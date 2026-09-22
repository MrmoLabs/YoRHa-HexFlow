# backend/db/migrations

> ⚠️ **非权威（NON-AUTHORITATIVE）SQL 参考文件**

本目录下的 `schema.sql` 与 `seed_data.sql` **不是**数据库结构/种子数据的权威来源，也**没有任何自动执行机制**。

- **权威来源**:
  - 表结构: `backend/db/models.py`（SQLAlchemy 模型），启动时由 `backend/main.py` 的 `lifespan` 执行 `Base.metadata.create_all` 创建。
  - 种子数据: `backend/db/seed.py` + `backend/routers/operator.py::seed_operator_templates`（幂等播种）。
- 当前**没有迁移框架**（无 Alembic / 版本化迁移）。改动表结构请改 `models.py`，并同步更新这里的 SQL 仅供参考。
- 如需查看线上库内容，使用 `scripts/inspect_db.py`。
