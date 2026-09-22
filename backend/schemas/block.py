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

class FrameRequest(BaseModel):
    blocks: List[Block]

class CompileResponse(BaseModel):
    hex_string: str
    total_length: int
    debug_info: List[str] = Field(default_factory=list)
