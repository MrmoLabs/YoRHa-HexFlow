import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.core import response_match, sequence_runner, transport
from backend.core.escape import escape_hex, table_from_config
from backend.core.frame_builder import build_wrapped
from backend.db.database import get_db
from backend.db.log_store import safe_log
from backend.db.models import ResponseSpec, ProtocolTemplate
from backend.routers.export import hex_to_bytes

router = APIRouter(prefix="/dispatch", tags=["dispatch"])

# Send history (bounded): frames are dispatched through the E2 transport
# abstraction (loopback default / tcp / serial) and recorded with three
# kinds of events — raw / response / error (E2-T4).
_MAX_HISTORY = 100
_history: deque = deque(maxlen=_MAX_HISTORY)


class WrapSpec(BaseModel):
    """批次一 1c (D4-A): 可选封装 —— hex_string 视作已编码内核载荷（单条），
    发送前经后端唯一封装入口 build_wrapped 套上协议外壳。

    slot_id 显式指定插槽（存协议原始 id，绑定表同源）优先；缺省则按
    slot_order 起的稠密位次（同协议组内 0..n-1 位次，绑定 slot_order 同源）。
    wrap 缺省 → 裸帧路径与既有行为逐字节一致（§0 硬约束）。

    批次二 (D14③): **多载荷组**（编排页「封装试发」一组 N 条指令）——
    `payloads` 给出 N 条内核 hex + `slot_ids`/`start_order` 洞序，此时
    `hex_string` 不参与（仍必填，Pydantic 约束；语义见 dispatch_frame）。
    层位与单条完全一致：**逐条内核先转义 → 再串行套壳**，外壳字面不转。"""

    protocol_id: str
    slot_id: Optional[str] = None
    slot_order: Optional[int] = None
    # 批次二 (D14③): 多载荷组（缺省 None → 单条路径逐字节不变）
    payloads: Optional[List[str]] = None
    slot_ids: Optional[List[Optional[str]]] = None
    start_order: Optional[int] = None


class DispatchRequest(BaseModel):
    # 批次二 (D14③): 与 wrap.payloads **二选一** —— 编排页「封装试发」一组 N 条
    # 内核载荷走 payloads（可不带 hex_string）；缺省裸帧/单条内核路径不变。
    hex_string: Optional[str] = Field(
        None,
        description="Assembled hex stream to send (wrap 单条时为内核载荷；多载荷组改给 wrap.payloads)",
    )
    instruction_name: Optional[str] = Field(None, description="Source instruction label")
    wrap: Optional[WrapSpec] = Field(None, description="批次一: 可选协议封装（缺省裸帧）")


class DispatchEvent(BaseModel):
    """One send-history event: raw frame, response bytes, or error (E2-T4)."""

    type: str  # "raw" | "response" | "error"
    hex_string: Optional[str] = None  # raw/response payload, space-separated uppercase
    message: Optional[str] = None  # error reason


class DispatchRecord(BaseModel):
    id: int
    timestamp: str
    channel: str  # LOOPBACK / TCP / SERIAL (transport mode, default LOOPBACK)
    status: str  # SENT / ERROR
    byte_count: int
    hex_string: str
    instruction_name: Optional[str] = None
    echo: str  # response bytes, compact uppercase hex (loopback = payload echo)
    # 批次二 (D3): 封装期溢出/欠载/超上限告警（append/zero_fill 路径）——
    # 与 /compile/wrapped 的 warnings 同源同文案；reject 路径已在 400 detail。
    warnings: List[str] = Field(default_factory=list)
    events: List[DispatchEvent] = Field(default_factory=list)


def _spaced(data: bytes) -> str:
    return " ".join(f"{b:02X}" for b in data)


def append_history(record: DispatchRecord) -> None:
    """公开入栈口：/logs 回放复用三事件口径（不外泄 _history 私有态）。"""
    _history.appendleft(record)


def _apply_wrap(
    wrap: WrapSpec,
    payloads: List[str],
    db: Session,
    slot_ids: Optional[List[Optional[str]]] = None,
    start_order: Optional[int] = None,
) -> dict:
    """批次一 1c: wrap → build_wrapped（单 payload：slot_id 显式优先，否则
    稠密位次 start_order=slot_order）。协议 404 / 语义 400（含批次二
    fit_policy=reject）原样透出；返回 build_wrapped 全结果 —— 调用方取
    `hex` 终检、`warnings` 交回执（批次二 D3 溢出/欠载徽标）。"""
    protocol = db.query(ProtocolTemplate) \
        .filter(ProtocolTemplate.id == wrap.protocol_id).first()
    if protocol is None:
        raise HTTPException(status_code=404, detail="Protocol not found")
    if slot_ids is None:
        slot_ids = [wrap.slot_id] if wrap.slot_id else None
    if start_order is None:
        start_order = wrap.slot_order or 0
    try:
        return build_wrapped(
            protocol.children or [],
            payloads,
            slot_ids=slot_ids,
            start_order=start_order,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/", response_model=DispatchRecord)
def dispatch_frame(request: DispatchRequest, db: Session = Depends(get_db)):
    # P3 互斥：序列运行期禁止手动发送（Runner 直连 transport 不经此路由，无自锁）
    if sequence_runner.is_running():
        raise HTTPException(status_code=409, detail="序列运行中，手动发送已互斥（先停止序列）")
    # 批次一 1c: wrap 存在 → hex_string 视作内核载荷，先封装再终检 hex
    # （wrap 缺省 → 下方裸帧路径与既有行为逐字节一致，§0 硬约束）。
    # N4 (G3): 出线前先对**内核**按转义表转义、再套壳（外壳 FA…ED 字面不转；
    # 壳内 length/checksum 因此按线上字节计）—— 缺省关闭 → 原样返回。
    # 批次二 (D14③ 转义层位统一): 单条与多载荷组（编排页「封装试发」）共用同
    # 一条层位规则 = **逐条内核先转义 → 再套壳**。此前试发是「先 /compile/wrapped
    # 套完壳 → 再裸发」，escape 开启时会把整帧当内核转义，与本路由带 wrap 的
    # 「只转内核」语义不一致（两路径出字节不同）。
    table = table_from_config(transport.get_config())
    warnings: List[str] = []
    # 批次二 (D14③): hex_string 与 wrap.payloads 二选一（都不给 → 400，早于任何
    # 转义/封装，避免拿 None 去 escape）
    multi = request.wrap.payloads if (request.wrap is not None and request.wrap.payloads is not None) else None
    if multi is None and request.hex_string is None:
        raise HTTPException(status_code=400, detail="hex_string 与 wrap.payloads 至少提供一个")
    try:
        if multi is not None:
            escaped = [escape_hex(p, table) for p in multi]
            wrapped = _apply_wrap(
                request.wrap,
                escaped,
                db,
                slot_ids=request.wrap.slot_ids,
                start_order=request.wrap.start_order,
            )
            hex_string = wrapped["hex"]
            warnings = wrapped["warnings"]
        else:
            hex_string = escape_hex(request.hex_string, table)
            if request.wrap is not None:
                wrapped = _apply_wrap(request.wrap, [hex_string], db)
                hex_string = wrapped["hex"]
                warnings = wrapped["warnings"]
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid payload: {e}")
    try:
        data = hex_to_bytes(hex_string)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid payload: {e}")

    channel = transport.get_config()["mode"].upper()
    payload_spaced = _spaced(data)
    base = dict(
        id=int(time.time() * 1000),
        timestamp=datetime.now(timezone.utc).isoformat(),
        channel=channel,
        byte_count=len(data),
        hex_string=payload_spaced,
        instruction_name=request.instruction_name,
        warnings=warnings,
    )

    try:
        response = transport.send(data)
    except transport.TransportError as e:
        # Error event: the raw frame we attempted to send + failure reason.
        _history.appendleft(DispatchRecord(
            status="ERROR",
            echo="",
            events=[
                DispatchEvent(type="raw", hex_string=payload_spaced),
                DispatchEvent(type="error", message=str(e)),
            ],
            **base,
        ))
        # P5 落库：手动路 ERROR（safe_log 旁路 —— 直调未传 db 时跳过，写失败不反噬响应）
        safe_log(
            db, source="manual", status="ERROR", channel=channel,
            hex_string=payload_spaced, echo="", byte_count=len(data),
            instruction_name=request.instruction_name, error=str(e),
        )
        raise HTTPException(status_code=502, detail=f"Transport error: {e}")

    record = DispatchRecord(
        status="SENT",
        echo=response.hex().upper(),
        events=[
            DispatchEvent(type="raw", hex_string=payload_spaced),
            DispatchEvent(type="response", hex_string=_spaced(response)),
        ],
        **base,
    )
    _history.appendleft(record)
    # P5 落库：手动路 OK（error 保持 NULL）
    safe_log(
        db, source="manual", status="OK", channel=channel,
        hex_string=payload_spaced, echo=record.echo, byte_count=len(data),
        instruction_name=request.instruction_name,
    )
    return record


@router.get("/history", response_model=List[DispatchRecord])
def dispatch_history(limit: int = 50):
    limit = max(1, min(limit, _MAX_HISTORY))
    return list(_history)[:limit]


@router.delete("/history")
def clear_history():
    _history.clear()
    return {"status": "cleared", "remaining": len(_history)}


# ---- P2 事务化发送引擎 ----
# 超时 → 按间隔重发 N 次（retries = 重发次数，总尝试 = retries + 1）；广播（broadcast）
# 无应答语义：读侧 1ms 立即放弃、不判匹配（协议层保证广播帧不回包）。规格解析优先级：
# 内联 response_spec > response_specs[instruction_id] > 缺省 echo。响应恒 200（成败在
# status 字段，保住逐次 attempt 明细），校验类错误仍 400；同时按 raw/response/error
# 三事件口径写入 /dispatch/history（状态仍 SENT/ERROR，Terminal 历史面板直接可见）。


class TransactionRequest(BaseModel):
    hex_string: str = Field(..., description="Assembled hex stream to send (wrap 存在时为内核载荷)")
    instruction_name: Optional[str] = Field(None, description="Source instruction label")
    instruction_id: Optional[str] = Field(None, description="逻辑外键 → instructions.id（规格解析）")
    wrap: Optional[WrapSpec] = Field(None, description="批次一: 可选协议封装（缺省裸帧）")
    response_spec: Optional[Dict[str, Any]] = Field(
        None, description="内联规格覆盖（优先于按指令持久化的规格）"
    )
    timeout_ms: int = Field(500, description="单次 attempt 读超时（ms）")
    retries: int = Field(2, description="失配/无应答后的重发次数（总尝试 = retries + 1）")
    interval_ms: int = Field(50, description="相邻 attempt 间隔（ms）")
    broadcast: bool = Field(False, description="广播：无应答语义，不判匹配")


class TransactionAttempt(BaseModel):
    n: int
    status: str  # OK | NO_RESPONSE | MATCH_FAILED | TRANSPORT_ERROR
    sent: str  # space-separated uppercase
    received: str  # space-separated uppercase（无应答为空串）
    rtt_ms: float  # 本次发送到判定的耗时（无应答 ≈ 读超时）
    reasons: List[str] = Field(default_factory=list)  # MATCH_FAILED 的失配原因
    error: Optional[str] = None  # TRANSPORT_ERROR 原因


class TransactionStats(BaseModel):
    attempts: int
    # RTT 聚合只统计「拿到字节」的 attempt（无应答的耗时是超时不是往返）；无样本 → None
    rtt_ms_last: Optional[float] = None
    rtt_ms_avg: Optional[float] = None
    rtt_ms_max: Optional[float] = None


class TransactionRecord(BaseModel):
    id: int
    timestamp: str
    channel: str  # LOOPBACK / TCP / SERIAL
    status: str  # OK | FAILED
    byte_count: int
    hex_string: str  # 请求帧 space-separated
    instruction_name: Optional[str] = None
    instruction_id: Optional[str] = None
    spec_source: str  # inline | instruction | default
    broadcast: bool
    echo: str  # 末次应答 compact hex（无 → ""）
    attempts: List[TransactionAttempt]
    stats: TransactionStats


def _bounded_int(value, name: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise HTTPException(
            status_code=400, detail=f"Invalid transaction params: {name} 必须是整数"
        )
    if not (lo <= value <= hi):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid transaction params: {name} 必须在 {lo}..{hi} 范围内",
        )
    return value


def _resolve_spec(request: TransactionRequest, db) -> tuple:
    """规格解析：内联 > 按指令持久化 > 缺省 echo。返回 (归一化 spec, source)。"""
    if request.response_spec is not None:
        try:
            return response_match.normalize_spec(request.response_spec), "inline"
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"Invalid response spec: {e}")
    if request.instruction_id:
        row = (
            db.query(ResponseSpec)
            .filter(ResponseSpec.instruction_id == request.instruction_id)
            .first()
        )
        if row is not None:
            try:
                return response_match.normalize_spec(row.spec), "instruction"
            except ValueError as e:
                raise HTTPException(
                    status_code=400, detail=f"Stored response spec invalid: {e}"
                )
    return response_match.default_spec(), "default"


@router.post("/transaction", response_model=TransactionRecord)
def dispatch_transaction(request: TransactionRequest, db: Session = Depends(get_db)):
    # P3 互斥：序列运行期禁止手动事务发送（与 dispatch_frame 同口径）
    if sequence_runner.is_running():
        raise HTTPException(status_code=409, detail="序列运行中，手动发送已互斥（先停止序列）")
    # 批次一 1c: 与 dispatch_frame 同口径 —— wrap 先封装、hex 终检在后
    # N4 (G3): 与 dispatch_frame 同口径 —— 内核先转义再套壳（缺省关闭原样）
    try:
        hex_string = escape_hex(
            request.hex_string, table_from_config(transport.get_config())
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid payload: {e}")
    if request.wrap is not None:
        hex_string = _apply_wrap(request.wrap, [hex_string], db)["hex"]
    try:
        data = hex_to_bytes(hex_string)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid payload: {e}")

    timeout_ms = _bounded_int(request.timeout_ms, "timeout_ms", 1, 60000)
    retries = _bounded_int(request.retries, "retries", 0, 10)
    interval_ms = _bounded_int(request.interval_ms, "interval_ms", 0, 60000)
    spec, spec_source = _resolve_spec(request, db)

    channel = transport.get_config()["mode"].upper()
    payload_spaced = _spaced(data)
    broadcast = bool(request.broadcast)
    max_attempts = 1 + retries
    attempts: List[TransactionAttempt] = []
    last_received = b""

    for n in range(1, max_attempts + 1):
        started = time.perf_counter()
        try:
            # 广播：读侧 1ms 放弃（无应答语义），非广播用事务级读超时
            received = transport.send(
                data, read_timeout_ms=1 if broadcast else timeout_ms
            )
        except transport.TransportError as e:
            attempts.append(TransactionAttempt(
                n=n,
                status="TRANSPORT_ERROR",
                sent=payload_spaced,
                received="",
                rtt_ms=round((time.perf_counter() - started) * 1000, 2),
                error=str(e),
            ))
        else:
            rtt = round((time.perf_counter() - started) * 1000, 2)
            if broadcast:
                last_received = received
                attempts.append(TransactionAttempt(
                    n=n, status="OK", sent=payload_spaced,
                    received=_spaced(received), rtt_ms=rtt,
                ))
            elif not received:
                attempts.append(TransactionAttempt(
                    n=n, status="NO_RESPONSE", sent=payload_spaced,
                    received="", rtt_ms=rtt,
                ))
            else:
                last_received = received
                ok, reasons = response_match.match_response(spec, data, received)
                attempts.append(TransactionAttempt(
                    n=n, status="OK" if ok else "MATCH_FAILED",
                    sent=payload_spaced, received=_spaced(received), rtt_ms=rtt,
                    reasons=[] if ok else reasons,
                ))
        if attempts[-1].status == "OK":
            break
        if n < max_attempts and interval_ms:
            time.sleep(interval_ms / 1000)

    status = "OK" if attempts[-1].status == "OK" else "FAILED"
    last = attempts[-1]
    rtts = [a.rtt_ms for a in attempts if a.received]
    record = TransactionRecord(
        id=int(time.time() * 1000),
        timestamp=datetime.now(timezone.utc).isoformat(),
        channel=channel,
        status=status,
        byte_count=len(data),
        hex_string=payload_spaced,
        instruction_name=request.instruction_name,
        instruction_id=request.instruction_id,
        spec_source=spec_source,
        broadcast=broadcast,
        echo=last_received.hex().upper(),
        attempts=attempts,
        stats=TransactionStats(
            attempts=len(attempts),
            rtt_ms_last=rtts[-1] if rtts else None,
            rtt_ms_avg=round(sum(rtts) / len(rtts), 2) if rtts else None,
            rtt_ms_max=max(rtts) if rtts else None,
        ),
    )

    # 写 /dispatch/history：状态与事件类型沿用 SENT/ERROR + raw/response/error 口径
    # （P5：reason 提升两用 —— history 文案与落库 error 同源，格式不变）
    reason: Optional[str] = None
    if status == "OK":
        history_status = "SENT"
        history_events = [
            DispatchEvent(type="raw", hex_string=payload_spaced),
            DispatchEvent(type="response", hex_string=_spaced(last_received)),
        ]
    else:
        history_status = "ERROR"
        reason = f"TRANSACTION FAILED ×{len(attempts)}: {last.status}"
        if last.reasons:
            reason += f" [{', '.join(last.reasons)}]"
        if last.error:
            reason += f" ({last.error})"
        history_events = [
            DispatchEvent(type="raw", hex_string=payload_spaced),
            DispatchEvent(type="error", message=reason),
        ]
    _history.appendleft(DispatchRecord(
        id=record.id,
        timestamp=record.timestamp,
        channel=channel,
        status=history_status,
        byte_count=len(data),
        hex_string=payload_spaced,
        instruction_name=request.instruction_name,
        echo=record.echo,
        events=history_events,
    ))
    # P5 落库：事务路（status 归一 OK/ERROR，error 与 history 文案同源）
    safe_log(
        db, source="transaction",
        status="OK" if status == "OK" else "ERROR",
        channel=channel, hex_string=payload_spaced, echo=record.echo,
        byte_count=len(data),
        instruction_name=request.instruction_name,
        instruction_id=request.instruction_id,
        rtt_ms=record.stats.rtt_ms_last,
        error=reason,
    )
    return record
