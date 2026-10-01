"""E1-4 (B2): IEEE 754 float32 编码 — 双端 byte-equal 锚点（stdlib 直测）。

向量表单一真相源 = vectors/float_ieee.json（CP2b / D11-①）：本表与前端 InstructionEncoder.test.js 的 E1-4 VECTORS 同读这一份 JSON，新增/修改向量只写一处；跨语言特殊值约定（{"$v": "Infinity"/"-Infinity"/"NaN"} 包装对象）见 vectors/README.md。

契约：op=FLOAT_IEEE + byte_len=4（bits=32）+ 规范 type（缺省/number）→
float32 大端（网络序），恒 4 字节；bits=64（byte_len=8）与矛盾 type 不在
范围（保持既有 zeros 契约外行为，同 E1-1 原则）。
"""

import unittest

from backend.core.orchestrator import encode_float_ieee
from backend.routers.datahub import compile_blocks, fields_to_blocks, frame_bytes
from vectors.load_vectors import load_vectors

# 行形状（JSON 行）: (value, expected_hex)
# CP2b (D11-①): 单一真相源 = vectors/float_ieee.json —— 两端同读一份，新增向量只写一处
VECTORS = load_vectors("float_ieee")


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


class TestFloatIeeeVectors(unittest.TestCase):
    def test_vectors(self):
        for value, expected in VECTORS:
            with self.subTest(value=value):
                self.assertEqual(encode_float_ieee(value), expected)

    def test_fields_to_blocks_static_value(self):
        self.assertEqual(
            frame_of(field("FLOAT_IEEE", 4, {"value": 3.14})),
            bytes.fromhex("4048F5C3"),
        )
        self.assertEqual(
            frame_of(field("FLOAT_IEEE", 4, {"value": 1})),
            bytes.fromhex("3F800000"),
        )

    def test_missing_value_emits_four_zero_bytes(self):
        # 缺省值 → 00000000（与前端 params.value || 0 → 0 同口径）
        self.assertEqual(frame_of(field("FLOAT_IEEE", 4)), bytes(4))

    def test_byte_len_not_4_out_of_scope(self):
        # bits=64（byte_len=8）/ byte_len=2 不在 E1-4 范围：保持既有 zeros
        self.assertEqual(frame_of(field("FLOAT_IEEE", 8, {"value": 1})), bytes(8))
        self.assertEqual(frame_of(field("FLOAT_IEEE", 2, {"value": 1})), bytes(2))

    def test_contradictory_type_keeps_zeros(self):
        # type=float/string 属契约外（模板不设置）：保持既有 zeros 行为
        self.assertEqual(
            frame_of(field("FLOAT_IEEE", 4, {"type": "float", "value": 5})),
            bytes(4),
        )
        self.assertEqual(
            frame_of(field("FLOAT_IEEE", 4, {"type": "string", "value": 1.5})),
            bytes(4),
        )

    def test_little_endian联动(self):
        # FLOAT_IEEE × E1-2：3F800000 → 0000803F
        self.assertEqual(
            frame_of(field("FLOAT_IEEE", 4, {"value": 1}, endianness="LITTLE")),
            bytes.fromhex("0000803F"),
        )


if __name__ == "__main__":
    unittest.main()
