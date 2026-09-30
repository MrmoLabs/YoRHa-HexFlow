"""N5 (G4 · PLAN §8.16): 字段级 align/pad_to 填充对齐 —— 双端 byte-equal 锚点（stdlib 直测）。

向量表与 frontend/src/utils/__tests__/InstructionEncoder.align.test.js 的 VECTORS
逐行同步（两端各自钉同一张表实现跨语言一致性），改一必改二。

口径（拍板：字段级 align + pad_to，骑 parameter_config 零 DDL）：
- align = N（1..4096）→ 该字段**内容起点**绝对偏移补位到 ≡0 (mod N)，已对齐 0 字节；
- pad_to = N（1..4096）→ 该字段**内容末尾**绝对偏移补位到 ≡0 (mod N)，已对齐 0 字节；
- pad_byte ≤2 位 hex → 填充字节值（N2 pad_char 严格解析先例），否则 0x00；
- 非法 align/pad_to（≤0 / 非数 / >4096 / 非有限）→ 忽略（fail-open，绝不阻断出帧）；
- 组：align 在首副本前补一次、pad_to 在末副本后补一次；子字段 pad 按各自**绝对偏移
  逐副本**计算（非 Σ×reps 常数）；
- presence 未命中 → 字段与 pad 都不发；repeat=0 → 同；
- LITTLE 端序：pad 不参与字节序反转（pad 在反转后的字段字节之外）；
- pad 进发射流 / 偏移尺 / 总长；**不进**长度公式（PASS0 fieldSizes）与校验参与区
  （内容口径，既有零改动）—— 向量避开 length/checksum（N3 同口径）。

BE 向量不含 length/checksum 字段（datahub 路径 config=None → 0x00 填充，与前端真
Σ/CRC 不 byte-equal —— 前端侧行为单列 FE 测）。
"""

import unittest

from backend.core.pad import align_pad_len, pad_hex, pad_spec, pad_to_pad_len
from backend.routers.datahub import compile_blocks, fields_to_blocks, frame_bytes


def L(id_, hexval, seq=0, **kw):
    """叶字段：FIXED hex 出帧 + 可选 align/pad_to/pad_byte/presence/endianness。"""
    cfg = {"hex": hexval}
    for key in ("align", "pad_to", "pad_byte", "presence", "value"):
        if key in kw:
            cfg[key] = kw[key]
    field = {
        "id": id_, "name": id_.upper(), "op_code": "FIXED",
        "byte_len": len(hexval) // 2, "sequence": seq, "parent_id": None,
        "parameter_config": cfg,
    }
    if kw.get("endianness"):
        field["endianness"] = kw["endianness"]
    return field


def G(id_, kids, seq=0, repeat=None, **kw):
    """组字段：children 挂子树（parent_id/sequence 由本 helper 归一）。"""
    cfg = {}
    for key in ("align", "pad_to", "pad_byte", "presence"):
        if key in kw:
            cfg[key] = kw[key]
    for i, kid in enumerate(kids):
        kid["parent_id"] = id_
        kid["sequence"] = i
    field = {
        "id": id_, "name": id_.upper(), "op_code": "ARRAY_GROUP", "byte_len": 0,
        "sequence": seq, "parent_id": None, "parameter_config": cfg,
        "children": kids,
    }
    if repeat:
        field["repeat_type"], field["repeat_count"] = repeat
    return field


# 与前端 VECTORS 逐行同步：(字段规格, 期望帧 hex)
VECTORS = [
    # align 已对齐 → 0 补位
    ([L("a", "AABB"), L("b", "CC", align=2)], "AABBCC"),
    # align 补 1 / 补 3
    ([L("a", "AA"), L("b", "CC", align=2)], "AA00CC"),
    ([L("a", "AA"), L("b", "CC", align=4)], "AA000000CC"),
    # pad_to 帧尾补 2
    ([L("a", "AABB", pad_to=4), L("b", "CC")], "AABB0000CC"),
    # pad_byte 改填充字节值
    ([L("a", "AA"), L("b", "CC", align=2, pad_byte="FF")], "AAFFCC"),
    # align + pad_to 同字段：内容起点 4、内容末尾 5 → 补到 8（补 3）
    ([L("a", "AA"), L("b", "CC", align=4, pad_to=8)], "AA000000CC000000"),
    # 组级 align：组内容起点补位到 4（归入前一字段的 span）
    ([L("a", "AA"), G("g", [L("x", "BB"), L("y", "CC")], align=4)], "AA000000BBCC"),
    # 重复组内子字段 align：逐副本按绝对偏移算（非 Σ×reps 常数）
    ([G("g", [L("x", "AA", align=2)], repeat=("FIXED", 2))], "AA00AA"),
    # presence 未命中 → 字段与 pad 都不发
    ([L("a", "AA", value=1), L("b", "CC", align=2,
                               presence={"ref_id": "a", "expect": "9"})], "AA"),
    # presence 命中 → 照常补位
    ([L("a", "AA", value=1), L("b", "CC", align=2,
                               presence={"ref_id": "a", "expect": "1"})], "AA00CC"),
    # pad_to 在末副本之后补一次（副本共 2 字节 → 补 6）
    ([G("g", [L("x", "BB")], repeat=("FIXED", 2), pad_to=8)], "BBBB000000000000"),
    # LITTLE：pad 不参与反转（pad 在反转后的字段字节之外）
    ([L("a", "AA"), L("b", "1234", align=4, endianness="LITTLE")], "AA0000003412"),
    # 非法 align → 忽略（fail-open）
    ([L("a", "AA"), L("b", "CC", align=0)], "AACC"),
    ([L("a", "AA"), L("b", "CC", align="9999")], "AACC"),
    # 数值串 → 归一（同 byte_len 的 Number/floor 口径）
    ([L("a", "AA"), L("b", "CC", align="4")], "AA000000CC"),
    # 非法 pad_byte → 0x00
    ([L("a", "AA"), L("b", "CC", align=2, pad_byte="Z")], "AA00CC"),
]


def frame_of(*fields):
    for i, field in enumerate(fields):
        field["sequence"] = i  # 顶层按位置定序（两端同规则）
    return frame_bytes(compile_blocks(fields_to_blocks(list(fields))))


class TestAlignVectors(unittest.TestCase):
    def test_vectors(self):
        for i, (specs, expected) in enumerate(VECTORS):
            with self.subTest(vector=i, expected=expected):
                self.assertEqual(frame_of(*specs).hex().upper(), expected)


class TestPadSpecNormalize(unittest.TestCase):
    """归一口径与前端 utils/padSpec.js padSpec 同源（改一必改二）。"""

    def test_align_pad_to_range(self):
        self.assertEqual(pad_spec({"align": 4, "pad_to": 8})[:2], (4, 8))
        self.assertEqual(pad_spec({"align": 0})[0], 0)        # ≤0 → 忽略
        self.assertEqual(pad_spec({"align": -1})[0], 0)
        self.assertEqual(pad_spec({"align": 4096})[0], 4096)  # 上限内
        self.assertEqual(pad_spec({"align": 4097})[0], 0)     # 超上限 → 忽略
        self.assertEqual(pad_spec({"align": "4"})[0], 4)      # 数值串
        self.assertEqual(pad_spec({"align": "8.7"})[0], 8)    # floor
        self.assertEqual(pad_spec({"align": "x"})[0], 0)
        self.assertEqual(pad_spec({"align": True})[0], 0)     # bool 非法（_floor_numeric 同口径）
        self.assertEqual(pad_spec(None)[0], 0)

    def test_pad_byte_strict_hex_parse(self):
        self.assertEqual(pad_spec({"pad_byte": "FF"})[2], 255)
        self.assertEqual(pad_spec({"pad_byte": "f"})[2], 15)
        self.assertEqual(pad_spec({"pad_byte": "Z"})[2], 0)   # 非法 → 00（N2 先例）
        self.assertEqual(pad_spec({"pad_byte": "FFF"})[2], 0)  # >2 位 → 00
        self.assertEqual(pad_spec({})[2], 0)

    def test_pad_lengths(self):
        self.assertEqual(align_pad_len(1, 4), 3)
        self.assertEqual(align_pad_len(4, 4), 0)   # 已对齐 → 0
        self.assertEqual(align_pad_len(0, 4), 0)
        self.assertEqual(align_pad_len(1, 0), 0)   # 关闭
        self.assertEqual(pad_to_pad_len(6, 8), 2)
        self.assertEqual(pad_to_pad_len(8, 8), 0)
        self.assertEqual(pad_to_pad_len(6, 0), 0)
        self.assertEqual(pad_hex(3, 0xFF), "FFFFFF")
        self.assertEqual(pad_hex(0, 0), "")


if __name__ == "__main__":
    unittest.main()
