"""R21（§8.52 排期 · 长度域 BE/LE）：协议 length 卡字节序出线。

共享向量单一真相源 = `vectors/length_order.json`（本文件与前端
`protocolTree.test.js` 同读一份，新增向量只写一处）。

三处实现（改一必改三）：
1. `LengthHandler.apply_byte_order` —— 发射期出线（`config.params.byte_order`）；
2. `frame_builder._with_byte_order` —— 协议 children → config.params 出口翻译
   （镜像 FE `toFrameBlocks.buildLogicConfig` 的同名分支）；
3. `response_generate._length_element` —— 自动生成的回显规则声明 `byte_order`
   （出线反转而规则仍按大端比 → 必然不匹配，声明必须跟上出线）。

缺省 / `big` / 枚举外 → 逐字节与本批之前一致（§0 硬约束）；收侧
`response_match.VALID_BYTE_ORDERS` 本就支持两值（test_response_match 已锚）。

> **R34（§8.66 · 校验和字节序）接手**：本文件当年明写的「仅 length 卡列此
> 字段，checksum 的 `byte_order` 未立项需另开」已由 `test_checksum_byte_order.py`
> 「另开」收掉 —— 下方 `test_checksum_blocks_*` 随之**翻面**（不写键 → 同闸门
> 写键），其余 length 断言一行未改。
"""
import unittest

from backend.core.frame_builder import _build_logic_config, _index_nodes, build_wrapped
from backend.core.response_generate import layer_stage_spec
from backend.handlers.length import LengthHandler, byte_order_of
from backend.schemas.block import Block, BlockConfig
from vectors.load_vectors import load_vectors

VECTORS = load_vectors("length_order")


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


def length_block(byte_order, byte_length=2, refs=("h",), offset=None):
    params = {"refs": list(refs)}
    if offset is not None:
        params["offset"] = offset
    if byte_order is not None:
        params["byte_order"] = byte_order
    return mk("L", btype="length", byte_length=byte_length, config=BlockConfig(params=params))


def junk_block(value):
    return mk(
        "L",
        btype="length",
        byte_length=2,
        config=BlockConfig(params={"refs": ["h"], "byte_order": value}),
    )


class SharedVectors(unittest.TestCase):
    """共享向量：refs 求和 → 大端格式化 → 按 byte_order 出线。"""

    def test_every_row(self):
        handler = LengthHandler()
        for row in VECTORS:
            with self.subTest(**row):
                blk = length_block(row["byte_order"], row["byte_length"])
                h = mk("h", byte_length=row["total"])
                self.assertEqual(handler.calculate(blk, flat(h)), row["expected"])


class DefaultByteIdentical(unittest.TestCase):
    """§0 硬约束：缺省口径逐字节不变。"""

    def test_missing_byte_order_stays_big(self):
        blk = length_block(None, 2)
        self.assertEqual(byte_order_of(blk), "big")
        self.assertEqual(LengthHandler().calculate(blk, flat(mk("h", byte_length=6))), "0006")

    def test_explicit_big_identical_to_missing(self):
        self.assertEqual(
            LengthHandler().calculate(length_block("big", 2), flat(mk("h", byte_length=6))),
            "0006",
        )

    def test_enumeration_out_fail_open_to_big(self):
        for junk in ("middle", "", 3, None, True):
            with self.subTest(junk=junk):
                blk = junk_block(junk)
                self.assertEqual(byte_order_of(blk), "big")
                self.assertEqual(
                    LengthHandler().calculate(blk, flat(mk("h", byte_length=6))), "0006"
                )

    def test_case_insensitive_little_accepted(self):
        # 与 FE `String(pc.byte_order).toLowerCase()==='little'` 同口径（大小写不敏感）。
        blk = junk_block("LITTLE")
        self.assertEqual(byte_order_of(blk), "little")
        self.assertEqual(
            LengthHandler().calculate(blk, flat(mk("h", byte_length=6))), "0600"
        )


class OtherPaths(unittest.TestCase):
    def test_range_mode_honours_byte_order(self):
        # 无 refs 键的旧 range 模式（target_start_id/target_end_id）同样反转。
        a, b = mk("a", byte_length=2), mk("b", byte_length=4)
        blk = mk(
            "L",
            btype="length",
            byte_length=2,
            config=BlockConfig(
                target_start_id="a", target_end_id="b", params={"byte_order": "little"}
            ),
        )
        # 区间 [a, b] 含两端 → 2+4 = 6 → 大端 0006 / 小端 0600
        self.assertEqual(LengthHandler().calculate(blk, flat(a, blk, b)), "0600")

    def test_config_none_still_zero_fill(self):
        blk = mk("L", btype="length", byte_length=2, config=None)
        self.assertEqual(LengthHandler().calculate(blk, flat(mk("h", byte_length=6))), "0000")

    def test_odd_width_malformed_output_not_reversed(self):
        # 值超出 byte_length：f"{300:02X}" = "12C"（3 位畸形）。大端路径本就输出
        # 奇数位，little 不发明语义、保持原样（不切成半字节乱序）。
        blk = length_block("little", byte_length=1, refs=(), offset=300)
        self.assertEqual(LengthHandler().calculate(blk, flat()), "12C")


class FrameBuilderMapping(unittest.TestCase):
    """协议 children → config.params 出口翻译（镜像 FE toFrameBlocks）。"""

    @staticmethod
    def _children(byte_order=None, with_refs=True):
        pc = {}
        if with_refs:
            pc["refs"] = ["h"]
        if byte_order is not None:
            pc["byte_order"] = byte_order
        return [
            {"id": "h", "label": "h", "type": "fixed", "byte_length": 2,
             "hex_value": "AABB", "config": {}, "children": []},
            {"id": "L", "label": "L", "type": "length", "byte_length": 2, "hex_value": "00",
             "config": {}, "children": [], "parameter_config": pc},
            {"id": "s", "label": "s", "type": "slot", "byte_length": 0, "hex_value": None,
             "config": {}, "children": []},
        ]

    @staticmethod
    def _hex(children):
        # 载荷 2B 注入插槽；Σ(refs=[h]) = 2 → 长度值 2（2 字节）
        return build_wrapped(children, ["CCDD"], ["s"])["hex"]

    def test_little_frame_and_logic_echo(self):
        out = build_wrapped(self._children("little"), ["CCDD"], ["s"])
        self.assertEqual(out["hex"], "AA BB 02 00 CC DD")
        self.assertEqual(
            [item for item in out["logic"] if item["type"] == "length"][0]["value"], "0200"
        )

    def test_big_and_absent_byte_identical(self):
        want = "AA BB 00 02 CC DD"
        self.assertEqual(self._hex(self._children("big")), want)
        self.assertEqual(self._hex(self._children(None)), want)
        # 未列 byte_order 的存量树 → params 不写键（形状与本批之前一致）
        children = self._children(None)
        by_id = {}
        _index_nodes(children, by_id)
        self.assertEqual(
            _build_logic_config(children[1], "length", by_id),
            {"params": {"refs": ["h"]}},
        )

    def test_byte_order_survives_refs_absent_path(self):
        # 存量树无 pc.refs → config 直通路径也必须带上字节序（面板只写一个键的场景）。
        node = {"id": "L", "type": "length", "byte_length": 2,
                "parameter_config": {"byte_order": "little"}}
        by_id = {}
        _index_nodes([node], by_id)
        self.assertEqual(_build_logic_config(node, "length", by_id),
                         {"params": {"byte_order": "little"}})

    def test_checksum_blocks_honour_byte_order(self):
        # R34（§8.66 · 校验和字节序）**翻面**：R21 期此处断言「校验块 byte_order
        # 不在范围 → 原样不写键」；本批把成对缺口「另开」收掉 → checksum 卡与
        # length 卡同一存点、同一值域、同一闸门（改一必改二，正主见
        # test_checksum_byte_order.py）。
        node = {"id": "C", "type": "checksum",
                "parameter_config": {"refs": [], "byte_order": "little"}}
        self.assertEqual(
            _build_logic_config(node, "checksum", {}),
            {"params": {"refs": [], "algorithm": "crc16_modbus",
                        "byte_order": "little"}},
        )
        # 缺省仍不写键 —— params 形状与 R21 期逐字节一致（§0 硬约束）。
        node["parameter_config"] = {"refs": []}
        self.assertEqual(
            _build_logic_config(node, "checksum", {}),
            {"params": {"refs": [], "algorithm": "crc16_modbus"}},
        )
        # length 卡不受牵连（仍只出自己的两个键）。
        ref = {"id": "h", "type": "fixed", "byte_length": 2, "hex_value": "AB",
               "children": []}
        len_node = {"id": "L", "type": "length", "byte_length": 2,
                    "parameter_config": {"refs": ["h"], "byte_order": "little",
                                         "encoding": "varint"}}
        by_id = {}
        _index_nodes([ref, len_node], by_id)
        self.assertEqual(
            _build_logic_config(len_node, "length", by_id),
            {"params": {"refs": ["h"], "byte_order": "little",
                        "encoding": "varint"}},
        )


class ResponseSpecDeclaration(unittest.TestCase):
    """自动生成的回显规则必须跟上出线字节序（否则出线小端 / 判定大端必失配）。"""

    @staticmethod
    def _children(byte_order=None):
        pc = {"refs": ["s"]}
        if byte_order is not None:
            pc["byte_order"] = byte_order
        return [
            {"id": "h", "type": "fixed", "byte_length": 1, "hex_value": "A0", "children": []},
            {"id": "l", "type": "length", "byte_length": 2,
             "parameter_config": pc, "children": []},
            {"id": "s", "type": "slot", "byte_length": 0, "children": []},
            {"id": "t", "type": "fixed", "byte_length": 1, "hex_value": "ED", "children": []},
        ]

    @staticmethod
    def _stage(children):
        warnings = []
        stage = layer_stage_spec(children, where="[层0]", warnings=warnings)
        return stage, warnings

    def test_little_declared(self):
        stage, warnings = self._stage(self._children("little"))
        self.assertEqual(warnings, [])
        self.assertEqual(stage["length"]["byte_order"], "little")

    def test_default_and_enumeration_out_declare_big(self):
        for value in (None, "middle", ""):
            with self.subTest(value=value):
                stage, warnings = self._stage(self._children(value))
                self.assertEqual(warnings, [])
                self.assertEqual(stage["length"]["byte_order"], "big")

    def test_big_declared_explicitly(self):
        stage, _ = self._stage(self._children("big"))
        self.assertEqual(stage["length"]["byte_order"], "big")


if __name__ == "__main__":
    unittest.main()
