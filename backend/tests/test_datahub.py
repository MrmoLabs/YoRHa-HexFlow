"""C3 数据中心一期：stdlib unittest 直测纯函数（无新增依赖，不碰真库）。

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

from backend.db.models import BitField, Instruction, InstructionField
from backend.routers.datahub import (
    build_bundle,
    compile_blocks,
    create_backup,
    fields_to_blocks,
    format_hex_text,
    frame_bytes,
    instructions_export_payload,
    list_backups,
    replace_database_file,
    sanitize_filename,
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


if __name__ == "__main__":
    unittest.main()
