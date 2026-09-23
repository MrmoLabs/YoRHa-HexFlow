"""批次四 (R2 打通): LengthHandler / ChecksumHandler 的 refs 集合模式。

背景: 协议页 length/checksum 的前端 SSOT 是 parameter_config.refs，此前
后端导出侧只拿到死 config={} —— range（target_start_id/target_end_id）
永不启动、恒输出 00。批次四起 frontend/toFrameBlocks.js 在出口把 refs
（按数组序展开的叶子 id 列表）+ 算法枚举翻译进 config.params，handlers
优先走本文件锚定的集合模式；无 refs 键的旧 range 模式原样保留（回归向量
也在本文件末尾）。
"""
import unittest

from backend.handlers.checksum import ChecksumHandler
from backend.handlers.length import LengthHandler
from backend.schemas.block import Block, BlockConfig


def mk(bid, *, hex_value=None, byte_length=1, btype="fixed", enabled=True, config=None):
    return Block(
        id=bid,
        type=btype,
        label=bid,
        byte_length=byte_length,
        hex_value=hex_value,
        is_enabled=enabled,
        config=config,
    )


def flat(*blocks):
    return [("global", b) for b in blocks]


class LengthRefsMode(unittest.TestCase):
    def test_sums_exact_refs_noncontiguous(self):
        # 集合语义: refs=[a, c] 必须恰好 2+4=6 —— range 模式会把中间的 b
        # (3B) 也卷进来，这正是不采用 target_start/end 的原因。
        a = mk("a", byte_length=2)
        b = mk("b", byte_length=3)
        c = mk("c", byte_length=4)
        blk = mk("L", btype="length", byte_length=2,
                 config=BlockConfig(params={"refs": ["a", "c"]}))
        self.assertEqual(LengthHandler().calculate(blk, flat(a, b, c)), "0006")

    def test_skips_self_slot_disabled_and_unknown(self):
        a = mk("a", byte_length=2)
        slot = mk("s", byte_length=5, btype="slot")
        off = mk("x", byte_length=7, enabled=False)
        ghost = mk("g", byte_length=9)  # 不在流里
        blk = mk("a", btype="length", byte_length=1,
                 config=BlockConfig(params={"refs": ["a", "s", "x", "ghost"]}))
        # 自身/slot/禁用/缺席 全跳过 → 0
        self.assertEqual(LengthHandler().calculate(blk, flat(a, slot, off, ghost, blk)), "00")

    def test_empty_refs_returns_offset_only(self):
        a = mk("a", byte_length=2)
        blk = mk("L", btype="length", byte_length=2,
                 config=BlockConfig(params={"refs": [], "offset": 1}))
        # 空集 → count=0，但显式 offset 仍生效（与前端无 refs Σ=0 同源缺省 0）
        self.assertEqual(LengthHandler().calculate(blk, flat(a)), "0001")

    def test_no_config_still_zeros(self):
        blk = mk("L", btype="length", byte_length=2, config=None)
        self.assertEqual(LengthHandler().calculate(blk, flat(mk("a"))), "0000")


class ChecksumRefsMode(unittest.TestCase):
    def test_sum_and_xor_by_refs(self):
        a = mk("a", hex_value="01")
        b = mk("b", hex_value="02")
        c = mk("c", hex_value="FF")
        sum_blk = mk("C", btype="checksum", byte_length=1,
                     config=BlockConfig(params={"refs": ["a", "b"], "algorithm": "sum"}))
        xor_blk = mk("C", btype="checksum", byte_length=1,
                     config=BlockConfig(params={"refs": ["a", "b"], "algorithm": "xor"}))
        self.assertEqual(ChecksumHandler().calculate(sum_blk, flat(a, b, c)), "03")
        self.assertEqual(ChecksumHandler().calculate(xor_blk, flat(a, b, c)), "03")  # 01^02
        xor_all = mk("C", btype="checksum", byte_length=1,
                     config=BlockConfig(params={"refs": ["a", "b", "c"], "algorithm": "xor"}))
        self.assertEqual(ChecksumHandler().calculate(xor_all, flat(a, b, c)), "FC")  # 01^02^FF

    def test_crc16_follows_refs_array_order(self):
        # CRC 对字节序敏感：refs 数组序 = 前端 PASS2 拼接序（非流序）
        a = mk("a", hex_value="01")
        b = mk("b", hex_value="02")
        handler = ChecksumHandler()
        fwd = mk("C", btype="checksum", byte_length=2,
                 config=BlockConfig(params={"refs": ["a", "b"], "algorithm": "crc16_modbus"}))
        rev = mk("C", btype="checksum", byte_length=2,
                 config=BlockConfig(params={"refs": ["b", "a"], "algorithm": "crc16_modbus"}))
        expect_fwd = f"{handler.crc16(bytearray([0x01, 0x02])):04X}"
        expect_rev = f"{handler.crc16(bytearray([0x02, 0x01])):04X}"
        self.assertEqual(handler.calculate(fwd, flat(a, b)), expect_fwd)
        self.assertEqual(handler.calculate(rev, flat(a, b)), expect_rev)
        self.assertNotEqual(expect_fwd, expect_rev)  # 向量本身必须有序敏感

    def test_empty_refs_all_algos_return_zeros(self):
        # 前端 calculateChecksum 对空字节恒 0（PASS2 亦有 refs.length>0 闸）；
        # crc16 空数据会得 0xFFFF —— 集合模式必须在算法前短路为全 0。
        a = mk("a", hex_value="01")
        for algorithm in ("sum", "xor", "crc16_modbus"):
            blk = mk("C", btype="checksum", byte_length=2,
                     config=BlockConfig(params={"refs": [], "algorithm": algorithm}))
            self.assertEqual(ChecksumHandler().calculate(blk, flat(a)), "0000", algorithm)

    def test_hex_with_spaces_cleaned_and_bad_hex_skipped(self):
        a = mk("a", hex_value="DE AD")
        bad = mk("b", hex_value="ZZ")
        blk = mk("C", btype="checksum", byte_length=1,
                 config=BlockConfig(params={"refs": ["a", "b"], "algorithm": "sum"}))
        # 空格清洗后 0xDE+0xAD=0x18B → 按 1B 宽度 mod 256 = 0x8B；
        # 非法 hex 块静默跳过（与 range 模式 fromhex 失败口径一致）
        self.assertEqual(ChecksumHandler().calculate(blk, flat(a, bad)), "8B")

    def test_contiguous_refs_match_range_mode(self):
        # 一致性锚: refs 恰好是连续区间时，集合模式与旧 range 模式同值
        a = mk("a", hex_value="11")
        b = mk("b", hex_value="22")
        c = mk("c", hex_value="33")
        set_mode = mk("C", btype="checksum", byte_length=1,
                      config=BlockConfig(params={"refs": ["a", "b", "c"], "algorithm": "sum"}))
        range_mode = mk("C", btype="checksum", byte_length=1,
                        config=BlockConfig(target_start_id="a", target_end_id="c",
                                           params={"algorithm": "sum"}))
        handler = ChecksumHandler()
        self.assertEqual(
            handler.calculate(set_mode, flat(a, b, c)),
            handler.calculate(range_mode, flat(a, b, c)),
        )

    def test_no_config_still_zeros(self):
        blk = mk("C", btype="checksum", byte_length=1, config=None)
        self.assertEqual(ChecksumHandler().calculate(blk, flat(mk("a"))), "00")


class RangeModeRegression(unittest.TestCase):
    """无 refs 键的旧 range 契约（graph/模板侧在用）必须原样工作。"""

    def test_length_range_counts_start_to_end(self):
        a = mk("a", byte_length=2)
        b = mk("b", byte_length=3)
        c = mk("c", byte_length=4)
        blk = mk("L", btype="length", byte_length=2,
                 config=BlockConfig(target_start_id="a", target_end_id="b", params={}))
        self.assertEqual(LengthHandler().calculate(blk, flat(a, b, c)), "0005")

    def test_checksum_range_default_algo_sum(self):
        a = mk("a", hex_value="10")
        b = mk("b", hex_value="20")
        blk = mk("C", btype="checksum", byte_length=1,
                 config=BlockConfig(target_start_id="a", target_end_id="b", params={}))
        self.assertEqual(ChecksumHandler().calculate(blk, flat(a, b)), "30")


if __name__ == "__main__":
    unittest.main()
