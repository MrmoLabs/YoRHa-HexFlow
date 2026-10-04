from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

# P3 序列编排 API 模型：定义 CRUD（保存时定值）+ 运行状态（轮询契约）。
# 归一/校验在路由层（_normalize_config / core.sequence_plan.normalize_plan，
# ValueError → 400）；此处只承形状，不做业务判定。


class SequenceStepSpec(BaseModel):
    instruction_id: str = Field(..., description="逻辑外键 → instructions.id（审计回溯）")
    label: Optional[str] = Field(None, description="步骤显示名（缺省用指令名 / step-N）")
    delay_ms: int = Field(0, description="本步执行前等待（0..60000）")
    params: Optional[Dict[str, Any]] = Field(
        None, description="保存时冻结的表单参数 {field_id: value}"
    )
    payload: str = Field(..., description="保存时编译的完整帧 hex（前端 encodeInstruction 产物）")
    plan: Optional[Dict[str, Any]] = Field(
        None, description="发送时重算计划 {dynamic, checksum}（normalize_plan 归一后入库）"
    )
    # CP3 3c (D6-B): 序列封装帧 —— 选配方后该步冻结**完整封装帧**，plan 由路由
    # 注入 plan.shell（外壳逐层区间）；发送期按配方重算外壳。未选 = 现状裸帧路径。
    wrap: Optional[Dict[str, Any]] = Field(
        None, description="{recipe_id}（请求形）；落库形另带 definition_hash"
    )
    # R26（§8.58）序列级分支：本步执行条件 —— 受限表达式（`== != >= <= > < in`，
    # 无 eval）。None / 空 = 无条件（存量步骤缺省路径，行为逐字节不变）。
    # 保存侧只查语法（routers/sequence._condition_spec），变量到运行期才存在。
    condition: Optional[str] = Field(
        None, description="执行条件表达式；None/空 = 无条件"
    )


class SequencePayload(BaseModel):
    """POST /sequences 与 PUT /{id} 的同形全量体（PUT = 整体替换）。"""

    name: str
    description: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    steps: List[SequenceStepSpec] = Field(default_factory=list)


class SequenceStepOut(BaseModel):
    id: str
    step_order: int
    instruction_id: str
    label: Optional[str] = None
    delay_ms: int
    params: Optional[Dict[str, Any]] = None
    payload: str
    plan: Optional[Dict[str, Any]] = None
    # 批次二 (D14②): 宿主指令已被删除 → 步骤失效标记（冻结快照仍可运行，仅
    # 编辑入口不可用）。零 DDL：判据 = instruction_id 悬空。
    instruction_missing: bool = False
    # CP3 3c (D6-B): 配方引用（{recipe_id, definition_hash}）；协议结构变了才亮
    # 徽标（D15 关联项 2），步骤冻结帧不受影响、不阻断。
    wrap: Optional[Dict[str, Any]] = None
    # R26（§8.58）步骤执行条件回显；null = 无条件（存量步骤/未自愈列同 null）
    condition: Optional[str] = None


class SequenceOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    config: Dict[str, Any] = Field(default_factory=dict)
    steps: List[SequenceStepOut] = Field(default_factory=list)


class StepResult(BaseModel):
    """一次运行的逐步结果（sequence_runner._step_record 形状）。"""

    n: int
    step_id: str
    label: str
    instruction_id: str
    status: str  # OK | ERROR | SKIPPED
    sent: Optional[str] = None
    received: Optional[str] = None
    rtt_ms: Optional[float] = None
    error: Optional[str] = None


class SequenceStatus(BaseModel):
    """轮询契约（P4 序列页 1.5s GET /sequences/status）。"""

    running: bool
    result: str  # idle | running | completed | failed | stopped
    sequence_id: Optional[str] = None
    sequence_name: Optional[str] = None
    total_steps: int = 0
    current_step: Optional[int] = None  # 1-based 进行中的步；非运行 → None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    stop_requested: bool = False
    error: Optional[str] = None
    steps: List[StepResult] = Field(default_factory=list)
