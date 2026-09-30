from enum import Enum
from typing import List, Optional, Dict, Any, Union
from pydantic import BaseModel, Field

class BlockType(str, Enum):
    FIXED = "fixed"
    LENGTH = "length" 
    CHECKSUM = "checksum"
    OPTIONAL = "optional"
    TIMESTAMP = "timestamp" # New Phase 3
    CONTAINER = "container" # New Phase 3
    SLOT = "slot"
    # 批 4: 协议结构化位域 —— 位段静态默认值在发射期打包
    # （backend/handlers/bitfield.py，零 DDL：位段存 children JSON）。
    BITFIELD = "bitfield"

class BlockConfig(BaseModel):
    # Logic Link
    target_start_id: Optional[str] = None
    target_end_id: Optional[str] = None
    
    # Checksum
    algorithm: Optional[str] = "sum" # sum, xor, crc16_modbus
    
    # Container/Slot
    header_hex: Optional[str] = None
    tail_hex: Optional[str] = None
    
    # General
    params: Dict[str, Any] = Field(default_factory=dict)

class Block(BaseModel):
    id: str
    type: str # Use string to allow flexibility or BlockType enum
    label: str
    byte_length: int
    hex_value: Optional[str] = None
    config: Optional[BlockConfig] = None
    
    # Phase 3: Recursive Structure
    children: List['Block'] = Field(default_factory=list) 
    is_container: bool = False
    is_enabled: bool = True

    # E1-2 (B6): BIG (default) | LITTLE — emission byte order for this block's
    # value bytes; length/checksum handlers always compute on big-endian order.
    endianness: str = "BIG"

    # E1-5 (B7): resolved repeat expansion count for containers — the container's
    # children are emitted N times (1 = NONE / single copy). FIXED counts and
    # DYNAMIC counts (from the referenced field's static value) are resolved in
    # datahub.to_block; the orchestrator flattens children N times.
    repeat_count: int = 1

    # N5 (G4): 字段级对齐/填充 —— parameter_config 的 align / pad_to / pad_byte
    # 原样透传（Any 不做类型强制：bool/非法值由 core/pad 归一 fail-open，与前端
    # utils/padSpec.js 同口径）。指令链经 datahub.to_block 填充；协议链缺省 None
    # → 零影响。align = 内容起点补到 N 边界，pad_to = 内容末尾补到 N 边界。
    align: Any = None
    pad_to: Any = None
    pad_byte: Any = None

class FrameRequest(BaseModel):
    blocks: List[Block]

class CompileResponse(BaseModel):
    hex_string: str
    total_length: int
    debug_info: List[str] = Field(default_factory=list)

# 批次一 1b (D4-A): POST /compile/wrapped —— 协议 + 已编码内核 hex 载荷
# 走后端唯一封装入口 build_wrapped（指令编码仍在前端，D4/D11 分批收敛）。
# slot_ids 存协议原始 id（绑定表同源），按 payload 位次一一对应、允许
# null/缺省（该条走 start_order 起的稠密位次）。
class WrappedCompileRequest(BaseModel):
    protocol_id: str
    payloads: List[str]
    slot_ids: Optional[List[Optional[str]]] = None
    start_order: int = 0

class WrappedCompileResponse(BaseModel):
    hex_string: str
    total_length: int
    warnings: List[str] = Field(default_factory=list)
