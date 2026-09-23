import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.core.response_match import normalize_spec
from backend.db.database import get_db
from backend.db.models import ResponseSpec
from backend.schemas.response_spec_api import ResponseSpecResponse, ResponseSpecUpsert

# P2 应答规格：按指令持久化的匹配规格 CRUD（新表 response_specs，仅新增）。
# 无模块级 create_all（同 E4/P1 先例，建表归 lifespan）；单测临时库直调本模块函数。
# 一指令一规格：instruction_id 逻辑唯一（路由先查给 404、DB unique 兜底）；
# spec 形态以 response_match.normalize_spec 为 SSOT（ValueError → 400）。
# PUT 为 upsert（规格编辑器「SAVE」一步落库）；路径键 = instruction_id，
# 前端只随当前指令取/存，无需记行 id。

router = APIRouter(prefix="/response-specs", tags=["response-specs"])


def _validated_spec(spec) -> dict:
    try:
        return normalize_spec(spec)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid response spec: {e}")


def _response(row: ResponseSpec) -> ResponseSpecResponse:
    return ResponseSpecResponse(id=row.id, instruction_id=row.instruction_id, spec=row.spec)


@router.get("", response_model=List[ResponseSpecResponse])
def get_response_specs(db: Session = Depends(get_db)) -> List[ResponseSpecResponse]:
    rows = (
        db.query(ResponseSpec)
        .order_by(ResponseSpec.instruction_id.asc())
        .all()
    )
    return [_response(row) for row in rows]


@router.get("/{instruction_id}", response_model=ResponseSpecResponse)
def get_response_spec(instruction_id: str, db: Session = Depends(get_db)) -> ResponseSpecResponse:
    row = db.query(ResponseSpec).filter(ResponseSpec.instruction_id == instruction_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Response spec not found")
    return _response(row)


@router.put("/{instruction_id}", response_model=ResponseSpecResponse)
def upsert_response_spec(
    instruction_id: str, payload: ResponseSpecUpsert, db: Session = Depends(get_db)
) -> ResponseSpecResponse:
    spec = _validated_spec(payload.spec)
    row = db.query(ResponseSpec).filter(ResponseSpec.instruction_id == instruction_id).first()
    if row is None:
        row = ResponseSpec(id=str(uuid.uuid4()), instruction_id=instruction_id, spec=spec)
        db.add(row)
    else:
        row.spec = spec
    db.commit()
    db.refresh(row)
    return _response(row)


@router.delete("/{instruction_id}")
def delete_response_spec(instruction_id: str, db: Session = Depends(get_db)):
    row = db.query(ResponseSpec).filter(ResponseSpec.instruction_id == instruction_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Response spec not found")
    row_id = row.id
    db.delete(row)
    db.commit()
    return {"status": "deleted", "id": row_id, "instruction_id": instruction_id}
