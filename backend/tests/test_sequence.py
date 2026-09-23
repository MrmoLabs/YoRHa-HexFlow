"""P3 序列 Runner 单测 — stdlib unittest 直调（claim/execute 阻塞执行，不起真线程）。

Run from repo root: python -m unittest discover -s backend/tests
覆盖：loopback 顺序执行与快照形状（轮询契约字段）、单槽占用 → SequenceBusy、
启动前停止 → 全 SKIPPED、stop_on_error 两态（TCP 拒连 → 步 TRANSPORT_ERROR）、
脏计划运行时 PLAN: 兜底、idle 停止幂等。
"""
import unittest

from backend.core import sequence_runner, transport
from backend.routers.transport import set_transport_config
from backend.tests.test_transport import _closed_local_port

INSTR = "22222222-bbbb-4ccc-8ddd-000000000001"


def _step(step_id, payload=b"\xA5\x01", delay_ms=0, plan=None, label=None):
    """Runner 内部步形状（payload = bytes，路由在启动时已归一）。"""
    return {
        "id": step_id,
        "instruction_id": INSTR,
        "label": label,
        "delay_ms": delay_ms,
        "payload": payload,
        "plan": plan,
    }


def _refusing_tcp():
    """拒连对端：connect 即错 → transport.TransportError（秒回，无等待）。"""
    set_transport_config({
        "mode": "tcp",
        "tcp": {
            "host": "127.0.0.1",
            "port": _closed_local_port(),
            "connect_timeout_ms": 200,
            "read_timeout_ms": 100,
        },
    })


class SequenceRunnerTest(unittest.TestCase):
    def setUp(self):
        transport.reset()  # 默认 loopback；reset 同时清钩子，绝不泄漏给其他模块
        sequence_runner.reset()

    def tearDown(self):
        transport.reset()
        sequence_runner.reset()

    def test_claim_execute_loopback_completes(self):
        steps = [
            _step("s1", b"\xA5\x01"),
            _step("s2", b"\xAA\xBB\xCC", label="第二步"),
            _step("s3"),
        ]
        run = sequence_runner.claim(
            "seq-1", "冒烟序列", steps,
            {"stop_on_error": True, "read_timeout_ms": None},
        )
        sequence_runner.execute(run)

        snap = sequence_runner.snapshot()
        self.assertFalse(snap["running"])
        self.assertEqual(snap["result"], "completed")
        self.assertEqual(snap["sequence_id"], "seq-1")
        self.assertEqual(snap["sequence_name"], "冒烟序列")
        self.assertEqual(snap["total_steps"], 3)
        self.assertIsNone(snap["current_step"])  # 终态无进行中步
        self.assertIsNotNone(snap["started_at"])
        self.assertIsNotNone(snap["finished_at"])
        self.assertFalse(snap["stop_requested"])
        self.assertIsNone(snap["error"])

        self.assertEqual([r["n"] for r in snap["steps"]], [1, 2, 3])
        self.assertEqual([r["status"] for r in snap["steps"]], ["OK", "OK", "OK"])
        first = snap["steps"][0]
        self.assertEqual(first["step_id"], "s1")
        self.assertEqual(first["instruction_id"], INSTR)
        self.assertEqual(first["sent"], "A5 01")       # 发送帧：空格大写
        self.assertEqual(first["received"], "A501")    # loopback 回显：紧凑大写
        self.assertIsNotNone(first["rtt_ms"])
        self.assertIsNone(first["error"])
        # label 缺省规则：有 label 用 label，否则 step-N
        self.assertEqual(snap["steps"][1]["label"], "第二步")
        self.assertEqual(snap["steps"][2]["label"], "step-3")

    def test_claim_busy_while_running_then_release(self):
        run = sequence_runner.claim("seq-1", "占用", [_step("s1")], {})
        with self.assertRaises(sequence_runner.SequenceBusy):
            sequence_runner.claim("seq-2", "第二个", [_step("x")], {})
        # 同一序列再启动也拒（路由映射同 409）
        with self.assertRaises(sequence_runner.SequenceBusy):
            sequence_runner.claim("seq-1", "占用", [_step("s1")], {})
        self.assertTrue(sequence_runner.is_running())

        sequence_runner.execute(run)
        self.assertFalse(sequence_runner.is_running())
        # 槽释放后可再占；终态保留到下次 claim 覆盖（轮询能拿到上一轮结果）
        self.assertEqual(sequence_runner.snapshot()["sequence_id"], "seq-1")
        run2 = sequence_runner.claim("seq-2", "再跑", [_step("x")], {})
        sequence_runner.execute(run2)
        self.assertEqual(sequence_runner.snapshot()["sequence_id"], "seq-2")

    def test_stop_before_execute_skips_all(self):
        steps = [_step("s1"), _step("s2", delay_ms=50), _step("s3")]
        run = sequence_runner.claim("seq-stop", "停", steps, {})
        sequence_runner.request_stop()  # execute 首步检查停止位
        sequence_runner.execute(run)
        snap = sequence_runner.snapshot()
        self.assertEqual(snap["result"], "stopped")
        self.assertTrue(snap["stop_requested"])
        self.assertEqual([r["status"] for r in snap["steps"]], ["SKIPPED"] * 3)
        self.assertFalse(snap["running"])

    def test_stop_requested_when_idle_is_noop(self):
        sequence_runner.request_stop()  # idle 无操作（端点恒 200 幂等的前提）
        snap = sequence_runner.snapshot()
        self.assertEqual(snap["result"], "idle")
        self.assertFalse(snap["running"])

    def test_dirty_plan_marks_step_error_and_fails_fast(self):
        dirty = {"dynamic": [{"op": "TIME_ACCUMULATOR", "offset": 1, "byte_len": 2,
                              "base_time": "not-a-date"}]}
        steps = [_step("s1", b"\xA5\x00\x00", plan=dirty), _step("s2")]
        run = sequence_runner.claim(
            "seq-dirty", "脏计划", steps,
            {"stop_on_error": True, "read_timeout_ms": None},
        )
        sequence_runner.execute(run)
        snap = sequence_runner.snapshot()
        self.assertEqual(snap["result"], "failed")
        self.assertTrue(snap["error"].startswith("PLAN:"))
        self.assertEqual(snap["steps"][0]["status"], "ERROR")
        self.assertTrue(snap["steps"][0]["error"].startswith("PLAN:"))
        self.assertIsNone(snap["steps"][0]["sent"])  # 计划失败不发送
        self.assertEqual(snap["steps"][1]["status"], "SKIPPED")

    def test_stop_on_error_false_tolerates_errors(self):
        _refusing_tcp()
        steps = [_step("s1", b"\xA5"), _step("s2", b"\xA6")]
        run = sequence_runner.claim(
            "seq-tolerant", "容错", steps,
            {"stop_on_error": False, "read_timeout_ms": None},
        )
        sequence_runner.execute(run)
        snap = sequence_runner.snapshot()
        self.assertEqual(snap["result"], "completed")   # 记错继续 → 跑完
        self.assertIsNone(snap["error"])                # 逐步错误不升级运行级
        self.assertEqual([r["status"] for r in snap["steps"]], ["ERROR", "ERROR"])
        self.assertTrue(snap["steps"][0]["error"].startswith("TRANSPORT:"))
        self.assertIsNotNone(snap["steps"][0]["sent"])  # 发送已尝试

    def test_stop_on_error_true_aborts_after_first_error(self):
        _refusing_tcp()
        steps = [_step("s1", b"\xA5"), _step("s2", b"\xA6")]
        run = sequence_runner.claim(
            "seq-strict", "中止", steps,
            {"stop_on_error": True, "read_timeout_ms": None},
        )
        sequence_runner.execute(run)
        snap = sequence_runner.snapshot()
        self.assertEqual(snap["result"], "failed")
        self.assertTrue(snap["error"].startswith("TRANSPORT:"))
        self.assertEqual([r["status"] for r in snap["steps"]], ["ERROR", "SKIPPED"])


if __name__ == "__main__":
    unittest.main()
