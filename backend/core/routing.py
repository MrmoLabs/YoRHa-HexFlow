"""R36 发前路由（PLAN §8.68 · §8.52 C-1 选项 C 经翻案立项）—— 按输入值选指令。

**复用 `core/condition.py` 受限表达式，不造第二套判据**：一条规则 = 一次比较，
与序列步骤的 `condition` 同形（无 eval / 无布尔连接 / 无算术）。条件的 SSOT 是
`condition.py`，FE 侧 `utils/condition.js` 逐行同语义、共享向量
`vectors/condition.json` —— 本模块**不碰**它，只在上面套一层「挑哪条」。

匹配口径（五条，改一必改二）：

1. **定序** = `(sort_order 升序, name 升序, id 升序)` —— 总序确定，同 `sort_order`
   不依赖插入顺序，也不依赖数据库返回顺序；
2. **first-match-wins**：第一条判真者胜出，其后不再看；
3. **停用（enabled=0）与回收站（deleted_at 非 NULL）的行不参与**（白做两层防御：
   查询侧已滤，这里再滤一次，免得调用方换个查询就把口径漏掉）；
4. **条件语法坏掉 → 记进 `invalid` 并继续往下扫**：保存侧 `parse_condition` 已拦
   400，运行期踩到只可能来自直接改库；一条坏规则既不该让整条路由 500，更不该
   让它「误命中」；
5. **变量不在输入里 / 类型不可比 → 普通不命中，不记 `invalid`**：输入侧不满足是
   正常结果，不是规则缺陷。第 4、5 条抛的同为 `ConditionError`，靠先单独
   `parse_condition` 过一遍区分开：**解析期**挂 = 规则坏了，**求值期**挂 = 这次
   输入没给它要的键。

**全无命中 → `matched=False`，绝不回落到第一条**（不猜）。
"""
from typing import Any, Dict, Iterable, List, Tuple

from backend.core.condition import ConditionError, evaluate_condition, parse_condition


def routing_order(rule: Any) -> Tuple[int, str, str]:
    """定序键（口径 1）。字段缺失按 0 / 空串兜底，不抛。"""
    return (
        int(getattr(rule, "sort_order", 0) or 0),
        str(getattr(rule, "name", "") or ""),
        str(getattr(rule, "id", "") or ""),
    )


def select_rule(rules: Iterable[Any], inputs: Dict[str, Any]) -> Dict[str, Any]:
    """按口径扫规则表 → 首个判真者。

    `rules` 是鸭子对象（`id/name/condition/instruction_id/sort_order/enabled/
    deleted_at`），免建库即可测；返回四个键：

    - `matched`  : 是否命中
    - `rule`     : 命中的规则对象，未命中为 None
    - `invalid`  : `[{id, name, condition, reason}]` —— **解析期**就坏掉的规则
    - `considered`: 实际求值过的规则条数（停用 / 回收站行不计）
    """
    invalid: List[Dict[str, str]] = []
    considered = 0
    for rule in sorted(rules, key=routing_order):
        if not getattr(rule, "enabled", 1):
            continue
        if getattr(rule, "deleted_at", None) is not None:
            continue
        condition = getattr(rule, "condition", "")
        try:
            parse_condition(condition)
        except ConditionError as exc:
            invalid.append(
                {
                    "id": str(getattr(rule, "id", "")),
                    "name": str(getattr(rule, "name", "")),
                    "condition": str(condition or ""),
                    "reason": str(exc),
                }
            )
            continue
        considered += 1
        try:
            if evaluate_condition(condition, inputs or {}):
                return {
                    "matched": True,
                    "rule": rule,
                    "invalid": invalid,
                    "considered": considered,
                }
        except ConditionError:
            # 求值期挂（变量未定义 / 类型不可比）= 这次输入不满足 → 普通不命中
            continue
    return {"matched": False, "rule": None, "invalid": invalid, "considered": considered}
