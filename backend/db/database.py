from pathlib import Path
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

# Project-local SQLite database for zero-config local runs.
DB_PATH = Path(__file__).resolve().parent / "yorha.db"
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH.as_posix()}"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


@event.listens_for(Engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_protocol_version_column(bind):
    """批次五: version 乐观并发列自愈（main.py lifespan 在 create_all 后调用）。

    create_all 只建缺失的表、**不给既有表补列**（本仓无迁移框架，见
    backend/db/migrations/README）→ 既有 yorha.db 的 protocols 表缺 version
    列时启动即 ALTER ADD COLUMN（SQLite 无 IF NOT EXISTS，须 PRAGMA 先查）。
    DEFAULT 1 顺带回填存量行为 1；幂等（已存在 / 表尚不存在则 no-op —— 后者
    由 create_all 按 models 建全列）。
    """
    with bind.connect() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(protocols)")}
        if not columns:
            return
        if "version" not in columns:
            conn.exec_driver_sql(
                "ALTER TABLE protocols ADD COLUMN version INTEGER NOT NULL DEFAULT 1"
            )
            conn.commit()


def ensure_binding_columns(bind):
    """批次一 1a 三列 + CP3 3d (D7-A) definition_hash + 两个部分唯一索引自愈。

    main.py lifespan 在 create_all 后调用（镜像 ensure_protocol_version_column：
    create_all 不给既有表补列）。三列缺则 ALTER ADD COLUMN —— is_default /
    priority NOT NULL DEFAULT 回填存量行 0，slot_id 缺省 NULL（= 按 slot_order
    稠密位次，存量行为逐字节不变）。`definition_hash`（CP3 3d）缺则补 TEXT NULL，
    存量行回填 NULL = 无出处可比 → 读侧不出失效徽标（D7-A 不追溯存量）。
    随后建两个部分唯一索引（幂等）：

    - ux_bindings_default: 每指令至多一个 is_default=1（D1-A 默认协议唯一）；
    - ux_bindings_slot: 每协议每显式槽至多一行（防重复填洞，NULL 不参与）。

    表尚不存在 → no-op（create_all 已按 models 建全列 + 本函数随后补索引 ——
    新库同样先 create_all 再进来，索引在两条路径都会建）。
    """
    with bind.connect() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(protocol_bindings)")}
        if not columns:
            return
        existing = columns
        for ddl in (
            "ALTER TABLE protocol_bindings ADD COLUMN slot_id TEXT",
            "ALTER TABLE protocol_bindings ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE protocol_bindings ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE protocol_bindings ADD COLUMN definition_hash TEXT",
        ):
            column = ddl.split("ADD COLUMN ", 1)[1].split(" ", 1)[0]
            if column not in existing:
                conn.exec_driver_sql(ddl)
        conn.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_bindings_default "
            "ON protocol_bindings(instruction_id) WHERE is_default = 1"
        )
        conn.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_bindings_slot "
            "ON protocol_bindings(protocol_id, slot_id) WHERE slot_id IS NOT NULL"
        )
        conn.commit()


def ensure_recipe_columns(bind):
    """CP3 3a (D13): instructions.default_recipe_id 单列自愈。

    main.py lifespan 在 create_all 后调用（镜像 ensure_protocol_version_column /
    ensure_binding_columns：create_all 只建缺失的表、**不给既有表补列**）。
    缺列则 ALTER ADD COLUMN TEXT NULL（SQLite 无 IF NOT EXISTS，须 PRAGMA 先查），
    存量行回填 NULL = 无配方（降级链走默认协议 / 裸发）。

    幂等：已存在 → no-op；表尚不存在 → no-op（后者由 create_all 按 models 建全列，
    新库同样先 create_all 再进来）。`frame_recipes` 新表本身由 create_all 建。
    """
    with bind.connect() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(instructions)")}
        if not columns:
            return
        if "default_recipe_id" not in columns:
            conn.exec_driver_sql(
                "ALTER TABLE instructions ADD COLUMN default_recipe_id TEXT"
            )
            conn.commit()


def ensure_sequence_step_columns(bind):
    """CP3 3c (D6-B) + R26（§8.58）: sequence_steps 的 `wrap` / `condition` 两列自愈。

    main.py lifespan 在 create_all 后调用（镜像 ensure_recipe_columns：create_all
    只建缺失的表、**不给既有表补列**）。缺列则 ALTER ADD COLUMN（JSON / VARCHAR(200)
    NULL），存量行回填 NULL = 裸帧步骤（D6-B 缺省路径）+ 无条件步骤（R26 缺省路径）
    —— 两者都**行为逐字节不变**。

    幂等：已存在 → no-op；表尚不存在 → no-op（后者由 create_all 按 models 建全列，
    新库同样先 create_all 再进来）。
    """
    with bind.connect() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(sequence_steps)")}
        if not columns:
            return
        added = False
        if "wrap" not in columns:
            conn.exec_driver_sql("ALTER TABLE sequence_steps ADD COLUMN wrap JSON")
            added = True
        if "condition" not in columns:
            conn.exec_driver_sql(
                "ALTER TABLE sequence_steps ADD COLUMN condition VARCHAR(200)"
            )
            added = True
        if added:
            conn.commit()


def ensure_response_spec_columns(bind):
    """CP3 3d: response_specs.stage + definition_hash 双列自愈（D15-A / D7-A）。

    main.py lifespan 在 create_all 后调用（镜像 ensure_sequence_step_columns：
    create_all 只建缺失的表、**不给既有表补列**）。缺列则 ALTER ADD COLUMN：

    - `stage`（D15-A）= 本行 `spec.stages` 的最外层序号（0-based；2 = 共 3 层），
      NULL = 未分层（`spec` 无 `stages` 键 = 单层：存量手工规格 / 无配方指令的
      「据此生成」）—— 存量行 NULL 即存量零改的行级标记；
    - `definition_hash`（D7-A）= 生成期记录的协议链复合指纹，NULL = 从未生成
      （无出处可比 → 读侧不出徽标，不追溯存量）。

    幂等：已存在 → no-op；表尚不存在 → no-op（后者由 create_all 按 models 建全列）。
    """
    with bind.connect() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(response_specs)")}
        if not columns:
            return
        for ddl in (
            "ALTER TABLE response_specs ADD COLUMN stage INTEGER",
            "ALTER TABLE response_specs ADD COLUMN definition_hash TEXT",
        ):
            column = ddl.split("ADD COLUMN ", 1)[1].split(" ", 1)[0]
            if column not in columns:
                conn.exec_driver_sql(ddl)
        conn.commit()
