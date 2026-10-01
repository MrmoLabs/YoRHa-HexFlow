"""CP3 3a: /recipes CRUD + definition_hash 回写/失效 + 补列自愈 + 串行编译入口。

临时库直调路由函数（无 TestClient）—— 对齐 test_bindings / test_sequence_api 范式。
覆盖（DESIGN_CorePipeline §9.7 · 3a 验收列）：
- CRUD：创建/列表/详情/更新/删除 + `?instruction_id=` 降级链过滤；
- `definition_hash` **保存期回写**（服务端按该层协议 children 算，客户端传入忽略）；
- **编译期比对失效**（改协议 → 编译出「配方已失效」warning + stage.stale，不阻断）；
- 层数上限（>4 → 400）、stage 协议 404、槽存在性/重复 400、空 stages 400；
- version 乐观并发 409（镜像 protocols.version）；删除时清指令引用回执；
- `instructions.default_recipe_id` 补列自愈（幂等 / 新库 no-op / 表缺 no-op）。

三层帧主向量单一真相源 = vectors/wrap.json · 表 three（改一必改三）。
"""
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core.definition_hash import protocol_definition_hash
from backend.db.database import Base, ensure_recipe_columns
from backend.db.models import FrameRecipe, Instruction, ProtocolTemplate
from backend.routers.compile import compile_wrapped_frame
from backend.routers.recipe import (
    create_recipe,
    delete_recipe,
    get_recipe,
    get_recipes,
    update_recipe,
)
from backend.schemas.block import WrappedCompileRequest
from backend.schemas.recipe_api import (
    MAX_RECIPE_STAGES,
    RecipeCreate,
    RecipeStage,
    RecipeUpdate,
)
from vectors.load_vectors import load_vectors

THREE = load_vectors("wrap", "three")
LAYER_IDS = [layer["protocol_id"] for layer in THREE["layers"]]
MANUAL_ID = THREE["manual"]["protocol_id"]


def _stages(slot=True):
    """三层配方 stages（槽显式指名，镜像编辑器产出形态）。"""
    return [
        RecipeStage(
            protocol_id=layer["protocol_id"],
            slot_ids=[layer["slot_id"]] if slot else None,
        )
        for layer in THREE["layers"]
    ]


class RecipeTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp.name) / "test_recipes.db"
        self.engine = create_engine(
            f"sqlite:///{db_path.as_posix()}", connect_args={"check_same_thread": False}
        )
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(
            autocommit=False, autoflush=False, bind=self.engine
        )
        self.db = self.session_factory()
        for layer in THREE["layers"]:
            self.db.add(ProtocolTemplate(
                id=layer["protocol_id"], label=layer["label"],
                type="container", children=layer["children"],
            ))
        self.db.add(ProtocolTemplate(
            id=MANUAL_ID, label=THREE["manual"]["label"],
            type="container", children=THREE["manual"]["children"],
        ))
        self.db.add(Instruction(
            id="inst-recipe", device_code="D01", code="0x10", name="开门指令",
        ))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def create(self, **kwargs):
        payload = RecipeCreate(
            name=kwargs.get("name", "三层配方"),
            description=kwargs.get("description", "应用壳 → 中继壳 → 链路壳"),
            stages=kwargs.get("stages", _stages()),
            instruction_id=kwargs.get("instruction_id"),
            id=kwargs.get("id"),
        )
        return create_recipe(payload, self.db)


class RecipeCrudTests(RecipeTestBase):
    """CRUD + 保存期校验 + definition_hash 回写。"""

    def test_create_writes_stages_and_definition_hash(self):
        recipe = self.create()
        self.assertEqual([s.protocol_id for s in recipe.stages], LAYER_IDS)
        # hash 由服务端按该层协议 children 算并回写（非用户输入）
        for stage, layer in zip(recipe.stages, THREE["layers"]):
            self.assertEqual(
                stage.definition_hash, protocol_definition_hash(layer["children"])
            )
        self.assertTrue(stage.definition_hash.startswith("sha256:"))
        self.assertEqual(recipe.version, 1)
        self.assertEqual(recipe.instruction_id, None)
        self.assertIsNotNone(recipe.created_at)

    def test_create_strips_client_supplied_hash(self):
        # 客户端传入的 definition_hash 一律忽略，以服务端算的为准
        payload = RecipeCreate(
            name="伪造指纹",
            stages=[
                RecipeStage(protocol_id=LAYER_IDS[0], slot_ids=["s0"],
                            definition_hash="sha256:deadbeef"),
            ],
        )
        recipe = create_recipe(payload, self.db)
        self.assertNotEqual(recipe.stages[0].definition_hash, "sha256:deadbeef")
        self.assertEqual(
            recipe.stages[0].definition_hash,
            protocol_definition_hash(THREE["layers"][0]["children"]),
        )

    def test_list_get_roundtrip(self):
        created = self.create()
        rows = get_recipes(self.db)
        self.assertEqual([r.id for r in rows], [created.id])
        fetched = get_recipe(created.id, self.db)
        self.assertEqual(fetched.name, created.name)
        self.assertEqual(
            [s.protocol_id for s in fetched.stages], LAYER_IDS
        )

    def test_get_missing_404(self):
        with self.assertRaises(HTTPException) as ctx:
            get_recipe("nope", self.db)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.detail, "Recipe not found")

    def test_filter_by_instruction_id(self):
        recipe = self.create(instruction_id="inst-recipe")
        rows = get_recipes(self.db, instruction_id="inst-recipe")
        self.assertEqual([r.id for r in rows], [recipe.id])
        self.assertEqual(rows[0].instruction_id, "inst-recipe")
        # 未关联的指令 → 空数组（降级链的「无配方」级），不是 404
        self.assertEqual(get_recipes(self.db, instruction_id="ghost"), [])

    def test_filter_unlinked_instruction_returns_empty(self):
        self.create()  # 配方存在但没挂指令
        self.assertEqual(get_recipes(self.db, instruction_id="inst-recipe"), [])

    def test_relink_replaces_previous_default(self):
        first = self.create(instruction_id="inst-recipe")
        second = self.create(name="后继配方", instruction_id="inst-recipe")
        rows = get_recipes(self.db, instruction_id="inst-recipe")
        self.assertEqual([r.id for r in rows], [second.id])
        # 单列天然唯一：旧配方行还在，只是不再被指令引用
        self.assertIsNotNone(get_recipe(first.id, self.db))
        self.assertIsNone(get_recipe(first.id, self.db).instruction_id)

    def test_update_bumps_version_and_rewrites_hash(self):
        recipe = self.create()
        # 协议结构变了（指纹随之变）→ 保存期重新回写 = 失效的消解点
        protocol = self.db.get(ProtocolTemplate, LAYER_IDS[0])
        protocol.children = list(protocol.children) + [{
            "id": "extra", "label": "extra", "type": "fixed",
            "byte_length": 1, "hex_value": "FF", "config": {}, "children": [],
        }]
        self.db.commit()

        updated = update_recipe(
            recipe.id,
            RecipeUpdate(name="改名后", stages=_stages(), version=1),
            self.db,
        )
        self.assertEqual(updated.name, "改名后")
        self.assertEqual(updated.version, 2)
        self.assertNotEqual(
            updated.stages[0].definition_hash, recipe.stages[0].definition_hash
        )
        self.assertEqual(
            updated.stages[0].definition_hash,
            protocol_definition_hash(protocol.children),
        )

    def test_update_stale_version_409(self):
        recipe = self.create()
        update_recipe(recipe.id, RecipeUpdate(name="v2"), self.db)  # → version 2
        with self.assertRaises(HTTPException) as ctx:
            update_recipe(recipe.id, RecipeUpdate(name="陈旧写", version=1), self.db)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("Recipe version conflict", ctx.exception.detail)

    def test_update_unlink_instruction(self):
        recipe = self.create(instruction_id="inst-recipe")
        updated = update_recipe(
            recipe.id, RecipeUpdate(instruction_id=""), self.db
        )
        self.assertIsNone(updated.instruction_id)
        self.assertEqual(get_recipes(self.db, instruction_id="inst-recipe"), [])

    def test_update_missing_404(self):
        with self.assertRaises(HTTPException) as ctx:
            update_recipe("nope", RecipeUpdate(name="x"), self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_delete_clears_instruction_reference(self):
        recipe = self.create(instruction_id="inst-recipe")
        result = delete_recipe(recipe.id, self.db)
        self.assertEqual(result["cleared_instructions"], 1)
        # 指令的 default_recipe_id 已回 NULL → 降级链不再指向已删配方
        instruction = self.db.get(Instruction, "inst-recipe")
        self.assertIsNone(instruction.default_recipe_id)
        with self.assertRaises(HTTPException) as ctx:
            get_recipe(recipe.id, self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_delete_404(self):
        with self.assertRaises(HTTPException) as ctx:
            delete_recipe("nope", self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_delete_unlinked_returns_zero(self):
        recipe = self.create()
        self.assertEqual(delete_recipe(recipe.id, self.db)["cleared_instructions"], 0)


class RecipeValidationTests(RecipeTestBase):
    """§9.5-3「配方期（组合）」行：stage 协议 404 / 槽契约 / 层数上限 / 空阶段。"""

    def test_missing_protocol_404(self):
        payload = RecipeCreate(
            name="悬空层", stages=[RecipeStage(protocol_id="ghost", slot_ids=["s0"])]
        )
        with self.assertRaises(HTTPException) as ctx:
            create_recipe(payload, self.db)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.detail, "Protocol not found")

    def test_slot_not_in_protocol_400(self):
        payload = RecipeCreate(
            name="悬空槽",
            stages=[RecipeStage(protocol_id=LAYER_IDS[0], slot_ids=["ghost"])],
        )
        with self.assertRaises(HTTPException) as ctx:
            create_recipe(payload, self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("插槽不存在于所选协议", ctx.exception.detail)

    def test_slot_must_be_slot_type_400(self):
        # h0 是 fixed 块，不是槽
        payload = RecipeCreate(
            name="非插槽",
            stages=[RecipeStage(protocol_id=LAYER_IDS[0], slot_ids=["h0"])],
        )
        with self.assertRaises(HTTPException) as ctx:
            create_recipe(payload, self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("目标块不是插槽", ctx.exception.detail)

    def test_duplicate_slot_400(self):
        payload = RecipeCreate(
            name="重复槽",
            stages=[RecipeStage(protocol_id=LAYER_IDS[0],
                                slot_ids=["s0", "s0"])],
        )
        with self.assertRaises(HTTPException) as ctx:
            create_recipe(payload, self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("插槽重复分配", ctx.exception.detail)

    def test_empty_stages_400(self):
        payload = RecipeCreate(name="空配方", stages=[])
        with self.assertRaises(HTTPException) as ctx:
            create_recipe(payload, self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("至少 1 层", ctx.exception.detail)

    def test_layer_cap_rejects_five(self):
        # 第 5 层复用已有协议 id（校验在层数这一步就挡下，协议存在性不相关）
        stages = [
            RecipeStage(protocol_id=LAYER_IDS[i % 3], slot_ids=None)
            for i in range(MAX_RECIPE_STAGES + 1)
        ]
        payload = RecipeCreate(name="五层配方", stages=stages)
        with self.assertRaises(HTTPException) as ctx:
            create_recipe(payload, self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn(f"最多 {MAX_RECIPE_STAGES} 层", ctx.exception.detail)

    def test_layer_cap_allows_four(self):
        stages = [
            RecipeStage(protocol_id=LAYER_IDS[i % 3], slot_ids=None)
            for i in range(MAX_RECIPE_STAGES)
        ]
        recipe = create_recipe(RecipeCreate(name="四层配方", stages=stages), self.db)
        self.assertEqual(len(recipe.stages), MAX_RECIPE_STAGES)

    def test_blank_name_400(self):
        payload = RecipeCreate(name="   ", stages=_stages())
        with self.assertRaises(HTTPException) as ctx:
            create_recipe(payload, self.db)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("配方名不能为空", ctx.exception.detail)

    def test_unknown_instruction_404(self):
        payload = RecipeCreate(name="挂空指令", stages=_stages(),
                               instruction_id="ghost")
        with self.assertRaises(HTTPException) as ctx:
            create_recipe(payload, self.db)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.detail, "Instruction not found")


class RecipeCompileTests(RecipeTestBase):
    """编译期 hash 比对（D7-A 失效 warning 不阻断）与入口互斥校验。"""

    def test_compile_ok_no_stale(self):
        recipe = self.create()
        resp = compile_wrapped_frame(
            WrappedCompileRequest(recipe_id=recipe.id, payloads=THREE["kernel"]),
            db=self.db,
        )
        self.assertEqual(resp.hex_string, THREE["expect"]["hex"])
        self.assertEqual(resp.total_length, THREE["expect"]["total_length"])
        self.assertEqual(resp.warnings, [])
        self.assertFalse(any(stage.stale for stage in resp.stages))

    def test_protocol_change_marks_stale_and_warns(self):
        recipe = self.create()
        # 改第 0 层协议结构（外壳加一个字节）→ 指纹失配
        protocol = self.db.get(ProtocolTemplate, LAYER_IDS[0])
        protocol.children = [{
            "id": "h0b", "label": "h0b", "type": "fixed",
            "byte_length": 2, "hex_value": "A1 A1", "config": {}, "children": [],
        }] + list(protocol.children)
        self.db.commit()

        resp = compile_wrapped_frame(
            WrappedCompileRequest(recipe_id=recipe.id, payloads=THREE["kernel"]),
            db=self.db,
        )
        # 不阻断（D7-A 口径）：仍出帧，但带「配方已失效」warning + stale 标记
        self.assertTrue(any("配方已失效" in w for w in resp.warnings))
        self.assertTrue(resp.stages[0].stale)
        self.assertFalse(any(s.stale for s in resp.stages[1:]))
        # 失效层的指纹 = 当前协议指纹（回显），配方记录未被编译改写（不回写 DB）
        row = self.db.get(FrameRecipe, recipe.id)
        self.assertNotEqual(
            row.stages[0]["definition_hash"], resp.stages[0].definition_hash
        )
        # 重新保存 → 指纹更新、失效消解
        update_recipe(recipe.id, RecipeUpdate(stages=_stages()), self.db)
        again = compile_wrapped_frame(
            WrappedCompileRequest(recipe_id=recipe.id, payloads=THREE["kernel"]),
            db=self.db,
        )
        self.assertFalse(any(s.stale for s in again.stages))

    def test_recipe_and_protocol_mutex_400(self):
        recipe = self.create()
        with self.assertRaises(HTTPException) as ctx:
            compile_wrapped_frame(
                WrappedCompileRequest(recipe_id=recipe.id, protocol_id=LAYER_IDS[0],
                                      payloads=THREE["kernel"]),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("互斥", ctx.exception.detail)

    def test_neither_id_400(self):
        with self.assertRaises(HTTPException) as ctx:
            compile_wrapped_frame(
                WrappedCompileRequest(payloads=THREE["kernel"]), db=self.db
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("必须指定其一", ctx.exception.detail)

    def test_missing_recipe_404(self):
        with self.assertRaises(HTTPException) as ctx:
            compile_wrapped_frame(
                WrappedCompileRequest(recipe_id="ghost", payloads=["0102"]),
                db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.detail, "Recipe not found")


class EnsureRecipeColumnTest(unittest.TestCase):
    """既有库缺列自愈：手工建无 default_recipe_id 的旧 instructions 表 → ALTER +
    幂等 + 新库 no-op + 表缺 no-op（镜像 EnsureVersionColumnTest）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp.name) / "legacy.db"
        self.engine = create_engine(
            f"sqlite:///{db_path.as_posix()}", connect_args={"check_same_thread": False}
        )

    def tearDown(self):
        self.engine.dispose()
        self.tmp.cleanup()

    def _make_legacy_table(self, with_row=True):
        with self.engine.begin() as conn:
            conn.exec_driver_sql(
                "CREATE TABLE instructions ("
                "id VARCHAR(36) PRIMARY KEY, device_code VARCHAR(32) NOT NULL, "
                "code VARCHAR(64) NOT NULL, name VARCHAR(128) NOT NULL, "
                "type VARCHAR(32), description TEXT)"
            )
            if with_row:
                conn.exec_driver_sql(
                    "INSERT INTO instructions (id, device_code, code, name) "
                    "VALUES ('i1', 'D01', '0x10', '旧指令')"
                )

    def _columns(self):
        with self.engine.connect() as conn:
            return {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(instructions)")}

    def test_adds_missing_column_and_backfills_null(self):
        self._make_legacy_table()
        ensure_recipe_columns(self.engine)
        self.assertIn("default_recipe_id", self._columns())
        with self.engine.connect() as conn:
            value = conn.exec_driver_sql(
                "SELECT default_recipe_id FROM instructions WHERE id='i1'"
            ).scalar()
        self.assertIsNone(value)  # 存量行回填 NULL = 无配方 → 降级链裸发/默认协议

    def test_idempotent_when_column_already_exists(self):
        self._make_legacy_table()
        ensure_recipe_columns(self.engine)
        ensure_recipe_columns(self.engine)  # 二次调用 no-op 不抛
        self.assertEqual(
            sum(1 for c in self._columns() if c == "default_recipe_id"), 1
        )

    def test_fresh_schema_is_noop(self):
        Base.metadata.create_all(bind=self.engine)  # models 已带列
        ensure_recipe_columns(self.engine)
        self.assertIn("default_recipe_id", self._columns())

    def test_table_absent_is_noop(self):
        # 表都还没有（调用先于 create_all 的防御分支）→ 不抛
        ensure_recipe_columns(self.engine)


if __name__ == "__main__":
    unittest.main()
