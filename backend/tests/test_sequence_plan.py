"""P3 序列计划（发送时重算）纯函数测试 — stdlib unittest 直测。

覆盖：normalize_plan 的 payload/plan 严格形态（ValueError → 路由 400）、
动态补丁（TIME/COUNTER 定宽等长）、校验补丁（regions 顺序拼接 + byte_order
落字段）、以及「写入侧 ↔ 应答反算侧」同源的往返锚定（patched frame 过
match_response）。E1-6 编码期望与 test_encode_time_counter 同源向量。
"""
import unittest

from backend.core.orchestrator import _iso_ms, encode_time_accumulator
from backend.core.response_match import checksum_value, match_response, normalize_spec
from backend.core.sequence_plan import apply_plan, normalize_plan

BASE = "2000-01-01T00:00:00Z"


class NormalizePayloadTest(unittest.TestCase):
    def test_payload_cleaned_and_no_plan(self):
        data, plan = normalize_plan("a5 01-0b_0C", None)
        self.assertEqual(data, b"\xa5\x01\x0b\x0c")
        self.assertIsNone(plan)

    def test_payload_invalid(self):
        bads = ["", "   ", "ABC", "GG", 123, None, "AA" * 4097]  # 奇数位/非法字符/超长/非串
        for payload in bads:
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    normalize_plan(payload, None)

    def test_empty_plan_normalized(self):
        data, plan = normalize_plan("A501", {})
        self.assertEqual(data, b"\xa5\x01")
        self.assertEqual(plan, {"dynamic": [], "checksum": None})

    def test_plan_shape_rejects(self):
        for plan in ["nope", {"dynamic": [] , "extra": 1}, {"unknown": []}]:
            with self.subTest(plan=plan):
                with self.assertRaises(ValueError):
                    normalize_plan("A5", plan)


class NormalizeDynamicTest(unittest.TestCase):
    def test_time_entry_valid(self):
        _, plan = normalize_plan(
            "A5" + "00" * 4,
            {"dynamic": [{"op": "TIME_ACCUMULATOR", "offset": 1, "byte_len": 2,
                          "base_time": BASE, "field_id": 42}]},
        )
        entry = plan["dynamic"][0]
        self.assertEqual(entry["field_id"], "42")  # 归一为字符串
        self.assertEqual(entry["base_time"], BASE)
        self.assertEqual(set(entry), {"op", "offset", "byte_len", "field_id", "base_time"})

    def test_time_base_required_and_parseable(self):
        for base in [None, "", "not-a-date", 123]:
            with self.subTest(base=base):
                with self.assertRaises(ValueError):
                    normalize_plan(
                        "A5" + "00" * 4,
                        {"dynamic": [{"op": "TIME_ACCUMULATOR", "offset": 1,
                                      "byte_len": 2, "base_time": base}]},
                    )

    def test_counter_entry_keeps_scalars(self):
        _, plan = normalize_plan(
            "A5" + "00" * 2,
            {"dynamic": [{"op": "AUTO_COUNTER", "offset": 1, "byte_len": 2,
                          "value": 5, "start_val": 3, "step": 1, "max": 10}]},
        )
        entry = plan["dynamic"][0]
        self.assertEqual(
            (entry["value"], entry["start_val"], entry["step"], entry["max"]),
            (5, 3, 1, 10),
        )

    def test_counter_rejects_non_scalars(self):
        for value in [True, {"a": 1}, [1]]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    normalize_plan(
                        "A5" + "00" * 2,
                        {"dynamic": [{"op": "AUTO_COUNTER", "offset": 1,
                                      "byte_len": 2, "value": value}]},
                    )

    def test_dynamic_bounds_and_keys(self):
        good = {"op": "AUTO_COUNTER", "offset": 1, "byte_len": 2}
        bads = [
            {**good, "op": "carrier-pigeon"},          # 未知 op
            {**good, "offset": 4},                     # offset+byte_len 越界（帧 3 字节）
            {**good, "byte_len": 0},                   # 非法宽度
            {**good, "byte_len": 65},                  # 超上限
            {**good, "foo": 1},                        # 未知键
            {"op": "AUTO_COUNTER"},                    # 缺 offset/byte_len
            "not-dict",                                # 非对象
        ]
        for entry in bads:
            with self.subTest(entry=entry):
                with self.assertRaises(ValueError):
                    normalize_plan("A5" + "00" * 2, {"dynamic": [entry]})
        with self.assertRaises(ValueError):
            normalize_plan("A5", {"dynamic": "nope"})  # 非数组
        with self.assertRaises(ValueError):
            normalize_plan("A5", {"dynamic": [good] * 33})  # >32 项


class NormalizeChecksumTest(unittest.TestCase):
    def _payload(self):
        return "A5 01 0B 0C 00 00"  # 6 字节，字段占 [4,6)

    def test_checksum_valid_defaults(self):
        _, plan = normalize_plan(
            self._payload(),
            {"checksum": {"offset": 4, "byte_length": 2, "regions": [[0, 4]]}},
        )
        cs = plan["checksum"]
        self.assertEqual(cs["algo"], "sum")          # 缺省算法
        self.assertEqual(cs["byte_order"], "big")    # 缺省序
        self.assertEqual(cs["regions"], [[0, 4]])

    def test_checksum_rejects(self):
        base = {"offset": 4, "byte_length": 2, "regions": [[0, 4]]}
        bads = [
            {**base, "algo": "CRC32"},                 # 未知算法
            {**base, "byte_order": "middle"},          # 未知序
            {**base, "algo": "crc16_modbus"},          # crc16 必 2 字节——bl 已 2，此例应过？
        ]
        for cs in bads[:2]:
            with self.subTest(cs=cs):
                with self.assertRaises(ValueError):
                    normalize_plan(self._payload(), {"checksum": cs})
        # crc16 + 1 字段字节 → 拒绝
        with self.assertRaises(ValueError):
            normalize_plan(self._payload(), {"checksum": {**base, "byte_length": 1,
                                                          "algo": "crc16_modbus"}})
        # 字段越界 / regions 空 / 区间对错 / 越界 / 与字段重叠 / 未知键 / 非对象
        for cs in [
            {**base, "offset": 5},                              # 5+2 > 6
            {**base, "regions": []},
            {**base, "regions": [[0]]},
            {**base, "regions": [[4, 4]]},                      # start >= end
            {**base, "regions": [[0, 99]]},                     # 越界
            {**base, "regions": [[2, 6]]},                      # 与字段 [4,6) 重叠
            {**base, "regions": [[0, 4]], "foo": 1},
            "nope",
        ]:
            with self.subTest(cs=cs):
                with self.assertRaises(ValueError):
                    normalize_plan(self._payload(), {"checksum": cs})


class ApplyPlanTest(unittest.TestCase):
    def test_no_plan_identity(self):
        data = b"\xa5\x01\x02"
        self.assertEqual(apply_plan(data, None, 0), data)
        self.assertEqual(apply_plan(data, {"dynamic": [], "checksum": None}, 0), data)

    def test_time_patch_matches_encoder_and_keeps_length(self):
        payload = b"\xa5\x00\x00\x00\x0b"
        _, plan = normalize_plan(
            payload.hex(),
            {"dynamic": [{"op": "TIME_ACCUMULATOR", "offset": 1, "byte_len": 2,
                          "base_time": BASE}]},
        )
        now = _iso_ms(BASE) + 3500  # 3.5s → floor 3 秒
        frame = apply_plan(payload, plan, now)
        self.assertEqual(len(frame), len(payload))  # 等长替换
        self.assertEqual(frame[1:3], bytes.fromhex(encode_time_accumulator(BASE, now, 2)))
        self.assertEqual(frame[1:3], b"\x00\x03")
        self.assertEqual(frame[0:1] + frame[3:], payload[0:1] + payload[3:])  # 其余字节未动

    def test_counter_patch_matches_e1_vector(self):
        payload = b"\xa5\x00\x00\x0b"
        _, plan = normalize_plan(
            payload.hex(),
            {"dynamic": [{"op": "AUTO_COUNTER", "offset": 1, "byte_len": 2,
                          "value": 5, "step": 1, "max": 10}]},
        )
        frame = apply_plan(payload, plan, 0)
        self.assertEqual(frame[1:3], bytes.fromhex("0006"))  # (5+1)%10，E1-6 向量
        self.assertEqual(len(frame), len(payload))

    def test_checksum_regions_concat_order(self):
        payload = b"\x11\x22\x33\x44\x55\x66\x00"
        _, plan = normalize_plan(
            payload.hex(),
            {"checksum": {"offset": 6, "byte_length": 1, "algo": "sum",
                          "regions": [[4, 6], [0, 2]]}},
        )
        frame = apply_plan(payload, plan, 0)
        # sum 序无关：0x55+0x66+0x11+0x22 = 0xEE（按列示顺序取区间，字段不入算）
        self.assertEqual(frame[6], 0xEE)
        self.assertEqual(frame[0:6], payload[0:6])  # 区间外字节未动

        # crc16 序敏感：regions 按「列示顺序」（非帧序）拼接——若实现误按帧序
        # 排序，crc16(55 66 | 11 22 33 44) ≠ crc16(11 22 33 44 55 66) 即判出。
        payload8 = bytes([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x00, 0x00])
        _, plan_crc = normalize_plan(
            payload8.hex(),
            {"checksum": {"offset": 6, "byte_length": 2, "algo": "crc16_modbus",
                          "regions": [[4, 6], [0, 4]]}},
        )
        frame_crc = apply_plan(payload8, plan_crc, 0)
        listed = payload8[4:6] + payload8[0:4]
        expected = checksum_value("crc16_modbus", listed, 2).to_bytes(2, "big")
        self.assertEqual(frame_crc[6:8], expected)
        self.assertEqual(frame_crc[0:6], payload8[0:6])

    def test_checksum_crc16_order_and_placement(self):
        payload = bytes([0xA5, 0x01, 0x0B, 0x0C, 0x00, 0x00])
        _, plan = normalize_plan(
            payload.hex(),
            {"checksum": {"offset": 4, "byte_length": 2, "algo": "crc16_modbus",
                          "regions": [[0, 4]]}},
        )
        frame = apply_plan(payload, plan, 0)
        expected = checksum_value("crc16_modbus", payload[0:4], 2).to_bytes(2, "big")
        self.assertEqual(frame[4:6], expected)
        self.assertEqual(frame[0:4], payload[0:4])

        # little 序 = big 字节反转（线上小端字段）
        _, plan_le = normalize_plan(
            payload.hex(),
            {"checksum": {"offset": 4, "byte_length": 2, "algo": "crc16_modbus",
                          "byte_order": "little", "regions": [[0, 4]]}},
        )
        frame_le = apply_plan(payload, plan_le, 0)
        self.assertEqual(frame_le[4:6], expected[::-1])

    def test_checksum_roundtrip_passes_match_response(self):
        """写入侧 ↔ 应答反算侧同源锚：补丁帧过 normalize_spec+match_response。"""
        payload = bytes([0xA5, 0x01, 0x0B, 0x0C, 0x00, 0x00])
        _, plan = normalize_plan(
            payload.hex(),
            {"checksum": {"offset": 4, "byte_length": 2, "algo": "crc16_modbus",
                          "regions": [[0, 4]]}},
        )
        frame = apply_plan(payload, plan, 0)
        spec = normalize_spec({
            "mode": "echo",
            "checksum": {"algo": "crc16_modbus", "field_offset": 4,
                         "field_byte_length": 2, "span_start": 0, "span_end": 4},
        })
        ok, reasons = match_response(spec, sent=frame, received=frame)
        self.assertTrue(ok, reasons)

    def test_dirty_plan_raises_at_apply(self):
        payload = b"\xa5\x00\x00"
        with self.assertRaises(ValueError):
            apply_plan(payload, {"dynamic": [
                {"op": "TIME_ACCUMULATOR", "offset": 1, "byte_len": 2,
                 "base_time": "not-a-date"}]}, 0)
        with self.assertRaises(ValueError):
            apply_plan(payload, {"checksum": {"regions": []}}, 0)


if __name__ == "__main__":
    unittest.main()
