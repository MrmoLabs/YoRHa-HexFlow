"""P5 通讯日志（dispatch_logs）三路写入 + 查询/导出/回放单测（临时库直调，无 TestClient）。

Run from repo root: python -m unittest discover -s backend/tests
覆盖：manual/transaction/sequence/replay 四路落行与状态归一（SENT/FAILED→OK/ERROR）、
SKIPPED 不落日志、直调不传 db 旁路守卫、非法字段不写、查询降序/limit 钳制/过滤 400、
CSV(BOM)/JSON 导出与格式 400、回放 200/400/404/409/502（成败皆入 history + 落新行）、
DELETE 清空。序列路读行走新会话（顺带证明跨会话持久化）。
"""
import json as jsonlib
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core import sequence_runner, transport
from backend.db.database import Base
from backend.db.log_store import log_hook, safe_log
from backend.db.models import DispatchLog
from backend.routers import dispatch as dispatch_mod
from backend.routers.dispatch import (
    DispatchRequest,
    TransactionRequest,
    dispatch_frame,
    dispatch_transaction,
)
from backend.routers.logs import clear_logs, export_logs, list_logs, replay_log
from backend.tests.test_sequence import INSTR, _refusing_tcp, _step

CSV_HEADER = (
    "id,created_at,source,channel,status,byte_count,hex_string,echo,"
    "instruction_name,instruction_id,sequence_id,step_order,rtt_ms,error"
)


class LogsTestBase(unittest.TestCase):
    def setUp(self):
        transport.reset()  # 默认 loopback；reset 同时清钩子，绝不泄漏给其他模块
        dispatch_mod._history.clear()
        sequence_runner.reset()  # 清运行态 + 日志钩子
        # 临时库文件：写侧（含 Runner 钩子）与读侧不同会话，证明跨会话持久
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_logs.db').as_posix()}"
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

    def _latest(self):
        return self.db.query(DispatchLog).order_by(DispatchLog.id.desc()).first()

    def _count(self):
        return self.db.query(DispatchLog).count()

    def _fresh_rows(self, **kwargs):
        """新会话读（Runner 钩子走独立会话写入 → 顺带验证跨会话可见）。"""
        fresh = self.session_factory()
        try:
            return list_logs(db=fresh, **kwargs)
        finally:
            fresh.close()

    def _wire_runner(self):
        sequence_runner.set_log_hook(log_hook(self.session_factory))


class ManualAndTransactionWritesTest(LogsTestBase):
    def test_manual_ok_row_and_direct_call_without_db_is_guarded(self):
        record = dispatch_frame(
            DispatchRequest(hex_string="AA 55", instruction_name="冒烟手动"),
            db=self.db,
        )
        self.assertEqual(record.status, "SENT")
        row = self._latest()
        self.assertEqual(row.source, "manual")
        self.assertEqual(row.status, "OK")
        self.assertEqual(row.channel, "LOOPBACK")
        self.assertEqual(row.hex_string, "AA 55")
        self.assertEqual(row.echo, "AA55")
        self.assertEqual(row.byte_count, 2)
        self.assertEqual(row.instruction_name, "冒烟手动")
        self.assertIsNone(row.error)
        self.assertIsNone(row.sequence_id)
        self.assertIsNone(row.step_order)
        self.assertIsNone(row.rtt_ms)
        self.assertTrue(row.created_at.endswith("+00:00"))

        # 直调不传 db（既有测试口径）→ safe_log 旁路守卫：不炸、不写行
        before = self._count()
        guard = dispatch_frame(DispatchRequest(hex_string="01 02"))
        self.assertEqual(guard.status, "SENT")
        self.assertEqual(self._count(), before)

    def test_manual_transport_error_row(self):
        _refusing_tcp()
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(DispatchRequest(hex_string="01 02"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 502)
        row = self._latest()
        self.assertEqual(row.source, "manual")
        self.assertEqual(row.status, "ERROR")
        self.assertEqual(row.hex_string, "01 02")
        self.assertEqual(row.echo, "")
        self.assertTrue(row.error)
        top = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(top.status, "ERROR")

    def test_transaction_ok_and_failed_rows(self):
        dispatch_transaction(
            TransactionRequest(
                hex_string="AA 55 01", instruction_name="事务甲", instruction_id=INSTR
            ),
            db=self.db,
        )
        ok = self._latest()
        self.assertEqual(ok.source, "transaction")
        self.assertEqual(ok.status, "OK")
        self.assertEqual(ok.instruction_id, INSTR)
        self.assertEqual(ok.instruction_name, "事务甲")
        self.assertEqual(ok.echo, "AA5501")
        self.assertIsNotNone(ok.rtt_ms)  # 事务路带末次样本
        self.assertIsNone(ok.error)

        # 内联失配规格（loopback 回显不含 FFFF）→ 1 次尝试即 FAILED → 归一 ERROR
        dispatch_transaction(
            TransactionRequest(
                hex_string="AA 55 01",
                response_spec={"mode": "rules", "suffix": "FFFF"},
                retries=0,
                interval_ms=0,
            ),
            db=self.db,
        )
        bad = self._latest()
        self.assertEqual(bad.source, "transaction")
        self.assertEqual(bad.status, "ERROR")
        self.assertIn("MATCH_FAILED", bad.error)
        self.assertIn("SUFFIX_MISMATCH", bad.error)

    def test_safe_log_rejects_invalid_source_without_row(self):
        # 旁路守卫：非法字段在 record_log 抛错 → safe_log 吞掉回滚，不落行也不炸
        safe_log(
            self.db, source="bogus", status="OK", channel="LOOPBACK",
            hex_string="01", echo="",
        )
        self.assertEqual(self._count(), 0)


class SequenceWritesTest(LogsTestBase):
    def test_sequence_ok_rows_across_sessions(self):
        self._wire_runner()
        run = sequence_runner.claim(
            "seq-p5", "日志序列",
            [_step("s1"), _step("s2", label="二步")],
            {"stop_on_error": True, "read_timeout_ms": None},
        )
        sequence_runner.execute(run)

        rows = self._fresh_rows()  # 新会话读
        self.assertEqual(len(rows), 2)
        self.assertEqual([r.step_order for r in rows], [2, 1])  # id 降序 = 后发在前
        second = rows[0]
        self.assertEqual(second.source, "sequence")
        self.assertEqual(second.status, "OK")
        self.assertEqual(second.sequence_id, "seq-p5")
        self.assertEqual(second.instruction_name, "二步")  # 步 label
        self.assertEqual(second.instruction_id, INSTR)
        self.assertEqual(second.hex_string, "A5 01")
        self.assertEqual(second.echo, "A501")  # loopback 回显 compact
        self.assertIsNotNone(second.rtt_ms)
        self.assertIsNone(second.error)
        first = rows[1]
        self.assertEqual(first.instruction_name, "step-1")  # label 缺省 → step-N

    def test_sequence_skipped_writes_nothing_and_error_row(self):
        self._wire_runner()
        # 执行前请求停止 → 全 SKIPPED：未发生通讯 → 不落行
        run = sequence_runner.claim("seq-skip", "跳过", [_step("s1")], {})
        run.stop = True
        sequence_runner.execute(run)
        self.assertEqual(sequence_runner.snapshot()["result"], "stopped")
        self.assertEqual(self._fresh_rows(), [])

        # TCP 拒连 → 步 TRANSPORT ERROR → 落 ERROR 行（sent 已置 → 帧可回放）
        _refusing_tcp()
        run2 = sequence_runner.claim(
            "seq-err", "错误", [_step("s1")], {"stop_on_error": True, "read_timeout_ms": None}
        )
        sequence_runner.execute(run2)
        rows = self._fresh_rows()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row.source, "sequence")
        self.assertEqual(row.status, "ERROR")
        self.assertEqual(row.sequence_id, "seq-err")
        self.assertEqual(row.hex_string, "A5 01")
        self.assertEqual(row.echo, "")
        self.assertTrue(row.error.startswith("TRANSPORT:"))


class QueryExportDeleteTest(LogsTestBase):
    def _seed(self):
        dispatch_frame(DispatchRequest(hex_string="01"), db=self.db)
        dispatch_frame(DispatchRequest(hex_string="02"), db=self.db)
        dispatch_frame(DispatchRequest(hex_string="03", instruction_name="冒烟手动"), db=self.db)
        dispatch_transaction(TransactionRequest(hex_string="AA 55 01"), db=self.db)

    def test_list_order_limit_and_filters(self):
        self._seed()
        rows = list_logs(db=self.db)
        self.assertEqual([r.hex_string for r in rows], ["AA 55 01", "03", "02", "01"])  # 新在前
        self.assertEqual([r.hex_string for r in list_logs(limit=2, db=self.db)], ["AA 55 01", "03"])
        self.assertEqual(
            [r.hex_string for r in list_logs(source="manual", db=self.db)], ["03", "02", "01"]
        )
        self.assertEqual(list_logs(status="ERROR", db=self.db), [])  # 四条全 OK
        self.assertEqual(len(list_logs(status="OK", db=self.db)), 4)
        # limit 静默钳制（同 /dispatch/history 先例）
        self.assertEqual(len(list_logs(limit=0, db=self.db)), 1)
        self.assertEqual(len(list_logs(limit=99999, db=self.db)), 4)
        # 非法过滤值 400（业务口径 detail）
        for kwargs in ({"source": "bogus"}, {"status": "NOPE"}):
            with self.assertRaises(HTTPException) as ctx:
                list_logs(db=self.db, **kwargs)
            self.assertEqual(ctx.exception.status_code, 400)

    def test_export_csv_json_and_bad_format(self):
        self._seed()
        csv_resp = export_logs(format="csv", db=self.db)
        self.assertEqual(csv_resp.media_type, "text/csv; charset=utf-8")
        self.assertEqual(
            csv_resp.headers["content-disposition"],
            'attachment; filename="dispatch_logs.csv"',
        )
        text = csv_resp.body.decode("utf-8")
        self.assertTrue(text.startswith("﻿"))  # utf-8 BOM → Excel 中文不乱码
        self.assertIn(CSV_HEADER, text.lstrip("﻿"))
        self.assertIn("transaction", text)
        self.assertIn("冒烟手动", text)

        json_resp = export_logs(format="json", db=self.db)
        self.assertEqual(json_resp.media_type, "application/json; charset=utf-8")
        self.assertEqual(
            json_resp.headers["content-disposition"],
            'attachment; filename="dispatch_logs.json"',
        )
        items = jsonlib.loads(json_resp.body.decode("utf-8"))
        self.assertEqual(len(items), 4)
        self.assertEqual(items[0]["source"], "transaction")  # 新在前
        self.assertEqual(items[0]["hex_string"], "AA 55 01")

        # 过滤同样作用于导出
        filtered = export_logs(format="csv", source="manual", db=self.db)
        body = filtered.body.decode("utf-8")
        self.assertIn("manual", body)
        self.assertNotIn("transaction", body)

        with self.assertRaises(HTTPException) as ctx:
            export_logs(format="xml", db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_delete_clears(self):
        self._seed()
        result = clear_logs(db=self.db)
        self.assertEqual(result, {"status": "cleared", "remaining": 0})
        self.assertEqual(self._count(), 0)
        self.assertEqual(list_logs(db=self.db), [])


class ReplayTests(LogsTestBase):
    def _seed_log(self, hex_string="AA 55", name="回放源"):
        dispatch_frame(DispatchRequest(hex_string=hex_string, instruction_name=name), db=self.db)
        return self._latest().id

    def test_replay_resends_writes_new_row_and_history(self):
        log_id = self._seed_log()
        out = replay_log(log_id, db=self.db)
        self.assertEqual(out.status, "SENT")
        self.assertEqual(out.hex_string, "AA 55")
        self.assertEqual(out.echo, "AA55")
        self.assertEqual(out.instruction_name, "回放源")  # 延续存档标签

        rows = list_logs(db=self.db)
        self.assertEqual(len(rows), 2)
        top = rows[0]
        self.assertGreater(top.id, rows[1].id)
        self.assertEqual(top.source, "replay")
        self.assertEqual(top.status, "OK")
        self.assertEqual(top.instruction_name, "回放源")
        self.assertIsNone(top.sequence_id)  # 回放是独立发送，不挂回原序列
        self.assertIsNone(top.error)
        # 三事件口径入 /dispatch/history（Terminal 面板可见）
        hist = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(hist.status, "SENT")
        self.assertEqual(hist.hex_string, "AA 55")
        self.assertEqual([e.type for e in hist.events], ["raw", "response"])

    def test_replay_unknown_404(self):
        with self.assertRaises(HTTPException) as ctx:
            replay_log(999999, db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("日志不存在", ctx.exception.detail)

    def test_replay_mutual_exclusion_409_while_sequence_running(self):
        log_id = self._seed_log()
        before = self._count()
        sequence_runner.claim("seq-busy", "占槽", [_step("s")], {})  # 占槽不执行 → 运行中
        with self.assertRaises(HTTPException) as ctx:
            replay_log(log_id, db=self.db)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("互斥", ctx.exception.detail)
        self.assertEqual(self._count(), before)  # 未发送 → 不落 replay 行

    def test_replay_transport_error_502_logs_error_row(self):
        log_id = self._seed_log()
        _refusing_tcp()
        with self.assertRaises(HTTPException) as ctx:
            replay_log(log_id, db=self.db)
        self.assertEqual(ctx.exception.status_code, 502)
        top = self._latest()
        self.assertEqual(top.source, "replay")
        self.assertEqual(top.status, "ERROR")
        self.assertTrue(top.error)
        hist = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(hist.status, "ERROR")
        self.assertEqual([e.type for e in hist.events], ["raw", "error"])

    def test_replay_corrupt_stored_hex_400(self):
        # 直插脏行（绕过写侧校验）→ 回放按存档帧解析 400
        row = DispatchLog(
            created_at="2026-09-23T00:00:00+00:00",
            source="manual", channel="LOOPBACK", status="OK",
            byte_count=1, hex_string="ZZ", echo="", instruction_name=None,
        )
        self.db.add(row)
        self.db.commit()
        with self.assertRaises(HTTPException) as ctx:
            replay_log(row.id, db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
