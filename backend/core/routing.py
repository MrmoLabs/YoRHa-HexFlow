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

R43（PLAN §8.75）增 `trace`：上面五条口径里「跳过」与「不命中」原先都只留在
本模块内部，调用方只看得到「扫了几条、命中没有」—— 比较不成立 / 变量不在输入 /
类型不可比在回执里**同为不命中**，规则作者说不出自己那条卡在哪。轨迹给
**每条参与定序的规则一行** `code` + `detail`：

- 轨迹**只记录、不判定** —— 判据仍是 `condition.py` 一处，不造第二套；
- 回收站行**不进轨迹**（列表页本就看不见它们）；
- 命中即停，其后的规则标 `NOT_EVALUATED`（**没被求值过**，与 `considered` 同源，
  不许说成「比较不成立」）。
"""
from typing import Any, Dict, Iterable, List, Tuple

from backend.core.condition import ConditionError, evaluate_condition, parse_condition

#: 轨迹码 —— FE `utils/routeResolve.js` 的 `TRACE_LABELS` 是它的**超集**（多一个
#: `INSTRUCTION_MISSING`，那条由 `routers/routing.resolve_route` 那层静态跳过补，
#: 不在这里，因为 `select_rule` 根本看不见悬空规则），改一必改二。
#: 码给机器分支（FE 高亮 / 测试断言），中文文案归 FE（判据与事实都在后端）。
TRACE_CODES: Tuple[str, ...] = (
    "MATCHED",               # 判真命中
    "COND_FALSE",            # 比较不成立
    "VAR_UNDEFINED",         # 变量不在本次输入里
    "TYPE_INCOMPARABLE",     # 类型不可比
    "COND_ERROR",            # 求值期其它错误（`in` 右侧不是数组/字符串…）
    "CONDITION_INVALID",     # 条件语法坏掉（解析期）
    "DISABLED",              # 已停用
    "NOT_EVALUATED",         # 未轮到 —— 前面已有命中
)

#: 求值期 `ConditionError` 文案前缀 → 轨迹码。**文案改一条这里就得改一条**：
#: `EvalCodePrefixTest` 从分类这一侧钉住，漂移即红（兜底码会吞掉归因）。
EVAL_CODE_PREFIXES: Tuple[Tuple[str, str], ...] = (
    ("变量未定义：", "VAR_UNDEFINED"),
    ("类型无法比较：", "TYPE_INCOMPARABLE"),
)


def _eval_code(exc: ConditionError) -> Tuple[str, str]:
    """求值期错误 → `(code, detail)`；`detail` 是**载荷**不是整句。

    `变量未定义：nope` → `("VAR_UNDEFINED", "nope")`、
    `类型无法比较：数字 与 字符串` → `("TYPE_INCOMPARABLE", "数字 与 字符串")`；
    认不出的（`右侧须是数组或字符串，实得 数字`…）落 `COND_ERROR` 并原样带走，
    FE 拼成「求值未通过：原文」—— 不猜、也不吞。
    """
    message = str(exc)
    for prefix, code in EVAL_CODE_PREFIXES:
        if message.startswith(prefix):
            return code, message[len(prefix) :]
    return "COND_ERROR", message


def routing_order(rule: Any) -> Tuple[int, str, str]:
    """定序键（口径 1）。字段缺失按 0 / 空串兜底，不抛。"""
    return (
        int(getattr(rule, "sort_order", 0) or 0),
        str(getattr(rule, "name", "") or ""),
        str(getattr(rule, "id", "") or ""),
    )


def _trace_row(rule: Any, code: str, detail: str = "") -> Dict[str, str]:
    """一行轨迹：与 `invalid` 同形多 `code` / `detail` 两键。"""
    condition = getattr(rule, "condition", "")
    return {
        "id": str(getattr(rule, "id", "")),
        "name": str(getattr(rule, "name", "")),
        "condition": str(condition or ""),
        "code": code,
        "detail": detail,
    }


def select_rule(rules: Iterable[Any], inputs: Dict[str, Any]) -> Dict[str, Any]:
    """按口径扫规则表 → 首个判真者。

    `rules` 是鸭子对象（`id/name/condition/instruction_id/sort_order/enabled/
    deleted_at`），免建库即可测；返回五个键：

    - `matched`  : 是否命中
    - `rule`     : 命中的规则对象，未命中为 None
    - `invalid`  : `[{id, name, condition, reason}]` —— **解析期**就坏掉的规则
    - `considered`: 实际求值过的规则条数（停用 / 回收站行不计）
    - `trace`    : `[{id, name, condition, code, detail}]` —— 每条参与定序的规则
      一行「为什么」（R43 · §8.75），顺序 = 定序；判定口径与 `considered` 一字未改
    """
    invalid: List[Dict[str, str]] = []
    trace: List[Dict[str, str]] = []
    considered = 0
    matched_rule: Any = None
    stopped = False
    for rule in sorted(rules, key=routing_order):
        if getattr(rule, "deleted_at", None) is not None:
            # 回收站行不进列表也不进轨迹（口径 3 的白做防御留在这里）
            continue
        if stopped:
            # first-match-wins（口径 2）：**没被求值过**，不是「比较不成立」
            trace.append(_trace_row(rule, "NOT_EVALUATED"))
            continue
        if not getattr(rule, "enabled", 1):
            trace.append(_trace_row(rule, "DISABLED"))
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
            trace.append(_trace_row(rule, "CONDITION_INVALID", str(exc)))
            continue
        considered += 1
        try:
            hit = evaluate_condition(condition, inputs or {})
        except ConditionError as exc:
            # 求值期挂（变量未定义 / 类型不可比）= 这次输入不满足 → 普通不命中
            code, detail = _eval_code(exc)
            trace.append(_trace_row(rule, code, detail))
            continue
        if hit:
            trace.append(_trace_row(rule, "MATCHED"))
            matched_rule = rule
            stopped = True
        else:
            trace.append(_trace_row(rule, "COND_FALSE"))
    return {
        "matched": matched_rule is not None,
        "rule": matched_rule,
        "invalid": invalid,
        "considered": considered,
        "trace": trace,
    }
