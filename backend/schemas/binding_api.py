from typing import Optional

from pydantic import BaseModel

# E4 编排绑定 API schema：绑定 = protocol_id + instruction_id + 插槽序（+ 展示 label）。
# 字段名与前端 toServer 对齐（snake_case 出线）。
# 批次一 1a（D1-A 一行两用）：+ slot_id（显式目标槽）/ is_default（指令默认封装协议）
# / priority（多候选择序，预留）。三列缺省与 DB 自愈口径一致：slot_id NULL、
# is_default False、priority 0。


class BindingCreate(BaseModel):
    id: Optional[str] = None  # 前端可自带 uuid（同 protocol.py 先例），缺省服务器生成
    protocol_id: str = ""
    instruction_id: str = ""
    label: str = "新绑定 (NEW)"
    slot_order: Optional[int] = None  # 缺省 → 服务器按 max+1 分配
    slot_id: Optional[str] = None  # 显式目标槽节点 id；None = 按 slot_order 稠密位次
    is_default: bool = False  # True → 同指令旧默认同事务清零（部分唯一索引兜底）
    priority: int = 0


class BindingUpdate(BaseModel):
    # 全部可选：None = 不改（区别于 protocol.py 的整对象 PUT，允许局部更新）
    protocol_id: Optional[str] = None
    instruction_id: Optional[str] = None
    label: Optional[str] = None
    slot_order: Optional[int] = None
    slot_id: Optional[str] = None  # None = 不改（批次一无清空显式槽的 UI）
    is_default: Optional[bool] = None  # None = 不改；False = 显式取消默认
    priority: Optional[int] = None


class BindingResponse(BaseModel):
    id: str
    protocol_id: str
    instruction_id: str
    label: str
    slot_order: int
    slot_id: Optional[str] = None
    is_default: bool = False
    priority: int = 0

    class Config:
        from_attributes = True
