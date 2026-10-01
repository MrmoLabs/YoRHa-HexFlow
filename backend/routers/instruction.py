from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import or_
from typing import List
import uuid

from backend.db.database import get_db, engine, Base
from backend.db.models import Instruction, InstructionField, BitField
from backend.schemas.instruction_api import InstructionCreate, InstructionResponse, InstructionFieldSchema, BitFieldSchema, InstructionUpdate

# Create tables if not exist (Simple migration)
# In prod use Alembic
Base.metadata.create_all(bind=engine)

router = APIRouter(
    prefix="/instructions",
    tags=["instructions"]
)

# G5 收口（双端硬拦拍板 2026-09-30）：保存侧已知算子白名单。
# 双端同源：FE constants.js OP_CODES 15 项（含 N2 的 STRING）+ encoder legacy
# 5 项（INPUT/FIXED/HEADER/TAIL/CALCULATED）= 20 项，与 FE utils/validateInstruction.js
# 的 KNOWN_OPS 逐行同步 —— 改一必改二。存量摸底（只读）：instruction_fields 31 行
# 9 种 op 全在册 → 取全集硬拦不锁任何历史数据。未知 op 若入库，fields_to_blocks
# 会静默降级 fixed（编码错码）—— 保存前拒绝（C2 位域校验同位先例）。
KNOWN_OPS = frozenset({
    "HEX_RAW", "INT_UNSIGNED", "INT_SIGNED", "FLOAT_IEEE", "SCALED_DECIMAL",
    "BCD_CODE", "BITFIELD", "MAPPING", "ARRAY_GROUP", "STRUCT",
    "LENGTH_CALC", "CHECKSUM_CRC", "TIME_ACCUMULATOR", "AUTO_COUNTER",
    "STRING",
    "INPUT", "FIXED", "HEADER", "TAIL", "CALCULATED",
})


# HELPER: Flat Save (Trust Payload)
def save_field_flat(db: Session, field_data: InstructionFieldSchema, instruction_id: str):
    f_id = field_data.id or str(uuid.uuid4())

    db_field = InstructionField(
        id=f_id,
        instruction_id=instruction_id,
        parent_id=field_data.parent_id, # Trust the payload
        sequence=field_data.sequence,
        name=field_data.name,
        op_code=field_data.op_code,
        
        # New Schema Fields
        parameter_config=field_data.parameter_config,
        byte_len=field_data.byte_len,
        endianness=field_data.endianness,
        
        repeat_type=field_data.repeat_type,
        repeat_ref_id=field_data.repeat_ref_id,
        repeat_count=field_data.repeat_count
    )
    db.add(db_field)

    # Bit-level layout (BITFIELD only)
    for idx, bit in enumerate(field_data.bits):
        db.add(BitField(
            id=bit.id or str(uuid.uuid4()),
            field_id=f_id,
            sequence=bit.sequence if bit.sequence else idx,
            bit_name=bit.bit_name,
            start_bit=bit.start_bit,
            bit_len=bit.bit_len,
            default_val=bit.default_val
        ))


# C2: 保存时位域强校验 — 镜像前端 P0-2 的 BIT_OVERLAP / BIT_OVERFLOW 口径，
# 直连 API 绕过前端也不允许入库重叠/超容量位域。POST/PUT 落库前调用。
def _validate_bitfields(fields):
    if not fields:
        return
    for f in fields:
        if f.op_code != "BITFIELD" or not f.bits:
            continue
        label = f.name or "UNNAMED"
        prev_end = -1
        for b in sorted(f.bits, key=lambda x: (x.start_bit or 0)):
            start = b.start_bit or 0
            length = max(1, b.bit_len or 1)
            if start < prev_end:
                raise HTTPException(
                    status_code=400,
                    detail=f"「{label}」位域重叠（{b.bit_name} 起始 {start} < 上一块结束 {prev_end}）",
                )
            prev_end = max(prev_end, start + length)
        total_bits = sum(max(1, b.bit_len or 1) for b in f.bits)
        if f.byte_len and f.byte_len > 0 and total_bits > f.byte_len * 8:
            raise HTTPException(
                status_code=400,
                detail=f"「{label}」位域超出容量（{f.byte_len}B = {f.byte_len * 8} bits，Σ{total_bits} bits）",
            )


def _validate_op_codes(fields):
    """G5 收口：保存侧 op_code 白名单（拍板：双端硬拦 · C2 同位先例）。

    口径与 FE validateInstruction 的 W5→E（OP_UNKNOWN errors）逐项对齐：
    - 大小写敏感逐字匹配（小写 op 在 FE 编码即落错路径 → 双端同拦）；
    - 空/缺省 op fail-open 不拦（FE 门为 `f.op_code && …` 同口径）；
    - detail 指明字段名 + 未知 op（FE 保存阻断文案同源，用户可直接定位）。
    POST/PUT 落库前调用 —— PUT 全量替换的 DELETE 之前，拒绝即存量原样。
    """
    if not fields:
        return
    for f in fields:
        op = f.op_code
        if not op or str(op) in KNOWN_OPS:
            continue
        label = f.name or f.id or "UNNAMED"
        raise HTTPException(
            status_code=400,
            detail=(
                f"「{label}」未知算子（{op}）：不在已知算子全集（OP_CODES + encoder legacy）"
                "——保存已拒绝，请核对算子模板或清洗导入数据"
            ),
        )


def serialize_instruction(db_inst: Instruction) -> InstructionResponse:
    sorted_fields = sorted(
        db_inst.fields,
        key=lambda field: ((field.parent_id or ''), field.sequence, field.name, field.id)
    )

    response_fields = [
        InstructionFieldSchema(
            id=field.id,
            parent_id=field.parent_id,
            sequence=field.sequence,
            name=field.name,
            op_code=field.op_code,
            byte_len=field.byte_len,
            endianness=field.endianness,
            repeat_type=field.repeat_type,
            repeat_ref_id=field.repeat_ref_id,
            repeat_count=field.repeat_count,
            parameter_config=field.parameter_config or {},
            bits=[
                BitFieldSchema(
                    id=bit.id,
                    sequence=bit.sequence,
                    bit_name=bit.bit_name,
                    start_bit=bit.start_bit,
                    bit_len=bit.bit_len,
                    default_val=bit.default_val
                )
                for bit in sorted(field.bit_fields, key=lambda b: (b.start_bit, b.sequence, b.id))
            ],
            children=[]
        )
        for field in sorted_fields
    ]

    return InstructionResponse(
        id=db_inst.id,
        device_code=db_inst.device_code,
        code=db_inst.code,
        name=db_inst.name,
        description=db_inst.description,
        type=db_inst.type,
        fields=response_fields
    )



@router.get("/", response_model=List[InstructionResponse])
def get_instructions(search: str = None, db: Session = Depends(get_db)):
    query = db.query(Instruction)
    if search:
        query = query.filter(or_(Instruction.name.contains(search), Instruction.code.contains(search)))
    instructions = query.all()
    return [serialize_instruction(instruction) for instruction in instructions]

@router.get("/{id}", response_model=InstructionResponse)
def get_instruction_detail(id: str, db: Session = Depends(get_db)):
    inst = db.query(Instruction).filter(Instruction.id == id).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Instruction not found")

    return serialize_instruction(inst)

@router.post("/", response_model=InstructionResponse)
def create_instruction(inst: InstructionCreate, db: Session = Depends(get_db)):
    i_id = str(uuid.uuid4())
    
    # 1. Uniqueness Check
    existing = db.query(Instruction).filter(or_(Instruction.name == inst.name, Instruction.code == inst.code)).first()
    if existing:
        raise HTTPException(status_code=400, detail="指令名称或代号必须唯一")

    # C2: 位域强校验 — 重叠/超容量在落库前拒绝（POST）
    _validate_bitfields(inst.fields)

    # G5: op 白名单 — 未知算子在任何写入前拒绝（POST，直连 API 同拦）
    _validate_op_codes(inst.fields)

    # 2. Create Instruction
    new_inst = Instruction(
        id=i_id,
        device_code=inst.device_code,
        code=inst.code,
        name=inst.name,
        description=inst.description,
        type=inst.type
    )
    db.add(new_inst)
    db.commit()
    
    # 2. Save Fields
    if inst.fields:
        for f in inst.fields:
            save_field_flat(db, f, i_id)
        db.commit()
    
    db.refresh(new_inst)
    
    return serialize_instruction(new_inst)

@router.put("/{id}", response_model=InstructionResponse)
def update_instruction(id: str, updates: InstructionUpdate, db: Session = Depends(get_db)):
    db_inst = db.query(Instruction).filter(Instruction.id == id).first()
    if not db_inst:
        raise HTTPException(status_code=404, detail="Not Found")
    
    # Uniqueness Check (Exclude self)
    existing = db.query(Instruction).filter(
        or_(Instruction.name == updates.name, Instruction.code == updates.code),
        Instruction.id != id
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="指令名称或代号必须唯一")

    # C2: 位域强校验 — 必须在任何写入发生前拒绝（PUT 全量替换前）
    _validate_bitfields(updates.fields)

    # G5: op 白名单 — 必须在元数据写入与字段 DELETE 之前拒绝（PUT 全量替换前），
    # 拒绝即存量原样、无半写状态。
    _validate_op_codes(updates.fields)

    # Update Metadata
    db_inst.device_code = updates.device_code
    db_inst.name = updates.name
    db_inst.code = updates.code
    db_inst.description = updates.description
    db_inst.type = updates.type
    
    # Update Tree (Full Replace Strategy)
    # Bulk query.delete() bypasses ORM cascade, so clear bit_fields explicitly first.
    field_ids = [row.id for row in db.query(InstructionField.id).filter(InstructionField.instruction_id == id)]
    if field_ids:
        db.query(BitField).filter(BitField.field_id.in_(field_ids)).delete(synchronize_session=False)
    db.query(InstructionField).filter(InstructionField.instruction_id == id).delete(synchronize_session=False)
    
    if updates.fields:
        for f in updates.fields:
            save_field_flat(db, f, id)
    
    db.commit()
    db.refresh(db_inst)
    return serialize_instruction(db_inst)

@router.delete("/{id}")
def delete_instruction(id: str, db: Session = Depends(get_db)):
    db_inst = db.query(Instruction).filter(Instruction.id == id).first()
    if not db_inst:
        raise HTTPException(status_code=404, detail="Not Found")
    
    db.delete(db_inst)
    db.commit()
    return {"status": "deleted", "id": id}
