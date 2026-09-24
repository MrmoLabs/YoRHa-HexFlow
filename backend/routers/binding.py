import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import Instruction, ProtocolBinding, ProtocolTemplate
from backend.schemas.binding_api import BindingCreate, BindingResponse, BindingUpdate

# E4 编排绑定持久化（甲案：新表）。绑定 = protocol_id + instruction_id + 插槽序。
# 不做模块级 create_all —— 建表统一在 main.py lifespan（避免导入即写真实库），
# 后端单测用临时库文件直调本模块函数（不走 TestClient）。
#
# 批次一 1a（D1-A）：三新字段透传 + 设默认同事务清旧默认 + 绑定期关系校验
# （slot_id 存在且为 slot 块 / accepts 设备白名单命中，DESIGN_CorePipeline §6.1）。
# 唯一约束冲突（显式槽重复 / 默认唯一并发）由两个部分唯一索引兜底 → IntegrityError
# 统一转 400（create_all 只建表不建索引，索引在 ensure_binding_columns）。

router = APIRouter(prefix="/bindings", tags=["bindings"])


def next_slot_order(existing_orders) -> int:
    """插槽序分配：max+1（空表从 0 起）—— 纯函数，单测直测。"""
    orders = [int(order) for order in existing_orders if order is not None]
    return max(orders) + 1 if orders else 0


def find_slot_node(children, slot_id: str) -> Optional[dict]:
    """协议树内按 id 深搜节点（dict 树，children JSON 列）—— 纯函数，单测直测。"""
    for node in children or []:
        if not isinstance(node, dict):
            continue
        if node.get("id") == slot_id:
            return node
        found = find_slot_node(node.get("children"), slot_id)
        if found is not None:
            return found
    return None


def validate_binding(db: Session, protocol_id: str, instruction_id: str, slot_id: Optional[str]) -> None:
    """绑定期关系校验（6.1 第二行）：slot_id 存在且 type=slot、accepts 白名单命中。

    占位期（slot_id 为空）直接放行 —— 编排页先 POST 后回填 id 的既有流程不受扰。
    显式槽必须同时给 protocol_id（否则槽无从校验）。协议缺失 404（同 protocol.py
    "Protocol not found"）；其余校验 400 + 中文 detail（操作员直读，同步失败提示）。
    """
    if not slot_id:
        return
    if not protocol_id:
        raise HTTPException(status_code=400, detail="指定 slot_id 时必须同时指定 protocol_id")

    protocol = db.query(ProtocolTemplate).filter(ProtocolTemplate.id == protocol_id).first()
    if not protocol:
        raise HTTPException(status_code=404, detail="Protocol not found")

    node = find_slot_node(protocol.children, slot_id)
    if node is None:
        raise HTTPException(status_code=400, detail=f"插槽不存在于所选协议：{slot_id}")
    if node.get("type") != "slot":
        raise HTTPException(status_code=400, detail=f"目标块不是插槽：{slot_id}")

    accepts = (node.get("parameter_config") or {}).get("accepts")
    if accepts and instruction_id:
        instruction = db.query(Instruction).filter(Instruction.id == instruction_id).first()
        # 指令已被删/占位期 → 无法核验设备维度，放行（删除级联在批次二，见
        # DESIGN_CorePipeline §6.4）；命中名单为空串 device_code 且白名单非空 → 拒。
        if instruction is not None and (instruction.device_code or "") not in [str(a) for a in accepts]:
            raise HTTPException(
                status_code=400,
                detail=f"插槽不接受该设备：{instruction.device_code} ∉ {accepts}",
            )


def enforce_single_default(db: Session, instruction_id: str, keep_id: str) -> None:
    """同指令其余行 is_default 清零（同事务，部分唯一索引兜底）—— 直调不 commit。"""
    if not instruction_id:
        return
    (
        db.query(ProtocolBinding)
        .filter(
            ProtocolBinding.instruction_id == instruction_id,
            ProtocolBinding.id != keep_id,
            ProtocolBinding.is_default == 1,
        )
        .update({"is_default": 0}, synchronize_session=False)
    )


def _commit_or_conflict(db: Session) -> None:
    """唯一索引冲突（显式槽重复 / 默认唯一并发）→ 400；先 rollback 回滚本事务清默认。"""
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=f"绑定冲突：{exc.orig}")


@router.get("", response_model=List[BindingResponse])
def get_bindings(db: Session = Depends(get_db), instruction_id: Optional[str] = None):
    # 插槽序升序即前端侧栏列表顺序；同序按 id 兜底保证稳定。
    # 批次一: 可选 instruction_id 过滤（加工页取默认协议走 ?instruction_id=）。
    query = db.query(ProtocolBinding)
    if instruction_id is not None:
        query = query.filter(ProtocolBinding.instruction_id == instruction_id)
    return query.order_by(ProtocolBinding.slot_order.asc(), ProtocolBinding.id.asc()).all()


@router.post("", response_model=BindingResponse)
def create_binding(payload: BindingCreate, db: Session = Depends(get_db)):
    if payload.slot_order is not None:
        slot_order = payload.slot_order
    else:
        existing = db.query(ProtocolBinding.slot_order).all()
        slot_order = next_slot_order([row[0] for row in existing])

    validate_binding(db, payload.protocol_id, payload.instruction_id, payload.slot_id)

    binding = ProtocolBinding(
        id=payload.id or str(uuid.uuid4()),
        protocol_id=payload.protocol_id,
        instruction_id=payload.instruction_id,
        label=payload.label,
        slot_order=slot_order,
        slot_id=payload.slot_id,
        is_default=1 if payload.is_default else 0,
        priority=payload.priority,
    )
    db.add(binding)
    if payload.is_default:
        # 新行已 add 未 flush，keep_id 用显式 id（同事务清旧默认）。
        enforce_single_default(db, payload.instruction_id, keep_id=binding.id)
    _commit_or_conflict(db)
    db.refresh(binding)
    return binding


@router.put("/{binding_id}", response_model=BindingResponse)
def update_binding(binding_id: str, payload: BindingUpdate, db: Session = Depends(get_db)):
    binding = db.query(ProtocolBinding).filter(ProtocolBinding.id == binding_id).first()
    if not binding:
        raise HTTPException(status_code=404, detail="Binding not found")

    if payload.label is not None:
        binding.label = payload.label
    if payload.protocol_id is not None:
        binding.protocol_id = payload.protocol_id
    if payload.instruction_id is not None:
        binding.instruction_id = payload.instruction_id
    if payload.slot_order is not None:
        binding.slot_order = payload.slot_order
    if payload.slot_id is not None:
        binding.slot_id = payload.slot_id
    if payload.is_default is not None:
        binding.is_default = 1 if payload.is_default else 0
    if payload.priority is not None:
        binding.priority = payload.priority

    validate_binding(db, binding.protocol_id, binding.instruction_id, binding.slot_id)
    if binding.is_default:
        # 恒清同指令其余默认（改 instruction_id 后旧默认也在此收口）。
        enforce_single_default(db, binding.instruction_id, keep_id=binding.id)
    _commit_or_conflict(db)
    db.refresh(binding)
    return binding


@router.delete("/{binding_id}")
def delete_binding(binding_id: str, db: Session = Depends(get_db)):
    binding = db.query(ProtocolBinding).filter(ProtocolBinding.id == binding_id).first()
    if not binding:
        raise HTTPException(status_code=404, detail="Binding not found")

    db.delete(binding)
    db.commit()
    return {"status": "deleted", "id": binding_id}
