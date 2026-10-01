"""E1-3 (B3/B4): packed BCD + SCALED factor/offset 定标 — 双端 byte-equal 锚点。

向量表单一真相源 = vectors/bcd_scaled.json（CP2b / D11-①）：本表与前端 InstructionEncoder.test.js 的 E1-3 VECTORS_BCD / VECTORS_SCALED 同读这一份 JSON，新增/修改向量只写一处；跨语言特殊值约定（{"$v": "Infinity"/"-Infinity"/"NaN"} 包装对象）见 vectors/README.md。

口径：
- BCD：floor 解析（_floor_numeric，同 INT_SIGNED）→ abs → 数字逐 nibble 打包，
  超长截高位保低 2*byte_len 位，高位补 0（大端）。
- SCALED：(value+offset)*factor，factor/offset 空/非有限 → 1/0 恒等，value
  非有限 → 0；结果 abs(floor)，mod 2^(8*byte_len)。矛盾 type 不参与（保持既有
  zeros 契约外行为，同 E1-1 原则）。
"""

import unittest

from backend.core.orchestrator import encode_bcd, encode_scaled
from backend.routers.datahub import compile_blocks, fields_to_blocks, frame_bytes
from vectors.load_vectors import load_vectors

# 行形状（JSON 行）: (value, byte_len, expected_hex)
# CP2b (D11-①): 单一真相源 = vectors/bcd_scaled.json · 表 bcd —— 两端同读一份，新增向量只写一处
VECTORS_BCD = load_vectors("bcd_scaled", "bcd")

# 行形状（JSON 行）: (value, factor, offset, byte_len, expected_hex)
# CP2b (D11-①): 单一真相源 = vectors/bcd_scaled.json · 表 scaled —— 两端同读一份，新增向量只写一处
VECTORS_SCALED = load_vectors("bcd_scaled", "scaled")


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


class TestBcdVectors(unittest.TestCase):
    def test_vectors(self):
        for value, byte_len, expected in VECTORS_BCD:
            with self.subTest(value=value, byte_len=byte_len):
                self.assertEqual(encode_bcd(value, byte_len), expected)

    def test_fields_to_blocks_static_value(self):
        self.assertEqual(
            frame_of(field("BCD_CODE", 2, {"value": 25})), bytes.fromhex("0025")
        )
        self.assertEqual(
            frame_of(field("BCD_CODE", 1, {"value": 255})), bytes.fromhex("55")
        )

    def test_missing_value_emits_zeros(self):
        # 静态值缺省 → 00（与前端 params.value || 0 同口径）
        self.assertEqual(frame_of(field("BCD_CODE", 2)), bytes.fromhex("0000"))

    def test_contradictory_type_keeps_zeros(self):
        # type=string 的 BCD 属矛盾配置（契约外）：保持既有 zeros 行为
        self.assertEqual(
            frame_of(field("BCD_CODE", 2, {"type": "string", "value": 25})),
            bytes(2),
        )

    def test_little_endian联动(self):
        # BCD × E1-2：0025 → 2500
        self.assertEqual(
            frame_of(field("BCD_CODE", 2, {"value": 25}, endianness="LITTLE")),
            bytes.fromhex("2500"),
        )


class TestScaledVectors(unittest.TestCase):
    def test_vectors(self):
        for value, factor, offset, byte_len, expected in VECTORS_SCALED:
            with self.subTest(value=value, factor=factor, offset=offset):
                self.assertEqual(
                    encode_scaled(value, factor, offset, byte_len), expected
                )

    def test_fields_to_blocks_static_value(self):
        self.assertEqual(
            frame_of(field("SCALED_DECIMAL", 2, {"value": 5, "factor": 2, "offset": 10})),
            bytes.fromhex("001E"),
        )

    def test_identity_when_factor_offset_missing(self):
        # 恒等回归：无 factor/offset → 裸整数路径不变
        self.assertEqual(
            frame_of(field("SCALED_DECIMAL", 2, {"value": 0x1234})),
            bytes.fromhex("1234"),
        )

    def test_contradictory_type_keeps_zeros(self):
        # type=float 的 SCALED 属矛盾配置（契约外）：保持既有 zeros 行为
        self.assertEqual(
            frame_of(
                field("SCALED_DECIMAL", 4, {"type": "float", "value": 5, "factor": 3})
            ),
            bytes(4),
        )


if __name__ == "__main__":
    unittest.main()
