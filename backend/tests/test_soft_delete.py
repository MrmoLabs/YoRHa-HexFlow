"""R6 软删除 / 回收站（PLAN §8.43）验收单测。

拍板（§8.37 R6）：**13 表统一加 `deleted_at`，仅新增列（合 §0），不做表重建**。
本文件守三件事：

1. **DDL** —— 13 表恰好都有 `deleted_at`；R6 之前的存量库（v1）由 `0002` 迁移
   逐表 `ALTER ADD COLUMN` 补齐（有备份、记版本、integrity ok）；新库 `create_all`
   已建全列 → 迁移只验不改（幂等，不撞「重复列名」）。
2. **写侧** —— 删除 = 打标记进回收站、恢复 = 清标记、彻底删除 = 真删行 + 级联；
   级联共用同一时间戳（恢复判据）；读侧 `alive()` 过滤（列表不出现、单查 404、
   二次删 404，与改前硬删后口径一致）。
3. **已知取舍** —— 回收站行**继续占用**唯一键（`sequences.name` /
   `device_profiles.label` / `response_specs.instruction_id` 都是 SQLite
   autoindex，拍板禁止表重建 → 删不掉），彻底删除才释放；`response_specs` 走
   upsert 复活；配方/档案的指针在删除期解除、恢复不回填。

夹具模式同 test_instruction_delete / test_protocol_delete：stdlib unittest 直调
路由函数 + 临时库（不走 TestClient，不触 lifespan）。
"""

import shutil
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base
from backend.db.migrate import (
    REGISTRY,
    TARGET_VERSION,
    current_version,
    ensure_migrations_table,
    run_pending_migrations,
    soft_delete_tables,
)
from backend.db.models import (
    DeviceProfile,
    DispatchLog,
    FrameRecipe,
    Instruction,
    InstructionField,
    ProtocolBinding,
    ProtocolTemplate,
    ResponseSpec,
    Sequence,
    SequenceStep,
)
from backend.routers.binding import create_binding, delete_binding, get_bindings
from backend.routers.instruction import (
    delete_instruction,
    get_instruction_detail,
    get_instructions,
)
from backend.routers.profile import create_profile, delete_profile, get_profiles
from backend.routers.protocol import create_protocol, delete_protocol, get_protocol, get_protocols
from backend.routers.recipe import delete_recipe, get_recipes
from backend.routers.response_spec import (
    delete_response_spec,
    get_response_spec,
    get_response_specs,
    upsert_response_spec,
)
from backend.routers.sequence import (
    create_sequence,
    delete_sequence,
    get_sequence,
    list_sequences,
)
from backend.routers.trash import KINDS, list_trash, purge_trash_item, restore_trash_item
from backend.schemas.binding_api import BindingCreate
from backend.schemas.profile_api import ProfileCreate
from backend.schemas.protocol_api import ProtocolCreate
from backend.schemas.response_spec_api import ResponseSpecUpsert
from backend.schemas.sequence_api import SequencePayload, SequenceStepSpec

# 拍板「13 表统一」的权威名单（防有人默默漏掉一张表）
EXPECTED_13_TABLES = {
    "instructions",
    "operator_templates",
    "protocols",
    "instruction_fields",
    "bit_fields",
    "protocol_bindings",
    "transport_settings",
    "device_profiles",
    "response_specs",
    "sequences",
    "sequence_steps",
    "dispatch_logs",
    "frame_recipes",
}


def _seq_payload(name):
    """最小合法序列（步骤引用 i-2，指令行可缺 —— _normalize_steps 不查指令表）。"""
    return SequencePayload(
        name=name,
        description=None,
        config=None,
        steps=[
            SequenceStepSpec(
                instruction_id="i-2",
                label="第一步",
                delay_ms=0,
                params={"f1": 5},
                payload="A5 01 0B",
                plan=None,
            )
        ],
    )


class MigrationDeletedAtTest(unittest.TestCase):
    """13 表的 `deleted_at` DDL（migrate.py 的 0002 迁移）。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="yorha-r6-migrate-"))
        self.backups = self.tmp / "backups"
        self.engine = create_engine(f"sqlite:///{(self.tmp / 'r6.db').as_posix()}")

    def tearDown(self):
        self.engine.dispose()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _cols(self, table):
        with self.engine.connect() as conn:
            rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
        return {row[1] for row in rows}

    def test_models_carry_deleted_at_on_exactly_13_tables(self):
        Base.metadata.create_all(bind=self.engine)
        tables = soft_delete_tables()
        self.assertEqual(len(tables), 13)
        self.assertEqual(set(tables), EXPECTED_13_TABLES)
        for table in tables:
            self.assertIn("deleted_at", self._cols(table))  # create_all 已建全列

    def test_pre_r6_library_is_upgraded_by_0002(self):
        """存量库（无 `deleted_at`、已记 0001 基线）→ 0002 逐表补列 + 备份留痕。"""
        Base.metadata.create_all(bind=self.engine)
        with self.engine.begin() as conn:
            for table in soft_delete_tables():
                conn.exec_driver_sql(f"ALTER TABLE {table} DROP COLUMN deleted_at")
            ensure_migrations_table(conn)
            conn.exec_driver_sql(
                "INSERT INTO schema_migrations (version, name, applied_at) "
                "VALUES (1, 'baseline', '2026-10-01T00:00:00')"
            )
        for table in soft_delete_tables():
            self.assertNotIn("deleted_at", self._cols(table))

        report = run_pending_migrations(
            self.engine, do_backup=True, backups_dir=self.backups
        )

        # 从 0001 起的全部待执行迁移（0002 必须排第一 —— 本用例的被测对象；
        # 后续新增版本不硬编码进断言，避免每加一条迁移就改这里）
        pending = [f"{m.version:04d}_{m.name}" for m in REGISTRY if m.version >= 2]
        self.assertEqual(report["applied"][0], "0002_soft_delete_deleted_at")
        self.assertEqual(report["applied"], pending)
        self.assertEqual(report["from_version"], 1)
        self.assertEqual(report["to_version"], TARGET_VERSION)
        self.assertEqual(report["integrity"], "ok")
        # 既有库先整库备份（DDL 前的回退路径）
        self.assertTrue(report["backup"])
        self.assertTrue(Path(report["backup"]).is_file())
        for table in soft_delete_tables():
            self.assertIn("deleted_at", self._cols(table))
        with self.engine.connect() as conn:
            self.assertEqual(current_version(conn), TARGET_VERSION)

    def test_fresh_library_only_verifies(self):
        """新库 create_all 已建全列 → 0002 的 ALTER 全部跳过（不撞重复列名）。"""
        Base.metadata.create_all(bind=self.engine)
        report = run_pending_migrations(
            self.engine, do_backup=False, backups_dir=self.backups
        )
        self.assertEqual(
            report["applied"], [f"{m.version:04d}_{m.name}" for m in REGISTRY]
        )
        self.assertEqual(report["integrity"], "ok")
        with self.engine.connect() as conn:
            self.assertEqual(current_version(conn), TARGET_VERSION)


class _TrashBase(unittest.TestCase):
    """13 表样样有行的公共夹具。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp.name) / "test_soft_delete.db"
        self.engine = create_engine(
            f"sqlite:///{db_path.as_posix()}", connect_args={"check_same_thread": False}
        )
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(
            autocommit=False, autoflush=False, bind=self.engine
        )
        self.db = self.session_factory()

        self.proto = create_protocol(ProtocolCreate(label="协议甲", children=[]), db=self.db)
        self.other_proto = create_protocol(ProtocolCreate(label="协议乙", children=[]), db=self.db)

        self.db.add(Instruction(id="i-1", device_code="01", code="C1", name="宿主指令"))
        self.db.add(Instruction(id="i-2", device_code="01", code="C2", name="旁支指令"))
        self.db.add(
            InstructionField(
                id="f-1", instruction_id="i-1", name="F1", sequence=0,
                op_code="INPUT", byte_len=1, endianness="BIG",
            )
        )
        self.db.add(
            ProtocolBinding(
                id="b-1", protocol_id=self.proto.id, instruction_id="i-1", label="绑定1"
            )
        )
        self.db.add(
            ProtocolBinding(
                id="b-2", protocol_id=self.other_proto.id, instruction_id="i-2", label="绑定2"
            )
        )
        self.db.add(ResponseSpec(id="rs-1", instruction_id="i-1", spec={"mode": "rules"}))
        self.db.add(ResponseSpec(id="rs-2", instruction_id="i-2", spec={"mode": "rules"}))
        self.db.add(Sequence(id="seq-1", name="序列甲", config={}))
        self.db.add(
            SequenceStep(
                id="st-1", sequence_id="seq-1", step_order=0, instruction_id="i-1",
                label="步1", delay_ms=0, payload="AA BB",
            )
        )
        self.db.add(Sequence(id="seq-2", name="序列乙", config={}))
        self.db.add(DeviceProfile(id="prof-1", label="档案甲", config={}))
        self.db.add(DeviceProfile(id="prof-2", label="档案乙", config={}))
        self.db.add(FrameRecipe(id="rec-1", name="配方甲", stages=[]))
        self.db.add(
            DispatchLog(
                created_at="2026-10-02T00:00:00+00:00", source="manual",
                channel="LOOPBACK", status="OK", byte_count=2, hex_string="AA BB",
                instruction_id="i-1",
            )
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    # ---- 小工具 ----
    def _trash(self):
        return list_trash(db=self.db).items

    def _ids(self, kind, items=None):
        rows = self._trash() if items is None else items
        return sorted(it.id for it in rows if it.kind == kind)

    def _assert_404(self, fn, *args):
        with self.assertRaises(HTTPException) as ctx:
            fn(*args, db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)


class TrashProtocolTest(_TrashBase):
    def test_delete_hides_reads_lists_in_trash_and_hides_cascade_children(self):
        result = delete_protocol(self.proto.id, db=self.db)
        self.assertEqual(result["deleted_bindings"], 1)

        # 读侧：列表不出现 / 单查 404 / 二次删 404（同改前硬删后口径）
        self.assertNotIn(self.proto.id, [p.id for p in get_protocols(db=self.db)])
        self._assert_404(get_protocol, self.proto.id)
        self._assert_404(delete_protocol, self.proto.id)
        # 连带入站的绑定从读侧消失（同改前的「级联清理」），旁支绑定不受影响
        self.assertEqual([b.id for b in get_bindings(db=self.db)], ["b-2"])

        # 回收站：宿主单独占一行，被连带的子行**不单独占一行**（恢复时会一起回来）
        items = self._trash()
        self.assertEqual(self._ids("protocol", items), [self.proto.id])
        self.assertEqual(self._ids("binding", items), [])
        # 行仍在库，且与宿主共用同一时间戳（= 恢复判据）
        host = (
            self.db.query(ProtocolTemplate)
            .filter(ProtocolTemplate.id == self.proto.id)
            .first()
        )
        child = self.db.query(ProtocolBinding).filter(ProtocolBinding.id == "b-1").first()
        self.assertEqual(host.deleted_at, child.deleted_at)

    def test_restore_brings_protocol_and_bindings_back(self):
        delete_protocol(self.proto.id, db=self.db)

        res = restore_trash_item("protocol", self.proto.id, db=self.db)

        self.assertEqual(res.status, "restored")
        self.assertEqual(res.related, {"bindings": 1})
        self.assertIn(self.proto.id, [p.id for p in get_protocols(db=self.db)])
        self.assertEqual({b.id for b in get_bindings(db=self.db)}, {"b-1", "b-2"})
        for row in (
            self.db.query(ProtocolTemplate).filter(ProtocolTemplate.id == self.proto.id).first(),
            self.db.query(ProtocolBinding).filter(ProtocolBinding.id == "b-1").first(),
        ):
            self.assertIsNone(row.deleted_at)
        self.assertEqual(self._trash(), [])  # 站清空

    def test_purge_truly_removes_rows_and_frees_the_key(self):
        delete_protocol(self.proto.id, db=self.db)

        res = purge_trash_item("protocol", self.proto.id, db=self.db)

        self.assertEqual(res.status, "purged")
        self.assertEqual(res.related, {"bindings": 1})
        self.assertEqual(
            self.db.query(ProtocolTemplate)
            .filter(ProtocolTemplate.id == self.proto.id)
            .count(),
            0,
        )
        self.assertEqual(
            self.db.query(ProtocolBinding)
            .filter(ProtocolBinding.protocol_id == self.proto.id)
            .count(),
            0,
        )
        # 旁支完好
        self.assertEqual(self.db.query(ProtocolBinding).filter(ProtocolBinding.id == "b-2").count(), 1)
        self.assertEqual(self._ids("protocol"), [])


class TrashInstructionTest(_TrashBase):
    def test_cascade_hides_children_but_leaves_rows_and_siblings(self):
        result = delete_instruction("i-1", db=self.db)
        self.assertEqual(result["deleted_bindings"], 1)
        self.assertEqual(result["deleted_response_specs"], 1)
        self.assertEqual(result["orphaned_sequence_steps"], 1)

        self.assertNotIn("i-1", [i.id for i in get_instructions(db=self.db)])
        self._assert_404(get_instruction_detail, "i-1")
        self._assert_404(delete_instruction, "i-1")

        items = self._trash()
        self.assertEqual(self._ids("instruction", items), ["i-1"])
        # 宿主在站里 → 连带入站的子行隐藏；i-2 的原样活在库里
        self.assertEqual(self._ids("binding", items), [])
        self.assertEqual(self._ids("response_spec", items), [])
        self.assertEqual({b.id for b in get_bindings(db=self.db)}, {"b-2"})
        self.assertEqual({r.instruction_id for r in get_response_specs(db=self.db)}, {"i-2"})

        # 三表同戳（恢复判据）：宿主 / 绑定 / 应答规格
        stamps = {
            self.db.query(Instruction).filter(Instruction.id == "i-1").first().deleted_at,
            self.db.query(ProtocolBinding).filter(ProtocolBinding.id == "b-1").first().deleted_at,
            self.db.query(ResponseSpec).filter(ResponseSpec.id == "rs-1").first().deleted_at,
        }
        self.assertEqual(len(stamps), 1)
        self.assertIsNotNone(stamps.pop())
        # 冻结快照与日志不动（三分口径不变）
        self.assertEqual(self.db.query(SequenceStep).count(), 1)
        self.assertEqual(self.db.query(DispatchLog).count(), 1)

    def test_restore_brings_children_back(self):
        delete_instruction("i-1", db=self.db)

        res = restore_trash_item("instruction", "i-1", db=self.db)

        self.assertEqual(res.related, {"bindings": 1, "response_specs": 1})
        self.assertIn("i-1", [i.id for i in get_instructions(db=self.db)])
        self.assertEqual({b.id for b in get_bindings(db=self.db)}, {"b-1", "b-2"})
        self.assertEqual(
            {r.instruction_id for r in get_response_specs(db=self.db)}, {"i-1", "i-2"}
        )
        self.assertEqual(self._trash(), [])

    def test_purge_removes_config_and_fields_but_keeps_snapshot_and_logs(self):
        delete_instruction("i-1", db=self.db)

        res = purge_trash_item("instruction", "i-1", db=self.db)

        self.assertEqual(res.related, {"bindings": 1, "response_specs": 1})
        self.assertEqual(
            self.db.query(Instruction).filter(Instruction.id == "i-1").count(), 0
        )
        self.assertEqual(
            self.db.query(InstructionField)
            .filter(InstructionField.instruction_id == "i-1")
            .count(),
            0,
        )
        self.assertEqual(
            self.db.query(ProtocolBinding)
            .filter(ProtocolBinding.instruction_id == "i-1")
            .count(),
            0,
        )
        self.assertEqual(
            self.db.query(ResponseSpec)
            .filter(ResponseSpec.instruction_id == "i-1")
            .count(),
            0,
        )
        # 旁支 + 冻结快照 + 日志原样
        self.assertEqual(self.db.query(Instruction).count(), 1)
        self.assertEqual(self.db.query(SequenceStep).count(), 1)
        self.assertEqual(self.db.query(DispatchLog).count(), 1)
        self.assertEqual(self._trash(), [])

    def test_standalone_child_keeps_its_own_entry_across_parent_restore(self):
        """独立入站的子行：不被父行的恢复顺带捞回，也不被父行的删除吞掉记账。"""
        delete_binding("b-2", db=self.db)
        self.assertEqual(self._ids("binding"), ["b-2"])  # 宿主活着 → 显示

        delete_instruction("i-2", db=self.db)
        self.assertEqual(self._ids("binding"), [])  # 宿主也进站 → 隐藏
        self.assertEqual(self._ids("response_spec"), [])  # rs-2 被连带

        res = restore_trash_item("instruction", "i-2", db=self.db)
        # b-2 不算在内（戳不同 → 不是被连带入站的那一批）
        self.assertEqual(res.related, {"bindings": 0, "response_specs": 1})
        self.assertEqual(self._ids("binding"), ["b-2"])  # 宿主回来 → 重新露出


class TrashSequenceProfileRecipeTest(_TrashBase):
    def test_sequence_delete_keeps_steps_then_purge_clears_them(self):
        self.assertEqual(delete_sequence("seq-1", db=self.db).status_code, 204)
        self.assertNotIn("seq-1", [s.id for s in list_sequences(db=self.db)])
        self._assert_404(get_sequence, "seq-1")
        self.assertEqual(
            self.db.query(SequenceStep).filter(SequenceStep.sequence_id == "seq-1").count(),
            1,
        )

        res = purge_trash_item("sequence", "seq-1", db=self.db)
        self.assertEqual(res.related, {"steps": 1})
        self.assertEqual(
            self.db.query(SequenceStep).filter(SequenceStep.sequence_id == "seq-1").count(),
            0,
        )
        self.assertEqual(self.db.query(Sequence).count(), 1)  # seq-2 完好

    def test_sequence_name_reserved_while_in_trash_until_purged(self):
        delete_sequence("seq-1", db=self.db)
        with self.assertRaises(HTTPException) as ctx:
            create_sequence(_seq_payload("序列甲"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)  # 软删行继续占名

        purge_trash_item("sequence", "seq-1", db=self.db)
        created = create_sequence(_seq_payload("序列甲"), db=self.db)
        self.assertEqual(created.name, "序列甲")

    def test_profile_label_reserved_while_in_trash_until_purged(self):
        delete_profile("prof-1", db=self.db)
        self.assertNotIn("prof-1", [p.id for p in get_profiles(db=self.db)])
        with self.assertRaises(HTTPException) as ctx:
            create_profile(ProfileCreate(label="档案甲"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)  # 软删行继续占名

        purge_trash_item("profile", "prof-1", db=self.db)
        created = create_profile(ProfileCreate(label="档案甲"), db=self.db)
        self.assertEqual(created.label, "档案甲")

    def test_recipe_delete_clears_link_and_purge_reclears(self):
        row = (
            self.db.query(Instruction).filter(Instruction.id == "i-1").first()
        )
        row.default_recipe_id = "rec-1"
        self.db.commit()

        # 软删仍解除指针（活行不许指向回收站行）—— 回执口径不变
        result = delete_recipe("rec-1", db=self.db)
        self.assertEqual(result["cleared_instructions"], 1)
        self.assertNotIn("rec-1", [r.id for r in get_recipes(db=self.db)])

        # 恢复配方（不回填指针 = 已知取舍，需重新指定）
        restore_trash_item("recipe", "rec-1", db=self.db)
        self.assertIn("rec-1", [r.id for r in get_recipes(db=self.db)])

        # 重新指定后再次入站并彻底删除 → 指针再清一次，不留脏行
        row = self.db.query(Instruction).filter(Instruction.id == "i-1").first()
        row.default_recipe_id = "rec-1"
        self.db.commit()
        delete_recipe("rec-1", db=self.db)
        purge_trash_item("recipe", "rec-1", db=self.db)
        row = self.db.query(Instruction).filter(Instruction.id == "i-1").first()
        self.assertIsNone(row.default_recipe_id)
        self.assertEqual(self.db.query(FrameRecipe).count(), 0)

    def test_live_link_to_trashed_recipe_degrades_to_no_recipe(self):
        """读侧 alive 过滤：指针指向回收站行 → 按「无配方」降级（回空数组）。"""
        row = self.db.query(Instruction).filter(Instruction.id == "i-1").first()
        row.default_recipe_id = "rec-1"
        rec = self.db.query(FrameRecipe).filter(FrameRecipe.id == "rec-1").first()
        rec.deleted_at = "2026-10-02T00:00:00+00:00"
        self.db.commit()

        self.assertEqual(get_recipes(db=self.db, instruction_id="i-1"), [])
        self.assertNotIn("rec-1", [r.id for r in get_recipes(db=self.db)])

        rec.deleted_at = None
        self.db.commit()
        self.assertEqual(len(get_recipes(db=self.db, instruction_id="i-1")), 1)

    def test_purge_live_item_and_unknown_kind_are_rejected(self):
        self._assert_404(restore_trash_item, "nope", "x")
        with self.assertRaises(HTTPException) as ctx:
            purge_trash_item("nope", "x", db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)
        with self.assertRaises(HTTPException) as ctx:
            restore_trash_item("protocol", "ghost-id", db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)
        # 活行不在回收站 → 400（不是 404：行在，只是状态不对）
        with self.assertRaises(HTTPException) as ctx:
            restore_trash_item("protocol", self.proto.id, db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            purge_trash_item("protocol", self.proto.id, db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_response_spec_upsert_revives_trashed_row(self):
        delete_response_spec("i-1", db=self.db)
        self.assertNotIn("i-1", [r.instruction_id for r in get_response_specs(db=self.db)])
        self._assert_404(get_response_spec, "i-1")

        row = upsert_response_spec(
            "i-1",
            ResponseSpecUpsert(spec={"mode": "rules", "prefix": "AA55"}),
            db=self.db,
        )

        self.assertEqual(row.id, "rs-1")  # 同一行复活，没撞唯一键、没换 id
        orm = (
            self.db.query(ResponseSpec).filter(ResponseSpec.id == "rs-1").first()
        )
        self.assertIsNone(orm.deleted_at)
        self.assertEqual(orm.spec["mode"], "rules")
        self.assertEqual(orm.spec["prefix"], "AA55")  # 覆盖写（spec 换掉）
        self.assertIn("i-1", [r.instruction_id for r in get_response_specs(db=self.db)])
        self.assertEqual(self._trash(), [])


class TrashScopeTest(_TrashBase):
    def test_kind_whitelist_excludes_logs_templates_and_transport(self):
        """拍板只要 7 类可回收：日志（追加型审计）、模板与单行配置不进站。"""
        self.assertEqual(
            set(KINDS),
            {
                "protocol",
                "instruction",
                "binding",
                "recipe",
                "sequence",
                "profile",
                "response_spec",
            },
        )
        self.assertEqual(self._trash(), [])  # 夹具里有日志/模板/配置 → 站是空的

    def test_trash_list_counts_and_labels(self):
        delete_sequence("seq-1", db=self.db)
        delete_profile("prof-1", db=self.db)
        delete_binding("b-2", db=self.db)

        resp = list_trash(db=self.db)
        self.assertEqual(resp.count, len(resp.items))
        labels = {it.kind: it.label for it in resp.items}
        self.assertEqual(labels["sequence"], "序列甲")
        self.assertEqual(labels["profile"], "档案甲")
        self.assertEqual(labels["binding"], "绑定2")
        # 最近删的在前（倒序）
        self.assertEqual(resp.items[0].kind, "binding")


if __name__ == "__main__":
    unittest.main()
