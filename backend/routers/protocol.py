import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

# 建表统一在 main.py lifespan（对齐 binding.py 先例：导入不写真实库，
# 测试导入 protocol 路由无副作用）。
from backend.db.database import get_db
from backend.db.models import ProtocolTemplate
from backend.schemas.protocol_api import ProtocolCreate, ProtocolResponse, ProtocolUpdate

router = APIRouter(
    prefix="/protocols",
    tags=["protocols"]
)


def _validate_refs(children) -> None:
    """A7: refs 四类 400 校验（children JSON 列零 DDL，校验先于落库）。

    非数组 / 非字符串 / 自引用 / 锚 slot / 悬空 —— detail 英文对齐
    "Protocol not found" 先例。refs 为纯 id 数组、同树约束（跨树引用契约外）。
    """
    nodes = {}

    def walk(items):
        for item in items or []:
            nodes[item.id] = item
            walk(item.children)

    walk(children)

    for node_id, node in nodes.items():
        pc = node.parameter_config or {}
        if "refs" not in pc:
            continue
        refs = pc["refs"]
        if not isinstance(refs, list):
            raise HTTPException(status_code=400, detail="refs must be an array")
        for ref in refs:
            if not isinstance(ref, str):
                raise HTTPException(status_code=400, detail="refs entries must be strings")
            if ref == node_id:
                raise HTTPException(status_code=400, detail="refs cannot reference the block itself")
            target = nodes.get(ref)
            if target is None:
                raise HTTPException(status_code=400, detail="refs target not found")
            if target.type == "slot":
                raise HTTPException(status_code=400, detail="refs cannot anchor a slot")


@router.get("/", response_model=List[ProtocolResponse])
def get_protocols(db: Session = Depends(get_db)):
    return db.query(ProtocolTemplate).order_by(ProtocolTemplate.label.asc()).all()


@router.get("/{protocol_id}", response_model=ProtocolResponse)
def get_protocol(protocol_id: str, db: Session = Depends(get_db)):
    protocol = db.query(ProtocolTemplate).filter(ProtocolTemplate.id == protocol_id).first()
    if not protocol:
        raise HTTPException(status_code=404, detail="Protocol not found")
    return protocol


@router.post("/", response_model=ProtocolResponse)
def create_protocol(payload: ProtocolCreate, db: Session = Depends(get_db)):
    _validate_refs(payload.children)
    protocol_id = payload.id or str(uuid.uuid4())

    protocol = ProtocolTemplate(
        id=protocol_id,
        label=payload.label,
        type=payload.type,
        description=payload.description,
        children=[node.model_dump() for node in payload.children],
    )
    db.add(protocol)
    db.commit()
    db.refresh(protocol)
    return protocol


@router.put("/{protocol_id}", response_model=ProtocolResponse)
def update_protocol(protocol_id: str, payload: ProtocolUpdate, db: Session = Depends(get_db)):
    protocol = db.query(ProtocolTemplate).filter(ProtocolTemplate.id == protocol_id).first()
    if not protocol:
        raise HTTPException(status_code=404, detail="Protocol not found")

    _validate_refs(payload.children)
    protocol.label = payload.label
    protocol.type = payload.type
    protocol.description = payload.description
    protocol.children = [node.model_dump() for node in payload.children]
    db.commit()
    db.refresh(protocol)
    return protocol


@router.delete("/{protocol_id}")
def delete_protocol(protocol_id: str, db: Session = Depends(get_db)):
    protocol = db.query(ProtocolTemplate).filter(ProtocolTemplate.id == protocol_id).first()
    if not protocol:
        raise HTTPException(status_code=404, detail="Protocol not found")

    db.delete(protocol)
    db.commit()
    return {"status": "deleted", "id": protocol_id}
