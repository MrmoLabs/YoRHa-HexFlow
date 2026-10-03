"""轻量版本化 SQLite 升级机制（无 Alembic · 批次：DB 升级机制，PLAN §8.30）。

**为什么**：本仓过去只靠 `create_all`（只建缺失的表、不给既有表补列）+ 手写
`database.ensure_*` 启动自愈（每加一列都要有人记得写、并兼容旧库）。表越来越多后
（14 表 + 分散的自愈列），缺一个可查的**版本号**与**升级结果检查**，字段变更会越来越
难管。本模块补一个最小闭环：

    版本表 schema_migrations  →  顺序迁移注册表  →  既有库先备份  →  单事务 apply+verify
  →  记录版本（失败整体回滚、版本不前进）  →  全库 integrity_check 终检

**职责边界**（不与既有机制打架）：
- 表结构权威仍是 `backend/db/models.py`（`create_all` 建表）；
- 已落地的 `ensure_*` 自愈继续负责「存量库补列」（它们幂等、且早于本模块运行）；
- 本模块负责**版本记录、顺序升级、备份、结果校验**，从 `0001_baseline` 起步；
- 未来**新增表/列**时：改 `models.py` + 追加一条 `Migration`（apply 写 DDL、
  verify 校验结果）→ 旧库启动即自动升级并留痕，新库 `create_all` 建好后仅记录基线。

**调用点**：`backend/main.py` lifespan（`create_all` + `ensure_*` 之后）；也可手动：

    python -m backend.db.migrate status   # 当前版本 / 目标版本 / 待执行迁移
    python -m backend.db.migrate up        # 备份 → 升级 → 校验（幂等）

失败语义：apply / verify 任一失败 → **该条迁移整体回滚、版本号不前进**，
抛 `MigrationError`（消息带备份路径），启动随之失败，绝不带半套 schema 服务。
"""
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterable, List, Optional

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.pool import NullPool

from backend.db import models as _models  # noqa: F401  —— 注册全部表到 Base.metadata
from backend.db.database import Base

MIGRATIONS_TABLE = "schema_migrations"
DEFAULT_BACKUP_DIR = Path(__file__).resolve().parent / "backups"

_CREATE_TABLE = f"""
CREATE TABLE IF NOT EXISTS {MIGRATIONS_TABLE} (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
)
"""


class MigrationError(RuntimeError):
    """升级失败（已回滚，库保持升级前版本）。"""


@dataclass(frozen=True)
class Migration:
    """一条迁移：`apply` 写变更，`verify` 检查结果（不过则整条回滚）。

    `verify` 必须是**只读且幂等**的检查（只在本条迁移执行时与终检里跑，
    不随每次启动重放历史检查），失败抛任意异常即可。
    """

    version: int
    name: str
    apply: Callable[[object], None]
    verify: Callable[[object], None]


# --------------------------------------------------------------------------
# 迁移注册表（顺序 = 升级顺序；版本号必须从 1 起连续递增）
# --------------------------------------------------------------------------


def _baseline_verify(conn):
    """0001 基线校验：models 全表在位 + 五处 `ensure_*` 自愈列在位。

    既有库与新库都会经过 create_all + ensure_* 再进本模块，所以这一条既是
    「基线已具备」的证明，也是对历史自愈层的一次结果检查。
    """
    expected_tables = set(Base.metadata.tables)
    rows = conn.exec_driver_sql(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    actual_tables = {row[0] for row in rows}
    missing_tables = sorted(expected_tables - actual_tables)
    if missing_tables:
        raise MigrationError(f"基线缺表: {missing_tables}")

    required_columns = {
        "protocols": {"version"},
        "protocol_bindings": {"is_default", "priority", "slot_id", "definition_hash"},
        "instructions": {"default_recipe_id"},
        "sequence_steps": {"wrap"},
        "response_specs": {"stage", "definition_hash"},
    }
    for table, want in required_columns.items():
        if table not in actual_tables:
            continue  # 缺表已在上面报出
        have = {
            row[1]
            for row in conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
        }
        missing = sorted(want - have)
        if missing:
            raise MigrationError(f"基线缺列 {table}.{missing}（ensure_* 自愈未生效？）")


def _baseline_apply(conn):
    """0001 基线：无 DDL（create_all + ensure_* 已就位），仅由 verify 背书后记录版本。"""
    return None


# --------------------------------------------------------------------------
# 0002 · R6 软删除（PLAN §8.43）：13 表统一加 `deleted_at`
# --------------------------------------------------------------------------


def soft_delete_tables() -> List[str]:
    """需要 `deleted_at` 的表 = **models 里带该列的表**（SSOT，不另抄一张名单）。

    从 `Base.metadata` 派生 → models 加列、迁移范围自动跟随；verify 侧再钉死
    「恰好 13 张」，防有人误删某表的列而迁移静默漏改。
    """
    return sorted(
        name
        for name, table in Base.metadata.tables.items()
        if "deleted_at" in table.columns
    )


def _column_names(conn, table: str) -> set:
    rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
    return {row[1] for row in rows}


def _soft_delete_apply(conn):
    """缺则 `ALTER TABLE ... ADD COLUMN deleted_at VARCHAR(40)`（幂等）。

    全新库由 create_all 直接建出全列 → 逐表跳过（`ALTER` 加已存在的列会直接
    报错），等价于 no-op；存量库逐表补列（同 `ensure_*` 的 PRAGMA 先查口径）。
    表尚不存在 → 跳过，交给 0001 baseline verify 报缺表。
    """
    for table in soft_delete_tables():
        have = _column_names(conn, table)
        if have and "deleted_at" not in have:
            conn.exec_driver_sql(
                f"ALTER TABLE {table} ADD COLUMN deleted_at VARCHAR(40)"
            )


def _soft_delete_verify(conn):
    """升级结果检查：13 表**每张**都得有 `deleted_at`，一张都不能少。"""
    tables = soft_delete_tables()
    if len(tables) != 13:
        raise MigrationError(
            f"R6 软删除应覆盖 13 张表，实得 {len(tables)}: {tables}"
        )
    missing = sorted(t for t in tables if "deleted_at" not in _column_names(conn, t))
    if missing:
        raise MigrationError(f"软删除列缺失: {missing}")


# --------------------------------------------------------------------------
# 0003 · R10 入库回写（PLAN §8.48）：`dispatch_logs.fields_json` 仅新增列
# --------------------------------------------------------------------------

#: R10 要落 `fields_json` 的表（**全计划唯一 DDL 批**）—— 与 0002 同款口径：
#: 表单从 `models` 派生（加列只写一处），verify 再钉死「恰好这一张」，防有人
#: 误删列后迁移静默漏改、或误给别的表也加上这列（§0 只允许新增列，不做改列）。
def decode_json_tables() -> List[str]:
    return sorted(
        name
        for name, table in Base.metadata.tables.items()
        if "fields_json" in table.columns
    )


def _decode_json_apply(conn):
    """缺则 `ALTER TABLE ... ADD COLUMN fields_json JSON`（幂等）。

    全新库由 create_all 直接建出该列 → 跳过（`ALTER` 加已存在的列会直接报错）；
    存量库补列（同 0002 的 PRAGMA 先查口径）。SQLite 的 `JSON` 只是类型名
    （TEXT 亲和），与 `models.DispatchLog.fields_json = Column(JSON)` 同形。
    """
    for table in decode_json_tables():
        have = _column_names(conn, table)
        if have and "fields_json" not in have:
            conn.exec_driver_sql(
                f"ALTER TABLE {table} ADD COLUMN fields_json JSON"
            )


def _decode_json_verify(conn):
    """升级结果检查：R10 恰好只给 `dispatch_logs` 加列 —— 多一张、少一张都报错。"""
    tables = decode_json_tables()
    if tables != ["dispatch_logs"]:
        raise MigrationError(
            f"R10 fields_json 应且仅应覆盖 dispatch_logs，实得 {tables}"
        )
    for table in tables:
        if "fields_json" not in _column_names(conn, table):
            raise MigrationError(f"解码快照列缺失: {table}.fields_json")


REGISTRY: List[Migration] = [
    Migration(1, "baseline", _baseline_apply, _baseline_verify),
    # 13 表统一加 `deleted_at`（仅新增列，合 §0；新库 create_all 已带 → 只验不改）。
    Migration(2, "soft_delete_deleted_at", _soft_delete_apply, _soft_delete_verify),
    # R10：`dispatch_logs.fields_json` 解码快照（仅新增列，全计划唯一 DDL 批）。
    Migration(3, "dispatch_logs_fields_json", _decode_json_apply, _decode_json_verify),
]

#: 当前目标版本（= REGISTRY 最后一条）。升级即把库推进到这个号。
TARGET_VERSION = REGISTRY[-1].version


# --------------------------------------------------------------------------
# 内部工具
# --------------------------------------------------------------------------


def validate_registry(registry: Iterable[Migration]) -> None:
    """版本号必须从 1 起**连续**递增且名字唯一（断号 = 中间那条永远不会跑）。"""
    items = list(registry)
    if not items:
        raise MigrationError("迁移注册表为空")
    versions = [m.version for m in items]
    names = [m.name for m in items]
    if versions != sorted(versions) or len(set(versions)) != len(versions):
        raise MigrationError(f"迁移版本号必须升序且不重复: {versions}")
    if versions != list(range(1, len(versions) + 1)):
        raise MigrationError(f"迁移版本号必须从 1 起连续: {versions}")
    if len(set(names)) != len(names):
        raise MigrationError(f"迁移名重复: {names}")


def ensure_migrations_table(conn) -> None:
    conn.exec_driver_sql(_CREATE_TABLE)


def current_version(conn) -> int:
    """当前库版本；无记录 = 0（尚未纳入版本化管理）。"""
    ensure_migrations_table(conn)
    row = conn.exec_driver_sql(
        f"SELECT MAX(version) FROM {MIGRATIONS_TABLE}"
    ).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def _integrity(engine: Engine) -> str:
    with engine.connect() as conn:
        return str(conn.exec_driver_sql("PRAGMA integrity_check").scalar())


def _migration_engine(engine: Engine) -> Engine:
    """迁移专用引擎：**事务化 DDL**（失败可整体回滚）。

    pysqlite 的默认事务语义是「非 DML 语句前隐式 COMMIT」→ `CREATE TABLE` 落在
    事务之外，`rollback()` 撤不掉它（升级失败会留下半套 schema）。SQLAlchemy 官方
    recipe 是关掉驱动的隐式事务 + 显式 `BEGIN`，本仓只对**迁移这一个连接**启用，
    不改主 engine 的既有语义（应用侧代码一行不动）。
    """
    mig = create_engine(
        engine.url.render_as_string(hide_password=False),
        poolclass=NullPool,
    )

    @event.listens_for(mig, "connect")
    def _disable_implicit_txn(dbapi_connection, _record):
        dbapi_connection.isolation_level = None

    @event.listens_for(mig, "begin")
    def _explicit_begin(conn):
        conn.exec_driver_sql("BEGIN")

    return mig


def _backup(
    engine: Engine,
    db_path: Path,
    from_version: int,
    to_version: int,
    backups_dir: Path,
) -> Path:
    """升级前整库快照（`backend/db/backups/` 已 gitignore）。"""
    backups_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = backups_dir / f"pre-migration-v{from_version}-to-v{to_version}-{stamp}.bak"
    # 避免同秒重名（两次升级同秒）：补序号
    seq = 0
    while target.exists():
        seq += 1
        target = backups_dir / (
            f"pre-migration-v{from_version}-to-v{to_version}-{stamp}-{seq}.bak"
        )
    try:
        # 非 WAL 库上等价于无操作；WAL 库先把未落盘内容并回主文件再拷
        with engine.connect() as conn:
            conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
    except Exception:  # pragma: no cover - 非致命（默认库非 WAL）
        pass
    shutil.copy2(db_path, target)
    return target


# --------------------------------------------------------------------------
# 对外 API
# --------------------------------------------------------------------------


def status(engine: Engine, *, registry: Iterable[Migration] = REGISTRY) -> dict:
    """读态：当前版本 / 目标版本 / 待执行迁移 / 库路径（不升级；首次运行会补建空版本表）。"""
    validate_registry(registry)
    items = list(registry)
    with engine.connect() as conn:
        version = current_version(conn)
    pending = [m for m in items if m.version > version]
    db_file = engine.url.database
    return {
        "current_version": version,
        "target_version": items[-1].version,
        "pending": [f"{m.version:04d}_{m.name}" for m in pending],
        "applied": [
            f"{m.version:04d}_{m.name}" for m in items if m.version <= version
        ],
        "db_path": db_file,
        "integrity": _integrity(engine),
    }


def run_pending_migrations(
    engine: Engine,
    *,
    registry: Iterable[Migration] = REGISTRY,
    do_backup: bool = True,
    backups_dir: Optional[Path] = None,
) -> dict:
    """把库升到注册表目标版本；返回升级报告（幂等：无待执行则只校验）。

    `do_backup=False` 用于「全新库刚由 create_all 建出」的场景（无存量可毁，
    无需快照）—— 调用方（main.py lifespan）按文件是否存在决定。
    """
    validate_registry(registry)
    items = list(registry)
    target = items[-1].version

    with engine.begin() as conn:
        ensure_migrations_table(conn)
        version = current_version(conn)

    if version > target:
        # 恢复了「更高版本程序」产出的备份 / 库被外部升过级：schema 里有本程序
        # 不认识的结构，继续跑只会拿旧代码盖新库 → 一律拒绝（不备份、不改一列）。
        raise MigrationError(
            f"库版本 v{version} 高于当前程序目标 v{target}：拒绝执行迁移。"
            "请升级程序到对应版本，或用备份回退到匹配的库。"
        )

    pending = [m for m in items if m.version > version]
    report = {
        "from_version": version,
        "to_version": version,
        "applied": [],
        "backup": None,
        "db_path": engine.url.database,
        "integrity": None,
    }
    if not pending:
        report["to_version"] = version
        report["integrity"] = _integrity(engine)
        if report["integrity"] != "ok":
            raise MigrationError(
                f"数据库完整性检查失败: {report['integrity']!r}（版本 {version}，未做变更）"
            )
        return report

    db_path = Path(engine.url.database) if engine.url.database else None
    backup_path = None
    if do_backup and db_path and db_path.is_file():
        backup_path = _backup(
            engine,
            db_path,
            from_version=version,
            to_version=target,
            backups_dir=backups_dir or DEFAULT_BACKUP_DIR,
        )
        report["backup"] = str(backup_path)

    # 事务化 DDL 引擎只建一次（见 _migration_engine），跑完整批即释放
    mig_engine = _migration_engine(engine)
    try:
        for migration in pending:
            label = f"{migration.version:04d}_{migration.name}"
            try:
                # apply + verify + 记版本同一事务，任一失败 → 整体回滚
                # （DDL 一并撤掉），版本号不前进。
                with mig_engine.begin() as conn:
                    migration.apply(conn)
                    migration.verify(conn)  # 升级结果检查：不过 → 整条回滚
                    conn.exec_driver_sql(
                        f"INSERT INTO {MIGRATIONS_TABLE} (version, name, applied_at) "
                        "VALUES (?, ?, ?)",
                        (migration.version, migration.name,
                         datetime.now().isoformat(timespec="seconds")),
                    )
            except Exception as exc:  # noqa: BLE001 - 统一包装成 MigrationError
                kept = f"，升级前快照: {backup_path}" if backup_path else ""
                raise MigrationError(
                    f"迁移 {label} 失败，已整体回滚（库仍为 v{version}，"
                    f"未记录版本{kept}）: {exc}"
                ) from exc
            report["applied"].append(label)
    finally:
        mig_engine.dispose()

    report["to_version"] = target
    report["integrity"] = _integrity(engine)
    if report["integrity"] != "ok":
        raise MigrationError(
            f"升级到 v{target} 后完整性检查失败: {report['integrity']!r}"
            f"（已执行 {report['applied']}，快照: {backup_path}）"
        )
    # 终检：刚执行的这几条 verify 再跑一遍（只查本次，不重放历史检查）
    with engine.connect() as conn:
        for migration in pending:
            try:
                migration.verify(conn)
            except Exception as exc:  # noqa: BLE001
                raise MigrationError(
                    f"迁移 {migration.version:04d}_{migration.name} 升级后校验失败: {exc}"
                ) from exc
    return report


def _main(argv: List[str]) -> int:
    from backend.db.database import engine

    command = argv[0] if argv else "status"
    if command == "status":
        info = status(engine)
        print(
            f"schema_migrations: v{info['current_version']} / "
            f"target v{info['target_version']}"
        )
        print(f"db: {info['db_path']}")
        print(f"integrity: {info['integrity']}")
        print(f"applied: {info['applied'] or '[]'}")
        print(f"pending: {info['pending'] or '[]'}")
        return 0
    if command == "up":
        report = run_pending_migrations(engine, do_backup=True)
        if report["applied"]:
            print(f"applied: {report['applied']} (backup: {report['backup']})")
        else:
            print("no pending migrations (already at target)")
        print(f"version: v{report['to_version']} · integrity: {report['integrity']}")
        return 0
    print(f"usage: python -m backend.db.migrate [status|up] (got {command!r})")
    return 2


if __name__ == "__main__":  # pragma: no cover
    import sys

    raise SystemExit(_main(sys.argv[1:]))
