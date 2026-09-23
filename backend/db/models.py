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


# 7. Transport Settings（P1: 连接持久化 — 单行表，id 恒为 "current"）
class TransportSetting(Base):
    __tablename__ = "transport_settings"

    id = Column(String(16), primary_key=True)  # 恒为 "current"（单行约定）
    config = Column(JSON, nullable=False)  # 当前生效传输配置（transport.default_config 形态）
    # 逻辑指针（同 op_code 先例不加 FK）：最后激活的设备档案；手工改配置/删档案时置空
    active_profile_id = Column(String(36), nullable=True)


# 8. Device Profiles（P1: 设备档案 — 传输配置的命名快照）
class DeviceProfile(Base):
    __tablename__ = "device_profiles"

    id = Column(String(36), primary_key=True)
    label = Column(String(128), nullable=False, unique=True)  # 档案名唯一（路由先查给 400，DB 约束兜底）
    config = Column(JSON, nullable=False)  # 完整三段传输配置快照（validate_config 归一后入库）


# 9. Response Specs（P2: 事务化发送引擎 — 按指令持久化的应答匹配规格，新表）
class ResponseSpec(Base):
    __tablename__ = "response_specs"

    id = Column(String(36), primary_key=True)
    # 逻辑外键（同 op_code 先例，不加 FK 约束）：一指令一规格，路由先查保证唯一、DB unique 兜底
    instruction_id = Column(String(36), nullable=False, unique=True)
    # 匹配规格 JSON：normalize_spec 归一后入库（core/response_match.py 为形态 SSOT）
    spec = Column(JSON, nullable=False)


# 10. Sequences（P3: 序列编排 — 定义载体，新表；既有表零改）
class Sequence(Base):
    __tablename__ = "sequences"

    id = Column(String(36), primary_key=True)
    name = Column(String(128), nullable=False, unique=True)  # 序列名唯一（路由先查 400，DB 约束兜底）
    description = Column(Text, nullable=True)
    # 运行配置 JSON：normalize_config 归一（stop_on_error / read_timeout_ms）
    config = Column(JSON, nullable=False, default=dict)


# 11. Sequence Steps（P3: 步骤 = 保存时定值的帧快照 + 发送时重算计划，新表）
class SequenceStep(Base):
    __tablename__ = "sequence_steps"

    id = Column(String(36), primary_key=True)
    # 逻辑外键（同 op_code 先例，不加 FK 约束）：删除序列时按此列在路由内级联清理
    sequence_id = Column(String(36), nullable=False)
    step_order = Column(Integer, nullable=False, default=0)  # 执行序（读取按 step_order, id 排序）
    instruction_id = Column(String(36), nullable=False)  # 逻辑外键 → instructions.id（审计回溯）
    label = Column(String(128), nullable=True)  # 步骤显示名（缺省用指令名 / step-N）
    delay_ms = Column(Integer, nullable=False, default=0)  # 本步执行前等待（0..60000）
    # 保存时冻结的表单参数 {field_id: value}（TIME/COUNTER 不冻结，重算见 plan）
    params = Column(JSON, nullable=True)
    payload = Column(Text, nullable=False)  # 保存时编译的完整帧 hex（前端 encodeInstruction 产物）
    # 发送时重算计划 {"dynamic": [...TIME/COUNTER 补丁], "checksum": {regions 重算}}；None = 原样发送
    plan = Column(JSON, nullable=True)
