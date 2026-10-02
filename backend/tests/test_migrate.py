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

    def test_backup_dir_gitignored(self):
        ignore = (Path(__file__).resolve().parents[2] / ".gitignore").read_text(
            encoding="utf-8"
        )
        self.assertIn("backend/db/backups/", ignore)


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
