"""P5 /logs：通讯日志（新表 dispatch_logs）的查询 / 导出 / 回放 / 清空读侧。

- 查询：id 降序（新在前）；limit 1..1000 静默钳制（同 /dispatch/history 先例）、
  source / status 过滤（非法值 400，业务口径 detail 为 SSOT）。
- 导出：GET /logs/export?format=csv|json —— 同过滤参数、无行数上限（导出即
  归档语义）；csv 带 utf-8 BOM（Excel 直开中文不乱码）+ 附件头，json = 与
  列表同形的数组。
- 回放：POST /logs/{id}/replay 重发存档帧，走**现行**传输配置（存档 channel
  仅记录当时通道）。口径同 POST /dispatch：序列运行期 409 互斥（同文案）、
  200 SENT / 502 传输错；成败皆入 /dispatch/history（三事件口径）并写新日志行
  source=replay（延续 instruction_name/id，不挂 sequence/step）。
- DELETE /logs 清空（形态同 DELETE /dispatch/history）。
"""
import csv
import io
import json
import time
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.core import sequence_runner, transport
from backend.db.database import get_db
from backend.db.models import DispatchLog
from backend.db.log_store import VALID_SOURCES, VALID_STATUSES, safe_log
from backend.routers.dispatch import DispatchEvent, DispatchRecord, append_history
from backend.routers.export import hex_to_bytes

router = APIRouter(prefix="/logs", tags=["logs"])

_LIMIT_MAX = 1000
_CSV_COLUMNS = (
    "id", "created_at", "source", "channel", "status", "byte_count",
    "hex_string", "echo", "instruction_name", "instruction_id",
    "sequence_id", "step_order", "rtt_ms", "error",
)


class DispatchLogOut(BaseModel):
    id: int
    created_at: str  # ISO-8601 UTC
    source: str  # manual | transaction | sequence | replay
    channel: str  # 发送时通道 LOOPBACK / TCP / SERIAL
    status: str  # OK | ERROR（历史 SENT/FAILED 归一）
    byte_count: int
    hex_string: str  # space-separated uppercase
    echo: str  # compact uppercase（无 = ""）
    instruction_name: Optional[str] = None
    instruction_id: Optional[str] = None
    sequence_id: Optional[str] = None
    step_order: Optional[int] = None  # 1-based（仅序列路）
    rtt_ms: Optional[float] = None
    error: Optional[str] = None


def _query(db: Session, source: Optional[str], status: Optional[str], limit: Optional[int] = None):
    """过滤 + id 降序查询（过滤值非法 → 400；limit=None = 不封顶，导出口径）。"""
    query = db.query(DispatchLog)
    if source is not None:
        if source not in VALID_SOURCES:
            raise HTTPException(status_code=400, detail=f"source 非法: {source}")
        query = query.filter(DispatchLog.source == source)
    if status is not None:
        if status not in VALID_STATUSES:
            raise HTTPException(status_code=400, detail=f"status 非法: {status}")
        query = query.filter(DispatchLog.status == status)
    query = query.order_by(DispatchLog.id.desc())
    if limit is not None:
        query = query.limit(limit)
    return query.all()


def _row_dict(row: DispatchLog) -> dict:
    return {key: getattr(row, key) for key in _CSV_COLUMNS}


@router.get("", response_model=List[DispatchLogOut])
def list_logs(
    limit: int = 50,
    source: Optional[str] = None,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
) -> List[DispatchLogOut]:
    limit = max(1, min(_LIMIT_MAX, limit))
    return _query(db, source, status, limit=limit)


@router.get("/export")
def export_logs(
    format: str = "csv",
    source: Optional[str] = None,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
) -> Response:
    if format not in ("csv", "json"):
        raise HTTPException(status_code=400, detail="format 必须是 csv 或 json")
    items = [_row_dict(row) for row in _query(db, source, status)]
    if format == "json":
        return Response(
            content=json.dumps(items, ensure_ascii=False).encode("utf-8"),
            media_type="application/json; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="dispatch_logs.json"'},
        )
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=_CSV_COLUMNS, extrasaction="ignore")
    writer.writeheader()
    for item in items:
        writer.writerow({key: ("" if item[key] is None else item[key]) for key in _CSV_COLUMNS})
    # 显式写入 U+FEFF（utf-8 BOM）：Excel 直开中文列名/内容不乱码
    return Response(
        content=("\ufeff" + buf.getvalue()).encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="dispatch_logs.csv"'},
    )


@router.post("/{log_id}/replay", response_model=DispatchRecord)
def replay_log(log_id: int, db: Session = Depends(get_db)) -> DispatchRecord:
    # 回放 = 手动发送存档帧：互斥与文案同 POST /dispatch
    if sequence_runner.is_running():
        raise HTTPException(status_code=409, detail="序列运行中，手动发送已互斥（先停止序列）")
    row = db.query(DispatchLog).filter(DispatchLog.id == log_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail=f"日志不存在：{log_id}")
    try:
        data = hex_to_bytes(row.hex_string)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"存档帧非法: {e}")

    channel = transport.get_config()["mode"].upper()
    payload_spaced = " ".join(f"{b:02X}" for b in data)
    base = dict(
        id=int(time.time() * 1000),
        timestamp=datetime.now(timezone.utc).isoformat(),
        channel=channel,
        byte_count=len(data),
        hex_string=payload_spaced,
        instruction_name=row.instruction_name,
    )
    common = dict(
        source="replay",
        channel=channel,
        hex_string=payload_spaced,
        byte_count=len(data),
        instruction_name=row.instruction_name,
        instruction_id=row.instruction_id,
    )
    try:
        response = transport.send(data)
    except transport.TransportError as e:
        record = DispatchRecord(
            status="ERROR",
            echo="",
            events=[
                DispatchEvent(type="raw", hex_string=payload_spaced),
                DispatchEvent(type="error", message=str(e)),
            ],
            **base,
        )
        append_history(record)
        safe_log(db, status="ERROR", echo="", error=str(e), **common)
        raise HTTPException(status_code=502, detail=f"Transport error: {e}")

    record = DispatchRecord(
        status="SENT",
        echo=response.hex().upper(),
        events=[
            DispatchEvent(type="raw", hex_string=payload_spaced),
            DispatchEvent(
                type="response",
                hex_string=" ".join(f"{b:02X}" for b in response),
            ),
        ],
        **base,
    )
    append_history(record)
    safe_log(db, status="OK", echo=record.echo, **common)
    return record


@router.delete("")
def clear_logs(db: Session = Depends(get_db)) -> dict:
    db.query(DispatchLog).delete()
    db.commit()
    return {"status": "cleared", "remaining": db.query(DispatchLog).count()}
