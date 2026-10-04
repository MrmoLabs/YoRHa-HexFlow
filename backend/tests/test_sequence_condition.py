"""R26（PLAN §8.58 · §8.52 排期第 6 批）：序列级分支 —— runner 判定 + 保存口 + 往返。

覆盖面（stdlib unittest 直调，无 TestClient、不起真线程）：

1. **前置证明**：无条件序列（存量全部）**零解码、零日志增量、记录形状不变** ——
   注入一个「被调用即失败」的 `decode_vars`，跑完必须一次都没调到；
2. 运行期三态：条件真 → 执行；条件假 → `SKIPPED + "COND: 条件不成立"`
   （不延时、不建帧、不发、不落日志）；条件非法 / 变量未定义 / 类型不可比 →
   `ERROR + "COND: ..."` + 结构化诊断（`stage=condition`、`data_sent=False`），
   `stop_on_error` 照常管辖；
3. 变量上下文：`step.<n>.*` 逐步累积 + 应答解码字段的平铺键（`fw_version >= 0x1200`）；
4. 保存口 400 定位 `steps[i].condition`、空白与缺键 → null、往返回显；
5. 启动注入（compile_wrap 旁的第二个入口 `decode_vars`）与 datahub 导出带条件。

Run from repo root: python -m unittest backend.tests.test_sequence_condition
"""
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core import sequence_runner, transport
from backend.db.database import Base
from backend.db.log_store import resolve_log_fields
from backend.db.models import Sequence, SequenceStep
from backend.routers import sequence as sequence_mod
from backend.routers.sequence import (
    _condition_spec,
    _flat_decoded,
    create_sequence,
    get_sequence,
    start_sequence,
)
from backend.schemas.sequence_api import SequencePayload, SequenceStepSpec
from backend.tests.test_sequence import _step

INSTR = "22222222-bbbb-4ccc-8ddd-000000000001"


def _cond_step(step_id, condition, payload=b"\xA5\x01", delay_ms=0):
    """带条件的 runner 步（键缺席 = 无条件，与存量形状同构）。"""
    return {**_step(step_id, payload, delay_ms=delay_ms), "condition": condition}


class SequenceConditionRunnerTest(unittest.TestCase):
    """runner 侧：条件三态 + 变量上下文 + 无条件序列零回归。"""

    def setUp(self):
        transport.reset()  # 默认 loopback；reset 同时清钩子，绝不泄漏给其他模块
        sequence_runner.reset()
        self.logs = []
        sequence_runner.set_log_hook(lambda **kw: self.logs.append(kw))

    def tearDown(self):
        transport.reset()
        sequence_runner.reset()

    def _run(self, steps, *, stop_on_error=True, decode_vars=None):
        run = sequence_runner.claim(
            "seq-cond", "条件序列", steps,
            {"stop_on_error": stop_on_error, "read_timeout_ms": None},
            decode_vars=decode_vars,
        )
        sequence_runner.execute(run)
        return sequence_runner.snapshot()

    # ---- 1) 前置证明：无条件序列逐字节不变 ---------------------------------

    def test_no_condition_sequence_never_calls_decode_vars(self):
        """零回归锚：`decode_vars` 被调即失败 → 存量路径根本不碰它。"""
        calls = []

        def must_not_run(instruction_id, echo):
            calls.append((instruction_id, echo))
            raise AssertionError("无条件序列不应解码应答")

        snap = self._run(
            [_step("s1", b"\xA5\x01"), _step("s2", b"\xA6\xA7", label="第二步")],
            decode_vars=must_not_run,
        )
        self.assertEqual(snap["result"], "completed")
        self.assertEqual(calls, [])  # 零解码
        self.assertEqual([r["status"] for r in snap["steps"]], ["OK", "OK"])
        self.assertEqual(len(self.logs), 2)  # 日志增量也照旧（每步一条）
        first = snap["steps"][0]
        self.assertEqual(first["sent"], "A5 01")
        self.assertEqual(first["received"], "A501")
        self.assertIsNone(first["error"])
        # 记录键集与 R26 之前同形（FE 轮询契约不增键）
        self.assertEqual(
            sorted(first),
            sorted(["n", "step_id", "label", "instruction_id", "status",
                    "sent", "received", "rtt_ms", "error"]),
        )

    def test_blank_condition_is_treated_as_no_condition(self):
        """`'   '`（保存口会归一成 null）在 runner 侧同样走原路径。"""
        snap = self._run(
            [_step("s1"), {**_step("s2"), "condition": ""}]
        )
        self.assertEqual([r["status"] for r in snap["steps"]], ["OK", "OK"])

    # ---- 2) 条件真 / 假 ----------------------------------------------------

    def test_true_condition_uses_previous_step_status(self):
        snap = self._run([
            _step("s1"),
            _cond_step("s2", 'step.1.status == "OK"'),
            _cond_step("s3", 'step.1.status == "ERROR"'),  # 前面没错 → 假
        ])
        self.assertEqual(snap["result"], "completed")  # 被跳过的步不算失败
        self.assertEqual(
            [r["status"] for r in snap["steps"]], ["OK", "OK", "SKIPPED"]
        )
        self.assertEqual(snap["steps"][2]["error"], "COND: 条件不成立")
        self.assertIsNone(snap["steps"][2]["sent"])

    def test_false_condition_skips_without_send_log_or_delay(self):
        """判定排在 delay 之前：条件不成立的步**不白等**、不发、不落日志。"""
        started = time.perf_counter()
        snap = self._run([
            _step("s1"),
            _cond_step("s2", 'step.1.status == "ERROR"', delay_ms=400),
            _step("s3"),
        ])
        elapsed = time.perf_counter() - started

        self.assertEqual(
            [r["status"] for r in snap["steps"]], ["OK", "SKIPPED", "OK"]
        )
        skipped = snap["steps"][1]
        self.assertEqual(skipped["error"], "COND: 条件不成立")
        self.assertIsNone(skipped["sent"])
        self.assertIsNone(skipped["received"])
        self.assertIsNone(skipped["rtt_ms"])
        self.assertLess(elapsed, 0.35, "条件挡下的步不应吃掉 400ms 延时")
        # 只有真跑的两步落了日志（SKIPPED 不经 _log_step）
        self.assertEqual([log["step_order"] for log in self.logs], [1, 3])
        self.assertTrue(all(log["status"] == "OK" for log in self.logs))

    # ---- 3) 条件本身非法 → COND: 错误 --------------------------------------

    def test_invalid_condition_marks_step_cond_error_and_fails_fast(self):
        snap = self._run([
            _cond_step("s1", "fw_version >="),
            _step("s2"),
        ])
        self.assertEqual(snap["result"], "failed")
        self.assertTrue(snap["error"].startswith("COND:"))
        step1 = snap["steps"][0]
        self.assertEqual(step1["status"], "ERROR")
        self.assertTrue(step1["error"].startswith("COND:"))
        self.assertIsNone(step1["sent"])  # 字节没出去
        diag = step1.get("diagnostic")
        self.assertIsNotNone(diag)
        self.assertEqual(diag["stage"], "condition")
        self.assertEqual(diag["code"], "CONDITION_REJECTED")
        self.assertFalse(diag["data_sent"])
        # stop_on_error=True → 后续步补 SKIPPED（error 为空 = 与条件挡下的可区分）
        self.assertEqual(snap["steps"][1]["status"], "SKIPPED")
        self.assertIsNone(snap["steps"][1]["error"])
        # 条件错误也要落日志（与 PLAN: 错误同口径：status=ERROR + 基础帧）
        self.assertEqual(len(self.logs), 1)
        self.assertEqual(self.logs[0]["status"], "ERROR")
        self.assertIn("COND:", self.logs[0]["error"])

    def test_undefined_variable_at_runtime_is_cond_error(self):
        snap = self._run([
            _step("s1"),
            _cond_step("s2", "fw_version >= 0x1200"),
        ], decode_vars=lambda instruction_id, echo: {})
        self.assertEqual(snap["result"], "failed")
        self.assertEqual(snap["steps"][1]["status"], "ERROR")
        self.assertEqual(
            snap["steps"][1]["error"], "COND: 变量未定义：fw_version"
        )

    def test_type_mismatch_is_cond_error(self):
        snap = self._run([
            _step("s1"),
            _cond_step("s2", "step.1.status == 1"),
        ])
        self.assertEqual(snap["steps"][1]["status"], "ERROR")
        self.assertEqual(
            snap["steps"][1]["error"], "COND: 类型无法比较：字符串 与 数字"
        )

    def test_stop_on_error_false_tolerates_cond_errors(self):
        snap = self._run([
            _cond_step("s1", "fw_version >="),
            _step("s2"),
        ], stop_on_error=False)
        self.assertEqual(snap["result"], "completed")
        self.assertIsNone(snap["error"])  # 逐步错误不升级运行级
        self.assertEqual(
            [r["status"] for r in snap["steps"]], ["ERROR", "OK"]
        )

    # ---- 4) 变量上下文 -----------------------------------------------------

    def test_decoded_fields_flow_into_flat_and_step_namespace(self):
        """解码字段两个命名空间并存：平铺键看最新、`step.<n>.<字段>` 回看第几步。"""
        decode_calls = []

        def decode_vars(instruction_id, echo):
            decode_calls.append((instruction_id, echo))
            return {"fw_version": 4608}

        snap = self._run([
            _step("s1"),
            _cond_step("s2", "fw_version >= 0x1200"),
            _cond_step("s3", "step.1.fw_version == 0x1200"),
            _cond_step("s4", 'step.1.received == "A501"'),
        ], decode_vars=decode_vars)
        self.assertEqual(
            [r["status"] for r in snap["steps"]], ["OK", "OK", "OK", "OK"]
        )
        # 解码入口按宿主指令的应答逐次调用（每个 status=OK 且有应答的步一次，
        # 不含被条件挡下的步）
        self.assertEqual(decode_calls, [(INSTR, "A501")] * 4)

    def test_decode_failure_never_breaks_execution(self):
        """注入的回调炸了 → 上下文少几个键，执行本身不受影响。"""
        def boom(instruction_id, echo):
            raise RuntimeError("解码炸了")

        snap = self._run(
            [_step("s1"), _cond_step("s2", 'step.1.status == "OK"')],
            decode_vars=boom,
        )
        self.assertEqual([r["status"] for r in snap["steps"]], ["OK", "OK"])


# ---------------------------------------------------------------------------
# 保存口 / 往返 / 启动注入（临时库直调路由函数）
# ---------------------------------------------------------------------------


class SequenceConditionApiTest(unittest.TestCase):
    def setUp(self):
        transport.reset()
        sequence_runner.reset()
        self.tmp = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp.name) / "test_seq_cond.db"
        self.engine = create_engine(
            f"sqlite:///{db_path.as_posix()}", connect_args={"check_same_thread": False}
        )
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(
            autocommit=False, autoflush=False, bind=self.engine
        )
        self.db = self.session_factory()

    def tearDown(self):
        transport.reset()
        sequence_runner.reset()
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    @staticmethod
    def _payload(steps, name="分支序列"):
        return SequencePayload(
            name=name, description=None, config=None, steps=steps
        )

    def _spec(self, **kwargs):
        base = dict(
            instruction_id=INSTR, label=None, delay_ms=0,
            params=None, payload="A5 01 0B", plan=None,
        )
        base.update(kwargs)
        return SequenceStepSpec(**base)

    def _create(self, steps, name="分支序列"):
        return create_sequence(self._payload(steps, name), db=self.db)

    def _wait_finished(self, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            snap = sequence_runner.snapshot()
            if not snap["running"]:
                return snap
            time.sleep(0.02)
        self.fail("序列未在超时内跑完")

    # ---- 保存侧校验与回显 --------------------------------------------------

    def test_condition_roundtrips_create_then_get(self):
        out = self._create([
            self._spec(payload="A5 01"),
            self._spec(payload="A5 02", condition='step.1.status == "OK"'),
        ])
        self.assertIsNone(out.steps[0].condition)
        self.assertEqual(out.steps[1].condition, 'step.1.status == "OK"')

        again = get_sequence(out.id, db=self.db)
        self.assertIsNone(again.steps[0].condition)
        self.assertEqual(again.steps[1].condition, 'step.1.status == "OK"')
        # 落库确实是这一列（不是只在响应里回显）
        row = (
            self.db.query(SequenceStep)
            .filter(SequenceStep.sequence_id == out.id, SequenceStep.step_order == 1)
            .first()
        )
        self.assertEqual(row.condition, 'step.1.status == "OK"')

    def test_blank_condition_is_stored_as_null(self):
        for i, blank in enumerate(("", "   ")):
            out = self._create([self._spec(condition=blank)], name=f"空条件{i}")
            self.assertIsNone(out.steps[0].condition)
            row = (
                self.db.query(SequenceStep)
                .filter(SequenceStep.sequence_id == out.id)
                .first()
            )
            self.assertIsNone(row.condition)

    def test_invalid_condition_400_with_step_index(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create([self._spec(condition="fw_version >=")])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("steps[0].condition", ctx.exception.detail)
        self.assertIn("缺少比较运算符", ctx.exception.detail)  # 求值器原文带上
        # 结构化诊断与 plan/wrap 同口径（不是裸 400）
        diagnostic = getattr(ctx.exception, "diagnostic", None)
        self.assertIsNotNone(diagnostic)
        self.assertEqual(diagnostic["stage"], "condition")
        self.assertEqual(diagnostic["code"], "STEP_CONDITION_INVALID")
        self.assertFalse(diagnostic["data_sent"])
        self.assertEqual(self.db.query(Sequence).count(), 0)  # 任何写入都没发生

    def test_condition_spec_rejects_non_string(self):
        with self.assertRaises(HTTPException) as ctx:
            _condition_spec(42, "steps[0]", 1)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("steps[0].condition", ctx.exception.detail)

    def test_legacy_spec_without_condition_key_stays_null(self):
        """缺键（存量 FE 请求形）→ None，PUT 整体替换也不引出多余键。"""
        out = self._create([self._spec()])  # spec 里根本没有 condition
        self.assertIsNone(out.steps[0].condition)

    # ---- 启动注入 ----------------------------------------------------------

    def test_start_injects_decode_vars_and_carries_condition(self):
        out = self._create([
            self._spec(payload="A5 01"),
            self._spec(payload="A5 02", condition='step.1.status == "OK"'),
        ])
        with mock.patch.object(
            sequence_runner, "start", return_value=sequence_runner.snapshot()
        ) as spy:
            start_sequence(out.id, db=self.db)

        kwargs = spy.call_args.kwargs
        self.assertTrue(callable(kwargs.get("decode_vars")))
        steps = spy.call_args.args[2]
        self.assertIsNone(steps[0]["condition"])          # 无条件步：键在但为 null
        self.assertEqual(steps[1]["condition"], 'step.1.status == "OK"')
        self.assertTrue(callable(sequence_mod._decode_vars_factory()))

    def test_end_to_end_conditional_run(self):
        """API 全链路：创建（带条件）→ start → 逐步 OK/OK/SKIPPED。"""
        out = self._create([
            self._spec(payload="A5 01"),
            self._spec(payload="A5 02", condition='step.1.status == "OK"'),
            self._spec(payload="A5 03", condition='step.1.status == "ERROR"'),
        ])
        with mock.patch.object(
            sequence_mod, "_decode_vars_factory", self._decode_factory
        ):
            start_sequence(out.id, db=self.db)
            snap = self._wait_finished()

        self.assertEqual(snap["result"], "completed")
        self.assertEqual(
            [r["status"] for r in snap["steps"]], ["OK", "OK", "SKIPPED"]
        )
        self.assertEqual(snap["steps"][2]["error"], "COND: 条件不成立")

    def _decode_factory(self):
        """与 routers/sequence._decode_vars_factory 同形，但开临时库会话（不碰真实库）。"""

        def decode_vars(instruction_id, echo):
            session = self.session_factory()
            try:
                return _flat_decoded(
                    resolve_log_fields(
                        session, echo, instruction_id=instruction_id
                    )
                )
            finally:
                session.close()

        return decode_vars


# ---------------------------------------------------------------------------
# datahub 导出：条件必须整行走包（否则导入回读会静默丢分支）
# ---------------------------------------------------------------------------


class SequenceConditionExportTest(unittest.TestCase):
    def test_export_row_carries_condition(self):
        from backend.routers.datahub import sequence_step_export_row

        step = SequenceStep(
            id=str(uuid.uuid4()),
            sequence_id="q1",
            step_order=0,
            instruction_id=INSTR,
            label="第二步",
            delay_ms=100,
            params=None,
            payload="A5 01",
            plan=None,
            condition="fw_version >= 0x1200",
            wrap=None,
        )
        row = sequence_step_export_row(step)
        self.assertEqual(row["condition"], "fw_version >= 0x1200")
        # 列表外的键不新增（导出形 = 冻结帧整行）
        self.assertIn("wrap", row)
        self.assertIn("payload", row)


if __name__ == "__main__":
    unittest.main()
