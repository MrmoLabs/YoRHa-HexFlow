"""R36 发前路由 · CRUD 与解析（PLAN §8.68 —— §8.52 C-1 选项 C）。

两条路径：

- `prefix="/routing-rules"` 的 CRUD —— 规则表的增删改查，读侧一律 `alive()`；
- `resolve_route(inputs, db)` —— 被 `POST /dispatch/routed`（`routers/dispatch.py`）
  调用的**解析**入口。**只读**：不写库、不碰 transport、不记 dispatch 日志。

**§0 铁律**：`/dispatch/`（`dispatch_frame`）与 `/dispatch/transaction` 一行不改；
发前路由是**新增**端点，缺省口径逐字节不变。
"""
import uuid
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.core.condition import ConditionError, parse_condition
from backend.core.routing import select_rule
from backend.db.database import get_db
from backend.db.models import Instruction, RoutingRule
from backend.db.soft_delete import alive, mark_deleted, now_iso
from backend.routers.instruction import serialize_instruction
from backend.schemas.routing_api import (
    RouteResolveResponse,
    RouteTraceEntry,
    RoutingRuleCreate,
    RoutingRuleResponse,
)

router = APIRouter(prefix="/routing-rules", tags=["routing"])

# 定序键与 core/routing.py 逐字一致 —— 列表顺序 = 匹配顺序，前端不必自己猜。
_ORDER = (RoutingRule.sort_order.asc(), RoutingRule.name.asc(), RoutingRule.id.asc())


def _validate_condition(condition: str) -> None:
    """保存侧语法校验 → 400。运行期再踩到的坏条件由匹配器跳过（不 500）。"""
    try:
        parse_condition(condition)
    except ConditionError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid routing condition: {exc}")


def _require_instruction(db: Session, instruction_id: str) -> None:
    """目标必须是**活**指令（入回收站的不作候选，同 response-specs 口径）。"""
    hit = (
        alive(db.query(Instruction), Instruction)
        .filter(Instruction.id == instruction_id)
        .first()
    )
    if hit is None:
        raise HTTPException(status_code=404, detail="Instruction not found")


def _ensure_name_free(db: Session, name: str, exclude_id: str = None) -> None:
    """判重查**全表**（不排回收站）—— 软删行继续占用唯一键（§8.43 已知取舍），
    只查活行会漏到 DB IntegrityError 报 500。"""
    query = db.query(RoutingRule).filter(RoutingRule.name == name)
    if exclude_id is not None:
        query = query.filter(RoutingRule.id != exclude_id)
    if query.first() is not None:
        raise HTTPException(status_code=400, detail="Routing rule name already exists")


def _to_response(row: RoutingRule) -> RoutingRuleResponse:
    return RoutingRuleResponse(
        id=row.id,
        name=row.name,
        condition=row.condition,
        instruction_id=row.instruction_id,
        sort_order=row.sort_order,
        enabled=row.enabled,
        description=row.description,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("", response_model=List[RoutingRuleResponse])
def list_rules(db: Session = Depends(get_db)) -> List[RoutingRuleResponse]:
    rows = alive(db.query(RoutingRule), RoutingRule).order_by(*_ORDER).all()
    return [_to_response(row) for row in rows]


@router.post("", response_model=RoutingRuleResponse)
def create_rule(payload: RoutingRuleCreate, db: Session = Depends(get_db)) -> RoutingRuleResponse:
    _validate_condition(payload.condition)
    _require_instruction(db, payload.instruction_id)
    _ensure_name_free(db, payload.name)
    ts = now_iso()
    row = RoutingRule(
        id=str(uuid.uuid4()),
        name=payload.name,
        condition=payload.condition,
        instruction_id=payload.instruction_id,
        sort_order=payload.sort_order,
        enabled=1 if payload.enabled else 0,
        description=payload.description,
        created_at=ts,
        updated_at=ts,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_response(row)


@router.get("/{rule_id}", response_model=RoutingRuleResponse)
def get_rule(rule_id: str, db: Session = Depends(get_db)) -> RoutingRuleResponse:
    row = alive(db.query(RoutingRule), RoutingRule).filter(RoutingRule.id == rule_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Routing rule not found")
    return _to_response(row)


@router.put("/{rule_id}", response_model=RoutingRuleResponse)
def update_rule(
    rule_id: str, payload: RoutingRuleCreate, db: Session = Depends(get_db)
) -> RoutingRuleResponse:
    row = alive(db.query(RoutingRule), RoutingRule).filter(RoutingRule.id == rule_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Routing rule not found")
    # 先校验再落笔：条件/指令任一不合法就整单中止，不留下半改状态
    _validate_condition(payload.condition)
    _require_instruction(db, payload.instruction_id)
    _ensure_name_free(db, payload.name, exclude_id=rule_id)
    row.name = payload.name
    row.condition = payload.condition
    row.instruction_id = payload.instruction_id
    row.sort_order = payload.sort_order
    row.enabled = 1 if payload.enabled else 0
    row.description = payload.description
    row.updated_at = now_iso()
    db.commit()
    db.refresh(row)
    return _to_response(row)


@router.delete("/{rule_id}")
def delete_rule(rule_id: str, db: Session = Depends(get_db)) -> Dict[str, str]:
    row = alive(db.query(RoutingRule), RoutingRule).filter(RoutingRule.id == rule_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Routing rule not found")
    mark_deleted(row)
    db.commit()
    return {"status": "deleted", "id": rule_id}


def resolve_route(inputs: Dict, db: Session) -> RouteResolveResponse:
    """发前解析：规则 → 指令。**只解析，不发送。**

    两层静态跳过（都记进 `invalid`，不 500、也不误命中别的规则）：

    1. 目标指令已进回收站 / 不存在 → 规则悬空；
    2. 条件**语法**坏掉 → 由 `core/routing.select_rule` 记账（求值期的
       「变量不在输入里」是正常不命中，不记）。

    全无命中 → `matched=False`，**不猜**：调用方维持人工选指令。

    R43（§8.75）回执多一项 `trace`：`select_rule` 给的逐条轨迹，再把本层那
    种静态跳过（`INSTRUCTION_MISSING`）按同一定序并进去 —— 列表里看得见的每条
    规则在轨迹里都有一行。
    """
    rows = alive(db.query(RoutingRule), RoutingRule).order_by(*_ORDER).all()

    invalid: List[Dict[str, Any]] = []
    if rows:
        wanted = {row.instruction_id for row in rows}
        live_ids = {
            inst.id
            for inst in alive(db.query(Instruction), Instruction)
            .filter(Instruction.id.in_(wanted))
            .all()
        }
    else:
        live_ids = set()

    usable: List[RoutingRule] = []
    for row in rows:
        if row.instruction_id in live_ids:
            usable.append(row)
        else:
            invalid.append(
                {
                    "id": row.id,
                    "name": row.name,
                    "condition": row.condition,
                    "reason": "INSTRUCTION_MISSING",
                }
            )

    result = select_rule(usable, inputs)
    invalid.extend(result["invalid"])

    # R43（§8.75）轨迹：`select_rule` 只看得见 `usable`，把它那层静态跳过
    # （目标指令不在册）按**同一定序**并回去 —— 顺序仍 = 列表顺序。
    # 悬空那条优先标 INSTRUCTION_MISSING：它本来就不在 `usable` 里，
    # 从未进过扫描，与 `invalid` 无条件收录它的口径一致。
    by_id = {entry["id"]: entry for entry in result["trace"]}
    trace: List[RouteTraceEntry] = []
    for row in rows:
        if row.instruction_id in live_ids:
            entry = by_id.get(str(row.id))
            if entry is not None:
                trace.append(RouteTraceEntry(**entry))
        else:
            trace.append(
                RouteTraceEntry(
                    id=str(row.id),
                    name=str(row.name or ""),
                    condition=str(row.condition or ""),
                    code="INSTRUCTION_MISSING",
                    detail="",
                )
            )

    if not result["matched"]:
        return RouteResolveResponse(
            matched=False,
            invalid=invalid,
            considered=result["considered"],
            trace=trace,
        )

    rule: RoutingRule = result["rule"]
    instruction = (
        alive(db.query(Instruction), Instruction).filter(Instruction.id == rule.instruction_id).first()
    )
    return RouteResolveResponse(
        matched=True,
        rule=_to_response(rule),
        instruction_id=rule.instruction_id,
        instruction=serialize_instruction(instruction),
        invalid=invalid,
        considered=result["considered"],
        trace=trace,
    )
