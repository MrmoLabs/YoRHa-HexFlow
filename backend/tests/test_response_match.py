"""P2 应答匹配纯函数单测（normalize_spec 校验 + match_response 判定 + CRC 双端锚定）。

Run from repo root: python -m unittest discover -s backend/tests
stdlib unittest 直调纯函数，无 TestClient、无数据库。
"""

import unittest

from backend.core.framing import cobs_encode
from backend.core.response_match import (
    crc16,
    default_spec,
    match_response,
    normalize_spec,
)
from backend.handlers.checksum import ChecksumHandler


def _sum_frame(payload: bytes) -> bytes:
    """payload + 单字节 SUM8（反算区间 = 默认整帧排除字段自身 → 恰为 payload）。"""
    return payload + bytes([sum(payload) % 256])


class NormalizeSpecTest(unittest.TestCase):
    def test_default_shape_has_all_keys(self):
        spec = normalize_spec({})
        self.assertEqual(spec["mode"], "echo")
        self.assertEqual(spec["prefix"], "")
        self.assertEqual(spec["suffix"], "")
        self.assertEqual(spec["echo_header_bytes"], 0)
        self.assertIsNone(spec["length"])
        self.assertIsNone(spec["checksum"])
        self.assertEqual(spec["ignore_ranges"], [])
        # default_spec 与 normalize({}) 同形
        self.assertEqual(default_spec(), spec)

    def test_rejects_non_dict_and_unknown_keys(self):
        with self.assertRaises(ValueError):
            normalize_spec([1, 2])
        with self.assertRaises(ValueError) as ctx:
            normalize_spec({"mode": "echo", "regex": ".*"})
        self.assertIn("未知规格字段", str(ctx.exception))

    def test_rejects_bad_mode(self):
        with self.assertRaises(ValueError) as ctx:
            normalize_spec({"mode": "carrier-pigeon"})
        self.assertIn("匹配模式", str(ctx.exception))

    def test_hex_literals_cleaned_and_uppercased(self):
        spec = normalize_spec({"prefix": "aa 55", "suffix": "0d_0a"})
        self.assertEqual(spec["prefix"], "AA55")
        self.assertEqual(spec["suffix"], "0D0A")
        self.assertEqual(normalize_spec({"prefix": ""})["prefix"], "")

    def test_rejects_bad_hex_literals(self):
        with self.assertRaises(ValueError):
            normalize_spec({"prefix": "A"})       # 奇数位
        with self.assertRaises(ValueError):
            normalize_spec({"suffix": "ZZ"})      # 非十六进制

    def test_echo_header_bytes_bounds_and_bool_rejected(self):
        self.assertEqual(normalize_spec({"echo_header_bytes": 4})["echo_header_bytes"], 4)
        with self.assertRaises(ValueError):
            normalize_spec({"echo_header_bytes": True})   # bool 不是 int
        with self.assertRaises(ValueError):
            normalize_spec({"echo_header_bytes": 1025})

    def test_length_normalization_and_validation(self):
        length = normalize_spec({"length": {"offset": 2}})["length"]
        # CP3 3d: + offset_from_end（插槽后长度块的「距帧尾」表达，缺省 None）
        self.assertEqual(length, {
            "offset": 2, "byte_length": 1, "offset_val": 0, "byte_order": "big",
            "offset_from_end": None,
        })
        with self.assertRaises(ValueError):
            normalize_spec({"length": {"bogus": 1}})
        with self.assertRaises(ValueError):
            normalize_spec({"length": {"byte_order": "middle"}})
        with self.assertRaises(ValueError):
            normalize_spec({"length": {"byte_length": 0}})
        # 绝对与距帧尾两种表达互斥
        with self.assertRaises(ValueError):
            normalize_spec({"length": {"offset": 2, "offset_from_end": 3}})
        self.assertEqual(
            normalize_spec({"length": {"offset_from_end": 3}})["length"]["offset"], 0
        )

    def test_checksum_normalization_and_validation(self):
        cs = normalize_spec({"checksum": {"algo": "crc16_modbus", "field_offset": 4}})
        self.assertEqual(cs["checksum"]["field_byte_length"], 2)  # crc16 缺省 2 字节
        with self.assertRaises(ValueError) as ctx:
            normalize_spec({"checksum": {"algo": "crc_32_legacy"}})  # R22: crc32 已入枚举 → 换真·枚举外样本
        self.assertIn("algo", str(ctx.exception))
        with self.assertRaises(ValueError):
            normalize_spec({"checksum": {"algo": "crc16_modbus", "field_byte_length": 1}})
        with self.assertRaises(ValueError):
            normalize_spec({"checksum": {"span_start": 8, "span_end": 8}})
        with self.assertRaises(ValueError):
            normalize_spec({"checksum": {"field_offset": -1}})

    def test_ignore_ranges_sort_and_overlap_rejected(self):
        spec = normalize_spec({"ignore_ranges": [[10, 12], [4, 6]]})
        self.assertEqual(spec["ignore_ranges"], [[4, 6], [10, 12]])
        with self.assertRaises(ValueError):
            normalize_spec({"ignore_ranges": [[4, 6], [5, 9]]})   # 重叠
        with self.assertRaises(ValueError):
            normalize_spec({"ignore_ranges": [[6, 4]]})           # 反向
        with self.assertRaises(ValueError):
            normalize_spec({"ignore_ranges": [[0, 4, 8]]})        # 三元素
        with self.assertRaises(ValueError):
            normalize_spec({"ignore_ranges": [[i, i + 1] for i in range(33)]})  # 超 32 段


class MatchResponseTest(unittest.TestCase):
    SENT = bytes([0xA5, 0x01, 0x02, 0x5A])

    def test_empty_response_always_fails(self):
        ok, reasons = match_response(default_spec(), self.SENT, b"")
        self.assertFalse(ok)
        self.assertEqual(reasons, ["EMPTY_RESPONSE"])

    def test_mode_any_accepts_any_nonempty(self):
        spec = normalize_spec({"mode": "any", "prefix": "FF"})
        ok, reasons = match_response(spec, self.SENT, b"\x00\x01")
        self.assertTrue(ok)
        self.assertEqual(reasons, [])

    def test_echo_default_pass_and_mismatch_index(self):
        ok, reasons = match_response(default_spec(), self.SENT, self.SENT)
        self.assertTrue(ok)
        corrupt = bytes([0xA5, 0x01, 0xFF, 0x5A])
        ok, reasons = match_response(default_spec(), self.SENT, corrupt)
        self.assertFalse(ok)
        self.assertEqual(reasons, ["ECHO_MISMATCH@2"])

    def test_echo_length_mismatch(self):
        ok, reasons = match_response(default_spec(), self.SENT, self.SENT + b"\x00")
        self.assertFalse(ok)
        self.assertEqual(reasons, ["ECHO_LENGTH_MISMATCH"])

    def test_ignore_ranges_mask_volatile_bytes(self):
        # 第 2 字节为计数器：掩码后回显比对通过
        spec = normalize_spec({"ignore_ranges": [[2, 3]]})
        mutated = bytes([0xA5, 0x01, 0x77, 0x5A])
        ok, reasons = match_response(spec, self.SENT, mutated)
        self.assertTrue(ok, reasons)
        # 未掩码的第 3 字节仍要一致
        worse = bytes([0xA5, 0x01, 0x77, 0x00])
        ok, reasons = match_response(spec, self.SENT, worse)
        self.assertFalse(ok)
        self.assertEqual(reasons, ["ECHO_MISMATCH@3"])

    def test_prefix_suffix_rules(self):
        spec = normalize_spec({"mode": "rules", "prefix": "A5", "suffix": "5A"})
        self.assertTrue(match_response(spec, self.SENT, b"\xA5\x01\x5A")[0])
        self.assertFalse(match_response(spec, self.SENT, b"\x00\x01\x5A")[0])   # PREFIX
        self.assertFalse(match_response(spec, self.SENT, b"\xA5\x01\x00")[0])   # SUFFIX
        reasons = match_response(spec, self.SENT, b"\x00\x01\x00")[1]
        self.assertIn("PREFIX_MISMATCH", reasons)
        self.assertIn("SUFFIX_MISMATCH", reasons)

    def test_echo_header_bytes(self):
        spec = normalize_spec({"mode": "rules", "echo_header_bytes": 2})
        self.assertTrue(match_response(spec, self.SENT, b"\xA5\x01\xFF\xEE")[0])
        reasons = match_response(spec, self.SENT, b"\xA5\x02\xFF\xEE")[1]
        self.assertEqual(reasons, ["ECHO_HEADER_MISMATCH"])
        reasons = match_response(spec, self.SENT, b"\xA5")[1]
        self.assertEqual(reasons, ["ECHO_HEADER_TOO_SHORT"])

    def test_length_self_consistency_big_and_little(self):
        # 帧 = 数据(2B) + 长度字段(offset 2, 声明 3 == 帧长 3 + 0)
        frame_big = bytes([0x10, 0x20, 0x03])
        spec = normalize_spec({
            "mode": "rules",
            "length": {"offset": 2, "byte_length": 1, "offset_val": 0, "byte_order": "big"},
        })
        self.assertTrue(match_response(spec, self.SENT, frame_big)[0], "big 端自洽")

        # 声明值 4、帧长 5 → offset_val = -1 自洽
        frame_shift = bytes([0x10, 0x20, 0x30, 0x40, 0x04])
        spec_shift = normalize_spec({
            "mode": "rules",
            "length": {"offset": 4, "byte_length": 1, "offset_val": -1},
        })
        self.assertTrue(match_response(spec_shift, self.SENT, frame_shift)[0])

        # little 端 16 位长度（值 4 → 字节 04 00；帧长 4 == 声明 4 自洽）
        frame_little = bytes([0x10, 0x20, 0x04, 0x00])
        spec_little = normalize_spec({
            "mode": "rules",
            "length": {"offset": 2, "byte_length": 2, "byte_order": "little"},
        })
        self.assertTrue(match_response(spec_little, self.SENT, frame_little)[0])

        reasons = match_response(spec, self.SENT, bytes([0x10, 0x20, 0x05]))[1]
        self.assertIn("LENGTH_MISMATCH(5!=3)", reasons[0])
        reasons = match_response(spec, self.SENT, b"\x10")[1]
        self.assertEqual(reasons, ["LENGTH_OUT_OF_RANGE"])

    def test_checksum_sum_pass_fail(self):
        frame = _sum_frame(bytes([0x01, 0x02, 0x03]))   # 06 校验
        spec = normalize_spec({
            "mode": "rules",
            "checksum": {"algo": "sum", "field_offset": 3, "field_byte_length": 1},
        })
        self.assertTrue(match_response(spec, self.SENT, frame)[0])
        bad = bytes([0x01, 0x02, 0x04, 0x06])           # 数据改了、校验没改
        ok, reasons = match_response(spec, self.SENT, bad)
        self.assertFalse(ok)
        self.assertTrue(reasons[0].startswith("CHECKSUM_MISMATCH(exp=07,got=06)".split("(")[0]))
        self.assertIn("exp=07", reasons[0])
        # 字段越界
        reasons = match_response(spec, self.SENT, b"\x01")[1]
        self.assertEqual(reasons, ["CHECKSUM_OUT_OF_RANGE"])

    def test_checksum_xor(self):
        payload = bytes([0xF0, 0x0F, 0xAA])
        xor_value = 0xF0 ^ 0x0F ^ 0xAA
        frame = payload + bytes([xor_value])
        spec = normalize_spec({
            "mode": "rules",
            "checksum": {"algo": "xor", "field_offset": 3, "field_byte_length": 1},
        })
        self.assertTrue(match_response(spec, self.SENT, frame)[0])
        self.assertFalse(match_response(spec, self.SENT, payload + bytes([xor_value ^ 1]))[0])

    def test_checksum_crc16_modbus_little_endian_trailing(self):
        payload = bytes([0x01, 0x03, 0x00, 0x00, 0x00, 0x0A])
        crc = crc16(payload)
        frame = payload + crc.to_bytes(2, "little")     # MODBUS 线上小端
        spec = normalize_spec({
            "mode": "rules",
            "checksum": {
                "algo": "crc16_modbus",
                "field_offset": len(payload),
                "field_byte_length": 2,
                "byte_order": "little",
            },
        })
        self.assertTrue(match_response(spec, self.SENT, frame)[0])
        # 同帧按 big 解读 → 失配
        spec_big = normalize_spec({
            "mode": "rules",
            "checksum": {
                "algo": "crc16_modbus",
                "field_offset": len(payload),
                "field_byte_length": 2,
                "byte_order": "big",
            },
        })
        self.assertFalse(match_response(spec_big, self.SENT, frame)[0])

    def test_checksum_span_excludes_field_and_respects_span(self):
        payload = bytes([0x01, 0x02, 0x03, 0x04])
        # span 只取前 2 字节 → 01+02=03；字段放帧尾
        frame = payload + bytes([0x03])
        spec = normalize_spec({
            "mode": "rules",
            "checksum": {
                "algo": "sum",
                "field_offset": 4,
                "field_byte_length": 1,
                "span_start": 0,
                "span_end": 2,
            },
        })
        self.assertTrue(match_response(spec, self.SENT, frame)[0])
        # span 外的数据变化不影响（03→04），span 内变化会失配
        self.assertTrue(match_response(spec, self.SENT, bytes([0x01, 0x02, 0x09, 0x09, 0x03]))[0])
        self.assertFalse(match_response(spec, self.SENT, bytes([0x01, 0x99, 0x03, 0x04, 0x03]))[0])

    def test_rules_mode_skips_echo_compare(self):
        # rules 模式：字节不同但结构规则全过 → 通过（无回显比对）
        spec = normalize_spec({"mode": "rules", "prefix": "A5"})
        self.assertTrue(match_response(spec, self.SENT, b"\xA5\xFF\xEE\xDD")[0])

    def test_crc16_matches_checksum_handler(self):
        # 双端锚定：response_match.crc16 与 backend/handlers/checksum.py 实现一致
        handler = ChecksumHandler()
        for data in (b"", b"\x00", bytes(range(32)), b"YoRHa-VECTOR"):
            self.assertEqual(crc16(data), handler.crc16(bytearray(data)))


class VarintLengthTest(unittest.TestCase):
    """R28（PLAN §8.52 第 8 批 · §8.60 定案）：length.encoding = varint 的收侧判读。

    同一份规格必须同时吃下「设计期宽 1、出线宽 1」与「设计期宽 1、出线宽 2」两种帧 ——
    这正是 `expected = len(frame) + offset_val - (width - byte_length)` 回算项的作用
    （与 response_generate 求 offset_val 的口径改一必改二）。
    """

    # [FA FA][LEN=05][5 字节载荷] → 8 字节；LEN=5、出线宽 1 → 5 == 8 + (-3)
    NARROW = bytes.fromhex("FAFA05AABBCCDDEE")
    # [FA FA][LEN=8001][128 字节载荷] → 132 字节；LEN=128、出线宽 2 → 128 == 132-3-1
    WIDE = bytes.fromhex("FAFA8001") + bytes([0xAA]) * 128

    def _spec(self, with_encoding=True):
        length = {"offset": 2, "byte_length": 1, "offset_val": -3}
        if with_encoding:
            length["encoding"] = "varint"
        return normalize_spec({"mode": "rules", "echo_header_bytes": 2, "length": length})

    def test_same_spec_matches_both_wire_widths(self):
        spec = self._spec()
        for frame in (self.NARROW, self.WIDE):
            ok, reasons = match_response(spec, frame, frame)
            self.assertTrue(ok, msg=f"{frame.hex()} → {reasons}")

    def test_without_encoding_key_reads_fixed_width(self):
        """缺 encoding = 存量定宽口径 → 宽帧必然失配（两种形态确实不同，不是可互换）。"""
        spec = self._spec(with_encoding=False)
        self.assertTrue(match_response(spec, self.NARROW, self.NARROW)[0])
        ok, reasons = match_response(spec, self.WIDE, self.WIDE)
        self.assertFalse(ok)
        self.assertIn("LENGTH_MISMATCH(128!=129)", reasons)

    def test_truncated_varint_reports_invalid_not_mismatch(self):
        """读不出值（续位未收束 / 超值域）与读出的值对不上是两种病因 → 两个 reason 码。"""
        ok, reasons = match_response(self._spec(), self.NARROW, bytes.fromhex("FAFA80"))
        self.assertFalse(ok)
        self.assertTrue(reasons[0].startswith("LENGTH_VARINT_INVALID("), msg=reasons)
        # 8 字节续位未收束
        ok, reasons = match_response(self._spec(), self.NARROW, b"\xFA\xFA" + b"\x80" * 8)
        self.assertFalse(ok)
        self.assertTrue(reasons[0].startswith("LENGTH_VARINT_INVALID("), msg=reasons)
        # 8 字节收束但值超 2^53-1（FE 丢精度边界，与 framing.VARINT_MAX 同源）
        ok, reasons = match_response(
            self._spec(), self.NARROW, b"\xFA\xFA" + bytes([0xFF] * 7 + [0x7F])
        )
        self.assertFalse(ok)
        self.assertTrue(reasons[0].startswith("LENGTH_VARINT_INVALID("), msg=reasons)

    def test_position_out_of_range_still_reported_separately(self):
        """varint 的边界只卡「起点处至少 1 字节」—— 位置出界是另一个 reason。"""
        ok, reasons = match_response(self._spec(), self.NARROW, bytes.fromhex("FAFA"))
        self.assertFalse(ok)
        self.assertEqual(reasons, ["LENGTH_OUT_OF_RANGE"])

    def test_encoding_fixed_is_not_written_and_unknown_rejected(self):
        spec = normalize_spec({"length": {"offset": 1, "byte_length": 2, "encoding": "fixed"}})
        self.assertNotIn("encoding", spec["length"])  # 只写非缺省值 → 存量形态逐字节不变
        with self.assertRaises(ValueError) as ctx:
            normalize_spec({"length": {"offset": 1, "encoding": "leb128"}})
        self.assertIn("length.encoding 必须是 fixed/varint 之一", str(ctx.exception))

    def test_byte_order_kept_but_never_applied_to_varint(self):
        """两个键可共存（LEB128 字节序无关），byte_order 原样保留供 UI 显示。"""
        spec = normalize_spec({"length": {"offset": 1, "byte_length": 1, "byte_order": "little",
                                          "encoding": "varint"}})
        self.assertEqual(spec["length"]["byte_order"], "little")
        self.assertEqual(spec["length"]["encoding"], "varint")
        # little 与 big 判读结果相同（不走 apply_byte_order）
        frame = bytes.fromhex("FA05AABBCCDD")   # 6 字节；LEN=5、出线宽 1 → 5 == 6 + (-1)
        for order in ("big", "little"):
            spec = normalize_spec({"mode": "rules",
                                   "length": {"offset": 1, "byte_length": 1, "offset_val": -1,
                                              "encoding": "varint", "byte_order": order}})
            self.assertTrue(match_response(spec, frame, frame)[0], msg=order)


class CobsStageTest(unittest.TestCase):
    """R28：unpack.mode = cobs —— 分层剥层先 COBS 解码、再剥区内槽前后的本层字节。

    手写两层规格（协议 = [FA FA] + COBS 区 + [00 定界][ED]，区内 = inner_head BB +
    内层帧 + 区内无尾），与 `backend/tests/test_response_generate.py` 的生成侧口径对偶。
    """

    INNER = bytes.fromhex("A00102E0")          # 层0：prefix A0 / suffix E0
    HEAD = bytes.fromhex("FAFA")               # 层1 区外头部
    TAIL = bytes.fromhex("00ED")               # 层1 定界 00 + trailer ED

    @classmethod
    def _rx(cls, region):
        return cls.HEAD + region + cls.TAIL

    def _spec(self, inner_head=1):
        return normalize_spec({
            "mode": "rules",
            "stages": [
                {"prefix": "A0", "suffix": "E0", "echo_header_bytes": 0,
                 "unpack": {"head": 1, "trailer": 0}},
                {"prefix": "FAFA", "suffix": "ED", "echo_header_bytes": 2,
                 "unpack": {"head": 2, "trailer": 2, "mode": "cobs",
                            "inner_head": inner_head, "inner_trailer": 0}},
            ],
        })

    @staticmethod
    def _region(children_hex):
        """区内字节（无定界）→ COBS 出线区（与 framing.cobs_encode 同一口径）。"""
        return cobs_encode(bytes.fromhex(children_hex))

    def test_decode_peels_to_inner_frame(self):
        region = self._region("BB" + self.INNER.hex())
        rx = self._rx(region)
        ok, reasons = match_response(self._spec(), rx, rx)
        self.assertTrue(ok, msg=reasons)
        self.assertEqual(reasons, [])

    def test_corrupted_inner_is_tagged_with_inner_stage(self):
        region = self._region("BB" + "A10102E0")
        rx = self._rx(region)
        ok, reasons = match_response(self._spec(), rx, rx)
        self.assertFalse(ok)
        self.assertIn("STAGE[0].PREFIX_MISMATCH", reasons)  # 外层已剥干净 → 病因在内层

    def test_broken_cobs_region_stops_at_that_stage(self):
        # 码字节要 9 字节、区里只剩 3 字节 → 解码畸形
        rx = self._rx(bytes.fromhex("0ABBA001"))
        ok, reasons = match_response(self._spec(), rx, rx)
        self.assertFalse(ok)
        self.assertTrue(reasons[0].startswith("STAGE[1].UNPACK_COBS_INVALID("), msg=reasons)
        # 区内裸 0x00 = 定界没剥干净（unpack.trailer 少算了一个字节）
        rx = self._rx(bytes.fromhex("03BB00"))
        ok, reasons = match_response(self._spec(), rx, rx)
        self.assertFalse(ok)
        self.assertTrue(reasons[0].startswith("STAGE[1].UNPACK_COBS_INVALID("), msg=reasons)

    def test_decoded_region_too_short_is_its_own_reason(self):
        region = self._region("BB" + self.INNER.hex())
        rx = self._rx(region)
        ok, reasons = match_response(self._spec(inner_head=10), rx, rx)
        self.assertFalse(ok)
        self.assertEqual(reasons, ["STAGE[1].UNPACK_INNER_TOO_SHORT(5<=10)"])

    def test_cobs_mode_allows_empty_head_and_trailer(self):
        """「整层就是一个 COBS 区」本身可区分 → cobs 下 head/trailer 允许同为 0。"""
        spec = normalize_spec({
            "mode": "rules",
            "stages": [
                {"prefix": "A0", "suffix": "E0", "unpack": {"head": 1, "trailer": 0}},
                {"prefix": "", "suffix": "",
                 "unpack": {"head": 0, "trailer": 0, "mode": "cobs",
                            "inner_head": 0, "inner_trailer": 0}},
            ],
        })
        self.assertEqual(spec["stages"][1]["unpack"]["mode"], "cobs")

    def test_inner_geometry_rejected_in_slice_mode_and_unknown_mode(self):
        with self.assertRaises(ValueError) as ctx:
            normalize_spec({"mode": "rules", "stages": [
                {"prefix": "", "suffix": "", "unpack": {"head": 1, "trailer": 0, "inner_head": 1}},
            ]})
        self.assertIn("仅 mode=cobs 时有效", str(ctx.exception))
        with self.assertRaises(ValueError) as ctx:
            normalize_spec({"mode": "rules", "stages": [
                {"prefix": "", "suffix": "", "unpack": {"head": 1, "trailer": 0, "mode": "gzip"}},
            ]})
        self.assertIn("unpack.mode 必须是 slice/cobs 之一", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
