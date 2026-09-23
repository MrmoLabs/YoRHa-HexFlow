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
    # 批次五: version 乐观并发 —— 缺省 None = 旧客户端 / curl 直调，跳过比对
    # 直接覆盖（向后兼容先例: 批次四无 refs 键的旧 range 模式原样保留）。
    version: Optional[int] = None


class ProtocolResponse(ProtocolBase):
    id: str
    # 批次五: 回读 version 供客户端下一次 PUT 携带（新建恒 1，每次成功写 +1）。
    version: int = 1

    class Config:
        from_attributes = True
