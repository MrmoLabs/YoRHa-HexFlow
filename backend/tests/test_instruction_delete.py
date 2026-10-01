"""批次二 (D12/D14②): 指令删除的引用计数 + 按数据性质三分处置单测。

直调路由函数（临时库显式 Session，无 TestClient）—— 对齐 test_protocol_delete
范式。三分口径（D14② 2026-10-01 拍板）：
  - **活配置** protocol_bindings / response_specs → 级联删（同事务）
  - **冻结快照** sequence_steps → 保留 + 回执 orphaned 计数（payload/plan 自含、
    Runner 发送不查指令行 → 删宿主后仍可运行，只标失效）
  - **日志** dispatch_logs → 只读保留
此前 `delete_instruction` 只 `db.delete(db_inst)`，四表全留脏行（逻辑外键无 FK，
不报错只静默错）。
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
    Sequence,
    SequenceStep,
)
from backend.routers.instruction import (
    delete_instruction,
    get_instruction_references,
)


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
        # 指向 i-2 的旁支（不应受影响）
        self.db.add(
            ProtocolBinding(id="b-2", protocol_id="p-1", instruction_id="i-2", label="绑定2")
        )
        self.db.add(ResponseSpec(id="rs-2", instruction_id="i-2", spec={}))
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
        self.assertEqual(counts["total"], 4)

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

        # 活配置级联删：i-1 的绑定与规格没了；i-2 的原样保留（同表不同宿主）
        self.assertEqual(
            [b.id for b in self._rows(ProtocolBinding)], ["b-2"]
        )
        self.assertEqual([r.id for r in self._rows(ResponseSpec)], ["rs-2"])

        # 冻结快照保留（不改写已保存序列的步骤构成）
        steps = self._rows(SequenceStep)
        self.assertEqual([s.id for s in steps], ["st-1"])
        self.assertEqual(steps[0].instruction_id, "i-1")
        self.assertEqual(steps[0].payload, "AA BB")

        # 日志只读保留
        logs = self._rows(DispatchLog)
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0].instruction_id, "i-1")

    def test_delete_unreferenced_returns_zero_counts(self):
        self.db.add(Instruction(id="i-3", device_code="01", code="C3", name="孤指令"))
        self.db.commit()
        result = delete_instruction("i-3", db=self.db)
        self.assertEqual(result["deleted_bindings"], 0)
        self.assertEqual(result["deleted_response_specs"], 0)
        self.assertEqual(result["orphaned_sequence_steps"], 0)

    def test_delete_missing_instruction_404(self):
        with self.assertRaises(HTTPException) as ctx:
            delete_instruction("ghost", db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
