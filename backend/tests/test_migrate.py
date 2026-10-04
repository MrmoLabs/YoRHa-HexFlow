"""DB 升级机制验收（批次：轻量版本化迁移 · PLAN §8.30 · `backend/db/migrate.py`）。

覆盖用户要求的四件事：**记录版本 / 升级前备份 / 升级结果检查 / 失败可恢复**：

1. 新库 → 记录基线版本（不备份：无存量可毁）；
2. 既有库 → apply 任何迁移前先整库快照（快照可用 sqlite3 打开读回数据）；
3. 幂等 → 到目标版本后二次运行只读态校验，不再备份、不再记版本；
4. 失败 → apply 抛错或 verify 不过，**单事务整体回滚、版本不前进**，
   且基线校验能抓出「表/自愈列缺失」的坏 schema（升级结果检查不是走过场）。

注册表纪律（版本号从 1 起连续、名字唯一）单独一组用例。
全部跑在临时库上，绝不触碰 `backend/db/yorha.db`。
"""
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from sqlalchemy import create_engine

from backend.db.database import Base
from backend.db.migrate import (
    REGISTRY,
    TARGET_VERSION,
    Migration,
    MigrationError,
    current_version,
    ensure_migrations_table,
    run_pending_migrations,
    status,
    validate_registry,
)


#: 注册表全量标签（版本号随 REGISTRY 增长，测试不硬编码单条迁移名）。
_ALL_LABELS = [f"{m.version:04d}_{m.name}" for m in REGISTRY]


class _MigrateCase(unittest.TestCase):
    """临时库 + 临时备份目录。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="yorha-migrate-"))
        self.backups = self.tmp / "backups"
        self.engine, self.db_path = self._new_engine("main.db")

    def tearDown(self):
        self.engine.dispose()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _new_engine(self, name):
        path = self.tmp / name
        return create_engine(f"sqlite:///{path.as_posix()}"), path

    def _tables(self, engine=None):
        with (engine or self.engine).connect() as conn:
            rows = conn.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        return {r[0] for r in rows}


class FreshDbTest(_MigrateCase):
    def test_fresh_db_records_baseline_without_backup(self):
        Base.metadata.create_all(bind=self.engine)

        report = run_pending_migrations(
            self.engine, do_backup=False, backups_dir=self.backups
        )

        self.assertEqual(report["applied"], _ALL_LABELS)
        self.assertEqual(report["from_version"], 0)
        self.assertEqual(report["to_version"], TARGET_VERSION)
        self.assertEqual(report["integrity"], "ok")
        self.assertIsNone(report["backup"])
        # 全新库（create_all 刚建出）不产生快照：没有会被毁掉的存量
        self.assertFalse(self.backups.exists())

        info = status(self.engine)
        self.assertEqual(info["current_version"], TARGET_VERSION)
        self.assertEqual(info["pending"], [])
        self.assertEqual(info["applied"], _ALL_LABELS)

    def test_version_row_names_migration(self):
        Base.metadata.create_all(bind=self.engine)
        run_pending_migrations(self.engine, do_backup=False, backups_dir=self.backups)

        with self.engine.connect() as conn:
            row = conn.exec_driver_sql(
                "SELECT name, applied_at FROM schema_migrations WHERE version = 1"
            ).fetchone()
        self.assertEqual(row[0], "baseline")
        self.assertTrue(row[1])  # 有时间戳留痕

    def test_second_run_is_noop(self):
        Base.metadata.create_all(bind=self.engine)
        run_pending_migrations(self.engine, do_backup=False, backups_dir=self.backups)

        second = run_pending_migrations(
            self.engine, do_backup=True, backups_dir=self.backups
        )
        self.assertEqual(second["applied"], [])
        self.assertEqual(second["to_version"], TARGET_VERSION)
        self.assertEqual(second["integrity"], "ok")
        self.assertIsNone(second["backup"])  # 无待执行 → 不备份
        self.assertFalse(self.backups.exists())


class ExistingDbBackupTest(_MigrateCase):
    def test_backup_taken_and_data_survives(self):
        Base.metadata.create_all(bind=self.engine)
        # 存量数据：独立于 models 的表，证明「升级前后数据都在」
        with self.engine.begin() as conn:
            conn.exec_driver_sql("CREATE TABLE scratch (k TEXT PRIMARY KEY, v TEXT)")
            conn.exec_driver_sql(
                "INSERT INTO scratch (k, v) VALUES ('keep', 'me')"
            )

        report = run_pending_migrations(
            self.engine, do_backup=True, backups_dir=self.backups
        )

        self.assertIsNotNone(report["backup"])
        backup = Path(report["backup"])
        self.assertTrue(backup.is_file())
        self.assertGreater(backup.stat().st_size, 0)
        self.assertEqual(report["applied"], _ALL_LABELS)

        # 快照可用（用 sqlite3 独立打开读回升级前的数据）
        with sqlite3.connect(str(backup)) as con:
            got = con.execute("SELECT v FROM scratch WHERE k='keep'").fetchone()
        self.assertEqual(got[0], "me")

        # 主库数据原样
        with self.engine.connect() as conn:
            v = conn.exec_driver_sql(
                "SELECT v FROM scratch WHERE k='keep'"
            ).scalar()
        self.assertEqual(v, "me")
        self.assertEqual(self._version(), TARGET_VERSION)

    def _version(self):
        with self.engine.connect() as conn:
            return current_version(conn)


class FieldsJsonMigrationTest(_MigrateCase):
    """R10（PLAN §8.48 · **全计划唯一 DDL 批**）：`dispatch_logs.fields_json` 仅新增列。"""

    def _cols(self, table):
        with self.engine.connect() as conn:
            rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
        return {row[1] for row in rows}

    def test_legacy_library_gains_fields_json_and_keeps_rows(self):
        """存量库（无 `fields_json`、已记 0001/0002）→ 0003 补列；存量行照留、新列 NULL。

        其后新增的迁移（0004 …）也一并跑掉 —— `device_profiles` 已建列 → 只验不改。
        断言用 `_ALL_LABELS[2:]` 跟注册表走，不硬编码到 0003 就死。
        """
        Base.metadata.create_all(bind=self.engine)
        with self.engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE dispatch_logs DROP COLUMN fields_json")
            ensure_migrations_table(conn)
            for version, name in ((1, "baseline"), (2, "soft_delete_deleted_at")):
                conn.exec_driver_sql(
                    "INSERT INTO schema_migrations (version, name, applied_at) "
                    f"VALUES ({version}, '{name}', '2026-10-01T00:00:00')"
                )
            conn.exec_driver_sql(
                "INSERT INTO dispatch_logs (id, created_at, source, channel, status,"
                " byte_count, hex_string, echo)"
                " VALUES (1, '2026-10-01T00:00:00', 'manual', 'LOOPBACK', 'OK', 2,"
                " '12 34', '1234')"
            )
        self.assertNotIn("fields_json", self._cols("dispatch_logs"))

        report = run_pending_migrations(
            self.engine, do_backup=False, backups_dir=self.backups
        )

        self.assertEqual(report["applied"], _ALL_LABELS[2:])  # 0003 + 后续新增
        self.assertEqual(report["to_version"], TARGET_VERSION)
        self.assertEqual(report["integrity"], "ok")
        self.assertIn("fields_json", self._cols("dispatch_logs"))
        with self.engine.connect() as conn:
            self.assertEqual(current_version(conn), TARGET_VERSION)
            row = conn.exec_driver_sql(
                "SELECT hex_string, fields_json FROM dispatch_logs WHERE id = 1"
            ).fetchone()
        self.assertEqual(row[0], "12 34")  # 存量行原样在
        self.assertIsNone(row[1])  # 存量行不回填（FE R9 客户端解码兜底）

    def test_fresh_library_only_verifies(self):
        """新库 create_all 已建列 → 0003 的 ALTER 全部跳过（不撞重复列名）。"""
        Base.metadata.create_all(bind=self.engine)
        report = run_pending_migrations(
            self.engine, do_backup=False, backups_dir=self.backups
        )
        self.assertIn("0003_dispatch_logs_fields_json", report["applied"])
        self.assertEqual(report["integrity"], "ok")
        self.assertIn("fields_json", self._cols("dispatch_logs"))

    def test_verify_actually_checks_the_column(self):
        """verify 不是走过场：补列范围钉死「恰好 dispatch_logs 一张」，列缺失即报错。"""
        from backend.db.migrate import _decode_json_verify, decode_json_tables
        Base.metadata.create_all(bind=self.engine)
        self.assertEqual(decode_json_tables(), ["dispatch_logs"])
        with self.engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE dispatch_logs DROP COLUMN fields_json")
        with self.engine.connect() as conn:
            with self.assertRaises(MigrationError) as ctx:
                _decode_json_verify(conn)
        self.assertIn("fields_json", str(ctx.exception))

    def test_backup_dir_gitignored(self):
        ignore = (Path(__file__).resolve().parents[2] / ".gitignore").read_text(
            encoding="utf-8"
        )
        self.assertIn("backend/db/backups/", ignore)


class ProfileSortMigrationTest(_MigrateCase):
    """R20（PLAN §8.50 ②-3 · 2026-10-03 拍板解禁 DDL）：`device_profiles.sort_order`（0004）。"""

    def _cols(self, table):
        with self.engine.connect() as conn:
            rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
        return {row[1] for row in rows}

    def test_legacy_library_gains_sort_order_and_rows_default_to_zero(self):
        """存量库（已记 0001–0003）→ 0004 补列；存量行拿到 0 =「未重排」。"""
        Base.metadata.create_all(bind=self.engine)
        with self.engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE device_profiles DROP COLUMN sort_order")
            ensure_migrations_table(conn)
            for version, name in (
                (1, "baseline"),
                (2, "soft_delete_deleted_at"),
                (3, "dispatch_logs_fields_json"),
            ):
                conn.exec_driver_sql(
                    "INSERT INTO schema_migrations (version, name, applied_at) "
                    f"VALUES ({version}, '{name}', '2026-10-03T00:00:00')"
                )
            conn.exec_driver_sql(
                "INSERT INTO device_profiles (id, label, config) "
                "VALUES ('p1', '车间A', '{}')"
            )
        self.assertNotIn("sort_order", self._cols("device_profiles"))

        report = run_pending_migrations(
            self.engine, do_backup=False, backups_dir=self.backups
        )

        self.assertEqual(report["applied"], _ALL_LABELS[3:])  # 0004 + 后续新增
        self.assertEqual(report["to_version"], TARGET_VERSION)
        self.assertEqual(report["integrity"], "ok")
        self.assertIn("sort_order", self._cols("device_profiles"))
        with self.engine.connect() as conn:
            row = conn.exec_driver_sql(
                "SELECT label, sort_order FROM device_profiles WHERE id = 'p1'"
            ).fetchone()
        self.assertEqual(row[0], "车间A")  # 存量行原样在
        self.assertEqual(row[1], 0)  # 未重排 → 排序键 (sort_order, label) 退化成 label 升序

    def test_fresh_library_only_verifies(self):
        """新库 create_all 已建列 → 0004 的 ALTER 直接跳过（不撞重复列名）。"""
        Base.metadata.create_all(bind=self.engine)
        report = run_pending_migrations(
            self.engine, do_backup=False, backups_dir=self.backups
        )
        self.assertIn("0004_device_profiles_sort_order", report["applied"])
        self.assertEqual(report["integrity"], "ok")
        self.assertIn("sort_order", self._cols("device_profiles"))

    def test_verify_actually_checks_the_table_and_column(self):
        """verify 不是走过场：补列范围钉死「恰好 device_profiles 一张」，列缺失即报错。"""
        from backend.db.migrate import _profile_sort_verify, profile_sort_tables

        Base.metadata.create_all(bind=self.engine)
        self.assertEqual(profile_sort_tables(), ["device_profiles"])
        with self.engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE device_profiles DROP COLUMN sort_order")
        with self.engine.connect() as conn:
            with self.assertRaises(MigrationError) as ctx:
                _profile_sort_verify(conn)
        self.assertIn("sort_order", str(ctx.exception))


class ConditionMigrationTest(_MigrateCase):
    """R26（PLAN §8.58 · 2026-10-04 拍板解禁 DDL）：`sequence_steps.condition`（0005，仅新增列）。"""

    def _cols(self, table):
        with self.engine.connect() as conn:
            rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
        return {row[1] for row in rows}

    def test_legacy_library_gains_condition_and_rows_stay_null(self):
        """存量库（已记 0001–0004）→ 0005 补列；存量行拿到 NULL = 无条件（路径逐字节不变）。"""
        Base.metadata.create_all(bind=self.engine)
        with self.engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE sequence_steps DROP COLUMN condition")
            ensure_migrations_table(conn)
            for version, name in (
                (1, "baseline"),
                (2, "soft_delete_deleted_at"),
                (3, "dispatch_logs_fields_json"),
                (4, "device_profiles_sort_order"),
            ):
                conn.exec_driver_sql(
                    "INSERT INTO schema_migrations (version, name, applied_at) "
                    f"VALUES ({version}, '{name}', '2026-10-04T00:00:00')"
                )
            conn.exec_driver_sql(
                "INSERT INTO sequence_steps (id, sequence_id, step_order, "
                "instruction_id, delay_ms, payload) "
                "VALUES ('s1', 'q1', 0, 'i1', 0, 'A5010B')"
            )
        self.assertNotIn("condition", self._cols("sequence_steps"))

        report = run_pending_migrations(
            self.engine, do_backup=False, backups_dir=self.backups
        )

        self.assertEqual(report["applied"], _ALL_LABELS[4:])  # 0005 + 后续新增
        self.assertEqual(report["to_version"], TARGET_VERSION)
        self.assertEqual(report["integrity"], "ok")
        self.assertIn("condition", self._cols("sequence_steps"))
        with self.engine.connect() as conn:
            row = conn.exec_driver_sql(
                "SELECT payload, condition FROM sequence_steps WHERE id = 's1'"
            ).fetchone()
        self.assertEqual(row[0], "A5010B")  # 存量步骤原样在
        self.assertIsNone(row[1])  # 回填 NULL = 无条件（R26 缺省路径）

    def test_fresh_library_only_verifies(self):
        """新库 create_all 已建列 → 0005 的 ALTER 直接跳过（不撞重复列名）。"""
        Base.metadata.create_all(bind=self.engine)
        report = run_pending_migrations(
            self.engine, do_backup=False, backups_dir=self.backups
        )
        self.assertIn("0005_sequence_steps_condition", report["applied"])
        self.assertEqual(report["integrity"], "ok")
        self.assertIn("condition", self._cols("sequence_steps"))

    def test_verify_actually_checks_the_scope_and_column(self):
        """verify 不是走过场：补列范围钉死「恰好 sequence_steps 一张」，列缺失即报错。"""
        from backend.db.migrate import _condition_verify, condition_tables

        Base.metadata.create_all(bind=self.engine)
        self.assertEqual(condition_tables(), ["sequence_steps"])
        with self.engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE sequence_steps DROP COLUMN condition")
        with self.engine.connect() as conn:
            with self.assertRaises(MigrationError) as ctx:
                _condition_verify(conn)
        self.assertIn("condition", str(ctx.exception))


class FailureRecoveryTest(_MigrateCase):
    def test_failed_apply_rolls_back_and_keeps_version(self):
        def boom(conn):
            conn.exec_driver_sql("CREATE TABLE probe (x INTEGER)")
            raise RuntimeError("DDL 中途炸了")

        registry = [Migration(1, "boom", boom, lambda c: None)]

        with self.assertRaises(MigrationError) as ctx:
            run_pending_migrations(
                self.engine,
                registry=registry,
                do_backup=False,
                backups_dir=self.backups,
            )

        message = str(ctx.exception)
        self.assertIn("0001_boom", message)
        self.assertIn("回滚", message)
        self.assertIn("v0", message)  # 版本停在 0
        self.assertNotIn("probe", self._tables())  # DDL 已回滚
        with self.engine.connect() as conn:
            self.assertEqual(
                conn.exec_driver_sql(
                    "SELECT COUNT(*) FROM schema_migrations"
                ).scalar(),
                0,
            )

    def test_failed_verify_rolls_back_applied_ddl(self):
        def apply_ok(conn):
            conn.exec_driver_sql("CREATE TABLE probe (x INTEGER)")

        def verify_bad(conn):
            raise RuntimeError("升级结果检查不通过")

        registry = [Migration(1, "halfway", apply_ok, verify_bad)]

        with self.assertRaises(MigrationError) as ctx:
            run_pending_migrations(
                self.engine,
                registry=registry,
                do_backup=False,
                backups_dir=self.backups,
            )
        self.assertIn("升级结果检查不通过", str(ctx.exception))
        self.assertNotIn("probe", self._tables())
        with self.engine.connect() as conn:
            self.assertEqual(
                conn.exec_driver_sql(
                    "SELECT COUNT(*) FROM schema_migrations"
                ).scalar(),
                0,
            )

    def test_error_message_carries_backup_path(self):
        registry = [Migration(1, "boom", self._raise, lambda c: None)]
        with self.assertRaises(MigrationError) as ctx:
            run_pending_migrations(
                self.engine,
                registry=registry,
                do_backup=True,
                backups_dir=self.backups,
            )
        backups = list(self.backups.glob("*.bak"))
        self.assertEqual(len(backups), 1)
        self.assertIn(str(backups[0]), str(ctx.exception))

    @staticmethod
    def _raise(conn):
        raise RuntimeError("boom")

    def test_backup_path_in_message_requires_do_backup(self):
        # 不备份（新库）时不误导用户去找不存在的快照
        registry = [Migration(1, "boom", self._raise, lambda c: None)]
        with self.assertRaises(MigrationError) as ctx:
            run_pending_migrations(
                self.engine, registry=registry, do_backup=False, backups_dir=self.backups
            )
        self.assertNotIn("快照", str(ctx.exception))


class BaselineCheckTest(_MigrateCase):
    def test_missing_table_caught_by_baseline_verify(self):
        Base.metadata.create_all(bind=self.engine)
        with self.engine.begin() as conn:
            conn.exec_driver_sql("DROP TABLE protocols")

        with self.assertRaises(MigrationError) as ctx:
            run_pending_migrations(
                self.engine, do_backup=False, backups_dir=self.backups
            )

        self.assertIn("缺表", str(ctx.exception))
        with self.engine.connect() as conn:
            self.assertEqual(current_version(conn), 0)  # 没通过就不记版本

    def test_missing_selfheal_column_caught_by_baseline_verify(self):
        Base.metadata.create_all(bind=self.engine)
        # 模拟「ensure_* 自愈没跑」的坏库：拿掉一条自愈列
        with self.engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE sequence_steps DROP COLUMN wrap")

        with self.assertRaises(MigrationError) as ctx:
            run_pending_migrations(
                self.engine, do_backup=False, backups_dir=self.backups
            )
        self.assertIn("缺列", str(ctx.exception))


class RegistryDisciplineTest(unittest.TestCase):
    def test_gap_rejected(self):
        with self.assertRaises(MigrationError):
            validate_registry(
                [Migration(1, "a", lambda c: None, lambda c: None),
                 Migration(3, "c", lambda c: None, lambda c: None)]
            )

    def test_duplicate_version_rejected(self):
        with self.assertRaises(MigrationError):
            validate_registry(
                [Migration(1, "a", lambda c: None, lambda c: None),
                 Migration(1, "b", lambda c: None, lambda c: None)]
            )

    def test_duplicate_name_rejected(self):
        with self.assertRaises(MigrationError):
            validate_registry(
                [Migration(1, "a", lambda c: None, lambda c: None),
                 Migration(2, "a", lambda c: None, lambda c: None)]
            )

    def test_empty_rejected(self):
        with self.assertRaises(MigrationError):
            validate_registry([])

    def test_shipped_registry_is_contiguous(self):
        validate_registry(REGISTRY)
        self.assertEqual(REGISTRY[0].version, 1)
        self.assertEqual(REGISTRY[-1].version, TARGET_VERSION)


class NewerDbTest(_MigrateCase):
    def test_newer_db_refused_before_touching_anything(self):
        """恢复了更高版本程序的备份（库版本 > 本程序目标版本）→ 一律拒绝。

        PLAN §8.33：**不做备份、不记版本、不动一列** —— 拿旧代码盖新库比失败更糟。
        """
        Base.metadata.create_all(bind=self.engine)
        with self.engine.begin() as conn:
            ensure_migrations_table(conn)
            conn.exec_driver_sql(
                "INSERT INTO schema_migrations (version, name, applied_at) "
                f"VALUES ({TARGET_VERSION + 1}, 'future', '2030-01-01T00:00:00')"
            )

        with self.assertRaises(MigrationError) as ctx:
            run_pending_migrations(
                self.engine, do_backup=True, backups_dir=self.backups
            )

        message = str(ctx.exception)
        self.assertIn("高于", message)
        self.assertIn(f"v{TARGET_VERSION + 1}", message)
        self.assertIn(f"v{TARGET_VERSION}", message)
        self.assertFalse(self.backups.exists())      # 连快照都没建：根本没打算动库
        with self.engine.connect() as conn:
            self.assertEqual(current_version(conn), TARGET_VERSION + 1)  # 版本行原样


class StatusTest(_MigrateCase):
    def test_status_reports_pending_then_applied(self):
        Base.metadata.create_all(bind=self.engine)

        before = status(self.engine)
        self.assertEqual(before["current_version"], 0)
        self.assertEqual(before["target_version"], TARGET_VERSION)
        self.assertEqual(before["pending"], _ALL_LABELS)
        self.assertEqual(before["applied"], [])
        self.assertEqual(before["integrity"], "ok")
        self.assertIn("main.db", before["db_path"])

        run_pending_migrations(self.engine, do_backup=False, backups_dir=self.backups)

        after = status(self.engine)
        self.assertEqual(after["current_version"], TARGET_VERSION)
        self.assertEqual(after["pending"], [])
        self.assertEqual(after["applied"], _ALL_LABELS)

    def test_integrity_check_failure_raises(self):
        # PRAGMA integrity_check 结果不是 ok（文件损坏/写坏）→ 必须报错而不是静默通过。
        # 用打桩把「坏结果」确定性喂进来（真把 db 写坏的话，SQLite 会在更早的
        # current_version 读阶段就抛，无法稳定落到本分支）。
        from unittest import mock

        from backend.db import migrate as migrate_mod

        Base.metadata.create_all(bind=self.engine)
        run_pending_migrations(self.engine, do_backup=False, backups_dir=self.backups)

        with mock.patch.object(migrate_mod, "_integrity", return_value="page 3 missing"):
            with self.assertRaises(MigrationError) as ctx:
                run_pending_migrations(
                    self.engine, do_backup=False, backups_dir=self.backups
                )
        self.assertIn("完整性", str(ctx.exception))
        self.assertIn("page 3 missing", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
