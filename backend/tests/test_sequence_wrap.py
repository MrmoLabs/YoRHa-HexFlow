"""CP3 3c (D6-B): 序列封装帧 —— 冻结完整帧 + plan.shell 逐层区间 + 发送按配方重算。

Run from repo root: python -m unittest discover -s backend/tests

§9.7 3c 验收三款在本文件钉死：

1. **序列封装往返过 `match_response`**：配方冻结帧 → Runner 出线 → loopback 回显
   过 `normalize_spec + match_response`（同一套五要素反算，负例一并钉住）；
2. **冻结 vs 重算**：冻结 `payload` 不动 —— 内核动态补丁改变内核字节、协议定义
   改变外壳字节，出线按配方**重算**（两者都与冻结帧不同）；
3. **沿 `normalize_plan` 键集纪律**：plan 顶层 / shell / kernel / layers / 字段行
   逐层未知键一律 ValueError → 400（带 `steps[i]:` 定位），嵌套不变量（层序、
   offset 严格递减、最外层恒 0、内核落在第 0 层、字段不出层区间）逐条钉住。

另覆盖：转义层位（**内核先转义 → 再套壳**，壳字面不转，同 dispatch N4/D13）、
摘配方切回裸帧、连续 PUT 幂等重冻、未选配方裸帧路径零回归、Runner `WRAP:` 三分。
主向量 = vectors/wrap.json · 表 three（与 test_frame_recipes / test_wrap_api /
InstructionProcessor.test 同读一份，改一必改四）。
"""
import unittest
from unittest import mock

from fastapi import HTTPException

from backend.core import sequence_runner, transport
from backend.core.recipe_compile import compile_recipe
from backend.core.response_match import match_response, normalize_spec
from backend.core.sequence_plan import core_plan, kernel_slice, normalize_plan
from backend.db.database import Base, ensure_sequence_step_columns
from backend.db.models import ProtocolTemplate
from backend.routers import dispatch as dispatch_mod
from backend.routers.recipe import create_recipe
from backend.routers.sequence import (
    _compile_wrap_factory,
    create_sequence,
    get_sequence,
    start_sequence,
    update_sequence,
)
from backend.routers.transport import set_transport_config
from backend.schemas.recipe_api import RecipeCreate, RecipeStage
from backend.schemas.sequence_api import SequencePayload, SequenceStepSpec
from vectors.load_vectors import load_vectors

THREE = load_vectors("wrap", "three")
RECIPE_ID = "recipe-seq-three"
INSTR = "22222222-bbbb-4ccc-8ddd-000000000001"
KERNEL = "".join(THREE["kernel"]).replace(" ", "")            # "0102"
FROZEN = THREE["expect"]["hex"].replace(" ", "")              # 11 字节紧凑形
# 三层几何（vectors/wrap.json 表 three 手算，shell_plan 产出须与之一致）：
#   head = [2,2,2] → S = [4,2,0]，内核起点 = 4+2 = 6、长 2
#   LEN 字段（各层本地 1 号位）→ 绝对 [5,3,1]
EXPECT_SHELL = {
    "recipe_id": RECIPE_ID,
    "kernel": {"offset": 6, "length": 2},
    "layers": [
        {"index": 0, "offset": 4, "size": 5},
        {"index": 1, "offset": 2, "size": 8},
        {"index": 2, "offset": 0, "size": 11},
    ],
}


def _bare(payload=KERNEL, plan=None, wrap=None, label=None):
    return SequenceStepSpec(
        instruction_id=INSTR, label=label, delay_ms=0,
        params=None, payload=payload, plan=plan, wrap=wrap,
    )


class SequenceWrapTestBase(unittest.TestCase):
    """临时库 + 三层配方（vectors 三点同源）+ 序列 Runner 重置。"""

    def setUp(self):
        import tempfile
        from pathlib import Path

        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        from backend.db.database import Base

        transport.reset()
        dispatch_mod._history.clear()
        sequence_runner.reset()
        self._tempfile = tempfile.TemporaryDirectory()
        db_path = Path(self._tempfile.name) / "test_seq_wrap.db"
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
        self.db.commit()
        self.recipe = create_recipe(
            RecipeCreate(
                id=RECIPE_ID,
                name="三层配方",
                stages=[
                    RecipeStage(protocol_id=layer["protocol_id"],
                                slot_ids=[layer["slot_id"]])
                    for layer in THREE["layers"]
                ],
            ),
            self.db,
        )

    def tearDown(self):
        transport.reset()
        dispatch_mod._history.clear()
        sequence_runner.reset()
        self.db.close()
        self.engine.dispose()
        self._tempfile.cleanup()

    # ---- 辅助 ----

    def _spec(self, steps, name="封装序列"):
        return SequencePayload(name=name, description=None, config=None, steps=steps)

    def _create(self, steps):
        return create_sequence(self._spec(steps), db=self.db)

    def _runner_steps(self, out):
        """镜像 start_sequence 的步装配（hex → bytes、plan 重归一），不起线程。"""
        steps = []
        for i, s in enumerate(out.steps):
            data, plan = normalize_plan(s.payload, s.plan)
            steps.append({
                "id": f"s{i}",
                "instruction_id": s.instruction_id,
                "label": s.label,
                "delay_ms": s.delay_ms,
                "payload": data,
                "plan": plan,
            })
        return steps

    def _wrap_factory(self):
        """与 routers/sequence._compile_wrap_factory 同形，但开临时库会话。"""

        def compile_wrap(recipe_id, kernel_hex):
            session = self.session_factory()
            try:
                out = compile_recipe(session, recipe_id, [kernel_hex])
                return str(out["hex"]).replace(" ", "")
            finally:
                session.close()

        return compile_wrap

    def _execute(self, out, compile_wrap=None, config=None):
        run = sequence_runner.claim(
            out.id, out.name, self._runner_steps(out),
            config if config is not None else
            {"stop_on_error": True, "read_timeout_ms": None},
            compile_wrap=compile_wrap,
        )
        sequence_runner.execute(run)
        return sequence_runner.snapshot()


# ---------------------------------------------------------------------------
# 1) normalize_plan 键集纪律（SSOT；纯函数直测）
# ---------------------------------------------------------------------------


class SequenceShellPlanKeyTest(unittest.TestCase):
    """plan.shell 严格键集与嵌套不变量 —— 未知键/错位一律 ValueError → 400。"""

    def _shell(self):
        """与 EXPECT_SHELL 同几何的最小合法 shell（内核 6..8）。"""
        return {
            "recipe_id": RECIPE_ID,
            "definition_hash": "sha256:abc",
            "kernel": {"offset": 6, "length": 2},
            "layers": [
                {"index": 0, "offset": 4, "size": 5,
                 "length": [{"offset": 5, "byte_length": 1}], "checksum": []},
                {"index": 1, "offset": 2, "size": 8,
                 "length": [{"offset": 3, "byte_length": 1}], "checksum": []},
                {"index": 2, "offset": 0, "size": 11,
                 "length": [{"offset": 1, "byte_length": 1}], "checksum": []},
            ],
        }

    def _assert_rejects(self, plan, fragment):
        with self.assertRaises(ValueError) as ctx:
            normalize_plan(FROZEN, plan)
        self.assertIn(fragment, str(ctx.exception))

    def test_legacy_plan_shape_unchanged_without_shell(self):
        """零回归锚：不带 shell 的 plan 归一化后键集仍是 {dynamic, checksum}。"""
        _, plan = normalize_plan(FROZEN, {"checksum": None})
        self.assertEqual(set(plan), {"dynamic", "checksum"})

    def test_null_shell_is_dropped(self):
        _, plan = normalize_plan(FROZEN, {"shell": None})
        self.assertEqual(set(plan), {"dynamic", "checksum"})

    def test_shell_normalizes_to_absolute_geometry(self):
        _, plan = normalize_plan(FROZEN, {"shell": self._shell()})
        shell = plan["shell"]
        self.assertEqual(shell["recipe_id"], EXPECT_SHELL["recipe_id"])
        self.assertEqual(shell["definition_hash"], "sha256:abc")
        self.assertEqual(shell["kernel"], EXPECT_SHELL["kernel"])
        for got, want in zip(shell["layers"], EXPECT_SHELL["layers"]):
            for key in ("index", "offset", "size"):
                self.assertEqual(got[key], want[key], key)
        # 层序恒 0..n-1 连续、由内向外 offset 递减
        self.assertEqual([l["offset"] for l in shell["layers"]], [4, 2, 0])

    def test_unknown_keys_rejected_layer_by_layer(self):
        self._assert_rejects({"nope": 1}, "未知 plan 字段")
        self._assert_rejects({"shell": {**self._shell(), "nope": 1}}, "plan.shell 未知字段")
        shell = self._shell()
        shell["kernel"] = {"offset": 6, "length": 2, "nope": 1}
        self._assert_rejects({"shell": shell}, "plan.shell.kernel 未知字段")
        shell = self._shell()
        shell["layers"][1]["nope"] = 1
        self._assert_rejects({"shell": shell}, "plan.shell.layers[1] 未知字段")
        shell = self._shell()
        shell["layers"][0]["length"][0]["nope"] = 1
        self._assert_rejects({"shell": shell}, "length[0] 未知字段")

    def test_layer_index_must_run_contiguously(self):
        shell = self._shell()
        shell["layers"][1]["index"] = 2
        self._assert_rejects({"shell": shell}, "必须按层序连续")

    def test_layer_offsets_must_nest_and_end_at_zero(self):
        # 不递减：层 1 比外层 4 还大（先过帧检 5+6=11，再撞嵌套检）
        shell = self._shell()
        shell["layers"][1]["offset"] = 5
        shell["layers"][1]["size"] = 6
        self._assert_rejects({"shell": shell}, "必须小于外层")

        # 嵌套都成立、但最外层不是 0 → 冻结帧起点错位
        shifted = {
            "recipe_id": RECIPE_ID,
            "kernel": {"offset": 8, "length": 2},
            "layers": [
                {"index": 0, "offset": 7, "size": 4,
                 "length": [{"offset": 8, "byte_length": 1}], "checksum": []},
                {"index": 1, "offset": 4, "size": 7,
                 "length": [{"offset": 5, "byte_length": 1}], "checksum": []},
                {"index": 2, "offset": 1, "size": 10,
                 "length": [{"offset": 2, "byte_length": 1}], "checksum": []},
            ],
        }
        self._assert_rejects({"shell": shifted}, "最外层 offset 必须为 0")

    def test_kernel_must_sit_inside_first_layer(self):
        shell = self._shell()
        shell["kernel"] = {"offset": 0, "length": 2}
        self._assert_rejects({"shell": shell}, "必须落在第 1 层区间内")
        shell = self._shell()
        shell["kernel"] = {"offset": 10, "length": 2}  # 10+2 > 11 → 越出 payload
        self._assert_rejects({"shell": shell}, "plan.shell.kernel 超出 payload 范围")

    def test_layer_and_field_must_stay_in_frame(self):
        shell = self._shell()
        shell["layers"][0]["size"] = 8     # 4+8=12 > 11 → 越出 payload
        self._assert_rejects({"shell": shell}, "超出 payload 范围")
        shell = self._shell()
        shell["layers"][0]["length"][0]["offset"] = 9  # 超出该层 [4,9)
        self._assert_rejects({"shell": shell}, "超出该层区间")
        shell = self._shell()
        shell["layers"].append({"index": 3, "offset": 0, "size": 5,
                                "length": [], "checksum": []})
        self._assert_rejects({"shell": shell}, "必须小于外层")

    def test_layer_limit_matches_recipe_cap(self):
        shell = self._shell()
        extra = [
            {"index": i, "offset": 0, "size": 5, "length": [], "checksum": []}
            for i in (3, 4)
        ]
        shell["layers"] = shell["layers"] + extra   # 5 层 → 超 4 层上限
        self._assert_rejects({"shell": shell}, "最多 4 层")

    def test_kernel_slice_and_core_plan_roundtrip(self):
        data = bytes.fromhex(FROZEN)
        _, plan = normalize_plan(FROZEN, {"shell": self._shell()})
        self.assertEqual(kernel_slice(data, plan).hex().upper(), KERNEL)
        self.assertNotIn("shell", core_plan(plan))
        # 无 shell：两者都是恒等/原样
        bare = {"dynamic": [], "checksum": None}
        self.assertIs(core_plan(bare), bare)
        self.assertEqual(kernel_slice(data, bare), data)


# ---------------------------------------------------------------------------
# 2) 保存期冻结完整帧 + 读侧失效徽标
# ---------------------------------------------------------------------------


class SequenceWrapFreezeTest(SequenceWrapTestBase):
    def test_wrap_freezes_full_frame_and_shell(self):
        """选配方 → payload 冻结成完整帧、plan 注入逐层区间、wrap 带复合指纹。"""
        out = self._create([_bare(wrap={"recipe_id": RECIPE_ID}, label="封装步")])
        step = out.steps[0]
        self.assertEqual(step.payload, FROZEN)             # 冻结完整帧（11 字节）
        shell = step.plan["shell"]
        self.assertEqual(shell["recipe_id"], RECIPE_ID)
        self.assertEqual(shell["kernel"], EXPECT_SHELL["kernel"])
        self.assertEqual([l["offset"] for l in shell["layers"]], [4, 2, 0])
        self.assertEqual([l["size"] for l in shell["layers"]], [5, 8, 11])
        self.assertEqual(
            [l["length"][0]["offset"] for l in shell["layers"]], [5, 3, 1]
        )
        self.assertTrue(shell["definition_hash"].startswith("sha256:"))
        # 内核侧补丁坐标不变（仍相对内核帧，不是整帧）
        self.assertEqual(step.plan["dynamic"], [])
        self.assertIsNone(step.plan["checksum"])
        # wrap 列 + 读侧 stale 标记（协议未改 → 未失效）
        self.assertEqual(step.wrap["recipe_id"], RECIPE_ID)
        self.assertEqual(step.wrap["definition_hash"], shell["definition_hash"])
        self.assertFalse(step.wrap["stale"])

    def test_reapply_then_put_is_idempotent(self):
        """前端「应用」后回传（内核 + 无 shell）与原样回传（完整帧 + shell）
        两种形态都要冻出**同一帧**——连续 PUT 结果逐字节相同。"""
        first = self._create([_bare(wrap={"recipe_id": RECIPE_ID})])
        s = first.steps[0]

        echoed = update_sequence(
            first.id,
            self._spec([_bare(payload=s.payload, plan=s.plan,
                              wrap={"recipe_id": RECIPE_ID})], name="封装序列"),
            db=self.db,
        ).steps[0]
        reapplied = update_sequence(
            first.id,
            self._spec([_bare(payload=KERNEL, wrap={"recipe_id": RECIPE_ID})],
                       name="封装序列"),
            db=self.db,
        ).steps[0]

        for other in (echoed, reapplied):
            self.assertEqual(other.payload, s.payload)
            self.assertEqual(other.plan["shell"], s.plan["shell"])
            self.assertEqual(other.wrap, s.wrap)

    def test_unwrapping_recipe_restores_bare_kernel(self):
        """摘掉配方 → 按旧区间切回内核、剥 shell、wrap 归零（退回 3c 前形态）。"""
        created = self._create([_bare(wrap={"recipe_id": RECIPE_ID})])
        frozen = created.steps[0]
        bare = update_sequence(
            created.id,
            self._spec([_bare(payload=frozen.payload, plan=frozen.plan, wrap=None)]),
            db=self.db,
        ).steps[0]
        self.assertEqual(bare.payload, KERNEL)
        self.assertNotIn("shell", bare.plan or {})
        self.assertIsNone(bare.wrap)

    def test_missing_recipe_is_400_with_step_locator(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create([_bare(wrap={"recipe_id": "recipe-ghost"})])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertTrue(ctx.exception.detail.startswith("steps[0]: "))
        self.assertIn("配方不存在", ctx.exception.detail)

    def test_wrap_unknown_field_is_400(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create([_bare(wrap={"recipe_id": RECIPE_ID, "protocol_id": "x"})])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn(".wrap 未知字段", ctx.exception.detail)

    def test_unknown_plan_key_is_400_with_step_locator(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create([_bare(plan={"shellz": {}})])
        self.assertIn("steps[0]: 未知 plan 字段", ctx.exception.detail)

    def test_bare_step_is_untouched(self):
        """未选配方：payload/plan/wrap 与 3c 之前逐字节一致（零回归锚）。"""
        out = self._create([_bare(payload="A5 01 0B", label="裸步")])
        step = out.steps[0]
        self.assertEqual(step.payload, "A5010B")
        self.assertIsNone(step.plan)
        self.assertIsNone(step.wrap)

    def test_stale_flag_lights_when_protocol_definition_changes(self):
        """D7-A：协议结构变了才亮徽标，不阻断、冻结帧不动。"""
        created = self._create([_bare(wrap={"recipe_id": RECIPE_ID})])
        frozen = created.steps[0]
        self.assertFalse(created.steps[0].wrap["stale"])

        protocol = (self.db.query(ProtocolTemplate)
                    .filter(ProtocolTemplate.id == "vector-mid").first())
        children = [dict(c) for c in protocol.children]
        children[3] = {**children[3], "hex_value": "EE"}   # t1: E1 → EE
        protocol.children = children
        self.db.commit()

        stale = get_sequence(created.id, db=self.db).steps[0]
        self.assertTrue(stale.wrap["stale"])
        self.assertEqual(stale.payload, frozen.payload)     # 冻结帧不动
        self.assertEqual(stale.plan["shell"], frozen.plan["shell"])
        self.assertEqual(
            stale.plan["shell"]["definition_hash"],
            frozen.plan["shell"]["definition_hash"],        # 指纹是冻结期的值
        )

        protocol.children = [dict(c) for c in THREE["layers"][1]["children"]]
        self.db.commit()
        self.assertFalse(get_sequence(created.id, db=self.db).steps[0].wrap["stale"])

    def test_start_sequence_injects_compile_wrap_entry(self):
        out = self._create([_bare(wrap={"recipe_id": RECIPE_ID})])
        with mock.patch.object(
            sequence_runner, "start", return_value=sequence_runner.snapshot()
        ) as spy:
            start_sequence(out.id, db=self.db)
        self.assertTrue(callable(spy.call_args.kwargs.get("compile_wrap")))
        self.assertTrue(callable(_compile_wrap_factory()))


# ---------------------------------------------------------------------------
# 3) 发送期：按配方重算 + 冻结 vs 重算 + match_response 往返
# ---------------------------------------------------------------------------


class SequenceWrapSendTest(SequenceWrapTestBase):
    def test_sent_equals_frozen_and_roundtrips_match_response(self):
        """验收①：出线 == 冻结帧（escape 关）、回显过 match_response（负例同钉）。"""
        out = self._create([_bare(wrap={"recipe_id": RECIPE_ID})])
        frozen = out.steps[0].payload
        snap = self._execute(out, compile_wrap=self._wrap_factory())

        self.assertEqual(snap["result"], "completed")
        step = snap["steps"][0]
        self.assertEqual(step["status"], "OK")
        self.assertEqual(step["sent"], " ".join(
            FROZEN[i:i + 2] for i in range(0, len(FROZEN), 2)
        ))
        self.assertEqual(step["received"], FROZEN)

        sent = bytes.fromhex(step["sent"].replace(" ", ""))
        received = bytes.fromhex(step["received"])
        spec = normalize_spec({"mode": "echo", "echo_header_bytes": len(sent)})
        ok, reasons = match_response(spec, sent, received)
        self.assertTrue(ok, reasons)
        # 负例：应答被篡改 → 同一 spec 必须判失败（证明往返不是空通过）
        bad_ok, bad_reasons = match_response(spec, sent, bytes([0] * len(received)))
        self.assertFalse(bad_ok)
        self.assertTrue(bad_reasons)
        # 冻结帧原样（保存期值不被发送期回写）
        self.assertEqual(get_sequence(out.id, db=self.db).steps[0].payload, frozen)

    def test_kernel_dynamic_patch_updates_kernel_only(self):
        """验收②a：内核动态补丁落在内核区间，外壳按配方重算（长度不变）。"""
        plan = {"dynamic": [{"op": "AUTO_COUNTER", "offset": 1, "byte_len": 1,
                             "value": 0, "step": 1, "max": 255}]}
        out = self._create([_bare(plan=plan, wrap={"recipe_id": RECIPE_ID})])
        snap = self._execute(out, compile_wrap=self._wrap_factory())
        self.assertEqual(snap["result"], "completed")
        sent = bytes.fromhex(snap["steps"][0]["sent"].replace(" ", ""))

        frozen = bytes.fromhex(FROZEN)
        self.assertEqual(len(sent), len(frozen))             # 等长 → 外壳 LEN 有效
        self.assertEqual(sent[:7], frozen[:6] + frozen[6:7]) # 外壳 + 内核首字节不动
        self.assertEqual(sent[7], 0x01)                      # (value+step)=1
        self.assertEqual(sent[8:], frozen[8:])               # 内核尾 + 各层尾不动
        self.assertNotEqual(sent, frozen)                    # 冻结 vs 重算可区分
        # 冻结帧本身没被发送期改写
        self.assertEqual(get_sequence(out.id, db=self.db).steps[0].payload, FROZEN)

    def test_protocol_change_recomputes_shell_at_send(self):
        """验收②b：外壳字节按**当前**协议定义重算，冻结帧保持保存时的值。"""
        out = self._create([_bare(wrap={"recipe_id": RECIPE_ID})])
        self.assertEqual(out.steps[0].payload, FROZEN)

        protocol = (self.db.query(ProtocolTemplate)
                    .filter(ProtocolTemplate.id == "vector-link").first())
        children = [dict(c) for c in protocol.children]
        children[3] = {**children[3], "hex_value": "EE"}      # t2: E2 → EE
        protocol.children = children
        self.db.commit()

        snap = self._execute(out, compile_wrap=self._wrap_factory())
        self.assertEqual(snap["result"], "completed")
        sent = bytes.fromhex(snap["steps"][0]["sent"].replace(" ", ""))
        self.assertEqual(len(sent), 11)
        self.assertEqual(sent[10], 0xEE)                      # 最外层尾字节已重算
        self.assertEqual(sent[:10], bytes.fromhex(FROZEN)[:10])
        self.assertEqual(                                    # 冻结帧不受影响
            get_sequence(out.id, db=self.db).steps[0].payload, FROZEN
        )

    def test_kernel_escaped_then_wrapped_shell_stays_literal(self):
        """转义层位（N4/D13）：内核先转义 → 再套壳；壳字面不转、LEN 按线上字节计。"""
        set_transport_config({"escape": {"enabled": True,
                                         "pairs": [["7D", "7D5D"], ["E0", "E05E"]]}})
        try:
            out = self._create([_bare(payload="7D02", wrap={"recipe_id": RECIPE_ID})])
            # 冻结帧按**未转义**内核算：A0 02 7D 02 E0 → 三套壳
            self.assertEqual(out.steps[0].payload, "C008B005A0027D02E0E1E2")
            snap = self._execute(out, compile_wrap=self._wrap_factory())
            self.assertEqual(snap["result"], "completed")
            sent = snap["steps"][0]["sent"].replace(" ", "")
            # 内核 7D → 7D 5D（转义），三层 LEN 随线上字节重算 03/06/09；
            # 外壳尾字节 E0 若被整帧转义会变 E05E → 判据即在此
            self.assertEqual(sent, "C009B006A0037D5D02E0E1E2")
            self.assertNotIn("E05E", sent)
        finally:
            transport.reset()

    def test_deleted_recipe_marks_step_error_not_crash(self):
        """WRAP 三分：配方被删 → 记步 `WRAP: …`，不炸 Runner 级兜底。"""
        out = self._create([_bare(wrap={"recipe_id": RECIPE_ID})])

        def broken(recipe_id, kernel_hex):
            raise HTTPException(status_code=404, detail="Recipe not found")

        snap = self._execute(out, compile_wrap=broken)
        self.assertEqual(snap["result"], "failed")
        self.assertTrue(snap["steps"][0]["error"].startswith("WRAP:"))
        self.assertIn("Recipe not found", snap["steps"][0]["error"])
        self.assertIsNone(snap["steps"][0]["sent"])

    def test_missing_compile_entry_marks_wrap_error(self):
        out = self._create([_bare(wrap={"recipe_id": RECIPE_ID})])
        snap = self._execute(out, compile_wrap=None)
        self.assertEqual(snap["steps"][0]["status"], "ERROR")
        self.assertTrue(snap["steps"][0]["error"].startswith("WRAP:"))

    def test_bare_step_send_path_unchanged(self):
        """零回归锚：无 shell 的步仍走 apply_plan → 整帧转义（3c 之前逐字节一致）。"""
        plan = {"dynamic": [{"op": "AUTO_COUNTER", "offset": 1, "byte_len": 1,
                             "value": 0, "step": 1, "max": 255}]}
        out = self._create([_bare(payload="A5 00 0B", plan=plan)])
        snap = self._execute(out, compile_wrap=None)
        self.assertEqual(snap["result"], "completed")
        self.assertEqual(snap["steps"][0]["sent"], "A5 01 0B")


# ---------------------------------------------------------------------------
# 4) DDL 自愈：sequence_steps.wrap 单列（镜像 ensure_recipe_columns 四态模板）
# ---------------------------------------------------------------------------


class SequenceStepColumnSelfHealTest(unittest.TestCase):
    """create_all 只建缺失的表、**不给既有表补列** → 存量库缺 wrap 须启动自愈。

    四态与 test_frame_recipes 的 ensure_recipe_columns 用例同构（改一须对照另一处）。
    """

    def setUp(self):
        import tempfile
        from pathlib import Path

        from sqlalchemy import create_engine

        self._tempfile = tempfile.TemporaryDirectory()
        db_path = Path(self._tempfile.name) / "test_seq_wrap_col.db"
        self.engine = create_engine(
            f"sqlite:///{db_path.as_posix()}", connect_args={"check_same_thread": False}
        )

    def tearDown(self):
        self.engine.dispose()
        self._tempfile.cleanup()

    def _make_legacy_table(self, with_row=True):
        with self.engine.begin() as conn:
            conn.exec_driver_sql(
                "CREATE TABLE sequence_steps ("
                "id VARCHAR(36) PRIMARY KEY, sequence_id VARCHAR(36) NOT NULL, "
                "step_order INTEGER NOT NULL, instruction_id VARCHAR(36) NOT NULL, "
                "label VARCHAR(128), delay_ms INTEGER NOT NULL, params JSON, "
                "payload TEXT NOT NULL, plan JSON)"
            )
            if with_row:
                conn.exec_driver_sql(
                    "INSERT INTO sequence_steps (id, sequence_id, step_order, "
                    "instruction_id, delay_ms, payload) "
                    "VALUES ('s1', 'q1', 0, 'i1', 0, 'A5010B')"
                )

    def _columns(self):
        with self.engine.connect() as conn:
            return {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(sequence_steps)")}

    def test_adds_missing_column_and_backfills_null(self):
        self._make_legacy_table()
        ensure_sequence_step_columns(self.engine)
        self.assertIn("wrap", self._columns())
        with self.engine.connect() as conn:
            value = conn.exec_driver_sql(
                "SELECT wrap FROM sequence_steps WHERE id='s1'"
            ).scalar()
        self.assertIsNone(value)  # 存量行回填 NULL = 裸帧步骤（D6-B 缺省路径）

    def test_idempotent_when_column_already_exists(self):
        self._make_legacy_table()
        ensure_sequence_step_columns(self.engine)
        ensure_sequence_step_columns(self.engine)  # 二次调用 no-op 不抛
        self.assertEqual(sum(1 for c in self._columns() if c == "wrap"), 1)

    def test_fresh_schema_is_noop(self):
        Base.metadata.create_all(bind=self.engine)  # models 已带列
        ensure_sequence_step_columns(self.engine)
        self.assertIn("wrap", self._columns())

    def test_table_absent_is_noop(self):
        # 表都还没有（调用先于 create_all 的防御分支）→ 不抛
        ensure_sequence_step_columns(self.engine)


if __name__ == "__main__":
    unittest.main()
