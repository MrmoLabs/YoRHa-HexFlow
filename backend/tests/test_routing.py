"""R36 发前路由 · 单测（PLAN §8.68 —— §8.52 C-1 选项 C 经用户翻案立项）。

两级钉：

1. **纯匹配器** `backend.core.routing.select_rule` —— 定序（sort_order 升序，同值
   按 name 稳序）· first-match-wins · 停用与回收站行不参与 · 条件**语法**坏掉记进
   `invalid` 并**继续往下扫**（一条坏规则不该让整条路由 500，更不该让它误命中）·
   变量不在输入里 = **普通不命中**（不是缺陷，不记 invalid）。
2. **数据层 + 解析端点** —— CRUD 校验（语法 / 目标指令存在 / 名字唯一）与
   `resolve_route` 的「**不猜**」口径（无命中就是 matched=false，绝不回落第一条）。

§0 锚：`/dispatch/routed` 是**新增端点**、只解析不发送 —— 回执里不得出现
`DispatchRecord` 的 `status` / `attempts` / `hex_string` 字段（出现即说明它串进了
`/dispatch` 缺省口径）。

Run from repo root: python -m unittest backend.tests.test_routing
"""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core.routing import select_rule
from backend.db.database import Base
from backend.db.models import Instruction, RoutingRule
from backend.routers.dispatch import dispatch_routed, RouteResolveRequest
from backend.routers.routing import (
    create_rule,
    delete_rule,
    list_rules,
    resolve_route,
    update_rule,
)
from backend.routers.trash import list_trash, purge_trash_item, restore_trash_item
from backend.schemas.routing_api import RoutingRuleCreate

INSTR_A = "11111111-aaaa-4bbb-8ccc-000000000001"
INSTR_B = "11111111-aaaa-4bbb-8ccc-000000000002"
# 上述两条既有测试同款：`v == 1 == 2` 语法非法（test_condition 已锁）、
# `nope == 1` 变量未定义（test_condition 已锁）。
BAD_SYNTAX = "v == 1 == 2"
UNDEFINED_VAR = "nope == 1"


def _rule(
    name,
    condition,
    sort_order=0,
    enabled=1,
    deleted_at=None,
    id="r",
    instruction_id=INSTR_A,
):
    """匹配器入参：与 `RoutingRule` 行同形的鸭子对象（免建库）。"""
    return SimpleNamespace(
        id=id,
        name=name,
        condition=condition,
        instruction_id=instruction_id,
        sort_order=sort_order,
        enabled=enabled,
        deleted_at=deleted_at,
    )


class SelectRuleTest(unittest.TestCase):
    """纯匹配器语义（FE 侧若将来本地预览须同源；改一必改二）。"""

    def test_order_is_sort_order_then_name(self):
        # 同 sort_order 的两条按 name 升序 —— 定序不飘，不依赖插入顺序
        out = select_rule(
            [_rule("乙", "v == 2", id="a"), _rule("甲", "v == 1", id="b")],
            {"v": 1},
        )
        self.assertTrue(out["matched"])
        self.assertEqual(out["rule"].name, "甲")

    def test_lower_sort_order_wins_even_if_listed_later(self):
        first = _rule("高", "v == 9", sort_order=1, id="hi")
        second = _rule("低", "v == 1", sort_order=0, id="lo")
        out = select_rule([first, second], {"v": 1})
        self.assertEqual(out["rule"].id, "lo")

    def test_first_match_wins(self):
        out = select_rule(
            [_rule("一", "v == 1", sort_order=0, id="a"),
             _rule("二", "v == 1", sort_order=1, id="b")],
            {"v": 1},
        )
        self.assertEqual(out["rule"].id, "a")

    def test_disabled_rule_never_matches(self):
        out = select_rule([_rule("停用", "v == 1", enabled=0, id="a")], {"v": 1})
        self.assertFalse(out["matched"])
        self.assertIsNone(out["rule"])

    def test_trashed_rule_never_matches(self):
        out = select_rule(
            [_rule("已删", "v == 1", deleted_at="2026-10-06T00:00:00+00:00", id="a")],
            {"v": 1},
        )
        self.assertFalse(out["matched"])

    def test_broken_syntax_recorded_invalid_and_scan_continues(self):
        out = select_rule(
            [_rule("坏条件", BAD_SYNTAX, sort_order=0, id="bad"),
             _rule("好条件", "v == 1", sort_order=1, id="good")],
            {"v": 1},
        )
        self.assertTrue(out["matched"])
        self.assertEqual(out["rule"].id, "good")  # 坏的那条不中断扫描
        self.assertEqual([r["id"] for r in out["invalid"]], ["bad"])
        self.assertIn("==", out["invalid"][0]["reason"])

    def test_undefined_variable_is_plain_miss_not_defect(self):
        # 输入里没有这条规则看的键 → 不命中是**正常结果**，不许记成缺陷
        out = select_rule([_rule("看别的键", UNDEFINED_VAR, id="a")], {"v": 1})
        self.assertFalse(out["matched"])
        self.assertEqual(out["invalid"], [])

    def test_no_rule_is_never_guessed(self):
        out = select_rule([_rule("不命中", "v == 99", id="a")], {"v": 1})
        self.assertFalse(out["matched"])
        self.assertIsNone(out["rule"])
        self.assertEqual(out["invalid"], [])

    def test_empty_ruleset(self):
        out = select_rule([], {"v": 1})
        # R43（§8.75）起多一个 `trace` 键 —— 契约随新事实改写，其余四键原样
        self.assertEqual(
            out,
            {"matched": False, "rule": None, "invalid": [], "considered": 0, "trace": []},
        )


class SelectRuleTraceTest(unittest.TestCase):
    """R43（PLAN §8.75）逐条判定轨迹 —— 「这条为什么没成立」逐条可见。

    此前 `select_rule` 只回「命中哪条 / 扫了几条」，比较不成立、变量不在输入、
    类型不可比在回执里**同为不命中**（R40 §8.72 八 登记的留白）。轨迹给每条
    规则一行 `code`（机器码，FE 出中文）+ `detail`（后端事实载荷），判据仍只有
    `core/condition.py` 一处 —— 轨迹只**记录**，不改判定。
    """

    def test_trace_one_row_per_rule_with_id_name_condition(self):
        out = select_rule(
            [_rule("不成立", "v == 99", id="a"), _rule("成立", "v == 1", id="b")],
            {"v": 1},
        )
        self.assertEqual(
            [sorted(e) for e in out["trace"]],
            [["code", "condition", "detail", "id", "name"]] * 2,
        )
        self.assertEqual(
            [(e["id"], e["name"], e["condition"]) for e in out["trace"]],
            [("a", "不成立", "v == 99"), ("b", "成立", "v == 1")],
        )

    def test_every_outcome_has_its_own_code_in_scan_order(self):
        out = select_rule(
            [
                _rule("停用", "v == 1", enabled=0, sort_order=0, id="off"),
                _rule("坏条件", BAD_SYNTAX, sort_order=1, id="bad"),
                _rule("看别的键", UNDEFINED_VAR, sort_order=2, id="undef"),
                _rule("类型不比", "v == '1'", sort_order=3, id="type"),
                _rule("不成立", "v == 99", sort_order=4, id="false"),
                _rule("命中", "v == 1", sort_order=5, id="hit"),
                _rule("没轮到", "v == 1", sort_order=6, id="tail"),
            ],
            {"v": 1},
        )
        self.assertEqual(
            [(e["id"], e["code"]) for e in out["trace"]],
            [
                ("off", "DISABLED"),
                ("bad", "CONDITION_INVALID"),
                ("undef", "VAR_UNDEFINED"),
                ("type", "TYPE_INCOMPARABLE"),
                ("false", "COND_FALSE"),
                ("hit", "MATCHED"),
                ("tail", "NOT_EVALUATED"),
            ],
        )
        # 命中即停 —— 尾巴上的规则**没被求值过**，所以不算进 considered；
        # 停用与语法坏掉那两条本就不计（既有口径，轨迹不改它）
        self.assertTrue(out["matched"])
        self.assertEqual(out["rule"].id, "hit")
        self.assertEqual(out["considered"], 4)
        # 各自的 detail 是后端事实（变量名 / 两个类型名），FE 拿来出文案
        details = {e["id"]: e["detail"] for e in out["trace"]}
        self.assertEqual(details["undef"], "nope")
        self.assertEqual(details["type"], "数字 与 字符串")
        self.assertEqual(details["bad"], out["invalid"][0]["reason"])
        self.assertEqual(details["off"], "")
        self.assertEqual(details["false"], "")
        self.assertEqual(details["tail"], "")

    def test_in_operator_right_operand_is_its_own_code_not_a_silent_false(self):
        # `v in 1` 语法合法、求值期抛「右侧须是数组或字符串」—— 既不是比较不成立
        # 也不是类型不可比，归 COND_ERROR 兜底并把原文带回去
        out = select_rule([_rule("in 坏", "v in 1", id="a")], {"v": 1})
        self.assertEqual(out["trace"][0]["code"], "COND_ERROR")
        self.assertIn("右侧须是数组或字符串", out["trace"][0]["detail"])

    def test_trashed_rule_leaves_no_trace_row(self):
        # 回收站行列表页根本看不见 —— 轨迹只覆盖「规则顺序」列表里看得见的行
        out = select_rule(
            [_rule("已删", "v == 1", deleted_at="2026-10-06T00:00:00+00:00", id="a")],
            {"v": 1},
        )
        self.assertEqual(out["trace"], [])

    def test_empty_ruleset_gives_empty_trace(self):
        out = select_rule([], {"v": 1})
        self.assertEqual(out["trace"], [])

    def test_trace_does_not_change_match_semantics(self):
        # 轨迹只是把原来「跳过」的地方改成「跳过并记一行」—— 判定一字未改
        out = select_rule(
            [_rule("一", "v == 1", sort_order=0, id="a"),
             _rule("二", "v == 1", sort_order=1, id="b")],
            {"v": 1},
        )
        self.assertEqual(out["rule"].id, "a")
        self.assertEqual(out["invalid"], [])
        self.assertEqual(out["considered"], 1)


class EvalCodePrefixTest(unittest.TestCase):
    """轨迹码是**按 `ConditionError` 文案前缀**分类的 —— 文案一漂移就得红。

    这些文案由 `vectors/condition.json` 双端锁死，本类再从分类这一侧钉一遍：
    静默漂移会让「变量不在输入」被记成兜底码，是能被测出来的。
    """

    def test_prefixes_still_match_condition_error_messages(self):
        from backend.core.condition import ConditionError, evaluate_condition

        from backend.core.routing import EVAL_CODE_PREFIXES

        cases = [
            ({"v": 1}, UNDEFINED_VAR, "VAR_UNDEFINED"),
            ({"v": 1}, "v == '1'", "TYPE_INCOMPARABLE"),
        ]
        for variables, cond, want_code in cases:
            with self.assertRaises(ConditionError) as ctx:
                evaluate_condition(cond, variables)
            msg = str(ctx.exception)
            hits = [code for prefix, code in EVAL_CODE_PREFIXES if msg.startswith(prefix)]
            self.assertEqual(hits, [want_code], msg)

    def test_unmatched_message_falls_back_to_cond_error(self):
        from backend.core.condition import ConditionError, evaluate_condition

        from backend.core.routing import EVAL_CODE_PREFIXES

        with self.assertRaises(ConditionError) as ctx:
            evaluate_condition("v in 1", {"v": 1})
        msg = str(ctx.exception)
        self.assertFalse(any(msg.startswith(p) for p, _ in EVAL_CODE_PREFIXES), msg)


class RoutingTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_routing.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()
        for iid, code, name in ((INSTR_A, "READ_VER", "读版本"), (INSTR_B, "READ_CFG", "读配置")):
            self.db.add(
                Instruction(id=iid, device_code="M1", code=code, name=name, type="DYNAMIC")
            )
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _create(self, name, condition, instruction_id=INSTR_A, sort_order=0, enabled=1):
        return create_rule(
            RoutingRuleCreate(
                name=name,
                condition=condition,
                instruction_id=instruction_id,
                sort_order=sort_order,
                enabled=enabled,
            ),
            db=self.db,
        )


class RoutingCrudTest(RoutingTestBase):
    def test_create_then_list_ordered_by_sort_order(self):
        self._create("后", "v == 2", sort_order=1)
        self._create("先", "v == 1", sort_order=0)
        rows = list_rules(db=self.db)
        self.assertEqual([r.name for r in rows], ["先", "后"])
        self.assertEqual(rows[0].instruction_id, INSTR_A)

    def test_create_rejects_bad_syntax_before_writing(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create("坏", BAD_SYNTAX)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(list_rules(db=self.db), [])

    def test_create_rejects_unknown_or_trashed_instruction(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create("悬空", "v == 1", instruction_id="no-such-id")
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(list_rules(db=self.db), [])

    def test_create_rejects_duplicate_name(self):
        self._create("同名", "v == 1")
        with self.assertRaises(HTTPException) as ctx:
            self._create("同名", "v == 2")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(len(list_rules(db=self.db)), 1)

    def test_update_revalidates_condition(self):
        row = self._create("规则", "v == 1")
        with self.assertRaises(HTTPException) as ctx:
            update_rule(row.id, RoutingRuleCreate(
                name="规则", condition=BAD_SYNTAX, instruction_id=INSTR_A
            ), db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        # 校验失败即中止：库里仍是原条件
        self.assertEqual(list_rules(db=self.db)[0].condition, "v == 1")

    def test_delete_soft_deletes_and_hides_from_list(self):
        row = self._create("规则", "v == 1")
        out = delete_rule(row.id, db=self.db)
        self.assertEqual(out["status"], "deleted")
        self.assertEqual(list_rules(db=self.db), [])
        with self.assertRaises(HTTPException) as ctx:
            delete_rule(row.id, db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)


class ResolveRouteTest(RoutingTestBase):
    def test_match_returns_full_instruction_payload(self):
        self._create("读版本", "meter_id == 1", instruction_id=INSTR_A, sort_order=0)
        out = resolve_route({"meter_id": 1}, db=self.db)
        self.assertTrue(out.matched)
        self.assertEqual(out.instruction_id, INSTR_A)
        self.assertEqual(out.instruction.name, "读版本")
        self.assertEqual(out.rule.name, "读版本")
        self.assertEqual(out.considered, 1)

    def test_no_match_is_not_guessed(self):
        self._create("读版本", "meter_id == 1", instruction_id=INSTR_A)
        out = resolve_route({"meter_id": 999}, db=self.db)
        self.assertFalse(out.matched)
        self.assertIsNone(out.instruction_id)
        self.assertIsNone(out.instruction)

    def test_rule_pointing_at_deleted_instruction_is_skipped_not_500(self):
        self._create("读版本", "meter_id == 1", instruction_id=INSTR_A)
        # 指令进回收站 → 规则悬空：跳过并记 invalid，不 500、也不误命中别的
        self.db.query(Instruction).filter(Instruction.id == INSTR_A).update(
            {"deleted_at": "2026-10-06T00:00:00+00:00"}
        )
        self.db.commit()
        out = resolve_route({"meter_id": 1}, db=self.db)
        self.assertFalse(out.matched)
        self.assertEqual([r["id"] for r in out.invalid], [rule_id_of(self.db)])

    def test_disabled_rule_is_not_considered(self):
        self._create("停用", "meter_id == 1", enabled=0)
        out = resolve_route({"meter_id": 1}, db=self.db)
        self.assertFalse(out.matched)
        self.assertEqual(out.considered, 0)

    def test_endpoint_is_resolve_only_no_dispatch_record_shape(self):
        self._create("读版本", "meter_id == 1", instruction_id=INSTR_A)
        out = dispatch_routed(RouteResolveRequest(inputs={"meter_id": 1}), db=self.db)
        payload = out.model_dump()
        # §0：新增端点只解析 —— 出现这三个键即说明串进了 /dispatch 缺省口径
        for leaked in ("status", "attempts", "hex_string"):
            self.assertNotIn(leaked, payload)


class ResolveRouteTraceTest(RoutingTestBase):
    """R43（PLAN §8.75）回执 `trace` —— 把 `select_rule` 的轨迹与
    `resolve_route` 自己那层静态跳过（目标指令不在册）按**同一定序**并回一张表。"""

    def test_trace_arrives_on_the_response(self):
        self._create("读版本", "meter_id == 1", sort_order=0)
        out = resolve_route({"meter_id": 999}, db=self.db)
        self.assertEqual(
            [(e.name, e.code) for e in out.trace],
            [("读版本", "COND_FALSE")],
        )
        self.assertEqual(out.trace[0].condition, "meter_id == 1")
        self.assertEqual(out.trace[0].detail, "")

    def test_trace_merges_dangling_and_disabled_rows_in_list_order(self):
        self._create("活", "meter_id == 1", sort_order=0)
        self._create("停用", "meter_id == 1", sort_order=1, enabled=0)
        self._create("悬空", "meter_id == 1", instruction_id=INSTR_B, sort_order=2)
        self.db.query(Instruction).filter(Instruction.id == INSTR_B).update(
            {"deleted_at": "2026-10-06T00:00:00+00:00"}
        )
        self.db.commit()

        out = resolve_route({"meter_id": 999}, db=self.db)
        # 列表顺序 = 轨迹顺序：悬空那条既在 invalid 里、也在轨迹里，各说各的
        self.assertEqual(
            [(e.name, e.code) for e in out.trace],
            [("活", "COND_FALSE"), ("停用", "DISABLED"), ("悬空", "INSTRUCTION_MISSING")],
        )
        self.assertEqual([r["id"] for r in out.invalid], [out.trace[2].id])
        self.assertEqual(out.trace[2].detail, "")

    def test_matched_trace_stops_and_marks_the_tail(self):
        self._create("先", "meter_id == 1", sort_order=0)
        self._create("后", "meter_id == 1", sort_order=1)
        out = resolve_route({"meter_id": 1}, db=self.db)
        self.assertEqual(
            [(e.name, e.code) for e in out.trace],
            [("先", "MATCHED"), ("后", "NOT_EVALUATED")],
        )

    def test_trace_never_leaks_dispatch_record_fields(self):
        # §0：/dispatch/routed 只解析 —— 轨迹是新增字段，不许顺带带出这三个
        self._create("读版本", "meter_id == 1")
        out = dispatch_routed(RouteResolveRequest(inputs={"meter_id": 1}), db=self.db)
        payload = out.model_dump()
        for leaked in ("status", "attempts", "hex_string"):
            self.assertNotIn(leaked, payload)
        self.assertIn("trace", payload)

    def test_no_rules_gives_empty_trace_not_none(self):
        out = resolve_route({"meter_id": 1}, db=self.db)
        self.assertEqual(out.trace, [])
        self.assertIsNone(out.instruction)


class RoutingTrashTest(RoutingTestBase):
    """R6 回收站白名单里的 `routing_rule` —— 没有它，软删标记就是永久黑洞。"""

    def test_deleted_rule_lands_in_trash_and_restores(self):
        row = self._create("规则", "v == 1")
        delete_rule(row.id, db=self.db)

        mine = [it for it in list_trash(db=self.db).items if it.kind == "routing_rule"]
        self.assertEqual([it.id for it in mine], [row.id])
        self.assertEqual(mine[0].label, "规则")

        # §8.43 已知取舍：软删行**继续占用**唯一键 → 想重建同名只报 400，不 500
        with self.assertRaises(HTTPException) as ctx:
            self._create("规则", "v == 9")
        self.assertEqual(ctx.exception.status_code, 400)

        restore_trash_item("routing_rule", row.id, db=self.db)
        self.assertEqual([r.id for r in list_rules(db=self.db)], [row.id])

        # 再删一次 → 彻底删除才释放键
        delete_rule(row.id, db=self.db)
        purge_trash_item("routing_rule", row.id, db=self.db)
        self.assertEqual(list_rules(db=self.db), [])
        self._create("规则", "v == 9")
        self.assertEqual(len(list_rules(db=self.db)), 1)

    def test_rule_stays_in_trash_even_if_target_instruction_went_first(self):
        """目标指令先进站，规则不会被顺带隐藏 —— 它是独立可恢复的顶层对象。"""
        row = self._create("规则", "v == 1")
        delete_rule(row.id, db=self.db)
        self.db.query(Instruction).filter(Instruction.id == INSTR_A).update(
            {"deleted_at": "2026-10-06T00:00:00+00:00"}
        )
        self.db.commit()
        mine = [it for it in list_trash(db=self.db).items if it.kind == "routing_rule"]
        self.assertEqual([it.id for it in mine], [row.id])


def rule_id_of(db) -> str:
    from backend.db.soft_delete import alive

    return alive(db.query(RoutingRule), RoutingRule).first().id


if __name__ == "__main__":
    unittest.main()
