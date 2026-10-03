"""R10（PLAN §8.48 · §8.37 R10 行 · C-2 选 C 后半）**入库回写**单测。

两半，对应拍板原文「`dispatch_logs` 加 `fields_json`（仅新增列）+ 回填 `fields`」：

① **解码器** `backend/core/field_decode.py` —— 与 FE `utils/InstructionDecoder.js`
   （R9 §8.47）分派同序、取值同口径：各算子一组取值锚 + 布局区间（align / pad_to /
   repeat / presence）+ 三类告警（短帧 / 尾残字节 / 非法 hex）+ 空布局不造假警报。
   编码走 BE 自己的 `fields_to_blocks` + `compile_blocks`（只出骨架帧的算子给手工帧）。

② **回写** —— 四条写入缝（manual / transaction / sequence / replay）全过
   `db/log_store.record_log` **单一接缝**自动回填；`/dispatch/history` 的 `fields`
   与 `fields_json` 是**同一次解码**；`/logs` 列表与 JSON 导出回填、**CSV 列集逐字不变**。

Run from repo root: python -m unittest discover -s backend/tests
"""
import json as jsonlib
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core import sequence_runner, transport
from backend.core.field_blocks import fields_to_blocks
from backend.core.field_decode import decode_field_bytes, decode_hex, field_index
from backend.db.database import Base
from backend.db.log_store import log_hook, record_log, resolve_log_fields, safe_log
from backend.db.models import DispatchLog, Instruction, InstructionField
from backend.routers import dispatch as dispatch_mod
from backend.routers.datahub import compile_blocks
from backend.routers.dispatch import DispatchRequest, dispatch_frame
from backend.routers.logs import (
    _CSV_COLUMNS as _CSV_KEYS,
    DispatchLogOut,
    _row_dict,
    export_logs,
    list_logs,
)

#: 手动路标签（manual 只带 name，事务/序列/回放带 id）
INSTR_NAME = "读电压"
INSTR_ID = "aaaaaaaa-1111-4111-8111-000000000001"
#: 与 test_sequence_plan 同一 base_time（TIME_ACCUMULATOR 秒数的零点）
TIME_BASE = "2000-01-01T00:00:00Z"
#: 导出 CSV 头 —— R10 **不许**多这一列
CSV_HEADER = (
    "id,created_at,source,channel,status,byte_count,hex_string,echo,"
    "instruction_name,instruction_id,sequence_id,step_order,rtt_ms,error"
)


def _leaf(**kw):
    """扁平指令字段（`fields_to_blocks` / `field_index` 吃的形状）。"""
    base = {
        "id": kw.pop("id", "f1"),
        "name": kw.pop("name", "F1"),
        "sequence": kw.pop("sequence", 1),
        "byte_len": kw.pop("byte_len", 1),
        "endianness": kw.pop("endianness", "BIG"),
    }
    base.update(kw)
    return base


def _encode(fields, now=None):
    """BE 编译出帧（space-separated hex，与 `/compile` 同一实现）。"""
    return compile_blocks(fields_to_blocks(fields, now=now))


class ValueDecodeTest(unittest.TestCase):
    """取值层：分派顺序与 FE `decodeFieldBytes` 一一对应（改一必改二）。"""

    def test_compiled_ops_round_trip(self):
        """BE 能编出值的算子：编 → 解回原值（f32 按 7 位有效数字比对）。"""
        cases = [
            ("FLOAT_IEEE", 4, {"value": 3.14, "type": "number"}, 3.14),
            ("INT_SIGNED", 2, {"value": -1, "type": "number"}, -1),
            ("INT_SIGNED", 4, {"value": -32768, "type": "number"}, -32768),
            ("BCD_CODE", 2, {"value": 1234, "type": "number"}, 1234),
            ("SCALED_DECIMAL", 2, {"value": 3.14, "factor": 100, "type": "number"}, 3.14),
            ("STRING", 5, {"value": "ALPHA", "type": "string"}, "ALPHA"),
        ]
        for op, byte_len, cfg, want in cases:
            with self.subTest(op=op):
                fields = [_leaf(op_code=op, byte_len=byte_len, parameter_config=cfg)]
                got = decode_hex(fields, _encode(fields))
                self.assertEqual(got["warnings"], [])
                self.assertEqual(got["residual"], 0)
                value = got["fields"][0]["value"]
                if isinstance(want, float):
                    self.assertAlmostEqual(value, want, places=6)
                else:
                    self.assertEqual(value, want)

    def test_static_hex_field(self):
        fields = [_leaf(op_code="FIXED", byte_len=2, parameter_config={"hex": "AA55"})]
        got = decode_hex(fields, "AA55")
        self.assertEqual(got["fields"][0]["value"], "AA55")

    def test_unsigned_input_reads_frame_bytes(self):
        """BE 只出骨架帧（INPUT 值不由它编）——解码侧读的正是设备回的那几个字节。"""
        fields = [_leaf(op_code="INPUT", byte_len=2, parameter_config={"type": "number"})]
        self.assertEqual(decode_hex(fields, "1234")["fields"][0]["value"], 4660)

    def test_little_endian_restored_before_reading(self):
        fields = [_leaf(op_code="INPUT", byte_len=2, endianness="LITTLE",
                        parameter_config={"type": "number"})]
        self.assertEqual(decode_hex(fields, "3412")["fields"][0]["value"], 4660)

    def test_bitfield_aggregates_big_endian(self):
        fields = [_leaf(op_code="BITFIELD", byte_len=2, parameter_config={"type": "number"})]
        self.assertEqual(decode_hex(fields, "0102")["fields"][0]["value"], 258)

    def test_hex_raw_and_hex_type(self):
        fields = [_leaf(op_code="HEX_RAW", byte_len=3, parameter_config={})]
        self.assertEqual(decode_hex(fields, "DEADBE")["fields"][0]["value"], "DEADBE")
        fields = [_leaf(op_code="INPUT", byte_len=3, parameter_config={"type": "hex"})]
        self.assertEqual(decode_hex(fields, "DEADBE")["fields"][0]["value"], "DEADBE")

    def test_utf8_text_uses_replacement_not_exception(self):
        fields = [_leaf(op_code="STRING", byte_len=3,
                        parameter_config={"value": "\u00e9\u00e9", "type": "string",
                                          "encoding": "utf8"})]
        # 0xE9 单字节不是合法 UTF-8 起始 → 替换成 U+FFFD（与前端 TextDecoder 同口径）
        self.assertEqual(decode_hex(fields, "E94142")["fields"][0]["value"],
                         "\ufffdAB")

    def test_bcd_invalid_nibbles_falls_back_to_hex(self):
        fields = [_leaf(op_code="BCD_CODE", byte_len=2, parameter_config={"type": "number"})]
        self.assertEqual(decode_hex(fields, "12AF")["fields"][0]["value"], "12AF")

    def test_time_accumulator_decodes_as_seconds_count(self):
        """TIME_ACCUMULATOR 无专用解码分支 → 走缺省无符号（与 FE 同：回的是秒数）。"""
        base_ms = datetime.strptime(TIME_BASE, "%Y-%m-%dT%H:%M:%SZ") \
            .replace(tzinfo=timezone.utc).timestamp() * 1000
        fields = [_leaf(op_code="TIME_ACCUMULATOR", byte_len=2,
                        parameter_config={"base_time": TIME_BASE, "type": "number"})]
        hexstr = _encode(fields, now=base_ms + 5000).replace(" ", "")
        self.assertEqual(hexstr, "0005")
        self.assertEqual(decode_hex(fields, hexstr)["fields"][0]["value"], 5)

    def test_auto_counter_decodes_as_unsigned(self):
        """AUTO_COUNTER 状态机不可逆（R9 拍板三条之一）——只回当前计数的无符号读数。"""
        fields = [_leaf(op_code="AUTO_COUNTER", byte_len=1,
                        parameter_config={"value": 5, "start_val": 0, "step": 2,
                                          "max_val": 100, "type": "number"})]
        hexstr = _encode(fields).replace(" ", "")
        self.assertEqual(hexstr, "07")
        self.assertEqual(decode_hex(fields, hexstr)["fields"][0]["value"], 7)

    def test_non_finite_float_is_folded_to_string(self):
        """f32 溢出位型：`Infinity` 是非法 JSON → 落库/出响应前必须折成字符串，
        否则 FastAPI 响应层直接 500（给 None 又会把「这帧溢出了」这条信息吞掉）。"""
        fields = [_leaf(op_code="FLOAT_IEEE", byte_len=4,
                        parameter_config={"value": 1e300, "type": "number"})]
        self.assertEqual(_encode(fields).replace(" ", ""), "7F800000")
        got = decode_hex(fields, "7F800000")
        self.assertEqual(got["fields"][0]["value"], "Infinity")
        jsonlib.dumps(got)  # 必须可序列化


class LayoutDecodeTest(unittest.TestCase):
    """布局层：与编译侧共用 `fields_to_blocks` + `Orchestrator.flatten()`。"""

    def _ranges(self, got):
        return [(f["name"], f["byteLen"], f["start"], f["end"]) for f in got["fields"]]

    def test_align_and_pad_to_boundaries(self):
        fields = [
            _leaf(id="a", name="A", sequence=1, op_code="INPUT", byte_len=1,
                  parameter_config={"type": "number", "align": 4}),
            _leaf(id="b", name="B", sequence=2, op_code="INPUT", byte_len=2,
                  parameter_config={"type": "number"}),
            _leaf(id="c", name="C", sequence=3, op_code="INPUT", byte_len=1,
                  parameter_config={"type": "number", "pad_to": 8}),
        ]
        got = decode_hex(fields, "01020304 05060708")
        self.assertEqual(self._ranges(got),
                         [("A", 1, 0, 1), ("B", 2, 1, 3), ("C", 1, 3, 4)])
        self.assertEqual((got["consumed"], got["residual"], got["warnings"]),
                         (8, 0, []))

    def test_repeat_expansion_yields_one_entry_per_copy(self):
        fields = [
            _leaf(id="g", name="G", sequence=1, op_code="ARRAY_GROUP", byte_len=0,
                  repeat_type="FIXED", repeat_count=3, parameter_config={}),
            _leaf(id="g1", name="G1", sequence=2, parent_id="g", op_code="INPUT",
                  byte_len=1, parameter_config={"type": "number"}),
        ]
        got = decode_hex(fields, "010203")
        self.assertEqual(self._ranges(got),
                         [("G1", 1, 0, 1), ("G1", 1, 1, 2), ("G1", 1, 2, 3)])

    def test_presence_miss_emits_no_entry(self):
        fields = [
            _leaf(id="ref", name="REF", sequence=1, op_code="INPUT", byte_len=1,
                  parameter_config={"value": 1, "type": "number"}),
            _leaf(id="opt", name="OPT", sequence=2, op_code="INPUT", byte_len=2,
                  parameter_config={"value": 7, "type": "number",
                                    "presence": {"ref_id": "ref", "expect": "2"}}),
        ]
        got = decode_hex(fields, "01")
        self.assertEqual(self._ranges(got), [("REF", 1, 0, 1)])
        self.assertEqual((got["consumed"], got["residual"]), (1, 0))


class DecodeGuardrailTest(unittest.TestCase):
    """告警与「解不出来」的诚实回报 —— 不许静默出错值，也不许凭空造警报。"""

    def test_empty_layout_decodes_nothing_and_no_phantom_warning(self):
        """空字段布局不解码：三字节应答 + 空布局不能造出 `residual` 尾字节假警报。"""
        got = decode_hex([], "AABBCC")
        self.assertEqual((got["fields"], got["consumed"], got["residual"],
                          got["warnings"]), ([], 0, 0, []))
        # 只有零长字段的布局同样不出条目（presence 未命中 / byte_len=0 同款早退）
        self.assertEqual(decode_hex([_leaf(byte_len=0)], "AABBCC")["fields"], [])

    def test_short_frame_marks_truncated_and_warns(self):
        fields = [
            _leaf(id="a", name="A", sequence=1, op_code="INPUT", byte_len=2,
                  parameter_config={"type": "number"}),
            _leaf(id="b", name="B", sequence=2, op_code="INPUT", byte_len=2,
                  parameter_config={"type": "number"}),
        ]
        got = decode_hex(fields, "010203")
        self.assertEqual([(f["name"], f["truncated"]) for f in got["fields"]],
                         [("A", False), ("B", True)])
        self.assertTrue(any("比字段布局短" in w for w in got["warnings"]), got["warnings"])

    def test_residual_tail_warns(self):
        fields = [_leaf(op_code="INPUT", byte_len=2, parameter_config={"type": "number"})]
        got = decode_hex(fields, "01020304")
        self.assertEqual(got["residual"], 2)
        self.assertTrue(any("尾部多出 2 字节" in w for w in got["warnings"]), got["warnings"])

    def test_non_hex_and_odd_length_warn_instead_of_raising(self):
        fields = [_leaf(op_code="INPUT", byte_len=2, parameter_config={"type": "number"})]
        self.assertEqual(decode_hex(fields, "ZZ")[ "warnings"],
                         ["响应含非十六进制字符，无法解码"])
        got = decode_hex(fields, "0102F")
        self.assertEqual(got["warnings"], ["响应 hex 为奇数位，末半字节已丢弃"])
        self.assertEqual(got["consumed"], 2)

    def test_field_index_covers_nested_and_flat(self):
        nested = [_leaf(id="g", children=[_leaf(id="kid", parent_id="g")])]
        flat = [_leaf(id="g"), _leaf(id="kid", parent_id="g")]
        for fields in (nested, flat):
            index = field_index(fields)
            self.assertIn("kid", index)

    def test_decode_field_bytes_handles_empty_payload(self):
        self.assertIsNone(decode_field_bytes(_leaf(), b""))


class LogFieldsTestBase(unittest.TestCase):
    """临时库：写侧与读侧不同会话，证明跨会话持久化（沿用 test_logs 先例）。"""

    def setUp(self):
        transport.reset()
        dispatch_mod._history.clear()
        sequence_runner.reset()
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'r10.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False,
                                            bind=self.engine)
        self.db = self.session_factory()
        self._make_instruction()

    def tearDown(self):
        transport.reset()
        dispatch_mod._history.clear()
        sequence_runner.reset()
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _make_instruction(self, *, deleted_at=None):
        inst = Instruction(id=INSTR_ID, device_code="DEV", code=INSTR_NAME,
                           name=INSTR_NAME, type="DYNAMIC", deleted_at=deleted_at)
        self.db.add(inst)
        self.db.flush()
        for spec in (
            dict(id="aaaaaaaa-1111-4111-8111-000000000011", sequence=1, name="高字节",
                 op_code="INPUT", byte_len=1, endianness="BIG",
                 parameter_config={"type": "number"}),
            dict(id="aaaaaaaa-1111-4111-8111-000000000012", sequence=2, name="低字节",
                 op_code="INPUT", byte_len=1, endianness="BIG",
                 parameter_config={"type": "number"}),
        ):
            self.db.add(InstructionField(instruction_id=INSTR_ID, **spec))
        self.db.commit()

    def _fresh(self):
        return self.session_factory()

    def _rows(self):
        with self._fresh() as db:
            return db.query(DispatchLog).order_by(DispatchLog.id).all()


class ResolveFieldsTest(LogFieldsTestBase):
    """`resolve_log_fields` 的口径：无应答 / 查不到 / 无布局 → NULL，且绝不抛。"""

    def _record(self, **kw):
        base = dict(source="manual", status="OK", channel="LOOPBACK",
                    hex_string="12 34", byte_count=2)
        base.update(kw)
        with self._fresh() as db:
            return record_log(db, **base)

    def test_resolves_by_name_and_returns_decode_payload(self):
        got = resolve_log_fields(self.db, "1234", instruction_name=INSTR_NAME)
        self.assertEqual([f["name"] for f in got["fields"]], ["高字节", "低字节"])
        self.assertEqual([f["value"] for f in got["fields"]], [18, 52])
        self.assertEqual(got["warnings"], [])

    def test_resolves_by_id_even_when_row_is_in_trash(self):
        """日志行留存的正是那条指令 —— 指令进了回收站也要解得出（FE 只能查活行）。"""
        got = resolve_log_fields(self.db, "1234", instruction_id=INSTR_ID)
        self.assertEqual(len(got["fields"]), 2)

    def test_empty_echo_returns_none_without_querying(self):
        self.assertIsNone(resolve_log_fields(self.db, "", instruction_name=INSTR_NAME))
        self.assertIsNone(resolve_log_fields(self.db, None, instruction_id=INSTR_ID))

    def test_unknown_instruction_returns_none(self):
        self.assertIsNone(resolve_log_fields(self.db, "1234", instruction_name="不存在"))
        self.assertIsNone(resolve_log_fields(self.db, "1234", instruction_id="nope"))
        self.assertIsNone(resolve_log_fields(self.db, "1234"))

    def test_instruction_without_fields_returns_none(self):
        """空字段布局不解码（R9 同口径）—— 不能凭空造一条 residual 警告。"""
        bare = Instruction(id="bbbbbbbb-1111-4111-8111-000000000001", device_code="DEV",
                           code="裸", name="裸", type="DYNAMIC")
        self.db.add(bare)
        self.db.commit()
        self.assertIsNone(resolve_log_fields(self.db, "1234", instruction_id=bare.id))

    def test_name_lookup_skips_soft_deleted_rows(self):
        """按名解析只在**未软删**行里找（与 FE 从 /instructions 活行取首个对齐）。"""
        shadow = Instruction(id="cccccccc-1111-4111-8111-000000000001", device_code="DEV",
                             code=INSTR_NAME, name=INSTR_NAME, type="DYNAMIC",
                             deleted_at="2026-10-01T00:00:00+00:00")
        self.db.add(shadow)
        self.db.flush()
        self.db.add(InstructionField(
            instruction_id=shadow.id, id="cccccccc-1111-4111-8111-000000000011",
            sequence=1, name="影子", op_code="INPUT", byte_len=2,
            parameter_config={"type": "number"}))
        self.db.commit()
        got = resolve_log_fields(self.db, "1234", instruction_name=INSTR_NAME)
        self.assertEqual([f["name"] for f in got["fields"]], ["高字节", "低字节"])

    def test_record_log_backfills_fields_json(self):
        """单一接缝：四条写入缝都过这里，缺省自动回填（序列路 daemon 线程依赖它）。"""
        with self._fresh() as db:
            row_id = record_log(db, source="sequence", status="OK", channel="LOOPBACK",
                                hex_string="12 34", echo="1234", byte_count=2,
                                instruction_name=INSTR_NAME, instruction_id=INSTR_ID,
                                sequence_id="s1", step_order=1)
        with self._fresh() as db:
            row = db.query(DispatchLog).filter(DispatchLog.id == row_id).one()
            self.assertEqual(row.fields_json["consumed"], 2)
            self.assertEqual([f["value"] for f in row.fields_json["fields"]], [18, 52])

    def test_record_log_null_when_nothing_decodable(self):
        with self._fresh() as db:
            row_id = record_log(db, source="manual", status="ERROR", channel="LOOPBACK",
                                hex_string="12 34", echo="", byte_count=2,
                                instruction_name=INSTR_NAME, error="boom")
        with self._fresh() as db:
            row = db.query(DispatchLog).filter(DispatchLog.id == row_id).one()
            self.assertIsNone(row.fields_json)

    def test_explicit_fields_wins_over_recompute(self):
        """回执与落库共用同一次解码 —— 显式传入就不再查库重算。"""
        payload = {"fields": [], "consumed": 0, "total": 0, "residual": 0,
                   "warnings": ["调用方已解过"]}
        with self._fresh() as db:
            row_id = record_log(db, source="manual", status="OK", channel="LOOPBACK",
                                hex_string="12 34", echo="1234", byte_count=2,
                                instruction_name="不存在", fields=payload)
        with self._fresh() as db:
            row = db.query(DispatchLog).filter(DispatchLog.id == row_id).one()
            self.assertEqual(row.fields_json["warnings"], ["调用方已解过"])

    def test_safe_log_bypass_when_not_a_session(self):
        safe_log(object(), source="manual", status="OK")  # 直调未传 db → 跳过，不抛
        self.assertEqual(self._rows(), [])


class DispatchWiringTest(LogFieldsTestBase):
    """回执侧：`/dispatch/history` 的 `fields` 与 `fields_json` 是同一次解码。"""

    def test_manual_send_backfills_both_history_and_db(self):
        record = dispatch_frame(
            DispatchRequest(hex_string="12 34", instruction_name=INSTR_NAME),
            db=self.db,
        )
        self.assertEqual([f["value"] for f in record.fields["fields"]], [18, 52])
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].fields_json, record.fields)

    def test_manual_send_with_unresolvable_label_has_no_fields(self):
        """查不到指令 → 两边都 NULL/None（展示层退回 R9 客户端解码兜底）。"""
        record = dispatch_frame(
            DispatchRequest(hex_string="12 34", instruction_name="不存在的标签"),
            db=self.db,
        )
        self.assertIsNone(record.fields)
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0].fields_json)

    def test_sequence_hook_backfills_without_caller_passing_fields(self):
        """序列路跑在 daemon 线程、不持有路由会话 —— 只能靠 record_log 自己回填。"""
        hook = log_hook(self.session_factory)
        hook(source="sequence", status="OK", channel="LOOPBACK",
             hex_string="12 34", echo="1234", byte_count=2,
             instruction_name=INSTR_NAME, instruction_id=INSTR_ID,
             sequence_id="s1", step_order=1)
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual([f["value"] for f in rows[0].fields_json["fields"]], [18, 52])


class LogsReadTest(LogFieldsTestBase):
    """读侧：`/logs` 列表与 JSON 导出回填 `fields`，**CSV 列集逐字不变**。"""

    def _seed(self):
        with self._fresh() as db:
            record_log(db, source="manual", status="OK", channel="LOOPBACK",
                       hex_string="12 34", echo="1234", byte_count=2,
                       instruction_name=INSTR_NAME)

    def test_row_dict_exposes_fields_but_csv_columns_unchanged(self):
        self._seed()
        row = list_logs(db=self.db)[0]
        out = DispatchLogOut.model_validate(row, from_attributes=True)
        self.assertEqual([f["value"] for f in out.fields["fields"]], [18, 52])
        # 三种入参形都要认：ORM（FastAPI from_attributes 走这条）、列名 dict、键名 dict
        as_dict = {key: getattr(row, key) for key in _CSV_KEYS}
        for payload in ({"fields_json": row.fields_json, **as_dict},
                        {"fields": row.fields_json, **as_dict}):
            self.assertEqual(
                [f["value"] for f in DispatchLogOut.model_validate(payload).fields["fields"]],
                [18, 52], payload.get("fields", payload.get("fields_json")),
            )
        exported = _row_dict(row)
        self.assertIn("fields", exported)
        self.assertEqual(list(exported)[:len(_CSV_KEYS)], list(_CSV_KEYS))

    def test_json_export_carries_fields_csv_header_unchanged(self):
        self._seed()
        body = export_logs(format="json", db=self.db).body.decode("utf-8")
        items = jsonlib.loads(body)
        self.assertEqual([f["value"] for f in items[0]["fields"]["fields"]], [18, 52])
        csv_body = export_logs(format="csv", db=self.db).body.decode("utf-8-sig")
        self.assertEqual(csv_body.splitlines()[0], CSV_HEADER)


if __name__ == "__main__":
    unittest.main()
