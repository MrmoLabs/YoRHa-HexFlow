"""P5 通讯日志落库：dispatch_logs 单表的写侧件。

- 写口三路 + 回放：routers/dispatch.py（manual / transaction，路由直持
  Session）、core/sequence_runner（sequence，经 set_log_hook 注入的回调）、
  routers/logs.py（replay）。
    rtt_ms      事务 = 末次样本、序列 = 本步往返；manual·replay 为 NULL
    fields      R10 §8.48 解码快照 —— 缺省由 record_log **自动回填**（见
                `resolve_log_fields`），调用方可显式传（= 同一次解码复用给回执，
                保证 `/dispatch/history` 的 `fields` 与 `fields_json` 同一份）；
                解不出 = None（落库 NULL，展示层退回客户端解码兜底）。
- safe_log 为旁路观测：写失败 rollback 后忽略——帧已出线是既成事实，不反噬
  响应码（区别于 P1 transport persist_hook：配置未持久化必须失败，日志缺失不）。
- log_hook(session_factory)：为 core/sequence_runner.set_log_hook 造回调，
  每步独立会话（Runner 在 daemon 线程跑，不持有路由会话）。
"""
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from backend.core.field_decode import decode_hex
from backend.db.models import DispatchLog, Instruction

VALID_SOURCES = ("manual", "transaction", "sequence", "replay")
VALID_STATUSES = ("OK", "ERROR")

#: 「调用方没传 fields」的哨兵 —— 不能用 None 当缺省（None 是合法的「解不出」）
_UNSET = object()


#: 解码器吃的扁平字段键（= `fields_to_blocks` / `field_index` 消费的全部布局键）。
#: 口径对齐 `routers/instruction.serialize_instruction` 的 GET /instructions 输出
#: （改一必改二）——BE 解码必须与 FE 编解码吃**同一份**字段形状，否则两边算出的
#: 布局会错位。只列列、不列 `bits`：布局与取值只看 `byte_len`/`op_code`/`endianness`/
#: `repeat_*`/`parameter_config`，位域打包是编码期行为、解码侧只回聚合整数。
_DECODE_FIELD_KEYS = (
    "id", "parent_id", "sequence", "name", "op_code", "byte_len",
    "endianness", "repeat_type", "repeat_ref_id", "repeat_count",
)


def _field_dicts(instruction) -> list:
    """ORM 指令 → 解码器输入的扁平字段 dict 列表（`children` 恒 []，扁平 parent_id 关联）。"""
    return [
        {**{key: getattr(f, key) for key in _DECODE_FIELD_KEYS},
         "parameter_config": dict(f.parameter_config or {}),
         "children": []}
        for f in instruction.fields
    ]


def resolve_log_fields(
    db: Session,
    echo,
    *,
    instruction_id=None,
    instruction_name=None,
):
    """R10（§8.48 · C-2 选 C 后半）：应答 hex + 这条日志对应的指令 → 解码快照。

    返回 `core.field_decode.decode_hex(...)` 的结果，或 `None`（= 落库 NULL）：
    - **无应答**（echo 空）→ None：没东西可读，且不打 DB 查询（ERROR 路几乎全是这种）；
    - **指令不可解析** → None：manual 只带标签、事务/序列带 id，查不到就是查不到；
    - **无字段布局**（`instruction.fields` 空）→ None —— 与 R9「空字段布局不解码」
      同口径，避免给纯文本应答凭空造一条 `residual` 尾字节假警报。

    指令解析口径：`instruction_id` 优先（事务/序列/回放的逻辑外键，**不看软删**
    —— 日志行留存的正是那条指令，指令进了回收站也该解得出来，这比 FE 只能查
    活行更强）；无 id 才按 `instruction_name` 找，且只在未软删行里按 id 稳定序
    取首个（FE 从 `/instructions` 活行清单里也是取得到的第一个，口径对齐）。

    **本函数绝不抛**：它跑在写日志的同一条路径上，解码炸了不能反噬日志本身
    （safe_log 的 rollback 会连日志一起吞掉）。真出异常就把消息写进 warnings
    落库 —— 「解不出来」必须看得见，不能静默变 NULL。
    """
    if not isinstance(db, Session):
        return None
    text = str(echo or "").strip()
    if not text:
        return None
    try:
        instruction = None
        if instruction_id:
            instruction = (
                db.query(Instruction)
                .filter(Instruction.id == str(instruction_id))
                .first()
            )
        if instruction is None and instruction_name:
            instruction = (
                db.query(Instruction)
                .filter(
                    Instruction.name == str(instruction_name),
                    Instruction.deleted_at.is_(None),
                )
                .order_by(Instruction.id)
                .first()
            )
        if instruction is None:
            return None
        fields = _field_dicts(instruction)
        if not fields:
            return None
        return decode_hex(fields, text)
    except Exception as exc:  # noqa: BLE001 —— 解码失败不得反噬写日志
        return {
            "fields": [],
            "consumed": 0,
            "total": 0,
            "residual": 0,
            "warnings": [f"字段解码失败: {exc}"],
        }


def record_log(db: Session, **payload) -> int:
    """插入一条通讯日志并提交，返回自增 id。字段非法 → ValueError（测试可见）。

    R10：`fields` 缺省在此**自动回填**（`resolve_log_fields`）—— 四条写入缝
    （manual / transaction / sequence / replay）都过这一处，序列路跑在 daemon
    线程、回放路没有表单输入，靠调用方各自记得算是靠不住的。
    """
    source = payload.get("source")
    if source not in VALID_SOURCES:
        raise ValueError(f"source 非法: {source!r}")
    status = payload.get("status")
    if status not in VALID_STATUSES:
        raise ValueError(f"status 非法: {status!r}")
    hex_string = str(payload.get("hex_string") or "")
    byte_count = payload.get("byte_count")
    fields_value = payload.get("fields", _UNSET)
    if fields_value is _UNSET:
        fields_value = resolve_log_fields(
            db,
            payload.get("echo"),
            instruction_id=payload.get("instruction_id"),
            instruction_name=payload.get("instruction_name"),
        )
    row = DispatchLog(
        created_at=datetime.now(timezone.utc).isoformat(),
        source=source,
        channel=str(payload.get("channel") or ""),
        status=status,
        byte_count=int(byte_count) if byte_count is not None else len(hex_string.split()),
        hex_string=hex_string,
        echo=str(payload.get("echo") or ""),
        instruction_name=payload.get("instruction_name"),
        instruction_id=payload.get("instruction_id"),
        sequence_id=payload.get("sequence_id"),
        step_order=payload.get("step_order"),
        rtt_ms=payload.get("rtt_ms"),
        error=payload.get("error"),
        fields_json=fields_value,
    )
    db.add(row)
    db.commit()
    return int(row.id)


def safe_log(db, **payload) -> None:
    """旁路写：非 Session（直调未传 db，同既有测试口径）→ 跳过；写失败回滚后忽略。"""
    if not isinstance(db, Session):
        return
    try:
        record_log(db, **payload)
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass


def log_hook(session_factory):
    """为 sequence_runner.set_log_hook 造回调（lifespan 传 SessionLocal，测试传临时库工厂）。"""

    def hook(**payload) -> None:
        db = session_factory()
        try:
            safe_log(db, **payload)
        finally:
            db.close()

    return hook
