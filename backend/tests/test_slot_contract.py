"""批次二 (D3/D14① + D12 §6.2 槽节点行): 插槽契约保存期校验 + 删槽悬空收口。

直调路由函数（临时库显式 Session，无 TestClient）—— 对齐 test_protocol_refs /
test_wrap_api 范式。覆盖：
  - 保存期 `fit_policy` 结构/取值 400（读侧 fail-open 会把 reject 静默成
    append —— 正是 D14① 要消灭的「静默」，故在入库前拦）；
  - `POST /compile/wrapped` 对 reject 的 HTTP 400 映射 + 缺省口径 warning 不阻断；
  - 协议内删块 → 绑定 slot_id 悬空 → 置 NULL 并回执 dangling_slots_cleared（§6.2）。
存量零回归：无 parameter_config / 无 fit_policy 的槽走缺省 append/zero_fill。
"""

import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base
from backend.db.models import ProtocolBinding, ProtocolTemplate
from backend.routers.compile import compile_wrapped_frame
from backend.routers.protocol import create_protocol, update_protocol
from backend.schemas.block import WrappedCompileRequest
from backend.schemas.protocol_api import ProtocolCreate, ProtocolUpdate


def fixed(nid, hex_value, byte_length=None):
    return {
        "id": nid,
        "label": nid,
        "type": "fixed",
        "byte_length": byte_length if byte_length is not None else len(hex_value.replace(" ", "")) // 2,
        "hex_value": hex_value,
        "config": {},
        "children": [],
    }


def slot(nid, parameter_config=None):
    node = {
        "id": nid,
        "label": nid,
        "type": "slot",
        "byte_length": 1,
        "hex_value": None,
        "config": {},
        "children": [],
    }
    if parameter_config is not None:
        node["parameter_config"] = parameter_config
    return node


class SlotContractTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp.name) / "test_slot_contract.db"
        self.engine = create_engine(
            f"sqlite:///{db_path.as_posix()}", connect_args={"check_same_thread": False}
        )
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(
            autocommit=False, autoflush=False, bind=self.engine
        )
        self.db = self.session_factory()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()


class FitPolicySaveValidationTest(SlotContractTestBase):
    def _create(self, children):
        return create_protocol(
            ProtocolCreate(label="协议", children=children), db=self.db
        )

    def test_valid_fit_policy_accepted_and_persisted(self):
        proto = self._create([
            slot("s", {"fit_policy": {"overflow": "reject", "underflow": "reject"}})
        ])
        stored = (
            self.db.query(ProtocolTemplate).filter(ProtocolTemplate.id == proto.id).first()
        )
        self.assertEqual(
            stored.children[0]["parameter_config"]["fit_policy"],
            {"overflow": "reject", "underflow": "reject"},
        )

    def test_partial_fit_policy_accepted(self):
        proto = self._create([slot("s", {"fit_policy": {"underflow": "reject"}})])
        stored = (
            self.db.query(ProtocolTemplate).filter(ProtocolTemplate.id == proto.id).first()
        )
        self.assertEqual(
            stored.children[0]["parameter_config"]["fit_policy"], {"underflow": "reject"}
        )

    def test_missing_parameter_config_accepted(self):
        # 存量零回归：槽无 parameter_config → 缺省口径，保存照常
        proto = self._create([slot("s")])
        self.assertTrue(proto.id)

    def test_bad_overflow_value_400(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create([slot("s", {"fit_policy": {"overflow": "truncate"}})])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("overflow", ctx.exception.detail)
        self.assertIn("truncate", ctx.exception.detail)

    def test_bad_underflow_value_400(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create([slot("s", {"fit_policy": {"underflow": "append"}})])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("underflow", ctx.exception.detail)

    def test_unknown_key_400(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create([slot("s", {"fit_policy": {"overflow": "reject", "pad": True}})])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("pad", ctx.exception.detail)

    def test_not_an_object_400(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create([slot("s", {"fit_policy": "reject"})])
        self.assertEqual(ctx.exception.status_code, 400)

    def test_update_also_validates(self):
        proto = self._create([slot("s")])
        with self.assertRaises(HTTPException) as ctx:
            update_protocol(
                proto.id,
                ProtocolUpdate(label="改", children=[slot("s", {"fit_policy": {"overflow": "bad"}})]),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_create_returns_zero_dangling_slots_cleared(self):
        proto = self._create([slot("s")])
        self.assertEqual(getattr(proto, "dangling_slots_cleared", None), 0)


class DanglingSlotCleanupTest(SlotContractTestBase):
    def _proto(self, children):
        return create_protocol(ProtocolCreate(label="协议", children=children), db=self.db)

    def test_removing_slot_nulls_binding_slot_id_and_reports_count(self):
        proto = self._proto([slot("s1"), slot("s2")])
        self.db.add(
            ProtocolBinding(id="b-gone", protocol_id=proto.id, instruction_id="i-1",
                             label="指向被删槽", slot_id="s1")
        )
        self.db.add(
            ProtocolBinding(id="b-keep", protocol_id=proto.id, instruction_id="i-2",
                             label="指向保留槽", slot_id="s2")
        )
        self.db.add(
            ProtocolBinding(id="b-null", protocol_id=proto.id, instruction_id="i-3",
                             label="无显式槽")
        )
        self.db.commit()

        result = update_protocol(
            proto.id,
            ProtocolUpdate(label="协议", children=[slot("s2")]),
            db=self.db,
        )

        self.assertEqual(result.dangling_slots_cleared, 1)
        rows = {b.id: b.slot_id for b in self.db.query(ProtocolBinding).all()}
        self.assertIsNone(rows["b-gone"])
        self.assertEqual(rows["b-keep"], "s2")
        self.assertIsNone(rows["b-null"])

    def test_update_without_slots_keeps_cleared_at_zero(self):
        proto = self._proto([slot("s1")])
        result = update_protocol(
            proto.id, ProtocolUpdate(label="协议", children=[slot("s1")]), db=self.db
        )
        self.assertEqual(result.dangling_slots_cleared, 0)


class CompileFitPolicyHttpTest(SlotContractTestBase):
    """reject → HTTP 400（§3「HTTP 400 detail / 预览 red banner」）；缺省 → warning。"""

    def _proto(self, children):
        return create_protocol(ProtocolCreate(label="协议", children=children), db=self.db)

    def test_overflow_reject_maps_to_400(self):
        proto = self._proto([
            slot("s", {"fit_policy": {"overflow": "reject", "underflow": "zero_fill"}})
        ])
        with self.assertRaises(HTTPException) as ctx:
            compile_wrapped_frame(
                WrappedCompileRequest(protocol_id=proto.id, payloads=["0102", "0304"]),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("洞位不足", ctx.exception.detail)
        self.assertIn("reject", ctx.exception.detail)

    def test_underflow_reject_detail_has_slot_and_bytes(self):
        proto = self._proto([
            slot("s", {"fit_policy": {"overflow": "append", "underflow": "reject"}})
        ])
        with self.assertRaises(HTTPException) as ctx:
            compile_wrapped_frame(
                WrappedCompileRequest(protocol_id=proto.id, payloads=[]), db=self.db
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("欠载", ctx.exception.detail)
        self.assertIn("s", ctx.exception.detail)
        self.assertIn("1 字节", ctx.exception.detail)  # 槽声明字节数

    def test_max_bytes_reject_detail_has_actual_and_allowed(self):
        proto = self._proto([
            slot("s", {"fit_policy": {"overflow": "reject"}, "max_bytes": 1})
        ])
        with self.assertRaises(HTTPException) as ctx:
            compile_wrapped_frame(
                WrappedCompileRequest(protocol_id=proto.id, payloads=["0102"]), db=self.db
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("2 字节", ctx.exception.detail)
        self.assertIn("1 字节", ctx.exception.detail)

    def test_default_policy_warns_without_blocking(self):
        # 存量缺省（无 fit_policy）→ append/zero_fill：不阻断，只 warning
        proto = self._proto([slot("s")])
        result = compile_wrapped_frame(
            WrappedCompileRequest(protocol_id=proto.id, payloads=["0102", "0304"]),
            db=self.db,
        )
        self.assertEqual(result.total_length, 4)
        self.assertTrue(any("洞位不足" in w for w in result.warnings))

    def test_max_bytes_without_reject_only_warns(self):
        proto = self._proto([slot("s", {"max_bytes": 1})])
        result = compile_wrapped_frame(
            WrappedCompileRequest(protocol_id=proto.id, payloads=["0102"]), db=self.db
        )
        self.assertTrue(any("溢出" in w for w in result.warnings))


if __name__ == "__main__":
    unittest.main()
