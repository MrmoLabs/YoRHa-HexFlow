import tempfile
import unittest
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, ensure_binding_columns
from backend.db.models import Instruction, ProtocolTemplate
from backend.routers.binding import (
    create_binding,
    delete_binding,
    find_slot_node,
    get_bindings,
    next_slot_order,
    update_binding,
    validate_binding,
)
from backend.schemas.binding_api import BindingCreate, BindingUpdate

# E4 绑定持久化：stdlib unittest 直调路由函数（显式传 Session，不走 TestClient）。
# 临时库文件证明「会话外/重启后仍在」（验收：刷新/重启后 bindings 仍在）。
# 批次一 1a（D1-A 一行两用）：三新字段透传 / 设默认同事务清旧 / 部分唯一索引
# 400 兜底 / legacy 表补列自愈 / instruction_id 过滤 / 绑定期关系校验（6.1）。


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
        # 批次一: 部分唯一索引只在 ensure_binding_columns 内创建（models 无
        # __table_args__），临时库不调则默认唯一/槽唯一约束测试失效。
        ensure_binding_columns(self.engine)
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


class BatchOneBindingFieldTest(unittest.TestCase):
    """批次一 1a: slot_id / is_default / priority 三字段透传与默认清理。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_fields.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        ensure_binding_columns(self.engine)  # 部分唯一索引仅在此创建
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()

        # 带显式 slot_id 的绑定要过 6.1 绑定期校验 → 协议行 + slot 节点先铺
        slot = {
            "id": "slot-a",
            "label": "槽",
            "type": "slot",
            "byte_length": 0,
            "hex_value": None,
            "config": {},
            "children": [],
        }
        slot_x = {**slot, "id": "slot-x"}
        self.db.add(
            ProtocolTemplate(
                id="proto-1",
                label="协议1",
                children=[{**slot, "id": "slot-a"}, slot_x],
            )
        )
        self.db.add(
            ProtocolTemplate(id="proto-2", label="协议2", children=[{**slot, "id": "slot-x"}])
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _create(self, label, **kwargs):
        kwargs.setdefault("protocol_id", "proto-1")
        kwargs.setdefault("instruction_id", "inst-1")
        return create_binding(BindingCreate(label=label, **kwargs), db=self.db)

    def test_new_fields_roundtrip_with_defaults(self):
        binding = self._create("缺省行")
        self.assertIsNone(binding.slot_id)
        self.assertEqual(binding.is_default, 0)
        self.assertEqual(binding.priority, 0)

        explicit = self._create("显式槽", slot_id="slot-a", is_default=True, priority=7)
        self.assertEqual(explicit.slot_id, "slot-a")
        self.assertEqual(explicit.is_default, 1)
        self.assertEqual(explicit.priority, 7)

        rows = get_bindings(db=self.db)
        by_id = {row.id: row for row in rows}
        self.assertEqual(by_id[explicit.id].slot_id, "slot-a")
        self.assertEqual(by_id[explicit.id].is_default, 1)
        self.assertEqual(by_id[explicit.id].priority, 7)

    def test_set_default_clears_previous_default_same_instruction(self):
        first = self._create("旧默认", instruction_id="inst-1", is_default=True)
        second = self._create("新默认", instruction_id="inst-1", is_default=True)
        self.assertEqual(first.is_default, 0)  # 同事务清旧
        self.assertEqual(second.is_default, 1)

        # 不同指令的默认互不影响
        other = self._create("别指令默认", instruction_id="inst-2", is_default=True)
        self.assertEqual(other.is_default, 1)
        defaults = [row for row in get_bindings(db=self.db) if row.is_default == 1]
        self.assertEqual(sorted(row.instruction_id for row in defaults), ["inst-1", "inst-2"])

    def test_update_to_default_clears_old_and_unsetting_restores(self):
        first = self._create("A", instruction_id="inst-1", is_default=True)
        second = self._create("B", instruction_id="inst-1")

        flipped = update_binding(second.id, BindingUpdate(is_default=True), db=self.db)
        self.assertEqual(flipped.is_default, 1)
        refreshed = [row for row in get_bindings(db=self.db) if row.id == first.id][0]
        self.assertEqual(refreshed.is_default, 0)

        # 显式取消默认（False ≠ None 不改）
        unset = update_binding(second.id, BindingUpdate(is_default=False), db=self.db)
        self.assertEqual(unset.is_default, 0)

    def test_duplicate_explicit_slot_returns_400(self):
        from fastapi import HTTPException

        self._create("占坑", protocol_id="proto-1", slot_id="slot-x")
        with self.assertRaises(HTTPException) as ctx:
            self._create("撞坑", protocol_id="proto-1", slot_id="slot-x")
        self.assertEqual(ctx.exception.status_code, 400)

        # 不同协议的同名槽 id 不冲突（唯一索引是 (protocol_id, slot_id)）
        self._create("他协议", protocol_id="proto-2", slot_id="slot-x")

    def test_duplicate_default_race_returns_400(self):
        """绕过路由清理直接撞唯一索引（并发清旧失败兜底）→ IntegrityError。"""
        from sqlalchemy.exc import IntegrityError

        self._create("默认1", instruction_id="inst-1", is_default=True)
        # 直插第二行默认，模拟同事务清理未生效的并发窗口（部分唯一索引立即约束）
        with self.assertRaises(IntegrityError):
            self.db.execute(
                text(
                    "INSERT INTO protocol_bindings (id, protocol_id, instruction_id, label, "
                    "slot_order, is_default, priority) VALUES "
                    "('race', 'proto-1', 'inst-1', 'RACE', 99, 1, 0)"
                )
            )
        self.db.rollback()

    def test_get_bindings_filters_by_instruction_id(self):
        self._create("inst-1 行", instruction_id="inst-1")
        self._create("inst-2 行", instruction_id="inst-2")
        rows = get_bindings(db=self.db, instruction_id="inst-1")
        self.assertEqual([row.label for row in rows], ["inst-1 行"])
        # 不带过滤仍是全量
        self.assertEqual(len(get_bindings(db=self.db)), 2)

    def test_partial_update_keeps_new_fields_unspecified(self):
        binding = self._create("原样", slot_id="slot-a", is_default=True, priority=3)
        updated = update_binding(binding.id, BindingUpdate(label="改名"), db=self.db)
        self.assertEqual(updated.slot_id, "slot-a")  # None = 不改
        self.assertEqual(updated.is_default, 1)
        self.assertEqual(updated.priority, 3)
        self.assertEqual(updated.label, "改名")


class ValidateBindingTest(unittest.TestCase):
    """批次一 6.1 绑定期关系校验：slot 存在且为 slot 块 / accepts 白名单命中。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_validate.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        ensure_binding_columns(self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()

        protocol_children = [
            {
                "id": "root",
                "label": "根",
                "type": "container",
                "byte_length": 0,
                "hex_value": None,
                "config": {},
                "children": [
                    {
                        "id": "slot-a",
                        "label": "槽",
                        "type": "slot",
                        "byte_length": 0,
                        "hex_value": None,
                        "config": {},
                        "parameter_config": {"accepts": ["01", "02"]},
                        "children": [],
                    },
                    {
                        "id": "fixed-b",
                        "label": "定值块",
                        "type": "fixed",
                        "byte_length": 1,
                        "hex_value": "AA",
                        "config": {},
                        "children": [],
                    },
                ],
            },
        ]
        self.db.add(ProtocolTemplate(id="proto-ok", label="协议", children=protocol_children))
        self.db.add(
            Instruction(id="inst-01", device_code="01", code="C1", name="指令01")
        )
        self.db.add(
            Instruction(id="inst-99", device_code="99", code="C9", name="指令99")
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def test_slot_id_without_protocol_rejected(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            validate_binding(self.db, "", "inst-01", "slot-a")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_empty_slot_id_skipped(self):
        validate_binding(self.db, "", "inst-01", None)  # 占位期放行
        validate_binding(self.db, "", "inst-01", "")

    def test_missing_protocol_404(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            validate_binding(self.db, "proto-none", "inst-01", "slot-a")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_dangling_slot_400(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            validate_binding(self.db, "proto-ok", "inst-01", "slot-gone")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("插槽不存在", ctx.exception.detail)

    def test_non_slot_node_400(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            validate_binding(self.db, "proto-ok", "inst-01", "fixed-b")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("不是插槽", ctx.exception.detail)

    def test_accepts_whitelist_hit_and_miss(self):
        from fastapi import HTTPException

        validate_binding(self.db, "proto-ok", "inst-01", "slot-a")  # 01 ∈ 白名单
        with self.assertRaises(HTTPException) as ctx:
            validate_binding(self.db, "proto-ok", "inst-99", "slot-a")  # 99 ∉
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("插槽不接受该设备", ctx.exception.detail)

    def test_find_slot_node_recurses_and_misses(self):
        tree = [
            {"id": "a", "children": [{"id": "b", "children": [{"id": "c"}]}]},
            {"id": "d"},
        ]
        self.assertEqual(find_slot_node(tree, "c")["id"], "c")
        self.assertIsNone(find_slot_node(tree, "zz"))
        self.assertIsNone(find_slot_node(None, "a"))


class LegacyBindingSelfHealTest(unittest.TestCase):
    """既有库（三列缺 / 索引缺）启动自愈：ALTER 补列 + 存量回填 + 索引建齐。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_legacy.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})

        # 手工建「批次一之前」形状的表（仅四列）+ 一行存量数据
        with self.engine.connect() as conn:
            conn.exec_driver_sql(
                "CREATE TABLE protocol_bindings ("
                "id VARCHAR(36) PRIMARY KEY, "
                "protocol_id VARCHAR(36) NOT NULL, "
                "instruction_id VARCHAR(36) NOT NULL, "
                "label VARCHAR(128) NOT NULL, "
                "slot_order INTEGER NOT NULL)"
            )
            conn.exec_driver_sql(
                "INSERT INTO protocol_bindings VALUES ('old-1', 'p1', 'i1', '存量', 0)"
            )
            conn.commit()

    def tearDown(self):
        self.engine.dispose()
        self.tmp.cleanup()

    def test_ensure_adds_columns_backfills_and_indexes(self):
        ensure_binding_columns(self.engine)

        with self.engine.connect() as conn:
            columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(protocol_bindings)")}
            self.assertIn("slot_id", columns)
            self.assertIn("is_default", columns)
            self.assertIn("priority", columns)

            row = conn.exec_driver_sql(
                "SELECT slot_id, is_default, priority FROM protocol_bindings WHERE id='old-1'"
            ).fetchone()
            self.assertIsNone(row[0])  # NULL = 按 slot_order 稠密位次，存量行为不变
            self.assertEqual(row[1], 0)
            self.assertEqual(row[2], 0)

            indexes = {row[1] for row in conn.exec_driver_sql("PRAGMA index_list(protocol_bindings)")}
            self.assertIn("ux_bindings_default", indexes)
            self.assertIn("ux_bindings_slot", indexes)

    def test_ensure_is_idempotent(self):
        ensure_binding_columns(self.engine)
        ensure_binding_columns(self.engine)  # 二次调用 no-op 不抛
        with self.engine.connect() as conn:
            columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(protocol_bindings)")}
            self.assertEqual(
                [c for c in ("slot_id", "is_default", "priority") if c in columns],
                ["slot_id", "is_default", "priority"],
            )

    def test_ensure_noop_when_table_missing(self):
        ensure_binding_columns(self.engine)  # 表在
        with self.engine.connect() as conn:
            conn.exec_driver_sql("DROP TABLE protocol_bindings")
            conn.commit()
        ensure_binding_columns(self.engine)  # 表缺 → no-op 不抛


if __name__ == "__main__":
    unittest.main()
