"""P1 设备档案 + 连接持久化 tests: transport_settings 单行存取/恢复/钩子，
/profiles CRUD 与激活语义（is_active 指针 + modified 判定），临时库直调路由函数。

Run from repo root: python -m unittest discover -s backend/tests
"""

import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core import transport
from backend.db.database import Base
from backend.db.models import DeviceProfile, TransportSetting
from backend.db.transport_store import (
    load_settings,
    persist_hook,
    restore_transport_config,
    save_config,
    set_active_profile,
)
from backend.routers.profile import (
    activate_profile,
    create_profile,
    delete_profile,
    get_profiles,
    update_profile,
)
from backend.routers.transport import set_transport_config
from backend.schemas.profile_api import ProfileCreate, ProfileUpdate


def _tcp_config(host="192.168.0.9", port=502):
    """完整三段配置（validate_config 输入口径），mode=tcp。"""
    config = transport.default_config()
    config["mode"] = "tcp"
    config["tcp"].update({"host": host, "port": port})
    return config


class ProfileTestBase(unittest.TestCase):
    def setUp(self):
        transport.reset()  # 默认 loopback；reset 同时清钩子
        transport.set_persist_hook(None)  # 双保险：绝不把钩子泄漏给其他测试模块
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_profiles.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()

    def tearDown(self):
        transport.set_persist_hook(None)
        transport.reset()
        # Windows: 先关会话再 dispose 连接池，否则文件被占用无法删除（WinError 32）
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()


class TransportStoreTest(ProfileTestBase):
    def test_save_load_roundtrip_and_upsert_single_row(self):
        config = _tcp_config(host="10.0.0.7", port=7000)
        save_config(self.db, config, active_profile_id="pf-1")
        save_config(self.db, config, active_profile_id=None)  # 二次写 = upsert，不新增行

        row = load_settings(self.db)
        self.assertEqual(row.id, "current")
        self.assertEqual(row.config["mode"], "tcp")
        self.assertEqual(row.config["tcp"]["host"], "10.0.0.7")
        self.assertIsNone(row.active_profile_id)
        self.assertEqual(self.db.query(TransportSetting).count(), 1)

    def test_restore_applies_saved_config(self):
        save_config(self.db, _tcp_config(host="10.0.0.7"), active_profile_id=None)
        self.assertTrue(restore_transport_config(self.db))
        self.assertEqual(transport.get_config()["mode"], "tcp")
        self.assertEqual(transport.get_config()["tcp"]["host"], "10.0.0.7")

    def test_restore_without_row_keeps_defaults(self):
        self.assertFalse(restore_transport_config(self.db))
        self.assertEqual(transport.get_config(), transport.default_config())

    def test_restore_invalid_row_keeps_defaults(self):
        self.db.add(TransportSetting(id="current", config={"mode": "udp"}))
        self.db.commit()
        self.assertFalse(restore_transport_config(self.db))
        self.assertEqual(transport.get_config()["mode"], "loopback")

    def test_persist_hook_writes_config_and_clears_pointer(self):
        save_config(self.db, _tcp_config(), active_profile_id="pf-keep")
        transport.set_persist_hook(persist_hook(self.session_factory))
        set_transport_config({"mode": "serial", "serial": {"baudrate": 115200}})

        row = load_settings(self.db)
        self.assertEqual(row.config["mode"], "serial")
        self.assertEqual(row.config["serial"]["baudrate"], 115200)
        self.assertIsNone(row.active_profile_id)  # 手工改配置清激活指针

    def test_set_active_profile_requires_existing_row(self):
        set_active_profile(self.db, "pf-x")  # 无行 → 无操作不炸
        self.assertIsNone(load_settings(self.db))

        save_config(self.db, transport.default_config(), active_profile_id=None)
        set_active_profile(self.db, "pf-x")
        self.assertEqual(load_settings(self.db).active_profile_id, "pf-x")


class ProfileCrudTest(ProfileTestBase):
    def _create(self, label, config=None):
        return create_profile(ProfileCreate(label=label, config=config), db=self.db)

    def test_create_omitted_config_snapshots_and_activates(self):
        profile = self._create("环回快照")
        self.assertEqual(profile.config, transport.get_config())
        self.assertTrue(profile.is_active)
        self.assertFalse(profile.modified)
        self.assertEqual(load_settings(self.db).active_profile_id, profile.id)

    def test_create_with_explicit_config_normalized_and_not_active(self):
        config = _tcp_config()
        config["serial"]["parity"] = "e"  # validate_config 归一大写
        profile = self._create("产线网关", config=config)

        self.assertEqual(profile.config["serial"]["parity"], "E")
        self.assertFalse(profile.is_active)
        self.assertEqual(transport.get_config()["mode"], "loopback")  # 创建不改生效配置
        self.assertIsNone(load_settings(self.db))  # 不匹配快照不写行、不动指针

    def test_create_label_validation(self):
        for bad in ("", "   "):
            with self.subTest(label=bad), self.assertRaises(HTTPException) as ctx:
                self._create(bad)
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn("不能为空", ctx.exception.detail)

        self._create("基准")
        with self.assertRaises(HTTPException) as ctx:
            self._create("基准")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("已存在", ctx.exception.detail)

        stripped = self._create("  基准2  ")  # 存储前 strip
        self.assertEqual(stripped.label, "基准2")

    def test_create_rejects_partial_or_invalid_config(self):
        with self.assertRaises(HTTPException) as ctx:  # 缺 serial 段 → 400（非合并语义）
            self._create("半截", config={"mode": "tcp"})
        self.assertEqual(ctx.exception.status_code, 400)

        with self.assertRaises(HTTPException) as ctx:
            self._create("坏模式", config={**_tcp_config(), "mode": "udp"})
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("未知传输模式", ctx.exception.detail)

    def test_get_orders_by_label_ascending(self):
        self._create("B档")
        self._create("A档")
        rows = get_profiles(db=self.db)
        self.assertEqual([row.label for row in rows], ["A档", "B档"])

    def test_partial_update_and_label_rules(self):
        profile = self._create("原名")
        updated = update_profile(profile.id, ProfileUpdate(label="新名"), db=self.db)
        self.assertEqual(updated.label, "新名")
        self.assertEqual(updated.config, transport.get_config())  # None = 不改

        update_profile(profile.id, ProfileUpdate(label="新名"), db=self.db)  # 改回自身名允许

        other = self._create("别名")
        with self.assertRaises(HTTPException) as ctx:
            update_profile(other.id, ProfileUpdate(label="新名"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)

        with self.assertRaises(HTTPException) as ctx:
            update_profile("no-such-id", ProfileUpdate(label="x"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_update_config_of_active_profile_drives_modified(self):
        profile = self._create("快照")  # 激活中，config == 生效
        self.assertFalse(profile.modified)

        updated = update_profile(profile.id, ProfileUpdate(config=_tcp_config()), db=self.db)
        self.assertTrue(updated.is_active)
        self.assertTrue(updated.modified)
        self.assertEqual(transport.get_config()["mode"], "loopback")  # 更新只改快照不生效

        back = update_profile(
            profile.id, ProfileUpdate(config=transport.get_config()), db=self.db
        )
        self.assertFalse(back.modified)  # 写回生效值 → modified 复位

    def test_activate_applies_config_and_sets_pointer(self):
        profile = self._create("产线网关", config=_tcp_config(host="10.1.2.3"))
        self.assertFalse(profile.is_active)

        active = activate_profile(profile.id, db=self.db)
        self.assertEqual(transport.get_config()["mode"], "tcp")
        self.assertEqual(transport.get_config()["tcp"]["host"], "10.1.2.3")
        self.assertTrue(active.is_active)
        self.assertFalse(active.modified)
        self.assertEqual(load_settings(self.db).active_profile_id, profile.id)

        rows = {row.id: row for row in get_profiles(db=self.db)}
        self.assertTrue(rows[profile.id].is_active)

    def test_activate_missing_404_and_invalid_400(self):
        with self.assertRaises(HTTPException) as ctx:
            activate_profile("no-such-id", db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

        bad = DeviceProfile(id="bad-1", label="坏档案", config={"mode": "udp"})
        self.db.add(bad)
        self.db.commit()
        with self.assertRaises(HTTPException) as ctx:
            activate_profile("bad-1", db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("档案配置非法", ctx.exception.detail)
        self.assertEqual(transport.get_config()["mode"], "loopback")  # 半途不生效

    def test_delete_active_profile_clears_pointer_keeps_config(self):
        profile = self._create("快照")  # 激活中
        effective_before = transport.get_config()

        result = delete_profile(profile.id, db=self.db)
        self.assertEqual(result, {"status": "deleted", "id": profile.id})

        row = load_settings(self.db)
        self.assertIsNone(row.active_profile_id)  # 清悬空指针
        self.assertEqual(row.config, effective_before)  # 生效配置记录不动
        self.assertEqual(transport.get_config(), effective_before)  # 实际传输配置也不动
        self.assertEqual(get_profiles(db=self.db), [])

        with self.assertRaises(HTTPException) as ctx:
            delete_profile(profile.id, db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_manual_change_via_hook_deactivates_profile(self):
        profile = self._create("快照")  # 指针已落
        transport.set_persist_hook(persist_hook(self.session_factory))
        try:
            set_transport_config({"mode": "tcp", "tcp": {"host": "10.1.1.1", "port": 7000}})
        finally:
            transport.set_persist_hook(None)

        rows = get_profiles(db=self.db)
        self.assertFalse(rows[0].is_active)  # 手工改配置 → 档案失活
        row = load_settings(self.db)
        self.assertIsNone(row.active_profile_id)
        self.assertEqual(row.config["tcp"]["host"], "10.1.1.1")

    def test_profiles_and_settings_survive_engine_restart(self):
        first = self._create("A档")  # 快照激活（写行 + 指针）
        second = self._create("B档", config=_tcp_config())
        activate_profile(second.id, db=self.db)  # 生效配置 → tcp，指针 → B档
        self.db.close()

        fresh_engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=fresh_engine)  # 幂等（同 lifespan 语义）
        fresh_factory = sessionmaker(autocommit=False, autoflush=False, bind=fresh_engine)
        fresh_db = fresh_factory()
        try:
            rows = {row.label: row for row in get_profiles(db=fresh_db)}
            self.assertEqual(set(rows), {"A档", "B档"})
            self.assertEqual(rows["B档"].config["tcp"]["host"], "192.168.0.9")
            self.assertFalse(rows["A档"].is_active)
            self.assertTrue(rows["B档"].is_active)  # 指针跨重启仍在
            self.assertEqual(load_settings(fresh_db).active_profile_id, second.id)
            self.assertEqual(first.id, first.id)  # id 无损

            transport.reset()  # 重启代理：默认态起步 → 恢复落库配置
            self.assertTrue(restore_transport_config(fresh_db))
            self.assertEqual(transport.get_config()["mode"], "tcp")
        finally:
            fresh_db.close()
            fresh_engine.dispose()


if __name__ == "__main__":
    unittest.main()
