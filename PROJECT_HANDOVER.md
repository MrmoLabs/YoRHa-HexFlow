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
*   `POST /dispatch/` — **进程内环回（loopback）**，返回 ACK 记录，保存在有界 deque（最多 100 条）；`GET /dispatch/history`、`DELETE /dispatch/history`。
    *   **诚实说明**: 当前**没有**真实串口/TCP/WebSocket 传输，`/dispatch` 不是真实链路，仅用于打通前后端发送状态与历史记录。真实传输层是后续工作。

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
1.  **真实传输层**: 串口 / TCP 实现，替换 `/dispatch` 环回。
2.  **通讯调试页 (`/terminal`)**: 目前是占位页，接入发送历史、原始报文与响应面板。
3.  **数据中心页 (`/datahub`)**: 占位页，补 JSON 导入导出、备份恢复。
4.  **绑定持久化**: 编排页的 bindings 目前只在页面内存中。
5.  **位域强校验**: 重叠 / 字节不足目前仅前端提示，可在保存时强校验。

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
*   **编码器已知限制（2026-09 字段覆盖面审计，B2–B8）**: 以下均属 `InstructionEncoder.js` / 双端同步范围，**未获授权勿改**（加工页 UI 已对可展示项做语义标注；2026-09-22 管理页 Phase0：`utils/encoderLimits.js` 为标注单一事实源，面板横幅/⚠角标 + `utils/validateInstruction.js` 保存前校验（Error 阻断/Warning 不阻断），见 `docs/PLAN_InstructionManagement.md`）：
    1. `FLOAT_IEEE` 按普通整数编码（浮点分支要求 `parameter_config.type='float'`，算子模板从不设置）。
    2. `BCD_CODE` 无 BCD 分支（`25 → 0x19`，而非 `0x25`）。
    3. `SCALED_DECIMAL` 的 `factor/offset` 不参与编码（加工页已展示，字节仍按裸整数）。
    4. `INT_SIGNED` 负数用 `Math.abs` 而非补码（`-1 → 01`），加工页 hex 输入也无法表达负数。
    5. `endianness=LITTLE` 仅入库与透传，编码恒按大端（属性面板已加控件并标注“仅存储”）。
    6. `ARRAY_GROUP` 的 `repeat_type/count/ref_id` 可配可存，但编码只展开一次（`FIXED×N` 只编 1 份），加工页不显示重复信息。
    7. `TIME_ACCUMULATOR` 在加工页按用户选择的相对秒数直接编码（`base_time` 仅用于显示换算）；`AUTO_COUNTER` 的 `step/max` 不自动递增，需手输值（语义参数已在表单下方展示）。
*   **Phase 1 偏移标尺（2026-09-22）**: `utils/byteOffsets.js` 纯函数按 `parent_id/sequence` 计算每块起始偏移与指令总长。尺寸口径 = `byte_len > 0` → `parameter_config.computedValue` 字节数（hex 且非 `??`）→ 未知（`··`，总长降级为下限并显示 `+`）；未知尺寸只污染其**后**块的偏移，自身起点照常显示。组起点 = 父起点 + 组内累计（组显示 `@00..`），组卡片直显 Σ 子块可算长度（空组=已知 0B），顶栏 `LEN nB` 并标注 `FIXED/VAR`（`variable = 未知 || computedValue 驱动长度 || DYNAMIC 重复`；口径对齐编码器实际输出——B7 重复只展开一次），另修复 LENGTH_CALC 公式引用组恒 `??` 的缺陷（`useInstructionLanes.nameToValueMap` 原硬编码组为 `??`，现取 Σ 组值、真未知才 `??`，示例状态包长度现算 `05`，并移除死字段 `_displayLen`），总长口径与编排页 `getTotalBytes`（Σ叶子字节）对齐。见 `docs/PLAN_InstructionManagement.md` §3。
*   **Phase 2 复制派生（2026-09-22）**: `utils/duplicateInstruction.js` 两个纯函数：`buildDuplicateInstructionPayload` 派生新指令（后端 POST 无条件发指令 id 且 name/code 双唯一 → 前端重生成全部字段/bit id、重映射 `parent_id`/`repeat_ref_id`/`refs` 防主键冲突与 E2 悬空、`(副本N)`/`-COPYN` 对已加载列表去重，落库后选中）；`duplicateBlockInInstruction` 深拷贝子树插入源块之后（副本 `_N` 改名防 E3、仅副本根进入本道重排序号、refs/formula 保持指向原块 = 未接线副本、完成后选中副本）。骨架模板（P2-2）曾按调研点 3 以真实算子实施，后按人工反馈以「功能多余」整体移除（`utils/skeletons.js`、7 个用例、顶栏「骨架 ▾」菜单已删）。同轮反馈：列表复制入口由生僻符号 ⧉ 改为「副本」文字并提高对比度（构建 CSS 中悬停机制规则已确认存在）；画布新增**长按左键拖拽平移**（二次反馈修正：起点放宽为画布任意处除卡片/控件、3px 阈值、起拖后指针捕获防中断、内容层 `100%+160px` 滚动余量保证双轴可平移、`onClickCapture` 吞掉松手 click 防误清选中/误触泳道聚焦，dnd 拖卡不受影响）。见 `docs/PLAN_InstructionManagement.md` §4。
*   **Phase 3 表格视图与 JSON 导入（2026-09-22）**: 侧栏指令库头部「表格/列表」切换；`components/editor/InstructionTable.jsx` 表格（列 = 代号/设备/名称/总长/字段数——调研点 2 确认 `InstructionResponse` 无 `updated_at`，故无更新时间列；**人工反馈三条**：①全部单元格居中 ②表头自带检索框、绑定页面级 `searchTerm` 与侧栏搜索双向同步并显示 `MATCH n` 行数 ③**导出功能移除**——「导出」按钮、`handleExport`、`buildExportPayload` 及其 2 个用例已删，仅保留导入），行渲染与列表共享同一过滤，点行走未保存确认 wrapper，切回列表状态不丢。`utils/importExport.js` 纯函数 `analyzeImport`（数组或 `{instructions}` → payloads/冲突/错误三分流：name 或 code 与存量或文件内重复、名称代号为空 → 冲突跳过绝不覆盖，`validateInstruction` 结构错按 `[CODE]` 上报；payload 经 `duplicateInstruction.js` 抽出的共用 `cloneFieldsForNewInstruction` 重生成字段/bit id 并重映射 parent/repeat/refs——后端字段 id 按 payload 原样入库，复用文件内 id 会撞源指令主键）。入口在 section 顶栏「导入」：解析失败即报错 → 预览计数（新增/冲突/错误 + 明细截断）→ 顺序 POST → 二次弹窗汇总。测试 107/107（基线 100 + 导入 7；导出 2 例随功能移除），`vite build` 通过，校验器改动文件零违规。见 `docs/PLAN_InstructionManagement.md` §5。
