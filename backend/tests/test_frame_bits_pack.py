# -*- coding: utf-8 -*-
"""R73（§8.105）发射期全帧 packBits —— 红测先行（多 sub-byte 块帧 wire 收口）。

R70 §8.102 七 留白 1 的既登记 spec（PLAN:9453）：
 - 发射期 bit 级拼接镜像 `frameBitPack`（块文档 bit 串按序 → ceil 字节 → **尾补零**）；
 - 含 `block_spans` bit 化、align/pad/LITTLE 交互、**双端位真帧向量**红测；
 - pad 落位口径本会话 question 拍板 = **尾补零 = 高对齐（5280/A540 系）**，与设计层
   frameBitPack / 画布展示逐位一致（wire 头补零旧口径 014A/0294 系废止）。

改动面（零 DDL：children JSON 列 + pydantic 字段，refs/bits 透传先例同款）：
 - `ProtocolNodeSchema.bit_len` 透传（此前 pydantic 丢弃 → 协议刷新即失 →
   wire 拿不到真值宽度 → sub-byte 语义无从谈起）；
 - `frame_builder._to_blocks` 映射 `Block.bit_len`；
 - `backend/core/frame_bits.py`（新）纯函数层镜像 FE `frameBitPack.js`；
 - `Orchestrator.process` 发射期位游标（纯字节帧走原值串直出分支 → raw 逐字节
   逐空格不变；`block_spans` 以 bit 计）；
 - `pack_protocol_bits` 声明 `bit_len` extent → 尾补零（hex_value 与 wire 同拍板）。

红测口径 = 13 测：预期 11 红（缺特性）+ 2 绿（纯字节帧护栏：raw 空格分组 /
shell 字节换算）。
"""

import tempfile
import unittest
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core.frame_builder import _collect_shell, _to_blocks
from backend.core.orchestrator import Orchestrator
from backend.db.database import Base
from backend.handlers.bitfield import pack_protocol_bits
from backend.routers.compile import compile_wrapped_frame
from backend.routers.protocol import create_protocol, get_protocol
from backend.schemas.block import Block, BlockConfig, WrappedCompileRequest
from backend.schemas.protocol_api import ProtocolCreate, ProtocolNodeSchema
from vectors.load_vectors import load_vectors

# 双端同读一份：FE frameBitPack.test.js 消费同表（消费矩阵 = test_vectors_manifest）
BIT_TRUE_VECTORS = load_vectors("bit_true_frame")


def bit(name, start, length, default=0):
    return {"bit_name": name, "start_bit": start, "bit_len": length, "default_val": default}


def block(nid, **kw):
    base = dict(
        id=nid, type="fixed", label=nid, byte_length=1, hex_value="00",
        config=None, children=[], is_container=False, is_enabled=True,
        endianness="BIG", repeat_count=1, align=0, pad_to=0, pad_byte=0,
    )
    base.update(kw)
    return Block(**base)


def bf(nid, bit_len, byte_length, segs, **kw):
    """位域块：`bit_len` 顶层声明（R73 透传目标）+ 段列表进 config.params.bits。"""
    return block(
        nid, type="bitfield", bit_len=bit_len, byte_length=byte_length,
        hex_value=None, config=BlockConfig(params={"bits": list(segs)}), **kw
    )


class TestBitTrueFrameVectors(unittest.TestCase):
    """双端位真帧向量：`vectors/bit_true_frame.json` · FE frameBitPack.test.js 同读。

    期望值已由 FE 既有实现实证（R70 frameBitPack.js）—— BE 新层对不上即红。
    """

    def test_vectors_pack_byte_equal(self):
        from backend.core.frame_bits import pack_frame_bit_stream  # R73 新层（红 = 模块缺席）
        for case in BIT_TRUE_VECTORS:
            with self.subTest(case=case["name"]):
                got = pack_frame_bit_stream(case["blocks"])
                self.assertEqual(got["hex"], case["expect"]["hex"])
                self.assertEqual(got["bit_len"], case["expect"]["bitLen"])
                self.assertEqual(got["pad_bits"], case["expect"]["padBits"])
                self.assertEqual(got["bytes"], case["expect"]["bytes"])


class TestBitLenPassthrough(unittest.TestCase):
    """schema 透传 → 翻译层映射（此前 pydantic 丢字段 → 协议刷新即失，refs/bits 先例）。"""

    def test_protocol_node_schema_keeps_bit_len(self):
        n = ProtocolNodeSchema(
            id="bf", label="主导头", type="bitfield", byte_length=2, bit_len=10,
            bits=[bit("VER", 0, 4, 10), bit("FLAG", 4, 6, 20)],
        )
        self.assertEqual(getattr(n, "bit_len", None), 10)

    def test_to_blocks_maps_bit_len(self):
        nodes = [{
            "id": "bf", "label": "主导头", "type": "bitfield", "byte_length": 2,
            "bit_len": 10, "children": [],
            "bits": [bit("VER", 0, 4, 10), bit("FLAG", 4, 6, 20)],
        }]
        blocks = _to_blocks(nodes, {})
        self.assertEqual(getattr(blocks[0], "bit_len", None), 10)


class TestSubByteWire(unittest.TestCase):
    """发射期出线（拍板：尾补零 = 高对齐；旧 wire 头补零口径废止）。"""

    def test_single_subbyte_bitfield_emits_tail_padded_doc_order(self):
        orch = Orchestrator([bf(
            "h", 10, 2, [bit("VER", 0, 4, 10), bit("FLAG", 4, 6, 20)]
        )])
        # 文档串 '0101001010'（10bit = 330）→ 尾补 6 零 → 5280；旧口径头补零 = 014A
        self.assertEqual(orch.process().replace(" ", ""), "5280")

    def test_multisubbyte_blocks_tight_pack(self):
        orch = Orchestrator([
            bf("a", 4, 1, [bit("VER", 0, 4, 10)]),      # '1010'
            bf("b", 6, 1, [bit("FLAG", 0, 6, 21)]),      # '010101'
        ])
        # 紧凑拼接 '1010'+'010101' = 10bit → 尾补 6 零 → A540；旧口径逐块 = A0 15
        self.assertEqual(orch.process().replace(" ", ""), "A540")

    def test_subbyte_header_straddles_next_byte_block(self):
        orch = Orchestrator([
            bf("h", 10, 2, [bit("VER", 0, 4, 10), bit("FLAG", 4, 6, 20)]),
            block("t", byte_length=1, hex_value="ED"),
        ])
        # 10bit 头 + 8bit = 18bit 跨字节：字节边界随位流走（旧口径逐块 = 014A ED）
        self.assertEqual(orch.process().replace(" ", ""), "52BB40")

    def test_align_after_subbyte_pads_to_byte_boundary(self):
        orch = Orchestrator([
            bf("h", 10, 2, [bit("VER", 0, 4, 10), bit("FLAG", 4, 6, 20)]),
            block("t", byte_length=1, hex_value="ED", align=1),
        ])
        # align=1 → 位游标 10 补 6 零到字节边界，内容从字节 2 起（对齐是字节级构造）
        self.assertEqual(orch.process().replace(" ", ""), "5280ED")

    def test_little_endian_subbyte_emits_reversed_byte_window(self):
        orch = Orchestrator([bf(
            "h", 10, 2, [bit("VER", 0, 4, 10), bit("FLAG", 4, 6, 20)],
            endianness="LITTLE",
        )])
        # LITTLE = 字节级语义：块的定宽字节窗（5280）整窗反转 → 8052（不做块内收紧）
        self.assertEqual(orch.process().replace(" ", ""), "8052")

    def test_pack_protocol_bits_tail_pad_with_declared_bit_len(self):
        segs = [bit("VER", 0, 4, 10), bit("FLAG", 4, 6, 20)]
        # 声明 extent=10 → 高对齐尾补零（与 wire/设计层同拍板）
        self.assertEqual(pack_protocol_bits(segs, 2, bit_len=10), "5280")
        # bit_len 缺省 → extent = size*8 → 既有打包口径零漂移（PACK_VECTORS 同源）
        self.assertEqual(pack_protocol_bits([bit("A", 0, 4, 10)], 1), "0A")


class TestSpansAndShell(unittest.TestCase):
    """`block_spans` bit 化（R70 留白 spec 明文）+ 消费方字节换算护栏。"""

    def test_block_spans_in_bits(self):
        orch = Orchestrator([
            block("a1", byte_length=2, hex_value="FA FA"),
            block("a3", byte_length=1, hex_value="AA"),
        ])
        orch.process()
        self.assertEqual(orch.block_spans, {"a1": [(0, 16)], "a3": [(16, 24)]})

    def test_byte_frame_raw_spacing_unchanged(self):
        """绿护栏：纯字节帧 raw 空格分组逐字节不变（R27 基线口径，R73 零触碰）。"""
        orch = Orchestrator([
            block("a1", byte_length=2, hex_value="FA FA"),
            block("a2", byte_length=1, hex_value="ED", is_enabled=False),
            block("a3", byte_length=1, hex_value="AA"),
        ])
        self.assertEqual(orch.process(), "FA FA AA")

    def test_shell_offsets_stay_byte_values(self):
        """绿护栏：spans bit 化后 `_collect_shell` 仍输出**字节**区间（纯字节帧
        换算零漂移 → 载荷注入点 / LEN·CRC 字段位置 / 配方平移口径不变）。"""
        blocks = [
            block("h", byte_length=2, hex_value="FA FA"),
            block("p", byte_length=2, hex_value="01 02"),
            block("l", type="length", hex_value="00",
                  config=BlockConfig(params={"refs": ["h", "p"]})),
            block("c", type="checksum", byte_length=2, hex_value="0000",
                  config=BlockConfig(params={"refs": ["h", "p"], "algorithm": "sum"})),
        ]
        orch = Orchestrator(blocks)
        orch.process()
        shell = _collect_shell(blocks, orch.block_spans)
        self.assertEqual(shell["length"], [{"offset": 4, "byte_length": 1}])
        self.assertEqual(shell["checksum"], [{"offset": 5, "byte_length": 2}])
        self.assertIsNone(shell["payload_offset"])


class TestBitLenEndToEnd(unittest.TestCase):
    """闭环：POST /protocols（落库 bit_len）→ GET 回读 → /compile/wrapped 紧凑出帧。

    直调路由函数（显式 Session，无 TestClient）—— 对齐 test_protocol_bitfield 范式。
    锁「schema 透传 → JSON 列持久化 → 发射期位流」三段不断链。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp.name) / "test_r73.db"
        self.engine = create_engine(
            f"sqlite:///{db_path.as_posix()}", connect_args={"check_same_thread": False}
        )
        Base.metadata.create_all(bind=self.engine)
        self.db = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def test_save_readback_compiles_tight_frame(self):
        payload = ProtocolCreate(
            id="proto-r73",
            label="位真帧协议",
            children=[
                ProtocolNodeSchema(
                    id="h", label="首", type="fixed", byte_length=1, hex_value="AA",
                ),
                ProtocolNodeSchema(
                    id="bf", label="主导头", type="bitfield", byte_length=2, bit_len=10,
                    bits=[bit("VER", 0, 4, 10), bit("FLAG", 4, 6, 20)],
                ),
                ProtocolNodeSchema(
                    id="s", label="槽", type="slot", byte_length=0,
                ),
            ],
        )
        create_protocol(payload, db=self.db)

        fetched = get_protocol("proto-r73", db=self.db)
        bf_node = next(n for n in fetched.children if n["id"] == "bf")
        self.assertEqual(bf_node.get("bit_len"), 10)  # 回读不丢（红 = schema 丢字段）

        resp = compile_wrapped_frame(
            WrappedCompileRequest(protocol_id="proto-r73", payloads=["01 02"]),
            db=self.db,
        )
        # wire = AA(8) + 头(10) + 载荷(16) = 34bit → 尾补零 → 5 字节紧凑出线
        # （旧口径逐块 = AA 014A 01 02 = 6 字节）
        self.assertEqual(resp.hex_string, "AA 52 80 40 80")
        self.assertEqual(resp.total_length, 5)


if __name__ == "__main__":
    unittest.main()
