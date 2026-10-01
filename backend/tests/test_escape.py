"""N4 (G3) 传输层帧字节转义单测 —— 红测先行。

Run from repo root: python -m unittest discover -s backend/tests

覆盖四块：
1. 纯函数向量表 `escape_hex` / `escape_bytes` —— 双端向量纪律，与
   frontend/src/utils/__tests__/escapeTable.test.js 同字节序列，改一必改二；
2. 传输配置 `escape` 段（白名单、旧库缺段补齐、400 文案、大小写归一、
   pairs 列表整体替换语义 —— FE 删行依赖）；
3. 出线三路接线：/dispatch 裸发、/dispatch 套壳（**内核先转义再套壳**，
   外壳 FA/ED 字面不转、壳 length 按线上字节计）、/dispatch/transaction、
   序列 runner；
4. 存量口径不回归：escape 缺省关闭 → 逐字节不变（§0 硬约束）、
   replay 存档帧即线上字节 → 不二次转义。
"""

import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core import sequence_runner, transport
from backend.core.escape import (
    build_table,
    escape_bytes,
    escape_hex,
    normalize_escape,
    table_from_config,
)
from backend.core.transport import default_config, validate_config
from backend.db.database import Base
from backend.db.models import DispatchLog, ProtocolTemplate
from backend.routers import dispatch as dispatch_mod
from backend.routers.dispatch import (
    DispatchRequest,
    TransactionRequest,
    WrapSpec,
    dispatch_frame,
    dispatch_transaction,
)
from backend.routers.logs import replay_log
from backend.routers.transport import get_transport_config, set_transport_config

# ---- 双端共享向量（pairs, 输入 hex, 期望 hex；紧凑大写）----
# 空表 / 关闭态不在此表 —— 直通语义（原样返回、不解析）由
# test_disabled_table_is_identity_and_unparsed 单独钉住。
VECTORS = [
    # 0x7D 型字头（受保护字节 → 转义前缀 + 替换字节）
    ([["7D", "7D5D"], ["11", "7D31"], ["13", "7D32"]], "01 7D 02", "017D5D02"),
    ([["7D", "7D5D"]], "7D 7D", "7D5D7D5D"),
    # 未受保护字节原样
    ([["7D", "7D5D"]], "5D 01", "5D01"),
    # 单趟：替换产物不再二次转义
    ([["7D", "7D5D"]], "7D 5D", "7D5D5D"),
    # 0x10 型前缀（替换序列 = 前缀 + 原字节）
    ([["11", "1011"]], "AA 11 BB", "AA1011BB"),
    # 非前缀型多字节替换
    ([["0D", "0D0A"]], "0D 0D", "0D0A0D0A"),
    # 全字节覆盖含 00
    ([["00", "7DFF"]], "00 01 00", "7DFF017DFF"),
]

PAIRS_7D = [["7D", "7D5D"]]
# 套壳用：连外壳字节也列入表 —— 证明壳 FA/ED 字面不转
PAIRS_SHELL = [["7D", "7D5D"], ["FA", "7DFA"], ["ED", "7DED"]]

# 套壳协议：FA FA / length(refs=[slot]) / slot / ED（与 test_wrap_api 主向量同构）
PROTO_ID = "proto-escape"
VECTOR_CHILDREN = [
    {"id": "h", "label": "h", "type": "fixed", "byte_length": 2,
     "hex_value": "FA FA", "config": {}, "children": []},
    {"id": "l", "label": "l", "type": "length", "byte_length": 1,
     "hex_value": "00", "config": {},
     "parameter_config": {"type": "length", "refs": ["s"]}, "children": []},
    {"id": "s", "label": "s", "type": "slot", "byte_length": 0,
     "hex_value": None, "config": {}, "children": []},
    {"id": "t", "label": "t", "type": "fixed", "byte_length": 1,
     "hex_value": "ED", "config": {}, "children": []},
]

INSTR = "22222222-bbbb-4ccc-8ddd-000000000001"


def _step(step_id, payload, plan=None):
    """Runner 内部步形状（payload = bytes，与 test_sequence._step 同构）。"""
    return {
        "id": step_id,
        "instruction_id": INSTR,
        "label": None,
        "delay_ms": 0,
        "payload": payload,
        "plan": plan,
    }


class EscapeVectorTests(unittest.TestCase):
    """纯函数向量：与 FE escapeTable.test.js 钉同一批字节。"""

    def test_shared_vectors(self):
        for pairs, src, want in VECTORS:
            with self.subTest(pairs=pairs, src=src):
                table = build_table({"enabled": True, "pairs": pairs})
                self.assertEqual(escape_hex(src, table), want)

    def test_shared_vectors_bytes_form(self):
        for pairs, src, want in VECTORS:
            with self.subTest(pairs=pairs, src=src):
                table = build_table({"enabled": True, "pairs": pairs})
                raw = bytes.fromhex(src.replace(" ", ""))
                self.assertEqual(escape_bytes(raw, table).hex().upper(), want)

    def test_disabled_table_is_identity_and_unparsed(self):
        # 关闭 → 表为空 → 原样返回（连空白格式都不动：/dispatch 关闭态逐字节不变）
        table = build_table({"enabled": False, "pairs": PAIRS_7D})
        self.assertEqual(table, {})
        self.assertEqual(escape_hex("AA 7D", table), "AA 7D")
        # 非法 hex 在关闭态也不解析（错误仍由下游 hex_to_bytes 统一抛 → 400 文案不变）
        self.assertEqual(escape_hex("not hex", table), "not hex")
        # 启用但零规则同样空表 → 直通
        empty_on = build_table({"enabled": True, "pairs": []})
        self.assertEqual(empty_on, {})
        self.assertEqual(escape_hex("01 7D 02", empty_on), "01 7D 02")

    def test_empty_config_and_junk_fail_open(self):
        self.assertEqual(table_from_config(None), {})
        self.assertEqual(table_from_config({}), {})
        self.assertEqual(table_from_config({"escape": None}), {})
        # 脏数据 fail-open：非对象 / 非法 pair → 空表直通，不炸发送路径
        self.assertEqual(table_from_config({"escape": "junk"}), {})
        self.assertEqual(
            table_from_config({"escape": {"enabled": True, "pairs": "junk"}}), {}
        )
        self.assertEqual(
            table_from_config({"escape": {"enabled": True, "pairs": [["7D"]]}}), {}
        )

    def test_empty_payload(self):
        table = build_table({"enabled": True, "pairs": PAIRS_7D})
        self.assertEqual(escape_hex("", table), "")
        self.assertEqual(escape_bytes(b"", table), b"")

    def test_invalid_hex_raises_only_when_enabled(self):
        table = build_table({"enabled": True, "pairs": PAIRS_7D})
        for bad in ("ABC", "not hex", "7D GG"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    escape_hex(bad, table)

    def test_disable_parity_with_default(self):
        self.assertEqual(
            default_config()["escape"], {"enabled": False, "pairs": []}
        )


class EscapeConfigTests(unittest.TestCase):
    """传输配置 escape 段：白名单 / 旧库补齐 / 400 文案 / 归一 / 列表替换。"""

    def setUp(self):
        transport.reset()

    def tearDown(self):
        transport.reset()

    def test_escape_key_is_whitelisted(self):
        # 实现前：未知配置字段 escape → 400（红）
        effective = set_transport_config(
            {"escape": {"enabled": True, "pairs": PAIRS_7D}}
        )
        self.assertEqual(effective["escape"],
                         {"enabled": True, "pairs": PAIRS_7D})
        self.assertEqual(get_transport_config()["escape"],
                         {"enabled": True, "pairs": PAIRS_7D})

    def test_legacy_config_without_escape_is_filled(self):
        # 旧库存量配置无 escape 段 → 补默认关闭段（restore 不得静默失败）
        cfg = {k: v for k, v in default_config().items() if k != "escape"}
        normalized = validate_config(cfg)
        self.assertEqual(normalized["escape"], {"enabled": False, "pairs": []})

    def test_pairs_normalized_to_uppercase(self):
        normalized = validate_config({
            **default_config(),
            "escape": {"enabled": True, "pairs": [["7d", "7d5d"]]},
        })
        self.assertEqual(normalized["escape"]["pairs"], [["7D", "7D5D"]])

    def test_normalize_escape_direct(self):
        self.assertEqual(normalize_escape(None),
                         {"enabled": False, "pairs": []})
        self.assertEqual(
            normalize_escape({"pairs": [["7d", "7d5d"]]}),
            {"enabled": False, "pairs": [["7D", "7D5D"]]},
        )

    def test_invalid_escape_shapes_400(self):
        cases = [
            ({"escape": ["7D"]}, "escape 配置必须是对象"),
            ({"escape": {"enabled": True, "pairs": [], "x": 1}},
             "未知 escape 配置字段"),
            ({"escape": {"enabled": "yes", "pairs": []}},
             "escape.enabled 必须是布尔值"),
            ({"escape": {"enabled": True, "pairs": {"7D": "7D5D"}}},
             "escape.pairs 必须是数组"),
            ({"escape": {"enabled": True, "pairs": [["7D"]]}},
             "escape.pairs[0] 必须是"),
            ({"escape": {"enabled": True, "pairs": [["7DD", "7D5D"]]}},
             "escape.pairs[0].from 必须是 2 位 hex"),
            ({"escape": {"enabled": True, "pairs": [["GG", "7D5D"]]}},
             "escape.pairs[0].from 必须是 2 位 hex"),
            ({"escape": {"enabled": True, "pairs": [["7D", "7D5"]]}},
             "escape.pairs[0].to 必须是"),
            ({"escape": {"enabled": True, "pairs": [["7D", "ZZZZ"]]}},
             "escape.pairs[0].to 必须是"),
            ({"escape": {"enabled": True, "pairs": [["7D", "7"]]}},
             "escape.pairs[0].to 必须是"),
            ({"escape": {"enabled": True,
                         "pairs": [["7D", "7D5D"], ["7D", "7D31"]]}},
             "escape.pairs[1].from 重复"),
        ]
        for patch, fragment in cases:
            with self.subTest(fragment=fragment):
                with self.assertRaises(ValueError) as ctx:
                    validate_config({**default_config(), **patch})
                self.assertIn(fragment, str(ctx.exception))

    def test_router_maps_invalid_escape_to_400(self):
        with self.assertRaises(HTTPException) as ctx:
            set_transport_config({"escape": {"enabled": True, "pairs": "x"}})
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("escape.pairs 必须是数组", ctx.exception.detail)

    def test_pairs_list_replaced_not_merged(self):
        # FE 删行依赖：_deep_merge 只递归 dict，列表整体替换
        set_transport_config({"escape": {"enabled": True, "pairs":
                              [["7D", "7D5D"], ["11", "7D31"]]}})
        set_transport_config({"escape": {"enabled": True, "pairs":
                              [["7D", "7D5D"]]}})
        self.assertEqual(get_transport_config()["escape"]["pairs"],
                         [["7D", "7D5D"]])

    def test_partial_patch_keeps_sections(self):
        # escape 单独 patch 不影响 mode/tcp/serial（存量 patch 语义）
        effective = set_transport_config(
            {"escape": {"enabled": True, "pairs": PAIRS_7D}}
        )
        self.assertEqual(effective["mode"], default_config()["mode"])
        self.assertEqual(effective["tcp"], default_config()["tcp"])
        self.assertEqual(effective["serial"], default_config()["serial"])


class EscapeWireTestBase(unittest.TestCase):
    def setUp(self):
        transport.reset()
        dispatch_mod._history.clear()
        sequence_runner.reset()
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = create_engine(
            f"sqlite:///{(Path(self.tmp.name) / 'test_escape.db').as_posix()}",
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(
            autocommit=False, autoflush=False, bind=self.engine
        )
        self.db = self.session_factory()
        self.db.add(ProtocolTemplate(
            id=PROTO_ID, label="转义向量协议", type="container",
            children=VECTOR_CHILDREN,
        ))
        self.db.commit()

    def tearDown(self):
        transport.reset()
        dispatch_mod._history.clear()
        sequence_runner.reset()
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _enable(self, pairs, enabled=True):
        set_transport_config({"escape": {"enabled": enabled, "pairs": pairs}})


class DispatchEscapeTests(EscapeWireTestBase):
    def test_bare_frame_escaped(self):
        self._enable(PAIRS_7D)
        record = dispatch_frame(
            DispatchRequest(hex_string="AA 7D 01", instruction_name="转义"),
            db=self.db,
        )
        self.assertEqual(record.byte_count, 4)
        self.assertEqual(record.hex_string, "AA 7D 5D 01")
        self.assertEqual(record.echo, "AA7D5D01")  # loopback 回显 = 线上字节
        hist = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(hist.hex_string, "AA 7D 5D 01")
        self.assertEqual(hist.events[0].hex_string, "AA 7D 5D 01")

    def test_bare_frame_disabled_byte_equal(self):
        # §0 硬约束：缺省关闭 → 与存量逐字节一致
        record = dispatch_frame(
            DispatchRequest(hex_string="AA 7D 01"), db=self.db
        )
        self.assertEqual(record.byte_count, 3)
        self.assertEqual(record.hex_string, "AA 7D 01")
        self.assertEqual(record.echo, "AA7D01")

    def test_wrap_escapes_kernel_then_shell_literal(self):
        # 内核先转义、外壳 FA/ED 字面不转；壳 length 按线上字节（转义后 3 字节）
        self._enable(PAIRS_SHELL)
        record = dispatch_frame(
            DispatchRequest(
                hex_string="01 7D",
                wrap=WrapSpec(protocol_id=PROTO_ID),
            ),
            db=self.db,
        )
        self.assertEqual(record.hex_string, "FA FA 03 01 7D 5D ED")
        self.assertEqual(record.byte_count, 7)

    def test_wrap_disabled_byte_equal(self):
        record = dispatch_frame(
            DispatchRequest(
                hex_string="01 7D",
                wrap=WrapSpec(protocol_id=PROTO_ID),
            ),
            db=self.db,
        )
        self.assertEqual(record.hex_string, "FA FA 02 01 7D ED")

    def test_multi_payload_same_layering_as_single(self):
        # 批次二 (D14③): 试发改走 wrap.payloads —— 层位与单条完全一致：
        # 逐条内核先转义、外壳 FA/ED 字面不转，壳 length 按转义后线上字节。
        self._enable(PAIRS_SHELL)
        single = dispatch_frame(
            DispatchRequest(hex_string="01 7D", wrap=WrapSpec(protocol_id=PROTO_ID)),
            db=self.db,
        )
        dispatch_mod._history.clear()
        multi = dispatch_frame(
            DispatchRequest(
                instruction_name="封装试发",
                wrap=WrapSpec(protocol_id=PROTO_ID, payloads=["01 7D"]),
            ),
            db=self.db,
        )
        self.assertEqual(single.hex_string, "FA FA 03 01 7D 5D ED")
        self.assertEqual(multi.hex_string, single.hex_string)
        self.assertEqual(multi.byte_count, single.byte_count)

    def test_multi_payload_disabled_byte_equal(self):
        record = dispatch_frame(
            DispatchRequest(
                wrap=WrapSpec(protocol_id=PROTO_ID, payloads=["01 7D"])
            ),
            db=self.db,
        )
        self.assertEqual(record.hex_string, "FA FA 02 01 7D ED")

    def test_invalid_kernel_hex_detail_stable(self):
        # 关闭态错误文案（存量口径）
        with self.assertRaises(HTTPException) as off:
            dispatch_frame(DispatchRequest(hex_string="not hex"), db=self.db)
        self.assertEqual(off.exception.status_code, 400)
        # 开启态：转义层先解析 → 同一 400 文案口径
        self._enable(PAIRS_7D)
        with self.assertRaises(HTTPException) as on:
            dispatch_frame(DispatchRequest(hex_string="not hex"), db=self.db)
        self.assertEqual(on.exception.status_code, 400)
        self.assertEqual(on.exception.detail, off.exception.detail)

    def test_transaction_escaped(self):
        self._enable(PAIRS_7D)
        record = dispatch_transaction(
            TransactionRequest(hex_string="AA 7D", instruction_name="事务"),
            db=self.db,
        )
        self.assertEqual(record.status, "OK")
        self.assertEqual(record.hex_string, "AA 7D 5D")
        self.assertEqual(record.attempts[0].sent, "AA 7D 5D")
        self.assertEqual(record.echo, "AA7D5D")

    def test_transaction_disabled_byte_equal(self):
        record = dispatch_transaction(
            TransactionRequest(hex_string="AA 7D"), db=self.db
        )
        self.assertEqual(record.hex_string, "AA 7D")
        self.assertEqual(record.attempts[0].sent, "AA 7D")


class ReplayEscapeTests(EscapeWireTestBase):
    def test_replay_does_not_double_escape(self):
        # 存档帧 = 线上字节（已转义落库）→ 回放原样重发
        row = DispatchLog(
            created_at="2026-09-30T00:00:00+00:00",
            source="manual", channel="LOOPBACK", status="OK",
            byte_count=3, hex_string="AA 7D 01", echo="AA7D01",
            instruction_name="存档",
        )
        self.db.add(row)
        self.db.commit()

        self._enable(PAIRS_7D)
        out = replay_log(row.id, db=self.db)
        self.assertEqual(out.status, "SENT")
        self.assertEqual(out.hex_string, "AA 7D 01")
        self.assertEqual(out.echo, "AA7D01")


class SequenceEscapeTests(EscapeWireTestBase):
    def test_step_payload_escaped_before_send(self):
        self._enable(PAIRS_7D)
        run = sequence_runner.claim(
            "seq-escape", "转义序列",
            [_step("s1", b"\x01\x7D\x02")],
            {"stop_on_error": True, "read_timeout_ms": None},
        )
        sequence_runner.execute(run)

        snap = sequence_runner.snapshot()
        self.assertEqual(snap["result"], "completed")
        first = snap["steps"][0]
        self.assertEqual(first["sent"], "01 7D 5D 02")  # 记录即线上字节
        self.assertEqual(first["received"], "017D5D02")

    def test_step_payload_disabled_byte_equal(self):
        run = sequence_runner.claim(
            "seq-plain", "原样序列",
            [_step("s1", b"\x01\x7D\x02")],
            {"stop_on_error": True, "read_timeout_ms": None},
        )
        sequence_runner.execute(run)

        first = sequence_runner.snapshot()["steps"][0]
        self.assertEqual(first["sent"], "01 7D 02")
        self.assertEqual(first["received"], "017D02")


if __name__ == "__main__":
    unittest.main()
