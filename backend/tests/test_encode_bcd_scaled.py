"""E1-3 (B3/B4): packed BCD + SCALED factor/offset 定标 — 双端 byte-equal 锚点。

向量表与 frontend/src/utils/__tests__/InstructionEncoder.test.js 的 E1-3
VECTORS_BCD / VECTORS_SCALED 逐行同步（两端各自钉同一张表实现跨语言一致性），
改一必改二。

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

# 与前端 E1-3 VECTORS_BCD 同步：(value, byte_len, expected_hex)
VECTORS_BCD = [
    (25, 2, "0025"),
    (25, 1, "25"),
    (0, 2, "0000"),
    (12345, 2, "2345"),
    (255, 1, "55"),
    (-25, 2, "0025"),
    (12.9, 2, "0012"),
    (1.5, 1, "01"),
    (-1.5, 1, "02"),
    ("42", 1, "42"),
    ("-7", 1, "07"),
    ("FF", 1, "00"),
    ("", 1, "00"),
    # byte_len=0 不入表：FE 既有 `byte_len || 1` 归一 / BE `>0` 守卫属通用边角，非 B3 语义
    (True, 1, "00"),
    (float("inf"), 1, "00"),
    (float("nan"), 1, "00"),
    (None, 1, "00"),
]

# 与前端 E1-3 VECTORS_SCALED 同步：(value, factor, offset, byte_len, expected_hex)
VECTORS_SCALED = [
    (5, 2, 10, 2, "001E"),
    (5, None, None, 2, "0005"),
    (5, "", "", 2, "0005"),
    (2.7, 1, 0, 2, "0002"),
    (-3, 1, 0, 2, "0003"),
    (10, 0.5, 0, 2, "0005"),
    (10, 2.5, 0, 2, "0019"),
    (300, 10, 0, 1, "B8"),
    ("FF", 1, 0, 1, "00"),
    ("12", 1, 0, 1, "0C"),
    (7, "3", 0, 1, "15"),
    (7, 1, "2.5", 1, "09"),
    (None, 1, 0, 1, "00"),
    (0.5, 1, 0, 1, "00"),
    (-0.5, 1, 0, 1, "01"),
    (255, 1, 0, 2, "00FF"),
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
