from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from typing import List

from backend.db.database import get_db
from backend.db.models import OperatorTemplate
from backend.schemas.instruction_api import OperatorTemplateSchema

router = APIRouter(
    prefix="/operator_templates",
    tags=["operators"]
)

# SEED DATA (As defined in Plan)
SEED_TEMPLATES = [
    # BASE
    {"op_code": "HEX_RAW", "name": "原始Hex", "category": "BASE", "description": "固定十六进制值", "param_template": {"hex": "input"}},
    # N2 (G2): 定长文本字段 —— value 走 keyword 文本输入、encoding 走数组下拉、
    # pad_char 推断为 string 文本（hex 字面）；pc.type='string' 由 Instruction.jsx
    # 创建特判设置（keyword 值不复制进 pc），编码/显示/校验链都认它。
    {"op_code": "STRING", "name": "文本字段", "category": "BASE", "description": "定长文本（ascii/utf8，按字节 pad/截断）", "param_template": {"value": "string", "encoding": ["ascii", "utf8"], "pad_char": "00"}},
    
    # NUMERIC
    {"op_code": "INT_UNSIGNED", "name": "无符号整数", "category": "NUMERIC", "description": "标准整数", "param_template": {"bits": [8,16,32,64]}},
    {"op_code": "INT_SIGNED", "name": "有符号整数", "category": "NUMERIC", "description": "补码整数", "param_template": {"bits": [8,16,32,64]}},
    {"op_code": "FLOAT_IEEE", "name": "浮点数", "category": "NUMERIC", "description": "IEEE 754", "param_template": {"bits": [32, 64]}},
    {"op_code": "SCALED_DECIMAL", "name": "比例小数", "category": "NUMERIC", "description": "公式: (In+Offset)*Factor", "param_template": {"factor": "number", "offset": "number"}},
    
    # ENCODING
    {"op_code": "BCD_CODE", "name": "BCD码", "category": "ENCODING", "description": "Binary Coded Decimal", "param_template": {"bytes": "number"}},

    # DYNAMIC
    {"op_code": "TIME_ACCUMULATOR", "name": "时间累积", "category": "DYNAMIC", "description": "Current - BaseTime", "param_template": {"base_time": "1980-01-01T00:00:00"}},
    {"op_code": "AUTO_COUNTER", "name": "自动计数", "category": "DYNAMIC", "description": "(Current+Step)%Max", "param_template": {"start_val": 0, "step": 1, "max": 65535}},
    
    # LOGIC
    {"op_code": "MAPPING", "name": "枚举映射", "category": "LOGIC", "description": "状态位映射", "param_template": {"options": "kv_pair_list"}},

    # STRUCT
    {"op_code": "ARRAY_GROUP", "name": "嵌套组", "category": "STRUCT", "description": "循环容器", "param_template": {"max_count": "number"}},

    # LOGIC_CALC (V2)
    {"op_code": "LENGTH_CALC", "name": "长度计算", "category": "LOGIC", "description": "基于公式计算字段长度", "param_template": {"refs": "field_picker", "formula": "string"}},
    # B1 convergence: algo values are exactly the enums the frontend encoder
    # implements (formula.js ChecksumAlgo). Legacy names (CRC16_CCITT/CRC32/
    # XOR_SUM/ADD_SUM) were never read by the encoder — the selection had no effect.
    {"op_code": "CHECKSUM_CRC", "name": "校验码", "category": "LOGIC", "description": "CRC16-MODBUS/CCITT/CRC32/LRC/Sum/Xor校验", "param_template": {"refs": "field_picker", "algo": ["CRC_16_MODBUS", "CRC_16_CCITT", "CRC_32", "LRC", "SUM_8", "XOR_8"]}},

    # BIT-LEVEL (V2)
    {"op_code": "BITFIELD", "name": "位域", "category": "ENCODING", "description": "按位定义字段布局", "param_template": {"bit_layout": "bit_editor"}},
]


def seed_operator_templates(db: Session):
    # Robust seed: Upsert templates (called once from app lifespan)
    try:
        print("Seeding/Updating Operator Templates...")
        for t in SEED_TEMPLATES:
            db_obj = OperatorTemplate(**t)
            db.merge(db_obj)
        db.commit()
        print("Seeding Complete.")
    except Exception as e:
        db.rollback()
        print(f"Seeding Failed: {e}")

@router.get("/", response_model=List[OperatorTemplateSchema])
def get_operator_templates(db: Session = Depends(get_db)):
    return db.query(OperatorTemplate).all()
