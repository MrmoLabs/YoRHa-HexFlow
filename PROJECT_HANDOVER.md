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
    无 db 提交。~~人工跨泳道拖拽目视待补~~ —— **已补，2026-10-02 真浏览器拖拽通过
    （见 42）**。明细见 `docs/PLAN_Backlog.md` §8.6。
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
    ~~**待办：人工复测**（slot 拾取计数进位 / 自引用 SYS 提示 / 含槽卡面 `??` /
    组装试发 SENT 长度含载荷真值）~~ —— **已销，2026-10-02 真浏览器复测 4 项全过
    （见 42）**；零 DDL → 无 db 提交，明细见 PLAN §8.7。
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

31. **D13 设计决策：层数模型与跨协议组合 → 封装配方**（2026-10-01，**纯文档批，
    零代码**）：口述形态确认为**丙「外壳套外壳」**（内核 → 应用壳 → 链路壳各自
    独立定义、发送期叠加），配套两条边界 —— 内核↔外壳只互通**总长/校验**（payload
    保持黑盒 hex，不暴露内部字段）、链路壳**有 LEN**（按「有 LEN 不需转义」判定）。
    据此拍板 **D13 = A 封装配方 + 串行 `build_wrapped`**，`PROTOCOL_REF`（D2-B）
    挂起并写明**重开条件四条**。落地形态：新表 `frame_recipes`（有序
    `stages: [{protocol_id, slot_ids, definition_hash}]`）+
    `instructions.default_recipe_id` 补列（单列天然唯一）+ 降级链
    **配方 → 默认协议 → 裸发**；第 n 层输出直接喂第 n+1 层 `payloads` →
    **`frame_builder.py` 一行不改**、环在有序数组下**结构上不可能存在**（免拓扑求值
    与防环）、refs 保持同树、双端编译器不动。**主动偏离 D3**：配方路径
    `fit_policy` 缺省 `reject`（零存量 + 多层下 append 错误被下一层当正常载荷收下）；
    `definition_hash` 由批次三**提前进 3a** 且 **hash 只在后端算**（消掉 D7 的双端
    同构成本）。转义**不属配方范围** —— N4 已实现（`backend/core/escape.py`，
    transport config `escape` 段、缺省关闭、**先转内核再套壳**、壳域按线上字节
    重算），配方链沿用该层位（只在第 0 层之前转义）；**新发现**：编排页「封装
    试发」走 `/compile/wrapped` → `/dispatch` **不带 wrap**，`escape` 收到的是
    已封装整帧 → 与带 `wrap` 的"只转内核"语义不一致（缺省关闭时无影响），
    **建议并入批次二**（→ **已随 CP2 落地，层位项见条目 33**），见
    `DESIGN_Decisions.md` D13「边界（转义）」。
    文档：`DESIGN_Decisions.md` D13（+ §0 回填 + D2 交叉引用 + 审批状态）、
    `DESIGN_CorePipeline.md` §9（9.1 DDL / 9.2 阶段载荷取甲案 / 9.3 端点契约与
    降级链 / 9.4 UI 归属：编排页配方编辑器 + 加工页分层堆叠 / 9.5 防错四条 /
    9.6 三时间点补行 / 9.7 排批 / 9.8 本期不做）+ §7 批次三扩容（3a–3d）+
    §8 `PROTOCOL_REF` 结论改写；`PLAN_Backlog.md` §1 新增 **CP2 / CP3** 两行。
    **排批（2026-10-01 拍板）= 并入批次三**，硬前置批次二（复用其 reject 分支）。
    残余风险进人工验证清单：「有 LEN = 不需要转义」为经验判定，需在真实链路帧上
    核对载荷出现定界字节时设备是否异常。→ **CP2 已实现（层位项随批落地，见 33）
    → CP3 已全部收口（3a–3d = 条目 35–38，人工验证复跑 = 条目 41）。**

32. **D14 / D15 / D11 分段（三缺口复核代码后起草并拍板，纯文档）**（2026-10-01）：
    - **同批修正**：D13「边界（转义）」原写 `output_transform` 待建 → 实为
      **N4 已实现**（`backend/core/escape.py`、transport config `escape` 段、
      缺省关闭、先转内核再套壳），并**新发现层位不一致**（编排页封装试发走
      `/compile/wrapped` → `/dispatch` **不带 wrap**，`escape` 收到已封装整帧，
      与带 wrap 的「只转内核」语义不同；缺省关闭时无影响）→ 改线项归 D14 ③。
    - **D14（批次二三个口径）✅ 拍板 = A/A/A**（CP2 开工前置，**已满足**）：
      ① **存量槽 `fit_policy` 不迁移**（保持 `append`/`zero_fill`，本批只把静默变
      显式；新建槽 UI 默认 `reject`、配方路径强制 `reject`）；② 删指令时
      `sequence_steps` = **失效标记不阻断** —— 初稿推「阻断」，复核 `sequence_runner`
      发现**步骤 payload 自含、不查指令行**（删宿主后仍可跑）后改判，并成文按数据
      性质的三分口径（**活配置级联删 / 冻结快照失效标记 / 日志只读保留**），同时
      消掉 D12 矩阵与选项 A 的口径矛盾（矩阵已同步修正）；③ 转义层位 =
      **试发改带 `wrap` 下发**。
    - **D15（应答是否逐层解包，D5 × D13 交互）✅ 拍板 = A**：D5 拍板早于 D13，
      形态丙下应答是链路壳帧 → 单层 `response_specs` 必然失配；口径 =
      **`response_specs` 增 `stage` 列 + 「据此生成」按配方每层各执行一次 +
      `response_match` 按 `stages` 逆序解包逐层跑五要素**（无配方 = 单层退化、
      存量零改）；关联待确认「**应答是否也带转义字节**」→ 已进 §9.7 人工验证必查 ④。
      → **D5-A 实施设计须按 D15 修订，不得按单层字面实现**。
    - **D11 补实施注（代价重估）✅ 分段拍板 = ①**：`routers/datahub.py::
      fields_to_blocks` + `compile_blocks` 已是后端指令编码器雏形，但**只出骨架帧、
      无 `inputs` 层、无 `normalizeInstruction` 对应** → A 的真实工程量被低估。
      三档分期 ①向量表共享 fixture 化 / ②发送前比对（不改产物）/ ③全量替换前端
      —— **拍板取 ①，2026-10-01 成本重估后从 CP2 拆出独立成批 CP2b**（向量含
      `Infinity`/`NaN` 等 JSON 无法直接表达的值，需先定跨语言特殊值约定，约
      13 组向量表 / 15 个测试文件；原「成本极低」估计作废）。②③ 不在本期。
    - 文档落点：`DESIGN_Decisions.md` §0（D1–D15 全拍板）+ D11 实施注 + D14 + D15
      + D5/D12 交叉引用；`DESIGN_CorePipeline.md` §6.2 矩阵修正、§7 批次二（D14
      口径 + D11-① 并入）、§7 批次三 3d 与 §9.7/§9.8 按 D15 修订；
      `PLAN_Backlog.md` CP2/CP3 行同步。
      → **CP2 已开工并实现完成（见 33），下一步 CP2b / CP3。CP2b 亦已完成
      （见 34），仅剩 CP3。**

33. **CP2 Core Pipeline 批次二（防错）实现完成：D3 执行 / D12 删除级联 / D14 三口径**
    （2026-10-01，**零 DDL** —— `models.py` 未动、`yorha.db` 不随本批提交，
    `/dispatch` 裸发缺省口径逐字节不变）：
    - **D14-A + D3**：`core/frame_builder.py` 新增 `_fit_policy`/`_max_bytes`，
      装填三态执行（①条数溢出 ②`max_bytes` 超限 ③欠载逐槽）→ `reject` 走
      `ValueError` → **400**（detail 带槽 id 与实际/允许字节数），缺省
      `append`/`zero_fill` 保持原 warning 文案；**实施注**：条数溢出无槽归属 →
      任一槽 `overflow=reject` 即阻断追加帧末尾，`max_bytes` 超限归 overflow 策略。
      `routers/protocol.py::_validate_slot_contracts`（create/update 只校验
      `fit_policy`，非法 400 不 fail-open）+ `_iter_nodes` + 删槽后
      `binding.slot_id` 悬空置 NULL 并回执 `dangling_slots_cleared`
      （`schemas/protocol_api.py` 新增响应字段，缺省 0）。前端
      `config/blockTypes.js` slot `fields:['length','fit']` + 新建槽预置
      reject/reject；`ProtocolPropertiesPanel.jsx` fit 分支两下拉（值域分侧）+
      STRICT/LEGACY 徽标 + 缺省口径注记。
    - **D14-B**：`routers/sequence.py::_missing_instruction_ids` 读时批量比对 →
      `SequenceStepOut.instruction_missing`（**零 DDL**）；`Sequences.jsx` 行级
      琥珀「失效」徽标（+ 本地兜底判据）+ 该步骤编辑降只读（下拉锁死、标签/延时
      禁改、黄提示「帧是冻结快照仍可运行」）。
    - **D12**：`routers/instruction.py` `GET /{id}/references`（四表计数 + total）
      + `DELETE` 同事务三分处置（活配置级联删 / `sequence_steps` 留并回执
      `orphaned_sequence_steps` / `dispatch_logs` 只读留，404 detail 不改）；
      `api/instructions.js::getInstructionReferences` + `useInstructionData.
      deleteInstruction` 删前计数 → 弹窗按三分口径列受影响项
      （`describeReferences`/`describeDeletion` 纯函数钉文案），计数失败降级不拦删。
    - **D14-C**：`routers/dispatch.py` `WrapSpec` 增 `payloads`/`slot_ids`/
      `start_order`、`_apply_wrap` 返回含 `warnings` 的 dict、`DispatchRecord.
      warnings`、`hex_string` Optional + 与 wrap 二选一 400、**多载荷逐条先转义
      内核再套壳**；`api/dispatch.js::dispatchWrappedGroup` + 编排页
      `handleTrialSend` 去掉「`/compile/wrapped` → 裸发」两跳改带 wrap 直发，
      `record.warnings` 独立琥珀徽标（不拼进 SENT 文本）。
    - **验收（自动化全绿 · 人工验证 5 项已通过）**：BE **426/426**（基线 383 + 43，新增
      `test_slot_contract.py` / `test_instruction_delete.py`）、FE **915/915
      （63 文件）**、`npx vite build` EXIT=0、yorha-ui 校验器 13 文件 **0 违规**；
      文档同步 = `pageStatus.json` 四页条目 + `docs/PAGE_STATUS.md` 重生成 +
      `PLAN_Backlog.md` §1 CP2 行与 §8.19 + `DESIGN_CorePipeline.md` §6.1/§9.5
      「⬜ 批次二补」→ ✅ 与 §7 批次二状态注。
    - **人工验证清单 ✅ 5 项已通过（2026-10-01）**：① 新建槽默认 STRICT → 试发
      溢出/欠载 **400**（detail 含槽 id 与字节数），存量槽仍只出琥珀 warning；
      ② 删指令弹窗三分口径与回执计数；③ 序列失效徽标 + 步骤只读 + 仍可运行；
      ④ 编排多载荷试发 `warnings` 徽标与 SENT 实际出线帧；⑤ 真实链路帧核对
      （载荷定界字节 / 三层帧 / **设备应答是否也带转义**，D15 关联 → 结论供
      CP3-3d 参照）。
      → **已提交 `5afe706`（2026-10-01，代码+文档，零 DDL 未提交 `yorha.db`）
      → 待办：CP2b（D11-① 共享 fixture，需先定跨语言特殊值约定）→ CP3。
      → CP2b 已于同日完成，见条目 34；CP3 亦已全部收口（见条目 35–41）。**

34. **CP2b D11-① 双端共享向量表实现完成（单一真相源 = 根目录 `vectors/`）**
    （2026-10-01，**零 DDL** —— 纯测试/数据重构，**不改任何生产代码路径**）：
    - **跨语言特殊值约定拍板 = `$v` 包装对象**：JSON 无 `Infinity`/`NaN`，而向量
      确需喂这两个值 → `{"$v":"Infinity"}` / `{"$v":"-Infinity"}` /
      `{"$v":"NaN"}`；**其余标量按 JSON 原型天然分型**（`null`/`true`/数字/字符串），
      故字符串输入 `"1e3"`、`""` 不会与数值 `1.5`、`0` 撞车（原顾虑的
      「`NaN`/字符串哨兵撞车」由设计消解，**不采用字符串哨兵**）；特殊值对象只允许
      恰好一个 `$v` 键，两端加载器对畸形标记**直接抛错**不 fail-open。
    - **`vectors/` = 12 个 JSON / 15 张表**：11 张平面向量表（`int_signed` /
      `little_endian` / `bcd_scaled`·双表 / `float_ieee` / `repeat` /
      `time_counter`·双表 / `string` / `align` / `presence`·双表 / `escape` /
      `bitfield`）+ **`wrap.json` 三处同值场景树**（`FA FA 02 01 02 ED`，原在
      `test_frame_builder.py` / `test_wrap_api.py` / `blockMerge.test.js` 各写
      一遍 → 现同读一份）。双端加载器 `vectors/load_vectors.py` ↔
      `vectors/vectors.js` 逐条同口径——**「改一必改二」只保留在这一处**。
    - **改读范围**：13 个 BE 测试文件 + 6 个 FE 测试文件（14 处 `const VECTORS`
      声明 + wrap 场景树）全部改读共享 JSON，内联字面量删除，**行注归档**进
      `vectors/README.md`（`#N` = 表下标）。形状适配 3 处（`null`↔`undefined`、
      `children`↔`fields`、bitfield 三元组↔对象）与「未迁入 = 实现语义同源锚点」
      清单（`padSpec` / `KNOWN_OPS` / `escape` 实现）记于 README §4/§5。
    - **验收（自动化全绿）**：BE **426/426**、FE **915/915（63 文件）**、
      `npx vite build` EXIT=0、yorha-ui 校验器 7 文件 **0 违规**。
      **测试总数与基线逐表一致**（FE 915 不变）→ 证明 FE 原内联表行数与 BE
      完全相同，迁移无覆盖增减。
    - **文档同步**：`PLAN_Backlog.md` §1 CP2b 行与新 §8.20、`DESIGN_Decisions.md`
      D11 实施注、`DESIGN_CorePipeline.md` §1/§7 拆批注状态、`vectors/README.md`
      新增；**无 UI 改动 → `pageStatus.json` / `PAGE_STATUS.md` 不动**。
      → **已提交 `da0179d`（2026-10-01，代码+文档，零 DDL 未提交 `yorha.db`）
      → CP3 已全部收口（3a `e63d76f` + `438f3af` 含 DDL 落库 / 3b / 3c / 3d，
      见条目 35–38，人工验证复跑 = 条目 41）。**
35. **CP3-3a 封装配方数据层 + 串行编译 + 加工页分层预览实现完成**
    （2026-10-01，**含 DDL** —— `frame_recipes` 新表 + `instructions.default_recipe_id`
    补列自愈；`models.py` 只增表/列，`/dispatch` 裸发缺省口径逐字节不变，未碰
    `processor.py` / `graph.py` / `Blueprint.jsx`）：
    - **数据层**：`models.py::FrameRecipe`（id/name/description/stages(JSON)/version/
      created_at/updated_at，**无 `instruction_id` 列** —— 关联靠 `instructions.
      default_recipe_id`，单列天然唯一、关联即顶替）+ 补列；
      `database.ensure_recipe_columns` 镜像 `ensure_protocol_version_column`
      （PRAGMA 先查 → ALTER → 幂等 / 表缺 no-op）。`protocol_bindings` **不动**
      —— 配方与默认协议是**互斥消费**。
    - **`/recipes` CRUD**（`routers/recipe.py` + `schemas/recipe_api.py`）：
      `GET ?instruction_id=` 降级链过滤（0/1 条，未关联 = `[]`）；保存期校验 =
      层数 1..**4**（`MAX_RECIPE_STAGES`）、stage 协议 404、槽存在且为 slot /
      插槽重复 / 空 stages / 空名 → 400；`version` 缺省跳过、不符 **409**；
      **删除同事务清指令引用**回执 `cleared_instructions`。
    - **`definition_hash`**（`core/definition_hash.py`，只 hash 协议 `children`）：
      **保存期回写、编译期只比对 + `stages[]` 回显、不写库**（编译即回写会让下一次
      比对必然「已对齐」，失效徽标失去意义 —— §9.1「回写」按响应回显落地）。
    - **串行编译**（`core/recipe_compile.py`，`/compile/wrapped` 与
      `dispatch._apply_wrap` **共用同一份实现** → 预览与出线同字节）：stage 0 吃
      内核组、后续层吃 `[前层输出]`、`start_order` 只作用于 stage 0、`slot_ids`
      归配方阶段所有；逐层错误带「第 N 层（协议）」前缀；`hex` 恒为最终帧。
      请求 `protocol_id` 与 `recipe_id` **互斥**、都不给 400。
    - **`frame_builder` 两处增改**（均加缺省参数 = 原行为）：① `strict_fit=True`
      把配方路径未显式配置的槽缺省改 `reject`/`reject`（**主动偏离 D3**，
      报错归因区分「协议存在 overflow=reject 插槽」vs「配方路径缺省 reject」）；
      ② 返回增 `logic` = 发射后 length/checksum **真值**（分层 LEN/CRC 卡面）。
    - **范围提前（记入 §7/§9.7）**：`/dispatch`、`/dispatch/transaction` 的
      `wrap.recipe_id` 接线**原属 3b，已随 3a 实施** —— 加工页「预览 / TRANSMIT /
      事务三路同参同字节」是批次一立下的不变量，缺接线则配方态预览帧与出线帧
      **不同字节**。**3b 因此只余编排页配方编辑器 + 编排页试发改线 + curl 冒烟**。
    - **加工页降级链三级**（`InstructionProcessor` §9.3）：**配方 → 默认绑定协议 →
      裸发**，互斥取第一个命中；**配方级拉取失败不整机降级**，回落第 2 级。
      `InstructionRunner` 预览按 `mode` 分叉：配方态**分层堆叠**（层号 · 协议 label ·
      该层 hex · Δ · LEN/CRC 真值 · 该层告警）+ 顶层 `RECIPE STALE` 失效徽标，
      单协议态**形态与文案逐字不变**；`TransactionPanel` 配方态指示改配方名 + 层数。
      新增 `frontend/src/api/recipes.js`，`compileWrapped({recipeId})` 配方态不带 `slotIds`。
    - **验收（自动化全绿）**：BE **466/466**（基线 426 + 40）、FE **920/920
      （63 文件，基线 915 + 5）**、`npx vite build` EXIT=0、yorha-ui 校验器 3 文件
      **0 违规**；另跑**真路由冒烟 25 项 PASS**（TestClient 走完整 FastAPI 栈 ——
      单测直调函数验不到的路由注册 / 出线 JSON / 删除清引用 / 残留自清，脚本临时
      目录不往真库留数据）。**三层帧主向量一处钉死改一必改三** = `vectors/wrap.json`
      新表 **`three`**（三处同读：`test_frame_recipes` / `test_wrap_api` /
      `InstructionProcessor.test`）。
    - **文档同步**：`DESIGN_CorePipeline.md` §7 批次三 3a 进度注 + §9.7 排批表
      两行、`PLAN_Backlog.md` §1 CP3 行与新 §8.21、`DESIGN_Decisions.md` D13/D7
      实施注、`pageStatus.json` 加工页条目 + `PAGE_STATUS.md` 再生成 + 本条。
    - **提交**：→ **已提交 `e63d76f`（代码+文档）→ `438f3af`（chore(db) DDL 落库）
      → 本回填，2026-10-01**。**待办**：① ~~**人工验证必查 3 项**（§9.7：三层真实
      链路帧目视核对 / 分层堆叠逐层字节与协议页卡面一致 / 改动中间层协议 → 失效
      徽标点亮，通过后补记）~~ —— **已销，2026-10-02 复跑通过（见 41）**；② ~~CP3 剩余子批 3b / 3c / 3d~~ —— **已销（3b = 36、3c = 37、3d = 38）**。
36. **CP3-3b 编排页配方编辑器 + 试发改线实现完成**
    （2026-10-01，**纯前端批、零 DDL** —— 未改 `models.py`/`database.py`（故**无
    `chore(db)` 提交**）、未碰 `processor.py`/`graph.py`/`Blueprint.jsx`；3a 已提前
    并入 `dispatch` `wrap.recipe_id` 接线，本子批只剩编辑器与试发改线两块）：
    - **新组件 `frontend/src/components/editor/RecipeEditor.jsx`**，落位编排页属性
      面板**分区 4/5「封装配方 (RECIPE)」**（§9.4「编排绑定页」行）：有序 stage
      加层 / 上移 / 下移 / 删层 + 每层选协议 + 选槽；层数 **1..`MAX_RECIPE_STAGES`=4**
      （与后端 `recipe_api.MAX_RECIPE_STAGES` 同值）、删层保底 1 层；加层**沿用上一层
      协议**（首层用首个协议）；**换协议即清该层 `slot_ids`**（槽属另一棵协议树，留着
      是脏引用 → 服务端 400），置空 = 回稠密位次。
    - **选槽语义**：成员关系 + **选择顺序**，位次 badge `#n` = 第 n 条载荷（§9.1
      「位置对应 payloads」），取消后位次前移不留空洞；无槽协议不出芯片。
    - **新建即 POST 落库**（沿本页「空表种默认绑定」先例，id 前端 uuid）；编辑只进
      草稿、**SAVE 一次 PUT** 带 `version` 乐观并发（不符 **409** 透出）；脏点 +
      **离开拦截**（配方脏稿纳入既有 `beforeunload`）；**脏时禁切换 / 禁新建 / 禁试发**
      —— 后端只认已落库配方，带脏稿试发 = 预想与出线不一致（本批正是防静默错帧）。
    - **试发改走配方**：选中配方 → `dispatchWrappedGroup({recipeId, payloads,
      instructionName})` → `wrap.recipe_id`，**不下发 `slotIds`/`startOrder`**（槽位与
      层序归配方阶段所有）；**未选配方 → 原组协议参数对象逐字不变**（批次二 D14③ 层位
      口径，现状零回归）。头部 `WRAP :: 配方 <名>`（琥珀）/ `WRAP :: 组协议` 来源指示，
      显示名**优先取草稿**（改名未保存即时跟随）。
    - **关联指令下拉（LINK）** = 加工页降级链第 1 级的读入口（写
      `instructions.default_recipe_id`）。**换绑两步**：`_link_instruction` 只写目标
      指令行、**不回清旧指针** → 保存时先 `instruction_id:""` 清旧、再带清空后的
      `version` 设新；否则旧指令继续指向本配方（破 `RecipeResponse`「0 或 1 条」不变量）。
      **此下拉是 3a 加工页配方态的 UI 前置** —— 没有它，§9.7 人工验证项 ③（改协议看
      失效徽标）从界面到不了。
    - **删配方弹 `NieRModal` 确认**（服务端同事务解除指向本配方的指令关联）；
      `GET /recipes` 全量挂载拉取，**失败只提示不阻断**绑定编辑与组协议试发。
    - **既有用例零改**：未建配方时编辑器只渲染新建入口、**不占任何 select** →
      「属性面板四分区 select = 3」与试发原参数断言全绿。
    - **验收**：BE **466/466**、FE **924/924（63 文件，基线 920 + 4）**、
      `npx vite build` EXIT=0、yorha-ui 校验器 3 文件 **0 违规**；**真 curl 冒烟
      13 项 ALL PASS** —— 真 uvicorn + `curl.exe`（**不是 TestClient**；单测直调函数
      验不到真实 HTTP 栈）：带 recipe 往返（**出线 = 预览同字节**）/ **不带 wrap 裸帧
      回归**（`0102` 逐字节不变）/ 组协议回归 / 删配方 `cleared_instructions=0` /
      残留清零。冒烟的临时增删会改 SQLite 文件字节，已还原到 3a 提交态（BE 全量
      已核实**不脏 `yorha.db`**）。
    - **文档同步**：`DESIGN_CorePipeline.md` §7 批次三 3b 进度注 + §9.7 排批表、
      `PLAN_Backlog.md` §1 CP3 行 + 新 §8.22、`DESIGN_Decisions.md` D13 表行与实施注、
      本条、`pageStatus.json` 编排页条目 + `PAGE_STATUS.md` 再生成。
    - **提交**：→ **已提交 `c4b1f7f`（代码+文档，零 DDL 未提交 `yorha.db`），2026-10-01**。
    - **待办**：① ~~**§9.7 3b 人工验证 3 项**（编排页建配方 → 加层/换序/选槽 → SAVE
      → 刷新回读一致；配方试发出线与头部指示一致、**未选配方时与改前逐字节一致**；
      改名未保存 → 试发按钮置灰，保存后恢复）~~ —— **已销，2026-10-02 复跑通过
      （见 41）**；② CP3 剩余子批 ~~**3c**（序列封装帧
      D6-B）与 **3d**（D5-A `response_spec` `stage` 维度 + D7-A 余下徽标）~~
      —— **均已完成**（3c = 条目 37、3d = 条目 38）。

37. **CP3-3c 序列封装帧实现完成（D6-B 冻结 vs 重算分离）**
    （2026-10-01，**含 DDL** —— `sequence_steps` 新增 `wrap JSON` 单列，故有
    `chore(db)` 提交；未碰 `processor.py`/`graph.py`/`Blueprint.jsx`；未封装步骤的
    `/dispatch` 缺省口径与序列发送路径由既有用例 + 冒烟**双钉**）：
    - **保存期冻结**（`routers/sequence.py` `_normalize_steps(db, …)` / `_freeze_wrap`）：
      入参先 `normalize_plan` 归一 → 有 `wrap` 即 `kernel_slice` 切内核 →
      `compile_recipe` → `recipe_compile.shell_plan` 注入 **`plan.shell`**（每层
      length/checksum 的**本帧绝对坐标**区间）→ 完整帧二次归一后冻结进 `payload`，
      `wrap = {recipe_id, definition_hash}` 落库。**请求形只收 `{recipe_id}`**
      （`_wrap_spec` 未知键 400）；`definition_hash`/`stale` 属**响应形**，透传即 400。
    - **发送期重算**（`core/sequence_runner.py` `_frame_for_send`）：无 `plan.shell`
      = `apply_plan → 整帧转义`（**逐字节不变**）；有 shell = `kernel_slice →
      内核侧 apply_plan → 内核转义 → `compile_wrap(recipe_id, kernel_hex)` 套壳 →
      整帧出线（层位同 dispatch「先转内核再套壳」）；编译异常抛 `WrapError` →
      记步 `WRAP: {原因}`，与 `PLAN:`/`TRANSPORT:` **三分类**。路由侧
      `_compile_wrap_factory()` 每次自开 `SessionLocal`（请求会话已关）。
    - **读侧失效徽标**：`_wrap_with_stale(db, wrap, seen)` 按 recipe_id 缓存
      `recipe_compile.current_fingerprint`（配方 `stages` + 所引协议的复合 sha256）
      与冻结时 `definition_hash` 比对 → `wrap.stale`；配方/协议缺失也按 `stale=true`
      （只提示不阻断，冻结帧仍可运行）。
    - **回退路径**：`plan` 带 shell 但 `wrap` 缺席 / `null` → 按旧区间切回内核 +
      `core_plan` 剥 shell —— **两种前端形态均幂等，前端只透传不计算**。
    - **几何 SSOT**：`frame_builder._collect_shell`（发射期 `orchestrator.block_spans`
      取每块真实区间）→ `recipe_compile.shell_plan`（`head_i`/`S_i` 平移为最终帧
      绝对坐标）→ `sequence_plan._normalize_shell`（严格键集 + 嵌套不变量：层序
      0..n-1 连续、offset 严格递减、最外层恒 0、内核落第 0 层、字段不出层区间）。
      **`shell` 仅当输入存在才输出** → 存量 plan 键集零回归。
    - **DDL**：`models.py` 新列 + `database.ensure_sequence_step_columns`（镜像
      `ensure_recipe_columns`：缺列 `ALTER TABLE sequence_steps ADD COLUMN wrap JSON`，
      幂等、表不存在 no-op）+ `main.py` lifespan 调用；`schemas/sequence_api.py` 增
      `SequenceStepSpec.wrap` / `SequenceStepOut.wrap`。
    - **前端**（仅 `frontend/`）：步骤编辑器新增 `RECIPE（可选）` 选择器
      （`data-testid="step-wrap-recipe"`）+ 卡片/编辑器头部 `WRAP :: <配方名>` 回显 +
      `stale` 徽标 + 新纯函数 `utils/sequenceView.shellSummary(plan)` 渲染
      `SHELL L1..LN · LN LEN@x CRC@y` 层摘要；**`buildPlan` 输出键集一行未改**
      （shell 后端注入 = 单一真相源，另有用例钉死 `['checksum','dynamic']`）；
      `toDraft` 对响应形 `wrap: null` **剥键**（键缺席 = 从未封装）→ 裸帧 PUT
      请求形逐字节不变。
    - **验收**：BE **496/496（基线 466 + 30）**、FE **932/932（63 文件，基线 924 + 8）**、
      `npx vite build` EXIT=0、yorha-ui 校验器 4 文件 **0 违规**；**真路由冒烟 30 项
      ALL PASS**（真 uvicorn + `curl.exe`）：冻结帧 = 主向量 `three` 同字节 /
      `plan.shell` 偏移 `[4,2,0]` 尺寸 `[5,8,11]` LEN `[5,3,1]` / 裸帧 `plan=null
      wrap=null` 零回归 / 三类 400 定位 `steps[0]:` / GET 回读与 PUT 幂等 /
      运行 `sent` = 冻结帧（转义用例 12B 同步核过）/ 改中间层协议 → `stale=true`
      且冻结字节不动 / 还原 → `stale` 清、**残留清零**（16 指令 · 3 协议 · 0 配方 ·
      1 原有序列原样）。
      **真浏览器 UI 验证 6 项**：真实 PUT 请求体 = `{payload: 内核, plan: 无 shell,
      wrap:{recipe_id}}` 且**第 2 步不带 `wrap` 键**、卡片 20B（11B 内核 + 9B 头）、
      `WRAP ::` 两处回显、`PLAN` 摘要 `SHELL L1..L3 · L1 LEN@5 · L2 LEN@3 · L3 LEN@1`
      （与后端坐标一致）、UI 启动运行 2/2 OK 且第 1 步 `sent` = `C0 11 B0 0E A0 0B
      <11B> E0 E1 E2`（20B 几何自洽）。
    - **文档同步**：`DESIGN_CorePipeline.md` §4 序列 Runner 行 + §5 封装帧行 +
      §7 批次三 3c 进度注 + §9.7 排批表 3c 行 + 人工验证 ⑤、`PLAN_Backlog.md`
      §1 CP3 行 + 新 §8.23、`DESIGN_Decisions.md` D6 关联与 D15-② 实施注、
      本条、`pageStatus.json` 序列页条目 + `PAGE_STATUS.md` 再生成。
    - **提交**：→ **已提交 `fbad083`（代码+文档）→ `17c6830`（chore(db) DDL 落库），2026-10-01**。
    - **待办**：~~CP3 剩余子批 3d~~ —— **已完成，见条目 38**（CP3 四子批全数收口）。

38. **CP3-3d 应答分层生成与失效徽标实现完成（D5-A 按 D15-A 修订 + D7-A 余下两处）**
    （2026-10-01，**含 DDL** —— 3 列**仅新增**：`response_specs.stage` /
      `response_specs.definition_hash` / `protocol_bindings.definition_hash`，
      故有 `chore(db)` 提交；未碰 `processor.py`/`graph.py`/`Blueprint.jsx`；
      `/dispatch` 缺省口径由 `test_bare_frame_path_unchanged` + 存量用例**零改全绿**
      双钉）：
    - **生成映射**（`core/response_generate.py`，新建）：`resolve_layers` =
      默认配方 → **每层各生成一次** / 默认协议 → 单层 / 皆无 → **400
      「该指令既无默认封装配方也无默认协议，无法据此生成」**。每层按
      fixed → `echo_header_bytes`（首个非 fixed 前连续 fixed）、
      length → `length_element`（插槽参与 → `offset_val = A - head - trailer`；
      插槽后仍有插槽 / 区间模式 / 悬空 → **跳过 + warning**）、
      checksum → `checksum_element`（refs 只圈插槽 → `span_start=head` +
      `span_end_pad=trailer`；恰好整帧 → 省区间；否则跳过 + warning）各映射一次
      → **`stages[]` 每层一份**，落库层记 `stage`；**1 层不写 `stages` 键**
      （存量形逐字节等价）；产出先过 `normalize_spec` 归一，出处用
      `chain_fingerprint`（解析不出 → `NULL`）。
    - **逆序解包**（`core/response_match.py`）：`_SPEC_KEYS` 增 `stages`、
      `_STAGE_KEYS`/`_UNPACK_KEYS`（head+trailer ≥ 1）、`_CHECKSUM_KEYS` 增
      `span_end_pad`/`field_offset_from_end`、`_LENGTH_KEYS` 增 `offset_from_end`、
      `MAX_STAGES = 4`。`_match_stages` 按 **i = n-1 → 0** 跑五要素，head/trailer
      **同时剥 `received`/`sent`**，reasons 前缀 `STAGE[i].`；**顶层禁 echo /
      length / checksum、`mode` 禁 `echo`**。**无 `stages` 键 → 原单帧路径
      逐字节不变**。**后插槽字段**绝对位置不可静态定位 → 新增 `offset_from_end` /
      `field_offset_from_end`（与绝对 `offset`/`field_offset` **互斥**，非 0 同给 → 400）。
    - **端点**：`POST /response-specs/{instruction_id}/generate`（写 spec + stage +
      出处，返回 `{spec, stage, definition_hash, stale, layers, warnings}`，
      `warnings` 是降级说明不是错误）；`GET /response-specs/targets?protocol_id=`
      （**声明在 `/{instruction_id}` 之前**，`uses_protocol` 前置）；手工 `PUT`
      **保留出处**、`stage` 镜像随 spec 重算（`_stage_mirror`）。
    - **D7-A 绑定徽标**：`create_binding` 记出处；`update_binding` **仅
      `protocol_id` 真变时重记**（改 label/priority 不抹提示）；`_attach_stale`
      把 `stale` 挂** ORM 行本身**（保持既有「同会话 commit 后读到刷新值」单测语义），
      三态 = NULL 出处 `None` / 链解析不出 `true` / 一致 `false`。
    - **DDL 自愈**：`database.ensure_response_spec_columns`（新建）+
      `ensure_binding_columns` 扩第 4 列，`main.py` lifespan 接线；四态同
      `ensure_recipe_columns`（缺列补列 / 二次 no-op / `create_all` 已带 no-op /
      表不存在 no-op）。
    - **前端**（仅 `frontend/`）：`api/responseSpecs.js` 增
      `getResponseSpecTargets` / `generateResponseSpec`（`api/index.js` 导出）；
      协议页新增「据此生成 RESPONSE SPEC」底栏（切协议重拉候选并清选中、未选禁用、
      成功回显 `N 层 · STAGE k` + `warnings` 降级行、失败透传 400 detail、候选拉取
      失败短错误行降级）；`TransactionPanel`（`response-spec-stale`）与
      `Orchestration`（`binding-stale`）两处徽标 —— **只在 `stale === true` 渲染**。
    - **验收**：BE **537/537（基线 496 + 41）**、FE **944/944（63 文件，基线 932 +
      12）**、`npx vite build` EXIT=0、yorha-ui 校验器 8 文件 **0 违规**；**真路由
      冒烟 43 项 ALL PASS**（真 uvicorn :8765）：DDL 三列落真库 / 无链 400 / 不存在
      404 / 三层 `targets` 命中 + `uses_protocol` + 层数 3 / 生成 `stage=2`
      `layers=3` `warnings` 空 `stale=false` sha256 出处 / dispatch
      `spec_source=instruction` 应答 OK / **内联写错最内层 length → `MATCH_FAILED`
      + `STAGE[0].`** / 绑定记出处 `stale=false` / 改协议 → spec 与 binding
      **同时 `stale=true`** / 手工 PUT 保留出处 + `stage` 镜像 2 / 无 `stages` →
      stage `NULL` / 回滚协议 → 两处 `stale=false`。
    - **文档同步**：`DESIGN_CorePipeline.md` §7 批次三 3d 进度注 + §9.7 排批表 3d 行 +
      人工验证 ④ + §9.8 末条改「已随 3d 完成」、`DESIGN_Decisions.md` D5/D7/D15
      表行与三处实施注、`PLAN_Backlog.md` §1 CP3 行 + 新 §8.24、本条、
      `pageStatus.json` 再生成。
    - **提交**：→ **`77dd389`（代码+文档）→ `bb7a0ba`（chore(db) DDL 落库），
      2026-10-01**。
    - **待办**：~~**§9.7 人工验证 ④**（真实设备应答帧的反转义口径 —— `escape` 尚未接进
      `response_match`，见 `DESIGN_Decisions.md` D15 关联项 1）~~ → **✅ 已销（2026-10-02，
      条目 44 / PLAN §8.35）**：按公开规范模拟真机应答定论 = 带转义，收侧接
      「先线上、后逻辑」双口径，无需真机帧；批次四 4b/4c 见条目 39。

39. **CP4-4a 关系数据导入导出实现完成（bindings + response_specs 并入 DataHub ZIP）**
    （2026-10-02，**零 DDL** —— 只读写既有 `protocol_bindings` / `response_specs`
      两表，`models.py`/`database.py` 未改，`yorha.db` 不随本批提交；未碰
      `processor.py`/`graph.py`/`Blueprint.jsx`，`/dispatch` 缺省口径零影响）：
    - **导出**：`GET /datahub/export/bundle` 的 ZIP 增 `relations.json`
      （`{schemaVersion, bindings[], responseSpecs[]}`，行字段与列一一对应，
      `definition_hash` 原样带出）；`manifest.json` 增 `relations` 计数；
      `/datahub/status` `counts` 增 `protocolBindings` / `responseSpecs`。
    - **导入**（`POST /datahub/import/relations`，入参 = `relations.json` 原文）：
      严格顶层键集（未知键 / 非 1 `schemaVersion` / 非数组 → 400）；**恢复语义**
      按 `id` upsert、**逐行独立提交**（`IntegrityError` 只回该行 → `skipped` 带
      reason，**部分成功即部分落库、不整批回滚**）；父指令/协议缺失 → 跳过；
      **槽悬空 → 置 NULL + `warnings[]`**（§6.2 不静默口径，保留行不丢弃）；
      `is_default=1` 先清同指令旧行（默认唯一不变量）；`spec` 过 `normalize_spec`
      （非法行跳过，不整批 400）、**`stage` 按 `spec.stages` 重算镜像**
      （SSOT = `_stage_mirror`，不信文件里的值）、同指令已有别行 → 跳过；
      出处指纹原样回填 → 目标库协议已变则读侧 `stale` 自然点亮（D7-A）。
    - **前端**（仅 `frontend/`）：DataHub 页新增「关系数据 (RELATIONS IMPORT)」
      面板（隐藏 file input → JSON 解析校验 → `NieRModal` 确认（列条数与 upsert
      语义）→ POST → 回显 **新增/更新/跳过/警告** 四段计数并 `refresh()`）；
      环境面板 `COUNT_LABELS` 增 `绑定 BINDINGS` / `应答规格 SPECS`；
      导出回显补 `relations.json`。
    - **验收**：BE **549/549（基线 537 + 12）**、FE **948/948（63 文件，基线 944 + 4）**、
      `npx vite build` EXIT=0、yorha-ui 校验器 4 文件 **0 违规**；**零 DDL**。
    - **人工验证 6 项通过**（真浏览器：两行计数 0/0 → 1/1、导出回显 + manifest 条数
      一致、确认前不发请求、导入回显四段计数 + 服务端 id/出处/stale 回读、二次导入
      upsert 覆盖、非法 JSON 与严格 400 三态），明细见 `PLAN_Backlog.md` §8.25。
    - **文档同步**：`DESIGN_CorePipeline.md` §7 批次四 4a 进度注、`README.md`
      Data Hub 一段（+ `relations.json` 与导入端点、状态面板改「七表行数」）、
      `PLAN_Backlog.md` §1 新 CP4 行 + 新 §8.25、`pageStatus.json` 数据中心页条目 +
      `PAGE_STATUS.md` 再生成、本条。
    - **提交**：→ **`54620ab`（代码+文档），2026-10-02**。
    - **待办**：（已随条目 40 = 4b+4c 完成）批次四三子批 4a/4b/4c 至此全数收口。

40. **CP4-4b/4c 绑定矩阵视图 + D9/D10 划界 + D8 全量核对实现完成（批次四收口）**
    （2026-10-02，**零 DDL、后端 0 文件改动** —— 复核确认 §6.2 槽节点行（删槽 →
    `slot_id` 悬空置 NULL + 回执 `dangling_slots_cleared`）**批次二已落地**并有
    `test_slot_contract.py` 3 例；未碰 `processor.py`/`graph.py`/`Blueprint.jsx`，
    `yorha.db` 全程未改）：
    - **4b 绑定矩阵**（指令 → 默认协议 → 槽位）：纯函数 `frontend/src/utils/bindingMatrix.js`
      —— 一行一条**指令**（含未绑定的），`device_code → code` 排序、`is_default` 真值
      分栏（API 布尔 / DB 0·1 皆认）、重复默认出 `extraDefaults`、显式槽 → 节点标签、
      无显式槽 → `slot_order` 位次；**孤儿不静默**（`protocolMissing` / `slotMissing` /
      `stale===true` 才亮）。DataHub 页新增「绑定矩阵 (BINDING MATRIX)」只读面板：
      摘要八项计数 + 六列表 + 「N 条指令尚未指定默认协议」补齐提示，三读
      `GET /bindings · /instructions/ · /protocols/` 挂既有 `refresh()` **与状态面板
      同拍、单读失败互不拖垮**（加载/空库/出错三态）。
    - **D9/D10 文档划界落位**：`README.md` 新增 **§6 Scope Boundaries（页面划界 · D9/D10）**；
      `pageStatus.json` 协议页（页面划界 + 删槽回执）、通讯调试页（传输层唯一归属点）、
      编排绑定页（矩阵指针 + `accepts` 白名单）、数据中心页（矩阵条目）四条目，`PAGE_STATUS.md`
      再生；编排绑定页 `nextSteps` 移除已落地的「绑定集导入导出」。
    - **4c D8 全量核对（销项）**：`DESIGN_CorePipeline.md` 新增 **§6.3** —— §6.1 五行
      （结构 / 关系 / 值 / 配方 + 4a 恢复期镜像）+ §6.2 三行（指令 / 协议 / 槽节点）
      逐行落到函数 + 测试锚 → **8 行全「已有」、0 待补**；§6.2 槽节点行状态改写；
      `DESIGN_Decisions.md` D8/D9/D10 三表行 + 三处实施注（**D9-B / D10-B 重开条件
      「绑定矩阵落地」已具备，仍取 A**，重开须单独拍板）。
    - **验收**：BE **549/549**（持平 —— 本批无后端改动）、FE **958/958（64 文件，
      基线 948 + 10 = `bindingMatrix.test.js` 8 例 + `DataHub.test.jsx` 2 例）**、
      `npx vite build` EXIT=0、yorha-ui 校验器 4 文件 **0 违规**；**零 DDL**。
    - **人工验证 3 项通过**（真浏览器只读）：16 行矩阵与 API 逐项一致
      （`指令 16 · 有默认协议 1 · 无绑定 15 · 绑定 1 · 悬空槽 0 · 协议已删 0 · 失效绑定 0`，
      截图存证）、行内三格（`新协议 (NEW) / 按序 0` 与未绑定行 `—`）+ 底部补齐提示、
      刷新后矩阵随 `refresh` 重读一致；明细见 `PLAN_Backlog.md` §8.26。
    - **文档同步**：`DESIGN_CorePipeline.md` §7 批次四 4b/4c 进度注 + §6.3、
      `DESIGN_Decisions.md` D8/D9/D10、`README.md` §6、`pageStatus.json` + `PAGE_STATUS.md`、
      `PLAN_Backlog.md` §1 CP4 行 + 新 §8.26、本条。
    - **提交**：→ **`03b25d3`（代码+文档），2026-10-02**。
    - **状态**：**批次四（治理）三子批 4a / 4b / 4c 全数完成并提交 —— CP4 收口**。
      遗留待确认项（不阻塞）：应答是否带转义字节（`escape` 未接进 `response_match`，
      D15 关联项 1 / §9.7 人工验证 ④）→ **✅ 已销（2026-10-02，条目 44 / PLAN §8.35）**。

41. **CP3 人工验证复跑收口（3a①②③ + 3b①②③ + 洞位填装试发，8 项全过）**
    （2026-10-02，**纯验证 + 文档批、零代码改动、零 DDL、`yorha.db` 不随本批改动** ——
    临时协议/绑定/配方仅在本地验证会话中存在，验完从库备份 `yorha.db.bak_4bv` 整库
    还原，基线逐项一致：instructions 16 / protocols 3 / bindings 1 · `slot_order=0` /
    response_specs 0 / frame_recipes 0）：
    - **动机**：§9.7 排批表记着「3a①②③ / 3b①②③ / 3c⑤ 已执行通过（2026-10-01）」，
      但本文件 35/36 两条「待办：人工验证必查 3 项」与 `pageStatus.json` 编排页三条
      `nextSteps` 仍写「待补」——**三处文档互相矛盾**。本批以真浏览器实跑 + 后端
      `GET /dispatch/history` 对账定论，再把三处口径统一。
    - **3a 三项（加工页 `/processing`）**：① TRANSMIT 出线帧
      `DD CC FA FA ED 00 FA FA 00 00 00 00 00 05 01 08 ED`（17B，history `byte_count=17`）
      与 `WRAPPED_LAYERS` L3 汇总**逐字节一致**；载荷内含定界字节 `FA FA`、L1 带 `LEN`
      （D13「有 LEN = 不需要转义」观察对象，**真实设备判定仍待硬件**）；② 逐层字节与
      协议页卡面一致（L1 帧头 `FA FA` 2B@00 + 帧尾 `ED` 1B@02 + 设计期 `??` → 运行期
      `LEN=00` + 插槽 `??B` → 运行期 11B 内核；L2 固定块 `CC`→`EE`、卡面同步 `EE 1B @00`；
      L3 `DD`；累进 15/16/17B；单协议编译与配方 L1 **byte-equal**）；③ 改中间层协议
      （`PUT /protocols/…`，与协议页 SAVE 同端点）`CC → EE` 后重载 →
      `⚠ RECIPE STALE — 配方已失效：协议定义已变更，请重新保存配方` 点亮 + L2 行
      `DEF STALE`，**三层预览仍渲染**（warning 不阻断）。
    - **3b 三项（编排页 `/orchestration`）**：① 新建（POST `已新建 (CREATED) v1`）→
      改名 → 加层至 `层数 3 / 4` → 换序（第 3 层上移）→ 选槽（`#1 载荷插槽`，位次按下）
      → 关联 `示例状态包` → SAVE（v2..v4）→ **整页刷新回读逐项一致**（名称/层数/层序/
      槽位/关联），状态 `配方已同步`；② 选中配方试发 → 头部 `WRAP :: 配方 三层壳 (TRI-LAYER)`
      + SENT 17B（与 history 一致）；**刷新取消选中** → 头部回 `WRAP :: 组协议`，
      SENT 28B **与建配方前基线逐字节相同**（history 02:41:52 / 02:50:27 两条
      byte-equal）；③ 改名未保存 → `配方未保存` + **试发按钮 `disabled=true`** + 头部
      即时跟随草稿名；SAVE（v3）→ 恢复 `disabled=false`。
    - **附加拦截**：L3 挂含 2 个 `underflow=reject` 空槽的富协议试发被 **400**，detail
      逐槽透出「实际 0 字节 / 允许 1 字节（underflow=reject）」—— §6.1 值校验在配方期
      生效；改用无槽外层壳后成功。
    - **洞位填装 → 封装试发**：组内补第 2 条绑定 → 洞位下拉 `0 → 1` 换位 → 装配预览
      `[状态块]` 标记移位 → `保存更改`（`2 条未保存 → 0 条未保存`，history 侧
      `slot_order` 对调）→ 两次 52B 出线帧**载荷顺序互换**，`⚠ 空洞：1 个洞未被载荷填充`
      告警照出。
    - **文档同步**：`DESIGN_CorePipeline.md` §9.7 复跑补记 8 条、`PLAN_Backlog.md`
      §1 CP3 行 + 新 §8.27、`pageStatus.json` 编排页 `nextSteps` 删 3 条已销项 +
      `PAGE_STATUS.md` 再生、本文件 35/36 待办①销项 + 本条。
    - **状态**：**CP3 人工验证项全数销**；协议页 2 条同日以 42 收口，仍开放（不阻塞）
      仅剩 §9.7 ④ 应答转义字节（需真实设备帧或单独拍板）→ **✅ 已销（2026-10-02，
      条目 44 / PLAN §8.35）**。

42. **协议页两条人工复测收口（slot refs 新语义 4 子项 + 跨泳道拖拽）**
    （2026-10-02，**纯验证 + 文档批、零代码改动、零 DDL** —— 验证过程中的 refs 增删与
    拖拽改树仅在本地会话存在，验完从库备份 `yorha.db.bak_4bv` 整库还原，基线逐项一致：
    protocols 3 / bindings 1 · `slot_order=0` / frame_recipes 0、LENGTH refs 回 3 项、
    嵌套容器 children 回 3 项、`yorha.db` 工作树零 diff）：
    - **工具口径**：全程用浏览器工具的**真实点击 / 真实拖拽**（snapshot 取 ref → click /
      drag），不走合成 MouseEvent —— 合成事件不触发画布选中，正是此前「待补」的成因。
    - **① slot 拾取计数进位**：点 LENGTH 卡 → 属性面板 `结构引用 (REFS)` `3 REF(S)` +
      `SELECT FIELDS`（芯片：固定块 / 固定块 / 新容器）→ 点 `SELECT FIELDS` 按钮变
      `STOP PICKING (DONE)`（拾取态）→ 点 SLOT 卡 → **`4 REF(S)`** + 新芯片 `SLOT ×` +
      `保存更改 (SAVE)` 出现（脏态）→ SAVE 落库（服务端 `parameter_config.refs` 4 项、
      `version` 8）。
    - **② 自引用 SYS 提示**：拾取态点 LENGTH 自身 → 计数**仍 `4 REF(S)`**（未入 refs），
      状态栏出 **`SYS: 不能引用自身`**。
    - **③ 含槽卡面 `??`**：加槽前 LENGTH 卡面 `3B`（Σ=1+2+0 可定注入）→ 加槽后
      **`LENGTH ?? 1B @06`**（`computeRefsSigma` 对含槽 refs 整卡不注入维持 `??`）；
      对照组：既有 CHECKSUM（refs 含槽）同为 `??`，嵌套容器内 LENGTH（refs=固定块 1B
      全可定）仍注入 `1B`；SAVE 后刷新回读卡面与 chips 一致（`REF SLOT` 角标点亮）。
    - **④ 组装试发 SENT 长度含载荷真值**：编排页封装试发出线
      `… ED 00 0E EE 00 01 20 …`（28B）→ LENGTH 字节 **`0E` = 14 = 内核 11B + 引用固定块
      3B**；改槽 refs **之前**同路径出线为 `… ED 00 03 EE …`（`03` = 设计期静态 Σ=3B）——
      **同一出线位 `03 → 0E`，从静态设计值翻成含载荷真值**。旁证：`POST /compile/wrapped`
      用 payload 0/1/2/4/11B 扫描，LENGTH 字节 **`03/04/05/07/0E` = payload + 3 线性跟随**；
      UI 试发出线与 API 编译帧**逐字节一致**；`⚠ 空洞：2 个洞未被载荷填充` 照常透出。
    - **⑤ 跨泳道拖拽落点**：画布 3 泳道（根 `新协议 (NEW)` / 空容器 `新容器 [EMPTY
      GROUP]` / 嵌套容器）→ 把嵌套容器里的 `固定块 00 1B @0A` 真实拖到根泳道
      `固定块_1 00 00 2B @02` 卡上 → 落点**贴目标前插**（根泳道 14 卡：`固定块 @02` +
      `固定块_1 @03`，偏移全量重算），嵌套容器剩 2 卡（LENGTH / CHECKSUM），脏态
      `保存更改 (SAVE)` → SAVE 落库（`bd980b3a` 上移至顶层 index 2、
      `c8925b01.children` 剩 2、`version` 9），**UI 三泳道与服务端 children 树一致**；
      截图存证（三泳道 + `4 REF(S)` 芯片 + 跨泳道落点同框）。
    - **文档同步**：`pageStatus.json` 协议页 `nextSteps` 两条销项（`PAGE_STATUS.md` 再生）、
      本文件 11/12 两条待办销项 + 本条、`PLAN_Backlog.md` 新 §8.28。
    - **状态**：**协议页人工复测项全数销**；全仓遗留仅 §9.7 ④（应答是否带转义字节，需
      真实设备帧或单独拍板）→ **✅ 已销（2026-10-02，条目 44 / PLAN §8.35）** +
      编排页「绑定拖拽排序（拖拽交互未做）」**功能项**（非验证项）→ **已排期
      （PLAN §8.37 批 R4）**。

43. **本会话六批（五实现 + 一文档）：共享向量收口 / DB 版本化升级 / README 单一事实来源 /
    关键链路诊断 / 危险操作可恢复性 / 评审清单收口**（2026-10-02；**零 DDL** —— 未改
    `models.py`、未碰 `processor.py` / `graph.py` / `Blueprint.jsx`、`/dispatch`
    缺省裸帧口径逐字节不变；仅批 2 有 `chore(db)` 同步提交）：
    - **批 1 共享向量收口** → **`f76d406`**：`backend/tests/test_vectors_manifest.py`
      五道闸（manifest ↔ vectors/ 双向齐 / hash 一致 / 无孤儿向量 / 目录纪律 /
      README 一节一锚）+ `frontend/src/utils/__tests__/vectorsLoader.test.js` 五例 +
      `vectors/README.md` §6；此后**新增向量只写一处**。
    - **批 2 SQLite 版本化升级机制** → **`8b8fcfc`**（代码+文档）+ **`9dad0e1`**
      （`chore(db)`：`schema_migrations` 版本表 + `0001_baseline` 记录，v1、
      integrity ok）：`backend/db/migrate.py`（裸 SQL 版本表**不动 `models.py`** /
      `Migration` 注册表从 1 连续 / 既有库 apply 前整库快照到 `backend/db/backups/`
      / apply+verify+记版本同一事务 / `PRAGMA integrity_check` 终检 / CLI
      `python -m backend.db.migrate status|up`）+ `test_migrate.py` 18 例 + lifespan
      接入（`create_all` 与 5 个 `ensure_*` 之后、fresh 判定在 `create_all` 之前）。
      **关键发现**：pysqlite「非 DML 前隐式 COMMIT」使 DDL 落在事务外、回滚撤不掉
      （实测残留 `probe` 表）→ 迁移专用引擎用 SQLAlchemy 官方 recipe（连接
      `isolation_level=None` + `BEGIN` 事件显式 `BEGIN`，`NullPool` 跑完 dispose），
      **只作用于迁移连接，主 engine 语义不动**。
    - **批 3 README 单一事实来源** → **`62fb68a`**：EN/ZH README 状态节改纯指路
      （唯一数据源 `frontend/src/config/pageStatus.json`，`docs/PAGE_STATUS.md` 为
      生成物禁手改），纠正两处过期占位页说法 + Run Tests 补后端命令 + 目录结构补
      lifespan 顺序与 `migrate.py`。
    - **批 4 关键链路可诊断反馈** → **`46f65a4`**：新增 `backend/core/diagnostics.py`
      （`Diagnostic` / `DiagError` / `DiagHTTPException` / `http` / `http_from` /
      `with_detail` / `diagnostic_of` / `install`）→ 错误体 `{"detail": 原文,
      "diagnostic": {…}}`；**只做加法**：`detail` 字符串与文案逐字不变、普通
      `HTTPException` 仍走 FastAPI 默认形状、成功路径零改动。四条链路接线：组帧
      （`dispatch` 拆转义/封装/hex 三段 + 配方逐层 `layer`）、发送（502 +
      `byte_count`、序列互斥 409）、应答匹配（`spec`/`param` + 失败事务
      `TransactionRecord.diagnostic` 三态）、序列执行（ERROR 步必带 `diagnostic`，
      成功步不加键）；前端 `client.js::handleResponse` 挂 `error.diagnostic` + 消息
      前压摘要（`formatDiagnostic`）。**BE +33、FE +10**。
    - **批 5 危险操作可恢复性** → **`f1e38ef`**：restore **当场 schema 自愈**
      （`create_all` + 5×`ensure_*` + 迁移 `do_backup=False` + integrity，失败报错带
      `pre-restore` 快照名，响应新增 `schema{applied,version,integrity}`）/
      **序列运行中禁止恢复 409** / 恢复后传输配置**当场对齐且不抹
      `active_profile_id`**（摘钩→交回→挂回，响应新增 `transportConfigRestored`）/
      迁移**拒绝更高版本的库**（`version > target` 动列前抛错）/ 配置**持久化失败
      留痕**（error 事件可见）。**BE +8**（`test_recoverability.py` 7 +
      `test_migrate.NewerDbTest` 1），全部临时库不碰真库。
    - **批 6 文档评审清单收口（本条 + 同批）**：PLAN 新 **§8.34**（A 组 9 处过期说法
      纠正 / B 组 8 项真实缺口 + 暂缓挂账 / C 组 5 项待拍板）+ 就地改正
      `DESIGN_CorePipeline.md` §9.8、`DESIGN_Decisions.md` D13 边界与「拍板后的下一步」、
      本文件条目 31/33/34/35 的「待办 CP3」旧话 + §6 目录地图补 `migrate.py` /
      `backups/` / `diagnostics.py` / `tests/` 四行与 `main.py` lifespan 新顺序。
    - **验收**：批 4/5 跑 **BE 613/613**、**FE 973/973（66 文件）**、`npx vite build`
      EXIT=0、yorha-ui 校验器 0 违规；uvicorn 实测 4 例（400 / 404 带 `diagnostic`、
      200 缺省记录**零新增字段**）；批 1/2/3 见各自 §8.29–§8.31（BE 572、FE 963 基线）。
    - **状态**：**本会话六批（五实现 + 一文档）全部提交**；遗留 = PLAN §8.34
      C 组五项**待用户拍板**（自动选指令路由 / 响应解码为字段 / 全量项目包迁移 /
      应答反转义口径 / 三项暂缓是否重启）+ B 组功能缺口（编排页拖拽排序、float64
      编码、pre-import 快照、回收站、上一配置回退、ESLint 存量）+ §9.7 ④ 需真机帧。
      → **本条遗留已随后续两批推进（条目 44 / 45）**：C-4「应答反转义口径」与 §9.7 ④
      **已销**（条目 44 / PLAN §8.35）；C 组余 4 项出**详版（含举例、现状证据、成本、
      建议）**、B 组 6 项**已排期**（条目 45 / PLAN §8.36、§8.37）。

44. **真机应答口径收口：「应答带转义字节」→ 先线上、后逻辑双口径（销 §9.7 ④ / D15
    关联项 1）**（2026-10-02，**零 DDL** —— 未改 `models.py` / `database.py`，`yorha.db`
    不随本批提交；未碰 `processor.py` / `graph.py` / `Blueprint.jsx`；`/dispatch` 缺省
    口径逐字节不变 —— `escape` 缺省关闭 ⇒ 收侧 `unescape=None` ⇒ 判定仍是与存量同一条
    单口径路径）：
    - **起因**：§8.34 B1-1 / C-4 —— `escape` 反转义 grep `response_match` 零命中，
      「应答是否也带转义字节」在环回下无法定论，一直挂着「需真实设备帧」。按用户
      2026-10-02 指令**不等硬件**：先查公开规范里真机的应答行为，再据此**模拟真机应答**。
    - **调研定论**：DL/T 645-2007（数据域 +0x33 **双向对称**、L/CS 按**线上字节**算）
      与 RFC 1662 §4.2 / RFC 1549（0x7D stuffing **双向对称**、FCS 在塞字节**之前** =
      逻辑字节）两条公开规范 ⇒ 转义必对称，**应答带转义字节**；L/CS 覆盖哪种字节两种
      规范各占一端，而本仓内核 = RFC 1662 型、外壳 = DL/T 645 型（**自己就是混合的**）
      ⇒ **「两种都收」才是自洽解**，单选必把一半真机判成失配。
    - **实现（只做加法）**：`escape.py::unescape_bytes`（`escape_bytes` 的逆：左到右
      最长匹配、单趟不回扫、空表直通）+ `response_match.match_response` 拆出
      `_match_frame` 外加第二口径 —— 先按**线上字节**判，未过且表**确实能改变字节**
      才把 `sent`/`received` **一并**还原再判，第 2 次过即命中；两次都不过返回**第 1 次**
      的 reasons（**不 fail-open**）；`unescape` keyword-only 缺省 `None`。接线仅
      `/dispatch/transaction`（转义表提到循环外建 `rx_unescape`）。**`detail` 文案 /
      诊断形状 / 成功路径 / 序列 runner 零改动**（runner 本就无应答匹配）。
    - **测试**：新 `backend/tests/test_real_device_reply.py` **17 例** —— 共享向量 7 组
      互逆；RFC 1662 型真机（不给第二口径 = 现存症状 `LENGTH_MISMATCH(3!=5)` +
      `CHECKSUM_MISMATCH`，给了即命中、应答确实逻辑 6B→线上 8B）；DL/T 645 型真机第 1 次
      即命中 + **次序反了必失配**（反证「先线上」）；两层套壳帧线上恒成立、改坏内层出
      `STAGE[0].CHECKSUM_MISMATCH`；整链路 5 例（逻辑型 OK / 线上型 OK / 坏帧 FAILED 且
      history 照旧 ERROR / **escape 关闭仍是单口径 OK** / 环回 echo 字节未被改动）。
    - **验收**：**BE 630/630**（基线 613 + 17）、**FE 973/973（66 文件）**、
      `npx vite build` EXIT=0、yorha-ui 校验器 2 文件 **0 违规**（本批零前端改动）；
      `pageStatus.json` 协议页末条销项 → `PAGE_STATUS.md` 再生。
    - **文档同步**：PLAN 新 **§8.35**（含调研证据表）+ §8.27 / §8.28 残留行、§8.34
      B1-1 / C-4、§1 ⑤ 行回填；`DESIGN_CorePipeline.md` §9.7 ④ 与 §9.8 残留行；
      `DESIGN_Decisions.md` D15 关联项 1 与两处实施注；本条。
    - **状态**：**§9.7 ④ 与 D15 关联项 1 销项**；仍开放的真机核对只剩**出线方向**
      （D13「有 LEN = 不需要转义」在载荷含定界字节时设备是否异常，§9.7 ①）**→ ✅ 出线方向
      亦已销（2026-10-03，条目 68 / PLAN §8.51）**。

45. **五项拍板详版 + B2 六项排期（纯文档批：PLAN §8.36 / §8.37）**（2026-10-02，
    **零代码、零 DDL、`pageStatus.json` 未动 → `PAGE_STATUS.md` 不重生成**）：
    - **§8.36 五项拍板详版**（应用户「描述详细一些，最好举例说明」）：每项按
      **现状代码证据 → 到底决断什么 → 举例（一个选 B/C 才能解 + 一个不做也能过）→
      A/B/C 成本量级与前置 → 建议 + 不做的后果** 展开。
      · **C-1 路由**：`TransactionRequest` 单条 `hex_string`、`sequence_steps` 无
      condition 字段、全 backend grep 路由词零命中（序列严格线性）；**B 序列级分支**
      （1–2 批，加 `condition` 列合 §0）vs **C 输入值规则表**（2–3 批，撞 §0 → 只能
      做独立端点）—— 两个能力不可合并拍；建议本轮 A。
      · **C-2 解码**：全仓 grep `decode/bytes→fields` 0 命中、`vectors/float_ieee.json`
      只有正向 21 组；建议 **B 仅展示（零 DDL）**，并点明 **C-2 是 C-1 选 C 的硬前置**。
      · **C-3 迁移**：三条路径逐一对账 —— 整库 `backup`=`shutil.copy2` + `restore`
      自愈（**已能搬机**）、bundle 只含 `instructions+relations+frames`、导入端点
      = relations + 指令页/协议页逐条；**缺 5 张表**（配方/序列/传输配置/设备档案/
      算子模板）；建议 **C 补域折中**（第一件事 = pre-import 快照 = R1），
      不建议 B（重复造 backup）。
      · **C-4** 改「**请确认接受该口径**」（§8.35 已解决）。
      · **C-5**：① CRC —— BE 三算法 / FE `formula.js` 声明 `CRC_32` 但 switch 无 case、
      三道护栏 + `mapChecksumAlgo` 静默归一 → 接 CCITT **连存都存不进去**；② 长度域 ——
      `length.py` 恒 big-endian 而应答侧已支持 `byte_order` → **能判不能发**；
      ③ varint/COBS —— 组帧元素只有 `container/fixed/bitfield/length/checksum/slot`、
      动解包属最高风险档。**建议 ①② 触发式（②可先做）、③ 明确不做**。
    - **§8.37 B2 六项排期**（用户授权「可以进行排期」）：**R1** 导入 pre-import 快照
      （BE 小）→ **R2** 传输配置上一配置回退（BE+FE 小）→ **R3** ESLint 存量（FE 中）→
      **R4** 编排页绑定拖拽（FE 中）→ **R5** float64 双端（BE+FE+向量中，1–2 批）→
      **R6** 软删除/回收站（**含 DDL**，2 批）—— 合计 **7–8 批**；排序理由与每批
      「验收口径」写全（**自 R3 起才把 `npm run lint` 变成门槛**）。
    - **纠正**：§8.34 B2-8「ESLint 存量 1 error 2 warnings」**数字过期** —— 当前 HEAD
      全仓 `npm run lint` 实测 = **60 problems（42 errors / 18 warnings）、26 文件**
      （`no-unused-vars` 23 / `exhaustive-deps` 17 / … / `rules-of-hooks` 1）；原小数字
      系早期批次口径（§8.7 记录里 `Protocol.jsx` 单文件即 1 error 2 warnings）。
      「各批不计入验收」的处置属实并维持，清理排 R3。
    - **状态更新**：§8.34 B2 组改「已排期 → §8.37（R1–R6）」、C 组挂 §8.36 详版索引
      （实质待拍 = 4 项）；`PLAN` §1 批次总览新增 **C 待拍** / **R1–R6** 两行。
    - **顺带修表（文档卫生）**：§1 批次表的 CP3 行原本**跨行续写**（第 40–45 行是裸
      段落），把表格从第 39 行截断 —— 于是 **CP4 行起已经不是表格、渲染成裸文本**。
      改法 = 续行用 `<br>` 并回 CP3 单行 + 去掉 CP3/CP4/新行之间的两处空行 →
      表格恢复连续（校验：四行列数一致 = 4 个 `|`；全文件表格块 0 处列数错配）。

46. **五项拍板全部收齐并落档（纯文档批 · PLAN §8.36 拍板结果表 / §8.37 追加 R7–R10）**
    （2026-10-02，**零代码、零 DDL**）：
    - **拍板内容（用户逐项给出）**：**C-1 = A 本轮不立项**（维持人工选 + N3 设计期
      双支，序列仍线性）；**C-2 = C 入库回写**（= B 解码面板 + `dispatch_logs` 加
      `fields_json` 两步，**仅新增列**）；**C-3 = C 补域 + manifest 折中**（不选 B ——
      重复造 backup）；**C-4 = 确认接受**（「应答带转义字节 + 先线上后逻辑」正式定案，
      §9.7 ④ / D15 关联项 1 销项）；**C-5 = 按建议**（① CRC / ② 长度域 **触发式**、
      ③ varint/COBS **明确不做**）；**R6 = 13 表统一加 `deleted_at`**（列方案，不做
      `trash_bin` 新表 —— 原「列 vs 表」待拍项关闭）。
    - **排期更新**：C-2 → **R9 + R10**、C-3 → **R1（快照，已排）+ R7 + R8**；
      追加批次按「不在已批准的 R1–R6 顺序中插队」原则**排在 R6 之后**，且 R7/R8 与 R1
      同属 `datahub` 模块可直接复用 R1 的快照函数。**排期合计 R1–R10 = 11–12 批**
      （R1–R6 7–8 批 + R7–R10 4 批）。
    - **文档同步**：PLAN §8.36 新增「拍板结果」表（8 行：C-1/C-2/C-3/C-4/C-5×3 + R6
      方案，每行含「落地含义 + 编入哪个批次」）、§8.37 「排期外」段改「拍板后追加
      R7–R10」表 + 追加理由、§1 批次表 `C 待拍` → `C 已拍` 行与 `R1–R6` → `R1–R10`
      行、§8.34 C 组头标已拍 + 第 5 条标已定。
    - **状态**：**C 组 5 项 + R6 方案全部关闭**，无待拍板项残留；下一步 = 按排期开跑
      **R1**（导入 pre-import 自动快照，BE 小批，= C-3 选 C 的第一件事）。

47. **R1 数据导入 pre-import 自动快照落地（排期首项 · PLAN §8.38）**（2026-10-02，
    **零 DDL、后端 only、零前端改动** —— 未改 `models.py`/`database.py`，`yorha.db`
    不随本批提交；未碰 `processor.py`/`graph.py`/`Blueprint.jsx`；`/dispatch` 缺省
    口径不变）：
    - **起因**：§8.34 B2-5 → §8.37 **R1** —— 恢复前有 `pre-restore` 快照、**导入没有**
      （风险不对称）；C-3 选 C 后它又成为 **R7/R8 的硬前置**，故排首项。
    - **实现**（`backend/routers/datahub.py` 3 处）：① 新 `safety_snapshot(prefix,
      scenario, db_path, backup_dir)` 把「先快照、失败即中止」收成一处（缺省读模块级
      `DB_PATH`/`BACKUP_DIR`、缺库 → `None` 不报错、`OSError` → 500 +
      `安全快照失败，已中止{场景}：{exc}`）—— R8 复用；② `/import/relations` 顺序改
      **校验 → 快照 → 回灌**（400 不落垃圾快照；快照失败 500 且一行未写），响应新增
      **`preImportSnapshot`**（只做加法）；③ `isSafetySnapshot` 前缀改常量
      `SAFETY_SNAPSHOT_PREFIXES = ("pre-restore-", "pre-import-")` —— 否则 `pre-import-*`
      在备份列表里与手建备份无从区分（FE 徽标只渲染 `[快照]`、恢复按钮对所有条目可点，
      **不改现有语义**）。
    - **测试**：`backend/tests/test_datahub.py` 新 `TestImportPreSnapshot` **6 例**
      （直调路由函数不走 TestClient，沿 `test_bindings.py` 惯例）：快照先于写库且字节
      = 回灌前 / 400 零快照零写入 / 快照失败 500 且零写入 / 缺库 → `null` 照常导入 /
      helper 两分支 / `pre-import`+`pre-restore` 同打徽标而手建备份不打。**setUp 替换
      模块级 `DB_PATH`/`BACKUP_DIR` 必须在 tearDown 还原**（沿 §8.35 教训）。
    - **验收**：**BE 636/636**（基线 630 + 6）、**FE 973/973（66 文件）**、
      `npx vite build` EXIT=0、yorha-ui 校验器 `DataHub.jsx` **0 违规**（零前端改动）；
      零 DDL → 无 `chore(db)` 提交。
    - **文档同步**：`pageStatus.json` 数据中心页「关系数据回灌」补快照口径 +
      `PAGE_STATUS.md` 再生、PLAN 新 **§8.38** + §8.37 R1 行标已办 + §1 `R1–R10`
      行状态 + §8.34 B2-5 标已办、本条。
    - **范围说明**：只覆盖 `POST /datahub/import/*`（B2-5 原文口径，该前缀下当前只有
      `relations`）；**指令页 / 协议页逐条 JSON 导入走别的端点、不在本批**（逐条 create
      + 冲突跳过，语义不同，需要时另立批次）。
    - **状态**：**R1 ✅**，余 **R2–R10**（R2 传输配置上一配置回退 → R3 ESLint →
      R4 拖拽 → R5 float64 → R6 软删除（13 表加 `deleted_at`）→ R7/R8 C-3 补域 →
      R9/R10 C-2 解码入库）。

48. **R2 传输配置「上一配置」一键回退落地（PLAN §8.39）**（2026-10-02，**零 DDL、
    BE+FE** —— 未改 `models.py`/`database.py`，`transport_settings` 结构不变；未碰
    `processor.py`/`graph.py`/`Blueprint.jsx`；`/dispatch` 缺省口径不变）：
    - **起因**：§8.33「不改 backlog」/ §8.34 B2-7 → §8.37 **R2** —— 改错配置只能手动
      改回来；§8.33 的持久化失败留痕是**事后**从 error 事件看见的，缺一个**当场**动作。
    - **实现**：`transport.set_config` 新增 `record_history`（缺省 `True`，只做加法），
      真变更时把被替换的旧版压进 `_config_history = deque(maxlen=20)`；新
      `revert_config()` 弹栈 → 校验 → 断连 → 落库 → `_record_event("config", …)`，
      返回 `{config, historyDepth}`，栈空 `ValueError` → **400**；
      `POST /transport/config/revert`；`get_status()` 新增 **`configHistoryDepth`**
      （只做加法）；`reset()` 一并清栈；`_persist_best_effort()` 从 `set_config` 抽出
      供两条路径共用。FE：`api/transport.js::revertTransportConfig` + barrel 导出 +
      通讯配置区 `回退上一配置 (REVERT)`（`disabled = !depth`，0 置灰）+ 回填生效配置
      并 `refreshStatus/refreshProfiles`。
    - **两条一改就错的语义**：**回退本身不入栈**（否则能无限「回退回退」振荡，退不到空）；
      **启动装载不入栈**（`restore_transport_config` 传 `record_history=False`，否则一开机
      栈里躺一份默认配置，什么都没改点回退就被重置回默认）—— 档案激活属用户动作照常入栈。
    - **测试**：BE 新 `test_transport_revert.py` **8 例**（含**有界 20 挤掉最老一版**、
      **连退三版再 400**、**端到端走 `restore_transport_config` 验装载不入栈**）；
      `test_transport.py` 的**精确键集**断言加入 `configHistoryDepth`（全仓唯一一处
      `get_status()` 形状断言 —— 本批的**主动形变**，非漏改）。FE `Terminal.test.jsx`
      **+3 例**（置灰 / 成功回填 / 400 detail 展示）。
    - **验收**：**BE 644/644**（基线 636 + 8）、**FE 976/976（66 文件）**（基线 973 + 3）、
      `npx vite build` EXIT=0、yorha-ui 校验器 `Terminal.jsx` **0 违规**；零 DDL → 无
      `chore(db)` 提交。
    - **边界**：回退栈**进程内**、**重启即空**（R2 定为零 DDL）；跨重启回退需给
      `transport_settings` 加列 → 归 R6 那档 DDL 批。
    - **同批拍板记录（R4）**：编排页绑定拖拽 —— **拖完只改展示序，点保存按钮才改持久序**
      （拖拽 = 本地草稿态，「保存」调同一个 PUT 回写 `slot_order`，零 BE 改动）。
    - **文档同步**：`pageStatus.json` 通讯调试页 + `PAGE_STATUS.md` 再生、PLAN 新
      **§8.39** + §8.37 R2 行已办 / R4 行拍板 + §1 `R1–R10` 状态 + §8.34 B2-7 已办 +
      §8.33 backlog 项销号、本条。
    - **状态**：**R1 ✅ R2 ✅**，余 **R3 ESLint（60 problems，本批起加 `npm run lint`
      门槛）→ R4 拖拽 → R5 float64 → R6 软删除（13 表加 `deleted_at`）→ R7/R8 → R9/R10**。

49. **R3 · ESLint 存量清零，`npm run lint` 自本批起成为验收门槛（PLAN §8.40）**
    （2026-10-02，**纯 FE + 1 处 lint 配置** —— 未碰 `backend/`、`models.py`、
    `processor.py`/`graph.py`/`Blueprint.jsx`，`/dispatch` 缺省口径不变，零 DDL）：
    - **起因**：§8.34 B2-8（原「1 error 2 warnings」已于 2026-10-02 复测纠正为
      **60 problems / 42 errors / 18 warnings / 26 文件**）→ §8.37 **R3**。
    - **结果**：`npm run lint` **EXIT=0、0 problems / 0 文件**（60 → 0，涉 27 文件，
      `git diff --stat` = 27 files / +120 / −48）。
    - **处置分布**：`no-unused-vars` 23 → 删未用绑定（`catch (_) {}` → `catch { 理由 }`、
      未用 prop 解构）；`exhaustive-deps` 17 → **逐条带理由 disable**；`no-useless-escape`
      3 → 正则字符类内去掉多余 `\\-`（语义不变）；`no-empty` 2 → `catch { 中文理由 }`；
      `no-undef` 1 → 测试补 `import { …, beforeEach } from 'vitest'`；
      `no-extra-boolean-cast` 1 → `!Boolean(x)` → `!x`；`no-control-regex` 1 →
      **故意的**控字符校验，注释 disable；旧的无人报告 disable 指令 1 → 删。
    - **React Compiler 规则 11 条的处置（关键）**：先加定点 disable → 被
      `reportUnusedDisableDirectives` 判「没盖住任何问题」→ **逐条删/留做实验**
      （删掉 disable 重跑确认 0 报告）才定稿，最终只留 **2 条真被用上的
      `set-state-in-effect`**（`SmartInput`、`InstructionProcessor`）。
      **最终全仓定点 disable = 20 条**：`exhaustive-deps` 16 / `set-state-in-effect` 2 /
      `no-unused-vars` 1 / `no-control-regex` 1。
    - **顺手修掉 2 处真问题（等价修，非改行为）**：
      ① `ParamConfigForm.jsx` **conditional hook** —— `if (!template) return null` 写在
      `useEffect` **之前**，`op_code` 切到无模板指令时**钩子数跳变**会抛错；改成
      「无模板判断进 effect 体内短路 + 早退挪到钩子之后」，渲染输出与 effect 触发条件
      逐条等价。② `NieRDatePicker.jsx` **先用后声明** —— `initDate` 声明在 effect 之后，
      改成 `syncState` → `initDate` → `useEffect` → 早退的纯重排。
    - **yorha-ui 校验器**：`NieRModal.jsx` **4 条违规是 HEAD 存量**
      （`backdrop-blur-[2px]` / `rounded-full` / `p-8` / `px-6`×2）—— R3 改到该文件就必须
      过校验器 → 顺手清（去 blur 去圆角、`p-8`→`p-4`、`px-6`→`px-4`，密度对齐页内既有值）。
    - **⚠️ 工具坑（必记）**：**PowerShell 5.1 的 `>` 默认写 UTF-16LE** ——
      `git show HEAD:... > f.jsx` 交给校验器会得到**假的「0 违规」**（按 UTF-8 读出乱码
      什么也匹配不到）。比对 HEAD 版本必须用 `cmd /c "git show ... > f.jsx"` 或 Python 写字节。
    - **验收**：`npm run lint` **EXIT=0 / 0 problems**、**BE 644/644**、
      **FE 976/976（66 文件）**、`npx vite build` EXIT=0、yorha-ui 校验器
      **18 个改动 `.jsx` 全部 0 违规**。
    - **边界**：**只清欠账不改行为** —— 除上述两处「等价修 + 纯重排」外全是删除与注释；
      `exhaustive-deps` 一律定点放行而**没**顺手补 deps（补 deps 会改变 effect/memo 触发
      时机 = 行为变更，须单独排批；`useInstructionLanes.allFields` 那 4 条同理，正解
      （空数组收成模块级常量 / `useMemo` 固定引用）已写在注释里）。
    - **文档同步**：PLAN 新 **§8.40** + §8.37 R3 行已办 + §1 `R1–R10`（R1 ✅ R2 ✅
      R3 ✅ + lint 门槛生效）+ §8.34 **B2-8 标清零**、本条。
    - **状态**：**R1 ✅ R2 ✅ R3 ✅**，余 **R4 拖拽（已拍：拖完只改展示序、点保存才改
      持久序）→ R5 float64 → R6 软删除（13 表加 `deleted_at`）→ R7/R8 → R9/R10**。
      自本批起每批验收项固定为：BE 全量 + FE 全量 + `npx vite build` +
      **`npm run lint` EXIT=0** + yorha-ui 校验器 0 违规。

50. **R4 · 编排页绑定拖拽排序 —— 拖完只改展示序，保存才改持久序（PLAN §8.41）**
    （2026-10-02，**纯 FE，零 BE 改动、零 DDL** —— 未碰 `backend/`、`models.py`、
    `processor.py`/`graph.py`/`Blueprint.jsx`，`/dispatch` 缺省口径不变）：
    - **拍板**（§8.37 用户原话）：**「R4 拖完改展示序，点击保存按钮才改持久序」**。
    - **为什么零 BE**：侧栏展示序 = `sortedBindings` 按 **(协议序, 洞号)** 派生，而
      `slot_order` 本来就是 PUT 载荷字段（`toServer()` 一直带）→ 「改展示序」= 本地重写
      `slot_order`（草稿），「改持久序」= 点「保存更改 (SAVE)」逐行 `PUT /bindings/{id}`。
      **同一字段的两个阶段，不是两套数据**，所以没有"拖拽专用接口"这回事。
    - **新增 `frontend/src/utils/reorderBindings.js`（纯函数，拖拽/下拉共用）**：
      `moveBindingToIndex()` 组内换位 + 稠密重编号 0..n-1 + 目标位次钳 `0..组内余数`
      + **只回写真变化的行**；`reorderBindingsWithinGroup()` 落在 `over` 的原位次，
      **跨协议组直接 `null`**（洞号是组内位次，不猜"要不要顺带换协议"）。两条路径位次
      数值等价的推导写在文件头注释。
    - **`Orchestration.jsx`**：抽**模块级 `BindingRow`**（`useDraggable`/`useDroppable`
      是钩子，**不能进 `.map()` 回调**）；把手 = label 前的**空白 grip**（两根 1px 横线）——
      **无文本节点**（不动 `aside .truncate` 的 `textContent` 既有断言）、**不是 button**
      （不影响「行内首个 button = 删除」取法）、**只挂 `listeners` 不挂 `attributes`**
      （不给行加 `role="button"`）；`<DndContext>` 只包侧栏列表，`PointerSensor` +
      **8px 起拖**（点一下选中不误判成拖）；`handleDragEnd` → 换位 + 并进 `dirtyIds`，
      `loadFailed` 只改本地不标脏。键盘/无障碍等价路径本来就有（属性面板洞位下拉）。
    - **测试 +14 → FE 990/990（67 文件）**：`utils/__tests__/reorderBindings.test.js`
      **11 例**；`Orchestration.test.jsx` **+3 例**（① 拍板口径：展示序立刻翻转 +
      `updateBinding` 零调用 + SAVE 禁用→可用 → 点 SAVE 才 PUT 新 `slot_order`；
      ② 跨协议组落点不换序/不标脏/SAVE 仍禁用；③ 只有真变化的行进队列 —— 断言
      `updateBinding` **从未**以 `srv-3` 被调用、脏标记只在前两行）。
      **怎么测拖拽**：jsdom 无真实指针传感器、`getBoundingClientRect` 全 0 →
      `vi.mock('@dnd-kit/core')` **只把 `DndContext` 的 `onDragEnd` 透到 DOM**，测试直接
      调用；被测的是我们自己的换位/标脏/落库口径，不是 dnd-kit 本身。
    - **更正 §8.37 原行两处失实**：① 「现状 = 上移/下移按钮 + 洞位下拉」→ 实测**只有
      洞位下拉，没有上下移按钮**；② 「未保存切换协议/刷新要有丢弃提示」→ 刷新**已有**
      `beforeunload` 拦截、协议切换**不丢稿**（脏行按行驻留）→ **无需新增**。
    - **验收**：`npm run lint` **EXIT=0**、**BE 644/644**、**FE 990/990（67 文件）**、
      `npx vite build` EXIT=0、yorha-ui 校验器 **0 违规**；零 DDL。
    - **文档同步**：PLAN 新 **§8.41** + §8.37 R4 行已办 + §1 `R1–R10` 状态、本条。
    - **状态**：**R1 ✅ R2 ✅ R3 ✅ R4 ✅**，余 **R5 float64 → R6 软删除（13 表加
      `deleted_at`，DDL）→ R7 导出补域 → R8 导入补端点 → R9 解码展示面板 → R10
      `fields_json` 入库（DDL）**。每批验收项固定为：BE 全量 + FE 全量 +
      `npx vite build` + **`npm run lint` EXIT=0** + yorha-ui 校验器 0 违规。

51. **R5 · float64 编码双端（缺省 f32 逐字节不变）—— PLAN §8.42**
    （2026-10-02，**BE + FE + 向量，零 DDL** —— 未碰 `models.py`、`processor.py` /
    `graph.py` / `Blueprint.jsx`，`/dispatch` 缺省口径不变）：
    - **它是什么问题**：不是「功能缺失」，是**双端不一致** —— R5 前 `byte_len=8`：
      FE `getFieldBytes` 落默认整数路径出 `0000000000000001`，BE `datahub.to_block`
      的 `byte_len == 4` 闸不命中 → 保持 zeros。**同一份指令，本地试发与服务端编译 /
      导出给出两种不同的帧**。N1（§8.16）当时只能挂 `FLOAT64_UNSUPPORTED` 提醒
      （G7 定案「提醒而非改模板」），本批补真正的双端分支。
    - **BE**：`orchestrator.encode_float_ieee(value, byte_len=4)` 加**缺省 4 = 存量
      行为**的形参 —— `byte_len == 8` → `struct.pack(">d")` 出 16 hex，否则仍 `">f"`；
      解析口径 `_float_number` **一字未改**（非有限 → 0，f64 也不写 NaN 位型）。
      `datahub.to_block` 分派 `byte_len == 4` → `byte_len in (4, 8)`。LITTLE 走
      `orchestrator.py` 的**字节整体逆序**，与宽度无关 → f64 自动成立（补测）。
    - **FE**：`InstructionEncoder.getFieldBytes` —— `byteLen === 4` → `(4 || 8)`、
      `new Float32Array(1)` → `byteLen === 8 ? new Float64Array(1) : new Float32Array(1)`，
      解析 / `isFinite` 归 0 / `.reverse()` 全复用，**4 位分支逐字符未动**。
      `formula.js formatFloatToHex(value, byteLen = 4)` 补宽度参数（**全仓零调用方**；
      它是裸位型转换，与编码器「先解析后归 0」口径不同，差异写进 docstring）。
    - **提醒收窄**：`FLOAT64_UNSUPPORTED`（`byte_len === 8` 报）→
      **`FLOAT_IEEE_WIDTH_UNSUPPORTED`**（`byte_len ∉ {4, 8}` 才报）。全仓该 code 只在
      `validateInstruction.js` 与其测试两处（**无 UI 按 code 分派**）→ 改名无副作用。
    - **章随位宽走**：`runnerRenderRules.resolveRunnerKind` 的 `FLOAT_IEEE` →
      `byte_len === 8` 出 **F64** 章、否则 F32（之前 `key` 恒为 F32，会「章写 F32、
      出帧 8 字节」错位）。
    - **`vectors/float_ieee.json` 分组 `{ "f32": [...], "f64": [...] }`（不拆文件）**：
      `bcd_scaled.json` / `time_counter.json` / `presence.json` 已是「同语义多表」的
      分组先例；f32/f64 是**同一解析口径的两种位宽**，放同一文件一眼看出「只差位宽」。
      `f32` **22 行一字节未改**（缺省不变的物证），`f64` 新增 **23 行**。关键锚点 =
      `1e40`：f32 出 `7F800000`（IEEE 溢出）/ f64 出 `483D6329F1C35CA5`。
    - **更正 §8.37 R5 原行「`response_match` 解码侧同步（否则能发不能判）」—— 实测不
      成立**：`backend/core/response_match.py` 全文**零值解码**（547 行只有
      `prefix/suffix/echo_header_bytes/length/checksum/unpack` 六类**字节级**比对，
      两侧都是 `bytes`；全仓 grep `struct.unpack`、`'>f'`、`'>d'` 零命中）→ 判定天然与
      位宽无关，**`response_match` 零改动**；真缺口在**编译侧 `datahub.to_block`**，
      本批一并修。
    - **测试 +4 BE / +30 FE** → **BE 648/648 · FE 1020/1020（67 文件）**：
      BE `test_encode_float_ieee.py` 6 → 10 例（`VECTORS64`、
      `test_default_arg_stays_f32` 单参回归、`test_byte_len_8_emits_float64`、
      `test_f32_f64_dividing_line`、f64 LITTLE / 矛盾 type）；FE
      `InstructionEncoder.test.js` 187 例（+23 f64 向量 + 5 锚点）、
      `validateInstruction.test.js` +1（G7 收窄成三条）、`runnerRenderRules.test.js`
      +1（F64 章）。
    - **缺省逐字节不变的证据链**：`f32` 22 行两端原样全绿 + `encode_float_ieee`
      单参调用回归 + `test_default_arg_stays_f32` 显式断言 `f(v) == f(v, 4) == 期望`
      + 改前 BE 644 / FE 990 全量零改动全绿。
    - **验收**：`npm run lint` **EXIT=0**、**BE 648/648**、**FE 1020/1020（67 文件）**、
      `npx vite build` EXIT=0、yorha-ui 校验器 **0 违规**（7 个改动 .js）；零 DDL；
      `pageStatus.json` 未改 → 无需重生成 `PAGE_STATUS.md`。
    - **文档同步（同批）**：PLAN 新 **§8.42** + §8.37 R5 行已办（含 `response_match`
      更正）+ §1 状态 + §8.16 N1 后记与引子 + E1-4 进度块 + B2 缺口第 4 条 +
      §8.37 验收口径；`vectors/README.md`（16 表 + `[f64]` 组说明）；
      `docs/BUSINESS_SCENARIOS.md`（浮点 64 位 🟡→🟢 / G7 行 / §8.14 注）；
      `test_operator_templates.py` 注释（模板仍默认 32）；本条。
    - **状态**：**R1 ✅ R2 ✅ R3 ✅ R4 ✅ R5 ✅**，余 **R6 软删除（13 表加
      `deleted_at`，DDL）→ R7 导出补域 → R8 导入补端点 → R9 解码展示面板 → R10
      `fields_json` 入库（DDL）**。每批验收项固定为：BE 全量 + FE 全量 +
      `npx vite build` + **`npm run lint` EXIT=0** + yorha-ui 校验器 0 违规。

52. **R6-1 · 软删除 / 回收站 —— DDL + BE（13 表统一 `deleted_at`）—— PLAN §8.43**
    （2026-10-02，**BE + DDL（仅新增列）**，零 FE 改动 —— 未碰 `processor.py` /
    `graph.py` / `Blueprint.jsx`，`/dispatch` 缺省口径逐字节不变）：
    - **它是什么问题**：B2 缺口 6 —— 删除类操作**没有软删除 / 回收站**，误删只能靠
      DataHub 备份回退（引用检查与前端确认虽齐全，但「删了就真没了」）。拍板（§8.36
      「R6 方案」行）= **13 表统一加 `deleted_at`（仅新增列，合 §0）+ 读端点过滤 +
      回收站页，不做 `trash_bin` 新表**。R6 拆两批：**本批 = DDL + BE**，
      R6-2 = FE 回收站 UI。
    - **DDL**：`models.py` 13 张表每张末尾加 `deleted_at String(40) NULL`；迁移走**已有的
      版本化注册表**（不另起 `ensure_*`）`Migration(2, "soft_delete_deleted_at")` ——
      apply 逐表 `PRAGMA` 缺则 `ALTER ADD COLUMN`（新库 `create_all` 已带 → 逐表跳过，
      不撞重复列名）、verify = 13 表每张都有列（缺一回滚、版本不前进）、既有库升级前
      自动整库备份。名单由 `migrate.soft_delete_tables()` 从 `Base.metadata` **派生**
      （SSOT）。`migrations/schema.sql`（NON-AUTHORITATIVE）本就与权威脱钩 → 不同步。
    - **写侧**：新文件 `backend/db/soft_delete.py` = 唯一落点 —— `mark_deleted` /
      `mark_related` / `restore_related` / `purge_related` / `alive` / `trashed`。
      **级联子行与父行共用同一时间戳** = 恢复判据（不加级联标记列；本次之前已独立入站的
      子行戳不同 → 不被父行恢复顺带捞回，也不计入 `deleted_*` 回执）。
    - **端点**：7 类可回收（protocol / instruction / binding / recipe / sequence /
      profile / response_spec）的 `DELETE` 改软删，**回执形状与计数键逐字不变**
      （`deleted_bindings` / `deleted_response_specs` / `orphaned_sequence_steps` /
      `cleared_instructions` / `204`）；读端点一律 `alive()` → **列表不出现、单查 404、
      二次删 404，与改前硬删后同口径**。新增 `routers/trash.py`：`GET /trash`
      （最近删的在前）、`POST /trash/{kind}/{id}/restore`、`DELETE /trash/{kind}/{id}`
      （彻底删除）；`kind` 走**白名单**；列表**隐藏被父行连带入站的子行**（宿主回来会一起
      恢复，不单独占一行）。`datahub` 的导出 / 状态计数 / 导入宿主校验三处读侧同样过滤。
      `dispatch_logs`（追加型审计）/ `operator_templates` / `transport_settings`
      **只加列不改行为**。
    - **已知取舍**（拍板「不做表重建」的直接后果，**R6-2 要写进 UI 文案**）：
      ① 软删行**继续占唯一键** —— `sequences.name` / `device_profiles.label` /
      `response_specs.instruction_id` 都是 `sqlite_autoindex_*`（删不掉）→ 站内同名
      新建 / 改名 400「已存在」（路由查重**故意不过滤回收站**，宁可落在路由也不要漏到
      DB 变 500），**彻底删除才释放**；② `response_specs` 走 **upsert 复活**（同 id、
      不撞键）；③ 配方 / 档案**指针在删除期解除、恢复不回填** → 恢复后需重新指定默认
      配方 / 重新激活（读侧 `alive()` 兜底：指针指向站内行时按「无配方」降级回空数组，
      前端 `recipes.find(...) || null` 与 `（配方缺失）` 回退路径原样可用）。
    - **测试**：新增 `backend/tests/test_soft_delete.py`（4 类 19 例：迁移 DDL 存量/新库
      两态、三态与级联共戳、唯一键占用 400、upsert 复活、指针口径、白名单恰 7 类）+
      `test_datahub.py` **+2**（导出不含回收站行 / 回灌把站内宿主当不存在）；改写 6 个
      既有删除与迁移测试。**BE 648 → 668**。
    - **文档同步（同批）**：PLAN 新 **§8.43** + §8.37 R6 行（R6-1 已办 / R6-2 待办）+
      §1 状态 + §8.34 B2 缺口第 6 条（后端半收口）；本条。
    - **状态**：**R1 ✅ R2 ✅ R3 ✅ R4 ✅ R5 ✅ R6-1 ✅**，余 **R6-2 FE 回收站 UI（含各
      删除确认弹窗文案「不可撤销」改「移入回收站，可恢复」）→ R7 导出补域 → R8 导入
      补端点 → R9 解码展示面板 → R10 `fields_json` 入库（DDL）**。每批验收项固定为：
      BE 全量 + FE 全量 + `npx vite build` + **`npm run lint` EXIT=0** + yorha-ui
      校验器 0 违规。

53. **R6-2 · 软删除 / 回收站 —— FE（回收站页 + 删除文案口径）—— PLAN §8.44**
    （2026-10-02，**零 DDL、零后端改动**，纯 FE —— 未碰 `processor.py` /
    `graph.py` / `Blueprint.jsx`，`/dispatch` 缺省口径逐字节不变）：
    - **它是什么问题**：R6 的 FE 半 —— 拍板 §8.36「R6 方案」里的「**回收站页**」与
      §8.43 结尾留的「待办 R6-2」。R6-1 已把删除改成软删，但**前端仍吓唬用户**
      （「永久删除 / 不可撤销 / 须重新新建」），且删掉的东西**没有找回入口**。
      两批合计 = R6 ✅（13 列 + 读侧过滤 + 回收站页），**DDL 只有 13 列、未加表**。
    - **新增回收站页 `/trash`（第 8 页，快捷键 `G`）**：新文件
      `frontend/src/pages/Trash.jsx`，骨架照 `DataHub.jsx`。三段 = **口径面板常驻**
      （唯一键仍占用、配方/档案指针恢复后需重新指定与激活、日志不进站 —— **宁可写
      「恢复后要重做一步」，也不许暗示恢复即完全回到删除前**）+ **条目列表**
      （`GET /trash`，7 类中文映射 / 名称 / **秒级 `UTC` 删除时间**、最近删的在前，
      空态与错态各有版式）+ **刷新**。每行 `恢复 RESTORE` **直调**（可逆，不弹）、
      `彻底删除 PURGE` **必过 `NieRModal`**（写明不可恢复 + 提示改点「恢复」）。
      忙态按行（`restore:<id>` / `purge:<id>`），成功回拉、失败不回拉。
    - **接线三处**：`App.jsx` `case 'trash'`；`pageStatus.json` 追加第 8 页（A/B/C/D/E/
      F/R 已占 → 取 **G**）；`npm run sync:page-status` **重生成 `docs/PAGE_STATUS.md`**
      （§8.31）。同批改准该 JSON 里两处过期删除口径（协议「级联删」、指令「随删清理」）。
    - **API 层**：新文件 `frontend/src/api/trash.js` 三端点进 barrel —— `listTrash()` /
      `restoreTrashItem(kind, id)` / `purgeTrashItem(kind, id)`，`kind`、`id` 走
      `encodeURIComponent`。**FE 不兜白名单第二层**：白名单外 404
      `Unknown trash kind:` 与活行 400 `该条目不在回收站` 一律让后端 detail 原样透出
      （避免两处口径分叉）。
    - **五处删除确认与回执文案改口径（本批真正目的）**：指令
      `describeReferences` / `describeDeletion`、协议弹窗与状态条、序列、配方、档案 ——
      由「永久删除 / 不可撤销 / 须重新新建」改为「移入回收站、可在『回收站』页恢复」，
      并补上指针不回填的后果；**不可逆警告只保留在 `PURGE` 确认里**。
      **各弹窗首句前缀一律不改** → `Terminal` / `Sequences` / `Protocol` 既有断言
      **零改动即通过**，`useInstructionData.test.js` 因该模块自带「改文案必改测试」
      约定而改 **7 处**断言。
    - **同批收口**：`App.jsx` 存量 **5 处** yorha-ui 违规清零（`backdrop-blur-md` /
      `backdrop-blur-sm` 去模糊改实底、品牌区 `p-6`、导航 `py-6`、顶栏 `px-6` 收紧为
      `p-4`）—— **改动前用 `git stash` 证明这 5 处在 HEAD 上同样存在**（本批新增
      违规 = 0）；先例 = 第 4 批 `NieRDatePicker` 注释「清既有校验器违规」。
    - **测试**：新增 `api/__tests__/trash.test.js`（5 例：三端点 URL/method 逐字对齐 +
      404/400 detail 原样透出）+ `pages/__tests__/Trash.test.jsx`（8 例：列条目 /
      中文映射 / 空态 / 错态重试 / 恢复 / 恢复失败不重拉 / **取消不调·确认才 DELETE** /
      口径面板）→ **FE 1020 → 1033（+13，69 文件）**；BE **668/668**（零改动）。
    - **文档同步（同批）**：PLAN 新 **§8.44** + §8.37 R6 行（两批均标已办）+ §1 `R1–R10`
      状态 + §8.34 B2 缺口第 6 条（**全量收口**）+ `docs/PAGE_STATUS.md`（重生成）；
      本条。
    - **状态**：**R1 ✅ R2 ✅ R3 ✅ R4 ✅ R5 ✅ R6 ✅**，余 **R7 导出补域 → R8 导入补
      端点 → R9 解码展示面板 → R10 `fields_json` 入库（DDL）**。每批验收项固定为：
      BE 全量 + FE 全量 + `npx vite build` + **`npm run lint` EXIT=0** + yorha-ui
      校验器改动文件 0 违规。

54. **R7 · 导出补域 —— `bundle` 3 域 → 8 域 + `manifest.domainVersion` —— PLAN §8.45**
    （2026-10-02，**零 DDL** —— `models.py` 一个字符未改；未碰 `processor.py` /
    `graph.py` / `Blueprint.jsx`，`/dispatch` 缺省口径逐字节不变）：
    - **它是什么问题**：C-3 拍板选 C（§8.36）。换机 / 跨项目时「哪一份东西算项目」
      此前只剩两条路 —— 整库 `backup/restore`（能搬但**不可读、不可 diff、会覆盖新机
      已有数据**）与在源机**逐条手工重建**。根因是 `GET /datahub/export/bundle` 只有
      3 域（`instructions.json` + `relations.json` + `frames/*`）：配方、序列、传输配置、
      设备档案、算子模板**一个都不进包**，源机上做好的 3 个配方 + 5 条序列搬不到新电脑。
    - **它现在怎么解决**：按拍板「原 3 域 → 8 域」扩该端点，新增 5 个域文件 ——
      `recipes.json`（`stages` 原样）、`sequences.json`（**内嵌 `sequence_steps`**，
      步骤不单独成域、子行不再重复 `sequence_id`）、`transport.json`（单行 `current`
      仍用数组统一形状）、`profiles.json`、`templates.json`。**8 个域查询一律 `alive()`**
      （回收站行不进包；序列步骤靠 `sequence_id IN (导出序列)` 天然跟随宿主）；**列子集
      不含 `deleted_at`** → 日后回灌得到的恒是活行；行序显式排序（序列 `(name,id)`、
      步骤 `(step_order,id)`、档案 `(label,id)`、算子 `op_code`、配方与绑定 `id`）→
      导出可 diff。`manifest` 加 **`domainVersion`**（8 域清单，键序 = 导出序，值 = 该域
      `schemaVersion`）与 **`domainCounts`**（逐域行数，**键集与 `domainVersion` 严格相等**，
      收在纯函数 `bundle_manifest()` 里），存量三键 `instructionCount` / `relations` /
      `frames` **只做加法**。**本批只做出线** —— 零新端点、`POST /datahub/import/relations`
      一字未动，按域导入 = R8（快照复用 R1 的 `safety_snapshot()`）。
    - **两条关键取舍**：
      ① **同批修回一处 R6-1 丢失的过滤** —— `export_bundle` 里**指令 / 绑定 / 应答规格**
      三个查询原本没有 `alive()`，而模块 docstring 已声明「聚合导出一律 `alive()` 过滤」，
      即上批那次编辑**报成功但没落盘**、且当时没有测试盯这条；本批改这个函数时一并补回，
      端到端测试把**六处回收站排除**（指令 / 绑定 / 应答规格 / 配方 / 序列 / 档案）逐条钉死。
      ② **协议不在 8 域内**（严格照拍板的 5 个域实施，不多不少）—— `bundle` 里只有绑定与
      配方对协议的**引用 id**，没有协议本体；因此换机须**先经协议页导入协议**，配方与绑定
      才认得出宿主。是否加第 9 域留 R8 决策。
    - **测试**：`test_datahub.py` 新增 3 类 **8 例**（5 新域载荷形 + `deleted_at` 不出线 /
      序列内嵌与丢弃外来步骤 / manifest 8 域清单与存量三键 / 域清单漂移守卫 / 临时库端到端
      ZIP）。**BE 668 → 676**、**FE 1033/1033（69 文件）**、`npx vite build` EXIT=0、
      `npm run lint` **EXIT=0**、yorha-ui 校验器改动文件 **0 违规**；FE 本批仅改**文案与
      注释**（导出回显列 8 个域文件名、面板段落补 5 域与 `domainVersion` 说明、
      `pageStatus.json` 数据中心页口径）→ `docs/PAGE_STATUS.md` 已重生成；
      `vectors/` 未动；`frontend/red-report.json` 不入库。
    - **文档同步**：PLAN 新 **§8.45** + §8.37 **R7 行标已办** + §8.36 **C-3 行状态** +
      §1 `R1–R10` 状态 + `docs/PAGE_STATUS.md`（重生成）；本条。
    - **状态**：**R1 ✅ R2 ✅ R3 ✅ R4 ✅ R5 ✅ R6 ✅ R7 ✅**，余 **R8 导入补
      端点 → R9 解码展示面板 → R10 `fields_json` 入库（DDL）**。每批验收项固定为：
      BE 全量 + FE 全量 + `npx vite build` + **`npm run lint` EXIT=0** + yorha-ui
      校验器改动文件 0 违规。

55. **R8 · 按域导入 —— R7 出线的 5 个新域补回灌（C-3 收口）—— PLAN §8.46**
    （2026-10-02，**零 DDL** —— `models.py` 一个字符未改；未碰 `processor.py` /
    `graph.py` / `Blueprint.jsx`，`/dispatch` 缺省口径逐字节不变）：
    - **它是什么问题**：R7 §8.45 只做出了线 —— 5 个新域进了 ZIP，但**没有任何端点能
      把它们送回库里**。整机迁移最后一步卡死：解压出来 5 个 .json，只能手敲回界面。
    - **它现在怎么解决**：`POST /datahub/import/` 下补 5 条路径（`recipes` /
      `sequences` / `transport` / `profiles` / `templates`），与既有
      `/import/relations` 完全同形；回执统一 `{domain, imported, updated, skipped,
      warnings, preImportSnapshot}`（sequences 另带 `steps.written`）。三段式收在
      `run_domain_import()`：① **纯函数顶层校验**（非对象 / 未知顶层键 /
      schemaVersion 不符 / 缺数组 → 400 **不落快照**）→ ② `pre-import` 快照
      （复用 R1 的 `safety_snapshot()`，失败 500 中止且库未被改）→ ③ **逐行独立
      提交**（`IntegrityError` 只回滚该行 → `skipped` 带 index + id + reason，
      **部分成功即部分落库**、不整批回滚）。
    - **校验不写第二套**（本批最关键的一条取舍）：
      ① 配方 = `routers/recipe.resolve_stages`（层上限 / 插槽归属，且
      **`definition_hash` 不采信载荷**、按**目标机**的协议 children 重算 —— 配方搬到
      新机器当场就知道与源机是否同构）；
      ② 序列 = `routers/sequence` **新抽的共用入口 `normalize_sequence`**（串
      `_checked_name` → `_normalize_config` → `_normalize_steps`），`create_sequence`
      / `update_sequence` 改调它、**行为逐字不变**；`_write_steps` 同步改公开为
      `write_steps`。后果 = 导入的序列等于用序列页 PUT 一遍：`plan` 重归一、`wrap`
      按目标机配方重新冻结并重算指纹；
      ③ 传输 / 档案 = `core.transport.validate_config`（`ValueError` → 单行跳过）；
      ④ 算子模板 = 形态校验 + 按 `op_code`（即主键）天然 upsert。
      `datahub` 只负责「逐行 upsert + 逐行报告 + 快照」，不复制各域的校验口径。
    - **回收站边界（R6 §8.43 的回灌侧）**，两种要分开：
      **宿主在站里 → 单行跳过**（配方的协议、序列的指令；序列是**整条跳过**，与 R7
      「宿主-从属同进同出」同一条纪律）；**自己的 id 在站里 → 跳过并提示「先恢复或
      彻底删除」**（软删行继续占唯一键，直接 upsert 会写出一条**看不见的行**）。
      `label` / `name` 撞车（包括被回收站行占着的名字）→ 跳过并指出占用行；
      传输配置的 `active_profile_id` 是逻辑指针 → 目标机没有那个活档案就**置空并记
      警告**，不带悬空指针进来。
    - **FE**：DataHub 页新增「按域导入 (DOMAIN IMPORT)」面板 —— 一个选择器吃 5 个域
      文件，按**顶层数组键**自动识别域名（`recipes` / `sequences` / `settings` →
      `transport` / `profiles` / `templates`，键名与 path 一一对应）→ 二次确认 →
      回显 `新增 / 更新 / 跳过 / 警告（+ 写入步数）` → 刷新。识别不出域、非法 JSON、
      不是对象**一律不出弹窗**，直接 `sysMsg` 报错（同 4a 关系导入）。`api.importDomain`
      **不兜白名单第二层** —— 写错的路径让后端 404 detail 原样透出。
    - **测试**：`test_datahub.py` 新增 3 类 **9 例**（`TestDomainPayloadValidation`
      2 例顶层校验、`TestImportDomains` 5 例逐域回灌、`TestDomainImportEndpoints`
      2 例快照次序 —— 顶层 400 时 `safety_snapshot` **一次都没被调**、成功路径回执带
      `preImportSnapshot`）；`DataHub.test.jsx` 12 → **15（+3）**。
      **BE 676 → 685/685**、**FE 1033 → 1036/1036（69 文件）**、
      `npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器改动文件
      **0 违规**；`pageStatus.json` 数据中心页补「按域导入」口径 → `PAGE_STATUS.md`
      已重生成；`vectors/` 未动；`frontend/red-report.json` 不入库。
    - **回灌路径全景（C-3 至此收口）**：`instructions.json` → 指令页 IMPORT（既有）；
      `relations.json` → `/import/relations`（既有）；5 个新域 → **本批 5 条端点**；
      `frames/*` → 派生物不回灌（按指令重编译）；协议本体 → **不在 8 域内**
      （§8.45 五的已知观察），走「协议页导出 JSON + 协议页 IMPORT」既有路径。
      **换机顺序 = 协议 → relations / recipes → sequences**，否则前两者会因宿主缺失
      整批 skipped。C-3 拍板的「8 域」**未扩为 9** —— 日后要一条命令搬干净，需另拍
      「协议是否入包」。
    - **文档同步**：PLAN 新 **§8.46** + §8.37 **R8 行标已办** + §8.36 **C-3 行状态**
      （三项到此全收口）+ §1 `R1–R10` 状态 + `docs/PAGE_STATUS.md`（重生成）；本条。
    - **状态**：**R1 ✅ R2 ✅ R3 ✅ R4 ✅ R5 ✅ R6 ✅ R7 ✅ R8 ✅**，余 **R9 解码展示
      面板 → R10 `fields_json` 入库（DDL）**。每批验收项固定为：
      BE 全量 + FE 全量 + `npx vite build` + **`npm run lint` EXIT=0** + yorha-ui
      校验器改动文件 0 违规。

56. **R9 · 解码展示面板 —— 命中应答逆向还原成「字段 = 值」（C-2 选 C 前半）—— PLAN §8.47**
    （2026-10-03，**纯 FE · 零 DDL** —— `models.py` 一个字符未改；未碰 `processor.py` /
    `graph.py` / `Blueprint.jsx`，`/dispatch` 缺省口径逐字节不变，`vectors/` 未动）：
    - **它是什么问题**：编码一直是单向的 —— 全仓 `decodeFields` / `decodeResponse` /
      `parseResponse` **0 命中**，`response_match` 只输出 pass/fail + reasons（字节
      差异），**从不回填字段值**。`vectors/float_ieee.json` 里 `3.14 → 4048F5C3` 有一
      整组编码向量，反方向 `4048F5C3 → 3.14` 却没有任何实现。于是发「读电压」收到
      应答，页面只给 MATCH OK + raw hex，人要自己对照协议心算 —— 排「发对了但值不对」
      时每条都要手工换算。
    - **它现在怎么解决**：新 `utils/InstructionDecoder.js`。
      **布局与编码器共用一份** —— 把 `encodeInstruction` 里的树布局（扁平字段 →
      `roots` + 逐节点 `childrenOf`）抽成公开的 `InstructionEncoder.buildLayout()`，
      编码与解码同调一处（**改一必改二**）；`emitNode` 的组 `align` / `pad_to` /
      `repeat` / `presence` 判定逐字镜像进解码游标；**叶字节长度不自己算**，向
      `getFieldBytes(field, …).length` 要（唯一真相源），值再从响应帧里**读** ⇒
      布局是**结构对偶**，不是第二套实现。搬移当时 `src/utils` **607 例全绿**。
      **值分派与 `_encodeFieldBytes` 同序**：静态 hex（`FIXED` / `HEADER` / `TAIL` /
      `HEX_RAW` / 协议叶 `hex_value`）→ 文本（ascii 逐字节、utf8 走 `TextDecoder`）→
      旧 `float` / `decimal` → 纯 hex → BITFIELD 聚合整数 → `INT_SIGNED` 两补码（宽帧
      BigInt 防精度丢失）→ BCD packed 十进制 → `FLOAT_IEEE` 大端（f32/f64 按
      `byte_len` 分水岭）→ 缺省无符号 + `SCALED_DECIMAL` **反定标** `raw/factor −
      offset`；**LITTLE 先整体还原**（对偶 `getFieldBytes` wrapper，组容器不逆序）。
      返回 `{fields, consumed, total, residual, warnings}` —— 短帧逐字段标
      `truncated`、尾部残字节计入 `residual` 并告警，**不静默给错值**。
      `presence` / `repeat` 走同一份值链：给了 `inputs` / `computedValues` / `now`
      就与编码期逐字一致；不给（真机应答手上没有表单输入）走静态链 +
      `_presenceHit` fail-open → 缺省照读、不吞字节。
    - **反向验证 = `encode ∘ decode = id` 不动点**（拍板原话「拿 `vectors/*.json`
      反向验证」）：取共享向量表的已知帧 → 解成值 → 用**同一个编码器**把这个值编回
      同一帧 → 必须逐字节相同。它比「解出的值 = 向量里的原始输入」更强也更诚实：
      编码本身有归一（bool → 1、非法字符串 → 0、NaN → 0、定长补齐、LITTLE 逆序），
      不动点不要求解码器猜回**编码前**的原始输入，只要求它把**帧里真实存的信息**还原
      到能被原样复现。覆盖 `float_ieee` f32/f64、`int_signed`、`bcd_scaled`（bcd +
      scaled 反定标）、`string`（含 `pad_char` 补齐的 NUL）、`little_endian`、
      `bitfield.pack`、`time_counter`（time 以解出的秒数反推墙钟编回原帧、auto 以
      状态回推合法前态），外加一例整帧（组 `align` + `repeat ×3` + `presence` +
      LITTLE 混排，解出来的值原样重编 = 命中应答逐字节相同）。
    - **两处接入**：① **指令加工 · 事务面板** —— `TXN_OK` 后取最后一次成功 attempt
      的 `received` 按指令字段布局解码 → 新组件 `DecodedFields` 出 `字段 = 值`（带
      字段数 / 字节数统计头）；② **通讯调试 · 发送历史** ——
      `historyRows(records, { instructionsByName })` 多出的第二个参数（**缺省时行形状
      逐字不变**）把**响应帧**解成 `字段 = 值`：表格新增「字段 FIELDS」列（单行预览 +
      `title` 看全量），详情「响应与错误日志」面板出完整字段表（名称 · 值 · 字节区间 ·
      警告）。`Terminal` 挂载时拉一次 `api.getInstructions()` 建 name → instruction
      映射；**解响应而非发送帧**（值在应答里），raw hex 列仍显示发送帧。
    - **边界与降级（都登记，不藏）**：**无字段布局 → 不解码** —— 指令没有 `fields` 时
      不出面板、也**不出**「尾部残字节」警告，那是空布局的假警报而不是应答的问题
      （本批实测踩过一次：三字节应答 + 空布局 → 出了一条假 `residual` 警告）；
      **解不出就不出** —— 无指令名 / 指令已删 / 无响应 / 映射里没有这条 → 视图模型
      **不加键**（历史列显示 `—`），不加假数据、不报错。三条**已知不可逆**（各有断言
      锚定，不是 bug）：① **f32 溢出位型**（`1e300 → 7F800000` 即 +Inf）解得出
      `Infinity` 却编不回去 —— 编码器把非有限输入归 0 是既有 byte-equal 契约
      （`orchestrator._float_number` 同口径，f64 也绝不写出 Inf 位型）；② **utf8 定长
      截断**（`'中'@2B` 只留半个码点 `E4B8`）解出 `U+FFFD` 再编码成 `EFBFBD`（ascii
      截断反而可逆：`'中' &0xFF → 2D` 解回 `'-'` 再编仍是 `2D`）；③ **`AUTO_COUNTER`
      是状态机**（`(Current+Step)%Max`），解出的是「编码那一刻的计数状态」而非输入
      （`TIME_ACCUMULATOR` 反之可逆）。**展示层收敛 ≠ 值**：`formatFieldValue` 对非整数
      按 7 位有效数字收敛（`3.1399998664855957` → `3.14`，拍板举例就是
      `voltage = 3.14 V`）并剥掉定长补齐的 NUL / 尾空格，**解码值本身一个字节不动**
      （round-trip 以原值为准）；整数与 `>1e10` 的值不碰。
    - **测试**：新 `utils/__tests__/InstructionDecoder.test.js` **21 例**（三段：反向
      验证不动点 / 整帧对偶 / 入口口径与异常帧）+ `DecodedFields.test.jsx` **3 例** +
      `TransactionPanel.test.jsx` **+2** + `terminalPanes.test.js` **+4** →
      **FE 1036 → 1066/1066（71 文件）**；BE **685/685**（本批未碰后端，全量复跑）；
      `npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器改动文件
      **0 违规**；`pageStatus.json` 指令加工 + 通讯调试两页补「解码展示」口径 →
      `PAGE_STATUS.md` 已重生成；`vectors/` 未动；`frontend/red-report.json` 不入库。
    - **留到 R10**：`dispatch_logs.fields_json`（**仅新增列**）+ `/dispatch/history`
      回填 `fields` —— 把解码结果入库，历史跨会话可查（C-2 后半，全计划唯一 DDL 批）。
    - **文档同步**：PLAN 新 **§8.47** + §8.37 **R9 行标已办** + §8.36 **C-2 行状态**
      （R9 已办、R10 待办）+ §1 `R1–R10` 状态 + `docs/PAGE_STATUS.md`（重生成）；本条。
    - **状态**：**R1 ✅ R2 ✅ R3 ✅ R4 ✅ R5 ✅ R6 ✅ R7 ✅ R8 ✅ R9 ✅**，余 **R10
      `fields_json` 入库（DDL）**。每批验收项固定为：
      BE 全量 + FE 全量 + `npx vite build` + **`npm run lint` EXIT=0** + yorha-ui
      校验器改动文件 0 违规。

57. **R10 · 入库回写 —— 应答解码随日志落库（C-2 选 C 后半 · 全计划唯一 DDL 批）—— PLAN §8.48**
    （2026-10-03，**BE + FE** —— `models.py` **仅新增** `DispatchLog.fields_json` 一列、
    `db/migrate.py` 追加 migration 0003；未碰 `processor.py` / `graph.py` /
    `Blueprint.jsx`，`/dispatch` 缺省口径逐字节不变，`vectors/` 未动）：
    - **它是什么问题**（R9 留下的后半）：R9 的解码是**瞬时**的 —— 结果只活在渲染那一刻。
      指令后来被删/改，历史里那条应答就再也解不出来（客户端只能查活行）；序列跑在 daemon
      线程，客户端手上根本没有那帧的上下文；`vectors` 能验「编得出」，但**日志本身不留值**，
      事后「按应答值决策 / 追溯对账」无据可查。
    - **它现在怎么解决**（三条取舍，按重要性排）：
      ① **布局不写第二套** —— 解码复用编译侧 SSOT `fields_to_blocks`（presence 门 /
      repeat ×N 展开 / endianness / align / `pad_to` / `byte_length` 全在里面）；并把
      `Orchestrator._flatten_recursive` 外面套一层公开 `flatten()`，编码 `process()` 与
      解码**共用同一份扁平流**（`_PadMark` 容器补位标记 + 叶块），只是编码往 `final_hex`
      追加、解码按游标往 `data` 切片 ⇒ **算法只有一处**。值分派与 FE `decodeFieldBytes`
      **逐条同序**（静态 hex → 文本 → 旧 float/decimal → 纯 hex → BITFIELD → 两补码 →
      BCD → FLOAT_IEEE 大端 → 缺省无符号 + `SCALED_DECIMAL` 反定标，LITTLE 先整体还原），
      **非有限浮点落库前必须折字符串**（`"Infinity"` / `-Infinity` / `NaN` ——
      `json.dumps(float('inf'))` 产出的是非法 JSON，FastAPI 响应层会直接 500）。
      ② **单一接缝** = `db/log_store.record_log` 自动回填 —— 四条写入缝（manual /
      transaction / sequence / replay）全过这里；序列跑在 daemon 线程、回放没有表单输入，
      靠各调用方自己记得算是靠不住的。`fields` 传了就用传的（回执与落库共用**同一次**
      解码）、没传才自己解。`resolve_log_fields` **绝不抛**（解码炸了会把日志本身一起
      rollback 掉 ⇒ 异常消息写进 `warnings` 落库，「解不出来」看得见）；无应答 / 指令不可
      解析 / 无字段布局一律 `NULL`（**空布局不出假 `residual` 警报**，R9 同口径）。指令
      解析 `instruction_id` 优先且**不看软删**（日志行留存的正是那条指令），无 id 才按名
      在未软删行里取首个（与 FE 从 `/instructions` 活行取第一个对齐）。
      ③ **分层** —— 解码在 `core`，编译口径原先躺在 `routers/datahub.py`，而 **core 不能
      反向依赖 routers** ⇒ `_presence_hit` + `fields_to_blocks` **纯搬进**
      `backend/core/field_blocks.py`，`datahub` **原名再导出**（`# noqa: F401`）：测试与
      datahub 内部的 `from backend.routers.datahub import fields_to_blocks` 一行未改，
      搬移当时 BE 685 例全绿。ORM → 解码器输入在 `log_store` 里做**窄映射**（只列参与布局
      的列；`bits` 不需要 —— 位域打包是编码期行为，解码侧只回聚合整数）。
    - **两处回执**：① `/dispatch/history` 的 `DispatchRecord.fields`（manual / transaction /
      replay 各解一次、**同时**喂回执与 `safe_log` ⇒ 与 `fields_json` 是**同一次解码**，
      绝不各算一遍 —— 否则同一事件可能因指令后续被改而显示不同值）；② `/logs` 的
      `DispatchLogOut.fields`（列名 `fields_json` → 对外一律 `fields`，两端同名同形，
      `AliasChoices` 同认 ORM 形与 dict 形）+ JSON 导出带 `fields`，**CSV 列集
      `_CSV_COLUMNS` 逐字不变**（导出即归档，不改既有表头）。**内存 deque 与 DB 表不是
      同一份**，拍板要求两边都回填 —— DB 侧由 `record_log` 自己兜（序列路只走这条）。
    - **FE：优先消费服务端回填** —— `decodeHistoryRow` **先吃 `record.fields`**，拿不到
      （`null` / 空壳 = 0 字段且 0 警告 / 存量行）才回落 R9 客户端解码。它比客户端解码强在
      两处：指令后来被删/改也解得出（值随日志留痕，不依赖当前 `/instructions` 还在不在）；
      序列 daemon 线程那帧客户端当时没有上下文。**存量行行形状与 R9 逐字不变**。
    - **边界与降级（都登记，不藏）**：**存量行不回填** —— migration 0003 只
      `ADD COLUMN`，既有行 `fields_json` 保持 `NULL`、展示层兜底（合 §0「只做加法」）；
      **解不出就 `NULL` 而不是空对象**（客户端据此回落，不把「解过但空」与「没解」混为
      一谈）；**BE 只出骨架帧**（`to_block` 不编 `INPUT` 值）是既有现状、与本批无关 ——
      解码读的本来就是设备回的那几个字节，编译侧只负责给布局与宽度；**告警文案与 FE 逐字
      相同**（非十六进制 / 奇数位 / 比字段布局短 / 尾部多出 N 字节），两端显示同一句话。
    - **DDL（全计划唯一一处）**：`migrate.py` 追加
      `Migration(3, "dispatch_logs_fields_json")` —— apply = 缺则
      `ALTER TABLE dispatch_logs ADD COLUMN fields_json JSON`（新库 `create_all` 已带 →
      只验不改），verify = 补列范围**恰好 `dispatch_logs` 一张**、列缺失即报错（多一张、
      少一张都报错）。存量库升级前照旧整库备份。
    - **测试**：新 `backend/tests/test_field_decode.py` **35 例**（三段：取值层各算子锚 +
      布局区间 + 告警与诚实回报；回写侧 `resolve_log_fields` 各条口径 / `record_log`
      自动回填 / 手动路回执与落库同源 / 序列钩子 / 读侧列表与导出）+ `test_migrate.py`
      **+3**（存量库补列且存量行留 `NULL`、新库只验不改、verify 真查列）→
      **BE 685 → 723/723**；`terminalPanes.test.js` **+3** → **FE 1066 → 1069/1069
      （71 文件）**；`npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui
      校验器改动文件 **0 违规**；`pageStatus.json` 通讯调试页补「入库回写优先」口径 →
      `PAGE_STATUS.md` 已重生成；`vectors/` 未动；`frontend/red-report.json` 不入库。
      顺手把 `test_soft_delete` 的 0002 断言改成「从 0001 起的全部待执行迁移、0002 必须
      排第一」—— 新增迁移不再硬编码进断言。
    - **文档同步**：PLAN 新 **§8.48** + §8.37 **R10 行标已办** + §8.36 **C-2 行收口**
      （R9 / R10 两半均完成）+ §1 `R1–R10` **全数完成** + `docs/PAGE_STATUS.md`（重生成）；
      本条。
    - **状态**：**R1 ✅ R2 ✅ R3 ✅ R4 ✅ R5 ✅ R6 ✅ R7 ✅ R8 ✅ R9 ✅ R10 ✅ ——
      §8.37 排期 11 批全数完成**。每批验收项固定为：BE 全量 + FE 全量 + `npx vite build`
      + **`npm run lint` EXIT=0** + yorha-ui 校验器改动文件 0 违规。
58. **R11 · R10 后剩余项盘点与排期（PLAN §8.49 · 文档批 · 零代码）**（2026-10-03）：
    - **它是什么问题**：R10 收口后排期全空，但三处待办总盘（本文件 §5 条目 1–57、
      `pageStatus.json` 八页 `nextSteps`、PLAN §8.34 B/C 组与 §9.7）**从没对过账** ——
      于是出现「文档说没做、代码其实早做了」的过期说法，剩余项也没有分类（哪些能做、
      哪些等真机、哪些得先拍板）。
    - **对账结论**：条目 1–57 **无一开放**；§8.37 R1–R10（11 批）、§8.16 N1–N5 + G5、
      §8.34 A 组与 C 组**全部闭合**。
    - **就地纠正三处过期说法**（`pageStatus.json` = 页面状态唯一事实来源，改完
      `npm run sync:page-status` **重生成 `PAGE_STATUS.md`**）：指令页 `availableNow`
      「B2–B8 已在配置面标注」与 `nextSteps`「把 B2–B8 推进为真实编码语义」（E1 早落地、
      `ENCODER_LIMITS` 已清空）、编排页 `nextSteps`「绑定拖拽交互未做」（R4 已落地）。
    - **两处暂缓项销项注**：PLAN §8.14 头注与 §8.34 B3 补「**解码回程 bytes→fields 已由
      R9 + R10 收口**」—— §8.14 四项暂缓自此只剩三项（CRC 多算法 / 长度域 BE-LE = C-5
      触发式、varint/COBS = 不做）。
    - **剩余项四类分流**：① **仍需真机 1 项**（§9.7 ① 载荷含定界字节的**出线**方向）
      **→ ✅ 已销（2026-10-03，条目 68 / PLAN §8.51，改走公开规范真帧仿真，本类无开放项）**；
      ② **触发式 / 不做**（C-1 不立项、C-5 ①② 触发式 ③ 不做、§8.14 余三项、
      `BUSINESS_SCENARIOS.md` 挂账三项）；③ **需拍板 3 项**（加工页展示+切换传输 ——
      与 **D9-A「传输层唯一归属点」**冲突，只读回显与可切换要分开拍；数据中心「数据包
      示例下载」口径未定；设备档案自定义排序 = 要新增 `sort_order` 列即动 DDL）；
      ④ **可直接推进 → 排期 R12–R18**（序列步骤拖拽排序 / 回收站筛选与批量恢复 /
      串口端口枚举 / 档案重命名 + 状态历史自动轮询 / 报文格式切换 / 按域独立导出包 /
      字段引用测试补强），**全部零 DDL**。
    - **文档同步（同批）**：PLAN 新 **§8.49** + §1 新增 `R11–R18` 行 + §8.14 / §8.34 B3
      销项注 + `pageStatus.json` 三处纠正 → `PAGE_STATUS.md` 重生成；本条。
    - **状态**：**R11 ✅（本文档批，未跑测试 —— 沿 §8.34 / §8.36 / §8.37 文档批先例）**；
      R12–R18 待办，验收口径同 §8.49（BE 全量 + FE 全量 + `npx vite build` +
      **`npm run lint` EXIT=0** + yorha-ui 校验器改动文件 0 违规 + 一批一提交）。
59. **R12 · 序列步骤拖拽排序 —— 拖完只改草稿序，点「保存定义」才 PUT（PLAN §8.49）**
    （2026-10-03，**纯 FE · 零 DDL · 零后端改动** —— `models.py` 未动、未碰 `processor.py` /
    `graph.py` / `Blueprint.jsx`、`/dispatch` 缺省口径逐字节不变）：
    - **它是什么问题**：`pageStatus.json` 序列页 `nextSteps` 挂着「步骤拖拽排序（当前为上移/
      下移按钮位序回写）」—— 编排页 R4 已经把拖拽做了，序列页还只能点箭头；步骤一多，
      连点十几次 ↑ 才能把最后一步挪到最前。
    - **口径 = 镜像 R4 的拍板**：**拖完只改草稿数组序，点「保存定义」才 PUT**。后端
      `PUT /sequences/{id}` 本就按数组序重编 `step_order`、整组替换步骤行 → **零 BE 改动**、
      零 DDL；拖拽与上移/下移**共用** `utils/sequenceView.reorder`，两条路径只差「怎么给位次」。
    - **实现**：新模块级 `StepRow` 组件（**钩子不进 `.map()`**，同 R4 `BindingRow` 先例）+
      `stepKey(step, i) = s.id || 'draft-${i}'`（新增步尚无服务端 id，与 React key 同源；拖拽
      期间序未变故稳定）；把手 = 行首**空白 grip** —— 无文本节点（不动「编辑该步骤」按钮里的
      label 文本）、**不是 button**（行内三个 button 顺序照旧）、只挂 dnd-kit `listeners` 不挂
      `attributes`（不给行加 `role=button`）；`DndContext` 只包步骤列表，`PointerSensor`
      **8px 起拖**（点一下选步骤不会误判成拖）。
    - **编辑器跟随**：`handleDragEnd` 在 `reorder` 后按**区间平移**修正 `editorIndex`
      （`from` 段外的元素随「抽出再插回」左/右移一格，跨度可大于 1）—— 否则拖完编辑器会
      静默改到**别的步骤**头上；运行期 `running` 直接忽略拖拽（与上移/下移同一禁用口径）。
    - **测试**：`Sequences.test.jsx` **+3**（与 R4 同款 mock：把 `DndContext` 的 `onDragEnd`
      透到 DOM，测我们自己的换序/跟随/禁用口径而非 dnd-kit）—— ① 草稿序翻转而
      `updateSequence` **零调用**，点保存才按新序 PUT 且 `id`/`step_order` 照旧剥离、延时随行
      保留（自己拖自己 = 无位移）；② 编辑器开着第二步、第一步拖到其位置 → 第二步落到 index 0
      且编辑器跟着显 `STEP 01`、标签输入仍是「第二步」；③ 运行中拖拽忽略。
    - **验收**：**FE 1069 → 1072/1072（71 文件）**、**BE 723/723**（全量复跑，零改动）、
      `npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 3 文件 **0 违规**；
      `pageStatus.json` 序列页 `availableNow` 补拖拽口径 + `nextSteps` 置「无」→
      `PAGE_STATUS.md` 已重生成；`vectors/` 未动、`frontend/red-report.json` 不入库。
    - **文档同步（同批）**：PLAN §8.49 **R12 行标已办 + R12 终态** + §1 `R11–R18` 行回填 +
      `docs/PAGE_STATUS.md`（重生成）；本条。
    - **状态**：**R11 ✅ R12 ✅**，余 **R13 回收站筛选与批量恢复 → R14 串口枚举 → R15 档案
      重命名 + 轮询 → R16 报文格式切换 → R17 按域独立导出 → R18 字段引用测试**。
60. **R13 · 回收站类型筛选 + 批量恢复 / 批量彻底删除（PLAN §8.49）**（2026-10-03，**纯 FE ·
    零 DDL · 零后端改动**）：
    - **它是什么问题**：`pageStatus.json` 回收站页 `nextSteps` 挂着「按类型分组筛选与批量
      恢复（当前为单条操作 + 整列平铺）」—— 站内攒下几十条删除时，只能逐条点「恢复」，
      也没法只看某一类。
    - **类型筛选**：chips = `全部 N` + 出现过的 kind（`KIND_ORDER` 固定次序，不按频次抖动），
      计数从 `items` 派生、不另打接口；**只切可见行、不重排**（行序仍由后端「最近删的在前」
      定）；当前筛选无条目时给「该类型下没有条目 + 清除筛选」，**不冒充「回收站为空」**。
    - **批量选择**：行首复选框（`aria-label` = `选择 <类型>「<名称>」`）+ 表头全选**当前筛选**
      可见行；键 = `kind:id`（跨类型不撞）；已选但被筛掉的行**保留勾选**（批量作用于已选全集）；
      动作条给「已选 N 条 / 批量恢复 / 批量彻底删除 / 清除选择」，无选中即禁用。
    - **批量执行口径**：后端本就是单条接口（**无批量端点**）→ **逐条串行、逐条回报**，不做整批
      事务：半成如实报「成功 N / M + 失败明细逐条列出」，**不静默吞错、不整批回滚**；跑完清空
      选择、`refresh` 按现存条目**剪枝**（恢复 / 清空后不留幽灵勾）。批量彻底删除**仍过同一个
      `NieRModal`**（不可逆必须确认），文案先摆名单（前 8 条、超出折叠）再讲半成口径。
    - **测试**：`Trash.test.jsx` **+3**（8 → 11）—— chips 计数 + 子集行序不变；批量恢复逐条
      POST（`[['sequence','seq-1'],['response_spec','rs-1']]`）+ 成功 2/2 回执 + 两按钮回禁用；
      批量删除**取消零调用 → 确认才执行**、成功 1/2 与失败明细同屏报出。**既有 8 例零改全绿**
      （单条恢复 / 单条确认 / 空态 / 错态文案逐字未动）。
    - **验收**：**FE 1072 → 1075/1075（71 文件）**、**BE 723/723**（全量复跑，零改动）、
      `npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 2 文件 **0 违规**；
      `pageStatus.json` 回收站页 `availableNow` 补一条 + `nextSteps` 置「无」→ `PAGE_STATUS.md`
      已重生成；`vectors/` 未动、`frontend/red-report.json` 不入库。
    - **文档同步（同批）**：PLAN §8.49 **R13 行标已办 + R13 终态** + §1 `R11–R18` 行回填 +
      `docs/PAGE_STATUS.md`（重生成）；本条。
    - **状态**：**R11 ✅ R12 ✅ R13 ✅ R14 ✅**，余 **R15 档案重命名 + 状态历史自动轮询 →
      R16 报文格式切换 → R17 按域独立导出包 → R18 字段引用测试补强**。
61. **R14 · 串口端口枚举 + 波特率预设（PLAN §8.49）**（2026-10-03，**零 DDL**）：
    - **它是什么问题**：通讯调试页的「串口 PORT」只能手输（不知道本机有哪些 COM 口），
      「波特率 BAUDRATE」只能敲数字（常用档得记）。`pageStatus.json` 通讯调试页
      `nextSteps` 原文挂着「串口端口枚举（列出本机可用 COM 口）与波特率预设表」。
    - **后端 `GET /transport/ports`**（`backend/routers/transport.py`）：**只读、不碰配置**
      —— 非串口模式也照答。pyserial `serial.tools.list_ports.comports()`，按**自然序**排
      （`_port_sort_key`：纯字典序会把 COM10 排到 COM3 前；每段打类型标记 `(0,str)/(1,int)`
      保证任意设备名之间都不拿 int 比 str）。**绝不 500** —— 缺 pyserial 或枚举炸了（权限 /
      驱动）都降级成 `{ports: [], source: "unavailable", error: "<原文>"}`，让配置页照常可用。
    - **前端**（`Terminal.jsx` SERIAL 段）：**端口芯片**（点芯片即填「串口 PORT」，`title`
      出设备描述，选中态 `aria-pressed` 随草稿派生，点芯片**不触发 APPLY**）+「刷新端口」
      重拉（挂载即拉一次）+ **波特率预设档** 1200..115200（点档位填输入框，**输入仍可任意
      键入** —— 预设只是省事、不构成取值白名单，提交口径仍由后端校验说了算）。两者**都只改
      草稿**，仍需点「应用配置」才落库；降级时把 `error` 原文显示在端口行、不出芯片。
      `api/transport.js` 新增 `getTransportPorts`，`api/index.js` barrel 同步导出。
    - **测试**：BE 新 `backend/tests/test_transport_ports.py` **4 例**（形状与自然序 / 空列表是
      正常态不是错误 / 枚举抛异常降级 / pyserial 缺失降级 —— 后两条都断言**绝不抛**且原文
      在 `error` 里）；`Terminal.test.jsx` **+3**（19 → 22）= 挂载即拉 + 芯片填表单 + 刷新重拉
      / 预设档随 APPLY 以**数字**提交 / 降级原文显示且配置区照常可用。
    - **验收**：**BE 723 → 727/727**、**FE 1075 → 1078/1078（71 文件）**、`npx vite build`
      EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 6 文件 **0 违规**；`pageStatus.json`
      通讯调试页 `availableNow` 补 R14 条 + `nextSteps` 删已办的枚举项 → `PAGE_STATUS.md`
      已重生成。
    - **文档同步（同批）**：PLAN §8.49 **R14 行标已办 + R14 终态** + §1 行回填 +
      `docs/PAGE_STATUS.md`（重生成）+ **顺手修 PLAN §8.49 里 R13/R14 终态被写成字面 `\n`
      的两行**（编辑器换行没落成真换行，连带修掉一个失衡的 `**`）；本条。
    - **状态**：**R11 ✅ R12 ✅ R13 ✅ R14 ✅ R15 ✅**，余 **R16 报文格式切换 →
      R17 按域独立导出包 → R18 字段引用测试补强**。
62. **R15 · 档案重命名 + 状态 / 发送历史自动轮询（PLAN §8.49）**（2026-10-03，**纯 FE ·
    零 DDL · 后端一行未动**）：
    - **它是什么问题**：档案建错名只能删了重建（后端 `PUT /profiles/{id}` 其实早就支持只送
      `label` 改名，前端一直没入口）；连接状态与发送历史**只能手动刷新**（`pageStatus.json`
      通讯调试页 `nextSteps` 原文两项）。
    - **重命名**：「重命名 (RENAME)」独立按钮（与「更新 = 写入配置快照」分开，不混语义）
      展开改名行 —— 预填当前名、**名字没改不放行**（后端吃得下同名请求，但那是白跑一趟）、
      确认**只 `PUT {label}`、不带 `config`**（改名不该动快照）。撞名 400 的 detail **原文
      透出**且改名行**留着**让用户改（`_checked_label` **不过滤回收站** —— 软删档案占的名也
      要先恢复或彻底删除才释放），「放弃」零调用。
    - **自动轮询**：连接状态面板加「自动刷新 AUTO · 5s」开关（`aria-pressed`，默认开）——
      状态与发送历史**每 5s 一起拉**，**仅标签页可见时走**（`visibilitychange` 立刻
      `clearInterval`，回前台恢复），关掉开关 effect 重跑即彻底停；手动刷新照旧可用，轮询
      失败各走自己 `refresh*` 的 catch（只写错误条、**不打断下一轮**）。
    - **测试**：`Terminal.test.jsx` **+3**（22 → 25）—— 改名预填 + 禁未改 + 只送 label
      （`config` 必为 undefined）+ 列表刷新 + 回执；撞名 detail 原文显示且行不收起、放弃
      零调用；**假时钟**（`vi.useFakeTimers` + `act` 推进）5s 一跳 → 切后台 20s 不再拉 →
      回前台恢复 → 关开关 30s 彻底不拉。
    - **验收**：**BE 727/727**（零改动全量复跑）、**FE 1078 → 1081/1081（71 文件）**、
      `npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 2 文件 **0 违规**；
      `pageStatus.json` 通讯调试页 `availableNow` 补 R15 条 + `nextSteps` 删已办的重命名与
      轮询两项（**排序**改记为「需 `sort_order` 列 = 动 DDL → §8.49 三 待拍板」）→
      `PAGE_STATUS.md` 已重生成。
    - **文档同步（同批）**：PLAN §8.49 **R15 行标已办 + R15 终态** + §1 行回填 +
      `docs/PAGE_STATUS.md`（重生成）；本条。
    - **状态**：**R11 ✅ R12 ✅ R13 ✅ R14 ✅ R15 ✅ R16 ✅**，余 **R17 按域独立导出包 →
      R18 字段引用测试补强**。
63. **R16 · 报文格式切换 hex / ascii / 二进制位图（PLAN §8.49）**（2026-10-03，**纯 FE ·
    零 DDL · 后端一行未动**）：
    - **它是什么问题**：三面板只有一种摆法（hex），盯定界字节 / 控制符得自己脑补字符，
      看位翻转得一个个数 —— `pageStatus.json` 通讯调试页 `nextSteps` 原文挂着「报文格式
      切换（hex / ascii / 二进制位图）（当前仅 hex）」。
    - **一个开关换三处**：三面板上方一条「显示格式 FORMAT」（HEX / ASCII / BIN，
      `aria-pressed` 标亮）—— 同时换 **发送历史预览列 + 原始报文 + 响应面板**，
      面板标题 hint 也跟着换口径。
    - **三种口径**（纯函数 `frameLines` / `framePreview` 在 `utils/terminalPanes.js`）：
      **hex** = 8 字节/行，与存量 `hexDump` / `hexPreview` **逐字相同**、未知口径也回落 hex
      （切回来零变化）；**ascii** = 每字节 1 字符、8 字节/行（0x20–0x7E 原样，控制符与高位
      显 `.`，非法 token 显 `?` 而不是静默装成 00）；**bin** = 每字节 8 位补零、**4 字节/行**
      （8 字节/行宽到换行失控）。预览超限仍标 `…+N`。
    - **不换字节**：只动展示层 —— 发送 / 入库 / 校验口径一律不碰；`historyRows` 加
      `ctx.frameFormat`（**不传 ctx = 逐字不变**，存量调用与旧断言全绿）。
    - **测试**：`terminalPanes.test.js` **+4**（hex 与 `hexDump`/`hexPreview` 逐字相同 /
      ascii 含 `?` 防御与 8 字节分行 / bin 补零与 `…+N` / `historyRows` 只换预览列且
      time·byteCount·decoded 不动）；`Terminal.test.jsx` **+1**（一次点击换三处 + 切回 hex
      逐字不变 + `aria-pressed` 跟随）。
    - **验收**：**BE 727/727**（零改动全量复跑）、**FE 1081 → 1086/1086（71 文件）**、
      `npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 4 文件 **0 违规**；
      `pageStatus.json` 通讯调试页 `availableNow` 补 R16 条 + `nextSteps` 删已办的格式项
      （该页只剩「档案自定义排序 = 待拍板」）→ `PAGE_STATUS.md` 已重生成。
    - **文档同步（同批）**：PLAN §8.49 **R16 行标已办 + R16 终态** + §1 行回填 +
      `docs/PAGE_STATUS.md`（重生成）；本条。
    - **状态**：**R11 ✅ R12 ✅ R13 ✅ R14 ✅ R15 ✅ R16 ✅ R17 ✅**，余 **R18 字段引用
      测试补强**。
64. **R17 · 按域独立导出包 `GET /datahub/export/bundle?domains=…`（PLAN §8.49）**
    （2026-10-03，**零 DDL**）：
    - **它是什么问题**：导出一次就是全 8 域一个大 ZIP —— 只想把序列或配方下盘到另一台机，
      也得连指令、关系、帧一起搬；`pageStatus.json` 数据中心页 `nextSteps` 原文挂着「补
      数据包示例下载与算子模板/协议的独立导出包」。
    - **后端**（`backend/routers/datahub.py`）：`export_bundle(domains=…)` + 纯函数
      `parse_bundle_domains`（**缺省 None = 不带该参数**；空项 / 未知域名 / 重复三类一律
      400，未知域报错带**可选全集**原文，**不静默忽略**）。`bundle_manifest` 加可选
      `domains` 参数 —— `domainVersion` · `domainCounts` **只列包里真有的域**（键序仍按
      8 域表，不是用户给的顺序）；`instructionCount` · `relations` · `frames` 三个存量子键
      描述的是**这个包**（没选中的在调用侧清成 0 行 / 置空）。`frames` 是八键之一的**独立域**
      （不选就不编译帧），`relations` 可单选但**协议数据仍走协议页既有导出** —— 不借机
      重开「第 9 域」拍板项。**缺省口径逐字节不变**：文件集合、manifest 三键、
      下载文件名 `^yorha-datahub-\d{8}-\d{6}\.zip$` 全部与改前一致；按域包的文件名带域名
      （`yorha-datahub-<域>-<时间戳>.zip`）防几份包在下载目录里打架。
    - **前端**（`DataHub.jsx` 聚合导出区）：「按域导出 DOMAINS」8 域芯片（**顺序 =
      `BUNDLE_DOMAIN_VERSIONS` 键序 = 导出序**，送后端按表排序、不看点击顺序；`aria-pressed`
      标亮）+「导出所选域」—— **全不选即禁用、不发请求**，全量口径只走原「下载 ZIP」按钮。
      `api/datahub.js` 的 `exportDataBundle(domains)`：传数组才拼 `?domains=a,b`
      （逗号分隔 + `encodeURIComponent`），不传 / 空数组**不带该参数**。
    - **测试**：BE 新 `test_datahub_bundle_domains.py` **6 例**（复用 `test_datahub` 的
      `RelationsTestCase` 临时库）—— `parse_bundle_domains` 缺省 / 顺序保留 / 空项·未知·
      重复三类 400；端到端缺省 8 域回归、子集只出所选且 manifest 键序按 8 域表、
      `frames` 与 `instructions` 独立可选（互相不带对方文件）、显式全 8 域 ≡ 缺省
      （只差 `generatedAt` 时间戳）。FE `DataHub.test` **+2**（芯片按表顺序下载 + 取消到空
      回到禁用不发请求 / 全量无参回归）+ 新 `api/__tests__/datahub.test.js` **4 例**
      （不传与空数组都不带 `?domains` / 数组拼串 + `encodeURIComponent` / 400 detail 原样
      透出）。
    - **验收**：**BE 727 → 733/733**、**FE 1086 → 1092/1092（72 文件）**、`npx vite build`
      EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 6 文件 **0 违规**；
      `pageStatus.json` 数据中心页 `availableNow` 补 R17 条 + `nextSteps` 收敛成只剩
      「数据包示例下载口径 = 待拍板」→ `PAGE_STATUS.md` 已重生成。
    - **文档同步（同批）**：PLAN §8.49 **R17 行标已办 + R17 终态** + §1 行回填 +
      `docs/PAGE_STATUS.md`（重生成）；本条。
    - **状态**：**R11 ✅ R12 ✅ R13 ✅ R14 ✅ R15 ✅ R16 ✅ R17 ✅ R18 ✅** —— **§8.49
      R11–R18 八批全部落地**，§5 余项只剩**需用户拍板 3 项**与**需真实设备帧 1 项**
      **→ 两项余账均已清零（2026-10-03）：拍板 3 项 → 条目 66/67 + PLAN §8.50，真机帧 1 项
      → 条目 68 + PLAN §8.51**。
65. **R18 · 指令页字段引用测试补强（PLAN §8.49 · 纯测试零代码）**（2026-10-03）：
    - **它是什么问题**：指令页 `nextSteps` 原文挂「补更细的字段引用测试（块移动与保存失败
      恢复已覆盖）」—— 单条路径各有测试，但 `references` 计数 × 块移动 / 保存失败恢复的
      **交叉面**没人钉；这类「两套机制叠在一起时谁说了算」的回归一坏就是静默坏。
    - **改了什么**：只动 `frontend/src/hooks/__tests__/useInstructionData.test.js`（+6 例，
      **零产品代码改动、零 DDL、未碰后端**）——
      · **组合面 4 例**（新 describe）：① 块移动只动草稿，删前计数照常按 id 拉（计数只认
      后端、不看本地把块挪到第几格），0 分项不列行，确认后连草稿与脏标一起收口、活动指令
      切下一条；② 取消确认零 DELETE，且再点删除**重新拉一次计数**（不跨次缓存）；③ 计数拉到
      但 DELETE 失败 → 状态条报错留台、指令与未保存草稿都还在、脏标不清；④ 块移动 →
      PUT 400 → **顺序与脏态都不回滚**（P4-2 口径）→ 撤销回移动前 → 重试成功清横幅 · 脏标 ·
      撤销栈（保存 = 新基线）。
      · **纯函数分档 2 例**：`describeDeletion` 只报非零那一段（不写「0 条」占位）、
      `describeReferences` 仅日志被引用（最轻一档）时不冒充「无引用」。
    - **夹具口径**：`moveField + updateLocalInstruction` 就是指令页 `onMoveItem` 的原样组合
      （C1-d 抽出的纯函数），两条字段 `f-a` / `f-b` 挪首位即得 `['f-b','f-a']`；
      `HEX_RAW` 叶子字段过 P0-2 校验，故 PUT 失败分支真到得了 `updateInstruction`。
    - **验收**：**BE 733/733**（未碰后端）、**FE 1092 → 1098/1098（72 文件）**、
      `npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 2 文件 **0 违规**；
      `pageStatus.json` 指令页 `availableNow` 补 R18 条 + `nextSteps` 收敛成「无 —— 指令页
      三条待办全部出清」→ `PAGE_STATUS.md` 已重生成。
    - **文档同步（同批）**：PLAN §8.49 **R18 行标已办 + R18 终态 + §1 行**（`🔄` → `✅`
      R11–R18 八批全清）+ `docs/PAGE_STATUS.md`（重生成）；本条。
    - **状态**：**R11 ✅ R12 ✅ R13 ✅ R14 ✅ R15 ✅ R16 ✅ R17 ✅ R18 ✅**（八批全清）。
      **三项拍板 2026-10-03 已答复**（见条目 66 与 PLAN §8.50）：① 加工页传输展示与切换 =
      **维持 D9-A 不立项**、② 数据包示例下载 = **动态导出 → R19**、③ 档案自定义排序 =
      **`sort_order` DDL 解禁 → R20**；余**需真实设备帧 1 项**（§9.7 ① 出线方向）
      **→ ✅ 已销（2026-10-03，条目 68 / PLAN §8.51）**。
66. **R19 · 数据包示例下载（动态导出 · PLAN §8.50 · 用户拍板 ②-2）**（2026-10-03，**零 DDL**）：
    - **拍板回执**：口径取**动态导出** —— 用当前库现做一份，不用仓内静态样例（免维护、
      不会与 schema 漂移）；同批另两项拍板一并落定：① 加工页「展示传输 + 本页切换传输」=
      **维持 D9-A（唯一归属点在通讯调试页），不立项**；③ 设备档案自定义排序 =
      **允许新增 `sort_order` 列（DDL 点头）** → R20。排期与结论见 PLAN **§8.50**。
    - **改了什么**（**纯 FE**，`backend/routers/datahub.py` **一行未动**）：`DataHub.jsx`
      聚合导出区加「下载示例包 (SAMPLE)」按钮 + `SAMPLE_DOMAINS` 常量 —— 取**按域导入的
      5 域**（recipes / sequences / transport / profiles / templates，顺序 =
      `BUNDLE_DOMAIN_VERSIONS` 键序 = 导出序），直接调 R17 出线的 `exportDataBundle(数组)`
      （`?domains=` 子集），**零新端点、零新参数**；下载文件名打 `sample` 标记
      （`yorha-datahub-sample-<时间戳>.zip`），与手工按域导出的包在下载目录里不打架；
      成功文案回显域数、体积与「可直接走按域导入试回灌」。
    - **为什么是这 5 域**：与 `POST /datahub/import/{domain}` 能吃的范围**逐字对齐** ——
      示例包得「下下来就能试回灌」，出 instructions / relations / frames 反而落不进按域
      导入端点（那三个各走本页 / 协议页的既有导入）。
    - **测试**：`DataHub.test` **+1** —— 示例包按 5 域调用且顺序按 8 域表、文件名匹配
      `^yorha-datahub-sample-\d+\.zip$`、成功文案回显、**全量按钮仍是无参调用**不被带偏。
    - **验收**：**BE 733/733**（未碰后端）、**FE 1098 → 1099/1099（72 文件）**、
      `npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 3 文件 **0 违规**；
      `pageStatus.json` 数据中心页 `availableNow` 补 R19 条 + `nextSteps` 收敛成「无 —— 示例
      下载已由 R19 落地，余下仅档案排序 → R20」→ `PAGE_STATUS.md` 已重生成。
    - **文档同步（同批）**：PLAN 新 **§8.50**（三项拍板回执 + R19–R20 排期表 + R19 终态）、
      §8.49 ③ 补拍板回执注、§1 新增 `R19–R20` 行 + `docs/PAGE_STATUS.md`（重生成）；本条。
    - **状态**：**R19 ✅ R20 ✅**（§8.50 两批全清）；余 **§9.7 ① 真机一项**。
67. **R20 · 设备档案自定义排序（PLAN §8.50 ②-3 · 全计划第二批 DDL）**（2026-10-03）：
    - **拍板**：②-3「设备档案自定义排序」= **允许新增 `sort_order` 列**（DDL 明确点头）；
      同批的 ①（加工页展示传输状态 + 本页切换）拍成 **维持 D9-A 不立项** ——
      `processing` 页 `nextSteps` 已换成拍板回执，不再列本页待办。
    - **改了什么（BE + FE）**：
      · `models.py`：`DeviceProfile.sort_order` **仅新增列**（`Integer NOT NULL DEFAULT 0`，
        0 = 未重排）；
      · `migrate.py`：**REGISTRY 4 · 0004** —— `apply` 缺则 `ALTER TABLE … ADD COLUMN
        sort_order INTEGER NOT NULL DEFAULT 0`、`verify` 钉死「恰好 device_profiles 一张」
        （照 `migrations/README`「新增列 = 追加版本化迁移」的口径，**不新开 `ensure_*`**）；
      · `profile.py`：排序键 **`(sort_order, label, id)`**（全 0 = 旧行为 label 升序逐字不变）
        + **`PUT /profiles/order` 整表一次提交** —— 声明在 `PUT /{profile_id}` **之前**
        （单测钉死这个顺序，否则字面 `order` 被参数路由吃掉），`ids` 必须**恰好**覆盖全部活档案，
        重复 / 遗漏 / 未知 / 混入回收站一律 400 且**零写入**；新建档案：未重排给 0 照 label 落位、
        已有自定义序 `max + 1` 追加末尾（不让 0 顶到最前面）；删中间一条**不重排**其余序号；
      · `schemas/profile_api.py`：`ProfileResponse.sort_order` + `ProfileOrderUpdate`；
      · `datahub.py`：`profile_export_row` 随行带 `sort_order`（**行序仍按 label 升序**，
        一次拖拽不掀整个文件、导出可 diff），`import_profiles` 采纳它 —— 缺席（旧包）
        **不覆盖**目标库已有的序、非负整数以外的值**整行跳过**不静默降级成 0；
      · FE：`api.reorderProfiles` + 通讯调试页「排序顺序 (REORDER)」排序区 —— 拖拽（dnd-kit，
        三行手则同 R12：grip 只挂 `listeners` 不挂 `attributes`）+ 上移/下移**都只改草稿序**，
        脏标按 id 序比（顺序没动不放行），点「保存顺序 (SAVE ORDER)」才 PUT（端点回的新顺序
        **直接替换本地状态**，不多拉一次 GET），「放弃」零调用、400 留草稿可改完再存。
    - **测试**：**BE +10**（新 `test_profile_order.py` 6 例 + `test_migrate` 3 例 +
      `test_datahub` 1 例）、**FE +7**（`Terminal.test` 3 例 + 新
      `api/__tests__/profiles.test.js` 4 例）。
    - **验收**：**BE 733 → 743/743**、**FE 1099 → 1106/1106（73 文件）**、
      `npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 6 文件 **0 违规**；
      `pageStatus.json` 通讯调试页 `availableNow` 补 R20 条 + `nextSteps` 收敛成「无 —— R20 落地」、
      加工页 `nextSteps` 换拍板回执 → `PAGE_STATUS.md` 已重生成。
    - **文档同步（同批）**：PLAN §8.50 **R20 行标已办 + R20 终态** + §1 `R19–R20` 行回填 +
      `docs/PAGE_STATUS.md`（重生成）；本条。
    - **db 同步（另开一个 `chore(db)` 提交，不混进本 feat）**：`python -m backend.db.migrate up`
      把真库 **v1 → v4** —— 顺带补齐一直挂着的 0002 软删列 / 0003 `fields_json`（冒烟时发现真库
      在 `schema_migrations` 里只记到 v1，`migrate status` 长期报 pending 两条，本批一并收掉）。
    - **状态**：**R19 ✅ R20 ✅**；~~余 **§9.7 ① 出线方向（需真实设备帧）一项**~~
      **→ 该余项已由条目 68（PLAN §8.51）销项，§5 开放项出清**。

68. **§9.7 ① 出线方向销项 · 联网取公开规范真帧 + 仓内仿真（PLAN §8.51 · 测试批 + 文档批）**
    （2026-10-03，**零产品代码改动、零 DDL、`pageStatus.json` 未动 → `PAGE_STATUS.md` 不重生成**）：
    - **它是什么问题**：D13「边界（转义）」把「链路壳**有 LEN = 不需要转义**」记成**经验判定**，
      并把「载荷出现定界字节时真实设备是否异常」挂进 `DESIGN_CorePipeline.md` §9.7 人工验证
      必查 ①（= `PLAN_Backlog.md` §8.34 B1-2）。这是全仓**唯一挂着「需真实设备帧」的开放项**
      —— 环回下测不出、没硬件就无法判定，长期阻塞。
    - **怎么办（用户指令，2026-10-03）**：「真实设备帧的问题，需要你自己**联网查询设备帧**
      并在项目里**模拟**」→ 沿 **§8.35 同一套方法**（拿公开规范真帧模拟真机；那次销的是
      **应答方向**），本批换到**出线方向**：
      · **A 组 · 三条有长度域的公开规范真帧**（`PublicSpecFrameTest` 5 例）：**IEC 60870-5-104**
        （`68 <len> <4 控制> <ASDU>`、len = 其后全部字节、无尾定界；公开示例帧 20B —— 把对象
        地址第三字节改成 `68` → 帧内**第二个 68H**：按长度域切逐字节还原，按「下一个 68H 当
        帧头」重同步则在对象地址处断错）、**DL/T 645-2007**（`68…68 C L DATA CS 16`，公开收发例
        CS 反算 = `8D` / `DD`；**raw `0x35` / `0xE3` 经 0x33 换算上线即 `68 16`** —— 0x33 并不
        保证线上不出现 68H/16H，真正兜住定界的是 **L 域**）、**Modbus TCP**（MBAP 长度域自 unit
        起计 + 寄存器值 `68 68 7E 7E`，68H 与 **7EH（HDLC 旗标）** 都在载荷里，零转义照常成帧）；
      · **B 组 · 本仓三层壳出线仿真**（`RepoWireFrameTest` 3 例，主向量 = `vectors/wrap.json::three`
        与 `test_wrap_api` / `InstructionProcessor` 同读）：注入含**每层头尾 + 规范定界字节**的
        内核 `A0 B0 C0 E0 E1 E2 68 16 7E 7D FA ED` → ①外壳定界字节**字面在帧里**（转义只发生在
        第 0 层之前）、②自外向内按 LEN 反解 `C0 → B0 → A0` **内核逐字节还原**、③开转义对照 =
        壳内 LEN 按**线上字节**重算（7 而非 5）+ 收侧 `unescape_bytes` 可逆、④escape 关闭出线
        逐字节不变（§0 硬约束）；
      · **C 组 · 反例**（`LenLessFramingTest` 2 例）：**无 LEN** 的纯定界帧 `FA FA…ED` —— 载荷
        含 ED 时「扫第一个 ED 当帧尾」断在载荷里（载荷截断成 `01` + 残帧 `02 ED`），开转义后
        载荷里不再有裸旗标字节、唯一 ED = 真帧尾且可逆；**同一份载荷换成有 LEN 的壳，零转义
        就切得出来** —— 正反两面合起来才是 D13 那半句判据。
    - **结论**：① D13 判定由**经验**升级为「**与公开规范一致**」→ §9.7 ① / §8.34 B1-2 销项；
      ② 残余风险**收窄**成「目标设备是否按其声明的协议实现」= 设备个体问题、非协议问题 →
      转**触发式**（真机若真断帧，对那条链路开 `escape`，N4 能力已具备），不再挂账；
      ③ **「需真实设备帧」这一类自此无开放项**（B1-1 → §8.35、B1-2 → 本条）。
    - **测试**：新 `backend/tests/test_wire_delimiter.py` **10 例**（A 组 5 + B 组 3 + C 组 2）
      —— 直调 `core/escape.py` / `core/frame_builder.py` 纯函数，**无 DB、无 TestClient、
      零产品代码改动**。
    - **验收**：**BE 743 → 753/753**、**FE 1106/1106（73 文件，未碰前端）**、`npx vite build`
      EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 **0 违规（零前端改动 → 无文件可校）**、
      md 表列数校验 `table mismatches = 0`、隐形字符 / CRLF = 0；**零 DDL → 无 `chore(db)` 提交**。
    - **文档同步（同批）**：`DESIGN_Decisions.md` D13 边界残余风险注、`DESIGN_CorePipeline.md`
      §9.7 必查 ① + 复跑第 1 项 + 「剩余真机核对项」行、PLAN **§8.51 新节 + §1 新行** +
      §8.34 B1-2 / §8.35 尾 / C-4 / §8.49 三·① 与 R18 终态 / §8.27 复跑第 1 项销项注、本条
      （含条目 44 / 64 / 65 / 67 四处状态行的销项注）。
    - **状态**：**§9.7 ① ✅ 销项 —— §5「需真实设备帧」开放项出清**；余下皆为触发式 /
      不立项 / 不做（C-1、C-5 ①②③、§8.14 余三项、`BUSINESS_SCENARIOS.md` 挂账三项、
      加工页传输维持 D9-A），**无排期待办**。

69. **七项复议拍板：触发式 / 挂账 / 不做 → 全数立项，排期 R21–R28（PLAN §8.52 · 纯文档批）**
    （2026-10-03，**零代码、零 DDL、`pageStatus.json` 未动 → `PAGE_STATUS.md` 不重生成**）：
    - **起因**：§8.51 销掉「需真实设备帧」后，用户要求把此前「不主动立项」的项**逐项描述
      再决定** —— 描述完当场**七项全勾立项**，原拍板 **C-1 = A 不立项 / C-5 = ①② 触发式
      ③ 不做 / `BUSINESS_SCENARIOS.md` 挂账三项 = 不排期全部推翻**；**加工页「展示传输 +
      本页切换」复议维持 D9-A 不立项**（唯一不动项）。
    - **拍板 → 排期**：C-5 ② 长度域 BE/LE → **R21**（修「出线恒大端 vs 收侧已支持 little」
      的**能判不能发**不对称，最小）、C-5 ① CRC 多算法 → **R22**（BE + FE +
      `response_match` **三处白名单成对改**）、挂账 ① epoch 模板 → **R23**、挂账 ③ 创建后
      切 op → **R24**、挂账 ② 加扰 / 混淆 → **R25**、C-1 B 序列级分支 → **R26**
      （`sequence_steps.condition` **仅新增列** + 受限表达式无 eval；**C 发前路由仍未立项**）、
      C-5 ③ varint / COBS 拆两批 → **R27 出线 / R28 解包**（解包 = 风险最高档，硬前置 R27）。
    - **顺序理由**：先小后大 —— 先补不对称（R21/R22）→ 值表达（R23/R25）→ 交互面（R24）
      → 执行引擎（R26）→ 最后碰解包链（R27/R28）；R26 含 DDL → `yorha.db` **另开
      `chore(db)`**。
    - **文档同步（本批）**：PLAN 新 **§8.52**（拍板结果表 + 排期表 + 硬约束提醒）+ **§1 新行
      R21–R28（🔄 排期已立）** + §8.14 头注 / §8.49 三·② / §8.36 C-1 建议与 C-5 汇总四处
      复议注；`BUSINESS_SCENARIOS.md` 三行状态 `⚪ 挂账` → `⏸ 已立项 R2x` + **挂账清单清零注**。
    - **状态**：**触发式 / 挂账 / 不做清单自此清零**，待办 = **R21 → R28 八批**
      （**R21 → 条目 70、R22 → 条目 71、R23 → 条目 72 均已完成 ✅**）；仍不立项的只剩
      加工页传输（D9-A）。

70. **R21 · 长度域 `byte_order`（big / little）：补「能判不能发」的不对称（PLAN §8.53 · §8.52 排期第 1 批）**
    （2026-10-03，**BE + FE、零 DDL、`models.py` 未动、`/dispatch` 缺省口径逐字节不变**）：
    - **问题**：收侧 `response_match.VALID_BYTE_ORDERS` 本就收 `big` / `little`、事务面板
      回显规则**能配能判**；出线 `backend/handlers/length.py` 却恒 `f"{total:0{n}X}"`
      大端 → 「**能判不能发**」（§8.36 C-5 ②，原触发式项）。
    - **存点 + 六处改点（改一必改二/三）**：length 卡 `parameter_config.byte_order`
      （`blockTypes.js` 新增 `byte_order` 字段，走**既有通用 select 分支** →
      `ProtocolPropertiesPanel.jsx` **零改动**）；① `LengthHandler.byte_order_of` +
      `apply_byte_order`（refs 模式与旧 range 模式**两个 return 同步套用**；little =
      字节对反转；缺省与枚举外回大端；**奇数长度不反转** = 值超 `byte_length` 的畸形
      输出，不发明语义）；② 出口翻译 `frame_builder._with_byte_order` ↔
      `toFrameBlocks.withByteOrder`（**只在 little 写键** → params 形状与存量逐字节一致；
      **refs 缺失的 config 直通路径同样生效**；checksum 块不吃此键）；③
      `response_generate._length_element` 生成的回显规则改从 pc 取 `byte_order`（原硬编码
      `"big"`，否则出线小端、规则按大端比必然失配）；④ `protocolTree.collectDeterministicBytes`
      设计期卡面同口径（**设计期与出线逐字节一致**，大小写不敏感）；⑤ `validateProtocol`
      W5 `BYTE_ORDER_UNKNOWN`（大小写归一后判、空串不报，镜像 W4 `ALGO_UNKNOWN`）。
      仅 length 卡列此字段（拍板范围 = 长度域）；`parameter_config` 是自由 dict → **零 schema 改动**。
    - **顺带修（存量缺陷）**：`collectDeterministicBytes` 把 `formatToHex()` 的**展示串**
      （已带空格，如 `"00 06"`）直接 `.match(/.{1,2}/g)` → 空格被吃进切片 → **≥2 字节真值
      多出一个 0 字节**（`"00 06"` → `[00,0x0,06]`；单字节看不出，2 字节 CRC / 长度必错，
      嵌套校验中间字节同理被污染）；length / checksum 两分支同步 `.replace(/\s/g,'')`
      （**改一必改二**）+ 2 字节 CRC 回归用例。只影响**卡面显示**，出线字节由 BE 决定、不变。
    - **共享向量**：新增 `vectors/length_order.json`（顶层数组 7 行：`byte_order` /
      `byte_length` / `total` / `expected`）**双端同读** —— `backend/tests/test_length_byte_order.py`
      ↔ `frontend/.../protocolTree.test.js`（同 Σ 的容器中央值按行断言）；
      `vectorsLoader.test.js` `TABLES` 登记 + `vectors/README.md` §3（12 文件 16 表 →
      **13 文件 17 表**）与 §7 行注归档。
    - **验收**：**BE 753 → 768/768**（+15）、**FE 1106 → 1117/1117（73 文件）**（+11）、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0、yorha-ui 校验器改动 js/jsx/json
      **0 违规**、md 表列数 mismatches = 0、隐形字符 / CRLF / TAB = 0；**零 DDL → 无 `chore(db)`**。
    - **文档同步（同批）**：PLAN **§8.53 新节** + §1 `R21–R28` 行回填（R21 ✅）+ §8.52 排期表
      R21 行标已办 + §8.36 C-5 汇总与 §8.14 补记两处销项注；`vectors/README.md` §3 + §7；
      `BUSINESS_SCENARIOS.md` C-5 ② 行 `⏸ 已立项` → `✅ 已落地`；`pageStatus.json` 协议页
      `availableNow` / `nextSteps` 回填 + `npm run sync:page-status`；本条。
    - **状态**：**R21 ✅**；余 **R22 → R28 七批**（下一批 **R22 CRC16-CCITT / CRC32 / LRC**）。

71. **R22 · CRC 多算法（CRC16-CCITT / CRC32 / LRC）：六张白名单同批成对改（PLAN §8.54 · §8.52 排期第 2 批）**
    （2026-10-03，**BE + FE、零 DDL、`models.py` 未动、`/dispatch` 缺省口径逐字节不变**）：
    - **问题**：出线 `ChecksumHandler` 与收侧 `response_match.VALID_ALGOS` 只认
      `sum / xor / crc16_modbus`；FE `ChecksumAlgo` 虽已声明 `CRC_32` 却**无实现**
      （`calculateChecksum` 落 `default:` 打 warn、`mapChecksumAlgo` 把它折回
      `CRC_16_MODBUS`）→ §8.36 C-5 ① 触发式项「真机提 CCITT/CRC32 即做」。
    - **六张白名单 + 一处算子模板同批成对改（改一必改七）**：BE
      `response_match.VALID_ALGOS`、`frame_builder.BACKEND_ALGO`；FE
      `formula.js ChecksumAlgo`、`blockTypes.algo.options`、`toFrameBlocks.BACKEND_ALGO`、
      `validateProtocol.VALID_ALGOS`、`sequenceView.PLAN_ALGO`、`TransactionPanel.jsx` 下拉；
      `backend/routers/operator.py` 指令页 `CHECKSUM_CRC` 算子模板 `algo` 六值。值域 =
      `SUM_8 / XOR_8 / CRC_16_MODBUS / CRC_16_CCITT / CRC_32 / LRC` ↔
      `sum / xor / crc16_modbus / crc16_ccitt / crc32 / lrc`。
    - **算法规范双端同源**：CCITT = **CRC-16/CCITT-FALSE**（poly 0x1021 / init 0xFFFF /
      非反射 / xorout 0，check `"123456789"` → `0x29B1`）；CRC32 = **IEEE 反射**
      poly 0xEDB88320 / init = xorout 0xFFFFFFFF（→ `0xCBF43926`）；LRC = `(-sum) & 0xFF`
      （→ `0x23`）。三处实现同位同源：`formula.js calculateChecksum` 三个 `case`、
      `handlers/checksum.py` 两分支三方法、`response_match.checksum_value` 三支三函数。
    - **收侧宽度表 `ALGO_FIELD_WIDTH`**（`sum` / `xor` = `None` 不限、`crc16_modbus` = 2、
      `crc16_ccitt` = 2、`crc32` = 4、`lrc` = 1）：**保留 `crc16_modbus` 遗留「恰好 2 字节」
      精确判定逐字不变**；新算法只加「≥ 宽度」**下限**（缺则 `to_bytes` OverflowError → 500，
      收口 400）；`default_field_bl = ALGO_FIELD_WIDTH.get(algo) or 1`（2 / 4 / 1）；
      `sequence_plan` 判定路径与 `response_generate` 自动回显**共用同一张表**（不足 →
      `raise` / 弃生成 + 警告）；`sequenceView` 计划冻结链加同宽下限分支
      （`PLAN_ALGO_FIELD_WIDTH`，**键 = 后端值域**）；事务面板 `field_byte_length` 三态缺省 4 / 2 / 1。
    - **`mapChecksumAlgo` 保留旧名折叠**：六个**规范值**直通；**裸名 `CRC32` /
      `CRC16_CCITT` / unknown / 空串仍折回 `CRC_16_MODBUS`** → `importExport` 既有归一用例
      与存量草稿的出线字节**不变**。
    - **共享向量**：新增 `vectors/checksum_algo.json`（6 算法 × 5 输入 = **30 行**，
      `algo` / `data` / `width` / `expected`）**双端同读** ——
      `backend/tests/test_checksum_algorithms.py` ↔ `frontend/.../checksumAlgo.test.js`；
      期望值取自**外部真值**（`zlib.crc32`、`binascii.crc_hqx` + 三枚已发布 CRC check 值
      自校验），**非照实现抄表**；`vectorsLoader.test.js` `TABLES` 登记 + `vectors/README.md`
      §3（13 文件 17 表 → **14 文件 18 表**）与 §7 行注归档。
    - **验收**：**BE 768 → 793/793**（+25）、**FE 1117 → 1127/1127（74 文件）**（+10）、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0、yorha-ui 校验器改动 js/jsx/json
      **0 违规**、md 表列数 mismatches = 0、隐形字符 / CRLF / TAB = 0；**零 DDL → 无 `chore(db)`**。
    - **文档同步（同批）**：PLAN **§8.54 新节** + §1 `R21–R28` 行回填（R22 ✅）+ §8.52 排期表
      R22 行标已办 + §8.36 C-5 ① 汇总与 §8.14 补记两处销项注；`vectors/README.md` §3 + §7；
      `BUSINESS_SCENARIOS.md` 校验字段行 `⏸已立` → `✅ 已落地`；`pageStatus.json` 协议页
      `availableNow` / `nextSteps` 回填 + `npm run sync:page-status`；本条。
    - **状态**：**R22 ✅**；**R23 亦已完成 ✅（条目 72）**；余 **R24 → R28 五批**
      （下一批 **R24 创建后切换 op**）。

72. **R23 · `TIME_EPOCH` 绝对时间戳算子：替代手填 INT_UNSIGNED 语义化 epoch（PLAN §8.55 · §8.52 排期第 3 批）**
    （2026-10-03，**BE + FE、零 DDL、`models.py` 未动、`/dispatch` 缺省口径逐字不变**）：
    - **问题**：想要「绝对 Unix 时间戳」只能手填 `INT_UNSIGNED` + 语义化注释（值发一次就过期），
      `TIME_ACCUMULATOR` 只能出**相对**秒数（相对 `base_time`）→ `BUSINESS_SCENARIOS.md`
      挂账 ①。
    - **算子定义（双端同源）**：`op_code = TIME_EPOCH`，参数 `unit ∈ {s, ms}`、**缺省 `s`**
      （`operator.py` `param_template = {"unit": ["s", "ms"]}` → FE `inferConfigType` 出数组 →
      `ParamConfigForm` 渲染 `<select>`）；`raw = floor(now_ms/1000)`（s）或 `floor(now_ms)`（ms）
      → `abs(raw) & ((1 << (8 * byte_len)) - 1)` 定宽大端；**位宽不够只截低位、不报错**
      （4 字节秒值覆盖到 2106、毫秒需 ≥5 字节）；`now` 非有限 → BE 返 `None`（调用方不覆盖
      `hex_value`，保持既有 `cfg.hex`/zeros 现状）/ FE 回落 `Date.now()`（同 E1-6 契约外锚）；
      `inputs` / `value` **不参与**（墙钟压过静态值）。
    - **BE 五处**：`core/orchestrator.py encode_time_epoch`、`core/field_blocks.py`
      `TIME_EPOCH` 分支（`type` 闸 + `sem is not None` 才覆盖 `hex_value`，插 AUTO_COUNTER 前）、
      `core/sequence_plan.py`（`_DYNAMIC_OPS` 三值 + `_EPOCH_KEYS = {field_id, op, offset,
      byte_len, unit}` + `_encode_dynamic` 分支 + `allowed` 三段 + `_normalize_dynamic` 分支，
      探针墙钟 `1_700_000_000_000.0`）、`routers/instruction.py KNOWN_OPS` **20 → 21**
      （注释 15/20 → 16/21）、`routers/operator.py SEED_TEMPLATES` 新增 DYNAMIC 模板
      （无 `base_time`）。
    - **FE 七处**：`constants.js`（`OP_CODES` + `OP_PRIORITY`）、`InstructionEncoder.js`
      **只赋 `value` 后走通用整数路径**（`Math.abs(...).toString(16).padStart().slice(-2n)`
      对正值恒等于 `& mask` → byte-equal 是结构性的，不靠人肉对齐）、
      `normalizeRunnerInstruction.js` **内层与外层 keep 列表同加**（只加一处会摊平成
      `INPUT` / `TIME_CUMULATIVE` → 打字被静默忽略 =「能改但无效」）、`runnerRenderRules.js`
      （`classifyRunnerField` 增 `isEpoch` **走 `isCalculated` 而非 `isTimeCumulative`** →
      只读、不开时间选择器、不写 `base_time`、显示取 `computedValues` hex；`resolveRunnerKind`
      `EPOCH` 章先于 `TIME`；`collectSemanticItems` 增 `UNIT` 且缺省补 `s`）、
      `RunnerFieldTree.jsx` suffix epoch 分支（否则掉进 `getFieldEpoch().getFullYear()` 显示
      `2000`）、`useInstructionLanes.js` 设计期卡面预览、`sequenceView.js` 计划条目
      （`unit` 归一小写，BE 同 `toLowerCase` 口径）；另 `Sequences.jsx` /
      `encoderLimits.js` / `validateInstruction.js` 注释同步。
    - **共享向量**：新增 `vectors/time_epoch.json`（**11 行**，行形状 `{unit, now_ms,
      byte_len, expected}`）**双端同读** —— `backend/tests/test_time_epoch.py` ↔
      `frontend/.../timeEpoch.test.js`；覆盖 s/ms（含 `MS` 大写等价）× 1/2/4/8 字节（含
      1 字节非零低字节堵「恒 00」假绿、截低位、左侧零填、epoch 起点 0、毫秒截低 32 位）；
      `vectorsLoader.test.js` `TABLES` 登记 + `vectors/README.md` §3（14 文件 18 表 →
      **15 文件 19 表**）与 §7 行注归档。
    - **验收**：**BE 793 → 808/808**（+15，`test_op_whitelist` 清单同批改名
      `is_exactly_21`）、**FE 1127 → 1139/1139（75 文件）**（+12）、`npx vite build` EXIT=0、
      `npm run lint` EXIT=0、yorha-ui 校验器改动 js/jsx/json **0 违规**、md 表列数
      mismatches = 0、隐形字符 / CRLF / TAB = 0；**零 DDL → 无 `chore(db)`**；`seed.py`
      **不改**（不新增种子字段）。
    - **文档同步（同批）**：PLAN **§8.55 新节** + §1 `R21–R28` 行回填（R23 ✅）+ §8.52
      拍板表与排期表两行标已办 + §8.36 C-5 汇总销项注 + §8.49「剩余项四类分流」尾注 +
      §8.53／§8.54 尾行推进；`vectors/README.md` §3 + §7；`BUSINESS_SCENARIOS.md`
      绝对时间戳行 `⏸` → `✅`、挂账清单行与 G5 白名单计数回填；`pageStatus.json` 指令页
      `availableNow` / `nextSteps` 回填 + `npm run sync:page-status`；本条。
    - **状态**：**R23 ✅**；**R24 亦已完成 ✅（条目 73）**；余 **R25 → R28 四批**
      （下一批 **R25 加扰 / 混淆**）。

73. **R24 · 创建后切换 op：属性面板放开 `op_code` 编辑 + 兼容校验 + 确认回执（PLAN §8.56 · §8.52 排期第 4 批）**
    （2026-10-03，**BE + FE、零 DDL、`models.py` 未动、`/dispatch` 缺省口径逐字不变**）：
    - **问题**：`BUSINESS_SCENARIOS.md` 挂账 ③ —— 属性面板的 `op_code` 是只读 `<span>`，
      想换算子只能**删了重建重录**（`PLAN §8.52` 2026-10-03 复议立项 R24）。
    - **FE 新模块 `utils/opSwitch.js`（纯函数，20 例单测）**：
      - `switchableOps(templates, current)` = **有算子模板的 OP_CODES**（与调色板同源：
        `STRUCT` 有口径无模板 → 不提供；encoder legacy 五项无创建入口 → 不列），`HEX_RAW`
        居首、余按 `OP_PRIORITY`；**当前算子恒列第一**（legacy 字段渲染不出空下拉、也切得走）。
      - `planOpSwitch(block, next, {childCount, templates})` → `{ok, code, from, to, next,
        kept, dropped, byteLen, bitsDelta}`；拒绝码 `OP_UNKNOWN`（未知算子）与
        `GROUP_HAS_CHILDREN`（**容器切成叶算子且下挂子块 → 拦**，文案点名子块数与
        「孤儿子块」）；同算子 → `SAME_OP`（不产生转换）。
      - **中性键保留** `value / refs / presence / align / pad_to / pad_byte / endianness /
        input_base`（组 → 组另留 `max_count`；**进组摘 `value`** —— 组不吃静态值，留着会被
        `hasFixedValue` 误判成 FIXED 卡面）；**其余键一律丢**（按目标算子重建）。
      - `describeOpSwitch(plan)` = 确认回执文案（切换方向 / 保留 / 清除 / 位宽 /
        字节长度变化 / 「确认后写入草稿，仍需 APPLY 保存」）。
    - **`applyOpDefaults` 单源**：从 `pages/Instruction.jsx handleAddBlock` **原样抽出**
      （改一必改二）→ 新建与切换共用同一份默认态（模板默认值、`BITFIELD` 播种一段 8-bit、
      `ARRAY_GROUP` 清零 + `max_count=1`、`bits` 位宽派生 `byte_len`、`HEX_RAW` hex 等长、
      `STRING` 8B + `type=string` + `encoding` 标量、MAPPING 补 `_kvArray`）；`preferByteLen`
      参数区分两路 —— **新建恒用模板首项**（既有行为逐条不变，`Instruction.test.jsx` STRING
      例照旧绿），**切换优先保留原 `byte_len`**（位宽枚举容纳得下就用它，容纳不下才回落首项
      并同步 `byte_len`，回执报「位宽 + 字节长度」）。
    - **顺带修（存量缺陷）模板数组污染**：`param_template` 的**数组 = 枚举选项**，旧实现原样
      复制进 `parameter_config` → 下拉显示取 `[0]` 而编码器走 `default` 分支，两端各读各的。
      R23 新增的 `TIME_EPOCH unit` 与既有的 `CHECKSUM_CRC algo` 都中招 → `applyOpDefaults`
      一律**落首个标量**（`bits` / `encoding` 早有特判，等价改写）。
    - **面板 UI**（`BlockPropertiesPanel.jsx`）：`op_code` 只读 span → **带标签的
      `算子 (Operator)` 下拉**（值绑 `tempBlockConfig.op_code`，header 同步显示草稿算子）；
      `handleOpChange` **先 `setTempBlockConfig(prev => ({...prev}))` 强制回弹受控下拉**
      （取消 = 草稿一字未动，不会出现「显示新算子、草稿还是旧算子」的假态）→ 按 `plan` 弹
      `openConfirm` 回执（阻断态给空动作），**确认才 `setTempBlockConfig(plan.next)`**。
    - **BE 保存侧兜底**（`routers/instruction.py`）：新表常量 `GROUP_OPS = {ARRAY_GROUP,
      STRUCT}`（与 FE `isGroupOp` 同源）+ `_validate_op_switch(old_ops, fields)` ——
      **只对 op 与存量不同的字段判**（新增字段 / 未切换字段不判 → 存量历史形态不锁）：
      ① 容器切成叶算子且 payload 下挂子字段 → 400；② 切入 `HEX_RAW` 且 hex 去空白后长度
      ≠ `byte_len*2` → 400（**FE `validateInstruction` E1 `HEX_LENGTH` 同口径**，堵直连 API
      绕过面板 APPLY 校验的口子）；调用点在 `update_instruction` 的 `_validate_op_codes`
      之后、**任何写入之前** → 拒绝即存量原样、无半写状态。
    - **测试**：`backend/tests/test_op_switch.py` **15 例**（纯函数口径 + 端点接线：拒绝后
      状态原样、子块先挪出再切组放行、未切换的存量 HEX 长度不拦、新增字段不拦）+
      `backend/tests/test_operator_templates.py` 新增「模板集 = 可切换算子集」反漂移锁
      （`KNOWN_OPS` − `STRUCT` − legacy 5，少一个模板就等于那个算子切不过去）；FE
      `utils/__tests__/opSwitch.test.js` **20 例** + `BlockPropertiesPanel.test.jsx`
      下拉四例（选项构成、合法切换回执 + 回弹 + 确认播种、取消不动草稿、带子块拦截）。
    - **验收**：**BE 808 → 824/824**（+16）、**FE 1139 → 1163/1163（76 文件）**（+24）、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0、yorha-ui 校验器改动 js/jsx
      **0 违规**、md 表列数 mismatches = 0、隐形字符 / CRLF / TAB = 0；**零 DDL → 无
      `chore(db)`**；`seed.py` **不改**（无新算子、无新模板字段）。
    - **文档同步（同批）**：PLAN **§8.56 新节** + §1 `R21–R28` 行回填（R24 ✅）+ §8.52
      拍板表与排期表两行标已办 + §8.54／§8.55 尾行推进；`BUSINESS_SCENARIOS.md`
      「创建后切换 op」行 `⏸` → `✅` + 挂账清单行改已落地；`pageStatus.json` 指令页
      `nextSteps` 回填 + `npm run sync:page-status`；本条。
    - **状态**：**R24 ✅**；**R25 亦已完成 ✅（条目 74）**、**R26 亦已完成 ✅（条目 75）**、
      **R27 出线已完成 ✅（条目 76）**、**R28 解包已完成 ✅（条目 77）** —— R21–R28 全数销项。

74. **R25 · 加扰 / 混淆字段：新算子 `SCRAMBLE` —— 明文进、密文出（PLAN §8.57 · §8.52 排期第 5 批）**
    （2026-10-04，**BE + FE、零 DDL、`models.py` 未动、`/dispatch` 缺省口径逐字不变**；
    **本条由 R26 批回补** —— 提交 `c9495d0` 只改了条目 73 的状态行，R25 正文漏写）：
    - **问题**：`BUSINESS_SCENARIOS.md` 挂账 ② —— 想让固定 hex「换个说法」只能手算好密文贴进
      `HEX_RAW`，换种子要整段重算，卡面上也看不出被加扰过。
    - **算子定义（双端同源）**：op = `SCRAMBLE`（ENCODING 类目，`OP_CODES` 16 → 17、
      `KNOWN_OPS` 21 → 22），明文在 `parameter_config.hex`、**出线 = 密文**；两模式
      `XOR_SEED` 按字节循环异或 `out[i] = plain[i] ^ seed[i % len(seed)]`（缺省）、
      `BIT_ROLL` 逐字节左旋 `((b << n) | (b >> (8-n))) & 0xFF` 且 `n = ((roll%8)+8)%8`
      （负数 / 超 8 / 带小数 / 数字串统一归一，抹平 JS 负 `%` 与 Python `%` 的差异）。
      三条 fail-open：明文空 / 非 hex / 非字符串 → 补零（**绝不把非法明文发上线**）、奇长明文
      丢末尾半字节、契约外 `mode`/`seed`/`roll` → 恒等；解码是编码的逆（XOR 自反、左旋逆
      右旋）→ `decode(encode(x))` 是不动点。
    - **BE**：`core/orchestrator` `encode_scramble` + `unscramble_hex`（共用
      `_scramble_apply`，inverse 只换旋转方向）；`core/field_blocks` 加 `elif op == "SCRAMBLE"`
      分支（**不设 `byte_len` 闸** —— 加扰逐字节保长，长度只由明文定）；`core/field_decode`
      0.5 分支反加扰交回明文 hex（与 FE `InstructionDecoder` 同位）；`routers/instruction`
      `KNOWN_OPS` 21 → 22 + `_validate_scrambles`（create / update 两处、**任何写入前**：
      模式不在册 / 生效模式参数非法 / 明文长度 ≠ `byte_len*2` → 400，`_validate_op_switch`
      保持不动以免两处各判一半）；`routers/operator` `SEED_TEMPLATES` 加 ENCODING 组
      `{mode: [XOR_SEED, BIT_ROLL], seed: "A5", roll: 1}`（**缺省种子 A5** —— 加扰立刻可见，
      比恒等缺省更早暴露「忘了设种子」）。
    - **FE 十处**：`utils/scramble.js` 口径档案（与 BE 逐行同语义）、`InstructionEncoder` /
      `InstructionDecoder` 编解码分支、`validateInstruction` 新错误码 `SCRAMBLE_PARAM`
      （保存阻断 / 卡面 ⛔ / 导入预览同源）+ `scrambleParamError` 只判生效模式、
      `normalizeRunnerInstruction` 与 `runnerRenderRules` 双认身份（否则明文落进 INPUT 被
      「摊平即失效」—— R23 教训）+ 新 `SCR` 芯片、`useInstructionLanes` 卡面取**加扰后线上
      hex**、`BlockPropertiesPanel` 专用 `PLAINTEXT` hex 输入与就近校验、`opSwitch` 的 hex
      播种条件扩 `SCRAMBLE`、`constants` `OP_CODES` + `OP_PRIORITY`；`Block.jsx` /
      `Instruction.jsx` / `sequence_plan.py` / `blockTypes.js` **零改动**。
    - **算子模板顺带修（存量缺陷）**：`applyOpDefaults` 把模板里的**数组 = 枚举选项**一律落
      首元素标量（`unit` / `algo` / `encoding` / `bits`）—— 旧实现原样复制进
      `parameter_config` → 下拉显示取 `[0]`、编码器走 `default`，两端各读各的（R23
      `TIME_EPOCH unit` 与既有 `CHECKSUM_CRC algo` 都中招）。
    - **测试**：新增共享向量 `vectors/scramble.json` **14 行**双端同读（`vectors/README.md`
      §3 → **16 文件 / 20 表** + §7 归档），每行同时钉「出线 byte-equal + 出帧一致 + 反加扰
      回到明文」三件套，期望值**独立复算对拍**（非照实现抄表）；**BE 824 → 843/843**（新
      `test_scramble` 19 例 + `test_op_whitelist` 集合 22 + `test_time_epoch` 计数锁 21 → 22）、
      **FE 1163 → 1196/1196（77 文件）**（`scramble.test.js` 26 例 + 卡面 3 + 面板 4 +
      `opSwitch` / `validateInstruction` 全集 21 → 22）。
    - **验收 / 文档同步**：`npx vite build` EXIT=0、`npm run lint` EXIT=0、yorha-ui 校验器
      18 文件 0 违规、md 表列数 mismatches = 0、index blob STAGED=31 BAD=0；**零 DDL → 无
      `chore(db)`**，`seed.py` 不改（新模板在 `operator.py`，不落库）；PLAN **§8.57 新节** +
      §1 回填 + §8.52 两表标已办 + §8.54／§8.55／§8.56 尾行推进、`BUSINESS_SCENARIOS.md`
      「加扰 / 混淆」行 ⏸ → ✅ 与挂账清单、G5 白名单计数 21 → 22、`vectors/README.md` §3 / §7、
      `pageStatus.json` 指令页白名单计数与 `nextSteps` 回填 + `npm run sync:page-status`。
    - **状态**：**R25 ✅**；**R26 亦已完成 ✅（条目 75）**、**R27 → R28 两批亦已完成 ✅
      （条目 76 / 77）** —— R21–R28 全数销项。

75. **R26 · 序列级分支：`sequence_steps.condition`（仅新增列）+ 受限表达式无 eval + runner 判执行 / 跳过（PLAN §8.58 · §8.52 排期第 6 批）**
    （2026-10-04，**BE + FE、DDL 仅新增列 → `yorha.db` 另开 `chore(db)`**、
    `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、`/dispatch` 缺省口径逐字不变）：
    - **问题**：序列里「第 N+1 步发不发，取决于第 N 步的结果」无处表达 —— 只能拆成两条序列
      人工判断。原拍板 C-1 = A 不立项 → 2026-10-03 复议**立项 B**（**C 发前路由仍不在本列**）。
    - **受限表达式（双端同语义、无 eval）**：语法 = **一次比较** `左 op 右`；6 比较符
      `== != >= <= > <` + 关键字 `in`；关键字 `true`/`false`/`null`/`in` 大小写不敏感；
      **不做**算术 / 括号 / 布尔连接 / 函数调用；变量 = **整串裸词查表**（可含 `.`、`-`、中文，
      分隔 = 空白与 `[] ,` 引号，**整串精确匹配、不下钻**）；`a in b` ≡ `b.includes(a)`（子串
      或数组成员，FE 曾写反方向、靠向量对拍抓出）；`null` 只与 `null` 相等（`v == 0` → false、
      比大小 → 类型错）；布尔永不当数字；上限 `MAX_CONDITION_LEN=200` / `MAX_TOKENS=64` /
      `MAX_ARRAY_ITEMS=32`。**11 条错误文案双端逐字相同**，由 `vectors/condition.json` 的
      `error` 行钉死。落点：`backend/core/condition.py` ↔ `frontend/src/utils/condition.js`
      （改一必改二）。
    - **runner 四分口径**（`core/sequence_runner.py`）：条件空 / 缺键 → **原路径**（
      `with_context = any(...)` → 无条件序列**连 `decode_vars` 都不调**，前置证明由专项测试
      用「被调用即失败」的回调钉死）；求值为真 → 执行；为假 → `SKIPPED` +
      `error = "COND: 条件不成立"`（**判定排在 delay 之前**：不延时、不建帧、不发、不落
      日志，与停止补跳过的**空 error** 可区分）；抛错 → `ERROR` + `"COND: {原因}"` +
      `_step_diagnostic(stage="condition", code="CONDITION_REJECTED", data_sent=False)` → 走
      `_log_step` + `stop_on_error`，**绝不把异常吞成 False**。变量上下文（`_remember`）：
      `step.<n>.status/sent/received/rtt_ms`（去空格 hex，无值不写键）+ 应答解码字段的
      **平铺键（最近者胜）与定点键** `step.<n>.<字段名>`。
    - **解码 hook 与保存口**：路由侧新增 `_decode_vars_factory`（仿 `_compile_wrap_factory`
      自开会话）复用 `log_store.resolve_log_fields` —— **与落库解码同一条路**，回调**永不抛**；
      保存侧 `_condition_spec` **只查语法不查变量**（变量到运行期才存在）→ `400` 定位
      `steps[i].condition`（`stage="condition"` / `code="STEP_CONDITION_INVALID"`，为此
      `diagnostics.STAGES` 新增 `"condition"` 枚举值）；`SequenceStepSpec` / `SequenceStepOut`
      各加 `condition: Optional[str] = None`，`_to_out` 用 `getattr(..., None)`（与 `wrap`
      同口径）。
    - **DDL 三处（仅新增列）**：`models.py::SequenceStep.condition VARCHAR(200) NULL` +
      `migrate.py::Migration(5, "sequence_steps_condition", ...)`（`condition_tables()` verify
      钉死**恰好** `["sequence_steps"]`）+ `database.ensure_sequence_step_columns` 改为
      **wrap + condition 两列同批自愈**（一次 commit 幂等）；datahub
      `sequence_step_export_row` 显式 dict **补 `"condition"`**（漏了 = 导出再导入静默丢分支）。
    - **FE `Sequences.jsx`**：编辑器新增「执行条件（可选）」输入（`maxLength=200`、
      `data-testid="step-condition"`），`stepCondition` state 与「标签 / 延时」同轨（APPLY 才
      落步）→ `checkCondition` **就地红框 + 红字**（`step-condition-error`），APPLY 先拦非法
      并弹 `fail` 横幅；`handleApplyStep` 是重建对象故显式
      `...(stepConditionText ? { condition } : {})`；`saveBody` 按 `'condition' in s &&
      s.condition` **条件包含**（键缺席 = 无条件 → 无条件步骤请求形与改前逐字节一致）；
      `toDraft` `if (!step.condition) delete step.condition`；StepRow `COND :: {expr}` 行内
      指示（`step-cond-{i}`，title 写明四分口径）；状态行 `title` 本就带 `error` → 跳过原因
      `COND: 条件不成立` 就地可见（**状态表结构零改动**）。
    - **测试**：新增共享向量 `vectors/condition.json` **58 行**双端同读（README §3 →
      **17 文件 / 21 表** + §7，`vectorsLoader` TABLES 登记后目录同集自检 5/5）；BE 新
      `test_condition.py` **14 例**（求值器 + 向量 FAILS=0）与 `test_sequence_condition.py`
      **18 例**（无条件零解码零增量 / 真 → 执行 / 假 → 不延时不发不落日志 / 非法 → `COND:` +
      诊断 + 快停 / `stop_on_error` 两态 / 变量未定义 / 类型不可比 / 解码字段两命名空间 /
      解码炸了不反噬 / 保存口 400 定位且 0 写入 / 空白归一 / 缺键 null / 启动注入 /
      API 全链路 OK-OK-SKIPPED / datahub 导出带条件）+ `test_migrate` 新
      `ConditionMigrationTest` 3 例（R20 断言改 `_ALL_LABELS[3:]` 跟注册表走）+
      `SequenceStepColumnSelfHealTest` 四态扩两列；FE 新 `utils/__tests__/condition.test.js`
      **14 例** + `Sequences.test.jsx` **24 → 27 例**。
    - **验收**：**BE 843 → 878/878**、**FE 1196 → 1213/1213（78 文件）**、`npx vite build`
      EXIT=0、`npm run lint` EXIT=0、yorha-ui 校验器改动 js/jsx/json **6 文件 0 违规**、
      `vectors/README.md` 表清单 16 / 20 → **17 / 21**、md 表列数 mismatches = 0、隐形字符 /
      CRLF / TAB = 0、index blob BAD = 0；**不引 pytest、无新 pip 依赖**。
    - **文档同步（同批）**：PLAN **§8.58 新节** + §1 `R21–R28` 行回填（R26 ✅）+ §8.52
      拍板表与排期表两行标已办 + §8.54／§8.55／§8.56／§8.57 四处尾行推进到 R27；
      `BUSINESS_SCENARIOS.md` G1 行补「按结果跳步已解、发前路由 C 仍红」+「按输入值选指令
      模板 / 报文」行注 R26 边界；`pageStatus.json` + `npm run sync:page-status`；本条
      （**含条目 74 的 R25 正文回补**）。
    - **状态**：**R26 ✅**（**R27 出线已于 2026-10-04 完成 ✅ → 见条目 76**、**R28 解包亦已
      完成 ✅ → 见条目 77**，R21–R28 全数销项）；提交 = `feat(R26)` 在前 +
      `chore(db)` 提交 `yorha.db`（Migration 0005）在后。

76. **R27 · varint / COBS 出线：length 卡 `encoding`（LEB128 变长长度）+ 组帧元素 `cobs` —— 只做编码、不碰解包（PLAN §8.59 · §8.52 排期第 7 批）**
    （2026-10-04，**BE + FE、零 DDL → 无 `chore(db)`**、`processor.py` / `graph.py` /
    `Blueprint.jsx` 未碰、`/dispatch` 缺省口径逐字节不变）：
    - **问题**：长度域只有「定宽 1 / 2 字节」一种形态、帧定界只能靠固定外壳 —— §8.36 C-5 ③
      原判**不做**，§8.52 复议**立项并按原建议拆两批**：**R27 出线（编码）→ R28 解包
      （`stages` 逆向解码 + 应答匹配）**，本批只做前者。
    - **硬前置（Phase 0）先于实现**：动代码之前先抓改前金标准、双端钉死「**无变长编码时逐字节
      不变**」—— BE `test_framing_baseline.py` **14 例** + FE `framingBaseline.test.js` **5 例**。
      两条能力都必须**显式配置**才生效（`encoding` 缺省 `fixed`、树里没有 `cobs` 节点），
      故这 19 例是持续看守，不是一次性自证。
    - **① varint（length 卡新选项）**：`pc.encoding ∈ {fixed, varint}`，缺省 `fixed` = 缺失键 =
      与本批之前逐字节一致；**LEB128 最小无符号**（`0 → 00`、`127 → 7F`、`128 → 8001`、
      `300 → AC02`、`2^32-1 → FFFFFFFF0F`）；**字节序中立** → 不走 `apply_byte_order`（R21 的
      `byte_order` 与它并存也互不相干）；值域 `VARINT_MAX = 2^53-1`，负数 / 超界 / 非整数 →
      BE `ValueError` → 既有 **400**、FE `encodeVarint` 回 `[]` / `varintWidth` 回 `null`；
      **出线后回写 `block.byte_length = 实际字节数`** —— 设计期宽度 ≠ 出线宽度，回写后下游
      refs Σ 与 checksum 计数**同源**（`varint_len_root` 132 字节 vs 缺省 `fixed` 的 131 字节
      正是这 1 字节）。FE 同口径 PASS1 回填 `fieldSizes` 并**再跑一遍 PASS1**（Σ 幂等、
      第二遍只多把出线宽算进 Σ）。
    - **② cobs（协议树新组帧元素）**：`type: "cobs"` 可嵌套包住整段子树、
      `pc.terminator ∈ {00, none}` 缺省 `00`；BE `Orchestrator.process()` **第 0 步树级前置改写**
      `_apply_cobs()` —— **由内向外**：子树先经**同源子编译器**发射（与主帧同一套 handler，
      LEN / CRC 语义完全一致）→ `encode_cobs_hex` → 替换为**定宽 `fixed` 叶**（`id` 沿用、
      `children` **保留**供 LEN / CRC 卡面回显）；**无 cobs 节点零遍历零改写**。算法单趟、
      码字节占位回填、单块 ≤ 254 字面量，**码 `0xFF` 满块闭合且其后无字面量时不写收束码**
      （否则 254 字面量出现两态、非规范）；定界按 `terminator` 追加 → 出线正文**无裸 `0x00`**。
      FE `emitNode` 组分支**局部缓冲子发射**（`hexParts` / `byteMap` / `currentByteIndex` 换绑、
      游标从 0 起镜像内层 Orchestrator 相对游标）→ `encodeCobsHex` → 并回主流，子块 byteMap
      丢弃（**只记 cobs 块自身出线区间**，镜像 BE `block_spans`）。
    - **解码不进生产代码（「只做编码」的字面执行）**：BE 由 `test_module_is_encode_only` 钉住
      模块无解码入口；FE 解码只活在测试内的**局部参考解码器**（与实现零共享代码）—— 往返校验
      用它，生产路径永不 import。
    - **refs 跨不过编码边界**：`expand` 遇 `cobs` **停钻不下钻** —— 引 cobs 块本身按其**出线
      字节数**计；指其**内部叶子** → 保存侧 **400**（BE `_validate_refs` 收集 `inside_cobs`，
      detail `refs cannot reference blocks inside a COBS subtree`；FE 镜像 `REFS_INSIDE_COBS`
      中文可定位），否则后端按 0 计、前端仍查得到 → 两端 Σ 分歧。枚举外值双端 **fail-open**
      （回 `fixed` / `00`）+ FE `ENCODING_UNKNOWN` / `TERMINATOR_UNKNOWN` **warning 不阻断**，
      镜像 `byte_order` 既定口径、防抖自动保存不被误报卡死。
    - **API 形制与落点**：`backend/core/framing.py` ↔ `frontend/src/utils/framing.js` 编码 SSOT
      （`normalize_encoding` / `terminator_of` 纯函数只吃 `params`）；取 `Block` 的门面 =
      `length.encoding_of(block)`，与 R21 `byte_order_of(block)` 同一形制。BE 五处
      （`framing.py` / `handlers/length.py` / `core/orchestrator.py` / `core/frame_builder.py` /
      `routers/protocol.py::_validate_refs`）、FE 八处（`config/blockTypes.js` + `utils/framing.js`
      + `utils/InstructionEncoder.js` + `utils/toFrameBlocks.js` + `utils/validateProtocol.js`
      + `utils/byteOffsets.js` + `utils/protocolTree.js` + `components/editor/Block.jsx`）。
    - **设计期偏移尺（两遍法）**：`computeByteOffsets` 新增 `opts.sizeOverrides` 注入精确出线宽
      —— `length + varint` 按 `varintWidth(Σ + offset)`（任一尺寸未知或值域外 → 未知，不猜）；
      `cobs` 组的宽取决于**子树字节**（0x00 分布、254 满块）→ `computeProtocolOffsets`
      **第一遍静态算 → 对每个 cobs 真编码求宽 → 第二遍回灌**，偏移 / 其后起点 / 总长与 BE
      `block_spans` 同口径；**无 cobs 节点 → 零第二遍**（存量尺寸与总长逐值不变）；子树含
      **槽**（载荷期才定）→ 注入 `null` = 未知（下游沿既有 `??` 链），**不谎报成 Σ 下界**。
      COBS 区比 Σ 子**宽** → 游标按**组自身 size 收口**（普通组 Σ 子 ≥ size 走既有 pad 上卷，
      条件不成立即存量零影响）。
    - **已知限制 / 存量差异（本批明确不修）**：载荷落 COBS 区内 → `payload_offset = None`；
      cobs 区内 FE 不做字节高亮（子块区间落在编码后已无对应）；协议卡 UI 无 `align` / `pad`
      字段（子树内配 pad 仅理论可达）；`SUM_8` 且 `byte_length = 2` 时 BE 出 `01F7`、FE 出
      `00F7`（`formula.js` 8 位折返）是 **R22 期就存在的双端差异**，按「不改算法」原则两侧各
      钉现值加注、留待算法对齐批次；FE 编码侧已补 `pc.offset`（此前漏加 → 同一棵树两端同帧），
      **设计期卡面 Σ 显示**仍不加（显示口径另案）。
    - **测试与向量**：新增共享向量 `vectors/framing.json` **3 表 35 行**（`varint` 14 ·
      `cobs` 16 · `frame` 5）双端同读，README §3 → **18 文件 / 24 表**（原 17 / 21）+ §7 三条注、
      `vectorsLoader` TABLES 登记后目录同集自检过；**双道自检**（期望值既对表、又过独立规范
      解码器往返）当场揪出 **2 个错向量 + 1 个编码器满块收束码 bug** —— 防「期望值 = 实现自证」。
      BE 新 `test_framing_baseline.py` **14 例** + `test_framing.py` **25 例**（向量对表 / 值域 /
      fail-open / 满块边界与往返 / 定界三态 / `LengthHandler` varint 与宽度回写与 byte_order
      忽略与下游 checksum 计字节 / `Orchestrator` 嵌套与空子树与 refs 引 cobs / frame 向量 /
      `test_module_is_encode_only`）；FE 新 `framingBaseline.test.js` **5** + `framing.test.js`
      **17**，既有 `blockTypes.test.js` +4（encoding / cobs / createBlock 种子）、
      `validateProtocol.test.js` +4（W6 / W7 / `REFS_INSIDE_COBS` / 空 cobs 零问题）、
      `toFrameBlocks.test.js` +4（encoding 翻译 / 两键并存 / terminator 三态 / expand 停钻）。
    - **验收**：**BE 878 → 917/917**（+39）、**FE 1213 → 1247/1247（80 文件）**（+34）、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0、yorha-ui 校验器改动 js/jsx/json
      **16 文件 0 违规**、`vectors/README.md` 表清单 17 / 21 → **18 / 24**、md 表列数
      mismatches = 0、隐形字符 / CRLF / TAB = 0、index blob BAD = 0；**零 DDL → 无
      `chore(db)`**；不引 pytest、**无新 pip 依赖**。
    - **文档同步（同批）**：PLAN **§8.59 新节** + §1 `R21–R28` 行回填（R27 ✅、余 R28）+
      §8.52 排期表 R27 行标已办 + §8.36 C-5 两处销项注 + §8.54～§8.58 **五处尾行**推进到
      R28；`BUSINESS_SCENARIOS.md` 第三节 `varint / COBS 组帧` 行 ⏸ → ✅ + 调研基线「仍暂缓」
      收窄 + 挂账行补已落地；`pageStatus.json` + `npm run sync:page-status`；本条
      （**含条目 75 的状态行同步**）。
    - **状态**：**R27 ✅**；**R28 解包亦已完成 ✅ → 见条目 77**（R21–R28 全数销项）；
      提交 = `feat(R27)` 单笔（R27 **零 DDL** → 无 `chore(db)`）。

77. **R28 · varint / COBS 解包：`stages` 逆向解包 + 应答匹配 —— R27 出线的收侧另一半（PLAN §8.60 · §8.52 排期第 8 批）**
    （2026-10-04，**BE + FE、零 DDL → 无 `chore(db)`**、`models.py` 一行未动、
    `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、`/dispatch` 缺省口径逐字节不变）：
    - **问题**：R27 只把 varint / COBS **发得出去**，收侧还按定宽 / 切片判 —— 设备回帧的长度域
      是 LEB128 变长、或整段被 COBS 定界包住时，`response_match` 根本剥不开内层，五要素判定
      无从谈起。C-5 ③ 按原建议**拆两批**，本批做后半（**硬前置 = R27 出线已完成 ✅**）。
    - **Phase 0（改前金标准先双端钉死）**：动实现之前先抓改前形态并机械生成测试，改完必须仍绿
      —— BE `test_response_baseline.py` **7 例**（内嵌改前金标准 JSON：25 normalize +
      20 match + 6 多层 + 4 生成树 + 3 层链 + stage A/B/C/D，由 Temp `ev_r28_baseline.py`
      → `ev_r28_baseline.json` 抓取、`ev_r28_gen_baseline_test.py` **机械生成测试体**防手抄漂移）；
      FE `responseBaseline.test.jsx` **3 例**（`defaultSpec()` 形状 / 改前缀 + 开 LENGTH 提交
      spec 逐字节 / 只改前缀）。两条新能力都**显式配置**才生效 → §0 缺省口径由它们 +
      `test_framing_baseline` 14 / `framingBaseline` 5 持续看守。
    - **收侧新模块 `backend/core/unframe.py`（只解不编、纯函数、零 I/O）**：
      `decode_varint(data, offset=0) -> (value, width)` —— LEB128 逆向，**非最小编码接受**
      （`80 00` = 0，编码侧只会出最小形态 → 收侧放宽不产生歧义，拒绝反而把「设备补零」判成坏帧），
      宽度按**实际读到的字节数**报（供回算 `offset_val`）；起点负 / 布尔 / 越界、续位悬空、
      超 `MAX_VARINT_BYTES = 8`、值超 `VARINT_MAX = 2^53-1` → `ValueError`。
      `cobs_decode(data) -> bytes` —— 标准 COBS **码字节区**（不含定界）逆向，码 `0xFF` 与末块
      之后**不补隐式 `0x00`**（与 R27「满块闭合不写收束码」配对即无歧义）；空区 / **区内含
      `0x00`**（= 定界漏剥，让 `unpack.trailer` 少算一个字节当场现形）/ 码字节越界 → `ValueError`。
      **对偶纪律**：R27「生产模块不得出现解码入口」演进为「**编码模块仍无解码符号**」——
      `framing.py` **一行不改**（`test_framing::test_encode_only_module` 继续钉死无 `decode*`），
      新增 `test_unframe::DecodeOnlyModuleTest` 对偶钉死无 `encode*`。
    - **规格形制（只写非缺省值 → 存量逐字节不变）**：`length.encoding ∈ {fixed, varint}`
      （**缺失键**读作 `fixed`；枚举外 → 400 `length.encoding 必须是 fixed/varint 之一`）；
      `unpack.mode ∈ {slice, cobs}` + `inner_head` / `inner_trailer`（**仅 cobs 下写这三键**，
      `slice` 形态逐字节不变；`slice` 配 `inner_*` → 400；`cobs` 下允许 `head = trailer = 0`
      —— 整层就是一个 COBS 区本身可区分，`slice` 仍禁 0+0）。
    - **新 reason 码（三条，只在病因确实不同时新增）**：`LENGTH_VARINT_INVALID(原因)`
      （**读不出值** ≠ 读出的值对不上 `LENGTH_MISMATCH`，不硬凑）；
      `STAGE[i].UNPACK_COBS_INVALID(原因)`（区解码失败）；
      `STAGE[i].UNPACK_INNER_TOO_SHORT(n<=m)`（区内字节不够剥 `inner_head + inner_trailer`）。
      请求侧解码失败**不写理由**（镜像存量 `tx=b""`）；单帧与分层两处 length 逻辑抽共用
      `_length_reasons(length, frame, tag="")`，reason 只差 `STAGE[i].` 前缀（**改一必改二**）。
    - **关键公式（varint 自洽的唯一例外）**：`expected = len(frame) + offset_val -
      (width - byte_length)` —— `offset_val` 按**设计期宽**算、收侧按**实际出线宽**回算，
      两处差的 `(width - byte_length)` 正好抵消（展开即 `declared = payload + A`）；`fixed` 时
      `width == byte_length` → 修正项恒 0，**存量逐字节不变**。推导证得该抵消**只对被选中的
      那张 length 卡成立**，层内另有 varint 卡时 `expected = declared + Σ(wᵢ - bᵢ)(i ≠ 选中项)`
      → 必然失配 —— 由此定出下面的**逐要素降级**。
    - **生成侧几何（可用才生成，算不出就降级 —— 只少判不误判）**：`_flatten_leaves` 对
      **无槽 COBS 收为一个几何单元**（`_cobs_wire` 走 `build_wrapped` 取**出线宽**，码字节与
      `0x00` 插码不进逻辑和；refs 越出子树 / 区间模式 → 降级）、含槽 COBS 展开；插槽在 COBS
      区内 → `boundary` → `head/trailer` + `inner_head/inner_trailer` + 跳过 length/checksum +
      warning（**剥层几何仍成立**）；嵌套 ≥ 2 层 cobs 包槽 或宽不可知 → `unpack = None`；
      `_ref_leaf_ids` 遇 cobs 不下钻；`_length_element` 走 `normalize_encoding` fail-open、
      只写非缺省 `encoding`；新增 `_varint_indices` + `_downgrade_varint` 三处降级
      （非选中 varint 卡 → 丢 length；payload-span / 绝对位置的 checksum 被 varint 污染 → 丢
      checksum；**任意 varint 卡 → `unpack = None`**，因 `head`/`trailer` 是字节计数）。
      **多层缺 `unpack` → `ValueError` → 400**（文案指名道姓「无法静态表达的 COBS/变长几何 …
      请手工编写应答规格」）—— 分层剥不出内层不是「少判」而是「误判」，fail-closed。
    - **FE 落点（只做规格表单，不建无消费者的解码模块）**：`TransactionPanel.jsx` LENGTH
      toggle 行右侧新增 `ENCODING` 下拉（`fixed · 定宽` / `varint · LEB128`）+ `patchLengthEncoding`
      —— **选 varint 才写键、切回 fixed 删键**（与后端「缺失键 = fixed」逐字节对应，存量形态不变），
      `BYTE_LEN` **不禁用**（设计期宽度，收侧回算要用），选 varint 时出 9px 提示（字节序无关 /
      BYTE_LEN = 设计期宽度）。
    - **向量口径（反向消费，不新增文件）**：新表须**双端同读**而匹配只有后端一处消费 → 不满足，
      故 **不新增 vectors 文件**；`test_unframe.py` 逆向消费 `vectors/framing.json`（varint 行
      `hex → v`、cobs 行 `out` 剥定界 → `in`）作解码往返真值 + 与 `encode_varint` /
      `encode_cobs_hex` 直接往返 + 畸形报错面；`framing.json::_note` 与 `vectors/README.md` §3 表行 +
      §7 同批改口（R27「只编码不解包」→ R28 反向消费），表清单 **18 文件 / 24 表不变**。
    - **测试**：BE 新 `test_unframe.py` **9 例** + `test_response_baseline.py` **7 例**、
      `test_response_match.py` **23 → 35**（+12：varint 双出线宽同规格 / 缺 `encoding` 宽帧失配 /
      截断·超值域 `VARINT_INVALID` / 位置越界另码 / 枚举外拒收 / byte_order 共存不参与判读；
      cobs 两层剥层成功 / 内层病因打 `STAGE[0].` / 区畸形与裸 `00` 打 `STAGE[1].` /
      区太短 / cobs 允许 0+0 / `inner_*` 在 slice 下拒 / mode 枚举外拒）、
      `test_response_generate.py` **41 → 51**（+10：`encoding` 透传与只写非缺省 / 生成 → 发射 →
      收侧判定**双出线宽整链往返** / 非选中 varint 卡降级 / 多层 varint 拒绝生成 /
      无槽 COBS 计**出线宽**而非逻辑和 / 含槽 COBS 区内几何 / 区内 length 降级 warning /
      无槽区 length 隐藏 warning / 两层 cobs 生成 + 整链往返 / 嵌套 cobs 拒绝生成）。
    - **验收**：**BE 917 → 955/955**（+38）、**FE 1247 → 1251/1251（81 文件）**（+4 =
      `responseBaseline.test.jsx` 3 + `TransactionPanel.test.jsx` 13 → 14）、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0、yorha-ui 校验器改动 js/jsx/json
      **3 文件 0 违规**、md 表列数 mismatches = 0、隐形字符 / CRLF / TAB = 0、
      index blob BAD = 0；**零 DDL → 无 `chore(db)`**；不引 pytest、**无新 pip 依赖**。
    - **文档同步（同批）**：PLAN **§8.60 新节** + §1 `R21–R28` 行回填（R28 ✅、七项全数销项）+
      §8.52 排期表 R28 行标已办 + §8.59 尾行 + §8.36 C-5 销项注 + §8.53～§8.58 **四处尾行**
      推进到「全数销项」；`vectors/framing.json::_note` + `vectors/README.md` §3 表行与 §7 改口；
      `pageStatus.json` 协议页 R27 条尾 + 指令页 `nextSteps` 新增 R28 条 + `npm run sync:page-status`；
      本条（**含条目 73～76 四处状态行同步**）。
    - **状态**：**R28 ✅** —— **§8.52 七项复议立项（R21–R28）至此全数销项**；
      提交 = `feat(R28)` 单笔（**零 DDL** → 无 `chore(db)`）。

78. **R29 · 加工页条件存在 (PRESENCE) 展示层 —— 把「这条到底发不发」在加工页看出来（PLAN §8.61 · 人工测试反馈批次）**
    （2026-10-04，**纯 FE、零 DDL → 无 `chore(db)`**、`models.py` 一行未动、
    `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**出线字节逐字不变**）：
    - **问题（用户原话）**：「满足 IF 条件的与不满足 IF 条件的时候，指令加工中本条指令的字段从肉眼上看不出区别」。
      改前取证两层 —— ① **显示缺口**：§8.16 第 6 条文件面清单**本就不含 `InstructionForm`**，
      加工页字段树对 presence 零感知（无 IF 角标 / 无命中态 / 定长章仍按静态 `byte_len` 亮）→ **不是回归，是范围外**；
      ② **判定链两处**：库内仅 2 条 presence 配置，其中样本指令 ② `枚举映射 == "01"` 因
      `handleChange` 把选项值 `parseInt(x,16)` 转成数值 → `String(1)="1" ≠ "01"` **选哪支都未命中**，
      而未动下拉时 `inputs` 无键 + `pc.value` 空 → **fail-open 恒命中**（样本 ① 字节确实 8B↔9B 变，
      但字段行毫无标识）。**拍板 = 只做显示层**，② 属语义变更另排。
    - **新纯函数 `resolvePresenceStates`（`config/runnerRenderRules.js`）**：**只委托**
      `InstructionEncoder._presenceHit`（与出线编码同一套 fail-open，改一必改二），**不造第二套判据**；
      对象形态 `pc.presence` 才进表（否则不进表 = 不点角标，与改前逐像素一致）；返回
      `{fieldId: {hit, title}}`，`title` = `条件字段：[ref] == expect` + `· 命中 → 发射本字段` /
      `· 未命中 → 0 字节（本帧不发）` + **fail-open 归因四支**（缺 ref_id / 缺 expect / ref 悬空 / ref 无值链）
      —— 把「为什么这条恒发 / 不发」写进 hover，因为存量 ref 无 `pc.value`、ref 悬空这两类静态链断裂
      **此前在加工页完全不可见**。依赖 `runnerRenderRules → InstructionEncoder`，编码器不回引 → **无环**。
    - **渲染三处（全为显示层）**：`SmartInput.jsx` 新 prop `presence` → label 区（kind 章后）`IF` 琥珀章 +
      右徽标槽 `presence && !hit` → **`[SKIP 0B]` 顶到最高优先**（压过 TIME_PICKER / READ_ONLY / 用量 /
      长度章，「这行根本不出线」比「能不能改」要紧）；`RunnerFieldTree.jsx` 新 prop `presenceStates`
      → 叶行 / 组头出章、未命中外层 `opacity-50`（**组未命中整棵子树随之降透明**）、递归透传；
      `InstructionRunner.jsx` `useMemo` 造表，依赖 `[normalizedInstruction, inputs, computedValues]`
      **与 `hexPreview` / `byteMap` 同一组** → 角标与右侧 BYTE_STREAM、`LEN` **恒同步**，
      不会出现「角标说 SKIP 但字节还在」。
    - **边界（三不改）**：`presenceStates` **缺省 `null` = 零渲染** → `Sequences.jsx` 步骤编辑器复用同一
      组件但不传表，**该页零改动**；被门掉的字段**输入与限宽一律不禁用**（要靠键入把条件改命中，
      `maxLength`/`min`/`max`/用量徽标全照旧）；`_presence_hit` 口径 / 校验四码 / normalize / 编码分支
      **一行未动**，**不做 expect 十六进制补零归一**（`"01" ≡ 1` 会翻转存量判定 → 字节变）。
    - **测试（红测先行有据）**：3 新文件 **24 例** —— `runnerRenderRules.presence.test.js` 12（进表口径 /
      `String` 归一 / `computed` 优先 / fail-open 四支归因 / **角标结论 == 真实字节**恒等式）、
      `RunnerFieldTree.presence.test.jsx` 9（不传零渲染 / 表无此字段也不渲染 / 命中 / 未命中 /
      `[SKIP 0B]` 压过 `[READ_ONLY]` / 组级同权 / 父命中不豁免子）、`InstructionRunner.presence.test.jsx` 3
      （**装配线**：表真传到字段树 + 改 ref 输入实时翻转 + 未配不出章）。
      **红测证据**：`git stash` 四个实现文件 → **19 failed / 2 passed**（通过的 2 条是「不传就不渲染」的
      反向用例，理应在旧代码上也通过），`stash pop` → **24 / 24 绿**。
    - **验收**：**BE 955/955（持平）**、**FE 1251 → 1275/1275（84 文件，+24）**、`npx vite build` EXIT=0、
      `npm run lint` EXIT=0、yorha-ui 校验器改动 js/jsx **7 文件 0 违规**、md 表列数 mismatches = 0、
      隐形字符 / CRLF / TAB = 0、index blob BAD = 0；**零 DDL → 无 `chore(db)`**；不引 pytest、**无新 pip 依赖**。
    - **文档同步（同批）**：PLAN **§8.61 新节** + §1 新增 `R29` 行 + §8.60 尾行改指 §8.61；
      `pageStatus.json` 加工页 `instructions` 新增 R29 条 + `npm run sync:page-status`；本条。
    - **状态**：**R29 ✅** —— 加工页「看不见条件」这条人工反馈已收口；**登记为后续可选项（§8.61 第七节）**
      = expect/枚举十六进制归一（**会改字节，单独排期**）/ ref 无值链校验提醒 / Sequences 页同款角标。
      提交 = `feat(R29)` 单笔（**零 DDL** → 无 `chore(db)`）。

79. **R30 · presence 可见性收口：进制/补零假阴性提示 + 第二消费方自算（PLAN §8.62 · R29 自登记「半成品」批次）**
    （2026-10-05，**纯 FE、零 DDL → 无 `chore(db)`**、`models.py` 一行未动、
    `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**出线字节逐字不变**）：
    - **两处缺口（都是「看得见没」同一主题）**：① R29 角标**只说结论不说原因** —— 样本 ② expect 存字符串
      `"01"`、枚举下拉把选项值 `parseInt(x,16)` 转成数值 `1` → `String(1)="1" ≠ "01"` 判不等，而 title 只写
      「未命中 → 0 字节」，看不出**为什么**；② **第二个消费方一个章都不出** —— `Sequences.jsx` 步骤编辑器
      复用同一 `RunnerFieldTree`，R29 为把范围钉在加工页把缺省定成 `null = 零渲染` → 同一条指令**加工页有角标、
      步骤编辑器没有**，自相矛盾。两处**都不改判定、不改字节**（用户此前明确只选显示层，判定归一仍待拍板）。
    - **进制 / 补零假阴性提示**（`resolvePresenceStates` 的 `title` 追加）：三条**同时**成立才提示 ——
      仅 **miss 侧**（命中 / fail-open 不挂）+ **expect 整串十六进制可解析**（`^[0-9A-Fa-f]+$`，`ALPHA` / `0x1`
      一律 `NaN`）+ **解析值与当前值数值相等**；文案 `· ⚠ 按十六进制解析 "01" = 1 与当前值 1 相等，String 归一
      判不等（补零/进制差异 → 未命中）`。**真·不同值（`9`↔`1`）不提示** —— 宁可少判不误判，只陈述事实不断言意图。
      纯展示，不参与任何比对。
    - **第二消费方自算**（`RunnerFieldTree` 缺省语义「零渲染」→「自算」）：`undefined`（未传）→ 用本组件手上的
      `fields` / `inputs` / `computedValues` **自算**（顶层只算一次、递归把表透传）；`null`（显式）→ 关闭
      （保留 R29 逃生口）；对象 → 直接用（`InstructionRunner` 走这条，带 memo 与 `hexPreview` / `byteMap` 同依赖）。
      自算与显式传表**同一个 helper**、**不是第二套判据** → 两页口径必然同源、新增页面默认就有。
      **`Sequences.jsx` 一行未改**即生效；`normalizeRunnerInstruction` 的 `parameter_config` 整包 spread，
      `presence` 原样透传到渲染树。
    - **边界**：判定 / 校验四码 / normalize / 编码分支**一行未动** → 出线字节逐字不变；BE 零改动；**零 DDL**；
      判定归一（`"01" ≡ 1`）**仍不做**，继续挂 §8.61 第七节待拍板。
    - **测试（红测先行有据）**：新增 **15 例**（FE **1275 → 1290**）—— `runnerRenderRules.presence` +7、
      `RunnerFieldTree.presence` +5（含**显式表优先于自算**）、`InstructionRunner.presence` +2（端到端：
      默认 `0` vs `"01"` 不提示 → 改 `1` 出提示**且判定仍 miss**）、`Sequences.test` +1（**第二消费方端到端**：
      零接线出 `IF(miss)` + `[SKIP 0B]`，帧同步 `FRAME 1B`）。
      **红测证据**：stash `runnerRenderRules.js` + `RunnerFieldTree.jsx` → presence 三文件 **7 failed / 31 passed**、
      `Sequences.test.jsx` **1 failed / 27 passed**，`stash pop` 后 4 文件 42 例全绿。
    - **验收**：**BE 955/955（持平）**、**FE 1275 → 1290/1290（84 文件，+15）**、`npx vite build` EXIT=0、
      `npm run lint` EXIT=0、yorha-ui 校验器改动 js/jsx **6 文件 0 违规**、md 表列数 mismatches = 0、
      隐形字符 / CRLF / TAB = 0；**零 DDL → 无 `chore(db)`**；不引 pytest、**无新 pip 依赖**。
    - **文档同步（同批）**：PLAN **§8.62 新节** + §1 新增 `R30` 行 + §8.61 尾行改指 §8.62；本条。
    - **状态**：**R30 ✅** —— §8.61 第七节 3 项中「Sequences 同款角标」已以「组件自算」方式收掉（不止同款：
      新页面默认就有）。**剩余待拍板 2 项** = expect/枚举十六进制归一（**会改字节**）、ref 无值链校验提醒（新 W 码）。
      提交 = `feat(R30)` 单笔（**零 DDL** → 无 `chore(db)`）。
      （**R32 改判**：本条的 miss 侧假阴性注记已随 §8.64 判定归一**翻到命中侧** ——
      「能 hex 相等的必已命中」，miss 侧那段话不再可能成立。见条目 81。）

80. **R31 · presence 设计期效度三码 —— 「配了却不成立」在保存前就点破（PLAN §8.63 · §8.61 第七节第 ② 项正主）**
    （2026-10-05，**纯 FE、零 DDL → 无 `chore(db)`**、`models.py` 一行未动、
    `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**出线字节逐字不变**、
    BE 零改动 —— BE 本就无 presence 校验码，四码 + 三码均 FE-only）：
    - **来源**：R29/R30 只把「为什么判不等」摆在**加工页 / 步骤编辑器**的 hover（运行前的填写现场）；
      **指令管理页（设计期）看不到** —— 用户配完保存，等真机上「一个字节都不发」才发现，太晚。
      §8.61 第七节第 ② 项「ref 无值链的校验提醒（新 W 码）」是本批正主，扩成**三码**。
    - **三码（全落 warnings → 保存只拦 errors → 零行为变更）**：
      | 码 | 形态 | 结论 |
      |---|---|---|
      | W `PRESENCE_REF_NO_SOURCE` | 引用字段无 `pc.value`、非输入型（`INPUT`/`STRING`/`variable`）、无选项、非计算类，**且**是只读固定算子（`HEX_RAW`/`FIXED`/`HEADER`/`TAIL`/`SCRAMBLE` 或 `readOnly`） | 编码期 `_refValue` 只能取 `undefined` → **恒 fail-open 判命中 = 等于没配** |
      | W `PRESENCE_EXPECT_UNREACHABLE` | 有下拉选项（**封闭集**）→「选项归一值 ∪ 静态值」**无一**与 `String(expect)` 相等 | **选哪一项都不成立**（恒未命中 → 0 字节）——样本② 的设计期可见版 |
      | W `PRESENCE_HEX_PAD` | 静态值与 expect 十六进制解析相等、`String` 归一判不等，且非自由键入、无选项集 | 补零/进制假阴性 → **静态链恒未命中**（与 R30 hover 归因同一谓词） |
    - **判据一律「表外不算、宁可少判」**：可自由键入（`STRING` / `type='string'`）、非锁定、
      无候选全集 → 一律不提醒（误报会让用户对提醒脱敏）；悬空 ref 归 `PRESENCE_REF_MISSING`、
      配置不完整归 `PRESENCE_INCOMPLETE` → **不叠报效度码**。
    - **SSOT 抽取（本批唯一重构）**：新叶子模块 **`frontend/src/utils/presenceSemantics.js`**
      （零 import → **无环**）承载 `hexNorm` / `comparableNumber` / `radixPadMismatch` /
      `normalizeOptionValue` / `formatEnumOptions` / `enumCandidates`；`runnerRenderRules.js`（R30 hover）
      与 `validateInstruction.js`（R31 提醒）**import 同一实现**，`formatEnumOptions` 从
      `runnerRenderRules` **re-export** → 既有 importer 与 70 例回归**一行未改**。
      理由：同一条「为什么不等」出现在两处，必须共用一个谓词，否则文案与判定会悄悄分叉
      （与 `_presence_hit` ↔ `_presenceHit` 的「改一必改二」同一纪律，只是这一对在 FE 内部）。
    - **边界**：判定 / 校验四码 / normalize / 编码分支**一行未动** → 出线字节逐字不变；
      **不新增 error** → 保存门行为不变；**零 DDL**。
    - **测试（红测先行有据）**：新增 **21 例**（FE **1290 → 1311**）——
      `utils/__tests__/validateInstruction.presenceValidity.test.js`：① 8 例（含悬空/不完整不叠报）、
      ② 5 例、③ 6 例、零行为总闸 2 例。**红测证据**：实现落笔前跑该文件 → **7 failed / 14 passed**
      （恰是 7 个正向断言，码尚不存在）；实现后 `git stash push -- validateInstruction.js runnerRenderRules.js`
      → **再红 7 failed / 14 passed**，`stash pop` → 21 例全绿；R30 既有 19 例 + `runnerRenderRules.test`
      70 例（重构回归）同步全绿。
    - **验收**：**BE 955/955（持平）**、**FE 1290 → 1311/1311（85 文件，+21）**、`npx vite build` EXIT=0、
      `npm run lint` EXIT=0、yorha-ui 校验器改动 js/jsx **4 文件 0 违规**、md 表列数 mismatches = 0；
      **零 DDL → 无 `chore(db)`**；不引 pytest、**无新 pip 依赖**。
    - **文档同步（同批）**：PLAN **§8.63 新节** + §1 新增 `R31` 行 + §8.62 尾行改指 §8.63；本条；
      pageStatus 指令管理页新条 + `npm run sync:page-status`。
    - **状态**：**R31 ✅** —— §8.61 第七节第 ② 项**已收掉**（扩成三码）。**唯一剩余待拍板** =
      expect/枚举十六进制归一（`"01" ≡ 1`，**会改字节**）→ 下一批 **R32（§8.64）**。
      提交 = `feat(R31)` 单笔（**零 DDL** → 无 `chore(db)`）。
      （**R32 后改判**：本条 ③ `PRESENCE_HEX_PAD` 已**退役**、② 的候选判据已改用
      `presenceEqual` —— 见条目 81。）

81. **R32 · presence 判定归一（`"01"` ≡ 1）—— 首个「会改字节」的判定修正（PLAN §8.64 · §8.61 第七节第 ① 项正主）**
    （2026-10-05，**纯 FE+BE、零 DDL → 无 `chore(db)`**、`models.py` 一行未动、
    `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**不引 pytest、无新 pip 依赖**；
    用户拍板「R31 + R32 两批连做」并**明确接受出线字节会变**）：
    - **病根（样本②）**：expect 存**字符串** `"01"`、引用值是**数值** `1` → `String(1)="1" ≠ "01"`
      **恒未命中**，门等于配废。R30 只能在 hover 解释「为什么判不等」、R31 只能在设计期提醒
      「这条条件达不成」—— 都在**描述病**。本批把两者判成**等**。
    - **谓词 `presenceEqual(expect, value)`** = `String()` 归一（N3 存量口径逐字保留：数值 1 命中
      `"1"`）**∪ 十六进制归一**（`expect` 是**字符串** 且 整串 `^[0-9A-Fa-f]+$` 且在安全整数内
      → 与 `comparableNumber(value)` 数值相等即判**命中**，`"01"` ≡ 1、`"0A"` ≡ 10）。
    - **三条边界（宁可少判，只做拍板项）**：仅字符串 expect（JSON 数字 `10` 不按 hex 解 → 现状不变）、
      **不做 trim**（`" 1"` 非整串 hex → 向量 `[..., " 1" → "AA"]` 锚住）、超安全整数不归一
      （`Number.isSafeInteger` ↔ Python `2**53-1` **同阈**，双端精度一致不分叉）。
    - **三个判定点同用一个谓词（改一必改二 + 一）**：
      | 层 | 位置 | 不跟的后果 |
      |---|---|---|
      | FE 运行期 | `utils/InstructionEncoder._presenceHit` | 出线字节真源 |
      | FE 设计期 | `utils/byteOffsets.presenceStaticState` | 编码期命中、卡面却按 0 字节排偏移（两端自相矛盾） |
      | BE 编译期 | `core/field_blocks._presence_hit` → `_presence_equal` | byte-equal 锚点断 |
    - **存量影响清单（会改字节的全集）**：`vectors/presence.json` leaf `[{"ref_id":"cmd","expect":"01"}, "AA"]`
      → **`"AABB"`** —— **唯一一条向量变化**（两端同读一份 → 自动同步）；无 presence 的指令、
      其余 17 份向量、`/dispatch` 缺省口径、N3 四码、fail-open 四支、判定先于 repeat 的顺序
      **一行未动**；`test_field_decode` / `test_encode_align` / `Sequences` 的用例均为真·不同值
      → 结论不变（BE 955 → 963 全绿即证据）。
    - **展示层随判定收口（一处翻面 + 一处退役 + 一处改判据）**：① R30 的 **miss 侧假阴性注记翻到
      命中侧**（`· 按十六进制归一判等（expect "01" ≡ 值 1 = 1，补零/进制差异不影响判定）`，fail-open
      归因优先互斥）；② **R31 W `PRESENCE_HEX_PAD` 退役**（「恒未命中」前提不复存在，再报即假警）；
      ③ **R31 W `PRESENCE_EXPECT_UNREACHABLE` 改判据** `String(v)!==expect` → `!presenceEqual(expect,v)`
      （样本② 归一后**可达 → 不再报**，文案加「（含十六进制归一）」）。① 码
      `PRESENCE_REF_NO_SOURCE` 不受影响（fail-open 未变）。
    - **测试（红测先行有据）**：新增 **21 例** —— BE `TestPresenceRadixNormalize` **8**、FE
      `InstructionEncoder.presence.test.js` R32 describe **8**（含组级门）、FE `byteOffsets.presence.test.js`
      R32 describe **5**。**红测证据**：实现落笔前 BE → **4 failed / 14 passed**、FE → **6 failed /
      51 passed**（正向全红）；实现后 BE 18/18、FE 57/57 全绿；R30/R31 展示层既有用例**转红属预期
      （语义翻面）→ 同批改写**。
    - **验收**：**BE 955 → 963/963**、**FE 1311 → 1323/1323（85 文件，+12）**、`npx vite build` EXIT=0、
      `npm run lint` EXIT=0、yorha-ui 校验器改动 js/jsx/json **0 违规**、md 表列数 mismatches = 0；
      **零 DDL → 无 `chore(db)`**。
    - **文档同步（同批）**：PLAN **§8.64 新节** + §1 新增 `R32` 行 + §8.63 尾行改指 + §1 `R30`/`R31`
      两行加改判指针；本条（并给条目 79 / 80 挂改判注）；pageStatus 加工页 / 序列编排页 / 指令管理页
      三条改判 + `npm run sync:page-status`。
    - **状态**：**R32 ✅ —— §8.61 第七节两项至此全部出清（② 由 R31、① 由本批），第七节归零。**
      **明确留白**：不做空白容错、不做 JSON 数字 expect 归一、不改 fail-open 与 N3 四码。
      提交 = `feat(R32)` 单笔（**零 DDL** → 无 `chore(db)`）。

82. **R33 · 加工页 presence 未命中字段 `纯隐藏`（仅加工页、步骤编辑器不动；PLAN §8.65 · 用户新需求，非 §8.52 复议范围）**

    - **来源与拍板**：用户新需求 —— 「命中即发送」语义下，指令加工业页面**没有触发的字段直接隐藏掉，
      防止干扰使用者」。两项 UX 取舍当场拍板：① **纯隐藏（完全不渲染）**，不留占位、不留
      「N 个字段已隐藏 ▸ 展开」入口；② **仅指令加工业页面** —— 步骤编辑器（Sequences）维持 R29 形态
      （降透明 + `[SKIP 0B]`），因为那里要展示步骤流程全貌。
    - **实现（纯展示层，判定点一个不加）**：
      | 改动 | 位置 | 要点 |
      |---|---|---|
      | 新 prop `hidePresenceMissed = false` | `components/InstructionForm/RunnerFieldTree.jsx` | 算出 `presenceMiss` 后**直接 `return null`**；**组与叶同一判定点**（组返回即整棵子树消失，子层不重复判）；递归透传至深层 |
      | 唯一接线点 | `components/InstructionForm/InstructionRunner.jsx` | 传 `hidePresenceMissed`（加工页） |
      | 兜底事实行 | `RunnerFieldTree` 顶层 | `depth===0` 且**全部字段**未命中 → `[HIDDEN] 无可填字段 · …（本帧不发射）`；**无按钮无展开入口**；有任一可见字段即不出现 |
      | **零改动** | `pages/Sequences.jsx` | 不传该 prop → 缺省 `false` → 分支永不进入，**逐像素不变** |
    - **判定同源、展示分叉**：判定表仍是同一张 `resolvePresenceStates`（**同源判定 + 分叉展示**），
      本批**不新增任何判定点**；判定 / 编码 / 偏移尺 / 校验四码**一行未改 → 零字节变化**。
      测试锁「字段被藏起来 `LEN` 照样随判定 +1」（隐藏只动 DOM，不改编码）。
    - **测试（红测先行有据）**：**红测证据 = 实现落笔前 7 failed / 26 passed**（现状照旧出降透明 +
      `[SKIP 0B]`）。新增 R33 describe **12 例**（缺省不变 / 叶未命中整行消失 / 命中照常 / 组未命中
      整棵子树消失 / 组命中而内层未命中 / 未配 presence 不受影响 / 自算路径同隐藏 /
      `presenceStates=null` 时不隐藏 / 递归透传 / 全隐藏兜底行无按钮 / 有可见字段不出兜底行）。
      `InstructionRunner.presence` 装配测试**同批改写**：R29 靠 miss 形态证「表已接线」，
      R33 后加工页 miss 不可见 → 改**两头锁**（初始即命中直接出 `IF(hit)` + 默认未命中完全不出、
      改 ref 命中才出现、改回又消失的**双向翻转**）。
    - **验收**：**BE 963/963（持平，本批零 BE 改动）**、**FE 1323 → 1335/1335（85 文件，+12）**、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0、yorha-ui 校验器改动 4 文件 **0 违规**、
      md 表列数 mismatches = 0；**零 DDL → 无 `chore(db)`**。
    - **文档同步（同批）**：PLAN **§8.65 新节** + §1 新增 `R33` 行 + §8.64 尾行改指；本条；
      pageStatus 加工页条目改写 + `npm run sync:page-status`。
    - **状态**：**R33 ✅ —— 「未命中」从「降透明提示」改为「纯隐藏」，且仅作用于加工页。**
      **明确留白**：步骤编辑器不隐藏（拍板②）、不加隐藏计数角标与展开开关（拍板①）、
      不动判定与编码任何一码（**零字节变化**）。被隐藏字段的**编辑入口**：改**引用字段**的值即让它
      重新出现（判定驱动渲染，非写死），或到步骤编辑器（不隐藏）里改。
      提交 = `feat(R33)` 单笔（**零 DDL** → 无 `chore(db)`）。

83. **R34 · 协议校验和字节序 `checksum.byte_order`（R21 成对缺口「另开」；PLAN §8.66 · 2026-10-05 排期拍板）**

    - **来源与拍板**：§8.53（R21 长度域 BE/LE）尾行明写「checksum 的 `byte_order`
      **未立项，需另开**」，`frontend/src/config/blockTypes.js` 代码注释同款留档 ——
      文档与代码**双重登记**的成对缺口。2026-10-05 排期时在「校验和字节序 / 前端拆包 /
      发前路由」三候选中拍板选此，节奏 = 自主连跑到完。
    - **为什么真需要**：协议要求校验和**低字节先发**（Modbus CRC16 就是这个形态）此前
      做不到 —— `ChecksumHandler` 两个 return 恒 `f"{result:0X}"` 大端格式化。
    - **实现（BE 四处 + FE 四处，零 DDL）**：

      | # | 位置 | 要点 |
      |---|---|---|
      | ① | `backend/handlers/base.py` | **字节序门面上移**：`byte_order_of` + `apply_byte_order` 从 `length.py` 移入 base → length / checksum **两个 handler 同用一个谓词**（不留第二套判据）；`length.py` re-export 保住既有 import |
      | ② | `backend/handlers/checksum.py` | **两个 return 同位套用**（refs 模式 + 旧区间模式 —— 换一种引用方式不换出线形态） |
      | ③ | `backend/core/frame_builder._with_byte_order` | 闸门放开到 checksum；**`_with_encoding` 一行未动**（varint 仍 length 专属） |
      | ④ | `backend/core/response_generate._checksum_element` | 硬编码 `"byte_order": "big"` → **从 `pc` 取**（镜像 §8.53 表第 ④ 项 `_length_element`）—— 否则出线小端而比对规则按大端比**必然失配** |
      | ⑤ | `frontend/src/config/blockTypes.js` | checksum 卡 `fields` 增 `'byte_order'`，**复用 R21 同一字段定义** → 面板走通用 select 分支，`ProtocolPropertiesPanel` **零 JSX 改动** |
      | ⑥ | `frontend/src/utils/toFrameBlocks.js` | `withLogicParams` 闸门放开；`encoding` 另设 `type === 'length'` 二级闸（防 `pc.encoding='varint'` 误写进 checksum） |
      | ⑦ | `frontend/src/utils/protocolTree.js` | **两个计算点同用一份反转（改一必改二）**：`collectDeterministicBytes`（容器内容 / 卡面递归）+ `injectRefsSigma`（卡中央值），抽 `isLittleOrder` / `reverseHexPairs` |
      | ⑧ | `frontend/src/utils/validateProtocol.js` | W5 `BYTE_ORDER_UNKNOWN` 同码覆盖 checksum，文案按块型分叉（长度字节序 / 校验字节序）；W6 仍 length 专属 |

    - **收侧本就支持、本批零改动**：`response_match._CHECKSUM_KEYS` 与
      `sequence_plan._normalize_checksum` 早已含 `byte_order`（R21/R22 期留的口），
      `test_response_match` / `test_sequence_plan` 既有锚继续有效。
    - **共享向量（真值链不自证）**：`vectors/checksum_order.json` **12 行 = 6 算法 × 2 字节序**
      两端同读 —— `expected_big` **逐字取自 R22 `checksum_algo.json` 的外部真值**
      （zlib / binascii / 已发布 check 值，本批不重新验证算法），`expected_little` = 字节反转；
      1 字节算法（SUM_8 / XOR_8 / LRC）两侧同串 → 把「单字节不反转」也钉进表里。
      同批在 `vectorsLoader.test.js` 的 `TABLES` 登记（否则「表清单与 vectors 目录同集」红）。
    - **缺省口径逐字节不变（§0）**：面板读侧是 `pc[propKey] ?? field.default`（**只回显不落值**）、
      `createBlock` 不播种 → 存量与新建 checksum 块的 `parameter_config` **形状不变**，
      只有真把下拉选到 `little` 才出现该键；未配 / `big` / 枚举外一律大端。
    - **测试（红测先行有据）**：实现落笔前 **BE 11 failed / 14 tests**（big 行全绿、
      little 行全红 → 红因全部由缺失特性引起）+ **FE 9 failed / 108 passed**；实现后
      **BE +14、FE +14** 全绿。**三处既有测试同批翻面**（R21 的「checksum 不吃此键」断言随语义失效）：
      `test_checksum_blocks_ignore_byte_order` → `..._honour_byte_order`、
      `toFrameBlocks`「非 length 块不写」→「闸门只开两卡」、`blockTypes`「checksum 不列」。
    - **验收**：**BE 963 → 977/977**、**FE 1335 → 1349/1349（85 文件，+14）**、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0、yorha-ui 校验器改动 10 文件 **0 违规**、
      md 表列数 mismatches = 0；**零 DDL → 无 `chore(db)`**、不引 pytest、无新 pip 依赖、
      `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、`/dispatch` 缺省口径不变。
    - **文档同步（同批）**：PLAN **§8.66 新节** + §1 新增 `R34` 行 + §8.53 尾行与表第 ③ 项改指；
      本条；pageStatus 协议页条目 + `npm run sync:page-status`。
    - **状态**：**R34 ✅ —— §8.53「checksum 的 `byte_order` 未立项，需另开」的账已还清。**
      **明确留白**：`cobs` / `slot` / `bitfield` 无字节序概念不加字段；指令域 `endianness`
      （E1-2 B6）是另一个域不并入；**不引入 trim 归一**（谓词形态沿用 R21，避免本批顺带改
      既有字节行为）；收侧零改动。
      提交 = `feat(R34)` 单笔（**零 DDL** → 无 `chore(db)`）。

84. **R35 · 前端路由级拆包（首屏 752kB → 325kB；PLAN §8.67 · 2026-10-05 排期拍板）**

    - **来源与拍板**：**无既有登记项** —— `vite build` 每批报的
      「chunk larger than 500 kB」警告本身就是债。2026-10-05 排期时在
      「路由级拆包 / 只分 vendor / 发前路由 / 拆包+trim 连做」四选项中拍板选**路由级拆包**。
    - **为什么真需要**：8 个页面在 `App.jsx` 里全是静态 import，vite 把它们连同首屏外壳
      揉成一个 **752.85kB** 的 `index.js`，而用户一次只开一页 —— 首屏白拉了 8 页中 7 页的代码。
    - **实现（FE 四处，零 DDL）**：

      | # | 位置 | 要点 |
      |---|---|---|
      | ① | `frontend/src/utils/routeChunks.js`（新） | **页面模块单一登记表** `ROUTE_LOADERS`（R35 落笔 8 个动态 import，与 `PAGE_REGISTRY` 同集；R38 加路由规则页起 9 个）+ `routeComponent` 返回**缓存过的** `React.lazy` 实例（不缓存 → 每次渲染新建组件 = 整页重挂载）+ `prefetchRoute` **幂等**（复用同一份 pending Promise，失败 `.catch(→null)` 不打断导航）+ `__resetRouteCaches` 仅测试隔离 |
      | ② | `frontend/src/components/RouteLoading.jsx`（新） | Suspense fallback：`[ MODULE LOAD ]` 标记 + 按 `useLocation` 查 `PAGE_STATUS_BY_PATH` 出中文页名（未知路由回落站点名，**不臆造**）+ `role="status"` / `aria-live`；**不画假百分比**（拆包加载没有可度量的进度），8 段待机格只表达「等待中」 |
      | ③ | `frontend/src/App.jsx` · 渲染 | **删 8 行静态页面 import** → `renderRouteElement` 按 `pageKey` 取组件后**原样注入各页 props**（prop 契约一行未动），未知 key 仍 `<Navigate to="/protocol">` |
      | ④ | `frontend/src/App.jsx` · 预取 + 边界 | `NavItem` 增 `pageKey` 走 `onMouseEnter` / `onFocus` 预取（键盘 Tab 与鼠标同待遇）；**`<Suspense>` 放在 `key={location.pathname}` 之外** → 换路由时边界自身不重建，已访问过的页切回来不重闪 fallback |

    - **`manualChunks` 分 vendor 判负（候选 B′）**：依赖极轻（react / react-dom /
      react-router-dom / dnd-kit / clsx / tailwind-merge / uuid，无 lodash 无图表库），
      vendor 只砍约 200kB 而**本项目代码自身就 >500kB**，警告照报 —— 只有路由级 lazy 能切开首屏。
    - **体量账（两次 `npx vite build` 实测）**：`assets/index-*.js`
      **752.85kB（gzip 243.50）→ 325.42kB（gzip 113.64）**，8 个页面 chunk
      **10.43–56.63kB**（Trash 10.43 / DataHub 23.19 / Protocol 27.06 /
      InstructionProcessor 30.56 / Orchestration 33.62 / Sequences 34.01 /
      Terminal 36.26 / Instruction 56.63），**500kB 警告消失**。
    - **零字节影响**：纯前端构建层，**BE 一行未改**，`/dispatch` 缺省口径不变，
      出线 hex / `LEN` / 导出一个字节都不动；行为面唯一变化 = 切页时多一个终端风格 loading 态。
    - **`pageStatus.json` 零改动**：该文件按页登记「本页具备哪些能力」，本批是外壳 / 构建层
      改动**不给任一页新增能力** → 塞进任一页 `availableNow` 都是张冠李戴，故 json 与生成物
      `docs/PAGE_STATUS.md` 双双不动（与 `chore(db)` 批次同类：无页面能力变化即不登记），
      记账走 PLAN §1 表 + §8.67 + 本条。
    - **测试（红测先行有据）**：新增 `routeChunks.test.js`（9 例）+
      `RouteLoading.test.jsx`（4 例）。实现前 **2 文件整体红 = 模块不存在**（缺特性本身）；
      落实现后剩 1 failed 是**测试自身 bug**（React 19 的 `lazy` 返回 lazy 组件对象非函数）
      → 按纪律**先修测试**（断言 `$$typeof === Symbol.for('react.lazy')`）再算数；修后 **13/13 全绿**。
      钉住：每页各有且仅有一个载入器（按 registry 派生 —— R35 时 8 页、R38 加路由规则页起 9 页）/ 同页同引用 / prefetch 幂等且失败不炸 / fallback 只认已登记路由。
    - **验收**：**BE 977/977（持平）**、**FE 1349 → 1362/1362（87 文件，+13）**、
      `npx vite build` EXIT=0（无体积警告）、`npm run lint` EXIT=0、yorha-ui 校验器改动
      5 文件 **0 违规**、md 表列数 mismatches = 0；**零 DDL → 无 `chore(db)`**、不引 pytest、
      无新 pip 依赖、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰。
    - **文档同步（同批）**：PLAN **§8.67 新节** + §1 新增 `R35` 行；本条 + 目录地图补
      `routeChunks.js` / `RouteLoading.jsx`；`pageStatus.json` 不改（见上）。
    - **状态**：**R35 ✅ —— 每页只加载自己那块。**
      **明确留白**：不做 `manualChunks` 分 vendor（判负）、不做路由预渲染 / SSR、
      **发前路由**（`BUSINESS_SCENARIOS` G1 尾注，§8.52 C-1 拍板 A 不立项，翻案需用户确认）
      **→ 2026-10-06 已翻案立项，见第 85 条 / PLAN §8.68**；`byte_order` trim 归一
      （§8.66 留白）不涉。
      提交 = `feat(R35)` 单笔（**零 DDL** → 无 `chore(db)`）。

85. **R36 · 发前路由 · BE 数据层（新表 + 匹配器 + 解析端点；PLAN §8.68 · 2026-10-06 翻案拍板）**

    - **来源与拍板**：§8.36 C-1 三选项（A 不立项 / B 序列级分支 / C 发前路由），
      §8.52 复议**只立项了 B**（R26），拍板表明写「C 发前路由**仍不在本列**，要做另议」。
      **2026-10-06 用户对 A 不立项翻案**，按**原选项 C** 规格立项，**分三批**
      （承诺「2–3 批」，实分 3 批，分界见 §8.68 一）。
      例 B（只有 C 解得了）：同一个执行按钮，`meter_id = 0001` 发指令 X、`= 0002` 发指令 Y，
      发生在**进入序列之前** —— 序列分支结构上解不了。
    - **批次切分**：**R36 = 纯 BE**（表 + CRUD + 匹配器 + 解析端点）；
      **R37 = 集成收尾**（引用计数 / 同戳级联 / 回收站中文名，**✅ §8.69，见第 86 条**）
      —— 先补数据完整性洞；**R38 = 规则编辑 UI（独立「发前路由规则」页）**
      （**✅ §8.70，见第 87 条**）；**R39 = 加工页自动选指令接线**（**✅ §8.71，见第 88 条**）；
      **R40 = 规则页试解析入口**（**✅ §8.72，见第 89 条**，§8.70 六 与 §8.71 七
      两处同挂的留白正主，2026-10-07 单独立项）。
      **后两批经 2026-10-06 用户拍板再拆一次**（question 工具回执）：先管理面、后接线 ——
      两件事验收面不同，CRUD 纯 FE 可全自动验收，接线须实机冒烟。
    - **新表 `routing_rules`（§0 合规）**：`id` / `name`（唯一）/ `condition` /
      `instruction_id`（**逻辑外键**，同 `op_code` 先例不加 FK）/ `sort_order` / `enabled` /
      `description` / `created_at` / `updated_at` / `deleted_at` —— 属 §0「**仅新增表**」
      明文允许，`models.py` 无改列删列。**零 Migration**：`create_all` 对既有库也会建新表
      （补不了列、建得了表），REGISTRY 五条全是加列 → **不动 REGISTRY**；新表批历史上有
      `chore(db): 同步 yorha.db` 先例，但现行节奏**排除 `yorha.db`** → **单笔 feat、无
      `chore(db)`**。
    - **匹配器 `backend/core/routing.py` 复用 `core/condition.py`，不造第二套判据**
      （与 `sequence_steps.condition` 同一门语言、同一份 SSOT，FE `utils/condition.js`
      逐行同语义）。五条口径：`(sort_order, name, id)` 定序 · **first-match-wins** ·
      停用与回收站行不参与 · 条件**语法**坏掉记 `invalid` **继续往下扫** ·
      变量不在输入里 = **普通不命中不记 `invalid`**（后两条同抛 `ConditionError`，
      靠**先单独 `parse_condition`** 区分：解析期挂 = 规则坏了，求值期挂 = 输入没给键）。
      **全无命中 → `matched=false`，绝不回落第一条。**
    - **端点（§0）**：`POST /dispatch/routed` **新增且只解析不发送** —— 回执六键
      `matched / rule / instruction_id / instruction / invalid / considered`，
      **无 `status`·`attempts`·`hex_string`**（有测试逐键断言）；命中顺带回指令全文。
      `POST /dispatch/` 与 `/dispatch/transaction` **一行不改**。CRUD `/routing-rules`
      按 `response_spec.py` 范式：判重查全表（软删占名 → 先 400 不漏 500）、目标须为**活**
      指令、**先校验再落笔**。**回收站白名单补 `routing_rule`**（否则 `DELETE` 打的软删
      标记是永久黑洞）。
    - **意外发现并修好（真故障）**：`migrate.py` 0002 / 0004 / 0005 三条 verify 是
      「**metadata 全量派生 + 精确集合断言**」，新表天生带 `deleted_at` / `sort_order` /
      `condition` → 三条同时红 → `run_pending_migrations` 整条回滚 → **每个库都起不来**
      （BE 全量一度 16 errors + 3 failures）。改口径为 **`_scope_tables` = 冻结史实名单
      ∩ models**：冻结名单保史实（新表由 `create_all` 整表建出，轮不到这条 ALTER），
      交集保防漏卡（名单里哪张表在 models 被误删该列 → `len != 13` 照样报错）。
      **两个防漏方向都还在、既有 0 条测试需改** —— 改的是口径本身，不是挪球门。
      `migrate.R6_TABLES` 与测试的 `EXPECTED_13_TABLES` 各写一份、互为交叉校验。
    - **测试（红测先行有据）**：新增 `backend/tests/test_routing.py`（22 例）。实现前
      **整体红 = `ModuleNotFoundError: backend.core.routing`**（缺特性本身）；落一轮后
      剩 1 failed 是**测试自身 bug**（恢复后原行仍占名，本就该 400，§8.43）
      → 按纪律**先修测试**再算数；修后 **22/22 全绿**。全量回归再翻 **1 条既有钉**：
      `TrashScopeTest`「白名单恰好 7 类」实得 8 类 —— 属**测试随新事实改写**（非缺特性、
      也非测试写错），改写时补显式 `assertNotIn` 强化原意。三档性质分开记账。
    - **验收**：**BE 977 → 999/999**、**FE 1362/1362（持平，纯 BE 批）**、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0、md 表列数 mismatches = 0、
      index blob 卫生 STAGED / BAD = 0；**仅新增表 → 零 Migration、无 `chore(db)`**、
      不引 pytest、无新 pip 依赖、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰。
      实机：`openapi.json` 上 `/dispatch/routed` 与 `/routing-rules` 五方法齐备、
      `/dispatch/` 与 `/transaction` 原样；建规则 → 命中回指令全文 → 不命中
      `matched=false` → 空输入 `considered=1`·`invalid=0` → 删除后回收站可见。
    - **文档同步（同批）**：PLAN **§8.68 新节** + §1 新增 `R36` 行 + §8.36 拍板表与
      §8.52 拍板表各补翻案行 + §8.67 留白改指；`BUSINESS_SCENARIOS` 挂账行
      「按输入值选指令模板 / 报文」🔴 → ✅ 与 G1 尾注；本条 + 目录地图补 4 个新文件。
    - **状态**：**R36 ✅ —— 「该发哪条指令」有了数据层答案，`/dispatch` 缺省口径一个字节没动。**
      **明确留白（→ R37 ✅ / R38 ✅ / R39 ✅）**：`byte_order` trim 归一（§8.66 留白）
      不涉。原挂的「指令删除的引用计数与级联」与「`Trash.jsx` 中文名」
      **已由 R37 销掉 ✅（§8.69）**，「规则编辑 UI」**已由 R38 销掉 ✅（§8.70）**，
      「加工页自动选指令接线」**已由 R39 销掉 ✅（§8.71）**。
      提交 = `feat(R36)` 单笔（**仅新增表** → 无 Migration、无 `chore(db)`）。

86. **R37 · 发前路由 · 集成收尾（引用计数 + 同戳级联 + 回收站；PLAN §8.69 · 2026-10-06）**

    - **来源与拆批**：R36 §8.68 八 挂的两条留白。**为什么先做它再做 UI** ——
      不做的后果是「删指令 → 规则变悬空行且用户**不知道**自己删了什么」（数据完整性），
      而 UI 那两件是可见性；顺序反了的代价是 UI 先上线、用户造出成批规则后一次误删
      一次性产出成批悬空行，且**没有任何一处会提示**。
    - **三分口径归类**：`routing_rules` 归 D14② 的**活配置**档（与 `protocol_bindings` /
      `response_specs` 同档），目标入站时**同戳**级联、恢复时一并捞回。三处改动缺一环就断：

      | # | 位置 | 改动 | 漏了会怎样 |
      |---|---|---|---|
      | ① | `instruction.get_instruction_references` | 加 `routing_rules`（只数活行）并计入 `total` | 弹窗不提规则 = **对用户隐瞒一次删改** |
      | ② | `instruction.delete_instruction` | `mark_related(RoutingRule, instruction_id, ts)` + 回执 `deleted_routing_rules` | 规则留站外成悬空行 |
      | ③ | `trash.py` 的 `instruction` `children` | 补 `("routing_rules", RoutingRule, instruction_id)` | 同戳级联**白做** —— 恢复了宿主，规则还在站外 |

      ③ 最隐蔽（②管**进去**、③管**回来**），落实现后正是它单独红了一轮。
    - **刻意例外：`routing_rule` 在回收站不隐藏。** `trash.py` 通用的「宿主在站就连带
      子行隐藏」是**时间戳的代理**：规则先独立删（`t1`）、指令后入站（`t2`）→ 被判隐藏，
      但恢复按同戳 `t2` 捞子行**捞不回 `t1` 的它** → 从此再也看不见，正是 R36 点名要防的
      「永久黑洞」换了入口进来。故规则**始终自己占一行**：列表多几行，换**任何一行都够得着**。
      `binding` / `response_spec` 既有行为有测试钉着，本批不顺手改别人的口径。
    - **FE**：`describeReferences` 新增「· 发前路由规则 N 条 → 随删入站（活配置，随指令恢复）」
      （排在应答规格之后、序列步骤之前 = 三类活配置连排）+ 无引用句补一词；`describeDeletion`
      新增「发前路由规则 N 条级联」（沿用 **R18 只报非零** 口径）；`Trash.jsx` `KIND_LABELS`
      加 `routing_rule: 路由规则`（`KIND_ORDER = Object.keys(...)` 自动跟上，chip 不用另配）；
      `relatedText` 通用求和，恢复回执多的键自动并入。
    - **`pageStatus.json` 两处陈述已陈旧并改正**（指令页「四表计数」/「活配置（绑定·规格）」
      → 五表 + 加规则；回收站页「7 类对象」→ 8 类 + summary 列规则 + 统一入口补例外说明）
      → `npm run sync:page-status`。
    - **测试（红测先行有据）**：BE 实现前 4 errors + 1 failure（`KeyError: 'routing_rules'`、
      级联没做 → 规则仍在列）、FE 3 failed（文案缺项）—— **红因全部 = 缺特性本身**；
      落实现后 BE 仍剩 1 failed（`children` 没接）**同属缺特性**；全量回归再翻 **3 条既有钉**
      （`res.related` 多出 `routing_rules` 键）→ **测试随新事实改写**。四档性质分开记账。
    - **验收**：**BE 999 → 1002/1002**、**FE 1362 → 1365/1365（+3）**、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0、yorha-ui 校验器 **4 个改动文件
      （3 js/jsx + `pageStatus.json`）0 违规**、md 表列数 mismatches = 0、
      index blob 卫生 STAGED / BAD = 0；**零 DDL → 无 Migration、无 `chore(db)`**、
      不引 pytest、无新 pip 依赖、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、
      **`/dispatch` 缺省口径未动**。
    - **文档同步（同批）**：PLAN **§8.69 新节** + §1 新增 `R37` 行 + §8.68 一 / 八
      批次切分与留白改指 + 两处拍板表改「R36 ✅ / R37 ✅ / R38 待排」；本条 + 目录地图
      改 `instruction.py` / `trash.py` / `useInstructionData.js` / `Trash.jsx` 四行。
    - **状态**：**R37 ✅ —— 删指令不再留下没人知道的悬空规则，恢复也一并回来。**
      **明确留白（→ R38 ✅ / R39 ✅）**：规则编辑 UI（**R38 已落地 ✅ §8.70**）、
      加工页自动选指令接线（**R39 已落地 ✅ §8.71**）；`byte_order` trim 归一（§8.66 留白）不涉。
      提交 = `feat(R37)` 单笔（**零 DDL** → 无 Migration、无 `chore(db)`）。

87. **R38 · 发前路由 · 管理面（独立「发前路由规则」页 · CRUD + 排序草稿 + 启停；PLAN §8.70 · 2026-10-06）**
    - **为什么**：R36 给了数据层答案、R37 补齐删改时的数据完整性，但**页面上看不到也建不了
      规则** —— R38 给规则表第一个家。**纯 FE、零 DDL**，`backend/` 一个字节没碰。
    - **落点与拆批（用户拍板，question 工具回执 2026-10-06）**：① **新建独立页**
      （`/routing`，第 9 页，快捷键 `H`，插在回收站之前）而非挂指令页 / 加工页面板 ——
      规则是独立实体、还要跨规则调 `sort_order`（first-match-wins 的语义全在顺序上），
      塞进任一现有页都装不下；② **拆两批**：R38 只做 CRUD、R39 才做加工页接线 ——
      前者红测全落在文案与请求形状上（纯 FE 可自动验收），后者改变「执行」行为（须实机冒烟）。
    - **页面四件事**：列表顺序 = 匹配顺序（照后端 `(sort_order, name, id)` 定序渲染，
      FE 不重排不重算，保存一律稠密重编使 `(name, id)` 兜底永不生效）；表单就地校验
      （`validateRuleDraft` 委托 `utils/condition.checkCondition` 同一 SSOT，非法即红字
      **一个请求都不发**）；启停 / 删除（`NieRModal` 二次确认）逐行 PUT / DELETE；
      **排序只改草稿** —— 上移 / 下移零请求，点「保存顺序 SAVE ORDER」才按草稿
      **只 PUT `sort_order` 真变化的行**（后端无批量排序端点），「放弃 REVERT」零调用重拉。
    - **新增 3 个文件**：`frontend/src/pages/RoutingRules.jsx`、
      `frontend/src/utils/routingView.js`（7 个纯函数，逐个有专测）、
      `frontend/src/api/routing.js`（`/routing-rules` 五方法，PUT 是整体替换恒六字段）。
    - **接缝四处**：`api/index.js` barrel、`pageStatus.json` **第 9 条**（key `path`
      快捷键 `H`，数组序 = 侧栏序）+ `npm run sync:page-status`、`routeChunks.js` 载入器、
      `App.jsx` `case 'routing'`（只注入 `instructions`，不写共享状态）。
      前三处由 `pageRegistry` / `routeChunks` 既有测试互钉（键集与载入器集同集的断言
      R35 就挂好了，忘登记即红）；**`App.jsx` 的 case 无自动化测试** —— 漏写即静默回落
      `/protocol`，**本批实机冒烟已验**（直达 `GET /routing` 渲染本页未回落；建规则 →
      下移（**后端仍 0/1 = 草稿期零请求**、界面 `● 2 条顺序待保存`）→ 保存顺序（后端变
      `beta=0/alpha=1`、`更新 2 条 · 未变 0 条`）→ 删除（确认前未发 DELETE、确认后软删进
      回收站中文名正确），冒烟数据已清）。
    - **测试（红测先行有据，两档记账）**：实现前 4 个文件全红 —— 3 个新测试文件
      `Failed to resolve import`（模块不存在）、注册表断言 `undefined to be '/routing'`，
      **红因全部 = 缺特性本身**；落实现后翻 1 条**测试自身 bug**（`renderPage` 辅助写死
      等某一行 → 空态列表里没有该行 → 改等恒存在的表头计数）**先修再算数**；
      另有 1 处**落笔自查改正**（顺序脏计数初稿断言 `1`，两行换位实为两行要写 → 改 `2`，
      该断言在红跑里因模块不存在从未执行到，不计红）。
    - **验收**：**FE 1365 → 1405/1405（+40 = 7 api + 21 routingView + 11 页面 + 1 注册表）**、
      **BE 1002/1002**（零 BE 改动复跑）、`npx vite build` EXIT=0、`npm run lint` EXIT=0、
      yorha-ui 校验器 **11 个改动文件 0 违规**、md 表列数 mismatches = 0；
      产物 **9 个页面 chunk**（`RoutingRules` 15.67 kB），首屏 `index` 仍无 >500kB 警告
      （R35 拆包前提未被破坏）。
    - **文档同步（同批）**：PLAN **§8.70 新节** + §1 新增 `R38` 行 + §8.68 一 改 4 批 /
      八 留白改指 + §8.69 拆批表与留白改指 + §8.67 的「`PAGE_REGISTRY` 8 页」改计数无关措辞
      + 两处拍板表改「R38 ✅ / R39 待排」；`BUSINESS_SCENARIOS` 72 / 91 两行改指；
      本条 + 目录地图改 `api/` / `App.jsx` / `routeChunks.js`（8 页 → 9 页）/
      `pageStatus.json` 四行并补 `RoutingRules.jsx` / `routingView.js` 两行。
    - **状态**：**R38 ✅ —— 规则第一次能在页面上被建出来、排序出来、停掉、删掉。**
      **明确留白**：加工页自动选指令接线（**R39 已落地 ✅ §8.71**）；规则页「试解析」入口
      （**R40 已落地 ✅ §8.72，见第 89 条**）；`byte_order` trim 归一（§8.66 留白）不涉。
      提交 = `feat(R38)` 单笔（**纯 FE · 零 DDL** → 无 Migration、无 `chore(db)`）。

88. **R39 · 发前路由 · 加工页接线（路由输入 → 命中即选指令 + 一键回退；PLAN §8.71 · 2026-10-06）**
    - **为什么**：R36 给了数据层答案、R37 补了删改的数据完整性、R38 把规则摆上页面 —— 但
      **「换指令」这个动作一直没落地**，规则建得出来却没人用它。R39 是四批里唯一**改变执行
      行为**的一批，因此按 §8.69 / §8.70 的拆批理由，**验收面 = 实机冒烟**（红测只能证明
      「调了什么、显示了什么」，证不了「真把指令切过去了」）。**纯 FE、零 DDL、零 BE 改动**
      （`POST /dispatch/routed` R36 就绪）。
    - **接线三块**：① `api/dispatch.js::resolveRoute(inputs)` → `POST /dispatch/routed`
      （体恒 `{ inputs }`；回执六键与 `/dispatch` 缺省三键**不重叠**，重叠即串端点）+
      barrel；② 新纯逻辑层 **`utils/routeResolve.js`**（行增删改 · 值类型解析 ·
      回执 → 中文事实文案四档 · 目标指令不在册时补进列表**已在册返回原引用**），零依赖
      无环、逐个有专测；③ `InstructionProcessor.jsx` 加**「路由输入 (ROUTE INPUTS)」条**
      （扁平键值行 + 类型徽标 + `解析 RESOLVE` + 状态条 + 收起/展开让位），**命中即
      `setActiveInstructionId` 选中 + `回到上一条 (UNDO)` 一键回退**，无命中按回执
      `matched=false` **不猜、维持现状**，失败出 `ERR:` 事实文案。
    - **冒烟抓到的类型缺口（本批最重要的一条）**：R36 的后端测试写的是
      `resolve_route({"meter_id": 1}, …)` **整数**，而加工页输入框只可能给**字符串**；
      条件里的 `0001` 是**数字字面量**，`core/condition._equal` 对**数字 vs 字符串抛错**
      → `resolve_route` 当普通不命中吞掉 —— **数字条件与全部数值比较符 `> < >= <=`
      从页面侧静默失效**。定的口径 = **值按 JSON 标量解析**（`0001` → 数字 1、
      `"0001"` → 字符串 0001、其余按原文串），键去空白、空键行整行不发；顶栏提示语写明
      这条规则、**每行出类型徽标**（`空` / `数字` / `字符串`）当场写明会按什么发。
      不做类型下拉 —— 多一列控件换不来更多信息。
    - **渲染条件改判**：`activeInstructionId` → **`currentInstruction`**（回执给了 id 却
      查不到指令时落空态，而非拿 `null` 渲染 `InstructionRunner` 崩掉）；正常路径分支
      不可达，行为逐字不变。顺手**移除一条随组件变大而失效的 `eslint-disable`**
      （v7 编译器分析不再报该点 → 判 unused 新引入 1 条 warning），lint 回 **0 问题**，
      解释注释原样保留。
    - **新增 1 个文件**：`frontend/src/utils/routeResolve.js`；改 3 个
      （`api/dispatch.js`、`api/index.js`、`pages/InstructionProcessor.jsx`）。
    - **测试（红测先行有据，两档记账）**：实现前 3 个文件全红 —— `../routeResolve`
      **未解析** / `resolveRoute` **不是函数** / 面板元素**不存在**，**红因全部 = 缺特性
      本身**（同一轮 23 条既有用例全绿）；落实现后翻 **2 条断言随类型语义改写**
      → **测试随新事实改写**；本批**无**「测试自身 bug」这一档。
    - **实机冒烟 8 组**：面板常驻 → 键值去空白**命中切指令**（`ID` 由 `SAMPLE-INST-HEARTBEAT`
      → `SAMPLE-INST-STATUS`）+ 事实文案 + UNDO 回退 → 无命中**不切不出回退** →
      `0001` 按数字中、按字符串不中、`"0001"` 按字符串中（**类型语义双向验证**）→
      加行 / 删行 / 收起 / 展开；控制台 0 error，冒烟规则软删 + 彻底清除（规则 0 条）。
    - **验收**：**FE 1405 → 1445/1445（+40 = 27 纯逻辑 + 6 api + 7 页面）**、
      **BE 1002/1002**（零改动复跑）、`npx vite build` EXIT=0、`npm run lint` EXIT=0
      **且 0 warning**、yorha-ui 校验器 **7 个改动文件 0 违规**、md 表列数 mismatches = 0；
      **零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、无新 pip 依赖、
      `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径未动**。
    - **文档同步（同批）**：PLAN **§8.71 新节** + §1 新增 `R39` 行 + §8.68 一 批次切分与
      八 留白改指 + §8.69 八 留白与拆批表改指 + §8.70 六 留白改指（**规则页「试解析」
      明写仍留白**）+ 两处拍板表改「R39 ✅」；`BUSINESS_SCENARIOS` 72 / 91 两行改指；
      本条 + 目录地图改 `InstructionProcessor.jsx` / `api/dispatch.js` / `api/index.js`
      三行并补 `utils/routeResolve.js` 一行。
    - **状态**：**R39 ✅ —— 「按输入挑指令」第一次在页面上被真正执行，并且能一键退回。**
      **明确留白**：规则页「试解析」入口（§8.70 六）→ **R40 已落地 ✅ §8.72，见第 89 条**；
      输入表不做持久化（本仓前端零 `localStorage` 先例，不为此新引落盘样式）；`byte_order`
      trim 归一（§8.66 留白）不涉 → **R42 已落地 ✅（§8.74）**；规则表仍不在数据中心 8 域清单
      → **R44 已落地 ✅（§8.76，8 域 → 9 域）**。
      提交 = `feat(R39)` 单笔（**纯 FE · 零 DDL** → 无 Migration、无 `chore(db)`）。

89. **R40 · 发前路由 · 规则页试解析（键值 → 看会命中哪条；PLAN §8.72 · 2026-10-07）**
    - **为什么**：§8.70 六 与 §8.71 七 **两处同挂**的那条留白正主 —— R38 建页时就登记了
      「在规则表上就地输一条输入 → 看会命中哪条 / 为什么没命中」，R39 只把接线落在加工页。
      四批闭环后规则作者仍处在「**写完规则没法验**」的状态，只能等真发送才知道挑中哪条。
      **纯 FE、零 DDL、零 BE 改动**（`POST /dispatch/routed` 自 R36 起就是只解析不发送的
      只读端点，命中 / 扫描数 / 结构性缺陷**后端全都给了**，本批只做入口与转写）。
    - **改动四块**：① `utils/routeResolve.js` 新增 **`describeDryRun(res)`** →
      `{ matched, headline, rows }`，`rows` **恒四行**（命中规则 / 目标指令 / 参与扫描 /
      缺陷跳过）；② 新共用组件 **`components/RouteInputTable.jsx`**（两页扁平键值行表的
      **唯一排版实现**：键值框 + 类型徽标 + 行删除，**边界划在排版** —— 不持状态、不发请求、
      不渲染「+ 添加」按钮）；③ `RoutingRules.jsx` 页底 `试解析 (DRY RUN)` 面板（行表 +
      按钮 + SYS/ERR 一行事实 + `<dl>` 四行结果表 + 未命中脚注）；④
      `InstructionProcessor.jsx` 内联行表换成 `<RouteInputTable>`（DOM 与 `aria-label` /
      `testid` **逐字节不变**，删掉随之多余的三个 import）。
    - **文案断在「命中 / 无命中」**：同一份回执的**另一种动作语境** —— 加工页真会切指令
      （`describeResolve` 写「已切到指令…」），规则页试解析**一行状态都不改**，绝不能复用那句，
      否则就是谎称这页也切了。`considered` / `invalid` **由后端给，FE 不自己数**；`invalid`
      非空挤进 `缺陷跳过` 一行、**不进 headline**（一句只说一件事）。
    - **事实边界写死**：后端只看得见已落库的行 → 口径行**常驻**「按已保存的规则计算（表单与
      顺序的未保存改动不参与）」（**不推断**用户此刻改没改东西，推断错就是撒谎），顺序有草稿时
      当场亮 `N 条顺序待保存 —— 试解析按已落库顺序计算`（琥珀条，缺这句会对着旧顺序的答案推新
      顺序），右栏固定「只回显结果 —— 不选中规则、不改表单与顺序」。
    - **为什么抽组件**：第二张行表若抄一遍，类型徽标 / 空键不发 / 删到只剩一行禁删三条细口径就有
      两个出处。三件事保零回归：`idPrefix` / `labels` **默认值即加工页原文**、`+ 添加` 按钮
      **留页面**（两页按钮视觉语言不同）、**R39 那 13 条既有用例一次不改全绿 = 抽取没改行为**。
    - **文件（12 个）**：**新增 3 个** —— `components/RouteInputTable.jsx` + 两个测试文件
      （`utils/__tests__/routeResolve.dryrun.test.js`、`pages/__tests__/RoutingRules.dryrun.test.jsx`）；
      **改 5 个代码 / 配置** —— `utils/routeResolve.js`、`pages/RoutingRules.jsx`、
      `pages/InstructionProcessor.jsx`、`pages/__tests__/RoutingRules.test.jsx`、
      `config/pageStatus.json`；**改 4 个 md** —— 本条、`docs/PLAN_Backlog.md`、
      `docs/BUSINESS_SCENARIOS.md`、`docs/PAGE_STATUS.md`（重生成）。
    - **测试（红测先行有据，两档记账）**：实现前 **2 个新文件 13 条全红** —— 7 条
      `describeDryRun is not a function` + 6 条面板 / 按钮 / 结果表**不存在**，
      **红因全部 = 缺特性本身**，**无一条**属「测试自身 bug」；落实现后翻 **1 条既有用例随
      新事实改写**（`findByText(/2 条顺序待保存/)` 撞上新琥珀条**同子串** → 断言收窄到顺序条
      原文 `^● 2 条顺序待保存$`，是**收窄不是放水**）。
    - **实机冒烟 8 组**：面板常驻（未跑不出结果行）→ 键值去空白命中 + 徽标 `数字` + 四行表 →
      无命中两行 `（无命中）` + 三类原因脚注 → 值 `"0001"` 字符串对数字条件**仍不中**（类型
      语义从规则页同样可见）→ 加行 / 删行 / 只剩一行 × 禁用 → 顺序草稿琥珀条出与消 →
      **回 `/processing` 解析命中切到「示例状态包」（抽取后 R39 回归）** → `/routing`
      控制台 **0 error 0 warning**（`/processing` 仅 3 条既有 `response-specs/{id} 404 =
      未配置常态`，与本批无关），清场后规则 0 条、回收站 `routing_rule` 0 条。
    - **验收**：**FE 1445 → 1458/1458（+13 = 7 纯逻辑 + 6 页面）**、**BE 1002/1002 持平**
      （零 BE 改动复跑）、`npx vite build` EXIT=0、`npm run lint` EXIT=0 **且 0 warning**、
      yorha-ui 校验器 **8 个 js / jsx / json 文件 0 违规**（**md 不在校验器口径内** ——
      `PLAN_Backlog.md` / `PROJECT_HANDOVER.md` 里 34 条历史 CSS 字样 **HEAD 版本同样 34 条、
      逐条相同**，本批零新增；R38 的「11 文件」、R39 的「7 文件」同为 js / jsx / json 口径）、
      md 表列数 mismatches = 0；
      **零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、无新 pip 依赖、
      `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径未动**。
    - **文档同步（同批）**：PLAN **§8.72 新节** + §1 新增 `R40` 行 + §8.70 六 留白改指
      （试解析 → R40 ✅，并记「逐条判定轨迹另议」）+ §8.71 七 留白改指 + 两处拍板表改
      「R40 ✅」+ §8.68 前「立项前现状快照」补一条销项注 + §8.72 八 补「文档同步（同批）」段；`BUSINESS_SCENARIOS` **8 处过期说法就地纠正** —— 72 / 91 两行改指 R40 +
      47 / 48（「全库无 presence」「无 presence 概念 🔴」→ N3 已落地）+ 49（pad 🔴 → N5 ✅
      G4）+ 62（R28 解包「待排」→ §8.60 已落地）+ 73（解码回程 ⏸ → R9 + R10 ✅）+ 头注
      「仍暂缓」块与挂账第 4 条尾巴 → **§8.14 四项暂缓 / 挂账四项均清零**；
      `pageStatus.json` **两页**
      （规则页补 `availableNow` 试解析条 + `nextSteps` 换成 trace 留白；加工页**补登记**
      R39 漏登的「路由输入」条）+ `npm run sync:page-status` 重生成 `PAGE_STATUS.md`；
      本条 + 目录地图改 `InstructionProcessor.jsx` / `RoutingRules.jsx` / `routeResolve.js`
      三行并补 `RouteInputTable.jsx` 一行；顺手修第 85 条里残留的「R39（待排）」。
    - **状态**：**R40 ✅ —— 规则作者第一次能在页面上验自己写的规则，而不必等一次真发送。**
      **明确留白**：**逐条规则的判定轨迹（trace）** 给不出「每条规则为什么没成立」—— 要给
      `POST /dispatch/routed` 回执加 `trace` 字段，属 **BE 契约改动**（现有逐键断言测试要随新
      事实改写），**另议排批** → **R43 已落地 ✅（§8.75）**；输入表不做持久化；`byte_order` trim 归一（§8.66） → **R42 已落地 ✅（§8.74）**；
      规则表仍不在数据中心 8 域清单 → **R44 已落地 ✅（§8.76）**。
      提交 = `feat(R40)` 单笔（**纯 FE · 零 DDL** → 无 Migration、无 `chore(db)`）。

90. **R41 · 文档卫生（过期指路清零；PLAN §8.73 · 2026-10-07）**
    - **为什么**：R1–R40 **全部排批且全部落地**之后，登记面上还残留**指向未来批次的标记** ——
      不是功能缺口，是**读账会读错**：`pageStatus.json` `nextSteps` 仍写「下一批 R23（epoch …），
      排期见 §8.52」（R23 早在 2026-10-03 完成）、「余下仅设备档案自定义排序（→ R20，`sort_order`
      DDL 已由用户拍板解禁）」（R20 同日完成）；PLAN §1 `R21–R28` 行首仍 🔄（该行**八个子批
      状态格本就全 ✅**）；三处留白小节**标题**的「→ R3x」没跟上**正文已逐条标的 ✅**；本条前
      一条（85）同段体例标了 R37 / R38 却**漏 R39**（R39 早已销）。
    - **改动 8 处（3 个文件）**：`pageStatus.json` 2（`/protocol` R23 改指 §8.55、`/datahub`
      R20 改指 §8.50 并记「本页 nextSteps 无余项」）+ `docs/PLAN_Backlog.md` 4（§1 行首
      🔄 → ✅；§8.68 八 / §8.69 八 / §8.70 六 三个标题括注各补 ✅）+ 本文件 2（条目 85 补
      「加工页自动选指令接线**已由 R39 销掉 ✅（§8.71）**」、条目 86 括注补 ✅）。
      **条目 87 本就已标 R39 ✅ / R40 ✅，不动**。
    - **判断口径（免得下批又翻一遍）**：**只改声明当前状态的登记面**（`nextSteps` / §1 状态格 /
      留白小节标题 / 条目状态句）；**各节尾注「下一批 → Rx」与各条同步清单里的「待排」复述
      = 当批的排期快照**，历史留档、原样不动 —— 改了才是造假。
    - **文件（4 个）**：**改 3 个 md / JSON** —— 本条、`docs/PLAN_Backlog.md`、
      `config/pageStatus.json`；**改 1 个 md** —— `docs/PAGE_STATUS.md`（重生成）。
      **零代码改动** —— `backend/` 与 `frontend/src/` 下代码一字未碰（改的只是配置里的两串
      `nextSteps` 文案）。
    - **测试**：**无红测** —— 本批零代码改动，红测先行的口径不适用（R11 §8.49 文档批同款）。
    - **验收**：**FE 1458/1458 持平**、**BE 1002/1002 持平**、`npx vite build` EXIT=0、
      `npm run lint` EXIT=0 **且 0 warning**、yorha-ui 校验器 **1 个 json 文件 0 违规**
      （md 不在校验器口径内 —— 34 条历史 CSS 字样 **HEAD 版本同样 34 条、逐条相同**）、
      md 表列数 mismatches = 0、`ev33` STAGED=0 BAD=0；**零 DDL → 无 Migration、
      无 `chore(db)`**、不引 pytest、无新 pip 依赖、`processor.py` / `graph.py` /
      `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径未动**。
    - **文档同步（同批）**：PLAN **§8.73 新节** + §1 新增 `R41` 行 + 上述 4 处改写；
      `pageStatus.json` 两处 + `npm run sync:page-status` 重生成 `PAGE_STATUS.md`；本条插入。
    - **状态**：**R41 ✅ —— 登记面不再有指向未来批次的过期断言，历史排期快照原样留档。**
      **明确留白**：校验器 **md 口径**（34 条历史 CSS 字样要让 md 过检须二选一 —— 改写史实
      措辞，或给校验器 md 规则加白名单；后者改**仓外** `~/.agents/skills/yorha-ui`）**另议**
      —— **→ R48 已落地 ✅（2026-10-07，见条目 97 / PLAN §8.80）**：两条**都没走**，取第三条路
      （md 扫描面收窄到**围栏代码块**），史实措辞一字未改、白名单一个没建；
      输入表持久化 —— 不涉（**规则 trace** 已由 **R43 ✅ §8.75** 收掉、**规则表进 8 域清单**
      已由 **R44 ✅ §8.76** 收掉、**`byte_order` trim 归一**已由 **R42 ✅ §8.74** 收掉，
      三条都不再是留白）。
      提交 = `feat(R41)` 单笔（**零代码 · 零 DDL** → 无 Migration、无 `chore(db)`）。

91. **R42 · `byte_order` trim 归一（FE 单点判据；PLAN §8.74 · 2026-10-07）**
    - **为什么**：R34 在 §8.66 七 留白里明写「**不引入 trim 归一**」，理由是「UI 下拉产不出
      带空白的值，两端在可达输入上本就同判」—— 这个理由**只覆盖下拉这一个入口**：值照样能由
      **导入 / API 直写**进来（冒烟就是 `POST /protocols/` 直写 ` LITTLE `）。而 BE
      `handlers/base.py::byte_order_of` 从 R21 起就是 `str(order).strip().lower()`，它的
      docstring 还写着「与 FE `.trim().toLowerCase()` 同口径」—— **那句在 FE 侧从来不成立**：
      FE 三处谓词只有 `validateProtocol` 的 W5 一路带 `.trim()`。于是同一个 `' LITTLE '`
      会**卡面判大端、后端判小端**。
    - **改动（4 个 js，1 新增 + 3 接线）**：新增 **`frontend/src/utils/byteOrder.js`**
      （`normalizeByteOrder` = `String(raw ?? '').trim().toLowerCase()`、
      `isLittleByteOrder` = 归一后只认 `little`，其余含枚举外 fail-open 回大端，逐字对齐
      `byte_order_of`；**只归一不判枚举**，W5「在枚举内才不报」语义不变）+ 三处接线：
      `protocolTree.js`（checksum `isLittleOrder` 两个计算点共用 + length 分支就地谓词）、
      `toFrameBlocks.js`（出口翻译闸门 `withLogicParams`）、`validateProtocol.js`（W5 收敛）。
    - **范围钉死（按 §8.66 留白原文）**：只管 FE 谓词 + 卡面 / 出口翻译 / W5 四处；
      **收侧 `response_match` / `sequence_plan` 零改动**（fail-closed 不动）；指令域
      `endianness`（E1-2 B6）另一域不并入；`pc.encoding` 不 trim（未登记，超范围）。
      **为什么新增单点而非就地加 3 个 `.trim()`**：对齐 BE `byte_order_of` 的单点判据纪律，
      并坐实它 docstring 那句「同口径」—— R42 之前不实、R42 起才成立。
    - **文件（12 个）**：**改 8 个 js** —— `utils/byteOrder.js`（**新**）、`utils/protocolTree.js`、
      `utils/toFrameBlocks.js`、`utils/validateProtocol.js` + 4 个测试
      （`utils/__tests__/byteOrder.test.js` **新**、`protocolTree.test.js`、
      `toFrameBlocks.test.js`、`validateProtocol.test.js`）；**改 4 个 md / JSON** —— 本条、
      `docs/PLAN_Backlog.md`、`config/pageStatus.json`、`docs/PAGE_STATUS.md`（重生成）。
      **零 BE 改动**（`byte_order_of` / `frame_builder` / `response_generate` 本就 `.strip()`）。
    - **测试**：红测先行 —— 新建 `byteOrder.test.js` **3 条整文件加载即红**（被测模块不存在）
      + **3 条行为锚红**（`protocolTree.test.js` length `' LITTLE '` 期望 `06 00` 实得 `00 06`、
      checksum `' little '` 期望 `37 4B` 实得 `4B 37`、`toFrameBlocks.test.js` params 未写键）
      —— **红因 3 档全为「缺特性」**，无一条属测试自身 bug；`validateProtocol.test.js` 2 条
      （`' LITTLE '` 不报 W5）**实现前就绿**（W5 原生带 `.trim()`，属已有特性，不冒充红测）。
      顺手改写 1 条既有测试注释（原「不额外引入 trim」已失效），**原断言一字未动仍绿**。
    - **验收**：**4 文件 105/105（+6）**、**FE 全量 1464/1464（95 文件，+1/+6）**、
      **BE 1002/1002 持平**（零改动）、`npx vite build` EXIT=0、`npm run lint` EXIT=0
      **且 0 warning**、yorha-ui 校验器改动 **9 个 js / json 文件 0 违规**（8 js + 1 json）、md 表列数
      mismatches = 0、`ev33` STAGED=0 BAD=0；**零 DDL → 无 Migration、无 `chore(db)`**、
      不引 pytest、无新 pip 依赖、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、
      **`/dispatch` 缺省口径未动**。
    - **实机冒烟（后端 8055 + dev 5174）**：`POST /protocols/` 直写 `byte_order=' LITTLE '`
      （length × 1 + checksum × 1）与净值对照 `'little'`，后端**原样保留**脏值 → 卡面
      `G(脏)` = `06 00`、`G2(净)` = `06 00`、`G3(脏校验)` = `FF 2E`（**修复前不 trim 判 big
      → `00 06`**）；属性面板「⚠ 3 提醒」展开**三条全是既有的「HEX 与字节长度不一致」，
      无一条 W5**（`BYTE_ORDER_UNKNOWN` 未报）；控制台 **0 error 0 warning**；
      清场 `DELETE /protocols/{id}` + `DELETE /trash/protocol/{id}` 后**回收站 0 条**。
    - **文档同步（同批）**：PLAN **§8.74 新节** + §1 新增 `R42` 行 + **§8.66 七 销项注** +
      **7 处留白改指**（§8.67 七 / §8.68 七 / §8.69 八 / §8.70 六 / §8.71 七 / §8.72 八 /
      §8.73 三 的「`byte_order` trim 归一不涉」→ **R42 ✅ §8.74**）；本条插入 + 目录地图补
      `byteOrder.js` 一行；`pageStatus.json` 相关页补记 + `npm run sync:page-status`
      重生成 `PAGE_STATUS.md`。
    - **状态**：**R42 ✅ —— 同一个 `byte_order` 值，卡面、出线、W5、后端四方判成同一个
      字节序。** **明确留白**：收侧 `response_match` / `sequence_plan` 不碰（fail-closed
      本就支持）；指令域 `endianness` 不并入；`pc.encoding` 不 trim。
      提交 = `feat(R42)` 单笔（**纯 FE · 零 DDL** → 无 Migration、无 `chore(db)`）。

92. **R43 · 规则 trace（逐条判定轨迹；PLAN §8.75 · 2026-10-07）**
    - **为什么**：R40 把试解析做到了回执级，但 **比较不成立 / 变量不在输入 / 类型不可比，三者在回执里
      同为 `matched=false`** —— 规则作者只看得到「无命中」，说不出**自己那一条**卡在哪一类；规则攒到
      五条以上，「扫过 3 条都不成立」基本没法定位。这条留白在 **§8.72 八（R40）与 §8.73 三（R41）
      两处同挂**，原文已把做法写死：给 `POST /dispatch/routed` 回执加 `trace` 字段，属 **BE 契约改动**。
    - **契约**：`RouteResolveResponse` 新增 `trace: List[RouteTraceEntry]`，**定序全序、一行一条规则**，
      五键 = `id` / `name` / `condition` + 后端给的 `code`（机器码）+ `detail`（事实载荷：变量名 /
      两个类型名 / 语法错误原文，可空）。**九种码** = `core/routing.TRACE_CODES` 八种（`MATCHED` /
      `COND_FALSE` / `VAR_UNDEFINED` / `TYPE_INCOMPARABLE` / `COND_ERROR` / `CONDITION_INVALID` /
      `DISABLED` / `NOT_EVALUATED`）+ `resolve_route` 静态跳过补的 `INSTRUCTION_MISSING` ——
      `select_rule` 根本看不见悬空规则（进不了 `usable`），所以那张表里没有它，FE `TRACE_LABELS`
      是它的**超集**，两处注释都写明了这层不对称。
    - **只记录不判定**：判据仍是 `backend/core/condition.py` 一处，FE `utils/routeResolve.js` 连条件求值
      都不做。`select_rule` 由四键变五键 —— 命中即 `return` 改成「记一行 `MATCHED` 后置 `stopped`、
      走完循环只补 `NOT_EVALUATED`」，尾部规则**不 parse、不求值、不累加 `considered`**；停用与解析期
      坏掉两处的裸 `continue` 改成「跳过并记一行」；**回收站行仍直接跳过不记**（列表页本就看不见）；
      `matched` / `rule` / `invalid` / `considered` 四键逐字未改。**中文文案归 FE**
      （`TRACE_LABELS` + `traceReasonText`），但 `detail` **不许 FE 自己从条件里抠** —— 那是
      `condition.py` 抛出来的事实。
    - **文件（9 个）**：**改 4 个 BE** —— `backend/core/routing.py`（`TRACE_CODES` /
      `EVAL_CODE_PREFIXES` / `_eval_code` / `_trace_row` / `select_rule` 五键）、
      `backend/schemas/routing_api.py`（新增 `RouteTraceEntry` + `trace` 字段）、
      `backend/routers/routing.py`（两层按同一定序并表）、`backend/tests/test_routing.py`；
      **改 5 个 FE** —— `frontend/src/utils/routeResolve.js`、`frontend/src/pages/RoutingRules.jsx`、
      `frontend/src/api/dispatch.js` + 2 个测试文件（`utils/__tests__/routeResolve.dryrun.test.js`、
      `pages/__tests__/RoutingRules.dryrun.test.jsx`）。**零 DDL** → 无 Migration、无 `chore(db)`、
      不引 pytest、无新 pip 依赖、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、
      **`/dispatch` 缺省口径未动**。
    - **测试**：红测先行 —— BE 新增 **13 条**（`SelectRuleTraceTest` 6 + `EvalCodePrefixTest` 2 +
      `ResolveRouteTraceTest` 5），实现前 **12 红**（`KeyError` / `AttributeError` / `ImportError` /
      断言缺 `trace`）；FE 新增 **8 条**（`routeResolve.dryrun` 4 + `RoutingRules.dryrun` 4），
      实现前 **6 红**（`describeDryRun().trace` 为 undefined、页面查无 `dry-trace-0`）——
      **红因 18 条全为缺特性**；余下 2 条护栏实现前就绿（当时本就没有轨迹块），**不冒充红测**。
      `EvalCodePrefixTest` 还从分类侧反向钉住 `ConditionError` **文案前缀**漂移（漂移会静默退化成
      兜底码，两条测试一红就能叫出来）。
    - **三档记账**：**随新事实改写 3 条** —— BE `test_empty_ruleset` 四键全等补 `trace: []`、
      FE 两条完整形状 `toEqual` 各补 `trace: []`（`matched` / `headline` / `rows` 逐字未动，不是放水）；
      **测试自身 bug 先修 2 条** —— 红批里写的两条页面护栏用 `/逐条判定轨迹/` 做**否定**断言，撞上
      同批新加的**口径列表同名词**，改成锚到结果区标题 `/逐条判定轨迹 \(TRACE\)/`；其余为缺特性档。
    - **验收**：**BE 1002 → 1015/1015（+13）**、**FE 1464 → 1472/1472（95 文件，+8）**、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0 **且 0 warning**、yorha-ui 校验器改动
      **6 个 js / jsx / json 文件 0 违规**（5 js / jsx + 1 json）、md 表列数 mismatches = 0、`ev33` STAGED=0 BAD=0；
      **零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、无新 pip 依赖、
      `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径未动**。
    - **实机冒烟（后端 8055 + dev 5174）**：5 条规则各占一类（`sort_order` 0..4），悬空那条用
      **直接改库软删指令**造（`DELETE /instructions/{id}` 会级联软删规则，页面上留不下悬空行 ——
      该分支本就只来自直改库 / R37 之前的旧行）。`meter_id=999` → `considered=3`、轨迹
      `COND_FALSE` / `VAR_UNDEFINED(detail=line)` / `DISABLED` / `INSTRUCTION_MISSING` /
      `COND_FALSE`；`meter_id=1` → `matched=true`、`considered=1`、#1 `MATCHED`、其后
      `NOT_EVALUATED`（#4 仍 `INSTRUCTION_MISSING`，与 `invalid` 无条件收录它的既有口径一致）。
      页面「缺陷跳过」由 `规则「…」：INSTRUCTION_MISSING` 变成
      **`规则「R43 smoke dangling」：目标指令不在册`**；`逐条判定轨迹 (TRACE) · 5 条`、
      `dry-trace-0..4` 五个 testid 齐、`MATCHED` 行黄字；控制台 **0 error 0 warning**；
      清场后规则表回原状、**回收站 0 条**，8055 / 5174 两个后台壳已停。
    - **文档同步（同批）**：PLAN **§8.75 新节** + §1 新增 `R43` 行 + §8.70 六 / §8.73 三
      两处 trace 留白改指；本条插入 + 条目 89 / 90 两处留白改指（顺带把条目 89 里 R42 那句
      「不涉」一并改指）+ 目录地图改 `routeResolve.js` / `RoutingRules.jsx` 两行；
      `pageStatus.json` `/routing` 补记 + `npm run sync:page-status` 重生成 `PAGE_STATUS.md`。
    - **状态**：**R43 ✅ —— 规则作者第一次能逐条读到「为什么不命中」，而不必逐条去猜。**
      **明确留白**：**加工页不加轨迹**（同一份回执，但那边是「命中即切」的动作语境，一行事实已够）
      → **R45 已落地 ✅（2026-10-07，§8.77）**；
      **不为「数值 / 字符串互换」单独开码**（`TYPE_INCOMPARABLE` 的 `detail` 已带出两个类型名，
      再细分是文案不是判据）；输入表持久化仍不涉；规则表进 8 域清单 → **R44 已落地 ✅（§8.76）**。
      提交 = `feat(R43)` 单笔（**BE+FE · 零 DDL** → 无 Migration、无 `chore(db)`）。

93. **R44 · 规则表进数据包（`routing_rules` 第 9 域；PLAN §8.76 · 2026-10-07）**
    - **为什么**：R7 拍板「原 3 域 → 8 域」时**刻意不含规则表**，留白原文「若要随数据包迁移
      另议，不擅自扩域」在 §8.70 六 / §8.71 七 / §8.72 八 / §8.73 三 / §8.75 七 **五处同挂**。
      R36–R43 四批把规则做成了可建、可排序、可试解析、可读轨迹的实体，却**换不了机** ——
      别的域一个 ZIP 就走，唯独规则只能一条条手抄。**2026-10-07 question 工具回执拍板**选
      此项（同批候选：输入表持久化 / 校验器 md 口径 / 暂不排批）。
    - **它现在怎么解决**：**8 域 → 9 域** —— `ROUTING_RULES_SCHEMA_VERSION = 1` 入
      `BUNDLE_DOMAIN_VERSIONS` **排末尾**（前面 8 域的相对导出序一个字节没动），
      `GET /datahub/export/bundle` 多出 `routing_rules.json`，`manifest` 的 `domainVersion` /
      `domainCounts` 各多一键（纯函数里的 `ValueError: 域清单不一致` 漂移守卫**顺带把 counts 表
      也钉住**），新端点 `POST /datahub/import/routing_rules` 与既有五个按域导入端点同形
      （顶层校验 400 不落快照 → `pre-import` 快照 → 逐行提交）。
    - **四条口径全部镜像既有纪律、没有一条是新造的**：① 只出活行，`created_at` /
      `updated_at` / `deleted_at` **三个记账列不进包**（时间戳是机器本地记账不是内容 ——
      进包即导出可 diff，回灌用目标机时钟，也不搬源机回收站状态）；② **行序 = 匹配顺序**
      `(sort_order, name, id)`，即 `core/routing.py` 定序键，**排序收在
      `routing_rules_export_payload` 一处**、调用方传进来的顺序不作数（导出与匹配两处各排一次序
      迟早分叉）；③ **条件语法交 SSOT** `core/condition.parse_condition`（规则页保存侧同一入口），
      **目标指令必须是活行** → 缺失单行跳过（镜像 `import_sequences`「宿主缺失整条跳过」——
      `routing_rules` 不加 FK，直接 upsert 等于亲手写出一条一进包就是 `INSTRUCTION_MISSING`
      的缺陷行，而 R43 刚把那一档标成「只能直改库造出来」）；④ 名称唯一**查全表含回收站占名**
      （同 `routing._ensure_name_free`）、`id` 自己在站 → 跳过并提示先恢复或彻底删除。
      `sort_order` / `enabled` 为**可选行字段**（在场必须合法、`bool` 不算数；缺席则建行取
      0 / 1、改行保留目标库已有的值，镜像 R20 `profiles.sort_order`）。
    - **文件（6 个）**：**改 3 个 BE** —— `backend/routers/datahub.py`（`ROUTING_RULES_SCHEMA_VERSION`
      / `routing_rule_export_row` / `routing_rules_export_payload` / `bundle_manifest` counts /
      `routing_rules_rows` / `import_routing_rules` / `export_bundle` 接线 /
      `/import/routing_rules` 端点）、`backend/tests/test_datahub.py`、
      `backend/tests/test_datahub_bundle_domains.py`、**新增 1 个 BE**
      `backend/tests/test_datahub_routing_rules.py`；**改 2 个 FE** —— `frontend/src/pages/DataHub.jsx`
      + `frontend/src/pages/__tests__/DataHub.test.jsx`。**零 DDL** → 无 Migration、无 `chore(db)`、
      不引 pytest、无新 pip 依赖、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、
      **`/dispatch` 缺省口径未动**。
    - **测试（红测先行有据）**：BE 新增 **18 条**，实现前 **18 红** ——
      `AttributeError`（四个符号不存在）+ `AssertionError`（`routing_rules` 不在清单）+
      `KeyError`（manifest counts 少一域）+ `400 未知域：routing_rules`（`domains=` 子集选不到）
      + `routing_rules.json not found`（ZIP 里没有），**红因全为缺特性**。FE 用 **`git stash`
      只暂存实现文件**取回实现前状态跑 `DataHub.test.jsx` → **5 failed / 14 passed**（1 条 R44 新测
      = 缺特性，4 条 = 随新事实改写的断言对旧实现红），还原后两次全量全绿。
    - **三档记账**：**缺特性 19 条**（BE 18 + FE 1）；**测试随新事实改写 9 条** —— BE 5
      （`test_eight_domain_inventory` → `test_nine_domain_inventory` 的清单与 `len 8→9`、
      `test_counts_and_legacy_keys` 的 counts 表补键、`test_zip_carries_eight_domains` →
      `test_zip_carries_nine_domains` 补文件与计数、bundle_domains 的
      `default_is_still_the_full_*` 与 `explicit_all_*` 两处更名）+ FE 4（芯片清单与顺序注释、
      全量导出文案、示例包数组、域键识别用例）；**测试自身 bug 档 0 条**。
    - **验收**：**BE 1015 → 1033/1033（+18）**、**FE 1472 → 1473/1473（95 文件，+1）**、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0 **且 0 warning**、yorha-ui 校验器改动
      **3 个 js / jsx / json 文件 0 违规**（2 js/jsx + 1 json）、`ev40` TOTAL_PROBLEMS=0、
      `ev33` STAGED=0 BAD=0；**零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、
      无新 pip 依赖、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、
      **`/dispatch` 缺省口径未动**。
      > **FE 全量首跑出过 1 条 `Terminal.test.jsx` 历史预览红**（`Unable to find an element
      > with the text: AA 55 ……`）—— 本批未触碰该页，单跑 29/29 绿，随后两次全量 95 文件
      > 1473 条全绿。按**测试抖动**记账：不改测试、不改实现，如实登记。
    - **文档同步（同批）**：PLAN **§8.76 新节** + §1 新增 `R44` 行 + §8.70 六 / §8.71 七 /
      §8.72 八 / §8.73 三 / §8.75 七 五处留白改指；本条插入 + 条目 88 / 89 / 90 / 92
      四处同款留白改指（顺带把条目 88 里 R42 那句「不涉」一并改指）+ 目录地图改
      `datahub.py` / `DataHub.jsx` 两行；`pageStatus.json` `/datahub` 导出陈述改 9 域 +
      留白销项 + `nextSteps` 改指，并 `npm run sync:page-status` 重生成 `PAGE_STATUS.md`。
    - **状态**：**R44 ✅ —— 规则表终于随包走：换一台机，规则与指令、配方、序列一起进 ZIP，
      而不是一条条手抄。**
      **明确留白**：**协议数据仍不在 9 域内**（R7 那批就明确过「协议不进域」，本批不重开）；
      **不做批量导入端点**（按域导入仍一次一个域，「先灌指令再灌规则」的顺序要求由回执的
      「指令不存在」逐行告知，不新开编排）；输入表持久化、校验器 md 口径仍不涉。
      提交 = `feat(R44)` 单笔（**BE+FE · 零 DDL** → 无 Migration、无 `chore(db)`）。

94. **R45 · 加工页判定轨迹（同一份回执两页共用一张轨迹表；PLAN §8.77 · 2026-10-07）**
    - **为什么**：R43 落地 `trace` 时**刻意留白**「加工页不加轨迹」（条目 92，理由是那边是
      「命中即切」的动作语境、一行事实已够）。落地后账面出现一个**不对称** —— 同一份
      `POST /dispatch/routed` 回执，规则作者在 `/routing` 的试解析里能读到三行「为什么不命中」，
      **在 `/processing` 真按下「解析 RESOLVE」并真切了指令的那一刻却只有一行状态条**，
      要看轨迹得换页再解析一次。**2026-10-07 question 工具回执拍板**选此项（同批候选：
      输入表持久化 / 校验器 md 口径 / 暂不排批）。
    - **它现在怎么解决**：`routeResolve.js` 的 **`describeTrace` 由 `describeDryRun` 私有函数
      提为导出**（一行）—— 同一份回执两处消费，轨迹**必须走同一张表**不许各排各的，
      `describeDryRun` 内部改调它、**返回值逐字不变**（R43 的 8 条既有用例一次不改全绿 =
      提取没改行为的证据）。`InstructionProcessor.jsx` 新增 `routeTrace`：**一次解析开始就清、
      失败也清**（不残留上一次），成功存 `describeTrace(res?.trace)`；轨迹块挂**状态条下方、
      与展开态无关**（结论属于状态条那一层，收起输入表不该把结论一起收走），
      testid `route-trace-{n}` 与规则页 `dry-trace-{n}` 同形不同名、`MATCHED` 行黄字同款。
    - **三条边界**：① 回执没给 `trace`（旧后端）→ `[]` → 不出块，状态条照旧写事实；
      ② **只回显不改判** —— 命中才切 / 无命中不切仍是 R39 原口径，FE 不自己扫第二遍条件；
      ③ **`回到上一条` 只改状态条不清轨迹** —— 撤回的是「切指令」这个动作，规则与输入都没变，
      那次解析为什么命中仍是真的。
    - **文件（4 个）**：**改 2 个 FE 实现** —— `frontend/src/utils/routeResolve.js` +
      `frontend/src/pages/InstructionProcessor.jsx`；**改 2 个 FE 测试** ——
      `frontend/src/utils/__tests__/routeResolve.dryrun.test.js` +
      `frontend/src/pages/__tests__/InstructionProcessor.test.jsx`。
      **纯 FE · 零 DDL** → 无 Migration、无 `chore(db)`、零 BE 改动、不引 pytest、
      无新 pip 依赖、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、
      **`/dispatch` 缺省口径未动**。
    - **测试（红测先行有据）**：新增 **8 条**（util 3 + 页面 5），实现前 **7 红 1 绿** ——
      util 3 条整文件加载即红（`describeTrace does not provide an export named 'describeTrace'`）+
      页面 4 条 `Unable to find … 逐条判定轨迹 (TRACE)`，**红因全为缺特性**；那 1 条
      「回执不带 `trace` → 不出块」**实现前即绿属护栏**（当时本就没有轨迹块），
      **如实登记，不冒充红测**。
    - **三档记账**：**缺特性 7 条**；**测试随新事实改写 0 条**（本批没有既有断言被推翻）；
      **测试自身 bug 档 0 条**。
    - **验收**：**BE 1033/1033 持平**（零改动）、**FE 1473 → 1481/1481（95 文件，+8）**、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0 **且 0 warning**、yorha-ui 校验器改动
      **5 个 js / jsx / json 文件 0 违规**（4 js/jsx + 1 json）、`ev40` TOTAL_PROBLEMS=0、
      `ev33` STAGED=0 BAD=0；**零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、
      无新 pip 依赖、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、
      **`/dispatch` 缺省口径未动**。
      > **FE 全量首跑出过 1 条 `Terminal.test.jsx` 历史预览红**（`Unable to find an element
      > with the text: AA 55 ……`）—— **与 R44 §8.76 登记的是同一条**，本批未触碰该页；
      > 单跑 29/29 绿，随后**两次全量 95 文件 1481 条全绿**。按**测试抖动**记账：
      > 不改测试、不改实现，如实登记。
    - **实机冒烟**（后端 8055 + dev 5174）：三条规则各占一类（条件假 / 变量不在输入 / 停用），
      `meter_id=999` → 无命中状态条 + 轨迹三行 `比较不成立` / `变量不在本次输入里：line` /
      `已停用（不参与匹配）`；`meter_id=1` → `命中规则「R45 smoke A」→ 已切到指令「示例心跳帧」`
      + #1 `判真命中` **黄字**、#2 #3 `未轮到`；点 `回到上一条` 后状态条换文案而**轨迹仍三行**。
      **控制台做了 A/B 对照**：带 R45 的页面出 2 条 404 → `git stash` 暂存两份运行时改动、
      同一 URL 重开一页 → **同样出 2 条**，且都是 `GET /response-specs/{id} 404`（该指令无存档
      应答规格，FE 自 P2 起按 404 当「未配置」处理，测试里也这么 mock）→ **定性为既有口径，
      本批新增 0 error**。清场后规则表 `[]`、**回收站 0 条**，8055 / 5174 两个后台壳已停。
      > `git stash` 往返把两份文件写成 CRLF（326 / 221 行）—— 当场转回 LF 并复核，
      > 提交前字节核验 BAD=0。
    - **文档同步（同批）**：PLAN **§8.77 新节** + §1 新增 `R45` 行 + §8.75 七 留白改指；
      本条插入 + 条目 92 一处留白改指 + 目录地图 `routeResolve.js` /
      `InstructionProcessor.jsx` 两行；`pageStatus.json` `/processing` 补记 +
      `/routing` 的 `nextSteps` 改指，并 `npm run sync:page-status` 重生成 `PAGE_STATUS.md`。
    - **状态**：**R45 ✅ —— 解析发生在哪一页，「为什么」就在哪一页读得到，而且是同一张表。**
      **明确留白**：轨迹块**不做折叠 / 虚拟列表**（规则条数目前个位数，未见上限问题，
      不预设不存在的性能问题）；轨迹**不落库、不进导出包**（回执的瞬时呈现）；
      输入表持久化、校验器 md 口径仍不涉。
      提交 = `feat(R45)` 单笔（**纯 FE · 零 DDL** → 无 Migration、无 `chore(db)`）。

95. **R46 · TIME 字段点击范围收窄（只有值区才开时间配置弹窗；PLAN §8.78 · 2026-10-07）**
    - **为什么**：实机手工验证 `/processing` 当场反馈 —— TIME 类字段（运行秒数）**点整行任意处
      都会弹时间配置**，只希望点值区那块才弹。**无既有登记项**（R36–R45 的留白到 R45 已全部销完，
      这是新报上来的交互问题）。**2026-10-07 question 工具回执拍板其作 R46**，
      **原拍板给 R46 的「输入表持久化」顺延 R47**（校验器 md 口径仍待另议）。
    - **它现在怎么解决**：`SmartInput.jsx` **把开弹窗的 `onClick` 从整行最外层挪到值区
      `div.flex-1`** —— 原先 `onClick`（`RunnerFieldTree.handleTimeClick` → `onOpenDatePicker`）
      与 `onSelect` 两个回调**同挂最外层**，点标签 / 点右徽标 `[TIME_PICKER]` / 点值区都同时做
      「开弹窗 + 字节定位」两件事。改后最外层**只留 `onSelect`**，值区**不 `stopPropagation`**
      → 事件继续冒泡，点值区 = 开弹窗 + 选中字段两件事一起。
    - **三条边界**：① **字节定位选中仍是全行语义**（第 4 批 #2「点字段出读数条」的既有用例
      一次不改全绿）；② 值区不 `stopPropagation`，但 `RunnerFieldTree` 叶行外层那句
      `stopPropagation()` 仍在 —— 「嵌套组内选中不被外层组 id 覆盖成整组」的隔离不受影响；
      ③ **非 TIME 字段零变化**（`onClick` 本就 `undefined`，值区不挂处理器）。
    - **文件（3 个）**：**改 1 个 FE 实现** —— `frontend/src/components/InstructionForm/SmartInput.jsx`；
      **改 2 个 FE 测试** —— 同目录 `__tests__/SmartInput.test.jsx` +
      `frontend/src/pages/__tests__/InstructionProcessor.test.jsx`。
      **纯 FE · 零 DDL** → 无 Migration、无 `chore(db)`、零 BE 改动、不引 pytest、
      无新 pip 依赖、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、
      **`/dispatch` 缺省口径未动**。
    - **测试（红测先行有据）**：新增 **5 条**（单元级 3 + 页面级 2），实现前 **3 红 2 绿** ——
      红的三条全是「触发点还没收到值区」（单元级点标签 / 点徽标
      `expected "vi.fn()" to not be called at all, but actually been called 1 times` ×2、
      页面级点标签 `expected <span …></span> to be null`）；那 2 条「点值区 → 开时间配置弹窗」
      **实现前即绿属护栏**（改前整行就开），**如实登记，不冒充红测**。
    - **三档记账**：**缺特性 3 条**；**测试随新事实改写 0 条**；**测试自身 bug 档 0 条**。
    - **验收**：**BE 1033/1033 持平**（零改动）、**FE 1481 → 1486/1486（95 文件，+5）**、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0 **且 0 warning**、yorha-ui 校验器改动
      **3 个 js / jsx + 1 json 文件 0 违规**、`ev40` TOTAL_PROBLEMS=0、`ev33` STAGED=0 BAD=0；
      **零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、无新 pip 依赖、
      `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径未动**。
      > **FE 全量跑了三遍**：两遍 95 文件 1486 条全绿；一遍出 1 failed，正是 R44 §8.76 与
      > R45 §8.77 都登记过的那条 `Terminal.test.jsx` 历史预览抖动，本批未触碰该页，
      > **单跑 29/29 绿**。按**测试抖动**记账：不改测试、不改实现，如实登记。
    - **实机冒烟**（后端 8055 + dev 5174，**零数据改动**）：选中「示例心跳帧」的 TIME 字段
      `运行秒数` —— 点**标签**不出弹窗但 `SEL :: 运行秒数 · 0X05-0X08 · 4B` 照旧 + 导轨亮；
      点**值区**出 `时间配置 (TEMPORAL)`（年 月 日 时 分 秒 + 取消 确认）；点右徽标
      `[TIME_PICKER]` 不出弹窗且定位保留。**控制台 0 条新增 error** —— 只有 2 条
      `GET /response-specs/sample-inst-heartbeat 404`，与 R45 §8.77 已 A/B 定性的同类
      （无存档应答规格，FE 按 404 当「未配置」）。本批不创建、不删除任何数据，无需清场。
    - **文档同步（同批）**：PLAN **§8.78 新节** + §1 新增 `R46` 行；本条插入；
      `pageStatus.json` `/processing` 补记一条，并 `npm run sync:page-status` 重生成
      `PAGE_STATUS.md`（**R36–R45 的留白改指一条都不涉及** —— 本批无既有登记项可销）。
    - **状态**：**R46 ✅ —— 点哪一块就是哪一块：只有值区才弹时间配置，点标签与徽标只是把字节
      定位到那一行。**
      **明确留白**：**不给值区加额外 hover 高亮 / 点击提示**（整行已有 `cursor-pointer` 与 hover 底色，
      不为一次范围收窄新增视觉层）；**不改字节定位选中的全行语义**（要一并收窄另议）；
      **输入表持久化已顺延 R47**、校验器 md 口径仍不涉。
      提交 = `feat(R46)` 单笔（**纯 FE · 零 DDL** → 无 Migration、无 `chore(db)`）。

96. **R47 · 输入表持久化（两页共用一份本机草稿；PLAN §8.79 · 2026-10-07）**
    - **为什么**：R39 建「路由输入」时挂在 **§8.71 七 第 4 条**的留白原文 ——「输入表不做
      持久化：本仓前端**零 `localStorage` 先例**，本批不为此新引一种落盘样式；刷新即回到一行
      空输入。真要常驻站点参数（表号、线别），另开一批连『谁清、谁改』一起拍」。R46 批内由
      question 工具回执把它排为 R47（原拍板给 R46 的正是这一条），本批**销的就是这一条**；
      它在 §8.72 / §8.75 / §8.76 / §8.77 / §8.78 被以「§8.71 七 同款留白」反复引用，
      那些是各批当时的口径记录，**只在正主处销一次**。
    - **拍板（question 回执，一次问齐三问）**：① 存哪几列 → **整表原样存（含空行）**；
      ② 加工页与规则页存一份还是两份 → **两页共用一份**；③ 存多久、谁清谁改 →
      **localStorage + 显式「清空输入 (CLEAR)」按钮**（键入即写，按钮主动清）。
    - **它现在怎么解决**：新建 `utils/routeInputsPersist.js` —— 单点槽
      `ROUTE_INPUTS_KEY = 'yorha.routeInputs.v1'` + `loadRouteInputs` / `saveRouteInputs` /
      `clearRouteInputs` 三个纯数据函数（不碰 React、不碰请求）。两页的 `useState` 改成
      `loadRouteInputs() ?? emptyRouteInputs()` 惰性读槽（**切页即重读，共用的就是那个槽**），
      行变更走**唯一的口** `handleRouteRows` / `handleDryRows`（改键值、加行、删行三条路同口，
      否则「改的存了、加的没存」会读回一张对不上的表），清空按钮删槽 + 回默认一行空行。
      `routeResolve.js` 的解析口径（键去空白、空键不发、值按 JSON 标量）**一行未动**。
    - **三条边界**：① **「存什么读什么」与「默认一行」是两件事** —— 读回 `null`（没存过）才给
      `emptyRouteInputs()`，形状合法的空数组原样给，不是 `{key, value}` 字符串的行一律当
      「没存过」（宁回默认一行也不回半张表）；② **存储故障只降级不报错** —— 读 / 写 / 清全
      try/catch：隐私模式读不到、配额满写不进、本机那份被改坏，都当「本机没存过」，输入表照常
      打开（**表打不开比表是空的严重得多**）；③ **清空只清输入** —— 解析状态条、逐条判定轨迹、
      UNDO、选中指令、规则表与表单顺序草稿都与输入无关，一并不动，且**不做二次确认**
      （清的是本机草稿，不删任何后端数据，删完 ADD 还能加回来）。
    - **文件（6 个）**：**新建 1 个 FE 实现** —— `frontend/src/utils/routeInputsPersist.js`；
      **改 2 个 FE 页面** —— `frontend/src/pages/InstructionProcessor.jsx` +
      `frontend/src/pages/RoutingRules.jsx`；**新建 1 个 + 改 2 个 FE 测试** ——
      `frontend/src/utils/__tests__/routeInputsPersist.test.js`（新）+
      `frontend/src/pages/__tests__/InstructionProcessor.test.jsx` +
      `frontend/src/pages/__tests__/RoutingRules.dryrun.test.jsx`。**纯 FE · 零 DDL** →
      无 Migration、无 `chore(db)`、零 BE 改动、不引 pytest、无新 pip 依赖、
      `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径未动**。
    - **测试（红测先行有据）**：新增 **15 条**（单元 9 + 加工页 3 + 规则页 3），实现前
      **15 红 0 绿** —— 单元 9 条**整文件红**（`routeInputsPersist` 模块不存在）；页面 6 条 =
      `expected null to be truthy` ×2（键入没落盘）、`expected '' to be 'meter_id'` ×2
      （本机那份没回显）、`Unable to find … name "清空输入 (CLEAR)"` ×2（清空入口缺失）。
      **护栏 0 条**。
    - **三档记账**：**缺特性 15 条**；**测试随新事实改写 0 条**；**测试自身 bug 档 0 条**。
      **单列说明（不冒充红测）**：两个页面测试文件各加一条文件级
      `beforeEach(() => window.localStorage.clear())` —— 键入即写后，同文件先跑的用例会把行留给
      后跑的用例，这是**隔离不是改断言**：加钩子前后两文件既有用例全绿、一条没改。
    - **验收**：**BE 1033/1033 持平**（零改动）、**FE 1486 → 1501/1501（96 文件，+15，+1 文件）**、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0 **且 0 warning**、yorha-ui 校验器改动
      **6 个 js / jsx + 1 json 文件 0 违规**、`ev40` TOTAL_PROBLEMS=0、`ev33` STAGED=0 BAD=0；
      **零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、无新 pip 依赖、
      `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径未动**。
    - **实机冒烟**（后端 8055 + dev 5174，**后端与库零改动**）：加工页键入 `meter_id = 0001`
      并点 `+ 添加 ADD` → 本机槽两行（含空行）、状态条 `1 项有效`；切规则页 `/routing` →
      **原样回显同两行**；点 `清空输入 (CLEAR)` → 槽 `null`、回默认一行空行；再键入两行 →
      **刷新页面仍在**；回加工页 `/processing` 同槽回显，再清空后解析按钮与选中指令
      `ID: SAMPLE-INST-HEARTBEAT` 都不动。**控制台 0 条新增 error** —— 只有 2 条
      `GET /response-specs/sample-inst-heartbeat 404`（R45 §8.77 已 A/B 定性的同类）。
      冒烟没点任何解析 / 试解析 / 新建规则按钮，后端与库零改动，写进本机槽的两行已随最后一步
      清空，无需清场。
    - **文档同步（同批）**：PLAN **§8.79 新节** + §1 新增 `R47` 行；**销 §8.71 七 第 4 条**
      （原文就地标注 → R47 已落地）与 §8.78 六 的顺延项就地标注已收口；本条插入；
      `pageStatus.json` 的 `/processing` 与 `/routing` 各补记一条，并
      `npm run sync:page-status` 重生成 `PAGE_STATUS.md`。
    - **状态**：**R47 ✅ —— 表号不用再打第二遍：切页、刷新都还在，清空是一下子的事。**
      **明确留白**：**不在状态条加「存本机」常驻提示**（显式清空入口已把这件事摆在屏上，
      要加属文案扩面，另议排批）；**清空不做二次确认**（要改成先问一句另议）；
      校验器 md 口径仍不涉 —— **→ R48 已落地 ✅（2026-10-07，见条目 97 / PLAN §8.80）**。
      提交 = `feat(R47)` 单笔（**纯 FE · 零 DDL** → 无 Migration、无 `chore(db)`）。

97. **R48 · 校验器 md 口径（`.md` 纳入 · 只扫围栏代码块；PLAN §8.80 · 2026-10-07）**
    - **来源与拍板**：§8.73 八（R41）与本文件条目 90 **两处同挂**的留白正主 —— 34 条历史
      CSS 字样（`rounded-sm` / `shadow-md` …，全是当年「改掉它」的史实记述）要让 md 过检
      **须二选一**：改写史实措辞，或给校验器加白名单；后者改**仓外**
      `~/.agents/skills/yorha-ui` 故「另议」。**2026-10-07 question 回执拍板选此题并授权改
      仓外 skill**（余三候选：输入表持久化 → 已顺延 R47 ✅、`Terminal.test.jsx` 抖动治理、
      暂不排批），两问一次问齐：① 扫描面 = **只扫围栏代码块，散文不看**；② 固定验收 = **传，
      且传全仓 md**。
    - **摸底取数（先量后拍）**：仓内 md **14 份**（初测 16 含 2 份 `venv` 第三方 LICENSE，
      已排除；与 `git ls-files` 同数）、围栏块 26 个（`bash` 11 / 无标注 7 / `sql` 2 / `json` 2 /
      `mermaid` 2 / `python` 1 / `typescript` 1）、**进扫描面的 1 个且其内 0 违规**；
      同一批文件按**整文件判**（R48 之前的行为）= **3 文件 36 条** → 围栏口径 **0 条**。
      故三条路取第三条：**扫描面收窄**，二选一（改写史实 / 建白名单）**都不必发生**。
    - **文件（9 个）**：**仓外 3 个**（`scripts/validate-yorha-ui.mjs` 加 `.md` 扫描面 +
      `validateMarkdown` / `validateSource` 分流 + 行号 `Line: N (md fence)`；`references/rules.md`
      新增 §9；`SKILL.md` 工作流第 4 步补一句）；**仓内 6 个**（新 `scripts/test-yorha-md-validator.mjs`
      + 新 `scripts/fixtures/md-validator/` 6 份 fixture 数据）。**零业务代码改动** ——
      `backend/` 与 `frontend/src/` 一字未碰。
    - **仓外改动不进本仓提交**（skill 是共享资产）：本仓记**事实 + 可复跑测试**当防回滚护栏，
      改动要点逐条写在 PLAN §8.80「二」，日后据此可与仓外那份比对或重建。
    - **测试（红测先行有据，三档 + 护栏单列）**：新增 7 条 → **3 红 4 护栏**，红因全为缺特性
      （md 无行号 / 散文被咬 6 条 / 全仓 md 36 条）；首跑另有 **1 条测试自身 bug**
      （js fixture 写 camelCase，规则族本就不判）**先修再算数**；**三档** = 缺特性 3 /
      测试自身 bug 先修 1 / 随新事实改写 0；实现后**追加 1 条 `typescript` 别名护栏单列不冒充
      红测**，终态 **8/8 绿**。实现中被红测当场抓到 1 个 bug（裸 token `css` 没归一成 `.css`
      → css 块不判），修法写进 §8.80「四」。
    - **fixture 放置是刻意不是掩盖**（§8.80「三 · 2」）：fixture 必须含违规样式才测得到，
      而校验器对 `.mjs` 全文判（连它自己的源码都判出 8 条正则字面量）→ 内联则本测试自己
      9 条违规；写成仓内 `.md` 又被「全仓 md 0 违规」咬住。故放 `.txt` 数据文件 —— `.txt`
      不在 `SCANNED_EXTENSIONS` 内，**哪天扫描面扩到 `.txt` 这条会当场叫出来**。
    - **验收**：**BE 1033/1033 持平**、**FE 1501/1501 持平**（两项均零改动）、
      `npx vite build` EXIT=0、`npm run lint` EXIT=0 **且 0 warning**、yorha-ui 校验器
      （1 个 `test-yorha-md-validator.mjs` + **全仓 14 份 md**）**0 违规**、md 口径测试 **8/8**、
      `ev40` TOTAL_PROBLEMS=0、`ev33` STAGED=0 BAD=0；**零 DDL → 无 Migration、
      无 `chore(db)`**、不引 pytest、无新 pip 依赖、`processor.py` / `graph.py` /
      `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径未动**。
    - **自检取证**：拿改后的校验器扫它自己那份 skill 目录 —— 旧行为（整文件判）**41 条** →
      新行为 **9 条**（8 条是 validator 自身源码的正则字面量、1 条是 `components.md` 围栏里的
      既有示例，**都早于 R48**）→ **未新增任何违规，反而少了 32 条误判**。那 9 条既有违规
      **不在本批范围**（是内容问题不是口径问题），另议排批。
    - **人工验证**：**无应用代码改动 → 不启 8055 / 5174、不做浏览器冒烟**，改以三件可复跑的
      事实为准（md 口径测试 8/8 · 全仓 14 份 md 0 违规 · skill 自检 41 → 9）。
      `pageStatus.json` 与 `PAGE_STATUS.md` **双双不动**（不给任何一页新增能力）。
    - **文档同步（同批）**：PLAN **§8.80 新节** + §1 新增 `R48` 行；**销 §8.73 八 第 1 条**
      与本文件条目 90 的 md 口径留白（两处原文就地标注 → R48 已落地）+ §8.70 八 校验器口径注
      就地改指 + §8.79 七 与本文件条目 96 的「md 口径不涉」就地标注已收口；§8.67 末尾补注
      **过期悬账（R35 人工验证点）就地销掉**（四处复核查无出处，不挂用户欠账）；本条插入。
    - **状态**：**R48 ✅ —— md 进了校验器：散文还是散文，围栏才是代码。**
      **明确留白**：skill 自检那 9 条既有违规（8 条自身源码 + 1 条 `components.md` 示例）
      另议排批 —— **→ R49 已落地 ✅（2026-10-08，见条目 98 / PLAN §8.81）**：9 → **0**，
      自指 8 条走豁免、示例 2 条修内容，规则一字未改；`~~~` 围栏与缩进代码块不判（fail-open）；
      `.txt` 等非扫描扩展名不纳入。
      提交 = `feat(R48)` 单笔（**零 DDL** → 无 Migration、无 `chore(db)`）。

98. **R49 · 校验器自检收口（自指豁免 + 示例补工业标记；PLAN §8.81 · 2026-10-08）**
    - **来源与拍板**：R48 §8.80 七 第 1 条登记的留白 —— validator 扫**它自己那份 skill** 出
      **9 条条目 / 13 处匹配**（8 条 = 它自身的规则正则字面量与 FIXES 文案里的禁词，
      `rounded` / `shadow` / `text-shadow` / `#0ff` …；1 条 = `components.md`「Page skeleton」
      两行缩略示例 `class="yorha-panel"` ×2 缺 `[ ± ]`）。**2026-10-08 question 回执两问都选
      推荐项**：① 自指那 8 条 → **自指豁免 + 报告里写明**（否掉基线棘轮、否掉行内抑制注释 ——
      后者就是最初留白里的「白名单」方向，会软化全仓「改动文件 0 违规」）；② 示例那 2 条 →
      **修示例补 header**（否掉规则放行省略号 —— JSX 的 `{...props}` 也带 `...`，会出洞；
      否掉改占位 —— 骨架图就不示范真实类名了）。**分野**：前者是口径（规则表最后两个载体，
      且校验器早已 `stripComments`），后者是内容。
    - **文件（5 个）**：**仓外 4 个**（`scripts/validate-yorha-ui.mjs` 加 `SELF_PATH` /
      `isSelfSource` + `validateSource` 首行豁免 + `formatReport` 四行说明 + 文件头与 usage；
      `references/rules.md` 新增 **§10**；`references/components.md` 骨架两块面板补 header 与
      `[ + ] MODULE_A // 0x01` / `MODULE_B // 0x02`；`SKILL.md` 步骤 4 补一句）；**仓内 1 个**
      （新 `scripts/test-yorha-selfscan.mjs`）。**fixture 零新增** —— 复用 R48 的 `plain.js.txt`
      与 `css-block.md.txt`。**零业务代码改动**：`backend/` 与 `frontend/src/` 一字未碰。
    - **规则链没被碰**：`validateYoRHaCode` 与 `RULES` 表 8 条规则**一行未改**，豁免落在
      `validateSource`、**位于规则链之前**。四重取证：R48 的 8 条断言复跑全绿 / 外部 fixture
      仍判 `NO_BOX_SHADOW` + `NO_BORDER_RADIUS` 且 exit 1 / R48 的 skill 字节核验与 9 项口径
      落位复跑 `BAD=0` / 自检报告 7 文件全绿、豁免行在场（全文留档）。
    - **四条边界**：按路径判不按名判（`resolve` + 小写，`<stdin>` 不参与）；**只此一文件**，
      本脚本的副本换名照判；**不静默**（文本四行 + `--json` `selfExempt: true`）；**不买什么**
      —— 真把 CSS 贴进这个脚本不会被抓，该文件没有样式、只有拒绝样式的模式。
    - **仓外改动不进本仓提交**（skill 是共享资产）：本仓记**事实 + 可复跑测试**当防回滚护栏，
      改动要点逐条写在 PLAN §8.81「三」「四」。
    - **测试（红测先行有据，三档 + 护栏单列）**：新增 7 条 → **4 红 3 护栏**，红因全为缺特性
      （自检 exit 1 / 报告无豁免说明 / 仍有 `MISSING_INDUSTRIAL_TAG` / `components.md` 单独扫
      exit 1 且 `Line: 153 (md fence)`）；护栏 = **豁免不扩大**（外部文件同样违规仍 exit 1）/
      R48 md 围栏回归 / 全仓 14 份 md 0 违规，**实现前即绿不冒充红测**；**三档** = 缺特性 4 /
      测试自身 bug 先修 2（都在临时取证脚本 `r49_regress.py`：`"FAIL" in out` 撞上汇总行
      `FAIL 0`、一处少传 `node`）/ 随新事实改写 0（R48 那 8 条一字未改）。**实现一发即绿，
      实现 bug 0**（与 R48 抓到裸 token 归一 bug 不同，如实记）。终态 **7/7 绿**。
    - **验收**：**BE 1033/1033 持平**、**FE 1501/1501 持平**（两项均零改动）、`npx vite build`
      EXIT=0、`npm run lint` EXIT=0 **且 0 warning**、yorha-ui 校验器（**2 个 `mjs`** +
      **全仓 14 份 md**）**0 违规**、md 口径测试 **8/8**、**自检收口测试 7/7**、
      `ev40` TOTAL_PROBLEMS=0、`ev33` STAGED=0 BAD=0；**零 DDL → 无 Migration、
      无 `chore(db)`**、不引 pytest、无新 pip 依赖、`processor.py` / `graph.py` /
      `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径未动**。
    - **人工验证**：**无应用代码改动 → 不启 8055 / 5174、不做浏览器冒烟**，改以四件可复跑的
      事实为准（自检 7/7 · md 8/8 · skill 自检 exit 0 且写明豁免 · 外部 fixture 照旧被判）。
      `pageStatus.json` 与 `PAGE_STATUS.md` **双双不动**（不给任何一页新增能力）。
    - **文档同步（同批）**：PLAN **§8.81 新节** + §1 新增 `R49` 行；**销 §8.80 七 第 1 条**
      （原文就地标注 → R49 已落地、9 → 0）；本条插入 + 条目 97 留白处销项 + 目录地图补 1 行。
    - **状态**：**R49 ✅ —— 校验器不判自己：尺不量尺，但要把「不量」说出口。**
      **明确留白**：行内抑制注释机制不做（口径扩到全仓会软化「改动文件 0 违规」，真要开豁免口
      另议排批连「谁能开、开什么」一起拍）；`~~~` 围栏与缩进代码块仍不判；`.txt` 等非扫描扩展名
      仍不纳入；`Terminal.test.jsx` 抖动治理仍未排（候选之一）。
      提交 = `feat(R49)` 单笔（**零 DDL** → 无 Migration、无 `chore(db)`）。

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
| `scripts/test-yorha-md-validator.mjs` | R48 新增：yorha-ui 校验器 **md 口径**的 8 条断言（围栏才判 / 散文·行内·无标注·非样式围栏不判 / 违规出行号 / 语言别名 / 全仓 md 0 违规），兼**仓外 skill 的防回滚护栏** · 跑法 `node scripts/test-yorha-md-validator.mjs` | ✅ 固定验收新增一项（R48 起） |
| `scripts/test-yorha-selfscan.mjs` | R49 新增：校验器**自检收口**的 7 条断言（自检 exit 0 / 报告写明豁免 / 无工业标记违规 / `components.md` 0 违规 / **外部文件照旧被判** / R48 围栏回归 / 全仓 md 0 违规），兼**仓外 skill 的防回滚护栏** · 跑法 `node scripts/test-yorha-selfscan.mjs` | ✅ 固定验收新增一项（R49 起） |
| `scripts/fixtures/md-validator/*.txt` | 上一条测试的 fixture 数据（**故意违规**才测得到，故放 `.txt` 数据文件：`.txt` 不在校验器扫描面内，也不会被「全仓 md 0 违规」咬住） | ✅ 勿改成 `.md`、勿并进源码 |
| `requirements.txt`（根目录） | **不存在**；requirements 在 `backend/` 下 | ⚠️ 勿在文档中引用根目录版本 |

### backend/
| 文件 | 职责 | 状态 |
|---|---|---|
| `backend/main.py` | FastAPI 入口；`lifespan`（`create_all` → 5 个 `ensure_*` 自愈 → `db/migrate.run_pending_migrations` 版本化升级 → 3 个种子 → 传输配置恢复 → `core/diagnostics.install`）；注册全部路由（`/compile` 本体已拆至 `routers/compile.py`） | ✅ 权威入口 |
| `backend/routers/instruction.py` | 指令 CRUD；`save_field_flat` 持久化 bits；`serialize_instruction` 返回 bits；**R37 起 `GET /{id}/references` 数五表（加 `routing_rules`）+ `DELETE` 同戳级联 `routing_rules`** | ✅（§8.69） |
| `backend/routers/trash.py` | 回收站**唯一读写入口**：`KINDS` 白名单（8 类）+ 列表 / 恢复 / 彻底删除；**R37 起 `instruction` 的 `children` 含 `routing_rules`（同戳恢复），且该 kind 刻意不加 `hide`** | ✅（§8.43 / §8.69） |
| `backend/routers/protocol.py` | 协议 CRUD + 种子 | ✅ |
| `backend/routers/operator.py` | 算子模板 + `seed_operator_templates`（含 BITFIELD） | ✅ |
| `backend/routers/compile.py` | `POST /compile`（块森林 → Orchestrator → hex），原内联于 `main.py` | ✅ |
| `backend/routers/export.py` | `/export/hex`、`/export/binary`、`hex_to_bytes` | ✅ 新增 |
| `backend/routers/dispatch.py` | `/dispatch` 环回通道 + 有界历史；**R36 增 `POST /routed`（只解析不发送）**，`/dispatch/` 与 `/transaction` 一行未改 | ✅ 新增 |
| `backend/routers/datahub.py` | 数据中心页后端：聚合导出 ZIP（**R44 起 9 域**，`BUNDLE_DOMAIN_VERSIONS` 键序 = 导出序 = `manifest.domainVersion` 键序）、`bundle_manifest` 纯函数 + `域清单不一致` 漂移守卫、**按域导入 6 域**（recipes / sequences / transport / profiles / templates + **R44 `routing_rules`**，三段式 = 顶层校验 400 不落快照 → `pre-import` 快照 → 逐行提交）、`GET /status`、备份与恢复；**读端点一律 `alive()`**（回收站行不进包） | ✅ 新增（§8.37 / §8.45 / §8.46），R44 补第 9 域（§8.76） |
| `backend/routers/routing.py` | **R36 发前路由**：`/routing-rules` CRUD（语法 / 活指令 / 全表判重三道校验，先校验再落笔）+ `resolve_route` 只读解析（两层静态跳过记 `invalid`） | ✅ 新增（§8.68） |
| `backend/core/routing.py` | 匹配器 `select_rule` —— **复用 `core/condition.py` 不造第二套判据**；`(sort_order, name, id)` 定序 · first-match-wins · 停用 / 回收站不参与 · 解析期坏条件记 `invalid` 并继续扫 · 求值期未定义变量 = 普通不命中 · **无命中不猜** | ✅ 新增（§8.68） |
| `backend/schemas/routing_api.py` | 规则读写体 + `POST /dispatch/routed` 入参回执（**六键，无 `status`·`attempts`·`hex_string`** —— 有那三个即说明串进了 `/dispatch` 缺省口径） | ✅ 新增（§8.68） |
| `backend/tests/test_routing.py` | R36 单测 22 例（匹配语义 / CRUD 四拒 / 解析不猜 / 回收站往返与占名） | ✅ 新增（§8.68） |
| `backend/core/orchestrator.py` | 块森林 → hex 编译（`/compile`、`/export/binary` 使用） | ✅ |
| `backend/core/diagnostics.py` | 统一诊断：`Diagnostic` / `DiagError` / `DiagHTTPException` + `install(app)` → 错误体 `{"detail": 原文, "diagnostic": {…}}`（`detail` 逐字不变，只做加法） | ✅ 新增（§8.32） |
| `backend/core/field_blocks.py` | 编译侧字段布局 SSOT（`fields_to_blocks` + `_presence_hit` + 内嵌 `to_block`：presence 门 · repeat ×N · endianness · align · `pad_to`）—— 自 `routers/datahub.py` **纯搬入**、`datahub` 原名再导出 | ✅ 编码与解码共用一份（§8.48，改一必改二） |
| `backend/core/field_decode.py` | 应答逆向解码（`decode_hex` / `decode_blocks` / `decode_field_bytes` / `field_index`），值分派与 FE `utils/InstructionDecoder.js` 同序；非有限浮点落库前折字符串 | ✅ 写日志时回填 `dispatch_logs.fields_json`（§8.48） |
| `backend/tests/` | 后端全量测试（stdlib `unittest`，**直调路由不用 TestClient**、不触 lifespan；共享向量读根目录 `vectors/`） | ✅ `python -m unittest discover -s backend/tests -t backend/tests` |
| `backend/handlers/base.py` | `LogicHandler` 抽象 + **字节序门面** `byte_order_of` / `apply_byte_order`（R21 length 起用，**R34 §8.66 上移** → length 与 checksum 两 handler 同用一份判据） | ✅ |
| `backend/handlers/length.py`、`checksum.py` | 扁平流区间长度 / 校验计算（R34 起两者的出线 return 同位套用字节序门面；`length.py` 并 re-export 该门面） | ✅ |
| `backend/db/models.py` | SQLAlchemy 模型（含 `BitField`） | ✅ |
| `backend/db/database.py` | SQLite engine / Session / Base | ✅ |
| `backend/db/seed.py` | 示例指令种子 | ✅ |
| `backend/db/yorha.db` | SQLite 数据库文件 | ✅ 已被 git 跟踪（保留） |
| `backend/db/migrate.py` | **版本化迁移**（`schema_migrations` 裸 SQL 表 + `Migration` 注册表 + 升级前整库快照到 `backups/` + 单事务 apply/verify + `integrity_check` 终检 + CLI `python -m backend.db.migrate status\|up`）；**R36 起四条 verify 的范围口径改为 `_scope_tables` = 冻结史实名单 ∩ models**（原「metadata 全量派生 + 精确集合」被后来的新表误伤 → 0002/0004/0005 全红 → 每个库都起不来） | ✅ 权威升级机制（§8.30，口径修正见 §8.68 五） |
| `backend/db/backups/` | 迁移/恢复的整库快照落点（`pre-restore-*` 为恢复前安全快照） | ✅ gitignore，不入库 |
| `backend/db/migrations/*.sql` | `schema.sql` / `seed_data.sql` **非权威参考**（见同目录 `README.md`），无自动执行 | ⚠️ 仅供参考（真正的版本化迁移在 `backend/db/migrate.py`） |
| `backend/core/processor.py` | 旧编译链 | ⚠️ **未接线**（Phase-2 遗留，保留勿删，勿引入新依赖） |
| `backend/core/graph.py` | 旧 GraphEngine 拓扑排序 | ⚠️ **未接线**（同上） |
| `backend/debug_db.py` | MySQL 调试脚本，唯一使用 pymysql 的地方 | ⚠️ 独立脚本 |

### frontend/src/
| 文件 | 职责 | 状态 |
|---|---|---|
| `src/api/` | 全部 HTTP 调用，按域拆分：`client.js`（fetch 助手）/ `protocols.js` / `instructions.js` / `operators.js` / `export.js` / `bindings.js` / `compile.js` / `dispatch.js`（**R39 增 `resolveRoute` → `POST /dispatch/routed`**）/ `responseSpecs.js` / `sequences.js` / **`routing.js`（R38：`/routing-rules` 五方法）** 等 + `index.js` 桶导出 `api` 对象；**导入路径 `./api` 不变** | ✅ 原 `src/api.js` 已拆 |
| `src/constants.js` | `OP_CODES` / `CATEGORIES` / `OP_PRIORITY` / `CATEGORY_ORDER`（BITFIELD 已含） | ✅ |
| `src/utils/InstructionEncoder.js` | **编码核心**（hex 生成、依赖解析、BITFIELD 打包） | ✅ 权威编码逻辑，勿随意改 |
| `src/utils/formula.js` | 公式求值 / 校验和算法 | ✅ |
| `src/utils/normalizeInstruction.js` | 保存前字段/指令载荷归一化（`normalizeFieldPayload` / `normalizeInstructionPayload`），由 `useInstructionData` re-export | ✅ |
| `src/utils/byteOrder.js` | **R42 · FE 侧唯一的字节序取值判据**：`normalizeByteOrder(raw)`（trim + lower，`''` = 未配置）+ `isLittleByteOrder(raw)`（归一后只认 `little`，其余含枚举外 fail-open 回大端）—— 与 BE `handlers/base.py::byte_order_of` 的 `str(order).strip().lower()` 逐字对齐；**只归一不判枚举**（W5 的枚举判定留在 `validateProtocol`）。消费方三处：`protocolTree.js`（length 分支 + checksum `isLittleOrder`）/ `toFrameBlocks.js`（出口翻译闸门）/`validateProtocol.js`（W5）| ✅ 新增（R42 · §8.74） |
| `src/utils/protocolTree.js` | 协议页纯树工具（`serializeProtocol` / `findNode`） | ✅ 新增（自 Protocol.jsx 抽出） |
| `src/utils/blockMerge.js` | 编排页纯逻辑（协议+指令合并、slot 注入、`buildLanes` / `getTotalBytes`） | ✅ 新增（自 Orchestration.jsx 抽出） |
| `src/utils/toFrameBlocks.js` | 导出映射 `byte_len→byte_length`、`op_code→type`（供 `/export/binary`） | ✅ 新增（自 Orchestration.jsx 抽出） |
| `src/utils/download.js` | `triggerBlobDownload`（.hex / .bin 下载共用） | ✅ 新增 |
| `src/utils/routingView.js` | **R38 规则页纯逻辑**：`emptyRuleDraft` / `defaultSortOrder`（新建落末位）/ `validateRuleDraft`（名称+条件+目标指令，条件**委托 `condition.checkCondition` 同一 SSOT**）/ `moveRule`（上移下移，只改草稿）/ `renumber`（稠密重编 0..N-1）/ `changedSortOrder`（**只回写真变化的行**）/ `describeRoutingSaveError`（后端 detail → 中文事实文案） | ✅ 新增（R38 · §8.70） |
| `src/utils/routeResolve.js` | **R39 加工页接线纯逻辑**：行增删改（`addRouteInput` / `removeRouteInput` / `patchRouteInput`）· **`parseInputValue` 值按 JSON 标量解析**（`0001` → 数字 1、`"0001"` → 字符串 0001、其余按原文串 —— 后端 `_equal` 数字/字符串不同型即不中）· `describeInputType` 类型徽标 · `toInputsMap`（键去空白、空键行不发、后写赢）· `resolveInstructionId` / `mergeResolvedInstruction`（不在册补列表，**已在册返回原引用**）· `describeResolve` **回执 → 中文事实文案四档**（命中 / 命中没目标 / 扫过无命中 / 零参与）+ `describeResolveError` · **R40 增 `describeDryRun`**（试解析回执 → **恒四行结果表**：命中规则 / 目标指令 / 参与扫描 / 缺陷跳过，文案断在「命中 / 无命中」**不搬「已切到」**）· **R43 增 `TRACE_LABELS` + `traceReasonText` + `describeTrace`**（回执 `trace` → **逐条判定轨迹**：码 → 中文 + `detail` 载荷；同一张码表也接 `describeInvalid`，同一条规则在「缺陷跳过」与轨迹里措辞同源）· **R45 把 `describeTrace` 提为导出**（加工页与规则页**两处消费同一张轨迹表**，`describeDryRun` 内部改调它、返回值逐字不变）| ✅ 新增（R39 · §8.71），R40 增（§8.72）、R43 增（§8.75）、R45 提导出（§8.77） |
| `src/App.jsx` | 路由壳：`PAGE_REGISTRY` 驱动侧栏与 `Routes`，`renderRouteElement` 按 `pageKey` 取组件后注入各页 props（**R38 加 `case 'routing'`，只注入 `instructions`**）；R35 起页面改动态 import + `<Suspense>`（首屏拆包），`NavItem` 悬停/聚焦预取 | ✅ |
| `src/utils/routeChunks.js` | **页面模块单一登记表** `ROUTE_LOADERS`（**9 页动态 import**，R38 加第 9 页）+ 缓存的 `React.lazy` + 幂等 `prefetchRoute` + `__resetRouteCaches`（仅测试） | ✅ 新增（R35） |
| `src/components/RouteInputTable.jsx` | 发前路由的**扁平键值行表**（键值框 + 类型徽标 + 行删除）—— 加工页「路由输入」与规则页「试解析」**共用同一张表**（类型徽标 / 空键不发 / 删到只剩一行禁删三条细口径只此一处）；`idPrefix` / `labels` 默认值 = 加工页原文，调用方不传即逐字节等价。**边界划在排版**：不持状态、不发请求、不渲染「+ 添加」按钮（按钮视觉语言两页不同，归页面） | ✅ 新增（R40 · §8.72） |
| `src/components/RouteLoading.jsx` | 路由级拆包的 Suspense fallback：`[ MODULE LOAD ]` + 按路由出中文页名，未知路由回落站点名，不画假百分比 | ✅ 新增（R35） |
| `src/hooks/useInstructionData.js` | 指令数据加载/保存/CRUD（归一化逻辑在 `utils/normalizeInstruction.js`，此处 re-export）；导出 `describeReferences` / `describeDeletion` 删除文案纯函数（**R37 加发前路由规则行/段，沿用只报非零**，改文案必改测试） | ✅（§8.69） |
| `src/hooks/useInstructionForm.js` | 表单输入 + 编码 memo | ✅ |
| `src/components/ui/` | `NieRModal` / `NieRDatePicker` 通用 UI（FeaturePlaceholder 已随第 13 单死代码清理批删除） | ✅ |
| `src/components/editor/` | 编辑器域组件：`Canvas` / `Block` / `BlockPropertiesPanel` / `ComponentPalette` / `BitFieldEditor` / `ParamConfigForm`（参数编辑器拆至 `editor/paramConfig/`）/ `InstructionListSidebar` / `ProtocolListSidebar` / `ProtocolPropertiesPanel` | ✅ |
| `src/components/InstructionForm/InstructionRunner.jsx` | 动态表单 + 发送/导出按钮（已拆：`normalizeRunnerInstruction.js` 归一化、`RunnerFieldTree.jsx` 字段树、`TransmissionLog.jsx` 日志） | ✅ |
| `src/pages/InstructionProcessor.jsx` | 指令加工页，`handleSend` 走 `/dispatch`；**R39 起顶部常驻「路由输入 (ROUTE INPUTS)」条** —— 键值行 + 类型徽标 + `解析 RESOLVE`（`POST /dispatch/routed`）+ 状态条 + `回到上一条 (UNDO)`，**命中即 `setActiveInstructionId` 选中、无命中不猜**；渲染条件为 `currentInstruction`（目标不在册落空态不崩）；行表本体自 **R40 起改用共用组件 `RouteInputTable`**（DOM 与 `aria-label` / `testid` 逐字节不变）；**R45 起状态条下方出「逐条判定轨迹 (TRACE) · N 条」**（`data-testid="route-trace-{n}"`，`MATCHED` 行黄字，回执不带 `trace` 就不出块；`routeTrace` 一次解析开始就清、失败也清，`回到上一条` 只改状态条不清它；挂载**与展开态无关**） | ✅（§8.71），R40 改用共用组件（§8.72），R45 增轨迹（§8.77） |
| `src/pages/Orchestration.jsx` | 编排绑定页，EXPORT .BIN 走 `/export/binary` | ✅ |
| `src/pages/Instruction.jsx` | 指令管理页（含 `handleAddBlock` 默认 bits 初始化） | ✅ |
| `src/pages/DataHub.jsx` | 数据中心页：状态面板 + 聚合导出 + 备份与恢复 + 绑定矩阵；**R17 起「按域导出 DOMAINS」9 域芯片**（顺序 = `BUNDLE_DOMAIN_VERSIONS` 键序 = 导出序，送后端按表排序不看点击顺序）+ R19 示例包（**R44 起 6 域**，与按域导入能吃的范围逐字对齐）+ **按域导入选择器按顶层数组键识别域名**（含 `routing_rules`，FE 不兜白名单第二层） | ✅（§8.37），R17 起按域导出（§8.49），R44 补第 9 域（§8.76） |
| `src/pages/Blueprint.jsx` | 旧蓝图页 | ⚠️ **未接线**（保留勿删，不进路由） |
| `src/pages/Trash.jsx` | 回收站页：`KIND_LABELS`（**8 类**中文名，R37 补 `routing_rule`）+ `KIND_ORDER = Object.keys(KIND_LABELS)` 筛选 chip + 恢复 / 彻底删除 / 批量；`relatedText` **通用求和**（回执多一个键自动并入，无需改） | ✅（§8.44 / §8.69） |
| `src/pages/RoutingRules.jsx` | **发前路由规则页**（第 9 页 · `/routing` · 快捷键 `H`）：列表顺序 = 匹配顺序、表单就地校验、启停 / 删除二次确认、**排序只改草稿、保存顺序只 PUT 真变化的行**；**R40 起页底常驻「试解析 (DRY RUN)」面板** —— 填键值调 `POST /dispatch/routed`，出一行事实 + 恒四行结果表（命中规则 / 目标指令 / 参与扫描 / 缺陷跳过），**按已保存的规则计算、只回显不改状态**，顺序有草稿时当场点破；**R43 起结果表下方出「逐条判定轨迹 (TRACE) · N 条」**（`data-testid="dry-trace-{n}"`，`MATCHED` 行黄字，回执没给 `trace` 就不出块）+ 口径列表补一条 + 未命中脚注改指轨迹 | ✅ 新增（R38 · §8.70），R40 增试解析（§8.72），R43 增轨迹（§8.75） |
| `src/config/pageStatus.json` | 页面状态唯一数据源（**9 页**，数组序 = 侧栏序） | ✅ 改后重跑脚本 |

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
    1. ~~`FLOAT_IEEE` 按普通整数编码（浮点分支要求 `parameter_config.type='float'`，算子模板从不设置）~~ **已解决（E1-4，2026-09-23）**：`op=FLOAT_IEEE` + `byte_len=4`（bits=32）+ 规范 type（缺省/number）→ IEEE 754 float32 大端恒 4 字节（`orchestrator.encode_float_ieee` ↔ `getFieldBytes` FLOAT_IEEE 分支；严格十进制解析同 E1-1 口径，非有限→0，超 f32 范围 → ±Infinity IEEE 溢出对齐 JS Float32Array），byte-equal 向量表 22 例锚定双端测试（`test_encode_float_ieee.py` ↔ E1-4 describe，改一必改二；**R5 起再加 `f64` 组 23 例**）。~~**范围外保留现状**：bits=64（`byte_len=8`）仍走整数路径 / BE zeros（E1-4 只做 float32，如需 float64 另立子项）~~ → **✅ 已由 R5（PLAN §8.42，2026-10-02）收口**：`byte_len=8` 双端真出 float64（`struct.pack('>d')` / `Float64Array`），`vectors/float_ieee.json` 分 `f32`（22 行未改）/ `f64`（23 行）两组，**缺省 f32 逐字节不变**；矛盾 `type=float/string/hex` 模板不会产生，FE 走既有分支、BE 保持 zeros 契约外。
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
