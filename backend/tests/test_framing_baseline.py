# -*- coding: utf-8 -*-
"""R27 硬前置（§8.52 排期 · varint / COBS **出线**）：**无变长编码时逐字节不变**。

§0 硬约束要求「R27 / R28 前须先证『无变长编码时逐字节不变』」—— 本文件即那
份证明：**先于任何 R27 改动**从当前代码抓取的出线金标准（帧 hex + 发射期
`block_spans` 绝对区间），覆盖发射与封装的每条既有分支：

  fixed（含禁用块跳过）· length refs Σ（大端缺省 / 小端 R21）· checksum refs ·
  bitfield 打包 · 容器 repeat ×2 + 空容器 + LITTLE 叶反转 · slot 归零 ·
  build_wrapped（主向量 / 三层手工 / 空载荷删槽 / 无载荷保槽）·
  **N4 出线层位**（转义后套壳）。

R27 新增的两条能力都必须是**显式配置**才生效：
  ① `length` 卡 `parameter_config.encoding = "varint"`（缺省/缺失 → `fixed`）；
  ② 组帧元素 `cobs`（既有元素集里不存在 → 零节点零改动）。
故本文件的断言在 R27 落码后**必须依旧全绿**（改一必改二的反向钉子）——
任何一条变红，即说明变长编码漏进了缺省路径。
"""

import copy
import unittest

from backend.core.escape import escape_hex, table_from_config
from backend.core.frame_builder import build_wrapped
from backend.core.orchestrator import Orchestrator
from backend.handlers.length import LengthHandler
from backend.schemas.block import Block, BlockConfig
from vectors.load_vectors import load_vectors


def block(nid, **kw):
    base = dict(
        id=nid, type="fixed", label=nid, byte_length=1, hex_value="00",
        config=None, children=[], is_container=False, is_enabled=True,
        endianness="BIG", repeat_count=1, align=0, pad_to=0, pad_byte=0,
    )
    base.update(kw)
    return Block(**base)


class DirectEmitBaseline(unittest.TestCase):
    """Orchestrator 发射期各分支的出线字节 + block_spans（改造前抓取）。"""

    def test_fixed_and_disabled_block(self):
        blocks = [
            block("a1", label="A1", byte_length=2, hex_value="FA FA"),
            block("a2", label="A2", byte_length=1, hex_value="ED", is_enabled=False),
            block("a3", label="A3", byte_length=1, hex_value="AA"),
        ]
        orch = Orchestrator(blocks)
        self.assertEqual(orch.process(), "FA FA AA")
        self.assertEqual(orch.block_spans, {"a1": [(0, 2)], "a3": [(2, 3)]})

    def test_length_and_checksum_refs_default_big_endian(self):
        blocks = [
            block("h", byte_length=2, hex_value="FA FA"),
            block("p", byte_length=2, hex_value="01 02"),
            block("l", type="length", hex_value="00",
                  config=BlockConfig(params={"refs": ["h", "p"]})),
            block("c", type="checksum", byte_length=2, hex_value="0000",
                  config=BlockConfig(params={"refs": ["h", "p"], "algorithm": "sum"})),
        ]
        orch = Orchestrator(blocks)
        # 注：checksum byte_length=2 + SUM_8 的 BE 真值 = 全和 0x1F7 按定宽 4 位
        # 输出（FE 同款算法在 2 字节宽度上是 8 位折返 → 00F7 —— **存量双端差异**，
        # 非 R27 范围，两侧基线各钉各的现值，见 framingBaseline.test.js 同注）。
        self.assertEqual(orch.process(), "FA FA 01 02 04 01F7")
        self.assertEqual(orch.block_spans, {
            "h": [(0, 2)], "p": [(2, 4)], "l": [(4, 5)], "c": [(5, 7)],
        })

    def test_length_byte_order_little_r21(self):
        blocks = [
            block("h", byte_length=1, hex_value="A0"),
            block("p", byte_length=3, hex_value="01 02 03"),
            block("l", type="length", byte_length=2, hex_value="0000",
                  config=BlockConfig(params={"refs": ["p"], "byte_order": "little"})),
        ]
        orch = Orchestrator(blocks)
        self.assertEqual(orch.process(), "A0 01 02 03 0300")
        self.assertEqual(orch.block_spans, {"h": [(0, 1)], "p": [(1, 4)], "l": [(4, 6)]})

    def test_bitfield_pack(self):
        blocks = [
            block("b", type="bitfield", byte_length=2, hex_value="0000",
                  config=BlockConfig(params={"bits": [
                      {"bit_name": "s", "start_bit": 0, "bit_len": 4, "default_val": 10},
                      {"bit_name": "f", "start_bit": 4, "bit_len": 4, "default_val": 3},
                      {"bit_name": "w", "start_bit": 8, "bit_len": 8, "default_val": 255},
                  ]})),
            block("t", byte_length=1, hex_value="ED"),
        ]
        orch = Orchestrator(blocks)
        self.assertEqual(orch.process(), "FF3A ED")
        self.assertEqual(orch.block_spans, {"b": [(0, 2)], "t": [(2, 3)]})

    def test_container_repeat_empty_and_little_leaf(self):
        blocks = [
            block("g", is_container=True, byte_length=0, repeat_count=2,
                  children=[block("g1", byte_length=1, hex_value="11")]),
            block("e", is_container=True, byte_length=0, children=[]),
            block("le", label="LE", byte_length=2, hex_value="01 02",
                  endianness="LITTLE"),
        ]
        orch = Orchestrator(blocks)
        self.assertEqual(orch.process(), "11 11 02 01")
        self.assertEqual(orch.block_spans,
                         {"g1": [(0, 1), (1, 2)], "le": [(2, 4)]})

    def test_slot_emits_nothing(self):
        blocks = [
            block("h", byte_length=1, hex_value="A0"),
            block("s", type="slot", byte_length=4, hex_value="DE AD BE EF"),
        ]
        orch = Orchestrator(blocks)
        self.assertEqual(orch.process(), "A0")
        self.assertEqual(orch.block_spans, {"h": [(0, 1)]})

    def test_emit_does_not_resize_blocks_without_varint(self):
        """R27 硬前置：缺省路径**不得改块宽**（varint 的实际宽度回写只在显式
        `encoding="varint"` 时发生）—— 这里钉住 byte_length / is_container /
        children 结构在 process 前后逐项不变。"""
        blocks = [
            block("h", byte_length=2, hex_value="FA FA"),
            block("p", byte_length=2, hex_value="01 02"),
            block("l", type="length", hex_value="00",
                  config=BlockConfig(params={"refs": ["h", "p"]})),
            block("g", is_container=True, byte_length=0,
                  children=[block("g1", byte_length=1, hex_value="11")]),
        ]
        before = [(b.id, b.byte_length, b.is_container, len(b.children),
                   b.hex_value) for b in blocks]
        Orchestrator(blocks).process()
        after = [(b.id, b.byte_length, b.is_container, len(b.children),
                  b.hex_value) for b in blocks]
        # logic 块只允许 hex_value 被算定（既有行为），宽度/结构一律不动。
        self.assertEqual([(i, bl, ic, n) for i, bl, ic, n, _ in before],
                         [(i, bl, ic, n) for i, bl, ic, n, _ in after])
        self.assertEqual(before[0], after[0])  # 非 logic 块全字段不变
        self.assertEqual(after[2][4], "04")


class LengthHandlerEncodingDefault(unittest.TestCase):
    """`encoding` 键缺席 ≡ `encoding="fixed"`（R21 同款「缺省 = 现状」闸）。"""

    FLAT = None

    def _flat(self, refs, byte_length=1):
        blocks = [block("p", byte_length=3, hex_value="01 02 03")]
        blocks.append(block("l", type="length", byte_length=byte_length, hex_value="00",
                            config=BlockConfig(params={"refs": refs})))
        return blocks, [("global", b) for b in blocks]

    def test_absent_key_equals_fixed(self):
        blocks, flat = self._flat(["p"])
        absent = LengthHandler().calculate(blocks[1], flat)
        blocks2, flat2 = self._flat(["p"])
        blocks2[1].config = BlockConfig(params={"refs": ["p"], "encoding": "fixed"})
        fixed = LengthHandler().calculate(blocks2[1], flat2)
        self.assertEqual(absent, fixed)
        self.assertEqual(absent, "03")  # byte_length=1 → "03"

    def test_absent_key_is_golden(self):
        blocks, flat = self._flat(["p"], byte_length=2)
        self.assertEqual(LengthHandler().calculate(blocks[1], flat), "0003")


class WrapEntrypointBaseline(unittest.TestCase):
    """`build_wrapped`（唯一封装入口）四态出线金标准。"""

    def test_main_vector(self):
        main = load_vectors("wrap", "main")
        out = build_wrapped(main["children"], main["payloads"])
        self.assertEqual(out["hex"], "FA FA 02 01 02 ED")
        self.assertEqual(out["total_length"], 6)

    def test_three_layers_manual_tree(self):
        three = load_vectors("wrap", "three")
        out = build_wrapped(three["manual"]["children"], three["kernel"])
        self.assertEqual(out["hex"], three["expect"]["hex"])
        self.assertEqual(out["total_length"], three["expect"]["total_length"])

    def test_empty_payload_deletes_slot(self):
        main = load_vectors("wrap", "main")
        out = build_wrapped(copy.deepcopy(main["children"]), [""])
        self.assertEqual(out["hex"], "FA FA 00 ED")
        self.assertEqual(out["total_length"], 4)

    def test_no_payload_keeps_slot_emitting_nothing(self):
        main = load_vectors("wrap", "main")
        out = build_wrapped(copy.deepcopy(main["children"]), [])
        self.assertEqual(out["hex"], "FA FA 00 ED")
        self.assertEqual(out["total_length"], 4)


class WireLayerOrderBaseline(unittest.TestCase):
    """N4 层位（内核转义后套壳）出线金标准 —— R27 的组帧编码不得挪动这一层。"""

    def test_escape_then_wrap(self):
        main = load_vectors("wrap", "main")
        table = table_from_config(
            {"escape": {"enabled": True, "pairs": [["00", "7D5C"]]}}
        )
        kernel = escape_hex("01 00 02", table)
        out = build_wrapped(main["children"], [kernel])
        self.assertEqual(out["hex"], "FA FA 04 01 7D 5C 02 ED")
        self.assertEqual(out["total_length"], 8)


if __name__ == "__main__":
    unittest.main()
