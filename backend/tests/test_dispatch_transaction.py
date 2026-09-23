"""P2 事务化发送引擎单测（直调 dispatch_transaction，无 TestClient）。

Run from repo root: python -m unittest discover -s backend/tests
覆盖：默认回显单发、失配重发与间隔、成功落在后续 attempt、广播无应答、
TCP 无应答/传输错误重试、规格三级解析与脏库存 400、参数 400、
历史三事件口径（事务入栈）与 /dispatch 手工口径不回归。
"""

import tempfile
import time
import unittest
import uuid
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core import transport
from backend.db.database import Base
from backend.db.models import ResponseSpec
from backend.routers import dispatch as dispatch_mod
from backend.routers.dispatch import (
    DispatchRequest,
    TransactionRequest,
    dispatch_frame,
    dispatch_transaction,
)
from backend.routers.response_spec import upsert_response_spec
from backend.routers.transport import set_transport_config
from backend.schemas.response_spec_api import ResponseSpecUpsert
from backend.tests.test_transport import _closed_local_port, _TcpPeer

INSTR = "22222222-bbbb-4ccc-8ddd-000000000001"


class TransactionTestBase(unittest.TestCase):
    def setUp(self):
        transport.reset()  # 默认 loopback；reset 同时清钩子，绝不泄漏给其他模块
        dispatch_mod._history.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_txn.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()

    def tearDown(self):
        transport.reset()
        dispatch_mod._history.clear()
        # Windows: 先关会话再 dispose 连接池，否则文件被占用无法删除（WinError 32）
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _tx(self, hex_string="AA 55 01", **kwargs):
        return dispatch_transaction(TransactionRequest(hex_string=hex_string, **kwargs), db=self.db)


class LoopbackTransactionTests(TransactionTestBase):
    def test_default_echo_single_attempt_ok(self):
        record = self._tx("AA 55 01", instruction_name="probe")
        self.assertEqual(record.status, "OK")
        self.assertEqual(record.channel, "LOOPBACK")
        self.assertEqual(record.spec_source, "default")
        self.assertFalse(record.broadcast)
        self.assertEqual(record.byte_count, 3)
        self.assertEqual(record.echo, "AA5501")

        self.assertEqual(len(record.attempts), 1)
        attempt = record.attempts[0]
        self.assertEqual(attempt.n, 1)
        self.assertEqual(attempt.status, "OK")
        self.assertEqual(attempt.sent, "AA 55 01")
        self.assertEqual(attempt.received, "AA 55 01")
        self.assertGreaterEqual(attempt.rtt_ms, 0)
        self.assertEqual(attempt.reasons, [])

        self.assertEqual(record.stats.attempts, 1)
        self.assertIsNotNone(record.stats.rtt_ms_last)
        self.assertIsNotNone(record.stats.rtt_ms_avg)
        self.assertIsNotNone(record.stats.rtt_ms_max)

        # 事务按 SENT + raw/response 口径入 /dispatch/history
        top = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(top.status, "SENT")
        self.assertEqual([e.type for e in top.events], ["raw", "response"])
        self.assertEqual(top.hex_string, "AA 55 01")
        self.assertEqual(top.echo, "AA5501")
        self.assertEqual(top.instruction_name, "probe")

    def test_mismatch_retries_then_fails_and_reports_reasons(self):
        started = time.monotonic()
        record = self._tx(
            "AA 55 01",
            response_spec={"mode": "rules", "suffix": "FFFF"},
            retries=2,
            interval_ms=40,
        )
        elapsed = time.monotonic() - started
        self.assertEqual(record.status, "FAILED")
        self.assertEqual(record.spec_source, "inline")
        self.assertEqual(len(record.attempts), 3)  # 1 + 2 次重发
        for i, attempt in enumerate(record.attempts, start=1):
            self.assertEqual(attempt.n, i)
            self.assertEqual(attempt.status, "MATCH_FAILED")
            self.assertIn("SUFFIX_MISMATCH", attempt.reasons)
        self.assertEqual(record.stats.attempts, 3)
        # 两次 40ms 间隔（容差半格防时钟分辨率误差）
        self.assertGreaterEqual(elapsed, 0.075)

        top = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(top.status, "ERROR")
        self.assertEqual([e.type for e in top.events], ["raw", "error"])
        self.assertIn("MATCH_FAILED", top.events[1].message)
        self.assertIn("SUFFIX_MISMATCH", top.events[1].message)

    def test_success_on_second_attempt_after_flaky_reply(self):
        original = transport.send
        calls = {"n": 0}

        def flaky(data, read_timeout_ms=None):
            calls["n"] += 1
            return b"\x00\x00" if calls["n"] == 1 else bytes(data)

        transport.send = flaky
        try:
            record = self._tx("AA 55 01", retries=2, interval_ms=0)
        finally:
            transport.send = original

        self.assertEqual(calls["n"], 2)  # 首次失配 → 重发一次即成功，不再发
        self.assertEqual(record.status, "OK")
        self.assertEqual([a.status for a in record.attempts], ["MATCH_FAILED", "OK"])
        top = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(top.status, "SENT")   # 最终成功 → SENT
        self.assertEqual(top.echo, "AA5501")   # echo = 末次（成功）应答

    def test_broadcast_skips_matching(self):
        record = self._tx(
            "AA 55 01",
            response_spec={"mode": "rules", "suffix": "FFFF"},  # 回显下本会失配
            broadcast=True,
            retries=3,
            interval_ms=0,
        )
        self.assertTrue(record.broadcast)
        self.assertEqual(record.status, "OK")
        self.assertEqual(record.spec_source, "inline")  # 规格仍解析展示，仅不用于判定
        self.assertEqual(len(record.attempts), 1)       # 无应答语义：发出即成功
        self.assertEqual(record.attempts[0].status, "OK")

    def test_invalid_params_map_to_400(self):
        cases = [
            dict(hex_string="ABC"),                       # 奇数位
            dict(hex_string="01", timeout_ms=0),          # 读超时越界
            dict(hex_string="01", retries=99),            # 重发越界
            dict(hex_string="01", interval_ms=-1),        # 间隔负数
            dict(hex_string="01", response_spec={"mode": "echo", "regex": "x"}),  # 规格脏字段
            dict(hex_string="01", response_spec={"mode": "carrier-pigeon"}),      # 规格脏模式
        ]
        for bad in cases:
            with self.subTest(bad=bad), self.assertRaises(HTTPException) as ctx:
                dispatch_transaction(TransactionRequest(**bad), db=self.db)
            self.assertEqual(ctx.exception.status_code, 400)


class SpecResolutionTests(TransactionTestBase):
    def test_resolution_inline_over_stored_over_default(self):
        # 1) 无规格 → default（回显比对）→ OK
        record = self._tx("AA 55")
        self.assertEqual(record.spec_source, "default")
        self.assertEqual(record.status, "OK")

        # 2) 按指令持久化 → instruction（后缀规则失配）→ FAILED
        upsert_response_spec(
            INSTR,
            ResponseSpecUpsert(spec={"mode": "rules", "suffix": "FFFF"}),
            db=self.db,
        )
        record = self._tx("AA 55", instruction_id=INSTR)
        self.assertEqual(record.spec_source, "instruction")
        self.assertEqual(record.status, "FAILED")

        # 3) 内联覆盖（优先级最高）：rules 无规则 = 接受非空应答 → OK
        record = self._tx("AA 55", instruction_id=INSTR, response_spec={"mode": "rules"})
        self.assertEqual(record.spec_source, "inline")
        self.assertEqual(record.status, "OK")

    def test_stored_garbage_spec_is_400(self):
        # 绕过路由直插脏数据（模拟历史库），事务解析须 400 而非静默用脏规格
        self.db.add(ResponseSpec(
            id=str(uuid.uuid4()),
            instruction_id=INSTR,
            spec={"mode": "echo", "regex": "boom"},
        ))
        self.db.commit()
        with self.assertRaises(HTTPException) as ctx:
            self._tx("AA 55", instruction_id=INSTR)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("Stored response spec invalid", ctx.exception.detail)


class TcpTransactionTests(TransactionTestBase):
    def test_no_response_retries_then_fails(self):
        peer = _TcpPeer(reply=False)  # 静默对端：读超时 → 空应答
        self.addCleanup(peer.stop)
        set_transport_config({
            "mode": "tcp",
            "tcp": {
                "host": "127.0.0.1",
                "port": peer.port,
                "connect_timeout_ms": 500,
                "read_timeout_ms": 150,
            },
        })

        record = self._tx("01 02", retries=1, interval_ms=0, timeout_ms=60)
        self.assertEqual(record.status, "FAILED")
        self.assertEqual(record.channel, "TCP")
        self.assertEqual([a.status for a in record.attempts], ["NO_RESPONSE", "NO_RESPONSE"])
        self.assertEqual(record.attempts[0].received, "")
        # 无字节 → 无 RTT 样本
        self.assertIsNone(record.stats.rtt_ms_last)
        self.assertIsNone(record.stats.rtt_ms_avg)

        top = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(top.status, "ERROR")
        self.assertIn("NO_RESPONSE", top.events[1].message)

    def test_transport_error_retries_and_history_error(self):
        set_transport_config({
            "mode": "tcp",
            "tcp": {
                "host": "127.0.0.1",
                "port": _closed_local_port(),
                "connect_timeout_ms": 200,
                "read_timeout_ms": 100,
            },
        })
        record = self._tx("01", retries=1, interval_ms=0)
        self.assertEqual(record.status, "FAILED")
        self.assertEqual(
            [a.status for a in record.attempts], ["TRANSPORT_ERROR", "TRANSPORT_ERROR"]
        )
        self.assertIn("TCP 连接", record.attempts[0].error)

        top = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(top.status, "ERROR")
        self.assertEqual([e.type for e in top.events], ["raw", "error"])
        self.assertIn("TRANSPORT_ERROR", top.events[1].message)

    def test_manual_dispatch_shape_not_regressed_after_transaction(self):
        # 事务之后手工 /dispatch：既有口径不变、历史按 appendleft 排序
        self._tx("AA 55")
        record = dispatch_frame(DispatchRequest(hex_string="01 02", instruction_name="manual"))
        self.assertEqual(record.status, "SENT")
        self.assertEqual([e.type for e in record.events], ["raw", "response"])
        history = dispatch_mod.dispatch_history(limit=10)
        self.assertEqual([r.hex_string for r in history], ["01 02", "AA 55"])


if __name__ == "__main__":
    unittest.main()
