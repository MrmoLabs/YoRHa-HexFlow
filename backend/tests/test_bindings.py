import tempfile
import unittest
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base
from backend.routers.binding import (
    create_binding,
    delete_binding,
    get_bindings,
    next_slot_order,
    update_binding,
)
from backend.schemas.binding_api import BindingCreate, BindingUpdate

# E4 绑定持久化：stdlib unittest 直调路由函数（显式传 Session，不走 TestClient）。
# 临时库文件证明「会话外/重启后仍在」（验收：刷新/重启后 bindings 仍在）。


class NextSlotOrderTest(unittest.TestCase):
    """next_slot_order 纯函数向量。"""

    def test_empty_starts_at_zero(self):
        self.assertEqual(next_slot_order([]), 0)

    def test_appends_max_plus_one(self):
        self.assertEqual(next_slot_order([0, 1, 2]), 3)

    def test_gaps_follow_max_not_count(self):
        self.assertEqual(next_slot_order([0, 5]), 6)

    def test_single_nonzero(self):
        self.assertEqual(next_slot_order([7]), 8)

    def test_ignores_none_entries(self):
        self.assertEqual(next_slot_order([None, 2, None]), 3)


class BindingCrudTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_bindings.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()

    def tearDown(self):
        # Windows: 先关会话再 dispose 引擎连接池，否则文件被占用无法删除（WinError 32）
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _create(self, label, protocol_id="proto-1", instruction_id="inst-1", **kwargs):
        return create_binding(
            BindingCreate(protocol_id=protocol_id, instruction_id=instruction_id, label=label, **kwargs),
            db=self.db,
        )

    def test_create_assigns_slot_order_sequentially(self):
        first = self._create("绑定A")
        second = self._create("绑定B")
        self.assertEqual(first.slot_order, 0)
        self.assertEqual(second.slot_order, 1)

        rows = get_bindings(db=self.db)
        self.assertEqual([row.label for row in rows], ["绑定A", "绑定B"])

    def test_create_honors_client_id_and_explicit_slot_order(self):
        binding = self._create("定点", id="client-uuid-1", slot_order=9)
        self.assertEqual(binding.id, "client-uuid-1")
        self.assertEqual(binding.slot_order, 9)

        # 显式 9 之后，缺省分配应从 max+1 起（=10）
        follower = self._create("跟班")
        self.assertEqual(follower.slot_order, 10)

    def test_get_orders_by_slot_order_ascending(self):
        self._create("序5", slot_order=5)
        self._create("序1", slot_order=1)
        rows = get_bindings(db=self.db)
        self.assertEqual([row.label for row in rows], ["序1", "序5"])

    def test_partial_update_keeps_unspecified_fields(self):
        binding = self._create("原名")
        updated = update_binding(binding.id, BindingUpdate(label="改名"), db=self.db)
        self.assertEqual(updated.label, "改名")
        self.assertEqual(updated.protocol_id, "proto-1")  # None = 不改
        self.assertEqual(updated.instruction_id, "inst-1")
        self.assertEqual(updated.slot_order, 0)

        rebound = update_binding(
            binding.id,
            BindingUpdate(protocol_id="proto-9", instruction_id="inst-9"),
            db=self.db,
        )
        self.assertEqual(rebound.protocol_id, "proto-9")
        self.assertEqual(rebound.instruction_id, "inst-9")
        self.assertEqual(rebound.label, "改名")  # label 未带 → 保留

    def test_update_missing_returns_404(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            update_binding("no-such-id", BindingUpdate(label="x"), db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_delete_removes_and_second_delete_404s(self):
        from fastapi import HTTPException

        binding = self._create("待删")
        result = delete_binding(binding.id, db=self.db)
        self.assertEqual(result, {"status": "deleted", "id": binding.id})
        self.assertEqual(get_bindings(db=self.db), [])

        with self.assertRaises(HTTPException) as ctx:
            delete_binding(binding.id, db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_bindings_survive_new_session_and_engine(self):
        """关闭会话/引擎后重开（重启代理）—— 绑定仍在，字段无损。"""
        created = self._create("持久化探针", protocol_id="proto-7", instruction_id="inst-7")
        self.db.close()

        fresh_engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=fresh_engine)  # 幂等（同 lifespan 语义）
        fresh_factory = sessionmaker(autocommit=False, autoflush=False, bind=fresh_engine)
        fresh_db = fresh_factory()
        try:
            rows = get_bindings(db=fresh_db)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].id, created.id)
            self.assertEqual(rows[0].label, "持久化探针")
            self.assertEqual(rows[0].protocol_id, "proto-7")
            self.assertEqual(rows[0].instruction_id, "inst-7")
            self.assertEqual(rows[0].slot_order, 0)
        finally:
            fresh_db.close()
            fresh_engine.dispose()


if __name__ == "__main__":
    unittest.main()
