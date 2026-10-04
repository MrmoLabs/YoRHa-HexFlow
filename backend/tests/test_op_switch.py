"""R24（§8.52 挂账 ③）· 切算子兼容校验单测（直调路由函数 + PUT 端点，无 TestClient）。

背景：属性面板 op_code 原本只读（改算子只能删建重录），R24 放开编辑后必须同时补
「切完是否还合法」的校验 —— FE `utils/opSwitch.planOpSwitch` 在下拉侧先拦，BE
`_validate_op_switch` 在保存侧兜底（堵直连 API 绕过面板的口子）。

口径（与 FE 逐条对齐，改一必改二）：
- 只判 **op 发生变化** 的字段 —— 新增字段、未切换字段一律不判，存量数据的历史形态
  不因此被锁；
- 容器（ARRAY_GROUP/STRUCT）切成叶算子且下挂子字段 → 400（子块会变孤儿）；
- 切入 HEX_RAW 且 hex 与 byte_len 不等长 → 400（FE validateInstruction E1 同源）。

Run from repo root: python -m unittest backend.tests.test_op_switch
"""

import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base
from backend.db.models import Instruction, InstructionField
from backend.routers.instruction import (
    GROUP_OPS,
    _validate_op_switch,
    create_instruction,
    update_instruction,
)
from backend.schemas.instruction_api import (
    InstructionCreate,
    InstructionFieldSchema,
    InstructionUpdate,
)


def f(name="字段", op_code="HEX_RAW", byte_len=1, field_id=None, parent_id=None, pc=None):
    return InstructionFieldSchema(
        id=field_id, name=name, op_code=op_code, byte_len=byte_len,
        parent_id=parent_id, parameter_config=pc,
    )


class OpSwitchHelperTest(unittest.TestCase):
    """_validate_op_switch 纯函数口径（C2/G5 同范式）。"""

    def test_group_to_leaf_with_children_rejected(self):
        fields = [
            f(name="容器", op_code="INT_UNSIGNED", byte_len=1, field_id="g"),
            f(name="子块", op_code="HEX_RAW", byte_len=1, parent_id="g", pc={"hex": "00"}),
        ]
        with self.assertRaises(HTTPException) as ctx:
            _validate_op_switch({"g": "ARRAY_GROUP"}, fields)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("容器", ctx.exception.detail)
        self.assertIn("1 个子块", ctx.exception.detail)

    def test_struct_is_also_a_container(self):
        # STRUCT 没有算子模板（不进调色板），但存量/协议侧仍以字面 'STRUCT' 使用
        fields = [
            f(name="组", op_code="INT_UNSIGNED", byte_len=1, field_id="s"),
            f(name="子", op_code="INT_UNSIGNED", byte_len=2, parent_id="s"),
        ]
        self.assertIn("STRUCT", GROUP_OPS)
        with self.assertRaises(HTTPException):
            _validate_op_switch({"s": "STRUCT"}, fields)

    def test_group_to_leaf_without_children_ok(self):
        # 空容器切成叶算子是合法转换（新建语义）——不拦
        _validate_op_switch({"g": "ARRAY_GROUP"}, [f(name="组", op_code="INT_UNSIGNED", byte_len=1, field_id="g")])

    def test_leaf_to_group_ok(self):
        # 叶 → 组：payload 里本来就没有子块，允许（空组）
        _validate_op_switch({"l": "INT_UNSIGNED"}, [f(name="叶", op_code="ARRAY_GROUP", byte_len=0, field_id="l")])

    def test_switch_into_hex_raw_bad_length_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            _validate_op_switch({"h": "INT_UNSIGNED"}, [
                f(name="载荷体", op_code="HEX_RAW", byte_len=2, field_id="h", pc={"hex": "AB"}),
            ])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("载荷体", ctx.exception.detail)
        self.assertIn("4 字符", ctx.exception.detail)  # 2B → 4 字符

    def test_switch_into_hex_raw_strips_whitespace(self):
        # FE E1 的判据是 replace(/\s/g,'') —— BE 同口径（否则带空格会被误判）
        _validate_op_switch({"h": "INT_UNSIGNED"}, [
            f(name="好", op_code="HEX_RAW", byte_len=2, field_id="h", pc={"hex": "AB CD"}),
        ])

    def test_hex_length_not_checked_when_op_unchanged(self):
        # 未切换 → 不判（存量 HEX 长度怪数据不能因为本批被锁）
        _validate_op_switch({"h": "HEX_RAW"}, [
            f(name="存量", op_code="HEX_RAW", byte_len=4, field_id="h", pc={"hex": "AB"}),
        ])

    def test_new_field_not_validated(self):
        # old_ops 查不到 id = 新增字段 → 不判（与「未切换」同一豁免口径）
        _validate_op_switch({}, [
            f(name="新容器", op_code="HEX_RAW", byte_len=1, field_id="brand-new"),
            f(name="新子块", op_code="INT_UNSIGNED", byte_len=1, parent_id="brand-new"),
        ])

    def test_child_parent_check_uses_payload_children_only(self):
        # 子块计数只看本次 payload：父切成叶、但 payload 里已把子块挪走 → 放行
        fields = [
            f(name="容器", op_code="INT_UNSIGNED", byte_len=1, field_id="g"),
            f(name="已挪出", op_code="HEX_RAW", byte_len=1, field_id="kid", parent_id=None, pc={"hex": "00"}),
        ]
        _validate_op_switch({"g": "ARRAY_GROUP"}, fields)

    def test_none_and_empty_fields_pass(self):
        _validate_op_switch({}, None)
        _validate_op_switch({}, [])


class OpSwitchEndpointTest(unittest.TestCase):
    """端点接线：PUT 全量替换前拒绝 → 存量原样、无半写状态。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_switch.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _create(self, fields, code="SW-1", name="切算子试"):
        return create_instruction(
            InstructionCreate(
                device_code="DEV", code=code, name=name, type="DYNAMIC", fields=fields,
            ),
            db=self.db,
        )

    def _put(self, instr_id, fields, code="SW-1", name="切算子试"):
        return update_instruction(
            instr_id,
            InstructionUpdate(
                device_code="DEV", code=code, name=name, type="DYNAMIC", fields=fields,
            ),
            db=self.db,
        )

    def _ops(self, instr_id):
        rows = self.db.query(InstructionField).filter(InstructionField.instruction_id == instr_id).all()
        return {row.id: row.op_code for row in rows}

    def test_put_group_to_leaf_rejected_and_state_unchanged(self):
        created = self._create([
            f(name="容器", op_code="ARRAY_GROUP", byte_len=0, field_id="grp"),
            f(name="子块", op_code="HEX_RAW", byte_len=1, field_id="kid", parent_id="grp"),
        ])
        with self.assertRaises(HTTPException) as ctx:
            self._put(created.id, [
                f(name="容器", op_code="INT_UNSIGNED", byte_len=1, field_id="grp"),
                f(name="子块", op_code="HEX_RAW", byte_len=1, field_id="kid", parent_id="grp"),
            ])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("孤儿子块", ctx.exception.detail)
        # 拒绝发生在任何写入前 —— 存量原样
        self.assertEqual(self._ops(created.id), {"grp": "ARRAY_GROUP", "kid": "HEX_RAW"})

    def test_put_switch_ok_when_children_moved_out_first(self):
        created = self._create([
            f(name="容器", op_code="ARRAY_GROUP", byte_len=0, field_id="grp"),
            f(name="子块", op_code="HEX_RAW", byte_len=1, field_id="kid", parent_id="grp"),
        ])
        # 先把子块挪出容器（parent 置空），再切组 → 放行
        resp = self._put(created.id, [
            f(name="容器", op_code="INT_UNSIGNED", byte_len=1, field_id="grp"),
            f(name="子块", op_code="HEX_RAW", byte_len=1, field_id="kid", parent_id=None),
        ])
        ops = {fld.id: fld.op_code for fld in resp.fields}
        self.assertEqual(ops["grp"], "INT_UNSIGNED")
        self.assertEqual(self._ops(created.id)["grp"], "INT_UNSIGNED")

    def test_put_switch_into_hex_raw_with_bad_length_rejected(self):
        created = self._create([f(name="载荷体", op_code="INT_UNSIGNED", byte_len=2, field_id="hexf")])
        with self.assertRaises(HTTPException) as ctx:
            self._put(created.id, [
                f(name="载荷体", op_code="HEX_RAW", byte_len=2, field_id="hexf", pc={"hex": "AB"}),
            ])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(self._ops(created.id), {"hexf": "INT_UNSIGNED"})

    def test_put_unchanged_op_never_validated(self):
        # 存量 HEX 长度不符但**没换算子** → 照常写入（不锁存量）
        created = self._create([f(name="存量", op_code="HEX_RAW", byte_len=4, field_id="old", pc={"hex": "AB"})])
        resp = self._put(created.id, [f(name="存量", op_code="HEX_RAW", byte_len=4, field_id="old", pc={"hex": "AB"})])
        self.assertEqual([fld.op_code for fld in resp.fields], ["HEX_RAW"])

    def test_put_new_field_with_children_under_leaf_not_validated(self):
        # 新增字段（old_ops 查不到）不判 —— 校验只覆盖「切换」语义
        created = self._create([f(name="甲", op_code="HEX_RAW", byte_len=1, field_id="a")])
        resp = self._put(created.id, [
            f(name="甲", op_code="HEX_RAW", byte_len=1, field_id="a"),
            f(name="新叶", op_code="HEX_RAW", byte_len=1, field_id="newleaf", pc={"hex": "00"}),
            f(name="新子", op_code="HEX_RAW", byte_len=1, field_id="newkid", parent_id="newleaf",
              pc={"hex": "00"}),
        ])
        self.assertEqual(len(resp.fields), 3)


if __name__ == "__main__":
    unittest.main()
