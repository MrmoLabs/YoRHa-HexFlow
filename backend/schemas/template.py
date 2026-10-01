from enum import Enum
from typing import List, Optional, Dict, Union
from pydantic import BaseModel
from backend.schemas.block import Block

class LayerType(str, Enum):
    TEMPLATE = "template"
    INSTRUCTION = "instruction"

class Slot(Block):
    """A placeholder in a template where an Instruction's payload will be inserted."""
    type: str = "slot"
    target_layer_id: Optional[str] = None # ID of the instruction layer bound to this slot

class FrameTemplate(BaseModel):
    id: str
    name: str
    blocks: List[Union[Block, Slot]]
    
class Instruction(BaseModel):
    id: str
    name: str
    blocks: List[Block] # The payload blocks

class Binding(BaseModel):
    """Binds an Instruction to a Template."""
    id: str
    template_id: str
    instruction_id: str
    slot_mapping: Dict[str, str] # SlotID (Template) -> BlockID (Instruction) or "ALL"
    
class Layer(BaseModel):
    """Runtime representation of a layer in the stack."""
    id: str
    type: LayerType
    blocks: List[Block]
    offset_in_stream: int = 0
