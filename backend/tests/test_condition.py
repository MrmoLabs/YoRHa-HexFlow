"""R26（PLAN §8.58 · §8.52 排期第 6 批）：序列步骤条件 —— 受限表达式求值器。

共享向量单一真相源 = `vectors/condition.json`（本文件与 FE `condition.test.js` 同读一份，
58 行：`expected` = 求值结果、`error` = 预期错误文案**逐字相同**）。一条条件 = 一次比较：

    左操作数  运算符（== != >= <= > < in）  右操作数

**无 eval / 无 exec / 无属性反射**：没有算术、没有括号、没有布尔连接、没有函数调用，
多一个字符就报错（fail-closed）。变量名是**一整个裸词**，查表 = 整串精确匹配 ——
`step.1.status` 是一个键，不是「点号下钻」。

双端纪律：FE `utils/condition.js` 与 `backend/core/condition.py` **逐行同语义**，
两端都跑这张表 → 任何一端的语义漂移都会红。

Run from repo root: python -m unittest backend.tests.test_condition
"""
import unittest

from backend.core.condition import (
    KEYWORDS,
    MAX_ARRAY_ITEMS,
    MAX_CONDITION_LEN,
    MAX_TOKENS,
    OPS,
    ConditionError,
    evaluate_condition,
    parse_condition,
)
from vectors.load_vectors import load_vectors

VECTORS = load_vectors("condition")


class ConditionVectorTest(unittest.TestCase):
    """共享向量 58 行：求值结果与错误文案**双端逐字一致**。"""

    def test_vector_table_is_not_empty(self):
        self.assertGreaterEqual(len(VECTORS), 50)

    def test_every_vector_row(self):
        for i, row in enumerate(VECTORS):
            expr, variables = row["expr"], row.get("vars") or {}
            if "error" in row:
                with self.assertRaises(ConditionError, msg=f"#{i} {expr!r}") as ctx:
                    evaluate_condition(expr, variables)
                self.assertEqual(
                    str(ctx.exception), row["error"], f"#{i} {expr!r}"
                )
            else:
                self.assertIs(
                    evaluate_condition(expr, variables), row["expected"],
                    f"#{i} {expr!r}",
                )

    def test_errors_carry_no_boolean_silently(self):
        """求值失败**绝不**静默当 False（否则步骤会被悄悄跳过）。"""
        with self.assertRaises(ConditionError):
            evaluate_condition("nope == 1", {})


class ConditionGrammarTest(unittest.TestCase):
    """语法面（与求值分离 —— 保存侧只查语法，此时变量还没到运行期）。"""

    def test_parse_only_ignores_unknown_variables(self):
        left, op, right = parse_condition("任何变量 >= 1")
        self.assertEqual(left, ("var", "任何变量"))
        self.assertEqual(op, ">=")
        self.assertEqual(right, ("num", 1))

    def test_operator_whitelist_is_the_six_from_the_vote(self):
        # §8.52 拍板 5 项 + 补齐 §8.36 例 A 用的 >= / <=
        self.assertEqual(OPS, ("==", "!=", ">=", "<=", ">", "<"))
        self.assertEqual(KEYWORDS, ("true", "false", "null", "in"))

    def test_no_arithmetic_no_parentheses_no_boolean_glue(self):
        for expr in (
            "a + 1 == 2",
            "(a) >= 1",
            "a >= 1 && b >= 1",
            "a >= 1 || b >= 1",
            "len(a) == 1",
            "a * 2 == 1",
        ):
            with self.assertRaises(ConditionError, msg=expr):
                parse_condition(expr)

    def test_limits_are_enforced(self):
        with self.assertRaises(ConditionError) as ctx:
            parse_condition("a >= " + "1" * (MAX_CONDITION_LEN + 10))
        self.assertIn(str(MAX_CONDITION_LEN), str(ctx.exception))

        with self.assertRaises(ConditionError) as ctx:
            parse_condition(("[1] == [1] " * 10))
        self.assertIn(str(MAX_TOKENS), str(ctx.exception))

        # 数组元素上限是第二道（记号上限会先拦，这里直接打 parser）
        with self.assertRaises(ConditionError):
            parse_condition(
                "[" + ",".join(str(i % 10) for i in range(MAX_ARRAY_ITEMS + 3)) + "] == 1"
            )

    def test_empty_is_rejected(self):
        for bad in (None, "", "   "):
            with self.assertRaises(ConditionError, msg=repr(bad)) as ctx:
                parse_condition(bad)
            self.assertEqual(str(ctx.exception), "条件为空")

    def test_trailing_and_leading_garbage_is_rejected(self):
        with self.assertRaises(ConditionError) as ctx:
            parse_condition("a == 1 == 2")
        self.assertIn("多余的记号", str(ctx.exception))


class ConditionSemanticsTest(unittest.TestCase):
    """几条不靠向量也要钉死的语义。"""

    def test_lookup_is_exact_match_not_dotted_traversal(self):
        # 变量表里既有平铺键也有带点键 —— 整串精确匹配，前缀/下钻都不参与
        variables = {"status": "X", "step.1.status": "OK", "step": {"1": {"status": "Y"}}}
        self.assertIs(evaluate_condition('step.1.status == "OK"', variables), True)
        self.assertIs(evaluate_condition('status == "X"', variables), True)
        # 表里真有个嵌套 dict 也只当「一个值」用（不可下钻 → 类型比较报错）
        with self.assertRaises(ConditionError) as ctx:
            evaluate_condition("step == 1", variables)
        self.assertIn("类型无法比较", str(ctx.exception))

    def test_null_only_equals_null(self):
        self.assertIs(evaluate_condition("v == null", {"v": None}), True)
        self.assertIs(evaluate_condition("v == 0", {"v": None}), False)
        self.assertIs(evaluate_condition("v != 0", {"v": None}), True)
        with self.assertRaises(ConditionError):  # 顺序比较遇上 null → 类型错
            evaluate_condition("v > 0", {"v": None})

    def test_in_is_substring_or_array_membership(self):
        self.assertIs(evaluate_condition('"A5" in v', {"v": "A501"}), True)
        self.assertIs(evaluate_condition('v in ["A501", "B0B1"]', {"v": "A501"}), True)
        self.assertIs(evaluate_condition('v in ["B0B1"]', {"v": "A501"}), False)
        self.assertIs(evaluate_condition("v in []", {"v": "A501"}), False)

    def test_numbers_compare_across_int_and_float(self):
        self.assertIs(evaluate_condition("v == 4608.0", {"v": 4608}), True)
        self.assertIs(evaluate_condition("v >= 4608", {"v": 4608.0}), True)
        self.assertIs(evaluate_condition("v == 0x1200", {"v": 4608}), True)

    def test_bool_is_never_a_number(self):
        for expr in ("v == 1", "v > 0", "v < 1"):
            with self.assertRaises(ConditionError, msg=expr):
                evaluate_condition(expr, {"v": True})


if __name__ == "__main__":
    unittest.main()
