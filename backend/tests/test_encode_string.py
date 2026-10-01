"""N2 字符串批（PLAN §8.16 · G2）：STRING 定长文本编码 — 双端 byte-equal 锚点。

向量表单一真相源 = vectors/string.json（CP2b / D11-①）：本表与前端 InstructionEncoder.test.js 的 STRING VECTORS 同读这一份 JSON，新增/修改向量只写一处；跨语言特殊值约定（{"$v": "Infinity"/"-Infinity"/"NaN"} 包装对象）见 vectors/README.md。口径：ascii 按 code point &0xFF（Python ord()
↔ JS code-point 迭代）、utf8 走 UTF-8 字节流（孤立代理项 → U+FFFD 替换，
对齐 TextEncoder）、byte_len>0 → pad/截断定长、pad_char 按 2 位以内 hex
严格解析（非法/缺省 0x00）。
"""

import unittest

from backend.core.orchestrator import encode_string
from backend.routers.datahub import compile_blocks, fields_to_blocks, frame_bytes
from vectors.load_vectors import load_vectors

# 行形状（JSON 行）: (value, byte_len, encoding, pad_char, expected_hex)
# CP2b (D11-①): 单一真相源 = vectors/string.json —— 两端同读一份，新增向量只写一处
VECTORS = load_vectors("string")


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


class TestEncodeString(unittest.TestCase):
    def test_vectors(self):
        for value, byte_len, encoding, pad_char, expected in VECTORS:
            with self.subTest(value=value, byte_len=byte_len, encoding=encoding, pad_char=pad_char):
                self.assertEqual(encode_string(value, byte_len, encoding, pad_char), expected)

    def test_zero_or_negative_byte_len_keeps_raw(self):
        # byte_len<=0/None → 变长原样（不 pad/截断）—— to_block 分支闸
        # byte_len>0，本函数级口径与前端「byte_len 缺失/0 → 变长」对齐。
        self.assertEqual(encode_string("AB", 0), "4142")
        self.assertEqual(encode_string("AB", -1), "4142")
        self.assertEqual(encode_string("AB", None), "4142")

    def test_pad_char_strict_hex_parse(self):
        # 非 2 位以内 hex（非法/空/None）→ 0x00；'20' → 0x20（与前端同规则）
        self.assertEqual(encode_string("AB", 4, "ascii", ""), "41420000")
        self.assertEqual(encode_string("AB", 4, "ascii", None), "41420000")
        self.assertEqual(encode_string("AB", 4, "ascii", "20"), "41422020")
        self.assertEqual(encode_string("AB", 4, "ascii", "2G"), "41420000")


class TestFieldsToBlocksString(unittest.TestCase):
    def test_string_static_value_pads_to_byte_len(self):
        self.assertEqual(
            frame_of(field("STRING", 4, {"type": "string", "value": "AB"})),
            b"AB\x00\x00",
        )

    def test_string_pad_char_20(self):
        self.assertEqual(
            frame_of(field("STRING", 4, {"value": "AB", "pad_char": "20"})),
            b"AB  ",
        )

    def test_legacy_input_type_string_encodes_ascii(self):
        # 存量 INPUT + type=string：N2 起 BE 与 FE 同出 ASCII 定长（此前 BE 恒 zeros）。
        self.assertEqual(
            frame_of(field("INPUT", 2, {"type": "string", "value": "A"})),
            b"A\x00",
        )

    def test_input_type_number_unchanged_zeros_placeholder(self):
        # 非字符串 INPUT 不进新分支（0x00 占位现状不变）
        self.assertEqual(
            frame_of(field("INPUT", 2, {"type": "number", "value": 7})),
            b"\x00\x00",
        )

    def test_string_byte_len_zero_omitted(self):
        # byte_len=0 → 分支不进（byte_len>0 闸）→ 既有省略口径
        self.assertEqual(frame_of(field("STRING", 0, {"value": "AB"})), b"")

    def test_contradictory_numeric_op_type_string_keeps_zeros(self):
        # 矛盾配置（数值 op + type=string）：E1 各支既有 zeros 契约外行为不变
        # （FE 侧照走 string 分支——两端各自现状锚，双方测试各自锁定）。
        self.assertEqual(
            frame_of(field("BCD_CODE", 2, {"type": "string", "value": 25})),
            b"\x00\x00",
        )


if __name__ == "__main__":
    unittest.main()
