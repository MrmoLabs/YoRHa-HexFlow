"""E1-4 (B2) + R5: IEEE 754 float32 / float64 编码 — 双端 byte-equal 锚点。

向量表单一真相源 = vectors/float_ieee.json（CP2b / D11-①）：本表与前端
InstructionEncoder.test.js 的 E1-4 VECTORS 同读这一份 JSON（R5 起已分组
f32 / f64，两个组各锚一种位宽），新增/修改向量只写一处；跨语言特殊值约定
（{"$v": "Infinity"/"-Infinity"/"NaN"} 包装对象）见 vectors/README.md。

契约（R5 收口，PLAN §8.42）：op=FLOAT_IEEE + 规范 type（缺省/number）
- byte_len=4（bits=32）→ float32 大端，恒 4 字节（**存量行为，缺省参数
  逐字节不变**）；
- byte_len=8（bits=64）→ float64 大端，恒 8 字节（R5 新增，双端一致）；
- 其余 byte_len 与矛盾 type 不在范围（保持既有 zeros 契约外行为，同 E1-1
  原则；FE 校验 W FLOAT_IEEE_WIDTH_UNSUPPORTED 提醒）。

解析口径 `_float_number`（非有限 → 0）两端共用，故 NaN/±Inf 输入两种位宽
都出全零；R5 前后「缺省逐字节不变」由 f32 组（22 条）整组回归锚定。
"""

import unittest

from backend.core.orchestrator import encode_float_ieee
from backend.routers.datahub import compile_blocks, fields_to_blocks, frame_bytes
from vectors.load_vectors import load_vectors

# 行形状（JSON 行）: (value, expected_hex)
# CP2b (D11-①): 单一真相源 = vectors/float_ieee.json —— 两端同读一份，新增向量只写一处
VECTORS = load_vectors("float_ieee", key="f32")
VECTORS64 = load_vectors("float_ieee", key="f64")


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
    def test_vectors_f32(self):
        for value, expected in VECTORS:
            with self.subTest(value=value):
                self.assertEqual(encode_float_ieee(value), expected)

    def test_vectors_f64(self):
        for value, expected in VECTORS64:
            with self.subTest(value=value):
                self.assertEqual(encode_float_ieee(value, 8), expected)

    def test_default_arg_stays_f32(self):
        # R5 缺省口径：不传 byte_len 逐字节等同改前（存量调用零漂移）
        for value, expected in VECTORS:
            with self.subTest(value=value):
                self.assertEqual(encode_float_ieee(value), expected)
                self.assertEqual(encode_float_ieee(value, 4), expected)

    def test_fields_to_blocks_static_value(self):
        self.assertEqual(
            frame_of(field("FLOAT_IEEE", 4, {"value": 3.14})),
            bytes.fromhex("4048F5C3"),
        )
        self.assertEqual(
            frame_of(field("FLOAT_IEEE", 4, {"value": 1})),
            bytes.fromhex("3F800000"),
        )

    def test_missing_value_emits_zero_bytes_per_width(self):
        # 缺省值 → 0…0（与前端 params.value || 0 → 0 同口径）
        self.assertEqual(frame_of(field("FLOAT_IEEE", 4)), bytes(4))
        self.assertEqual(frame_of(field("FLOAT_IEEE", 8)), bytes(8))

    def test_byte_len_8_emits_float64(self):
        # R5：bits=8 字节 → float64 大端（R5 前此处为 zeros）
        self.assertEqual(
            frame_of(field("FLOAT_IEEE", 8, {"value": 1})),
            bytes.fromhex("3FF0000000000000"),
        )
        self.assertEqual(
            frame_of(field("FLOAT_IEEE", 8, {"value": 3.14})),
            bytes.fromhex("40091EB851EB851F"),
        )

    def test_f32_f64_dividing_line(self):
        # 同一输入：f32 溢出成 +Inf、f64 正常落位 —— 两种位宽必须分得开
        self.assertEqual(
            encode_float_ieee(1e40, 4),
            "7F800000",
        )
        self.assertEqual(
            encode_float_ieee(1e40, 8),
            "483D6329F1C35CA5",
        )

    def test_byte_len_not_4_or_8_out_of_scope(self):
        # 契约外宽度（byte_len=2）：保持既有 zeros
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
        self.assertEqual(
            frame_of(field("FLOAT_IEEE", 8, {"type": "float", "value": 5})),
            bytes(8),
        )

    def test_little_endian联动(self):
        # FLOAT_IEEE × E1-2：3F800000 → 0000803F（字节整体逆序，与宽度无关）
        self.assertEqual(
            frame_of(field("FLOAT_IEEE", 4, {"value": 1}, endianness="LITTLE")),
            bytes.fromhex("0000803F"),
        )
        self.assertEqual(
            frame_of(field("FLOAT_IEEE", 8, {"value": 1}, endianness="LITTLE")),
            bytes.fromhex("000000000000F03F"),
        )


if __name__ == "__main__":
    unittest.main()
