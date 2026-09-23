import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import ProtocolBinding
from backend.schemas.binding_api import BindingCreate, BindingResponse, BindingUpdate

# E4 编排绑定持久化（甲案：新表）。绑定 = protocol_id + instruction_id + 插槽序。
# 不做模块级 create_all —— 建表统一在 main.py lifespan（避免导入即写真实库），
# 后端单测用临时库文件直调本模块函数（不走 TestClient）。

router = APIRouter(prefix="/bindings", tags=["bindings"])


def next_slot_order(existing_orders) -> int:
    """插槽序分配：max+1（空表从 0 起）—— 纯函数，单测直测。"""
    orders = [int(order) for order in existing_orders if order is not None]
    return max(orders) + 1 if orders else 0


@router.get("", response_model=List[BindingResponse])
def get_bindings(db: Session = Depends(get_db)):
    # 插槽序升序即前端侧栏列表顺序；同序按 id 兜底保证稳定
    return (
        db.query(ProtocolBinding)
        .order_by(ProtocolBinding.slot_order.asc(), ProtocolBinding.id.asc())
        .all()
    )


@router.post("", response_model=BindingResponse)
def create_binding(payload: BindingCreate, db: Session = Depends(get_db)):
    if payload.slot_order is not None:
        slot_order = payload.slot_order
    else:
        existing = db.query(ProtocolBinding.slot_order).all()
        slot_order = next_slot_order([row[0] for row in existing])

    binding = ProtocolBinding(
        id=payload.id or str(uuid.uuid4()),
        protocol_id=payload.protocol_id,
        instruction_id=payload.instruction_id,
        label=payload.label,
        slot_order=slot_order,
    )
    db.add(binding)
    db.commit()
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
    db.commit()
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
