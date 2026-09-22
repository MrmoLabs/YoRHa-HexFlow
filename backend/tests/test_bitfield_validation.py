"""C2：位域保存时后端强校验（stdlib unittest，无新增依赖）。

覆盖交接待办 5：前端 P0-2 已阻断，直连 API 不得入库重叠/超容量位域。

运行（仓库根目录）：
    python -m unittest backend.tests.test_bitfield_validation -v
"""
import unittest

from fastapi import HTTPException

from backend.routers.instruction import _validate_bitfields
from backend.schemas.instruction_api import BitFieldSchema, InstructionFieldSchema


def bitfield(byte_len=1, bits=(), name="状态位域"):
    """bits: [(bit_name, start_bit, bit_len), ...]"""
    return InstructionFieldSchema(
        name=name,
        op_code="BITFIELD",
        byte_len=byte_len,
        bits=[
            BitFieldSchema(bit_name=n, start_bit=s, bit_len=l)
            for (n, s, l) in bits
        ],
    )


class TestBitfieldValidation(unittest.TestCase):
    def test_overlap_rejected(self):
        # A:[0,5) 与 B:[4,…) → start 4 < prevEnd 5 → 400
        with self.assertRaises(HTTPException) as ctx:
            _validate_bitfields([bitfield(byte_len=2, bits=[("A", 0, 5), ("B", 4, 5)])])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("位域重叠", ctx.exception.detail)

    def test_overlap_detected_after_sorting(self):
        # 输入顺序打乱仍按 start_bit 判定（B 先于 A 传入）
        with self.assertRaises(HTTPException) as ctx:
            _validate_bitfields([bitfield(byte_len=2, bits=[("B", 4, 5), ("A", 0, 5)])])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("位域重叠", ctx.exception.detail)

    def test_over_capacity_rejected(self):
        # 1B = 8 bits，单 bit 长 9 → Σ9 > 8 → 400
        with self.assertRaises(HTTPException) as ctx:
            _validate_bitfields([bitfield(byte_len=1, bits=[("A", 0, 9)])])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("位域超出容量", ctx.exception.detail)

    def test_valid_layout_passes(self):
        # 正常：半字节对齐两段，不抛
        _validate_bitfields([bitfield(byte_len=1, bits=[("A", 0, 4), ("B", 4, 4)])])

    def test_adjacent_bits_are_not_overlap(self):
        # 紧邻（start == prevEnd）不算重叠；2B 满铺 Σ16 == 16 不算超容
        _validate_bitfields([bitfield(byte_len=2, bits=[("A", 0, 8), ("B", 8, 8)])])

    def test_empty_inputs_pass(self):
        _validate_bitfields(None)
        _validate_bitfields([])
        _validate_bitfields([bitfield(byte_len=1, bits=[])])  # 无 bits

    def test_non_bitfield_fields_skipped(self):
        _validate_bitfields([InstructionFieldSchema(
            name="raw", op_code="HEX_RAW", byte_len=1,
            bits=[BitFieldSchema(bit_name="X", start_bit=0, bit_len=9)],
        )])  # 非 BITFIELD 即便带 bits 也不校验

    def test_zero_byte_len_skips_capacity(self):
        # byte_len 未设（0）不判容量 — 与前端 totalBits > 0 门槛一致
        _validate_bitfields([bitfield(byte_len=0, bits=[("A", 0, 9)])])


if __name__ == "__main__":
    unittest.main()
