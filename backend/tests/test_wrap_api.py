"""批次一 1c: /compile/wrapped + dispatch/transaction wrap 接线单测。

直调路由函数（显式 Session，无 TestClient）—— 对齐 test_dispatch_transaction /
test_bindings 范式。覆盖：compile 端点 happy/404/400（显式槽悬空、非法载荷）、
loopback 单发 wrap、事务 wrap、稠密 slot_order、非 wrap 路径逐字节不回归
（§0 硬约束：/dispatch 缺省裸帧行为不变）。
三处同值主向量 FA FA 02 01 02 ED 的单一真相源 = vectors/wrap.json · 表 main
（CP2b / D11-①）：本文件 / test_frame_builder.py / blockMerge.test.js 同读这一份。
"""

import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core import transport
from backend.db.database import Base
from backend.db.models import ProtocolTemplate
from backend.routers import dispatch as dispatch_mod
from backend.routers.compile import compile_wrapped_frame
from backend.routers.dispatch import (
    DispatchRequest,
    TransactionRequest,
    WrapSpec,
    dispatch_frame,
    dispatch_transaction,
)
from backend.schemas.block import WrappedCompileRequest
from vectors.load_vectors import load_vectors

# 主共享向量协议（CP2b / D11-① 单一真相源 = vectors/wrap.json · 表 main，与
# test_frame_builder.SharedVectorTest / blockMerge.test.js 三处同读一份）：
# h "FA FA" / l refs[s] / slot s / t "ED"，载荷 0102 → VECTOR_HEX。
PROTO_ID = "proto-vector"
_MAIN = load_vectors("wrap", "main")
VECTOR_CHILDREN = _MAIN["children"]
VECTOR_HEX = _MAIN["expect"]["hex"]

# 双槽协议：显式 slot_id 与稠密 slot_order 位次语义用。
PROTO_2SLOT = "proto-2slot"
TWO_SLOT_CHILDREN = [
    {"id": "s1", "label": "s1", "type": "slot", "byte_length": 0,
     "hex_value": None, "config": {}, "children": []},
    {"id": "m", "label": "m", "type": "fixed", "byte_length": 1,
     "hex_value": "CC", "config": {}, "children": []},
    {"id": "s2", "label": "s2", "type": "slot", "byte_length": 0,
     "hex_value": None, "config": {}, "children": []},
]


class WrapApiTestBase(unittest.TestCase):
    def setUp(self):
        transport.reset()  # 默认 loopback；reset 同时清钩子，不泄漏给其他模块
        dispatch_mod._history.clear()
        self.tmp = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp.name) / "test_wrap.db"
        self.engine = create_engine(
            f"sqlite:///{db_path.as_posix()}",
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(
            autocommit=False, autoflush=False, bind=self.engine
        )
        self.db = self.session_factory()
        self.db.add(ProtocolTemplate(
            id=PROTO_ID, label="向量协议", type="container",
            children=VECTOR_CHILDREN,
        ))
        self.db.add(ProtocolTemplate(
            id=PROTO_2SLOT, label="双槽协议", type="container",
            children=TWO_SLOT_CHILDREN,
        ))
        self.db.commit()

    def tearDown(self):
        transport.reset()
        dispatch_mod._history.clear()
        # Windows: 先关会话再 dispose 连接池，否则文件被占用无法删除（WinError 32）
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()


class CompileWrappedEndpointTests(WrapApiTestBase):
    """POST /compile/wrapped：协议 404 / 语义 400 / 主向量回执。"""

    def test_happy_path_shared_vector(self):
        resp = compile_wrapped_frame(
            WrappedCompileRequest(protocol_id=PROTO_ID, payloads=["0102"]),
            db=self.db,
        )
        self.assertEqual(resp.hex_string, VECTOR_HEX)
        self.assertEqual(resp.total_length, 6)
        self.assertEqual(resp.warnings, [])

    def test_explicit_slot_and_dense_slot_order(self):
        explicit = compile_wrapped_frame(
            WrappedCompileRequest(protocol_id=PROTO_2SLOT, payloads=["0102"],
                                  slot_ids=["s1"]),
            db=self.db,
        )
        self.assertEqual(explicit.hex_string, "01 02 CC")

        dense = compile_wrapped_frame(
            WrappedCompileRequest(protocol_id=PROTO_2SLOT, payloads=["0102"],
                                  start_order=1),
            db=self.db,
        )
        self.assertEqual(dense.hex_string, "CC 01 02")
        self.assertEqual(dense.warnings, ["空洞：1 个洞未被载荷填充"])

    def test_underflow_warning_travels_to_response(self):
        resp = compile_wrapped_frame(
            WrappedCompileRequest(protocol_id=PROTO_ID, payloads=[]),
            db=self.db,
        )
        self.assertEqual(resp.hex_string, "FA FA 00 ED")
        self.assertEqual(resp.warnings, ["空洞：1 个洞未被载荷填充"])

    def test_protocol_not_found_404(self):
        with self.assertRaises(HTTPException) as ctx:
            compile_wrapped_frame(
                WrappedCompileRequest(protocol_id="nope", payloads=["0102"]),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.detail, "Protocol not found")

    def test_invalid_payload_400(self):
        with self.assertRaises(HTTPException) as ctx:
            compile_wrapped_frame(
                WrappedCompileRequest(protocol_id=PROTO_ID, payloads=["GG"]),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("非法 hex 载荷", str(ctx.exception.detail))

    def test_dangling_explicit_slot_400(self):
        with self.assertRaises(HTTPException) as ctx:
            compile_wrapped_frame(
                WrappedCompileRequest(protocol_id=PROTO_ID, payloads=["0102"],
                                      slot_ids=["ghost"]),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("插槽不存在", str(ctx.exception.detail))


class DispatchWrapTests(WrapApiTestBase):
    """POST /dispatch：wrap 单发（loopback 回显）与裸帧不回归。"""

    def test_loopback_single_frame_wrapped(self):
        record = dispatch_frame(
            DispatchRequest(hex_string="0102", instruction_name="开门",
                            wrap=WrapSpec(protocol_id=PROTO_ID)),
            db=self.db,
        )
        self.assertEqual(record.status, "SENT")
        self.assertEqual(record.channel, "LOOPBACK")
        self.assertEqual(record.hex_string, VECTOR_HEX)
        self.assertEqual(record.byte_count, 6)
        self.assertEqual(record.echo, "FAFA020102ED")
        self.assertEqual(record.instruction_name, "开门")

    def test_loopback_explicit_slot_wrapped(self):
        record = dispatch_frame(
            DispatchRequest(hex_string="0102",
                            wrap=WrapSpec(protocol_id=PROTO_2SLOT, slot_id="s1")),
            db=self.db,
        )
        self.assertEqual(record.hex_string, "01 02 CC")

    def test_loopback_dense_slot_order_wrapped(self):
        record = dispatch_frame(
            DispatchRequest(hex_string="0102",
                            wrap=WrapSpec(protocol_id=PROTO_2SLOT, slot_order=1)),
            db=self.db,
        )
        self.assertEqual(record.hex_string, "CC 01 02")

    def test_wrap_slot_id_beats_slot_order(self):
        record = dispatch_frame(
            DispatchRequest(hex_string="0102",
                            wrap=WrapSpec(protocol_id=PROTO_2SLOT,
                                          slot_id="s1", slot_order=1)),
            db=self.db,
        )
        self.assertEqual(record.hex_string, "01 02 CC")

    def test_wrap_protocol_not_found_404(self):
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(
                DispatchRequest(hex_string="0102",
                                wrap=WrapSpec(protocol_id="nope")),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.detail, "Protocol not found")

    def test_wrap_bad_slot_400(self):
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(
                DispatchRequest(hex_string="0102",
                                wrap=WrapSpec(protocol_id=PROTO_ID,
                                              slot_id="ghost")),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("插槽不存在", str(ctx.exception.detail))

    def test_wrap_invalid_kernel_payload_400(self):
        # wrap 路径：载荷 hex 由 build_wrapped 规范化校验（先于 hex_to_bytes 终检）
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(
                DispatchRequest(hex_string="GG",
                                wrap=WrapSpec(protocol_id=PROTO_ID)),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("非法 hex 载荷", str(ctx.exception.detail))

    def test_non_wrap_bare_frame_unchanged(self):
        # §0 硬约束: /dispatch 缺省裸帧行为逐字节不变
        record = dispatch_frame(DispatchRequest(hex_string="AA 55 01"), db=self.db)
        self.assertEqual(record.status, "SENT")
        self.assertEqual(record.hex_string, "AA 55 01")
        self.assertEqual(record.byte_count, 3)
        self.assertEqual(record.echo, "AA5501")

    def test_non_wrap_invalid_hex_unchanged_400(self):
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(DispatchRequest(hex_string="not hex"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("Invalid payload", str(ctx.exception.detail))


class TransactionWrapTests(WrapApiTestBase):
    """POST /dispatch/transaction：wrap 事务（loopback 单发成功）与裸帧不回归。"""

    def test_loopback_transaction_wrapped(self):
        record = dispatch_transaction(
            TransactionRequest(hex_string="0102", instruction_name="开门",
                               wrap=WrapSpec(protocol_id=PROTO_ID)),
            db=self.db,
        )
        self.assertEqual(record.status, "OK")
        self.assertEqual(record.channel, "LOOPBACK")
        self.assertEqual(record.hex_string, VECTOR_HEX)
        self.assertEqual(record.byte_count, 6)
        self.assertEqual(record.attempts[0].sent, VECTOR_HEX)
        self.assertEqual(record.attempts[0].received, VECTOR_HEX)
        self.assertEqual(record.echo, "FAFA020102ED")

        # 历史口径: 事务按 SENT + raw/response 入栈，hex 为封装后帧
        top = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(top.status, "SENT")
        self.assertEqual(top.hex_string, VECTOR_HEX)

    def test_transaction_wrap_404(self):
        with self.assertRaises(HTTPException) as ctx:
            dispatch_transaction(
                TransactionRequest(hex_string="0102",
                                   wrap=WrapSpec(protocol_id="nope")),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 404)

    def test_non_transaction_bare_unchanged(self):
        record = dispatch_transaction(
            TransactionRequest(hex_string="AA 55 01"), db=self.db
        )
        self.assertEqual(record.status, "OK")
        self.assertEqual(record.hex_string, "AA 55 01")
        self.assertEqual(record.echo, "AA5501")


class MultiPayloadDispatchTests(WrapApiTestBase):
    """批次二 (D14③ 转义层位统一): 编排页「封装试发」改带 wrap 下发。

    试发此前是「先 /compile/wrapped 套完壳 → 再裸发」，escape 开启时会把**整帧**
    当内核转义；本组钉死新口径 = 与单条路径同一条层位规则：逐条内核先转义、再套壳，
    且产物与 /compile/wrapped 逐字节一致。
    """

    def test_multi_payload_byte_equal_with_compile(self):
        compiled = compile_wrapped_frame(
            WrappedCompileRequest(protocol_id=PROTO_2SLOT, payloads=["0102", "0304"]),
            db=self.db,
        )
        record = dispatch_frame(
            DispatchRequest(
                instruction_name="封装试发",
                wrap=WrapSpec(protocol_id=PROTO_2SLOT, payloads=["0102", "0304"]),
            ),
            db=self.db,
        )
        self.assertEqual(record.status, "SENT")
        self.assertEqual(record.hex_string, compiled.hex_string)
        self.assertEqual(record.byte_count, compiled.total_length)
        # 稠密位次：s1 → 0102、中间 fixed CC、s2 → 0304
        self.assertEqual(record.hex_string, "01 02 CC 03 04")

    def test_hex_string_omitted_is_allowed(self):
        record = dispatch_frame(
            DispatchRequest(
                wrap=WrapSpec(protocol_id=PROTO_2SLOT, payloads=["0102"], slot_ids=["s2"])
            ),
            db=self.db,
        )
        self.assertEqual(record.hex_string, "CC 01 02")

    def test_neither_hex_string_nor_payloads_400(self):
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(DispatchRequest(instruction_name="空"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("至少提供一个", ctx.exception.detail)
        self.assertEqual(dispatch_mod.dispatch_history(limit=1), [])

    def test_warnings_surface_on_record(self):
        # PROTO_ID 单槽 → 第二条载荷无槽可用：缺省 append + warning（不阻断）
        record = dispatch_frame(
            DispatchRequest(
                wrap=WrapSpec(protocol_id=PROTO_ID, payloads=["0102", "0304"])
            ),
            db=self.db,
        )
        self.assertEqual(record.status, "SENT")
        self.assertTrue(any("洞位不足" in w for w in record.warnings))

    def test_reject_blocks_send_with_400(self):
        self.db.add(ProtocolTemplate(
            id="proto-reject", label="拒溢协议", type="container",
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
                DispatchRequest(
                    wrap=WrapSpec(protocol_id="proto-reject", payloads=["0102", "0304"])
                ),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("洞位不足", ctx.exception.detail)
        self.assertEqual(dispatch_mod.dispatch_history(limit=1), [])

    def test_bare_frame_path_unchanged(self):
        # §0 硬约束：缺省裸帧逐字节不变（本批只动带 wrap 的新分支）
        record = dispatch_frame(DispatchRequest(hex_string="AA 7D 01"), db=self.db)
        self.assertEqual(record.hex_string, "AA 7D 01")
        self.assertEqual(record.warnings, [])


if __name__ == "__main__":
    unittest.main()
