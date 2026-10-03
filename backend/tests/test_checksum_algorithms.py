"""R22（§8.52 排期 · CRC 多算法）：CRC16-CCITT / CRC32 / LRC 三算法三端同源。

共享向量单一真相源 = `vectors/checksum_algo.json`（本文件与前端
`checksumAlgo.test.js` 同读一份，新增向量只写一处）。表内 6 算法 × 5 输入，
期望值由独立来源生成（crc32=zlib、ccitt=binascii.crc_hqx、三枚已发布 check 值
自校验），不来自本仓实现。

三处实现（改一必改三）：
1. `ChecksumHandler` —— 发射期出线（refs 模式与旧区间模式两个 return 同位扩）；
2. `response_match.checksum_value` —— 收侧判定 / P3 序列补丁写入的公共入口；
3. `formula.js calculateChecksum` —— FE 编码器与设计期卡面（见 FE 侧测试）。

四张白名单同批成对改：`response_match.VALID_ALGOS`（收侧）、
`frame_builder.BACKEND_ALGO`（出口翻译）、FE `validateProtocol.VALID_ALGOS`、
FE `sequenceView.PLAN_ALGO`（计划冻结），另加 `operator.py` 指令页算子模板。

遗留口径不变（§0）：sum/xor 任意宽度、crc16_modbus 必须恰好 2 字节、
缺省算法与缺省字段宽逐字节与本批之前一致。
"""
import unittest

from backend.core.frame_builder import (
    BACKEND_ALGO,
    _build_logic_config,
    _index_nodes,
    build_wrapped,
)
from backend.core.response_generate import layer_stage_spec
from backend.core.response_match import (
    ALGO_FIELD_WIDTH,
    VALID_ALGOS,
    checksum_value,
    normalize_spec,
)
from backend.core.sequence_plan import normalize_plan
from backend.handlers.checksum import ChecksumHandler
from backend.schemas.block import Block, BlockConfig
from vectors.load_vectors import load_vectors

VECTORS = load_vectors("checksum_algo")

# 六算法的规范枚举（FE ChecksumAlgo ↔ 后端 params.algorithm）
FE_ALGOS = ["SUM_8", "XOR_8", "CRC_16_MODBUS", "CRC_16_CCITT", "CRC_32", "LRC"]
BE_ALGOS = ["sum", "xor", "crc16_modbus", "crc16_ccitt", "crc32", "lrc"]
WIDTH = {"sum": 1, "xor": 1, "crc16_modbus": 2, "crc16_ccitt": 2, "crc32": 4, "lrc": 1}


def spaced(hex_str):
    """build_wrapped 返回**空格分字节**的展示串；向量里的 expected 是紧凑串。"""
    return " ".join(hex_str[i:i + 2] for i in range(0, len(hex_str), 2))


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


def checksum_block(algo, byte_length, refs=("h",)):
    return mk(
        "C",
        btype="checksum",
        byte_length=byte_length,
        config=BlockConfig(params={"refs": list(refs), "algorithm": algo}),
    )


class SharedVectors(unittest.TestCase):
    """共享向量 vectors/checksum_algo.json：出线（handler）与收侧（checksum_value）。"""

    def test_handler_every_row(self):
        handler = ChecksumHandler()
        for row in VECTORS:
            with self.subTest(**row):
                data = bytes.fromhex(row["data"])
                src = mk("h", hex_value=row["data"], byte_length=len(data))
                blk = checksum_block(BACKEND_ALGO[row["algo"]], row["width"])
                self.assertEqual(handler.calculate(blk, flat(src)), row["expected"])

    def test_checksum_value_every_row(self):
        # 收侧公共入口：按字段宽算值，与出线同串（格式化到 row["width"] 字节）。
        for row in VECTORS:
            with self.subTest(**row):
                value = checksum_value(
                    BACKEND_ALGO[row["algo"]], bytes.fromhex(row["data"]), row["width"]
                )
                self.assertEqual(f"{value:0{row['width'] * 2}X}", row["expected"])

    def test_row_count_and_algo_coverage(self):
        # 表必须覆盖六算法（少一端 → 该算法无回归锚）。
        self.assertEqual(len(VECTORS), 30)
        self.assertEqual({row["algo"] for row in VECTORS}, set(FE_ALGOS))

    def test_range_mode_honours_algo_like_refs_mode(self):
        # 旧区间模式（target_start_id/target_end_id，无 refs）必须与 refs 模式同值 ——
        # 否则同一配置换一种引用方式就出不同字节。
        row = next(r for r in VECTORS if r["algo"] == "CRC_32" and r["data"] == "DEADBEEF")
        h = mk("h", hex_value="DEADBEEF", byte_length=4)
        t = mk("t", hex_value="00", byte_length=1)
        blk = mk(
            "C",
            btype="checksum",
            byte_length=4,
            config=BlockConfig(
                target_start_id="h", target_end_id="h",
                params={"algorithm": BACKEND_ALGO[row["algo"]]},
            ),
        )
        self.assertEqual(ChecksumHandler().calculate(blk, flat(h, blk, t)), row["expected"])


class EnumAndMapping(unittest.TestCase):
    """四张白名单 + 出口翻译表的值域一致性。"""

    def test_valid_algos_six(self):
        self.assertEqual(set(VALID_ALGOS), set(BE_ALGOS))

    def test_backend_algo_is_bijection(self):
        self.assertEqual(BACKEND_ALGO, dict(zip(FE_ALGOS, BE_ALGOS)))

    def test_algo_field_width_table(self):
        self.assertEqual(ALGO_FIELD_WIDTH, {"sum": None, "xor": None,
                                            "crc16_modbus": 2, "crc16_ccitt": 2,
                                            "crc32": 4, "lrc": 1})

    def test_frame_builder_maps_fe_enum_to_params(self):
        for fe, be in zip(FE_ALGOS, BE_ALGOS):
            with self.subTest(fe=fe):
                node = {"id": "C", "type": "checksum", "byte_length": WIDTH[BACKEND_ALGO[fe]],
                        "parameter_config": {"refs": ["h"], "algorithm": fe}}
                ref = {"id": "h", "type": "fixed", "byte_length": 2, "hex_value": "ABCD",
                       "children": []}
                by_id = {}
                _index_nodes([ref, node], by_id)  # refs 解析需要 by_id，空索引会掉成 []
                self.assertEqual(
                    _build_logic_config(node, "checksum", by_id),
                    {"params": {"refs": ["h"], "algorithm": be}},
                )


class FieldWidthRules(unittest.TestCase):
    """收侧 normalize_spec：缺省宽 + 遗留精确规则 + 新增下限规则。"""

    @staticmethod
    def spec(**kw):
        return normalize_spec({"checksum": {"field_offset": 0, **kw}})["checksum"]

    def test_defaults_per_algo(self):
        for algo, want in WIDTH.items():
            with self.subTest(algo=algo):
                self.assertEqual(self.spec(algo=algo)["field_byte_length"], want)

    def test_legacy_crc16_modbus_exact_two_unchanged(self):
        # 遗留：恰好 2 字节（宽了窄了都 400）—— 本批不动。
        self.assertEqual(self.spec(algo="crc16_modbus")["field_byte_length"], 2)
        for bl in (1, 4):
            with self.subTest(bl=bl):
                with self.assertRaises(ValueError):
                    self.spec(algo="crc16_modbus", field_byte_length=bl)

    def test_new_algos_reject_too_narrow(self):
        # 宽度不足 → 值放不进字段（crc32 在 to_bytes(2) 上会 OverflowError → 500），
        # 收口为 400。
        for algo, bl in (("crc32", 2), ("crc32", 3), ("crc16_ccitt", 1)):
            with self.subTest(algo=algo, bl=bl):
                with self.assertRaises(ValueError):
                    self.spec(algo=algo, field_byte_length=bl)

    def test_new_algos_accept_adequate_or_wider(self):
        # ≥ 下限即可（宽字段零填充，出线 f"{v:0{w*2}X}" 同为「字段宽下限」语义）。
        for algo, bl in (("crc32", 4), ("crc16_ccitt", 2),
                         ("crc16_ccitt", 4), ("lrc", 1), ("lrc", 2),
                         ("sum", 2), ("xor", 1)):
            with self.subTest(algo=algo, bl=bl):
                self.assertEqual(self.spec(algo=algo, field_byte_length=bl)["field_byte_length"], bl)

    def test_out_of_enum_still_rejected(self):
        with self.assertRaises(ValueError):
            self.spec(algo="crc_32_legacy")


class SequencePlanRules(unittest.TestCase):
    """序列计划（normalize_plan）与收侧同一张宽度表。"""

    PAYLOAD = "AABBCCDD11223344"  # 8 字节（hex 串 16 字符）

    @staticmethod
    def plan(algo, byte_length):
        return {"checksum": {"offset": 4, "byte_length": byte_length,
                             "regions": [[0, 4]], "algo": algo}}

    def test_crc32_accepted_at_four(self):
        _, plan = normalize_plan(self.PAYLOAD, self.plan("crc32", 4))
        self.assertEqual(plan["checksum"]["algo"], "crc32")
        self.assertEqual(plan["checksum"]["byte_length"], 4)

    def test_crc32_rejected_at_two(self):
        with self.assertRaises(ValueError):
            normalize_plan(self.PAYLOAD, self.plan("crc32", 2))

    def test_crc16_ccitt_rejected_at_one(self):
        with self.assertRaises(ValueError):
            normalize_plan(self.PAYLOAD, self.plan("crc16_ccitt", 1))

    def test_legacy_crc16_modbus_still_exact_two(self):
        with self.assertRaises(ValueError):
            normalize_plan(self.PAYLOAD, self.plan("crc16_modbus", 1))


class FrameBuilderOutLine(unittest.TestCase):
    """出线端到端：协议树 CRC_32 → 帧内 4 字节校验值（取自共享向量）。"""

    @staticmethod
    def children():
        return [
            {"id": "h", "label": "h", "type": "fixed", "byte_length": 4,
             "hex_value": "DEADBEEF", "config": {}, "children": []},
            {"id": "c", "label": "c", "type": "checksum", "byte_length": 4,
             "hex_value": "00000000", "config": {}, "children": [],
             "parameter_config": {"refs": ["h"], "algorithm": "CRC_32"}},
            {"id": "s", "label": "s", "type": "slot", "byte_length": 0, "hex_value": None,
             "config": {}, "children": []},
        ]

    @staticmethod
    def want(algo, data):
        return next(r["expected"] for r in VECTORS if r["algo"] == algo and r["data"] == data)

    def test_crc32_frame_hex(self):
        out = build_wrapped(self.children(), ["CCDD"], ["s"])
        self.assertEqual(out["hex"], f"DE AD BE EF {spaced(self.want('CRC_32', 'DEADBEEF'))} CC DD")

    def test_ccitt_frame_hex(self):
        children = self.children()
        children[1]["byte_length"] = 2
        children[1]["hex_value"] = "0000"
        children[1]["parameter_config"]["algorithm"] = "CRC_16_CCITT"
        out = build_wrapped(children, ["CCDD"], ["s"])
        self.assertEqual(
            out["hex"],
            f"DE AD BE EF {spaced(self.want('CRC_16_CCITT', 'DEADBEEF'))} CC DD",
        )

    def test_lrc_frame_hex(self):
        children = self.children()
        children[1]["byte_length"] = 1
        children[1]["hex_value"] = "00"
        children[1]["parameter_config"]["algorithm"] = "LRC"
        out = build_wrapped(children, ["CCDD"], ["s"])
        self.assertEqual(out["hex"], f"DE AD BE EF {self.want('LRC', 'DEADBEEF')} CC DD")


class ResponseSpecDeclaration(unittest.TestCase):
    """自动生成的回显规则必须声明新算法 + 宽度不足弃生成（否则判定 400）。"""

    @staticmethod
    def children(algo, byte_length):
        return [
            {"id": "h", "type": "fixed", "byte_length": 4, "hex_value": "DEADBEEF",
             "children": []},
            # refs 必须「只圈载荷」或「整层全部」—— 此处指向插槽（镜像
            # test_response_generate 的 [fixed][slot][checksum refs=插槽][fixed] 层序）。
            {"id": "s", "type": "slot", "byte_length": 0, "children": []},
            {"id": "c", "type": "checksum", "byte_length": byte_length,
             "parameter_config": {"refs": ["s"], "algorithm": algo}, "children": []},
            {"id": "t", "type": "fixed", "byte_length": 1, "hex_value": "ED", "children": []},
        ]

    def test_algo_declared_for_new_algorithms(self):
        for algo, be, bl in (("CRC_16_CCITT", "crc16_ccitt", 2),
                             ("CRC_32", "crc32", 4), ("LRC", "lrc", 1)):
            with self.subTest(algo=algo):
                warnings = []
                stage = layer_stage_spec(self.children(algo, bl), where="[层0]",
                                         warnings=warnings)
                self.assertEqual(warnings, [])
                self.assertEqual(stage["checksum"]["algo"], be)
                self.assertEqual(stage["checksum"]["field_byte_length"], bl)

    def test_too_narrow_field_skips_checksum_with_warning(self):
        warnings = []
        stage = layer_stage_spec(self.children("CRC_32", 2), where="[层0]", warnings=warnings)
        self.assertIsNone(stage["checksum"])
        self.assertEqual(len(warnings), 1)
        self.assertIn("≥ 4 字节", warnings[0])

    def test_legacy_crc16_warning_wording_unchanged(self):
        # 遗留：crc16_modbus 宽了窄了都弃生成，文案不变。
        for bl in (1, 4):
            with self.subTest(bl=bl):
                warnings = []
                stage = layer_stage_spec(self.children("CRC_16_MODBUS", bl),
                                         where="[层0]", warnings=warnings)
                self.assertIsNone(stage["checksum"])
                self.assertIn("须 2 字节", warnings[0])


class LegacyUnchanged(unittest.TestCase):
    """§0 硬约束：存量算法的缺省口径逐字节不变。"""

    @staticmethod
    def frame_hex(algorithm, byte_length=2):
        children = [
            {"id": "h", "label": "h", "type": "fixed", "byte_length": 2,
             "hex_value": "ABCD", "config": {}, "children": []},
            {"id": "c", "label": "c", "type": "checksum", "byte_length": byte_length,
             "hex_value": "0000", "config": {}, "children": [],
             "parameter_config": {"refs": ["h"], "algorithm": algorithm}},
            {"id": "s", "label": "s", "type": "slot", "byte_length": 0, "hex_value": None,
             "config": {}, "children": []},
        ]
        return build_wrapped(children, ["CCDD"], ["s"])["hex"]

    def test_sum_and_xor_bytes_unchanged(self):
        # 0xAB+0xCD = 0x178 → 按 256^2 取模后仍 0178；0xAB^0xCD = 0x66 → 零填 0066。
        self.assertEqual(self.frame_hex("SUM_8"), "AB CD 01 78 CC DD")
        self.assertEqual(self.frame_hex("XOR_8"), "AB CD 00 66 CC DD")

    def test_crc16_modbus_handler_matches_checksum_value(self):
        # 出线（ChecksumHandler）与收侧（checksum_value）两套实现必须同值 ——
        # 分叉即「发得出去、判不回来」。真值锚在共享向量的 crc16_modbus 行。
        want = self.want_crc16("ABCD")
        self.assertEqual(self.frame_hex("CRC_16_MODBUS"), f"AB CD {spaced(want)} CC DD")
        self.assertEqual(self.want_crc16(""), f"{0xFFFF:04X}")  # 空区间：handler 短路全 0

    @staticmethod
    def want_crc16(data_hex):
        return f"{checksum_value('crc16_modbus', bytes.fromhex(data_hex), 2):04X}"


if __name__ == "__main__":
    unittest.main()
