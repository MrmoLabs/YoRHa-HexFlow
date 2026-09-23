import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base
from backend.routers.binding import create_binding, get_bindings
from backend.routers.protocol import create_protocol, delete_protocol, get_protocol
from backend.schemas.binding_api import BindingCreate
from backend.schemas.protocol_api import ProtocolCreate

# 批次一 P0-1：删协议级联清理 protocol_bindings（逻辑外键无 FK/ON DELETE，
# 不清则编排页 protocols.find 落空 + DB 残留脏行）。夹具模式同
# test_protocol_refs：stdlib unittest 直调路由函数 + 临时库证明落库。


class DeleteProtocolCascadeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_protocol_delete.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()

    def tearDown(self):
        # Windows: 先关会话再 dispose 引擎连接池，否则文件被占用无法删除（WinError 32）
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _proto(self, label="协议A"):
        return create_protocol(ProtocolCreate(label=label, children=[]), db=self.db)

    def test_delete_without_bindings_returns_zero(self):
        proto = self._proto()
        result = delete_protocol(proto.id, db=self.db)
        self.assertEqual(
            result,
            {"status": "deleted", "id": proto.id, "deleted_bindings": 0},
        )
        with self.assertRaises(HTTPException) as ctx:
            get_protocol(proto.id, db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_delete_cascades_bindings_of_that_protocol_only(self):
        proto = self._proto()
        other = self._proto(label="协议B")
        keep = create_binding(
            BindingCreate(protocol_id=other.id, instruction_id="i-keep", label="保留"),
            db=self.db,
        )
        create_binding(
            BindingCreate(protocol_id=proto.id, instruction_id="i-1", label="绑定1"),
            db=self.db,
        )
        create_binding(
            BindingCreate(protocol_id=proto.id, instruction_id="i-2", label="绑定2"),
            db=self.db,
        )

        result = delete_protocol(proto.id, db=self.db)

        self.assertEqual(result["deleted_bindings"], 2)
        # 其他协议的绑定不受影响；被删协议的绑定不再在库
        remaining = get_bindings(db=self.db)
        self.assertEqual([b.id for b in remaining], [keep.id])
        self.assertTrue(all(b.protocol_id != proto.id for b in remaining))

    def test_delete_missing_protocol_404(self):
        with self.assertRaises(HTTPException) as ctx:
            delete_protocol("ghost-id", db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
