"""CP3 3d: D5-A「据此生成」按层映射 + D15-A 逆序解包匹配 + D7-A 失效徽标 + 补列自愈。

临时库直调路由函数（无 TestClient）—— 对齐 test_bindings / test_frame_recipes 范式。
覆盖（DESIGN_CorePipeline §9.7 · 3d 验收列）：
- **生成映射按层用例**：fixed→echo_header / length→length / checksum→checksum
  逐层产出，`unpack` 几何与 `stage` 行级镜像；
- **多层应答逆序解包匹配用例**：外壳帧 → 逐层剥离 → 内层五要素，失配带
  `STAGE[i].` 层号；
- **单层存量退化回归**：无配方 = 不写 `stages` 键，走原单帧路径；
- **hash 失效/不失配徽标用例**：response_spec 与 binding 两处（D7-A）；
- 补列自愈（response_specs 双列 / protocol_bindings.definition_hash 四态）。

三层帧主向量单一真相源 = vectors/wrap.json · 表 three（改一必改三）。
"""

import json
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core.frame_builder import build_wrapped
from backend.core.response_generate import build_spec, layer_stage_spec
from backend.core.response_match import match_response, normalize_spec
from backend.db.database import Base, ensure_binding_columns, ensure_response_spec_columns
from backend.db.models import (
    FrameRecipe,
    Instruction,
    ProtocolBinding,
    ProtocolTemplate,
    ResponseSpec,
)
from backend.routers.binding import create_binding, get_bindings, update_binding
from backend.routers.response_spec import (
    _stage_mirror,
    generate_response_spec,
    get_generate_targets,
    get_response_spec,
    upsert_response_spec,
)
from backend.schemas.binding_api import BindingCreate, BindingUpdate
from backend.schemas.response_spec_api import ResponseSpecUpsert
from vectors.load_vectors import load_vectors

THREE = load_vectors("wrap", "three")
LAYER_IDS = [layer["protocol_id"] for layer in THREE["layers"]]
# 3c/3d 共用几何锚：内核 0102 → 11B 出线帧（与 test_sequence_wrap 同读 three 表）
CANON = bytes.fromhex("C008B005A0020102E0E1E2")


def _layers():
    """three 三层 → resolve_layers 返回形（index 0 = 最内层）。"""
    return [
        {
            "protocol_id": layer["protocol_id"],
            "label": layer["label"],
            "children": layer["children"],
        }
        for layer in THREE["layers"]
    ]


def _one_layer(children):
    """单份协议 children → 归一化后的分层规格（mode=rules + 一个 stage）。"""
    stage = layer_stage_spec(children, where="[层0]", warnings=[])
    return normalize_spec(
        {"mode": "rules", "stages": [{**stage, "prefix": "", "suffix": ""}]}
    )["stages"][0]


class LayerMappingTest(unittest.TestCase):
    """生成映射按层（D5-A 按 D15-A 修订实施的核心）。"""

    def test_three_layers_each_mapped(self):
        spec, warnings = build_spec(_layers())
        self.assertEqual(warnings, [])
        spec = normalize_spec(spec)

        self.assertEqual(spec["mode"], "rules")
        # 顶层只留 framing：五要素全部按层写进 stages
        self.assertIsNone(spec["length"])
        self.assertIsNone(spec["checksum"])
        self.assertEqual(spec["echo_header_bytes"], 0)
        self.assertEqual(len(spec["stages"]), 3)
        for stage in spec["stages"]:
            # fixed(A0/B0/C0) → echo_header 1 字节（首个非 fixed 块处截断）
            self.assertEqual(stage["echo_header_bytes"], 1)
            # length 块在插槽前 → 绝对 offset 1；refs 只圈插槽 → offset_val = -head-trailer
            self.assertEqual(
                stage["length"],
                {
                    "offset": 1,
                    "byte_length": 1,
                    "offset_val": -3,
                    "byte_order": "big",
                    "offset_from_end": None,
                },
            )
            self.assertIsNone(stage["checksum"])
            # 该层帧 = head(2) + 内层块 + trailer(1)
            self.assertEqual(stage["unpack"], {"head": 2, "trailer": 1})

    def test_stage_column_mirror_is_outermost_index(self):
        self.assertEqual(_stage_mirror(normalize_spec(build_spec(_layers())[0])), 2)
        self.assertIsNone(_stage_mirror(normalize_spec(build_spec(_layers()[:1])[0])))

    def test_checksum_after_payload_maps_from_end(self):
        # [fixed][length][slot][checksum refs=插槽][fixed] —— 校验块在载荷之后，
        # 绝对位置取决于载荷长度 → 用「距帧尾字节数」表达（镜像 length 的
        # offset_from_end），span 用 span_end_pad 收到帧尾前 trailer 字节。
        children = [
            {"id": "h", "type": "fixed", "byte_length": 1, "hex_value": "A0", "children": []},
            {"id": "l", "type": "length", "byte_length": 1,
             "parameter_config": {"refs": ["s"]}, "children": []},
            {"id": "s", "type": "slot", "byte_length": 0, "children": []},
            {"id": "c", "type": "checksum", "byte_length": 1,
             "parameter_config": {"algorithm": "SUM_8", "refs": ["s"]}, "children": []},
            {"id": "t", "type": "fixed", "byte_length": 1, "hex_value": "ED", "children": []},
        ]
        warnings = []
        stage = layer_stage_spec(children, where="[层0]", warnings=warnings)
        self.assertEqual(warnings, [])
        self.assertEqual(stage["echo_header_bytes"], 1)
        self.assertEqual(stage["length"]["offset"], 1)          # 插槽前 → 绝对位置
        self.assertEqual(stage["length"]["offset_val"], -4)     # head 2 + trailer 2
        self.assertEqual(stage["checksum"]["field_offset_from_end"], 2)  # 校验字节 + 帧尾
        self.assertEqual(stage["checksum"]["span_start"], 2)     # refs 只圈载荷
        self.assertEqual(stage["checksum"]["span_end_pad"], 2)
        self.assertEqual(stage["unpack"], {"head": 2, "trailer": 2})

        normalized = _one_layer(children)
        self.assertEqual(normalized["checksum"]["field_offset"], 0)  # 归一后为缺省 0
        frame = bytes.fromhex("A002010203ED")
        self.assertEqual(
            match_response(
                normalize_spec({"mode": "rules", "stages": [normalized]}), frame, frame
            ),
            (True, []),
        )

    def test_length_after_payload_maps_from_end(self):
        # 长度块在载荷之后（另一种常见布局）→ offset_from_end 表达
        children = [
            {"id": "h", "type": "fixed", "byte_length": 1, "hex_value": "A0", "children": []},
            {"id": "s", "type": "slot", "byte_length": 0, "children": []},
            {"id": "l", "type": "length", "byte_length": 1,
             "parameter_config": {"refs": ["s"]}, "children": []},
            {"id": "t", "type": "fixed", "byte_length": 1, "hex_value": "ED", "children": []},
        ]
        warnings = []
        stage = layer_stage_spec(children, where="[层0]", warnings=warnings)
        self.assertEqual(warnings, [])
        self.assertNotIn("offset", stage["length"])  # 插槽后 → 不可绝对定位
        self.assertEqual(stage["length"]["offset_from_end"], 2)
        normalized = _one_layer(children)
        self.assertEqual(normalized["length"]["offset"], 0)
        self.assertEqual(normalized["length"]["offset_from_end"], 2)
        frame = bytes.fromhex("A0010202ED")
        self.assertEqual(
            match_response(
                normalize_spec({"mode": "rules", "stages": [normalized]}), frame, frame
            ),
            (True, []),
        )

    def test_unresolvable_shape_degrades_with_warning_not_error(self):
        # 样例协议的 length 无 refs（区间/缺省口径）→ 生成降级为「不生成 length」，
        # 整份 spec 仍然合法可存（D5-A：不阻断，手工规则是增量覆盖）。
        children = [
            {"id": "h", "type": "fixed", "byte_length": 2, "hex_value": "FA FA", "children": []},
            {"id": "l", "type": "length", "byte_length": 1, "children": []},
            {"id": "s", "type": "slot", "byte_length": 0, "children": []},
            {"id": "t", "type": "fixed", "byte_length": 1, "hex_value": "ED", "children": []},
        ]
        warnings = []
        stage = layer_stage_spec(children, where="[层0]", warnings=warnings)
        self.assertIsNone(stage["length"])
        self.assertEqual(len(warnings), 1)
        self.assertIn("未生成 length", warnings[0])
        normalize_spec({"mode": "rules", "stages": [{**stage, "prefix": "", "suffix": ""}]})

    def test_empty_layers_rejected(self):
        with self.assertRaises(ValueError):
            build_spec([])


class MultiLayerMatchTest(unittest.TestCase):
    """多层应答逆序解包匹配（D15-A）。"""

    def setUp(self):
        self.spec = normalize_spec(build_spec(_layers())[0])

    def test_round_trip_ok(self):
        ok, reasons = match_response(self.spec, CANON, CANON)
        self.assertTrue(ok, reasons)
        self.assertEqual(reasons, [])

    def test_inner_corruption_tagged_with_innermost_stage(self):
        # A0 02 → A0 03：最内层 length 自洽被破坏（第 0 层）
        bad = bytes.fromhex("C008B005A0030102E0E1E2")
        ok, reasons = match_response(self.spec, CANON, bad)
        self.assertFalse(ok)
        self.assertEqual(reasons, ["STAGE[0].LENGTH_MISMATCH(3!=2)"])

    def test_outer_corruption_tagged_with_outer_stage(self):
        bad = bytes.fromhex("C007B005A0020102E0E1E2")
        ok, reasons = match_response(self.spec, CANON, bad)
        self.assertFalse(ok)
        self.assertEqual(reasons, ["STAGE[2].LENGTH_MISMATCH(7!=8)"])

    def test_middle_layer_header_echo_uses_same_layer_sent_bytes(self):
        # 第 1 层帧头 B0 → B1：剥到该层才比对，请求侧按同一几何同步剥层
        bad = bytes.fromhex("C008B105A0020102E0E1E2")
        ok, reasons = match_response(self.spec, CANON, bad)
        self.assertFalse(ok)
        self.assertEqual(reasons, ["STAGE[1].ECHO_HEADER_MISMATCH"])

    def test_too_short_stops_unpacking(self):
        ok, reasons = match_response(self.spec, CANON, bytes.fromhex("C0"))
        self.assertFalse(ok)
        self.assertTrue(any("STAGE[2]" in r for r in reasons), reasons)
        self.assertFalse(any("STAGE[0]" in r for r in reasons), reasons)

    def test_empty_response_still_empty_response(self):
        self.assertEqual(match_response(self.spec, CANON, b""), (False, ["EMPTY_RESPONSE"]))

    def test_mode_any_short_circuits_layers(self):
        spec = normalize_spec(build_spec(_layers())[0])
        spec["mode"] = "any"
        self.assertEqual(match_response(spec, CANON, b"\x01"), (True, []))


class LegacySingleLayerRegressionTest(unittest.TestCase):
    """单层存量退化：无 stages 键 → 原单帧路径逐字节不变。"""

    def test_normalize_without_stages_omits_key(self):
        spec = normalize_spec({"mode": "echo"})
        self.assertNotIn("stages", spec)
        self.assertEqual(
            list(spec),
            ["mode", "prefix", "suffix", "echo_header_bytes", "length", "checksum", "ignore_ranges"],
        )

    def test_single_layer_generation_has_no_stages_key(self):
        spec, warnings = build_spec(_layers()[:1])
        spec = normalize_spec(spec)
        self.assertEqual(warnings, [])
        self.assertNotIn("stages", spec)
        self.assertEqual(spec["mode"], "rules")
        self.assertEqual(spec["echo_header_bytes"], 1)
        self.assertEqual(spec["length"]["offset_val"], -3)

    def test_single_layer_generated_spec_matches_same_frame(self):
        spec = normalize_spec(build_spec(_layers()[:1])[0])
        frame = bytes.fromhex("A0020102E0")  # 最内层块 = h + LEN + 内核 + t
        self.assertEqual(match_response(spec, frame, frame), (True, []))
        self.assertFalse(match_response(spec, frame, bytes.fromhex("A0030102E0"))[0])

    def test_legacy_echo_mode_untouched(self):
        spec = normalize_spec({})
        self.assertEqual(spec["mode"], "echo")
        self.assertTrue(match_response(spec, b"\x01\x02", b"\x01\x02")[0])
        self.assertFalse(match_response(spec, b"\x01\x02", b"\x01\x03")[0])


class StagesShapeInvariantTest(unittest.TestCase):
    """多层规格的组合不变量（五要素按层各归其位，顶层只留 framing）。"""

    def _stage(self, **over):
        stage = {"prefix": "", "suffix": "", "echo_header_bytes": 1,
                 "unpack": {"head": 2, "trailer": 1}}
        stage.update(over)
        return stage

    def test_valid_two_layer_passes(self):
        spec = normalize_spec({"mode": "rules", "stages": [self._stage(), self._stage()]})
        self.assertEqual(len(spec["stages"]), 2)

    def test_rejects_empty_and_over_long(self):
        with self.assertRaises(ValueError):
            normalize_spec({"stages": []})
        with self.assertRaises(ValueError):
            normalize_spec({"stages": [self._stage()] * 5})

    def test_rejects_echo_mode_and_top_level_structure(self):
        with self.assertRaises(ValueError):
            normalize_spec({"mode": "echo", "stages": [self._stage()]})
        with self.assertRaises(ValueError):
            normalize_spec({"mode": "rules", "echo_header_bytes": 2, "stages": [self._stage()]})
        with self.assertRaises(ValueError):
            normalize_spec({"mode": "rules", "length": {"offset": 1}, "stages": [self._stage()]})
        with self.assertRaises(ValueError):
            normalize_spec({"mode": "rules", "checksum": {"field_offset": 1}, "stages": [self._stage()]})

    def test_requires_unpack_and_non_empty_geometry(self):
        with self.assertRaises(ValueError):
            normalize_spec({"mode": "rules", "stages": [{"echo_header_bytes": 1}]})
        with self.assertRaises(ValueError):
            normalize_spec({"mode": "rules", "stages": [self._stage(unpack={"head": 0, "trailer": 0})]})
        with self.assertRaises(ValueError):
            normalize_spec({"mode": "rules", "stages": [self._stage(extra_key=1)]})
        with self.assertRaises(ValueError) as ctx:
            normalize_spec({"mode": "rules", "stages": [{"length": {"bogus": 1}, "unpack": {"head": 1}}]})
        self.assertIn("stages[0]", str(ctx.exception))

    def test_checksum_offset_and_span_pad_are_explicit(self):
        cs = normalize_spec({"checksum": {"field_offset_from_end": 2, "span_end_pad": 3}})
        self.assertEqual(cs["checksum"]["field_offset"], 0)
        self.assertEqual(cs["checksum"]["span_end_pad"], 3)
        with self.assertRaises(ValueError):
            normalize_spec({"checksum": {"field_offset": 1, "field_offset_from_end": 2}})


class DbBackedTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp.name) / "test_3d.db"
        self.engine = create_engine(
            f"sqlite:///{db_path.as_posix()}", connect_args={"check_same_thread": False}
        )
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.session_factory()
        for layer in THREE["layers"]:
            self.db.add(
                ProtocolTemplate(
                    id=layer["protocol_id"], label=layer["label"],
                    type="container", children=layer["children"],
                )
            )
        self.db.add(
            FrameRecipe(
                id="recipe-3d", name="三层封装配方",
                stages=[{"protocol_id": pid} for pid in LAYER_IDS],
            )
        )
        self.db.add(
            Instruction(id="inst-3d", device_code="D01", code="0x10",
                        name="开门指令", default_recipe_id="recipe-3d")
        )
        self.db.add(
            Instruction(id="inst-bare", device_code="D01", code="0x20", name="无链指令")
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()


class GenerateAndStaleTest(DbBackedTestBase):
    """D5-A「据此生成」落库 + D7-A response_spec 失效徽标。"""

    def test_generate_records_stage_and_fingerprint(self):
        result = generate_response_spec("inst-3d", db=self.db)
        self.assertEqual(result.stage, 2)
        self.assertTrue(result.definition_hash.startswith("sha256:"))
        self.assertEqual([layer.protocol_id for layer in result.layers], LAYER_IDS)
        self.assertEqual(result.warnings, [])
        self.assertFalse(result.stale)
        # 层摘要不带 children（前端只要知道是哪几层）
        self.assertNotIn("children", result.layers[0].model_dump())

    def test_generate_then_protocol_change_marks_stale(self):
        generate_response_spec("inst-3d", db=self.db)
        self.assertFalse(get_response_spec("inst-3d", db=self.db).stale)

        protocol = self.db.query(ProtocolTemplate).filter(
            ProtocolTemplate.id == LAYER_IDS[0]
        ).first()
        protocol.children = list(protocol.children) + [
            {"id": "x", "type": "fixed", "byte_length": 1, "hex_value": "99", "children": []}
        ]
        self.db.commit()
        self.assertTrue(get_response_spec("inst-3d", db=self.db).stale)

    def test_manual_spec_has_no_provenance(self):
        upsert_response_spec("inst-3d", ResponseSpecUpsert(spec={"mode": "rules"}), db=self.db)
        row = get_response_spec("inst-3d", db=self.db)
        self.assertIsNone(row.definition_hash)
        self.assertIsNone(row.stale)  # 无出处可比 → 不出徽标
        self.assertIsNone(row.stage)

    def test_manual_edit_keeps_provenance_and_resyncs_stage_mirror(self):
        generate_response_spec("inst-3d", db=self.db)
        current = dict(get_response_spec("inst-3d", db=self.db).spec)
        current["prefix"] = "AA"
        row = upsert_response_spec("inst-3d", ResponseSpecUpsert(spec=current), db=self.db)
        self.assertEqual(row.spec["prefix"], "AA")
        self.assertEqual(row.stage, 2)          # stages 原样保留 → 镜像重算仍为最外层序号
        self.assertTrue(row.definition_hash)    # 出处不因改规则而丢
        self.assertFalse(row.stale)

    def test_manual_edit_without_stages_clears_stage_mirror(self):
        generate_response_spec("inst-3d", db=self.db)
        row = upsert_response_spec(
            "inst-3d", ResponseSpecUpsert(spec={"mode": "rules"}), db=self.db
        )
        self.assertIsNone(row.stage)  # 镜像跟随 spec，不留半真值

    def test_recipe_deleted_is_stale_not_crash(self):
        generate_response_spec("inst-3d", db=self.db)
        self.db.query(FrameRecipe).filter(FrameRecipe.id == "recipe-3d").delete()
        self.db.commit()
        self.assertTrue(get_response_spec("inst-3d", db=self.db).stale)

    def test_generate_without_chain_is_400(self):
        with self.assertRaises(HTTPException) as ctx:
            generate_response_spec("inst-bare", db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_generate_missing_instruction_is_404(self):
        with self.assertRaises(HTTPException) as ctx:
            generate_response_spec("nope", db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_targets_lists_resolvable_instructions_with_protocol_hit(self):
        targets = get_generate_targets(protocol_id=LAYER_IDS[1], db=self.db)
        self.assertEqual([t.instruction_id for t in targets], ["inst-3d"])
        self.assertTrue(targets[0].uses_protocol)
        self.assertEqual(targets[0].layers, 3)
        self.assertEqual(targets[0].recipe_id, "recipe-3d")
        # 无链指令不出现在候选里（没有协议可映射）
        self.assertNotIn("inst-bare", [t.instruction_id for t in targets])

    def test_binding_makes_bare_instruction_a_target(self):
        create_binding(
            BindingCreate(protocol_id=LAYER_IDS[0], instruction_id="inst-bare",
                          label="默认", is_default=True),
            db=self.db,
        )
        targets = get_generate_targets(db=self.db)
        # 按名称序：开门指令 < 无链指令
        self.assertEqual([t.instruction_id for t in targets], ["inst-3d", "inst-bare"])
        self.assertEqual(targets[1].layers, 1)  # 无配方 → 默认协议单层退化


class BindingStaleTest(DbBackedTestBase):
    """D7-A 余下两处之一：binding 失效徽标。"""

    def _create(self, protocol_id=""):
        return create_binding(
            BindingCreate(protocol_id=protocol_id, instruction_id="inst-3d",
                          label="绑定"),
            db=self.db,
        )

    def test_create_records_fingerprint_and_not_stale(self):
        row = self._create(protocol_id=LAYER_IDS[0])
        self.assertTrue(row.definition_hash.startswith("sha256:"))
        self.assertFalse(row.stale)

    def test_protocol_change_marks_stale(self):
        row = self._create(protocol_id=LAYER_IDS[0])
        protocol = self.db.query(ProtocolTemplate).filter(
            ProtocolTemplate.id == LAYER_IDS[0]
        ).first()
        protocol.children = list(protocol.children) + [
            {"id": "y", "type": "fixed", "byte_length": 1, "hex_value": "77", "children": []}
        ]
        self.db.commit()
        listed = [b for b in get_bindings(db=self.db) if b.id == row.id][0]
        self.assertTrue(listed.stale)

    def test_label_edit_does_not_erase_stale(self):
        row = self._create(protocol_id=LAYER_IDS[0])
        protocol = self.db.query(ProtocolTemplate).filter(
            ProtocolTemplate.id == LAYER_IDS[0]
        ).first()
        protocol.children = list(protocol.children) + [
            {"id": "z", "type": "fixed", "byte_length": 1, "hex_value": "55", "children": []}
        ]
        self.db.commit()
        updated = update_binding(row.id, BindingUpdate(label="改名"), db=self.db)
        self.assertTrue(updated.stale)  # 只改 label 不重记出处

    def test_placeholder_binding_has_no_provenance(self):
        row = self._create(protocol_id="")
        self.assertIsNone(row.definition_hash)
        self.assertIsNone(row.stale)


class EnsureColumnsTest(unittest.TestCase):
    """补列自愈四态（response_specs 双列 / protocol_bindings.definition_hash）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = create_engine(
            f"sqlite:///{(Path(self.tmp.name) / 'test_3d_ensure.db').as_posix()}",
            connect_args={"check_same_thread": False},
        )

    def tearDown(self):
        self.engine.dispose()
        self.tmp.cleanup()

    def _columns(self, table):
        with self.engine.connect() as conn:
            return {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}

    def test_table_absent_is_noop(self):
        ensure_response_spec_columns(self.engine)
        ensure_binding_columns(self.engine)

    def test_response_spec_columns_added_and_backfilled_null(self):
        with self.engine.connect() as conn:
            conn.exec_driver_sql(
                "CREATE TABLE response_specs (id VARCHAR(36) PRIMARY KEY, "
                "instruction_id VARCHAR(36) NOT NULL UNIQUE, spec JSON NOT NULL)"
            )
            conn.exec_driver_sql("INSERT INTO response_specs VALUES ('r1', 'i1', '{}')")
            conn.commit()
        ensure_response_spec_columns(self.engine)
        cols = self._columns("response_specs")
        self.assertIn("stage", cols)
        self.assertIn("definition_hash", cols)
        with self.engine.connect() as conn:
            row = conn.exec_driver_sql(
                "SELECT stage, definition_hash FROM response_specs WHERE id='r1'"
            ).fetchone()
        self.assertIsNone(row[0])  # NULL = 未分层（存量单层零改）
        self.assertIsNone(row[1])  # NULL = 无出处 → 不出徽标
        ensure_response_spec_columns(self.engine)  # 二次 no-op 不抛
        self.assertEqual(sum(1 for c in cols if c == "stage"), 1)

    def test_fresh_schema_is_noop(self):
        Base.metadata.create_all(bind=self.engine)
        ensure_response_spec_columns(self.engine)
        ensure_binding_columns(self.engine)
        self.assertTrue({"stage", "definition_hash"} <= self._columns("response_specs"))
        self.assertIn("definition_hash", self._columns("protocol_bindings"))

    def test_binding_definition_hash_column_added_and_backfilled_null(self):
        with self.engine.connect() as conn:
            conn.exec_driver_sql(
                "CREATE TABLE protocol_bindings (id VARCHAR(36) PRIMARY KEY, "
                "protocol_id VARCHAR(36) NOT NULL, instruction_id VARCHAR(36) NOT NULL, "
                "label VARCHAR(128) NOT NULL, slot_order INTEGER NOT NULL)"
            )
            conn.exec_driver_sql(
                "INSERT INTO protocol_bindings VALUES ('b1', 'p1', 'i1', '存量', 0)"
            )
            conn.commit()
        ensure_binding_columns(self.engine)
        self.assertIn("definition_hash", self._columns("protocol_bindings"))
        with self.engine.connect() as conn:
            value = conn.exec_driver_sql(
                "SELECT definition_hash FROM protocol_bindings WHERE id='b1'"
            ).scalar()
        self.assertIsNone(value)
        ensure_binding_columns(self.engine)  # 二次 no-op（含两个部分唯一索引）


class StoredRowShapeTest(DbBackedTestBase):
    """库里既有单层行读出来 stage/definition_hash 为 NULL（存量零改的行级标记）。"""

    def test_legacy_row_shape(self):
        self.db.add(ResponseSpec(
            id="legacy", instruction_id="inst-3d",
            spec=normalize_spec({"mode": "echo"}),
        ))
        self.db.commit()
        row = get_response_spec("inst-3d", db=self.db)
        self.assertIsNone(row.stage)
        self.assertIsNone(row.definition_hash)
        self.assertIsNone(row.stale)
        self.assertNotIn("stages", row.spec)
        self.assertEqual(
            json.dumps(row.spec, sort_keys=True),
            json.dumps(normalize_spec({"mode": "echo"}), sort_keys=True),
        )


class VarintGenerationTest(unittest.TestCase):
    """R28（PLAN §8.52 第 8 批 · §8.60 定案）：length.encoding 透传 + varint 逐要素降级。

    生成侧必须把 `encoding` 一并写进规格，否则收侧按定宽读、出线宽一变就必然失配；
    而 varint 让**设计期几何**与线上字节差 (实际宽 - 设计期宽)，只有 length 自身靠
    收侧回算自洽（见 `_downgrade_varint`），其余要素一律少生成。
    """

    @staticmethod
    def _children(encoding=None):
        pc = {"refs": ["s"]}
        if encoding:
            pc["encoding"] = encoding
        return [
            {"id": "h", "type": "fixed", "byte_length": 2, "hex_value": "FA FA", "children": []},
            {"id": "l", "type": "length", "byte_length": 1,
             "parameter_config": pc, "children": []},
            {"id": "s", "type": "slot", "byte_length": 0, "children": []},
        ]

    @staticmethod
    def _spec(children):
        spec, warnings = build_spec(
            [{"protocol_id": "p0", "label": "层0", "children": children}]
        )
        return spec, warnings

    def test_encoding_written_only_when_non_default(self):
        spec, warnings = self._spec(self._children("varint"))
        self.assertEqual(warnings, [])
        self.assertEqual(spec["length"],
                         {"byte_length": 1, "offset_val": -3, "byte_order": "big",
                          "offset": 2, "encoding": "varint"})
        self.assertEqual(spec["echo_header_bytes"], 2)
        # 单层退化不写 stages/unpack（存量口径）；而层几何本身在 varint 下确实不可靠
        self.assertNotIn("unpack", spec)
        stage = layer_stage_spec(self._children("varint"), where="[层0]", warnings=[])
        self.assertIsNone(stage["unpack"])

        fixed, _ = self._spec(self._children())
        self.assertNotIn("encoding", fixed["length"])  # 缺省 = 缺失键（存量逐字节不变）
        self.assertEqual(fixed["length"]["offset_val"], -3)
        fixed_stage = layer_stage_spec(self._children(), where="[层0]", warnings=[])
        self.assertEqual(fixed_stage["unpack"], {"head": 3, "trailer": 0})

    def test_generated_spec_matches_wire_at_both_widths(self):
        """整条链：生成 → 发射（LengthHandler varint 出线）→ 收侧判定。"""
        spec, _ = self._spec(self._children("varint"))
        norm = normalize_spec(spec)
        for payload_len in (1, 128):  # 出线宽 1 / 2，同一份 offset_val 都要过
            payload = "AA" * payload_len
            frame = "".join(build_wrapped(self._children("varint"), [payload])["hex"].split())
            ok, reasons = match_response(norm, bytes.fromhex(frame), bytes.fromhex(frame))
            self.assertTrue(ok, msg=f"载荷 {payload_len} 字节 → {reasons}")

    def test_foreign_varint_card_drops_length(self):
        """第二张 varint 卡的出线宽不在回算项里 → 少判一条要素，不给一个必失配的值。"""
        children = [
            {"id": "h", "type": "fixed", "byte_length": 2, "hex_value": "FA FA", "children": []},
            {"id": "l1", "type": "length", "byte_length": 1,
             "parameter_config": {"refs": ["s"]}, "children": []},
            {"id": "s", "type": "slot", "byte_length": 0, "children": []},
            {"id": "l2", "type": "length", "byte_length": 1,
             "parameter_config": {"refs": ["s"], "encoding": "varint"}, "children": []},
        ]
        stage = layer_stage_spec(children, where="[层0]", warnings=[])
        self.assertIsNone(stage["length"])
        self.assertIsNone(stage["unpack"])  # head/trailer 是字节计数 → 一并不可靠
        warnings: list = []
        layer_stage_spec(children, where="[层0]", warnings=warnings)
        self.assertTrue(any("未生成 length" in w for w in warnings), msg=warnings)

    def test_multi_layer_with_varint_rejects_generation(self):
        """多层时 unpack 是结构必需 → 几何算不出 = 400（绝不给一个会剥错的几何）。"""
        inner = [
            {"id": "ih", "type": "fixed", "byte_length": 1, "hex_value": "A0", "children": []},
            {"id": "is", "type": "slot", "byte_length": 0, "children": []},
            {"id": "it", "type": "fixed", "byte_length": 1, "hex_value": "E0", "children": []},
        ]
        outer = [
            {"id": "h", "type": "fixed", "byte_length": 2, "hex_value": "FA FA", "children": []},
            {"id": "l", "type": "length", "byte_length": 1,
             "parameter_config": {"refs": ["s"], "encoding": "varint"}, "children": []},
            {"id": "s", "type": "slot", "byte_length": 0, "children": []},
        ]
        layers = [
            {"protocol_id": "p0", "label": "层0", "children": inner},
            {"protocol_id": "p1", "label": "层1", "children": outer},
        ]
        with self.assertRaises(ValueError) as ctx:
            build_spec(layers)
        self.assertIn("无法静态表达", str(ctx.exception))
        self.assertIn("[层1", str(ctx.exception))


class CobsGenerationTest(unittest.TestCase):
    """R28：协议树新组帧元素 `cobs` 进几何 —— 出线宽单元 / 区内剥层 / 不可静态降级。"""

    def test_slot_free_cobs_counts_wire_width_not_logical(self):
        """无槽 COBS 作一个几何单元：3 个 0x00 → `01 01 01 01`（4 字节）而非 3。"""
        children = [
            {"id": "h", "type": "fixed", "byte_length": 2, "hex_value": "FA FA", "children": []},
            {"id": "c", "type": "cobs",
             "children": [{"id": "k", "type": "fixed", "byte_length": 3,
                           "hex_value": "00 00 00", "children": []}],
             "parameter_config": {"terminator": "none"}},
            {"id": "s", "type": "slot", "byte_length": 0, "children": []},
        ]
        stage = layer_stage_spec(children, where="[层0]", warnings=[])
        self.assertEqual(stage["unpack"], {"head": 6, "trailer": 0})
        self.assertEqual(stage["echo_header_bytes"], 2)  # COBS 区不是回显头 → 到它为止

    @staticmethod
    def _outer_children():
        return [
            {"id": "h", "type": "fixed", "byte_length": 2, "hex_value": "FA FA", "children": []},
            {"id": "c", "type": "cobs",
             "children": [
                 {"id": "ih", "type": "fixed", "byte_length": 1, "hex_value": "BB", "children": []},
                 {"id": "s", "type": "slot", "byte_length": 0, "children": []},
                 {"id": "it", "type": "fixed", "byte_length": 1, "hex_value": "ED", "children": []},
             ],
             "parameter_config": {"terminator": "none"}},
        ]

    def test_slot_inside_cobs_gives_inner_geometry(self):
        warnings: list = []
        stage = layer_stage_spec(self._outer_children(), where="[层0]", warnings=warnings)
        self.assertEqual(stage["unpack"], {"head": 2, "trailer": 0, "mode": "cobs",
                                           "inner_head": 1, "inner_trailer": 1})
        self.assertEqual(stage["echo_header_bytes"], 2)
        self.assertEqual(warnings, [])  # 没有 length/checksum 卡 → 不该有降级警告

    def test_length_inside_cobs_degrades_with_visible_warning(self):
        children = self._outer_children()
        children[1]["children"].insert(1, {
            "id": "l", "type": "length", "byte_length": 1,
            "parameter_config": {"refs": ["s"]}, "children": [],
        })
        warnings: list = []
        stage = layer_stage_spec(children, where="[层0]", warnings=warnings)
        self.assertIsNone(stage["length"])
        self.assertTrue(any("插槽在 COBS 区内" in w for w in warnings), msg=warnings)
        # 区内几何本身仍可表达（剥层不依赖 declared）
        self.assertEqual(stage["unpack"]["mode"], "cobs")

    def test_length_hidden_in_slot_free_cobs_warns(self):
        """COBS 区（无槽）里的 length 卡没有出线坐标 → 少判一条要素 + 看得见。"""
        children = [
            {"id": "c", "type": "cobs",
             "children": [
                 {"id": "l", "type": "length", "byte_length": 1,
                  "parameter_config": {"refs": ["k"]}, "children": []},
                 {"id": "k", "type": "fixed", "byte_length": 2,
                  "hex_value": "00 00", "children": []},
             ],
             "parameter_config": {"terminator": "none"}},
            {"id": "s", "type": "slot", "byte_length": 0, "children": []},
        ]
        warnings: list = []
        stage = layer_stage_spec(children, where="[层0]", warnings=warnings)
        self.assertIsNone(stage["length"])
        self.assertTrue(any("COBS 区内" in w and "length" in w for w in warnings),
                        msg=warnings)
        # 单元宽度仍静态可解析（refs 没越出子树）→ 几何成立
        self.assertEqual(stage["unpack"], {"head": 4, "trailer": 0})

    @staticmethod
    def _inner_layer():
        return [
            {"id": "ih", "type": "fixed", "byte_length": 1, "hex_value": "A0", "children": []},
            {"id": "is", "type": "slot", "byte_length": 0, "children": []},
            {"id": "it", "type": "fixed", "byte_length": 1, "hex_value": "E0", "children": []},
        ]

    def test_two_layer_cobs_generation_and_roundtrip(self):
        """生成 → 发射 → 收侧剥层判定的整条链（mode=cobs 只在这一层写出）。"""
        layers = [
            {"protocol_id": "p0", "label": "层0", "children": self._inner_layer()},
            {"protocol_id": "p1", "label": "层1", "children": self._outer_children()},
        ]
        spec, warnings = build_spec(layers)
        self.assertEqual(warnings, [])
        norm = normalize_spec(spec)
        self.assertEqual(norm["stages"][1]["unpack"]["mode"], "cobs")

        inner = "".join(
            build_wrapped(self._inner_layer(), ["0102"])["hex"].split()
        )
        outer = "".join(build_wrapped(self._outer_children(), [inner])["hex"].split())
        ok, reasons = match_response(norm, bytes.fromhex(outer), bytes.fromhex(outer))
        self.assertTrue(ok, msg=f"{outer} → {reasons}")

    def test_nested_cobs_with_slot_rejects_multi_layer(self):
        """两层 COBS 都包槽 → 单次 COBS 解码够不着内层，几何表达不了 → 拒绝生成。"""
        nested = [
            {"id": "h", "type": "fixed", "byte_length": 2, "hex_value": "FA FA", "children": []},
            {"id": "c1", "type": "cobs",
             "children": [{"id": "c2", "type": "cobs",
                           "children": [{"id": "s", "type": "slot", "byte_length": 0,
                                         "children": []}],
                           "parameter_config": {"terminator": "none"}}],
             "parameter_config": {"terminator": "none"}},
        ]
        layers = [
            {"protocol_id": "p0", "label": "层0", "children": self._inner_layer()},
            {"protocol_id": "p1", "label": "层1", "children": nested},
        ]
        with self.assertRaises(ValueError) as ctx:
            build_spec(layers)
        self.assertIn("无法静态表达", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
