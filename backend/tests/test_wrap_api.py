"""批次一 1c: /compile/wrapped + dispatch/transaction wrap 接线单测。

直调路由函数（显式 Session，无 TestClient）—— 对齐 test_dispatch_transaction /
test_bindings 范式。覆盖：compile 端点 happy/404/400（显式槽悬空、非法载荷）、
loopback 单发 wrap、事务 wrap、稠密 slot_order、非 wrap 路径逐字节不回归
（§0 硬约束：/dispatch 缺省裸帧行为不变）。
双端向量纪律：主向量 FA FA 02 01 02 ED 与 test_frame_builder /
frontend/src/utils/__tests__/blockMerge.test.js 同字节，改一必改三。
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

# 主共享向量协议（与 test_frame_builder.SharedVectorTest 同构）：
# h "FA FA" / l refs[s] / slot s / t "ED"，载荷 0102 → "FA FA 02 01 02 ED"。
PROTO_ID = "proto-vector"
VECTOR_CHILDREN = [
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
        self.assertEqual(resp.hex_string, "FA FA 02 01 02 ED")
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
        self.assertEqual(record.hex_string, "FA FA 02 01 02 ED")
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
        self.assertEqual(record.hex_string, "FA FA 02 01 02 ED")
        self.assertEqual(record.byte_count, 6)
        self.assertEqual(record.attempts[0].sent, "FA FA 02 01 02 ED")
        self.assertEqual(record.attempts[0].received, "FA FA 02 01 02 ED")
        self.assertEqual(record.echo, "FAFA020102ED")

        # 历史口径: 事务按 SENT + raw/response 入栈，hex 为封装后帧
        top = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(top.status, "SENT")
        self.assertEqual(top.hex_string, "FA FA 02 01 02 ED")

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


if __name__ == "__main__":
    unittest.main()
