"""R36 发前路由 · API 契约（PLAN §8.68）。

- `RoutingRuleCreate`  : 建/改规则的写入体（PUT 整体替换，无部分更新语义）
- `RoutingRuleResponse`: 行的读出体
- `RouteResolveRequest` / `RouteResolveResponse` : `POST /dispatch/routed` 的入参
  与回执 —— **只解析不发送**，回执里没有 `status` / `attempts` / `hex_string`
  （那三个是 `DispatchRecord` 的字段，出现即说明串进了 `/dispatch` 缺省口径，
  违反 §0）。
"""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from backend.schemas.instruction_api import InstructionResponse


class RoutingRuleCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    condition: str = Field(..., min_length=1, max_length=200)
    instruction_id: str = Field(..., min_length=1, max_length=36)
    sort_order: int = 0
    # 0/1（models 用 Integer，与 sort_order 同型；不引 Boolean，存量库无先例）
    enabled: int = 1
    description: Optional[str] = None


class RoutingRuleResponse(BaseModel):
    id: str
    name: str
    condition: str
    instruction_id: str
    sort_order: int
    enabled: int
    description: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class RouteResolveRequest(BaseModel):
    """发前输入表。键是**扁平字符串**，与 `evaluate_condition` 的变量表同形。"""

    inputs: Dict[str, Any] = Field(default_factory=dict)


class RouteResolveResponse(BaseModel):
    matched: bool
    rule: Optional[RoutingRuleResponse] = None
    instruction_id: Optional[str] = None
    # 命中即回指令全文（FE 拿来直接渲染，省一次 /instructions 往返）
    instruction: Optional[InstructionResponse] = None
    # 结构性缺陷清单（条件语法坏掉 / 目标指令已进回收站）—— 静态跳过、不 500
    invalid: List[Dict[str, Any]] = Field(default_factory=list)
    considered: int = 0
