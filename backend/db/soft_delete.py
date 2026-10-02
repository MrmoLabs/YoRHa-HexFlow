"""R6 软删除 / 回收站（PLAN §8.43）—— 写侧语义的单一落点。

**口径**（拍板 §8.37 R6：13 表统一加 `deleted_at`，仅新增列，合 §0）：

- `deleted_at` **NULL = 活行**；**非 NULL = 回收站**（ISO-8601 时间戳）。
- 删除 = 打标记（不毁行）→ 恢复 = 清标记 → 彻底删除 = 真删行 + 级联子行。
- **级联共用同一时间戳**：父行与被它连带软删的子行 `deleted_at` **完全相同**，
  恢复时按 (子表, 外键列, 父 id, 时间戳) 把子行一并捞回 —— 因此**不需要**再加
  一列级联标记（拍板只要 `deleted_at` 一列）。本次之前已独立入回收站的子行
  时间戳不同 → 不会被父行的恢复顺带捞回，也不会被计入 `deleted_*` 计数。
- **读侧一律 `alive()`**：活行查询排掉回收站行；回收站行只能从
  `routers/trash.py` 读到。

**独立键占用（已知取舍）**：软删行**继续占用**它的唯一键 ——
`sequences.name` / `device_profiles.label` / `response_specs.instruction_id`
都是 inline UNIQUE（SQLite 落在 `sqlite_autoindex_*`，**删不掉**），拍板 R6 只
新增列、不做表重建 → 软删期间**同名不可重建**（路由既有的「已存在」400 先拦，
不会漏到 DB 报 500），彻底删除后键才释放。`response_specs` 是 upsert 语义 →
重新 SAVE 直接**复活**在库行（清标记 + 覆盖 spec），不走新建。

**日志例外**：`dispatch_logs` 只加列、不进回收站（"清空日志"若软删，回收站会
被海量日志行淹掉，且日志是追加型审计数据，删除即不可恢复是既有口径）。
"""
from datetime import datetime, timezone

from sqlalchemy.orm import Query


def now_iso() -> str:
    """回收站时间戳（UTC，微秒精度 → 级联与独立删除不会撞戳）。"""
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def is_trashed(row) -> bool:
    return getattr(row, "deleted_at", None) is not None


def alive(query: Query, *entities) -> Query:
    """读侧过滤：每张表各加一次 `deleted_at IS NULL`。

    调用惯例：**紧贴查询构造处**调（`alive(db.query(Model), Model).filter(...)`），
    避免漏过滤的读端点静默把回收站行当活行返回。
    """
    for entity in entities:
        query = query.filter(entity.deleted_at.is_(None))
    return query


def trashed(query: Query, *entities) -> Query:
    """回收站读侧：只留 `deleted_at IS NOT NULL` 的行（`alive` 的镜像）。"""
    for entity in entities:
        query = query.filter(entity.deleted_at.isnot(None))
    return query


def mark_deleted(row, ts: str = None) -> str:
    """删除单行 → 打标记，返回本次时间戳（级联子行共用它）。"""
    ts = ts or now_iso()
    row.deleted_at = ts
    return ts


def mark_related(query: Query, entity, criteria, ts: str) -> int:
    """级联软删：只标**尚未入回收站**的行（保留它们原有的独立时间戳与计数）。"""
    return (
        query.filter(*criteria)
        .filter(entity.deleted_at.is_(None))
        .update({"deleted_at": ts}, synchronize_session=False)
    )


def restore_related(query: Query, entity, criteria, ts: str) -> int:
    """按「同父 + 同时间戳」把被级联软删的子行一并恢复。"""
    return (
        query.filter(*criteria)
        .filter(entity.deleted_at == ts)
        .update({"deleted_at": None}, synchronize_session=False)
    )


def purge_related(query: Query, entity, criteria) -> int:
    """彻底删除的级联：按外键把引用者全部清掉（不看时间戳）。

    与改前的硬删级联同口径 —— 宿主都没了，指向它的行留着就是脏行。
    """
    return query.filter(*criteria).delete(synchronize_session=False)
