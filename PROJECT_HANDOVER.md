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

### K. `dispatch_logs`（P5 新增，通讯日志落库）
*   `id` (自增整型 PK，顺序即时间序，查询恒 id 降序)、`created_at` (ISO-8601 UTC)、`source` (`manual` | `transaction` | `sequence` | `replay`)、`channel` (发送时通道 LOOPBACK/TCP/SERIAL)、`status` (**统一 OK|ERROR** —— 历史 SENT/FAILED 归一)、`byte_count`、`hex_string` (发送帧 space-separated；序列 PLAN 错误未发出 → 落基础帧保可回放)、`echo` (末次应答 compact hex，无 = 空串)、`instruction_name` (手动/事务标签 · 序列步 label，缺省 step-N)、`instruction_id` (逻辑外键)、`sequence_id`·`step_order` (仅序列路；回放是独立发送不挂回原序列)、`rtt_ms` (事务=末次样本 / 序列=本步；manual·replay 空)、`error` (ERROR 原因，与 history 文案同源)
*   语义：三路 + 回放写入，写侧 SSOT `backend/db/log_store.py`（`record_log` 字段校验 / **`safe_log` 旁路** —— 直调未传 db 跳过、写失败回滚不反噬响应，区别于 P1 persist_hook；`log_hook(session_factory)` 为 Runner 造回调）。manual·transaction 在 `routers/dispatch.py` 路由内直写（`dispatch_frame` 新增 db 参数，既有直调不传 db 经守卫零回归）；sequence 经 `core/sequence_runner.py::set_log_hook` 注入（lifespan 传 SessionLocal、测试传临时库工厂、`reset` 一并清；**SKIPPED 不落行 = 未发生通讯**）；replay 写 `source=replay`。读侧 `routers/logs.py`（挂 `main.py`）：`GET /logs`（id 降序 · limit 1..1000 静默钳制 · source/status 过滤非法 400）、`GET /logs/export`（csv 带 utf-8 BOM + 附件头 / json 同形数组，过滤同参、无行数上限，format 非法 400）、`POST /logs/{id}/replay`（**现行**传输配置重发，存档 channel 仅记录当时通道；序列运行期 409 同文案 / 200 SENT / 502 传输错，成败皆入 `/dispatch/history` + 落新行；存档帧损坏 400、日志不存在 404）、`DELETE /logs` 清空（形态同 `DELETE /dispatch/history`）。**`/dispatch/history` 内存口径不变**（E2-T4 deque 100，既有测试锁形）；建表归 lifespan `create_all`（同全表纪律，路由无模块级 create_all）。

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
*   `POST /compile/wrapped` — 协议 + **已编码内核 hex 载荷** → 完整封装帧（批次一 1b；后端唯一封装入口 `backend/core/frame_builder.py::build_wrapped`：协议树按 `slot_id ?? slot_order` 填洞、溢出追加帧末/欠载保留槽、length/checksum refs 真值重算；返回 `hex_string/total_length/warnings`，协议缺失 404、载荷/槽语义错误 400）。请求形 `{protocol_id, payloads, slot_ids?, start_order?}`。
*   发送端点可选 `wrap`（批次一 1c）：`POST /dispatch/` 与 `POST /dispatch/transaction` 接 `{wrap: {protocol_id, slot_id?, slot_order?}}` —— 入参 hex 视作已编码内核载荷、后端套协议外壳；**缺省不带 wrap = 裸帧路径逐字节不变**。

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
9.  ~~**序列编排前端**~~ ✅ 已落地（2026-09-23，Backlog P4）：新菜单页「序列编排」
    （pageStatus 第 7 项 / 快捷键 F、`/sequences` 路由，PAGE_REGISTRY 派生导航与
    状态板自动收录，App.jsx 仅 +2 行）+ `api/sequences.js` 七端点入 barrel
    （DELETE 204 无体特判）+ 纯函数 `utils/sequenceView.buildPlan`（键集与后端
    `normalize_plan` 严格同形；**编码与计划走 raw op_code**——normalize 会把
    TIME_ACCUMULATOR/AUTO_COUNTER 改写成 TIME_CUMULATIVE/INPUT，仅 raw 与后端
    发送时重算 byte-equal；后端 400 形态生成侧降级为冻结 + 警告）+
    `pages/Sequences.jsx`（三栏定义列表/步骤编辑/运行状态，RunnerFieldTree 复用 +
    实时帧预览 + PUT 整体保存 + 运行期禁用 + `/status` 1.5s 轮询 + NieRModal
    二次确认）+ `docs/PAGE_STATUS.md` 重生成。验收：前端 428/428（390+38）、
    vite build EXIT=0、yorha-ui 校验器本批 UI 文件 0 违规（App.jsx 壳层 5 处
    既有违规非本批引入，留待独立清理批）。P5 日志落库见 `docs/PLAN_Backlog.md` §1。
10. ~~**通讯日志落库 / 导出 / 回放**~~ ✅ 已落地（2026-09-23，Backlog P5）：新表
    `dispatch_logs`（第 12 表，`models.py` 既有表零改，见 §3-K）+ 写侧
    `backend/db/log_store.py`（`record_log` 字段校验 / **`safe_log` 旁路** ——
    直调未传 db 跳过、写失败回滚不反噬响应，区别于 P1 persist_hook —— /
    `log_hook(session_factory)` 工厂）三路 + 回放：manual·transaction 在
    `dispatch_frame`（新增 db 参数，既有直调不传 db 零回归）/
    `dispatch_transaction` 路由内直写（transaction 的 reason 提升两用，history
    文案不变）、sequence 经 `sequence_runner.set_log_hook` 注入（lifespan 传
    SessionLocal、测试传临时库工厂、`reset` 一并清；**SKIPPED 不落行 = 未发生
    通讯**）、replay 写 `source=replay`。读侧 `backend/routers/logs.py`（挂
    `main.py`）：`GET /logs` 查询（id 降序 · limit 1..1000 钳制 · source/status
    过滤非法 400）、`GET /logs/export`（csv 带 utf-8 BOM + 附件头 / json 同形
    数组，过滤同参、无行数上限，format 非法 400）、`POST /logs/{id}/replay`
    （**现行**传输配置重发，口径同 POST /dispatch：序列运行期 409 同文案 /
    200 SENT / 502 传输错，成败皆入 `/dispatch/history` + 落新行；存档帧损坏
    400、日志不存在 404）、`DELETE /logs` 清空。状态统一 **OK|ERROR**（历史
    SENT/FAILED 归一）；`/dispatch/history` 内存口径不变（E2-T4 deque，既有
    测试锁形）。验收：后端 **205/205**（+14）、IMPORT-OK 55 路由、**curl 冒烟
    五轮全绿**（导出 BOM/过滤、回放 200/404、`BY-SOURCE manual=2 replay=1
    sequence=1 transaction=1` 四路铁证、清场复查 0）。明细见
    `docs/PLAN_Backlog.md` §8.5。已提交 `aa20589`（db 同步 `b635eac`）。
11. ~~**协议页卡片对标指令页 + 容器内联展开导航（A+B）**~~ ✅ 已落地
    （2026-09-23，用户批准范围）：Tier A 卡片补齐 —— `protocolTree`
    `computeProtocolOffsets` 适配层（children 树 → `computeByteOffsets`，
    容器打 ARRAY_GROUP 标仅限适配层，空容器=已知 0B 组不污染偏移）接线
    Canvas + `Block.jsx` 四规则（`isGroupMark` 统一 `::`/标签宽度地板、
    `type==='fixed'` hex 上卡、`slot` 沙底虚线、设计期 `length/checksum`
    中心 `??`）；Tier B 下钻 → 内联展开 —— `pathIds`/面包屑退役，
    `expandedContainerIds`+`focusedParentId`（镜像 `useInstructionLanes:50-64`
    切协议全展开 + 焦点自愈）、树版 `buildProtocolLanes`（DFS/展开门控）、
    点容器卡选中+toggle（页面层 `onSelect` 接，**共享 Canvas 零改动**）、
    ENTER=展开+聚焦、新容器自动展开+聚焦（镜像 `Instruction.jsx:266-271`）、
    `moveNode` 跨容器落点 + **环守卫**（树成环=findNode 栈溢出，原引用拒收）、
    删节点=子树剪枝、加块落焦点泳道。验收：前端 **447/447（37 文件）**
    （+19：protocolTree 18 + Protocol 净增 1，导航用例按新范式重写）、
    build EXIT=0、校验器 0 违规、后端零改动沿用 205/205；纯前端无 DDL →
    无 db 提交。人工跨泳道拖拽目视待补。明细见 `docs/PLAN_Backlog.md` §8.6。
12. ~~**一期：协议 refs 引用 + 帧级合并 + 封装试发**~~ ✅ 已落地
    （2026-09-23，用户批准范围 A8+B3+C3）：A —— refs 存
    `parameter_config.refs`（同树 id 数组；禁 slot 锚/自引用：面板过滤 +
    后端 `_validate_refs` 400 英文 detail），协议页 SELECT FIELDS 画布拾取
    （切协议/改选中中止，镜像 `Instruction.jsx:104-112`）、芯片单删、
    length 卡设计期 Σ = `formatToHex(Σ, byte_length)` pretty 注入（checksum
    保持 `??`、悬空不注入、`displayLanes` 纯派生不落库）；B ——
    `mergeProtocolInstruction` 收指令数组（N 指令 → 1 帧：DFS 填洞 / 空洞
    保留发射归零 / 溢出 `.flat()` append），编排页同协议多绑定按 slot_order
    升序依洞填装、洞位下拉稠密位次（改洞组内重编号 0..n-1 仅回写变化行，
    挂载零回写）、`countSlots` 三态警示（无 SLOT/洞位不足/空洞）、侧栏按
    （协议序, 洞号）重排；C —— 「封装试发」前端 InstructionEncoder 编译
    （getInitialValues → resolveDependencies → encodeInstruction）→
    `POST /dispatch` 载荷零改，`SENT: <hex>` / `SEND FAILED: <detail>`（409
    透出）回显、空组装双闸禁发。验收：前端 **483/483（37 文件）**（+36，
    UI 新 7 红转绿）、后端 **215/215**（+10）、build EXIT=0、校验器触
    9 文件 0 违规；零 DDL → 无 db 提交。两页 + 两闭环人工目视已验
    （2026-09-23 用户回「通过」）。
    明细见 `docs/PLAN_Backlog.md` §8.7。
13. **② 范围修订：slot 作 refs 目标**（2026-09-23 用户确认新语义，红测先行
    独立批落地）：定义期长度字段可引某 slot —— 卡面维持 `??`
    （`computeRefsSigma` 签名扩展 root 参判槽→null，不改共享 byId 契约）、
    `handlePickBlock` 放开 slot（自引用仍拒 + `SYS: 不能引用自身` 提示）、
    后端 `_validate_refs` 删锚 slot 400、`mergeProtocolInstruction` 填槽改写表
    把引用该槽的 refs 换成注入块 ids → 编码器 `Σ fieldSizes` 零改动算含载荷
    真长度。验收：前端 **486/486**（基线 483 + ② 新 3）、后端 **215/215**、
    build EXIT=0、校验器触 6 文件 0 违规；后端活探针 slot refs POST 200。
    **待办：人工复测**（slot 拾取计数进位 / 自引用 SYS 提示 / 含槽卡面 `??` /
    组装试发 SENT 长度含载荷真值）；零 DDL → 无 db 提交，明细见 PLAN §8.7。
    运维注（代理侧重启惯例）：本批曾踩两连坑 —— ① StatReload **静默失效**
    （日志只剩历史 Reloading 行、强触 mtime 无新检测、worker 带旧码续服，
    无 traceback）；② `start-dev.ps1` 的 `-NoExit -Command` 窗口包裹在代理
    重启下被 PS 5.1 `NativeCommandError`（uvicorn 全量 stderr）带崩 reload
    整链（`Reloading...` 后无下文、reloader 消失）。代理侧改用
    `Start-Process python -ArgumentList @('-m','uvicorn',…,'--reload')
    -RedirectStandardOutput/-RedirectStandardError <log> -WindowStyle Hidden`
    （不经控制台管道），改后端代码后以 curl 探针 + `backend.err.log`
    `Reloading` 行双验在位；**勿**用 `CommandLine -match 'uvicorn'` 全量过滤
    杀窗口（命令行含过滤字面量会自匹配误杀执行 shell，已发生一次）。
14. **协议页批次一：级联引用清理 + 保存失败恢复**（2026-09-23 协议页分析
    P0 批落地）：P0-1 删协议前查 `/bindings` 引用 → 有引用 `NieRModal`
    警示连带清理（`DELETE /protocols/{id}` 同事务级联删 `protocol_bindings`
    返回 `deleted_bindings`，状态回显"连带清理 N 条"），无引用直删、仅剩一个
    协议禁删给 `SYS` 提示；P0-2 `removeNode` 收集被删子树 id 集后级联剥离
    剩余树 `parameter_config.refs` 命中项（含容器子孙），防悬空 400
    "refs target not found" 整树卡保存；P0-3 保存失败横幅（镜像指令页 P4-2）
    区分「服务端拒绝 / 网络·服务错误」透传 detail，失败负载归还
    `pendingSaveRef`（flush / beforeunload 重新武装、in-flight 窗口同样守），
    重试 = `flushPendingSave`、× 只关横幅不清脏态；创建/删除失败状态栏透传
    `error.message`。验收：前端 **492/492**（基线 486 + 新 6：protocolTree
    +2 / Protocol +4）、后端 **218/218**（基线 215 + 新 3
    `test_protocol_delete`）、build EXIT=0、校验器触 `Protocol.jsx` 0 违规；
    `Protocol.jsx` 存量 1 error 2 warnings（react-hooks/immutability +
    exhaustive-deps，HEAD 同报）不计入本批。零 DDL → 无 db 提交，明细见
    PLAN §8.7 批次一条目。**待办：批次二** → 已落地（见 15）。
15. **协议页批次二：保存前结构校验 + 撤销/重做**（2026-09-23 用户「继续」
    批准，P0-4 + P1-5 批落地）：`utils/validateProtocol.js` 纯函数校验
    （errors 阻断 / warnings 提醒，条目带 blockId 可定位），跑点 =
    `saveProtocol` 唯一咽喉 —— errors 不 PUT、pending 归还（beforeunload
    继续拦）、`SYS: 保存被阻止 N 个结构错误`；问题清单**常驻属性面板顶部**
    （选中块不隐藏）、点条目 `findAncestors` 展开祖先 + 选中定位，修复后
    下一次防抖自动放行，保存成功状态栏并入 `· N 提醒`。撤销/重做复用
    指令页 `useHistory(50)`：`commitTree` 压旧快照（协议改名同入口），
    undo/redo 换快照重新入防抖链（自动保存语义下撤销即时落库），**保存
    不清史**、切协议清史、新编辑作废 redo；顶栏新增 `PROTOCOL EDITOR` 条
    （镜像指令页）挂 撤销/重做 按钮 + Ctrl+Z / Ctrl+Shift+Z（输入聚焦或
    删除弹窗打开不响应）。验收：前端 **505/505**（基线 492 + 新 13：
    validateProtocol +10 / protocolTree +1 / Protocol +2）、后端
    **218/218**（本批零后端改动全量回归）、build EXIT=0、校验器触
    `Protocol.jsx`/`ProtocolPropertiesPanel.jsx` 0 违规；改写存量 1 例
    `edit block properties`（4 字节 hex 改 8 字符适配 fixed 严等），
    ESLint 仍为 HEAD 存量 1 error 2 warnings 不计入本批。零 DDL → 无 db
    提交，明细见 PLAN §8.7 批次二条目。**待办：批次三** → 已落地（见 16）。
16. **协议页批次三：复制协议 / 复制块**（2026-09-23 用户「继续」批准，
    P1-1 + P1-2 批落地，全前端零后端改动）：`buildDuplicateProtocolPayload`
    —— 协议级整树重生 id + refs 全量自含重映射（丢悬空防 POST
    `_validate_refs` 400）+ label「(副本)」升序，侧栏行悬停「副本」按钮
    触发 POST 直建并切到副本（防抖自动保存下无 dirty 确认语义，切协议即
    flush）；`duplicateNode` —— 块级深拷贝插源块之后（子树全新 id、根标签
    同层 `_N` 防撞、**refs 保持指原块 = un-wired 副本**、pc 零别名），属性
    面板「复制块 (DUPLICATE)」触发，副本立即选中、容器副本顺手展开。共享
    `cloneTreeWithNewIds` 两阶段发号（**后记**：该块级入口后随人工验证第 3 轮
    #1 撤 UI 并连删，见 22）。验收：前端 **511/511**（基线 505 +
    新 6：protocolTree +4 / Protocol +2）、后端 **218/218**（零后端改动
    回归）、build EXIT=0、校验器触 `Protocol.jsx`/`ProtocolListSidebar.jsx`/
    `ProtocolPropertiesPanel.jsx` 0 违规；ESLint 仍为 HEAD 存量 1 error
    2 warnings 不计入本批。零 DDL → 无 db 提交，明细见 PLAN §8.7 批次三
    条目。**待办：批次四** → 已落地（见 17）；批次五 `version` 乐观并发 → 已落地（见 19）。
17. **协议页批次四：协议 JSON 导入/导出 + 协议级属性 + checksum 算法配置**
    （2026-09-23 用户「继续」批准，P3-1/P3-2/P3-3 批落地，前端为主 +
    后端 handlers refs 集合模式）：顶栏 导出/导入 按钮 —— 导出当前工作
    副本原样下盘 `{schemaVersion, protocols:[…]}`；导入 parse →
    `analyzeProtocolImport`（结构校验 + 全树重生 id + refs 自含重映射 +
    撞名「(导入)」升序）→ 预览弹窗 → 顺序 POST 追加**不覆盖**并切到首项
    （镜像指令页 P3-2 范式；后端 label 不唯一故无 conflicts）。协议级视图
    新增 description textarea（schema 既有字段零 DDL，`onProtocolLabelChange`
    改名 `onProtocolMetaChange` 共用 apply+schedule）。checksum 卡新增
    「校验算法」下拉（SUM8/XOR8/CRC16-MODBUS，缺省 CRC16-MODBUS）存
    `parameter_config.algorithm`（编码器 PASS2 同源直读）；编排导出
    `toFrameBlocks` 出口把 refs（数组序叶子展开）+ 算法枚举翻译进
    `config.params`，后端 Length/ChecksumHandler 新增 refs 集合模式 ——
    **打通 R2 死 `config:{}` 恒 00 断点**（无 refs 键的旧 range 模式原样
    保留）。验收：前端 **525/525**（基线 511 + 新 14：toFrameBlocks +5 /
    importExport +5 / validateProtocol +1 / Protocol +3）、后端
    **230/230**（基线 218 + 新 12：`test_logic_refs_config`）、build
    EXIT=0、校验器触 `Protocol.jsx`/`ProtocolPropertiesPanel.jsx`/
    `ProtocolListSidebar.jsx` 0 违规；ESLint 仍为 HEAD 存量 1 error
    2 warnings 不计入本批。零 DDL → 无 db 提交，明细见 PLAN §8.7 批次四
    条目。**待办：批次五** → 已落地（见 19）。

18. **两页卡面取值口径改造：能确定 → 直接显示数值，不确定 → 按字节数等量 ??**
    （2026-09-24 用户直接下达、三问确认口径，纯前端展示层零后端）：
    `formula.js` 新增 `formatUnknown(byteLen)` 按字节数出等量 `??`
    （1B→`??`、4B→`?? ?? ?? ??`，替代写死单个 `??`）；长度值十进制化 ——
    协议页 `injectRefsSigma` → `${sigma}B`、指令页 `LENGTH_CALC` →
    `${result}B`（hex `0F` 会被读成字节值；宽度/页脚与偏移标尺另承担尺寸
    口径）。组/容器卡中央值 = **嵌套内容逐块拼接**（字面 hex 出 pretty、
    未知按 byte_length 出等量 ??，如 `AA 55 ?? ??`，页脚仍显尺寸
    `4B @00`）—— 指令页 `useInstructionLanes.fieldContent` 递归、协议页新
    导出 `injectContainerContent` 链式接入 `Protocol.jsx displayLanes`
    （length/checksum/slot 的 hex_value `'00'` 建块默认占位不算已知；空容器
    不注入落尺寸分支 `0B`）；协议 length/checksum 与指令 CHECKSUM 空 refs →
    等量 ??，组卡尺寸已知无内容 → 按尺寸出等量 ??（size=0 → `0B`）。
    TIME_ACCUMULATOR 中央值下方新增 `BASE 2026-09-23 14:00` 小字（未配置
    → `BASE ?`；无基准注入等量 ?? 占位、有基准保留 hex 差值口径）。注入全为
    派生副本不落库，`byteOffsets` 回退已核实不破坏（组分支只走 Σ 子不读
    computedValue）。验收：前端 **531/531**（基线 525 + 新 6：Block +2 /
    useInstructionLanes +2 / protocolTree +2，存量断言 hex→十进制与组卡
    `4B`→内容串/等量 ?? 属预期更新）、后端 **230/230**（零后端改动回归）、
    build EXIT=0、校验器触 `Block.jsx`/`Protocol.jsx` 0 违规；ESLint 与
    HEAD 存量逐文件对齐无新增（Block 1e+1w / useInstructionLanes 3e+5w /
    protocolTree 0 / Protocol 1e+2w）。零 DDL → 无 db 提交，明细见 PLAN
    §8.7 卡面口径条目。**待办：批次五** → 已落地（见 19）。

19. **协议页批次五：version 乐观并发**（2026-09-24 用户批准，三口径确认：
    有 DDL 整数列 / 缺 version 直通 / 冲突双动作）：`protocols` 表新增
    `version INTEGER NOT NULL DEFAULT 1`（本仓无迁移框架 → 启动
    `ensure_protocol_version_column` PRAGMA 查缺列则 ALTER 自愈、DEFAULT 1
    回填存量行、幂等）。PUT 携带客户端最后见到的 version、不符 **409** 拒收
    陈旧写（先于 refs 校验），成功写恒 +1，`ProtocolResponse` 回读；缺
    version 的直调写（旧客户端/curl）跳过比对直接覆盖。前端 `saveProtocol`
    携带本地 version，保存失败横幅三分类（版本冲突/服务端拒绝/网络），冲突
    态换「强制覆盖」（按 id 拉最新 version 带本地负载重发）与「加载最新」
    （放弃本地、服务端版本替换工作副本并清历史）双动作，非冲突仍「重试」。
    验收：前端 **534/534**（基线 531 + 新 3：Protocol +3）、后端 **240/240**
    （基线 230 + 新 10：`test_protocol_version`）、build EXIT=0、校验器触
    `Protocol.jsx`/`Protocol.test.jsx`/两 api 文件 0 违规；ESLint
    `Protocol.jsx` 仍 1 error 2 warnings 无新增。**本批含 DDL** → yorha.db
    随本批入库，明细见 PLAN §8.7 批次五条目。

20. **Core Pipeline 批次一：绑定 → 封装 → 发送主线闭环（1a–1d）**（2026-09-24
    12 条设计拍板全 A 后实施，`docs/DESIGN_CorePipeline.md` §7 首批）：1a
    `protocol_bindings` 三列 DDL（`slot_id`/`is_default`/`priority`，仅新增 +
    启动自愈 `ensure_binding_columns` 补列并创建两部分唯一索引）+ 绑定 CRUD
    三字段与 `GET /bindings?instruction_id=` 过滤 + 设默认同事务清旧默认；
    1b `core/frame_builder.py` + `POST /compile/wrapped`（协议树填洞 →
    length/checksum 真值重算的**后端唯一封装入口**，主向量 `FA FA 02 01 02 ED`
    与前端 merge+encode 三端同钉、改一必改三）；1c `/dispatch`·
    `/dispatch/transaction` 可选 `wrap`（**缺省裸帧逐字节不变**）+ 加工页
    wrap 状态机（ok/none/failed/missing 降级裸发）与封装预览（300ms 防抖
    compileWrapped）、「:: Wrap ::」开关**默认开**（TRANSMIT 与事务同轨）+
    编排页星标默认封装（is_default，删除按钮后）与试发改线（逐指令编码 →
    compileWrapped → dispatchPayload）；1d 文档同步（pageStatus/
    PAGE_STATUS 重生成/PLAN §8.8/设计稿三处偏离注记）。验收：后端
    **296/296**（基线 240 + 56）、前端 **542/542（40 文件）**（基线 534 +
    8）、build EXIT=0、校验器触 4 个 UI 文件 0 违规。**本批含 DDL** →
    yorha.db 单独同步提交。两处偏离（撤销 `(protocol_id, instruction_id)`
    至多一行约束 / `build_wrapped` 收已编码内核 hex 签名）见
    `docs/PLAN_Backlog.md` §8.8 偏离注记。**已验证并提交 ✅ `31bc367`
    （代码+文档）/ `da91228`（db 同步），2026-09-24；反馈 1（星标确认）与
    反馈 2（协议卡面直填 §8.9）均已并入。**

21. **人工验证反馈 2 第 2 轮：四条口径实施（卡面 ?? / 指令草稿隔离 / 协议·编排
    手动保存）**（2026-09-24 逐条确认后实施，全部红→绿，2026-09-29 桌面端核验
    通过后与 #22 合并一单提交 ✅ `ce20122`，明细见 `docs/PLAN_Backlog.md` §8.10）：
    - #1 协议卡面未配置固定块 `??` 非 `00`（含空容器 `??`）：根因 `OP_CODES`
      缺 `STRUCT` 键致组卡恒判 fixed；补键 + `hexLooksUnconfigured`（全 0 →
      等量 `??`）+ `formatUnknown`；计算层保留全 0（存储值 = 编码真值）。测试
      Block +3 / protocolTree +2。
    - #2 指令草稿隔离：`useInstructionData` `draftInstruction` 单槽 + merged
      overlay，编辑/撤销/重做只写草稿、`saveChanges` 成功写穿共享 —— 指令加工
      页共享态保存前零写入（hook 测试 +3）。
    - #3 协议手动保存：防抖链退役，`draftProtocol` 草稿 + 派生脏标；commit/undo/
      redo 只动草稿；SAVE 按钮（属性面板）+ 顶栏 UNSAVED；切协议/新建/复制/导入
      弹「放弃未保存的更改？」；横幅重试 = `saveChanges`；`beforeunload` 脏标
      拦截；保存 = 写穿 + 清草稿 + 清史（镜像指令页）；409 双动作/校验闸/签名
      跳过保留。Protocol.test 17 红 → 26 绿。
    - #4 编排手动保存：`dirtyIds` 脏行集合，label/协议/指令/洞位编辑标脏不 PUT、
      SAVE 逐行落库（比对已发载荷防误清）；星标/增删即时保持；防抖 + 卸载冲刷
      退役改 `beforeunload`；降级态不标脏。Orchestration.test 4 红 → 18 绿。
    - 1d 文档：pageStatus 三段 11 处口径 + PAGE_STATUS 重生成 + PLAN §8.10。
    - 验收：前端 **559/559（40 文件）**（基线 556 + 3）、后端 **296/296**（纯
      前端回归）、build EXIT=0、校验器触 5 个 UI 文件 0 违规、PAGE_STATUS
      EXIT=0。**零 DDL** → 无 db 提交。✅ 已随 `ce20122` 提交（与 #22 合并，
      2026-09-29）。

22. **人工验证反馈 2 第 3 轮：六条实施（复制块撤除 / 卡面存储值 / 两页 SAVE
    底置 / 编排分栏·交互）**（2026-09-24 取证确认后实施，全部红→绿，
    2026-09-29 桌面端核验通过后与 #21 合并一单提交 ✅ `ce20122`，明细见
    `docs/PLAN_Backlog.md` §8.11）：
    - #1 复制块撤除：两页 `onDuplicateBlock`/handler/`duplicateBlockInInstruction`
      util + 单测全删；`duplicateNode` 纯函数 + 3 单测随后按用户拍板（「连删」）
      一并移除 —— `cloneTreeWithNewIds` 留用（协议级复制 / JSON 导入共用），
      `remapRefs=false` 死分支随之清除；侧栏「副本」整条复制保留。
    - #2 卡面口径：撤「全 0 → ??」回退——未配置固定块显存储值（`0000`→`00 00`）、
      空容器中央空白（页脚仍 `0B @00`）、`??` 仅限无法确定；计算层存储值 = 编码
      真值不变。
    - #3/#4 SAVE 底置：协议页属性面板底部动作区（协议级 + 块级字段之后 mt-auto）；
      编排页底部动作区（`● N 条未保存` 计数行 + 常驻 SAVE）。
    - #5 分栏：编排 section 补 `min-w-0 overflow-hidden`（flex `min-width:auto`
      根因），三页 aside 补 `shrink-0`，协议/编排 aside 补 `overflow-y-auto`。
    - #6 编排交互：侧栏脏行琥珀 ●（title=有未保存更改）；属性面板四分区
      IDENTITY/STRUCTURE/HOLE/ACTIONS，协议外壳/指令内核从头部下移；底部计数行 +
      SAVE 常驻 `disabled`（干净或降级）。
    - 1d 文档：pageStatus 协议·指令·编排三段 9 处 + PAGE_STATUS 重生成 + PLAN §8.11。
    - 验收（连删后终态）：前端 **557/557（40 文件）**（第 3 轮原 560，连删
      duplicateNode 3 单测 -3）、后端 **296/296**、build EXIT=0、校验器
      触 10 文件 0 违规、PAGE_STATUS EXIT=0、schema SCHEMA_IDENTICAL（零 DDL）。
      ✅ 已随 `ce20122` 提交（与 #21 合并，2026-09-29；`duplicateNode` 连删同批）。

23. **指令加工页编辑四条：TIME 徽标 / 字节高亮 / 右栏分区 / 定长限制**（2026-09-29
    口述 + 三问确认后实施，全部红→绿，明细见 `docs/PLAN_Backlog.md` §8.12）：
    - #1 TIME 字段不再误标 READ_ONLY：`SmartInput` 增 `pickerMode` 满亮实线
      lane + `[TIME_PICKER]` 徽标（点选日期取值形态不变，input 仍 DOM 只读）。
    - #2 点击字段（含整块容器）→ BYTE_STREAM_OUTPUT 高亮：新 `utils/byteHighlight.js`
      纯函数 5 个 + `byteMap` 接线（此前在 InstructionRunner 丢弃），分段 span
      反白 + title `字段名 @0xNN` + 「SEL :: 字段名 · 0xNN-0xNN · NB」读数条，
      换指令复位。人工验证反馈修复：嵌套组内点叶字段被冒泡升成整组（组容器
      onClick 覆盖叶 id）→ 叶行/组头 `stopPropagation` 选中即止，叶精确到
      自身字节、内组头不被外层组覆盖（组头点击 = 整块高亮保留）。
    - #3 右栏三分区标题 + 中文用途释义（BYTE STREAM 字节流预览 / PROTOCOL WRAP
      协议封装 / TRANSMIT 发送与导出）+ 读数条；Transaction/Log 自带 :: 标题
      不重复。
    - #4 定长输入限制 `computeFieldInputLimits`：hex 截断 byte_len×2 字符 +
      「n/N BYTES」徽标，数值按 0..2^(8n)-1 即时钳制（INT_SIGNED 两补码域、
      SCALED_DECIMAL 按 factor/offset 反算、超 2^53 封顶 MAX_SAFE_INTEGER）；
      编码端口径不变。
    - 验收期反馈两轮（同批）：① 同字段多字节段内连写 `00000000` →
      `buildHexSegments` 段内逐字节 `XX XX` 空格分隔（与整帧格式一致，高亮
      仍按整字段段）；② 测试首开日期选择器暴露 `NieRDatePicker` 既有 hooks
      违规（`if (!isOpen) return null` 先于 hooks，isOpen 翻转钩子数 0→2 跳变
      → React 内部错误 static flag）→ 早退后置 + `NieRDatePicker.test.jsx`
      红测锁定，并同触同清该文件 4 处既有校验器违规（backdrop-blur 改实底、
      p-6→p-3、px-8→px-5、shadow 移除）。
    - 1d 文档：pageStatus 加工段 5 处（含 runnerRenderRules 27→33 单测计数）+
      PAGE_STATUS 重生成 + PLAN §8.12。
    - 验收：前端 **580/580（42 文件）**（基线 557 + 23，含嵌套/格式/picker
      三轮反馈回归测）、后端 **296/296**、build EXIT=0、校验器触 9 文件
      0 违规、PAGE_STATUS EXIT=0、schema SCHEMA_IDENTICAL（28 对象，零 DDL）
      → 无 db 提交。✅ 2026-09-29 人工验证通过，一单提交 `c4e3480`。
24. **位编辑 + 十进制录入（批 1-4）**（2026-09-30 口述 + 四问确认后实施，
    全部红→绿，明细见 `docs/PLAN_Backlog.md` §8.13）：
    - **批 1 字段级十进制录入**（纯 FE）：属性面板参数区顶部固定行
      「录入进制 (INPUT BASE) HEX|DEC」存 `parameter_config.input_base`（缺省
      hex，`isDecimalEntry` 大小写不敏感/非法回退）；加工页定长整数字段切
      十进制通道（十进制原值、数值域钳制、`[nB]` 徽标，`maxLength` 不回吐）；
      **值存储恒数值 → encoder/后端零改动**。
    - **批 2 位图可视化**（纯 FE）：新 `utils/bitGrid.js` 纯函数层（位网格
      byte×8、bit0 在右 = LSB、冲突标红、溢出段照常渲染、`packBits` 与编码器
      镜像锁定）；`BitFieldEditor` 加位图主视图（点两格设段、点色块选段、
      表格↔位图双向联动），表格保留精确数值编辑。
    - **批 3 加工侧子位录入**（纯 FE，两者并存）：新 `BitSegmentInputs.jsx`，
      整包输入下方按 `bits[]` 展开子位行；**单一真源 = 字段整数**，改子位经
      `writeBitSegment` 只重写本段（间隙位保留）、整包改则子位重算；算术拆包
      避开 JS 32 位截断。
    - **批 4 协议结构化位域**（FE+BE，重方案）：新块型 `bitfield`（palette +
      面板复用 BitFieldEditor + `toFrameBlocks` 位段透传 + 卡面显打包字节 +
      导入白名单补 bits）；后端 `ProtocolNodeSchema.bits`（不补则 pydantic
      静默丢弃）、`_validate_bits` 落库拦重叠/超容量 400、打包收敛到
      `Orchestrator` 发射期单点（新 `handlers/bitfield.py`，两路共用）、
      `BlockType.BITFIELD`。语义：静态默认值打包、发送期不可改值；不含解码
      回程（后端 encode-only）。
    - 验收：前端 **648/648（46 文件）**（基线 580 + 68）、后端 **315/315**
      （基线 296 + 19）、build EXIT=0、校验器触 8 文件 0 违规、PAGE_STATUS
      EXIT=0、schema **SCHEMA_IDENTICAL**（28 对象 —— 位段存 children JSON
      列，零 DDL）→ 无 db 提交。存量 wrap 共享向量与裸发路径逐字节不变。
      **✅ 真机验证通过（2026-09-30 浏览器逐条全绿零 bug）→ 拆四单提交：
      批1 `23ad28e` / 批2 `327ac8c` / 批3 `f8dcf64` / 批4 `e6a31a4`。**

25. **调研后优化（优化批，批 1-4 的增量）**（2026-09-30 市场调研差距表经用户
    拍板取 1-4 四项，红→绿，明细见 `docs/PLAN_Backlog.md` §8.14）：
    - **BIN 三态进制 + 前缀识别**（纯 FE）：录入进制 HEX|DEC|BIN 三态；加工页
      二进制位模式通道（定宽回显、n/N BITS 徽标、无数值域）；hex 容 0x/0X
      归一纯 hex、dec 容 0x/0b（Number 原生，红测锁定）、bin 容 0b 输入糖；
      值存储恒数值 → encoder/后端零改动。
    - **位段值表（DBC VAL_）**：新 `utils/bitMeta.js`（脏值清洗 +
      `0=关,1:开` 解析/回显）；位图表格值表列 + 格 title/默认值 title 名称
      回显；子位行值表下拉（选择仍回传打包整数、只动本段）；协议侧
      `BitFieldSchema.value_table` Pydantic 透传（children JSON 零 DDL）、
      协议导入白名单保留并清洗。
    - **有符号位段（DBC signed）**：`normalizeBits/unpackBits/clampBitValue/
      writeBitSegment` 两补码语义（拆包负值、域钳制、回写转位模式且邻段保留）；
      位图 U/S 开关 + signed 行默认值负域、子位行负值回显。**打包口径零改动**
      （raw&mask 两补码天然覆盖，负 default 向量 `-40→D8` 双端锁）。
    - **位号标尺**：位图顶部 `7..0` 列头（LSb0 口径，先于字节行）。
    - **零 DDL 存储**：指令侧元数据骑 `parameter_config.bit_meta` ——
      `normalizeFieldPayload` 单点按 bits 重建拆分（保存/导入共用）+
      `instructions` memo 读时按位段 id 幂等合并（**位段自身键优先**，
      陈旧 pc.meta 不覆盖用户改动）。
    - 验收：前端 **683/683（47 文件）**（基线 648 + 35）、后端 **319/319**
      （基线 315 + 4）、build EXIT=0、校验器触 4 文件 0 违规、PAGE_STATUS
      EXIT=0、schema **SCHEMA_IDENTICAL**（28 对象，零 DDL）→ 无 db 提交。
      存量 wrap 向量与裸发路径 byte-equal 不变。
      **✅ 真机验证通过（2026-09-30 优化 1-4 逐条全绿）→ 第 5 单已提交
      `3668d37`。**

26. **验证反馈：校验标色**（2026-09-30 批 1-4/优化批人工验证中提出，红→绿，
    明细见 `docs/PLAN_Backlog.md` §8.15）：属性面板的 ⛔/⚠ 提醒清单同步点亮
    画布对应卡 —— 新纯函数 `utils/issueBadges.js`（清单 → `Map<blockId,
    {level, messages}>`，错误优先、消息聚合）→ `Canvas` 新 prop
    `validationIssues` → `Block` 新 prop `issue`：非选中态内联边框色（错误
    红 `#D94834` / 提醒琥珀 `#E58D28`，与面板同色系）+ header ⛔/⚠ 角标
    （`data-issue-chip`，title 悬停显全量消息）；选中/拾取态保既有边框、角标
    不丢；角标计入内容宽度地板。协议定义页 + 指令定义页接线（随编辑实时重算），
    蓝图/编排页不传零变化。**顺带（拍板「收紧过闸」）**：校验器抓到 Canvas 既有
    2 条 `NO_SOFT_SAAS_PADDING`（`pl-8` 嵌套缩进 / `p-10` 画布留白，非本批引入），
    收紧为 `pl-3`/`p-3`（布局变化随本批验证）。验收：前端 **696/696（49 文件）**（基线 683 + 13）、
    后端 **319/319**（纯 FE 零后端改动）、build EXIT=0、校验器触 4 文件 0 违规、
    PAGE_STATUS EXIT=0、schema **SCHEMA_IDENTICAL**（零 DDL）→ 无 db 提交。
    **✅ 真机验证通过（2026-09-30 红/琥珀/让位/pl-3 逐条全绿）→ 第 6 单已提交
    `3ff0f69`。**
27. **业务场景全集排期（G1–G7 → N1–N5）**（2026-09-30 用户要求「按指令编制
    业务全集一次盘满，而非提一个查一个」，盘查落档 `docs/BUSINESS_SCENARIOS.md`、
    排期见 `docs/PLAN_Backlog.md` §8.16）：四层能力矩阵（值表达 / 结构组织 /
    字节位布局 / 运行加工 + 护栏）对照出 7 个此前未记录的缺口 —— **G1 条件
    分支/变体族**（真业务阻断，方案 B：组级 `presence`，N3 重头）、**G2 字符串
    三连**（无入口 / 不定长 / 非 ASCII 脏字节，N2）、**G3 帧字节转义**（后端
    仅空 placeholder，N4 已解）、**G4 填充对齐**（N5 已解）、**G5 未知 op 静默
    错码**（N1 FE 提醒先行 → G5 收口双端硬拦已解，第 12 单）、**G6 STRUCT 无创建入口**（N1 定性
    存量兼容）、**G7 float64 陷阱**（N1 校验摘陷阱）。已立暂缓（§8.14 四项）与
    已知范围外（E1-4 float64）不重复排。**N1 与六单零文件重叠可并行开发；N3
    与六单共享文件必须等六单提交**。文档 + N1 随第 7 单提交，不混入六单。
    **进度（2026-09-30）**：N1 红→绿完成（FE 700/700 · BE 322/322）→ 真机
    验证通过 → 3 文档 + N1 作为第 7 单已提交 `7d50484`；N2 字符串批红→绿完成
    （红测 FE +28/BE +10，全量 FE **728/728** · BE **332/332**、build 0、
    校验器触 4 文件 0 违规、pageStatus EXIT=0、schema 零 DDL；`STRING` 模板 +
    定长 pad/截断 + ascii/utf8 + W6 + 双端 byte-equal 向量锚定）→ 真机验证
    通过 → 第 8 单已提交 `848e248`（`validateInstruction.js` 按 hunk 与 N1
    分离）。N3 组级 presence 红→绿 1 轮（7 个新增测试文件，全量 FE
    **812/812（55 文件）** · BE **342/342**、build 0、校验器触 13 文件 0 违规、
    pageStatus 0、schema 零 DDL；编码四插点 + BE to_block 镜像 + 静态三态 +
    校验 4 码 + IF 角标 + 面板 PRESENCE 区 + normalize 清洗）→ 真机验证通过
    （三态静态判定 / fail-open / CLEAR 复原 / 保存 JSON 落库 / 整页刷新往返
    一致）→ 第 9 单已提交 `8e9612f`。N4 帧字节转义批（层位拍板「**传输层 ·
    内核转义后套壳**」，配置骑 transport config `escape` 段零 DDL，内核域按逻辑
    字节 / 壳域按线上字节）红→绿 1 轮（全量 FE **823/823（56 文件）** · BE
    **367/367**、build 0、pageStatus 0、校验器 4 文件 0 违规、SCHEMA_IDENTICAL
    28；BE `test_escape.py` 25 例含双端共享向量 + FE `escapeTable` 7 例 +
    `Terminal` 4 例；出线三路 dispatch 裸发·套壳 / 事务 / 序列接线，replay 不
    二次转义）→ 真机验证通过（面板 APPLY 落库归一 / 裸发 `AA 7D 01 → AA 7D 5D
    01` / 关闭态 3B byte-equal / 整页刷新往返零 ERR / 套壳 `FA FA ED 00 01 7D →
    FA FA ED 00 01 7D 5D` 外壳字面不转 / 现场复位）→ 第 10 单已提交 `b7f9fa7`
    （环境插曲：uvicorn StatReload 卡死跑旧代码，重启后端排除，非代码缺陷）。
    N5 填充/对齐批（拍板「**字段级 `align` + `pad_to` 骑 `parameter_config` 零
    DDL**」，pad 进发射流/偏移尺/LEN/卡宽、不进长度公式/checksum/byteMap 内容
    口径）红→绿 2 轮（全量 FE **866/866（62 文件）** · BE **371/371**、build 0、
    pageStatus 0、校验器 10 文件 0 违规、SCHEMA_IDENTICAL 28；BE
    `test_encode_align.py` 16 双端共享向量 + FE 6 新测试文件 + `byteHighlight`
    gap 补测（BYTE_STREAM 无主段补齐，渲染 = hexPreview 全字节）；面板 ALIGN 区 +
    A4·P8 角标 + 卡宽含 pad + `orchestrator` 发射期游标/容器 `_PadMark`）→ 真机
    验证通过（APPLY → `@01→@04`/`@09→@10`、LEN `~9B→~16B`、卡宽 162·494·74px /
    整页刷新往返 4·8·FF 回填 / FE=BE `00FFFFFF414C504841000000FFFFFFFF` byte-equal
    / 裸发 16B echo=payload / CLEAR 还原 / `align=9999` fail-open 提醒不锁）→
    第 11 单已提交 `d8f0d65`。G5 双端硬拦插队批（拍板「**保存侧 400 硬拦 +
    FE W5 升 error**」，双端 KNOWN_OPS = OP_CODES 15 + encoder legacy 5 = 20 项
    同源同步、改一必改二；摸底 2026-09-30 + 真机 sweep 16 指令 × 37 字段 0 未知
    → 硬拦不锁历史）红→绿 1 轮（全量 FE **867/867（62 文件）** · BE **383/383**、
    build 0、pageStatus 0、校验器 2 文件 0 违规、SCHEMA_IDENTICAL 28；BE 新
    `test_op_whitelist.py` 12 例含 POST 拒绝零落库 / PUT 拒绝存量原样、FE
    `validateInstruction.test.js` 升 error 口径；`_validate_op_codes` 接 POST/PUT
    写入前 + FE OP_UNKNOWN 入 errors 自动生效于保存门 / 卡面 ⛔ 章 / 导入预览
    分流）→ 真机验证通过（POST/PUT 未知 op → 400 detail 且存量 UNCHANGED、UI 导入
    预览「校验错误 1 · [OP_UNKNOWN] …保存已阻止 · 没有可导入的指令」零落库、画布
    error 章 0 零误报、CMD-632 正常保存回路 UNSAVED 清除）→ 第 12 单已提交
    `b715e2b`。
    **六单 + N1/N2/N3/N4/N5 + G5 双端硬拦插队批全部部落库**
    （批1-4 `23ad28e`/`327ac8c`/`f8dcf64`/`e6a31a4`、第 5 单 `3668d37`、
    第 6 单 `3ff0f69`、第 7 单 `7d50484`、第 8 单 `848e248`、第 9 单
    `8e9612f`、第 10 单 `b7f9fa7`、第 11 单 `d8f0d65`、第 12 单 `b715e2b`）→
    **G1–G7 全集七项全部已结**。
28. **死代码清理批（第 13 单 · 维护批，行为不变）**（2026-10-01）：全仓三层
    AST 扫描（未用 import / 无外部引用 export / 整文件孤儿）→ 逐项人工核验 →
    清除，§9 保留名单不动（processor.py / graph.py / Blueprint.jsx）。BE 11 文件
    无用 import：orchestrator 删 `Dict·Layer·GraphEngine`（活文件自此不再 import
    §9 遗留 graph.py）、models `Boolean`、debug_db `quote_plus`、handlers
    `Dict·Any·binascii`、operator `HTTPException`、schemas `Union·Any·Field`、
    test_datahub `BitField`；orchestrator 两条过时注释改 N4 定案指针 —— 旧占位
    `# from backend.handlers.escape import EscapeHandler (To be implemented)`
    （模块从未存在）与 `ESCAPING LOGIC (Placeholder)` →「传输层 · 内核转义后套壳」，
    编排器只出逻辑字节、出线转义在 `backend/core/escape.py`（dispatch/sequence
    调用）。FE：`EMPTY_ESCAPE` 判死（全仓零引用）、InstructionEncoder 无用 import
    `formatToHex·formatFloatToHex`、GlitchEffect 无用 `motion` → framer-motion
    全仓零引用连根卸依赖（package.json −1、lock −3 包）；整文件孤儿 2 个：
    `visuals/ProtocolOnion.jsx`（仅自引）、`ui/FeaturePlaceholder.jsx`（PLAN §E3
    曾记「组件保留未删」，Terminal 重写后无任何入口，本批清除，README/文件地图
    同步）。红绿依据（清理批口径：删除若为活代码既有测试即红）：BE 383/383 ·
    FE 867/867（62 文件，依赖卸除后复跑）双绿 · py_compile 0 · build 0 ·
    pageStatus 0 · 校验器 3 文件 0 违规 · SCHEMA_IDENTICAL 28。真机冒烟（uvicorn
    重启载清理后代码 + vite:5173）：指令页 22 卡零崩溃 · error 章 0；加工页
    TRANSMIT → `TX_SUCCESS (LOOPBACK)`；`GET /datahub/export/bundle` 200 ZIP、
    16 指令 × 16 帧、CMD - 632 = 16B（N5 口径原样；11 个 0 字节帧 = 0 字段指令
    存量行为，有字段 5 条 = 37 字段与 sweep 一致）。→ 第 13 单已提交 `5310260`。
29. **加工页字段种类感知（第 14 单 · 用户新需求）**（2026-10-01）：加工页
    字段配置 UI「更加清晰，友好，贴合字段种类的特性」——只改加工页，定义侧
    不动。三层对齐：① **种类章** `resolveRunnerKind`（runnerRenderRules.js
    纯函数，lane 判定复用 classifyRunnerField）→ label 前小徽标
    F32/BCD/TEXT/SINT/UINT/BIT/… + title 悬停讲编码特性，右徽标保留状态/长度
    语义不挤占，组头同出章（VAR/IN 归一 GROUP）；② **通道贴合** ——
    FLOAT_IEEE 强制 float 通道（占位 `0.0`、input_base 让位、严格十进制小数
    正则与编码端同口径、指数不发值 blur 复位）、BCD_CODE 强制 bcd 数字通道
    （十进制回显、占位 `0..99…9`、滤非数字按 nibble 限宽）、STRING 用量徽标
    n/N CHARS|BYTES（超定长琥珀截断警示）、dec 通道占位即域、limits FLOAT→
    null / BCD→数字域；③ **编码契约补口**（真机实锤后拍板）—— normalize 对
    可编辑 FLOAT_IEEE/BCD_CODE/INT_SIGNED/SCALED_DECIMAL/AUTO_COUNTER 保留原
    算子（encode 五种类分支按 op 门控，摊平即全灭：真机 FLOAT 3.14 →
    `00 00 00 03`、BCD 1234 → `04 D2`；修后 `40 48 F5 C3` / `12 34` / `FB`
    逐字节锚定；带静态 value 仍判 FIXED、MAPPING/INT_UNSIGNED/TIME_*/组结构
    维持摊平不扩面）+ STRING 静态 value ≠ 固定块（N2 契约对齐：normalize
    豁免 TEXT 种类、getInitialValues 按 type=string 兜底 —— 真机 CMD-632
    'ALPHA' 整行只读坐实为误杀，修后 5/8 CHARS 可继续键入、出帧 16B 零
    漂移）。红测先行 3 轮（runnerRenderRules 15 红 → 57 绿、normalize 新建
    8 例 2 红、InstructionEncoder 1 红）+ 集成占位钉点 '0' → '0..65535' 3 处。
    红绿依据：FE **890/890**（63 文件，基线 867 + 23）· BE **383/383** ·
    build EXIT=0 · 校验器 5 文件 0 违规 · pageStatus EXIT=0 ·
    SCHEMA_IDENTICAL 28。真机（uvicorn:8000 + vite:5173，探针即建即删
    a67196d5）：6 字段探针六章/四占位全出、录入 3.14/1234/-5/HELLO_123456 →
    BYTE_STREAM 六段逐字节、`1e5` 不发值 blur 复位、12/8 CHARS 琥珀、
    TRANSMIT → `TX_SUCCESS (LOOPBACK)`；存量 CMD-632 TEXT 章 + 5/8 CHARS
    可编辑 + 16B 零漂移；error overlay 0 零崩溃；探针 DELETE 200。→ 第 14 单
    已提交 `f3adad8`。
30. **加工页全种类控件矩阵补齐（第 15 单 · 用户新需求）**（2026-10-01）：用户
    方向「时间字段要时间设置弹窗、枚举映射要下拉选项的这种」+ 拍板「全种类
    矩阵补齐」「CNT 发送成功后自动推进」。矩阵审计（14 算子 × 控件形态，代码
    + 真机）确认主干控件（时间弹窗 / 枚举下拉 / 位段值表 / 只读计算 / 种类章 /
    通道贴合）已就位，真缺口三处收口：① **无选项 MAPPING 枚举身份** ——
    身份与控件分闸（classify isEnum 认 original_op_code，下拉只由 hasOptions
    把闸），有选项照旧 select、无选项走普通通道（limits 闸改 (isEnum &&
    hasOptions) 保字节钳制）+ MAP 章（title 讲未配置）+ 语义行琥珀
    `NO OPTIONS ⚠`；② **CNT 自动推进** —— 新增 advanceAutoCounter 纯函数
    （与编码端 E1-6 逐句同口径：type 闸 / floor / input > value > start_val /
    双重取模，非计数字段 null），handleSend 成功分支回写 inputs（事务面板
    不推进），语义行出 NEXT=n 下帧预览；③ **HEADER/TAIL 只读加固** ——
    classify isFixed 认 original/字面双回退 + HDR 章上移 isFixed 之前保身份
    （旧死枝移除）+ 无 hex 帧头回显 0 填充。红测先行：runnerRenderRules.test
    +12 例（9 红 → 69 绿）。红绿依据：FE **902/902**（63 文件，基线 890 +
    12）· BE **383/383** · build EXIT=0 · 校验器 4 文件 0 违规 ·
    pageStatus EXIT=0 · SCHEMA_IDENTICAL 28。真机（uvicorn:8000 +
    vite:5173，探针 PROBE-15 即建即删）：副本枚举映射 MAP + NO OPTIONS ⚠ +
    可编辑 hex；示例心跳帧连发两帧 计数 0→1→2 / NEXT 1→2→3 / 字节位
    01→02→03；回归 TIME 弹窗 + 示例状态包双下拉 + 无误报；探针 SCALE 章 +
    FACTOR/OFFSET、STRUCT 组头 + 子字段 UINT dec；overlay 0；探针 DELETE
    200（库回 16）。附注：创建路由只存顶层字段，组契约 = 扁平 + parent_id
    （嵌套 children 静默丢弃）。→ 第 15 单已提交 `db371ab`。

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
| `src/api/` | 全部 HTTP 调用，按域拆分：`client.js`（fetch 助手）/ `protocols.js` / `instructions.js` / `operators.js` / `export.js` / `bindings.js` / `compile.js` / `dispatch.js` / `responseSpecs.js` / `sequences.js` 等 + `index.js` 桶导出 `api` 对象；**导入路径 `./api` 不变** | ✅ 原 `src/api.js` 已拆 |
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
| `src/components/ui/` | `NieRModal` / `NieRDatePicker` 通用 UI（FeaturePlaceholder 已随第 13 单死代码清理批删除） | ✅ |
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
