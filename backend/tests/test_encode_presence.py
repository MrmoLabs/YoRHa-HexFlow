"""N3 (G1 · PLAN §8.16): presence 条件存在 — 双端 byte-equal 锚点（stdlib 直测）。

向量表单一真相源 = vectors/presence.json（CP2b / D11-①）：本表与前端 InstructionEncoder.presence.test.js 的 LEAF/GROUP 向量 同读这一份 JSON，新增/修改向量只写一处；跨语言特殊值约定（{"$v": "Infinity"/"-Infinity"/"NaN"} 包装对象）见 vectors/README.md。

口径：
- 判定 = parameter_config.presence，静态链仅 pc.value（DYNAMIC repeat 静态
  resolve 先例，inputs/computed 覆盖为 FE-only 运行期行为）；
  比较 String(refVal) == String(expect)（数值 1 命中 "1"）；
- fail-open：presence 非对象 / 缺 ref_id / 缺 expect / ref 悬空 / ref 无静态值
  → 视为命中（半成品配置不吞字节，防数据丢失优于严格过滤）；
- 判定先于 repeat 展开与子树递归：未命中 → byte_length=0 + children=[] +
  type=fixed（子树不进 flatten，orchestrator 自动省 0 字节，零触碰）。

BE 向量不含量 checksum/length 字段（datahub 路径 config=None 时校验/长度
退化为 0x00 填充，与前端真 CRC/Σ 不 byte-equal —— 前端侧行为单列 FE 测）。
"""

import unittest

from backend.routers.datahub import compile_blocks, fields_to_blocks, frame_bytes
from vectors.load_vectors import load_vectors


def leaf(id, cfg, sequence=0, op="FIXED", byte_len=1, parent_id=None):
    return {"id": id, "name": id.upper(), "op_code": op, "byte_len": byte_len,
            "sequence": sequence, "parent_id": parent_id, "parameter_config": cfg}


def cmd_field(value=1):
    """ref 源字段：FIXED hex 发射 + pc.value 供 presence 静态链。"""
    return leaf("cmd", {"hex": "AA", "value": value}, sequence=0)


# 行形状（JSON 行）: (presence, expected_hex) — 帧 = cmd(AA) + gated(BB)
# CP2b (D11-①): 单一真相源 = vectors/presence.json · 表 leaf —— 两端同读一份，新增向量只写一处
LEAF_VECTORS = load_vectors("presence", "leaf")


def build_leaf(presence):
    return [cmd_field(), leaf("opt", {"hex": "BB", "presence": presence}, sequence=1)]


# 行形状（JSON 行）: (presence, repeat_type, repeat_count, expected_hex)
# — 帧 = cmd(AA) + 组(11)
# CP2b (D11-①): 单一真相源 = vectors/presence.json · 表 group —— 两端同读一份，新增向量只写一处
GROUP_VECTORS = load_vectors("presence", "group")


def build_group(presence, repeat_type, repeat_count):
    group = {"id": "g", "name": "G", "op_code": "ARRAY_GROUP", "byte_len": 0,
             "sequence": 1, "parent_id": None, "repeat_type": repeat_type,
             "repeat_count": repeat_count,
             "repeat_ref_id": "ref" if repeat_type == "DYNAMIC" else None,
             "parameter_config": {"presence": presence},
             "children": [leaf("a", {"hex": "11"}, sequence=0, parent_id="g")]}
    return [cmd_field(), group]


def frame_of(*fields):
    return frame_bytes(compile_blocks(fields_to_blocks(list(fields))))


class TestPresenceLeafVectors(unittest.TestCase):
    def test_vectors(self):
        for i, (presence, expected) in enumerate(LEAF_VECTORS):
            with self.subTest(vector=i, presence=presence):
                got = frame_of(*build_leaf(presence)).hex().upper()
                self.assertEqual(got, expected)


class TestPresenceGroupVectors(unittest.TestCase):
    def test_vectors(self):
        for i, (presence, repeat_type, repeat_count, expected) in enumerate(GROUP_VECTORS):
            with self.subTest(vector=i, repeat=repeat_type, count=repeat_count,
                               presence=presence):
                got = frame_of(*build_group(presence, repeat_type, repeat_count)).hex().upper()
                self.assertEqual(got, expected)

    def test_dynamic_repeat_with_presence(self):
        # 判定先于 repeat 展开：组未命中 → 只发 ref 字段（DYNAMIC 不展开）；
        # 命中 → 按 DYNAMIC 计数展开（门控放行不破坏 E1-5）。
        ref = leaf("ref", {"hex": "02", "value": 2}, sequence=0)
        def dyn_group(presence):
            return {"id": "g", "name": "G", "op_code": "ARRAY_GROUP", "byte_len": 0,
                    "sequence": 1, "parent_id": None, "repeat_type": "DYNAMIC",
                    "repeat_count": 1, "repeat_ref_id": "ref",
                    "parameter_config": {"presence": presence},
                    "children": [leaf("a", {"hex": "11"}, sequence=0, parent_id="g")]}
        self.assertEqual(
            frame_of(ref, dyn_group({"ref_id": "ref", "expect": "9"})).hex().upper(),
            "02")
        self.assertEqual(
            frame_of(ref, dyn_group({"ref_id": "ref", "expect": "2"})).hex().upper(),
            "021111")


class TestToBlockPresenceGate(unittest.TestCase):
    def test_missed_leaf_is_zero_block(self):
        blocks = fields_to_blocks(build_leaf({"ref_id": "cmd", "expect": "2"}))
        opt = next(b for b in blocks if b["id"] == "opt")
        self.assertEqual(opt["byte_length"], 0)
        self.assertEqual(opt["children"], [])
        self.assertIsNone(opt["hex_value"])
        self.assertEqual(opt["type"], "fixed")

    def test_hit_leaf_keeps_bytes(self):
        blocks = fields_to_blocks(build_leaf({"ref_id": "cmd", "expect": "1"}))
        opt = next(b for b in blocks if b["id"] == "opt")
        self.assertEqual(opt["byte_length"], 1)
        self.assertEqual(opt["hex_value"], "BB")

    def test_missed_group_drops_subtree(self):
        blocks = fields_to_blocks(build_group({"ref_id": "cmd", "expect": "2"}, "FIXED", 3))
        g = next(b for b in blocks if b["id"] == "g")
        self.assertEqual(g["children"], [])          # 子树不进 flatten
        self.assertFalse(g["is_container"])
        self.assertEqual(g["byte_length"], 0)

    def test_hit_group_resolves_repeat_through_gate(self):
        blocks = fields_to_blocks(build_group({"ref_id": "cmd", "expect": "1"}, "FIXED", 3))
        g = next(b for b in blocks if b["id"] == "g")
        self.assertEqual(g["repeat_count"], 3)
        self.assertEqual(len(g["children"]), 1)


class TestNestedPresence(unittest.TestCase):
    def test_parent_hit_child_miss(self):
        # 与前端「命中组内：未命中子跳过、无门子照发」同口径 → AA22
        fields = [
            cmd_field(),
            {"id": "outer", "name": "OUTER", "op_code": "ARRAY_GROUP", "byte_len": 0,
             "sequence": 1, "parent_id": None, "parameter_config": {
                 "presence": {"ref_id": "cmd", "expect": "1"}},
             "children": [
                 leaf("a", {"hex": "11", "presence": {"ref_id": "cmd", "expect": "2"}},
                      sequence=0, parent_id="outer"),
                 leaf("b", {"hex": "22"}, sequence=1, parent_id="outer"),
             ]},
        ]
        self.assertEqual(frame_of(*fields).hex().upper(), "AA22")
        blocks = fields_to_blocks(fields)
        outer = next(b for b in blocks if b["id"] == "outer")
        by_id = {c["id"]: c for c in outer["children"]}
        self.assertEqual(by_id["a"]["byte_length"], 0)
        self.assertEqual(by_id["b"]["byte_length"], 1)

    def test_outer_miss_child_never_built(self):
        fields = [
            cmd_field(),
            {"id": "outer", "name": "OUTER", "op_code": "ARRAY_GROUP", "byte_len": 0,
             "sequence": 1, "parent_id": None, "parameter_config": {
                 "presence": {"ref_id": "cmd", "expect": "2"}},
             "children": [
                 leaf("a", {"hex": "11"}, sequence=0, parent_id="outer"),
             ]},
        ]
        self.assertEqual(frame_of(*fields).hex().upper(), "AA")
        blocks = fields_to_blocks(fields)
        outer = next(b for b in blocks if b["id"] == "outer")
        self.assertEqual(outer["children"], [])


class TestCombinedVector(unittest.TestCase):
    def test_combined(self):
        # 与前端 COMBINED 用例同步：命中叶 + 未命中叶 + 命中组(×2) + 未命中组
        fields = [
            cmd_field(),
            leaf("optHit", {"hex": "BB", "presence": {"ref_id": "cmd", "expect": "1"}}, 1),
            leaf("optMiss", {"hex": "CC", "presence": {"ref_id": "cmd", "expect": "2"}}, 2),
            {"id": "gHit", "name": "GHIT", "op_code": "ARRAY_GROUP", "byte_len": 0,
             "sequence": 3, "parent_id": None, "repeat_type": "FIXED", "repeat_count": 2,
             "parameter_config": {"presence": {"ref_id": "cmd", "expect": "1"}},
             "children": [leaf("a", {"hex": "11"}, sequence=0, parent_id="gHit")]},
            {"id": "gMiss", "name": "GMISS", "op_code": "ARRAY_GROUP", "byte_len": 0,
             "sequence": 4, "parent_id": None,
             "parameter_config": {"presence": {"ref_id": "cmd", "expect": "2"}},
             "children": [leaf("b", {"hex": "22"}, sequence=0, parent_id="gMiss")]},
        ]
        self.assertEqual(frame_of(*fields).hex().upper(), "AABB1111")


class TestPresenceRadixNormalize(unittest.TestCase):
    """R32 (§8.64): 判定归一 —— expect 是十六进制**字符串**时与数值等价。

    拍板项（§8.61 第七节 ① / §8.63 第七节）：样本② expect 存字符串 "01"，而引用
    值是数值 1 → 旧口径 str(1) != "01" **恒未命中**，门等于配废。R32 两者判等
    （FE InstructionEncoder._presenceHit 与 byteOffsets.presenceStaticState 同批改）。

    三条边界（宁可少判，只做拍板项）：
    - 归一**仅当 expect 是字符串**（JSON 数字 10 不按 hex 解 → 现状不变）；
    - expect 必须**整串** ^[0-9A-Fa-f]+$（空白 / ALPHA 一律不归一）；
    - 数值**超出安全整数**不归一（与 JS Number.isSafeInteger 同阈，双端精度一致）。
    """

    @staticmethod
    def frame(presence, value=1):
        return frame_of(
            cmd_field(value),
            leaf("opt", {"hex": "BB", "presence": presence}, sequence=1),
        ).hex().upper()

    def test_padded_hex_string_hits_numeric_value(self):
        self.assertEqual(self.frame({"ref_id": "cmd", "expect": "01"}), "AABB")

    def test_hex_with_letters_hits_numeric_value(self):
        self.assertEqual(self.frame({"ref_id": "cmd", "expect": "0A"}, 10), "AABB")

    def test_string_ref_value_hits(self):
        self.assertEqual(self.frame({"ref_id": "cmd", "expect": "01"}, "1"), "AABB")

    def test_genuinely_different_value_still_misses(self):
        self.assertEqual(self.frame({"ref_id": "cmd", "expect": "9"}), "AA")

    def test_whitespace_expect_not_normalized(self):
        self.assertEqual(self.frame({"ref_id": "cmd", "expect": " 1"}), "AA")

    def test_numeric_expect_not_normalized(self):
        self.assertEqual(self.frame({"ref_id": "cmd", "expect": 10}, 16), "AA")

    def test_non_hex_expect_not_normalized(self):
        self.assertEqual(self.frame({"ref_id": "cmd", "expect": "ALPHA"}), "AA")

    def test_group_gate_normalized(self):
        group = {"id": "g", "name": "G", "op_code": "ARRAY_GROUP", "byte_len": 0,
                 "sequence": 1, "parent_id": None, "repeat_type": "FIXED",
                 "repeat_count": 1,
                 "parameter_config": {"presence": {"ref_id": "cmd", "expect": "01"}},
                 "children": [leaf("a", {"hex": "11"}, sequence=0, parent_id="g")]}
        self.assertEqual(frame_of(cmd_field(1), group).hex().upper(), "AA11")


if __name__ == "__main__":
    unittest.main()
