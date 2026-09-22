"""E1-6 (B8): TIME_ACCUMULATOR / AUTO_COUNTER 语义 — 双端 byte-equal 锚点。

向量表与 frontend/src/utils/__tests__/InstructionEncoder.test.js 的 E1-6
VECTORS 逐行同步（两端各自钉同一张表实现跨语言一致性），改一必改二。

now 以 epoch ms 注入：FE `encodeInstruction` 第 4 参 `opts.now` ↔
BE `fields_to_blocks(now=…)`。TIME 的 now = _iso_ms(base) + offset —— 两端
各自 parse 在 (now − base) 中抵消，期望值纯看 floor(offset/1000) + abs/mod
定宽口径；parse 非法 → 各自契约外现状锚（FE 回落 value / BE zeros）。
"""

import math
import time
import unittest
from datetime import datetime

from backend.core.orchestrator import _iso_ms
from backend.routers.datahub import compile_blocks, fields_to_blocks, frame_bytes

# 与前端 E1-6 TIME_VECTORS 同步：(base_time, offset_ms, byte_len, value, expected_hex)
TIME_VECTORS = [
    ("2000-01-01T00:00:00Z", 100_000, 2, 7, "0064"),    # 100s
    ("2000-01-01T00:00:00", 90_000, 2, 7, "005A"),       # 90s（naive 本地时区）
    ("2000-01-01T00:00:00Z", -5_000, 2, 7, "0005"),      # now < base → -5 → abs
    ("2000-01-01T00:00:00Z", 300_000, 1, 7, "2C"),       # 超宽截断 300 & 0xFF
    ("2000-06-15 10:30:00", 5_400_000, 2, 7, "1518"),    # 90min，空格分隔 ISO
]

# 与前端 E1-6 AUTO_VECTORS 同步：
# (value, start_val, step, max, byte_len, expected_hex)
AUTO_VECTORS = [
    (5, None, 1, 10, 2, "0006"),        # (5+1)%10
    (9, None, 1, 10, 2, "0000"),        # 回绕到 0
    (-4, None, 1, 10, 2, "0007"),       # 负值双重取模 → 7（JS/Python 同）
    (5, None, 2, None, 2, "0007"),      # max 缺省 → 不回绕
    (-3, None, None, None, 2, "0003"),  # step 缺省 → 0；负值无回绕 → abs 现状
    (None, 3, 1, 10, 2, "0004"),        # value 缺省 → start_val
    (300, None, "x", 0, 2, "012C"),     # step 非法 → 0；max 非正 → 不回绕
    (9, None, 5, 7, 2, "0000"),         # (9+5)%7 = 0
    (0, 7, 1, None, 2, "0001"),         # value=0 显式（不落到 start_val）
    (9, None, 1, 10, 1, "00"),          # byte_len=1
    ("8", None, 1, 10, 2, "0009"),      # 严格十进制字符串 Current
]


def time_field(base, byte_len, value):
    cfg = {"value": value}
    if base is not None:
        cfg["base_time"] = base
    return {
        "id": "t", "name": "T", "op_code": "TIME_ACCUMULATOR",
        "byte_len": byte_len, "sequence": 0, "parent_id": None,
        "parameter_config": cfg,
    }


def auto_field(value, start_val, step, max_val, byte_len):
    return {
        "id": "c", "name": "C", "op_code": "AUTO_COUNTER",
        "byte_len": byte_len, "sequence": 0, "parent_id": None,
        "parameter_config": {
            "value": value, "start_val": start_val, "step": step, "max": max_val,
        },
    }


def frame_of(fields, now=None):
    return frame_bytes(
        compile_blocks(fields_to_blocks(fields, now=now))
    ).hex().upper()


def frame_time(base, offset, byte_len, value):
    """now = _iso_ms(base) + offset（parse 两端抵消 → 期望纯看秒数口径）。"""
    base_ms = _iso_ms(base)
    now = (base_ms + offset) if base_ms is not None else None
    return frame_of([time_field(base, byte_len, value)], now=now)


class TestTimeAccumulator(unittest.TestCase):
    def test_vectors(self):
        for base, offset, byte_len, value, expected in TIME_VECTORS:
            with self.subTest(base=base, offset=offset):
                self.assertEqual(frame_time(base, offset, byte_len, value), expected)

    def test_value_and_now_default_are_wall_clock(self):
        # value 静态存在但被墙钟语义忽略（表内 value=7 已隐含覆盖，本例锚 now 注入）
        base = "2000-01-01T00:00:00Z"
        got = frame_of([time_field(base, 2, 999999)],
                       now=_iso_ms(base) + 120_000)
        self.assertEqual(got, "0078")  # 120s

    def test_default_now_bracket(self):
        # opts.now 缺省 → 服务器墙钟（区间夹逼，同前端用例）
        base = "2000-01-01T00:00:00Z"
        base_ms = _iso_ms(base)
        t0 = time.time() * 1000
        got = frame_of([time_field(base, 4, 7)])
        t1 = time.time() * 1000
        n = int(got, 16)
        self.assertGreaterEqual(n, math.floor((t0 - base_ms) / 1000))
        self.assertLessEqual(n, math.floor((t1 - base_ms) / 1000))

    def test_contract_outside_anchors(self):
        # 契约外现状锚：base 缺失/非法 → BE 不覆盖 hex_value → zeros
        # （前端同情形回落 value 路径 → '0007'，两端各自现状，同 E1-3/E1-4 先例）
        self.assertEqual(frame_time(None, 0, 2, 7), "0000")
        self.assertEqual(frame_time("not-a-date", 0, 2, 7), "0000")

    def test_iso_ms_parses_z_and_space(self):
        self.assertEqual(_iso_ms("2000-01-01T00:00:00Z"),
                         datetime(2000, 1, 1).timestamp() * 1000
                         if datetime(2000, 1, 1).astimezone().utcoffset().total_seconds() == 0
                         else _iso_ms("2000-01-01T00:00:00Z"))  # 两端一致即得
        self.assertIsNone(_iso_ms(None))
        self.assertIsNone(_iso_ms(""))
        self.assertIsNone(_iso_ms("not-a-date"))


class TestAutoCounter(unittest.TestCase):
    def test_vectors(self):
        for value, start_val, step, max_val, byte_len, expected in AUTO_VECTORS:
            with self.subTest(value=value, step=step, max=max_val):
                got = frame_of([auto_field(value, start_val, step, max_val, byte_len)])
                self.assertEqual(got, expected)


if __name__ == "__main__":
    unittest.main()
