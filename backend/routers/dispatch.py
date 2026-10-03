import re
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.core import diagnostics as diag
from backend.core import response_match, sequence_runner, transport
from backend.core.escape import escape_hex, table_from_config, unescape_bytes
from backend.core.frame_builder import build_wrapped
from backend.core.recipe_compile import compile_recipe
from backend.core.diagnostics import Diagnostic
from backend.db.database import get_db
from backend.db.log_store import resolve_log_fields, safe_log
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
    层位与单条完全一致：**逐条内核先转义 → 再串行套壳**，外壳字面不转。

    CP3 3a (D13): 增 `recipe_id` —— 与 `protocol_id` **互斥**（都不给 → 400），
    配方路径逐层串行套壳（`core/recipe_compile.py`，与 `/compile/wrapped`
    同一份实现 → 预览与出线同字节）；该路径下 `slot_ids`/`slot_order` 归配方
    阶段所有、`start_order` 只作用于第 0 层。缺省（不带 wrap）裸帧逐字节不变。"""

    protocol_id: Optional[str] = None
    recipe_id: Optional[str] = None
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
    # R10（§8.48 · C-2 选 C 后半）：命中应答按**指令字段布局**逆向解出的
    # 「字段 = 值」快照 —— 形状与 `core.field_decode` 返回值 / `dispatch_logs.fields_json`
    # 逐字相同（同一次解码，两处落同一份）。缺省 None = 解不出（无应答 / 指令查不到 /
    # 无字段布局），展示层退回 R9 客户端解码兜底 —— 只做加法，不改任何既有键。
    fields: Optional[Dict[str, Any]] = None


def _spaced(data: bytes) -> str:
    return " ".join(f"{b:02X}" for b in data)


def _transaction_diagnostic(last, byte_count: int) -> Optional[Diagnostic]:
    """失败事务 → 结构化诊断（成功 / 广播 OK → None）。

    三态是硬件联调最常问的三件事：**帧到底出没出去**（`data_sent`）、
    **出去了有没有回**（NO_RESPONSE）、**回了但对不上哪一条**（MATCH_FAILED，
    `STAGE[i]` 前缀翻译成层号，与「第 N 层」/配方 stage 同序：1 = stage 0）。
    """
    if last.status == "TRANSPORT_ERROR":
        return Diagnostic(
            stage="transport",
            code="TRANSPORT_ERROR",
            message=last.error or "transport error",
            data_sent=False,
            byte_count=byte_count,
        )
    if last.status == "NO_RESPONSE":
        return Diagnostic(
            stage="match",
            code="NO_RESPONSE",
            message=f"第 {last.n} 次尝试无应答（帧已发送 {byte_count} 字节）",
            data_sent=True,
            byte_count=byte_count,
        )
    if last.status == "MATCH_FAILED":
        reasons = list(last.reasons or [])
        layer = None
        for reason in reasons:
            m = re.match(r"STAGE\[(\d+)\]", str(reason))
            if m:
                layer = int(m.group(1)) + 1
                break
        return Diagnostic(
            stage="match",
            code="MATCH_FAILED",
            message="; ".join(str(r) for r in reasons) or "match failed",
            target=str(reasons[0]) if reasons else None,
            layer=layer,
            data_sent=True,
            byte_count=byte_count,
        )
    return None


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
    `hex` 终检、`warnings` 交回执（批次二 D3 溢出/欠载徽标）。

    CP3 3a (D13): `wrap.recipe_id` 分支 —— 配方逐层串行套壳（与
    `/compile/wrapped` 共用 `core/recipe_compile.py`，故预览与出线**同字节**）；
    与 `protocol_id` 互斥、都不给 → 400。配方路径下 `slot_ids`/`slot_order`
    归配方阶段所有（此处忽略），`start_order` 只作用于第 0 层。"""
    if wrap.recipe_id and wrap.protocol_id:
        raise diag.http(
            400, "protocol_id 与 recipe_id 互斥，只能指定一个",
            "wrap", "WRAP_SPEC_EXCLUSIVE",
            target=wrap.recipe_id or wrap.protocol_id, data_sent=False,
        )
    if wrap.recipe_id:
        return compile_recipe(
            db,
            wrap.recipe_id,
            payloads,
            start_order=start_order or 0,
        )
    if not wrap.protocol_id:
        raise diag.http(
            400, "wrap 须指定 protocol_id 或 recipe_id",
            "wrap", "WRAP_SPEC_MISSING", data_sent=False,
        )
    protocol = db.query(ProtocolTemplate) \
        .filter(ProtocolTemplate.id == wrap.protocol_id).first()
    if protocol is None:
        raise diag.http(
            404, "Protocol not found",
            "wrap", "WRAP_PROTOCOL_NOT_FOUND",
            target=wrap.protocol_id, data_sent=False,
        )
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
        # 单协议路径无层号；配方路径的 DiagError（带层号）由 http_from 保留
        raise diag.http_from(
            e, 400, str(e), "wrap", "WRAP_REJECTED",
            target=wrap.protocol_id, data_sent=False,
        )


@router.post("/", response_model=DispatchRecord)
def dispatch_frame(request: DispatchRequest, db: Session = Depends(get_db)):
    # P3 互斥：序列运行期禁止手动发送（Runner 直连 transport 不经此路由，无自锁）
    if sequence_runner.is_running():
        raise diag.http(
            409, "序列运行中，手动发送已互斥（先停止序列）",
            "sequence", "SEQUENCE_RUNNING", data_sent=False,
        )
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
        raise diag.http(
            400, "hex_string 与 wrap.payloads 至少提供一个",
            "encode", "PAYLOAD_MISSING", data_sent=False,
        )
    # 诊断分层（PLAN §8.32）：转义与封装拆成两段 try —— detail 文案与操作顺序
    # 与拆分前逐字一致，只是 400 现在能说清是**转义层**还是**封装层**拒的。
    try:
        if multi is not None:
            escaped = [escape_hex(p, table) for p in multi]
        else:
            escaped = escape_hex(request.hex_string, table)
    except ValueError as e:
        raise diag.http_from(
            e, 400, f"Invalid payload: {e}",
            "escape", "ESCAPE_REJECTED", data_sent=False,
        )
    try:
        if multi is not None:
            wrapped = _apply_wrap(
                request.wrap,
                escaped,
                db,
                slot_ids=request.wrap.slot_ids,
                start_order=request.wrap.start_order,
            )
            hex_string = wrapped["hex"]
            warnings = wrapped["warnings"]
        elif request.wrap is not None:
            wrapped = _apply_wrap(request.wrap, [escaped], db)
            hex_string = wrapped["hex"]
            warnings = wrapped["warnings"]
        else:
            hex_string = escaped
    except ValueError as e:
        raise diag.http_from(
            e, 400, f"Invalid payload: {e}",
            "wrap", "WRAP_REJECTED", data_sent=False,
        )
    try:
        data = hex_to_bytes(hex_string)
    except ValueError as e:
        raise diag.http_from(
            e, 400, f"Invalid payload: {e}",
            "encode", "PAYLOAD_INVALID", data_sent=False,
        )

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
        # 诊断（§8.32）：传输层抛错 → data_sent=False（send 未完整返回，可能部分写入）
        raise diag.http(
            502, f"Transport error: {e}",
            "transport", "TRANSPORT_ERROR",
            data_sent=False, byte_count=len(data),
        )

    # R10 §8.48：解码**一次**，回执（history deque）与落库（fields_json）共用 ——
    # 两处绝不各算一遍，否则同一事件可能因指令后续被改而显示不同值。
    decoded = resolve_log_fields(
        db, response.hex().upper(), instruction_name=request.instruction_name
    )
    record = DispatchRecord(
        status="SENT",
        echo=response.hex().upper(),
        events=[
            DispatchEvent(type="raw", hex_string=payload_spaced),
            DispatchEvent(type="response", hex_string=_spaced(response)),
        ],
        fields=decoded,
        **base,
    )
    _history.appendleft(record)
    # P5 落库：手动路 OK（error 保持 NULL）
    safe_log(
        db, source="manual", status="OK", channel=channel,
        hex_string=payload_spaced, echo=record.echo, byte_count=len(data),
        instruction_name=request.instruction_name, fields=decoded,
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
    # §8.32 统一诊断：失败时给结构化定位（成功 = null）—— 区分「帧没出去」
    # （transport, data_sent=false）/「出去了没应答」（NO_RESPONSE, data_sent=true）
    # /「应答来了但失配」（MATCH_FAILED, data_sent=true，layer = STAGE[i] 层号）。
    diagnostic: Optional[Dict[str, Any]] = None


def _bounded_int(value, name: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise diag.http(
            400, f"Invalid transaction params: {name} 必须是整数",
            "param", "PARAM_INVALID", target=name, data_sent=False,
        )
    if not (lo <= value <= hi):
        raise diag.http(
            400,
            f"Invalid transaction params: {name} 必须在 {lo}..{hi} 范围内",
            "param", "PARAM_INVALID", target=name, data_sent=False,
        )
    return value


def _resolve_spec(request: TransactionRequest, db) -> tuple:
    """规格解析：内联 > 按指令持久化 > 缺省 echo。返回 (归一化 spec, source)。"""
    if request.response_spec is not None:
        try:
            return response_match.normalize_spec(request.response_spec), "inline"
        except ValueError as e:
            raise diag.http_from(
                e, 400, f"Invalid response spec: {e}",
                "spec", "SPEC_INVALID", target="response_spec", data_sent=False,
            )
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
                raise diag.http_from(
                    e, 400, f"Stored response spec invalid: {e}",
                    "spec", "SPEC_INVALID_STORED",
                    target=request.instruction_id, data_sent=False,
                )
    return response_match.default_spec(), "default"


@router.post("/transaction", response_model=TransactionRecord)
def dispatch_transaction(request: TransactionRequest, db: Session = Depends(get_db)):
    # P3 互斥：序列运行期禁止手动事务发送（与 dispatch_frame 同口径）
    if sequence_runner.is_running():
        raise diag.http(
            409, "序列运行中，手动发送已互斥（先停止序列）",
            "sequence", "SEQUENCE_RUNNING", data_sent=False,
        )
    # 批次一 1c: 与 dispatch_frame 同口径 —— wrap 先封装、hex 终检在后
    # N4 (G3): 与 dispatch_frame 同口径 —— 内核先转义再套壳（缺省关闭原样）
    # §8.35: 表同时喂给收侧 —— 应答按同一张表作「先线上、后逻辑」第二口径判定
    escape_table = table_from_config(transport.get_config())
    try:
        hex_string = escape_hex(request.hex_string, escape_table)
    except ValueError as e:
        raise diag.http_from(
            e, 400, f"Invalid payload: {e}",
            "escape", "ESCAPE_REJECTED", data_sent=False,
        )
    if request.wrap is not None:
        hex_string = _apply_wrap(request.wrap, [hex_string], db)["hex"]
    try:
        data = hex_to_bytes(hex_string)
    except ValueError as e:
        raise diag.http_from(
            e, 400, f"Invalid payload: {e}",
            "encode", "PAYLOAD_INVALID", data_sent=False,
        )

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
    # §8.35（销 §9.7 ④）：应答是否带转义字节 → 两种真机口径都收。转义表为空
    # （escape 缺省关闭）传 None ⇒ 单口径，判定与存量逐字节一致（§0 硬约束）。
    rx_unescape = (lambda b: unescape_bytes(b, escape_table)) if escape_table else None

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
                ok, reasons = response_match.match_response(
                    spec, data, received, unescape=rx_unescape
                )
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
    failure_diag = _transaction_diagnostic(last, len(data))
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
        diagnostic=failure_diag.to_dict() if failure_diag else None,
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
    # R10 §8.48：同 manual —— 解一次给回执 + 落库共用（事务带 id，解析更准）
    decoded = resolve_log_fields(
        db, record.echo,
        instruction_id=request.instruction_id,
        instruction_name=request.instruction_name,
    )
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
        fields=decoded,
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
        error=reason, fields=decoded,
    )
    return record
