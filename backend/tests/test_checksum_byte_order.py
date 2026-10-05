"""R34（§8.66 排期 · 校验和字节序）：协议 checksum 卡 `parameter_config.byte_order`。

R21（§8.53 · 长度域 BE/LE）的**成对缺口** —— PLAN §8.53 尾行当时明写「仅 length
卡列此字段，checksum 的 `byte_order` 未立项，需另开」，本批即「另开」的那一批。

共享向量单一真相源 = `vectors/checksum_order.json`（本文件与前端
`checksumOrder.test.js` 同读一份，新增向量只写一处）。真值链不自证：
`expected_big` 逐字取自 R22 `vectors/checksum_algo.json` 的外部真值（zlib /
binascii / 已发布 check 值），`expected_little` = 字节反转（little 的定义）。

三处实现（改一必改三）：
1. `ChecksumHandler` —— 发射期出线（refs 模式与旧区间模式**两个 return 同位套用**）；
2. `frame_builder._with_byte_order` —— 协议 children → config.params 出口翻译
   （镜像 FE `toFrameBlocks.withLogicParams` 的同名分支）；
3. `response_generate._checksum_element` —— 自动生成的比对规则声明 `byte_order`
   （出线反转而规则仍按大端比 → **必然失配**，声明必须跟上出线）。

收侧**本就支持**、本批零改动：`response_match` 的 `_CHECKSUM_KEYS` 早已含
`byte_order`（`checksum_value(...).to_bytes(field_bl, cs["byte_order"])`）、
`sequence_plan._normalize_checksum` 同（R21/R22 期留的口），`test_response_match`
与 `test_sequence_plan` 既有锚继续有效。

缺省 / `big` / 枚举外 / 大小写 → 逐字节与本批之前一致（§0 硬约束）。
"""
import unittest

from backend.core.frame_builder import BACKEND_ALGO, _build_logic_config, _index_nodes
from backend.core.response_generate import layer_stage_spec
from backend.handlers.checksum import ChecksumHandler
from backend.schemas.block import Block, BlockConfig
from vectors.load_vectors import load_vectors

VECTORS = load_vectors("checksum_order")


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


def checksum_block(algo, byte_length, refs=("h",), byte_order=None):
    params = {"refs": list(refs), "algorithm": algo}
    if byte_order is not None:
        params["byte_order"] = byte_order
    return mk(
        "C",
        btype="checksum",
        byte_length=byte_length,
        config=BlockConfig(params=params),
    )


def source(row):
    data = bytes.fromhex(row["data"])
    return mk("h", hex_value=row["data"], byte_length=len(data))


class SharedVectors(unittest.TestCase):
    """共享向量 vectors/checksum_order.json：出线（handler）逐行同串。"""

    def test_every_row(self):
        handler = ChecksumHandler()
        for row in VECTORS:
            with self.subTest(**row):
                blk = checksum_block(
                    BACKEND_ALGO[row["algo"]],
                    row["byte_length"],
                    byte_order=row["byte_order"],
                )
                self.assertEqual(
                    handler.calculate(blk, flat(source(row))), row["expected"]
                )

    def test_table_shape(self):
        # 6 算法 × 2 字节序；单字节算法（SUM_8 / XOR_8 / LRC）两侧同串
        # → 「1 字节不反转」也钉在表里。
        self.assertEqual(len(VECTORS), 12)
        self.assertEqual({r["byte_order"] for r in VECTORS}, {"big", "little"})
        self.assertEqual(len({r["algo"] for r in VECTORS}), 6)
        for algo in ("SUM_8", "XOR_8", "LRC"):
            pair = [r for r in VECTORS if r["algo"] == algo]
            self.assertEqual(pair[0]["expected"], pair[1]["expected"], algo)

    def test_little_is_reversed_big(self):
        # 2 字节以上算法：little 必须恰为 big 的字节反转（不多不少）。
        by_key = {(r["algo"], r["byte_order"]): r for r in VECTORS}
        for algo in ("CRC_16_MODBUS", "CRC_16_CCITT", "CRC_32"):
            big = by_key[(algo, "big")]["expected"]
            little = by_key[(algo, "little")]["expected"]
            self.assertEqual(
                little, "".join(big[i:i + 2] for i in range(len(big) - 2, -1, -2)), algo
            )
            self.assertNotEqual(little, big, algo)


class RangeModeParity(unittest.TestCase):
    """旧区间模式（target_start/end）必须与 refs 模式同字节序 —— 换引用方式不换形态。"""

    def test_range_honours_little(self):
        row = next(r for r in VECTORS if r["algo"] == "CRC_16_MODBUS"
                   and r["byte_order"] == "little")
        data = bytes.fromhex(row["data"])
        h = mk("h", hex_value=row["data"], byte_length=len(data))
        t = mk("t", hex_value="00", byte_length=1)
        blk = mk(
            "C",
            btype="checksum",
            byte_length=row["byte_length"],
            config=BlockConfig(
                target_start_id="h", target_end_id="h",
                params={"algorithm": BACKEND_ALGO[row["algo"]],
                        "byte_order": "little"},
            ),
        )
        self.assertEqual(ChecksumHandler().calculate(blk, flat(h, blk, t)), row["expected"])

    def test_range_defaults_to_big(self):
        # 缺省 byte_order → 与本批之前逐字节一致（range 与 refs 两侧同口径）。
        row = next(r for r in VECTORS if r["algo"] == "CRC_16_MODBUS"
                   and r["byte_order"] == "big")
        data = bytes.fromhex(row["data"])
        h = mk("h", hex_value=row["data"], byte_length=len(data))
        t = mk("t", hex_value="00", byte_length=1)
        blk = mk(
            "C",
            btype="checksum",
            byte_length=row["byte_length"],
            config=BlockConfig(
                target_start_id="h", target_end_id="h",
                params={"algorithm": BACKEND_ALGO[row["algo"]]},
            ),
        )
        self.assertEqual(ChecksumHandler().calculate(blk, flat(h, blk, t)), row["expected"])


class FailOpen(unittest.TestCase):
    """缺省 / big / 枚举外 / 大小写 → 一律大端（fail-open，镜像 length 同名口径）。"""

    def _calc(self, byte_order):
        row = next(r for r in VECTORS if r["algo"] == "CRC_16_MODBUS"
                   and r["byte_order"] == "big")
        blk = checksum_block(
            BACKEND_ALGO[row["algo"]], row["byte_length"], byte_order=byte_order
        )
        return ChecksumHandler().calculate(blk, flat(source(row)))

    def test_missing_means_big(self):
        row = next(r for r in VECTORS if r["algo"] == "CRC_16_MODBUS"
                   and r["byte_order"] == "big")
        blk = checksum_block(BACKEND_ALGO[row["algo"]], row["byte_length"])   # 不写键
        self.assertEqual(
            ChecksumHandler().calculate(blk, flat(source(row))), row["expected"]
        )

    def test_enumeration_out_and_blanks_stay_big(self):
        big = next(r for r in VECTORS if r["algo"] == "CRC_16_MODBUS"
                   and r["byte_order"] == "big")["expected"]
        for value in ("middle", "", "LITTLE-ENDIAN"):
            with self.subTest(value=value):
                self.assertEqual(self._calc(value), big)

    def test_case_insensitive(self):
        little = next(r for r in VECTORS if r["algo"] == "CRC_16_MODBUS"
                      and r["byte_order"] == "little")["expected"]
        # 与 FE `String(pc.byte_order).toLowerCase()==='little'` 同口径：大小写不敏感。
        self.assertEqual(self._calc("  LiTtLe "), little)


class FrameBuilderTranslation(unittest.TestCase):
    """协议 children → config.params：只在 little 时写键（缺省形状与存量逐字节一致）。"""

    def test_checksum_little_written(self):
        node = {"id": "C", "type": "checksum",
                "parameter_config": {"refs": ["h"], "algorithm": "CRC_16_MODBUS",
                                     "byte_order": "little"}}
        ref = {"id": "h", "type": "fixed", "byte_length": 2, "hex_value": "ABCD",
               "children": []}
        by_id = {}
        _index_nodes([ref, node], by_id)
        self.assertEqual(
            _build_logic_config(node, "checksum", by_id),
            {"params": {"refs": ["h"], "algorithm": "crc16_modbus",
                        "byte_order": "little"}},
        )

    def test_checksum_default_and_enum_out_write_nothing(self):
        # 键缺失 / big / 枚举外 → 不写键（params 形状与本批之前逐字节一致，§0）。
        ref = {"id": "h", "type": "fixed", "byte_length": 2, "hex_value": "ABCD",
               "children": []}
        for value in (None, "big", "middle"):
            with self.subTest(value=value):
                pc = {"refs": ["h"], "algorithm": "CRC_16_MODBUS"}
                if value is not None:
                    pc["byte_order"] = value
                node = {"id": "C", "type": "checksum", "parameter_config": pc}
                by_id = {}
                _index_nodes([ref, node], by_id)
                self.assertEqual(
                    _build_logic_config(node, "checksum", by_id),
                    {"params": {"refs": ["h"], "algorithm": "crc16_modbus"}},
                )

    def test_checksum_without_refs_still_honours_order(self):
        # pc.refs 键缺失 → config 直通，byte_order 仍生效（镜像 length 直通路径）。
        node = {"id": "C", "type": "checksum",
                "parameter_config": {"byte_order": "little"}}
        self.assertEqual(
            _build_logic_config(node, "checksum", {}),
            {"params": {"byte_order": "little"}},
        )


class ResponseSpecDeclaration(unittest.TestCase):
    """自动生成的比对规则必须跟上出线字节序（否则出线小端 / 判定大端必失配）。"""

    @staticmethod
    def _children(byte_order=None):
        pc = {"refs": ["s"], "algorithm": "CRC_16_MODBUS"}
        if byte_order is not None:
            pc["byte_order"] = byte_order
        return [
            {"id": "h", "type": "fixed", "byte_length": 1, "hex_value": "A0", "children": []},
            {"id": "l", "type": "length", "byte_length": 2,
             "parameter_config": {"refs": ["s"]}, "children": []},
            {"id": "c", "type": "checksum", "byte_length": 2,
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
        self.assertIsNotNone(stage["checksum"], "checksum 规则未生成 → 断言会失真")
        self.assertEqual(stage["checksum"]["byte_order"], "little")

    def test_default_and_enumeration_out_declare_big(self):
        for value in (None, "middle", ""):
            with self.subTest(value=value):
                stage, warnings = self._stage(self._children(value))
                self.assertEqual(warnings, [])
                self.assertEqual(stage["checksum"]["byte_order"], "big")

    def test_big_declared_explicitly(self):
        stage, _ = self._stage(self._children("big"))
        self.assertEqual(stage["checksum"]["byte_order"], "big")


if __name__ == "__main__":
    unittest.main()
