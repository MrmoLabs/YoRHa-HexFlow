from typing import Dict, List

from pydantic import BaseModel

# R6 软删除 / 回收站（PLAN §8.43）：回收站读写三件套的 API 形状。
# 形状刻意压到最小 —— 条目只要「哪一类 / 哪一行 / 叫什么 / 何时入站」，
# 详情由各业务读端点自己给；恢复/彻底删除回执只回级联计数（镜像
# delete_* 既有 `deleted_bindings` / `cleared_instructions` 的回执风格）。


class TrashItem(BaseModel):
    kind: str          # 见 routers/trash.py 的 KINDS 白名单
    id: str
    label: str         # 展示名（各 kind 自带口径，缺省回落 id）
    deleted_at: str    # ISO-8601 时间戳（= 入回收站时刻 = 级联共用戳）


class TrashList(BaseModel):
    items: List[TrashItem]
    count: int


class TrashOpResponse(BaseModel):
    status: str                # restored | purged
    kind: str
    id: str
    related: Dict[str, int] = {}  # 级联子行计数 {bindings: 1, ...}
