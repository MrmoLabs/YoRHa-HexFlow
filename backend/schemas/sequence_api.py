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
