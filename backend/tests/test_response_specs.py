"""P2 应答规格 CRUD 单测（临时库直调路由函数，无 TestClient）。

Run from repo root: python -m unittest discover -s backend/tests
"""

import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base
from backend.db.models import ResponseSpec
from backend.routers.response_spec import (
    delete_response_spec,
    get_response_spec,
    get_response_specs,
    upsert_response_spec,
)
from backend.schemas.response_spec_api import ResponseSpecUpsert

INSTR_A = "11111111-aaaa-4bbb-8ccc-000000000001"
INSTR_B = "11111111-aaaa-4bbb-8ccc-000000000002"


class ResponseSpecTestBase(unittest.TestCase):
    def setUp(self):
        # 临时库文件：直调路由函数证明「会话外/重启后仍在」（同 test_bindings 先例）
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_specs.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()

    def tearDown(self):
        # Windows: 先关会话再 dispose 连接池，否则文件被占用无法删除（WinError 32）
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _put(self, instruction_id: str, spec: dict):
        return upsert_response_spec(
            instruction_id, ResponseSpecUpsert(spec=spec), db=self.db
        )


class ResponseSpecCrudTest(ResponseSpecTestBase):
    def test_upsert_creates_then_updates_same_row(self):
        first = self._put(INSTR_A, {"mode": "rules", "prefix": "AA55"})
        self.assertEqual(first.instruction_id, INSTR_A)
        self.assertEqual(first.spec["prefix"], "AA55")

        second = self._put(INSTR_A, {"mode": "any"})
        self.assertEqual(second.id, first.id)          # upsert 不新增行
        self.assertEqual(second.spec["mode"], "any")
        self.assertEqual(len(get_response_specs(db=self.db)), 1)

    def test_get_missing_404_and_found_returns_row(self):
        with self.assertRaises(HTTPException) as ctx:
            get_response_spec(INSTR_A, db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

        self._put(INSTR_A, {"mode": "echo"})
        row = get_response_spec(INSTR_A, db=self.db)
        self.assertEqual(row.instruction_id, INSTR_A)
        self.assertEqual(row.spec["mode"], "echo")

    def test_delete_200_then_404(self):
        self._put(INSTR_A, {"mode": "echo"})
        out = delete_response_spec(INSTR_A, db=self.db)
        self.assertEqual(out["status"], "deleted")
        self.assertEqual(out["instruction_id"], INSTR_A)
        with self.assertRaises(HTTPException) as ctx:
            delete_response_spec(INSTR_A, db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_invalid_spec_400_and_db_untouched(self):
        with self.assertRaises(HTTPException) as ctx:
            self._put(INSTR_A, {"mode": "echo", "regex": ".*"})
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("Invalid response spec", ctx.exception.detail)

        with self.assertRaises(HTTPException) as ctx:
            self._put(INSTR_A, {"mode": "carrier-pigeon"})
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(get_response_specs(db=self.db), [])

    def test_get_list_sorted_by_instruction_id(self):
        self._put(INSTR_B, {"mode": "echo"})
        self._put(INSTR_A, {"mode": "rules"})
        rows = get_response_specs(db=self.db)
        self.assertEqual([r.instruction_id for r in rows], [INSTR_A, INSTR_B])

    def test_put_normalizes_before_store(self):
        # 库里存归一化形态（SSOT = normalize_spec），不是用户原样输入
        row = self._put(INSTR_A, {"prefix": "aa 55", "ignore_ranges": [[10, 12], [4, 6]]})
        self.assertEqual(row.spec["prefix"], "AA55")
        self.assertEqual(row.spec["ignore_ranges"], [[4, 6], [10, 12]])
        stored = self.db.query(ResponseSpec).filter_by(instruction_id=INSTR_A).first()
        self.assertEqual(stored.spec["prefix"], "AA55")

    def test_persistence_survives_engine_restart(self):
        row = self._put(INSTR_A, {"mode": "rules", "suffix": "0D0A"})
        # 关引擎重开 = 重启代理
        self.db.close()
        self.engine.dispose()
        engine2 = create_engine(self.db_url, connect_args={"check_same_thread": False})
        try:
            Base.metadata.create_all(bind=engine2)  # 幂等，同 lifespan 语义
            session2 = sessionmaker(autocommit=False, autoflush=False, bind=engine2)()
            try:
                again = get_response_spec(INSTR_A, db=session2)
                self.assertEqual(again.id, row.id)
                self.assertEqual(again.spec["suffix"], "0D0A")
            finally:
                session2.close()
        finally:
            engine2.dispose()


if __name__ == "__main__":
    unittest.main()
