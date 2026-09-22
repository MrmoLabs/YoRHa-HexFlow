"""E1-2 (B6): endianness=LITTLE 整体逆序 — 双端 byte-equal 锚点（stdlib 直测）。

向量表与 frontend/src/utils/__tests__/InstructionEncoder.test.js 的 E1-2 VECTORS
逐行同步（两端各自钉同一张表实现跨语言一致性），改一必改二。

语义：先按 op 语义出大端字节，再对整段字节逆序（字节数不变；单字节不动）。
length/checksum handler 在逆序前的 big-endian 值上计算（Orchestrator.process
第 3 步先于第 4 步 emit 反转），与前端 refs 吃 _encodeFieldBytes（未反转）对称。
"""

import unittest

from backend.core.orchestrator import _reverse_hex_pairs
from backend.routers.datahub import compile_blocks, fields_to_blocks, frame_bytes

# (endianness, op, byte_len, cfg, expected_hex) — 与前端 E1-2 VECTORS 同步
VECTORS = [
    ("LITTLE", "INT_SIGNED", 2, {"value": -2}, "FEFF"),
    ("LITTLE", "HEX_RAW", 2, {"hex": "AA BB"}, "BBAA"),
    ("LITTLE", "HEX_RAW", 1, {"hex": "AA"}, "AA"),
    ("LITTLE", "FIXED", 2, {"hex": "1234"}, "3412"),
    ("little", "FIXED", 2, {"hex": "1234"}, "3412"),
    (None, "FIXED", 2, {"hex": "1234"}, "1234"),
    ("BIG", "FIXED", 2, {"hex": "1234"}, "1234"),
]


def field(op, byte_len, cfg=None, sequence=0, endianness=None, field_id=None):
    d = {
        "id": field_id or f"f{sequence}",
        "name": field_id or f"f{sequence}",
        "op_code": op,
        "byte_len": byte_len,
        "sequence": sequence,
        "parent_id": None,
        "parameter_config": cfg if cfg is not None else {},
    }
    if endianness is not None:
        d["endianness"] = endianness
    return d


def frame_of(*fields):
    return frame_bytes(compile_blocks(fields_to_blocks(list(fields))))


class TestLittleEndianVectors(unittest.TestCase):
    def test_vectors(self):
        for endianness, op, byte_len, cfg, expected in VECTORS:
            with self.subTest(endianness=endianness, op=op, cfg=cfg):
                self.assertEqual(
                    frame_of(field(op, byte_len, cfg, endianness=endianness)),
                    bytes.fromhex(expected),
                )

    def test_int_signed_big_regression(self):
        # E1-1 口径回归：BIG（缺省）下补码帧不被触碰
        self.assertEqual(
            frame_of(field("INT_SIGNED", 2, {"value": -1})), b"\xff\xff"
        )

    def test_group_children_reversed_individually(self):
        # 组容器自身不携带值；子字段各自按 endianness 出帧（与前端组递归同口径）
        group = field("FIXED", 0, {}, field_id="g")
        a = field("FIXED", 2, {"hex": "1234"}, sequence=1, field_id="a")
        a["parent_id"] = "g"
        b = field(
            "FIXED", 2, {"hex": "5678"}, sequence=2, field_id="b",
            endianness="LITTLE",
        )
        b["parent_id"] = "g"
        frame = frame_of(group, a, b).replace(b" ", b"")
        self.assertEqual(frame, bytes.fromhex("12347856"))


class TestEndiannessPassthrough(unittest.TestCase):
    def test_fields_to_blocks_passes_endianness(self):
        blocks = fields_to_blocks([
            field("FIXED", 2, {"hex": "1234"}, endianness="LITTLE"),
            field("FIXED", 2, {"hex": "1234"}, sequence=1),
            field("FIXED", 2, {"hex": "1234"}, sequence=2, endianness="little"),
        ])
        self.assertEqual(
            [b["endianness"] for b in blocks],
            ["LITTLE", "BIG", "LITTLE"],
        )


class TestReverseHexPairs(unittest.TestCase):
    def test_unit(self):
        self.assertEqual(_reverse_hex_pairs(""), "")
        self.assertEqual(_reverse_hex_pairs("A"), "A")  # 奇数原样
        self.assertEqual(_reverse_hex_pairs("12345"), "12345")
        self.assertEqual(_reverse_hex_pairs("1234"), "3412")
        self.assertEqual(_reverse_hex_pairs("12 34"), "34 12")
        self.assertEqual(_reverse_hex_pairs("12 34 56 78"), "78 56 34 12")


if __name__ == "__main__":
    unittest.main()
