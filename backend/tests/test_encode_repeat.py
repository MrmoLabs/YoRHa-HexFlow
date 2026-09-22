"""E1-5 (B7): ARRAY_GROUP repeat 展开 — 双端 byte-equal 锚点（stdlib 直测）。

向量表与 frontend/src/utils/__tests__/InstructionEncoder.test.js 的 E1-5
VECTORS 逐行同步（两端各自钉同一张表实现跨语言一致性），改一必改二。

对拷结构：帧 = [ref 字段(FIXED hex)]? + 组(FIXED 11 + FIXED 22)。
口径：NONE → ×1；FIXED → max(0, floor(repeat_count))（非 number/非有限防御 → 1）；
DYNAMIC → ref 字段静态 parameter_config.value（_floor_numeric 同款解析）
max(0, n)，ref 缺失/悬空/无值 → 0。orchestrator._flatten_recursive 按
datahub.to_block resolve 的 repeat_count 展开容器子树。
"""

import unittest

from backend.routers.datahub import compile_blocks, fields_to_blocks, frame_bytes

# 与前端 E1-5 VECTORS 同步：(repeat_type, repeat_count, ref_value, expected_hex)
# ref_value: None=无 value（ref 字段 hex BB）；"ghost"=ref_id 指向不存在字段。
VECTORS = [
    ("NONE", 1, None, "1122"),
    ("FIXED", 3, None, "112211221122"),
    ("FIXED", 1, None, "1122"),
    ("FIXED", 0, None, ""),
    ("FIXED", 2.7, None, "11221122"),
    ("FIXED", "x", None, "1122"),
    ("DYNAMIC", 1, 2, "AA" + "11221122"),
    ("DYNAMIC", 1, "3", "AA" + "112211221122"),
    ("DYNAMIC", 1, "FF", "AA"),
    ("DYNAMIC", 1, None, "BB"),
    ("DYNAMIC", 1, "ghost", ""),
]


def build(repeat_type, repeat_count, ref_value):
    """与前端 build() 同构：ref 字段（仅 DYNAMIC 且非 ghost）+ repeat 组。"""
    ghost = ref_value == "ghost"
    group = {
        "id": "g",
        "name": "G",
        "op_code": "ARRAY_GROUP",
        "byte_len": 0,
        "sequence": 1,
        "parent_id": None,
        "repeat_type": repeat_type,
        "repeat_count": repeat_count,
        "repeat_ref_id": "ghost" if ghost else ("ref" if repeat_type == "DYNAMIC" else None),
        "parameter_config": {},
        "children": [
            {"id": "a", "name": "A", "op_code": "FIXED", "byte_len": 1,
             "sequence": 0, "parent_id": "g", "parameter_config": {"hex": "11"}},
            {"id": "b", "name": "B", "op_code": "FIXED", "byte_len": 1,
             "sequence": 1, "parent_id": "g", "parameter_config": {"hex": "22"}},
        ],
    }
    if repeat_type != "DYNAMIC" or ghost:
        return [group]
    cfg = {"hex": "BB"} if ref_value is None else {"hex": "AA", "value": ref_value}
    ref = {"id": "ref", "name": "REF", "op_code": "FIXED", "byte_len": 1,
           "sequence": 0, "parent_id": None, "parameter_config": cfg}
    return [ref, group]


def frame_of(*fields):
    return frame_bytes(compile_blocks(fields_to_blocks(list(fields))))


class TestRepeatVectors(unittest.TestCase):
    def test_vectors(self):
        for repeat_type, repeat_count, ref_value, expected in VECTORS:
            with self.subTest(repeat=repeat_type, count=repeat_count, ref=ref_value):
                got = frame_of(*build(repeat_type, repeat_count, ref_value)).hex().upper()
                self.assertEqual(got, expected)

    def test_to_block_resolves_repeat_count(self):
        blocks = fields_to_blocks(build("FIXED", 3, None))
        group = next(b for b in blocks if b["id"] == "g")
        self.assertEqual(group["repeat_count"], 3)
        plain = fields_to_blocks(build("NONE", 1, None))
        plain_group = next(b for b in plain if b["id"] == "g")
        self.assertEqual(plain_group["repeat_count"], 1)
        dyn = fields_to_blocks(build("DYNAMIC", 1, 2))
        dyn_group = next(b for b in dyn if b["id"] == "g")
        self.assertEqual(dyn_group["repeat_count"], 2)
        dangling = fields_to_blocks(build("DYNAMIC", 1, "ghost"))
        ghost_group = next(b for b in dangling if b["id"] == "g")
        self.assertEqual(ghost_group["repeat_count"], 0)

    def test_nested_repeat(self):
        # 外 FIXED×2 ⊗ 内 FIXED×3 → '333333'×2（与前端嵌套用例同口径）
        frame = frame_of(
            {
                "id": "outer", "name": "O", "op_code": "ARRAY_GROUP", "byte_len": 0,
                "sequence": 0, "parent_id": None, "repeat_type": "FIXED",
                "repeat_count": 2, "parameter_config": {},
                "children": [
                    {
                        "id": "inner", "name": "I", "op_code": "ARRAY_GROUP",
                        "byte_len": 0, "sequence": 0, "parent_id": "outer",
                        "repeat_type": "FIXED", "repeat_count": 3,
                        "parameter_config": {},
                        "children": [
                            {"id": "c", "name": "C", "op_code": "FIXED",
                             "byte_len": 1, "sequence": 0, "parent_id": "inner",
                             "parameter_config": {"hex": "33"}},
                        ],
                    },
                ],
            }
        )
        self.assertEqual(frame.hex().upper(), "333333" * 2)

    def test_little_endian_child_in_repeat(self):
        # 重复中的子字段各自走 E1-2 LITTLE 反转（与前端用例同口径）
        frame = frame_of({
            "id": "g", "name": "G", "op_code": "ARRAY_GROUP", "byte_len": 0,
            "sequence": 0, "parent_id": None, "repeat_type": "FIXED",
            "repeat_count": 2, "parameter_config": {},
            "children": [
                {"id": "a", "name": "A", "op_code": "FIXED", "byte_len": 2,
                 "sequence": 0, "parent_id": "g", "endianness": "LITTLE",
                 "parameter_config": {"hex": "1234"}},
            ],
        })
        self.assertEqual(frame.hex().upper(), "34123412")


if __name__ == "__main__":
    unittest.main()
