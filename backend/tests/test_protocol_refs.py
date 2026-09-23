import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base
from backend.routers.protocol import create_protocol, get_protocol, update_protocol
from backend.schemas.protocol_api import ProtocolCreate, ProtocolNodeSchema, ProtocolUpdate

# A6/A7 refs 透传 + 400 校验（悬空/非数组非字符串/自引用；锚 slot 经② 放开）：
# stdlib unittest 直调路由函数（同
# test_bindings 夹具模式，临时库证明落库）。parameter_config 走 children
# JSON 列 —— models.py 零改动（零 DDL），仅 ProtocolNodeSchema 增字段透传，
# 否则 pydantic 丢字段、刷新后 refs 失效。


def node(nid, ntype="fixed", refs=None, children=None, byte_length=1):
    """协议节点夹具：refs 给值才带 parameter_config（同 createBlock 语义）。"""
    return ProtocolNodeSchema(
        id=nid,
        label=nid,
        type=ntype,
        byte_length=byte_length,
        parameter_config=(None if refs is None else {"type": ntype, "refs": refs}),
        children=children or [],
    )


class ProtocolRefsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_protocol_refs.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()

    def tearDown(self):
        # Windows: 先关会话再 dispose 引擎连接池，否则文件被占用无法删除（WinError 32）
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _create(self, children, label="协议A"):
        return create_protocol(ProtocolCreate(label=label, children=children), db=self.db)

    def _expect_400(self, protocol_id, children):
        with self.assertRaises(HTTPException) as ctx:
            update_protocol(
                protocol_id,
                ProtocolUpdate(label="协议A", children=children),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 400)

    # ── A6: parameter_config 透传（schema 增字段，零 DDL） ────────────────

    def test_create_persists_parameter_config_refs(self):
        created = self._create([
            node("h"),
            node("len", ntype="length", refs=["h"]),
        ])
        pc = created.children[1].get("parameter_config")
        self.assertIsNotNone(pc, "ProtocolNodeSchema 未透传 parameter_config（pydantic 丢字段）")
        self.assertEqual(pc.get("refs"), ["h"])

    def test_update_persists_and_roundtrips_via_get(self):
        created = self._create([node("h")])
        update_protocol(
            created.id,
            ProtocolUpdate(
                label="协议A",
                children=[node("h"), node("len", ntype="length", refs=["h"])],
            ),
            db=self.db,
        )
        fetched = get_protocol(created.id, db=self.db)
        pc = fetched.children[1].get("parameter_config")
        self.assertIsNotNone(pc)
        self.assertEqual(pc.get("refs"), ["h"])

    def test_valid_nested_refs_allowed(self):
        created = self._create([
            node("h"),
            node("g", ntype="container", children=[node("len", ntype="length", refs=["h"])]),
        ])
        pc = created.children[1]["children"][0].get("parameter_config")
        self.assertEqual(pc.get("refs"), ["h"])

    def test_absent_and_empty_refs_pass(self):
        created = self._create([node("h"), node("len", ntype="length", refs=[])])
        self.assertEqual(created.children[1]["parameter_config"]["refs"], [])

    # ── A7: 400 校验（悬空/非数组非字符串 + 自引用；锚 slot 经② 范围修订放开） ──

    def _with_slot(self):
        return self._create([node("h"), node("s", ntype="slot")])

    def test_dangling_ref_400(self):
        p = self._with_slot()
        self._expect_400(p.id, [
            node("h"),
            node("s", ntype="slot"),
            node("len", ntype="length", refs=["ghost"]),
        ])

    def test_slot_ref_allowed(self):
        """② 范围修订：refs→slot 合法 —— 定义期值不可知（前端 Σ 不注入维持 ??），
        发送期由 blockMerge 填槽改写为注入块 id 后按真值 Σ（原锚 slot 400 放开）。"""
        updated = update_protocol(self._with_slot().id, ProtocolUpdate(label="协议A", children=[
            node("h"),
            node("s", ntype="slot"),
            node("len", ntype="length", refs=["s"]),
        ]), db=self.db)
        pc = updated.children[2].get("parameter_config")
        self.assertEqual(pc.get("refs"), ["s"])

    def test_self_ref_400(self):
        p = self._with_slot()
        self._expect_400(p.id, [
            node("h"),
            node("len", ntype="length", refs=["len"]),
        ])

    def test_non_string_ref_400(self):
        p = self._with_slot()
        self._expect_400(p.id, [
            node("h"),
            node("len", ntype="length", refs=[123]),
        ])

    def test_non_array_refs_400(self):
        p = self._with_slot()
        self._expect_400(p.id, [
            node("h"),
            node("len", ntype="length", refs="h"),
        ])

    def test_create_dangling_ref_400(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create([node("len", ntype="length", refs=["ghost"])])
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
