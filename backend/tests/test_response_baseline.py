"""R28（PLAN §8.52 排期第 8 批 · §8.60 定案）Phase 0 硬前置：**无变长编码、无 COBS 层时
逐字节不变** —— 应答规格归一化 / 判定 / 据此生成三条路径的金标准看守。

金标准抓自 R28 改动**之前**的实现（Temp ev_r28_baseline.py → ev_r28_baseline.json），
本文件由同一份 JSON 机械生成、不手抄。R28 的新键（`length.encoding` /
`unpack.mode` / `unpack.inner_head` / `unpack.inner_trailer`）**只写非缺省值** ——
缺失键 = 存量口径，故下面每一条输出在改后必须逐字节相同；任何一条变了 = 退回
R28（或显式更新本文件并说明为什么那不是回归）。

三层帧主向量单一真相源 = vectors/wrap.json · 表 three（与 test_response_generate 同读）。
Run from repo root: python -m unittest backend.tests.test_response_baseline
"""

import json
import unittest

from backend.core.response_generate import build_spec, layer_stage_spec
from backend.core.response_match import match_response, normalize_spec
from vectors.load_vectors import load_vectors

THREE = load_vectors("wrap", "three")
CANON = bytes.fromhex("C008B005A0020102E0E1E2")


def _layers():
    return [
        {
            "protocol_id": layer["protocol_id"],
            "label": layer["label"],
            "children": layer["children"],
        }
        for layer in THREE["layers"]
    ]


def _inner():
    first = THREE["layers"][0]
    return [{"protocol_id": first["protocol_id"], "label": first["label"],
             "children": first["children"]}]


# ---- 儿何样例（与 test_response_generate 同形，禁用块 / 容器 / 区间模式都在内） ----
CHILD_A = [
    {"id": "h", "type": "fixed", "byte_length": 1, "hex_value": "A0", "children": []},
    {"id": "l", "type": "length", "byte_length": 1, "parameter_config": {"refs": ["s"]}, "children": []},
    {"id": "s", "type": "slot", "byte_length": 0, "children": []},
    {"id": "c", "type": "checksum", "byte_length": 1,
     "parameter_config": {"algorithm": "SUM_8", "refs": ["s"]}, "children": []},
    {"id": "t", "type": "fixed", "byte_length": 1, "hex_value": "ED", "children": []},
]
CHILD_B = [
    {"id": "h", "type": "fixed", "byte_length": 1, "hex_value": "A0", "children": []},
    {"id": "s", "type": "slot", "byte_length": 0, "children": []},
    {"id": "l", "type": "length", "byte_length": 1, "parameter_config": {"refs": ["s"]}, "children": []},
    {"id": "t", "type": "fixed", "byte_length": 1, "hex_value": "ED", "children": []},
]
CHILD_C = [
    {"id": "g", "type": "container", "byte_length": 0, "children": [
        {"id": "g1", "type": "fixed", "byte_length": 2, "hex_value": "FA FA", "children": []},
        {"id": "g2", "type": "fixed", "byte_length": 1, "hex_value": "BB", "is_enabled": False,
         "children": []},
    ]},
    {"id": "l", "type": "length", "byte_length": 1, "children": []},
    {"id": "s", "type": "slot", "byte_length": 0, "children": []},
    {"id": "t", "type": "fixed", "byte_length": 1, "hex_value": "ED", "children": []},
]
CHILD_D = CHILD_A
CHILDREN = {"A": CHILD_A, "B": CHILD_B, "C": CHILD_C, "D": CHILD_D}


def _stage(children):
    return layer_stage_spec(children, where="[层0]", warnings=[])


# ================= 金标准（机械内嵌，勿手改） =================
NORM_SRC = json.loads(r'''[{}, {"mode": "echo"}, {"mode": "rules", "prefix": "aa 55", "suffix": "0d_0a", "echo_header_bytes": 2}, {"mode": "any"}, {"mode": "rules", "echo_header_bytes": 1, "length": {"offset": 1, "byte_length": 2, "offset_val": -3, "byte_order": "little"}, "checksum": {"algo": "crc32", "field_offset": 4, "field_byte_length": 4, "span_start": 0, "span_end": null, "byte_order": "big", "span_end_pad": 0, "field_offset_from_end": null}, "ignore_ranges": [[0, 2], [4, 6]]}, {"mode": "rules", "length": {"offset": 0, "byte_length": 1, "offset_from_end": 2, "offset_val": -4}, "checksum": {"algo": "sum", "field_byte_length": 1, "span_start": 2, "span_end": null, "span_end_pad": 2}}, {"mode": "rules", "stages": [{"echo_header_bytes": 1, "length": {"byte_length": 1, "offset_val": -3, "byte_order": "big", "offset": 1}, "checksum": null, "unpack": {"head": 2, "trailer": 1}, "prefix": "", "suffix": ""}, {"echo_header_bytes": 1, "length": {"byte_length": 1, "offset_val": -3, "byte_order": "big", "offset": 1}, "checksum": null, "unpack": {"head": 2, "trailer": 1}, "prefix": "", "suffix": ""}, {"echo_header_bytes": 1, "length": {"byte_length": 1, "offset_val": -3, "byte_order": "big", "offset": 1}, "checksum": null, "unpack": {"head": 2, "trailer": 1}, "prefix": "", "suffix": ""}]}, [1, 2], {"mode": "echo", "regex": ".*"}, {"mode": "carrier-pigeon"}, {"prefix": "A"}, {"suffix": "ZZ"}, {"echo_header_bytes": true}, {"length": {"offset": 1, "byte_length": 5}}, {"length": {"byte_order": "middle"}}, {"length": {"offset": 1, "offset_from_end": 1}}, {"checksum": {"algo": "crc16_modbus", "field_byte_length": 1}}, {"checksum": {"algo": "nope"}}, {"ignore_ranges": [[0, 5], [3, 8]]}, {"mode": "echo", "stages": [{"unpack": {"head": 1, "trailer": 0}}]}, {"mode": "rules", "length": {"offset": 0}, "stages": [{"unpack": {"head": 1, "trailer": 0}}]}, {"mode": "rules", "stages": []}, {"mode": "rules", "stages": [{"prefix": "", "suffix": "", "nope": 1}]}, {"mode": "rules", "stages": [{"prefix": "", "suffix": "", "unpack": {"head": 0, "trailer": 0}}]}, {"mode": "rules", "stages": [{"prefix": "", "suffix": "", "unpack": {"zz": 1}}]}]''')
NORM_GOLD = json.loads(r'''["{\"mode\":\"echo\",\"prefix\":\"\",\"suffix\":\"\",\"echo_header_bytes\":0,\"length\":null,\"checksum\":null,\"ignore_ranges\":[]}", "{\"mode\":\"echo\",\"prefix\":\"\",\"suffix\":\"\",\"echo_header_bytes\":0,\"length\":null,\"checksum\":null,\"ignore_ranges\":[]}", "{\"mode\":\"rules\",\"prefix\":\"AA55\",\"suffix\":\"0D0A\",\"echo_header_bytes\":2,\"length\":null,\"checksum\":null,\"ignore_ranges\":[]}", "{\"mode\":\"any\",\"prefix\":\"\",\"suffix\":\"\",\"echo_header_bytes\":0,\"length\":null,\"checksum\":null,\"ignore_ranges\":[]}", "{\"mode\":\"rules\",\"prefix\":\"\",\"suffix\":\"\",\"echo_header_bytes\":1,\"length\":{\"offset\":1,\"byte_length\":2,\"offset_val\":-3,\"byte_order\":\"little\",\"offset_from_end\":null},\"checksum\":{\"algo\":\"crc32\",\"field_offset\":4,\"field_byte_length\":4,\"span_start\":0,\"span_end\":null,\"byte_order\":\"big\",\"span_end_pad\":0,\"field_offset_from_end\":null},\"ignore_ranges\":[[0,2],[4,6]]}", "{\"mode\":\"rules\",\"prefix\":\"\",\"suffix\":\"\",\"echo_header_bytes\":0,\"length\":{\"offset\":0,\"byte_length\":1,\"offset_val\":-4,\"byte_order\":\"big\",\"offset_from_end\":2},\"checksum\":{\"algo\":\"sum\",\"field_offset\":0,\"field_byte_length\":1,\"span_start\":2,\"span_end\":null,\"byte_order\":\"big\",\"span_end_pad\":2,\"field_offset_from_end\":null},\"ignore_ranges\":[]}", "{\"mode\":\"rules\",\"prefix\":\"\",\"suffix\":\"\",\"echo_header_bytes\":0,\"length\":null,\"checksum\":null,\"ignore_ranges\":[],\"stages\":[{\"prefix\":\"\",\"suffix\":\"\",\"echo_header_bytes\":1,\"length\":{\"offset\":1,\"byte_length\":1,\"offset_val\":-3,\"byte_order\":\"big\",\"offset_from_end\":null},\"checksum\":null,\"unpack\":{\"head\":2,\"trailer\":1}},{\"prefix\":\"\",\"suffix\":\"\",\"echo_header_bytes\":1,\"length\":{\"offset\":1,\"byte_length\":1,\"offset_val\":-3,\"byte_order\":\"big\",\"offset_from_end\":null},\"checksum\":null,\"unpack\":{\"head\":2,\"trailer\":1}},{\"prefix\":\"\",\"suffix\":\"\",\"echo_header_bytes\":1,\"length\":{\"offset\":1,\"byte_length\":1,\"offset_val\":-3,\"byte_order\":\"big\",\"offset_from_end\":null},\"checksum\":null,\"unpack\":{\"head\":2,\"trailer\":1}}]}", "ERR:应答规格必须是对象", "ERR:未知规格字段: regex", "ERR:未知匹配模式: 'carrier-pigeon'（可选 echo/rules/any）", "ERR:prefix 必须是偶数位十六进制", "ERR:suffix 含非法十六进制字符: non-hexadecimal number found in fromhex() arg at position 0", "ERR:echo_header_bytes 必须是整数", "ERR:length.byte_length 必须在 1..4 范围内", "ERR:length.byte_order 必须是 big/little 之一", "ERR:length.offset 与 length.offset_from_end 只能给其一", "ERR:crc16_modbus 的校验字段必须是 2 字节", "ERR:checksum.algo 必须是 sum/xor/crc16_modbus/crc16_ccitt/crc32/lrc 之一", "ERR:ignore_ranges 区间重叠: [0, 5) 与 [3, 8)", "ERR:多层规格 mode 不得为 echo（逐层结构校验用 rules / any）", "ERR:多层规格的 length 须按层写进 stages[..]（顶层只留 framing）", "ERR:stages 不能为空（单层规格不要写 stages 键）", "ERR:stages[0] 未知字段: nope", "ERR:stages[0]: unpack.head 与 unpack.trailer 不能同时为 0（层与层不可区分）", "ERR:stages[0]: 未知 unpack 字段: zz"]''')
MATCH_SRC = json.loads(r'''[[{}, "0102", "0102"], [{}, "0102", "0103"], [{}, "0102", "010203"], [{"mode": "rules", "prefix": "AA", "suffix": "55"}, "AA0155", "AB0155"], [{"mode": "rules", "prefix": "AA", "suffix": "55"}, "AA0155", "AA0156"], [{"mode": "rules", "echo_header_bytes": 2}, "AA0102", "AA0302"], [{"mode": "rules", "echo_header_bytes": 3}, "AA01", "AA0102"], [{"mode": "rules", "length": {"offset": 0, "byte_length": 1, "offset_val": 0}}, "0102", "0302"], [{"mode": "rules", "length": {"offset": 0, "byte_length": 1, "offset_val": 0}}, "0102", "02"], [{"mode": "rules", "length": {"offset": 0, "byte_length": 1, "offset_val": 0}}, "0102", "010203"], [{"mode": "rules", "length": {"offset": 9, "byte_length": 1, "offset_val": 0}}, "0102", "0102"], [{"mode": "rules", "length": {"offset": 0, "byte_length": 1, "offset_from_end": 2, "offset_val": -3}}, "010203", "010204"], [{"mode": "rules", "prefix": "AA", "suffix": "55", "echo_header_bytes": 1, "length": {"offset": 1, "byte_length": 1, "offset_val": 0}, "checksum": {"algo": "sum", "field_offset": 4, "field_byte_length": 1, "span_start": 0, "span_end": null}, "ignore_ranges": [[3, 4]]}, "AA0102FF55", "AA0102FE55"], [{"mode": "rules", "prefix": "AA", "suffix": "55", "echo_header_bytes": 1, "length": {"offset": 1, "byte_length": 1, "offset_val": 0}, "checksum": {"algo": "sum", "field_offset": 4, "field_byte_length": 1, "span_start": 0, "span_end": null}, "ignore_ranges": [[3, 4]]}, "AA0102FF55", "AA0102FF56"], [{"mode": "rules", "prefix": "AA", "suffix": "55", "echo_header_bytes": 1, "length": {"offset": 1, "byte_length": 1, "offset_val": 0}, "checksum": {"algo": "sum", "field_offset": 4, "field_byte_length": 1, "span_start": 0, "span_end": null}, "ignore_ranges": [[3, 4]]}, "AA0102FF55", "AA0102FF55"], [{"mode": "echo", "ignore_ranges": [[1, 2]]}, "0102", "0103"], [{"mode": "echo", "ignore_ranges": [[0, 2]]}, "0102", "0103"], [{"mode": "rules", "stages": [{"echo_header_bytes": 1, "length": {"byte_length": 1, "offset_val": -3, "byte_order": "big", "offset": 1}, "checksum": null, "unpack": {"head": 2, "trailer": 1}, "prefix": "", "suffix": ""}]}, "A001020304E0", "A001020304E0"], [{"mode": "rules", "stages": [{"echo_header_bytes": 1, "length": {"byte_length": 1, "offset_val": -3, "byte_order": "big", "offset": 1}, "checksum": null, "unpack": {"head": 2, "trailer": 1}, "prefix": "", "suffix": ""}]}, "A001020304E0", "A002020304E0"], [{}, "0102", ""]]''')
MATCH_GOLD = json.loads(r'''[[true, []], [false, ["ECHO_MISMATCH@1"]], [false, ["ECHO_LENGTH_MISMATCH"]], [false, ["PREFIX_MISMATCH"]], [false, ["SUFFIX_MISMATCH"]], [false, ["ECHO_HEADER_MISMATCH"]], [false, ["ECHO_HEADER_TOO_SHORT"]], [false, ["LENGTH_MISMATCH(3!=2)"]], [false, ["LENGTH_MISMATCH(2!=1)"]], [false, ["LENGTH_MISMATCH(1!=3)"]], [false, ["LENGTH_OUT_OF_RANGE"]], [false, ["LENGTH_MISMATCH(2!=0)"]], [false, ["LENGTH_MISMATCH(1!=5)", "CHECKSUM_MISMATCH(exp=AB,got=55)"]], [false, ["SUFFIX_MISMATCH", "LENGTH_MISMATCH(1!=5)", "CHECKSUM_MISMATCH(exp=AC,got=56)"]], [false, ["LENGTH_MISMATCH(1!=5)", "CHECKSUM_MISMATCH(exp=AC,got=55)"]], [true, []], [true, []], [false, ["STAGE[0].LENGTH_MISMATCH(1!=3)"]], [false, ["STAGE[0].LENGTH_MISMATCH(2!=3)"]], [false, ["EMPTY_RESPONSE"]]]''')
MULTI_RX = json.loads(r'''["c008b005a0020102e0e1e2", "c008b005a0030102e0e1e2", "c007b005a0020102e0e1e2", "c008b105a0020102e0e1e2", "c0", ""]''')
MULTI_GOLD = json.loads(r'''[[true, []], [false, ["STAGE[0].LENGTH_MISMATCH(3!=2)"]], [false, ["STAGE[2].LENGTH_MISMATCH(7!=8)"]], [false, ["STAGE[1].ECHO_HEADER_MISMATCH"]], [false, ["STAGE[2].LENGTH_OUT_OF_RANGE", "STAGE[2].UNPACK_TOO_SHORT(1<=3)"]], [false, ["EMPTY_RESPONSE"]]]''')
BUILD_GOLD = json.loads(r'''[["{\"mode\": \"rules\", \"echo_header_bytes\": 1, \"length\": {\"byte_length\": 1, \"offset_val\": -4, \"byte_order\": \"big\", \"offset\": 1}, \"checksum\": {\"algo\": \"sum\", \"field_byte_length\": 1, \"span_start\": 2, \"span_end\": null, \"byte_order\": \"big\", \"span_end_pad\": 2, \"field_offset_from_end\": 2}}", []], ["{\"mode\": \"rules\", \"echo_header_bytes\": 1, \"length\": {\"byte_length\": 1, \"offset_val\": -3, \"byte_order\": \"big\", \"offset_from_end\": 2}, \"checksum\": null}", []], ["{\"mode\": \"rules\", \"echo_header_bytes\": 2, \"length\": null, \"checksum\": null}", ["[层0 层0] length/checksum 用了 target_start_id/target_end_id 区间模式，静态无法解析（length refs 缺失）→ 未生成 length"]], ["{\"mode\": \"rules\", \"echo_header_bytes\": 1, \"length\": {\"byte_length\": 1, \"offset_val\": -4, \"byte_order\": \"big\", \"offset\": 1}, \"checksum\": {\"algo\": \"sum\", \"field_byte_length\": 1, \"span_start\": 2, \"span_end\": null, \"byte_order\": \"big\", \"span_end_pad\": 2, \"field_offset_from_end\": 2}}", []]]''')
BUILD_THREE = json.loads(r'''["{\"mode\": \"rules\", \"stages\": [{\"prefix\": \"\", \"suffix\": \"\", \"echo_header_bytes\": 1, \"length\": {\"byte_length\": 1, \"offset_val\": -3, \"byte_order\": \"big\", \"offset\": 1}, \"checksum\": null, \"unpack\": {\"head\": 2, \"trailer\": 1}}, {\"prefix\": \"\", \"suffix\": \"\", \"echo_header_bytes\": 1, \"length\": {\"byte_length\": 1, \"offset_val\": -3, \"byte_order\": \"big\", \"offset\": 1}, \"checksum\": null, \"unpack\": {\"head\": 2, \"trailer\": 1}}, {\"prefix\": \"\", \"suffix\": \"\", \"echo_header_bytes\": 1, \"length\": {\"byte_length\": 1, \"offset_val\": -3, \"byte_order\": \"big\", \"offset\": 1}, \"checksum\": null, \"unpack\": {\"head\": 2, \"trailer\": 1}}]}", []]''')
BUILD_SINGLE = json.loads(r'''["{\"mode\": \"rules\", \"echo_header_bytes\": 1, \"length\": {\"byte_length\": 1, \"offset_val\": -3, \"byte_order\": \"big\", \"offset\": 1}, \"checksum\": null}", []]''')
STAGE_GOLD = json.loads(r'''{"A": {"echo_header_bytes": 1, "length": {"byte_length": 1, "offset_val": -4, "byte_order": "big", "offset": 1}, "checksum": {"algo": "sum", "field_byte_length": 1, "span_start": 2, "span_end": null, "byte_order": "big", "span_end_pad": 2, "field_offset_from_end": 2}, "unpack": {"head": 2, "trailer": 2}}, "B": {"echo_header_bytes": 1, "length": {"byte_length": 1, "offset_val": -3, "byte_order": "big", "offset_from_end": 2}, "checksum": null, "unpack": {"head": 1, "trailer": 2}}, "C": {"echo_header_bytes": 2, "length": null, "checksum": null, "unpack": {"head": 3, "trailer": 1}}, "D": {"echo_header_bytes": 1, "length": {"byte_length": 1, "offset_val": -4, "byte_order": "big", "offset": 1}, "checksum": {"algo": "sum", "field_byte_length": 1, "span_start": 2, "span_end": null, "byte_order": "big", "span_end_pad": 2, "field_offset_from_end": 2}, "unpack": {"head": 2, "trailer": 2}}}''')


class NormalizeBaselineTest(unittest.TestCase):
    """normalize_spec：合法形态的逐字节输出 + 非法形态的错误文案（对外诊断面）。"""

    def test_golden_outputs_unchanged(self):
        self.assertEqual(len(NORM_SRC), len(NORM_GOLD))
        for src, want in zip(NORM_SRC, NORM_GOLD):
            try:
                got = json.dumps(normalize_spec(src), ensure_ascii=False, separators=(",", ":"))
            except ValueError as exc:
                got = "ERR:" + str(exc)
            self.assertEqual(got, want, msg=f"输入 {src!r} 的归一化输出变了")


class MatchBaselineTest(unittest.TestCase):
    """match_response 单层路径（含 prefix/suffix/echo/length/checksum/ignore_ranges）。"""

    def test_golden_verdicts_unchanged(self):
        self.assertEqual(len(MATCH_SRC), len(MATCH_GOLD))
        for (spec, tx, rx), want in zip(MATCH_SRC, MATCH_GOLD):
            ok, reasons = match_response(
                normalize_spec(spec), bytes.fromhex(tx), bytes.fromhex(rx)
            )
            self.assertEqual([ok, list(reasons)], want, msg=f"{spec!r} {tx} {rx} 判定变了")


class MultiStageBaselineTest(unittest.TestCase):
    """多层逆序解包路径（wrap three 三层 + CANON 及其破坏形态）。"""

    def test_golden_verdicts_unchanged(self):
        spec = normalize_spec(build_spec(_layers())[0])
        self.assertEqual(len(MULTI_RX), len(MULTI_GOLD))
        for rx_hex, want in zip(MULTI_RX, MULTI_GOLD):
            ok, reasons = match_response(spec, CANON, bytes.fromhex(rx_hex))
            self.assertEqual([ok, list(reasons)], want, msg=f"RX {rx_hex} 判定变了")


class GenerateBaselineTest(unittest.TestCase):
    """据此生成：几何样例 / 三层链 / 单层退化的 (spec, warnings) 逐字节。"""

    def test_per_tree_golden(self):
        got = []
        for key in ("A", "B", "C", "D"):
            spec, warnings = build_spec(
                [{"protocol_id": "p0", "label": "层0", "children": CHILDREN[key]}]
            )
            got.append([json.dumps(spec, ensure_ascii=False), list(warnings)])
        self.assertEqual(got, BUILD_GOLD)

    def test_three_layer_chain_golden(self):
        spec, warnings = build_spec(_layers())
        got = [json.dumps(spec, ensure_ascii=False), list(warnings)]
        self.assertEqual(got, BUILD_THREE)

    def test_single_layer_degenerate_golden(self):
        spec, warnings = build_spec(_inner())
        got = [json.dumps(spec, ensure_ascii=False), list(warnings)]
        self.assertEqual(got, BUILD_SINGLE)

    def test_stage_elements_golden(self):
        # 单层几何样例 A/B/C/D 逐字节；三层链的逐层 stage 已由 NORM/GOLD 第 6 条覆盖
        #（normalize 输入里就是 layer_stage_spec 现算的三个 stage）。
        for key, want in STAGE_GOLD.items():
            self.assertEqual(_stage(CHILDREN[key]), want, msg=f"层几何样例 {key} 变了")


if __name__ == "__main__":
    unittest.main()
