"""危险操作可恢复性验收（批次：针对性审视后的三处缺口修复 · PLAN §8.33）。

审视对象 = 备份恢复 / 数据库改动 / 串口·TCP 配置 / 序列停止。本文件守**修掉的缺口**：

1. **恢复旧备份后必须当场自愈** —— 老备份缺列、没有版本表；不自愈的话进程重启前
   的每次写入都可能炸。恢复端点现在跑「启动期同一套」`create_all + ensure_* +
   版本化迁移 + integrity_check`，失败时报错带上 pre-restore 快照路径（可回退）。
2. **序列运行中禁止恢复**（409 + diagnostic：Runner 还在往旧库写）。
3. **恢复出的传输配置当场生效且不清激活档案指针** —— 摘持久化钩子再交回配置
   （沿用 transport_store「先恢复、后挂钩」的启动纪律；否则 `persist_hook` 固定写
   `active_profile_id=None` 会把指针抹掉）。
4. **传输配置持久化失败不再静默** —— 配置照常生效，但事件里必须留痕
   （否则「以为存了、重启回默认」无从排查）。

（更高版本库拒绝迁移的第 5 处见 `test_migrate.NewerDbTest`。）
全部跑临时库，不碰 `backend/db/yorha.db`。
"""
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core import sequence_runner, transport
from backend.db.database import Base
from backend.db.migrate import MigrationError, current_version
from backend.db.transport_store import save_config
from backend.routers import datahub as datahub_mod
from backend.routers.datahub import RestoreRequest


def _old_backup_file(target: Path) -> None:
    """造一份「老备份」：完整 schema，但缺 `sequence_steps.wrap` 列、无版本表。"""
    engine_old = create_engine(f"sqlite:///{target.as_posix()}")
    Base.metadata.create_all(bind=engine_old)
    with engine_old.begin() as conn:
        conn.exec_driver_sql("ALTER TABLE sequence_steps DROP COLUMN wrap")
        conn.exec_driver_sql("DROP TABLE IF EXISTS schema_migrations")
    engine_old.dispose()


class _RestoreBase(unittest.TestCase):
    def setUp(self):
        transport.reset()
        self.addCleanup(transport.reset)
        sequence_runner.reset()
        self.addCleanup(sequence_runner.reset)

        self.tmp = Path(tempfile.mkdtemp(prefix="yorha-restore-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.backup_dir = self.tmp / "backups"
        self.backup_dir.mkdir()
        self.live = self.tmp / "live.db"

        # 老备份 + 里面的传输设置（含激活档案指针）
        old = self.tmp / "old.db"
        _old_backup_file(old)
        old_engine = create_engine(f"sqlite:///{old.as_posix()}")
        old_session = sessionmaker(
            autocommit=False, autoflush=False, bind=old_engine
        )()
        save_config(
            old_session,
            {"mode": "tcp", "tcp": {"host": "127.0.0.1", "port": 65001}},
            active_profile_id="prof-from-backup",
        )
        old_session.close()
        old_engine.dispose()
        shutil.copy2(old, self.backup_dir / "old-backup.db")

        # 现网库（会被替换掉的那个）
        self.live_engine = create_engine(
            f"sqlite:///{self.live.as_posix()}", connect_args={"check_same_thread": False}
        )
        self.addCleanup(self.live_engine.dispose)
        Base.metadata.create_all(bind=self.live_engine)
        self.SessionLocal = sessionmaker(
            autocommit=False, autoflush=False, bind=self.live_engine
        )

        for patch in (
            mock.patch.object(datahub_mod, "DB_PATH", self.live),
            mock.patch.object(datahub_mod, "engine", self.live_engine),
            mock.patch.object(datahub_mod, "BACKUP_DIR", self.backup_dir),
            mock.patch.object(datahub_mod, "SessionLocal", self.SessionLocal),
        ):
            patch.start()
            self.addCleanup(patch.stop)


class RestoreHealTests(_RestoreBase):
    def test_old_backup_is_healed_on_the_spot(self):
        resp = datahub_mod.restore_db(RestoreRequest(name="old-backup.db"))

        self.assertEqual(resp["restored"], "old-backup.db")
        # 恢复前安全快照落盘（回退路径）
        safety = resp["safetySnapshot"]
        self.assertTrue(safety)
        self.assertTrue((self.backup_dir / safety).is_file())

        # schema 自愈：补列 + 记基线版本 + 完整性 ok
        schema = resp["schema"]
        self.assertEqual(schema["applied"], ["0001_baseline"])
        self.assertEqual(schema["version"], 1)
        self.assertEqual(schema["integrity"], "ok")

        with self.live_engine.connect() as conn:
            cols = {
                row[1]
                for row in conn.exec_driver_sql(
                    "PRAGMA table_info(sequence_steps)"
                ).fetchall()
            }
            self.assertIn("wrap", cols)              # 缺列已补
            self.assertEqual(current_version(conn), 1)  # 版本表已建并记账

    def test_transport_config_from_backup_applies_and_keeps_profile_pointer(self):
        resp = datahub_mod.restore_db(RestoreRequest(name="old-backup.db"))

        self.assertTrue(resp["transportConfigRestored"])  # 内存配置已对齐恢复出的库
        cfg = transport.get_config()
        self.assertEqual(cfg["mode"], "tcp")
        self.assertEqual(cfg["tcp"]["port"], 65001)

        # 激活档案指针必须原样 —— 若没摘持久化钩子，set_config 的回写会把它清成 None
        with self.live_engine.connect() as conn:
            pointer = conn.exec_driver_sql(
                "SELECT active_profile_id FROM transport_settings WHERE id = 'current'"
            ).scalar()
        self.assertEqual(pointer, "prof-from-backup")

    def test_heal_failure_points_at_safety_snapshot(self):
        with mock.patch.object(
            datahub_mod, "run_pending_migrations",
            side_effect=MigrationError("库版本 v9 高于当前程序目标 v1"),
        ):
            with self.assertRaises(HTTPException) as ctx:
                datahub_mod.restore_db(RestoreRequest(name="old-backup.db"))

        self.assertEqual(ctx.exception.status_code, 500)
        detail = ctx.exception.detail
        self.assertIn("恢复后 schema 校验失败", detail)
        self.assertIn("恢复前快照", detail)
        self.assertIn("pre-restore", detail)  # 报错必须给出回退路径

    def test_restore_refused_while_sequence_running(self):
        with mock.patch.object(sequence_runner, "is_running", return_value=True):
            with self.assertRaises(HTTPException) as ctx:
                datahub_mod.restore_db(RestoreRequest(name="old-backup.db"))

        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.detail, "序列运行中，禁止恢复数据库（先停止序列）")
        self.assertEqual(ctx.exception.diagnostic["stage"], "sequence")
        self.assertIs(ctx.exception.diagnostic["data_sent"], False)

    def test_invalid_backup_name_still_400(self):
        for bad in ("../escape.db", "not-a-db.txt", "", "missing.db"):
            with self.assertRaises(HTTPException) as ctx:
                datahub_mod.restore_db(RestoreRequest(name=bad))
            self.assertEqual(ctx.exception.status_code, 400)


class TransportPersistFailureTests(unittest.TestCase):
    def setUp(self):
        transport.reset()
        self.addCleanup(transport.reset)

    def test_persist_failure_still_applies_config_but_is_recorded(self):
        def boom(_config):
            raise RuntimeError("连接池炸了")

        transport.set_persist_hook(boom)
        cfg = transport.set_config(
            {"mode": "tcp", "tcp": {"host": "127.0.0.1", "port": 65002}}
        )
        # 配置照常生效（尽力而为语义不变）
        self.assertEqual(cfg["mode"], "tcp")
        self.assertEqual(cfg["tcp"]["port"], 65002)
        # 但必须留痕：否则「以为存了、重启回默认」无人可知
        errors = [
            event
            for event in transport.get_status()["events"]
            if event["event"] == "error"
            and "持久化失败" in (event.get("detail") or "")
        ]
        self.assertTrue(errors, "配置持久化失败必须记入状态事件")
        self.assertIn("连接池炸了", errors[0]["detail"])

    def test_persist_hook_roundtrip(self):
        self.assertIsNone(transport.get_persist_hook())
        hook = lambda _config: None  # noqa: E731
        transport.set_persist_hook(hook)
        self.assertIs(transport.get_persist_hook(), hook)
        transport.set_persist_hook(None)
        self.assertIsNone(transport.get_persist_hook())


if __name__ == "__main__":
    unittest.main()
