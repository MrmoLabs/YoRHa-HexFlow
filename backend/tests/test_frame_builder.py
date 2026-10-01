import copy
import unittest

from backend.core.frame_builder import build_wrapped
from vectors.load_vectors import load_vectors

# 批次一 1b (D4-A 后端 frame_builder 唯一封装入口)。
# 语义移植自前端 blockMerge.js（fill/溢出追加/欠载保留/refs 改写），差异点：
# 载荷是已编码内核 hex（指令编码仍在前端），注入为单 fixed 块，外壳
# length/checksum 交由 handlers refs 集合模式真值重算。
# 三处同值锚点（本文件 / test_wrap_api.py / blockMerge.test.js）的主向量单一真相源
# = vectors/wrap.json · 表 main（CP2b / D11-①），三处同读一份，新增向量只写一处。


def fixed(nid, hex_value, byte_length=None, label=None):
    return {
        "id": nid,
        "label": label or nid,
        "type": "fixed",
        "byte_length": byte_length if byte_length is not None else len(hex_value.replace(" ", "")) // 2,
        "hex_value": hex_value,
        "config": {},
        "children": [],
    }


def slot(nid, label=None, children=None, parameter_config=None):
    node = {
        "id": nid,
        "label": label or nid,
        "type": "slot",
        "byte_length": 0,
        "hex_value": None,
        "config": {},
        "children": children or [],
    }
    # 批次二 (D3): 槽契约走 parameter_config（零 DDL）——不传则保持存量形态
    if parameter_config is not None:
        node["parameter_config"] = parameter_config
    return node


def length_block(nid, refs, byte_length=1):
    return {
        "id": nid,
        "label": nid,
        "type": "length",
        "byte_length": byte_length,
        "hex_value": "00",
        "config": {},
        "parameter_config": {"type": "length", "refs": list(refs)},
        "children": [],
    }


def checksum_block(nid, refs, algorithm="SUM_8", byte_length=1):
    return {
        "id": nid,
        "label": nid,
        "type": "checksum",
        "byte_length": byte_length,
        "hex_value": "00",
        "config": {},
        "parameter_config": {"type": "checksum", "refs": list(refs), "algorithm": algorithm},
        "children": [],
    }


def container(nid, children):
    return {
        "id": nid,
        "label": nid,
        "type": "container",
        "byte_length": 0,
        "hex_value": None,
        "config": {},
        "children": children,
    }


def shell(children):
    """协议根（children 为协议树根列表 —— build_wrapped 的输入口径）。"""
    return children


class SharedVectorTest(unittest.TestCase):
    """主共享向量：FA FA / 02 / 01 02 / ED —— 三处同读 vectors/wrap.json · main。"""

    def test_header_length_payload_tail(self):
        main = load_vectors("wrap", "main")
        result = build_wrapped(main["children"], main["payloads"])
        self.assertEqual(result["hex"], main["expect"]["hex"])
        self.assertEqual(result["total_length"], main["expect"]["total_length"])
        self.assertEqual(result["warnings"], main["expect"]["warnings"])

    def test_checksum_refs_set_recomputed(self):
        children = shell([
            fixed("h", "1A", 1),
            slot("s"),
            checksum_block("c", ["h", "s"]),
            fixed("t", "ED", 1),
        ])
        # SUM_8 over 1A 01 02 = 0x1D（1 字节 mod 0x100）
        result = build_wrapped(children, ["0102"])
        self.assertEqual(result["hex"], "1A 01 02 1D ED")
        self.assertEqual(result["total_length"], 5)


class FillSemanticsTest(unittest.TestCase):
    def test_nested_slot_filled(self):
        children = shell([
            fixed("h", "AA", 1),
            container("g", [slot("s")]),
            fixed("t", "BB", 1),
        ])
        result = build_wrapped(children, ["0102"])
        self.assertEqual(result["hex"], "AA 01 02 BB")
        self.assertEqual(result["total_length"], 4)

    def test_multi_payload_dense_order(self):
        children = shell([slot("s1"), fixed("m", "CC", 1), slot("s2")])
        result = build_wrapped(children, ["0102", "03040506"])
        self.assertEqual(result["hex"], "01 02 CC 03 04 05 06")
        self.assertEqual(result["total_length"], 7)

    def test_start_order_offsets_dense_cursor(self):
        def proto():
            return shell([
                length_block("l1", ["s1"]),
                slot("s1"),
                length_block("l2", ["s2"]),
                slot("s2"),
            ])

        # 发射按文档序：填 s1 → l1"02" / 注入"01 02" / l2"00"（s2 空洞跳过）。
        at_zero = build_wrapped(proto(), ["0102"], start_order=0)
        self.assertEqual(at_zero["hex"], "02 01 02 00")

        at_one = build_wrapped(proto(), ["0102"], start_order=1)
        self.assertEqual(at_one["hex"], "00 02 01 02")
        self.assertEqual(at_one["warnings"], ["空洞：1 个洞未被载荷填充"])

    def test_explicit_slot_id_beats_dense_position(self):
        children = shell([
            length_block("l1", ["s1"]),
            slot("s1"),
            length_block("l2", ["s2"]),
            slot("s2"),
        ])
        result = build_wrapped(children, ["0102"], slot_ids=["s2"])
        self.assertEqual(result["hex"], "00 02 01 02")

    def test_overflow_appends_to_root_end_with_warning(self):
        children = shell([fixed("h", "AA", 1), slot("s"), fixed("t", "BB", 1)])
        result = build_wrapped(children, ["0102", "0304"])
        self.assertEqual(result["hex"], "AA 01 02 BB 03 04")
        self.assertEqual(result["warnings"], ["洞位不足：1 条载荷无可用插槽，已追加帧末尾"])

    def test_underflow_keeps_slot_emitting_nothing(self):
        children = shell([slot("s1"), fixed("m", "CC", 1), slot("s2")])
        result = build_wrapped(children, ["0102"])
        self.assertEqual(result["hex"], "01 02 CC")
        self.assertEqual(result["warnings"], ["空洞：1 个洞未被载荷填充"])

    def test_empty_payload_consumes_slot_with_zero_bytes(self):
        def proto():
            return shell([
                fixed("h", "AA", 1),
                length_block("l", ["s"]),
                slot("s"),
                fixed("t", "BB", 1),
            ])

        empty = build_wrapped(proto(), [""])
        self.assertEqual(empty["hex"], "AA 00 BB")  # 槽被消耗、refs 收缩为空 → length 归 0
        self.assertEqual(empty["total_length"], 3)
        self.assertEqual(empty["warnings"], [])

        filled = build_wrapped(proto(), ["0102"])
        # 填槽就地注入：AA / l=02 / 载荷 01 02 / BB
        self.assertEqual(filled["hex"], "AA 02 01 02 BB")

    def test_unfilled_slot_refs_stay_dangling_counting_zero(self):
        children = shell([length_block("l", ["s"]), slot("s")])
        result = build_wrapped(children, [])
        self.assertEqual(result["hex"], "00")
        self.assertEqual(result["warnings"], ["空洞：1 个洞未被载荷填充"])

    def test_empty_payload_and_empty_protocol(self):
        result = build_wrapped([], [])
        self.assertEqual(result["hex"], "")
        self.assertEqual(result["total_length"], 0)

    def test_payload_without_slots_appends(self):
        result = build_wrapped([], ["AA BB"])
        self.assertEqual(result["hex"], "AA BB")
        self.assertEqual(result["total_length"], 2)
        self.assertEqual(result["warnings"], ["洞位不足：1 条载荷无可用插槽，已追加帧末尾"])


class RefsRewriteTest(unittest.TestCase):
    def test_length_refs_expand_to_injected_block(self):
        children = shell([length_block("l", ["s"]), slot("s"), fixed("t", "ED", 1)])
        result = build_wrapped(children, ["0102 03"])
        # refs 改写后 Σ = 注入块 byte_length = 3
        self.assertEqual(result["hex"], "03 01 02 03 ED")

    def test_input_not_mutated(self):
        children = shell([fixed("h", "FA FA", 2), length_block("l", ["s"]), slot("s")])
        before = copy.deepcopy(children)
        build_wrapped(children, ["0102"])
        self.assertEqual(children, before)  # 深克隆前缀化，不回染输入


class ErrorTest(unittest.TestCase):
    def test_dangling_explicit_slot_raises(self):
        with self.assertRaises(ValueError) as ctx:
            build_wrapped([slot("s1")], ["0102"], slot_ids=["nope"])
        self.assertIn("插槽不存在", str(ctx.exception))

    def test_explicit_non_slot_raises(self):
        with self.assertRaises(ValueError) as ctx:
            build_wrapped([fixed("h", "AA", 1)], ["0102"], slot_ids=["h"])
        self.assertIn("不是插槽", str(ctx.exception))

    def test_duplicate_explicit_slot_raises(self):
        children = shell([slot("s1"), slot("s2")])
        with self.assertRaises(ValueError) as ctx:
            build_wrapped(children, ["0102", "0304"], slot_ids=["s1", "s1"])
        self.assertIn("重复", str(ctx.exception))

    def test_invalid_payload_hex_raises(self):
        with self.assertRaises(ValueError):
            build_wrapped([slot("s")], ["ABC"])
        with self.assertRaises(ValueError):
            build_wrapped([slot("s")], ["GG"])

    def test_slot_ids_length_mismatch_tolerated(self):
        # 超出 payload 数的 slot_ids 忽略（不并行报错）
        result = build_wrapped([slot("s")], ["0102"], slot_ids=["s", "extra"])
        self.assertEqual(result["hex"], "01 02")


class WarningTest(unittest.TestCase):
    def test_overflow_and_underflow_combined(self):
        children = shell([slot("s1"), slot("s2"), slot("s3")])
        result = build_wrapped(children, ["0102", "0304", "0506", "0708", "090A"])
        self.assertEqual(result["hex"], "01 02 03 04 05 06 07 08 09 0A")
        self.assertEqual(result["warnings"], ["洞位不足：2 条载荷无可用插槽，已追加帧末尾"])

    def test_spaced_payload_accepted(self):
        children = shell([slot("s")])
        result = build_wrapped(children, ["01 02"])
        self.assertEqual(result["hex"], "01 02")
        self.assertEqual(result["total_length"], 2)


class FitPolicyTest(unittest.TestCase):
    """批次二 (D3/D14①): 溢出/欠载/超上限按槽 fit_policy 执行。

    三态 = reject（阻断 ValueError）/ append / zero_fill（缺省，存量零回归）；
    存量槽不动（D14① 拍板：不迁移），只有显式配 reject 的槽才阻断。
    """

    REJECT = {"fit_policy": {"overflow": "reject", "underflow": "reject"}}
    # 缺省（无 fit_policy）= append + zero_fill —— 存量零回归锚
    def test_default_overflow_appends_with_warning(self):
        children = shell([slot("s")])
        result = build_wrapped(children, ["0102", "0304"])
        self.assertEqual(result["hex"], "01 02 03 04")
        self.assertIn("洞位不足：1 条载荷无可用插槽，已追加帧末尾", result["warnings"])

    def test_default_underflow_zero_fills_with_warning(self):
        children = shell([slot("s1"), slot("s2")])
        result = build_wrapped(children, ["0102"])
        self.assertEqual(result["warnings"], ["空洞：1 个洞未被载荷填充"])

    def test_overflow_reject_raises_with_count(self):
        children = shell([slot("s", parameter_config=self.REJECT)])
        with self.assertRaises(ValueError) as ctx:
            build_wrapped(children, ["0102", "0304"])
        self.assertIn("洞位不足：1 条载荷无可用插槽", str(ctx.exception))
        self.assertIn("禁止追加帧末尾", str(ctx.exception))

    def test_underflow_reject_raises_with_slot_and_bytes(self):
        children = shell([slot("s", parameter_config=self.REJECT)])
        with self.assertRaises(ValueError) as ctx:
            build_wrapped(children, [])
        message = str(ctx.exception)
        self.assertIn("欠载", message)
        self.assertIn("s", message)
        self.assertIn("实际 0 字节", message)

    def test_underflow_reject_scoped_to_rejecting_slot_only(self):
        # 只有显式 reject 的槽阻断，同协议里 zero_fill 缺省槽照常告警
        children = shell([
            slot("bad", parameter_config=self.REJECT),
            slot("ok"),
        ])
        with self.assertRaises(ValueError) as ctx:
            build_wrapped(children, [])
        self.assertIn("bad", str(ctx.exception))
        self.assertNotIn("插槽 ok", str(ctx.exception))

    def test_mixed_overflow_policy_any_reject_blocks_append(self):
        # 实施注：条数溢出无槽归属 → 任一槽 overflow=reject 即阻断追加帧末尾
        children = shell([
            slot("strict", parameter_config={"fit_policy": {"overflow": "reject"}}),
            slot("loose"),
        ])
        with self.assertRaises(ValueError) as ctx:
            build_wrapped(children, ["0102", "0304", "0506"])
        self.assertIn("洞位不足", str(ctx.exception))

    def test_max_bytes_reject_raises_with_actual_and_allowed(self):
        children = shell([
            slot("s", parameter_config={
                "fit_policy": {"overflow": "reject", "underflow": "zero_fill"},
                "max_bytes": 1,
            }),
        ])
        with self.assertRaises(ValueError) as ctx:
            build_wrapped(children, ["0102"])
        message = str(ctx.exception)
        self.assertIn("溢出", message)
        self.assertIn("2 字节", message)
        self.assertIn("1 字节", message)

    def test_max_bytes_within_limit_silent(self):
        children = shell([
            slot("s", parameter_config={
                "fit_policy": {"overflow": "reject", "underflow": "zero_fill"},
                "max_bytes": 4,
            }),
        ])
        result = build_wrapped(children, ["0102"])
        self.assertEqual(result["warnings"], [])

    def test_max_bytes_default_policy_only_warns(self):
        children = shell([slot("s", parameter_config={"max_bytes": 1})])
        result = build_wrapped(children, ["0102"])
        self.assertTrue(any("溢出" in w for w in result["warnings"]))

    def test_reject_error_blocks_before_emitting_frame(self):
        # reject 语义：连 hex 都不产出（ValueError 而非半成品 result）
        children = shell([slot("s", parameter_config=self.REJECT)])
        with self.assertRaises(ValueError):
            build_wrapped(children, [])


if __name__ == "__main__":
    unittest.main()
