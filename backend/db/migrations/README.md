# backend/db/migrations

> ⚠️ **非权威（NON-AUTHORITATIVE）SQL 参考文件**

本目录下的 `schema.sql` 与 `seed_data.sql` **不是**数据库结构/种子数据的权威来源，也**没有任何自动执行机制**。

- **权威来源**:
  - 表结构: `backend/db/models.py`（SQLAlchemy 模型），启动时由 `backend/main.py` 的 `lifespan` 执行 `Base.metadata.create_all` 创建（**只建缺失的表，不给既有表补列**）。
  - 存量库补列: `backend/db/database.py` 的 `ensure_*` 幂等自愈（在 `create_all` 之后、迁移之前跑）。
  - 种子数据: `backend/db/seed.py` + `backend/routers/operator.py::seed_operator_templates`（幂等播种）。
- **版本化升级机制（PLAN §8.30）**: `backend/db/migrate.py` —— `schema_migrations` 版本表
  （`version` / `name` / `applied_at`）+ 顺序迁移注册表 `REGISTRY`。启动时在
  `create_all` + `ensure_*` 之后自动执行，闭环是：

  ```
  读版本 → 有无待执行？
      无 → 只做 PRAGMA integrity_check 读态校验（幂等）
      有 → 既有库先整库备份（backend/db/backups/pre-migration-v{a}-to-v{b}-{ts}.bak）
         → 逐条 apply + verify 同一事务（verify 不过 → 整体回滚、版本不前进）
         → 记录版本 → integrity_check 终检 + 本次 verify 复跑
  ```

  手动执行：

  ```bash
  python -m backend.db.migrate status   # 当前版本 / 目标版本 / 待执行 / 完整性
  python -m backend.db.migrate up        # 备份 → 升级 → 校验（幂等，可重复跑）
  ```

- **新增表 / 列的固定动作**: 改 `models.py` → 在 `migrate.py::REGISTRY` 追加一条
  `Migration(version, name, apply, verify)`。新库由 `create_all` 建出全量 schema、
  只记基线；旧库靠这条迁移自动升级并留痕（`verify` 写「升级后应该长什么样」）。
  版本号必须从 1 起**连续**升序、名字唯一，断号/重复直接 `MigrationError`。
- 失败语义：apply / verify 任一失败 → 该条迁移整体回滚、版本号不前进，抛
  `MigrationError`（消息带升级前快照路径），启动随之失败，**不带半套 schema 服务**。
- 如需查看线上库内容，使用 `scripts/inspect_db.py`。
