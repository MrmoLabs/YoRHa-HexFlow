from typing import Optional

from pydantic import BaseModel

# E4 编排绑定 API schema：绑定 = protocol_id + instruction_id + 插槽序（+ 展示 label）。
# 字段名与前端 toServer 对齐（snake_case 出线）。


class BindingCreate(BaseModel):
    id: Optional[str] = None  # 前端可自带 uuid（同 protocol.py 先例），缺省服务器生成
    protocol_id: str = ""
    instruction_id: str = ""
    label: str = "新绑定 (NEW)"
    slot_order: Optional[int] = None  # 缺省 → 服务器按 max+1 分配


class BindingUpdate(BaseModel):
    # 全部可选：None = 不改（区别于 protocol.py 的整对象 PUT，允许局部更新）
    protocol_id: Optional[str] = None
    instruction_id: Optional[str] = None
    label: Optional[str] = None
    slot_order: Optional[int] = None


class BindingResponse(BaseModel):
    id: str
    protocol_id: str
    instruction_id: str
    label: str
    slot_order: int

    class Config:
        from_attributes = True
