"""R25（§8.57 · §8.52 排期第 5 批 · BUSINESS_SCENARIOS 挂账 ②）：SCRAMBLE 加扰字段。

共享向量单一真相源 = `vectors/scramble.json`（本文件与 FE `scramble.test.js` 同读一份，
新增向量只写一处）。表内 plain × mode × seed × roll → expected（加扰后 hex）：

    XOR_SEED  out[i] = plain[i] ^ seed[i % len(seed)]
    BIT_ROLL  out[i] = (plain[i] << n | plain[i] >> (8-n)) & 0xFF   n = roll % 8

四处实现（改一必改二）：
1. `orchestrator.encode_scramble` —— 出线（`field_blocks` 的 SCRAMBLE 分支）；
2. `orchestrator.unscramble_hex` —— 解码（`field_decode` 对偶 FE `InstructionDecoder`）；
3. `routers/instruction._validate_scrambles` —— 保存侧 400（与 FE `scrambleParamError`
   + E1 HEX_LENGTH 同口径，POST/PUT 都在任何写入前）；
4. `routers.operator.SEED_TEMPLATES` —— 创建 / 切算子播种的缺省态（XOR 种子 A5）。

口径（§0 纪律）：明文空 / 非 hex → **补零**（绝不把非法明文发上线）；mode / seed / roll 契约外
→ **恒等**（保存侧已硬拦，编码侧只求出线有确定值）；解码是编码的逆（XOR 自反、左旋逆右旋）
→ decode(encode(x)) 是不动点。

Run from repo root: python -m unittest backend.tests.test_scramble
"""
import re
import unittest

from fastapi import HTTPException

from backend.core.field_blocks import fields_to_blocks
from backend.core.field_decode import decode_field_bytes
from backend.core.orchestrator import encode_scramble, unscramble_hex
from backend.routers.datahub import compile_blocks, frame_bytes
from backend.routers.instruction import KNOWN_OPS, _validate_scrambles
from backend.routers.operator import SEED_TEMPLATES
from backend.schemas.instruction_api import InstructionFieldSchema
from vectors.load_vectors import load_vectors

VECTORS = load_vectors("scramble")


def plain_of(text):
    """明文规范化（双端同口径）：去空白 + 大写 + 奇长丢末尾半字节。"""
    clean = re.sub(r"\s+", "", str(text or ""))
    if len(clean) % 2:
        clean = clean[:-1]
    return clean.upper()


def pc_of(row):
    """向量行 → parameter_config（明文在 hex 键上，与面板落库形状一致）。"""
    pc = {"hex": row["plain"]}
    for key in ("mode", "seed", "roll"):
        if key in row:
            pc[key] = row[key]
    return pc


def field(byte_len, pc, name="加扰"):
    return {
        "id": "s", "name": name, "op_code": "SCRAMBLE", "byte_len": byte_len,
        "sequence": 0, "parent_id": None, "parameter_config": pc,
    }


def frame_of(fields):
    return frame_bytes(compile_blocks(fields_to_blocks(fields))).hex().upper()


def schema(name="加扰", byte_len=2, pc=None, op="SCRAMBLE"):
    kw = dict(name=name, op_code=op, byte_len=byte_len)
    if pc is not None:
        kw["parameter_config"] = pc
    return InstructionFieldSchema(**kw)


class TestScrambleVectors(unittest.TestCase):
    """14 行共享向量：出线 byte-equal + 全链路出帧 + 解码是编码的逆。"""

    def test_vectors_encode_byte_equal(self):
        self.assertEqual(len(VECTORS), 14)
        for i, row in enumerate(VECTORS):
            with self.subTest(i=i, mode=row.get("mode")):
                got = encode_scramble(
                    row["plain"], row.get("mode"), row.get("seed"), row.get("roll")
                )
                self.assertEqual(got, row["expected"])

    def test_vectors_end_to_end_through_field_blocks(self):
        for i, row in enumerate(VECTORS):
            bl = max(1, (len(plain_of(row["plain"])) + 1) // 2)
            with self.subTest(i=i):
                self.assertEqual(frame_of([field(bl, pc_of(row))]), row["expected"])

    def test_decode_is_inverse_of_encode(self):
        for i, row in enumerate(VECTORS):
            with self.subTest(i=i):
                back = unscramble_hex(
                    row["expected"], row.get("mode"), row.get("seed"), row.get("roll")
                )
                self.assertEqual(back, plain_of(row["plain"]))

    def test_vector_covers_both_modes_and_fallbacks(self):
        modes = {str(r.get("mode") or "XOR_SEED").upper() for r in VECTORS}
        self.assertEqual(modes, {"XOR_SEED", "BIT_ROLL", "FOO"})
        # 恒等行（契约外 / 非法参数 / 空种子）：expected 就是明文
        identity = [r for r in VECTORS if r["expected"] == plain_of(r["plain"])]
        self.assertGreaterEqual(len(identity), 4)


class TestScrambleFallbacks(unittest.TestCase):
    def test_invalid_plaintext_returns_none_and_emits_zeros(self):
        # 空 / 非 str / 非 hex → None（调用方补零），绝不把非法明文发上线
        self.assertIsNone(encode_scramble(""))
        self.assertIsNone(encode_scramble(None))
        self.assertIsNone(encode_scramble("GG"))
        self.assertEqual(frame_of([field(2, {"hex": "ZZ", "seed": "A5"})]), "0000")
        self.assertEqual(frame_of([field(2, {"seed": "A5"})]), "0000")
        # 明文是数字型（直连 API 写入）→ 同样不认，与 FE `typeof plain === 'string'` 同判
        self.assertIsNone(encode_scramble(123))

    def test_contract_out_params_fail_open_to_identity(self):
        self.assertEqual(encode_scramble("0102", mode="XOR_SEED", seed="0"), "0102")
        self.assertEqual(encode_scramble("0102", mode="XOR_SEED", seed="GG"), "0102")
        self.assertEqual(encode_scramble("0102", mode="XOR_SEED", seed=None), "0102")
        self.assertEqual(encode_scramble("0102", mode="BIT_ROLL", roll="abc"), "0102")
        self.assertEqual(encode_scramble("0102", mode="BIT_ROLL"), "0102")
        self.assertEqual(encode_scramble("0102", mode="FOO", seed="A5"), "0102")

    def test_roll_normalizes_mod_8(self):
        # 负数 / 超 8 / 带小数 → 与 FE scrambleRollBits 同式 `((n%8)+8)%8`
        one = encode_scramble("81", mode="BIT_ROLL", roll=1)
        self.assertEqual(one, "03")
        for roll in (-7, 9, 1.9, "1"):
            with self.subTest(roll=roll):
                self.assertEqual(encode_scramble("81", mode="BIT_ROLL", roll=roll), one)

    def test_little_endian_reverses_after_scramble(self):
        # 字节序在字段级 wrapper 上做（对偶 FE getFieldBytes）→ 加扰先、逆序后
        f = field(2, {"hex": "0102", "seed": "A5"}, name="L")
        f["endianness"] = "LITTLE"
        # 01^A5=A4 02^A5=A7 → 逆序 A7A4
        self.assertEqual(frame_of([f]), "A7A4")


class TestScrambleValidation(unittest.TestCase):
    """保存侧 400（与 FE scrambleParamError + E1 HEX_LENGTH 逐项对齐）。"""

    def _reject(self, pc, byte_len=2, needle=None):
        with self.assertRaises(HTTPException) as ctx:
            _validate_scrambles([schema(pc=pc, byte_len=byte_len)])
        self.assertEqual(ctx.exception.status_code, 400)
        if needle:
            self.assertIn(needle, ctx.exception.detail)
        return ctx.exception.detail

    def test_valid_passes(self):
        _validate_scrambles([schema(pc={"hex": "AABB", "seed": "A5"})])
        _validate_scrambles([schema(pc={"hex": "AABB", "mode": "BIT_ROLL", "roll": 3})])
        # 明文为空 → 只提醒不拦（FE E1 `if (hex && …)` 同口径）
        _validate_scrambles([schema(pc={"seed": "A5"})])
        # 另一个模式的参数留空合法（下拉切回来即生效）
        _validate_scrambles([schema(pc={"hex": "AABB", "mode": "BIT_ROLL", "roll": 1})])
        _validate_scrambles([schema(pc={"hex": "AABB", "mode": "XOR_SEED", "seed": "5AA5"})])

    def test_non_scramble_fields_skipped(self):
        _validate_scrambles([schema(op="HEX_RAW", pc={"hex": "ZZ"})])
        _validate_scrambles(None)

    def test_bad_mode_400(self):
        self._reject({"hex": "AABB", "mode": "FOO", "seed": "A5"}, needle="加扰模式无效")

    def test_bad_seed_400(self):
        for seed in ("", "A", "GG", None):
            with self.subTest(seed=seed):
                pc = {"hex": "AABB"}
                if seed is not None:
                    pc["seed"] = seed
                self._reject(pc, needle="XOR 种子无效")

    def test_bad_roll_400(self):
        for roll in ("", "abc", "0x3", None):
            with self.subTest(roll=roll):
                pc = {"hex": "AABB", "mode": "BIT_ROLL"}
                if roll is not None:
                    pc["roll"] = roll
                self._reject(pc, needle="位旋转位数无效")

    def test_plaintext_length_and_charset_400(self):
        self._reject({"hex": "AA", "seed": "A5"}, byte_len=2,
                     needle="HEX 长度与字节长度不符")
        self._reject({"hex": "GGGG", "seed": "A5"}, byte_len=2,
                     needle="HEX 长度与字节长度不符")
        # 空白不计入长度（双端同口径 strip）
        _validate_scrambles([schema(byte_len=2, pc={"hex": "AA BB", "seed": "A5"})])

    def test_detail_carries_field_label(self):
        detail = self._reject({"hex": "AA", "seed": "A5"}, byte_len=2)
        self.assertIn("加扰", detail)


class TestScrambleWhitelistAndTemplate(unittest.TestCase):
    def test_known_ops_and_seed_template_in_sync(self):
        """白名单 + 模板三键与 FE 同批 21 → 22（`is_exactly_22` 锁集合相等）。"""
        self.assertIn("SCRAMBLE", KNOWN_OPS)
        tpl = next((t for t in SEED_TEMPLATES if t["op_code"] == "SCRAMBLE"), None)
        self.assertIsNotNone(tpl, "R25 缺 SCRAMBLE 模板 → 调色板/切算子都没有入口")
        self.assertEqual(tpl["category"], "ENCODING")
        pt = tpl["param_template"]
        self.assertEqual(pt["mode"], ["XOR_SEED", "BIT_ROLL"])  # 首项 = 缺省下拉
        self.assertEqual(pt["seed"], "A5")                      # 字面缺省（非 keyword）
        self.assertEqual(pt["roll"], 1)


class TestScrambleDecode(unittest.TestCase):
    def test_decode_field_bytes_returns_plaintext(self):
        row = VECTORS[0]
        raw = [int(row["expected"][i:i + 2], 16)
               for i in range(0, len(row["expected"]), 2)]
        self.assertEqual(decode_field_bytes(field(4, pc_of(row)), raw),
                         plain_of(row["plain"]))

    def test_decode_of_bit_roll_uses_right_rotation(self):
        row = next(r for r in VECTORS if r.get("mode") == "BIT_ROLL" and r.get("roll") == 3)
        raw = [int(row["expected"][i:i + 2], 16)
               for i in range(0, len(row["expected"]), 2)]
        self.assertEqual(decode_field_bytes(field(2, pc_of(row)), raw),
                         plain_of(row["plain"]))

    def test_decode_returns_none_for_empty_input(self):
        self.assertIsNone(decode_field_bytes(field(2, {"seed": "A5"}), []))


if __name__ == "__main__":
    unittest.main()
