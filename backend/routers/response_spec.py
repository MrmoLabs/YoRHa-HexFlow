import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.core.response_generate import chain_fingerprint, generate, resolve_layers
from backend.core.response_match import normalize_spec
from backend.db.database import get_db
from backend.db.models import Instruction, ResponseSpec
from backend.db.soft_delete import alive, mark_deleted
from backend.schemas.response_spec_api import (
    ResponseSpecGenerateResponse,
    ResponseSpecResponse,
    ResponseSpecTarget,
    ResponseSpecUpsert,
)

# P2 应答规格：按指令持久化的匹配规格 CRUD（新表 response_specs，仅新增）。
# 无模块级 create_all（同 E4/P1 先例，建表归 lifespan）；单测临时库直调本模块函数。
# 一指令一规格：instruction_id 逻辑唯一（路由先查给 404、DB unique 兜底）；
# spec 形态以 response_match.normalize_spec 为 SSOT（ValueError → 400）。
# PUT 为 upsert（规格编辑器「SAVE」一步落库）；路径键 = instruction_id，
# 前端只随当前指令取/存，无需记行 id。
#
# CP3 3d (D5-A × D15-A)：新增 `POST /{instruction_id}/generate`「据此生成」——
# 按指令的分层链（默认配方 → 每层各执行一次；无配方 → 默认协议单层退化）映射
# 出 spec 并 upsert，同时回写 stage 镜像与 definition_hash 出处指纹；
# `GET /targets` 给协议页列候选指令（**必须排在 /{instruction_id} 之前**，否则
# 被路径参数吃掉）。D7-A：读侧回 `stale`（指纹比对，不阻断）。

router = APIRouter(prefix="/response-specs", tags=["response-specs"])


def _validated_spec(spec) -> dict:
    try:
        return normalize_spec(spec)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid response spec: {e}")


def _stage_mirror(spec: dict) -> Optional[int]:
    """`stage` = `spec.stages` 的最外层序号；无 stages 键（单层）→ NULL。"""
    stages = spec.get("stages")
    if not isinstance(stages, list) or not stages:
        return None
    return len(stages) - 1


def _stale(row: ResponseSpec, db: Session) -> Optional[bool]:
    """D7-A 失效徽标：出处指纹与「指令当前分层链」比对。

    NULL 出处（手工规格 / 存量）→ None（不出徽标）；链解析不出来（配方/协议
    已删）→ True（同 3c 配方缺失口径：按失效提示，不阻断）。
    """
    if not row.definition_hash:
        return None
    current = chain_fingerprint(db, row.instruction_id)
    if current is None:
        return True
    return current != row.definition_hash


def _response(row: ResponseSpec, db: Session) -> ResponseSpecResponse:
    return ResponseSpecResponse(
        id=row.id,
        instruction_id=row.instruction_id,
        spec=row.spec,
        stage=row.stage,
        definition_hash=row.definition_hash,
        stale=_stale(row, db),
    )


@router.get("/targets", response_model=List[ResponseSpecTarget])
def get_generate_targets(
    protocol_id: Optional[str] = None, db: Session = Depends(get_db)
) -> List[ResponseSpecTarget]:
    """协议页「据此生成」的候选指令：解析得出层链的指令 + 该链是否含当前协议。

    层链解析不出来（无配方且无默认协议 / 配方引用已删协议）的指令**不出现在
    候选里** —— 没有协议可映射就没得生成。
    """
    targets: List[ResponseSpecTarget] = []
    # R6: 已入回收站的指令不作候选（活着才谈得上「据此生成」）
    rows = (
        alive(db.query(Instruction), Instruction)
        .order_by(Instruction.name.asc())
        .all()
    )
    for instruction in rows:
        try:
            layers = resolve_layers(db, instruction.id)
        except (LookupError, ValueError):
            continue
        protocol_ids = [layer["protocol_id"] for layer in layers]
        targets.append(
            ResponseSpecTarget(
                instruction_id=instruction.id,
                name=instruction.name or "",
                code=instruction.code or "",
                layers=len(layers),
                recipe_id=instruction.default_recipe_id,
                uses_protocol=bool(protocol_id) and protocol_id in protocol_ids,
            )
        )
    # 当前协议的关联指令排前（协议页动作的主用例），其余按名称序稳定排后。
    targets.sort(key=lambda t: (not t.uses_protocol, t.name, t.code))
    return targets


@router.get("", response_model=List[ResponseSpecResponse])
def get_response_specs(db: Session = Depends(get_db)) -> List[ResponseSpecResponse]:
    # R6: 回收站行不进列表（alive = deleted_at IS NULL）
    rows = (
        alive(db.query(ResponseSpec), ResponseSpec)
        .order_by(ResponseSpec.instruction_id.asc())
        .all()
    )
    return [_response(row, db) for row in rows]


@router.get("/{instruction_id}", response_model=ResponseSpecResponse)
def get_response_spec(instruction_id: str, db: Session = Depends(get_db)) -> ResponseSpecResponse:
    row = (
        alive(db.query(ResponseSpec), ResponseSpec)
        .filter(ResponseSpec.instruction_id == instruction_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Response spec not found")
    return _response(row, db)


@router.put("/{instruction_id}", response_model=ResponseSpecResponse)
def upsert_response_spec(
    instruction_id: str, payload: ResponseSpecUpsert, db: Session = Depends(get_db)
) -> ResponseSpecResponse:
    spec = _validated_spec(payload.spec)
    # R6（§8.43）：**故意不过滤回收站** —— response_specs.instruction_id 是
    # inline UNIQUE，回收站里那行仍占键；重新 SAVE 直接**复活**在库行（清标记 +
    # 覆盖 spec），既不撞唯一约束，也不会变成「看起来存了、读出来还是旧的」。
    row = db.query(ResponseSpec).filter(ResponseSpec.instruction_id == instruction_id).first()
    if row is None:
        row = ResponseSpec(id=str(uuid.uuid4()), instruction_id=instruction_id, spec=spec)
        db.add(row)
    else:
        # 手工编辑：spec 换、stage 镜像随 spec 重算；definition_hash **保留** ——
        # 它记的是「哪一版协议链生成的」出处，改规则不改变出处（D7-A 比对基准）。
        row.spec = spec
        row.deleted_at = None  # 回收站行被覆盖 → 复活
    row.stage = _stage_mirror(spec)
    db.commit()
    db.refresh(row)
    return _response(row, db)


@router.post("/{instruction_id}/generate", response_model=ResponseSpecGenerateResponse)
def generate_response_spec(
    instruction_id: str, db: Session = Depends(get_db)
) -> ResponseSpecGenerateResponse:
    """D5-A「据此生成 response_spec」：按指令分层链逐层映射 → upsert + 记出处。"""
    try:
        result = generate(db, instruction_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:  # 层链不可生成 / spec 形态非法 → 统一 400
        raise HTTPException(status_code=400, detail=str(e))

    spec = result["spec"]
    # 同 upsert：回收站行被覆盖 → 复活（唯一键 = instruction_id，见上）
    row = db.query(ResponseSpec).filter(ResponseSpec.instruction_id == instruction_id).first()
    if row is None:
        row = ResponseSpec(id=str(uuid.uuid4()), instruction_id=instruction_id, spec=spec)
        db.add(row)
    else:
        row.spec = spec
        row.deleted_at = None
    row.stage = _stage_mirror(spec)
    row.definition_hash = result["definition_hash"]
    db.commit()
    db.refresh(row)
    return ResponseSpecGenerateResponse(
        **_response(row, db).model_dump(),
        layers=[
            {"protocol_id": layer["protocol_id"], "label": layer.get("label")}
            for layer in result["layers"]
        ],
        warnings=result["warnings"],
    )


@router.delete("/{instruction_id}")
def delete_response_spec(instruction_id: str, db: Session = Depends(get_db)):
    # R6（§8.43）：删除 = 打标记进回收站（叶子行，无级联子行）
    row = (
        alive(db.query(ResponseSpec), ResponseSpec)
        .filter(ResponseSpec.instruction_id == instruction_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Response spec not found")
    row_id = row.id
    mark_deleted(row)
    db.commit()
    return {"status": "deleted", "id": row_id, "instruction_id": instruction_id}
