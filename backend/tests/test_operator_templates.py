"""N1 护栏批（PLAN §8.16 · G5/G6/G7）：算子模板 SEED 锁定测试。

- 模板 op_code 不得重复（调色板按 op 唯一键索引）；
- FLOAT_IEEE `param_template.bits` 首元素 = 新建字段默认位宽（Instruction.jsx
  只取 rawBits[0]）→ 必须保持 32：**R5（PLAN §8.42）起 float64 双端编码已支持**，
  但默认位宽仍不改 —— G7 定案「提醒而非改模板」，64 是用户按需手改的可选位宽，
  模板把 64 摆进首位会改变**所有新建字段的缺省出帧宽度**（行为变更，另排批）；
- 核心业务算子必须在席（调色板业务覆盖面锁定）；
- R24（§8.52 挂账 ③）：模板集 = KNOWN_OPS − STRUCT − encoder legacy 5 —— 属性面板的
  「切算子」下拉与调色板同源取「有模板的算子」，少一个模板就等于那个算子切不过去。
"""
import unittest

from backend.routers.instruction import KNOWN_OPS
from backend.routers.operator import SEED_TEMPLATES


class TestOperatorTemplates(unittest.TestCase):
    def test_seed_op_codes_unique(self):
        codes = [t["op_code"] for t in SEED_TEMPLATES]
        self.assertEqual(len(codes), len(set(codes)), f"duplicate op_code in SEED: {codes}")

    def test_float_bits_default_is_32(self):
        float_t = next(t for t in SEED_TEMPLATES if t["op_code"] == "FLOAT_IEEE")
        bits = float_t["param_template"]["bits"]
        self.assertEqual(bits[0], 32, "新建字段默认位宽必须是 32（64 是可选位宽不进默认 —— G7 定案；R5 §8.42 起 8 字节双端已支持，模板仍不动）")

    def test_seed_covers_core_business_ops(self):
        codes = {t["op_code"] for t in SEED_TEMPLATES}
        for op in ("HEX_RAW", "INT_UNSIGNED", "INT_SIGNED", "BCD_CODE",
                   "BITFIELD", "MAPPING", "ARRAY_GROUP", "LENGTH_CALC", "CHECKSUM_CRC"):
            self.assertIn(op, codes)

    def test_string_template_present(self):
        """N2 (G2): STRING 文本字段模板在席（BASE 分类 + value/encoding/pad_char 参数入口）。"""
        t = next((x for x in SEED_TEMPLATES if x["op_code"] == "STRING"), None)
        self.assertIsNotNone(t, "N2 (G2) 缺 STRING 模板：文本字段无创建入口")
        self.assertEqual(t["category"], "BASE")
        pt = t["param_template"]
        self.assertEqual(pt["value"], "string")
        self.assertEqual(pt["encoding"], ["ascii", "utf8"])
        self.assertEqual(pt["pad_char"], "00")

    def test_seed_is_exactly_the_switchable_op_set(self):
        """R24：可切换算子集 = 模板集 —— KNOWN_OPS 里除 STRUCT（无模板、不进调色板）与
        encoder legacy 5（只读容忍、无创建入口）之外必须逐个在席：少一个模板 = 那个算子
        在「切算子」下拉里切不过去（FE switchableOps 同源同判）。"""
        codes = {t["op_code"] for t in SEED_TEMPLATES}
        expected = set(KNOWN_OPS) - {"STRUCT", "INPUT", "FIXED", "HEADER", "TAIL", "CALCULATED"}
        self.assertEqual(codes, expected, f"模板集与可切换算子集漂移：{sorted(codes ^ expected)}")


if __name__ == "__main__":
    unittest.main()
