from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ProtocolNodeSchema(BaseModel):
    id: str
    label: str
    type: str
    byte_length: int = 0
    hex_value: Optional[str] = None
    config: Dict[str, Any] = Field(default_factory=dict)
    # 一期 A6: refs 引用走 children JSON 列（零 DDL）—— 不透传则 pydantic
    # 丢字段、刷新后 refs 失效。
    parameter_config: Optional[Dict[str, Any]] = None
    children: List['ProtocolNodeSchema'] = Field(default_factory=list)

    class Config:
        from_attributes = True


ProtocolNodeSchema.model_rebuild()


class ProtocolBase(BaseModel):
    label: str
    type: str = "container"
    description: Optional[str] = None
    children: List[ProtocolNodeSchema] = Field(default_factory=list)


class ProtocolCreate(ProtocolBase):
    id: Optional[str] = None


class ProtocolUpdate(ProtocolBase):
    pass


class ProtocolResponse(ProtocolBase):
    id: str

    class Config:
        from_attributes = True
