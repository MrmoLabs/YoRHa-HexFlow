from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any, Union
from enum import Enum

# Shared Enums (Must match DB)
class InstructionType(str, Enum):
    STATIC = "STATIC"
    DYNAMIC = "DYNAMIC"

class RepeatType(str, Enum):
    NONE = "NONE"
    FIXED = "FIXED"
    DYNAMIC = "DYNAMIC"

class Endianness(str, Enum):
    BIG = "BIG"
    LITTLE = "LITTLE"

# Operator Template Schema
class OperatorTemplateSchema(BaseModel):
    op_code: str
    name: str
    category: str
    param_template: Dict[str, Any]
    description: Optional[str] = None
    
    class Config:
        from_attributes = True

# Bit Field Schema (bit-level layout for BITFIELD fields)
class BitFieldSchema(BaseModel):
    id: Optional[str] = None
    sequence: int = 0
    bit_name: str
    start_bit: int = 0
    bit_len: int = 1
    default_val: int = 0

    class Config:
        from_attributes = True


# Instruction Field Schema
class InstructionFieldSchema(BaseModel):
    id: Optional[str] = None
    parent_id: Optional[str] = None
    sequence: int = 0
    name: str
    
    op_code: str
    byte_len: int = 0
    endianness: Endianness = Endianness.BIG
    
    # Repeat / Nesting
    repeat_type: RepeatType = RepeatType.NONE
    repeat_ref_id: Optional[str] = None
    repeat_count: int = 1
    
    # Parameter Config
    parameter_config: Optional[Dict[str, Any]] = None

    # Bit-level layout (only meaningful when op_code == 'BITFIELD')
    bits: List[BitFieldSchema] = Field(default_factory=list)

    children: List['InstructionFieldSchema'] = Field(default_factory=list)
    
    class Config:
        from_attributes = True

# Recursion logic for Pydantic
InstructionFieldSchema.model_rebuild()

class InstructionBase(BaseModel):
    device_code: str
    code: str
    name: str
    description: Optional[str] = None
    type: InstructionType = InstructionType.DYNAMIC

class InstructionCreate(InstructionBase):
    fields: List[InstructionFieldSchema] = Field(default_factory=list)

class InstructionUpdate(InstructionBase):
    fields: List[InstructionFieldSchema] = Field(default_factory=list)

class InstructionResponse(InstructionBase):
    id: str
    fields: List[InstructionFieldSchema] = Field(default_factory=list)
    
    class Config:
        from_attributes = True
