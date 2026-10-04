"""G5 收口 · BE 保存侧 op_code 白名单单测（拍板：双端硬拦 · 直调路由函数，无 TestClient）。

背景：未知 op 在 fields_to_blocks 静默降级 fixed → 编码错码（G5 危害）。N1 只上
了 FE W5 提醒；本次拍板（2026-09-30）保存侧 400 拒绝 + FE W5 升 error，双端同
口径硬拦。存量摸底（只读）：instruction_fields 31 行 9 种 op 全在 KNOWN_OPS 内
→ 取全集硬拦不锁任何历史数据。

KNOWN_OPS 双端同源：FE constants.js OP_CODES 17 项（含 N2 的 STRING、R23 的
TIME_EPOCH、R25 的 SCRAMBLE）+ encoder legacy 5 项（INPUT/FIXED/HEADER/TAIL/
CALCULATED）= 22 项 —— 改一必改二。

Run from repo root: python -m unittest discover -s backend/tests
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
    KNOWN_OPS,
    _validate_op_codes,
    create_instruction,
    update_instruction,
)
from backend.schemas.instruction_api import (
    InstructionCreate,
    InstructionFieldSchema,
    InstructionUpdate,
)

# 双端同源全集（FE validateInstruction KNOWN_OPS 逐行同步，R25 起含 SCRAMBLE）：
KNOWN_22 = [
    "HEX_RAW", "INT_UNSIGNED", "INT_SIGNED", "FLOAT_IEEE", "SCALED_DECIMAL",
    "BCD_CODE", "BITFIELD", "MAPPING", "ARRAY_GROUP", "STRUCT",
    "LENGTH_CALC", "CHECKSUM_CRC", "TIME_ACCUMULATOR", "AUTO_COUNTER",
    "TIME_EPOCH", "STRING", "SCRAMBLE",
    "INPUT", "FIXED", "HEADER", "TAIL", "CALCULATED",
]


def field(name="字段", op_code="HEX_RAW", byte_len=1, pc=None):
    # R25: SCRAMBLE 走 _validate_scrambles（生效模式的参数必须在场）→ 参与「全集过门」
    # 的那条要带合法种子；其余算子维持原样（不传 parameter_config，走默认 None）。
    kwargs = dict(name=name, op_code=op_code, byte_len=byte_len)
    if pc is not None:
        kwargs["parameter_config"] = pc
    return InstructionFieldSchema(**kwargs)


def known_field(i, op):
    return field(name=f"字段{i}", op_code=op,
                 pc=({"seed": "A5"} if op == "SCRAMBLE" else None))


class OpWhitelistHelperTest(unittest.TestCase):
    """_validate_op_codes 纯函数口径（C2 _validate_bitfields 同范式）。"""

    def test_known_ops_pass(self):
        # 全集 22 项逐个过门（含 legacy 5 —— encoder 各分支仍认识、存量可能携带）
        for op in KNOWN_22:
            _validate_op_codes([field(name=f"f_{op}", op_code=op)])

    def test_known_ops_set_is_exactly_22(self):
        # 防双端漂移：BE 集合与共享清单逐元素相等（FE 改 OP_CODES 时此处先红）
        self.assertEqual(set(KNOWN_OPS), set(KNOWN_22))

    def test_unknown_op_rejected_400_with_field_and_op_in_detail(self):
        with self.assertRaises(HTTPException) as ctx:
            _validate_op_codes([field(name="载荷体", op_code="WEIRD_OP")])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("载荷体", ctx.exception.detail)
        self.assertIn("WEIRD_OP", ctx.exception.detail)

    def test_case_sensitive_rejects_lowercase(self):
        # FE KNOWN_OPS.has(String(op)) 大小写敏感（小写 op 在 FE 编码落错路径）→ BE 同口径拦
        with self.assertRaises(HTTPException) as ctx:
            _validate_op_codes([field(op_code="hex_raw")])
        self.assertEqual(ctx.exception.status_code, 400)

    def test_empty_op_skipped_fail_open(self):
        # FE 门为 `f.op_code && …` → 空串不算未知（fail-open 同口径，不拦）
        _validate_op_codes([field(op_code="")])

    def test_none_op_skipped_fail_open(self):
        # op_code=None 走不到 HTTP 层（pydantic str 必填 → 422），此处钉函数级防御门
        stub = InstructionFieldSchema.model_construct(name="无op", op_code=None, byte_len=1)
        _validate_op_codes([stub])

    def test_none_and_empty_fields_pass(self):
        _validate_op_codes(None)
        _validate_op_codes([])

    def test_mixed_list_rejects_first_unknown(self):
        with self.assertRaises(HTTPException) as ctx:
            _validate_op_codes([
                field(name="好字段", op_code="HEX_RAW"),
                field(name="坏字段", op_code="NOPE"),
            ])
        self.assertIn("坏字段", ctx.exception.detail)
        self.assertNotIn("好字段", ctx.exception.detail)


class OpWhitelistEndpointTest(unittest.TestCase):
    """端点接线：POST / PUT 保存前拒绝（C2 _validate_bitfields 同位先例）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = f"sqlite:///{(Path(self.tmp.name) / 'test_ops.db').as_posix()}"
        self.engine = create_engine(self.db_url, connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _create(self, fields, code="OP-1", name="白名单试"):
        return create_instruction(
            InstructionCreate(
                device_code="DEV", code=code, name=name, type="DYNAMIC", fields=fields,
            ),
            db=self.db,
        )

    def _put(self, instr_id, fields, code, name):
        return update_instruction(
            instr_id,
            InstructionUpdate(
                device_code="DEV", code=code, name=name, type="DYNAMIC", fields=fields,
            ),
            db=self.db,
        )

    def test_post_rejects_unknown_op_before_any_write(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create([field(op_code="WEIRD_OP")])
        self.assertEqual(ctx.exception.status_code, 400)
        # 拒绝发生在任何写入前：指令行与字段行都没有
        self.assertEqual(self.db.query(Instruction).count(), 0)
        self.assertEqual(self.db.query(InstructionField).count(), 0)

    def test_post_accepts_all_known_ops(self):
        resp = self._create([known_field(i, op) for i, op in enumerate(KNOWN_22)])
        self.assertEqual(len(resp.fields), 22)

    def test_put_rejects_unknown_op_and_keeps_existing(self):
        created = self._create([field(name="原字段", op_code="HEX_RAW")])
        with self.assertRaises(HTTPException) as ctx:
            # 全量替换语义：若校验不在 DELETE 前，存量字段会被清掉 —— 此处必须原样
            self._put(created.id, [field(name="原字段", op_code="BOGUS_OP")],
                      code=created.code, name="改名后")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("BOGUS_OP", ctx.exception.detail)
        kept = self.db.query(InstructionField).filter_by(instruction_id=created.id).all()
        self.assertEqual([f.op_code for f in kept], ["HEX_RAW"])
        # 元数据写入同样未发生（校验位于任何字段变更之前）
        inst_row = self.db.query(Instruction).filter_by(id=created.id).first()
        self.assertEqual(inst_row.name, "白名单试")

    def test_put_accepts_full_replace_with_known_ops(self):
        created = self._create([field(name="原字段", op_code="HEX_RAW")])
        resp = self._put(created.id,
                         [known_field(i, op) for i, op in enumerate(KNOWN_22)],
                         code=created.code, name=created.name)
        self.assertEqual(len(resp.fields), 22)
        self.assertEqual(
            sorted(f.op_code for f in resp.fields), sorted(KNOWN_22),
        )


if __name__ == "__main__":
    unittest.main()
