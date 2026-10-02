import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from backend.core import diagnostics as diag
from backend.core import sequence_runner
from backend.core.recipe_compile import (
    compile_recipe,
    current_fingerprint,
    shell_plan,
    stages_fingerprint,
)
from backend.core.sequence_plan import core_plan, kernel_slice, normalize_plan
from backend.db.database import SessionLocal, get_db
from backend.db.models import FrameRecipe, Instruction, Sequence, SequenceStep
from backend.db.soft_delete import alive, mark_deleted
from backend.schemas.sequence_api import (
    SequenceOut,
    SequencePayload,
    SequenceStatus,
    SequenceStepOut,
    SequenceStepSpec,
)

# P3 序列编排后端（新表 sequences / sequence_steps，仅新增，既有表零改）：
# - CRUD = 保存时定值：步骤帧由 P4 前端 encodeInstruction 产出存 payload，
#   表单值冻结 params、重算计划 plan 经 normalize_plan 归一入库；此后改指令
#   定义不影响已存序列（用户批复：参数保存时定值，TIME/COUNTER 发送时重算）。
# - 运行 = 单槽后台 Runner（core/sequence_runner）：POST /{id}/start 同步占槽
#   丢 daemon 线程；GET /status 轮询（P4 序列页 1.5s）；POST /stop 协作式停止
#   （恒 200 幂等，idle 无操作）。状态存内存，重启即 idle（定义持久化在库）。
# - 互斥：序列运行期 POST /dispatch、POST /dispatch/transaction 入口查
#   sequence_runner.is_running() → 409（dispatch.py 接线）；Runner 自身直连
#   transport.send 不走被互斥路由，无自锁。
# - /status、/stop 注册在 /{sequence_id} 之前（FastAPI 按注册序匹配，防
#   "status" 被当成 sequence_id 吞成 404）。
# - 无模块级 create_all（同 E4/P1/P2 纪律，建表归 lifespan）；编辑/删除运行
#   中定义不打断运行（Runner 持内存副本），编辑入口由前端运行期自行禁用。
# - 校验类错误 400（业务口径 detail 为 SSOT）；模型形状缺失 422（pydantic，
#   同 P2 先例）。测试 stdlib unittest 直调本模块函数（临时库直连 Session）。
# - CP3 3c (D6-B) 序列封装帧：步骤可选 `wrap={recipe_id}`，保存期由配方把内核
#   套成**冻结完整帧**（payload）并在 plan 记 `shell`（外壳逐层 length/checksum
#   区间）；发送期切内核打补丁 → 内核先转义 → 按配方重算外壳（sequence_runner）。
#   `recipe_id` + 冻结期 `definition_hash` 复合指纹存 `sequence_steps.wrap`，
#   读侧比对当前协议定义 → 协议结构变了才亮徽标（不阻断，D7-A）。

router = APIRouter(prefix="/sequences", tags=["sequences"])

_MAX_STEPS = 200
_MAX_NAME = 128
_MAX_LABEL = 128
_MAX_DELAY_MS = 60000
_CONFIG_KEYS = {"stop_on_error", "read_timeout_ms"}


def _checked_name(db: Session, name, exclude_id=None) -> str:
    cleaned = str(name or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="序列名不能为空")
    if len(cleaned) > _MAX_NAME:
        raise HTTPException(status_code=400, detail=f"序列名最长 {_MAX_NAME} 字")
    # R6（§8.43 已知取舍）：**不过滤回收站** —— 软删行继续占名（sequences.name 是
    # inline UNIQUE，拍板 R6 只新增列、不重建表 → 删不掉那个索引）。回收站里还有
    # 同名序列时新建/改名会 400「已存在」，先恢复或彻底删除即可释放。
    query = db.query(Sequence).filter(Sequence.name == cleaned)
    if exclude_id is not None:
        query = query.filter(Sequence.id != exclude_id)
    if query.first() is not None:
        raise HTTPException(status_code=400, detail=f"序列名已存在：{cleaned}")
    return cleaned


def _normalize_config(raw) -> dict:
    """运行配置归一（严格键集，未知键 400——同 P2 normalize_spec 纪律）。"""
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="config 必须是对象")
    unknown = set(raw) - _CONFIG_KEYS
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"未知 config 字段: {', '.join(sorted(unknown))}"
        )
    stop_on_error = raw.get("stop_on_error", True)
    if not isinstance(stop_on_error, bool):
        raise HTTPException(status_code=400, detail="config.stop_on_error 必须是布尔值")
    read_timeout_ms = raw.get("read_timeout_ms", None)
    if read_timeout_ms is not None and (
        isinstance(read_timeout_ms, bool)
        or not isinstance(read_timeout_ms, int)
        or not (1 <= read_timeout_ms <= 60000)
    ):
        raise HTTPException(
            status_code=400,
            detail="config.read_timeout_ms 必须是 1..60000 的整数（或 null = 传输配置缺省）",
        )
    return {"stop_on_error": stop_on_error, "read_timeout_ms": read_timeout_ms}


def _wrap_spec(raw, where: str):
    """CP3 3c (D6-B): 请求形 `wrap` 校验 —— 只收 {recipe_id}，未知键 400。"""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail=f"{where}.wrap 必须是对象或 null")
    unknown = set(raw) - {"recipe_id"}
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"{where}.wrap 未知字段: {', '.join(sorted(unknown))}"
        )
    recipe_id = str(raw.get("recipe_id") or "").strip()
    if not (1 <= len(recipe_id) <= 64):
        raise HTTPException(
            status_code=400, detail=f"{where}.wrap.recipe_id 必须是 1..64 字符"
        )
    return {"recipe_id": recipe_id}


def _freeze_wrap(db: Session, where: str, recipe_id: str, data: bytes, plan):
    """保存期「冻结完整帧」：内核 → 逐层套壳 → 注入 plan.shell 逐层区间。

    返回 (完整帧 bytes, 注入 shell 的 plan)。协议/配方语义错误统一降为 400 并
    带 `steps[i]:` 定位（与 payload/plan 归一同一报错口径，前端可直接指到步骤）。
    """
    recipe = (
        alive(db.query(FrameRecipe), FrameRecipe)
        .filter(FrameRecipe.id == recipe_id)
        .first()
    )
    if recipe is None:
        raise diag.http(
            400, f"{where}: 配方不存在：{recipe_id}",
            "wrap", "RECIPE_NOT_FOUND", target=recipe_id, data_sent=False,
        )
    kernel = kernel_slice(data, plan).hex().upper()
    try:
        result = compile_recipe(db, recipe_id, [kernel])
    except HTTPException as e:
        # 内层 400/404 包一层 `steps[i]:` 定位 —— 层号/协议诊断跟着往上传
        raise diag.with_detail(e, 400, f"{where}: {e.detail}", target=where)
    except ValueError as e:
        raise diag.with_detail(e, 400, f"{where}: {e}", target=where)
    fingerprint = stages_fingerprint(
        [s.get("definition_hash") for s in (result.get("stages") or [])]
    )
    try:
        shell = shell_plan(result, kernel, recipe_id, fingerprint)
        # 内核侧补丁原样保留（plan 可能为 None → 空基座再挂 shell）
        base = core_plan(plan) or {}
        frozen, plan_with_shell = normalize_plan(result["hex"], {**base, "shell": shell})
    except ValueError as e:
        raise diag.with_detail(e, 400, f"{where}: {e}", target=where)
    return frozen, plan_with_shell, fingerprint


def _normalize_steps(db: Session, steps: List[SequenceStepSpec]) -> List[dict]:
    """步骤列表归一：边界 + normalize_plan（payload/plan 形态 SSOT）。

    CP3 3c (D6-B) 序列封装帧三形态（都先按入参归一，再按 wrap 决定去向）：
    1. 无 wrap、plan 无 shell = 现状裸帧路径，**逐字节不变**；
    2. 有 wrap → 切内核（无 shell 时入参 payload 即内核）→ 配方逐层套壳 →
       冻结**完整帧**入 payload、`plan.shell` 记外壳逐层区间；
    3. 无 wrap 但 plan 带 shell（配方被摘掉）→ 按旧区间切回内核、剥掉 shell，
       退回裸帧形态（否则内核相对区间会错位打到整帧上）。
    """
    if len(steps) > _MAX_STEPS:
        raise HTTPException(status_code=400, detail=f"步骤最多 {_MAX_STEPS} 步")
    normalized: List[dict] = []
    for i, step in enumerate(steps):
        where = f"steps[{i}]"
        instruction_id = str(step.instruction_id or "").strip()
        if not instruction_id or len(instruction_id) > 64:
            raise HTTPException(
                status_code=400, detail=f"{where}.instruction_id 必须是 1..64 字符"
            )
        label = step.label.strip() if isinstance(step.label, str) and step.label.strip() else None
        if label is not None and len(label) > _MAX_LABEL:
            raise HTTPException(status_code=400, detail=f"{where}.label 最长 {_MAX_LABEL} 字")
        delay = step.delay_ms
        if isinstance(delay, bool) or not isinstance(delay, int) or not (0 <= delay <= _MAX_DELAY_MS):
            raise HTTPException(
                status_code=400,
                detail=f"{where}.delay_ms 必须在 0..{_MAX_DELAY_MS} 范围内",
            )
        if step.params is not None and not isinstance(step.params, dict):
            raise HTTPException(status_code=400, detail=f"{where}.params 必须是对象或 null")
        wrap = _wrap_spec(step.wrap, where)
        try:
            data, plan = normalize_plan(step.payload, step.plan)
        except ValueError as e:
            raise diag.http_from(
                e, 400, f"{where}: {e}", "plan", "STEP_PLAN_INVALID",
                target=where, step=i + 1, data_sent=False,
            )

        fingerprint = None
        if wrap is not None:
            data, plan, fingerprint = _freeze_wrap(
                db, where, wrap["recipe_id"], data, plan
            )
        elif plan is not None and plan.get("shell"):
            # 摘掉配方：冻结完整帧 → 切回内核、剥 shell（回到 3c 之前的形态）
            try:
                kernel = kernel_slice(data, plan)
                data, plan = normalize_plan(kernel.hex().upper(), core_plan(plan))
            except ValueError as e:
                raise diag.http_from(
                    e, 400, f"{where}: {e}", "wrap", "STEP_SHELL_STRIP_INVALID",
                    target=where, step=i + 1, data_sent=False,
                )

        normalized.append({
            "instruction_id": instruction_id,
            "label": label,
            "delay_ms": delay,
            "params": step.params,
            "payload": data.hex().upper(),
            "plan": plan,
            "wrap": (
                {"recipe_id": wrap["recipe_id"], "definition_hash": fingerprint}
                if wrap is not None
                else None
            ),
        })
    return normalized


def write_steps(db: Session, sequence_id: str, steps: List[dict]) -> None:
    for order, spec in enumerate(steps):
        db.add(SequenceStep(
            id=str(uuid.uuid4()),
            sequence_id=sequence_id,
            step_order=order,
            instruction_id=spec["instruction_id"],
            label=spec["label"],
            delay_ms=spec["delay_ms"],
            params=spec["params"],
            payload=spec["payload"],
            plan=spec["plan"],
            wrap=spec.get("wrap"),
        ))


def normalize_sequence(db: Session, name, config, steps, exclude_id=None):
    """序列三段归一：名字 → 运行配置 → 步骤（plan / wrap 冻结）。

    **create / update / 按域导入（PLAN §8.46 R8）共用这一套口径** —— `datahub` 只管
    「逐行 upsert + 逐行报告 + 导入前快照」，不重写第二套校验。任一不合法即抛
    HTTPException（含「序列名已存在：X」的回收站占名口径），调用方决定是 400 还是
    单行 skip。顺序与 `update_sequence` 改前逐字一致（name → config → steps）。
    """
    return (
        _checked_name(db, name, exclude_id=exclude_id),
        _normalize_config(config),
        _normalize_steps(db, steps),
    )


def _step_rows(db: Session, sequence_id: str) -> List[SequenceStep]:
    return (
        db.query(SequenceStep)
        .filter(SequenceStep.sequence_id == sequence_id)
        .order_by(SequenceStep.step_order.asc(), SequenceStep.id.asc())
        .all()
    )


def _missing_instruction_ids(db: Session, step_rows: List[SequenceStep]) -> set:
    """批次二 (D14②): 步骤宿主指令已删除 → 失效标记（**零 DDL**）。

    判据 = `instruction_id` 悬空（等价 LEFT JOIN，批量比对）。步骤的
    payload/params/plan 是**冻结快照**、Runner 发送不查指令行 → 删宿主后步骤
    仍可运行，因此不级联删、只标记（与 D7「失效不阻断」同语义）。
    """
    wanted = {s.instruction_id for s in step_rows if s.instruction_id}
    if not wanted:
        return set()
    present = {
        row.id
        for row in db.query(Instruction.id).filter(Instruction.id.in_(wanted)).all()
    }
    return wanted - present


def _wrap_with_stale(db: Session, wrap, seen: dict) -> Optional[dict]:
    """读侧补 `stale`：冻结期复合指纹 vs **当前**协议定义重算值（D7-A 不阻断）。

    每次请求按 recipe_id 缓存（同序列里多步引用同一配方时只查一次）；配方已被
    删除或其任一层协议已删除 → 无法比对，按「已失效」处理（与 D14② 步骤失效
    同语义：标记不阻断，冻结帧仍可发）。
    """
    if not wrap:
        return None
    out = dict(wrap)
    recipe_id = out.get("recipe_id")
    if recipe_id not in seen:
        # R6: 配方在回收站 → 指纹算不出 → stale 徽标（与「配方已删」同口径）
        recipe = (
            alive(db.query(FrameRecipe), FrameRecipe)
            .filter(FrameRecipe.id == recipe_id)
            .first()
        )
        seen[recipe_id] = None if recipe is None else current_fingerprint(db, recipe)
    current = seen[recipe_id]
    recorded = out.get("definition_hash")
    out["stale"] = (current is None) or (recorded is None) or (recorded != current)
    return out


def _to_out(db: Session, row: Sequence, step_rows: List[SequenceStep]) -> SequenceOut:
    missing = _missing_instruction_ids(db, step_rows)
    seen: dict = {}
    return SequenceOut(
        id=row.id,
        name=row.name,
        description=row.description,
        config=row.config or {},
        steps=[
            SequenceStepOut(
                id=s.id,
                step_order=s.step_order,
                instruction_id=s.instruction_id,
                instruction_missing=s.instruction_id in missing,
                label=s.label,
                delay_ms=s.delay_ms,
                params=s.params,
                payload=s.payload,
                plan=s.plan,
                wrap=_wrap_with_stale(db, getattr(s, "wrap", None), seen),
            )
            for s in step_rows
        ],
    )


# ---- 轮询/停止：必须先于 /{sequence_id} 注册（路由匹配按注册序）----


@router.get("/status", response_model=SequenceStatus)
def sequence_status() -> SequenceStatus:
    """运行状态轮询（P4 序列页 1.5s）；idle 形态为缺省态，终态保留至下次启动。"""
    return SequenceStatus(**sequence_runner.snapshot())


@router.post("/stop", response_model=SequenceStatus)
def stop_sequence() -> SequenceStatus:
    """协作式停止（恒 200 幂等；idle 无操作）。停止位在 delay 分片与步间生效。"""
    sequence_runner.request_stop()
    return SequenceStatus(**sequence_runner.snapshot())


# ---- 定义 CRUD（保存时定值）----


@router.get("", response_model=List[SequenceOut])
def list_sequences(db: Session = Depends(get_db)) -> List[SequenceOut]:
    # R6: 回收站行不进列表（alive = deleted_at IS NULL）；步骤仍按宿主 id 分组，
    # 轫库行的步骤不落到任何活序列上 → 不会外泄。
    rows = (
        alive(db.query(Sequence), Sequence)
        .order_by(Sequence.name.asc(), Sequence.id.asc())
        .all()
    )
    grouped: dict = {}
    for step in (
        db.query(SequenceStep)
        .order_by(
            SequenceStep.sequence_id.asc(),
            SequenceStep.step_order.asc(),
            SequenceStep.id.asc(),
        )
        .all()
    ):
        grouped.setdefault(step.sequence_id, []).append(step)
    return [_to_out(db, row, grouped.get(row.id, [])) for row in rows]


@router.post("", response_model=SequenceOut)
def create_sequence(payload: SequencePayload, db: Session = Depends(get_db)) -> SequenceOut:
    name, config, steps = normalize_sequence(db, payload.name, payload.config, payload.steps)
    row = Sequence(
        id=str(uuid.uuid4()), name=name, description=payload.description, config=config
    )
    db.add(row)
    write_steps(db, row.id, steps)
    db.commit()
    db.refresh(row)
    return _to_out(db, row, _step_rows(db, row.id))


@router.get("/{sequence_id}", response_model=SequenceOut)
def get_sequence(sequence_id: str, db: Session = Depends(get_db)) -> SequenceOut:
    row = (
        alive(db.query(Sequence), Sequence)
        .filter(Sequence.id == sequence_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Sequence not found")
    return _to_out(db, row, _step_rows(db, row.id))


@router.put("/{sequence_id}", response_model=SequenceOut)
def update_sequence(
    sequence_id: str, payload: SequencePayload, db: Session = Depends(get_db)
) -> SequenceOut:
    row = (
        alive(db.query(Sequence), Sequence)
        .filter(Sequence.id == sequence_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Sequence not found")
    name, config, steps = normalize_sequence(
        db, payload.name, payload.config, payload.steps, exclude_id=row.id
    )
    # 整体替换：删旧步骤 + 改定义 + 写新步骤，单事务提交
    db.query(SequenceStep).filter(SequenceStep.sequence_id == row.id).delete(
        synchronize_session=False
    )
    row.name = name
    row.description = payload.description
    row.config = config
    write_steps(db, row.id, steps)
    db.commit()
    db.refresh(row)
    return _to_out(db, row, _step_rows(db, row.id))


@router.delete("/{sequence_id}")
def delete_sequence(sequence_id: str, db: Session = Depends(get_db)):
    # R6（§8.43）：删除 = 只给序列行打标记进回收站 —— **步骤一并留库**。
    # 改前是连步骤一起硬删，恢复无从谈起；现在步骤跟着宿主（同表分组、读侧
    # 只列活序列）自动隐藏，恢复序列即原样回来，彻底删除时才按外键清步骤
    # （routers/trash.py 的 children 级联）。二次删 404 口径不变。
    row = (
        alive(db.query(Sequence), Sequence)
        .filter(Sequence.id == sequence_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Sequence not found")
    mark_deleted(row)
    db.commit()
    return Response(status_code=204)


# ---- 运行（单槽 + 互斥）----


def _compile_wrap_factory():
    """D6-B: Runner 发送期「按配方重算外壳」的编译入口。

    请求作用域的 `db` 在 `start_sequence` 返回后即关闭，而 Runner 是后台线程、
    到步执行时才编译 → 入口每次自开独立会话（同一 SessionLocal/engine），
    不会持有已失效的请求会话。
    """

    def compile_wrap(recipe_id: str, kernel_hex: str) -> str:
        session = SessionLocal()
        try:
            out = compile_recipe(session, recipe_id, [kernel_hex])
            return str(out.get("hex") or "").replace(" ", "")
        finally:
            session.close()

    return compile_wrap


@router.post("/{sequence_id}/start", response_model=SequenceStatus)
def start_sequence(sequence_id: str, db: Session = Depends(get_db)) -> SequenceStatus:
    row = (
        alive(db.query(Sequence), Sequence)
        .filter(Sequence.id == sequence_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Sequence not found")
    # 互斥第一道（快速失败）；claim 内的锁为兜底（竞态 → SequenceBusy 同 409）
    if sequence_runner.is_running():
        raise diag.http(
            409, "序列运行中，先停止当前序列再启动",
            "sequence", "SEQUENCE_RUNNING", data_sent=False,
        )
    step_rows = _step_rows(db, row.id)
    if not step_rows:
        raise diag.http(
            400, "序列没有步骤，无法启动",
            "sequence", "SEQUENCE_EMPTY", target=str(sequence_id), data_sent=False,
        )

    steps = []
    for i, step in enumerate(step_rows):
        try:
            # 启动前重归一（防库内脏数据直连改库绕过保存口校验）
            data, plan = normalize_plan(step.payload, step.plan)
        except ValueError as e:
            raise diag.http_from(
                e, 400, f"步骤 {i + 1} 数据非法：{e}",
                "plan", "STEP_DATA_INVALID",
                target=step.id or f"steps[{i}]", step=i + 1, data_sent=False,
            )
        steps.append({
            "id": step.id,
            "instruction_id": step.instruction_id,
            "label": step.label,
            "delay_ms": step.delay_ms,
            # 已归一的帧字节（Runner/apply_plan 只认 bytes；库里存 hex 文本）
            "payload": data,
            "plan": plan,
        })
    config = _normalize_config(row.config or {})
    try:
        snap = sequence_runner.start(
            row.id, row.name, steps, config, compile_wrap=_compile_wrap_factory()
        )
    except sequence_runner.SequenceBusy as e:
        raise diag.http(
            409, str(e), "sequence", "SEQUENCE_RUNNING", data_sent=False,
        )
    return SequenceStatus(**snap)
