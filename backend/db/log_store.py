"""P5 通讯日志落库：dispatch_logs 单表的写侧件。

- 写口三路 + 回放：routers/dispatch.py（manual / transaction，路由直持
  Session）、core/sequence_runner（sequence，经 set_log_hook 注入的回调）、
  routers/logs.py（replay）。
- 字段映射（语义 SSOT，各调用点按此填）：
    source      manual | transaction | sequence | replay
    status      OK | ERROR（历史 SENT/FAILED 归一；SKIPPED 步不落日志 = 未发生通讯）
    hex_string  实际发送帧 space-separated；sequence 的 PLAN 错误（未发出）落基础帧
    echo        末次应答 compact hex（无 = ""）
    instruction_name  手动标签 / 事务标签 / 序列步 label（缺省 step-N）
    instruction_id    事务规格指令 / 序列步指令（manual·replay 不带）
    sequence_id·step_order  仅 sequence 路（回放是独立发送，不挂回原序列）
    rtt_ms      事务 = 末次样本、序列 = 本步往返；manual·replay 为 NULL
- safe_log 为旁路观测：写失败 rollback 后忽略——帧已出线是既成事实，不反噬
  响应码（区别于 P1 transport persist_hook：配置未持久化必须失败，日志缺失不）。
- log_hook(session_factory)：为 core/sequence_runner.set_log_hook 造回调，
  每步独立会话（Runner 在 daemon 线程跑，不持有路由会话）。
"""
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from backend.db.models import DispatchLog

VALID_SOURCES = ("manual", "transaction", "sequence", "replay")
VALID_STATUSES = ("OK", "ERROR")


def record_log(db: Session, **fields) -> int:
    """插入一条通讯日志并提交，返回自增 id。字段非法 → ValueError（测试可见）。"""
    source = fields.get("source")
    if source not in VALID_SOURCES:
        raise ValueError(f"source 非法: {source!r}")
    status = fields.get("status")
    if status not in VALID_STATUSES:
        raise ValueError(f"status 非法: {status!r}")
    hex_string = str(fields.get("hex_string") or "")
    byte_count = fields.get("byte_count")
    row = DispatchLog(
        created_at=datetime.now(timezone.utc).isoformat(),
        source=source,
        channel=str(fields.get("channel") or ""),
        status=status,
        byte_count=int(byte_count) if byte_count is not None else len(hex_string.split()),
        hex_string=hex_string,
        echo=str(fields.get("echo") or ""),
        instruction_name=fields.get("instruction_name"),
        instruction_id=fields.get("instruction_id"),
        sequence_id=fields.get("sequence_id"),
        step_order=fields.get("step_order"),
        rtt_ms=fields.get("rtt_ms"),
        error=fields.get("error"),
    )
    db.add(row)
    db.commit()
    return int(row.id)


def safe_log(db, **fields) -> None:
    """旁路写：非 Session（直调未传 db，同既有测试口径）→ 跳过；写失败回滚后忽略。"""
    if not isinstance(db, Session):
        return
    try:
        record_log(db, **fields)
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass


def log_hook(session_factory):
    """为 sequence_runner.set_log_hook 造回调（lifespan 传 SessionLocal，测试传临时库工厂）。"""

    def hook(**fields) -> None:
        db = session_factory()
        try:
            safe_log(db, **fields)
        finally:
            db.close()

    return hook
