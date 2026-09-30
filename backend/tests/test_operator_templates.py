"""N1 护栏批（PLAN §8.16 · G5/G6/G7）：算子模板 SEED 锁定测试。

- 模板 op_code 不得重复（调色板按 op 唯一键索引）；
- FLOAT_IEEE `param_template.bits` 首元素 = 新建字段默认位宽（Instruction.jsx
  只取 rawBits[0]）→ 必须保持 32：float64 是 E1-4 已知范围外，模板若把 64
  摆进首位会让新字段直接落 FE 整数路径 / BE zeros 的两端不一致陷阱（G7）；
- 核心业务算子必须在席（调色板业务覆盖面锁定）。
"""
import unittest

from backend.routers.operator import SEED_TEMPLATES


class TestOperatorTemplates(unittest.TestCase):
    def test_seed_op_codes_unique(self):
        codes = [t["op_code"] for t in SEED_TEMPLATES]
        self.assertEqual(len(codes), len(set(codes)), f"duplicate op_code in SEED: {codes}")

    def test_float_bits_default_is_32(self):
        float_t = next(t for t in SEED_TEMPLATES if t["op_code"] == "FLOAT_IEEE")
        bits = float_t["param_template"]["bits"]
        self.assertEqual(bits[0], 32, "新建字段默认位宽必须是 32（float64 范围外，G7）")

    def test_seed_covers_core_business_ops(self):
        codes = {t["op_code"] for t in SEED_TEMPLATES}
        for op in ("HEX_RAW", "INT_UNSIGNED", "INT_SIGNED", "BCD_CODE",
                   "BITFIELD", "MAPPING", "ARRAY_GROUP", "LENGTH_CALC", "CHECKSUM_CRC"):
            self.assertIn(op, codes)
