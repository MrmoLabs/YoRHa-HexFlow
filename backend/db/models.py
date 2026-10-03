from sqlalchemy import Column, Integer, String, Text, ForeignKey, Enum, JSON, Float
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

# ── R6 软删除 / 回收站（PLAN §8.43）─────────────────────────────────────────────
# 13 张表**统一**加一列 `deleted_at`（仅新增列，合 §0）：
#   NULL    = 活行；
#   非 NULL = 已入回收站的 ISO-8601 时间戳。
# 父行与被级联软删的子行**共用同一时间戳** —— 恢复时据此把子行一并捞回
# （不额外加级联标记列）。写侧 = 各路由 mark_deleted + routers/trash.py，
# 读侧 = 各路由 alive() 过滤；存量库由 migrate.py 的 0002 迁移补列（新库
# create_all 直接建全列）。日志 / 模板 / 传输配置三表只加列、不改行为。
# 1. Instructions (Main Table)
class Instruction(Base):
    __tablename__ = "instructions"

    id = Column(String(36), primary_key=True)
    device_code = Column(String(32), nullable=False) # New field
    code = Column(String(64), nullable=False)
    name = Column(String(128), nullable=False)
    type = Column(String(32), default="DYNAMIC")
    description = Column(Text, nullable=True)

    # CP3 3a (D13): 该指令的默认封装配方。单列 = 结构上天然唯一（每指令至多
    # 一个默认配方，无需部分唯一索引，§9.1）；NULL = 无配方 → 加工页降级链走
    # 默认协议 / 裸发。存量库缺列由 database.ensure_recipe_columns 启动自愈
    # （create_all 不补列，同批次五 version / 批次一 binding 三列先例）。
    default_recipe_id = Column(String(36), nullable=True)

    # Timestamps are handled by DB default currently
    
    # Children
    fields = relationship("InstructionField", back_populates="instruction", cascade="all, delete-orphan")
    # R6 软删除（§8.43）：NULL=活行，非 NULL=回收站时间戳（级联子行同戳）。
    deleted_at = Column(String(40), nullable=True)

# 2. Operator Templates
class OperatorTemplate(Base):
    __tablename__ = "operator_templates"
    
    op_code = Column(String(32), primary_key=True)
    name = Column(String(64), nullable=False)
    category = Column(String(32), nullable=False)
    param_template = Column(JSON, nullable=False) # UI render config
    description = Column(String(255))
    # R6 软删除（§8.43）：NULL=活行，非 NULL=回收站时间戳（级联子行同戳）。
    deleted_at = Column(String(40), nullable=True)


class ProtocolTemplate(Base):
    __tablename__ = "protocols"

    id = Column(String(36), primary_key=True)
    label = Column(String(128), nullable=False)
    type = Column(String(32), default="container", nullable=False)
    description = Column(Text, nullable=True)
    children = Column(JSON, nullable=False, default=list)
    # 批次五: version 乐观并发 —— PUT 携带客户端最后见到的 version，与当前行
    # 不符 409（陈旧写拒收），每次成功写 +1。存量库缺列由
    # database.ensure_protocol_version_column 启动自愈（create_all 不补列）。
    version = Column(Integer, nullable=False, default=1)
    # R6 软删除（§8.43）：NULL=活行，非 NULL=回收站时间戳（级联子行同戳）。
    deleted_at = Column(String(40), nullable=True)

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
    # R6 软删除（§8.43）：NULL=活行，非 NULL=回收站时间戳（级联子行同戳）。
    deleted_at = Column(String(40), nullable=True)


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
    # R6 软删除（§8.43）：NULL=活行，非 NULL=回收站时间戳（级联子行同戳）。
    deleted_at = Column(String(40), nullable=True)


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

    # 批次一 1a（DESIGN_Decisions D1-A）：一行两用 —— 填槽关系（+显式 slot_id）
    # 与「指令默认封装协议」（is_default，每指令至多一行）。存量库缺列由
    # database.ensure_binding_columns 启动自愈（create_all 不补列，同批次五先例）；
    # 两个部分唯一索引（默认唯一 / 显式槽唯一）在 ensure 内 CREATE IF NOT EXISTS。
    slot_id = Column(String(36), nullable=True)  # 显式目标槽节点 id；NULL = 按 slot_order 稠密位次
    is_default = Column(Integer, nullable=False, default=0)  # 1 = 该指令的默认封装协议
    priority = Column(Integer, nullable=False, default=0)  # 多候选择序（大者先，预留）

    # CP3 3d (D7-A 余下两处之一): 绑定期所引协议的 `definition_hash`
    # （core/definition_hash.protocol_definition_hash，只在后端算）；NULL = 存量行 /
    # 占位期（protocol_id 尚未回填）→ 读侧不出徽标。协议结构改动 → 读侧重算比对
    # 出 stale 徽标，**不阻断**（绑定关系与槽位仍有效，只提示需复核）。
    # 存量库缺列由 database.ensure_binding_columns 启动自愈。
    definition_hash = Column(String(80), nullable=True)
    # R6 软删除（§8.43）：NULL=活行，非 NULL=回收站时间戳（级联子行同戳）。
    deleted_at = Column(String(40), nullable=True)


# 7. Transport Settings（P1: 连接持久化 — 单行表，id 恒为 "current"）
class TransportSetting(Base):
    __tablename__ = "transport_settings"

    id = Column(String(16), primary_key=True)  # 恒为 "current"（单行约定）
    config = Column(JSON, nullable=False)  # 当前生效传输配置（transport.default_config 形态）
    # 逻辑指针（同 op_code 先例不加 FK）：最后激活的设备档案；手工改配置/删档案时置空
    active_profile_id = Column(String(36), nullable=True)
    # R6 软删除（§8.43）：NULL=活行，非 NULL=回收站时间戳（级联子行同戳）。
    deleted_at = Column(String(40), nullable=True)


# 8. Device Profiles（P1: 设备档案 — 传输配置的命名快照）
class DeviceProfile(Base):
    __tablename__ = "device_profiles"

    id = Column(String(36), primary_key=True)
    label = Column(String(128), nullable=False, unique=True)  # 档案名唯一（路由先查给 400，DB 约束兜底）
    config = Column(JSON, nullable=False)  # 完整三段传输配置快照（validate_config 归一后入库）
    # R6 软删除（§8.43）：NULL=活行，非 NULL=回收站时间戳（级联子行同戳）。
    deleted_at = Column(String(40), nullable=True)


# 9. Response Specs（P2: 事务化发送引擎 — 按指令持久化的应答匹配规格，新表）
class ResponseSpec(Base):
    __tablename__ = "response_specs"

    id = Column(String(36), primary_key=True)
    # 逻辑外键（同 op_code 先例，不加 FK 约束）：一指令一规格，路由先查保证唯一、DB unique 兜底
    instruction_id = Column(String(36), nullable=False, unique=True)
    # 匹配规格 JSON：normalize_spec 归一后入库（core/response_match.py 为形态 SSOT）
    spec = Column(JSON, nullable=False)
    # CP3 3d (D15-A): 分层维度 —— 本行 spec.stages 的**最外层序号**
    # （= len(stages)-1；2 = 共 3 层），NULL = 未分层（spec 无 stages 键 =
    # 单层：存量手工规格 / 无配方指令的「据此生成」）。保存期由路由回写镜像，
    # 读侧不必解析 JSON 即知层数（D15 拍板「response_specs 仅加一列」）。
    stage = Column(Integer, nullable=True)
    # CP3 3d (D7-A): 「据此生成」期记录的协议链复合指纹
    # （recipe_compile.stages_fingerprint 口径：各层 protocol_definition_hash 拼接
    # 后 sha256）；NULL = 从未生成（手工规格，无出处可比 → 读侧不出徽标）。
    # 只在后端算、客户端传入忽略（同 frame_recipes.stage.definition_hash 先例）；
    # 读侧重算比对 → stale 徽标**不阻断**（D7-A）。
    definition_hash = Column(String(80), nullable=True)
    # R6 软删除（§8.43）：NULL=活行，非 NULL=回收站时间戳（级联子行同戳）。
    deleted_at = Column(String(40), nullable=True)


# 10. Sequences（P3: 序列编排 — 定义载体，新表；既有表零改）
class Sequence(Base):
    __tablename__ = "sequences"

    id = Column(String(36), primary_key=True)
    name = Column(String(128), nullable=False, unique=True)  # 序列名唯一（路由先查 400，DB 约束兜底）
    description = Column(Text, nullable=True)
    # 运行配置 JSON：normalize_config 归一（stop_on_error / read_timeout_ms）
    config = Column(JSON, nullable=False, default=dict)
    # R6 软删除（§8.43）：NULL=活行，非 NULL=回收站时间戳（级联子行同戳）。
    deleted_at = Column(String(40), nullable=True)


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
    # CP3 3c (D6-B) 序列封装帧：配方引用 {recipe_id, definition_hash(冻结期复合
    # 指纹)}；None = 裸帧步骤。有值时 payload 是**冻结完整封装帧**、plan 带
    # shell（外壳逐层 length/checksum 区间），发送期按配方重算（D6-B）。
    # 存量库缺列由 database.ensure_sequence_step_columns 启动自愈。
    wrap = Column(JSON, nullable=True)
    # R6 软删除（§8.43）：NULL=活行，非 NULL=回收站时间戳（级联子行同戳）。
    deleted_at = Column(String(40), nullable=True)


# 12. Dispatch Logs（P5: 通讯日志落库 — 三路写入（manual/transaction/sequence）
# + 回放（replay），查询/导出见 routers/logs.py、写侧件见 db/log_store.py；
# 新表，既有表零改）
class DispatchLog(Base):
    __tablename__ = "dispatch_logs"

    # 自增整型 PK（日志高频插入，顺序即时间序；查询恒 id 降序）
    id = Column(Integer, primary_key=True, autoincrement=True)
    created_at = Column(String(40), nullable=False)  # ISO-8601 UTC
    source = Column(String(16), nullable=False)  # manual | transaction | sequence | replay
    channel = Column(String(16), nullable=False)  # 发送时通道 LOOPBACK / TCP / SERIAL
    status = Column(String(16), nullable=False)  # OK | ERROR（历史 SENT/FAILED 归一）
    byte_count = Column(Integer, nullable=False, default=0)
    hex_string = Column(Text, nullable=False)  # 发送帧 space-separated uppercase
    echo = Column(Text, nullable=False, default="")  # 末次应答 compact hex（无 = ""）
    instruction_name = Column(String(128), nullable=True)  # 手动/事务标签 · 序列步 label
    instruction_id = Column(String(64), nullable=True)  # 逻辑外键：事务规格指令 / 序列步指令
    sequence_id = Column(String(36), nullable=True)  # 序列路专用（其余路 = NULL）
    step_order = Column(Integer, nullable=True)  # 1-based 步序（仅序列路）
    rtt_ms = Column(Float, nullable=True)  # 事务=末次样本 / 序列=本步；manual·replay 无
    error = Column(Text, nullable=True)  # ERROR 原因（OK 为 NULL）
    # R10（§8.48 · C-2 选 C 后半）：命中应答按指令字段布局逆向解出的
    # `字段 = 值` 快照 —— 形状与 `core.field_decode.decode_hex` 的返回值逐字相同：
    # {"fields": [{fieldId, name, opCode, byteLen, start, end, truncated, value}],
    #  "consumed", "total", "residual", "warnings"}。NULL = 解不出（无应答 /
    # 指令不可解析 / 无字段布局 / 写日志前失败）。**仅新增列**（§0 硬约束）：
    # 新库 create_all 直接带，存量库由 db/migrate.py 的 0003 补列（幂等）。
    # 展示层**不改它** —— 解码值原样落库，展示层的 7 位有效数字收敛只发生在 FE。
    fields_json = Column(JSON, nullable=True)
    # R6 软删除（§8.43）：NULL=活行，非 NULL=回收站时间戳（级联子行同戳）。
    deleted_at = Column(String(40), nullable=True)


# 13. Frame Recipes（CP3 3a: 封装配方 — D13 拍板 A「封装配方 + 串行编译」，
# 新表；既有表零改 + instructions.default_recipe_id 一列自愈补列）
class FrameRecipe(Base):
    __tablename__ = "frame_recipes"

    id = Column(String(36), primary_key=True)
    name = Column(String(128), nullable=False)
    description = Column(Text, nullable=True)
    # 有序 JSON 数组（index 0 = 最内层，直接包内核）：每项
    # {protocol_id, slot_ids?, definition_hash?} —— 解析/校验/回写见
    # schemas/recipe_api.py 与 routers/recipe.py；definition_hash 由服务端算。
    stages = Column(JSON, nullable=False, default=list)
    # 镜像 protocols.version 乐观并发：PUT 带 version 与当前行不符 409，
    # 每次成功写 +1（存量行为缺省 1）。
    version = Column(Integer, nullable=False, default=1)
    created_at = Column(Text, nullable=True)  # ISO-8601 UTC
    updated_at = Column(Text, nullable=True)  # ISO-8601 UTC
    # R6 软删除（§8.43）：NULL=活行，非 NULL=回收站时间戳（级联子行同戳）。
    deleted_at = Column(String(40), nullable=True)
