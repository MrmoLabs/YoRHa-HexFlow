# -*- coding: utf-8 -*-
"""R27（§8.52 排期 · varint / COBS **出线**）：变长长度前缀与定界编码 —— **只编码、不解包**。

- 共享向量 `vectors/framing.json`（`varint` 14 · `cobs` 16 · `frame` 5）双端同读；
  `cobs` 期望值另由本文件自带的**规范解码器**（与实现零共享代码）往返复核 ——
  防「期望值 = 实现自证」，这是 R27 能落字节级承诺的根据。
- 缺省口径（§0）：`length` 卡不配 `encoding`、协议树里没有 `cobs` 节点 → 逐字节
  不变（钉子在 `test_framing_baseline.py`，本文件是新能力的正向面）。
- 解码不在本批：`cobs_decode` 属 R28，生产代码里**不得**出现 —— 由
  `test_module_is_encode_only` 字面钉住。
"""

import unittest

from backend.core import framing
from backend.core.frame_builder import build_wrapped
from backend.core.orchestrator import Orchestrator
from backend.handlers.length import LengthHandler, encoding_of
from backend.schemas.block import Block, BlockConfig
from vectors.load_vectors import load_vectors

VEC_VARINT = load_vectors("framing", "varint")
VEC_COBS = load_vectors("framing", "cobs")
VEC_FRAME = load_vectors("framing", "frame")


def _compact(hex_str: str) -> str:
    """发射期输出是按块拼的 pretty hex（块内可能自带空格）→ 紧凑口径比对。"""
    return "".join(str(hex_str).split())


def block(nid, **kw):
    base = dict(
        id=nid, type="fixed", label=nid, byte_length=1, hex_value="00",
        config=None, children=[], is_container=False, is_enabled=True,
        endianness="BIG", repeat_count=1, align=0, pad_to=0, pad_byte=0,
    )
    base.update(kw)
    return Block(**base)


def cobs_decode_ref(data: bytes) -> bytes:
    """规范解码（与 `framing.cobs_encode` 零共享代码，纯复核用）。

    码 - 1 = 字面量数；**非末块且码 != 0xFF** → 补回一个 0x00（满块闭合的
    FF 块后面没有被替换的零，故单列特殊）。
    """
    out = bytearray()
    i, n = 0, len(data)
    if n == 0:
        raise ValueError("empty stream")
    while i < n:
        code = data[i]
        if code == 0:
            raise ValueError("code byte is zero")
        i += 1
        take = code - 1
        if i + take > n:
            raise ValueError("truncated")
        out += data[i:i + take]
        i += take
        if code != 0xFF and i < n:
            out.append(0)
    return bytes(out)


class VarintVectorTest(unittest.TestCase):
    """`vectors/framing.json::varint` —— LEB128 最小无符号（双端同读）。"""

    def test_encode_matches_vectors(self):
        for row in VEC_VARINT:
            with self.subTest(v=row["v"]):
                self.assertEqual(framing.encode_varint(row["v"]), row["hex"])

    def test_width_matches_vector_hex(self):
        for row in VEC_VARINT:
            with self.subTest(v=row["v"]):
                self.assertEqual(
                    framing.varint_width(row["v"]), len(row["hex"]) // 2
                )

    def test_boundary_semantics(self):
        # 位宽拐点：7/14/21/28 位各差一就多一个字节
        self.assertEqual(framing.encode_varint(127), "7F")
        self.assertEqual(framing.encode_varint(128), "8001")
        self.assertEqual(framing.encode_varint(16383), "FF7F")
        self.assertEqual(framing.encode_varint(16384), "808001")

    def test_out_of_domain_rejected(self):
        with self.assertRaises(ValueError):
            framing.encode_varint(-1)
        with self.assertRaises(ValueError):
            framing.encode_varint(framing.VARINT_MAX + 1)
        with self.assertRaises(ValueError):
            framing.encode_varint(1.5)


class EncodingOfFailOpenTest(unittest.TestCase):
    """`encoding` 缺失 / 非法 → `fixed`（镜像 `byte_order_of` 的缺省口径）。"""

    def _params(self, **kw):
        return BlockConfig(params=kw)

    def test_absent_is_fixed(self):
        self.assertEqual(framing.normalize_encoding(None), "fixed")
        self.assertEqual(framing.normalize_encoding({}), "fixed")
        self.assertEqual(framing.normalize_encoding(self._params().params), "fixed")

    def test_varint_recognized(self):
        self.assertEqual(
            framing.normalize_encoding({"encoding": "varint"}), "varint"
        )
        self.assertEqual(
            framing.normalize_encoding({"encoding": " VARINT "}), "varint"
        )

    def test_bogus_is_fixed(self):
        self.assertEqual(framing.normalize_encoding({"encoding": "leb"}), "fixed")
        self.assertEqual(framing.normalize_encoding({"encoding": 7}), "fixed")

    def test_handler_path_reads_block_config(self):
        blk = block("l", type="length",
                    config=BlockConfig(params={"refs": [], "encoding": "varint"}))
        self.assertEqual(encoding_of(blk), "varint")
        self.assertEqual(encoding_of(block("x", type="length")), "fixed")


class CobsVectorTest(unittest.TestCase):
    """`vectors/framing.json::cobs` —— 标准 COBS + 定界（含满块边界行）。"""

    def test_encode_matches_vectors(self):
        for row in VEC_COBS:
            with self.subTest(data=row["in"][:32], term=row["term"]):
                got = framing.encode_cobs_hex(
                    row["in"], {"terminator": row["term"]}
                )
                self.assertEqual(got, row["out"])

    def test_round_trip_via_reference_decoder(self):
        """独立规范解码器往返 —— 编码不可逆 / 自造形态都会在这现形。"""
        for row in VEC_COBS:
            with self.subTest(data=row["in"][:32]):
                raw = bytes.fromhex(row["in"])
                self.assertEqual(cobs_decode_ref(framing.cobs_encode(raw)), raw)

    def test_zero_absent_from_cobs_payload(self):
        """COBS 的存在理由：编码段内不含 0x00（定界字节除外）。"""
        for row in VEC_COBS:
            body = row["out"][:-2] if row["term"] == "00" else row["out"]
            with self.subTest(data=row["in"][:32]):
                self.assertNotIn("00", body.upper())

    def test_terminator_fail_open(self):
        self.assertEqual(framing.terminator_of(None), b"\x00")
        self.assertEqual(framing.terminator_of({}), b"\x00")
        self.assertEqual(framing.terminator_of({"terminator": "none"}), b"")
        self.assertEqual(framing.terminator_of({"terminator": "junk"}), b"\x00")

    def test_encode_only_module(self):
        """「R27 只做编码、不碰解包」的字面钉子：生产模块不得出现解码入口。"""
        self.assertEqual(
            [n for n in dir(framing) if "decode" in n.lower()], []
        )


class LengthVarintHandlerTest(unittest.TestCase):
    """LengthHandler 的 varint 出线 + 实际宽度回写（后续计数同源）。"""

    def _forest(self, encoding=None, byte_order=None):
        params = {"refs": ["p"], "offset": 200}
        if encoding:
            params["encoding"] = encoding
        if byte_order:
            params["byte_order"] = byte_order
        return [
            block("h", byte_length=2, hex_value="FA FA"),
            block("l", type="length", byte_length=1, hex_value="00",
                  config=BlockConfig(params=params)),
            block("p", byte_length=1, hex_value="07"),
        ]

    def test_varint_emits_two_bytes_and_writes_back_width(self):
        forest = self._forest(encoding="varint")
        flat = [("global", b) for b in forest]
        hex_str = LengthHandler().calculate(forest[1], flat)
        self.assertEqual(hex_str, "C901")          # 值 201 → LEB128
        self.assertEqual(forest[1].byte_length, 2) # 出线宽度回写

    def test_fixed_default_stays_declared_width(self):
        forest = self._forest()
        flat = [("global", b) for b in forest]
        hex_str = LengthHandler().calculate(forest[1], flat)
        self.assertEqual(hex_str, "C9")            # 定宽 1 字节，与改前一致
        self.assertEqual(forest[1].byte_length, 1) # 不回写

    def test_byte_order_ignored_when_varint(self):
        """varint 字节序中立：同帧配 little 也按 varint 出线（结果逐字相同）。"""
        big = LengthHandler().calculate(*self._pair("big"))
        little = LengthHandler().calculate(*self._pair("little"))
        self.assertEqual(big, little)
        self.assertEqual(big, "C901")

    def _pair(self, order):
        forest = self._forest(encoding="varint", byte_order=order)
        return forest[1], [("global", b) for b in forest]

    def test_downstream_checksum_counts_written_back_width(self):
        """回写的意义：后到的 checksum 按**真实出线宽度**计 refs。"""
        forest = [
            block("h", byte_length=2, hex_value="FA FA"),
            block("p", byte_length=1, hex_value="07"),
            block("l", type="length", byte_length=1, hex_value="00",
                  config=BlockConfig(
                      params={"refs": ["p"], "offset": 200,
                              "encoding": "varint"})),
            block("c", type="checksum", byte_length=2, hex_value="0000",
                  config=BlockConfig(
                      params={"refs": ["l"], "algorithm": "sum"})),
        ]
        orch = Orchestrator(forest)
        self.assertEqual(_compact(orch.process()), "FAFA07C90100CA")
        self.assertEqual(orch.block_spans["l"], [(3, 5)])
        self.assertEqual(orch.block_spans["c"], [(5, 7)])


class CobsOrchestratorTest(unittest.TestCase):
    """`cobs` 组帧元素：发射前的树级前置改写（产物 = 定宽 fixed 叶）。"""

    def _inner(self):
        return [
            block("ih", byte_length=2, hex_value="FA FA"),
            block("il", type="length", byte_length=1, hex_value="00",
                  config=BlockConfig(params={"refs": ["ip"]})),
            block("ip", byte_length=1, hex_value="07"),
        ]

    def test_cobs_block_encodes_subtree_with_terminator(self):
        node = block("c", type="cobs", byte_length=0, hex_value=None,
                     is_container=True, children=self._inner())
        orch = Orchestrator([node])
        self.assertEqual(_compact(orch.process()), "05FAFA010700")
        self.assertEqual(orch.block_spans["c"], [(0, 6)])
        # 内层 length 真值就地定值 → 分层 LEN/CRC 卡面回显仍取得到
        self.assertEqual(node.children[1].hex_value, "01")

    def test_cobs_terminator_none(self):
        node = block("c", type="cobs", byte_length=0, hex_value=None,
                     is_container=True, children=self._inner(),
                     config=BlockConfig(params={"terminator": "none"}))
        self.assertEqual(_compact(Orchestrator([node]).process()), "05FAFA0107")

    def test_nested_cobs_encodes_inside_out(self):
        inner = block("ci", type="cobs", byte_length=0, hex_value=None,
                      is_container=True,
                      children=[block("x", byte_length=1, hex_value="00")])
        outer = block("co", type="cobs", byte_length=0, hex_value=None,
                      is_container=True,
                      children=[block("y", byte_length=1, hex_value="AA"), inner])
        # 内层 00 → 0101 + 定界 00 → 内层出线 010100；外层内 = 41 01 01 00
        # → COBS 04AA010101 + 定界 00
        self.assertEqual(_compact(Orchestrator([outer]).process()), "04AA01010100")

    def test_empty_cobs_still_emits_code_and_terminator(self):
        node = block("c", type="cobs", byte_length=0, hex_value=None,
                     is_container=True, children=[])
        self.assertEqual(_compact(Orchestrator([node]).process()), "0100")

    def test_no_cobs_nodes_is_a_no_op(self):
        """无 cobs 节点 → 前置改写零改写（与 test_framing_baseline 同口径）。"""
        forest = [
            block("h", byte_length=2, hex_value="FA FA"),
            block("p", byte_length=1, hex_value="07"),
            block("l", type="length", byte_length=1, hex_value="00",
                  config=BlockConfig(params={"refs": ["p"]})),
        ]
        ids_before = [b.id for b in forest]
        orch = Orchestrator(forest)
        self.assertEqual(_compact(orch.process()), "FAFA0701")
        self.assertEqual([b.id for b in forest], ids_before)
        self.assertEqual(forest[2].byte_length, 1)

    def test_refs_to_cobs_block_count_wire_width(self):
        """refs 引 cobs **块本身** → 计其出线字节数（跨不过边界，但块本身可引）。"""
        cobs_node = block(
            "c", type="cobs", byte_length=0, hex_value=None,
            is_container=True,
            children=[block("x", byte_length=1, hex_value="00"),
                      block("y", byte_length=1, hex_value="AA")],
        )
        # 内层 00AA → COBS 0102AA + 定界 00 = 4 字节
        lens = block("l", type="length", byte_length=1, hex_value="00",
                     config=BlockConfig(params={"refs": ["c"]}))
        orch = Orchestrator([cobs_node, lens])
        self.assertEqual(_compact(orch.process()), "0102AA0004")
        self.assertEqual(orch.block_spans["c"], [(0, 4)])


class FrameVectorTest(unittest.TestCase):
    """`vectors/framing.json::frame` —— 唯一封装入口 build_wrapped 端到端。"""

    def test_frames_match_vectors(self):
        for row in VEC_FRAME:
            with self.subTest(name=row["name"]):
                out = build_wrapped(row["children"], row["payloads"])
                compact = "".join(str(out["hex"]).split())
                self.assertEqual(compact, row["expect_hex"])
                self.assertEqual(out["total_length"], row["expect_length"])

    def test_frame_vectors_exercise_both_capabilities(self):
        names = [r["name"] for r in VEC_FRAME]
        self.assertIn("varint_len_root", names)
        self.assertIn("cobs_root", names)


if __name__ == "__main__":
    unittest.main()
