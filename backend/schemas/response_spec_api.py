from typing import Any, Dict, List, Optional

from pydantic import BaseModel

# P2 应答规格 API schema：一指令一规格（response_specs.instruction_id 逻辑唯一）。
# spec 形态由 backend/core/response_match.py 的 normalize_spec 定为 SSOT（400）。
#
# CP3 3d (D15-A / D7-A)：
# - 请求形仍只收 `spec`（ResponseSpecUpsert）——`stage` 是 `spec.stages` 的行级镜像、
#   `definition_hash` 只在后端算，客户端传入一律忽略（同 frame_recipes 先例）；
# - 响应形多 `stage`（最外层序号 / NULL=未分层）、`definition_hash`（出处指纹）、
#   `stale`（D7-A 失效徽标：true=协议链已变、false=仍匹配、null=无出处可比）；
# - 「据此生成」另用 ResponseSpecGenerateResponse（多回层数与降级 warning）。


class ResponseSpecUpsert(BaseModel):
    spec: Dict[str, Any]


class ResponseSpecResponse(BaseModel):
    id: str
    instruction_id: str
    spec: Dict[str, Any]
    stage: Optional[int] = None
    definition_hash: Optional[str] = None
    stale: Optional[bool] = None

    class Config:
        from_attributes = True


class ResponseSpecLayer(BaseModel):
    """生成用的层摘要（协议 children 不出线 —— 前端只要知道是哪几层）。"""

    protocol_id: str
    label: Optional[str] = None


class ResponseSpecGenerateResponse(ResponseSpecResponse):
    layers: List[ResponseSpecLayer] = []
    warnings: List[str] = []


class ResponseSpecTarget(BaseModel):
    """协议页「据此生成」的候选指令（`uses_protocol` = 当前协议在该指令层链内）。"""

    instruction_id: str
    name: str = ""
    code: str = ""
    layers: int = 0
    recipe_id: Optional[str] = None
    uses_protocol: bool = False
