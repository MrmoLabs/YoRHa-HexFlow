"""批次二 (D12/D14②): 指令删除的引用计数 + 按数据性质三分处置单测。

直调路由函数（临时库显式 Session，无 TestClient）—— 对齐 test_protocol_delete
范式。三分口径（D14② 2026-10-01 拍板）：
  - **活配置** protocol_bindings / response_specs → 级联删（同事务）
  - **冻结快照** sequence_steps → 保留 + 回执 orphaned 计数（payload/plan 自含、
    Runner 发送不查指令行 → 删宿主后仍可运行，只标失效）
  - **日志** dispatch_logs → 只读保留
此前 `delete_instruction` 只 `db.delete(db_inst)`，四表全留脏行（逻辑外键无 FK，
不报错只静默错）。

R6（PLAN §8.43）起「级联删」= **级联软删**：行留库、打同一个 `deleted_at`
时间戳（恢复时据此一并捞回），读侧 `alive()` 过滤；回执形状与计数键不变。
三分处置的**数据性质**结论不变 —— 活配置跟着走、冻结快照留、日志只读留。

R37（PLAN §8.69）：**发前路由规则 `routing_rules` 归入第一类「活配置」** ——
它是用户手写、指向某条指令的配置，目标入站时一并级联（同戳 → 恢复时一起回来），
引用计数新增 `routing_rules` 键并计入 `total`。**回收站对它不做「宿主在站就
隐藏」的代理过滤**（见 `test_independently_trashed_rule_stays_reachable`）。
"""

import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base
from backend.db.models import (
    DispatchLog,
    Instruction,
    ProtocolBinding,
    ResponseSpec,
    RoutingRule,
    Sequence,
    SequenceStep,
)
from backend.routers.instruction import (
    delete_instruction,
    get_instruction_references,
)
from backend.routers.routing import delete_rule, list_rules
from backend.routers.trash import list_trash, restore_trash_item


class InstructionDeleteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp.name) / "test_instruction_delete.db"
        self.engine = create_engine(
            f"sqlite:///{db_path.as_posix()}", connect_args={"check_same_thread": False}
        )
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(
            autocommit=False, autoflush=False, bind=self.engine
        )
        self.db = self.session_factory()

        self.db.add(Instruction(id="i-1", device_code="01", code="C1", name="宿主指令"))
        self.db.add(Instruction(id="i-2", device_code="01", code="C2", name="旁支指令"))
        # 指向 i-1 的活配置（应级联删）
        self.db.add(
            ProtocolBinding(id="b-1", protocol_id="p-1", instruction_id="i-1", label="绑定1")
        )
        self.db.add(ResponseSpec(id="rs-1", instruction_id="i-1", spec={}))
        # R37（PLAN §8.69）：发前路由规则也是**活配置** —— 目标指令入站时一并级联
        self.db.add(
            RoutingRule(
                id="rr-1",
                name="规则1",
                condition="v == 1",
                instruction_id="i-1",
                sort_order=0,
                enabled=1,
            )
        )
        # 指向 i-2 的旁支（不应受影响）
        self.db.add(
            ProtocolBinding(id="b-2", protocol_id="p-1", instruction_id="i-2", label="绑定2")
        )
        self.db.add(ResponseSpec(id="rs-2", instruction_id="i-2", spec={}))
        self.db.add(
            RoutingRule(
                id="rr-2",
                name="规则2",
                condition="v == 2",
                instruction_id="i-2",
                sort_order=0,
                enabled=1,
            )
        )
        # 冻结快照（应保留）+ 日志（只读保留）
        self.db.add(Sequence(id="seq-1", name="序列1", config={}))
        self.db.add(
            SequenceStep(
                id="st-1",
                sequence_id="seq-1",
                step_order=0,
                instruction_id="i-1",
                label="步1",
                delay_ms=0,
                payload="AA BB",
            )
        )
        self.db.add(
            DispatchLog(
                created_at="2026-10-01T00:00:00+00:00",
                source="manual",
                channel="LOOPBACK",
                status="OK",
                byte_count=2,
                hex_string="AA BB",
                instruction_id="i-1",
            )
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _rows(self, model):
        return self.db.query(model).all()

    def test_reference_counts_four_tables(self):
        counts = get_instruction_references("i-1", db=self.db)
        self.assertEqual(counts["bindings"], 1)
        self.assertEqual(counts["response_specs"], 1)
        self.assertEqual(counts["sequence_steps"], 1)
        self.assertEqual(counts["dispatch_logs"], 1)
        # R37（§8.69）：发前路由规则计入引用（活配置 → 会随删级联，弹窗必须先说）
        self.assertEqual(counts["routing_rules"], 1)
        self.assertEqual(counts["total"], 5)

    def test_reference_counts_routing_rules_only_count_alive(self):
        """回收站里的规则不该再算进「受影响项」（同 R6 活行口径）。"""
        self.assertEqual(get_instruction_references("i-2", db=self.db)["routing_rules"], 1)
        delete_rule("rr-2", db=self.db)
        self.db.expire_all()
        counts = get_instruction_references("i-2", db=self.db)
        self.assertEqual(counts["routing_rules"], 0)
        self.assertEqual(counts["total"], 2)  # 仅 b-2 + rs-2

    def test_reference_counts_zero_for_unreferenced(self):
        self.db.add(Instruction(id="i-3", device_code="01", code="C3", name="孤指令"))
        self.db.commit()
        counts = get_instruction_references("i-3", db=self.db)
        self.assertEqual(counts["total"], 0)

    def test_reference_counts_missing_instruction_404(self):
        with self.assertRaises(HTTPException) as ctx:
            get_instruction_references("ghost", db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_delete_cascades_live_config_only(self):
        result = delete_instruction("i-1", db=self.db)

        self.assertEqual(result["status"], "deleted")
        self.assertEqual(result["deleted_bindings"], 1)
        self.assertEqual(result["deleted_response_specs"], 1)
        self.assertEqual(result["orphaned_sequence_steps"], 1)
        # R37（§8.69）：路由规则同属活配置 → 一并级联
        self.assertEqual(result["deleted_routing_rules"], 1)

        # R6（§8.43）：活配置**级联软删** —— 行留库、与宿主共用同一时间戳；
        # i-2 的原样保留（同表不同宿主）。读侧 alive() 过滤 → 列表里只看得到 b-2。
        marks = {b.id: b.deleted_at for b in self._rows(ProtocolBinding)}
        self.assertEqual(set(marks), {"b-1", "b-2"})
        self.assertIsNotNone(marks["b-1"])
        self.assertIsNone(marks["b-2"])
        specs = {r.id: r.deleted_at for r in self._rows(ResponseSpec)}
        self.assertEqual(set(specs), {"rs-1", "rs-2"})
        self.assertIsNotNone(specs["rs-1"])
        self.assertIsNone(specs["rs-2"])
        # 规则同样级联软删、同戳（i-2 的规则原样保留）
        rules = {r.id: r.deleted_at for r in self._rows(RoutingRule)}
        self.assertEqual(set(rules), {"rr-1", "rr-2"})
        self.assertIsNotNone(rules["rr-1"])
        self.assertIsNone(rules["rr-2"])
        self.assertEqual([r.id for r in list_rules(db=self.db)], ["rr-2"])
        # 级联共用同一时间戳 = 恢复时把子行一并捞回的判据
        host = self.db.query(Instruction).filter(Instruction.id == "i-1").first()
        self.assertEqual(host.deleted_at, marks["b-1"])
        self.assertEqual(host.deleted_at, specs["rs-1"])
        self.assertEqual(host.deleted_at, rules["rr-1"])

        # 冻结快照保留（不改写已保存序列的步骤构成）
        steps = self._rows(SequenceStep)
        self.assertEqual([s.id for s in steps], ["st-1"])
        self.assertEqual(steps[0].instruction_id, "i-1")
        self.assertEqual(steps[0].payload, "AA BB")

        # 日志只读保留
        logs = self._rows(DispatchLog)
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0].instruction_id, "i-1")

        # 读侧：宿主已入回收站 → 单查 404（同改前硬删后的 404 口径）
        with self.assertRaises(HTTPException) as ctx:
            get_instruction_references("i-1", db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_delete_unreferenced_returns_zero_counts(self):
        self.db.add(Instruction(id="i-3", device_code="01", code="C3", name="孤指令"))
        self.db.commit()
        result = delete_instruction("i-3", db=self.db)
        self.assertEqual(result["deleted_bindings"], 0)
        self.assertEqual(result["deleted_response_specs"], 0)
        self.assertEqual(result["orphaned_sequence_steps"], 0)
        self.assertEqual(result["deleted_routing_rules"], 0)

    def test_restoring_host_restores_cascaded_rules(self):
        """同戳级联的意义：恢复指令时规则一并回来，不留悬空规则。"""
        delete_instruction("i-1", db=self.db)
        self.assertEqual([r.id for r in list_rules(db=self.db)], ["rr-2"])
        restore_trash_item("instruction", "i-1", db=self.db)
        self.db.expire_all()
        self.assertEqual(
            sorted(r.id for r in list_rules(db=self.db)), ["rr-1", "rr-2"]
        )
        # 恢复后规则仍是活配置 → 引用计数回到 1
        self.assertEqual(get_instruction_references("i-1", db=self.db)["routing_rules"], 1)

    def test_independently_trashed_rule_stays_reachable(self):
        """规则先独立入站、宿主后入站 —— 两条时间戳不同，恢复宿主**不会**顺带
        捞回它；因此回收站**不做**「宿主在站就隐藏」的代理过滤（做了这条规则会
        从此再也看不见），它必须始终自己占一行。"""
        delete_rule("rr-1", db=self.db)
        delete_instruction("i-1", db=self.db)
        trash = [it for it in list_trash(db=self.db).items if it.id == "rr-1"]
        self.assertEqual(len(trash), 1)  # 仍在列，不被宿主连带隐藏
        restore_trash_item("instruction", "i-1", db=self.db)
        self.db.expire_all()
        self.assertEqual([r.id for r in list_rules(db=self.db)], ["rr-2"])
        self.assertEqual(
            len([it for it in list_trash(db=self.db).items if it.id == "rr-1"]), 1
        )

    def test_delete_missing_instruction_404(self):
        with self.assertRaises(HTTPException) as ctx:
            delete_instruction("ghost", db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
