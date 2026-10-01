from typing import List, Optional

from pydantic import BaseModel, Field

# CP3 3a (D13): /recipes CRUD API schema。字段名与前端 toServer 对齐
# （snake_case 出线）；stages 是**服务端解析校验**的结构（不是裸字符串），
# definition_hash 由服务端算并回写 —— 客户端传入一律忽略（非用户输入，§9.1）。
#
# 与 protocols.version 同款乐观并发：RecipeUpdate.version 缺省 None（curl 直调
# 跳过比对），给了就必须与当前行一致，否则 409。

MAX_RECIPE_STAGES = 4   # §9.5-3 层数上限（建议 ≤4，本批取 4）
MAX_RECIPE_NAME = 128   # 镜像 protocols.label 长度上限


class RecipeStage(BaseModel):
    """配方单项（有序：index 0 = 最内层，直接包内核）。"""

    protocol_id: str
    # 该层承载槽，位置对应 payloads；None/空 = 稠密位次（镜像 build_wrapped
    # start_order 口径，§9.1 表）。
    slot_ids: Optional[List[Optional[str]]] = None
    # 服务端回写（sha256:…）：保存与编译时由后端按该层协议 children 算并回显。
    definition_hash: Optional[str] = None


class RecipeCreate(BaseModel):
    id: Optional[str] = None  # 前端可自带 uuid（同 protocol.py 先例），缺省服务器生成
    name: str = ""
    description: Optional[str] = None
    stages: List[RecipeStage] = Field(default_factory=list)
    # 可选：本配方设为该指令的默认封装配方（写 instructions.default_recipe_id，
    # 单列天然唯一）—— 加工页降级链「配方 → 默认协议 → 裸发」按它取配方。
    instruction_id: Optional[str] = None


class RecipeUpdate(BaseModel):
    # 全部可选：None = 不改（区别于 protocol.py 的整对象 PUT，允许局部更新）
    name: Optional[str] = None
    description: Optional[str] = None
    stages: Optional[List[RecipeStage]] = None
    instruction_id: Optional[str] = None  # None = 不改；"" = 解除指令关联
    version: Optional[int] = None  # 乐观并发：给了就必须与当前行一致（否则 409）


class RecipeResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    stages: List[RecipeStage]
    version: int = 1
    # 反查：当前指向本配方的指令（0 或 1 条 —— 单列天然唯一）
    instruction_id: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    class Config:
        from_attributes = True
