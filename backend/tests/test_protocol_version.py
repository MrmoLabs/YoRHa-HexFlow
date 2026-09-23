import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, ensure_protocol_version_column
from backend.routers.protocol import create_protocol, get_protocol, update_protocol
from backend.schemas.protocol_api import ProtocolCreate, ProtocolNodeSchema, ProtocolUpdate

# 批次五: version 乐观并发（直调路由，夹具镜像 test_protocol_refs 的临时库模式）：
#   - PUT 带 version → 与当前行比对，陈旧 409（先于 refs 400）、每次成功写 +1；
#   - PUT 缺 version（旧客户端/curl 直调）→ 跳过比对直接覆盖，仍 +1；
#   - ensure_protocol_version_column → 既有库缺列启动自愈 + 存量行回填 1 +
#     幂等（create_all 不给既有表补列，本仓无迁移框架）。


def node(nid, ntype="fixed", byte_length=1):
    return ProtocolNodeSchema(id=nid, label=nid, type=ntype, byte_length=byte_length)


class _ProtocolDbCase(unittest.TestCase):
    """共享临时库夹具（文件库 + 关会话后 dispose，Windows 可删，同 refs 测试）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_protocol_version.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()


class ProtocolVersionTest(_ProtocolDbCase):
    def _create(self):
        return create_protocol(ProtocolCreate(label="协议A", children=[node("h")]), db=self.db)

    def _put(self, protocol_id, version, label="协议B"):
        return update_protocol(
            protocol_id,
            ProtocolUpdate(label=label, children=[node("h")], version=version),
            db=self.db,
        )

    # ── 比对与递增 ────────────────────────────────────────────────────────

    def test_create_starts_at_version_1(self):
        self.assertEqual(self._create().version, 1)

    def test_matching_version_bumps_to_2_and_roundtrips(self):
        saved = self._put(self._create().id, version=1)
        self.assertEqual(saved.version, 2)
        # GET 回读供客户端下一次 PUT 携带（ProtocolResponse 透出 version）
        self.assertEqual(get_protocol(saved.id, db=self.db).version, 2)

    def test_stale_version_409_and_row_untouched(self):
        p = self._create()
        self._put(p.id, version=1)  # 1 → 2
        with self.assertRaises(HTTPException) as ctx:
            self._put(p.id, version=1, label="陈旧覆盖")  # 仍是 1 → 409
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("conflict", ctx.exception.detail)
        # 冲突负载未落库：行保持上一次成功写的状态
        row = get_protocol(p.id, db=self.db)
        self.assertEqual(row.version, 2)
        self.assertEqual(row.label, "协议B")

    def test_stale_version_409_precedes_refs_validation(self):
        """陈旧前置条件先拒：版本不符 + 内容带悬空 refs → 409 而非 400。"""
        p = self._create()
        self._put(p.id, version=1)  # 1 → 2
        dangling = ProtocolNodeSchema(
            id="len",
            label="len",
            type="length",
            byte_length=1,
            parameter_config={"type": "length", "refs": ["ghost"]},
        )
        stale = ProtocolUpdate(label="陈旧", children=[dangling], version=1)
        with self.assertRaises(HTTPException) as ctx:
            update_protocol(p.id, stale, db=self.db)
        self.assertEqual(ctx.exception.status_code, 409)

    def test_missing_version_skips_check_and_still_bumps(self):
        """旧客户端/curl 直调不带 version → 直通覆盖；仍 +1 防止他人误判一致。"""
        p = self._create()
        saved = update_protocol(
            p.id, ProtocolUpdate(label="协议C", children=[node("h")]), db=self.db
        )
        self.assertEqual(saved.version, 2)

    def test_sequential_puts_follow_the_chain(self):
        p = self._create()
        v2 = self._put(p.id, version=1).version
        v3 = self._put(p.id, version=v2).version
        self.assertEqual((v2, v3), (2, 3))
        # 第三发仍持 1 → 409
        with self.assertRaises(HTTPException) as ctx:
            self._put(p.id, version=1)
        self.assertEqual(ctx.exception.status_code, 409)


class EnsureVersionColumnTest(unittest.TestCase):
    """既有库缺列自愈：手工建无 version 的旧表 → ALTER 补列 + 回填 + 幂等。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'legacy.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})

    def tearDown(self):
        self.engine.dispose()
        self.tmp.cleanup()

    def _make_legacy_table(self, with_row=True):
        with self.engine.begin() as conn:
            conn.exec_driver_sql(
                "CREATE TABLE protocols ("
                "id VARCHAR(36) PRIMARY KEY, label VARCHAR(128) NOT NULL, "
                "type VARCHAR(32), description TEXT, children JSON)"
            )
            if with_row:
                conn.exec_driver_sql(
                    "INSERT INTO protocols (id, label, type, children) "
                    "VALUES ('p1', '旧协议', 'container', '[]')"
                )

    def _columns(self):
        with self.engine.connect() as conn:
            return {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(protocols)")}

    def test_adds_missing_column_and_backfills_one(self):
        self._make_legacy_table()
        ensure_protocol_version_column(self.engine)
        self.assertIn("version", self._columns())
        with self.engine.connect() as conn:
            value = conn.exec_driver_sql("SELECT version FROM protocols WHERE id='p1'").scalar()
        self.assertEqual(value, 1)

    def test_idempotent_when_column_already_exists(self):
        self._make_legacy_table()
        ensure_protocol_version_column(self.engine)
        ensure_protocol_version_column(self.engine)  # 二次调用 no-op 不抛
        self.assertEqual(sum(1 for c in self._columns() if c == "version"), 1)

    def test_fresh_schema_is_noop(self):
        Base.metadata.create_all(bind=self.engine)  # models 已带列
        ensure_protocol_version_column(self.engine)  # → no-op 不抛
        self.assertIn("version", self._columns())

    def test_table_absent_is_noop(self):
        # 表都还没有（调用先于 create_all 的防御分支）→ 不抛，交给 create_all 建全
        ensure_protocol_version_column(self.engine)


if __name__ == "__main__":
    unittest.main()
