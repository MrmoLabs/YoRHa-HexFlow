"""R23（§8.52 排期 · 挂账 ①）：TIME_EPOCH 绝对时间戳 —— 三处实现 + 计划补丁 + 白名单。

共享向量单一真相源 = `vectors/time_epoch.json`（本文件与前端
`timeEpoch.test.js` 同读一份，新增向量只写一处）。表内 unit（s/ms/MS）× now_ms ×
byte_len，期望值 = 规范式

    unit == 'ms' -> floor(now_ms)
    其余（缺省 's'）-> floor(now_ms // 1000)
    out = abs(raw) & ((1 << (8 * byte_len)) - 1)      # 定宽大端、高位截断

两处 BE 实现（改一必改二）：
1. `orchestrator.encode_time_epoch` —— 序列计划补丁（`sequence_plan`）与
   `field_blocks` 出线/设计期卡面共用；
2. `field_blocks` 的 `TIME_EPOCH` 分支（now 经 `fields_to_blocks(now=…)` 注入，
   与 FE `opts.now` 同名同单位）。
FE 侧对应 `InstructionEncoder` TIME_EPOCH 编码分支 + `useInstructionLanes`
设计期预览 + `sequenceView` 计划条目，与本文件 byte-equal（同读一份向量）。

口径（§0 纪律）：缺省 `unit='s'`；位宽不够只截低位、不报错（与通用整数路径
同口径，4 字节秒值覆盖到 2106、毫秒需 ≥5 字节）；now 非有限 → None（调用方不
覆盖 hex_value，保持既有 cfg.hex/zeros 现状，同 encode_time_accumulator）。
"""
import math
import unittest

from backend.core.orchestrator import encode_time_epoch
from backend.core.sequence_plan import apply_plan, normalize_plan
from backend.routers.datahub import compile_blocks, fields_to_blocks, frame_bytes
from backend.routers.instruction import KNOWN_OPS
from backend.routers.operator import SEED_TEMPLATES
from vectors.load_vectors import load_vectors

VECTORS = load_vectors("time_epoch")


def epoch_field(unit, byte_len):
    cfg = {} if unit is None else {"unit": unit}
    return {
        "id": "e", "name": "E", "op_code": "TIME_EPOCH",
        "byte_len": byte_len, "sequence": 0, "parent_id": None,
        "parameter_config": cfg,
    }


def frame_of(fields, now=None):
    return frame_bytes(
        compile_blocks(fields_to_blocks(fields, now=now))
    ).hex().upper()


class TestEncodeVectors(unittest.TestCase):
    def test_vectors_encode_byte_equal(self):
        for row in VECTORS:
            with self.subTest(unit=row["unit"], now=row["now_ms"]):
                got = encode_time_epoch(row["unit"], row["now_ms"], row["byte_len"])
                self.assertEqual(got, row["expected"])

    def test_vectors_end_to_end_through_field_blocks(self):
        # 出线全链路：fields_to_blocks(now=…) → compile → frame_bytes
        for row in VECTORS:
            with self.subTest(unit=row["unit"], now=row["now_ms"]):
                got = frame_of(
                    [epoch_field(row["unit"], row["byte_len"])], now=row["now_ms"]
                )
                self.assertEqual(got, row["expected"])

    def test_default_unit_is_seconds(self):
        # 缺省 / 非字符串一律按 's'（算子模板只出 s/ms，FE 同 toLowerCase 口径）
        self.assertEqual(
            encode_time_epoch(None, 1700000000000, 4),
            encode_time_epoch("s", 1700000000000, 4),
        )
        self.assertEqual(encode_time_epoch("", 1700000000000, 4), "6553F100")

    def test_width_truncates_high_bits_without_error(self):
        # 位宽不够 → 截低位（与通用整数路径同口径），不抛错
        self.assertEqual(encode_time_epoch("s", 1700000000000, 1), "F100"[-2:])
        self.assertEqual(
            encode_time_epoch("ms", 1700000000123, 2), "687B"
        )

    def test_invalid_now_returns_none(self):
        # now 契约外（非有限/布尔/字符串/None）→ None，调用方不覆盖 hex_value
        for bad in (float("nan"), float("inf"), float("-inf"), True, False, "1700000000000", None):
            with self.subTest(now=bad):
                self.assertIsNone(encode_time_epoch("s", bad, 4))

    def test_zero_now_is_epoch_origin(self):
        self.assertEqual(encode_time_epoch("s", 0, 4), "00000000")
        self.assertEqual(encode_time_epoch("ms", 0, 8), "0000000000000000")


class TestPlanDynamic(unittest.TestCase):
    def test_entry_valid_and_unit_normalized(self):
        for unit, want in [(None, "s"), ("s", "s"), ("MS", "ms"), ("ms", "ms")]:
            with self.subTest(unit=unit):
                item = {"op": "TIME_EPOCH", "offset": 1, "byte_len": 4}
                if unit is not None:
                    item["unit"] = unit
                _, plan = normalize_plan("A5" + "00" * 8, {"dynamic": [item]})
                entry = plan["dynamic"][0]
                self.assertEqual(entry["unit"], want)
                self.assertEqual(
                    set(entry), {"op", "offset", "byte_len", "unit"}
                )

    def test_unit_rejected_when_not_s_or_ms(self):
        for unit in ["min", "Ss", 123, None, True, ["s"]]:
            with self.subTest(unit=unit):
                with self.assertRaises(ValueError):
                    normalize_plan(
                        "A5" + "00" * 8,
                        {"dynamic": [{"op": "TIME_EPOCH", "offset": 1,
                                      "byte_len": 4, "unit": unit}]},
                    )

    def test_unknown_key_rejected(self):
        # 键集严格：epoch 条目不收 base_time（那是 TIME_ACCUMULATOR 的键）
        for key in ("base_time", "value", "step", "typo"):
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    normalize_plan(
                        "A5" + "00" * 8,
                        {"dynamic": [{"op": "TIME_EPOCH", "offset": 1,
                                      "byte_len": 4, key: "x"}]},
                    )

    def test_op_out_of_enum_rejected(self):
        for op in ["TIME_CLOCK", "EPOCH", "TIME_ACCUMULATOR_"]:
            with self.subTest(op=op):
                with self.assertRaises(ValueError):
                    normalize_plan(
                        "A5" + "00" * 8,
                        {"dynamic": [{"op": op, "offset": 1, "byte_len": 4}]},
                    )

    def test_patch_matches_encoder_and_keeps_length(self):
        payload = b"\xa5\x00\x00\x00\x0b"
        now = 1700000000000.0
        for unit in ("s", "ms"):
            with self.subTest(unit=unit):
                _, plan = normalize_plan(
                    payload.hex(),
                    {"dynamic": [{"op": "TIME_EPOCH", "offset": 1, "byte_len": 4,
                                  "unit": unit}]},
                )
                frame = apply_plan(payload, plan, now)
                self.assertEqual(len(frame), len(payload))  # 等长替换
                self.assertEqual(
                    frame[1:5], bytes.fromhex(encode_time_epoch(unit, now, 4))
                )
                self.assertEqual(
                    frame[0:1] + frame[5:], payload[0:1] + payload[5:]
                )

    def test_probe_width_validated_at_save(self):
        # 保存时试算：编码产物必须定宽 = byte_len（恒成立，因掩码按位宽取）
        _, plan = normalize_plan(
            "A5" + "00" * 16,
            {"dynamic": [{"op": "TIME_EPOCH", "offset": 1, "byte_len": 8}]},
        )
        self.assertEqual(plan["dynamic"][0]["byte_len"], 8)


class TestWhitelistAndTemplate(unittest.TestCase):
    def test_known_ops_contains_epoch(self):
        # 双端同源：FE constants.js OP_CODES 16 + legacy 5 = 21
        self.assertIn("TIME_EPOCH", KNOWN_OPS)
        self.assertEqual(len(KNOWN_OPS), 21)

    def test_operator_template_epoch(self):
        tpl = next((t for t in SEED_TEMPLATES if t["op_code"] == "TIME_EPOCH"), None)
        self.assertIsNotNone(tpl, "算子模板缺 TIME_EPOCH（指令管理下拉不出）")
        self.assertEqual(tpl["category"], "DYNAMIC")
        # unit 下拉 = s/ms（ParamConfigForm 数组型 → select）
        self.assertEqual(tpl["param_template"], {"unit": ["s", "ms"]})

    def test_epoch_not_treated_as_time_accumulator_keys(self):
        # _DYNAMIC_OPS 收三值，epoch 走独立键集
        import backend.core.sequence_plan as sp
        self.assertIn("TIME_EPOCH", sp._DYNAMIC_OPS)
        self.assertEqual(sp._EPOCH_KEYS, {"field_id", "op", "offset", "byte_len", "unit"})
        self.assertNotIn("base_time", sp._EPOCH_KEYS)
        self.assertTrue(math.isfinite(1700000000000.0))


if __name__ == "__main__":
    unittest.main()
