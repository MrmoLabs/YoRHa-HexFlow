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
