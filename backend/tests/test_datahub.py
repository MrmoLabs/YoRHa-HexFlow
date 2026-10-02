"""C3 数据中心一期 + 批次四 4a：stdlib unittest 直测纯函数与临时库回灌
（无新增依赖，不碰真库 —— 关系回灌用 tempfile 临时 SQLite，镜像 test_bindings）。

运行（仓库根目录）：
    python -m unittest backend.tests.test_datahub -v
"""
import json
import tempfile
import unittest
import zipfile
from datetime import datetime
from io import BytesIO
from pathlib import Path
from unittest import mock

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core.definition_hash import protocol_definition_hash
from backend.core.transport import default_config as default_transport_config
from backend.db.database import Base, ensure_binding_columns, ensure_response_spec_columns
from backend.db.models import (
    DeviceProfile,
    FrameRecipe,
    Instruction,
    InstructionField,
    OperatorTemplate,
    ProtocolBinding,
    ProtocolTemplate,
    ResponseSpec,
    Sequence,
    SequenceStep,
    TransportSetting,
)
from backend.routers import datahub
from backend.routers.datahub import (
    BUNDLE_DOMAIN_VERSIONS,
    PROFILES_SCHEMA_VERSION,
    RECIPES_SCHEMA_VERSION,
    RELATIONS_SCHEMA_VERSION,
    SEQUENCES_SCHEMA_VERSION,
    TEMPLATES_SCHEMA_VERSION,
    TRANSPORT_SCHEMA_VERSION,
    build_bundle,
    bundle_manifest,
    compile_blocks,
    create_backup,
    fields_to_blocks,
    format_hex_text,
    frame_bytes,
    import_relations,
    import_relations_endpoint,
    instructions_export_payload,
    list_backups,
    profiles_export_payload,
    recipes_export_payload,
    relations_export_payload,
    replace_database_file,
    safety_snapshot,
    sanitize_filename,
    sequences_export_payload,
    templates_export_payload,
    transport_export_payload,
    validate_backup_name,
)


def field(id, name, op_code, byte_len=0, parent_id=None, sequence=0, config=None, children=()):
    return {
        "id": id,
        "parent_id": parent_id,
        "sequence": sequence,
        "name": name,
        "op_code": op_code,
        "byte_len": byte_len,
        "endianness": "BIG",
        "repeat_type": "NONE",
        "repeat_ref_id": None,
        "repeat_count": 1,
        "parameter_config": config or {},
        "bits": [],
        "children": list(children),
    }


class TestFieldsToBlocks(unittest.TestCase):
    def test_nested_structure_and_types(self):
        # 子字段 → container；LENGTH/CHECKSUM(byte>0) → length/checksum；
        # byte_len=0 的 LENGTH_CALC 降级 fixed；HEX_RAW 带 hex 透传。
        fields = [
            field("hdr", "HDR", "HEX_RAW", byte_len=2, config={"hex": "AA 55"}, sequence=0),
            field("grp", "GROUP", "STRUCT", byte_len=0, sequence=1, children=[
                field("len", "LEN", "LENGTH_CALC", byte_len=1, parent_id="grp", sequence=0),
                field("body", "BODY", "UINT", byte_len=2, parent_id="grp", sequence=1),
            ]),
            field("dyn", "DYN_LEN", "LENGTH_CALC", byte_len=0, sequence=2),
            field("crc", "CRC", "CHECKSUM_CRC", byte_len=1, sequence=3),
        ]
        blocks = fields_to_blocks(fields)

        self.assertEqual([b["type"] for b in blocks], ["fixed", "container", "fixed", "checksum"])
        self.assertEqual(blocks[0]["hex_value"], "AA 55")
        self.assertTrue(blocks[1]["is_container"])
        self.assertEqual([c["type"] for c in blocks[1]["children"]], ["length", "fixed"])
        self.assertEqual(blocks[2]["byte_length"], 0)
        # config=None → LengthHandler 退化 0x00 填充，不引用 target id
        self.assertIsNone(blocks[1]["children"][0]["config"])

    def test_ordering_stable_and_orphan_promoted(self):
        # 扁平列表：顶层/children 均按 sequence 排序；parent_id 悬空 → 提升顶层
        fields = [
            field("b", "B", "UINT", byte_len=1, sequence=5),
            field("a", "A", "UINT", byte_len=1, sequence=1),
            field("c", "C", "UINT", byte_len=1, parent_id="missing", sequence=9),
            field("k2", "K2", "UINT", byte_len=1, parent_id="grp", sequence=2),
            field("grp", "GRP", "STRUCT", sequence=3, children=[]),
            field("k1", "K1", "UINT", byte_len=1, parent_id="grp", sequence=1),
        ]
        blocks = fields_to_blocks(fields)
        self.assertEqual([b["label"] for b in blocks], ["A", "GRP", "B", "C"])
        grp = next(b for b in blocks if b["label"] == "GRP")
        self.assertEqual(grp["type"], "container")
        self.assertEqual([c["label"] for c in grp["children"]], ["K1", "K2"])

    def test_nested_tree_input_equivalent(self):
        # 同一结构改为嵌套 children 树输入 → 结果与扁平一致
        flat = [
            field("grp", "GRP", "STRUCT", sequence=0, children=[]),
            field("k", "K", "UINT", byte_len=1, parent_id="grp", sequence=1),
        ]
        tree = [
            field("grp", "GRP", "STRUCT", sequence=0, children=[
                field("k", "K", "UINT", byte_len=1, parent_id="grp", sequence=1),
            ]),
        ]
        self.assertEqual(fields_to_blocks(tree), fields_to_blocks(flat))

    def test_empty_input(self):
        self.assertEqual(fields_to_blocks(None), [])
        self.assertEqual(fields_to_blocks([]), [])


class TestBundleBuild(unittest.TestCase):
    def test_compile_skeleton_frame(self):
        fields = [
            field("hdr", "HDR", "HEX_RAW", byte_len=2, sequence=0, config={"hex": "AA55"}),
            field("pad", "PAD", "UINT", byte_len=2, sequence=1),  # 无 hex → 00 占位
        ]
        data = frame_bytes(compile_blocks(fields_to_blocks(fields)))
        self.assertEqual(data, bytes.fromhex("AA550000"))

    def test_frame_bytes_and_hex_text(self):
        self.assertEqual(frame_bytes("AA 55_0a"), bytes.fromhex("AA550A"))
        self.assertEqual(frame_bytes(""), b"")
        with self.assertRaises(ValueError):
            frame_bytes("AAA")
        self.assertEqual(format_hex_text(bytes.fromhex("AA05")), "AA 05\n")
        self.assertEqual(format_hex_text(b""), "\n")

    def test_build_bundle_zip_contents(self):
        entries = [
            ("instructions.json", b'{"instructions": []}'),
            ("frames/CMD_1.bin", b"\x01\x02"),
            ("frames/CMD_1.hex", b"01 02\n"),
            ("manifest.json", b"{}"),
        ]
        with zipfile.ZipFile(BytesIO(build_bundle(entries))) as zf:
            self.assertEqual(zf.namelist(), [e[0] for e in entries])
            self.assertEqual(zf.read("frames/CMD_1.bin"), b"\x01\x02")

    def test_sanitize_filename_blocks_traversal(self):
        self.assertEqual(sanitize_filename("CMD_01"), "CMD_01")
        self.assertEqual(sanitize_filename("V1.2"), "V1.2")
        self.assertEqual(sanitize_filename("a/b\\c"), "a_b_c")
        # 遍历串：结果必须是单段文件名（无分隔符、无 '..'）
        for raw in ("../evil/../x", "..\\evil", "..", "/abs/path", ""):
            safe = sanitize_filename(raw)
            self.assertNotIn("/", safe)
            self.assertNotIn("\\", safe)
            self.assertNotIn("..", safe)
            self.assertTrue(safe)
        self.assertEqual(sanitize_filename("..."), "instruction")


class TestExportPayload(unittest.TestCase):
    def test_payload_symmetric_with_import(self):
        # 导出格式 = 指令页 analyzeImport 输入：{instructions:[…]} + 扁平 fields
        inst = Instruction(
            id="i1", device_code="D1", code="CMD_1", name="指令一", type="DYNAMIC",
            description="demo",
        )
        root = InstructionField(
            id="f1", instruction_id="i1", parent_id=None, sequence=0, name="HDR",
            op_code="HEX_RAW", byte_len=2, endianness="BIG",
            repeat_type="NONE", repeat_count=1, parameter_config={"hex": "AA55"},
        )
        root.bit_fields = []
        child = InstructionField(
            id="f2", instruction_id="i1", parent_id="f1", sequence=1, name="MODE",
            op_code="UINT", byte_len=1, endianness="BIG",
            repeat_type="NONE", repeat_count=1, parameter_config={},
        )
        child.bit_fields = []
        inst.fields = [root, child]

        payload = instructions_export_payload([inst])
        self.assertEqual(payload["schemaVersion"], 1)
        self.assertEqual(len(payload["instructions"]), 1)
        inst_json = payload["instructions"][0]
        self.assertEqual(inst_json["code"], "CMD_1")
        self.assertEqual([f["id"] for f in inst_json["fields"]], ["f1", "f2"])
        self.assertEqual(inst_json["fields"][1]["parent_id"], "f1")
        # 可 JSON 序列化（zip 入口依赖）
        json.dumps(payload)


class TestBackupRestore(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.db = self.root / "yorha.db"
        self.db.write_bytes(b"ORIGINAL")
        self.backup_dir = self.root / "backups"

    def tearDown(self):
        self._tmp.cleanup()

    def test_create_and_list_backups(self):
        now = datetime(2026, 9, 22, 12, 0, 0)
        first = create_backup(self.db, self.backup_dir, now=now)
        self.assertEqual(first.name, "yorha-20260922-120000.db")
        self.assertEqual(first.read_bytes(), b"ORIGINAL")
        # 同秒冲突 → 自动序号
        second = create_backup(self.db, self.backup_dir, now=now)
        self.assertEqual(second.name, "yorha-20260922-120000-1.db")
        self.assertEqual(len(list_backups(self.backup_dir)), 2)
        self.assertEqual(list_backups(self.root / "nope"), [])

    def test_validate_backup_name_rejects_traversal(self):
        create_backup(self.db, self.backup_dir, now=datetime(2026, 9, 22, 12, 0, 0))
        ok = validate_backup_name("yorha-20260922-120000.db", self.backup_dir)
        self.assertTrue(ok.is_file())

        for bad in ("../yorha.db", "..\\x.db", "a/b.db", "", "notdb.txt", "nope.db"):
            with self.assertRaises(ValueError, msg=bad):
                validate_backup_name(bad, self.backup_dir)

    def test_replace_database_file_clears_side_files(self):
        src = self.backup_dir / "b.db"
        self.backup_dir.mkdir()
        src.write_bytes(b"RESTORED")
        # 模拟 WAL/SHM/journal 残留 + 临时文件残留
        (self.root / "yorha.db-wal").write_bytes(b"WAL")
        (self.root / "yorha.db-shm").write_bytes(b"SHM")
        (self.root / "yorha.db-journal").write_bytes(b"J")
        (self.root / "yorha.db.restore-tmp").write_bytes(b"STALE")

        replace_database_file(src, self.db)

        self.assertEqual(self.db.read_bytes(), b"RESTORED")
        for suffix in ("-wal", "-shm", "-journal"):
            self.assertFalse((self.root / f"yorha.db{suffix}").exists())
        self.assertFalse((self.root / "yorha.db.restore-tmp").exists())

    def test_list_backups_flags_safety_snapshot(self):
        self.backup_dir.mkdir()
        (self.backup_dir / "pre-restore-1.db").write_bytes(b"A")
        (self.backup_dir / "yorha-1.db").write_bytes(b"B")
        entries = list_backups(self.backup_dir)
        self.assertEqual(len(entries), 2)
        by_name = {e["name"]: e for e in entries}
        self.assertTrue(by_name["pre-restore-1.db"]["isSafetySnapshot"])
        self.assertFalse(by_name["yorha-1.db"]["isSafetySnapshot"])
        self.assertEqual(by_name["yorha-1.db"]["sizeBytes"], 1)


# --------------------------------------------------------------------------
# 批次四 4a：relations.json 导出形 + 回灌（临时库直调 import_relations）
# --------------------------------------------------------------------------


def relation_binding(id="b1", protocol_id="p1", instruction_id="i1", **over):
    row = {
        "id": id,
        "protocol_id": protocol_id,
        "instruction_id": instruction_id,
        "label": "绑定一",
        "slot_order": 0,
        "slot_id": None,
        "is_default": 1,
        "priority": 0,
        "definition_hash": "sha256:abc",
    }
    row.update(over)
    return row


def relation_spec(id="rs1", instruction_id="i1", **over):
    row = {
        "id": id,
        "instruction_id": instruction_id,
        "spec": {"mode": "rules", "prefix": "AA", "suffix": "", "echo_header_bytes": 1,
                 "length": None, "checksum": None, "ignore_ranges": []},
        "stage": None,
        "definition_hash": "sha256:def",
    }
    row.update(over)
    return row


class RelationsTestCase(unittest.TestCase):
    """4a 关系回灌的临时库基座（镜像 test_bindings.setUp 的建库三步）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db_file = Path(self.tmp.name) / "test_relations.db"
        self.engine = create_engine(f"sqlite:///{db_file.as_posix()}", connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        ensure_binding_columns(self.engine)
        ensure_response_spec_columns(self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()
        self.db.add(Instruction(id="i1", device_code="D1", code="CMD_1", name="指令一", type="DYNAMIC"))
        self.db.add(Instruction(id="i2", device_code="D1", code="CMD_2", name="指令二", type="DYNAMIC"))
        self.db.add(ProtocolTemplate(id="p1", label="协议一", type="container", children=[
            {"id": "s1", "label": "S1", "type": "slot"},
            {"id": "f1", "label": "F1", "type": "fixed", "byte_length": 1},
        ]))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()


class TestRelationsExportPayload(RelationsTestCase):
    def test_shape_and_row_fields(self):
        self.db.add(ProtocolBinding(**relation_binding()))
        self.db.add(ResponseSpec(id="rs1", instruction_id="i1", spec={"mode": "rules"},
                                 stage=2, definition_hash="sha256:def"))
        self.db.commit()
        bindings = self.db.query(ProtocolBinding).all()
        specs = self.db.query(ResponseSpec).all()

        payload = relations_export_payload(bindings, specs)
        self.assertEqual(payload["schemaVersion"], RELATIONS_SCHEMA_VERSION)
        self.assertEqual(len(payload["bindings"]), 1)
        self.assertEqual(len(payload["responseSpecs"]), 1)
        row = payload["bindings"][0]
        self.assertEqual(row["id"], "b1")
        self.assertEqual(row["definition_hash"], "sha256:abc")
        self.assertEqual(row["slot_id"], None)
        self.assertEqual(sorted(row), sorted(relation_binding()))
        spec_row = payload["responseSpecs"][0]
        self.assertEqual(spec_row["stage"], 2)
        self.assertEqual(spec_row["definition_hash"], "sha256:def")
        self.assertEqual(sorted(spec_row), sorted(relation_spec()))
        # 导出形可 JSON 直序列化（ZIP 入口依赖）
        json.dumps(payload)

    def test_empty_relations_are_lists(self):
        payload = relations_export_payload([], [])
        self.assertEqual(payload["bindings"], [])
        self.assertEqual(payload["responseSpecs"], [])


class TestImportRelations(RelationsTestCase):
    def test_round_trip_preserves_rows(self):
        # 源载荷 = 导出形（dict），回灌后再次导出应逐字段等价
        source = {
            "schemaVersion": RELATIONS_SCHEMA_VERSION,
            "bindings": [
                relation_binding(slot_id="s1"),
                relation_binding(id="b2", instruction_id="i2", label="绑定二",
                                 slot_order=1, is_default=0),
            ],
            "responseSpecs": [relation_spec()],
        }
        report = import_relations(self.db, source)
        self.assertEqual(report["bindings"], {"imported": 2, "updated": 0, "skipped": []})
        self.assertEqual(report["responseSpecs"]["imported"], 1)
        self.assertEqual(report["warnings"], [])

        back = relations_export_payload(
            self.db.query(ProtocolBinding).order_by(ProtocolBinding.id).all(),
            self.db.query(ResponseSpec).order_by(ResponseSpec.id).all(),
        )
        self.assertEqual(back["bindings"], source["bindings"])
        self.assertEqual(back["responseSpecs"], source["responseSpecs"])

    def test_upsert_same_id_updates_without_duplicate(self):
        import_relations(self.db, {"bindings": [relation_binding(label="旧名")]})
        report = import_relations(self.db, {"bindings": [relation_binding(label="新名")]})
        self.assertEqual(report["bindings"], {"imported": 0, "updated": 1, "skipped": []})
        rows = self.db.query(ProtocolBinding).all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].label, "新名")

    def test_missing_parents_skipped_with_reason(self):
        report = import_relations(self.db, {"bindings": [
            relation_binding(id="b-no-i", instruction_id="no-such"),
            relation_binding(id="b-no-p", protocol_id="no-such"),
            relation_binding(id="b-missing-fields", protocol_id="", instruction_id=""),
        ]})
        self.assertEqual(report["bindings"]["imported"], 0)
        reasons = {s["id"]: s["reason"] for s in report["bindings"]["skipped"]}
        self.assertIn("指令不存在", reasons["b-no-i"])
        self.assertIn("协议不存在", reasons["b-no-p"])
        self.assertIn("缺 id", reasons["b-missing-fields"])

    def test_trashed_parents_treated_as_missing(self):
        # R6（§8.43）：**回收站里的宿主不是合法宿主** —— 回灌按「不存在」跳过，
        # 否则会写进一条指向回收站行的活绑定（读侧 alive 挡不住这种活行）。
        TRASHED = "2026-10-02T00:00:00+00:00"
        self.db.query(Instruction).filter(Instruction.id == "i1").update(
            {"deleted_at": TRASHED}, synchronize_session=False
        )
        self.db.query(ProtocolTemplate).filter(ProtocolTemplate.id == "p1").update(
            {"deleted_at": TRASHED}, synchronize_session=False
        )
        self.db.commit()

        report = import_relations(self.db, {"bindings": [
            relation_binding(id="b-dead-i"),                      # 指令已入站
            relation_binding(id="b-dead-p", instruction_id="i2"),  # 指令活、协议已入站
        ]})
        self.assertEqual(report["bindings"]["imported"], 0)
        reasons = {s["id"]: s["reason"] for s in report["bindings"]["skipped"]}
        self.assertIn("指令不存在", reasons["b-dead-i"])
        self.assertIn("协议不存在", reasons["b-dead-p"])

        spec_report = import_relations(self.db, {"responseSpecs": [relation_spec()]})
        self.assertEqual(spec_report["responseSpecs"]["imported"], 0)
        self.assertIn(
            "指令不存在", spec_report["responseSpecs"]["skipped"][0]["reason"]
        )

    def test_dangling_slot_cleared_with_warning(self):
        report = import_relations(self.db, {"bindings": [relation_binding(slot_id="gone")]})
        self.assertEqual(report["bindings"]["imported"], 1)
        self.assertEqual(len(report["warnings"]), 1)
        self.assertIn("悬空", report["warnings"][0])
        self.assertIsNone(self.db.query(ProtocolBinding).one().slot_id)
        # 存在的槽原样保留
        import_relations(self.db, {"bindings": [relation_binding(id="b2", slot_id="s1")]})
        self.assertEqual(self.db.query(ProtocolBinding).filter_by(id="b2").one().slot_id, "s1")

    def test_default_conflict_demotes_previous_default(self):
        import_relations(self.db, {"bindings": [
            relation_binding(id="b1", is_default=1),
            relation_binding(id="b2", instruction_id="i1", is_default=0),
        ]})
        report = import_relations(self.db, {"bindings": [relation_binding(id="b2", is_default=1)]})
        self.assertEqual(report["bindings"]["updated"], 1)
        rows = {r.id: r for r in self.db.query(ProtocolBinding).all()}
        self.assertEqual(rows["b2"].is_default, 1)
        self.assertEqual(rows["b1"].is_default, 0)

    def test_unique_slot_conflict_skipped(self):
        import_relations(self.db, {"bindings": [relation_binding(id="b1", slot_id="s1", is_default=0)]})
        report = import_relations(self.db, {"bindings": [
            relation_binding(id="b-other", slot_id="s1", is_default=0),
        ]})
        self.assertEqual(report["bindings"]["imported"], 0)
        self.assertEqual(len(report["bindings"]["skipped"]), 1)
        self.assertIn("唯一约束冲突", report["bindings"]["skipped"][0]["reason"])
        self.assertEqual(self.db.query(ProtocolBinding).count(), 1)

    def test_spec_stage_mirror_recomputed_and_hash_preserved(self):
        report = import_relations(self.db, {"responseSpecs": [
            relation_spec(stage=99, spec={
                "mode": "rules",
                "stages": [
                    {"unpack": {"head": 2, "trailer": 1}},
                    {"unpack": {"head": 2, "trailer": 1}},
                    {"unpack": {"head": 2, "trailer": 1}},
                ],
            }),
        ]})
        self.assertEqual(report["responseSpecs"]["imported"], 1)
        row = self.db.query(ResponseSpec).one()
        self.assertEqual(row.stage, 2)  # 文件里的 99 不作数，按 stages 重算
        self.assertEqual(row.definition_hash, "sha256:def")

    def test_spec_invalid_or_clashing_skipped(self):
        report = import_relations(self.db, {"responseSpecs": [
            relation_spec(id="rs-bad", spec={"mode": "bogus"}),
            relation_spec(id="rs-notobj", spec="oops"),
            relation_spec(id="rs-no-parent", instruction_id="no-such"),
            relation_spec(id="", instruction_id="i2"),
        ]})
        reasons = {s["id"]: s["reason"] for s in report["responseSpecs"]["skipped"]}
        self.assertIn("spec 非法", reasons["rs-bad"])
        self.assertIn("必须是对象", reasons["rs-notobj"])
        self.assertIn("指令不存在", reasons["rs-no-parent"])
        self.assertIn("缺 id", reasons[""])
        self.assertEqual(report["responseSpecs"]["imported"], 0)

        import_relations(self.db, {"responseSpecs": [relation_spec(id="rs1")]})
        clash = import_relations(self.db, {"responseSpecs": [relation_spec(id="rs-other")]})
        self.assertIn("已有应答规格", clash["responseSpecs"]["skipped"][0]["reason"])
        self.assertEqual(self.db.query(ResponseSpec).count(), 1)

    def test_top_level_strict_keys(self):
        with self.assertRaises(HTTPException) as ctx:
            import_relations(self.db, {"bindings": [], "extra": 1})
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("未知字段", ctx.exception.detail)

        with self.assertRaises(HTTPException) as ctx:
            import_relations(self.db, {"schemaVersion": 99})
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("schemaVersion", ctx.exception.detail)

        with self.assertRaises(HTTPException) as ctx:
            import_relations(self.db, ["not", "an", "object"])
        self.assertEqual(ctx.exception.status_code, 400)

        with self.assertRaises(HTTPException) as ctx:
            import_relations(self.db, {"bindings": {}})
        self.assertEqual(ctx.exception.status_code, 400)

    def test_partial_success_keeps_good_rows(self):
        report = import_relations(self.db, {"bindings": [
            relation_binding(id="b-ok"),
            relation_binding(id="b-bad", instruction_id="no-such"),
        ]})
        self.assertEqual(report["bindings"]["imported"], 1)
        self.assertEqual(len(report["bindings"]["skipped"]), 1)
        self.assertEqual(self.db.query(ProtocolBinding).count(), 1)


class TestImportPreSnapshot(RelationsTestCase):
    """PLAN §8.37 R1：关系回灌**前**的 pre-import 自动快照（端点层，直调路由函数）。

    钉四件事：快照在写库之前留下并回报 / 400 不留垃圾快照 / 快照失败即中止且一行
    都没写 / 库文件不存在时静默跳过；另钉 `_backup_entry` 把 pre-import 也认成
    安全快照（否则备份列表里它长得和手建备份一样，用户看不出该拿哪个回退）。
    """

    def setUp(self):
        super().setUp()
        # 端点读的是模块级 DB_PATH / BACKUP_DIR —— 替换后必须在 tearDown 还原
        # （同 §8.35 的教训：只替换不还原会泄漏到后续用例）。
        self._saved_paths = (datahub.DB_PATH, datahub.BACKUP_DIR)
        self.db_file = Path(self.tmp.name) / "yorha.db"
        self.db_file.write_bytes(b"ORIGINAL")
        self.backup_dir = Path(self.tmp.name) / "backups"
        datahub.DB_PATH = self.db_file
        datahub.BACKUP_DIR = self.backup_dir

    def tearDown(self):
        datahub.DB_PATH, datahub.BACKUP_DIR = self._saved_paths
        super().tearDown()

    def _snapshot_names(self):
        if not self.backup_dir.is_dir():
            return []
        return sorted(p.name for p in self.backup_dir.glob("pre-import-*.db"))

    def test_snapshot_taken_before_write_and_reported(self):
        report = import_relations_endpoint({"bindings": [relation_binding()]}, db=self.db)

        names = self._snapshot_names()
        self.assertEqual(len(names), 1)
        self.assertTrue(names[0].startswith("pre-import-"))
        self.assertEqual(report["preImportSnapshot"], names[0])
        # 快照字节 = 写库之前的库文件（本用例造的 ORIGINAL），不是回灌后的状态
        self.assertEqual((self.backup_dir / names[0]).read_bytes(), b"ORIGINAL")
        # 回灌照常进行，响应只做加法（原有键一个不少）
        self.assertEqual(report["bindings"]["imported"], 1)
        self.assertEqual(report["warnings"], [])

    def test_invalid_payload_400_leaves_no_snapshot_and_no_write(self):
        with self.assertRaises(HTTPException) as ctx:
            import_relations_endpoint({"nope": 1}, db=self.db)

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(self._snapshot_names(), [])  # 校验先行 → 不产生垃圾快照
        self.assertEqual(self.db.query(ProtocolBinding).count(), 0)

    def test_snapshot_failure_aborts_import_with_500(self):
        # 让快照目录位置被同名**文件**占住 → mkdir 抛 OSError（FileExistsError）
        blocker = Path(self.tmp.name) / "blocked"
        blocker.write_bytes(b"I AM A FILE")
        datahub.BACKUP_DIR = blocker

        with self.assertRaises(HTTPException) as ctx:
            import_relations_endpoint({"bindings": [relation_binding()]}, db=self.db)

        self.assertEqual(ctx.exception.status_code, 500)
        self.assertTrue(ctx.exception.detail.startswith("安全快照失败，已中止导入："))
        self.assertIn("blocked", ctx.exception.detail)
        # 关键不变量：快照失败 → 一行都没写（库保持原样，不需要回退）
        self.assertEqual(self.db.query(ProtocolBinding).count(), 0)

    def test_missing_db_file_skips_snapshot_but_import_works(self):
        datahub.DB_PATH = Path(self.tmp.name) / "no-such-db.db"

        report = import_relations_endpoint({"bindings": [relation_binding()]}, db=self.db)

        self.assertIsNone(report["preImportSnapshot"])
        self.assertEqual(self._snapshot_names(), [])
        self.assertEqual(report["bindings"]["imported"], 1)

    def test_helper_maps_oserror_and_tolerates_missing_db(self):
        # 库不存在 → None、不报错
        self.assertIsNone(
            safety_snapshot("pre-import", "导入",
                            db_path=Path(self.tmp.name) / "nope.db",
                            backup_dir=self.backup_dir)
        )
        # 快照失败 → 500、消息带场景词
        blocker = Path(self.tmp.name) / "blocked2"
        blocker.write_bytes(b"I AM A FILE")
        with self.assertRaises(HTTPException) as ctx:
            safety_snapshot("pre-import", "导入",
                            db_path=self.db_file, backup_dir=blocker)
        self.assertEqual(ctx.exception.status_code, 500)
        self.assertTrue(ctx.exception.detail.startswith("安全快照失败，已中止导入："))
        self.assertIn("blocked2", ctx.exception.detail)

    def test_pre_import_flagged_as_safety_snapshot(self):
        self.backup_dir.mkdir()
        (self.backup_dir / "pre-import-1.db").write_bytes(b"A")
        (self.backup_dir / "pre-restore-1.db").write_bytes(b"B")
        (self.backup_dir / "yorha-1.db").write_bytes(b"C")
        flags = {e["name"]: e["isSafetySnapshot"] for e in list_backups(self.backup_dir)}
        self.assertTrue(flags["pre-import-1.db"])
        self.assertTrue(flags["pre-restore-1.db"])
        self.assertFalse(flags["yorha-1.db"])


# --------------------------------------------------------------------------
# R7（PLAN §8.45 · §8.37 R7 行）：导出补域 —— 5 个新域载荷 + manifest 8 域清单
# + export_bundle 端到端（临时库直调，镜像 RelationsTestCase 建库三步）
# --------------------------------------------------------------------------


def recipe_row(id="r1", name="套壳配方", **over):
    row = FrameRecipe(
        id=id, name=name, description="两层封装",
        stages=[{"protocol_id": "p1", "slot_ids": ["s1"], "definition_hash": "sha256:abc"}],
        version=2, created_at="2026-10-02T00:00:00+00:00",
        updated_at="2026-10-02T01:00:00+00:00",
    )
    for key, value in over.items():
        setattr(row, key, value)
    return row


def sequence_step_row(id="st1", sequence_id="s1", step_order=0, instruction_id="i1", **over):
    row = SequenceStep(
        id=id, sequence_id=sequence_id, step_order=step_order,
        instruction_id=instruction_id, label="步一", delay_ms=10,
        params={"f1": 1}, payload="AA55FF", plan={"dynamic": []},
        wrap={"recipe_id": "r1"},
    )
    for key, value in over.items():
        setattr(row, key, value)
    return row


class TestExportDomainPayloads(unittest.TestCase):
    """R7 新增 5 域的载荷形（纯函数 + 内存 ORM 行，不碰库）。

    每域断言两件事：**列子集不含 `deleted_at`**（回灌后恒是活行，R6 口径）与
    **可 JSON 直序列化**（ZIP 入口依赖）。
    """

    def test_recipes_payload_shape(self):
        payload = recipes_export_payload([recipe_row()])
        self.assertEqual(payload["schemaVersion"], RECIPES_SCHEMA_VERSION)
        self.assertEqual(len(payload["recipes"]), 1)
        row = payload["recipes"][0]
        self.assertEqual(row["id"], "r1")
        self.assertEqual(row["name"], "套壳配方")
        self.assertEqual(row["stages"][0]["definition_hash"], "sha256:abc")
        self.assertEqual(row["version"], 2)
        self.assertNotIn("deleted_at", row)
        json.dumps(payload)

    def test_sequences_payload_nests_steps_and_drops_foreign(self):
        seq = Sequence(id="s1", name="冒烟序列", description="d",
                       config={"stop_on_error": True})
        steps = [
            sequence_step_row(id="st1", step_order=0),
            sequence_step_row(id="st2", step_order=1, instruction_id="i2",
                              label="步二", delay_ms=0, params=None,
                              payload="BB", plan=None, wrap=None),
            # 宿主不在导出列表里的步骤：**必须被丢掉**（分组只认给定序列）
            sequence_step_row(id="st-foreign", sequence_id="s2"),
        ]
        payload = sequences_export_payload([seq], steps)
        self.assertEqual(payload["schemaVersion"], SEQUENCES_SCHEMA_VERSION)
        row = payload["sequences"][0]
        self.assertEqual(row["id"], "s1")
        self.assertEqual(row["config"], {"stop_on_error": True})
        self.assertEqual([s["id"] for s in row["steps"]], ["st1", "st2"])
        self.assertNotIn("deleted_at", row)
        # 内嵌后子行不再重复宿主列（宿主-从属同进同出，靠外层 id 关联）
        self.assertNotIn("sequence_id", row["steps"][0])
        self.assertEqual(row["steps"][1]["label"], "步二")
        json.dumps(payload)

    def test_sequences_payload_keeps_given_step_order(self):
        seq = Sequence(id="s1", name="冒烟序列", description=None, config={})
        payload = sequences_export_payload(
            [seq], [sequence_step_row(id="st9", step_order=9)]
        )
        self.assertEqual([s["id"] for s in payload["sequences"][0]["steps"]], ["st9"])
        self.assertEqual(payload["sequences"][0]["steps"][0]["step_order"], 9)

    def test_transport_profiles_templates_payloads(self):
        transport_payload = transport_export_payload([
            TransportSetting(id="current", config={"mode": "serial"}, active_profile_id="d1")
        ])
        self.assertEqual(transport_payload["schemaVersion"], TRANSPORT_SCHEMA_VERSION)
        row = transport_payload["settings"][0]
        self.assertEqual(row["id"], "current")  # 单行约定
        self.assertEqual(row["active_profile_id"], "d1")
        self.assertNotIn("deleted_at", row)

        profiles = profiles_export_payload([
            DeviceProfile(id="d1", label="车间A", config={"mode": "serial"})
        ])
        self.assertEqual(profiles["schemaVersion"], PROFILES_SCHEMA_VERSION)
        self.assertEqual(profiles["profiles"][0]["label"], "车间A")
        self.assertNotIn("deleted_at", profiles["profiles"][0])

        templates = templates_export_payload([
            OperatorTemplate(op_code="HEX_RAW", name="十六进制原样", category="BASIC",
                             param_template={"hex": {}}, description="逐字节原样")
        ])
        self.assertEqual(templates["schemaVersion"], TEMPLATES_SCHEMA_VERSION)
        self.assertEqual(templates["templates"][0]["op_code"], "HEX_RAW")
        self.assertEqual(templates["templates"][0]["param_template"], {"hex": {}})
        self.assertNotIn("deleted_at", templates["templates"][0])

        for payload in (transport_payload, profiles, templates):
            json.dumps(payload)


class TestBundleManifest(unittest.TestCase):
    """manifest.domainVersion = 8 域清单（R7 拍板的「原 3 域 → 8 域」）。"""

    def _manifest(self, frames=("f1",)):
        return bundle_manifest(
            {"instructions": [1]},
            {"bindings": [1], "responseSpecs": [1]},
            {
                "recipes": {"recipes": [1, 2]},
                "sequences": {"sequences": [1]},
                "transport": {"settings": [1]},
                "profiles": {"profiles": [1, 2]},
                "templates": {"templates": [1]},
            },
            list(frames),
        )

    def test_eight_domain_inventory(self):
        manifest = self._manifest()
        self.assertEqual(
            list(manifest["domainVersion"]),
            ["instructions", "relations", "frames", "recipes", "sequences",
             "transport", "profiles", "templates"],
        )
        self.assertEqual(len(manifest["domainVersion"]), 8)
        self.assertEqual(manifest["domainVersion"], BUNDLE_DOMAIN_VERSIONS)
        # 域清单与行数表**键集严格相等** —— 少一域、多一域都算 bug
        self.assertEqual(set(manifest["domainCounts"]), set(manifest["domainVersion"]))

    def test_counts_and_legacy_keys(self):
        manifest = self._manifest()
        self.assertEqual(manifest["domainCounts"], {
            "instructions": 1,
            "relations": 2,
            "frames": 1,
            "recipes": 2,
            "sequences": 1,
            "transport": 1,
            "profiles": 2,
            "templates": 1,
        })
        # 存量三键只做加法 —— 旧消费方读 manifest 一个字段都不用改
        self.assertEqual(manifest["instructionCount"], 1)
        self.assertEqual(manifest["relations"],
                         {"bindings": 1, "responseSpecs": 1})
        self.assertEqual(manifest["frames"], ["f1"])
        self.assertIn("generatedAt", manifest)
        self.assertEqual(manifest["appVersion"], datahub.APP_VERSION)

    def test_guard_catches_domain_inventory_drift(self):
        # 往域清单里加一域却忘了补 counts → 必须报错，而不是静默出一个缺域的包
        drifted = {**BUNDLE_DOMAIN_VERSIONS, "protocols": 1}
        with mock.patch.object(datahub, "BUNDLE_DOMAIN_VERSIONS", drifted):
            with self.assertRaises(ValueError) as ctx:
                self._manifest()
        self.assertIn("域清单不一致", str(ctx.exception))


class TestExportBundleEightDomains(RelationsTestCase):
    """端到端：GET /datahub/export/bundle → 8 个域文件 + manifest 8 域清单。

    同时钉两条既有纪律：**回收站行不进包**（R6 §8.43，指令 / 绑定 / 应答规格 /
    配方 / 序列 / 档案 六处）与 **序列步骤随宿主同进同出**。
    """

    def setUp(self):
        super().setUp()
        self.db.add(FrameRecipe(id="r1", name="套壳配方", description="d",
                                stages=[{"protocol_id": "p1",
                                         "definition_hash": "sha256:abc"}],
                                version=1))
        self.db.add(FrameRecipe(id="r-trash", name="回收站配方", description=None,
                                stages=[], version=1,
                                deleted_at="2026-10-02T00:00:00+00:00"))
        self.db.add(Sequence(id="s1", name="冒烟序列", description="d",
                             config={"stop_on_error": True}))
        self.db.add(Sequence(id="s-trash", name="回收站序列", description=None,
                             config={}, deleted_at="2026-10-02T00:00:00+00:00"))
        self.db.add(sequence_step_row(id="st1", sequence_id="s1", step_order=0,
                                      instruction_id="i1"))
        self.db.add(sequence_step_row(id="st-trash", sequence_id="s-trash",
                                      step_order=0, instruction_id="i1"))
        self.db.add(TransportSetting(id="current", config={"mode": "serial"},
                                     active_profile_id=None))
        self.db.add(DeviceProfile(id="d1", label="车间A", config={"mode": "serial"}))
        self.db.add(DeviceProfile(id="d-trash", label="回收站档案", config={},
                                  deleted_at="2026-10-02T00:00:00+00:00"))
        self.db.add(OperatorTemplate(op_code="HEX_RAW", name="十六进制原样",
                                     category="BASIC", param_template={"hex": {}},
                                     description="逐字节原样"))
        # 回收站行（R6 六类可回收）：指令 / 绑定 / 应答规格 三处也要被挡住
        self.db.add(Instruction(id="i-trash", device_code="D1", code="CMD_TRASH",
                                name="回收站指令", type="DYNAMIC",
                                deleted_at="2026-10-02T00:00:00+00:00"))
        self.db.add(ProtocolBinding(id="b-trash", protocol_id="p1",
                                    instruction_id="i1", label="回收站绑定",
                                    slot_order=9, deleted_at="2026-10-02T00:00:00+00:00"))
        self.db.add(ResponseSpec(id="rs-trash", instruction_id="i2",
                                 spec={"mode": "rules"},
                                 deleted_at="2026-10-02T00:00:00+00:00"))
        self.db.commit()

        patcher = mock.patch.object(datahub, "SessionLocal", return_value=self.db)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_zip_carries_eight_domains(self):
        resp = datahub.export_bundle()
        with zipfile.ZipFile(BytesIO(resp.body)) as zf:
            names = zf.namelist()
            for domain in (
                "instructions.json", "relations.json", "recipes.json",
                "sequences.json", "transport.json", "profiles.json",
                "templates.json",
            ):
                self.assertIn(domain, names)
            self.assertIn("manifest.json", names)

            manifest = json.loads(zf.read("manifest.json"))
            self.assertEqual(list(manifest["domainVersion"]),
                             list(BUNDLE_DOMAIN_VERSIONS))
            self.assertEqual(len(manifest["domainVersion"]), 8)
            self.assertEqual(set(manifest["domainCounts"]),
                             set(manifest["domainVersion"]))

            # 回收站行不进包 —— 六处逐一钉
            instructions = json.loads(zf.read("instructions.json"))
            self.assertEqual([i["id"] for i in instructions["instructions"]],
                             ["i1", "i2"])
            relations = json.loads(zf.read("relations.json"))
            self.assertEqual(relations["bindings"], [])
            self.assertEqual(relations["responseSpecs"], [])
            recipes = json.loads(zf.read("recipes.json"))
            self.assertEqual([r["id"] for r in recipes["recipes"]], ["r1"])
            self.assertNotIn("deleted_at", recipes["recipes"][0])
            sequences = json.loads(zf.read("sequences.json"))
            self.assertEqual([s["id"] for s in sequences["sequences"]], ["s1"])
            # 站内序列的步骤一步都不出（宿主-从属同进同出）
            self.assertEqual([s["id"] for s in sequences["sequences"][0]["steps"]],
                             ["st1"])
            profiles = json.loads(zf.read("profiles.json"))
            self.assertEqual([p["id"] for p in profiles["profiles"]], ["d1"])
            templates = json.loads(zf.read("templates.json"))
            self.assertEqual([t["op_code"] for t in templates["templates"]],
                             ["HEX_RAW"])

            self.assertEqual(manifest["domainCounts"], {
                "instructions": 2,
                "relations": 0,
                "frames": 2,
                "recipes": 1,
                "sequences": 1,
                "transport": 1,
                "profiles": 1,
                "templates": 1,
            })
            # 存量三键仍在
            self.assertEqual(manifest["instructionCount"], 2)
            self.assertEqual(manifest["relations"],
                             {"bindings": 0, "responseSpecs": 0})
            self.assertEqual(len(manifest["frames"]), 2)


# --------------------------------------------------------------------------
# R8（PLAN §8.46 · §8.37 R8 行）：按域导入 —— 顶层校验 / 五域回灌 / 三段式快照
# --------------------------------------------------------------------------


class TestDomainPayloadValidation(unittest.TestCase):
    """按域载荷的顶层校验（纯函数）—— 400 必须发生在**落快照之前**。"""

    def test_rejects_bad_top_level(self):
        for bad, fragment in (
            (["不是对象"], "必须是对象"),
            ({"recipes": [], "extra": 1}, "未知顶层键"),
            ({"recipes": [], "schemaVersion": 99}, "schemaVersion 不支持"),
            ({"schemaVersion": 1}, "缺 recipes 数组"),
        ):
            with self.assertRaises(HTTPException) as ctx:
                datahub.recipes_rows(bad)
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn(fragment, str(ctx.exception.detail))

    def test_accepts_current_and_missing_version(self):
        # schemaVersion 缺省按当前版本收（镜像 `_relations_payload` 先例）
        self.assertEqual(datahub.recipes_rows({"recipes": [1]}), [1])
        self.assertEqual(
            datahub.recipes_rows(
                {"recipes": [1], "schemaVersion": RECIPES_SCHEMA_VERSION}
            ),
            [1],
        )
        for validator, key in (
            (datahub.sequences_rows, "sequences"),
            (datahub.transport_rows, "settings"),
            (datahub.profiles_rows, "profiles"),
            (datahub.templates_rows, "templates"),
        ):
            self.assertEqual(validator({key: []}), [])


class TestImportDomains(RelationsTestCase):
    """五个新域的回灌（临时库直调 importer）。"""

    def test_recipes_recompute_hash_and_skip_missing_protocol(self):
        payload = {"recipes": [
            {"id": "r1", "name": "配方一", "description": "d",
             "stages": [{"protocol_id": "p1", "slot_ids": ["s1"],
                         "definition_hash": "sha256:stale"}],
             "version": 3},
            {"id": "r-bad", "name": "缺协议", "version": 1,
             "stages": [{"protocol_id": "p-404", "slot_ids": None}]},
        ]}
        report = datahub.import_recipes(self.db, payload)
        self.assertEqual(report["imported"], 1)
        self.assertEqual(len(report["skipped"]), 1)
        self.assertEqual(report["skipped"][0]["id"], "r-bad")
        self.assertEqual(report["skipped"][0]["reason"], "协议不存在：p-404")

        row = self.db.query(FrameRecipe).one()
        # definition_hash **不采信载荷** —— 按目标机协议 children 重算
        children = self.db.query(ProtocolTemplate).one().children
        self.assertEqual(row.stages[0]["definition_hash"],
                         protocol_definition_hash(children))
        self.assertNotEqual(row.stages[0]["definition_hash"], "sha256:stale")
        self.assertEqual(row.version, 3)

        # 同 id 再导 → updated，版本与名字一并覆盖
        payload["recipes"][0]["name"] = "配方一改"
        self.assertEqual(datahub.import_recipes(self.db, payload)["updated"], 1)
        self.assertEqual(self.db.query(FrameRecipe).one().name, "配方一改")

    def test_sequences_whole_row_import_and_replace_steps(self):
        payload = {"sequences": [
            {"id": "s1", "name": "冒烟序列", "description": "d",
             "config": {"stop_on_error": False},
             "steps": [
                 {"instruction_id": "i1", "label": "步一", "delay_ms": 0,
                  "params": None, "payload": "AA55", "plan": None, "wrap": None},
                 {"instruction_id": "i1", "label": "步二", "delay_ms": 5,
                  "params": {"a": 1}, "payload": "BB", "plan": None, "wrap": None},
             ]},
            # 任一步骤宿主缺失 → **整条序列跳过**，不写一条缺步的序列
            {"id": "s-bad", "name": "缺指令", "config": None,
             "steps": [{"instruction_id": "i-404", "payload": "00"}]},
        ]}
        report = datahub.import_sequences(self.db, payload)
        self.assertEqual(report["imported"], 1)
        self.assertEqual(report["steps"], {"written": 2})
        self.assertEqual(report["skipped"][0]["reason"], "指令不存在：i-404")

        # 整体替换：同 id 再导 1 步 → updated，旧步被清掉
        payload["sequences"][0]["steps"] = payload["sequences"][0]["steps"][:1]
        report = datahub.import_sequences(self.db, payload)
        self.assertEqual(report["updated"], 1)
        self.assertEqual(report["steps"], {"written": 1})
        self.assertEqual(
            self.db.query(SequenceStep)
            .filter(SequenceStep.sequence_id == "s1").count(),
            1,
        )
        self.assertEqual(self.db.query(Sequence).count(), 1)

    def test_transport_single_row_and_pointer_warning(self):
        report = datahub.import_transport_settings(self.db, {"settings": [
            {"id": "current", "config": default_transport_config(),
             "active_profile_id": "d-404"},
            {"id": "other", "config": default_transport_config()},
        ]})
        self.assertEqual(report["imported"], 1)
        self.assertEqual(len(report["skipped"]), 1)
        self.assertIn("只支持单行配置", report["skipped"][0]["reason"])
        # 指针指向目标机没有的活档案 → **置空并记警告**，不带悬空指针进来
        self.assertIn("已置空", report["warnings"][0])
        row = self.db.query(TransportSetting).one()
        self.assertIsNone(row.active_profile_id)
        self.assertEqual(row.config["mode"], "loopback")

    def test_profiles_label_clash_and_trashed_id(self):
        self.db.add(DeviceProfile(
            id="d1", label="车间A", config=default_transport_config(),
            deleted_at="2026-10-02T00:00:00+00:00",
        ))
        self.db.commit()
        report = datahub.import_profiles(self.db, {"profiles": [
            {"id": "d1", "label": "车间A", "config": default_transport_config()},
            {"id": "d2", "label": "车间A", "config": default_transport_config()},
        ]})
        # d1 自己在回收站 → 提示先恢复；d2 撞名 → 跳过（label 是 inline UNIQUE）
        self.assertEqual(report["imported"], 0)
        self.assertEqual(len(report["skipped"]), 2)
        self.assertIn("回收站", report["skipped"][0]["reason"])
        self.assertIn("档案名已存在", report["skipped"][1]["reason"])

    def test_templates_upsert_by_op_code(self):
        payload = {"templates": [
            {"op_code": "HEX_RAW", "name": "原样", "category": "BASIC",
             "param_template": {"hex": "input"}, "description": "逐字节"},
            {"op_code": "", "name": "x", "category": "y", "param_template": {}},
        ]}
        report = datahub.import_operator_templates(self.db, payload)
        self.assertEqual(report["imported"], 1)
        self.assertEqual(report["skipped"][0]["reason"], "缺 op_code / name / category")
        payload["templates"][0]["name"] = "原样改"
        self.assertEqual(
            datahub.import_operator_templates(self.db, payload)["updated"], 1
        )
        self.assertEqual(self.db.query(OperatorTemplate).one().name, "原样改")


class TestDomainImportEndpoints(RelationsTestCase):
    """三段式：① 顶层校验 400 **不落快照** → ② 快照 → ③ 逐行回灌。"""

    def test_top_level_400_produces_no_snapshot(self):
        calls = []
        patcher = mock.patch.object(
            datahub, "safety_snapshot",
            side_effect=lambda *a, **k: calls.append(a) or None,
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        with self.assertRaises(HTTPException) as ctx:
            datahub.import_recipes_endpoint(
                {"recipes": [], "schemaVersion": 99}, db=self.db
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(calls, [])  # 纯函数 400 → 一行快照都不留

    def test_success_carries_preimport_snapshot(self):
        sentinel = {"name": "pre-import-9.db", "isSafetySnapshot": True}
        patcher = mock.patch.object(
            datahub, "safety_snapshot", return_value=sentinel
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        report = datahub.import_templates_endpoint(
            {"schemaVersion": TEMPLATES_SCHEMA_VERSION,
             "templates": [{"op_code": "HEX_RAW", "name": "原样",
                            "category": "BASIC", "param_template": {"hex": "input"}}]},
            db=self.db,
        )
        self.assertEqual(report["domain"], "templates")
        self.assertEqual(report["imported"], 1)
        self.assertEqual(report["preImportSnapshot"], sentinel)
        self.assertEqual(report["skipped"], [])


if __name__ == "__main__":
    unittest.main()

