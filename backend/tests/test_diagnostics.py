"""关键链路统一诊断验收（PLAN §8.32 · `backend/core/diagnostics.py` + 四链路接线）。

四条链路 = **组帧 → 发送 → 应答匹配 → 序列执行**。验收三件事：

1. **形状只做加法**：`DiagHTTPException` → `{"detail": 原文, "diagnostic": {...}}`；
   普通 `HTTPException` 不被接管；`detail` 恒为字符串且**文案与接线前逐字相同**
   （§0 硬约束：既有消费方与断言零改）。
2. **诊断真能定位**：stage（失败层）/ code（稳定机器码）/ target（字段·配方·步）/
   layer（封装层，与「第 N 层」同序）/ step（序列步号）/ data_sent（字节是否已发出）。
3. **链路闭环**：组帧（encode/escape/wrap + 层号透传到 `_freeze_wrap` 的
   `steps[i]:` 文案里）、发送（transport 502 / sequence 409）、应答匹配
   （spec 4xx + 失败事务三态 diagnostic）、序列执行（ERROR 步必带 diagnostic）。

全部直调路由函数（stdlib unittest，无 TestClient —— 对齐 test_wrap_api 范式）。
"""
import json
import unittest
from unittest import mock

from fastapi import FastAPI, HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core import diagnostics as diag
from backend.core import sequence_runner, transport
from backend.core.recipe_compile import compile_recipe
from backend.db.database import Base
from backend.db.models import ProtocolTemplate
from backend.routers import dispatch as dispatch_mod
from backend.routers.compile import compile_wrapped_frame
from backend.routers.dispatch import (
    DispatchRequest,
    TransactionRequest,
    WrapSpec,
    _transaction_diagnostic,
    dispatch_frame,
    dispatch_transaction,
)
from backend.routers.recipe import create_recipe
from backend.routers.sequence import _freeze_wrap
from backend.routers.transport import set_transport_config
from backend.schemas.block import WrappedCompileRequest
from backend.schemas.recipe_api import RecipeCreate, RecipeStage
from backend.tests.test_sequence import _step
from backend.tests.test_transport import _closed_local_port

PROTO_ID = "proto-diag"
PROTO_2 = "proto-diag-2"
PROTO_CHILDREN = [
    {"id": "h", "label": "h", "type": "fixed", "byte_length": 2,
     "hex_value": "FA FA", "config": {}, "children": []},
    {"id": "l", "label": "l", "type": "length", "byte_length": 1,
     "hex_value": "00", "config": {},
     "parameter_config": {"type": "length", "refs": ["s"]}, "children": []},
    {"id": "s", "label": "s", "type": "slot", "byte_length": 0,
     "hex_value": None, "config": {}, "children": []},
    {"id": "t", "label": "t", "type": "fixed", "byte_length": 1,
     "hex_value": "ED", "config": {}, "children": []},
]


class DiagnosticModelTest(unittest.TestCase):
    """诊断对象自身的纪律：未知 stage 拒收、None 键不输出、detail 同源。"""

    def test_unknown_stage_rejected(self):
        with self.assertRaises(ValueError):
            diag.Diagnostic(stage="nowhere", code="X", message="m")

    def test_to_dict_drops_none_keys(self):
        d = diag.Diagnostic(stage="wrap", code="WRAP_REJECT", message="m").to_dict()
        self.assertEqual(set(d), {"stage", "code", "message"})
        d2 = diag.Diagnostic(
            stage="wrap", code="WRAP_LAYER_REJECT", message="m",
            target="p1", layer=2, data_sent=False, byte_count=7,
        ).to_dict()
        self.assertEqual(d2["layer"], 2)
        self.assertIs(d2["data_sent"], False)

    def test_http_message_is_detail_verbatim(self):
        exc = diag.http(400, "坏在这一层", "wrap", "WRAP_REJECT", layer=1)
        self.assertIsInstance(exc, HTTPException)
        self.assertEqual(exc.detail, "坏在这一层")
        self.assertEqual(exc.diagnostic["message"], "坏在这一层")
        self.assertEqual(exc.diagnostic["layer"], 1)

    def test_diag_error_is_value_error(self):
        """DiagError 必须是 ValueError 子类 → 既有 `except ValueError` 不改一行。"""
        err = diag.DiagError(
            "第 2 层（壳）：洞位不足",
            diag.Diagnostic(stage="wrap", code="WRAP_LAYER_REJECT",
                            message="第 2 层（壳）：洞位不足", layer=2),
        )
        self.assertIsInstance(err, ValueError)
        with self.assertRaises(ValueError):
            raise err
        self.assertEqual(err.diagnostic["layer"], 2)

    def test_http_from_keeps_diagerror_diagnostic(self):
        err = diag.DiagError(
            "第 3 层（壳）：溢出",
            diag.Diagnostic(stage="wrap", code="WRAP_LAYER_REJECT",
                            message="第 3 层（壳）：溢出", layer=3, target="p3"),
        )
        exc = diag.http_from(err, 400, str(err), "wrap", "WRAP_REJECTED")
        self.assertEqual(exc.diagnostic["layer"], 3)   # 层号不被兜底覆盖
        self.assertEqual(exc.diagnostic["target"], "p3")
        self.assertEqual(exc.diagnostic["code"], "WRAP_LAYER_REJECT")

    def test_http_from_plain_value_error_uses_fallback(self):
        exc = diag.http_from(ValueError("boom"), 400, "boom", "encode",
                             "PAYLOAD_INVALID", data_sent=False)
        self.assertEqual(exc.diagnostic["stage"], "encode")
        self.assertEqual(exc.diagnostic["code"], "PAYLOAD_INVALID")
        self.assertIs(exc.diagnostic["data_sent"], False)

    def test_with_detail_rewrites_text_keeps_layer(self):
        inner = diag.http(404, "Protocol not found", "wrap",
                          "WRAP_PROTOCOL_NOT_FOUND", layer=2, target="p-missing")
        outer = diag.with_detail(inner, 400, "steps[1]: Protocol not found",
                                 target="steps[1]")
        self.assertEqual(outer.detail, "steps[1]: Protocol not found")
        self.assertEqual(outer.status_code, 400)
        self.assertEqual(outer.diagnostic["layer"], 2)          # 层号保留
        self.assertEqual(outer.diagnostic["target"], "p-missing")  # 更具体者优先
        self.assertEqual(outer.diagnostic["message"], "steps[1]: Protocol not found")


class HandlerShapeTest(unittest.TestCase):
    """响应形状：detail 原文 + diagnostic 并存；普通 HTTPException 不被接管。"""

    def setUp(self):
        self.app = FastAPI()
        diag.install(self.app)

    def test_handler_emits_detail_plus_diagnostic(self):
        handler = self.app.exception_handlers[diag.DiagHTTPException]
        exc = diag.http(400, "坏在这一层", "wrap", "WRAP_REJECT",
                        target="proto-x", layer=2, data_sent=False)
        resp = handler(None, exc)
        body = json.loads(resp.body)
        self.assertEqual(resp.status_code, 400)
        self.assertIsInstance(body["detail"], str)
        self.assertEqual(body["detail"], "坏在这一层")
        self.assertEqual(body["diagnostic"]["stage"], "wrap")
        self.assertEqual(body["diagnostic"]["layer"], 2)
        self.assertIs(body["diagnostic"]["data_sent"], False)

    def test_plain_http_exception_keeps_default_shape(self):
        """未带诊断的 HTTPException 仍走 FastAPI 默认 handler → 形状只有 detail。"""
        import asyncio

        from fastapi.exception_handlers import http_exception_handler
        from starlette.exceptions import HTTPException as StarletteHTTPException

        self.assertIs(
            self.app.exception_handlers[StarletteHTTPException],
            http_exception_handler,
        )
        self.assertIsNot(
            self.app.exception_handlers[StarletteHTTPException],
            self.app.exception_handlers[diag.DiagHTTPException],
        )
        resp = asyncio.run(
            http_exception_handler(None, HTTPException(404, "Protocol not found"))
        )
        self.assertEqual(json.loads(resp.body), {"detail": "Protocol not found"})

    def test_install_is_idempotent(self):
        before = self.app.exception_handlers[diag.DiagHTTPException]
        diag.install(self.app)
        self.assertIs(self.app.exception_handlers[diag.DiagHTTPException], before)


class _DiagTestBase(unittest.TestCase):
    """临时库 + loopback + 干净历史（对齐 test_wrap_api 范式）。

    资源全部走 `addCleanup`（LIFO）—— 子类 setUp 中途失败也会按序释放，
    不会在进程退出时留下 Windows 文件占用报错。
    """

    def setUp(self):
        import tempfile
        from pathlib import Path

        transport.reset()
        self.addCleanup(transport.reset)
        sequence_runner.reset()
        self.addCleanup(sequence_runner.reset)
        dispatch_mod._history.clear()
        self.addCleanup(dispatch_mod._history.clear)

        tmp = tempfile.TemporaryDirectory()
        self.tmp = tmp
        self.addCleanup(tmp.cleanup)
        db_path = Path(tmp.name) / "diag.db"
        self.engine = create_engine(
            f"sqlite:///{db_path.as_posix()}", connect_args={"check_same_thread": False}
        )
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(
            autocommit=False, autoflush=False, bind=self.engine
        )
        self.db = self.session_factory()
        self.addCleanup(self.db.close)
        self.db.add(ProtocolTemplate(
            id=PROTO_ID, label="诊断协议", type="container", children=PROTO_CHILDREN,
        ))
        self.db.add(ProtocolTemplate(
            id=PROTO_2, label="诊断协议二", type="container", children=PROTO_CHILDREN,
        ))
        self.db.commit()


class FrameDiagnosticsTests(_DiagTestBase):
    """组帧链路：encode / escape / wrap 三层各自报得出，且文案不变。"""

    def test_missing_payload_is_encode_stage(self):
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(DispatchRequest(instruction_name="空"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        # 文案逐字不变（§0）
        self.assertEqual(ctx.exception.detail, "hex_string 与 wrap.payloads 至少提供一个")
        self.assertEqual(ctx.exception.diagnostic["stage"], "encode")
        self.assertEqual(ctx.exception.diagnostic["code"], "PAYLOAD_MISSING")
        self.assertIs(ctx.exception.diagnostic["data_sent"], False)

    def test_bad_hex_is_encode_stage(self):
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(DispatchRequest(hex_string="ZZ"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertTrue(ctx.exception.detail.startswith("Invalid payload: "))
        self.assertEqual(ctx.exception.diagnostic["stage"], "encode")
        self.assertEqual(ctx.exception.diagnostic["code"], "PAYLOAD_INVALID")
        self.assertIs(ctx.exception.diagnostic["data_sent"], False)

    def test_bad_hex_with_escape_enabled_is_escape_stage(self):
        # escape 开启时同一串坏 hex 由转义层先拒 → stage 必须是 escape 而非 encode
        set_transport_config({"escape": {"enabled": True, "pairs": [["7D", "7D5D"]]}})
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(DispatchRequest(hex_string="ZZ"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.diagnostic["stage"], "escape")
        self.assertEqual(ctx.exception.diagnostic["code"], "ESCAPE_REJECTED")

    def test_unknown_protocol_is_wrap_stage_with_target(self):
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(
                DispatchRequest(wrap=WrapSpec(protocol_id="proto-nope",
                                              payloads=["0102"])),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.detail, "Protocol not found")  # 文案不变
        self.assertEqual(ctx.exception.diagnostic["stage"], "wrap")
        self.assertEqual(ctx.exception.diagnostic["code"], "WRAP_PROTOCOL_NOT_FOUND")
        self.assertEqual(ctx.exception.diagnostic["target"], "proto-nope")
        self.assertIs(ctx.exception.diagnostic["data_sent"], False)

    def test_wrap_spec_exclusive(self):
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(
                DispatchRequest(wrap=WrapSpec(protocol_id="a", recipe_id="b",
                                              payloads=["0102"])),
                db=self.db,
            )
        self.assertEqual(ctx.exception.detail, "protocol_id 与 recipe_id 互斥，只能指定一个")
        self.assertEqual(ctx.exception.diagnostic["code"], "WRAP_SPEC_EXCLUSIVE")
        self.assertEqual(ctx.exception.diagnostic["stage"], "wrap")

    def test_compile_reject_is_wrap_stage(self):
        self.db.add(ProtocolTemplate(
            id="proto-fit-reject", label="拒溢协议", type="container",
            children=[{
                "id": "s", "label": "s", "type": "slot", "byte_length": 0,
                "hex_value": None, "config": {}, "children": [],
                "parameter_config": {"fit_policy": {
                    "overflow": "reject", "underflow": "reject"}},
            }],
        ))
        self.db.commit()
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(
                DispatchRequest(wrap=WrapSpec(protocol_id="proto-fit-reject",
                                              payloads=["0102", "0304"])),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("洞位不足", ctx.exception.detail)
        self.assertEqual(ctx.exception.diagnostic["stage"], "wrap")
        self.assertEqual(ctx.exception.diagnostic["code"], "WRAP_REJECTED")
        self.assertIs(ctx.exception.diagnostic["data_sent"], False)


class SendDiagnosticsTests(_DiagTestBase):
    """发送链路：传输失败 502 / 序列互斥 409 —— data_sent 必须是 False。"""

    def test_transport_error_reports_not_sent(self):
        set_transport_config({
            "mode": "tcp",
            "tcp": {"host": "127.0.0.1", "port": _closed_local_port(),
                    "connect_timeout_ms": 200, "read_timeout_ms": 100},
        })
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(DispatchRequest(hex_string="A5 01"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertTrue(ctx.exception.detail.startswith("Transport error: "))
        d = ctx.exception.diagnostic
        self.assertEqual(d["stage"], "transport")
        self.assertEqual(d["code"], "TRANSPORT_ERROR")
        self.assertIs(d["data_sent"], False)   # send 未完整返回 → 视为没发出去
        self.assertEqual(d["byte_count"], 2)   # 但知道试图发多少字节

    def test_sequence_running_blocks_manual_send(self):
        with mock.patch.object(sequence_runner, "is_running", return_value=True):
            with self.assertRaises(HTTPException) as ctx:
                dispatch_frame(DispatchRequest(hex_string="A5 01"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.detail, "序列运行中，手动发送已互斥（先停止序列）")
        self.assertEqual(ctx.exception.diagnostic["stage"], "sequence")
        self.assertEqual(ctx.exception.diagnostic["code"], "SEQUENCE_RUNNING")
        self.assertIs(ctx.exception.diagnostic["data_sent"], False)

    def test_sequence_running_blocks_transaction_too(self):
        with mock.patch.object(sequence_runner, "is_running", return_value=True):
            with self.assertRaises(HTTPException) as ctx:
                dispatch_transaction(
                    TransactionRequest(hex_string="A5 01"), db=self.db
                )
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.diagnostic["stage"], "sequence")


class MatchDiagnosticsTests(_DiagTestBase):
    """应答匹配链路：spec 解析 4xx + 失败事务三态 diagnostic。"""

    def test_invalid_inline_spec_is_spec_stage(self):
        with self.assertRaises(HTTPException) as ctx:
            dispatch_transaction(
                TransactionRequest(hex_string="A5 01",
                                   response_spec={"bogus_key": 1}),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertTrue(ctx.exception.detail.startswith("Invalid response spec: "))
        self.assertEqual(ctx.exception.diagnostic["stage"], "spec")
        self.assertEqual(ctx.exception.diagnostic["code"], "SPEC_INVALID")
        self.assertEqual(ctx.exception.diagnostic["target"], "response_spec")

    def test_bad_transaction_param_is_param_stage(self):
        with self.assertRaises(HTTPException) as ctx:
            dispatch_transaction(
                TransactionRequest(hex_string="A5 01", timeout_ms=0), db=self.db
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.diagnostic["stage"], "param")
        self.assertEqual(ctx.exception.diagnostic["target"], "timeout_ms")

    def test_match_failed_transaction_carries_diagnostic(self):
        # 内联 spec 要求 DE AD 前缀 → loopback 回显 A501 必失配；帧确实出线了
        record = dispatch_transaction(
            TransactionRequest(
                hex_string="A5 01", retries=1,
                response_spec={"prefix": "DE AD"},
            ),
            db=self.db,
        )
        self.assertEqual(record.status, "FAILED")
        self.assertIsNotNone(record.diagnostic)
        d = record.diagnostic
        self.assertEqual(d["stage"], "match")
        self.assertEqual(d["code"], "MATCH_FAILED")
        self.assertIs(d["data_sent"], True)   # 关键区分：发出去了，只是对不上
        self.assertEqual(d["byte_count"], 2)
        self.assertIn("PREFIX_MISMATCH", d["message"])
        self.assertEqual(record.attempts[-1].status, "MATCH_FAILED")

    def test_ok_transaction_diagnostic_is_null(self):
        record = dispatch_transaction(
            TransactionRequest(hex_string="A5 01", retries=0), db=self.db
        )
        self.assertEqual(record.status, "OK")
        self.assertIsNone(record.diagnostic)

    def test_transaction_diagnostic_three_states(self):
        from backend.routers.dispatch import TransactionAttempt

        transport_err = TransactionAttempt(
            n=2, status="TRANSPORT_ERROR", sent="A5 01", received="",
            rtt_ms=1.0, error="连接被拒",
        )
        d1 = _transaction_diagnostic(transport_err, 2)
        self.assertEqual((d1.stage, d1.data_sent), ("transport", False))

        no_resp = TransactionAttempt(
            n=3, status="NO_RESPONSE", sent="A5 01", received="", rtt_ms=500.0
        )
        d2 = _transaction_diagnostic(no_resp, 2)
        self.assertEqual((d2.stage, d2.code, d2.data_sent),
                         ("match", "NO_RESPONSE", True))

        mismatch = TransactionAttempt(
            n=1, status="MATCH_FAILED", sent="A5 01", received="B6 02",
            rtt_ms=0.5, reasons=["STAGE[1].PREFIX_MISMATCH", "SUFFIX_MISMATCH"],
        )
        d3 = _transaction_diagnostic(mismatch, 2)
        self.assertEqual((d3.stage, d3.code), ("match", "MATCH_FAILED"))
        self.assertEqual(d3.layer, 2)          # STAGE[1] → 第 2 层（与配方 stage 同序）
        self.assertEqual(d3.target, "STAGE[1].PREFIX_MISMATCH")
        self.assertIs(d3.data_sent, True)

        ok = TransactionAttempt(
            n=1, status="OK", sent="A5 01", received="A501", rtt_ms=0.3
        )
        self.assertIsNone(_transaction_diagnostic(ok, 2))


class RecipeLayerDiagnosticsTests(_DiagTestBase):
    """封装层号：多层配方里「哪一层出的事」必须一路带到响应。"""

    def setUp(self):
        super().setUp()
        # 两层配方先在两份协议都在时入库（create_recipe 会 404 校验协议存在），
        # 再删掉第二层协议 —— 模拟「保存后协议被删」，编译期才暴露出层号定位。
        self.recipe = create_recipe(
            RecipeCreate(
                id="recipe-diag", name="诊断配方",
                stages=[
                    RecipeStage(protocol_id=PROTO_ID, slot_ids=["s"]),
                    RecipeStage(protocol_id=PROTO_2, slot_ids=["s"]),
                ],
            ),
            self.db,
        )
        self.db.query(ProtocolTemplate).filter(
            ProtocolTemplate.id == PROTO_2
        ).delete()
        self.db.commit()

    def test_missing_protocol_at_layer_two(self):
        with self.assertRaises(HTTPException) as ctx:
            compile_wrapped_frame(
                WrappedCompileRequest(recipe_id="recipe-diag", payloads=["0102"]),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.detail, "Protocol not found")  # 文案不变
        d = ctx.exception.diagnostic
        self.assertEqual(d["stage"], "wrap")
        self.assertEqual(d["code"], "WRAP_PROTOCOL_NOT_FOUND")
        self.assertEqual(d["layer"], 2)          # 第 2 层的协议被删了
        self.assertEqual(d["target"], PROTO_2)
        self.assertIs(d["data_sent"], False)

    def test_layer_survives_freeze_wrap_detail_rewrap(self):
        """_freeze_wrap 把 400 包成 `steps[i]:` 文案时，层号不能被包掉。"""
        with self.assertRaises(HTTPException) as ctx:
            _freeze_wrap(self.db, "steps[1]", "recipe-diag", b"\x01\x02", None)
        self.assertEqual(ctx.exception.detail, "steps[1]: Protocol not found")
        d = ctx.exception.diagnostic
        self.assertEqual(d["layer"], 2)
        self.assertEqual(d["message"], "steps[1]: Protocol not found")

    def test_dispatch_recipe_path_propagates_layer(self):
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(
                DispatchRequest(
                    wrap=WrapSpec(recipe_id="recipe-diag", payloads=["0102"])
                ),
                db=self.db,
            )
        self.assertEqual(ctx.exception.diagnostic.get("layer"), 2)

    def test_recipe_not_found_is_wrap_stage(self):
        with self.assertRaises(HTTPException) as ctx:
            compile_recipe(self.db, "recipe-nope", ["0102"])
        self.assertEqual(ctx.exception.detail, "Recipe not found")
        self.assertEqual(ctx.exception.diagnostic["code"], "RECIPE_NOT_FOUND")
        self.assertEqual(ctx.exception.diagnostic["target"], "recipe-nope")


class SequenceStepDiagnosticsTests(unittest.TestCase):
    """序列执行：每条 ERROR 步都能回答「第几步 / 哪一层 / 发没发出去」。"""

    def setUp(self):
        transport.reset()
        sequence_runner.reset()

    def tearDown(self):
        transport.reset()
        sequence_runner.reset()

    def _run(self, steps, config=None):
        run = sequence_runner.claim(
            "seq-diag", "诊断序列", steps,
            config or {"stop_on_error": True, "read_timeout_ms": None},
        )
        sequence_runner.execute(run)
        return sequence_runner.snapshot()

    def test_plan_error_step_carries_diagnostic(self):
        dirty = {"dynamic": [{"op": "TIME_ACCUMULATOR", "offset": 1, "byte_len": 2,
                              "base_time": "not-a-date"}]}
        snap = self._run([_step("s1", b"\xA5\x00\x00", plan=dirty), _step("s2")])
        step = snap["steps"][0]
        self.assertEqual(step["status"], "ERROR")
        self.assertTrue(step["error"].startswith("PLAN:"))        # 文案不变
        self.assertIsNone(step["sent"])                           # 没组出帧 → 没发
        d = step["diagnostic"]
        self.assertEqual(d["stage"], "plan")
        self.assertEqual(d["code"], "PLAN_REJECTED")
        self.assertEqual(d["step"], 1)
        self.assertIs(d["data_sent"], False)
        self.assertEqual(d["target"], "s1")                       # 定位到具体步
        self.assertEqual(snap["steps"][1]["status"], "SKIPPED")

    def test_transport_error_step_sent_hex_but_not_delivered(self):
        set_transport_config({
            "mode": "tcp",
            "tcp": {"host": "127.0.0.1", "port": _closed_local_port(),
                    "connect_timeout_ms": 200, "read_timeout_ms": 100},
        })
        snap = self._run([_step("s1", b"\xA5\x01")])
        step = snap["steps"][0]
        self.assertEqual(step["status"], "ERROR")
        self.assertTrue(step["error"].startswith("TRANSPORT:"))
        self.assertEqual(step["sent"], "A5 01")        # 尝试出线帧（日志/回放用）
        d = step["diagnostic"]
        self.assertEqual((d["stage"], d["code"]), ("transport", "TRANSPORT_ERROR"))
        self.assertIs(d["data_sent"], False)           # 但明确：没送达
        self.assertEqual(d["byte_count"], 2)
        self.assertEqual(d["step"], 1)

    def test_ok_step_has_no_diagnostic_key(self):
        snap = self._run([_step("s1", b"\xA5\x01")])
        self.assertEqual(snap["result"], "completed")
        self.assertNotIn("diagnostic", snap["steps"][0])  # 只有 ERROR 步才有

    def test_wrap_error_forwards_source_diagnostic(self):
        from backend.core.sequence_runner import WrapError, _step_diagnostic

        err = WrapError(
            "第 2 层（壳）：洞位不足",
            {"stage": "wrap", "code": "WRAP_LAYER_REJECT",
             "message": "第 2 层（壳）：洞位不足", "layer": 2, "target": "p-shell"},
        )
        d = _step_diagnostic(err, stage="wrap", code="WRAP_REJECTED",
                             n=3, step={"id": "s3"}, data_sent=False)
        self.assertEqual(d["layer"], 2)            # 来源层号不丢
        self.assertEqual(d["target"], "p-shell")   # 来源定位不丢
        self.assertEqual(d["step"], 3)             # 步号恒补上
        self.assertIs(d["data_sent"], False)

    def test_wrap_error_without_source_gets_fallback(self):
        from backend.core.sequence_runner import WrapError, _step_diagnostic

        d = _step_diagnostic(WrapError("配方被删"), stage="wrap",
                             code="WRAP_REJECTED", n=1,
                             step={"id": "s1"}, data_sent=False)
        self.assertEqual((d["stage"], d["code"]), ("wrap", "WRAP_REJECTED"))
        self.assertEqual(d["message"], "配方被删")
        self.assertEqual(d["step"], 1)


if __name__ == "__main__":
    unittest.main()
