"""P3 序列 CRUD + 启停 + 手动发送互斥单测（临时库直调路由函数，无 TestClient）。

Run from repo root: python -m unittest discover -s backend/tests
覆盖：创建/列表/详情/整体替换/删除（204/404）、名字与 config/步骤边界 400、
持久化（换会话仍在）、启动（404/400 无步骤/回显跑通）、停止幂等与 /status、
互斥（运行期 start / dispatch_frame / dispatch_transaction 全 409，释放后恢复）。
"""
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core import sequence_runner, transport
from backend.db.database import Base
from backend.db.models import Instruction, SequenceStep
from backend.routers import dispatch as dispatch_mod
from backend.routers.dispatch import (
    DispatchRequest,
    TransactionRequest,
    dispatch_frame,
    dispatch_transaction,
)
from backend.routers.sequence import (
    create_sequence,
    delete_sequence,
    get_sequence,
    list_sequences,
    sequence_status,
    start_sequence,
    stop_sequence,
    update_sequence,
)
from backend.schemas.sequence_api import SequencePayload, SequenceStepSpec
from backend.tests.test_sequence import _step

INSTR = "22222222-bbbb-4ccc-8ddd-000000000001"


def _payload(name="序列A", steps=None, config=None, description=None):
    if steps is None:
        steps = [
            SequenceStepSpec(
                instruction_id=INSTR, label="第一步", delay_ms=0,
                params={"f1": 5}, payload="A5 01 0B", plan=None,
            ),
        ]
    return SequencePayload(
        name=name, description=description, config=config, steps=steps,
    )


class SequenceApiTestBase(unittest.TestCase):
    def setUp(self):
        transport.reset()  # 默认 loopback；reset 同时清钩子，绝不泄漏给其他模块
        dispatch_mod._history.clear()
        sequence_runner.reset()
        # 临时库文件：直调路由函数证明「会话外/重启后仍在」（同 test_bindings 先例）
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_seq.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()

    def tearDown(self):
        transport.reset()
        dispatch_mod._history.clear()
        sequence_runner.reset()
        # Windows: 先关会话再 dispose 连接池，否则文件被占用无法删除（WinError 32）
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _create(self, payload=None):
        return create_sequence(payload or _payload(), db=self.db)


class SequenceCrudTest(SequenceApiTestBase):
    def test_create_list_get_roundtrip(self):
        out = self._create()
        self.assertTrue(out.id)
        self.assertEqual(out.name, "序列A")
        self.assertEqual(out.config, {"stop_on_error": True, "read_timeout_ms": None})  # 缺省归一
        self.assertEqual(len(out.steps), 1)
        step = out.steps[0]
        self.assertEqual(step.step_order, 0)
        self.assertEqual(step.payload, "A5010B")        # 紧凑大写归一入库
        self.assertEqual(step.label, "第一步")
        self.assertEqual(step.params, {"f1": 5})         # 保存时冻结
        self.assertIsNone(step.plan)
        self.assertEqual(step.instruction_id, INSTR)

        rows = list_sequences(db=self.db)
        self.assertEqual([r.id for r in rows], [out.id])
        self.assertEqual(len(rows[0].steps), 1)
        got = get_sequence(out.id, db=self.db)
        self.assertEqual(got.steps[0].id, step.id)

    def test_persists_across_sessions(self):
        out = self._create()
        fresh = self.session_factory()
        try:
            again = get_sequence(out.id, db=fresh)
            self.assertEqual(again.name, "序列A")
            self.assertEqual(len(again.steps), 1)
        finally:
            fresh.close()

    def test_duplicate_name_400(self):
        self._create()
        with self.assertRaises(HTTPException) as ctx:
            self._create(_payload(name="序列A"))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("已存在", ctx.exception.detail)

    def test_empty_name_400(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create(_payload(name="   "))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_update_replaces_steps_and_keeps_id(self):
        out = self._create()
        new = _payload(
            name="序列改",
            steps=[
                SequenceStepSpec(instruction_id="33333333-bbbb-4ccc-8ddd-000000000001", payload="CC DD"),
                SequenceStepSpec(instruction_id="33333333-bbbb-4ccc-8ddd-000000000001", payload="EE", delay_ms=100),
            ],
            config={"stop_on_error": False},
        )
        updated = update_sequence(out.id, new, db=self.db)
        self.assertEqual(updated.id, out.id)
        self.assertEqual(updated.name, "序列改")
        self.assertEqual(updated.config, {"stop_on_error": False, "read_timeout_ms": None})
        self.assertEqual(len(updated.steps), 2)
        self.assertEqual([s.step_order for s in updated.steps], [0, 1])
        self.assertNotEqual(updated.steps[0].id, out.steps[0].id)  # 换了新步骤行
        leftovers = (
            self.db.query(SequenceStep)
            .filter(SequenceStep.sequence_id == out.id)
            .all()
        )
        self.assertEqual(len(leftovers), 2)  # 旧步骤行删净，无孤儿

    def test_update_rename_to_existing_400(self):
        self._create(_payload(name="甲"))
        other = self._create(_payload(name="乙"))
        with self.assertRaises(HTTPException) as ctx:
            update_sequence(other.id, _payload(name="甲"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_get_update_delete_404(self):
        ghost = str(uuid.uuid4())
        cases = [
            (get_sequence, (ghost,)),
            (update_sequence, (ghost, _payload(name="丙"))),
            (delete_sequence, (ghost,)),
        ]
        for fn, args in cases:
            with self.subTest(fn=fn.__name__):
                with self.assertRaises(HTTPException) as ctx:
                    fn(*args, db=self.db)
                self.assertEqual(ctx.exception.status_code, 404)

    def test_delete_removes_steps_and_204(self):
        out = self._create()
        resp = delete_sequence(out.id, db=self.db)
        self.assertEqual(resp.status_code, 204)
        self.assertEqual(
            self.db.query(SequenceStep)
            .filter(SequenceStep.sequence_id == out.id)
            .count(),
            0,
        )
        with self.assertRaises(HTTPException) as ctx:
            delete_sequence(out.id, db=self.db)  # 二次删 404
        self.assertEqual(ctx.exception.status_code, 404)


class SequenceValidationTest(SequenceApiTestBase):
    def test_config_rejects(self):
        # 非对象 config 由 pydantic 模型层拒（HTTP 下 422，同 P2 形状口径先例），
        # 此处只测 dict 内的业务 400；路由 isinstance 守卫为直调路径双保险。
        bads = [
            {"unknown": 1},              # 未知键（严格键集）
            {"stop_on_error": "yes"},    # 非布尔
            {"read_timeout_ms": 0},      # 下界外
            {"read_timeout_ms": 60001},  # 上界外
            {"read_timeout_ms": True},   # bool 冒充整数
        ]
        for config in bads:
            with self.subTest(config=config):
                with self.assertRaises(HTTPException) as ctx:
                    self._create(_payload(config=config))
                self.assertEqual(ctx.exception.status_code, 400)

    def test_config_read_timeout_accepts_range(self):
        out = self._create(_payload(config={"read_timeout_ms": 1234}))
        self.assertEqual(out.config["read_timeout_ms"], 1234)

    def test_step_boundaries_400(self):
        base = {"instruction_id": INSTR, "payload": "A5"}
        bads = [
            {"payload": "GG"},       # 非法 hex 字符
            {"payload": "ABC"},      # 奇数位
            {"payload": ""},         # 空帧
            {"delay_ms": -1},        # 下界外
            {"delay_ms": 60001},     # 上界外
            {"instruction_id": "   "},  # 空指令 id
            {"label": "x" * 129},    # label 超长
        ]
        for kwargs in bads:
            spec = SequenceStepSpec(**{**base, **kwargs})
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(HTTPException) as ctx:
                    self._create(_payload(steps=[spec]))
                self.assertEqual(ctx.exception.status_code, 400)

    def test_step_count_cap_400(self):
        steps = [SequenceStepSpec(instruction_id="i", payload="A5") for _ in range(201)]
        with self.assertRaises(HTTPException) as ctx:
            self._create(_payload(steps=steps))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("200", ctx.exception.detail)

    def test_step_bad_plan_400_with_index_in_detail(self):
        # regions 与校验字段自身重叠（反算不自含）→ 步内定位 steps[0]
        spec = SequenceStepSpec(
            instruction_id="i", payload="A5 01 02 03",
            plan={"checksum": {"offset": 0, "byte_length": 2, "regions": [[0, 2]]}},
        )
        with self.assertRaises(HTTPException) as ctx:
            self._create(_payload(steps=[spec]))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("steps[0]", ctx.exception.detail)


class SequenceRunTest(SequenceApiTestBase):
    def _wait_finished(self, timeout=5.0):
        """直连 Runner 模块轮询到终态（loopback 极快，避免线程时序断言）。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            snap = sequence_runner.snapshot()
            if not snap["running"]:
                return snap
            time.sleep(0.02)
        self.fail("序列运行未在期限内结束")

    def test_start_runs_to_completion(self):
        out = self._create(_payload(steps=[
            SequenceStepSpec(instruction_id=INSTR, payload="A5 01"),
            SequenceStepSpec(instruction_id=INSTR, payload="B0 B1", label="二"),
        ]))
        started = start_sequence(out.id, db=self.db)
        self.assertEqual(started.sequence_id, out.id)
        self.assertEqual(started.total_steps, 2)

        snap = self._wait_finished()
        self.assertEqual(snap["result"], "completed")
        self.assertEqual([r["status"] for r in snap["steps"]], ["OK", "OK"])
        self.assertEqual(snap["steps"][0]["received"], "A501")  # loopback 回显

        status = sequence_status()  # /status 端点同源（P4 轮询口）
        self.assertEqual(status.result, "completed")
        self.assertFalse(status.running)
        self.assertEqual(len(status.steps), 2)

    def test_start_404_unknown_and_400_empty(self):
        with self.assertRaises(HTTPException) as ctx:
            start_sequence(str(uuid.uuid4()), db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

        empty = self._create(_payload(name="空序列", steps=[]))
        with self.assertRaises(HTTPException) as ctx:
            start_sequence(empty.id, db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("没有步骤", ctx.exception.detail)

    def test_mutex_409_for_start_and_manual_dispatch(self):
        # 手动占槽（不 execute）= 序列运行中
        run = sequence_runner.claim("seq-mutex", "互斥", [_step("m1")], {})
        seq = self._create(_payload(name="排队序列"))

        with self.assertRaises(HTTPException) as ctx:
            start_sequence(seq.id, db=self.db)
        self.assertEqual(ctx.exception.status_code, 409)

        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(DispatchRequest(hex_string="A5 01"))
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("序列运行中", ctx.exception.detail)

        with self.assertRaises(HTTPException) as ctx:
            dispatch_transaction(TransactionRequest(hex_string="A5 01"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 409)

        # 释放槽（停止位 + 执行空跑收尾）→ 手动发送恢复，口径不回归
        sequence_runner.request_stop()
        sequence_runner.execute(run)
        record = dispatch_frame(DispatchRequest(hex_string="A5 01"))
        self.assertEqual(record.status, "SENT")
        self.assertEqual(record.echo, "A501")
        self.assertEqual(record.channel, "LOOPBACK")

    def test_stop_idle_is_idempotent_200(self):
        status = stop_sequence()
        self.assertFalse(status.running)
        self.assertEqual(status.result, "idle")


class InstructionMissingFlagTest(SequenceApiTestBase):
    """批次二 (D14②): 宿主指令已删 → 步骤失效标记（零 DDL，读时批量比对）。

    判据 = `instruction_id` 悬空；步骤 payload/plan 是冻结快照、Runner 发送不查
    指令行 → 删宿主后**步骤仍可运行**，因此不级联删、只标失效（与 D7「失效不
    阻断」同语义）。列表 / 详情 / 创建回显三处同标。
    """

    def test_host_absent_is_flagged_on_create(self):
        out = self._create()
        self.assertTrue(out.steps[0].instruction_missing)

    def test_host_present_is_not_flagged(self):
        self.db.add(Instruction(id=INSTR, device_code="01", code="C1", name="宿主"))
        self.db.commit()
        out = self._create()
        self.assertFalse(out.steps[0].instruction_missing)

    def test_flag_follows_host_life_cycle(self):
        self.db.add(Instruction(id=INSTR, device_code="01", code="C1", name="宿主"))
        self.db.commit()
        out = self._create()
        self.assertFalse(out.steps[0].instruction_missing)

        # 删宿主 → 详情与列表都标失效；步骤本身一字未动
        self.db.query(Instruction).filter(Instruction.id == INSTR).delete()
        self.db.commit()
        before = self.db.query(SequenceStep).first()
        payload_before, plan_before, order_before = before.payload, before.plan, before.step_order

        got = get_sequence(out.id, db=self.db)
        self.assertTrue(got.steps[0].instruction_missing)
        listed = list_sequences(db=self.db)
        self.assertTrue(listed[0].steps[0].instruction_missing)

        after = self.db.query(SequenceStep).first()
        self.assertEqual(
            (after.payload, after.plan, after.step_order),
            (payload_before, plan_before, order_before),
        )


if __name__ == "__main__":
    unittest.main()
