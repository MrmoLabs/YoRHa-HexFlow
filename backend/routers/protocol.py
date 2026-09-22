import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.db.database import Base, engine, get_db
from backend.db.models import ProtocolTemplate
from backend.schemas.protocol_api import ProtocolCreate, ProtocolResponse, ProtocolUpdate


Base.metadata.create_all(bind=engine)

router = APIRouter(
    prefix="/protocols",
    tags=["protocols"]
)


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
