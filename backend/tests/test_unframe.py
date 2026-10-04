"""R28（PLAN §8.52 排期第 8 批 · §8.60 定案）收侧解包纯函数单测。

覆盖：
- `decode_varint` —— 与 `framing.encode_varint` 严格互逆（**向量反向消费**：
  vectors/framing.json · 表 varint 的 `hex` → 解码 → `v`），畸形/越界/超值域报
  ValueError 而不是猜一个值（宁可少判也不误判）；
- `cobs_decode` —— 与 `framing.cobs_encode` 严格互逆（同表 cobs 的 `out` → 剥定界 →
  解码 → `in`），并直接做编码端往返；区内裸 0x00 / 码字节越界一律报错；
- 「只解不编」：本模块不得出现任何 encode 入口（与 test_framing.
  test_encode_only_module 对偶 —— 编码模块无 decode 符号、解码模块无 encode 符号）。

向量文件不新增：R27 的 framing.json 只写了**出线方向**，R28 从同一份 JSON 的出线
侧反推解码侧 —— 新增 vectors 文件须双端同读，而匹配只有后端一处消费，故不引入。
Run from repo root: python -m unittest backend.tests.test_unframe
"""

import unittest

import backend.core.unframe as unframe
from backend.core.framing import encode_cobs_hex, encode_varint
from backend.core.unframe import cobs_decode, decode_varint
from vectors.load_vectors import load_vectors

VEC_VARINT = load_vectors("framing", "varint")
VEC_COBS = load_vectors("framing", "cobs")


class VarintDecodeTest(unittest.TestCase):
    def test_roundtrip_against_vector(self):
        """出线方向的字节真值 → 解码回原值，宽度 = 出线字节数。"""
        self.assertTrue(VEC_VARINT)
        for row in VEC_VARINT:
            data = bytes.fromhex(row["hex"])
            value, width = decode_varint(data)
            self.assertEqual(value, row["v"], msg=str(row))
            self.assertEqual(width, len(row["hex"]) // 2, msg=str(row))

    def test_encoder_decoder_are_inverse(self):
        for value in (0, 1, 127, 128, 300, 16383, 16384, (1 << 53) - 1):
            encoded = bytes.fromhex(encode_varint(value))
            self.assertEqual(decode_varint(encoded), (value, len(encoded)), msg=value)

    def test_offset_reads_from_middle(self):
        self.assertEqual(decode_varint(b"\xFF\x80\x01", 1), (128, 2))

    def test_accepts_non_minimal_encoding_with_true_width(self):
        """非最小编码（设备补零）接受 —— 宽度按实际读到的字节数报，供回算 offset_val。"""
        self.assertEqual(decode_varint(b"\x80\x00"), (0, 2))
        self.assertEqual(decode_varint(b"\x81\x00"), (1, 2))

    def test_rejects_bad_input(self):
        with self.assertRaises(ValueError):  # 起点越界（含 offset == len）
            decode_varint(b"", 0)
        with self.assertRaises(ValueError):
            decode_varint(b"\x01", 1)
        with self.assertRaises(ValueError):  # 负偏移 / 布尔不是合法起点
            decode_varint(b"\x01", -1)
        with self.assertRaises(ValueError):
            decode_varint(b"\x01", True)
        with self.assertRaises(ValueError):  # 续位未收束
            decode_varint(b"\x80\x80")
        with self.assertRaises(ValueError):  # 超过 8 字节上限
            decode_varint(b"\x80" * 8)
        with self.assertRaises(ValueError):  # 8 字节收束但超 2^53-1（FE 丢精度边界）
            decode_varint(bytes([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x7F]))
        with self.assertRaises(TypeError):
            decode_varint("8001")  # type: ignore[arg-type]


class CobsDecodeTest(unittest.TestCase):
    @staticmethod
    def _compact(text):
        return "".join(str(text).split()).upper()

    def test_roundtrip_against_vector(self):
        """出线侧 `out` 剥掉定界 → 解码回 `in`（表 cobs 即编码侧唯一真值）。"""
        self.assertTrue(VEC_COBS)
        for row in VEC_COBS:
            term = b"" if row["term"] == "none" else bytes.fromhex(row["term"])
            encoded = bytes.fromhex(row["out"])
            if term:
                self.assertTrue(encoded.endswith(term), msg=str(row))
                encoded = encoded[: -len(term)]
            got = self._compact(cobs_decode(encoded).hex())
            self.assertEqual(got, self._compact(row["in"]), msg=str(row))

    def test_encoder_decoder_are_inverse(self):
        cases = [
            b"",
            b"\x00",
            b"AA",
            b"AA\x00BB",
            b"\x00\x00\x00",
            bytes(254),            # 满块：码 0xFF 后不补隐式 0x00
            bytes(255),            # 满块 + 1 字节
            bytes(254) + b"\x00",  # 满块后接 0x00 → 由下一个码字节表示
            bytes([i % 256 for i in range(1000)]),
        ]
        for raw in cases:
            # encode_cobs_hex 输入 hex、缺省 terminator="00" → 末字节恒为定界，剥掉再解码
            encoded = bytes.fromhex(encode_cobs_hex(raw.hex()))
            self.assertTrue(encoded.endswith(b"\x00"), msg=len(raw))
            self.assertEqual(cobs_decode(encoded[:-1]), raw, msg=len(raw))

    def test_rejects_bad_input(self):
        with self.assertRaises(ValueError):  # 空区（不是一个合法码字节）
            cobs_decode(b"")
        with self.assertRaises(ValueError):  # 裸 0x00 = 定界没剥干净
            cobs_decode(b"\x03\xBB\x00")
        with self.assertRaises(ValueError):  # 码字节要求的字节数越过区尾
            cobs_decode(b"\x0A\xBB\xA0\x01")
        with self.assertRaises(TypeError):
            cobs_decode("03BB")  # type: ignore[arg-type]


class DecodeOnlyModuleTest(unittest.TestCase):
    def test_module_has_no_encode_entry(self):
        """「只解不编」：解码模块不得出现任何 encode 入口（与 test_framing 对偶）。"""
        self.assertEqual([n for n in dir(unframe) if "encode" in n.lower()], [])


if __name__ == "__main__":
    unittest.main()
