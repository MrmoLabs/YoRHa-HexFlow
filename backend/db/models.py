from sqlalchemy import Column, Integer, String, Text, ForeignKey, Enum, JSON, Boolean
from sqlalchemy.orm import relationship, backref
from backend.db.database import Base
import enum

# Enums
class InstructionType(str, enum.Enum):
    STATIC = "STATIC"
    DYNAMIC = "DYNAMIC"

class RepeatType(str, enum.Enum):
    NONE = "NONE"
    FIXED = "FIXED"
    DYNAMIC = "DYNAMIC"

class Endianness(str, enum.Enum):
    BIG = "BIG"
    LITTLE = "LITTLE"

# 1. Instructions (Main Table)
class Instruction(Base):
    __tablename__ = "instructions"

    id = Column(String(36), primary_key=True)
    device_code = Column(String(32), nullable=False) # New field
    code = Column(String(64), nullable=False)
    name = Column(String(128), nullable=False)
    type = Column(String(32), default="DYNAMIC")
    description = Column(Text, nullable=True)
    
    # Timestamps are handled by DB default currently
    
    # Children
    fields = relationship("InstructionField", back_populates="instruction", cascade="all, delete-orphan")

# 2. Operator Templates
class OperatorTemplate(Base):
    __tablename__ = "operator_templates"
    
    op_code = Column(String(32), primary_key=True)
    name = Column(String(64), nullable=False)
    category = Column(String(32), nullable=False)
    param_template = Column(JSON, nullable=False) # UI render config
    description = Column(String(255))


class ProtocolTemplate(Base):
    __tablename__ = "protocols"

    id = Column(String(36), primary_key=True)
    label = Column(String(128), nullable=False)
    type = Column(String(32), default="container", nullable=False)
    description = Column(Text, nullable=True)
    children = Column(JSON, nullable=False, default=list)

# 3. Instruction Fields
class InstructionField(Base):
    __tablename__ = "instruction_fields"

    id = Column(String(36), primary_key=True)
    instruction_id = Column(String(36), ForeignKey("instructions.id"))
    parent_id = Column(String(36), ForeignKey("instruction_fields.id"), nullable=True)
    
    sequence = Column(Integer, default=0, nullable=False)
    name = Column(String(64), nullable=False)
    
    op_code = Column(String(32), nullable=False) # References OperatorTemplate.op_code logically
    
    byte_len = Column(Integer, default=0)
    endianness = Column(String(16), default="BIG")
    
    # Repeat / Nesting Logic
    repeat_type = Column(String(16), default="NONE") # NONE, FIXED, DYNAMIC
    repeat_ref_id = Column(String(36), nullable=True) # ID of the field that dictates count
    repeat_count = Column(Integer, default=1)   # Fixed count
    
    # Parameter Config (JSON)
    parameter_config = Column(JSON, nullable=True)
    
    # Relationships
    instruction = relationship("Instruction", back_populates="fields")
    children = relationship("InstructionField",
                            backref=backref('parent', remote_side=[id]),
                            cascade="all, delete-orphan")
    bit_fields = relationship("BitField",
                              order_by="BitField.sequence",
                              backref="field",
                              cascade="all, delete-orphan")


# 4. Bit Fields (Bit-level layout for BITFIELD fields)
class BitField(Base):
    __tablename__ = "bit_fields"

    id = Column(String(36), primary_key=True)
    field_id = Column(String(36), ForeignKey("instruction_fields.id"), nullable=False)

    sequence = Column(Integer, default=0, nullable=False)
    bit_name = Column(String(64), nullable=False)
    start_bit = Column(Integer, default=0, nullable=False)
    bit_len = Column(Integer, default=1, nullable=False)
    default_val = Column(Integer, default=0, nullable=False)


# 5. Protocol Bindings (E4: 编排绑定持久化 — 新表，不改既有表)
class ProtocolBinding(Base):
    __tablename__ = "protocol_bindings"

    id = Column(String(36), primary_key=True)
    # 逻辑外键（同 op_code 先例，不加 FK 约束）：SQLite PRAGMA foreign_keys=ON 下
    # 允许占位期空串，由编排页 props 回填 effect 补真实 id
    protocol_id = Column(String(36), nullable=False)
    instruction_id = Column(String(36), nullable=False)

    label = Column(String(128), nullable=False, default="新绑定 (NEW)")
    slot_order = Column(Integer, nullable=False, default=0)  # 插槽序：侧栏列表排序键
