import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from backend.core import sequence_runner
from backend.core.sequence_plan import normalize_plan
from backend.db.database import get_db
from backend.db.models import Sequence, SequenceStep
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


def _normalize_steps(steps: List[SequenceStepSpec]) -> List[dict]:
    """步骤列表归一：边界 + normalize_plan（payload/plan 形态 SSOT）。"""
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
        try:
            data, plan = normalize_plan(step.payload, step.plan)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"{where}: {e}")
        normalized.append({
            "instruction_id": instruction_id,
            "label": label,
            "delay_ms": delay,
            "params": step.params,
            "payload": data.hex().upper(),
            "plan": plan,
        })
    return normalized


def _write_steps(db: Session, sequence_id: str, steps: List[dict]) -> None:
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
        ))


def _step_rows(db: Session, sequence_id: str) -> List[SequenceStep]:
    return (
        db.query(SequenceStep)
        .filter(SequenceStep.sequence_id == sequence_id)
        .order_by(SequenceStep.step_order.asc(), SequenceStep.id.asc())
        .all()
    )


def _to_out(row: Sequence, step_rows: List[SequenceStep]) -> SequenceOut:
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
                label=s.label,
                delay_ms=s.delay_ms,
                params=s.params,
                payload=s.payload,
                plan=s.plan,
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
    rows = db.query(Sequence).order_by(Sequence.name.asc(), Sequence.id.asc()).all()
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
    return [_to_out(row, grouped.get(row.id, [])) for row in rows]


@router.post("", response_model=SequenceOut)
def create_sequence(payload: SequencePayload, db: Session = Depends(get_db)) -> SequenceOut:
    name = _checked_name(db, payload.name)
    config = _normalize_config(payload.config)
    steps = _normalize_steps(payload.steps)
    row = Sequence(
        id=str(uuid.uuid4()), name=name, description=payload.description, config=config
    )
    db.add(row)
    _write_steps(db, row.id, steps)
    db.commit()
    db.refresh(row)
    return _to_out(row, _step_rows(db, row.id))


@router.get("/{sequence_id}", response_model=SequenceOut)
def get_sequence(sequence_id: str, db: Session = Depends(get_db)) -> SequenceOut:
    row = db.query(Sequence).filter(Sequence.id == sequence_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Sequence not found")
    return _to_out(row, _step_rows(db, row.id))


@router.put("/{sequence_id}", response_model=SequenceOut)
def update_sequence(
    sequence_id: str, payload: SequencePayload, db: Session = Depends(get_db)
) -> SequenceOut:
    row = db.query(Sequence).filter(Sequence.id == sequence_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Sequence not found")
    name = _checked_name(db, payload.name, exclude_id=row.id)
    config = _normalize_config(payload.config)
    steps = _normalize_steps(payload.steps)
    # 整体替换：删旧步骤 + 改定义 + 写新步骤，单事务提交
    db.query(SequenceStep).filter(SequenceStep.sequence_id == row.id).delete(
        synchronize_session=False
    )
    row.name = name
    row.description = payload.description
    row.config = config
    _write_steps(db, row.id, steps)
    db.commit()
    db.refresh(row)
    return _to_out(row, _step_rows(db, row.id))


@router.delete("/{sequence_id}")
def delete_sequence(sequence_id: str, db: Session = Depends(get_db)):
    row = db.query(Sequence).filter(Sequence.id == sequence_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Sequence not found")
    db.query(SequenceStep).filter(SequenceStep.sequence_id == row.id).delete(
        synchronize_session=False
    )
    db.delete(row)
    db.commit()
    return Response(status_code=204)


# ---- 运行（单槽 + 互斥）----


@router.post("/{sequence_id}/start", response_model=SequenceStatus)
def start_sequence(sequence_id: str, db: Session = Depends(get_db)) -> SequenceStatus:
    row = db.query(Sequence).filter(Sequence.id == sequence_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Sequence not found")
    # 互斥第一道（快速失败）；claim 内的锁为兜底（竞态 → SequenceBusy 同 409）
    if sequence_runner.is_running():
        raise HTTPException(status_code=409, detail="序列运行中，先停止当前序列再启动")
    step_rows = _step_rows(db, row.id)
    if not step_rows:
        raise HTTPException(status_code=400, detail="序列没有步骤，无法启动")

    steps = []
    for i, step in enumerate(step_rows):
        try:
            # 启动前重归一（防库内脏数据直连改库绕过保存口校验）
            data, plan = normalize_plan(step.payload, step.plan)
        except ValueError as e:
            raise HTTPException(
                status_code=400, detail=f"步骤 {i + 1} 数据非法：{e}"
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
        snap = sequence_runner.start(row.id, row.name, steps, config)
    except sequence_runner.SequenceBusy as e:
        raise HTTPException(status_code=409, detail=str(e))
    return SequenceStatus(**snap)
