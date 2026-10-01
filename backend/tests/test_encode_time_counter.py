"""E1-6 (B8): TIME_ACCUMULATOR / AUTO_COUNTER 语义 — 双端 byte-equal 锚点。

向量表单一真相源 = vectors/time_counter.json（CP2b / D11-①）：本表与前端 InstructionEncoder.test.js 的 E1-6 TIME/AUTO 向量 同读这一份 JSON，新增/修改向量只写一处；跨语言特殊值约定（{"$v": "Infinity"/"-Infinity"/"NaN"} 包装对象）见 vectors/README.md。

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
from vectors.load_vectors import load_vectors

# 行形状（JSON 行）: (base_time, offset_ms, byte_len, value, expected_hex)
# CP2b (D11-①): 单一真相源 = vectors/time_counter.json · 表 time —— 两端同读一份，新增向量只写一处
TIME_VECTORS = load_vectors("time_counter", "time")

# 行形状（JSON 行）: # (value, start_val, step, max, byte_len, expected_hex)
# CP2b (D11-①): 单一真相源 = vectors/time_counter.json · 表 auto —— 两端同读一份，新增向量只写一处
AUTO_VECTORS = load_vectors("time_counter", "auto")


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
