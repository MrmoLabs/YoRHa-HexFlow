# YoRHa-HexFlow 项目交接文档

## 1. 项目概览
**YoRHa-HexFlow** 是一个可视化、低代码/无代码编辑器，用于管理和生成二进制指令流。用户以可视化方式定义指令结构（“内核”），按打包规则编译为十六进制/二进制负载，并可经后端通道下发（当前为进程内环回）。

**视觉风格**: 《尼尔：机械纪元》工业终端风（沙色/炭黑、0 圆角、无阴影、1px 硬边框、等宽字体、琥珀色状态标记）。新增 UI 请复用 `frontend/src/index.css` 与 Tailwind 配置中的 `nier-*` 工具类，或使用 `yorha-ui` 设计规范。

## 2. 技术栈与环境
*   **操作系统**: Windows
*   **前端**: React **19** + Vite **7** + TailwindCSS + vitest
    *   路径: `frontend/`
    *   运行: `npm run dev` (端口 5173)；测试: `npm run test -- --run`
*   **后端**: Python + FastAPI + SQLAlchemy
    *   路径: `backend/`
    *   运行: `python -m uvicorn backend.main:app --reload` (端口 8000)
    *   一键启动: `.\start-dev.ps1`（后端 :8000 / 前端 :5173）
*   **数据库**: **SQLite**（`backend/db/yorha.db`，仓库内文件，**已被 git 跟踪**）
    *   连接与建表见 `backend/db/database.py`
*   **pymysql**: 仅 `backend/debug_db.py` 使用。`backend/requirements.txt` 与 `start-dev.ps1` 中保留该依赖，**不要移除**，否则 debug 脚本无法运行。主链路不经过 MySQL。

> 历史文档中出现的 MySQL（host/user/db `tc`）、`instructions.opcode_hex`、React 18 等描述均为**过时信息**，实际代码中不存在。以本文档与代码为准。

## 3. 数据库架构（以 `backend/db/models.py` 为准）
启动时由 `backend/main.py` 的 `lifespan` 执行 `Base.metadata.create_all` + 三个种子函数（算子模板、示例指令、示例协议）。

### A. `instructions`（主表）
*   `id` (char36, PK)、`device_code`、`code`、`name`、`type`（STATIC/DYNAMIC）、`description`
*   **没有** `opcode_hex` 字段
*   关系: `fields`（cascade delete-orphan）

### B. `instruction_fields`（树形字段）
*   `id` (PK)、`instruction_id` (FK)、`parent_id` (自关联 FK，用于嵌套)、`sequence`
*   `name`、`op_code`、`byte_len`、`endianness`（BIG/LITTLE）
*   `repeat_type` / `repeat_ref_id` / `repeat_count`
*   `parameter_config` (JSON): 算子参数，如 `{"hex": "AA55"}`、`{"refs": [...], "formula": "..."}`、`{"algorithm": "crc16_modbus"}`
*   关系: `bit_fields`（cascade delete-orphan）

### C. `bit_fields`（位级布局，BITFIELD 专用）
*   `id` (PK)、`field_id` (FK → instruction_fields.id)
*   `sequence`、`bit_name`、`start_bit`、`bit_len`、`default_val`
*   约定: `start_bit` 为整字段位偏移，bit 0 为 LSB；前端编辑器见 `frontend/src/components/editor/BitFieldEditor.jsx`

### D. `operator_templates`
*   `op_code` (PK)、`name`、`category`、`param_template` (JSON)、`description`
*   由 `backend/routers/operator.py` 的 `seed_operator_templates` 以 `db.merge` 播种（新增算子会自动出现在已有库）
*   算子分类见 `frontend/src/constants.js`（`OP_CODES` / `OP_PRIORITY` / `CATEGORY_ORDER`）

### E. `protocols`
*   `id` (PK)、`label`、`type`、`description`、`children` (JSON 块树)

### F. `transport_settings`（P1 新增，单行表）
*   `id` (恒为 `"current"`)、`config` (JSON)、`active_profile_id` (逻辑外键 → `device_profiles.id`，无 FK 约束)
*   语义：当前生效传输配置 + 最后激活的设备档案指针。写入口仅两处——`transport.set_persist_hook` 注册的配置变更钩子（落配置并清指针）与 `/profiles/{id}/activate`（配置 + 指针一起落）。lifespan 启动顺序：建表 → 恢复配置 → 再挂钩（避免回写）。

### G. `device_profiles`（P1 新增，设备档案）
*   `id` (PK)、`label` (唯一)、`config` (JSON，完整三段传输配置快照，`validate_config` 归一后入库)
*   语义：传输配置的命名快照。省略 `config` 创建 = 服务端快照当前生效配置且即视为激活；激活 = `transport.set_config` + 回写指针；手工改配置经钩子清指针（档案失活）；删除激活档案只清指针不动生效配置。API 见 `backend/routers/profile.py`（`/profiles` CRUD + `/profiles/{id}/activate`）。

### H. `response_specs`（P2 新增，应答规格）
*   `id` (PK)、`instruction_id` (逻辑外键 → `instructions.id`，唯一，无 FK 约束)、`spec` (JSON，`normalize_spec` 归一后入库)
*   语义：一指令一份事务应答匹配规格。五要素 = 帧头回显 `echo_header_bytes` / 长度自洽 `length`（`声明值 == 帧长 + offset_val`，对齐 `length.py` 的 offset 语义）/ 校验反算 `checksum`（sum·xor·crc16_modbus，恒排除字段自身，算法与 `handlers/checksum.py`、`formula.js calculateChecksum` 同一套且有 crc16 锚定测试）/ 掩码忽略区间 `ignore_ranges`（半开区间，echo 比对跳过）/ 前缀后缀 `prefix`·`suffix`；mode = echo（默认，结构 + 逐字节回显）/ rules（仅结构）/ any（非空即过）。
*   判定纯函数 `backend/core/response_match.py`（`normalize_spec` 为形态 SSOT，非法 → 400；`match_response` 返回 `(ok, reasons)`）。API 见 `backend/routers/response_spec.py`（GET 列表/单查、PUT upsert、DELETE，路径键 = instruction_id）。事务端点 `POST /dispatch/transaction` 规格解析优先级：内联 > 按指令 > 缺省 echo。

### I. `sequences`（P3 新增，序列定义）
*   `id` (PK)、`name` (唯一)、`description`、`config` (JSON：`stop_on_error` 缺省 true / `read_timeout_ms` 1..60000 或 null，`_normalize_config` 严格键集归一)
*   语义：序列编排定义头。运行态**不入库**——单槽内存 Runner（`core/sequence_runner.py`），重启即 idle；终态保留至下次启动覆盖。API 见 `backend/routers/sequence.py`（`/sequences` CRUD + `/{id}/start` + `/stop` + `/status` 轮询）。

### J. `sequence_steps`（P3 新增，序列步骤 = 保存时定值）
*   `id` (PK)、`sequence_id` (逻辑外键 → `sequences.id`，无 FK 约束，删除时路由内级联清理)、`step_order` (执行序)、`instruction_id` (逻辑外键 → `instructions.id`，审计回溯)、`label`、`delay_ms` (执行前等待 0..60000)、`params` (JSON，冻结表单值)、`payload` (Text，保存时前端 `encodeInstruction` 编译的完整帧 hex，紧凑大写入库)、`plan` (JSON，发送时重算计划)
*   语义（用户批复：参数保存时定值，TIME/COUNTER 发送时重算）：`plan.dynamic` 按发送墙钟等长重算 TIME_ACCUMULATOR / AUTO_COUNTER（E1-6 byte-equal 编码器；长度字节按字节数计与值无关恒有效）；`plan.checksum` 按 `regions`（refs 字段帧内字节区间，列示顺序拼接）反算写回，与应答侧共用 `response_match.checksum_value`。归一 `core/sequence_plan.py::normalize_plan`（保存与启动双入口，非法 → 400），执行 `apply_plan`。

## 4. 编译与下发链路

### 前端编码（动态发送表单 + 预览）
`frontend/src/utils/InstructionEncoder.js` 是编码核心：
1.  `getInitialValues` 生成输入默认值；
2.  `resolveDependencies` 计算 `LENGTH_CALC` / `CHECKSUM_CRC` / 公式字段；
3.  `encodeInstruction` 遍历叶子字段生成 hex 字符串与 `byteMap`。
*   **BITFIELD**: `getFieldBytes` 中按 `sum(default_val << start_bit)` 打包（输入值优先于默认位值）。
*   表单渲染: `frontend/src/components/InstructionForm/InstructionRunner.jsx`。

### 后端编译（块结构 → hex）
`backend/core/orchestrator.py`（`Orchestrator.process`）：深度遍历 → 扁平化 → 对 `length`/`checksum` 块做基于扁平流的区间计算 → 拼接 hex。
*   区间匹配规则（`backend/handlers/length.py` / `checksum.py`）：start 取首次匹配；end 只在 start 匹配之后才生效；end 缺失则扫到流尾。
*   `/compile` 与 `/export/binary` 都走这条链路。

### 导出与下发（本次交接新增）
*   `POST /export/hex` — hex 文本 → `.hex` 文件下载（指令加工页 "EXPORT_HEX" 按钮）。
*   `POST /export/binary?filename=` — 块森林 → Orchestrator 编译 → `.bin` 下载（编排页 "EXPORT .BIN" 按钮；前端经 `toFrameBlocks` 映射 `byte_len→byte_length`、`op_code→type`）。
*   `POST /dispatch/` — 经 **transport 抽象**（`backend/core/transport.py`）发送并返回记录，保存在有界 deque（最多 100 条，含 raw/response/error 三类事件）；`GET /dispatch/history`、`DELETE /dispatch/history`。
    *   **诚实说明**: **默认模式仍是进程内环回，`/dispatch` 口径不变**；E2 已实装 TCP（标准库 socket）与串口（pyserial）真实传输，经 `POST /transport/config` 切换、`GET /transport/status` 查看连接状态事件（connected/disconnected/error）。无真实设备时请保持 loopback。

## 5. 当前实施状态
### ✅ 已完成
*   全栈 CRUD（协议 / 指令 / 字段 / 算子模板），SQLite 持久化。
*   种子逻辑统一收敛到 `backend/main.py` 的 `lifespan`（已移除弃用的 `@router.on_event("startup")`）。
*   **三个交接 TODO 已实现**:
    1.  **二进制生成器**: `/export/binary`、`/export/hex` + 前端下载按钮。
    2.  **动态发送表单**: `InstructionRunner` 异步发送（SENDING / SENT / FAILED 日志状态）+ `InstructionProcessor.handleSend` 走 `/dispatch`。
    3.  **位域编辑器**: `BitFieldEditor` 组件 + `bit_fields` 表 + 编码器打包路径 + 算子模板 `BITFIELD`（ENCODING 类）。
*   配置修复: `docker-compose.yml` context 改为仓库根；`deploy/Dockerfile.backend` 改为使用 `backend/requirements.txt`。
*   `backend/core/orchestrator.py` 注释清理（行为不变）。
*   前端测试 47/47 通过；后端 import + 新端点冒烟通过。

### 🚧 待办 / 下一步
1.  ~~**真实传输层**~~ ✅ 已落地（2026-09-23，Backlog E2-T1..T4）：`backend/core/transport.py`
    （loopback 默认 / TCP 标准库 socket / pyserial 串口）+ `POST /transport/config`、
    `GET /transport/status` API + 发送历史三类事件（原始/响应/错误）；`/dispatch`
    默认环回口径不变，TCP/串口为可切换真实传输。
2.  ~~**通讯调试页 (`/terminal`)**~~ ✅ 已落地（2026-09-23，Backlog E3）：传输配置
    UI（`/transport/config` 三模式 + TCP/串口参数）+ 连接状态与状态事件面板 +
    发送历史 / 原始报文 / 响应与错误日志三面板（含手动 hex 发送与确认式清空）；
    `pageStatus.json` `terminal.implemented` → true，纯函数视图模型
    `utils/terminalPanes.js`。
3.  ~~**数据中心页 (`/datahub`)**~~ ✅ 已落地（2026-09-22，Backlog M2-C3 一期）：环境
    状态面板（GET /datahub/status）+ 聚合导出 ZIP（instructions.json + manifest +
    逐指令 frames）+ 备份/恢复（backend/db/backups/，恢复前自动安全快照）。原待办
    「JSON 导入导出、备份恢复」已覆盖，导入由指令管理页 JSON 导入承接。
4.  ~~**绑定持久化**~~ ✅ 已落地（2026-09-23，Backlog E4）：新表
    `protocol_bindings`（`slot_order` 插槽序，逻辑外键沿 op_code 先例）+
    `/bindings` CRUD（`backend/routers/binding.py`，无模块级 create_all、建表归
    lifespan）+ 编排页读写接线（挂载 GET 对账 / 加删即写 / 选择即时 PUT /
    label 400ms 防抖 + 卸载冲刷 / 加载失败降级本地提示条）。
5.  ~~**位域强校验**~~ ✅ 已落地（2026-09-22，Backlog M1-C2）：`backend/routers/instruction.py`
    `_validate_bitfields` 在 POST/PUT 落库前强校验，重叠 / 超容量位域 400 拒绝（unittest 8/8）。
6.  ~~**设备档案 + 连接持久化**~~ ✅ 已落地（2026-09-23，Backlog P1，`550b73e`）：新表
    `transport_settings`（配置经钩子落库 + lifespan 启动恢复）+ `device_profiles`
    （命名快照 CRUD + 激活切换）+ `/profiles` API + 调试页设备档案区；
    后续 P2–P5（事务发送引擎 / 序列编排 / 日志落库回放）见 `docs/PLAN_Backlog.md` §1。
7.  ~~**事务化发送引擎**~~ ✅ 已落地（2026-09-23，Backlog P2，`18b0dca`）：新表
    `response_specs`（应答规格按指令持久化，`normalize_spec` SSOT）+
    `core/response_match.py` 判定纯函数（帧头回显/长度自洽/校验反算 sum·xor·
    crc16_modbus/掩码忽略区间/前缀后缀，mode echo·rules·any）+
    `POST /dispatch/transaction`（超时→按间隔重发 N 次、广播无应答、逐次 attempt
    + RTT/统计，规格解析内联 > 按指令 > 缺省，同时入 `/dispatch/history` 三事件
    口径）+ `transport.send` 单次读超时覆盖 + 加工页 `TransactionPanel`
    （规格编辑器 + 事务发送 + attempt 展示；同批清零 InstructionRunner 10 处
    校验器违规）。验收：后端 149/149、前端 390/390、build EXIT=0、校验器 0 违规。
8.  ~~**序列编排后端**~~ ✅ 已落地（2026-09-23，Backlog P3）：新表
    `sequences` / `sequence_steps`（步骤存三件套 payload/冻结 params/plan，
    参数保存时定值、TIME·COUNTER·checksum 发送时重算，`normalize_plan`
    保存与启动双入口校验）+ `core/sequence_plan.py` 补丁纯函数 +
    `core/sequence_runner.py` 单槽后台 Runner（claim/execute 直调可测、
    协作式停止、`stop_on_error` 两态、终态保留至下次 claim）+
    `/sequences` CRUD/`start`/`stop`/`status`（`/status`·`/stop` 先注册，
    P4 1.5s 轮询契约）+ 手动发送互斥（运行期 `/dispatch`、
    `/dispatch/transaction` 与二次 start 全 409）。验收：后端 191/191
    （+42）、curl 冒烟四轮全绿（补丁链 sum 反验 match=True、互斥 409×3、
    停止 SKIPPED）。P4 序列编排前端见 `docs/PLAN_Backlog.md` §1。

## 6. 目录地图（文件 → 职责 → 是否在用）
> 这是本项目的“地图”。接手前先读这张表，避免全局搜索。

### 根目录 / 配置
| 文件 | 职责 | 状态 |
|---|---|---|
| `start-dev.ps1` | 一键启动后端:8000 + 前端:5173（含 `requiredModules` 检查，**保留 pymysql**） | ✅ 权威启动方式 |
| `docker-compose.yml` | Docker 编排（context = 仓库根） | ✅ |
| `deploy/Dockerfile.backend` | 后端镜像（依赖 `backend/requirements.txt`） | ✅ |
| `deploy/Dockerfile.frontend` | 前端构建 + nginx 托管 | ✅ |
| `scripts/generate-page-status.mjs` | 由 `pageStatus.json` 生成 `docs/PAGE_STATUS.md` | ✅ 改 JSON 后需重跑 |
| `scripts/inspect_db.py` | SQLite 调试脚本（原根目录 `inspect_db.py`；DB 路径按脚本位置解析，任意 cwd 可跑） | ✅ |
| `requirements.txt`（根目录） | **不存在**；requirements 在 `backend/` 下 | ⚠️ 勿在文档中引用根目录版本 |

### backend/
| 文件 | 职责 | 状态 |
|---|---|---|
| `backend/main.py` | FastAPI 入口；`lifespan`（create_all + 3 个种子）；注册全部路由（`/compile` 本体已拆至 `routers/compile.py`） | ✅ 权威入口 |
| `backend/routers/instruction.py` | 指令 CRUD；`save_field_flat` 持久化 bits；`serialize_instruction` 返回 bits | ✅ |
| `backend/routers/protocol.py` | 协议 CRUD + 种子 | ✅ |
| `backend/routers/operator.py` | 算子模板 + `seed_operator_templates`（含 BITFIELD） | ✅ |
| `backend/routers/compile.py` | `POST /compile`（块森林 → Orchestrator → hex），原内联于 `main.py` | ✅ |
| `backend/routers/export.py` | `/export/hex`、`/export/binary`、`hex_to_bytes` | ✅ 新增 |
| `backend/routers/dispatch.py` | `/dispatch` 环回通道 + 有界历史 | ✅ 新增 |
| `backend/core/orchestrator.py` | 块森林 → hex 编译（`/compile`、`/export/binary` 使用） | ✅ |
| `backend/handlers/length.py`、`checksum.py` | 扁平流区间长度 / 校验计算 | ✅ |
| `backend/db/models.py` | SQLAlchemy 模型（含 `BitField`） | ✅ |
| `backend/db/database.py` | SQLite engine / Session / Base | ✅ |
| `backend/db/seed.py` | 示例指令种子 | ✅ |
| `backend/db/yorha.db` | SQLite 数据库文件 | ✅ 已被 git 跟踪（保留） |
| `backend/db/migrations/*.sql` | `schema.sql` / `seed_data.sql` **非权威参考**（见同目录 `README.md`），无自动执行、无迁移框架 | ⚠️ 仅供参考 |
| `backend/core/processor.py` | 旧编译链 | ⚠️ **未接线**（Phase-2 遗留，保留勿删，勿引入新依赖） |
| `backend/core/graph.py` | 旧 GraphEngine 拓扑排序 | ⚠️ **未接线**（同上） |
| `backend/debug_db.py` | MySQL 调试脚本，唯一使用 pymysql 的地方 | ⚠️ 独立脚本 |

### frontend/src/
| 文件 | 职责 | 状态 |
|---|---|---|
| `src/api/` | 全部 HTTP 调用，按域拆分：`client.js`（fetch 助手）/ `protocols.js` / `instructions.js` / `operators.js` / `export.js` / `dispatch.js` + `index.js` 桶导出 `api` 对象；**导入路径 `./api` 不变** | ✅ 原 `src/api.js` 已拆 |
| `src/constants.js` | `OP_CODES` / `CATEGORIES` / `OP_PRIORITY` / `CATEGORY_ORDER`（BITFIELD 已含） | ✅ |
| `src/utils/InstructionEncoder.js` | **编码核心**（hex 生成、依赖解析、BITFIELD 打包） | ✅ 权威编码逻辑，勿随意改 |
| `src/utils/formula.js` | 公式求值 / 校验和算法 | ✅ |
| `src/utils/normalizeInstruction.js` | 保存前字段/指令载荷归一化（`normalizeFieldPayload` / `normalizeInstructionPayload`），由 `useInstructionData` re-export | ✅ |
| `src/utils/protocolTree.js` | 协议页纯树工具（`serializeProtocol` / `findNode`） | ✅ 新增（自 Protocol.jsx 抽出） |
| `src/utils/blockMerge.js` | 编排页纯逻辑（协议+指令合并、slot 注入、`buildLanes` / `getTotalBytes`） | ✅ 新增（自 Orchestration.jsx 抽出） |
| `src/utils/toFrameBlocks.js` | 导出映射 `byte_len→byte_length`、`op_code→type`（供 `/export/binary`） | ✅ 新增（自 Orchestration.jsx 抽出） |
| `src/utils/download.js` | `triggerBlobDownload`（.hex / .bin 下载共用） | ✅ 新增 |
| `src/hooks/useInstructionData.js` | 指令数据加载/保存/CRUD（归一化逻辑在 `utils/normalizeInstruction.js`，此处 re-export） | ✅ |
| `src/hooks/useInstructionForm.js` | 表单输入 + 编码 memo | ✅ |
| `src/components/ui/` | `NieRModal` / `NieRDatePicker` / `FeaturePlaceholder` 通用 UI | ✅ |
| `src/components/editor/` | 编辑器域组件：`Canvas` / `Block` / `BlockPropertiesPanel` / `ComponentPalette` / `BitFieldEditor` / `ParamConfigForm`（参数编辑器拆至 `editor/paramConfig/`）/ `InstructionListSidebar` / `ProtocolListSidebar` / `ProtocolPropertiesPanel` | ✅ |
| `src/components/InstructionForm/InstructionRunner.jsx` | 动态表单 + 发送/导出按钮（已拆：`normalizeRunnerInstruction.js` 归一化、`RunnerFieldTree.jsx` 字段树、`TransmissionLog.jsx` 日志） | ✅ |
| `src/pages/InstructionProcessor.jsx` | 指令加工页，`handleSend` 走 `/dispatch` | ✅ |
| `src/pages/Orchestration.jsx` | 编排绑定页，EXPORT .BIN 走 `/export/binary` | ✅ |
| `src/pages/Instruction.jsx` | 指令管理页（含 `handleAddBlock` 默认 bits 初始化） | ✅ |
| `src/pages/Blueprint.jsx` | 旧蓝图页 | ⚠️ **未接线**（保留勿删，不进路由） |
| `src/config/pageStatus.json` | 页面状态唯一数据源 | ✅ 改后重跑脚本 |

### 文档
| 文件 | 说明 |
|---|---|
| `PROJECT_HANDOVER.md` | **本文件**，权威交接文档 |
| `docs/PAGE_STATUS.md` | 由 `pageStatus.json` 生成，勿手改 |
| `docs/PRD_InstructionProcessing.md` | 指令处理 PRD（原 `doc/` 目录，已并入 `docs/`，原 `doc/` 已移除） |
| `README.md` / `README_ZH.md` / `SPECIFICATION.md` | 项目说明与规格（以本文档校准） |

## 7. 给下一位 AI 的建议
*   **先读第 6 节目录地图**，再决定是否需要全局搜索。
*   **严格类型**: 后端 Pydantic + SQLAlchemy；前端字段归一化集中在 `utils/normalizeInstruction.js`（`useInstructionData` re-export）。
*   **双端编码同步**: `frontend/src/utils/InstructionEncoder.js` 与 `backend/core/orchestrator.py` 是两套独立编码器，改动任一编码逻辑必须两边同步核对（含 `backend/handlers/`）。
*   **字段名归一化**: 前端 `Block.jsx` 兼容 `byte_len` / `byte_length`；后端块结构用 `byte_length`，指令字段用 `byte_len`，导出时由 `toFrameBlocks` 转换。
*   **诚实文档**: 不要把环回说成真实链路，不要写不存在的表字段（如 `opcode_hex`）。
*   **保留 pymysql**（`debug_db.py` 依赖）与 **保留 `backend/db/yorha.db` 跟踪**（用户决定）。
*   **未接线代码**: `processor.py` / `graph.py` / `Blueprint.jsx` 保留原样，仅在文档中标注，不要删除。
*   **B1 校验和收敛（2026-09 已修）**: 算法选择原先因键名（`algo` vs `algorithm`）与枚举值双重不匹配，恒算 CRC16-MODBUS。现 `backend/routers/operator.py` seed 枚举收敛为编码器真实实现的 `CRC_16_MODBUS / SUM_8 / XOR_8`；`utils/normalizeInstruction.js` 的 `mapChecksumAlgo` 负责旧值（`CRC16_CCITT/CRC32/XOR_SUM/ADD_SUM`）映射与 `parameter_config.algorithm` 别名。**若要新增算法，必须同时改 `formula.js` 的 `calculateChecksum` 并与 `backend/handlers/checksum.py` 核对**。
*   **编码器已知限制（2026-09 字段覆盖面审计，B2–B8；B2–B8 已于 E1 批 E1-1..E1-6 解除）**: 以下均属 `InstructionEncoder.js` / 双端同步范围，**未获授权勿改**（加工页 UI 已对可展示项做语义标注；2026-09-22 管理页 Phase0：`utils/encoderLimits.js` 为标注单一事实源，面板横幅/⚠角标 + `utils/validateInstruction.js` 保存前校验（Error 阻断/Warning 不阻断），见 `docs/PLAN_InstructionManagement.md`）：
    1. ~~`FLOAT_IEEE` 按普通整数编码（浮点分支要求 `parameter_config.type='float'`，算子模板从不设置）~~ **已解决（E1-4，2026-09-23）**：`op=FLOAT_IEEE` + `byte_len=4`（bits=32）+ 规范 type（缺省/number）→ IEEE 754 float32 大端恒 4 字节（`orchestrator.encode_float_ieee` ↔ `getFieldBytes` FLOAT_IEEE 分支；严格十进制解析同 E1-1 口径，非有限→0，超 f32 范围 → ±Infinity IEEE 溢出对齐 JS Float32Array），byte-equal 向量表 22 例锚定双端测试（`test_encode_float_ieee.py` ↔ E1-4 describe，改一必改二）。**范围外保留现状**：bits=64（`byte_len=8`）仍走整数路径 / BE zeros（E1-4 只做 float32，如需 float64 另立子项）；矛盾 `type=float/string/hex` 模板不会产生，FE 走既有分支、BE 保持 zeros 契约外。
    2. ~~`BCD_CODE` 无 BCD 分支（`25 → 0x19`，而非 `0x25`）~~ **已解决（E1-3，2026-09-23）**：双端 packed BCD（`orchestrator.encode_bcd` ↔ `getFieldBytes` BCD_CODE 分支）——floor 解析后取绝对值、数字逐 nibble 打包，超长截高位保低 `2*byte_len` 位、高位补 0；byte-equal 向量表 17 例锚定双端测试（`test_encode_bcd_scaled.py` ↔ E1-3 describe，改一必改二）；LITTLE 联动（`0025 → 2500`）经 E1-2 wrapper 自动生效。
    3. ~~`SCALED_DECIMAL` 的 `factor/offset` 不参与编码（加工页已展示，字节仍按裸整数）~~ **已解决（E1-3，2026-09-23）**：双端定标 `(value+offset)*factor`（`orchestrator.encode_scaled` ↔ `getFieldBytes` SCALED_DECIMAL 定标分支）——factor/offset 空/缺省/非有限 → 1/0 恒等回归、value 非有限 → 0、结果 `abs(floor)` 定宽 mod `2^(8n)`；矛盾 type（string/float/hex，算子模板不设置）不参与定标保持现行为；byte-equal 向量表 16 例锚定双端测试，改一必改二；B4 ⚠角标随 `getParamKeyLimitRef` 撤除自动消失。
    4. ~~`INT_SIGNED` 负数用 `Math.abs` 而非补码（`-1 → 01`），加工页 hex 输入也无法表达负数~~ **已解决（E1-1，2026-09-23）**：双端按位宽两补码（`orchestrator.encode_int_signed` ↔ `getFieldBytes` INT_SIGNED 分支，byte-equal 向量表 24 例锚定在双端测试，改一必改二）；加工页 hex 输入的补码写法（如 `FF`）经 `RunnerFieldTree` parseInt 归一为 255 → 掩码得同一字节，负数可表达。
    5. ~~`endianness=LITTLE` 仅入库与透传，编码恒按大端（属性面板已加控件并标注“仅存储”）~~ **已解决（E1-2，2026-09-23）**：先按 op 语义出大端字节、再整体逆序（字节数不变，单字节/组容器不动）——前端 `getFieldBytes` wrapper（内部实现改名 `_encodeFieldBytes`，checksum refs 走内部方法吃未反转值字节）↔ 后端 `Block.endianness`（`schemas/block.py` + `datahub.to_block` 透传）+ `orchestrator._reverse_hex_pairs` 在 emit 阶段反转（length/checksum handler 先于反转在大端值上计算），byte-equal 向量表 7 例锚定双端测试（`test_encode_little_endian.py` ↔ E1-2 describe），改一必改二；属性面板标注撤除为「字节序 (Endian)」。
    6. ~~`ARRAY_GROUP` 的 `repeat_type/count/ref_id` 可配可存，但编码只展开一次（`FIXED×N` 只编 1 份），加工页不显示重复信息~~ **已解决（E1-5，2026-09-23）**：双端真实展开 N 次 —— `orchestrator._flatten_recursive` 容器 ×N（`Block.repeat_count` ← `datahub.to_block` 按 NONE/FIXED/DYNAMIC resolve，DYNAMIC 查 ref 字段静态 value）↔ 前端 `encodeInstruction` 树状递归 emit（组级整拷贝循环 → `(ab)×N` 交错，byteMap 每份一跨）+ `_encodeFieldBytes` 组分支（直调/checksum 组 refs 路径）+ `_repeatCount`（三端 N 口径：FIXED `max(0,floor)`、DYNAMIC `computed>input>static` 严格解析、悬空 ref→0）；三处总长口径联动同步：`byteOffsets`（FIXED 组 Σ×N + 游标落组真终点；DYNAMIC 组降级 unknown → VAR/`··`/下限 `+`）、编排页 `blockMerge.getTotalBytes`（FIXED Σ×N，DYNAMIC ×1 下限）、指令页 LEN（派生自 byteOffsets 自动联动）；checksum 叶引用恒 1 份 ↔ BE `first-start→first-end` 范围恰 1 份（byte-equal by design）；byte-equal 向量表 11 例 + 嵌套/LITTLE/直调/inputs 运行时锚钉双端测试（`test_encode_repeat.py` ↔ E1-5 describe，改一必改二）。
    7. ~~`TIME_ACCUMULATOR` 在加工页按用户选择的相对秒数直接编码（`base_time` 仅用于显示换算）；`AUTO_COUNTER` 的 `step/max` 不自动递增，需手输值（语义参数已在表单下方展示）。~~ **已解决（E1-6，2026-09-23）**：双端语义真实生效 —— `TIME_ACCUMULATOR` → `floor((now − base_time)/1000)` 墙钟秒数（inputs/value 不参与；now 可注入：FE `encodeInstruction` 第 4 参 `opts.now` ↔ BE `fields_to_blocks(now=ms)`，缺省各自墙钟；base 解析 `Date.parse` ↔ `_iso_ms`（fromisoformat 尾 Z→+00:00，naive 本地时区），对齐 JS 本地语义）↔ `AUTO_COUNTER` → `(Current+Step)%Max`（Current = computed > input > 静态 value > start_val，`_floor_numeric` 同款解析；step 缺省/非法 → 0；max 缺省/非法/≤0 → 不回绕；双重取模 `((n%max)+max)%max` 消平 JS/Python 负余数差异；结果 abs(floor) mod 定宽），BE `orchestrator.encode_time_accumulator` / `encode_auto_counter` ↔ FE `InstructionEncoder` 两分支 byte-equal（向量表 TIME 5 + AUTO 11 例钉双端 `test_encode_time_counter.py` ↔ E1-6 describe，改一必改二）；base 缺失/非法（契约外）→ 双端各自现状回落（FE value 路径 / BE zeros）；跨帧自动递增状态机不在编码器（纯函数），由调用方每帧推进 value；B8 标注全撤，`ENCODER_LIMITS` 清空（模块保留为未来限制 SSOT）。
*   **Phase 1 偏移标尺（2026-09-22）**: `utils/byteOffsets.js` 纯函数按 `parent_id/sequence` 计算每块起始偏移与指令总长。尺寸口径 = `byte_len > 0` → `parameter_config.computedValue` 字节数（hex 且非 `??`）→ 未知（`··`，总长降级为下限并显示 `+`）；未知尺寸只污染其**后**块的偏移，自身起点照常显示。组起点 = 父起点 + 组内累计（组显示 `@00..`），组卡片直显 Σ 子块可算长度（空组=已知 0B），顶栏 `LEN nB` 并标注 `FIXED/VAR`（`variable = 未知 || computedValue 驱动长度 || DYNAMIC 重复`；口径对齐编码器实际输出——B7 重复只展开一次），另修复 LENGTH_CALC 公式引用组恒 `??` 的缺陷（`useInstructionLanes.nameToValueMap` 原硬编码组为 `??`，现取 Σ 组值、真未知才 `??`，示例状态包长度现算 `05`，并移除死字段 `_displayLen`），总长口径与编排页 `getTotalBytes`（Σ叶子字节）对齐。见 `docs/PLAN_InstructionManagement.md` §3。
*   **Phase 2 复制派生（2026-09-22）**: `utils/duplicateInstruction.js` 两个纯函数：`buildDuplicateInstructionPayload` 派生新指令（后端 POST 无条件发指令 id 且 name/code 双唯一 → 前端重生成全部字段/bit id、重映射 `parent_id`/`repeat_ref_id`/`refs` 防主键冲突与 E2 悬空、`(副本N)`/`-COPYN` 对已加载列表去重，落库后选中）；`duplicateBlockInInstruction` 深拷贝子树插入源块之后（副本 `_N` 改名防 E3、仅副本根进入本道重排序号、refs/formula 保持指向原块 = 未接线副本、完成后选中副本）。骨架模板（P2-2）曾按调研点 3 以真实算子实施，后按人工反馈以「功能多余」整体移除（`utils/skeletons.js`、7 个用例、顶栏「骨架 ▾」菜单已删）。同轮反馈：列表复制入口由生僻符号 ⧉ 改为「副本」文字并提高对比度（构建 CSS 中悬停机制规则已确认存在）；画布新增**长按左键拖拽平移**（二次反馈修正：起点放宽为画布任意处除卡片/控件、3px 阈值、起拖后指针捕获防中断、内容层 `100%+160px` 滚动余量保证双轴可平移、`onClickCapture` 吞掉松手 click 防误清选中/误触泳道聚焦，dnd 拖卡不受影响）。见 `docs/PLAN_InstructionManagement.md` §4。
*   **Phase 3 表格视图与 JSON 导入（2026-09-22）**: 侧栏指令库头部「表格/列表」切换；`components/editor/InstructionTable.jsx` 表格（列 = 代号/设备/名称/总长/字段数——调研点 2 确认 `InstructionResponse` 无 `updated_at`，故无更新时间列；**人工反馈三条**：①全部单元格居中 ②表头自带检索框、绑定页面级 `searchTerm` 与侧栏搜索双向同步并显示 `MATCH n` 行数 ③**导出功能移除**——「导出」按钮、`handleExport`、`buildExportPayload` 及其 2 个用例已删，仅保留导入），行渲染与列表共享同一过滤，点行走未保存确认 wrapper，切回列表状态不丢。`utils/importExport.js` 纯函数 `analyzeImport`（数组或 `{instructions}` → payloads/冲突/错误三分流：name 或 code 与存量或文件内重复、名称代号为空 → 冲突跳过绝不覆盖，`validateInstruction` 结构错按 `[CODE]` 上报；payload 经 `duplicateInstruction.js` 抽出的共用 `cloneFieldsForNewInstruction` 重生成字段/bit id 并重映射 parent/repeat/refs——后端字段 id 按 payload 原样入库，复用文件内 id 会撞源指令主键）。入口在 section 顶栏「导入」：解析失败即报错 → 预览计数（新增/冲突/错误 + 明细截断）→ 顺序 POST → 二次弹窗汇总。测试 107/107（基线 100 + 导入 7；导出 2 例随功能移除），`vite build` 通过，校验器改动文件零违规。见 `docs/PLAN_InstructionManagement.md` §5。
*   **Phase 4 撤销重做 / 保存失败恢复 / 落点指示线（2026-09-22）**: `hooks/useHistory.js` 手写双栈（各上限 50，新编辑清 redo 分支）挂在 `updateLocalInstruction` 咽喉（内容全等调用不压栈防废步骤），undo/redo 还原快照保持脏态；基线重置 = 切换指令 / 保存成功 / `loadInstructions` 重载（撤销永不跨基线），入口为顶栏「撤销/重做」（栈空禁用）+ `Ctrl+Z / Ctrl+Shift+Z`（输入态与弹窗打开时不响应）。P4-2：PUT 失败保留脏态并抛 `saveError` 横幅（顶栏正下方，「服务端拒绝(400/422)」/「网络/服务错误」分文案 + 重试 + 「本地更改保留 · RESET 可放弃」+ 关闭），成功/重载清除；与 P0-2 校验弹窗严格分流（校验失败根本不进 PUT catch）。P4-3：dragOver 按 arrayMove 预览在目标卡左/右缘渲染 2px 琥珀插入线（内容层坐标、几何不变不 setState），refs 连线层拖拽期间整层 `opacity-0`、落定后随 lanes 重算；新增 `onDragCancel` 清理 Escape 卡态并回滚跨 lane splice。P4-4：落点推导抽纯函数 `utils/computePlacement.js` 的 `computeFinalPlacement`（四分支单测 ×6：同 lane / 背景末尾 / 跨 lane parentId 跟随 ACTIVE / 不可解析 no-op + null）。过程 bug：keydown effect 曾插在 `modalConfig` 声明前触发 TDZ 崩渲染，页面冒烟测试当场逮住后移位。测试 113/113（基线 107 + 6），`vite build` 通过，校验器零新增违规（Canvas `pl-8`/`p-10` 为既有）。见 `docs/PLAN_InstructionManagement.md` §6。
