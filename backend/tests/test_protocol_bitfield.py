"""批 4：协议结构化位域（bitfield 块）—— 入库校验 + 编码打包。

与指令侧 BITFIELD 同口径（LSB 位偏移、定宽大端 hex），改一必改二：
打包向量锚定在 frontend/src/utils/__tests__/bitGrid.test.js 的
packBits 镜像组（同一批向量逐行对照）。

三层契约：
1. schema：ProtocolNodeSchema 透传 bits（此前被 pydantic 静默丢弃 → 刷新即失）
2. 入库：_validate_bits 拦重叠/超容量（镜像 routers.instruction._validate_bitfields）
3. 编码：frame_builder 透传 → Orchestrator 发射期单点打包（封装/导出两路共用）
"""

import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base
from backend.schemas.block import WrappedCompileRequest
from backend.schemas.protocol_api import ProtocolCreate, ProtocolNodeSchema, ProtocolUpdate
from backend.core import transport
from backend.core.frame_builder import build_wrapped, _to_blocks
from backend.handlers.bitfield import pack_protocol_bits
from backend.routers import dispatch as dispatch_mod
from backend.routers.compile import compile_wrapped_frame
from backend.routers.dispatch import DispatchRequest, dispatch_frame
from backend.routers.protocol import (
    _validate_bits,
    create_protocol,
    get_protocol,
    update_protocol,
)


def bit(name, start, length, default=0):
    return {"bit_name": name, "start_bit": start, "bit_len": length, "default_val": default}


def node(node_id, **kw):
    base = {"id": node_id, "label": node_id, "type": "bitfield", "byte_length": 1, "children": []}
    base.update(kw)
    return base


def pnode(node_id="bf", **kw):
    """校验层走真实调用路径：routers.protocol._validate_bits 收的是
    payload.children（Pydantic 节点），与 _validate_refs 同约定。"""
    return ProtocolNodeSchema(**node(node_id, **kw))


# 与前端 bitGrid.test.js / packBits 同批向量
# (start, len, default) 列表, byteLen, 期望**线上** hex（build_wrapped 按字节加空格）
PACK_VECTORS = [
    ([(0, 4, 5), (4, 4, 10)], 1, "A5"),
    ([(0, 8, 0xFF)], 1, "FF"),
    ([(8, 8, 0x12)], 2, "12 00"),
    ([(0, 16, 0x1234)], 2, "12 34"),
    ([(4, 12, 0xABC)], 2, "AB C0"),
    ([], 1, "00"),
    ([(0, 40, 1)], 8, "00 00 00 00 00 00 00 01"),
]


class TestProtocolBitfieldSchema(unittest.TestCase):
    def test_bits_round_trip(self):
        """bits 透传：此前 pydantic 丢弃未知键 → 协议位域刷新后即失。"""
        n = ProtocolNodeSchema(
            id="bf", label="控制", type="bitfield", byte_length=1,
            bits=[bit("MODE", 0, 2, 1), bit("EN", 2, 1, 1)],
        )
        self.assertEqual(len(n.bits), 2)
        self.assertEqual(n.bits[0].bit_name, "MODE")
        self.assertEqual(n.bits[1].start_bit, 2)

    def test_bits_optional_defaults_empty(self):
        n = ProtocolNodeSchema(id="fx", label="固定", type="fixed", byte_length=1)
        self.assertEqual(n.bits, [])

    def test_rejects_bad_bits_shape(self):
        with self.assertRaises(ValidationError):
            ProtocolNodeSchema(id="bf", label="x", type="bitfield", bits="nope")


class TestProtocolBitfieldValidation(unittest.TestCase):
    def test_overlap_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            _validate_bits([pnode(bits=[bit("A", 0, 4), bit("B", 2, 4)])])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("重叠", ctx.exception.detail)

    def test_capacity_overflow_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            _validate_bits([pnode(byte_length=1, bits=[bit("W", 0, 9)])])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("超出容量", ctx.exception.detail)

    def test_adjacent_and_exact_fit_ok(self):
        _validate_bits([pnode(bits=[bit("A", 0, 4), bit("B", 4, 4)])])
        _validate_bits([pnode(bits=[bit("A", 0, 8)])])

    def test_no_bits_ok_and_non_bitfield_ignored(self):
        _validate_bits([pnode(bits=[])])
        # 存量 fixed 节点即便残留 bits 也不拦（口径仅对 bitfield 块生效）
        _validate_bits([pnode("fx", type="fixed", bits=[bit("A", 0, 4), bit("B", 2, 4)])])

    def test_walks_nested_children(self):
        tree = [pnode("root", type="container", byte_length=0, children=[
            pnode(bits=[bit("A", 0, 4), bit("B", 3, 4)]),
        ])]
        with self.assertRaises(HTTPException):
            _validate_bits(tree)

    def test_missing_start_len_defaults(self):
        """缺省 start_bit/len 按 0/1 处理（不 500、不误判重叠）"""
        _validate_bits([pnode(bits=[{"bit_name": "A"}, {"bit_name": "B", "start_bit": 4}])])


class TestProtocolBitfieldEncoding(unittest.TestCase):
    def test_pack_vectors_byte_equal(self):
        for segs, byte_len, expect in PACK_VECTORS:
            with self.subTest(byteLen=byte_len, expect=expect):
                result = build_wrapped(
                    [node("bf", byte_length=byte_len, bits=[bit(f"S{i}", s, l, d) for i, (s, l, d) in enumerate(segs)])],
                    [""],
                    slot_ids=[],
                )
                self.assertEqual(result["hex"], expect)
                self.assertEqual(result["total_length"], byte_len)

    def test_to_blocks_translates_bits_into_config(self):
        blocks = _to_blocks([node("bf", byte_length=1, bits=[bit("MODE", 0, 2, 1)])], {})
        self.assertEqual(len(blocks), 1)
        blk = blocks[0]
        self.assertEqual(blk.type, "bitfield")
        self.assertFalse(blk.is_container)
        params = (blk.config.params if blk.config else None) or {}
        self.assertEqual(len(params.get("bits", [])), 1)
        self.assertEqual(params["bits"][0]["bit_name"], "MODE")

    def test_mixed_frame_with_slot(self):
        """混合帧：fixed + bitfield + slot 位序正确（改一必改三：与 FE blockMerge 共享向量）。"""
        tree = [
            {"id": "h", "label": "头", "type": "fixed", "byte_length": 1, "hex_value": "AA", "children": []},
            node("bf", byte_length=1, bits=[bit("MODE", 0, 2, 1), bit("EN", 2, 1, 1)]),  # 0x05
            {"id": "s", "label": "槽", "type": "slot", "byte_length": 0, "children": []},
        ]
        result = build_wrapped(tree, ["01 02"])
        self.assertEqual(result["hex"], "AA 05 01 02")
        self.assertEqual(result["total_length"], 4)

    def test_slotless_frame_regression(self):
        """存量帧 byte-equal 回归：无 bitfield 时输出与既有行为逐字节一致。"""
        tree = [
            {"id": "h", "label": "头", "type": "fixed", "byte_length": 1, "hex_value": "AA", "children": []},
            {"id": "f", "label": "固", "type": "fixed", "byte_length": 1, "hex_value": "DE", "children": []},
        ]
        result = build_wrapped(tree, [""], slot_ids=[])
        self.assertEqual(result["hex"], "AA DE")

    def test_empty_bits_emits_zero_fill(self):
        result = build_wrapped([node("bf", byte_length=2, bits=[])], [""], slot_ids=[])
        self.assertEqual(result["hex"], "00 00")

    def test_capacity_exceeding_byte_length_pads_from_low_bits(self):
        """超容量的位段在编码期截到块长（入库已拦 400，此处是脏库兜底）。"""
        result = build_wrapped([node("bf", byte_length=1, bits=[bit("W", 0, 12, 0xABC)])], [""], slot_ids=[])
        self.assertEqual(result["hex"], "BC")  # 低 8 位


class TestProtocolBitfieldEndToEnd(unittest.TestCase):
    """闭环：POST /protocols（落库 bits）→ GET 回读 → /compile/wrapped 出帧。

    直调路由函数（显式 Session，无 TestClient）—— 对齐 test_wrap_api 范式。
    这条锁住「schema 透传 → JSON 列持久化 → 封装打包」三段不断链。
    """

    def setUp(self):
        transport.reset()  # 裸发回归用例用默认 loopback
        dispatch_mod._history.clear()
        self.tmp = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp.name) / "test_bf_e2e.db"
        self.engine = create_engine(
            f"sqlite:///{db_path.as_posix()}", connect_args={"check_same_thread": False}
        )
        Base.metadata.create_all(bind=self.engine)
        self.db = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)()

    def tearDown(self):
        transport.reset()
        dispatch_mod._history.clear()
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _save(self, bits, byte_length=1):
        payload = ProtocolCreate(
            id="proto-bf",
            label="位域协议",
            children=[ProtocolNodeSchema(
                id="h", label="头", type="fixed", byte_length=1, hex_value="AA",
            ), ProtocolNodeSchema(
                id="bf", label="控制", type="bitfield", byte_length=byte_length, bits=bits,
            ), ProtocolNodeSchema(
                id="s", label="槽", type="slot", byte_length=0,
            )],
        )
        created = create_protocol(payload, db=self.db)
        return created

    def test_save_readback_wrap_roundtrip(self):
        created = self._save([bit("MODE", 0, 2, 1), bit("EN", 2, 1, 1)])  # 0x05
        self.assertEqual(created.id, "proto-bf")

        # 回读：bits 必须还在（此前 pydantic 丢弃 → 刷新即失）。
        # 注意回读走 JSON 列 → children 是 dict 树（与 ProtocolTemplate.children 一致）。
        fetched = get_protocol("proto-bf", db=self.db)
        bf = next(n for n in fetched.children if n["id"] == "bf")
        self.assertEqual([b["bit_name"] for b in bf["bits"]], ["MODE", "EN"])

        # 封装出帧：AA + 05(位域打包) + 载荷
        resp = compile_wrapped_frame(
            WrappedCompileRequest(protocol_id="proto-bf", payloads=["01 02"]), db=self.db
        )
        self.assertEqual(resp.hex_string, "AA 05 01 02")
        self.assertEqual(resp.total_length, 4)

    def test_save_rejects_overlap_400(self):
        with self.assertRaises(HTTPException) as ctx:
            self._save([bit("A", 0, 4), bit("B", 2, 4)])
        self.assertEqual(ctx.exception.status_code, 400)

    def test_update_rejects_capacity_400_and_keeps_row(self):
        created = self._save([bit("MODE", 0, 2, 1)])
        with self.assertRaises(HTTPException) as ctx:
            update_protocol(
                "proto-bf",
                ProtocolUpdate(
                    label="位域协议",
                    version=created.version,
                    children=[ProtocolNodeSchema(
                        id="bf", label="控制", type="bitfield", byte_length=1,
                        bits=[bit("W", 0, 9)],
                    )],
                ),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 400)
        # 被拒的行未被覆盖（落库前置校验语义）
        self.assertEqual(len(get_protocol("proto-bf", db=self.db).children), 3)

    def test_bare_dispatch_untouched(self):
        """§0 硬约束：无 wrap 的裸发路径逐字节不回归（协议新增块型零影响）。"""
        resp = dispatch_frame(
            DispatchRequest(hex_string="DE AD BE EF", target="loopback"), db=self.db
        )
        self.assertEqual(resp.hex_string, "DE AD BE EF")
