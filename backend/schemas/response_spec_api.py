from typing import Any, Dict

from pydantic import BaseModel

# P2 应答规格 API schema：一指令一规格（response_specs.instruction_id 逻辑唯一）。
# spec 形态由 backend/core/response_match.py 的 normalize_spec 定为 SSOT（400）。


class ResponseSpecUpsert(BaseModel):
    spec: Dict[str, Any]


class ResponseSpecResponse(BaseModel):
    id: str
    instruction_id: str
    spec: Dict[str, Any]

    class Config:
        from_attributes = True
