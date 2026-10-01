"""E1-1 (B5): INT_SIGNED 按位宽两补码 — 双端 byte-equal 锚点（stdlib 直测）。

向量表单一真相源 = vectors/int_signed.json（CP2b / D11-①）：本表与前端 InstructionEncoder.test.js 的 VECTORS 同读这一份 JSON，新增/修改向量只写一处；跨语言特殊值约定（{"$v": "Infinity"/"-Infinity"/"NaN"} 包装对象）见 vectors/README.md。
"""

import unittest

from backend.core.orchestrator import encode_int_signed
from backend.routers.datahub import compile_blocks, fields_to_blocks, frame_bytes
from vectors.load_vectors import load_vectors

# 行形状（JSON 行）: (value, byte_len, expected_hex)
# CP2b (D11-①): 单一真相源 = vectors/int_signed.json —— 两端同读一份，新增向量只写一处
VECTORS = load_vectors("int_signed")


def field(op, byte_len, cfg=None, sequence=0):
    return {
        "id": f"f{sequence}",
        "name": f"f{sequence}",
        "op_code": op,
        "byte_len": byte_len,
        "sequence": sequence,
        "parent_id": None,
        "parameter_config": cfg if cfg is not None else {},
    }


def frame_of(*fields):
    return frame_bytes(compile_blocks(fields_to_blocks(list(fields))))


class TestEncodeIntSigned(unittest.TestCase):
    def test_vectors(self):
        for value, byte_len, expected in VECTORS:
            with self.subTest(value=value, byte_len=byte_len):
                self.assertEqual(encode_int_signed(value, byte_len), expected)

    def test_zero_or_negative_byte_len_returns_empty(self):
        self.assertEqual(encode_int_signed(-1, 0), "")
        self.assertEqual(encode_int_signed(-1, -1), "")


class TestFieldsToBlocksSigned(unittest.TestCase):
    def test_static_negative_value_emits_complement(self):
        self.assertEqual(frame_of(field("INT_SIGNED", 1, {"value": -1})), b"\xff")
        self.assertEqual(frame_of(field("INT_SIGNED", 2, {"value": -1})), b"\xff\xff")

    def test_missing_value_emits_zeros(self):
        self.assertEqual(frame_of(field("INT_SIGNED", 2)), b"\x00\x00")

    def test_cfg_hex_ignored_for_signed(self):
        # 前端同样忽略 INT_SIGNED 的 params.hex（仅 FIXED/HEADER/TAIL/HEX_RAW 吃 hex）
        self.assertEqual(
            frame_of(field("INT_SIGNED", 1, {"hex": "A5", "value": -1})), b"\xff"
        )

    def test_type_number_is_canonical(self):
        self.assertEqual(
            frame_of(field("INT_SIGNED", 1, {"type": "number", "value": -1})), b"\xff"
        )

    def test_contradictory_type_keeps_zeros(self):
        # type=string/float/hex 的 INT_SIGNED 属矛盾配置（契约外）：保持既有 zeros
        self.assertEqual(
            frame_of(field("INT_SIGNED", 1, {"type": "string", "value": -1})), b"\x00"
        )

    def test_existing_hex_raw_regression(self):
        # 存量回归：HEX_RAW 骨架口径不变（E1-1 只动 INT_SIGNED）
        self.assertEqual(
            frame_of(field("HEX_RAW", 2, {"hex": "AA BB"})), bytes.fromhex("AABB")
        )


if __name__ == "__main__":
    unittest.main()
