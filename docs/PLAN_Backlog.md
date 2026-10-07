# 计划：指令管理页收官后的遗留事项总盘（Backlog）

> 创建于 2026-09-22。来源：`PLAN_InstructionManagement.md` 计划内待授权项、
> `PROJECT_HANDOVER.md`「待办 / 下一步」、`pageStatus.json` 各页 nextSteps、
> Phase 2–4 实施测试债审计。
> **审批状态（2026-09-22，用户批复「全通过审批，都做吧」）**：
> A1-b ✅ / B1 双端编码器解禁 ✅ / B2-T3 pyserial 解禁 ✅ / B4-甲 schema 解禁（建表）✅ / A1-x 批量改库 ✅

## 0. 硬约束变更（相对原计划）

- 解禁 `frontend/src/utils/InstructionEncoder.js` 与 `backend/core/orchestrator.py`
  的**编码语义**（仅 E1 批逐子项动；每子项动前设计、动后双端一致性测试）。
- 解禁新增 pip 依赖：**pyserial**（仅 E2-T3 串口模式；其余一律不加依赖）。
- 解禁 `backend/db/models.py`：**仅新增表、不改既有表**（E4 起沿用；2026-09-23
  用户批复 P 系列 C/D/B 新表继续此口径，SQLite `create_all` 自动建表）。
- 其余硬约束继续有效：不碰 `processor.py` / `graph.py` / `Blueprint.jsx`；
  不移除 `pymysql`；`yorha.db` 保持 git 跟踪、**不随批提交**（需同步时单独本地
  commit，先例 8f1b171）；`/dispatch` 环回口径在 E2-T5
  真实传输落地前不变；提交时机 = 每批人工验证后。

## 1. 批次总览与执行顺序

| 批次 | 内容 | 状态 |
|---|---|---|
| M1 | A1 加工页 refs 无 formula 修复 + C1 指令页测试债 + C2 位域后端强校验 | ✅（0ad7a1c） |
| M2 | C3 数据中心页一期 + C4 协议页测试收敛 + C5 编排回归 + C6 加工页渲染下沉 + C7 隐式约定收敛 + C8 README 同步 | ✅（47904ef） |
| E1 | B1 B2–B8 真实编码语义（6 子项，双端编码器解禁） | ✅（23ca9c5） |
| E2 | B2 传输层 T1→T2→T3→T4→T5（T2 TCP 无依赖先行，T3 串口 pyserial） | ✅（3149726） |
| E3 | B3 通讯调试页 /terminal 实装（依赖 E2） | ✅（530f0b4） |
| E4 | B4 编排绑定持久化（甲案：新表） | ✅（394c886） |
| P1 | C 设备档案 + 连接持久化（新表 transport_settings / device_profiles） | ✅（550b73e，db 同步 d95c1e4） |
| P2 | A 事务化发送引擎（应答匹配规则可配 + 超时重发 + RTT/成功率统计） | ✅（18b0dca，db 同步 b052139） |
| P3 | B1 序列编排后端（新表 sequences / sequence_steps + 后台 Runner + 轮询状态 + 与手动发送互斥） | ✅（28c68e4，db 同步 9c84911） |
| P4 | B2 序列编排前端（新菜单页「序列编排」，pageStatus 第 7 项，快捷键 F） | ✅（d33c319） |
| P5 | D 通讯日志落库 + 导出 + 回放（新表 dispatch_logs，三路写入，CSV/JSON 导出，日志重发） | ✅（aa20589，db 同步 b635eac） |
| CP1 | Core Pipeline 批次一：1a 绑定三列 DDL + 1b frame_builder + 1c 发送 wrap 接线 + 1d 文档（`DESIGN_CorePipeline.md` §7 首批） | **已提交 ✅ `31bc367`（代码+文档）/ `da91228`（db 同步），2026-09-24**——反馈 1（星标确认，§8.8）与反馈 2（协议卡面直填，§8.9）均已并入验收 |
| CP2 | Core Pipeline 批次二（防错）：D3 `fit_policy=reject` 执行（**存量槽不迁移**）+ 槽契约 warning 徽标 + 新建槽 UI 默认 reject + D12 删除级联（**`sequence_steps` 失效标记不阻断**，活配置级联删 / 冻结快照留 / 日志留）+ **转义层位统一**（封装试发改带 `wrap` 下发）（`DESIGN_CorePipeline.md` §7 批次二） | **已提交 ✅ `5afe706`（代码+文档），2026-10-01**——**人工验证 5 项已通过**（STRICT 400 / 删指令三分弹窗 / 序列失效只读 / 试发 warnings 徽标 / 真实链路帧）：BE 426/426（基线 383 + 43）、FE 915/915（63 文件）、`vite build` EXIT=0、yorha-ui 校验器 13 文件 0 违规；**零 DDL**（`yorha.db` 未随本批提交）。明细见 §8.19。2026-10-01 起为 CP3 硬前置（CP3 的 3a 复用其 reject 分支） |
| CP2b | D11 分段 ① **向量表共享 fixture 化**（两端测试读同一份 JSON 向量、新增向量只写一处；`DESIGN_Decisions.md` D11 实施注） | **已提交 ✅ `da0179d`（代码+文档），2026-10-01**——跨语言特殊值约定拍板 = **`$v` 包装对象**（`{"$v":"Infinity"}` / `"-Infinity"` / `"NaN"`，其余标量按 JSON 原型天然分型）；新增根目录 **`vectors/`（12 个 JSON 文件 / 15 张表 + 双端加载器 + README）**，13 个后端 / 6 个前端测试文件改读共享 JSON。终态：BE 426/426、FE 915/915（63 文件）、`npx vite build` EXIT=0、yorha-ui 校验器 7 文件 0 违规；**零 DDL**。明细见 §8.20。**不阻塞 CP3**（CP3 只硬前置 CP2 的 reject 分支） |
| CP3 | Core Pipeline 批次三（演进 · 2026-10-01 **扩容并入 D13 封装配方**）：3a `frame_recipes` 数据层 + 串行编译 + 加工页分层预览 + `definition_hash` / 3b 编排页配方编辑器 + 发送接线 / 3c 序列封装帧 D6-B / 3d D5-A 生成 response_spec（**按 D15-A：`response_specs` 增 `stage` 列 + 按层生成 + 逆序解包**）+ D7-A 余下徽标（明细 `DESIGN_CorePipeline.md` §7 批次三 + §9.7） | **已提交 ✅ 3a `e63d76f`（代码+文档）/ `438f3af`（db 同步）、3b `c4b1f7f`（代码+文档，零 DDL）、3c `fbad083`（代码+文档）/ `17c6830`（db 同步）、3d `77dd389`（代码+文档）/ `bb7a0ba`（db 同步），2026-10-01 —— CP3 四个子批全数完成**。硬前置 CP2 ✅；D13 于 2026-10-01 拍板 = A（封装配方）、**3d 前置 D15 于 2026-10-01 拍板 = A**。**3a 含 DDL**（`frame_recipes` 新表 + `instructions.default_recipe_id` 补列自愈）→ yorha.db 单独同步提交；**3a 提前并入了原属 3b 的 `dispatch` `wrap.recipe_id` 接线**（加工页预览/TRANSMIT/事务三路须同字节，缺接线则预览帧与出线帧不同）。3a 终态：BE 466/466（基线 426 + 40）、FE 920/920（63 文件，基线 915 + 5）、`npx vite build` EXIT=0、yorha-ui 校验器 0 违规、**真路由冒烟 25 项 PASS**；明细见 §8.21。**3b 终态**：**纯前端批、零 DDL**（未改 `models.py`/`database.py`，`yorha.db` 未随本批提交）—— FE **924/924（63 文件，基线 920 + 4）**、既有「属性面板四分区 select = 3」用例**零改全绿**（未建配方时编辑器不占 select）、BE 466/466、`npx vite build` EXIT=0、yorha-ui 校验器 3 文件 0 违规、**真 curl 冒烟 13 项 ALL PASS**（真 uvicorn + `curl.exe`：带 recipe 往返 / 不带 wrap 裸帧回归 / 组协议回归 / 残留清零）；明细见 §8.22。**3c 终态（2026-10-01）**：**含 DDL** —— `sequence_steps` 新增 `wrap JSON` 单列自愈（`database.ensure_sequence_step_columns`，镜像 3a `ensure_recipe_columns` 先例）→ yorha.db **单独同步提交**；BE **496/496（基线 466 + 30）**、FE **932/932（63 文件，基线 924 + 8）**、`npx vite build` EXIT=0、yorha-ui 校验器 4 文件 0 违规、**真路由冒烟 30 项 ALL PASS** + **真浏览器 UI 验证 6 项通过**；明细见 §8.23。**3d 终态（2026-10-01）**：**含 DDL** —— **3 列仅新增**<br>（`response_specs.stage` / `response_specs.definition_hash` /<br>`protocol_bindings.definition_hash`，`ensure_response_spec_columns` 新建 +<br>`ensure_binding_columns` 扩列自愈，lifespan 接线）→ yorha.db 沿先例<br>**手工只跑 3 条 ALTER 后单独同步提交**；BE **537/537（基线 496 + 41）**、<br>FE **944/944（63 文件，基线 932 + 12）**、`npx vite build` EXIT=0、yorha-ui<br>校验器 8 文件 0 违规、**真路由冒烟 43 项 ALL PASS**；明细见 §8.24。**§9.7 人工验证收口（2026-10-02）**：3a①②③ + 3b①②③ + 编排页「洞位填装 → 封装试发」**8 项真浏览器 + `/dispatch/history` 对账复跑全过**（含 400 逐槽拦截与「未选配方 = 建配方前基线 28B 逐字节相同」），三处文档（§9.7 / `pageStatus.json` / HANDOVER 35·36 待办①）口径已统一，明细 §8.27 |
| CP4 | Core Pipeline 批次四（治理）：**4a** 关系数据导入导出（`bindings` + `response_specs` 并入 DataHub ZIP `relations.json` + `POST /datahub/import/relations`）/ **4b** 绑定矩阵视图（指令 → 默认协议 → 槽位）+ §6.2「槽节点删除 → `slot_id` 悬空置 NULL 回执」+ D9/D10 划界落 README/PAGE_STATUS / **4c** D8 校验表全量核对（逐行销项，纯文档）（明细 `DESIGN_CorePipeline.md` §7 批次四） | 🔄 **4a 已提交 ✅ `54620ab`（代码+文档，零 DDL），2026-10-02**：导出 ZIP 增 `relations.json`（`manifest` 增 `relations` 计数、`/status` 增 `protocolBindings`/`responseSpecs` 两行计数）+ 回灌端点按 `id` upsert、逐行报告（父缺失 → `skipped` 带 reason、槽悬空 → 置 NULL + warning、默认唯一冲突清旧行、`spec` 过 `normalize_spec` / `stage` 重算镜像 / 出处原样回填）、**部分成功即部分落库不整批回滚**；前端 DataHub 增「关系数据」面板（选文件 → 解析校验 → 确认弹窗 → 回显 新增/更新/跳过/警告 计数 + 刷新）。终态 BE **549/549**（基线 537 + 12）、FE **948/948**（63 文件，基线 944 + 4）、`npx vite build` EXIT=0、yorha-ui 校验器 4 文件 0 违规；**零 DDL**；明细见 §8.25。**4b+4c 已提交 ✅ `03b25d3`（代码+文档，零 DDL），2026-10-02**：**4b** 绑定矩阵只读面板（`utils/bindingMatrix.js` 纯函数 + DataHub 页六列表 + 摘要八项计数；孤儿不静默 —— 协议已删 / 槽悬空 / `stale===true` 琥珀标出；三读与状态面板同拍、单读失败互不拖垮）+ D9/D10 划界落 `README.md` §6 Scope Boundaries 与 `pageStatus.json` 四页条目（`PAGE_STATUS.md` 再生）；**4c** 全量核对新增 `DESIGN_CorePipeline.md` §6.3 销项表 —— 8 行**全「已有」、0 待补**，§6.2 槽节点行复核为批次二已落地（`dangling_slots_cleared`）→ **本批零后端改动**（BE 用例数持平），`DESIGN_Decisions.md` D8/D9/D10 三表行 + 三处实施注（D9-B/D10-B 重开条件已具备**仍取 A**）。终态 BE **549/549**（持平）、FE **958/958（64 文件，基线 948 + 10）**、`npx vite build` EXIT=0、yorha-ui 校验器 4 文件 0 违规、**人工验证 3 项通过**；明细见 §8.26。**批次四三子批（4a/4b/4c）全数完成** |
| C 已拍 | **5 项拍板已收齐**（§8.36 拍板结果表：C-1 自动选指令路由 / C-2 响应解码为字段 / C-3 全量项目包迁移 / C-4 应答带转义 / C-5 三项暂缓；另含 R6 方案） | ✅ **2026-10-02 全部拍定**：C-1=**A 不立项** / C-2=**C** / C-3=**C** / C-4=**确认接受** / C-5=**①② 触发式、③ 不做** / R6=**13 表加 `deleted_at`** → 编入 **R7–R10** |
| R1–R10 | **B2 六项功能缺口 + 拍板选中项排期**（导入 pre-import 快照 / 传输配置上一配置回退 / ESLint 存量 / 编排页绑定拖拽 / float64 双端 / 软删除回收站 + C-3 补域 2 批 + C-2 解码 2 批）—— 顺序 = 先安全网 → 清欠账 → 体验 → 正确性 → 最后动 DDL | ✅ **R1–R10 全数完成（R1 ✅ §8.38 / R2 ✅ §8.39 / R3 ✅ §8.40 / R4 ✅ §8.41 / R5 ✅ §8.42 / R6 ✅ §8.43+§8.44 / R7 ✅ §8.45 / R8 ✅ §8.46 / R9 ✅ §8.47 / R10 ✅ §8.48；R8 = 2026-10-02、R9 = R10 = 2026-10-03）**（**R4 ✅ 已按拍板落地**：拖完只改展示序、点保存按钮才改持久序；**R5 ✅ 已落地**：float64 双端 + 向量 `f64` 组、缺省 `f32` 逐字节不变（§8.42）；**R6 ✅ 已落地（两批）**：R6-1 = 13 表统一 `deleted_at`（仅新增列）+ 软删/恢复/彻底删除 + `/trash` 统一入口（§8.43）；R6-2 = FE 回收站页 `/trash` + 五处删除确认改「移入回收站、可恢复」+ 页面状态登记与 `PAGE_STATUS.md` 重生成（§8.44）；**R7 ✅ 已落地（§8.45）**：`bundle` 3 域 → 8 域（补 recipes / sequences / transport / profiles / templates）+ `manifest.domainVersion` 8 域清单 + 读侧 `alive()` 收口，**零 DDL**、测试 +8 → 676；**R8 ✅ 已落地（§8.46）**：`POST /datahub/import/` 补 5 域（recipes / sequences / transport / profiles / templates），三段式 400 不落快照 → pre-import 快照 → 逐行提交，校验复用各域 SSOT；FE 一个选择器按顶层数组键识别域名；**零 DDL**、测试 +9 → 685；**R9 ✅ 已落地（§8.47）**：对偶解码器 `InstructionDecoder` —— 布局与编码器共用 `buildLayout()`、值分派同序，反向验证 = `encode ∘ decode = id` 不动点扫七组 `vectors/` 向量 + 整帧；接入事务面板命中应答（`DecodedFields`）与发送历史「字段 FIELDS」列 + 详情完整字段表；**纯 FE 零 DDL**、测试 +30 → 1066；**R10 ✅ 已落地（§8.48）**：**入库回写** —— `dispatch_logs` **仅新增列** `fields_json`（`migrate.py` 追加 `Migration(3, "dispatch_logs_fields_json")`，**全计划唯一 DDL 批**，verify 钉死「恰好一张表」）；解码**不写第二套布局**（复用 `fields_to_blocks` + `Orchestrator.flatten()`，编译口径纯搬进 `core/field_blocks.py` 后 `datahub` **原名再导出**，测试一行未改）；四条写入缝（manual / transaction / sequence / replay）统一过 `db/log_store.record_log` **单一接缝**自动回填、`resolve_log_fields` **绝不抛**、无应答/查不到指令/无字段布局一律 `NULL`；`/dispatch/history` 回填 `DispatchRecord.fields`（与 `fields_json` **同一次解码**）+ `/logs` 列表与 JSON 导出回填、**CSV 列集逐字不变**；FE `decodeHistoryRow` **优先吃服务端 `record.fields`**、回落 R9 客户端解码（存量行行形状逐字不变）；存量行**不回填**；测试 **BE 685 → 723（+38）、FE 1066 → 1069（+3，71 文件）**；**自 R3 起 `npm run lint` EXIT=0 进验收门槛**；§8.37；**11 批已全数完成**，R6/R10 含 DDL 仅新增列） |

| R11–R18 | **R10 后剩余项盘点与排期**（三处过期说法纠正 + 剩余项四类分流 + 序列步骤拖拽 / 回收站批量 / 串口枚举 / 档案改名·轮询 / 报文格式 / 按域独立导出 / 字段引用测试） | ✅ **R11–R18 八批全部完成（2026-10-03 连续落地）**：**R11 已完成 ✅（§8.49 文档批，2026-10-03）**：`pageStatus.json` 指令页 `availableNow`+`nextSteps`、编排页 `nextSteps` 三处过期说法纠正（B2–B8 标注 / B2–B8 真实语义 / 绑定拖拽）+ §8.14 与 §8.34 B3 补「解码回程由 R9+R10 收口」销项注 + 本节盘点排期 + `PAGE_STATUS.md` 重生成。**R12 已完成 ✅（§8.49：序列步骤拖拽排序 —— 纯 FE 零 DDL，拖完只改草稿序、点「保存定义」才 PUT，FE 1069 → 1072）**、**R13 已完成 ✅（§8.49：回收站类型筛选 + 批量恢复 / 批量彻底删除 —— 纯 FE 零 DDL，逐条串行、半成如实回报，FE 1072 → 1075）**、**R14 已完成 ✅（§8.49：串口端口枚举 + 波特率预设 —— `GET /transport/ports` 只读降级绝不 500、自然序排 COM 口，零 DDL，BE 723 → 727、FE 1075 → 1078）**、**R15 已完成 ✅（§8.49：档案重命名 + 状态/历史自动轮询 —— 纯 FE 零 DDL，改名只 PUT label、轮询仅标签页可见时走，FE 1078 → 1081）**、**R16 已完成 ✅（§8.49：报文格式切换 hex / ascii / bin —— 纯 FE 零 DDL，三面板一个开关、只换显示口径不换字节，FE 1081 → 1086）**、**R17 已完成 ✅（§8.49：按域独立导出包 —— `?domains=…` 只出所选域、缺省不带参数 = 现行 8 域逐字不变，零 DDL，BE 727 → 733、FE 1086 → 1092）**、**R18 已完成 ✅（§8.49：字段引用测试补强 —— 纯测试零代码，`references` 计数 × 块移动 / 保存失败恢复的交叉面 +6 例，FE 1092 → 1098）**；**需拍板 3 项**（加工页传输展示与切换 vs D9-A / 数据包示例下载口径 / 档案自定义排序 = DDL）与**仍需真机 1 项**（§9.7 ① 出线方向）登记在 §8.49 三（**三项拍板已于 2026-10-03 落定 → §8.50**；**真机 1 项亦已销 → §8.51**） |
| R19–R20 | **拍板后追加排期**（§8.50：① 加工页传输展示与切换 = **维持 D9-A 不立项**、② 数据包示例下载 = **动态导出**、③ 档案自定义排序 = **`sort_order` DDL 解禁**） | ✅ **R19 已完成 ✅（§8.50：数据包示例下载 —— 动态出按域导入的 5 域、复用 R17 `?domains=` 子集，零后端改动零 DDL，FE 1098 → 1099）**、**R20 已完成 ✅（§8.50：档案自定义排序 —— `device_profiles.sort_order` 仅新增列 + migration 0004 + `PUT /profiles/order` 整表一次提交，拖完只改草稿序；BE 733 → 743、FE 1099 → 1106；db 同步另开 `chore(db)` 提交）** |
| §8.51 | **§9.7 ① 出线方向销项**（「有 LEN = 不需要转义」在载荷含定界字节时是否异常）—— 按 §8.35 同套方法**联网取公开规范真帧 + 仓内仿真**：IEC 60870-5-104 / DL/T 645-2007 / Modbus TCP 三条**有长度域**协议 + 本仓三层壳出线反解 + **无 LEN 反例** | ✅ **已完成（2026-10-03，零代码改动、零 DDL、零 `pageStatus` 变更）**：新 `backend/tests/test_wire_delimiter.py` **10 例**，**BE 743 → 753/753**、FE 1106/1106（未碰前端）；**「需真实设备帧」这一类自此无开放项** |

| R21–R28 | **七项复议拍板全数立项**（§8.52：C-5 ② 长度域 BE/LE → R21、C-5 ① CRC 多算法 → R22、挂账 ① epoch → R23、挂账 ③ 切 op → R24、挂账 ② 加扰 → R25、C-1 B 序列分支 → R26（含 DDL 仅新增列）、C-5 ③ varint/COBS 拆两批 → R27 出线 / R28 解包） | ✅ **R21 已完成 ✅（2026-10-03，§8.53：长度域 `byte_order` —— BE+FE 零 DDL，收侧本就支持、补出线与出口翻译 + 应答声明；**顺带修**设计期 ≥2 字节真值被空格切坏的存量缺陷；新增共享向量 `vectors/length_order.json` 7 行，BE 753 → 768、FE 1106 → 1117）**；**R22 已完成 ✅（2026-10-03，§8.54：CRC16-CCITT / CRC32 / LRC —— 六张白名单 + `operator.py` 算子模板同批成对改；收侧 `ALGO_FIELD_WIDTH` 只加 ≥ 下限、`crc16_modbus` 遗留精确 2 字节逐字不变；共享向量 `vectors/checksum_algo.json` 30 行双端同读，期望值取自 `zlib` / `binascii` 外部真值；BE 768 → 793、FE 1117 → 1127）**；**R23 已完成 ✅（2026-10-03，§8.55：`TIME_EPOCH` 绝对时间戳算子 —— BE `encode_time_epoch` + 序列计划补丁 + `KNOWN_OPS` 20 → 21 + 算子模板，FE 编码分支 / normalize 保身份 / `EPOCH` 只读章 / 计划条目；共享向量 `vectors/time_epoch.json` 11 行双端同读，BE 793 → 808、FE 1127 → 1139）**；**R24 已完成 ✅（2026-10-03，§8.56：创建后切换 op —— 属性面板 `op_code` 只读 span → 下拉 + 兼容校验 + 确认回执；新建与切换共用 `applyOpDefaults` 单源（顺带修模板数组污染）+ BE `_validate_op_switch` 保存侧兜底，BE 808 → 824、FE 1139 → 1163）**；**R25 已完成 ✅（2026-10-04，§8.57：加扰 / 混淆字段 —— 新算子 `SCRAMBLE`（ENCODING 类目）明文异或种子 / 位旋转，出线只改本字段字节；FE 编码分支 + 卡面显**加扰后线上 hex** + 加工页只读 + 反加扰解码，BE `encode_scramble` / `unscramble_hex` + `_validate_scrambles` 保存侧 400，`KNOWN_OPS` 21 → 22 + 算子模板 `mode` / `seed` / `roll`（缺省种子 A5）；共享向量 `vectors/scramble.json` 14 行双端同读，BE 824 → 843、FE 1163 → 1196）**；**R26 已完成 ✅（2026-10-04，§8.58：序列级分支 —— `sequence_steps.condition` **仅新增列**（Migration 0005 + 启动自愈两列同批 + datahub 导出带条件），受限表达式求值器**双端同语义**（`== != >= <= > < in` 六比较符 + 关键字，**无 eval**，共享向量 `vectors/condition.json` 58 行），runner 四分口径（条件空→原路径 / 真→执行 / 假→`SKIPPED` 不延时不发送不落日志 / 非法→`ERROR` `COND:` 结构化诊断），变量上下文 = `step.<n>.*` 逐步累积 + 应答解码字段平铺，序列页「执行条件」输入**就地校验** + `COND ::` 指示 + 跳过原因进 tooltip；**前置证明 = 无条件序列零解码零增量**（专项测试钉住），BE 843 → 878、FE 1196 → 1213）**；**R27 已完成 ✅（2026-10-04，§8.59：varint / COBS **出线** —— length 卡 `encoding`（LEB128 最小无符号、字节序中立、**出线后回写 `byte_length`**）+ 协议树新组帧元素 `cobs`（`Orchestrator` 第 0 步由内向外前置改写、正文无裸 `00`、**解码不进生产代码**）+ 保存侧 refs 指向 COBS 内部 400 + 偏移尺两遍法回灌精确出线宽；**零 DDL（无 `chore(db)`）**，Phase 0 先证「无变长编码时逐字节不变」；共享向量 `vectors/framing.json` 3 表 35 行双端同读，BE 878 → 917、FE 1213 → 1247）**；**R28 已完成 ✅（2026-10-04，§8.60：varint / COBS **解包** —— 收侧新模块 `backend/core/unframe.py`（`decode_varint` / `cobs_decode`，`framing.py` 一行不改仍纯编码）+ 应答规格 `length.encoding`（fixed/varint）与 `unpack.mode=cobs`（`inner_head` / `inner_trailer`）+ 新 reason 码 `LENGTH_VARINT_INVALID(原因)` / `STAGE[i].UNPACK_COBS_INVALID(原因)` / `STAGE[i].UNPACK_INNER_TOO_SHORT(n<=m)` + 生成侧**逐要素降级**（只少判不误判，多层几何算不出 → 400）；FE 只做规格表单 ENCODING 下拉（**只写非缺省值**），不建无消费者的解码模块；**反向消费既有 `vectors/framing.json`、不新增向量文件**；**零 DDL（无 `chore(db)`）**，Phase 0 金标准先钉「改前形态逐字节不变」；**BE 917 → 955、FE 1247 → 1251）**；**加工页传输展示与切换**复议维持 D9-A 不立项** |

| R29 | **加工页条件存在 (PRESENCE) 展示层** —— 用户人工测试反馈「满足 IF 条件的与不满足 IF 条件的时候，指令加工中本条指令的字段从肉眼上看不出区别」（§8.61；**非 §8.52 复议范围，独立批次**） | ✅ **已完成（2026-10-04，§8.61，纯 FE · 零 DDL → 无 `chore(db)`）**：新纯函数 `resolvePresenceStates`（**只委托** `InstructionEncoder._presenceHit`，与出线编码同源 fail-open，不造第二套判据）+ `SmartInput` 新 prop `presence` → label 区 `IF` 琥珀章 + 右槽 `[SKIP 0B]`（**顶到最高优先**，压过 TIME_PICKER / READ_ONLY / 用量 / 长度）+ `RunnerFieldTree` 新 prop `presenceStates` → 叶行 / 组头出章、未命中 `opacity-50`（组未命中整棵子树随之降透明）+ `InstructionRunner` 造表（依赖与 `hexPreview` / `byteMap` **同组** → 角标与 BYTE_STREAM、`LEN` 恒同步）；**`presenceStates` 缺省 `null` = 零渲染 → `Sequences` 步骤编辑器零改动**；输入与限宽一律不禁用、**判定与字节一行未改**；红测先行（stash 实现后 19 failed / 2 passed → pop 后 24/24 绿）；**BE 955/955（持平）、FE 1251 → 1275/1275（84 文件，+24）**；判定链两处坑（expect `"01"` vs 枚举数值 `1`、无值链 fail-open）**登记为 §8.61 第七节可选项**，不并入本批 |

| R30 | **presence 可见性收口** —— R29 自己登记的两个「半成品」（§8.62；同属「看得见没」主题，**非** §8.52 复议范围） | ✅ **已完成（2026-10-05，§8.62，纯 FE · 零 DDL → 无 `chore(db)`）**：① **进制/补零假阴性提示** —— `resolvePresenceStates` 的 `title` 仅在「miss 侧 + expect 整串十六进制可解析 + 解析值与当前值数值相等」三条同时成立时追加（`01`↔1 会提示、`9`↔1 与 `ALPHA` 不提示，宁可少判不误判），纯展示不参与比对；② **第二消费方自算** —— `RunnerFieldTree` 的 `presenceStates` 缺省语义由「`null` = 零渲染」改为「`undefined` = 用本组件手上的 `fields`/`inputs` 自算」（与显式传表**同一个 helper**，顶层只算一次、递归透传），`Sequences.jsx` **一行未改**即出同款 `IF` / `[SKIP 0B]`，加工页与步骤编辑器口径必然同源；显式 `null` 逃生口与 `InstructionRunner` 的 memo 显式表**均保留**。**判定 / 编码 / 校验四码一行未改 → 出线字节逐字不变**，判定归一继续挂 §8.61 第七节待拍板；红测先行（stash 两实现文件 → presence 三文件 7 failed / 31 passed + `Sequences` 1 failed / 27 passed → pop 后 42 例全绿）；**BE 955/955（持平）、FE 1275 → 1290/1290（84 文件，+15）** |

| R31 | **presence 设计期效度三码** —— §8.61 第七节第 ② 项「ref 无值链校验提醒」的正主，扩成三个面（§8.63；同属「这条条件到底成不成立」主题，**非** §8.52 复议范围） | ✅ **已完成（2026-10-05，§8.63，纯 FE · 零 DDL → 无 `chore(db)`）**：新增三条 **W 码**（全落 warnings → 保存只拦 errors，**零行为变更**）——① `PRESENCE_REF_NO_SOURCE`：引用字段无 `pc.value` / 非输入型 / 无选项 / 非计算类**且**是只读固定算子 → 编码期只能取 `undefined` → **恒 fail-open 判命中 = 等于没配**；② `PRESENCE_EXPECT_UNREACHABLE`：有下拉选项（封闭集）却**无一**与 `String(expect)` 相等 → **选哪项都不成立**（样本② 的设计期可见版）；③ `PRESENCE_HEX_PAD`：静态值与 expect 十六进制解析相等却 `String` 判不等 → **静态链恒未命中**。判据一律**表外不算、宁可少判**（可自由键入 / 非锁定 / 无候选全集一律不报），悬空 ref 与不完整配置各归原码**不叠报**。同批把 R30 的比较谓词抽成叶子模块 `utils/presenceSemantics.js`（零依赖无环）→ **角标 hover 与设计期提醒 import 同一实现**（`formatEnumOptions` 从 `runnerRenderRules` re-export，既有 70 例一行未改）；**判定 / 校验四码 / normalize / 编码分支一行未改 → 出线字节逐字不变**，BE 零改动（BE 本就无 presence 校验码）。红测先行有据（实现前 7 failed / 14 passed → stash 复红 7 failed / 14 passed → pop 后 21 例全绿）；**BE 955/955（持平）、FE 1290 → 1311/1311（85 文件，+21）**（本行 ③ 码已由 R32 判定归一退役、② 判据已改 `presenceEqual`，见 §8.64） |

| R32 | **presence 判定归一** —— §8.61 第七节第 ① 项（首个**会改字节**的判定修正，用户拍板连做并接受字节变化）（§8.64；**非** §8.52 复议范围） | ✅ **已完成（2026-10-05，§8.64，纯 FE+BE · 零 DDL → 无 `chore(db)`）**：新增谓词 `presenceEqual(expect, value)` = `String()` 归一（N3 存量口径逐字保留：数值 1 命中 `"1"`）**∪ 十六进制归一**（expect 是**字符串**且整串 `^[0-9A-Fa-f]+$` 且在安全整数内 → 与 `comparableNumber(value)` 数值相等即判**命中**，`"01"` ≡ 1、`"0A"` ≡ 10 —— 样本② 拍板项）。**三个判定点同用一个谓词（改一必改二 + 一）**：FE `InstructionEncoder._presenceHit`（运行期）/ FE `byteOffsets.presenceStaticState`（设计期静态链，不跟就「编码命中、卡面按 0 字节排偏移」）/ BE `field_blocks._presence_hit` → `_presence_equal`（byte-equal 锚点）。三条边界**宁可少判**：仅字符串 expect（JSON 数字 `10` 不按 hex 解）、**不做 trim**（`" 1"` 非整串 hex）、超安全整数不归一（`Number.isSafeInteger` ↔ Python `2**53-1` 同阈）。**存量影响清单（会改字节的全集）**：`vectors/presence.json` 的 `[{"expect":"01"} → "AA"]` 翻成 `"AABB"` —— **唯一一条向量变化**（两端同读一份自动同步）；无 presence 的指令与其余 17 份向量**逐字节不变**，`/dispatch` 缺省口径不变；N3 四码 / fail-open 四支 / 判定先于 repeat 的顺序**一行未动**。**展示层随判定收口**：R30 的 miss 侧假阴性注记翻到**命中侧**（`· 按十六进制归一判等（expect "01" ≡ 值 1 = 1…）`）、R31 W `PRESENCE_HEX_PAD` **退役**（前提不复存在）、R31 W `PRESENCE_EXPECT_UNREACHABLE` 改用 `presenceEqual` 判候选（样本② 归一后可达 → 不再报）。红测先行有据（实现前 BE 4 failed / 14 passed + FE 6 failed / 51 passed → 实现后 BE 18/18、FE 57/57 全绿，R30/R31 展示层用例随语义翻面同批改写）；**BE 955 → 963/963、FE 1311 → 1323/1323（85 文件，+12）** |

| R33 | **加工页 presence 未命中字段纯隐藏** —— 用户新需求「没触发的字段直接隐藏掉，防止干扰使用者」，两项 UX 取舍拍板（**纯隐藏不留入口** + **仅加工页**）（§8.65；**非** §8.52 复议范围，独立批次） | ✅ **已完成（2026-10-05，§8.65，纯 FE · 零 DDL → 无 `chore(db)`）**：`RunnerFieldTree` 新增 opt-in prop **`hidePresenceMissed = false`** —— 算出 `presenceMiss` 后直接 `return null`（**组与叶同一判定点**，组返回即整棵子树消失，递归透传至深层），**缺省 false 分支永不进入 → `Sequences.jsx` 一行未改**仍出降透明 + `[SKIP 0B]`；`InstructionRunner` 为唯一接线点；顶层全字段皆未命中时出兜底**事实行**（`[HIDDEN] 无可填字段…`，无按钮无展开入口 —— 否则空白被当成页面坏了，有任一可见字段即不出现）。**纯展示层**：判定表仍是同一张 `resolvePresenceStates`（同源判定 + 分叉展示），判定 / 编码 / 偏移尺 / 校验四码**一行未改 → 零字节变化**（测试锁「字段被藏 LEN 照样随判定 +1」）。红测先行有据（实现前 **7 failed / 26 passed** → 实现后全绿）；`InstructionRunner.presence` 装配测试**同批改写**（R29 靠 miss 形态证接线，R33 后加工页 miss 不可见 → 改两头锁：初始即命中出 `IF(hit)` + 默认未命中不出、改 ref 命中才出现、改回又消失）。**BE 963/963（持平）、FE 1323 → 1335/1335（85 文件，+12）** |
| R34 | **校验和字节序** —— R21 长度域的**成对缺口**（§8.53 尾行登记「checksum 的 `byte_order` 未立项，需另开」+ `blockTypes.js` 代码注释同款留档，文档与代码双重登记）（§8.66；**非** §8.52 复议范围，独立批次） | ✅ **已完成（2026-10-05，§8.66，FE+BE · 零 DDL → 无 `chore(db)`）**：协议 checksum 卡增列 `byte_order` —— **复用 length 的同一 `BLOCK_PROPERTY_FIELDS.byte_order`**（同存点 / 同值域 / 同缺省 `big`），面板走既有通用 select 分支 → `ProtocolPropertiesPanel` **零 JSX 改动**。**同用一个字节序门面**：`byte_order_of` / `apply_byte_order` 上移 `handlers/base.py`，length + checksum 两个 handler 共用（`length.py` re-export 保住既有 import）。**BE 四处** = `ChecksumHandler` **两个 return 同位套用**（refs 模式 + 旧区间模式，换引用方式不换形态）· `frame_builder._with_byte_order` 闸门放开到 checksum（`_with_encoding` 一行未动 → varint 仍 length 专属）· `response_generate._checksum_element` 硬编码 `"big"` **改从 pc 取**（镜像 §8.53 表第 ④ 项 `_length_element`，否则出线小端而比对规则按大端比**必然失配**）。**FE 四处** = `blockTypes` 卡字段 · `toFrameBlocks.withLogicParams` 闸门放开（encoding 另设二级闸，防 `pc.encoding` 误写进 checksum）· `protocolTree` **两个计算点同用一份反转**（`collectDeterministicBytes` 容器内容 + `injectRefsSigma` 卡中央值）· `validateProtocol` W5 同码覆盖（文案按块型分叉）。**收侧本就支持、零改动**（`response_match._CHECKSUM_KEYS` 与 `sequence_plan` 早含 `byte_order`）。共享向量 `vectors/checksum_order.json` **12 行 = 6 算法 × 2 字节序**，真值链不自证（`expected_big` 逐字取自 R22 `checksum_algo.json` 的外部真值、`expected_little` = 字节反转；1 字节算法两侧同串 → 把「单字节不反转」也钉进表里）。**缺省路径逐字节不变**（§0）：面板读侧 `?? field.default` 只回显不落值、`createBlock` 不播种 → `parameter_config` 形状不变，只有真选到 `little` 才出现该键。红测先行有据（实现前 **BE 11 failed / 14 tests** + **FE 9 failed / 108 passed**），**三处既有测试同批翻面**（`test_checksum_blocks_ignore_byte_order` → `..._honour_byte_order`、`toFrameBlocks`「非 length 不写」→「闸门只开两卡」、`blockTypes`「checksum 不列」）。**BE 963 → 977/977、FE 1335 → 1349/1349（85 文件，+14）** |
| R35 | **前端路由级拆包** —— `vite build` 每批报的「chunk > 500kB」技术债（**无既有登记项**，build 输出本身即凭据：8 个页面在 `App.jsx` 全是静态 import，用户一次只开一页却全进首屏）（§8.67；**非** §8.52 复议范围，独立批次） | ✅ **已完成（2026-10-05，§8.67，纯 FE 构建层 · 零 DDL → 无 `chore(db)`）**：新增 `utils/routeChunks.js`（**页面模块单一登记表** `ROUTE_LOADERS` = 8 个动态 import · `routeComponent` 返回**缓存过的** `React.lazy` 实例（不缓存则每次渲染新建组件 → 整页重挂载）· `prefetchRoute` 复用同一份 pending Promise（hover 多少次只发一次、失败 `.catch(→null)` 不打断导航）· `__resetRouteCaches` 仅测试隔离）+ 新增 `components/RouteLoading.jsx`（Suspense fallback：`[ MODULE LOAD ]` 工业标记 + 按 `useLocation` 查 `PAGE_STATUS_BY_PATH` 出中文页名、**未知路由回落站点名不臆造** + `role="status"`/`aria-live`；**只陈述「正在载入哪页」不画假百分比** —— 拆包加载没有可度量的进度，8 段待机格表达「等待」）。`App.jsx` **删 8 行静态 import** → `renderRouteElement` 改按 `pageKey` 取组件后**原样注入各页 props**（未知 key 仍 `<Navigate to="/protocol">`）、`NavItem` 增 `pageKey` 走 `onMouseEnter`/`onFocus` 预取、**Suspense 边界放在 `key={location.pathname}` 之外**（换路由时边界自身不重建，已访问过的页切回来不重闪 fallback）。**体量账（两次 `npx vite build` 实测）**：`assets/index-*.js` **752.85kB（gzip 243.50）→ 325.42kB（gzip 113.64）**，8 个页面 chunk **10.43–56.63kB**，**500kB 警告消失**；`manualChunks` 分 vendor 判为无效（依赖极轻：react / router / dnd-kit 无 lodash 无图表库，vendor 只砍约 200kB 而本项目代码自身就超线）故不选。**零字节影响**（BE 一行未改，`/dispatch` 缺省口径不变）。**pageStatus.json 零改动**（该文件按页登记「本页具备哪些能力」，本批是外壳/构建层改动不给任一页新增能力 → 生成物 `docs/PAGE_STATUS.md` 同步为零）。红测先行有据（实现前 **2 个测试文件整体红 = 模块不存在**；落一轮后剩 1 failed 属**测试自身 bug** —— React 19 的 `lazy` 返回 lazy 组件对象非函数，先修测试再算数）；**BE 977/977（持平）、FE 1349 → 1362/1362（87 文件，+13）** |
| R36 | **发前路由 · BE 数据层** —— §8.52 复议时被**明确划在本列外**的「C-1 C 发前路由」（§8.36 例 B：同一个执行按钮，`meter_id = 0001` 该发指令 X、`= 0002` 该发指令 Y，发生在**进入序列之前**），2026-10-06 用户对 §8.52 拍板 A 不立项**翻案**，按**原选项 C** 规格立项、分 2–3 批（§8.68） | ✅ **已完成（2026-10-06，§8.68，纯 BE · 仅新增表 → 零 Migration、无 `chore(db)`）**：**新表 `routing_rules`**（`id` / `name` 唯一 / `condition` / `instruction_id` 逻辑外键 / `sort_order` / `enabled` / `description` / `created_at` / `updated_at` / `deleted_at`）—— 合 §0「仅新增表」明文；**新表不走 `migrate.py`**（`create_all` 对既有库也会建出，REGISTRY 五条全是加列）。**匹配器 `backend/core/routing.py` 直接复用 `core/condition.py` 受限表达式，不造第二套判据**（与 `sequence_steps.condition` 同一门语言、同一份 SSOT、FE `utils/condition.js` 逐行同语义），口径五条：`(sort_order 升序, name 升序, id 升序)` 定序（不依赖插入顺序与返回顺序）· **first-match-wins** · 停用（`enabled=0`）与回收站行不参与 · 条件**语法**坏掉记进 `invalid` 并**继续往下扫**（保存侧 `parse_condition` 已拦 400，运行期踩到只可能来自直接改库 —— 一条坏规则既不该让整条路由 500，更不该让它误命中）· 变量不在输入里 / 类型不可比 = **普通不命中、不记 `invalid`**（第 4、5 条抛的同为 `ConditionError`，靠**先单独 `parse_condition` 过一遍**区分开：解析期挂 = 规则坏了，求值期挂 = 这次输入没给它要的键）；**全无命中 → `matched=false`，绝不回落第一条**（不猜）。**端点 `POST /dispatch/routed`（新增）只解析不发送**，回执 `matched / rule / instruction_id / instruction / invalid / considered` **六键、无 `status`·`attempts`·`hex_string`**（出现即说明串进了 `/dispatch` 缺省口径）；命中顺带回**指令全文**（FE 省一次 `/instructions` 往返）。CRUD `/routing-rules` 按 `response_spec.py` 同款范式：判重查**全表**（软删行继续占名 → 先 400 拦住不漏 500）· 目标必须是**活**指令 · **先校验再落笔**（条件/指令/名字任一不合法整单中止，不留半改状态）。**回收站白名单补 `routing_rule`** —— 没有它，`DELETE /routing-rules/{id}` 打的软删标记就是**永久黑洞**（读侧 `alive()` 滤掉、回收站又不认识）。**意外收获：修好 `migrate.py` 三条 verify 的范围钉**（详见 §8.68 五）—— 原「从 `Base.metadata` 全量派生 + 精确集合断言」被新表当场打红（0002/0004/0005 三条同时红 → `run_pending_migrations` 整条回滚 → **每个库都起不来**），改口径为**冻结史实名单 ∩ models**，两个防漏方向都保住、只是不再误伤后来新增的同名列。红测先行有据（实现前 1 个测试文件**整体红 = `ModuleNotFoundError: backend.core.routing`**，属缺特性本身；落一轮后剩 1 failed 属**测试自身 bug** —— 恢复后原行仍占名，按 §8.43 改断言再算数；全量回归再翻 **1 条既有钉** —— 回收站白名单「恰好 7 类」实得 8 类，属**测试随新事实改写**并补显式 `assertNotIn`，三档性质分开记账）；**BE 977 → 999/999、FE 1362/1362（持平，纯 BE 批）** |
| R37 | **发前路由 · 集成收尾** —— 把 R36 §8.68 八 挂的两条留白（指令删除的引用计数与级联、回收站中文名）一次补完（§8.69）。**拆批理由**：这两件事与 UI 无关、却决定「删指令会不会留下悬空规则」—— **先把数据完整性洞补上，再让 R38 的 UI 造出命中它的数据** | ✅ **已完成（2026-10-06，§8.69，BE 小改 + FE 文案 · 零 DDL → 无 `chore(db)`）**：**BE 三处** —— ① `get_instruction_references` 加 `routing_rules`（**只数活行**，与 R6 同口径）并计入 `total`（弹窗不先说清 = 对用户隐瞒一次删改）；② `delete_instruction` 加 `mark_related(RoutingRule)` **同戳级联** + 回执 `deleted_routing_rules`（归 D14② 三分口径的**活配置**那一档）；③ `trash.py` 的 `instruction` `children` 补 `routing_rules` —— **漏了这一步，恢复指令时规则还留在站外**，同戳级联等于白做。**回收站对 `routing_rule` 刻意不做「宿主在站就隐藏」的代理过滤**：那条判据是时间戳的代理，对独立入站的行会失手（规则先删、指令后入站 → 被判隐藏，但恢复按同戳捞子行**捞不回时间戳更早的它** → 从此再也看不见）；代价只是列表多几行，换来**任何一行都够得着**。**FE 两处** —— `describeReferences` 新增「发前路由规则 N 条 → 随删入站」行 + 无引用句补一词、`describeDeletion` 新增「发前路由规则 N 条级联」（沿用**只报非零**口径）、`Trash.jsx` `KIND_LABELS` 加 `routing_rule: 路由规则`（`KIND_ORDER` = `Object.keys(KIND_LABELS)` 自动跟上，筛选 chip 不用另配）。**`pageStatus.json` 改两处已陈旧的陈述**（「四表计数」→ 五表、「7 类对象」→ 8 类 + 回收站例外说明）并 `npm run sync:page-status`。**红测先行有据**：BE 4 errors + 1 failure（`KeyError: 'routing_rules'`、级联没做 → 规则仍在列）+ FE 3 failed（文案缺项），**红因全部 = 缺特性本身**；落实现后 BE 仍剩 1 failed = 恢复路径 `children` 没接，**同属缺特性**；全量回归再翻 **3 条既有钉**（`res.related` 回执多出 `routing_rules` 键）→ **测试随新事实改写**，三档分开记账。**BE 999 → 1002/1002、FE 1362 → 1365/1365（+3）** |
| R38 | **发前路由 · 管理面（规则编辑 UI）** —— 给 R36 的规则表第一个家：**独立「发前路由规则」页**（`frontend/src/pages/RoutingRules.jsx`），把「进入序列之前先按输入条件挑指令」的规则第一次摆到页面上（§8.70）。**落点与拆批经用户拍板**（question 工具回执，2026-10-06）：选**新页**而非挂在指令页 / 加工页面板（规则是独立实体、还要跨规则调 `sort_order`，塞进任一现有页都装不下）；**先 CRUD 后接线**分两批（两件事的验收面不同） | ✅ **已完成（2026-10-06，§8.70，纯 FE · 零 DDL → 无 `chore(db)`）**：**页面四件事** —— ① 列表顺序 = 匹配顺序（照后端 `(sort_order, name, id)` 定序渲染，FE 不重排、不重算）；② 表单就地校验（`utils/routingView.validateRuleDraft` 委托 `utils/condition.checkCondition` 同一份 SSOT，非法即红字**一个请求都不发**）；③ 启停 / 删除（`NieRModal` 二次确认）逐行 PUT / DELETE，软删进回收站可恢复；④ **排序只改草稿**，上移 / 下移零请求，点「保存顺序 SAVE ORDER」才按草稿稠密重编 0..N-1 并**只 PUT `sort_order` 真变化的行**（后端无批量排序端点，少发一行是一行），「放弃 REVERT」零调用重拉。**接缝四处**：新 `api/routing.js`（`/routing-rules` 五方法）+ barrel、`pageStatus.json` 第 9 条（key `path` `shortcut` `H`）、`routeChunks` 载入器、`App.jsx` `case 'routing'` —— 后三者由 `pageRegistry` / `routeChunks` 两处既有测试互钉（键集与载入器集同集断言在 R35 就挂好了）。**红测先行有据**：4 个文件全红 —— 3 个新测试文件红因 = 模块不存在（`Failed to resolve import`），注册表断言红因 = `undefined to be '/routing'`，**全部 = 缺特性本身**；落实现后翻 1 条**测试自身 bug**（`renderPage` 辅助写死等 `meter 0001`，空态列表里没有该行 → 改等恒存在的表头计数）**先修再算数**，两档分开记账。**FE 1365 → 1405/1405（+40）**、BE 1002/1002、`vite build` 0、`lint` 0、校验器 11 文件 0 违规、md mismatches = 0、产物 9 个页面 chunk（`RoutingRules` 15.67 kB） |

| R39 | **发前路由 · 加工页接线** —— R38 给了规则一个家，但「进入序列之前按输入挑指令」的**换指令动作**仍未落地（§8.71）。拆批落点即 2026-10-06 question 工具回执「先 CRUD（R38）后接线（R39）」，接线因**改变执行行为**须实机冒烟才算数 | ✅ **已完成（2026-10-06，§8.71，纯 FE · 零 DDL → 无 Migration、无 `chore(db)`、零 BE 改动）**：**接线三块** —— ① `api/dispatch.js` 新增 `resolveRoute(inputs)`（`POST /dispatch/routed`，体恒 `{ inputs }`，回执 `matched / rule / instruction_id / instruction / invalid / considered` 六键与 `/dispatch` 缺省三键**不重叠**）+ barrel；② 新纯逻辑层 **`utils/routeResolve.js`**（行增删改 · **值按 JSON 标量解析** · 回执 → 中文事实文案四档 · 目标指令不在册时补进列表**返回原引用不制造重渲染**）；③ `InstructionProcessor.jsx` 加**「路由输入 (ROUTE INPUTS)」条**（扁平键值行 + 类型徽标 + `解析 RESOLVE` + 状态条 + 收起/展开让出执行区高度），**命中即 `setActiveInstructionId` 选中 + `回到上一条 (UNDO)` 一键回退**，无命中按回执 `matched=false` **不猜、维持现状**，解析失败出 `ERR:` 事实文案。**实机冒烟当场抓到一个类型缺口**（记「测试随新事实改写」）：FE 文本框只出**字符串**，而后端 `_equal` 数字/字符串**不同型即抛错 = 不命中**，条件里的 `0001` 是**数字字面量** —— 原样送串则**数字条件与全部数值比较符 `> < >= <=` 静默永不命中**；改值**按 JSON 标量解析**（`0001` → 数字 1、`"0001"` → 字符串 0001、其余按原文串）并在行侧出**类型徽标**当场写明会按什么发，规则页提示语同步。渲染条件 `activeInstructionId` → `currentInstruction`（回执目标不在册时落空态而非崩）；顺手移除一条**随组件变大而失效**的 `eslint-disable`（`react-hooks/set-state-in-effect` 现判 unused → lint 回 0 问题，原注释保留）。**红测先行有据**：3 个文件全红 —— `../routeResolve` **未解析** / `resolveRoute` **不是函数** / 面板元素**不存在**，红因全部 = **缺特性本身**（23 条既有用例全绿）；落实现后翻 **2 条断言随类型语义改写**（属「测试随新事实改写」），**三档性质分开记账**。**实机冒烟 8 组通过**：面板常驻 → 键值去空白命中切指令 + 状态文案 + UNDO 回退 → 无命中不切不出回退 → `0001` 按数字中、按字符串不中、`"0001"` 按字符串中（类型语义双向验证）→ 加行/删行/收起/展开，控制台 0 error，冒烟规则已删并**彻底清除**（规则 0 条）。**FE 1405 → 1445/1445（+40 = 27 纯逻辑 + 6 api + 7 页面）、BE 1002/1002、`vite build` 0、`lint` 0（0 warning）、校验器 7 文件 0 违规** |

| R40 | **发前路由 · 规则页试解析（DRY RUN）** —— §8.70 六 与 §8.71 七 **两处同挂**的那条留白正主：R38 建页时就登记了「在规则表上就地输一条输入 → 看会命中哪条 / 为什么没命中」，R39 只把接线落在加工页。四批闭环后规则作者仍处在「**写完规则没法验**」的状态，只能等真发送才知道挑中哪条（§8.72） | ✅ **已完成（2026-10-07，§8.72，纯 FE · 零 DDL → 无 Migration、无 `chore(db)`、零 BE 改动）**：**页底通栏「试解析 (DRY RUN)」面板** —— 输入扁平键值（与加工页同一份 `toInputsMap`：键去空白、空键不发、值按 JSON 标量解析）点按钮调 `POST /dispatch/routed`，出 SYS / ERR 一行事实 + **恒四行结果表**（命中规则 / 目标指令 / 参与扫描 / 缺陷跳过，值 = 回执原样转写）。**新增 `describeDryRun`** 与 R39 的 `describeResolve` 同一份回执、**另一种动作语境** —— 规则页一行状态都不改，文案断在「命中 / 无命中」，绝不复用「已切到指令」那句。**事实边界写死**：口径行常驻「按已保存的规则计算（表单与顺序的未保存改动不参与）」（不推断用户改没改东西，推断错就是撒谎），顺序有草稿时当场亮 `N 条顺序待保存 —— 试解析按已落库顺序计算`（琥珀条），右栏固定一句「只回显结果 —— 不选中规则、不改表单与顺序」。**抽第二消费方共用组件 `components/RouteInputTable.jsx`**（新）：两页那张行表排版只留一处出处（类型徽标 / 空键不发 / 删到只剩一行禁删三条细口径不会分家），`idPrefix` / `labels` 默认值即加工页原文、`+ 添加` 按钮留页面（两页按钮视觉语言不同，不塞进共用组件），**R39 的 13 条既有用例一次不改全绿 = 抽取没改行为的证据**。**红测先行有据**：2 个新文件 **13 条全红**（7 纯逻辑 `describeDryRun is not a function` + 6 页面「面板 / 按钮 / 结果表不存在」），红因全部 = **缺特性本身**，无一条属「测试自身 bug」；落实现后翻 **1 条既有用例随新事实改写**（`findByText(/2 条顺序待保存/)` 撞上新琥珀条同子串 → 断言**收窄**到顺序条原文 `^● 2 条顺序待保存$`，是收窄不是放水）。**实机冒烟 8 组通过**：面板常驻 → 去空白命中 + 类型徽标 + 四行表 → 无命中两行 `（无命中）` + 三类原因脚注 → 值 `"0001"` 字符串对数字条件**仍不中**（类型语义从规则页可见）→ 加行/删行/只剩一行 × 禁用 → 顺序草稿琥珀条出与消 → **回加工页解析命中切到「示例状态包」（抽取后 R39 回归）** → `/routing` 控制台 0 error 0 warning，清场后规则 0 条、回收站 `routing_rule` 0 条。**FE 1445 → 1458/1458（+13 = 7 纯逻辑 + 6 页面）、BE 1002/1002 持平、`vite build` 0、`lint` 0（0 warning）、校验器 8 文件（js / jsx / json）0 违规** |
| R41 | **文档卫生批（过期指路清零）** —— R1–R40 全部落地后，登记面上仍残留**指向未来批次的过期断言**（`pageStatus.json` 声称「下一批 R23，排期见 §8.52」「余下仅设备档案自定义排序（→ R20）」、§1 `R21–R28` 行首仍🔄、留白小节标题仍写「→ R37 / R38 / R39」）与**留白漏标**（同段体例已标 R37 / R38，却漏 R39）—— 不是功能缺口，是**读账会读错**的卫生问题（§8.73） | ✅ **已完成（2026-10-07，§8.73，纯文档 + `pageStatus.json` 文案 · 零功能改动、零 BE / FE 代码改动 · 零 DDL → 无 Migration、无 `chore(db)`、无 `feat`）**：**8 处过期标记就地改写** —— `pageStatus.json` 2 处（`/protocol`「下一批 R23（epoch …），排期见 §8.52」→ **R23 ✅ §8.55**；`/datahub`「余下仅设备档案自定义排序（→ R20，`sort_order` DDL 已由用户拍板解禁）」→ **R20 ✅ §8.50，nextSteps 无余项**）+ PLAN §1 `R21–R28` 行首 **🔄 → ✅**（该行**八个子批状态格本就全 ✅**，行首标记是漏翻）+ PLAN **3 处留白小节标题改指**（§8.68 八「→ R37 / R38 / R39」、§8.69 八「→ R38 / R39」、§8.70 六「→ R39 / R40 / 仍未排」各自补 ✅ —— **正文本就逐条标了 ✅，只动标题**）+ `PROJECT_HANDOVER.md` **2 处状态句**（条目 85 把「加工页自动选指令接线」仍列为留白而 R39 已销 → 补「**已由 R39 销掉 ✅（§8.71）**」；条目 86 括注同款补 ✅；**条目 87 本就已标 R39 / R40 ✅ 不动**）。**刻意不动的**：§8.5x / §8.6x 各节尾注「下一批 → Rx」是**当批的排期快照**（历史留档，改了才是造假），只改**声明当前状态**的登记面。`npm run sync:page-status` 重生成 `PAGE_STATUS.md`；**验收** = FE 1458/1458 · BE 1002/1002 · `vite build` 0 · `lint` 0（0 warning）· 校验器 1 文件（json）0 违规 · md 表列数 mismatches 0 · ev33 STAGED=0 BAD=0 |
| R42 | **`byte_order` trim 归一（FE 单点判据）** —— R34（§8.66 七）留白里明写的「**不引入 trim 归一**」，其理由「UI 下拉产不出带空白的值」只覆盖下拉这一个入口；值可由导入 / API 直写进来，而 BE `handlers/base.py::byte_order_of` 从 R21 起就是 `str(order).strip().lower()`，它 docstring 里「与 FE `.trim().toLowerCase()` 同口径」那句在 FE 侧**从来不成立** —— 同一个 `' LITTLE '` 会卡面判大端、后端判小端（§8.74；**非** §8.52 复议范围，独立小批） | ✅ **已完成（2026-10-07，§8.74，纯 FE · 零 DDL → 无 Migration、无 `chore(db)`、零 BE 改动）**：新增 `frontend/src/utils/byteOrder.js` 单点判据（`normalizeByteOrder` = trim + lower、`isLittleByteOrder` = 归一后只认 `little`，其余含枚举外 fail-open 回大端，逐字对齐 `byte_order_of`）+ **三处接线**（`protocolTree.js` length 分支与 checksum `isLittleOrder` 两个计算点 / `toFrameBlocks.js` 出口翻译闸门 / `validateProtocol.js` W5 归一收敛）→ **卡面、出线、W5、后端四方同判**。范围按 §8.66 留白原文钉死：收侧 `response_match` / `sequence_plan` **零改动**（fail-closed 不动）、指令域 `endianness`（E1-2 B6）另一域不并入、`pc.encoding` 不 trim（未登记，超范围）。**红测先行** = 新建 `utils/__tests__/byteOrder.test.js` 3 条（整文件加载即红，被测模块不存在）+ 3 条行为锚（`' LITTLE '` → `06 00`、`' little '` → `37 4B`、params 写键）—— 红因 3 条**全为缺特性本身**；`validateProtocol.test.js` 2 条本就绿（W5 原生带 `.trim()`，属已有特性不是红测）。**验收** = 4 文件 105/105（+6）· FE **1458 → 1464/1464（95 文件，+1/+6）** · BE **1002/1002 持平**（零改动）· `npx vite build` 0 · `npm run lint` 0（0 问题 0 警告）· yorha-ui 校验器改动 **9 个 js / json 文件 0 违规**（8 js + 1 json） · md 表列数 mismatches 0 · ev33 STAGED=0 BAD=0；**实机冒烟**（后端 8055 + dev 5174）：`POST /protocols/` 直写 `byte_order=' LITTLE '`，后端原样保留，卡面 length 出 `06 00`（修复前不 trim 判 big → `00 06`）、checksum 出 `FF 2E`、净值对照 `'little'` 同为 `06 00`，W5 未报；控制台 0 error；清场后回收站归零 |
| R43 | **规则 trace（逐条判定轨迹）** —— R40（§8.72 八）与 R41（§8.73 三）**两处同挂**的那条留白：试解析只给「命中哪条 / 扫了几条 / 哪几条有结构性缺陷」，**比较不成立 / 变量不在输入 / 类型不可比三者在回执里同为 `matched=false`** —— 规则攒到五条以上，「扫过 3 条都不成立」基本没法定位，规则作者说不出**自己那条**卡在哪一类（§8.75；**非** §8.52 复议范围，独立批次） | ✅ **已完成（2026-10-07，§8.75，BE+FE · 零 DDL → 无 Migration、无 `chore(db)`、**`/dispatch` 缺省口径一行未动**）**：`POST /dispatch/routed` 回执新增 `trace` —— **定序全序、一行一条规则**（`id` / `name` / `condition` + 后端给的机器码 `code` + 事实载荷 `detail`），九种码 = `core/routing.TRACE_CODES` 八种 + `resolve_route` 静态跳过补的 `INSTRUCTION_MISSING`。**只记录不判定**：判据仍是 `condition.py` 一处、FE `routeResolve.js` 连条件求值都不做；`select_rule` 由四键变五键，命中即停改成「记一行 `MATCHED` 后走完循环只补 `NOT_EVALUATED`（不 parse、不求值、不累加 `considered`）」，停用 / 解析期坏的裸 `continue` 改成「跳过并记一行」，回收站行仍不记；**判定与 `considered` 逐字未改**。FE 侧 `TRACE_LABELS` + `traceReasonText` 出中文（码表同时接 `describeInvalid` —— 同一条规则在「缺陷跳过」与轨迹里两处出现，措辞同源，原先 `invalid.reason` 是码就原样显示 `INSTRUCTION_MISSING`），规则页结果表下方出 `逐条判定轨迹 (TRACE) · N 条`（`data-testid="dry-trace-{n}"`，`MATCHED` 行黄字）。**红测先行** = BE 新增 13 条（**12 红**：`KeyError/AttributeError/ImportError/`断言缺 `trace`）+ FE 新增 8 条（**6 红**：`describeDryRun().trace` undefined、页面查无 `dry-trace-0`），红因**全为缺特性**；另有 2 条护栏实现前就绿（当时本就没有轨迹块），**不冒充红测**。**三档记账**：随新事实改写 3 条（BE `test_empty_ruleset` 四键全等补 `trace: []`、FE 两条完整形状 `toEqual` 补 `trace: []`）+ 测试自身 bug 先修 2 条（新写的页面护栏用 `/逐条判定轨迹/` 做否定断言，撞上同批新加的口径列表同名文案 → 改锚结果区标题 `/逐条判定轨迹 \(TRACE\)/`）。**验收** = BE **1002 → 1015/1015（+13）** · FE **1464 → 1472/1472（95 文件，+8）** · `npx vite build` 0 · `npm run lint` 0（0 问题 0 警告）· yorha-ui 校验器 6 个 js / jsx / json 文件 0 违规 · md 表列数 mismatches 0 · ev33 STAGED=0 BAD=0；**实机冒烟**（后端 8055 + dev 5174）五条规则各占一类，`meter_id=999` → `COND_FALSE` / `VAR_UNDEFINED(detail=line)` / `DISABLED` / `INSTRUCTION_MISSING` / `COND_FALSE`，`meter_id=1` → `MATCHED` + 四行 `NOT_EVALUATED`；页面「缺陷跳过」由英文码变**「目标指令不在册」**、轨迹五行齐、`MATCHED` 黄字、控制台 0 error；清场后规则表回原状、回收站 0 条 |

| R44 | **规则表进数据包（`routing_rules` 第 9 域）** —— R7（§8.45）拍板的「原 3 域 → 8 域」里**刻意不含规则表**，留白原文就是「若要随数据包迁移另议，不擅自扩域」（§8.70 六 / §8.71 七 / §8.72 八 / §8.73 三 / §8.75 七 五处同挂）；R36–R43 四批把规则做成了可建、可排序、可试解析、可读轨迹的实体，却**换不了机** —— 别的域一个 ZIP 就走，唯独规则只能一条条手抄（§8.76；2026-10-07 question 工具回执拍板选此项，余三候选为输入表持久化 / 校验器 md 口径 / 暂不排批） | ✅ **已完成（2026-10-07，§8.76，BE+FE · 零 DDL → 无 Migration、无 `chore(db)`、**`/dispatch` 缺省口径一行未动**）**：**8 域 → 9 域** —— `ROUTING_RULES_SCHEMA_VERSION = 1` 入 `BUNDLE_DOMAIN_VERSIONS` **排末尾**（前面 8 域的相对导出序一个字节没动，只在尾部多一域），`GET /datahub/export/bundle` 多出 `routing_rules.json`、`manifest` 的 `domainVersion` / `domainCounts` 多一键（漂移守卫 `ValueError: 域清单不一致` 顺带把 counts 表也钉住），新端点 `POST /datahub/import/routing_rules`。**四条口径全部镜像既有纪律、不另起炉灶** —— ① 只出活行，`created_at` / `updated_at` / `deleted_at` **三个记账列不进包**（回灌后用目标机时钟，也不搬源机回收站状态）；② **行序 = 匹配顺序** `(sort_order, name, id)`（即 `core/routing.py` 定序键），排序**收在 `routing_rules_export_payload` 一处**，调用方传进来的顺序不作数；③ **条件语法交 SSOT** `core/condition.parse_condition`（规则页保存侧同一入口，datahub 不写第二套判据），**目标指令必须是活行** → 缺失单行跳过（镜像 `import_sequences`「宿主缺失整条跳过」，不写出一进包就悬空、在发前路由里变成 `INSTRUCTION_MISSING` 缺陷行的规则）；④ 名称唯一**查全表含回收站占名**（同 `routing._ensure_name_free`）、id 自己在站 → 跳过并提示先恢复或彻底删除。`sort_order` / `enabled` 是**可选行字段**（在场必须合法、`bool` 不算数；缺席则建行取 0 / 1、改行保留目标库已有的值，镜像 R20 `profiles.sort_order`）。FE 四处接线：`BUNDLE_DOMAINS` 第 9 颗芯片、`DOMAIN_KEYS` / `DOMAIN_LABELS` 自动识别 + 中文名、`SAMPLE_DOMAINS` 第 6 个示例域（保持「示例包 = 按域导入能吃的范围」那句既有不变量成立），全量导出文案与面板提示 8 → 9。**红测先行有据**：BE 新建 `test_datahub_routing_rules.py` **18 条全红**（`AttributeError` 缺 4 个符号 + `AssertionError` / `KeyError` / `400 未知域：routing_rules` + `routing_rules.json not found`）—— 红因**全为缺特性**；FE 用 `git stash` 只暂存实现文件跑出 **5 红**（`R44` 新测 1 条 + 随新事实改写过的 4 条对旧实现红），还原后两次全量绿。**三档记账**：缺特性 19 条（BE 18 + FE 1）；测试随新事实改写 9 条（BE 5：`test_eight_domain_inventory` → `test_nine_domain_inventory` 清单与 `len 8→9`、`test_counts_and_legacy_keys` 的 counts 表补键、`test_zip_carries_eight_domains` → `test_zip_carries_nine_domains` 补文件与计数、bundle_domains 的 `default_is_still_the_full_*` 与 `explicit_all_*` 两处更名；FE 4：芯片清单与顺序注释、全量导出文案、示例包数组、域键识别用例）；测试自身 bug 档 **0 条**。**验收** = BE **1015 → 1033/1033（+18）** · FE **1472 → 1473/1473（95 文件，+1）** · `npx vite build` 0 · `npm run lint` 0（0 问题 0 警告）· yorha-ui 校验器改动 **3 个 js / jsx / json 文件 0 违规** · `ev40` TOTAL_PROBLEMS=0 · `ev33` STAGED=0 BAD=0（FE 全量首跑出过 1 条 `Terminal.test.jsx` 历史预览红 —— 本批未触碰该页、单跑 29/29 绿、随后两次全量 95 文件 1473 条全绿，按**测试抖动**记账，不改测试也不改实现） |

| R45 | **加工页判定轨迹（同一份回执，两页共用一张轨迹表）** —— R43（§8.75 七）落地轨迹时**刻意留白**「加工页不加轨迹」：`describeResolve` 消费的是同一份 `POST /dispatch/routed` 回执，但加工页是「命中即切」的动作语境，一行事实已够 —— 结果是规则作者在规则页能读到「为什么不命中」，**在真正按下「解析 RESOLVE」并真切指令的那个页面反而读不到**（§8.77；2026-10-07 question 工具回执拍板选此项，余三候选为输入表持久化 / 校验器 md 口径 / 暂不排批） | ✅ **已完成（2026-10-07，§8.77，纯 FE · 零 DDL → 无 Migration、无 `chore(db)`、零 BE 改动、`/dispatch` 缺省口径一行未动）**：**`describeTrace` 由 `describeDryRun` 的私有函数提为导出** —— 同一份回执两处消费（规则页试解析 / 加工页真解析），轨迹**必须走同一张表**不许各排各的，`describeDryRun` 内部改调它、返回值逐字不变（R43 的 8 条既有用例一次不改全绿 = 提取没改行为的证据）。加工页 `InstructionProcessor.jsx` 新增 `routeTrace`：**一次解析开始就清、失败也清**（不残留上一次），成功则存 `describeTrace(res?.trace)`；轨迹块挂**状态条下方、与展开态无关**（结论属于状态条那一层，收起输入表不该把结论一起收走），testid `route-trace-{n}` 与规则页 `dry-trace-{n}` 同形不同名、`MATCHED` 行黄字同款。**三条边界写死**：① 回执没给 `trace`（旧后端）→ `describeTrace` 出 `[]` → 不出块，状态条照旧写事实；② 轨迹**只回显不改判** —— 命中才切 / 无命中不切仍是 R39 原口径，FE 不自己扫第二遍条件；③ **`回到上一条` 只改状态条不清轨迹**（轨迹是那次解析的事实记录，规则与条件都没变）。**红测先行有据**：新增 8 条（util 3 + 页面 5）→ **7 红 1 绿**，红因全为缺特性（`describeTrace does not provide an export named` ×3、页面查无 `逐条判定轨迹 (TRACE)` ×4）；那 1 条「回执不带 trace 就不出块」**实现前即绿属护栏，不冒充红测**。**三档记账**：缺特性 7 / 随新事实改写 0 / 测试自身 bug 0。**验收** = BE **1033/1033 持平**（零改动）· FE **1473 → 1481/1481（95 文件，+8）** · `npx vite build` 0 · `npm run lint` 0（0 问题 0 警告）· yorha-ui 校验器 5 文件 0 违规（4 js/jsx + 1 json）· `ev40` TOTAL_PROBLEMS=0 · `ev33` STAGED=0 BAD=0；**实机冒烟**（后端 8055 + dev 5174）三条规则各占一类（条件假 / 变量不在输入 / 停用），`meter_id=999` → 无命中状态条 + 轨迹三行 `比较不成立` / `变量不在本次输入里：line` / `已停用（不参与匹配）`，`meter_id=1` → `命中规则「R45 smoke A」→ 已切到指令「示例心跳帧」` + #1 `判真命中` **黄字**、#2 #3 `未轮到`，`回到上一条` 后状态条换文案而**轨迹仍三行**；**控制台 A/B 对照** = 暂存 R45 运行时改动后同一页面同样出 2 条 `GET /response-specs/{id} 404`（该指令无存档应答规格，FE 本就按 404 处理），**本批新增 0 error**；清场后规则表 `[]`、回收站 0 条，8055 / 5174 两个后台壳已停 |

| R46 | **TIME 字段点击范围收窄（只有值区才开时间配置弹窗）** —— 2026-10-07 实机手工验证当场反馈：加工页 TIME 类字段（运行秒数）**点整行任意处都会弹时间配置**，只希望点值区那块才弹；**无既有登记项**（R36–R45 的留白已全部收口，这是新报上来的交互问题）（§8.78；question 工具回执拍板其作 R46，**原拍板的「输入表持久化」顺延 R47**） | ✅ **已完成（2026-10-07，§8.78，纯 FE · 零 DDL → 无 Migration、无 `chore(db)`、零 BE 改动、`/dispatch` 缺省口径一行未动）**：**触发点从整行最外层挪到值区** —— `SmartInput.jsx` 原把 `onClick`（`RunnerFieldTree.handleTimeClick`）挂在**整行最外层 div**，点标签、点右徽标 `[TIME_PICKER]`、点值区都会开时间配置；现改为**值区 `div.flex-1` 独享 `onClick`**，最外层只留**字节定位选中 `onSelect`**（点行仍高亮字节 + 读数条，第 4 批 #2 的既有语义一行未改），值区**不 `stopPropagation`** → 事件继续冒泡到外层，点值区 = 开弹窗 + 选中字段两件事一起。非 TIME 字段的 `onClick` 本就 `undefined` → 值区不出处理器，**零行为变化**。**红测先行有据**：新增 5 条（`SmartInput.test.jsx` 3 + `InstructionProcessor.test.jsx` 2）→ **3 红 2 绿**，红因全为缺特性（单元级 `expected "vi.fn()" to not be called at all, but actually been called 1 times` ×2、页面级 `expected <span …></span> to be null` ×1，即点标签 / 点徽标仍误开弹窗）；那 2 条「点值区才开弹窗」**实现前即绿属护栏，不冒充红测**。**三档记账**：缺特性 3 / 随新事实改写 0 / 测试自身 bug 0。**验收** = BE **1033/1033 持平**（零改动）· FE **1481 → 1486/1486（95 文件，+5）** · `npx vite build` 0 · `npm run lint` 0（0 问题 0 警告）· yorha-ui 校验器 4 文件 0 违规（3 js/jsx + 1 json）· `ev40` TOTAL_PROBLEMS=0 · `ev33` STAGED=0 BAD=0；**实机冒烟**（后端 8055 + dev 5174）三态 —— 点标签不出弹窗但字节定位照旧、点值区出 `时间配置 (TEMPORAL)`、点右徽标不出弹窗且定位保留；控制台仅 2 条 `GET /response-specs/{id} 404`（R45 §8.77 已 A/B 对照定性的既有口径），**本批新增 0 error** |

| R47 | **输入表持久化（两页共用一份本机草稿）** —— R39 建「路由输入」时就挂的留白（§8.71 七 第 4 条）原文：「输入表不做持久化：本仓前端**零 `localStorage` 先例**，本批不为此新引一种落盘样式；刷新即回到一行空输入。真要常驻站点参数（表号、线别），**另开一批连『谁清、谁改』一起拍**」—— 真开了一批，于是把那三问一次问齐（§8.79；2026-10-07 question 回执拍板：**存哪几列 / 两页存一份还是两份 / 存多久谁清**；R46 批内原拍板给它的批次顺延） | ✅ **已完成（2026-10-07，§8.79，纯 FE · 零 DDL → 无 Migration、无 `chore(db)`、零 BE 改动、`/dispatch` 缺省口径一行未动）**：**销 §8.71 七 第 4 条留白** —— 新增 `utils/routeInputsPersist.js`（单点槽 `ROUTE_INPUTS_KEY = 'yorha.routeInputs.v1'` + 读 / 写 / 清三个纯数据函数，不碰 React、不碰请求、不碰 `routeResolve` 的解析口径）。**拍板三条逐条落地**：① **整表原样存（含空行）** —— 存什么读什么，行序、空行、只填了键没填值的半行都原样回，本层不补行、不推断、不筛行；② **两页共用一份** —— 加工页 `routeRows` 与规则页 `dryRows` 的 `useState` 都改为读同一个槽，规则页写下的行切到加工页接着用；③ **localStorage + 显式清空入口** —— 键入即写（改键值、加行、删行三条路走同一个口），两页各挂一个 `清空输入 (CLEAR)` 按钮（共用组件 RouteInputTable「不加按钮」那条边界不变，按钮仍归各页）。**比拍板更硬的一条工程口径**：存储不可用（隐私模式读不到 / 配额满写不进 / 本机那份被改坏）一律当「本机没存过」回落默认一行空行，**本层绝不抛** —— 表打不开比表是空的严重得多。**红测先行有据**：新增 **15 条**（新文件 `routeInputsPersist.test.js` 9 + 加工页 3 + 规则页 3）→ **15 红 0 绿，红因全为缺特性**（单元整文件红 = 模块不存在；页面 `expected null to be truthy` ×2 = 键入没落盘、`expected '' to be 'meter_id'` ×2 = 本机那份没回显、`Unable to find … name "清空输入 (CLEAR)"` ×2 = 清空入口缺失）；**护栏 0 条**。**三档记账**：缺特性 15 / 随新事实改写 0 / 测试自身 bug 0；**另有 2 个文件级 `beforeEach` 清库钩子**（键入即写后，同文件先跑的用例会把行留给后跑的用例）—— 只加隔离、既有断言零改动，单列说明不冒充红测。**验收** = BE **1033/1033 持平**（零改动）· FE **1486 → 1501/1501（96 文件，+15，+1 文件）** · `npx vite build` 0 · `npm run lint` 0（0 问题 0 警告）· yorha-ui 校验器 **7 文件 0 违规**（6 js/jsx + 1 json）· `ev40` TOTAL_PROBLEMS=0 · `ev33` STAGED=0 BAD=0；**实机冒烟**（后端 8055 + dev 5174，**后端零改动、零数据改动**）四步 —— 加工页键入 `meter_id=0001` 并点加行 → 本机槽是两行（含空行），切规则页**原样回显同两行**、状态条 `1 项有效` → 点 `清空输入 (CLEAR)` 槽归 `null`、屏上回默认一行空行 → 再键入后**刷新页面两行仍在** → 回加工页同槽回显，清空后解析按钮与选中指令 `ID: SAMPLE-INST-HEARTBEAT` 都不动；控制台仅 2 条既有 `GET /response-specs/{id} 404`（R45 §8.77 已 A/B 对照定性），**本批新增 0 error** |

| R48 | **校验器 md 口径（`.md` 纳入 · 只扫围栏代码块）** —— §8.73 八 与 HANDOVER 条目 90 两处同挂的留白正主：34 条历史 CSS 字样（`rounded-sm` / `shadow-md` …，全是当年「改掉它」的史实记述）要让 md 过检**须二选一** —— 改写史实措辞，或给校验器加白名单，后者改**仓外** `~/.agents/skills/yorha-ui` 故「另议」（§8.80；2026-10-07 question 回执拍板选此项**并授权改仓外 skill**，余三候选为输入表持久化（已顺延 R47 ✅）/ `Terminal.test.jsx` 抖动治理 / 暂不排批） | ✅ **已完成（2026-10-07，§8.80，仓外 skill 改动 + 仓内新增可复跑测试 · 零 DDL → 无 Migration、无 `chore(db)`、零 BE 与零 FE 业务代码改动）**：**走第三条路 —— 把 md 的扫描面收到围栏代码块**，于是二选一**都不必发生**（史实措辞一字未改、白名单一个没建）。仓外 `validate-yorha-ui.mjs`：`.md` 进 `SCANNED_EXTENSIONS` + 新增 `validateMarkdown` / `validateSource` 按文件名分流 + 围栏抽取（只认反引号围栏、语言标注须在样式语言集内、`typescript`→`.ts` 等 GitHub 别名走别名表、裸 token 先归一成带点扩展名）+ 违规贴回 `Line: N (md fence)`；`validateYoRHaCode` **逐字未改** —— md 只是多一个扫描面，不是第二套判据；同步 skill 的 `references/rules.md` §9 与 `SKILL.md` 工作流。**取数（修正枚举后）**：仓内 **14 份 md**（与 `git ls-files` 同数；初测 16 含 2 份 `venv` 第三方 LICENSE 已排除）、26 个围栏块、进扫描面 1 个（`typescript` 标注，其内 0 违规）→ 围栏口径 **0 违规**；同一批文件按**整文件判**（R48 之前的行为）= **3 文件 36 条**。**红测先行有据**：新增 `scripts/test-yorha-md-validator.mjs` 7 条（fixture 放 `scripts/fixtures/md-validator/*.txt` 数据文件）→ **3 红 4 护栏**，红因全为缺特性（md 无行号 / 散文被咬 6 条 / 全仓 md 36 条）；首跑另有 **1 条测试自身 bug**（js fixture 写 camelCase，规则族本就不判）**先修再算数**；实现后追加 1 条 `typescript` 别名护栏**单列不冒充红测**，终态 **8/8 绿**。**三档记账**：缺特性 3 / 测试自身 bug 先修 1 / 随新事实改写 0（护栏 4，追加 1 单列）。**验收** = BE **1033/1033 持平** · FE **1501/1501 持平** · `npx vite build` 0 · `npm run lint` 0 · 校验器（1 个 `mjs` + **全仓 14 份 md**）**0 违规** · md 口径测试 **8/8** · `ev40` TOTAL_PROBLEMS=0 · `ev33` STAGED=0 BAD=0 |

节奏：每批 = 实现 → 测试/构建/校验器 → 文档同步 → 人工验证 → 提交（一批一提交）。

## 2. M1 明细（实现完成，待人工验证）

> **进度（2026-09-22）**：A1（a/b/x）+ C1（a–d）+ C2 全部实现。自动化验证：
> 前端 137/137（基线 113 + 新增 24：synthesizeFormula 4 / useHistory 7 /
> computeInsertionSide 4 / moveField 5 / saveError 4）、后端 unittest 8/8、
> `npx vite build` 通过、yorha-ui 校验器通过（Canvas 既知 `pl-8`/`p-10` 除外）、
> `scripts/fix_length_formulas.py` 只读盘点命中 3 块（含 `New Instruction 682`）EXIT=0。
> **人工验证期反馈（并入本批）**：复制块新卡片长名称被省略号截断，用户要求
> **单行完整显示（不截断、不换行）** → `Block.jsx` 表头改 `whitespace-nowrap`，
> content floor 增加 `labelPx` 标签宽度估算（CJK 11.5px / 拉丁 8px + 安全量，与
> footer 估算取 **max 而非求和** → 短名称不触发，既有 60px 地板/字节驱动宽度 4 例
> 原样通过）；新增 `Block.test.jsx` 第 5 例固化「长名单行 + 宽度撑开」契约
> （138/138）；顺手清理 REF 徽标 `rounded-sm`/`shadow-sm` 两处既有违规
> （Block.jsx 校验器 0 违规）。
> 待人工验证 → 一批一提交。

### A1 加工页「refs 无 formula」LENGTH_CALC 不可算

- 出处：`PLAN_InstructionManagement.md` L94–99。定调：不动编码器，补全公式落库。
- **A1-a** `utils/synthesizeFormula.js` 纯函数：字段 refs 全部可解析 → 合成
  `"[A] + [B]"` 公式串（镜像指令页 Σ 显示口径）；refs 为空或任一悬空 → null
  （不合成，先修引用）+ 单测。
- **A1-b** 属性面板 LENGTH_CALC 块参数区加「用 refs 合成公式」按钮：写入
  `parameter_config.formula`（走 `updateLocalInstruction` 正常脏态 → 手动保存
  落库），`LENGTH_NO_FORMULA` 警告随之消失。
- **A1-c** 验收：加工页同形态可算且与指令页 Σ 一致；问题清单警告消失。
- **A1-x（已审批）** 批量修复脚本 `scripts/fix_length_formulas.py`：
  默认只读盘点全部 `LENGTH_CALC ∧ refs ∧ ¬formula` 块；`--apply` 才走
  `PUT /instructions/{id}` 逐条落库（保持 API 单一写路径）。

### C1 指令页测试债（P4 新增功能补测）

- **C1-a** `hooks/useHistory` renderHook 单测：push → canUndo、undo/redo 互换、
  clear、上限 50（push 55 只留 50）、新 push 清 redo。≥5 例。
- **C1-b** P4-2 saveError 路径（扩 `useInstructionData.test.js`）：PUT 网络失败 →
  「网络/服务错误」；400/422 → 「服务端拒绝」；成功后清除；P0-2 校验失败
  **不**设置 saveError。≥4 例。
- **C1-c** `utils/computeInsertionSide.js` 抽取（Canvas handleDragOver 侧别推导）：
  active 在 over 前 → `right` / 后 → `left` / 任一缺失 → `left` 默认 /
  self-over → `null` + 单测 ≥3 例，Canvas 改调纯函数。
- **C1-d** `utils/moveField.js` 抽取（Instruction.jsx onMoveItem 的 splice 逻辑）：
  同道换序 / 换 parent / 目标道按 sequence 排序 / 源字段缺失 → 原样返回 +
  单测 ≥4 例，页面 onMoveItem 改调纯函数。

### C2 位域保存时后端强校验

- 出处：交接待办 5。现状：前端 P0-2 已阻断，直连 API 仍可入库重叠/超容量位域。
- `backend/routers/instruction.py` 增 `_validate_bitfields(fields)`：每个
  BITFIELD 字段内 bits 按 `start_bit` 排序 → 重叠（start < prevEnd）或超容量
  （Σbit_len > byte_len*8）→ 400 detail；POST/PUT 均调用。
- 测试：stdlib `python -m unittest`（**不加 pytest 依赖**）
  `backend/tests/test_bitfield_validation.py`：重叠 / 超容量 / 正常 / 无 bits。

## 3. M2 明细

> **进度（2026-09-22）**：C3–C8 全部实现。自动化验证：前端 207/207
> （M1 基线 137 → +70，新增 DataHub/blockMerge/runnerRenderRules/
> instructionDataOptions/契约测试并扩充 Protocol、Orchestration、pageRegistry）、
> 后端 unittest 21/21（新增 `test_datahub` 13 例，stdlib 直测纯函数）、
> `npx vite build` EXIT=0、yorha-ui 校验器 M2 全部改动文件 0 违规
> （Canvas `pl-8`/`p-10` 与 BlockPropertiesPanel 既知旧违规除外）、
> `backend/db/yorha.db` 未被改动。顺带修复真 bug：编排页总长度漏计注入
> 载荷字节（`children: []` 被当容器递归）+ 页脚 hex 流叶子/防崩；顺手清理
> Orchestration `px-6`、ProtocolPropertiesPanel `backdrop-blur-sm`/`pt-8` 既有违规。
> **人工验证期反馈（并入本批）**：加工页只读字段与可编辑字段区分度不够 →
> `SmartInput` 只读态改斜纹警示填充 + 虚线边框 + 反白 `[READ_ONLY]` 徽标 +
> 暗淡标签/幽灵刻度条，可编辑态实线边框悬停聚焦加深、行导轨仅可编辑行响应；
> 新增 `SmartInput.test.jsx` 6 例锁视觉+行为契约（213/213）。
> 待人工验证 → 一批一提交。

- **C3 数据中心页一期**：D1 聚合导出入口（指令 JSON + `/export` .bin/.hex 打包
  下载）M；D2 备份/恢复（复制 yorha.db 新端点，设计运行中换库风险）M；
  D3 环境状态面板（DB 路径/行数/版本）S；D4 README + pageStatus 翻转 S。
- **C4 协议页**：① 拖拽/属性编辑/异常保存交互测试 M ② 块类型与属性定义收敛、
  去硬编码 M。
- **C5 编排回归**：总长度、插槽缺失、边界结构测试 S–M。
- **C6 加工页参数渲染下沉**：渲染规则抽为可测试配置 + 单测 M。
- **C7 指令页隐式约定收敛**：页面↔hook 契约显式化（选项校验/JSDoc/拆 hook），
  行为不变 M。
- **C8 README 能力同步**：描述与页面实现状态对齐 S。

## 4. E1 明细（B1 编码语义，双端解禁）

每子项流程：字节级设计 → `InstructionEncoder.js` + `orchestrator.py` 双端实现 →
双端 byte-equal 一致性测试 + 存量回归样本 → 撤对应 UI 标注 → 文档。

- **E1-1** ✅ B5 INT_SIGNED 按位宽补码（替换 `Math.abs`）
- **E1-2** ✅ B6 `endianness=LITTLE` 真实字节序反转
- **E1-3** ✅ B3 BCD_CODE 打包 + B4 SCALED factor/offset 定标
- **E1-4** ✅ B2 FLOAT_IEEE（float32）
- **E1-5** ✅ B7 ARRAY_GROUP repeat 展开 N 次 ⚠️ **联动**：`byteOffsets` /
  编排页 `getTotalBytes` / 指令页 LEN 三处总长口径同步改 + Phase 1 测试更新
- **E1-6** ✅ B8 TIME_ACCUMULATOR / AUTO_COUNTER 语义生效（base_time / step / max）

> **E1-1 进度（2026-09-23，实现 + 自动验证完成，随 E1 整批提交 · 待人工验证）**：
> 字节级设计 = 两补码 mod 2^(8·byteLen) 溢出环绕 + 双端统一解析口径（number
> 取 floor 非有限→0 / 严格十进制字符串 / 其余含 bool、null、"FF"、"1e3" → 0）。
> 落点：`InstructionEncoder.getFieldBytes` 新增 INT_SIGNED 分支（BigInt 掩码）、
> `orchestrator.encode_int_signed` 纯函数、`fields_to_blocks` 规范 INT_SIGNED
> （type 缺省/number）静态值出补码帧（cfg.hex 忽略同前端，矛盾 type 保持 zeros）。
> 双端 byte-equal：同一张 24 例向量表钉在 `InstructionEncoder.test.js` 与
> `test_encode_int_signed.py`（改一必改二）+ 回归样本（INT_UNSIGNED 负数仍走
> abs、HEX_RAW 骨架不变）。验证：前端 240/240（213+27）、后端 29/29（21+8）、
> `vite build` EXIT=0、撤 B5 标注（encoderLimits 单一事实源 + 校验引用 + 测试
> 断言同步）。加工页 hex 输入负数表达 = 直接写补码字节（FF→255→掩码 FF）。

> **E1-2 进度（2026-09-23，实现 + 自动验证完成，随 E1 整批提交 · 待人工验证）**：
> 字节级设计 = 先按 op 语义出大端字节、`endianness=LITTLE` 时对整段字节逆序
> （字节数不变；单字节与组容器本身不动，子字段逐个经 wrapper 处理）。
> 落点：前端 `getFieldBytes` 改为 wrapper（内部实现改名 `_encodeFieldBytes`，
> checksum/refs 调用点走内部方法吃未反转值字节 → 与后端 handler 输入端对称）、
> 后端 `schemas/block.py` 加 `endianness: str = "BIG"` + `datahub.to_block` 透传
> （归一大写）+ `orchestrator._reverse_hex_pairs` 在 emit 第 4 步反转（length/
> checksum handler 第 3 步先在大端值上算完）。双端 byte-equal：同一张 7 例向量表
> 钉在 `InstructionEncoder.test.js` E1-2 describe 与 `test_encode_little_endian.py`
> （INT_SIGNED -2→FEFF、HEX_RAW `AA BB`→BBAA、单字节不动、小写容错、BIG/缺省回归；
> 改一必改二）+ 组容器不整体逆序、refs 不吃反转、checksum LITTLE/BIG 引用同值、
> `_reverse_hex_pairs` 单元 + endianness 透传测试。撤 B6 标注：encoderLimits
> （entry + push + header）、validateInstruction.test 三处、属性面板 label、面板
> banner 测试翻转。验证：前端 251/251（224+27）、后端 34/34（26+8）、
> `vite build` EXIT=0、校验器改动文件仅 BlockPropertiesPanel 既知旧违规
> （backdrop-blur-sm / pt-8，非本批引入）。

> **E1-3 进度（2026-09-23，实现 + 自动验证完成，随 E1 整批提交 · 待人工验证）**：
> 字节级设计：① B3 packed BCD —— 与 INT_SIGNED 同款 floor 解析（抽公共
> `_floor_numeric`）→ abs（负号无 nibble 表达，同通用路径口径）→ 数字逐 nibble
> 打包，超长截高位保低 2n 位、高位补 0（大端；LITTLE 经 E1-2 wrapper 联动）；
> ② B4 定标 —— `(value+offset)*factor`，factor/offset 空/缺省/非有限 → 1/0
> （恒等回归=裸整数路径不变），value 非有限 → 0，结果 `abs(floor)` 定宽
> mod 2^(8n)；矛盾 type（string/float/hex，算子模板不设置）不参与保持现行为。
> 落点：`InstructionEncoder.getFieldBytes` 新增 BCD_CODE 分支 + SCALED_DECIMAL
> 定标块（value 解析后、type 分支前）；`orchestrator.encode_bcd / encode_scaled /
> _to_number / _finite_or` + `fields_to_blocks` 两 elif（规范 type 静态值出帧）。
> 双端 byte-equal：BCD 17 例 + SCALED 16 例同表钉在 `InstructionEncoder.test.js`
> E1-3 describe 与 `test_encode_bcd_scaled.py`（改一必改二）+ 矛盾 type 现状锚、
> BCD×LITTLE 联动 0025→2500、encodeInstruction 混排、静态值缺省 zeros；byte_len=0
> 不入向量（FE `byte_len||1` 归一 / BE `>0` 守卫属通用边角非 B3 语义）。
> 撤 B3/B4 标注：encoderLimits（entries + getBlockLimitRefs + getParamKeyLimitRef
> factor/offset + header）、validateInstruction.test 三处、runnerRenderRules.test
> B4 ref→null（ParamConfigForm `if(!ref)` 守卫自动消失）。验证：前端 288/288、
> 后端 43/43、`vite build` EXIT=0、校验器 5 文件 0 违规。

> **E1-4 进度（2026-09-23，实现 + 自动验证完成，随 E1 整批提交 · 待人工验证）**：
> 字节级设计：`op=FLOAT_IEEE` + `byte_len=4`（bits=32）+ 规范 type（缺省/number）
> → IEEE 754 float32 大端（网络序）恒 4 字节。解析口径 = number 原样 / 严格
> 十进制字符串（同 E1-1 正则，拒 `1e3`/`0x`/`FF`）/ bool→1|0 / 其余→0；非有限
> （NaN/±Infinity）→ 0；有限值经 Float32Array 转换，超 f32 表示范围 →
> ±Infinity（IEEE 溢出，`struct.pack('>f')` OverflowError → copysign inf 对齐）。
> **范围外保持现状 → 已由 R5（§8.42）收口（2026-10-02）**：~~bits=64（byte_len=8）
> 仍走整数路径 / BE zeros~~ → **双端 float64 分支已落地**，向量表分 `f32`/`f64` 两组；
> 矛盾 type=float/string/hex 模板不会产生，FE 走既有分支、
> BE 保持 zeros 契约外（同 E1-1 原则）。落点：`getFieldBytes` FLOAT_IEEE 分支
> （BCD 分支后）、`orchestrator.encode_float_ieee + _float_number`（`import struct`）、
> `fields_to_blocks` elif（`byte_len == 4` + 规范 type 静态值出帧）。
> 双端 byte-equal：22 例向量表钉在 `InstructionEncoder.test.js` E1-4 describe 与
> `test_encode_float_ieee.py`（改一必改二）+ 静态/输入同口径、缺省值 4 零字节、
> byte_len≠4 / 矛盾 type×2 现状锚、LITTLE 联动 3F800000→0000803F、
> encodeInstruction 组装。撤 B2 标注：encoderLimits（entry + FLOAT push + header，
> 剩 B7/B8）、validateInstruction.test 两处、BlockPropertiesPanel.test mock 文本
> 去 B2。验证：前端 317/317（288+29）、后端 49/49（43+6）、`vite build` EXIT=0、
> 校验器 5 文件 0 违规。

> **E1-5 进度（2026-09-23，实现 + 自动验证完成，随 E1 整批提交 · 待人工验证 ·
> ⚠️ 联动三处总长口径）**：
> 字节级设计（三端统一 N 口径）：NONE/缺省→1；FIXED→`max(0, floor(repeat_count))`
> （非 number/非有限防御→1，对齐 normalize 归一与 BE isinstance 检查）；
> DYNAMIC→计数源字段值（computedValues > inputs > 静态 `parameter_config.value`，
> `_floor_numeric` 同款严格解析）`max(0,n)`，ref 缺失/悬空/无值→0。
> FE 落点：`encodeInstruction` 改**树状递归 emit**（组级整拷贝循环 → `(ab)×N`
> 交错，绝不 `(a×N)(b×N)`；byteMap 每份一跨；children 取 `fields` 优先、
> parent_id 链兜底）+ `_encodeFieldBytes` 组分支（直调/checksum 组 refs 路径）+
> `_repeatCount`。BE 落点：`Block.repeat_count`（schema）+ `datahub.to_block`
> resolve（pool 建 `by_id` 查 DYNAMIC ref 静态值）+ `orchestrator
> ._flatten_recursive` 容器 ×N。checksum refs 口径：叶引用恒 1 份 ↔ BE
> `first-start→first-end` 范围恰 1 份（byte-equal by design）；组引用走组分支自
> 展开（BE 范围匹配不到容器 id，契约外）。
> 联动三处：`byteOffsets`（FIXED 组 size=Σ×N、walk 游标落组真终点；DYNAMIC 组
> 降级 unknown → VAR/`··`/下限「+」——运行时才知次数，显示不许撒谎）、编排页
> `blockMerge.getTotalBytes`（FIXED Σ×N；DYNAMIC 无「+」表达 → ×1 下限并注释）、
> 指令页 LEN（派生自 byteOffsets，自动联动）。撤 B7 标注：encoderLimits（entry +
> ARRAY_GROUP/STRUCT push + `getParamKeyLimitRef` max_count + header，剩 B8）、
> validateInstruction.test 两处 + 清单、⚠B7 面板角标、runnerRenderRules B7→null。
> 验证：前端 335/335（317+18：E1-5 describe 15 + byteOffsets +2 + blockMerge +1）、
> 后端 53/53（49+4）、`vite build` EXIT=0、校验器 4 过 + 仅 BlockPropertiesPanel
> 既知旧违规（backdrop-blur-sm/pt-8，非本批引入）。Phase 1 测试更新：byteOffsets
> DYNAMIC 断言翻转为降级口径 + FIXED×N/×0/防御三用例、blockMerge repeat 组用例。

> **E1-6 进度（2026-09-23，实现 + 自动验证完成，随 E1 整批提交 · 待人工验证 ·
> 🎉 E1 批 B2–B8 全部解除）**：
> 字节级设计：TIME_ACCUMULATOR → `n = floor((now − base_time)/1000)`，墙钟主导
> （inputs/value 不参与）；base 缺失/非法（契约外）→ 双端各自现状回落（FE value
> 路径 / BE zeros 不覆盖）。now 可注入 —— FE `encodeInstruction` 第 4 参
> `opts.now`（缺省 Date.now()）↔ BE `fields_to_blocks(now=ms)`（缺省服务器墙
> 钟），双端注入同值 → byte-equal；base 解析 FE `Date.parse` ↔ BE `_iso_ms`
> （fromisoformat，尾 Z→+00:00，naive 按本地时区，对齐 JS 本地语义）。
> AUTO_COUNTER → `n = (Current + Step) % Max`（算子描述原样落地）：Current =
> computed > input > 静态 value（非空）> start_val，`_floor_numeric` 同款解析；
> step 缺省/非法 → 0；max 缺省/非法/≤0 → 不回绕；回绕双重取模 `((n%max)+max)%max`
> 消平 JS/Python 负余数差异；结果 abs(floor) mod 2^(8n)（无回绕负值 → abs 同
> 通用路径口径）。跨帧自动递增状态机不在编码器（纯函数），由调用方每帧推进
> value。落点：FE TIME/AUTO 两块（SCALED 块后、字符串分支前，规范 type 门控）
> + now 参数贯穿（`getFieldBytes`/`_encodeFieldBytes`/emitNode 末参）；BE
> `orchestrator.encode_time_accumulator`/`encode_auto_counter` + `_iso_ms`
> （datetime import）+ `datahub.to_block` 两 elif + `fields_to_blocks(now=)`。
> 编排页泳道 `useInstructionLanes` 既有 now−base/start_val 显示预览与新口径
> 天然一致，不动。撤 B8：**encoderLimits `ENCODER_LIMITS` 清空（B2–B8 全撤，
> 模块保留为未来限制 SSOT）**、validateInstruction.test 三处 + 清单改
> `toEqual({})`、runnerRenderRules.test STEP/MAX ref→null（⚠角标/横幅随之
> 消失）。验证：前端 341/341（335+6：E1-6 describe 6 用例）、后端 59/59
> （53+6：TIME 类 5 + AUTO 11 向量）、`vite build` EXIT=0、校验器 4 过 + 仅
> BlockPropertiesPanel 既知旧违规（backdrop-blur-sm/pt-8，非本批引入）。

## 5. E2 明细（传输层）

- **T1** transport 抽象：loopback 保留为默认模式（`/dispatch` 口径不变）
- **T2** TCP 模式（socket 标准库，无新依赖）：host/port/超时/连接状态事件
- **T3** 串口模式（**pyserial，已解禁**）：COM/波特率/校验/停止位
- **T4** `POST /transport/config` API + 发送历史三类事件（原始/响应/错误）
- **T5** 文档口径更新（真实传输落地后才改 /dispatch 描述）

> **E2 进度（2026-09-23，T1–T5 整批完成，随 E2 整批提交 · 待人工验证 · 传输层落地）**：
> T1 `backend/core/transport.py` 传输抽象：loopback 默认（`/dispatch` 口径不变——
> loopback 记录字段与存量逐位一致，echo=回显压缩 hex）；配置为进程内存态，POST
> patch 深合并 + 整体校验，非法 → 400。T2 TCP：stdlib socket 持久连接（复用同一
> 句柄，连续两次发送仅一次 accept）、connect/read 超时 ms 级、收包 25ms 轮询 +
> 50ms 静默截断（不等满 read_timeout）、连接状态事件 connected/disconnected/error
> （有界 50 条）。T3 串口：pyserial（requirements.txt 入册，E2-T3 解禁）lazy
> import；COM/波特率/数据位/校验位（N/E/O 归一大写）/停止位（1/1.5/2 归一）；
> 打开或收发失败 → TransportError。T4 `/transport/config`（GET/POST 深合并校验）
> + `/transport/status`（mode/connected/last_error/events）；/dispatch 发送历史
> 三类事件 raw/response/error：成功 [raw,response]、失败 [raw,error] + HTTP 502
> 且 ERROR 记录入历史（有界 100）。T5 文档口径：README/ZH §3、HANDOVER §4 下发
> 条目 + §5 待办 1 划线、PAGE_STATUS 指令加工/通讯调试两节、pageStatus.json
> processing/terminal 两条目（terminal.implemented 仍 false，E3 才翻）、前端三处
> 注释。验证：后端 79/79（59+20：test_transport.py，含本地回声 TCP 对端双发单
> accept、拒连 502、读超时空响应、串口坏端口、loopback 口径锚）、前端 341/341、
> `vite build` EXIT=0、校验器触达 3 文件 0 违规、curl 冒烟 10/10（loopback 锚 +
> TCP 切换/拒连 + 坏模式 400 + 状态事件）。运维教训：杀旧 uvicorn 须查
> multiprocessing 子进程（37832 的子 38976 继承监听句柄占住 8000）；PS5.1 下
> curl -d 内嵌 JSON 引号会被吞，改用临时文件传 body。

## 6. E3 明细（/terminal 通讯调试页）

- 通讯配置模型 UI（串口参数/目标地址/发送模式，接 E2 配置 API）
- 三面板：发送历史 / 原始报文 / 响应与错误日志
- 验收：`pageStatus.json` `terminal.implemented` → true，人工验证清单过

> **E3 进度（2026-09-23，整批完成，随 E3 整批提交 · 待人工验证 · 验收字段已翻）**：
> 页面 `Terminal.jsx` 全量重写（弃 FeaturePlaceholder 占位，组件保留未删——第 13 单
> 死代码清理批已删，仅此一
> 个使用方已迁走）：① 通讯配置面板 —— 三模式切换（loopback 默认，反白填充选中
> 态）+ 按模式显隐字段（TCP host/port/连接读取超时；串口 COM/波特率/数据位/校验
> 位/停止位，select 取值字符串 → `toPatch` 数字化，空串原样交后端 400 校验为
> SSOT），APPLY 调 `POST /transport/config` 并回填生效配置 + 刷新状态；② 连接
> 状态面板 —— mode/connected 标签（已连接 amber、未连接中性，无霓虹色）/
> last_error / 状态事件最近 8 条（新→旧）+ 手动刷新；③ 三面板 —— 发送历史
> （手动 hex 发送条：`hexInputInfo` 与后端 `hex_to_bytes` 同款清洗，非法/奇数位
> 禁发；表格 TIME/CH/ST/B/HEX 预览、行选中反白、刷新 + NieRModal 确认清空）、
> 原始报文（选中记录 raw 事件 8 字节/行 dump + ID/通道/字节/状态 meta）、响应与
> 错误日志（选中记录 response dump 或失败原因红条 + 全量 ERROR 记录汇总）。
> 视图模型纯函数抽 `utils/terminalPanes.js`（事件拆分/hexDump/预览截断/
> historyRows/hexInputInfo，注释钉与后端 dispatch.py 同口径）。API 层新增
> `api/transport.js`（get/set config + status）经 barrel 出口（顺手修正 index.js
> 旧环回注释）。验收：`pageStatus.json` terminal `implemented` → **true**（六页
> 全 true），`pageRegistry.test` 断言同步翻转；PAGE_STATUS terminal 节 / HANDOVER
> 待办 2 划线同步。测试：前端 **359/359**（341+18：terminalPanes 11 + Terminal
> 页面 7），后端 79/79（无改动回归），`vite build` EXIT=0（529 模块）、校验器
> 5 文件 0 违规（新文件零引入；容器 padding 曾踩 `px-8/py-8`→`px-6` 仍拦 →
> 改 `px-5 py-5` 过——校验器档位正则 ≥6 全拦）。

## 7. E4 明细（编排绑定持久化，甲案）

- `models.py` 新表 `ProtocolBinding`（不改既有表；`create_all` 自动建表）
- 新端点 CRUD（绑定 = protocol_id + instruction_id + 插槽序）+ 编排页读写接线
- 验收：刷新/重启后 bindings 仍在；编排页行为回归

> **E4 进度（2026-09-23，整批完成，随 E4 整批提交 · 待人工验证）**：
> ① `models.py` 新表 `protocol_bindings`（`id/protocol_id/instruction_id/label/
> slot_order`；**逻辑外键**沿 `op_code` 先例不加 FK 约束——本库
> `PRAGMA foreign_keys=ON`，占位期空串会炸真 FK；models.py 仅追加、既有表零改）。
> ② `routers/binding.py`：`GET /bindings`（slot_order 升序 + id 兜底）/
> `POST`（客户端可带 id，`slot_order` 缺省 `next_slot_order`=max+1 纯函数）/
> `PUT /{id}`（None=不改的局部更新）/ `DELETE /{id}`（404 同馆规）；**无模块级
> create_all**（protocol.py 的导入即写真实库不扩散，建表归 lifespan）；
> schema `schemas/binding_api.py` 三件套。main.py 装配。③ 编排页接线：
> 挂载 `GET` 对账 → 空表种默认（服务端同 POST，**加载失败降级纯本地**并挂侧栏
> 错误条，不写后端）→ 加/删即时 POST/DELETE、协议/指令选择即时 PUT、label
> 400ms 尾随防抖（每次变更清旧定时器防旧快照回冲；卸载冲刷 pending）→
> props 到位回填缺失 id 并补 PUT。前端 `api/bindings.js` 四封装 + barrel 出口。
> ④ 验收：`test_bindings.py` 12 例（`next_slot_order` 纯 5 + CRUD 7，**临时库
> 文件直调路由函数无 TestClient**；含「关引擎重开=重启代理」持久化断言）——
> Windows 连接池占文件 `WinError32` 已用 `engine.dispose()` 收口；编排页测试
> 6→11（存量 6 异步化 + 服务端加载/POST/即时 PUT+防抖/DELETE/降级 5 例）。
> 后端 **91/91**（79+12）、前端 **364/364**（359+5）。文档：pageStatus
> orchestration 条目、PAGE_STATUS 编排节、HANDOVER 待办 4 划线同步。
> yorha.db 预期随本批后端重启新增 protocol_bindings 表（文件变更，**不入库**）。

## 8. P 批次明细

### 8.1 P1（设备档案 + 连接持久化）

- `models.py` 两张**新表**（既有表零改）：`transport_settings`（单行 `id="current"`，
  `config` JSON + `active_profile_id` 逻辑外键）+ `device_profiles`（`label` 唯一 +
  `config` 完整三段快照）。
- 落库走 **transport 钩子**：`set_persist_hook`（`set_config` 生效且有变化时回调，
  落配置并清激活指针；钩子失败不回滚已生效配置）——`routers/transport.py` 与
  `test_transport.py` 零改动；`reset()` 一并清钩子防测试间泄漏。
- lifespan 顺序：建表 → 种子 → **先恢复配置再挂钩**（避免启动回写）→ 注册钩子。
- `/profiles` CRUD + `/profiles/{id}/activate`（`routers/profile.py`，无模块级
  create_all，建表归 lifespan）；语义：省略 config 创建 = 快照当前生效配置且即激活；
  快照 == 生效 → 创建即落指针；激活 = set_config（钩子清指针）→ 路由**末次回写指针**；
  手工改配置经钩子失活；删激活档案清悬空指针不动生效配置。
- 前端：调试页「设备档案」区（下拉 `profileOptionLabel` 摘要 + 激活 ★、已激活/已修改
  徽标、存为/应用/更新/删除 + 确认弹窗、区内错误条）；视图模型纯函数
  `utils/profileView.js`（`profileBadges` 防御性忽略 modified ⊆ is_active 之外的输入）。
- 验收：`test_profiles.py` 18 例（store 6 + CRUD/激活 12，临时库直调，含「关引擎
  重开 = 重启代理」持久化断言与钩子清指针断言）；前端 `profileView` 6 例 +
  `Terminal.test.jsx` 7→12（档案挂载/存档/激活回填/更新删除确认/失败条 5 例）。

> **P1 进度（2026-09-23，实现与自动化验证完成，待提交）**：
> 后端 **109/109**（91+18）、前端 **375/375**（364+11）、`vite build` EXIT=0、
> yorha-ui 校验器 0 violations（Terminal.jsx + profileView.js）。文档：pageStatus
> terminal 条目、PAGE_STATUS 已重跑生成脚本、HANDOVER F/G 表 + 待办 3 过期字样
> 修正（DataHub 实为 M2-C3 已落地）。yorha.db 预期随后端重启新增
> transport_settings / device_profiles 两表（文件变更，**不随本批提交**）。
> 人工验证沿「浏览器断连、用户侧补做」先例：调试页存档 → 应用 → 手工改配置失活
> → 重启后端配置与档案仍在。

### 8.2 P2（事务化发送引擎）

- `models.py` **新表** `response_specs`（`instruction_id` 逻辑唯一 + `spec` JSON
  归一入库；既有表零改）。
- 判定核心 `backend/core/response_match.py`（纯函数）：`normalize_spec` 为形态
  SSOT（未知字段/模式/区间重叠/越界 → ValueError → 400）；`match_response` 返回
  `(ok, reasons)`——五要素 = 帧头回显 `echo_header_bytes` / 长度自洽 `length`
  （`声明值 == 帧长 + offset_val`，对齐 `length.py` 的 offset 语义）/ 校验反算
  `checksum`（sum·xor·crc16_modbus，**恒排除字段自身**，span 可配、crc16 缺省
  2 字节，算法与 `handlers/checksum.py`、`formula.js` 同一套，crc16 有双端锚定
  测试）/ 掩码忽略区间 `ignore_ranges` / 前缀后缀 `prefix`·`suffix`；mode =
  echo（默认，结构 + 逐字节回显）/ rules（仅结构）/ any（非空即过）。
- `transport.send(data, read_timeout_ms=None)`：新增**单次读超时覆盖**（不落配置、
  不断连接）——事务逐次 attempt 的 deadline 与配置解耦；缺省 None = 原口径
  （既有调用与 `test_transport` 零改动）。
- `POST /dispatch/transaction`（`routers/dispatch.py` 追加）：超时 → 按间隔重发
  N 次（总尝试 = retries + 1）；广播 = 读侧 1ms 放弃 + 不判匹配（协议保证广播帧
  不回包）；规格解析优先级 **内联 > 按指令（response_specs）> 缺省 echo**；
  响应恒 200（成败在 `status`，保住 attempts 明细），参数/规格非法仍 400；
  逐次 attempt（OK / NO_RESPONSE / MATCH_FAILED / TRANSPORT_ERROR + RTT +
  reasons/error）+ 统计（rtt last/avg/max 只聚「拿到字节」的样本）；同时按
  SENT/ERROR + raw/response/error 口径写入 `/dispatch/history`
  （`DispatchRecord` 形态与 `/dispatch` 手工口径零改）。
- `/response-specs` CRUD（`routers/response_spec.py`，路径键 = instruction_id，
  PUT 为 upsert、保存即归一；无模块级 create_all，建表归 lifespan）。
- 前端：加工页右列新增 `TransactionPanel`（超时/重发/间隔 + 广播开关 +
  SEND_TRANSACTION + 汇总/逐次 attempt 展示 + 折叠式规格编辑器；脏规格内联
  发送、干净规格交后端按 instruction_id 解析；规格 404 → 本地缺省常态、非 404
  降级本地 + 错误条）；视图模型纯函数 `utils/transactionView.js`；api
  `responseSpecs.js` 四封装 + barrel。**同批整改 InstructionRunner 既有 10 处
  校验器违规**（shadow-inner/drop-shadow-sm/shadow-lg 阴影 → 移除/1px 边框，
  7 处松散 padding ≥6 → 5 档）。
- 验收：`test_response_match.py` 23 例（归一 9 + 判定 14）+
  `test_response_specs.py` 7 例 + `test_dispatch_transaction.py` 10 例
  （静默对端 NO_RESPONSE 重试、拒连 TRANSPORT_ERROR 重试、失配重发间隔计时、
  成功落第 2 次 attempt、广播跳过匹配、规格三级解析、脏库 400、手工
  `/dispatch` 口径不回归）。

> **P2 进度（2026-09-23，实现与自动化验证完成，待提交）**：
> 后端 **149/149**（109+40）、前端 **390/390**（375+15：面板 7 + 视图 8）、
> `vite build` EXIT=0（535 模块 / 482.31 kB）、yorha-ui 校验器 0 violations
> （InstructionRunner + TransactionPanel）。文档：pageStatus processing 条目、
> PAGE_STATUS 已重跑生成脚本、HANDOVER H 表 + 待办 7。yorha.db 预期随本批
> 后端重启新增 response_specs 表（文件变更，**不随本批提交**）。人工验证沿
> 「浏览器断连、用户侧补做」先例：加工页打开规格编辑器 → 存规格 → 发送事务
> 查看逐次 attempt 与 RTT。

### 8.3 P3（序列编排后端）

- 新表 `sequences` / `sequence_steps`（models.py 仅新增两表，既有表零改；逻辑
  外键无 FK 约束，建表归 lifespan，同 E4/P1/P2 纪律）。
- **契约定案（沿批复「序列步骤参数 = 保存时定值，TIME/COUNTER 发送时重算」）**：
  步骤存三件套——`payload`（保存时前端 `encodeInstruction` 编译的完整帧 hex）、
  `params`（冻结表单值，P4 回显）、`plan`（发送时重算计划）。发送时 `apply_plan`
  仅补两类字节：
  - `plan.dynamic`：TIME_ACCUMULATOR / AUTO_COUNTER 按发送墙钟重算等长替换
    （编码走 E1-6 双端 byte-equal 的 `encode_time_accumulator` /
    `encode_auto_counter`；offset/byte_len 来自前端 `byteMap`）。长度字段按
    字节数计与值无关 → 冻结帧内长度字节恒有效，无需重算。
  - `plan.checksum`：校验字段按 `regions`（refs 各字段帧内字节区间，**列示
    顺序**拼接——sum/xor 序无关、crc16 按此序）反算写回并落 `byte_order`；
    数值与区间语义抽自 `response_match`（`checksum_value` / `_checksum_span`
    公共化，写入侧与应答反算侧同源；crc16 与 `handlers/checksum.py`、
    `formula.js calculateChecksum` 同一套）。
- 归一 SSOT `core/sequence_plan.py::normalize_plan`（保存与启动双入口，未知键/
  越界/校验区间重叠字段 → ValueError → 400；`apply_plan` 传 hex 字符串亦
  ValueError 防呆）。payload 上限 4096 字节、步骤 ≤200、delay 0..60000、
  name/label ≤128；regions 与校验字段自身重叠 → 400（反算不自含）。
- 后台 Runner `core/sequence_runner.py`：单槽 claim/execute（同步占槽防双启动
  竞态；execute 阻塞——路由丢 daemon 线程、测试直调）；协作式停止（delay 50ms
  分片查停止位，停止后余步 SKIPPED）；`stop_on_error` 两态（true 缺省 → 步
  ERROR 即 failed；false 记错继续跑完 completed）；运行态只存内存、终态保留至
  下次 claim（重启即 idle，定义持久化在库）。
- 路由 `routers/sequence.py`（prefix `/sequences`）：GET/POST 定义、GET/PUT
  （整体替换）/DELETE（204+404，删步骤级联）；`POST /{id}/start`（404 / 400
  无步骤或库内脏数据 / 409 忙）、`POST /stop`（恒 200 幂等）、`GET /status`
  （轮询契约，P4 1.5s；**注册在 `/{sequence_id}` 之前**防被吞成 404）。形状
  缺失 422（pydantic，P2 先例）、业务 400。
- 与手动发送互斥：运行期 `POST /dispatch`、`POST /dispatch/transaction` 入口
  `sequence_runner.is_running()` → 409（`routers/dispatch.py` 两处）；Runner
  直连 `transport.send` 不走被互斥路由，无自锁。编辑/删除运行中定义不打断
  （Runner 持内存副本），编辑入口禁用由前端 P4 承担。
- `response_match.py` 重构：抽公共 `_checksum_span` + `checksum_value`，
  `_checksum_reasons` 改用之（行为等价，既有 `test_response_match` 验回归）。
- 验收：`test_sequence_plan.py` 18 例（归一严格形态 + 补丁 byte-equal + crc16
  regions 列示顺序锚 + **patched frame 过 `match_response` 往返锚**）+
  `test_sequence.py` 7 例（loopback 全流程 / busy / SKIPPED / stop_on_error
  两态 / 脏计划兜底）+ `test_sequence_api.py` 17 例（CRUD、config/步骤边界
  400、404/204、启停轮询、互斥矩阵，临时库直调）。

> **P3 进度（2026-09-23，实现与自动化验证完成，待提交）**：后端
> **191/191**（149+42）EXIT=0；纯后端批次、无前端改动（无 build/校验器项，
> pageStatus 不动）。curl 冒烟四轮全绿：CRUD 归一/校验矩阵（重名/坏 payload/
> 坏 config/404）、真跑 completed、补丁链实测（TIME `0000→0DC3`、checksum
> sum 反验 `expect=0181 got=0181 match=True`）、互斥 409×3（dispatch/transaction/
> 二次 start）、停止 → 全 SKIPPED、释放后手动发送恢复 200；冒烟数据已清
> （`/sequences` `[]`、`/dispatch/history` `[]`）。yorha.db 预期随本批后端
> 重启新增 sequences/sequence_steps 两表（文件变更，**不随本批提交**）。
> 人工验证沿「浏览器断连、用户侧补做」先例：P4 序列编排页落地后一并补页面级
> 验证（定义 CRUD、启停、1.5s 轮询、运行期手动发送禁用）。

### 8.4 P4（序列编排前端）

- pageStatus.json 第 7 项（key `sequences`、path `/sequences`、shortcut `F`
  ——A/B/R/C/D/E 之后的新占用，`implemented: true`）+ 生成器重跑 →
  `docs/PAGE_STATUS.md`。PAGE_REGISTRY 派生：导航项 / 状态板徽标 / 路由注册
  表自动收录，`App.jsx` 仅 +2 行（import + `case 'sequences'`）。
- **双轨指令处理（本批关键设计）**：表单渲染走 `normalizeRunnerInstruction`
  （render 语义），**编码与计划编译走 raw op_code** —— normalize 会把
  `TIME_ACCUMULATOR` 映成 `TIME_CUMULATIVE`、`AUTO_COUNTER` 映成 `INPUT`，
  只有 raw 才与后端发送时重算 byte-equal。步骤编辑器复用
  `useInstructionForm`(raw) + `RunnerFieldTree`(normalized)，实时帧预览
  即保存产物（preview == payload 同源）。
- `utils/sequenceView.js` 纯函数：`buildPlan` 逐条镜像编码器门槛（TIME/
  COUNTER 需 `params.type` ''/'number' 门；Current = computed > input >
  value > start_val，无源取 0 与 `floorNum(undefined)` 同口径；checksum 只认
  `algorithm`、缺省 CRC_16_MODBUS、refs 数组顺序生成区间——crc16 拼接序锚、
  悬空 ref 跳过、组 ref 取子树叶子并集、重复叶合并连续区间）。后端 400
  形态**全部生成侧降级**（自含重叠 / 算法不支持 / crc16 非 2B / >4B /
  refs 无区间 → 不入计划 + warning，保存必过）。键集与
  `backend/core/sequence_plan.normalize_plan` 严格同形（未知键 400）。
  另含状态/进度/计划摘要/字节数/位序调整辅助与 `EMPTY_CONFIG`。
- `api/sequences.js` 七端点入 barrel（DELETE 204 无体特判，不走
  `handleResponse` 的 json 解析）；启动 404/400/409 分流由页面红横幅承接
  （409 = 忙 / 与手动发送互斥同文案口径）。
- `pages/Sequences.jsx` 三栏：定义列表（新建 / 二次确认删除 / 刷新）·
  定义与步骤编辑（名称/描述/出错即停/读超时 + 步骤行未编译/字节数/计划摘要
  徽标 + 上移下移移除 + RunnerFieldTree 表单 + 实时帧预览 + PLAN 徽标 +
  降级警告 + 应用编译 + PUT 整体保存剥离 id/step_order）· 运行状态
  （启动/停止、结果徽标、进度、`/status` 挂载即拉 + 1.5s interval 卸载清理、
  逐步 OK/ERROR/SKIPPED 与 RTT、stop_requested 与运行级错误）。
  `canSave` = 非空名 + 步骤全编译 + 超时 1..60000 或空（0 步可存，空序列
  启动被后端 400 拦）；运行期定义编辑/删除/新建/启动全禁用、停止恒可用
  （幂等）。
- 验收：前端 **428/428**（基线 390 + 新 38：sequenceView 24 +
  Sequences 14，36 文件）EXIT=0；`vite build` EXIT=0；yorha-ui 校验器本批
  UI 文件（Sequences.jsx / sequences.js / sequenceView.js /
  Sequences.test.jsx）**0 违规**——首轮命中 `py-10` 已改 `py-4` 清零；
  `App.jsx` 壳层 5 处（backdrop-blur×2、p-6/py-6/px-6）为**既有违规**
  （`git diff` 证本批仅 +2 行未引入），留待独立 UI 清理批，本批不改以免
  壳层视觉回归。测试环境教训：本仓**未装 jest-dom**——存在/禁用断言须用
  `toBeTruthy()` / 元素 `.disabled` 属性。
- 页面级人工验证沿「浏览器断连、用户侧补做」先例：F 页快捷徽标、步骤编译
  预览、启停与 1.5s 轮询、运行期互斥禁用由用户侧补做；409 文案已自动化锁形。
- 纯前端批次 → `yorha.db` 无变化，**本批不产生 db 同步提交**。

### 8.5 P5（通讯日志落库 / 导出 / 回放）

- **范围**：新表 `dispatch_logs`（第 12 表，`models.py` 既有表零改）+ 写侧
  `backend/db/log_store.py` + 读侧 `backend/routers/logs.py`（挂 `main.py`）+
  `sequence_runner.set_log_hook` 钩子接线；`/dispatch/history` 内存口径不变
  （E2-T4 deque，既有测试锁形零回归）。纯后端批次 —— 前端零改动，无构建/
  校验器环节；`dispatch_frame` 新增 db 参数，既有直调不传 db 经 `safe_log`
  isinstance 守卫零回归。
- **测试**：后端 **205/205**（基线 191 + 新增 14 `backend/tests/test_logs.py`
  —— 四路落行/旁路守卫/过滤 400/导出 BOM/回放矩阵/清场）EXIT=0；
  `python -c "from backend.main import app"` → IMPORT-OK 55 路由。
- **curl 冒烟五轮全绿**（重启 uvicorn 载入 P5，lifespan `create_all` 建表）：
  R1 手动双发 200 + `/logs` 降序 2 条 + `source=manual` 过滤 200 +
  `source=bogus` 400（detail 业务口径）；R2 导出 `csv` 200（**BOM=YES**、14 列
  表头逐字节正确、附件头）/ `json` 200 / `xml` 400 / 过滤导出不含
  transaction；R3 回放 200 SENT（echo 回显）+ 落 `replay` 新行 + 三事件入
  history、`999999` → 404「日志不存在」；R4 事务 200 + 序列
  create→start→completed→delete 全链 200/204；**合计 `BY-SOURCE manual=2
  replay=1 sequence=1 transaction=1`（四路写入铁证）**；R5 `DELETE /logs` →
  `{"status":"cleared","remaining":0}` + 复查 0 条、history 清 200（冒烟数据
  全清，仅表结构留在 db）。
- **提交**：本批 9 文件（7 实现/测试 + 2 文档）一提交；`yorha.db` 因新表 DDL
  **单独同步提交**（沿 `8f1b171`/`d95c1e4`/`b052139`/`9c84911` 先例）；P5
  自身 hash 提交后回填 §1。

### 8.6 A+B（协议页卡片对标指令页 + 容器内联展开导航）

- **范围**（纯前端 8 文件；动共享 `Block.jsx` → Instruction/Blueprint/
  Orchestration/Protocol 四页全量回归；`Canvas.jsx` **零改动**）：
  - **Tier A 卡片数据补齐**：`protocolTree.computeProtocolOffsets` 适配层
    （children 树 → `computeByteOffsets` 扁平入参；容器打 `ARRAY_GROUP` 标仅限
    适配层不落库 —— 空容器命中 `isGroupOp` 判已知 0B 组，不再被 `byte_length=0`
    判未知尺寸污染后续偏移）经 `protocolOffsets.byId` 传入 Canvas；`Block.jsx`
    四规则：`::` 判定与标签宽度地板统一 `isGroupMark`（op_code 组 ∥
    `offsetMeta.isGroup`，同源单次计宽防重复 +18）、hex 上卡条件加
    `type==='fixed'`、`type==='slot'` 沙底虚线（对齐调色板占位虚线语义）、设计期
    `length/checksum` 中心值 `??`（对齐指令页 LENGTH_CALC/CHECKSUM 口径，替代
    误导性 `00` 占位）。
  - **Tier B 内联展开导航（下钻式 → 指令页范式替换）**：`pathIds`/面包屑退役 →
    `expandedContainerIds` + `focusedParentId`；切协议默认全展开 + 焦点回根、
    焦点自愈（逐行镜像 `useInstructionLanes:50-64`）；`buildProtocolLanes` 树版
    buildLanes（DFS 序、展开门控，`Canvas.RenderLaneNode` 原样按 parentId 挂
    子泳道与层级连线）；点容器卡 = 选中 + toggle 展开（Canvas 组双发以
    `op_code==='ARRAY_GROUP'` 为闸，协议容器无 op_code → 页面层 `onSelect` 接，
    **共享 Canvas 零改动**；展开覆焦新泳道、收起落父泳道，时序对齐
    `handleNavigateGroup:236` + `Canvas.jsx:292`）；属性面板 ENTER = 确保展开 +
    聚焦；调色板新容器自动展开 + 聚焦（镜像 `Instruction.jsx:266-271`）；
    `moveNode` 跨容器落点接 `computeFinalPlacement`（含**环守卫**：目标为自身/
    子孙原引用早退 —— 树成环 = `findNode`/buildLanes 栈溢出冻结，扁平
    parent_id 模型仅块不可见，协议侧必须拒收）；删节点 = 子树剪枝（对齐指令页
    级联删除最终效果）；加块落焦点泳道。
- **测试**：前端 **447/447（37 文件）** EXIT=0（基线 428 + 新增
  `protocolTree.test.js` 18 例纯函数锁形 + Protocol 净增 1 例；导航用例按新范式
  重写：默认全展开 / 点卡 toggle / ENTER 重聚焦 / 深层编辑持久化整树 + 新容器
  自动展开锁形）；`npm run build` EXIT=0；校验器触 `Protocol.jsx` + `Block.jsx`
  0 违规 EXIT=0；后端零改动沿用 **205/205**。
- **回归边界**：Blueprint/Orchestration 不传 offsets → 组卡/`::`/页脚零影响；
  无 `hex_value` 的 fixed 块在新 hex 规则下渲染不变（`&& effectiveHex` 短路）；
  指令页 `computedValue` 检查先于新 `??` 规则，公式结果优先不受影响。
- **提交**：本批 9 文件（5 实现/测试 + `pageStatus.json` 手写条目 2 行 + 3 文档
  —— PLAN/HANDOVER + `docs/PAGE_STATUS.md` 随生成器再生成）一提交；
  纯前端无 DDL → **无 db 同步提交**；`Sequences.jsx` 配色修复留在工作树
  待目视确认，独立 fix 批提交。

### 8.7 一期（协议 refs 引用 + 帧级合并 + 封装试发）

- **范围**（用户批准清单 A8+B3+C3；零 DDL，后端仅 refs 校验 + schema 两处，
  `processor.py`/`graph.py`/`Blueprint.jsx`/共享 `Canvas.jsx`/`Block.jsx` 零改动）：
  - **A refs 引用（协议页）**：`blockTypes.js` A1 `createBlock` 对 length/checksum
    初始化 `parameter_config:{type,refs:[]}` + `BLOCK_PROPERTY_FIELDS` refs 字段
    （dot-path key、`inputType:'refs'`、无 parse）；A2 `ProtocolPropertiesPanel`
    refs 专用分支（FieldPickerParam 形态：`N REF(S)` 计数 + SELECT FIELDS/STOP
    切换 + `data-testid="ref-chip-<id>"` 芯片单删、label 解自 `findNode` ——
    dot-path key 通用 input 承载不了数组）；A3 `Protocol.jsx` 页内 picking
    （anchorId=发起卡、`onUpdateRefs` 走 `handleUpdateBlock` 防抖落库；切协议/
    改选中中止，镜像 `Instruction.jsx:104-112`；ESC 不接，画布背景
    `onCancelPick` + STOP 双兜底；`handlePickBlock` 拒 slot 锚/自引用、toggle
    去重）；A4 `protocolTree` `computeRefsSigma`/`injectRefsSigma` ——
    `type==='length'` 注入 `formatToHex(Σ, byte_length)` **pretty 空格直出**
    （checksum 保持 `??`；悬空/空 refs/尺寸 null 不注入），`displayLanes` 纯派生
    不落库；refs 同树约束前端过滤 + 后端 `_validate_refs` 四类 400（英文 detail）；
    `ProtocolNodeSchema.parameter_config` 入 schema、删 `protocol.py` 模块级
    `create_all`（对齐 `binding.py` 先例）。
  - **B 帧级合并（N 指令 → 1 帧）**：B1 `blockMerge.mergeProtocolInstruction`
    第二参收指令数组（单对象/undefined/[] 向后兼容）—— payload 游标 DFS 填洞、
    空洞保留 slot（发射归零）、溢出 `.flat()` append 根末尾，`cloneBlocks` 同步
    p-/i- 前缀化 refs；B2 编排页组作用域 = 同 protocolId 绑定按 slot_order 升序
    → 指令数组（单绑定退化 E4 原语义，缺指令 `filter(Boolean)` 跳过）+ 侧栏
    `sortedBindings` 按（协议序, 洞号）重排（跨协议不按全局洞号穿插）；
    B3 洞位下拉（**稠密位次**）：`toServer` 出线 `slot_order`、seed 初始
    `slotOrder:0`、加/删/换洞经 `renumberGroup`/`handleSlotOrderChange` 组内
    重编号 0..n-1 **仅回写真变化行**（挂载零回写零钳制）、`countSlots` DFS 三态
    警示（无 SLOT/洞位不足/空洞）+ 右栏 N-填洞文案；`getTotalBytes` 与发射期
    slot 归零，设计期 offsets 标尺不动。
  - **C 封装试发**：C1 header「封装试发」= `getInitialValues` →
    `resolveDependencies` → `encodeInstruction`（与指令页同链路；试发编译走
    前端编码器 → `toFrameBlocks`/handlers/`POST /dispatch` 载荷**零改**，C3 零改）
    → `api.dispatchPayload(hexString, instruction_name)`；回显 `SENT: <hex>` /
    `SEND FAILED: <err.message>`（409 detail 透出）；空组装双闸禁发（disabled +
    handler 守卫）。R2 记档不修：后端导出协议 length/checksum 因死 `config={}`
    现状输出 00（既存缺陷，非本批引入）。
- **测试**：前端 **483/483（37 文件）** EXIT=0（基线 447 + 新增 36，其中 UI 新
  7 —— Protocol A2/A3（拾取→过滤→防抖持久化→芯片单删）/A4（Σ 注入 vs
  checksum/悬空不注入）、Orchestration B2/B3/侧栏重排/C1 空禁发/C1 编译试发
  409 透出；A2/A3 查询串随 Σ 注入修为 `/^LENGTH/` 前缀正则）；后端
  **215/215** EXIT=0（+10 `test_protocol_refs`：四类 400 + parameter_config
  透传）；`npm run build` EXIT=0；校验器触 9 文件 0 违规 EXIT=0。红测先行：
  编码层红测与 UI 红测均先跑红（UI 7 红）再实现转绿。
- **回归边界**：未触共享件 → 人工回归收敛为协议/编排两页 + refs 拾取、封装试发
  两条闭环目视（用户侧待做）；指令/蓝图/编排既有断言（`总长度`、
  `默认绑定 (DEFAULT)`、backfill 零回写）全量保持绿。
- **提交**：19 文件（实现 9 + 测试 6 + 配置/文档 4 —— `pageStatus.json` 手写
  2 条 + PLAN §8.7 + HANDOVER 待办 12 + `docs/PAGE_STATUS.md` 生成器再生成）
  一提交；零 DDL → **无 db 同步提交**（`yorha.db` 工作树改动不入库）；
  `Sequences.jsx` 配色修复留在工作树独立批。
- **② 范围修订：slot 作 refs 目标**（用户 2026-09-23 确认新语义，原非目标放开）：
  「定义协议时长度字段包含某 slot → 该长度字段在将来发送指令时根据确定的指令码
  计算出来」。四点改动（红测先行独立批）：
  1. UI 拾取放开：`handlePickBlock` 删 `target.type==='slot'` 过滤（自引用仍拒 +
     新增 `SYS: 不能引用自身` 状态栏提示），A2/A3 用例改写（slot 计数进位、
     双芯片逐删）；
  2. 设计期 Σ：`computeRefsSigma(block, byId, root)` **签名扩展第三参 root** ——
     refs 含槽目标（`findNode(root,id)?.type==='slot'`）→ `null` 整卡不注入维持
     `??`（即便 slot 带 byte_length）；不改共享 `byteOffsets` byId 契约
     （`toEqual({offset,size,isGroup})` 精确形状断言 ×9 + 指令页共用），
     `injectRefsSigma` 透传 root、`displayLanes` 传 `currentProtocol` 进 deps；
  3. 后端放开：`_validate_refs` 删锚 slot 400 分支（剩 非数组/非字符串/自引用/
     悬空四项），docstring 同步；
  4. 发送期真值：`mergeProtocolInstruction` 填槽时记改写表
     `槽p-id → [注入i-ids]`，收尾 `applyRewrites` 全树把引用该槽的 refs 展开为
     注入块 ids → 编码器 PASS1 `Σ fieldSizes[refId]` **零改动**算出含载荷真长度
     （空槽未改写 fieldSizes=0 自然不计；i-/p- 前缀天然不撞）。
- **② 测试/回归**：红测先行 —— FE 3 红（A3 计数 / 槽Σ 不注入 / 填槽改写）+
  BE 1 红（slot 200 例）先红后绿；全量 前端 **486/486（37 文件）**、后端
  **215/215**、build EXIT=0、校验器触 6 文件 0 违规，全 EXIT=0；后端活探针
  slot refs POST 200（reload 周期复验通过，运维坑见 HANDOVER 待办 13 注）。
- **协议页批次一：级联引用清理 + 保存失败恢复**（2026-09-23 协议页分析产出
  P0 落地，三点改动）：
  1. P0-1 删协议级联绑定：`handleDeleteProtocol` 删前查 `GET /bindings` 按
     `protocol_id` 计数 → 有引用开 `NieRModal` 警示"连带清理"（取消不删，
     确认才执行），无引用直删；`DELETE /protocols/{id}` **同事务级联删**
     `protocol_bindings`（逻辑外键无 FK/ON DELETE，不清则编排页
     `protocols.find` 落空 + DB 脏行）返回 `deleted_bindings` 计数，成功状态
     回显"连带清理 N 条"；检查失败降级直删（后端级联兜底）；仅剩一个协议
     禁删不再静默 return，给 `SYS: 至少保留一个协议`；
  2. P0-2 删块级联剥 refs：`protocolTree.removeNode` 先收集被删子树 id 集
     （含容器子孙），剪枝后剥离剩余树 `parameter_config.refs` 命中项 —— 此前
     悬空引用落库必 400 "refs target not found" 且前端只给固定文案，整树卡
     保存无从定位；纯函数、仅命中节点复制、输入树零改写；
  3. P0-3 保存失败恢复（镜像指令页 P4-2）：失败时**脏负载归还**
     `pendingSaveRef`（若防抖窗口内已有更新 payload 则不覆盖，pending 恒 =
     最新未保存负载）、定时器触发不再提前清 pending（覆盖保存 in-flight 网络
     窗口）；新增 saveError 横幅区分「服务端拒绝（400/422）/ 网络·服务错误」
     并透传 `error.message`（handleResponse 已格式化后端 detail），重试 =
     `flushPendingSave`、× 只关横幅不清脏态，成功清横幅；创建/删除失败状态栏
     同样透传 detail。
- **② 批次一测试/验收**：FE **492/492（37 文件）**（基线 486 + 新 6：
  protocolTree +2 级联剥 refs / Protocol +4 —— 弹窗取消·确认·无引用直删·
  末协议禁删、失败横幅 detail+pending 归还+重试转绿）、BE **218/218**
  （基线 215 + 新 3 `test_protocol_delete`：零引用 0 计数 / 级联仅清本协议
  绑定 / 404）、build EXIT=0、校验器触 `Protocol.jsx` 0 违规，全 EXIT=0。
  `Protocol.jsx` 存量 1 error 2 warnings（react-hooks/immutability 先声明后
  用 + exhaustive-deps，**HEAD 同报**）不计入本批。零 DDL → 无 db 提交。
- **协议页批次二：保存前结构校验 + 撤销/重做**（2026-09-23 用户「继续」
  批准，P0-4 + P1-5 两点）：
  1. P0-4 `validateProtocol`（新纯函数 `utils/validateProtocol.js`，镜像
     `validateInstruction.js` 形态：`{errors, warnings}` + 条目
     `{blockId, code, message}` 可定位）。**errors 阻断**：HEX 含非 hex
     字符（fromhex 失败静默错帧，后端零校验）、fixed 长度严等
     `byte_length×2`、refs 四类（非数组/非字符串/自引用/悬空，镜像后端
     `_validate_refs` 中文前置）、重复 id。**warnings 不阻断**：运算块
     （length/checksum/slot，运行期重算/填槽）长度差、同层标签重复
     （默认标签撞名常见且后端不校验）、checksum 未挂 refs（编码期按 0
     输出）、fixed 空 hex。容器跳过 hex 检查（组语义，**防误报闸** ——
     防抖自动保存下误报 = 既成事实编辑无法落库，误报即锁死）。跑点 =
     `saveProtocol` 唯一咽喉（防抖 / 切协议 flush / 横幅重试全覆盖）：
     errors → 不 PUT、pending 归还（离开拦截武装）、
     `SYS: 保存被阻止：N 个结构错误`；清单**常驻属性面板顶部**（选中块时
     不隐藏，比指令页更进一步 —— 防抖下边修边看），点条目 =
     `protocolTree.findAncestors` 展开祖先容器 + 选中定位；改好后下一次
     防抖自动放行、清单同步消失；保存成功状态栏并入 `· N 提醒`。warning
     级不阻断保住两处存量用例（A2/A3 length 差异、A4 无保存渲染）与种子
     协议零 brick（seed 的 len/slot 本就无 hex_value / 槽长 0）。
  2. P1-5 撤销/重做（复用指令页 `useHistory(50)`）：`commitTree` 统一
     「压旧快照入 undo 栈 → apply → schedule」（协议改名同走此入口），
     `handleUndo/handleRedo` = 换快照 + 重新入防抖链 —— 自动保存语义下
     撤销本身也即时落库；**保存不清史**（否则 350ms 防抖落库瞬间撤销窗口
     归零）、切协议清史（switch 效果内 `clearHistory`）、新编辑作废 redo
     （hook 既有口径）。顶栏新增 h-10 `PROTOCOL EDITOR` 条（镜像指令页
     `KERNEL EDITOR` 条，左标题点击清选中）挂 撤销/重做 按钮（disabled
     联动 canUndo/canRedo，类名照抄指令页）+ Ctrl+Z / Ctrl+Shift+Z
     （输入控件聚焦或删除弹窗打开不响应，镜像 Instruction.jsx:125-138）。
- **② 批次二测试/验收**：FE **505/505（38 文件）**（基线 492 + 新 13：
  validateProtocol +10 / protocolTree `findAncestors` +1 / Protocol +2 ——
  阻断·清单定位·修复放行 与 撤销·redo·Ctrl+Z·切协议清史）、BE
  **218/218**（本批零后端改动，全量回归）、build EXIT=0、校验器触
  `Protocol.jsx`/`ProtocolPropertiesPanel.jsx` 0 违规，全 EXIT=0。
  改写存量 1 例：`edit block properties` 4 字节 hex 'FF' → 'FF FF FF FF'
  （fixed 严等新语义下旧值必被阻断）。ESLint 仍为 HEAD 存量 1 error
  2 warnings（immutability 先声明后用 + exhaustive-deps）不计入本批。
  零 DDL → 无 db 提交。
- **协议页批次三：复制协议 / 复制块**（2026-09-23 用户「继续」批准，
  P1-1 + P1-2 两点，全前端零后端改动）：
  1. P1-1 复制协议（侧栏行悬停「副本」按钮，镜像
     InstructionListSidebar:56-67 + duplicateInstruction 流程）：
     `buildDuplicateProtocolPayload`（protocolTree.js 新增）纯函数构造 ——
     **整树重生 id**（防与源撞主键）+ **refs 全量重映射到副本**
     （`cloneFieldsForNewInstruction` 的 remap + 丢弃不可解口径，防 POST
     `_validate_refs` 400 "refs target not found"）+ label「(副本)」
     升序防撞（后端不校验 label 唯一，纯 UX 对齐指令页）；POST 直建 →
     追加列表并切到副本。无 dirty 确认（指令页那问「放弃未保存？」是手动
     保存语义；协议页防抖自动保存，切协议即 flush pending，无「放弃」）。
  2. P1-2 复制块（属性面板「复制块 (DUPLICATE)」，照抄
     BlockPropertiesPanel:502-505 按钮）：`duplicateNode` 深拷贝插源块
     之后 —— 子树全新 id、根标签同层 `_N` 防撞（descendants 随拷贝容器
     另起一层不改名）、**refs 保持指原块**（镜像
     duplicateBlockInInstruction:80-82 documented「un-wired copy ——
     re-target explicitly」：同树原块恒在不悬空，语义不被自动改写）、
     pc 浅拷零别名；副本立即选中、副本是容器顺手展开（镜像
     handleAddBlock 新容器口径）；输入树零改写。两函数共享
     `cloneTreeWithNewIds` 两阶段发号（先预序建 idMap 再重建）。
     **后记**：该入口随人工验证第 3 轮 #1 撤 UI（2026-09-24），纯函数 +
     3 单测按用户拍板连删（见 §8.11 #1），仅 `cloneTreeWithNewIds` 留用。
- **② 批次三测试/验收**：FE **511/511（38 文件）**（基线 505 + 新 6：
  protocolTree +4 —— 插位/防撞/un-wired refs/零改写 + 协议负载升序·自含
  重映射·null 边界；Protocol +2 —— 侧栏副本 POST 负载·切副本、复制块
  插位·选中·refs un-wired 落库）、BE **218/218**（零后端改动全量回归）、
  build EXIT=0、校验器触 `Protocol.jsx`/`ProtocolListSidebar.jsx`/
  `ProtocolPropertiesPanel.jsx` 0 违规，全 EXIT=0。ESLint 仍为 HEAD
  存量 1 error 2 warnings 不计入本批（期间自伤 2 处已修：`walk` 叶节点
  无 children 守卫、`handleDuplicateBlock` 重复声明去重）。零 DDL → 无
  db 提交。
- **协议页批次四：协议 JSON 导入/导出 + 协议级属性 + checksum 算法配置**
  （2026-09-23 用户「继续」批准，P3-1/P3-2/P3-3 三点，前端为主 +
  后端 handlers refs 集合模式，R2 死 config 断点本批打通）：
  1. P3-2 协议 JSON 导出/导入：顶栏 导出/导入 按钮 + 隐藏 file input
     （镜像指令页 importInputRef 范式；指令页导出已按反馈移除，协议侧
     本批保留 —— 备份/迁移需要）。导出 = 当前工作副本**原样**下盘
     `{schemaVersion:1, protocols:[proto]}`（`triggerBlobDownload`，与
     导入包装入口对称）；导入 = parse → `analyzeProtocolImport`
     （importExport.js 新增，report 同 analyzeImport 形态但**无
     conflicts** —— 后端不校验协议 label 唯一，撞名在负载构造器内升序
     承接）→ 预览 NieRModal 摘要 → 顺序 POST 追加**永不覆盖**，成功切到
     首个导入项。负载构造 `buildImportedProtocolPayload`
     （protocolTree.js 新增）：复用 `cloneTreeWithNewIds` 整树重生 id +
     refs 自含重映射（丢悬空防 `_validate_refs` 400）+
     `ProtocolNodeSchema` 白名单净化（外来编辑器私有键不落库）+ checksum
     算法 `mapChecksumAlgo` 归一（镜像指令页 B1 aliasChecksumAlgo，枚举外
     值两端回退口径不一 → 入库前统一）+ 撞名「(导入)/(导入N)」升序
     （空闲名保真 —— 与复制恒加「(副本)」语义分野）；节点缺 id 前置拦截
     （克隆发号按 id 建 Map，无 id 会整树共用新 id）。
  2. P3-1 协议级属性：面板协议级视图加 description textarea（schema 既有
     字段**零 DDL**；载荷既有 `description` 键 + `serializeProtocol` 含
     description 签名 → 防抖保存链自然覆盖）；`onProtocolLabelChange` 改名
     `onProtocolMetaChange`（label + description 共用 apply+schedule）。
  3. P3-3 checksum 算法配置（R2 打通）：`blockTypes.js` 新增 `algo` 字段
     （inputType `select`，SUM_8/XOR_8/CRC_16_MODBUS，缺省
     CRC_16_MODBUS）挂进 checksum fields，面板按 inputType 分流（点路径
     `parameter_config.algorithm`，写入带 type 同 refs 分支口径）→ 前端
     编码器 PASS2 `params.algorithm || CRC_16_MODBUS` 直接生效。编排导出
     断点打通：`toFrameBlocks.buildLogicConfig` 把 refs 按**数组序展开成
     叶子 id 列表**（容器 ref 展开子树文档序、悬空丢弃 —— range 区间模型
     对非连续 refs 会把区间内无关块算进来，故不采用 target_start/end）
     + 算法枚举映射（SUM_8→sum / XOR_8→xor / CRC_16_MODBUS→crc16_modbus，
     缺省 crc16_modbus 与前端编码器同源）翻进 `config.params`；后端
     LengthHandler/ChecksumHandler 新增 **refs 集合模式**（`params.refs`
     为 list 时走集合语义：跳过自身/禁用/slot、repeat 出现几次算几次、
     空集归 0 —— crc16 空数据本为 0xFFFF 须在算法前短路全 0），无 refs
     键的**旧 range 模式原样保留**（graph/模板侧在用，回归向量在批内测试
     锁定）；validateProtocol 新增 **W4** 算法枚举外 warning（枚举外值
     两端回退口径不一：前端 0 / 后端 crc16 —— 导入已净化 + UI 只产枚举，
     W4 兜底手改库/其他写入方，不阻断）。存量行无 `parameter_config.refs`
     → config 直通，行为与批次四前逐字节一致。
- **② 批次四测试/验收**：FE **525/525（39 文件）**（基线 511 + 新 14：
  toFrameBlocks +5 —— refs 叶子展开/算法映射/存量直通/嵌套递归、
  importExport +5 —— 包装接受/自含重映射/白名单净化·算法归一/结构拦截/
  撞名升序、validateProtocol +1 —— W4、Protocol +3 —— 导出负载·导入预览
  POST 切换·算法下拉落库）、BE **230/230**（基线 218 + 新 12：
  `test_logic_refs_config` —— length 非连续集合语义/跳过·空集 offset、
  checksum 三算法·crc16 refs 序敏感·空集归 0·空格清洗、集合=区间一致性、
  range 模式回归、无 config 归 0）、build EXIT=0、校验器触
  `Protocol.jsx`/`ProtocolPropertiesPanel.jsx`/`ProtocolListSidebar.jsx`
  0 违规。ESLint 仍为 HEAD 存量 1 error 2 warnings 不计入本批。零 DDL →
  无 db 提交。

- **两页卡面取值口径改造：能确定 → 直接显示数值，不确定 → 按字节数等量 ??**
  （2026-09-24 用户直接下达，三问确认口径；纯前端展示层、零后端零 DDL）：
  1. `formula.js` 新增公共助手 `formatUnknown(byteLen)`：按字节数出等量
     `??`（1B→`??`、2B→`?? ??`、4B→`?? ?? ?? ??`，替代写死单个 `??`；
     缺省/非法/<1 按 1 字节）。长度值同步**十进制化** —— 协议页
     `injectRefsSigma` Σ→`${sigma}B`、指令页 `LENGTH_CALC`→`${result}B`
     （长度是「数量」不是字节内容，hex `0F` 会被读成字节值；卡片宽度/
     页脚与偏移标尺另承担尺寸口径，`byteOffsets` 兼容性已核实：注入只写
     派生副本不回流不落库、组分支只走 Σ 子从不读 computedValue）。
  2. 组/容器卡**中央值 = 嵌套内容逐块拼接**（已知子块出字面 hex、未知子块
     按 byte_length 出等量 ??，如 `AA 55 ?? ??`；页脚仍显尺寸 `4B @00`）：
     指令页 `useInstructionLanes.fieldContent` 递归（HEX_RAW/hex/fixed 字面
     pretty 化、其余按字节等量 ??、子块取 sequence 序、空组回退尺寸分支）；
     协议页新导出 `injectContainerContent` 在 `Protocol.jsx displayLanes`
     链式接入（length/checksum/slot 的 hex_value `'00'` 系建块默认占位非
     真值 → 等量 ??；嵌套容器递归；空容器不注入 → Block 落尺寸分支 `0B`）。
  3. 其余卡面：协议页 length/checksum 无真值 → `formatUnknown(byte_length)`；
     指令页 CHECKSUM 空 refs → `formatUnknown(f.byte_len || 1)`、
     LENGTH_CALC 失败/含未知 → 同口径；组卡无内容但尺寸已知 → 按尺寸出等量
     ??（size=0 → `'0B'`）；TIME_ACCUMULATOR 中央值下方新增
     `BASE 2026-09-23 14:00` 小字（未配置 → `BASE ?`；无基准注入等量 ??
     占位、有基准保留 hex 差值口径 test:82 不变），宽度补偿 `baseNeed` 按
     8px mono ≈4.8px/char + 8。普通输入叶子的 `00` 填充不在范围保持不变。
- **② 卡面口径测试/验收**：FE **531/531（39 文件）**（基线 525 + 新 6：
  Block +2（length/checksum 等量占位、TIME BASE 行）/ useInstructionLanes
  +2（组内容拼接 `AA 55 ?? ??`、TIME 无基准占位）/ protocolTree +2
  （injectContainerContent 内容拼接/嵌套递归）；改写存量断言 Block 2、
  useInstructionLanes 4、protocolTree 3、Protocol 2 —— hex→十进制
  （`0F`→`15B`、`00 02`→`2B`）与组卡 `4B`→内容串/等量 ?? 属预期更新而非
  回归）、BE **230/230**（零后端改动全量回归）、build EXIT=0、校验器触
  `Block.jsx`/`Protocol.jsx` 及两测试文件 0 违规；ESLint 与 HEAD 存量
  逐文件对齐无新增（Block 1 error 1 warning、useInstructionLanes
  3 error 5 warnings、protocolTree 0、Protocol 1 error 2 warnings；
  Block displayValue 重排曾新增 react-compiler preserve-manual-memoization
  1 error，已用守卫内 `const size = offsetMeta.size` 单读取回归 HEAD 口径）。
  零 DDL → 无 db 提交。

- **协议页批次五：version 乐观并发**（2026-09-24 用户批准，三口径确认：有
  DDL 整数列 / 缺 version 直通 / 冲突双动作）：
  1. 后端：`models.ProtocolTemplate` 新增 `version INTEGER NOT NULL DEFAULT 1`
     （表 `protocols`）。本仓无迁移框架 → `database.ensure_protocol_version_column`
     启动自愈：create_all 后 PRAGMA 查缺列则 `ALTER TABLE protocols ADD COLUMN
     version INTEGER NOT NULL DEFAULT 1`（DEFAULT 1 顺带回填存量行），幂等；
     表不存在/已有列 no-op；`main.py lifespan` 在 create_all 后接线。
     `ProtocolUpdate.version` Optional 缺省 None = 旧客户端/curl 直调 → 跳过
     比对直接覆盖；`ProtocolResponse.version` 回读（新建恒 1）。`update_protocol`
     ：404 后**先 409 比对再 refs 校验**（陈旧前置条件先拒，对将被拒负载做
     内容校验无意义），成功写恒 +1（含直通写 —— 否则持旧 version 的其他客户
     端会误判仍一致）；detail 英文 `Protocol version conflict: expected X,
     current Y` 对齐 "Protocol not found" 先例。
  2. 前端：`api.getProtocol(id)`（冲突按 id 拉最新行）；`saveProtocol` 增
     `{forceVersion}` 参数 + PUT payload 携带本地 `version`（旧夹具无该字段
     → undefined → JSON 丢键 → 后端直通，既有测试零改）；失败横幅三分类
     （409 版本冲突 / 400·422 服务端拒绝 / 其余网络·服务错误）+ `saveConflict`
     态换按钮组 —— 冲突态「强制覆盖」（GET 最新 version → forceVersion 重发）
     与「加载最新」（清脏负载 + 撤防抖定时器 + 签名/历史重置 + 服务端版本替换
     工作副本；id 未变 → 展开/焦点保留，指向已删节点由既有自愈 effect 清理），
     非冲突仍走「重试」；双入口先收横幅防双击并发重发（失败由分类重新拉起）；
     保存成功与 × 关闭均清冲突态。
- **② 批次五测试/验收**：FE **534/534（39 文件）**（基线 531 + 新 3：Protocol
  +3 —— PUT 携 version·响应新值续存、409 双动作无「重试」·强制覆盖带新值
  重发成功清横幅、加载最新替换本地不重发·后续编辑带新 version）、BE
  **240/240**（基线 230 + 新 10：`test_protocol_version` —— 建即 1·匹配 +1
  回读·陈旧 409 行未动·409 先于 refs 400·缺 version 直通仍 +1·链式 PUT·
  ensure 补列回填 1·幂等·新库 no-op·表缺 no-op）、build EXIT=0、校验器触
  `Protocol.jsx`/`Protocol.test.jsx`/两 api 文件 0 违规；ESLint
  `Protocol.jsx` 仍 1 error 2 warnings 无新增。**本批含 DDL**（protocols
  一列，启动自愈落真库）→ yorha.db 随本批入库。

### 8.8 Core Pipeline 批次一（主线闭环：绑定 → 封装 → 发送，1a–1d）

> **人工验证期反馈 1（并入本批）**：星标设默认增加点击确认环节（NieRModal 确认弹窗，
> 确认才 PUT 落库；取消默认为低风险逆操作单击直执行）——Orchestration D1 用例改钉
> 「设默认弹确认 / 取消不 PUT / 确认才 PUT / 取消星直执行」（Orchestration.test 17 例绿）。

> 设计依据 `docs/DESIGN_CorePipeline.md`（§2/§4/§7）+ `docs/DESIGN_Decisions.md`
> 12 条拍板（2026-09-24 全 A）。进度（2026-09-24）：1a–1d 全部实现，红测先行、
> 自动化验收全绿；**本批含 DDL**（`protocol_bindings` 三列 + 两个部分唯一索引，
> 启动自愈 `ensure_binding_columns` 创建）→ yorha.db 沿 `8f1b171` 先例
> **单独同步提交**。人工验证两轮通过（反馈 1/2 均并入，见上 blockquote 与 §8.9）
> → **已提交 ✅ `31bc367` / db `da91228`（2026-09-24）。**

- **1a 数据层（DDL）**：`models.py::ProtocolBinding` 仅新增 `slot_id`（显式
  目标槽）/ `is_default`（该指令默认封装协议）/ `priority`（多候选择序，预留）
  三列；`database.ensure_binding_columns` 启动自愈补列（镜像
  `ensure_protocol_version_column`，幂等、表缺 no-op）并**只在自愈路径**创建
  两个部分唯一索引 `ux_bindings_default(instruction_id) WHERE is_default=1`、
  `ux_bindings_slot(protocol_id, slot_id) WHERE slot_id IS NOT NULL`（测试
  setUp 必须调用同一函数）；`schemas/binding_api.py` 三字段 wire 出线
  （is_default bool / slot_id 可空 / priority int）、`routers/binding.py`
  三字段 CRUD + `GET /bindings?instruction_id=` 过滤 + 设默认同事务清旧默认
  （IntegrityError → 400）+ 绑定期关系校验（slot_id 存在且 type=slot、
  accepts 设备白名单命中；占位期无 slot_id 放行）。验收：`test_bindings.py`
  29 例全绿（本批 +17：三字段透传 / 设默认清旧 / 唯一索引冲突 400 / 存量
  行缺省回填 / 关系校验 / 过滤 / 补列自愈幂等）。
- **1b frame_builder（红测先行）**：`core/frame_builder.py`
  `build_wrapped(protocol_children, payloads, slot_ids=None, start_order=0)`
  → `{"hex", "total_length", "warnings"}`（克隆 p- 前缀 + orig→cloned 映射 →
  DFS 收槽（遇 slot 不下钻）→ 显式槽/稠密位次两趟分配（slot_id 优先、稠密
  cursor 跳过已占槽、溢出 extend 根末、欠载保留槽、空载荷 `""` 删槽）→
  splice 注入 `i-payload-*` → rewrite 后置 pass → toFrameBlocks 镜像转 Block
  （JS Number/`||` 口径 helper）→ Orchestrator.process → length/checksum refs
  真值重算）+ `schemas/block.py` `WrappedCompileRequest/Response` +
  `POST /compile/wrapped`（**同步 def**、404 "Protocol not found"、
  ValueError → 400）；语义错误 raise、溢出/欠载仅 warning 不阻断（fit_policy
  reject 批次二）。验收：`test_frame_builder.py` 21 例全绿（红测期复核定值
  两处期望：at_zero 文档序跳洞 `02 01 02 00` / 空载荷帧内零字节
  `AA 02 01 02 BB`）。
- **1c 发送接线**：后端 `routers/dispatch.py` `WrapSpec{protocol_id, slot_id?,
  slot_order?}` + `_apply_wrap`，`/dispatch` 与 `/dispatch/transaction`
  可选 `wrap`（**缺省裸帧行为逐字节不变**；hex 校验移到 wrap 之后；两端点
  409 文案相同）；前端 api 层 `compile.js`（compileWrapped）+ `dispatch.js`
  第三参 wrap + `bindings.js` instruction_id 过滤 + barrel，`blockMerge.js`
  导出 `normalizeInstructionBlocks`。接线：加工页 wrap 状态机
  （ok / none / failed / missing，非 ok 一律降级裸发 + 状态提示）+ 封装
  预览（300ms 防抖 `compileWrapped`，与发送同参同字节、warnings 回显）+
  「:: Wrap ::」开关**默认开**（DESIGN §7 1c 口径）→ TRANSMIT 与
  TransactionPanel 同带 wrap；编排页 toServer/toLocal 出线三字段 + 星标
  默认封装（删除按钮后，点星 PUT 后端清同指令旧默认、本地同步清星）+
  试发改线（组内逐指令 encode → `compileWrapped` → `dispatchPayload`，
  SENT 附 warnings）。验收：`test_wrap_api.py` 18 例全绿（compile 端点 /
  loopback 单发 wrap / 事务 wrap / 显式槽 / 稠密 slot_order / slot_id 优先 /
  404 / 400 / 裸帧不回归）。
- **1d 文档（本节）**：pageStatus.json processing/orchestration 条目 +
  `node scripts/generate-page-status.mjs` 重生成 `docs/PAGE_STATUS.md` +
  本节 + `PROJECT_HANDOVER.md` 待办/链路/目录地图 + `DESIGN_CorePipeline.md`
  §2/§4/§7 偏离与进度注记 + `DESIGN_Decisions.md` D1 实施注。
- **测试/验收**：BE **296/296**（基线 240 + 1a 17 + 1b 21 + 1c 18）、FE
  **542/542（40 文件）**（基线 534 + 新 8：blockMerge 共享向量 1 +
  Orchestration 星标 1 + InstructionProcessor 6）、`vite build` EXIT=0、
  yorha-ui 校验器触 4 个 UI 文件 0 违规。
- **共享向量**：主向量 `FA FA 02 01 02 ED` **三端同钉**
  （`backend/tests/test_frame_builder.py` + `test_wrap_api.py` +
  `frontend/src/utils/__tests__/blockMerge.test.js`，改一必改三）。

**偏离注记（2026-09-24 批次一实施确认，两处均相对设计稿）**：

1. **撤销「`(protocol_id, instruction_id)` 至多一行」基数约束**（`DESIGN_
   CorePipeline.md` §2 基数约定、`DESIGN_Decisions.md` D1 选项 A 同款措辞，
   两处已同步注记）：同一 (协议, 指令) **允许多行** —— 编排页「同协议多绑定
   按 slot_order 依洞填装」（一期 B1/B2）本就是一对多，加唯一约束直接打破
   既有语义。防重复职责收敛到两个部分唯一索引：每指令至多一个默认
   （`ux_bindings_default`）、协议内显式槽不重复（`ux_bindings_slot`）。
2. **`build_wrapped` 签名偏离（payloads-hex）**：设计稿 §4 草案
   `build_wrapped(protocol_tree, instruction_ids, bindings, *, now=None) ->
   WrapResult{hex, byte_count, warnings, errors}`，实施为
   `build_wrapped(protocol_children, payloads, slot_ids=None, start_order=0)
   -> {hex, total_length, warnings}` —— 指令编码留在前端（加工页/编排页既有
   `encodeInstruction` 链路），后端入参收**已编码内核 hex 载荷**；同因
   `/compile/wrapped` 请求为 `{protocol_id, payloads, slot_ids?,
   start_order?}` 而非「instruction_id + 参数」。取舍 = D4-A/D11-A 分批
   收敛：本批先收**封装唯一入口**（协议树查库 + 洞位分配 + length/checksum
   真值重算恒在后端，前端不复制任何封装逻辑），编译权威全量收敛（前端仅
   乐观预览）留后续批。

### 8.9 人工验证反馈 2（协议页确定值直填：checksum 严格口径）

- 背景：协议定义页卡片对「已确定的内容」仍显示等量 ?? 占位（人工验证反馈 2；用户定调
  「类似指令管理页面，确定的内容直接填充」+ 严格口径「全确定才填」，回翻一期
  「checksum 设计期无真值恒不注入」口径）。
- 实现：`protocolTree.injectRefsSigma` 新增严格可确定性（`hasSlotInSubtree` /
  `strictSigma` / `collectDeterministicBytes` / `collectRefsBytes`）—— checksum 卡
  refs 全为可确定内容（fixed 字面 hex、全子可确定容器、Σ 可解析 length；无槽、无悬空、
  无未配置字面）→ 按 `mapChecksumAlgo`（缺省 CRC_16_MODBUS，同编码器同源）算出设计期
  真值直填；任一不可确定 → 维持按字节等量 ??。length 带 root 时升级 strictSigma
  （嵌套容器裹槽同拒——旧 computeRefsSigma 只查直接槽，容器裹槽的 Σ 填充后会变）；
  `injectContainerContent(lanes, byId, root)` 容器中央值同步直填（不带 byId/root 的
  旧调用行为不变）；`Protocol.jsx` 调用点传入 byId/root。
- 测试：protocolTree.test +6（43 例绿：SUM_8 手算向量 `FF`、缺省 CRC 同源、slot/
  未配置字面/悬空/嵌套槽不注入、容器拼接 `EE FF`）；Protocol.test A4 改钉新口径
  （确定 checksum 卡 name 追加真值 `校验 <hex>`，悬空仍不出值）。
- 验收：FE 548/548（40 文件）EXIT=0、`vite build` EXIT=0、yorha-ui 校验器触变更
  文件 0 违规、后端 296/296 OK（本反馈纯前端，后端零改动回归）。

### 8.10 人工验证反馈 2 第 2 轮（四条：卡面 ?? / 指令草稿隔离 / 协议·编排手动保存）

- 背景：人工验证反馈 2 第 2 轮四条口径（2026-09-24 逐条确认后实施）：①未配置的
  固定块卡面显示 `??` 而非 `00`（含空容器 `0B → ??`，长度含 SLOT 估算**未选**）；
  ②指令加工页不应看到管理页未保存的新增 → 草稿隔离；③协议定义页去 350ms 防抖
  自动保存，改「保存更改」手动确认（切协议/离开弹放弃确认，撤销重做保持本地）；
  ④编排绑定属性编辑（标签/洞位）同样进草稿 + 保存按钮，星标/删除保持即时。
- 实现（红测先行，全部红 → 绿）：
  - **#1 卡面 ??**：根因 `constants.OP_CODES` 缺 `STRUCT` 键致协议块全判组卡；
    补键 + `Block.jsx` `hexLooksUnconfigured`（全 0 视为未配置 → 等量 `??`）+
    `formatUnknown(length)`，`protocolTree.nodeContent` 同口径；计算层
    `collectDeterministicBytes` 保留全 0（存储值 = 编码真值，勿动）。
  - **#2 指令草稿隔离**：`useInstructionData` 加 `draftInstruction` 单槽 +
    merged `instructions` overlay（dirty 时活动指令覆盖）；编辑/撤销/重做只写草稿，
    `saveChanges` 成功功能式写穿共享 + 清草稿，加载/增删/复制清草稿；
    `Instruction.jsx` `promptDeleteBlock` 归 `updateLocalInstruction` 漏斗。
    dirty⟺draft 不变式（4 处直设点全随草稿写入）。
  - **#3 协议手动保存**：`draftProtocol` 草稿 + 派生 `hasUnsavedChanges`
    （`currentProtocol` = 草稿优先，保存前共享态零写入）；`commitTree/undo/redo`
    只动草稿；防抖链（`scheduleProtocolSave`/`flushPendingSave`/`pendingSaveRef`/
    `saveTimerRef`）退役；`saveProtocol` 直受草稿（签名相等跳过、validateProtocol
    闸、409 冲突双动作、detail 透传全保留），成功 = 写穿 + 清草稿 + **清史**
    （新基线，镜像指令页 P4-1）+ 异步落定按 `activeProtocolIdRef` 防误伤切走场景；
    切协议/新建/复制/导入过 `guardDirty`「放弃未保存的更改？」（`confirmDialog` +
    NieRModal，镜像指令页 openConfirm）；横幅重试 = `saveChanges`；`beforeunload`
    改脏标拦截；SAVE 按钮落 `ProtocolPropertiesPanel`（协议级/块级双视图可达）+
    顶栏 UNSAVED。切选同 id 不弹（无切换）；删除后自动愈合清陈旧草稿与横幅。
  - **#4 编排手动保存**：`dirtyIds` 脏行集合（草稿按行驻留，切选中行不丢、无需
    切行确认）；`handleUpdateBinding`（label/协议/指令）与 `handleSlotOrderChange`
    （洞位组内重排，标脏变化行）不再 PUT，`handleSaveBindings` 逐行落库 ——
    `clearDirty` 比对已发载荷 vs 当前行，保存期间又编辑的行不误出队、行已删清
    脏 id；星标/增删保持即时（即时 PUT 成功同步出队同行）；`persistTimerRef`/
    `pendingRef` 防抖与卸载冲刷退役，改 `beforeunload` 脏标拦截；降级（loadFailed）
    模式不标脏；SAVE 按钮同落属性面板。
- 测试：Protocol.test 防抖钉全量改手动语义 + 新增手动保存核心/切协议确认/离开拦截
  用例（17 红 → 26 绿）；Orchestration.test label·洞位即时 PUT 钉改写 + 新增离开
  拦截（4 红 → 18 绿）；useInstructionData.test 草稿隔离 3 例（#2，含保存前共享态
  零写入断言）；Block.test +3、protocolTree.test +2（#1）。
- 验收：FE **559/559（40 文件）** EXIT=0（基线 556 + 新 3）、后端 **296/296** OK
  （本反馈纯前端，零后端改动回归）、`vite build` EXIT=0、yorha-ui 校验器触 5 个
  UI 文件 **0 违规**、`generate-page-status.mjs` EXIT=0（pageStatus 三段 11 处
  口径更新）。**零 DDL** → 无 db 提交。2026-09-29 人工验证通过，与 §8.11 合并
  一单提交 ✅ `ce20122`。

### 8.11 人工验证反馈 2 第 3 轮（六条：复制块撤除 / 卡面存储值 / 两页 SAVE 底置 / 编排分栏·交互）

- 背景：人工验证反馈 2 第 3 轮六条（2026-09-24 取证确认三问：复制块两页都移除、
  空容器中央空白、编排 UX 全套照做）：①两页属性面板「复制块 (DUPLICATE)」入口
  撤除；②卡面口径反转——`??` 仅限无法确定内容的卡，未配置固定块显存储值
  （`0000`→`00 00`、`00`→`00`）、空容器中央空白；③协议页 SAVE 移属性面板底部
  （协议级 + 块级两视图）；④编排 SAVE 同移底部；⑤编排分栏修复（中心区可收缩、
  右栏不被挤出视口）；⑥编排交互全套（侧栏脏行琥珀 ●、属性面板四分区 + 结构选择
  下移、底部常驻保存区带计数）。
- 实现（红测先行，6 文件 13 红 → 111 绿）：
  - **#1 复制块撤除**：Protocol/Instruction 两页 `onDuplicateBlock` prop +
    handler + `duplicateBlockInInstruction` util 及其单测 describe 一并删除；
    `duplicateNode` 纯函数 + 3 单测随后按用户拍板（2026-09-24「连删」）
    **一并移除** —— `cloneTreeWithNewIds` 保留（协议级复制 / JSON 导入共用），
    其 `remapRefs=false` 死分支随之清除（两调用方均恒 remap）；protocolTree.js
    注释同步。侧栏「副本」整条复制与 `buildDuplicate*Payload` 不动。
  - **#2 卡面存储值口径**：`Block.jsx` 撤 `hexLooksUnconfigured`（未配置固定/HEX
    块照显存储值）、空容器 `size===0` 返 `''`（页脚仍 `0B @00`）；
    `protocolTree.nodeContent` 撤全 0→?? 分支（存储值原样 pretty 拼接）。计算层
    `collectDeterministicBytes` 存储值 = 编码真值原则不变。
  - **#3/#4 SAVE 底置**：`ProtocolPropertiesPanel` 撤顶部 SAVE，aside 末尾 view
    条件后新增底部动作区（`pt-4 border-t mt-auto`，协议级/块级共用）；编排页见 #6③。
  - **#5 分栏**：编排中心 section 补 `min-w-0 overflow-hidden`（根因：CSS flex
    item `min-width:auto` 仅 overflow:visible 时取内容最小尺寸）；三页属性 aside
    补 `shrink-0`，协议/编排 aside 补 `overflow-y-auto`。
  - **#6 编排交互**：①侧栏脏行 label 前琥珀 `●`（`title="有未保存更改"`，干净行
    不显）；②属性面板四分区标注（绑定标识 IDENTITY / 结构选择 STRUCTURE / 洞位
    HOLE / 操作 ACTIONS），协议外壳 + 指令内核 select 从头部下移（面板内 DOM 序 =
    协议外壳 → 指令内核 → 洞位；头部只留 总长度 + EXPORT/试发，AUTO-ASSEMBLY RULE
    归洞位分区）；③底部常驻保存区：计数行 `● N 条未保存`（0 muted / >0 琥珀）+
    SAVE 常驻 `disabled={!hasUnsavedChanges || loadFailed}`。
- 测试：Protocol.test +2、Orchestration.test 4 改写 + 4 新增、Block.test 2 改写、
  BlockPropertiesPanel.test +1、protocolTree.test 1 改写 + 连删 duplicateNode 3 it、
  duplicateInstruction.test 删 import + describe（复制块 util 测试随功能移除）。
- 验收（连删后终态）：FE **557/557（40 文件）** EXIT=0（第 3 轮原 560，连删
  duplicateNode 3 单测 -3；第 3 轮当时为基线 559 + 净 1）、后端 **296/296** OK
  （纯前端回归）、`vite build` EXIT=0、yorha-ui
  校验器触 10 个文件 **0 违规**（清掉 BlockPropertiesPanel HEAD 既有
  `backdrop-blur-sm` + `pt-8`×2，本轮新增 `pt-8` 全改 `pt-4`）、
  `generate-page-status.mjs` EXIT=0、schema 与 HEAD 比对 **SCHEMA_IDENTICAL**
  （零 DDL）→ 无 db 提交。与 §8.10 第 2 轮合并，2026-09-29 人工验证通过后
  一单提交 ✅ `ce20122`（含 `duplicateNode` 纯函数 + 3 单测连删）。

### 8.12 人工验证反馈：指令加工页编辑四条（TIME 徽标 / 字节高亮 / 右栏分区 / 定长限制）

> 出处：2026-09-29 用户口述四条 + 三问确认（①「现在的编辑形式就行，我说的是
> 页面对此字段错误地显示为 READ_ONLY」；②定长「字符数 + 数值范围都限」；
> ③右栏「分区 + 释义 + 选中读数」）。**纯前端批次，零后端/编码改动。**

- 需求与实现：
  1. **TIME 字段误标 READ_ONLY**：`SmartInput` 增 `pickerMode` —— readOnly +
     pickerMode 走满亮实线 lane（`pickerClasses` 实线边框、无锁定斜纹、标签 /
     accent 条恢复满对比、cursor-pointer），徽标 `[TIME_PICKER]`（title 提示
     点选日期），input 仍 DOM 只读（值只由日期选择器按 base_time 换算写入）；
     `RunnerFieldTree` 按 `isTimeCumulative` 传入。
  2. **点击字段 → 字节流高亮**：新 util `utils/byteHighlight.js` 纯函数 5 个
     （`collectSubtreeIds` 叶/容器子树 id 集、`matchByteRanges` byteMap 过滤、
     `buildHexSegments` 按区间切段 + selected 打标（零长段丢弃、空 map 整串
     回落）、`formatByteRanges` 读数文案、`findFieldLabel` 字段名回查）。
     `InstructionRunner` 消费此前丢弃的 `byteMap`（+ `selectedFieldId` 态，
     换指令复位），BYTE_STREAM_OUTPUT 改逐字段 span 渲染，选中段反白
     （`bg-[#dad4bb] text-[#4a4a4a]`）+ title `字段名 @0xNN`；字段行 / 整块
     容器 onClick → 选中（amber 导轨 `border-[#E58D28]` 与 hover 轨互斥分支），
     读数条 `SEL :: 字段名 · 0xNN-0xNN · NB`（未选中显点击提示）。
     **人工验证期反馈修复（同批）**：嵌套组内点叶字段被冒泡升成整组（组容器
     onClick 在叶 onSelect 之后触发、组 id 覆盖叶 id，读数落外层组）→ 叶行
     wrapper 与组头 onClick 均 `stopPropagation`（选中即止）：叶精确到自身
     字节，内组头选中本组子树不被外层组覆盖（组头点击 = 整块高亮口径保留）。
  3. **右栏直观化**：`SectionTitle` 本地组件（en + 中文 + 用途释义）三分区 ——
     BYTE STREAM 字节流预览（实时重算 / 点击定位）/ PROTOCOL WRAP 协议封装
     （预览 · 发送 · 事务同参同字节）/ TRANSMIT 发送与导出（CTRL+ENT、.hex
     落盘）；TransactionPanel / TransmissionLog 自带 `::` 标题不重复，读数条归
     BYTE 分区。
  4. **定长输入限制**：`computeFieldInputLimits`（runnerRenderRules 纯函数）——
     只读/计算/时间/枚举/string/decimal/float/无 byte_len 不设限；hex 通道
     `maxLength = byteLen×2`；数值域 0..2^(8n)-1（`1n<<` BigInt 精确、超 2^53
     封顶 MAX_SAFE_INTEGER）、INT_SIGNED 两补码域、SCALED_DECIMAL 按
     factor/offset 反算输入域（factor=0 恒 0 不设域、factor<0 不等式反向、
     退化丢域）。`SmartInput` 接 `maxLength/min/max/byteLen` —— hex 字符截断 +
     数值即时钳制（本地缓冲与回调同步），徽标「n/N BYTES」（hex，n =
     ceil(已用字符/2)）/「[nB]」（非 hex 通道）；编码端 `InstructionEncoder`
     口径不变。
  - **人工验证期反馈（第二轮，同批）**：① BYTE_STREAM 同字段多字节段内连写
    （`00000000`）与整帧 `XX XX` 格式不一致 → `buildHexSegments` 段内逐字节
    空格分隔（回落段同步），高亮仍按整字段段反白；② 验收期测试首开日期选择器
    暴露 `NieRDatePicker` 既有 hooks 违规 —— `if (!isOpen) return null` 先于
    `useState`/`useEffect`，isOpen false→true 钩子数 0→2 跳变触发 React 内部
    错误（`Expected static flag was missing`）→ 早退后置 + 红测锁定
    （`NieRDatePicker.test.jsx`，首次开选择器的用例覆盖）；同触同清该文件
    4 处既有校验器违规（`backdrop-blur-[2px]` 改实底 `bg-nier-dark/80`、
    `p-6`→`p-3`、`px-8`→`px-5`、`shadow-md`/外层 `shadow-[...]` 移除）。
- 测试（红→绿，三轮）：首轮红 4 文件 **19 红**（13 收集 + `byteHighlight.test.js`
  6 因模块未建整体红；另 1「不误伤 [HEX]」守护用例按设计即绿）→ 绿 4 文件
  59/59；二轮（嵌套组误升整组反馈）红 **2**（fixture inst-4 两层嵌套：叶点选
  落外层组 / 内组头被外层覆盖）→ 绿 11/11；三轮（XX XX 格式 + picker hooks
  反馈）红 **4**（3 格式断言 + 1 React 内部错误锁定）→ 绿。新增 **23 测**：
  byteHighlight 6 / computeFieldInputLimits 6 / SmartInput 5 /
  InstructionProcessor 集成 5（inst-3 心跳指令 INPUT 1B + TIME 4B、inst-4
  嵌套指令 头组>内组>叶 + 根级叶）/ NieRDatePicker 1。
- 验收：FE **580/580（42 文件）** EXIT=0（基线 557 + 23）、后端 **296/296** OK
  （零后端改动回归）、`vite build` EXIT=0、yorha-ui 校验器触 9 文件 **0 违规**
  （含同触同清 `NieRDatePicker` 既有 4 处）、`generate-page-status.mjs` EXIT=0、
  schema 与 HEAD 比对 **SCHEMA_IDENTICAL**（28 对象，零 DDL）→ 无 db 提交。
- 状态：**2026-09-29 人工验证通过（四条 + 三轮反馈修复），一单提交 ✅
  `c4e3480`（排除 yorha.db，零 DDL）。**

### 8.13 位编辑 + 十进制录入（批 1-4：字段级 dec 通道 / 位图可视化 / 加工侧子位 / 协议位域块）

> 诉求：项目指令/协议码定义与配置全程面向 HEX，但（a）时常需要位级编辑的指令
> 定义；（b）指令加工时常需录入十进制（最终指令码仍是十六进制）。经四问确认
> 拆四批：①字段级 dec 配置 ②指令侧位图可视化 ③加工侧子位录入 ④协议结构化
> 位域（重方案，涉后端）。

- **批 1（纯 FE）字段级十进制录入**：定义侧 `BlockPropertiesPanel` 参数区顶部
  固定行「录入进制 (INPUT BASE) HEX | DEC」→ 存 `parameter_config.input_base`
  （缺省 `hex`，`isDecimalEntry` 大小写不敏感、非法值回退 hex）；加工页
  `resolveFieldDisplay` 分支 4 按此切十进制通道（十进制原值不补零、
  `computeFieldInputLimits` 数值域照用但**不回吐** hex `maxLength`、
  `[nB]` 徽标）；HEX_RAW/BITFIELD 打包值不渲染该行。**不变量：值存储恒数值 →
  `InstructionEncoder`/后端零改动**（十进制只是 UI 解析/回显层皮肤）。
- **批 2（纯 FE）位域布局可视化**：新纯函数层 `utils/bitGrid.js`
  （`buildBitGrid`/`rangeToSegment`/`defaultSegmentName`/`packBits`）——
  位网格 byte×8、**bit0 在右 = LSB 存储口径**、段按序稳定配色、位号→多占用
  标 `conflictBits`、`byteCount = max(byte_len, 所需字节)`（溢出位段照常渲染，
  免得看不见）；`BitFieldEditor` 加位图主视图：空闲格点两下即生成位段
  （方向无关、同格 = 1 位）、点色块 = 选中该段并与表格行双向联动，表格保留
  精确数值编辑；打包预览改走 `packBits`（与 `packBitfieldDefault` 镜像
  测试「改一必改二」）。
- **批 3（纯 FE）加工侧 BITFIELD 按子位录入（两者并存）**：新
  `BitSegmentInputs.jsx` —— 整包 hex/dec 输入保留，其下按 `bits[]` 展开子位行
  （位名 + 十进制输入 + `[b3..b0]` 注记 + `data-bit-max` 上限）。**单一真源 =
  `inputs[field.id]`**：子位行是派生视图（`unpackBits`），改子位经
  `writeBitSegment` **只重写本段位**（间隙位/无主位与其它段原样保留）后回写
  单整数；无输入态逐段回显 `default_val`；拆包/回写走「除模·乘幂」算术而非
  JS 32 位位运算（>32 位段不被截断，有专测）。**encoder 分支零改动**。
- **批 4（FE + BE）协议结构化位域块**（用户选定的重方案）：新块型
  `bitfield`（`blockTypes.js` SSOT 扩展：palette 卡 + `fields: [length, bits]`，
  `createBlock` 预置 `bits: []`）；属性面板按 `inputType='bits'` 专用分支复用
  `BitFieldEditor`（同 refs 分流约定）；`toFrameBlocks` 出口把位段搬进
  `config.params.bits`（脏位段剔除，镜像后端过滤）；`Block.jsx` 卡面显示
  **打包后的真实字节**（`packBits`）而非 `hex_value`；协议 JSON 导入白名单
  补 `sanitizeBits`（不丢位段、不给存量块凭空注入空数组）。
  后端：`ProtocolNodeSchema.bits`（复用指令侧 `BitFieldSchema`；**不补则 pydantic
  静默丢弃、刷新即失**）→ `routers.protocol._validate_bits` 落库前拦
  **位域重叠/超容量 400**（镜像 `instruction._validate_bitfields`）→
  `frame_builder._build_bitfield_config` 只透传、**打包收敛到 `Orchestrator`
  发射期单点**（新 `handlers/bitfield.py`，`pack_protocol_bits`；封装
  `/compile/wrapped` 与导出 `/export/binary` 两路共用同一实现）→
  `BlockType.BITFIELD` 补枚举。语义：**静态默认值打包、发送期不可改值**；
  不含解码回程（后端 encode-only，无 bytes→fields 解析器，范围外另立批）。
- **测试（红→绿，四轮）**：批 1 红 **10** → 绿；批 2 红 **9**（`bitGrid` 模块
  缺失 + 位图交互）→ 绿；批 3 红 **5**（组件缺失 + 页面 4 例）+ 1 处
  「跨 32 位段」真实缺陷（我实现的 `unpackBits` 起点 32 场景断言错→修正
  测试向量为 5 字节字段 `0x2200000011`）→ 绿；批 4 后端红 **15**（模块缺失）
  + 前端红 **10**（blockTypes/toFrameBlocks/validateProtocol 断言）→ 绿。
  新增 **68 测**：前端 52（bitGrid 16 / BitFieldEditor 8 / BitSegmentInputs 6 /
  blockTypes 6 / toFrameBlocks 4 / validateProtocol 5 / protocolTree 3 /
  runnerRenderRules 4 / BlockPropertiesPanel 4 / SmartInput 3 / InstructionProcessor
  集成 4）+ 后端 19（`test_protocol_bitfield.py`：schema 3 / 入库校验 6 /
  编码 6 / 端到端 4）。
- **验收**：FE **648/648（46 文件）** EXIT=0（基线 580 + 68）、后端 **315/315**
  OK（基线 296 + 19）、`vite build` EXIT=0、yorha-ui 校验器触 8 文件
  **0 违规**、`generate-page-status.mjs` EXIT=0、schema 与 HEAD 比对
  **SCHEMA_IDENTICAL**（28 对象 —— 位段存 children JSON 列，**零 DDL**，
  `yorha.db` 按规不提交）。**回归硬指标**：存量 wrap 共享向量
  （`FA FA 02 01 02 ED`）与无 wrap 裸发路径逐字节不变（`test_wrap_api` 既有
  用例 + 新增裸发断言）。
- 状态：**✅ 真机验证通过（2026-09-30 浏览器逐条全绿零 bug，用户授权 agent
  验证）→ 按四单提交：批1 `23ad28e` / 批2 `327ac8c` / 批3 `f8dcf64` /
  批4 `e6a31a4`。**

### 8.14 调研后优化（优化批：BIN 三态进制 + 前缀识别 / 位段值表 / 有符号位段 / 位号标尺）

> 前置：§8.13 四批实施后按用户指令调研市面口径（DBC/CANdb++ 信号与值表、
> Wireshark/010 进制惯例、LSb0/MSb0 位号标注、CRC 五元组与串口组帧目录），
> 差距表经用户拍板取 1-4 四项一起做（CRC CCITT/CRC32/LRC、长度域 BE/LE、
> varint/COBS、解码回程暂缓另立批）。**不推翻四批设计**（LSb0 位图/单一真源/
> 单点打包与行业吻合）。
>
> **补记（2026-10-03 · §8.49）**：四项暂缓里的「**解码回程 bytes→fields**」已由
> **R9 + R10** 落地（§8.47 展示 / §8.48 入库），本行只剩三项 —— CRC 多算法与长度域
> BE/LE 按 §8.36 **C-5 = ①② 触发式**（真机提出即插队），varint/COBS = **③ 不做**。
>
> **补记（2026-10-03 · §8.52 复议）**：这三项**已全数立项** —— 长度域 BE/LE → **R21**、
> CRC 多算法 → **R22**、varint/COBS 拆 **R27 出线 / R28 解包**；「触发式 / 暂缓」到此清零。
>
> **销项注（2026-10-03 · §8.53）**：**R21 已完成 ✅**（长度域 `byte_order` 双端落地，
> BE 753 → 768、FE 1106 → 1117）；**R22 已完成 ✅**（2026-10-03 · §8.54：CRC16-CCITT /
> CRC32 / LRC 三算法，共享向量 `vectors/checksum_algo.json` 30 行双端同读，
> BE 768 → 793、FE 1117 → 1127）；**R27 出线已完成 ✅**（2026-10-04 · §8.59：varint / COBS
> 出线双端落地，共享向量 `vectors/framing.json` 3 表 35 行，BE 878 → 917、FE 1213 → 1247）；
> **R28 解包已完成 ✅**（2026-10-04 · §8.60：`stages` 逆向解包 + 应答匹配双端落地，
> **反向消费 `vectors/framing.json` 不新增向量文件**，BE 917 → 955、FE 1247 → 1251）。
> 三项至此**全部销项**。

- **优化 1（纯 FE）三态进制 + 进制前缀识别**：`BlockPropertiesPanel` 录入进制
  HEX|DEC → **+BIN** 三态（`input_base='bin'`，非法值仍回退 hex）；
  `resolveFieldDisplay` 新增 binary 通道（位模式定宽回显、placeholder 按位宽），
  `computeFieldInputLimits` bin 给 `maxLength = byteLen×8`、**无数值域**（位模式
  语义，数值域交给 dec 通道），`SmartInput` 新增 `type='binary'`（[01] 过滤 →
  按位宽截断 → 二进制解析发**数值**、徽标 `n/N BITS`、无定长 `[BINARY]`）。
  前缀容忍：hex 通道剥 `0x/0X` 归一纯 hex（`'0x'` 进行中保留缓冲不发半截值、
  定长截断不被前缀挤占）；dec 通道 `Number()` 原生吃 `0x/0b`（红测锁定）；
  bin 通道支持 `0b` 输入糖。**不变量：三通道值存储恒数值 → encoder/后端零改动**。
- **优化 2（FE + BE schema 透传）位段值表（DBC VAL_ 对齐）**：新共享纯函数层
  `utils/bitMeta.js`（`sanitizeValueTable`/`parseValueTable`/`formatValueTable`，
  编辑格式 `0=关,1:开`，`:` 与中文逗号兼容，脏值清洗：非数组丢弃、非对象/NaN
  value 项过滤）；`BitFieldEditor` 表格加「值表 (VAL_TABLE)」列，位图格 title、
  默认值 title 回显名称解码（`MODE = 1 (开) · bit0`）；`BitSegmentInputs` 值表
  位段渲染下拉（label+值 双显，当前值不在表内追加原值选项不留空），选择回传
  打包整数只动本段；协议侧 `BitFieldSchema.value_table`
  （`Optional[List[{value,label}]]`）Pydantic 透传走 children JSON **零 DDL**，
  `protocolTree.sanitizeBits` 导入白名单保留并清洗（无 meta 不注入键）。
- **优化 3（FE + BE schema 透传）有符号位段（DBC signed 对齐）**：
  `normalizeBits` 携带 `signed`（非 true 一律 false）；`unpackBits` 两补码解读
  （0xD8→-40、4 位 0x0C→-4，default 超有符号域按位模式解读 216→-40），
  `clampBitValue(v, len, signed)` 两补码域 `[-2^(n-1), 2^(n-1)-1]`、
  `writeBitSegment` 负值先钳域再转位模式（邻段/间隙位保留）；
  `BitFieldEditor` 行内 U/S 开关 + signed 行默认值放开负域（min/max 两补码域），
  `BitSegmentInputs` signed 行负值回显与钳制。**打包口径零改动**：FE
  `raw & mask`、BE `pack_protocol_bits` 均天然两补码（负 default 向量
  `-40 → D8` 双端锁定），signed 只影响拆包/钳制/UI。
- **优化 4（纯 FE）位号标尺**：`BitFieldEditor` 网格顶部 `7..0` 列头
  （LSb0 口径、先于字节行渲染，绝对位号 = 行号×8 + 列位号，免得自己数位）。
- **零 DDL 存储（优化 2/3 的指令侧）**：bit_fields 表无 JSON 列 → 元数据骑
  `parameter_config.bit_meta = { [bitId]: {signed?, value_table?} }`。
  **拆分点** `normalizeFieldPayload`（保存 `saveChanges` 与导入 `analyzeImport`
  共用，按 bits **重建**覆盖陈旧 meta、无 meta 删键 → 存量负载逐字段不变）；
  **合并点** `useInstructionData.instructions` memo 读时按 bit id 幂等合并
  —— **位段自身键优先**（bits 是编辑真源，陈旧 pc.meta 不得覆盖用户改动）。
  协议侧 bits 在 children JSON，直接挂在位段键上（上优化 2/3 的 Pydantic 透传）。
- **测试（红→绿一轮）**：红测 FE **22** 失败 + bitGrid 套件因 `bitMeta.js`
  缺失整体红、BE **3** 失败（负 default 打包为绿锁）。转绿过程修正三处红测
  自身问题：SmartInput 切片语义 `slice(0, n)`（我误写 `slice(n)`）、两个受控
  组件测试改 harness（React 受控回灌使同值 change 不触发 onChange）、合并方向
  改「位段自身键优先」（原 meta 优先会覆盖编辑）。新增 **39 测**：前端 **35**
  （normalizeInstruction 8 / bitGrid 7 / SmartInput 5 / BitFieldEditor 5 /
  runnerRenderRules 4 / BitSegmentInputs 3 / useInstructionData 2 /
  protocolTree 1）+ 后端 4（`test_protocol_bitfield.py` 元数据 3 + E2E 往返 1）。
  另改批 1 两处既有断言：`input_base='bin'` 从「非法回退 hex」升为真实通道
  （示例值改 `oct`，非法回退语义不变）。
- **验收**：FE **683/683（47 文件）** EXIT=0（基线 648 + 35）、后端 **319/319**
  OK（基线 315 + 4）、`vite build` EXIT=0、yorha-ui 校验器触 4 文件 **0 违规**、
  `generate-page-status.mjs` EXIT=0、schema **SCHEMA_IDENTICAL**（28 对象，
  零 DDL）→ 无 db 提交。存量 wrap 向量（`FA FA 02 01 02 ED`）与裸发路径
  byte-equal 不变。
- 状态：**✅ 真机验证通过（2026-09-30，优化 1-4 逐条全绿）→ 第 5 单已提交
  `3668d37`（与批 1-4 分开）。**

### 8.15 验证反馈：校验标色（属性面板提醒 → 画布卡片颜色）

> 起因：用户在批 1-4/优化批人工验证中提出——属性配置右侧已有 ⛔/⚠ 提醒清单，
> 但画布上对应的卡没有任何颜色，无法一眼定位问题块。经两问确认：视觉强度 =
> **边框变色 + 角标**（错误红 / 提醒琥珀，与面板同色系），范围 = **协议定义页 +
> 指令定义页**（共享 Canvas/Block，两页各传一次；蓝图/编排页不传、零变化）。

- **纯函数** `utils/issueBadges.js`：`buildIssueMap({errors, warnings})` →
  `Map<blockId, {level, messages}>`——errors/warnings 均带 blockId（两校验器
  全量核实）；同卡**错误优先**（level 只升不降）、messages 全量聚合（角标
  title 悬停直读，与面板清单同文）；无 blockId 条目跳过（页面级问题无卡可标）；
  null/空清单 → 空 Map。
- **透传链**：页面 `validation`/`validationIssues` memo（随编辑实时重算）→
  `Canvas` 新可选 prop `validationIssues` → 内部 `useMemo(buildIssueMap)` →
  渲染处 `issue={issueMap.get(item.id) || null}`；DragOverlay 拖拽镜像不带
  （拖拽态已有专属视觉）。
- **卡片视觉（Block 新 prop `issue`）**：非选中态内联 `borderColor`
  （错误 `#D94834` / 提醒 `#E58D28`，内联优先于主题类——避开 Tailwind 同属性
  类序不确定）；header 右侧出 ⛔/⚠ 角标芯片（`data-issue-chip`，title = 消息
  聚合，`bg` 纯色 + 黑字，无圆角）；**选中态让位**：保 3px 亮边（内联色不注入），
  角标不丢；拾取态同让位。角标计入内容宽度地板（+26px，与标签/页脚同口径）。
- **测试（红→绿）**：红测 3 文件——`issueBadges.test.js`（6 测：分级映射/
  错误优先升级/消息聚合/无 blockId 跳过/空输入）、`Block.test.jsx` +4（红边+角标、
  琥珀+⚠、选中让位保角标、无 issue 零痕迹）、`Canvas.test.jsx`（3 测：按
  blockId 映射到对应卡、不传零变化、prop 驱动实时点亮）。转绿 **+13 测**。
- **顺带（用户拍板「收紧过闸」）**：本批触碰 `Canvas.jsx` 触发校验器抓到既有债
  2 条（`NO_SOFT_SAAS_PADDING`：嵌套泳道 `pl-8`、画布留白 `p-10`，非本批引入），
  按方案收紧 `pl-8 → pl-3`、`p-10 → p-3`——嵌套组缩进与画布留白变紧，触达
  文件恢复 0 违规；布局变化随本批一并人工验证。
- **验收**：FE **696/696（49 文件）** EXIT=0（基线 683 + 13）、后端 **319/319**
  OK（本批纯 FE，零后端改动）、`vite build` EXIT=0、yorha-ui 校验器触 4 文件
  0 违规、`generate-page-status.mjs` EXIT=0、schema **SCHEMA_IDENTICAL**
  （28 对象，零 DDL）→ 无 db 提交。
- 状态：**✅ 真机验证通过（2026-09-30，红/琥珀/让位/pl-3 逐条全绿）→ 第 6 单
  已提交 `3ff0f69`（独立于批 1-4 与优化批）。**

### 8.16 业务场景全集排期（G1–G7 新缺口 → N1–N5 批次 + G5 白名单插队批）

> 起因：用户指出逐点发现（提一个查一个）不可持续，要求按「指令编制」业务
> 全集一次盘满。盘查结论落档 **`docs/BUSINESS_SCENARIOS.md`**（四层能力矩阵 +
> 缺口 G1–G7 + 挂账清单），本节是其排期执行面。已立暂缓项（CRC 多算法 /
> 长度域 BE/LE / varint·COBS / 解码回程，§8.14）与已知范围外（float64，E1-4
> 口径 —— **后由 §8.42 R5 收口，已不是范围外**）不重复排。
>
> **提交序与并行边界**：
> - 先按 §8.13–8.15 完成六单（批 1-4 四单 + 优化批 + 标色批）人工验证与提交；
> - **N1 与六单零文件重叠**（`operator.py` / `validateInstruction.js` 均未被六单
>   触碰）→ N1 可与六单人工验证**并行开发**，不破坏 hunk 分离；
> - N2 基本零重叠（设计上避开 SmartInput 即可）；**N3 与六单共享
>   `normalizeInstruction.js` / `BlockPropertiesPanel.jsx` → 必须等六单提交后开工**；
> - 本节文档 + BUSINESS_SCENARIOS.md 随 **N1 一并作为第 7 单提交**（不混入六单）。

**N1 护栏批（G5/G6/G7——小批，先行）**
- 范围 a（G7 摘陷阱）：`validateInstruction` 新增 W `FLOAT64_UNSUPPORTED`——
  `op=FLOAT_IEEE && byte_len===8` → 提醒「float64 编码未支持（E1-4 范围外），
  当前 FE 按整数路径输出、BE 保持 zeros（两端不一致）——请改 32 位或 HEX_RAW」。
  模板 `bits:[32,64]` **不动**（`Instruction.jsx:243-251` 只取首元素作默认，
  32 本就是默认；真正陷阱入口是手改 byte_len，校验才是正解）。
  **后记（2026-10-02 · R5，§8.42）**：float64 双端编码已落地 → 该提醒**收窄**成
  `FLOAT_IEEE_WIDTH_UNSUPPORTED`（只报 4/8 以外的位宽），`byte_len=8` 不再报；
  模板 `bits:[32,64]` 仍不动（默认 32 口径不变）。
- 范围 b（G5 护栏）：`validateInstruction` 新增 W `OP_UNKNOWN`——`op_code` 不在
  已知全集（`OP_CODES` 14 项 ∪ encoder legacy `INPUT/FIXED/HEADER/TAIL/CALCULATED`）
  → 提醒「未知算子，编码将落默认整数路径静默出错」。BE 保存侧白名单**挂账**
  （须先摸存量 op 全集，避免锁死历史数据）。**后记（2026-10-01）**：摸底完成 +
  策略拍板「双端硬拦」→ 本条 W5 已升级为 E（`OP_UNKNOWN` 入 errors），BE
  `routers/instruction.py` 白名单已落，见下「G5 双端硬拦插队批」（第 12 单 `b715e2b`）。
- 范围 c（G6 定性）：`STRUCT` 正式定为**存量兼容口径、不补创建模板**
  （`ARRAY_GROUP + repeat=NONE` 已覆盖纯结构组语义，补模板=制造真重复）；
  本条为文档定性零代码，若后续业务确认需要独立入口再改一行 SEED。
- 红测先行：FE `validateInstruction.test.js`（+FLOAT64 W / +OP_UNKNOWN W /
  已知 op 不误报）；BE 新增 `backend/tests/test_operator_templates.py`
  断言 `SEED_TEMPLATES` 结构与 FLOAT bits 默认口径（锁 SEED 不回摆）。
- 验收：§0 统一口径（FE/BE 全量 EXIT=0、`vite build`、校验器 0 违规、
  pageStatus 生成、schema 零 DDL、既有编码向量 byte-equal 不变）。
- 状态：**红→绿完成（FE 700/700 · BE 322/322，2026-09-30）→ 真机验证通过
  （FLOAT64/OP_UNKNOWN 提醒逐条全绿）→ 已随 3 文档一并作为第 7 单提交
  `7d50484`。**

**N2 字符串批（G2——入口 + 定长 + 字符集三件套）**
- a 入口：SEED_TEMPLATES 新增 `STRING`（BASE 分类，`param_template:
  {"value": "string", "encoding": ["ascii","utf8"], "pad_char": "00"}`——value
  走 keyword 文本输入、encoding 走数组下拉、pad_char 推断为 string 文本）+
  调色板自动出按钮；`OP_CODES`/`OP_PRIORITY` 加 STRING（`KNOWN_OPS` 经
  `Object.values(OP_CODES)` 自动跟随）；`Instruction.jsx` 创建特判：`byte_len=8`、
  `pc.type='string'`（keyword 会被创建逻辑吞掉必须特判，显示/编码链都认它）、
  `pc.encoding` 数组规范化为标量 `'ascii'`（A1 数组污染先例）。
- b 定长口径：编码期按 `byte_len` **定长 pad/截断**——`raw byte_len > 0` 才施加
  定长（链尾 `||1` 归一不适用本分支；缺失 = 契约外，FE 变长原样 / BE 不进分支
  各自现状锚，W1 BYTE_LEN_MISSING 已提醒）；pad 字节 = `parseInt(pad_char, 16)`，
  非法/缺省回退 `0x00`；存量 `params.type='string'` 行为变化（变长 → 定长）红测
  锁定。
- c 字符集：`ascii` 模式按 **code point** 迭代 `& 0xFF`（与 Python `ord()`
  byte-equal，代理对单字节口径；>0xFF 脏字节由校验 W 提醒改 utf8）；`utf8`
  模式 `TextEncoder` ↔ `bytes(s, 'utf-8')`。
- d 双端镜像：BE `orchestrator.encode_string`（E1 函数群同区）+
  `datahub.to_block` elif 分支（`op=STRING` 或规范 `type=string`，`byte_len>0`），
  与 FE `getFieldBytes` string 分支 byte-equal（双向量表锚定：ascii pad/截断、
  utf8、代理对、pad_char=20）；runner 显示走既有 `pc.type='string'` 通道零改动。
- 卡面：`Block.jsx` `displayValue` 新增 STRING/`type=string` 文本分支（显示
  `pc.value ?? pc.default`，空值显空白），替代落 `??` 占位。
- **文件面（修正）**：与六单共享 `Instruction.jsx`/`Block.jsx`/`orchestrator.py`
  （各自不同函数区域，提交时按 hunk 分离）、与 N1 共享 `validateInstruction.js`
  （N1 的 KNOWN_OPS/W4/W5 hunk 随第 7 单、N2 的 STRING W hunk 随第 8 单）；
  `ParamConfigForm`/`runnerRenderRules`/`SmartInput` 零触碰。
- 校验：W `STRING_NON_ASCII`（静态值含 >0xFF 且 encoding≠utf8）。
- **红测（先行）**：FE `InstructionEncoder.test.js` +17（13 向量 + op 缺 pc.type
  + byte_len 缺失变长 + INPUT 存量定长 + getInitialValues 初始值 + LENGTH_CALC
  定长尺寸；E1-4 矛盾 type=string 断言按定长口径更新为 '312E3500'——行为变化
  锁定）、`validateInstruction.test.js` +5（W6 提醒 / utf8 不报 / ≤0xFF 不报 /
  INPUT default 同口径 / STRING 不误报 OP_UNKNOWN）、`Instruction.test.jsx` +1
  （创建特判四键）、`Block.test.jsx` +4（卡面原文 / default 原文 / 无值 ?? 锁 /
  空串空白）；BE `test_encode_string.py` 新 13（13 行向量与 FE 逐行同步 + 函数级
  pad/变长 + to_block 6 集成）、`test_operator_templates.py` +1（SEED 在席）。
  初红 FE 25 + BE 2（导入错/缺模板），零误伤旧测。
- **实现落点**：FE `constants.js`（OP_CODES/OP_PRIORITY 加 STRING）、
  `InstructionEncoder.js`（string 分支定长重写 + getInitialValues STRING 初始
  值 = pc.value + fieldSizes 定长化——LENGTH_CALC 引用不再按字符数少算）、
  `validateInstruction.js`（W6）、`Instruction.jsx`（创建特判 byte_len=8 /
  pc.type / encoding 归一）、`Block.jsx`（displayValue 文本分支，带 hex 者回落
  现状）；BE `orchestrator.encode_string`（孤立代理项手工替 U+FFFD——注意
  Python `errors='replace'` **编码**侧产出的是 `?` 非 FFFD）、`datahub.to_block`
  elif 分支（`STRING ∪ (INPUT ∧ type=string)`，`byte_len>0` 闸；数值 op 矛盾
  配置不进支、E1 zeros 契约不变）、`operator.py` SEED。
- **验收（2026-09-30）**：FE **728/728（49 文件）** EXIT=0（基线 700 + 28）、
  BE **332/332** OK EXIT=0（基线 322 + 10）、`vite build` EXIT=0、yorha-ui
  校验器触 4 文件 0 违规、`generate-page-status.mjs` EXIT=0（指令页 availableNow
  +N2 条目）、schema **SCHEMA_IDENTICAL**（28 对象零 DDL）。
- 状态：**✅ 真机验证通过（2026-09-30，STRING 全链含 `STRING_NON_ASCII` chip
  逐条全绿）→ 第 8 单已提交 `848e248`**（`validateInstruction.js`
  按 hunk 与 N1 分离：N1 的 KNOWN_OPS/W4/W5 随第 7 单、N2 的 W6 随第 8 单；
  `Instruction.jsx`/`Block.jsx`/`orchestrator.py` 与六单同文件分 hunk）。

**N3 分支族批（G1——方案 B：组级 presence，本排期重头）**
- 前置：**六单提交完成**（共享文件 hunk 分离）+ N1/N2 落地。
- 模型（零 DDL）：字段/组 `parameter_config.presence = { ref_id, expect }`——
  编码期 `ref` 实值 `== expect` 才发射本字段/组，否则跳过（两支并列建模：
  `cmd=A` 组与 `cmd=B` 组同时在指令里，按值只发命中支）。复用三先例：
  DYNAMIC repeat 的值驱动链路、bit_meta 的 `parameter_config` JSON 骑乘、
  refs 拾取的面板交互。
- 编码：`InstructionEncoder.resolveDependencies` PASS 前置扫 presence →
  未命中字段归零长（尺寸口径对齐 slot=0 先例）；BE `datahub.to_block` 同款
  过滤（byte-equal）。
- 显示：lanes/画布两组都渲染 + 条件角标（`presence` chip）；byteOffsets 动态
  尺寸复用 DYNAMIC repeat 的「未知落 ??」口径。
- 校验：W `PRESENCE_REF_MISSING`（ref 指向不存在字段）、W `PRESENCE_OVERLAP`
  （同 ref 同 expect 的多支并存提醒）、E `PRESENCE_SELF`（自引用）。
- 测试点：红测先行（编码命中/未命中字节、双端镜像、ref 解析、显示标注）；
  覆盖「可选字段」「TLV count+分支」「按值路由设计期表达」三个验收场景。
- 范围外（本批不做）：运行期按值自动选指令（多指令路由）、条件表达式
  （公式引擎 `?:`）、union 同字节重解释。
- **细化设计（2026-09-30 落档，开工时按此执行）**：
  1. **判定链（编码期）**：取值复用 `_repeatCount` DYNAMIC 同链
     `computed[ref_id] ?? inputs[ref_id] ?? pc.value`，抽公共 helper；
     比较口径 = `String(refVal) === String(expect)` 归一（数值 1 命中 `'1'`）；
     **fail-open**：`presence` 配置不完整（缺 ref_id / 缺 expect / 非对象）
     → 视为命中（半成品配置不吞字节，防数据丢失优于严格过滤）。
  2. **层级与顺序**：presence 判定 **先于** repeat 展开（组未命中连 repeat
     都不展开）；组未命中 → 整棵子树 0 字节；命中组内子字段**各自独立**判
     presence（嵌套递归，父命中不豁免子）；字段级与组级同权，未命中 = 尺寸 0
     （slot=0 先例）。BE 同序（`to_block` 开头判定，未命中返回
     `byte_length=0 + children=[]`，子树不进 flatten）。
  3. **设计期显示**：两支卡片**都渲染**（可编辑），按静态值链
     （pc.value，同 DYNAMIC repeat 静态 resolve 先例）预判尺寸：未命中 →
     0B/空容器口径；ref 是运行输入静态判不了 → 尺寸落 `??`（「未知落 ??」
     先例）；header 加 `IF` 条件 chip（title：`条件字段：[ref] == expect`，
     Block 自读 pc.presence 零 prop 传递）。
  4. **面板**：BlockPropertiesPanel 尾部独立区「条件存在 (PRESENCE)」——
     ref 拾取（复用 refs pickingMode 交互）+ expect 文本输入 + 清除。
  5. **校验**：E `PRESENCE_SELF`、W `PRESENCE_REF_MISSING`（悬空）、
     W `PRESENCE_INCOMPLETE`（fail-open 配置提醒核对）、W `PRESENCE_OVERLAP`
     （同 ref 同 expect 多支）——`validateInstruction.js` 第 4 层 hunk（第 9 单）。
  6. **文件面**：FE `InstructionEncoder.js`（前置扫 + fieldSizes 0）、
     `validateInstruction.js`（4 码）、`normalizeInstruction.js`（presence 清洗）、
     `BlockPropertiesPanel.jsx`（面板区）、`Block.jsx`（IF chip，与六单 issue
     chip 同 header 区 hunk 分离）、`byteOffsets.js`/`useInstructionLanes.js`
     （静态尺寸口径，两文件当前干净）；BE `datahub.py`（to_block 判定，
     与 N2 STRING elif 分 hunk）、`orchestrator.py` 尽量零触碰。
     **测试文件全为 N3 新增层**：encoder/validate/normalize/BlockProperties
     Panel/Block 测试 + BE `test_encode_presence.py`。
  7. **红测矩阵**：编码命中/未命中、组子树跳过、嵌套独立、expect 数值
     字符串归一、fail-open、presence+repeat 先后序、未命中字段被 checksum
     refs 引用（0 字节进校验）、BE byte-equal 静态向量、校验 4 码、IF chip、
     面板配置往返；三验收场景（可选字段 / TLV count+分支 / 按值路由）。
- **验收（2026-09-30）**：红→绿 1 轮（7 个新增测试层文件 = FE 6 + BE 1，
  初红 FE 48 例 / BE 10 用例，零误伤旧测）；全量 FE **812/812（55 文件）**
  EXIT=0（基线 728 + 84）、BE **342/342** OK EXIT=0（基线 332 + 10）、
  `vite build` EXIT=0、yorha-ui 校验器触 13 文件 0 违规、
  `generate-page-status.mjs` EXIT=0、schema **SCHEMA_IDENTICAL**（28 对象，
  presence 纯 JSON 骑乘零 DDL 实证）。
- 状态：**✅ 真机验证通过（2026-09-30）→ 第 9 单已提交 `8e9612f`**。
  真机结论：面板 PRESENCE 区渲染 / 拾取单 ref 归一 / expect 联动 / APPLY → IF
  角标（title 判定式）/ CLEAR 摘键复原 / 保存 JSON 落库 + **整页刷新重开往返
  一致**；静态三态实测 —— 命中 `1B`（`~10B VAR`）、未命中 `0B`（`~9B VAR`，
  门完整 → VAR 且字节数可算）、ref 无静态值 → `??B` + 下游偏移 `··` + LEN
  低界 `27B+`（unknown 态）；fail-open 半成品 → 角标 `[?] == expect` + ⚠
  PRESENCE_INCOMPLETE 提醒且不吞字节。**数据面提醒**：存量 34 字段**零
  `pc.value`**（HEX_RAW 只写 `pc.hex`，STRING 的 value 输入是唯一 UI 入口）
  → 存量数据 presence 静态链恒落 unknown（??/VAR/低界+）；要静态 0B 门需
  ref 字段带 `pc.value`（运行期 inputs 仍可翻转，fail-open → 命中）。

**N4 帧字节转义批（G3——✅ 已落地，层位已拍板）**
- 现状（改造前）：`orchestrator.py` `ESCAPING LOGIC (Placeholder)` 空占位；编码链无转义点。
- **层位定案（2026-09-30 拍板：传输层 · 内核转义后套壳）**：出线前按转义表转义
  **内核 payload**，再交 `build_wrapped` 套协议外壳 —— 外壳字节（`FA FA…ED`）不进转义
  范围。由此确立「**内核域按逻辑字节、壳域按线上字节**」：内核自身的
  length/checksum/画布偏移在 FE 编码期算完、不受转义影响；壳内 length/checksum 由
  build_wrapped 对注入后的转义字节重算。
- 配置落点：传输配置 `escape = {enabled, pairs: [[原字节, 替换序列]]}`（骑 JSON，**零
  DDL**）。旧库存量配置缺段 → validate 自动补齐默认关闭段（restore 不得静默失败）；
  `pairs` 是列表 → `_deep_merge` 整体替换（FE 删行才生效）。
- 转义表**单趟映射**（命中 from → 输出 to 序列，未命中原样，替换产物不回扫）一个表
  覆盖三型：0x7D 型字头（`7D→7D5D`）、0x10 型前缀（`11→1011`）、非前缀多字节替换
  （`0D→0D0A`）；STX-ETX 框归 wrap 外壳族（不属转义），varint/COBS 仍 §8.14 暂缓。
- 双端范围：转义算法 SSOT = `backend/core/escape.py`；FE `utils/escapeTable.js` 仅做
  配置归一 / 行级提醒 / 样例预览 —— **画布、`/compile/*` 预览、`/export/binary` 恒为
  逻辑帧，线上字节以发送历史 raw 事件为准**。
- 接线三路：`dispatch_frame` / `dispatch_transaction`（内核先转义再套壳，关闭态逐字节
  不变）、`sequence_runner.execute`（转义先于 `record["sent"]` → 记录与存档即线上字节）；
  `replay` 存档帧即线上字节 → **不二次转义**（钉死）。

**N5 填充 / 对齐批（G4——✅ 已落地，对齐模型已拍板）**
- 现状（改造前）：只能 HEX_RAW 手工算 pad。
- **模型定案（2026-09-30 拍板：字段级 `align` + `pad_to`，两键骑 `parameter_config`
  零 DDL）**：`align=N` → 该字段**内容起点**绝对偏移补到 ≡0 (mod N)；`pad_to=N` →
  **内容末尾**补到 ≡0 (mod N)；`pad_byte` ≤2 位 hex 严格解析否则 0x00（N2 `pad_char`
  先例）。归一 1..4096（Number/floor；bool/非数/越界 → 0 即关闭）**fail-open** 不阻断
  出帧；非法 `align`/`pad_to` → `ALIGN_INVALID`/`PAD_TO_INVALID` 双码 W 提醒（零 error
  不锁保存），`pad_byte` 非法静默回落不提醒。
- **双口径（可翻案点）**：pad 进发射流 / 偏移尺 / `total` / 卡片宽度；**不进** PASS0
  长度公式、checksum 参与区、`byteMap` 区间、页脚 LEN —— 内容口径与既有链路零改动
  （指令链 `config=None` → 0x00 现状零改动，协议链不产三键 inert）。
- 归属与逐副本：`byteOffsets.byId` `offset`=内容起点、`size`=内容字节、`pad` 键**仅
  >0 条件写入**（10 处既有全形状 `toEqual` 断言零触碰）；align 前置 pad 归**前一
  兄弟** span（同列表首项 / 重复副本同 id 不另归属），组 span 走游标算术（含各副本
  子字段 pad + 自身 pad_to，不上卷避免与游标重复计数）；组 align 首副本前补一次、
  `pad_to` 末副本后补一次，叶按绝对游标**逐副本**算（非 Σ×reps 常数）；presence 未
  命中 / repeat=0 → 字段与 pad 都不发；LITTLE 反转只涉字段内容。
- 实现面：BE `backend/core/pad.py`（归一/补位 SSOT）+ `Block` 三键 Any 透传 +
  `datahub.to_block`（presence 未命中早退分支不带三键）+ `orchestrator` 发射期绝对
  游标（叶前置/后置补位，容器 `_PadMark` 挂子树首/尾 —— 展开期插入、发射期解析，
  经 `emit_blocks` 过滤出 handler 视野）；FE `utils/padSpec.js` + `InstructionEncoder.
  emitNode` 叶/组两路注入 + `byteOffsets` 逐副本游标模拟 + `validateInstruction` 双码
  提醒 + 面板「对齐 / 填充」区 + 卡面 `data-pad-chip`（A4·P8，宽度 = 内容 + 归属
  pad）；顺手修 `byteHighlight.buildHexSegments` —— byteMap 只记内容曾让填充字节在
  BYTE_STREAM 丢字节（与 LEN 矛盾）→ 无主段（fieldId=null 不参与高亮）补齐。
- 验收（2026-09-30）：红→绿 2 轮（FE 6 新测试文件 + `byteHighlight` gap 补测初红
  43 例、BE `test_encode_align.py` 初红 4 用例，零误伤旧测）；全量 FE **866/866
  （62 文件）** EXIT=0（基线 823 + 43）、BE **371/371** OK EXIT=0（基线 367 + 4）、
  `vite build` EXIT=0、yorha-ui 校验器触 10 文件 0 违规、`generate-page-status.mjs`
  EXIT=0、schema **SCHEMA_IDENTICAL**（28 对象，三键纯 JSON 骑乘零 DDL 实证）。
- 状态：**✅ 真机验证通过（2026-09-30）→ 第 11 单已提交 `d8f0d65`**。真机结论
  （指令 CMD - 632，vite:5173 + uvicorn:8000 重启载新码）：面板「对齐 / 填充」区
  渲染 / 三输入 APPLY → 画布 `A4·P8` 角标（title 对齐/填充双语义）、文本字段偏移
  `@01→@04`、后续字段 `@09→@10`、LEN `~9B→~16B`、卡宽 162/494/74px（内容 +
  归属 pad，0B 卡 60px 地板）；保存 + **整页刷新往返** 4/8/FF 回填、chip/偏移/LEN
  保持（parameter_config 落库零 DDL）；加工页 LEN 16 BYTES + BYTE_STREAM 全 16
  字节含 pad（`00 FF FF FF 41 4C 50 48 41 00 00 00 FF FF FF FF`，align/pad_to 用
  FF、字段内 pad_char 00 并存）；**FE=BE byte-equal**
  `00FFFFFF414C504841000000FFFFFFFF` 逐位相等；`/dispatch` 裸发 SENT LOOPBACK
  16B echo=payload byte-equal；CLEAR → chip 消失、`@01/@09`·`~9B` 还原；
  `align=9999` → fail-open（无 chip、偏移不动、摘要「无效→忽略」、卡 ⚠
  `ALIGN_INVALID` 提醒，不锁不报错）；复位 4/8/FF 留证（同 pad_char/presence 先例）。

**G5 双端硬拦插队批（op 白名单——✅ 已落地，保存策略已拍板「双端硬拦」）**

- 立题：G5 的 BE 半边收口（N1 只上了 FE W5 提醒不阻断 → 直连 API / JSON 导入
  仍可把未知 op 存进库，`fields_to_blocks` 静默降级 `fixed` → 编码错码）。前置
  摸底 2026-09-30 已完成（见挂账清项后），本批插队。
- 摸底（只读，2026-09-30）：`instruction_fields` 存量 op 全集 = HEX_RAW 9 /
  LENGTH_CALC 5 / INT_UNSIGNED 5 / MAPPING 4 / CHECKSUM_CRC 3 / ARRAY_GROUP 2 /
  TIME_ACCUMULATOR·INT_SIGNED·AUTO_COUNTER 各 1 —— **9 种全部 ∈ KNOWN_OPS，
  无 legacy（INPUT/FIXED/… 0 行）、无未知 op、无存量 type=string 字段**；真机
  sweep 复核 16 指令 × 37 字段 0 未知 → 取全集硬拦不锁任何历史数据。
- 拍板（2026-10-01，三选一）：**「双端硬拦」**——BE 保存侧 400 + FE W5
  `OP_UNKNOWN` 从 warnings 升 errors（翻案 N1「提醒不阻断」语义，与 BE 同口径）。
  备选「仅 BE 硬拦（FE 保持警告）」「仅警告不拦」被否：前者 UX 断层（FE 放行 →
  撞 400），后者护栏只到可见、错码数据仍可入库。
- 口径：KNOWN_OPS = OP_CODES 15 项（含 N2 STRING）+ encoder legacy 5 项
  （INPUT/FIXED/HEADER/TAIL/CALCULATED）= **20 项**，双端逐行同步（FE
  `validateInstruction.js` ∪ `constants.js` / BE `routers/instruction.py`）——
  改一必改二；大小写敏感逐字匹配（小写 op 在 FE 编码即落错路径 → 双端同拦）、
  空 op fail-open（FE 门 `f.op_code &&` 同口径）。
- 实现：BE `_validate_op_codes`（C2 位域校验同位先例）接 POST（唯一性检查后、
  任何写入前）与 PUT（元数据写入与字段全量 DELETE 之前）→ 拒绝即存量原样、无
  半写状态；FE `OP_UNKNOWN` 入 errors → **零新增 UI 接线**自动三处生效：
  saveChanges 结构错误门（P0-2）阻断保存、issueBadges ⛔ error 级卡面章、
  analyzeImport 导入预览 errors 分流拦截。
- 验收（红测先行，红→绿 1 轮）：BE 新 `test_op_whitelist.py` 12 例（全集逐项
  过门 / KNOWN_OPS 与共享清单逐元素相等防漂移 / 400 detail 断言 / 大小写敏感 /
  空与 None op fail-open / POST 拒绝零落库 / PUT 拒绝存量原样含元数据 / 全量替换
  20 项 200）；FE `validateInstruction.test.js` 同批升级（未知 op 入 errors、
  小写 op 同拦、全集 20 项 + STRING 双清）。门禁：FE **867/867**（62 文件，
  基线 866 + 1）· BE **383/383**（基线 371 + 12）· `vite build` EXIT=0 ·
  pageStatus EXIT=0 · 校验器 2 文件 0 违规 · SCHEMA_IDENTICAL（28 对象零 DDL）。
- 状态：**✅ 真机验证通过（2026-10-01）→ 第 12 单已提交 `b715e2b`**。真机结论
  （uvicorn 重启载新码 + vite:5173）：POST 未知 op → 400 detail（探针即建即删
  零残留）；存量 sweep 16 指令 × 37 字段全过门（硬拦不锁历史）；UI 导入预览拦截
  —— `bad_op_import.json` 经文件选择器入 analyzeImport →「新增 0 ／ 冲突跳过 0
  ／ 校验错误 1」「[OP_UNKNOWN] 「坏字段」未知算子（WEIRD_OP）…保存已阻止」「没有
  可导入的指令」+ 零落库；指令页画布 error 章 = 0（存量零误报，warning 提醒不受
  影响）；CMD-632 APPLY→SAVE 正常回路 UNSAVED 清除（PUT 200 过新校验、N5 配置
  原样）；PUT 全量替换带 BOGUS_OP → 400 且字段/元数据 UNCHANGED（拒绝在 DELETE
  前）。

**挂账**（不排期，见 `BUSINESS_SCENARIOS.md` 挂账清单）：epoch 模板、加扰、
切换 op、组帧族（已立 §8.14）。原挂账项「BE op 白名单拒绝策略」已清 → 见上方
**G5 双端硬拦插队批**（摸底 2026-09-30 + 拍板 2026-10-01，第 12 单 `b715e2b`）。

- 状态：**排期已落档；六单 + N1/N2/N3/N4/N5 + G5 双端硬拦插队批全部实现、真机
  验证通过并分单提交（2026-09-30 → 2026-10-01）**——批1-4 =
  `23ad28e`/`327ac8c`/`f8dcf64`/`e6a31a4`、
  第 5 单优化批 = `3668d37`、第 6 单标色 = `3ff0f69`；N1 红→绿 2 轮（FE
  700/700 + BE 322/322）+ 3 文档 = 第 7 单 `7d50484`；N2 红→绿 2 轮（FE
  **728/728**（49 文件，基线 700 + 28）/ BE **332/332**（基线 322 + 10））=
  第 8 单 `848e248`；N3 红→绿 1 轮（FE **812/812**（55 文件，基线 728 + 84）
  / BE **342/342**（基线 332 + 10），7 新测试文件）+ 真机验证通过 = 第 9 单
  `8e9612f`；N4 红→绿 1 轮（FE **823/823**（56 文件，基线 812 + 11）/
  BE **367/367**（基线 342 + 25），BE `test_escape.py` 25 例（含双端共享
  向量 7 组）+ FE `escapeTable.test.js` 7 例 + `Terminal.test.jsx` 4 例）+
  真机验证通过 = 第 10 单 `b7f9fa7`；N5 红→绿 2 轮（FE **866/866**（62 文件，
  基线 823 + 43）/ BE **371/371**（基线 367 + 4），FE 6 新测试文件 +
  `byteHighlight` gap 补测、BE `test_encode_align.py` 16 双端共享向量）+
  真机验证通过 = 第 11 单 `d8f0d65`；G5 双端硬拦插队批红→绿 1 轮（FE **867/867**
  （62 文件，基线 866 + 1）/ BE **383/383**（基线 371 + 12），BE
  `test_op_whitelist.py` 12 例）+ 真机验证通过 = 第 12 单 `b715e2b`。终态复验：
  build EXIT=0、校验器触达 0 违规、pageStatus EXIT=0、schema SCHEMA_IDENTICAL
  （28 对象零 DDL）→ **N5 对齐模型已拍板落地（G4 结）**；**G5 双端硬拦已拍板
  落地、白名单挂账清——G1–G7 全集七项全部已结**。**

### 8.17 加工页字段种类感知（第 14 单 · 用户新需求）

> 用户原话需求：加工页字段配置 UI「更加清晰，友好，贴合字段种类的特性」——
> 只改加工页（/processing，序列页共用 normalize），定义侧不动（input_base
> 对 FLOAT/BCD 的定义侧联动留作未来项）。

- **种类章**：`resolveRunnerKind(field)`（runnerRenderRules.js 纯函数）按
  classifyRunnerField 的 lane 判定输出 `{key,label,title}`（FIX > TIME > CALC族
  LEN·CKSUM·CALC > ENUM:MAP > F32/BCD/SCALE/TEXT/SINT/UINT/BIT/CNT/STRUCT/
  ARRAY/IN/HDR/VAR 兜底），SmartInput label 前小徽标 + title 悬停讲算子编码
  特性；右徽标保留状态/长度语义（READ_ONLY > TIME_PICKER > n/N BYTES > BITS >
  [nB] > [TYPE]）不挤占；组头同出种类章（VAR/IN 归一 GROUP）。
- **通道贴合**：FLOAT_IEEE 强制 float 通道（占位 `0.0`、input_base 让位、
  严格十进制小数正则与编码端 float32 分支同口径、指数 `1e5` 不发值 blur
  复位）；BCD_CODE 强制 bcd 数字通道（十进制回显非 hex、占位 `0..99…9`、
  滤非数字按 nibble 限宽不发半截值）；dec 通道占位即域（`0..65535` /
  `-128..127`）；limits FLOAT→null（f32 不设整数域）、BCD→`{byteLen,
  maxLength:2n, min:0, max}`。
- **STRING 用量徽标**：`computeStringUsage` → `{used,total,unit,over}`
  （ascii 按 code point、utf8 按 TextEncoder，n/N CHARS|BYTES），超定长琥珀
  `text-[#E58D28]` 截断警示（与编码端 pad/截断同源）。
- **解析助手**：`parseBcdInput` / `parseFloatInput` 纯函数（与编码端镜像，
  改一必改二）。
- **编码契约补口（真机实锤后拍板，两处超出纯 UI 的行为修正）**：
  1. normalize 对**可编辑** FLOAT_IEEE/BCD_CODE/INT_SIGNED/SCALED_DECIMAL/
     AUTO_COUNTER 保留原算子 —— encode 的 f32/打包 BCD/两补码/定标/计数五个
     分支按 op 门控（InstructionEncoder 行 173/205/302/318/340），摊平成
     INPUT 即全部死亡（真机实锤 FLOAT 3.14 → `00 00 00 03`、BCD 1234 →
     `04 D2`）；修后逐字节 `40 48 F5 C3` / `12 34` / `FB` 锚定。带静态 value
     仍判 FIXED（存量固定块语义不动）；MAPPING/INT_UNSIGNED（编码字节等价）、
     TIME_ACCUMULATOR→TIME_CUMULATIVE（加工页手动选时刻的既定覆盖语义）、
     组结构维持摊平不扩面。
  2. STRING 静态 value ≠ 固定块：N2 契约「加工页初始值 = 静态 value 可继续
     键入」此前被 value→FIXED 判定误杀（真机 CMD-632 'ALPHA' 整行只读坐实）
     —— normalize 豁免 TEXT 种类 + getInitialValues 按 type='string' 兜底
     （op 被摊平后初值契约不丢）；修后回显 5/8 CHARS 可键入、出帧 16B 与
     既往基线零漂移。
- **红测先行**：runnerRenderRules.test 15 红 → 57 绿（原 43 + 新 14）；
  normalizeRunnerInstruction.test 新建 8 例（2 红）；InstructionEncoder.test
  1 红（摊平形态初值）；集成占位钉点批 1 `'0'` → `'0..65535'` 3 处（占位
  即域的有意变更）。终态 FE **890/890**（63 文件，基线 867 + 23）/ BE
  **383/383** · build EXIT=0 · 校验器 5 文件 0 违规 · SCHEMA_IDENTICAL
  （28 对象零 DDL）。
- **真机（2026-10-01，探针即建即删 a67196d5）**：6 字段探针（FLOAT/BCD/
  SINT dec/UINT dec/STRING/BITFIELD）→ F32·BCD·SINT·UINT·TEXT·BIT 六章全出、
  四占位就位；录入 3.14 / 12a34→1234 / -5 / HELLO_123456 → BYTE_STREAM
  `40 48 F5 C3 · 12 34 · FB · 00 00 · 48 45 4C 4C 4F 5F 31 32 · 01`；
  `1e5` 不发值 blur 复位 3.14；12/8 CHARS 琥珀；TRANSMIT →
  TX_SUCCESS (LOOPBACK)；存量 CMD-632 TEXT 章 + 5/8 CHARS 可编辑 + 16B
  零漂移；error overlay 0 零崩溃；探针 DELETE 200 清理 → 第 14 单 feature
  `f3adad8`。

### 8.18 加工页全种类控件矩阵补齐（第 15 单 · 用户新需求）

> 用户原话需求：加工时「还是没能贴合展示字段的属性」→ 追问拍板：「时间字段
> 需要时间设置弹窗、枚举映射需要下拉选项的这种」+「全种类矩阵补齐」。矩阵
> 审计（14 算子 × 控件形态，代码 + 真机）结论：时间弹窗 / 枚举下拉 / 位段
> 值表 / 只读计算等主干控件已就位，真缺口三处如下，全部收口；无种子数据种类
> （SCALE / STRUCT）以探针验收。

- **G1 无选项 MAPPING 枚举身份**（真机坐实：示例状态包（副本）· 枚举映射
  退化成 IN 裸文本）：身份与控件分闸 —— classify `isEnum` 认
  original_op_code（normalize 摊平不丢身份），下拉只由 `hasOptions` 把闸：
  有选项照旧 select（回归零漂移），无选项走普通通道。resolveFieldDisplay
  枚举分支加 `options.length` 闸（落回通道分支，hex 占位 / inputs 源照旧）；
  computeFieldInputLimits 的 isEnum 闸改 `(isEnum && hasOptions)`（无选项
  保留字节钳制，防 01/FF 代码字段敲出溢出域）。呈现 = MAP 章（title 讲明
  「未配置选项… 配置 options 后自动出下拉」）+ 语义行琥珀 `NO OPTIONS ⚠`
  （collectSemanticItems warn 项，title 悬停指向指令管理）。
- **G2 CNT 自动计数器推进**（用户拍板「发送成功后自动推进 + NEXT 预览」）：
  编码器 E1-6「跨帧状态机在调用方」注释落地 —— 新增 `advanceAutoCounter
  (field, current)` 纯函数（type 闸 / floor 解析 / input > 静态 value >
  start_val / max 双重取模，与编码端逐句同口径；非计数字段 → null 不误
  推进），InstructionRunner.handleSend 成功分支递归 fields 回写 inputs
  （仅单帧 TRANSMIT；事务面板同 payload 多 attempt 不推进）；语义行出
  `NEXT=n` 下帧预览 chip（collectSemanticItems(field, {inputs})），字节流
  预览随 inputs 实时跟进。
- **G3 HEADER/TAIL 只读加固**：编码端直读 params.hex（或 FIXED 分支），
  可编辑输入不改变出帧即欺骗 —— classify isFixed 认 original / 字面双回退
  （时间优先次序不回退）；resolveRunnerKind HDR 分支上移到 isFixed 之前
  （normalize 改写 op 后仍出 HDR 身份，不再掉 FIX/IN；底部旧 HDR 死枝
  随之移除）；无 hex 存量帧头回显 0 填充字节（isExplicitHex 认 HEADER/TAIL，
  与编码端 0x00 输出同口径）。
- **红测先行**：runnerRenderRules.test +12 例（第 15 单 9 红 → 69 绿；
  G1 身份/章/通道/钳制/提示 5、G3 只读与 HDR 身份、advanceAutoCounter 3、
  NEXT chip —— 含 3 条当天即绿的通道/钳制/回显守护断言）。终态 FE
  **902/902**（63 文件，基线 890 + 12）/ BE **383/383** · build EXIT=0 ·
  校验器 4 文件 0 违规 · SCHEMA_IDENTICAL 28。
- **真机（2026-10-01，探针 PROBE-15 即建即删）**：副本枚举映射 MAP 章 +
  `NO OPTIONS ⚠` 琥珀 + 可编辑 hex 通道占位 `00`（无空下拉）；示例心跳帧
  CNT `NEXT=1` chip → TRANSMIT 两连发 计数 `0→1→2`、`NEXT 1→2→3`、
  字节流计数位 `01→02→03`（仅成功路径推进）；回归 —— TIME 弹窗（时/分/秒
  全出）、示例状态包双下拉（待机/执行/故障 · 测试/测试1）、无误报 NO
  OPTIONS；探针 SCALE 章 + `FACTOR=10 · OFFSET=5`、STRUCT 组头 + 子字段
  UINT dec `0..255`；overlay 0 零崩溃；探针 DELETE 200（库回 16 指令）。
  附注：指令创建路由只存顶层字段，组契约 = 扁平 + parent_id（嵌套 children
  被静默丢弃，探针以 PUT 修正）→ 第 15 单 feature `db371ab`。

### 8.19 Core Pipeline 批次二（CP2 · 防错：D3 执行 / D12 删除级联 / D14 三口径）

> 出处：`DESIGN_CorePipeline.md` §7 批次二 + `DESIGN_Decisions.md` **D14 = A/A/A**
> （2026-10-01 拍板，开工前置已满足）。**零 DDL**（`backend/db/models.py` 未动，
> `yorha.db` 不随本批提交）；`/dispatch` 裸发缺省口径逐字节不变
> （`test_bare_frame_path_unchanged` 等既有用例钉死）。
> **终态**：BE 426/426、FE 915/915（63 文件）、`npx vite build` EXIT=0、
> yorha-ui 校验器 13 文件 0 违规。**人工验证 5 项已通过 → 已提交 `5afe706`。**

- **D14-A 存量不迁移 · D3 执行收口**（`backend/core/frame_builder.py`）：新增
  `_fit_policy` / `_max_bytes` 助手，装填三态执行 —— ①条数溢出（载荷放不进槽组）、
  ②`max_bytes` 超限、③欠载逐槽判；`overflow`/`underflow = reject` → `ValueError`
  → **400**（detail 带槽 id 与实际/允许字节数），缺省 `append`/`zero_fill` 保持原
  warning 文案不变。**实施注**：条数溢出无槽归属 → **任一槽 `overflow=reject` 即
  阻断追加帧末尾**；`max_bytes` 超限归 overflow 策略。
- **D3 槽契约保存期校验 + 新建槽默认 reject**：`routers/protocol.py`
  `_validate_slot_contracts`（create/update 调用，**只校验新字段 `fit_policy`**，
  非法 400 不 fail-open）+ `_iter_nodes` + 删槽后指向它的 `binding.slot_id` 置
  NULL 并回执 `dangling_slots_cleared`（`schemas/protocol_api.py::ProtocolResponse`
  新增该字段，缺省 0，`from_attributes` 缺属性回落默认 → GET 安全）。前端
  `config/blockTypes.js`：slot `fields: ['length','fit']` + `BLOCK_PROPERTY_FIELDS.fit`
  （`inputType:'fit'`，存点 `parameter_config.fit_policy`）+ **新建槽预置
  reject/reject**；`ProtocolPropertiesPanel.jsx` 新增 fit 分支（溢出/欠载两下拉，
  值域分侧不给交叉值，任一 REJECT 亮 `STRICT`、缺省亮 `LEGACY` + 口径注记）。
- **D14-B 序列步骤失效标记（不阻断）**：`routers/sequence.py::_missing_instruction_ids`
  读时批量比对 → `schemas/sequence_api.py::SequenceStepOut.instruction_missing`
  （**零 DDL**，读时派生）；`pages/Sequences.jsx` 列表行琥珀「失效」徽标（+ 一层
  本地兜底判据）+ 该步骤编辑降只读（指令下拉锁死出「（宿主指令已删除）」占位、
  标签/延时禁改、红提示改黄提示「帧是冻结快照仍可运行」）。
- **D12 删除三分口径 + 删前引用计数**：`routers/instruction.py` 新增
  `GET /{id}/references`（四表计数 + `total`）；`DELETE` 同事务三分处置 ——
  活配置（`protocol_bindings`/`response_specs`）级联删、冻结快照（`sequence_steps`）
  **留**并回执 `orphaned_sequence_steps`、日志（`dispatch_logs`）只读保留
  （404 detail 保持 `Not Found` 不改）。前端 `api/instructions.js::getInstructionReferences`
  + `useInstructionData.deleteInstruction` 删前计数 → 弹窗按三分口径列受影响项与
  处置（`describeReferences`/`describeDeletion` 导出纯函数钉文案），计数接口失败
  **降级回原文案、不拦删除**。
- **D14-C 转义层位统一**：`routers/dispatch.py` `WrapSpec` 增
  `payloads`/`slot_ids`/`start_order`、`_apply_wrap` 改返回含 `warnings` 的 dict、
  `DispatchRecord.warnings`、`hex_string` 改 `Optional` + 与 `wrap` **二选一 400**、
  **多载荷 = 逐条内核先转义再套壳**（与单条 wrap 同层位）。前端
  `api/dispatch.js::dispatchWrappedGroup`（body 不带 `hex_string`）+ 编排页
  `handleTrialSend` 去掉「`/compile/wrapped` → 裸发」两跳、改带 wrap 直发
  `POST /dispatch`，`record.warnings` 独立琥珀徽标（不拼进 SENT 文本）。
- **测试**：BE 新增 `test_slot_contract.py`（槽契约 + 悬空回执）、
  `test_instruction_delete.py`（引用计数 + 级联矩阵），扩展
  `test_frame_builder.py::FitPolicyTest`（三态 + 缺省回归）、
  `test_sequence_api.py::InstructionMissingFlagTest`、
  `test_wrap_api.py::MultiPayloadDispatchTests`、`test_escape.py` 多载荷层位；
  FE 扩 `blockTypes` / `useInstructionData` / `Orchestration` / `Sequences` /
  `Protocol` 五处用例（含 fit 面板值域与 STRICT 徽标、试发带 wrap 下发、
  弹窗三分口径、失效徽标与只读）。
- **文档同步**：`pageStatus.json` 四页能力条目（protocol / instruction /
  orchestration / sequences）+ `node scripts/generate-page-status.mjs` 重生成
  `docs/PAGE_STATUS.md`；`DESIGN_CorePipeline.md` §6.1/§9.5 三层校验表
  「⬜ 批次二补」→ ✅ + §7 批次二状态注；本节与 §1 CP2 行、HANDOVER 条目 33。
- **人工验证清单 ✅ 5 项已通过（2026-10-01，记录保留）**：① 新建槽默认 STRICT →
  试发溢出/欠载 **400**（detail 含槽 id 与字节数），存量槽仍 append/zero_fill 只出
  琥珀 warning；② 删指令弹窗三分口径与回执计数（含 `orphaned_sequence_steps`）；
  ③ 序列失效徽标 + 步骤只读 + 仍可运行；④ 编排多载荷试发 `warnings` 徽标与 SENT
  实际出线帧；⑤ 真实链路帧核对（载荷定界字节 / 三层帧 / **设备应答是否也带转义**，
  D15 关联 → 该项结论供 CP3-3d 参照；应答方向已 2026-10-02 定论 = 带转义，见 §8.35）。

### 8.20 双端共享向量表（CP2b · D11 分段 ① 共享 fixture 化）

> 出处：`DESIGN_Decisions.md` **D11 分段 ①** + `DESIGN_CorePipeline.md` §7 批次二
> 拆批注（2026-10-01，CP2 完成后开工）。**零 DDL**（`models.py` 未动、`yorha.db`
> 不随本批提交）；**纯测试/数据重构**——不改任何生产代码路径，`/dispatch` 裸发
> 缺省口径逐字节不变（既有用例钉死）。
> **终态**：BE 426/426、FE 915/915（63 文件）、`npx vite build` EXIT=0、
> yorha-ui 校验器 7 文件 0 违规。**已提交 `da0179d`。**

- **跨语言特殊值约定（2026-10-01 拍板）= `$v` 包装对象**：JSON 无 `Infinity`/`NaN`，
  而向量确需喂这两个值（如 `[NaN, 1, "00"]`）→ `{"$v":"Infinity"}` /
  `{"$v":"-Infinity"}` / `{"$v":"NaN"}`；**其余标量按 JSON 原型天然分型**
  （`null`/`true`/数字/字符串），故字符串输入 `"1e3"`、`""` 与数值 `1.5`、`0`
  不会撞车（这正是弃用字符串哨兵的原因）。特殊值对象**只允许恰好一个 `$v` 键**，
  两端加载器对畸形标记**直接抛错**不 fail-open。约定与用法记于 `vectors/README.md`。
- **单一真相源 = 根目录 `vectors/`**（12 文件 / 15 表）：`int_signed` /
  `little_endian` / `bcd_scaled`（`bcd`+`scaled`）/ `float_ieee` / `repeat` /
  `time_counter`（`time`+`auto`）/ `string` / `align` / `presence`（`leaf`+`group`）/
  `escape` / `bitfield`（`pack`）/ `wrap`。前 11 个是平面向量表；**`wrap.json` 是
  三处同值场景树**（`FA FA / 02 / 01 02 / ED`，迁表前在 `test_frame_builder.py` +
  `test_wrap_api.py` + `blockMerge.test.js` 各写一遍）。
- **双端加载器逐条同口径（这一处保留「改一必改二」）**：`vectors/load_vectors.py`
  `load_vectors(name, key=None)` ↔ `vectors/vectors.js` `loadVectors(node)`，均为
  递归解 `$v`；后端按 `Path(__file__)` 定位绝对路径、前端 `import ... from '*.json'`
  （测试文件所在层上溯到仓库根）。
- **形状差异适配（值不变，各端在测试侧归一，3 处）**：① `null`↔`undefined`——
  JSON 无 `undefined`，FE 侧对 `repeat.ref_value`、`bcd_scaled.scaled.factor/offset`、
  `string.encoding/pad_char` 用 `?? undefined` 还原「不写键」（否则
  `Number(null)===0` 把缺省误当 0）；② `children`↔`fields`——align 组树键名，
  FE 侧 `toFe()` 递归改名；③ `[start,len,default]` 三元组↔
  `{start_bit,bit_len,default_val}`——bitfield，FE 侧 `map` 归一并把期望 hex
  去空格后与两端实现同钉。`wrap.json` 的 `config:{}` 等 BE 冗余键 FE 直接忽略
  （`blockMerge.test.js` 30 例钉住）。
- **迁表范围**：13 个后端测试文件（12 个向量表 + `test_wrap_api.py`）与 6 个前端
  测试文件（14 处 `const VECTORS` 声明 + `wrap` 场景树）全部改为读共享 JSON；
  内联字面量删除，行注归档进 `vectors/README.md`（`#N` = 表下标）。
  **未迁入 = 不是数据表的「实现语义同源」锚点**：`pad.py`↔`padSpec.js`、
  `op_whitelist.py`↔`KNOWN_OPS`、`escape.py`↔`escapeTable.js` 实现（表已共享）——
  这些仍是真·改一必改二，README §5 已注明。
- **文档同步**：`DESIGN_Decisions.md` D11 实施注（① 已实施 + `$v` 约定）、
  `DESIGN_CorePipeline.md` §1/§7 拆批注状态、本节与 §1 CP2b 行、HANDOVER 条目 34。
  **无 UI 改动 → `pageStatus.json` / `PAGE_STATUS.md` 不动。**

### 8.21 Core Pipeline 批次三 · 3a（CP3-3a：配方数据层 + 串行编译 + 加工页分层预览）

> 出处：`DESIGN_CorePipeline.md` §7 批次三 / §9.1–§9.7 + `DESIGN_Decisions.md`
> **D13 = A（封装配方）**（2026-10-01 拍板，硬前置 CP2 ✅）。**含 DDL** ——
> `frame_recipes` 新表 + `instructions.default_recipe_id` 补列自愈，
> `yorha.db` 沿先例**单独同步提交**；`/dispatch` 裸发缺省口径逐字节不变
> （既有用例 + 冒烟「不带 wrap 回归」钉死）。
> **终态**：BE **466/466**（基线 426 + 40）、FE **920/920**（63 文件，基线 915 + 5）、
> `npx vite build` EXIT=0、yorha-ui 校验器 3 文件 0 违规、**真路由冒烟 25 项 PASS**。
> **已提交 `e63d76f`（代码+文档）→ `438f3af`（chore(db) DDL 落库）→ 本回填。**
> §9.7 人工验证 3 项待通过后补记。

- **数据层（DDL）**：`models.py` 新增 `FrameRecipe`（id / name / description /
  stages(JSON) / version / created_at / updated_at，**无 `instruction_id` 列** ——
  关联靠 `instructions.default_recipe_id`，单列天然唯一）+ `Instruction.
  default_recipe_id` 补列；`database.ensure_recipe_columns` 镜像
  `ensure_protocol_version_column`（PRAGMA 先查 → ALTER ADD COLUMN → 幂等 /
  表缺 no-op / 存量回填 NULL = 无配方），`main.py` lifespan 在 create_all 后调用。
  `protocol_bindings` **不动** —— 配方与默认协议是**互斥消费**而非叠加。
- **`/recipes` CRUD**（`routers/recipe.py` + `schemas/recipe_api.py`，镜像
  `binding.py` 范式）：`GET ?instruction_id=` 降级链过滤（按 `default_recipe_id`
  反查 → 0/1 条；未关联 = `[]` 不是 404）；保存期校验 = §9.5-3「配方期」行 ——
  层数 **1..4**（`MAX_RECIPE_STAGES=4`）、stage 协议 404、槽存在且为 slot /
  插槽重复 400、配方名非空 ≤128；`version` 乐观并发（缺省跳过比对、给了不符
  **409**，镜像 `protocols.version`）；**删除同事务清指令引用**并回执
  `cleared_instructions`（逻辑外键无 FK，同 `protocol_bindings` 删除级联先例）。
- **`definition_hash` 只在后端算**（`core/definition_hash.py`：协议 `children`
  子树规范化 JSON（`sort_keys` + 紧凑分隔符）→ `sha256:<hex>`）：**保存期回写**
  （客户端传入一律忽略）、**编译期比对** —— 失效出「配方已失效」warning +
  `stages[].stale` **不阻断**（D7-A 口径）。
  **实施注**：编译期**不回写 DB** —— 若编译即回写，下一次比对必然「已对齐」，
  失效徽标即失去意义；§9.1「保存与编译时算并回写」的「回写」按**响应回显**
  （`stages[].definition_hash` = 当前指纹）落地，**落库只在 `/recipes` 保存期**。
- **串行编译**（`core/recipe_compile.py`，`/compile/wrapped` 与
  `dispatch._apply_wrap` **共用同一份实现** → 预览与出线同字节）：stage 0 吃内核
  载荷组、stage n≥1 吃 `[前层输出]`、`start_order` 只作用于 stage 0、`slot_ids`
  归配方阶段所有（请求侧该字段不参与）；逐层错误带「第 N 层（协议）」前缀、
  warnings 聚合同前缀；`hex`/`total_length` 恒为**最终帧**（旧调用方零改）。
  请求 `protocol_id` 与 `recipe_id` **互斥**、都不给 → 400（`protocol_id` 由必填改
  `Optional`，单协议路径字段逐字不变）。
- **`frame_builder` 两处增改**（均加参数且缺省值 = 原行为，存量路径零改）：
  ① `strict_fit=True`（**配方路径**，§9.5-2）把未显式配置的槽缺省改为
  `reject`/`reject` —— 主动偏离 D3「默认取现状零回归」；报错归因区分「协议存在
  overflow=reject 的插槽」vs「配方路径缺省 overflow=reject」；
  ② 返回增 `logic: [{label, type, value}]` = 发射后 length/checksum **真值**
  （§9.4「该层 LEN/CRC 卡面回显」）。
- **加工页降级链三级**（`InstructionProcessor`，§9.3）：**配方 → 默认绑定协议 →
  裸发**，互斥取第一个命中；**配方级拉取失败不整机降级**，继续走第 2 级
  （绑定级失败仍 `failed` 裸发，沿批次一 1c 口径）。`InstructionRunner` 预览按
  `mode` 分叉 —— 配方态**分层堆叠**（层号 · 协议 label · 该层 hex · Δ ·
  LEN/CRC 真值 · 该层告警）+ 顶层 `RECIPE STALE` 失效徽标，单协议态**形态与文案
  逐字不变**；`TransactionPanel` 配方态指示改配方名 + 层数。新增 `api/recipes.js`
  + barrel 导出，`compileWrapped({recipeId})` 配方态不带 `slotIds`。
- **测试**：BE 新建 `test_frame_recipes.py` **32 例**（CRUD / `?instruction_id=`
  过滤 / version 409 / 删引用回执 / 层数上限 / stage 槽契约 / hash 回写与失效 /
  补列自愈 4 例 / 编译入口互斥与 404）+ `test_wrap_api.py` 扩 **8 例**
  `RecipeWrapTests`；FE `InstructionProcessor.test.jsx` 扩 **5 例**。
  **三层帧主向量一处钉死改一必改三** = `vectors/wrap.json` 新表 **`three`**
  （三层壳 + 手工揉层单树 `manual` + `expect` 分层回显；三处同读 =
  `test_frame_recipes` / `test_wrap_api` / `InstructionProcessor.test`）——
  「配方 vs 单协议**同内核 byte-equal 双跑**」在向量层证明 D2-A 现状手工揉层与
  配方**等价**。
- **真路由冒烟**（TestClient 走完整 FastAPI 栈 —— 单测直调函数**验不到**的一段）：
  `/recipes` 路由注册与 openapi、出线 JSON、互斥/缺省 400、404 detail、
  version 409、删除清引用、**残留自清** —— 25 项 PASS（脚本在临时目录，
  不往真库留数据）。
- **文档同步**：`DESIGN_CorePipeline.md` §7 批次三 3a 进度注 + §9.7 排批表两行、
  本节与 §1 CP3 行、HANDOVER 条目 35、`DESIGN_Decisions.md` D13/D7 实施注、
  `pageStatus.json` 加工页条目 + `node scripts/generate-page-status.mjs` 再生成
  `docs/PAGE_STATUS.md`。
- **人工验证必查（§9.7，待执行）**：① 三层真实链路帧目视核对；② 分层堆叠视图
  逐层字节与协议页卡面一致；③ 改动中间层协议 → 加工页失效徽标点亮。

### 8.22 Core Pipeline 批次三 · 3b（CP3-3b：编排页配方编辑器 + 试发改线 + curl 冒烟）

（2026-10-01，**纯前端批、零 DDL** —— 未改 `models.py` / `database.py`，`yorha.db`
不随本批提交；未碰 `processor.py` / `graph.py` / `Blueprint.jsx`，`/dispatch` 缺省
口径由既有用例 + curl 裸帧回归**双钉**。3a 已提前并入 `dispatch` `wrap.recipe_id`
接线，故 3b 只剩**编辑器**与**试发改线**两块。）

**范围（`DESIGN_CorePipeline.md` §9.4「编排绑定页」行 + §9.7 3b 行）**

- **新组件 `frontend/src/components/editor/RecipeEditor.jsx`**（编排页属性面板
  **分区 4/5「封装配方 (RECIPE)」**，分区 5/5 仍是底部 SAVE 操作区）：
  - **有序 stage 列表**：加层 / 上移 / 下移 / 删层 + 每层选协议 + 选槽；层数
    **1..`MAX_RECIPE_STAGES`=4**（与后端 `recipe_api.MAX_RECIPE_STAGES` 同值）、
    **删层保底 1 层**（服务端同口径 400）；
  - **加层缺省沿用上一层协议**（最常见 = 同一外壳再套一层），首层用首个协议；
  - **换协议 → 该层 `slot_ids` 置空**（槽属另一棵协议树，留着即脏引用 → 服务端 400），
    置空 = 回稠密位次；
  - **选槽 = 成员关系 + 选择顺序**：位次 badge `#n` 即第 n 条载荷（§9.1「位置对应
    payloads」）；取消后位次自动前移不留空洞；无槽协议不出芯片；
  - **新建即 POST 落库**（沿本页「空表种默认绑定」先例，id 前端 uuid），之后编辑
    一律 PUT + `version` 乐观并发（不符 **409** 透出）；
  - **手动保存沿本页 SAVE 底置范式**：脏点 + 「配方未保存/已同步」+ 底部按钮；
    **离开拦截**：配方脏稿纳入页面既有 `beforeunload`；
  - **脏时禁切换配方 / 禁新建 / 禁试发**（单份草稿无处驻留 → 防静默丢稿；后端只认
    已落库配方，带脏稿试发 = 预想与出线不一致）。
- **未建配方时试发仍走组协议**（现状路径逐字节不变），编辑器此时**只渲染新建入口、
  不占任何 select** → 既有「属性面板四分区 select = 3」用例**零改全绿**。
- **头部 wrap 来源指示**：`WRAP :: 配方 <名>`（琥珀）vs `WRAP :: 组协议`；显示名
  **优先取草稿**（改名未保存时指示即时跟随，否则指示与实际出线对不上）。
- **试发改走配方**：`dispatchWrappedGroup({recipeId, payloads, instructionName})` →
  `wrap.recipe_id`，**不下发 `slotIds`/`startOrder`**（槽位与层序归配方阶段所有，
  §9.1 / `recipe_compile`）；未选配方 → 原组协议参数对象**逐字不变**（批次二 D14③
  层位口径）。
- **关联指令下拉（LINK）= 加工页降级链第 1 级的读入口**（写 `instructions.
  default_recipe_id`）。**换绑两步**：`_link_instruction` 只写目标指令行、**不回清
  旧指针**，直接设新会让旧指令继续指向本配方（`RecipeResponse`「0 或 1 条」不变量破）
  → 保存时**先 `instruction_id:""` 清旧、再带清空后的 `version` 设新**；仅改名/改层
  不发该字段（`None` = 不改）。
- **删配方弹 `NieRModal` 确认**（服务端同事务解除指向本配方的指令关联）；`GET /recipes`
  全量挂载拉取，**失败只提示不阻断**绑定编辑与组协议试发。

**测试**：FE `Orchestration.test.jsx` 新增 **4 例**（编辑器新建 → 改名/加层 → SAVE
单次 PUT + 脏点 + 离开拦截 / stage 操作四件套 / 试发改走配方且脏稿禁发 / 关联换绑
两步），其余**零改**。**curl 冒烟**（`Temp/opencode/cp3b_curl_smoke.ps1`，临时脚本
不入库）：真 uvicorn + `curl.exe`，**不是 TestClient**（单测直调函数验不到真实 HTTP
栈）——**13 项 ALL PASS**：建协议 / 建配方（`version=1` + 服务端回写 `definition_hash`）/
GET 往返 / 配方编译 `AA 01 02` / **dispatch 带 `recipe_id` 出线 = 预览同字节** /
**不带 wrap 裸帧回归**（`0102` 逐字节不变）/ 组协议 wrap 回归 / 删配方
`cleared_instructions=0` / 删协议 / 残留清零（`GET /recipes = []`）。

**终态**：BE **466/466**、FE **924/924（63 文件，基线 920 + 4）**、
`npx vite build` EXIT=0、yorha-ui 校验器 3 文件 0 违规、curl 冒烟 13 项 ALL PASS。

> **注**：冒烟的临时插入/删除会改 SQLite 文件字节（插入后页内容不与插入前字节等价），
> 已还原到 3a 提交态；BE 全量测试已核实**不脏 `yorha.db`**。3b **零 DDL** →
> **无 `chore(db)` 提交**。

**人工验证（§9.7 3b 段，待执行）**：① 编排页新建配方 → 加层 / 换序 / 选槽 → SAVE →
刷新后回读一致；② 选中配方点「封装试发」→ 出线帧与头部 `WRAP :: 配方` 指示一致、
**未选配方时与改前逐字节一致**；③ 改名（未保存）→ 试发按钮置灰，保存后恢复。

- **文档同步**：`DESIGN_CorePipeline.md` §7 批次三 3b 进度注 + §9.7 排批表、
  本节、`PLAN_Backlog.md` §1 CP3 行、`PROJECT_HANDOVER.md` 条目 36、
  `DESIGN_Decisions.md` D13 实施注、`pageStatus.json` 编排页条目 +
  `node scripts/generate-page-status.mjs` 再生成 `docs/PAGE_STATUS.md`。

### 8.23 Core Pipeline 批次三 · 3c（CP3-3c：序列封装帧 D6-B + curl/UI 双冒烟）

（2026-10-01，**含 DDL** —— `models.py` 新增 `sequence_steps.wrap` 单列 +
`database.ensure_sequence_step_columns` 补列自愈（镜像 3a `ensure_recipe_columns`
四态模板，`main.py` lifespan 调用），故**有 `chore(db)` 提交**；未碰
`processor.py` / `graph.py` / `Blueprint.jsx`；未封装步骤的序列发送路径与
`/dispatch` 缺省口径由既有用例 + 冒烟**双钉**。）

**范围（`DESIGN_CorePipeline.md` §9.7 3c 行 · D6-B「冻结 vs 重算分离」）**

- **请求 / 响应形分野**：`SequenceStepSpec.wrap` 只收 **`{recipe_id}`**
  （`_wrap_spec` 严格键集，未知键 400 `steps[i].wrap 未知字段: …`）；
  `definition_hash` / `stale` 属**响应形**（`SequenceStepOut.wrap`），透传即 400。
- **保存期冻结**（`routers/sequence.py` `_normalize_steps(db, steps)` / `_freeze_wrap`）：
  入参先 `normalize_plan` 归一 → 有 `wrap` 即 `kernel_slice` 切内核 →
  `compile_recipe` → `recipe_compile.shell_plan` 注入 **`plan.shell`** → 完整帧二次
  归一后冻结进 `payload`，`wrap = {recipe_id, definition_hash}` 落库；配方不存在 /
  编译异常一律降 **400**（`steps[i]: 配方不存在：…`）。**`plan` 无 shell** → 视
  `payload` 为内核；**`plan` 有 shell 而 `wrap` 缺席/null** → 按旧区间切回内核 +
  `core_plan` 剥 shell —— 两种形态均幂等，**前端只透传不计算**。
- **`plan.shell` 几何（本帧绝对坐标）**：`head_i` = 该层 `payload_offset`、
  `S_i = Σ_{j>i} head_j`，内核起点 = `Σ head_j`；`length`/`checksum` 平移为最终帧
  绝对坐标。取数链 = `orchestrator.block_spans`（发射期每块真实区间，align 归前块、
  pad_to 归后块）→ `frame_builder._collect_shell` → `shell_plan`。
- **`_normalize_shell` 键集与不变量**（SSOT 在 `sequence_plan.py`）：`_PLAN_KEYS` 增
  `shell`，**仅当输入存在才输出**（存量 `{dynamic, checksum}` 键集零回归）；严格键集
  + 嵌套不变量 —— 层序 0..n-1 连续、offset 严格递减、**最外层恒 0**、内核落第 0 层
  区间、字段不出层区间、层上限 **4**（与 `MAX_RECIPE_STAGES` 同值）。另拆
  `core_plan(plan)`（剥 shell 的内核侧补丁）与 `kernel_slice(data, plan)`（按旧区间
  切内核）。
- **发送期重算**（`core/sequence_runner.py` `_frame_for_send`）：**无 shell** =
  `apply_plan → 整帧转义`（**逐字节不变**）；**有 shell** = `kernel_slice →
  内核侧 apply_plan → 内核转义 → `run.compile_wrap(recipe_id, kernel_hex)` 套壳 →
  整帧出线（层位同 dispatch「先转内核再套壳」）。编译异常抛 `WrapError` → 记步
  `WRAP: {原因}`，与 `PLAN:` / `TRANSPORT:` **三分类**；`_Run.claim/start` 增可选
  `compile_wrap` 参，路由侧 `_compile_wrap_factory()` 每次自开 `SessionLocal`
  （请求会话已关）。
- **读侧失效徽标**：`_wrap_with_stale(db, wrap, seen)` 按 recipe_id 缓存
  `recipe_compile.current_fingerprint`（配方 `stages` 与所引协议定义的复合 sha256）
  比对冻结时 `definition_hash` → `wrap.stale`；配方/协议缺失也按 `stale=true`
  （**只提示不阻断**，冻结帧仍可运行）。
- **DDL 自愈四态**（`ensure_sequence_step_columns`，与 `ensure_recipe_columns`
  用例同构、改一须对照另一处）：缺列补列且存量行回填 `NULL`（= 裸帧步骤，缺省路径）/
  二次调用 no-op / `create_all` 已带列时 no-op / 表不存在 no-op。
- **前端（仅 `frontend/`）**：步骤编辑器新增 `RECIPE（可选）` 选择器
  （`data-testid="step-wrap-recipe"`，挂载期 `GET /recipes`，失败静默降级、引用已删
  配方出「（配方缺失：id）」占位项）；卡片 + 编辑器头部 `WRAP :: <配方名>` 琥珀回显、
  `wrap.stale` 点亮既有「失效」同款黄徽标；新纯函数 `utils/sequenceView.shellSummary`
  渲染 `SHELL L1..LN · LN LEN@x CRC@y` 并回显进既有 `PLAN:` 面板。**`buildPlan`
  输出键集一行未改**（shell 后端注入 = 单一真相源，另有用例钉死
  `['checksum','dynamic']`）；`toDraft` 对 `wrap: null` **剥键** → 裸帧 PUT 请求形
  逐字节不变，APPLY 用 `...('wrap' in s ? {wrap: s.wrap} : {})` 保证**内核 payload
  与 wrap 同行**。

**测试**：新建 `backend/tests/test_sequence_wrap.py` **30 例**（键集纪律 / 冻结与
徽标 / 发送与往返 / 补列自愈四态），其余**零改**。

**真路由冒烟 30 项 ALL PASS**（真 uvicorn + `curl.exe`，**不是 TestClient** —— 单测
直调函数验不到真实 HTTP 栈；临时夹具脚本在 `Temp/opencode`，不入库）：冻结帧 =
主向量 `three` 同字节 `C008B005A0020102E0E1E2` / `plan.shell` 层 offset `[4,2,0]`
size `[5,8,11]` LEN `[5,3,1]`、内核 `{6,2}` / `wrap.stale=false` 且与
`plan.shell.definition_hash` 同值 / 裸帧 `payload`+`plan=null`+`wrap=null` 零回归 /
三类 400 定位 `steps[0]: `（脏 plan 字段 / 幽灵配方 / 脏 wrap 未知键）/ `GET`
回读与 `PUT` **幂等同字节** / `POST /start` → `sent = C0 08 B0 05 A0 02 01 02 E0 E1
E2`、`received` 同帧（过 `match_response` 语义）/ **改中间层协议 → `stale=true`
且冻结字节与冻结 hash 不动** / 还原 → `stale` 清 / **残留清零**（16 指令 · 3 协议 ·
0 配方 · 1 原有序列 `wrap` 全 null 原样）。

**真浏览器 UI 验证 6 项**（真 vite + 真 uvicorn，抓真实 PUT 请求体）：① 请求体 =
`{payload: 内核, plan: 无 shell, wrap:{recipe_id}}`，且**第 2 步不带 `wrap` 键**
（裸帧形状守恒）；② 卡片字节数 **20B**（11B 内核 + 3×(2B 头 + 1B LEN) = 9B 头）；
③ `WRAP :: 三层配方（3c 冒烟）` 卡片 + 编辑器头部两处回显；④ `PLAN` 摘要
`SHELL L1..L3 · L1 LEN@5 · L2 LEN@3 · L3 LEN@1` —— 与后端 `shell_plan` 坐标一致；
⑤ UI 点「启动序列」→ **2/2 OK**，第 1 步 `sent = C0 11 B0 0E A0 0B <11B> E0 E1 E2`
（20B，`LEN` 绝对值 0x11/0x0E/0x0B 逐层自洽），第 2 步 `AUTO_COUNTER` 发送期重算
（0x49 → 0x4A）；⑥ 传 `plan` 带 shell + `wrap:null` → 服务端切回内核、剥 `plan.shell`
（回退路径实测）。

**终态**：BE **496/496（基线 466 + 30）**、FE **932/932（63 文件，基线 924 + 8）**、
`npx vite build` EXIT=0、yorha-ui 校验器 4 文件 **0 违规**、真路由冒烟 30 项 +
真浏览器 UI 6 项 ALL PASS。

> **注**：冒烟夹具（3 层协议 + 配方）已删除、`序列 1` 已按回退路径还原为裸帧，
> 冒烟改动的 SQLite 字节用 `git checkout -- backend/db/yorha.db` 还原后**手工只补
> 一条 DDL**（`ALTER TABLE sequence_steps ADD COLUMN wrap JSON`）→ 本批 `yorha.db`
> = **3a 提交态 + wrap 单列**，不含任何冒烟数据。

**人工验证（§9.7 3c 段 = 上方「真路由冒烟 + 真浏览器 UI 验证」两组，已执行通过）**
；§9.7 3a①②③ 与 3b①②③ 共 6 项亦已执行通过，见 §7 批次三 3a/3b 进度注。

> **已提交 `fbad083`（代码+文档）→ `17c6830`（chore(db) DDL 落库）→ 本回填。**

**文档同步**：`DESIGN_CorePipeline.md` §4 序列 Runner 行 + §5 封装帧行 + §7 批次三
3c 进度注 + §9.7 排批表 3c 行 + 人工验证必查 ⑤、`PLAN_Backlog.md` §1 CP3 行 +
本节、`DESIGN_Decisions.md` D6 关联与 D15 关联项 ② 实施注、`PROJECT_HANDOVER.md`
条目 37、`pageStatus.json` 序列页条目 + `node scripts/generate-page-status.mjs`
再生成 `docs/PAGE_STATUS.md`。

### 8.24 Core Pipeline 批次三 · 3d（CP3-3d）：D5-A 按 D15-A 生成 response_spec + D7-A 余下徽标（含 DDL）

**批次**（2026-10-01，**含 DDL** —— `models.py` 新增 3 列（仅新增列）+
`database.ensure_response_spec_columns` 新建 / `ensure_binding_columns` 扩第 4 列
补列自愈（`main.py` lifespan 调用），故**有 `chore(db)` 提交**；未碰
`processor.py` / `graph.py` / `Blueprint.jsx`；`/dispatch` 缺省口径由
`test_bare_frame_path_unchanged` + 存量用例**零改全绿**双钉。）

**范围（`DESIGN_CorePipeline.md` §9.7 3d 行 · D5-A 按 D15-A 修订 + D7-A 余下两处）**

- **DDL 三列（仅新增）**：`response_specs.stage`（该条 spec 在配方链中的层序）、
  `response_specs.definition_hash`（`chain_fingerprint` 出处）、
  `protocol_bindings.definition_hash`。补列自愈四态与 `ensure_recipe_columns`
  同构：缺列补列且存量行回填 `NULL` / 二次调用 no-op / `create_all` 已带列 no-op /
  表不存在 no-op。
- **生成映射（`core/response_generate.py`，新建）**：`resolve_layers` =
  默认配方 → **每层各生成一次** / 默认协议 → 单层 / 皆无 → `ValueError` → **400
  「该指令既无默认封装配方也无默认协议，无法据此生成」**。每层把协议叶子
  （容器内联、`is_enabled is False` 跳过、slot 恒叶子）映射成五要素：
  **fixed → `echo_header_bytes`**（首个非 fixed 前的连续 fixed）、
  **length → `length_element`**（refs 含插槽 → `offset_val = A - head - trailer`；
  插槽后仍有插槽 / 区间模式 / 悬空 → **跳过 + warning**）、
  **checksum → `checksum_element`**（`BACKEND_ALGO` 映射；refs 只圈插槽 →
  `span_start = head` + `span_end_pad = trailer`；恰好全叶子除自身 → 整帧省区间；
  否则跳过 + warning）、字段位置统一给 `offset` 或 **`offset_from_end`**。
  **1 层不写 `stages` 键**（存量形逐字节等价）；产出先过 `normalize_spec` 归一。
- **逆序解包（`core/response_match.py`）**：`_SPEC_KEYS` 增 `stages`、
  `_STAGE_KEYS` / `_UNPACK_KEYS`（head+trailer ≥ 1）、`_CHECKSUM_KEYS` 增
  `span_end_pad` / `field_offset_from_end`、`_LENGTH_KEYS` 增 `offset_from_end`，
  `MAX_STAGES = 4`（同 `MAX_RECIPE_STAGES`）。`_match_stages` 按 **i = n-1 → 0**
  跑五要素，head/trailer **同时剥 `received` 与 `sent`**，reasons 前缀
  `STAGE[i].`；**顶层禁 echo_header / length / checksum、`mode` 禁 `echo`**
  （外壳层无此三要素）。**无 `stages` 键 → 原单帧路径逐字节不变**。
- **后插槽字段**：绝对位置不可静态定位 → 新增 `offset_from_end` /
  `field_offset_from_end`（= `len(frame) - 字段起点` = `Σ bls[idx:]`），
  与绝对 `offset` / `field_offset` **互斥**（非 0 同给 → 400）。
- **端点**：`POST /response-specs/{instruction_id}/generate`（写 spec + stage +
  `definition_hash`，返回 `{spec, stage, definition_hash, stale, layers, warnings}`；
  `warnings` 是降级说明不是错误，规格已保存）；`GET /response-specs/targets?
  protocol_id=`（**声明在 `/{instruction_id}` 之前**，`uses_protocol` 前置）；
  手工 `PUT` **保留 `definition_hash`**、`stage` 镜像随 spec 重算。
- **D7-A 绑定徽标**：`create_binding` 记出处（空/协议不存在 → `NULL`）；
  `update_binding` **仅 `protocol_id` 真变时重记**（改 label/priority 不抹失效
  提示）；读侧 `stale` 三态挂** ORM 行本身**（NULL 出处 → `None`、链解析不出 →
  `true`、比对一致 → `false`）。
- **前端（仅 `frontend/`）**：`api/responseSpecs.js` 增
  `getResponseSpecTargets` / `generateResponseSpec`；协议页新增「据此生成
  RESPONSE SPEC」底栏（切协议重拉候选、选中前生成钮禁用、成功回显
  `N 层 · STAGE k` + `warnings` 降级行、失败透传 400 detail、候选拉取失败短错误行
  降级不打断编辑）；`TransactionPanel`（`response-spec-stale`）与 `Orchestration`
  （`binding-stale`）两处徽标 —— **只在 `stale === true` 渲染**，
  `false` / `null` 一律不出。

**测试**：新建 `backend/tests/test_response_generate.py` **41 例**（`resolve_layers`
三分支 / 按层三要素映射与跳过 warning / 单层不写 `stages` / `chain_fingerprint`
失败回 NULL）；`test_response_match.py` 仅 `test_length_normalization_and_validation`
精确断言补 `offset_from_end: None` 一行（**有意的模型扩展**）；FE 补 **12 例**
（Protocol 6 + TransactionPanel 3 + Orchestration 3）。终态：BE **537/537**
（基线 496 + 41）、FE **944/944（63 文件，基线 932 + 12）**、
`npx vite build` EXIT=0、yorha-ui 校验器 8 文件 0 违规。

**真路由冒烟 43 项 ALL PASS**（`Temp/opencode/smoke_3d.py`，真 uvicorn :8765）：
DDL 三列落真库、无链 400 / 不存在 404、三层协议 + 配方挂默认 → `targets` 命中 +
`uses_protocol` + 层数 3、生成 `stage=2` / `layers=3` / `warnings` 空 /
`stale=false` / sha256 出处、`GET` 复核、dispatch `spec_source=instruction`
应答 OK、**内联写错最内层 length → `MATCH_FAILED` + `STAGE[0].`**、绑定记出处 +
`stale=false`、改协议 → spec 与 binding **同时 `stale=true`**、手工 PUT 保留出处 +
`stage` 镜像 = 2、无 `stages` → stage `NULL`、回滚协议 → 两处 `stale=false`。

**文档同步**：`DESIGN_CorePipeline.md` §7 批次三 3d 进度注 + §9.7 排批表 3d 行 +
人工验证必查 ④、§9.8 末条改「已随 3d 完成」，`DESIGN_Decisions.md` D5/D7/D15
表行与三处实施注，`PLAN_Backlog.md` §1 CP3 行 + 本节，`PROJECT_HANDOVER.md`
条目 38，`pageStatus.json` 经 `node scripts/generate-page-status.mjs` 再生。

### 8.25 Core Pipeline 批次四 · 4a（CP4-4a）：关系数据导入导出（零 DDL）

**批次**（2026-10-02，**零 DDL** —— 只读写既有 `protocol_bindings` /
`response_specs` 两表，`models.py`/`database.py` 未改，`yorha.db` 不随本批提交；
未碰 `processor.py` / `graph.py` / `Blueprint.jsx`；`/dispatch` 缺省口径零影响）。

**范围（`DESIGN_CorePipeline.md` §7 批次四 4a）**

- **导出**：`GET /datahub/export/bundle` 的 ZIP 增 `relations.json`
  —— `{schemaVersion: 1, bindings: [...], responseSpecs: [...]}`，行字段与
  `models.py` 列一一对应（`definition_hash` 原样带出）；`manifest.json` 增
  `relations: {bindings, responseSpecs}` 计数；`/datahub/status` `counts` 增
  `protocolBindings` / `responseSpecs` 两键。
- **导入**（`POST /datahub/import/relations`，入参 = `relations.json` 原文）：
  - **严格顶层键集**：未知字段 / 非 `1` 的 `schemaVersion` / 非对象 → 400
    （镜像 `_wrap_spec` 未知键 400 口径）；`bindings`/`responseSpecs` 缺席当 `[]`，
    给了但不是数组 → 400。
  - **恢复语义、非手工编辑**：按 `id` upsert；`definition_hash` 原样回填 ——
    目标库协议若已不同，读侧 `stale` 徽标自然点亮（D7-A 口径不变）。
  - **逐行独立提交**：每行写完即 `commit`；`IntegrityError` → `rollback` 只回该行
    并进 `skipped`（带 reason），**部分成功即部分落库、不整批回滚**。
  - **父缺失 → 跳过**：指令/协议不存在 → `skipped` + `reason`（不静默）。
  - **槽悬空 → 置 NULL + warning**（§6.2「不静默」口径）：导入的 `slot_id` 在目标
    协议里不存在或非 slot 节点 → 保留行但清空槽 + 记 `warnings[]`。
  - **默认唯一不变量**：`is_default=1` 先清同指令其它行（镜像 `create_binding`）。
  - **应答规格**：`spec` 过 `normalize_spec`（非法 → 跳过，不 400 整批）；
    **`stage` 不信文件、按 `spec.stages` 重算镜像**（SSOT = `_stage_mirror`）；
    同指令已有别行 → 跳过（一指令一规格）。
- **前端（仅 `frontend/`）**：DataHub 页新增「关系数据 (RELATIONS IMPORT)」面板
  （隐藏 file input `data-testid="relations-import-input"` → JSON 解析校验 →
  `NieRModal` 确认（列条数与 upsert 语义）→ `POST` → 回显
  **新增/更新/跳过/警告** 四段计数并 `refresh()`）；环境面板 `COUNT_LABELS` 增
  `绑定 BINDINGS` / `应答规格 SPECS`；导出回显补 `relations.json`。

**测试**：`backend/tests/test_datahub.py` 增 **12 例**（导出形键集与行字段 /
空关系为 `[]`、往返等价、同 id 更新不重复、父缺失三态跳过、槽悬空置空带警告 +
存在槽原样、默认冲突降旧默认、`(protocol, slot)` 唯一冲突跳过、`stage` 重算 +
出处保留、spec 非法/非对象/缺父/缺 id 跳过 + 同指令撞行跳过、顶层严格键集 400
四态、部分成功保留好行），沿 `test_bindings` 临时库三步建库范式；FE
`DataHub.test.jsx` 增 **4 例**（导出回显 + 两行计数 / 确认后才 POST 并回显四段
计数 + 刷新 / 取消不发请求 / 非法 JSON 与非关系包不出弹窗）。

**终态**：BE **549/549**（基线 537 + 12）、FE **948/948（63 文件，基线 944 + 4）**、
`npx vite build` EXIT=0、yorha-ui 校验器 4 文件 **0 违规**；**零 DDL**。

**文档同步**：`DESIGN_CorePipeline.md` §7 批次四 4a 进度注、`README.md` 聚合导出
一段（+ `relations.json` 与导入端点）、`PLAN_Backlog.md` §1 新 CP4 行 + 本节、
`PROJECT_HANDOVER.md` 条目 39、`pageStatus.json` 数据中心页条目 +
`node scripts/generate-page-status.mjs` 再生 `PAGE_STATUS.md`。

**人工验证**（2026-10-02，`uvicorn :8000` + `vite :5173` + 真浏览器；
`Temp\opencode\seed_4a.py` 造 1 绑定 + 1 应答规格 → 导出 → 删两者制造差异 →
浏览器导入复原 → 从 `yorha.db.bak_4a` 还原）**6 项通过**：

1. 环境面板七表行数含新增两行：删后 `绑定 BINDINGS 0 / 应答规格 SPECS 0`，
   导入后 `1 / 1`（截图存证）。
2. **导出**：点「下载 ZIP (EXPORT)」→ `SYS: 导出完成：7.7 KB（instructions.json +
   relations.json + manifest.json + frames/*.bin|hex）`；ZIP 实含 `relations.json`，
   `manifest.relations` 与该文件条数逐项一致（1 绑定 / 1 规格）。
3. **导入**：选 `relations_4a.json` → 弹窗列「绑定 1 条 · 应答规格 1 条」与 upsert
   语义，**确认前计数仍 0/0（未发请求）** → 确认 →
   `SYS: 导入完成（relations_4a.json）：绑定 新增 1 / 更新 0 / 跳过 0；应答规格
   新增 1 / 更新 0 / 跳过 0；警告 0 条。` → 面板刷新 1/1；服务端回读两行 `id` 与
   导出逐字一致、`definition_hash` 原样、`stale=false`。
4. **同文件二次导入** → 「绑定 新增 0 / 更新 1；应答规格 新增 0 / 更新 1」
   （按 `id` upsert 覆盖，不产生重复行）。
5. **非法 JSON** 文件 → `SYS: 导入失败：文件不是合法 JSON（…）`，不出弹窗、不发请求。
6. **HTTP 层严格 400**：未知字段 `extra` / `schemaVersion:99` / `bindings:{}` → 400
   （各带 detail），空载荷 `{bindings:[],responseSpecs:[]}` → 200。

### 8.26 Core Pipeline 批次四 · 4b + 4c（CP4-4b/4c）：绑定矩阵视图 + D9/D10 划界 + D8 全量核对（零 DDL、零后端改动）

**批次**（2026-10-02，**零 DDL**；**后端 0 文件改动** —— 复核发现 §6.2 槽节点行
（删槽 → `slot_id` 悬空置 NULL + 回执 `dangling_slots_cleared`）**批次二已落地**
并有 `test_slot_contract.py` 3 例，4b 只需把它摊到读侧；未碰 `processor.py` /
`graph.py` / `Blueprint.jsx`，`/dispatch` 缺省口径零影响）。

**4b 绑定矩阵（指令 → 默认协议 → 槽位）**

- **纯函数** `frontend/src/utils/bindingMatrix.js`：
  - `buildBindingMatrix(instructions, bindings, protocols)` → `{rows, summary}`：
    **一行一条指令**（含零绑定的 —— 覆盖率本身是治理信息），按 `device_code → code → id`
    排序；`is_default` 真值分栏（API 出布尔、DB 存 0/1，皆认；**重复默认不吞** →
    `extraDefaults` 计数并取排序末条作代表格）；格内 `protocolMissing` /
    `slotMissing` / `stale` 三标志。
  - `findSlotNode`（与后端 `routers/binding.find_slot_node` 同形：仅认 `type==='slot'`，
    递归容器）、`slotCellText`（显式槽 → 节点标签 / `悬空 <id>`；无显式槽 → `按序 N`）、
    `protocolCellText`（存在 → 标签；已删 → `（协议已删）<id>`）。
  - **孤儿不静默**（§6.2「不静默」的读侧延伸）；**`stale` 只认 `true`**（`false`/`null`
    不亮，与编排页 / 指令页两处同口径）。
  - `summary`：指令 / 有默认协议 / 无绑定 / 绑定 / 悬空槽 / 协议已删 / 失效绑定 /
    重复默认 八项。
- **UI**（`frontend/src/pages/DataHub.jsx`）：新增全宽面板「绑定矩阵 (BINDING MATRIX)」
  —— 说明段 + 摘要行 + 六列表（指令 / 名称 / 设备 / 默认协议 / 槽位 / 其它绑定）+
  底部「N 条指令尚未指定默认协议 —— 到「编排绑定」页补齐」；三读
  `GET /bindings · /instructions/ · /protocols/` 挂在既有 `refresh()` 上**与状态面板
  同拍**，任一读失败只置 `matrix.error`（琥珀「矩阵不可用」行），**不拖垮状态面板**；
  加载 / 空库 / 出错三态齐备。

**4b D9/D10 文档划界落位**

- `README.md` 新增 **§6 Scope Boundaries (页面划界 · D9 / D10)**：协议页 = 只管线帧
  格式；传输层只在通讯调试页 `/transport/config` 与 transport 抽象；协议保持设备无关，
  `accepts` 白名单由 `validate_binding` 服务端强制；治理视图指针（矩阵 + `relations.json`）。
- `pageStatus.json` 四页各增条目（`PAGE_STATUS.md` 经 `node scripts/generate-page-status.mjs`
  再生）：协议页「页面划界（D9/D10）」「删槽回执不静默」；通讯调试页「传输层唯一归属点」；
  编排绑定页「绑定矩阵指针」「设备白名单 accepts」；数据中心页「绑定矩阵 (BINDING MATRIX)」；
  并移除编排绑定页 `nextSteps` 中已落地的「绑定集导入导出与跨项目迁移」。

**4c D8 校验表全量核对（销项）**

- `DESIGN_CorePipeline.md` 新增 **§6.3 全量核对销项表**：§6.1 五行（保存时结构 /
  绑定时关系 / 发送时值 / 配方期组合 D13 + **4a 关系回灌 = 绑定层在恢复路径的镜像**）
  × §6.2 三行（指令 / 协议 / 槽节点），每行落到**具体函数 + 测试锚 + 结论** →
  **8 行全「已有」、0 待补**。
- §6.2 槽节点行状态由「批次二随绑定矩阵」改为「✅ 已有（批次二）+ 4b 读侧核对」。
- `DESIGN_Decisions.md`：D8/D9/D10 三个表行补实施注 + 三个正文段各加「实施注」——
  D9-B / D10-B 的重开条件（原定「等绑定矩阵落地后再议」）**已具备，仍取 A**（矩阵是
  读侧治理视图，不构成把 `transport_profile` / `device_code` 塞进协议树的理由；
  要重开须单独拍板理由 + 基数代价）。

**测试**：FE 增 **10 例** —— `utils/__tests__/bindingMatrix.test.js` **8 例**
（排序、默认/其它分栏与布尔真值、孤儿不静默、重复默认、空入参降级、`findSlotNode`
含容器与非 slot 同 id 拒、两格文案）+ `pages/__tests__/DataHub.test.jsx` **2 例**
（摘要六项计数 + 行三格与琥珀标出、零绑定提示 + 刷新后矩阵重读）；**BE 0 新增**
（4b 无后端改动，549 持平）。

**终态**：BE **549/549**（持平）、FE **958/958（64 文件，基线 948 + 10）**、
`npx vite build` EXIT=0、yorha-ui 校验器 4 文件 **0 违规**；**零 DDL、零后端改动**
（`yorha.db` 全程未改，`git status` 无该文件）。

**人工验证（2026-10-02，`uvicorn :8000` + `vite :5173` + 真浏览器，只读零写入）3 项通过**：

1. **矩阵与 API 逐项一致**：16 行（= `GET /instructions/` 条数），摘要
   `指令 16 · 有默认协议 1 · 无绑定 15 · 绑定 1 · 悬空槽 0 · 协议已删 0 · 失效绑定 0`
   与 `GET /bindings` / `/protocols` 实况一一对应（截图存证）。
2. **行内三格**：有绑定行 `DEMO-002 · 示例状态包 · YoRHa-A2 · 新协议 (NEW) · 按序 0 ·
   —`（无显式槽 → `slot_order` 位次）；未绑定行三格 `—`；底部出
   「15 条指令尚未指定默认协议 —— 到「编排绑定」页补齐」。
3. **刷新重读**：点「刷新 (REFRESH)」→ 状态面板与矩阵同拍重载，摘要仍逐项一致
   （三读再次命中，无重复行 / 无残留）。

**文档同步**：`DESIGN_CorePipeline.md` §7 批次四 4b/4c 进度注 + §6.2 行改写 +
§6.3 新表、`DESIGN_Decisions.md` D8/D9/D10 表行与三处实施注、`README.md` §6、
`pageStatus.json` 四页条目 + `PAGE_STATUS.md` 再生、`PLAN_Backlog.md` §1 CP4 行 +
本节、`PROJECT_HANDOVER.md` 条目 40。

### 8.27 CP3 人工验证复跑收口（3a①②③ + 3b①②③ + 洞位填装试发，零代码改动）

**背景**：§9.7 排批表曾记「3a①②③ / 3b①②③ / 3c⑤ 已执行通过（2026-10-01）」，但
`PROJECT_HANDOVER.md` 条目 35/36 的「待办：人工验证必查 3 项」与 `pageStatus.json`
编排页三条 `nextSteps`（洞位填装试发 / 3a 三项 / 3b 三项）一直挂着「待补」——**文档
互相矛盾**。本节在批次四收口后**真浏览器重跑一遍**，以实际证据为准统一三处文档口径。

**执行方式**（2026-10-02，`uvicorn :8000` + `vite :5173` 真机）：

- 临时在库里建两个无槽外壳协议 `verify-shell-3`（固定块 `CC`）/ `verify-shell-outer`
  （固定块 `DD`）当配方 L2/L3，配方挂到 `sample-inst-status`；验证完**从库备份
  `yorha.db.bak_4bv` 整库还原** —— 还原后基线逐项一致（instructions 16 / protocols 3 /
  bindings 1 · `slot_order=0` / response_specs 0 / frame_recipes 0），`yorha.db` 不入提交。
- 所有「出线帧」结论**以后端 `GET /dispatch/history` 记录为据**（UI 回显 + 服务端记录
  双向对账），不靠肉眼孤证。

**8 项全部通过**：

1. **3a① 三层真实链路帧目视核对**：加工页点 `TRANSMIT` → history 记录
   `DD CC FA FA ED 00 FA FA 00 00 00 00 00 05 01 08 ED`（**17B**，`byte_count=17`），
   与 `WRAPPED_LAYERS` L3 汇总行**逐字节一致**（预览/出线同字节）。载荷内含定界字节
   `FA FA`、L1 带 `LEN` —— D13「有 LEN = 不需要转义」的观察对象；**真实设备是否异常
   仍待硬件**（与 §9.7 ④ 同性质，不阻塞）**→ ✅ 已销（2026-10-03，§8.51：公开规范真帧 +
   `test_wire_delimiter.py` 10 例仿真，无需硬件）**。
2. **3a② 分层堆叠视图逐层字节与协议页卡面一致**：L1 `FA FA`（帧头 2B@00）+ `ED`
   （帧尾 1B@02）+ 设计期 `??` → 运行期 `LEN 长度 (LEN)=00` + 载荷插槽 `??B` → 运行期
   注入 11B 内核（Δ+4B）；L2 固定块 `CC` 1B@00 → 改定义后 `EE`（协议页卡面同步显示
   `EE 1B @00`，Δ+1B）；L3 外层标记 `DD` 1B（Δ+1B）；三层累进 15/16/17B 与
   `POST /compile/wrapped {protocol_id: sample-protocol-root}` 单协议编译结果**byte-equal**
   （串行编译首层不改字节）。
3. **3a③ 改中间层协议 → RECIPE STALE**：`PUT /protocols/verify-shell-3`（与协议页
   SAVE 同端点同 payload 形状，`children` 变更 → `definition_hash` 变）改固定块 `CC → EE`
   （version 1→2）后重载加工页 → `⚠ RECIPE STALE — 配方已失效：协议定义已变更，请重新
   保存配方`（`data-testid="wrap-stale"`）点亮、L2 行标 `DEF STALE · 16B`、L2 字节已换
   `EE`，**三层预览仍完整渲染**（warning 不阻断，符合口径）。
4. **3b① 建配方闭环**：`新建 (recipe-new)` → 立即 POST 落库 `已新建 (CREATED) v1` →
   改名「三层壳 (TRI-LAYER)」→ `+ 层` 加到 `层数 3 / 4` → 每层选协议 → 点
   `第 3 层上移` 换序 → L1 点槽位片（`aria-pressed=true`，位次 `#1 载荷插槽 (SLOT)`）→
   `recipe-link` 关联 `示例状态包` → SAVE（`已保存 (SAVED) v2`）→ **整页刷新回读**：
   名称 / `层数 3 / 4` / 层序（示例协议壳 → 三层验证壳 → 外层壳）/ 槽片带位次按下 /
   关联 `示例状态包` **逐项一致**，状态 `配方已同步`。
5. **3b② 出线与基线**：选中配方点「封装试发」→ 头部 `WRAP :: 配方 三层壳 (TRI-LAYER)` +
   `SENT: DD CC FA FA ED 00 FA FA 00 00 00 00 00 05 00 08 ED`（17B，与 history
   02:49:20 记录一致）；**刷新取消选中**后头部回 `WRAP :: 组协议`，`SENT` 28B
   `00 00 00 00 00 FA FA … BF 66 EB` —— 与**建配方前的基线帧（history 02:41:52 与
   02:50:27 两条）逐字节相同**（`equalsBaseline=true`）。
6. **3b③ 脏稿闸**：把配方名改成「… · 改名未保存」→ `配方未保存`、
   **封装试发按钮 `disabled=true`**、头部即时跟随草稿名（显示名优先取草稿）；改回原名
   SAVE（`已保存 (SAVED) v3`）→ `配方已同步` + 试发 `disabled=false`。
7. **附加拦截（§6.1 值校验在配方期生效）**：首次拿含 2 个 `underflow=reject` 空槽的富
   协议当 L3 试发 → **400**，detail 逐槽透出「插槽 p-… 欠载：实际 0 字节 / 允许 1 字节
   （underflow=reject）」，UI 出 `SEND FAILED` 不出线；改用无槽外层壳后成功。
8. **洞位填装 → 封装试发链路**：组内补第 2 条绑定（`sample-inst-heartbeat` → 同协议，
   `slot_order=1`）→ 洞位下拉 `0 · 本绑定 → 1 · 本绑定` 换位 → 装配预览
   `HEX STREAM SIMULATION` 的 `[状态块]` 标记同步移位 → `保存更改 (SAVE)`（`2 条未保存
   → 0 条未保存`，history 侧 `slot_order` 对调为 heartbeat 0 / status 1）→ 两次试发出线
   52B 帧**载荷顺序互换**（`FA FA <状态块>` 在前 ↔ `AA 55 <心跳块>` 在前），
   `⚠ 空洞：1 个洞未被载荷填充` 告警照常透出。

**文档同步（本节）**：`DESIGN_CorePipeline.md` §9.7 复跑补记 8 条、`pageStatus.json`
编排页 `nextSteps` 删 3 条已销项（`PAGE_STATUS.md` 再生）、`PLAN_Backlog.md` §1 CP3 行
补人工验证态、`PROJECT_HANDOVER.md` 条目 35/36 待办①销项 + 新条目 41。

**残留（不阻塞，仍开放）**：`pageStatus.json` 协议页 2 条（跨泳道拖拽目视 / slot refs
新语义复测）—— **已同日由 §8.28 收口**；仅剩 `DESIGN_CorePipeline.md` §9.7 ④（应答是否
带转义字节 —— 需真实设备帧或单独拍板）→ **已由 §8.35 收口**（2026-10-02，按公开规范
模拟真机应答复核销项，无需真机帧）。

### 8.28 协议页人工复测收口（slot refs 新语义 4 子项 + 跨泳道拖拽，零代码改动）

**背景**：`pageStatus.json` 协议页两条 `nextSteps` 长期挂着 —— ① 跨容器拖拽落点
`moveNode` 已有 `protocolTree` 单测锁形但「人工跨泳道拖拽目视验证待补」（HANDOVER 11
待办）；② `DESIGN_CorePipeline` 一期 §8.7 ②「slot 作 refs 目标」新语义四子项「人工复测
待补」（HANDOVER 12 待办）。此前失败原因是**用合成 MouseEvent 点画布不触发选中**，本节
改用浏览器工具的**真实点击 / 真实拖拽**（snapshot 取 ref → `click` / `drag`）跑通。

**执行方式**（2026-10-02，`uvicorn :8000` + `vite :5173` 真机）：验证期间的 refs 增删与
拖拽改树只作用于本地会话，验完从库备份 `yorha.db.bak_4bv` 整库还原 —— 还原后基线逐项
一致（protocols 3 / bindings 1 · `slot_order=0` / frame_recipes 0、LENGTH refs 回 3 项、
嵌套容器 children 回 3 项），`yorha.db` 工作树零 diff、不入提交。

**5 项全部通过**：

1. **slot 拾取计数进位**：点 LENGTH 卡 → 属性面板 `结构引用 (REFS)` `3 REF(S)` +
   `SELECT FIELDS`（芯片：固定块 / 固定块 / 新容器）→ 点 `SELECT FIELDS`（按钮变
   `STOP PICKING (DONE)`，拾取态生效）→ 点 SLOT 卡 → **`4 REF(S)`** + 新芯片
   `SLOT ×` + `保存更改 (SAVE)` 出现（脏态）→ SAVE 落库（服务端
   `parameter_config.refs` 4 项、`version` 8）。
2. **自引用 SYS 提示**：拾取态点 LENGTH 自身 → 计数**仍 `4 REF(S)`**（未入 refs），
   状态栏出 **`SYS: 不能引用自身`**。
3. **含槽卡面 `??`**：加槽前 LENGTH 卡面 `3B`（Σ=1+2+0 可定注入）→ 加槽后
   **`LENGTH ?? 1B @06`**（`computeRefsSigma` 对含槽 refs 整卡不注入维持 `??`）；对照：
   既有 CHECKSUM（refs 含槽）同为 `??`，嵌套容器内 LENGTH（refs=固定块 1B 全可定）仍
   注入 `1B`；SAVE 后回读卡面与 chips 一致（`REF SLOT` 角标点亮）。
4. **组装试发 SENT 长度含载荷真值**：编排页封装试发出线 `… ED 00 0E EE 00 01 20 …`
   （28B）→ LENGTH 字节 **`0E` = 14 = 内核 11B + 引用固定块 3B**；改槽 refs **之前**同
   路径出线为 `… ED 00 03 EE …`（`03` = 设计期静态 Σ=3B）—— **同一位 `03 → 0E`，静态
   设计值翻成含载荷真值**。旁证：`POST /compile/wrapped` 用 payload 0/1/2/4/11B 扫描，
   LENGTH 字节 **`03/04/05/07/0E` = payload + 3 线性跟随**；UI 试发出线与 API 编译帧
   **逐字节一致**；`⚠ 空洞：2 个洞未被载荷填充` 照常透出。
5. **跨泳道拖拽落点**：画布 3 泳道（根 `新协议 (NEW)` / 空容器 `新容器 [EMPTY GROUP]` /
   嵌套容器）→ 把嵌套容器里的 `固定块 00 1B @0A` 真实拖到根泳道 `固定块_1 00 00 2B @02`
   卡上 → 落点**贴目标前插**（根泳道 14 卡、`固定块 @02` + `固定块_1 @03`、偏移全量
   重算），嵌套容器剩 2 卡（LENGTH / CHECKSUM），脏态 `保存更改` → SAVE 落库
   （`bd980b3a` 上移顶层 index 2、`c8925b01.children` 剩 2、`version` 9），**UI 三泳道
   与服务端 children 树一致**；截图存证（三泳道 + `4 REF(S)` 芯片 + 跨泳道落点同框）。

**文档同步（本节）**：`pageStatus.json` 协议页 `nextSteps` 两条销项（`PAGE_STATUS.md`
再生）、`PLAN_Backlog.md` 本节、`PROJECT_HANDOVER.md` 条目 11/12 待办销项 + 新条目 42、
§8.27 残留段改写。

**残留（不阻塞，仍开放）**：`DESIGN_CorePipeline.md` §9.7 ④（应答是否带转义字节 —— 需
真实设备帧或单独拍板）→ **已由 §8.35 收口**（2026-10-02）+ 编排页「绑定拖拽排序
（`slot_order` 洞位下拉回写已落地，拖拽交互未做）」**功能项**（非验证项）→ **已排期**
（§8.37 批 R4）。

### 8.29 共享向量收口：验收自动化（CP2b 后置 · 防单侧漂移）

**背景**：CP2b（`da0179d`，2026-10-01）已把 13 个后端 / 6 个前端测试改读
`vectors/*.json`（12 JSON / 15 表、`$v` 特殊值约定、`vectors/README.md` §1–§5 已把
**迁移范围**与**特殊值约定**写清），但当时只做了一次性核对，**没有闸拦住回潮**：
新增表只挂一端、改名忘落 JSON、测试重抄内联字面量、`__pycache__` 混进索引 —— 这些
都会让双端数据**悄悄分叉**且不红。本节把「验收方式」写成用例。

- **后端 5 闸**（新 `backend/tests/test_vectors_manifest.py`）：
  1. **消费矩阵**：每张 `vectors/*.json` 必须同时被后端测试 + 前端测试**真实引用**
     （单侧消费即红 —— 正是手抄时代失守的方式）；两侧**验收单自身不计入消费**，
     只扫描、不钉数据。
  2. **反向引用**：测试里 `load_vectors("<name>")` 引用的表必须真实存在。
  3. **表可读非空**：逐文件逐表读出，空表/形态变化当场红。
  4. **`$v` 纪律**：混键 / 未知值 `ValueError` 拒收（不 fail-open），三态映射
     `Infinity`/`-Infinity`/`NaN` + 标量按 JSON 原型分型回归。
  5. **入库卫生**：`.gitignore` 必须含 `__pycache__/` 与 `*.py[cod]`，且
     `git ls-files` 索引零 `__pycache__`/`*.pyc`（git 不可用 → 该子断言跳过，
     只留忽略规则断言）。核对结论：**当前索引零字节码，忽略规则齐备**。
- **前端 5 例**（新 `frontend/src/utils/__tests__/vectorsLoader.test.js`）：加载器与
  BE `load_vectors.py` 同口径（$v 三态 / 拒错 / 分型）+ `TABLES` 与 `vectors/` 目录
  **同集**（新增 JSON 忘登记 / 删除忘清 → 红）+ 全表 FE 侧可读非空。两侧验收单
  **互不重复扫仓**（后端扫矩阵、前端测自己这半）。
- **新增一张向量表的固定动作**（写进 `vectors/README.md` §6）：落 JSON → 后端引用 →
  前端引用 → 前端 `TABLES` 登记一行，少一步四道闸之一必红。
- **文档**：`vectors/README.md` 新 **§6「验收方式（四道闸 + 固定动作 + 迁移范围）」**，
  原「行注归档」顺延 §7（各表 `#N` 行注索引不变，README §42 的指引文字同样不动）。
- **核对两处旧说法**：① 计划文档**没有**「CP2b 未开工」的残留 —— PLAN §1 CP2b 行
  早已是「已提交 ✅ `da0179d`」，`DESIGN_Decisions.md` D11 实施注同步；② README 的
  页面状态说法确实过期（`Communication Terminal` 仍被写成占位页），**归 §8.31 收敛**。
- **终态**：BE **554/554**（基线 549 + 5）、FE **963/963（65 文件，基线 958 + 5）**、
  `npx vite build` EXIT=0、yorha-ui 校验器 0 违规；**零 DDL** → 无 db 提交。

### 8.30 SQLite 轻量版本化升级机制（DB 升级机制 · 无 Alembic）

**诉求**：表越来越多，单靠 lifespan 里 `create_all`（**只建缺失的表、不给既有表补列**）
+ 手写 `database.ensure_*` 补列自愈 —— 每次加列都要有人记得写、还要兼容旧库，且
`backend/db/migrations/README.md` 直说「没有迁移框架」，**没有可查的版本号、没有升级前
备份、没有升级结果检查**。本节补一个轻量版本化闭环，**不引入 Alembic**。

- **版本表** `schema_migrations(version PK, name, applied_at)`：在 `migrate.py` 里裸 SQL
  `CREATE TABLE IF NOT EXISTS` 建，**不碰 `models.py`**（§0「仅新增表/列」之外的零改动）。
- **顺序注册表** `backend/db/migrate.py::REGISTRY`：`Migration(version, name, apply, verify)`。
  版本号必须从 1 起**连续**升序、名字唯一（断号/重号/重名/空表 → `MigrationError`，
  因为断号意味着中间那条永远不会跑）。当前一条：`0001_baseline`（无 DDL，由 `verify`
  背书「models 全表在位 + 五处 `ensure_*` 自愈列在位」—— 顺带把历史自愈层做一次结果检查）。
- **升级前备份**：既有库（启动前文件已存在）在 apply 任何迁移前整库快照到
  `backend/db/backups/pre-migration-v{a}-to-v{b}-{ts}.bak`（目录已 gitignore；
  快照前 `PRAGMA wal_checkpoint(TRUNCATE)`；同秒重名补序号）。全新库（`create_all`
  刚建出）无存量可毁 → 不备份（`do_backup=not fresh`）。
- **升级结果检查**：每条迁移的 `apply`、`verify`、版本写入是**同一事务**，`verify` 不过
  → 整条回滚、版本不前进；全部执行完再跑 `PRAGMA integrity_check` 终检 + 对**本次**
  执行的 `verify` 复跑一遍（历史检查不随每次启动重放，避免未来 schema 合法演进反而卡启动）。
- **失败可恢复**：`MigrationError` 消息带「已整体回滚 / 库仍为 vX / 升级前快照路径」；
  启动随之失败，**不带半套 schema 服务**。
- **关键技术点 —— 事务化 DDL**：pysqlite 默认「非 DML 语句前隐式 COMMIT」→
  `CREATE TABLE` 落在事务之外，`rollback()` 撤不掉它（实测：默认引擎失败后 `probe` 表
  残留）。用 SQLAlchemy 官方 recipe（连接时 `isolation_level=None` + `BEGIN` 事件显式
  `BEGIN`）建**迁移专用引擎**（`NullPool`，跑完即 dispose），只作用于迁移连接 ——
  **应用侧主 engine 语义一行不动**（实测：专用引擎失败后 `probe` 表被干净撤掉，
  正常 DML 提交与 `integrity_check` 均正常）。
- **职责边界**：表结构权威仍是 `models.py`；既有 `ensure_*` 继续负责存量库补列
  （幂等、先于本模块）；本模块只管**版本记录 / 顺序升级 / 备份 / 结果校验**。
  新库 = 建表 + 记基线；旧库 = 备份 + 记基线；下次字段变更 = 追加一条 `Migration`。
- **调用点**：`main.py` lifespan（`create_all` + 五个 `ensure_*` 之后，升级动作打
  `yorha.migrate` INFO 日志）；手动 `python -m backend.db.migrate status|up`。
- **测试**：新 `backend/tests/test_migrate.py` **18 例**：新库记基线且不备份 / 既有库
  先备份且用独立 `sqlite3` 打开快照读回升级前数据 / 二次运行幂等（不再备份、不再记版本）/
  `apply` 抛错与 `verify` 不过都整体回滚 + 版本不前进 + DDL 撤销 / 错误消息带快照路径、
  新库失败不误报快照 / 基线抓出「缺表」「缺自愈列」两种坏 schema / 注册表纪律四例 /
  `status` 前后态 / 完整性失败必报错（打桩喂坏结果，真写坏文件会在更早读阶段抛）/
  备份目录已 gitignore。**全部跑临时库，不碰 `yorha.db`**。
- **终态**：BE **572/572**（基线 549 + 向量验收 5 + 迁移 18）、FE **963/963** 不变
  （本批零前端改动）、`npx vite build` EXIT=0；**含 DDL → `chore(db)` 单独同步提交**
  （版本表 + 基线行）。`migrations/README.md` 同步改写（原「没有迁移框架」→ 现机制 +
  新增表/列固定动作）。

### 8.31 README 页面状态收敛为单一事实来源（文档批）

**诉求**：项目文档只留一个事实来源。`docs/PAGE_STATUS.md` 已显示通讯调试、数据中心
落地，README 却仍写「占位页」—— 两份手工维护的页面清单迟早分叉。

- **核对结果（两处确实过期）**：① EN README「Current Page Status」列 5 页「接入主链路」
  +「`Communication Terminal` is still a placeholder page」（终端页 2026-09-23 已落地，
  09-30 真机反馈已走完）；② ZH README 同节写「`通讯调试` 与 `数据中心` 仍为占位页」
  （两页均早已落地）。而 `pageStatus.json` 是 7 页全有状态，README 属于第三份清单。
- **改法（两份 README 状态节 → 纯指路）**：明写「**本 README 不维护页面状态**」；
  唯一数据源 = `frontend/src/config/pageStatus.json`，`docs/PAGE_STATUS.md` 是**生成物**
  （附再生命令 `node scripts/generate-page-status.mjs`，禁手改）；「哪页落地/占位」只看
  那份矩阵，进行中工作看 `PLAN_Backlog.md` / `PROJECT_HANDOVER.md`；页面上线**只改一处**。
- **顺带准确性修正**（同一处小改）：① Data Hub「row counts of all seven tables」→ 改为
  **七张被统计的表**逐项列名（status 面板实际就是 7 个 counter：instructions / fields /
  bit fields / protocols / operator templates / bindings / response specs，库内表更多，
  原文会被读成「库里只有七张表」）；② Run Tests 补后端命令
  `python -m unittest discover -s backend/tests -t backend/tests`（原只给前端，与仓库
  实际双端测试口径不符）；③ 目录结构 `main.py` 行改成 lifespan 真实顺序
  （`create_all` + `ensure_*` 自愈 + 版本化迁移 + 种子，见 §8.30），`/db` 行补
  `migrate.py` 版本化升级器。
- **口径**：纯文档批（README / README_ZH / 本节），**不跑测试**；未改
  `pageStatus.json` → 无需再生 `PAGE_STATUS.md`。

### 8.32 关键链路可诊断反馈（组帧 / 发送 / 应答匹配 / 序列执行）

**诉求**：人工操作失败时只有一句 string `detail`（「Invalid payload: …」），说不出**卡在哪一层、
对应哪个字段或步骤、字节有没有真的出去** —— 硬件联调与问题复现全靠猜。四条链路统一成
「`detail` 人话（逐字不变） + `diagnostic` 结构定位」两份并存，互不替代。

- **形状（只做加法）**：新增 `backend/core/diagnostics.py` ——
  - `Diagnostic(stage, code, message, target?, layer?, step?, data_sent?, byte_count?)`，
    `to_dict()` 丢 None 键；未知 `stage` 直接拒收（九个枚举：plan / encode / escape /
    wrap / transport / match / spec / sequence / param）。
  - `DiagHTTPException`（HTTPException 子类）+ `install(app)`（`main.py` 启动时注册）→
    响应体 `{"detail": 原文, "diagnostic": {...}}`；**普通 HTTPException 仍走 FastAPI
    默认 handler，形状不变**；`detail` 恒为字符串（`client.js` 与既有断言零改）。
  - `DiagError(ValueError 子类)`：领域层抛它，既有 `except ValueError` / `detail=str(e)`
    一行不改；四个工具函数 `http()`（message 直接取 detail，两份文案同源）、
    `http_from()`（DiagError 保留自身层号，普通 ValueError 走兜底）、
    `with_detail()`（重写文案但保留层号/定位）、`diagnostic_of()`。
  - **`data_sent` 语义**：完整交给传输层才算 True —— 前置拦截（encode/escape/wrap/spec/
    sequence/param）= False；传输抛错 = False（可能已部分写入，见 message 与 byte_count）；
    **应答匹配失败 = True**（帧确实出线了，只是对不上）。
- **接线（四条链路）**：
  1. **组帧**：`dispatch.py` 原先一整块 `except ValueError` 拆成**转义 / 封装 / hex 解析**三段
     —— 文案与操作顺序逐字不变，只是 400 现在能分清是 escape 还是 wrap 拒的
     （escape 关闭时坏 hex 一路到 hex 解析 = `encode`，开启时先被转义层拒 = `escape`）；
     `recipe_compile.py` 逐层 `build_wrapped` 失败 → `DiagError` 带 `layer=N`（与
     「第 N 层（协议）：」文案同序，1 = stage 0）、协议缺失 404 带 `layer` + `target`；
     `compile.py` 三个入口同口径（`ENCODE_REJECTED` / `ENCODE_ERROR` / `WRAP_*`）。
  2. **发送**：传输失败 502 → `stage=transport, data_sent=false, byte_count=尝试字节`；
     序列互斥 409（dispatch 两路 + `/sequences/{id}/start`）→ `stage=sequence,
     data_sent=false`；序列启动空步骤 / 步骤数据非法 → `stage=sequence|plan` + `target` + `step`。
  3. **应答匹配**：内联 / 持久化 spec 解析 400 → `stage=spec`（`target=response_spec` /
     instruction_id）；事务参数 → `stage=param`（`target=参数名`）；**失败事务新增
     `TransactionRecord.diagnostic`（成功 = null）三态**：transport 错 `data_sent=false` /
     NO_RESPONSE `data_sent=true` / MATCH_FAILED `data_sent=true` 且 `layer` 由
     `STAGE[i]` reason 翻译（与配方 stage 同序）、`target=首条 reason`。
  4. **序列执行**：**ERROR 步必带 `diagnostic`**（`{stage, code, message, step, target,
     data_sent, [layer], [byte_count]}`）—— `PLAN:` → plan、`WRAP:` → wrap（`WrapError`
     可携带来源诊断，层号不丢）、`TRANSPORT:` → transport（带 `byte_count`）；
     `step` = 1-based 步号、`target` = 步 id。`record.sent`（尝试出线帧）与
     `diagnostic.data_sent=false` 同时存在，正是「发过但没送达」的澄清对；
     **成功步不加键**（形状零改）。`sequence.py::_freeze_wrap` 把内层错误包成
     `steps[i]: <原文>` 时用 `with_detail` 保住层号。
- **前端**：`client.js::handleResponse` 把 `error.diagnostic` 挂上，并在消息前压一行摘要 ——
  `[封装 · 第 2 层 · 未发送 · WRAP_LAYER_REJECT] 原文`（`formatDiagnostic` 导出可测，
  缺字段逐段跳过；无 diagnostic 的错误消息逐字不变）。
- **测试**：新 `backend/tests/test_diagnostics.py` **33 例**（诊断对象纪律 / handler 形状含
  「普通 HTTPException 仍只回单键 detail」/ 组帧三态 stage 与文案逐字不变 / 发送 502 + 409 /
  匹配三态含 `STAGE[1]` → layer 2 翻译 / 配方层号两处透传到 `_freeze_wrap` / 序列 ERROR
  步三类 + OK 步不加键）；新 `frontend/src/api/__tests__/client.test.js` **10 例**
  （摘要拼装、错误挂载、向后兼容、`formatApiErrorDetail` 不回归）。全部直调，无 TestClient。
- **终态**：BE **605/605**（572 + 33）、FE **973/973（66 文件）**（963 + 10）、
  `npx vite build` EXIT=0、yorha-ui 校验器 0 违规；**`/dispatch` 缺省裸帧口径逐字节不变**
  （§0，既有向量与字节断言全绿）。

### 8.33 危险操作可恢复性针对性审视（备份恢复 / 数据库改动 / 串口·TCP 配置 / 序列停止）

**方法**：先逐项盘「操作 → 现有护栏 → 缺口 → 要不要改码」，再动代码。结论：**5 处缺口
全部修掉（backend only）**，其余判定为可接受 / 登记 backlog（§8.34）。前端侧先核实了一遍：
恢复、清发送历史、删序列**均已有确认弹窗**且文案写明「不可恢复」/ 快照位置 ✓，无前端改动。

**① 备份恢复（`POST /datahub/restore`）**
- 已有护栏：文件名校验防穿越（`validate_backup_name`）、恢复前 `pre-restore` 安全快照、
  `dispose` + 清 `-wal/-shm/-journal` + 临时文件原子替换、前端确认弹窗与 notice。
- **缺口 1（已修）：恢复后不自愈** —— 老备份缺列、没有版本表，而 `create_all`/`ensure_*`/
  迁移只在启动期跑 → **进程重启前的每一次写入都可能撞缺列报错**。现在恢复当场跑
  「启动期同一套」`create_all` + 5 个 `ensure_*` + 版本化迁移（`do_backup=False`，
  pre-restore 快照就是回退路径）+ `integrity_check`；**只补结构不补数据**（种子交给下次
  启动的幂等播种，避免把用户删掉的数据又种回来）。失败 → 500 且消息**带快照文件名**；
  成功 → 响应新增 `schema{applied, version, integrity}`（只做加法）。
- **缺口 2（已修）：序列运行中可恢复** —— Runner 还在往旧库写。现在直接 409
  （`stage=sequence, data_sent=false`，§8.32 诊断口径）。
- **缺口 3（已修）：恢复出的传输配置要等重启才生效**，且若不摘持久化钩子，
  `persist_hook` 的回写会把 `active_profile_id` 清成 `None`（钩子固定写 None）。现在
  「先摘钩 → 交回配置 → 挂回钩」（沿用 `transport_store` 的启动纪律），响应新增
  `transportConfigRestored`，**激活档案指针原样保留**（有断言）。
- 不改（判定可接受 / 登记）：恢复窗口内并发写 —— notice + 前端弹窗已提示；
  数据导入接口无自动 pre-import 快照 → 登记 §8.34。

**② 数据库改动（schema 与数据）**
- schema：§8.30 已闭环（升级前备份 / 单事务 apply+verify / 版本不前进 / 终检）。
- **缺口 4（已修）：恢复了「更高版本程序」的备份 → 旧程序会拿旧代码盖新库**。
  `run_pending_migrations` 现在在**动任何一列之前**发现 `version > target` 就抛
  `MigrationError`（不备份、不记版本、零改动），提示升级程序或用备份回退。
- 数据：删除类端点均已带引用检查（instruction / protocol / recipe / binding /
  profile / sequence），前端确认弹窗齐全；但**没有软删除/回收站**，误删只能靠 DataHub
  备份回退 → 登记 §8.34。`DELETE /logs` 无前端入口（不可达）✓。

**③ 串口 / TCP 配置（`POST /transport/config`）**
- 已有护栏：整体校验（未知字段 / 超时范围拒绝）、锁内「变更即断开既有连接」原子生效、
  持久化到 `transport_settings` + 启动恢复、`GET /transport/status` 有界状态事件。
- **缺口 5（已修）：持久化失败被 `except: pass` 吞掉** —— 配置内存生效但没落库，
  重启回默认且无人知晓。现在仍「尽力而为不回滚」（语义不变），但记一条 `error` 事件
  「配置持久化失败（重启后可能回默认）：…」，`GET /transport/status` 可见。
- 不改（backlog，2026-10-02）：~~无「上一配置」一键回退~~ → **已由 §8.39（R2）补上**；
  config 期不做预连（连接失败在**发送期**以 502 + `stage=transport` 诊断暴露，§8.32
  已覆盖）。

**④ 序列停止**
- 已有护栏：协作式停止（分片睡眠逐片查停止位）、剩余步补 `SKIPPED`、停止端点恒 200
  幂等、运行态在内存（重启即 idle、定义持久化）、手动发送 ↔ 序列**双向 409 互斥**。
- 判定：**无缺口**。已发出的帧物理上不可撤回（设备侧事实，非缺陷）；停止需等当前
  `transport.send` 在短超时内自然结束 —— 文档已注明，不改。

**改码清单**（零 DDL）：`routers/datahub.py`（restore 三处 + `_heal_schema_after_restore` /
`_reload_transport_after_restore` 两个私有助手）、`core/transport.py`（`get_persist_hook` +
持久化失败留痕）、`db/migrate.py`（版本高于目标即拒绝）。
**测试**：新增 `backend/tests/test_recoverability.py` **7 例**（老备份当场自愈并断言补列+
记版本 / 激活指针不被抹 + 配置当场生效 / 自愈失败报错带 `pre-restore` 快照名 / 序列运行中
409 含 diagnostic / 坏文件名 400×4 / 持久化失败留痕且配置仍生效 / 钩子读写往返），
`test_migrate.py` **+1**（`NewerDbTest`：v2 库拒绝、零备份、版本行原样）。全部临时库。
**终态**：BE **613/613**（605 + 8）、FE **973/973（66 文件）** 不变（本批零前端改动，
FE 相关断言全部复跑通过）、`npx vite build` EXIT=0；**零 DDL → 无 `chore(db)` 提交**。

### 8.34 评审清单收口：过期说法纠正 + 真实缺口登记 + 待拍板项（文档批 · 零代码）

**背景**：把散在三份评审性清单里的说法**逐条与代码、git log 对账**（方法 = grep 代码 +
`git log` 核提交），先把过期说法就地纠正，再登记复核属实的真实缺口，最后单列**需用户
拍板、不可自行推进**的项。同批回填 `PROJECT_HANDOVER.md` 条目 43（本会话五实现批
hash + 本批）。

**A 组 · 过期说法纠正（本批就地改，9 处）**

| 位置 | 原说法 | 纠正后（事实） |
|---|---|---|
| `DESIGN_CorePipeline.md` §9.8 转义条 | 「已知层位不一致…**建议并入批次二**」 | ✅ 已随 CP2 落地（§1 CP2 行「转义层位统一（封装试发改带 `wrap` 下发）」+ §8.19），两条路径同为「套壳前转义内核」 |
| `DESIGN_Decisions.md` D13「边界（转义）」 | 「已知层位不一致（…**待收**）…建议并入批次二（防错）」 | ✅ 已随批次二收口，处置动作写全（复用 1c 改线） |
| `DESIGN_Decisions.md` §拍板后的下一步 | 三条「下一步」当待办列 | 三条**已全部完成**（§0 决策列 D1–D15 已回填 / `DESIGN_CorePipeline.md` 已生成并随 CP1–CP4 更新 / §1 批次表已同步）→ 改存档注 |
| `PROJECT_HANDOVER.md` 条目 31 | 「→ **待办：CP3-3a**」 | CP3 已全部收口（3a–3d = 条目 35–38，人工验证复跑 = 41） |
| `PROJECT_HANDOVER.md` 条目 33 | 「→ 待办：CP2b…→ CP3」 | CP2b = 条目 34；CP3 = 条目 35–41 |
| `PROJECT_HANDOVER.md` 条目 34 | 「→ **待办：CP3（3a 含 DDL…）**」 | CP3 四子批全数收口（3a `e63d76f`+`438f3af` 含 DDL 落库 / 3b / 3c / 3d） |
| `PROJECT_HANDOVER.md` 条目 35 待办② | 「CP3 剩余子批 3b / 3c / 3d」 | 已销（36 / 37 / 38） |
| `PROJECT_HANDOVER.md` §6 目录地图 | `main.py`「lifespan = create_all + 3 种子」；`migrations/*.sql`「无迁移框架」 | lifespan = `create_all` → 5×`ensure_*` → `run_pending_migrations` → 3 种子 → 传输配置恢复 → `diagnostics.install`；版本化迁移在 `backend/db/migrate.py`；**补四行**（`migrate.py` / `backups/` / `diagnostics.py` / `tests/`） |
| EN/ZH `README.md` 页面状态节（**§8.31 批已改，`62fb68a`**） | 「Communication Terminal 仍为占位页」「通讯调试 / 数据中心仍为占位页」 | 改纯指路，唯一数据源 `frontend/src/config/pageStatus.json`（`PAGE_STATUS.md` 为生成物，禁手改） |

**复核属实、不改的说法**（避免把对的「纠正」成错的）：
- **「CP3 已完成」属实** —— 四子批提交齐：3a `e63d76f`+`438f3af` / 3b `c4b1f7f` /
  3c `fbad083`+`17c6830` / 3d `77dd389`+`bb7a0ba`，人工验证复跑见 §8.27；
- **「`definition_hash` 已落地」属实** —— 三个消费方（配方 `core/recipe_compile.py` /
  `routers/binding.py` / `routers/response_spec.py`）全在代码里，grep 命中 21 个 py
  文件；`DESIGN_CorePipeline.md` §9.8 里已划线的「未做」两句正是对的；
- **「`processor.py` / `graph.py` / `Blueprint.jsx` 未接线」属实**（§9 保留勿动）。

**B 组 · 真实缺口登记（复核属实、当前未做）**

- **B1 需真机 / 真实数据才能推进**：
  1. ~~`escape` 反转义**未接进 `response_match`**（`backend/core/response_match.py`
     grep 零命中）→ 「应答是否也带转义字节」在环回下无法定论（§9.7 ④ / D15 关联项 1）~~
     → **✅ 已由 §8.35 收口**（按 DL/T 645 + RFC 1662 两条公开规范模拟真机应答，
     定「先线上、后逻辑」双口径并实现，销 §9.7 ④ 与 D15 关联项 1）；
  2. ~~D13「有 LEN = 不需要转义」是经验判定 → 载荷含定界字节时真实设备是否异常，
     需真机帧目视（§9.7 ① 的观察对象）—— **仍开放**（出线方向，与 §8.35 的应答
     方向不是一回事）~~ → **✅ 已由 §8.51 收口**（2026-10-03，沿 §8.35 同一套方法：
     联网取 **IEC 60870-5-104 / DL/T 645-2007 / Modbus TCP** 三条公开规范的真帧 + 仓内
     `test_wire_delimiter.py` 10 例仿真，**B1 至此整组无开放项**）。
- **B2 纯功能缺口（✅ 已排期 → §8.37 批 R1–R6，2026-10-02 用户授权）**：
  3. 编排页「绑定拖拽排序」**拖拽交互未实现**（现状 = 上移 / 下移按钮；§8.28 标为
     功能项而非验证项）；
  4. ~~**float64 编码仍不可用**（FE 走整数路径 / BE 保持 zeros，两端不一致；N1 已摘
     静默 → `FLOAT64_UNSUPPORTED` 提醒，G7 定案「提醒而非改模板」），真正修复 = 双端
     float64 分支，未立项~~ → **✅ 已由 §8.42（R5）收口**（2026-10-02：双端 float64
     分支 + 向量表 `f64` 组 + 提醒收窄到 4/8 以外位宽）；
  5. ~~数据导入 `POST /datahub/import/*` **无 pre-import 自动快照**（恢复有
     `pre-restore` 快照、导入没有 —— 风险不对称，§8.33 登记）~~ → **✅ 已由 §8.38
     （R1）收口**（2026-10-02：`safety_snapshot()` + 响应 `preImportSnapshot` +
     `pre-import-*` 打 `[快照]` 徽标）；
  6. ~~删除类操作**无软删除 / 回收站**（引用检查 + 前端确认齐全，误删只能靠 DataHub
     备份回退）~~ → **✅ 已由 §8.43（R6-1）+ §8.44（R6-2）全量收口**（2026-10-02）——
     13 表统一加 `deleted_at`（仅新增列）、7 类 `DELETE` 改软删 + 恢复 / 彻底删除、
     新增 `GET /trash` 统一入口 → 误删**不用再靠 DataHub 备份回退**；FE 侧新增回收站页
     `/trash`，并把五处删除确认弹窗由「不可撤销」改「移入回收站、可恢复」；
  7. ~~传输配置**无「上一配置」一键回退**（改错手动改回；持久化失败已可从
     `GET /transport/status` 的 error 事件看到，§8.33 批修）~~ → **✅ 已由 §8.39
     （R2）收口**（2026-10-02：进程内回退栈 + `POST /transport/config/revert` +
     通讯调试页 REVERT 按钮 + `status.configHistoryDepth` 置灰）；
  8. ~~ESLint **存量 1 error 2 warnings**（HEAD 存量，各批不计入验收）~~ → **数字过期，
     2026-10-02 复测纠正**：当前 HEAD 全仓 `npm run lint` = **60 problems（42 errors /
     18 warnings）、26 文件** —— `no-unused-vars` 23 / `react-hooks/exhaustive-deps` 17 /
     `no-useless-escape` 3 / `no-empty` 2 / `react-hooks/rules-of-hooks` 1 / `no-undef` 1 /
     `no-extra-boolean-cast` 1 / `no-control-regex` 1 + 各文件告警。原小数字系早期批次
     口径（§8.7 记录里 `Protocol.jsx` **单文件**即 1 error 2 warnings），此后代码变多
     未复测。「各批不计入验收」的处置**属实且维持**；清理排 **§8.37 批 R3**，自 R3 起
     才把 `npm run lint` 变成验收门槛。→ **✅ R3 已清零（§8.40，2026-10-02）**：`npm run lint` **EXIT=0、0 problems / 0 文件**（原 60 → 0，涉 27 文件）。
- **B3 已立暂缓 / 挂账（只列名，不重复排期）**：§8.14 四项暂缓（CRC 多算法 CCITT /
  CRC32 / LRC、长度域 BE/LE、varint/COBS 组帧、解码回程 bytes→fields）；
  `BUSINESS_SCENARIOS.md` 挂账三项（epoch 模板、加扰 / 混淆、创建后切 op）。
  → **补记（2026-10-03 · §8.49）**：四项里的「**解码回程 bytes→fields**」已由
  **R9 + R10** 收口（§8.47 / §8.48）；余三项按 **C-5 = ①② 触发式、③ 不做**，
  BUSINESS_SCENARIOS 三项仍为「软缺口、有替代、不排期」。

**C 组 · 需用户拍板（不实现，只登记 —— 自主推进到此为止）** → **✅ 2026-10-02 已全部拍板**

> 详版 → §8.36；**拍板结果 → §8.36「拍板结果」表**：C-1 = **A 不立项** / C-2 = **C
> 入库回写**（→ **R9 + R10**）/ C-3 = **C 补域折中**（→ **R1 + R7 + R8**）/ C-4 = **确认
> 接受**（§8.35 已落地）/ C-5 = **①② 触发式、③ 不做**；另拍 **R6 = 13 表统一加
> `deleted_at`**（列方案）。下面 5 条保留原文作**拍板前的登记记录**。

1. **自动选指令路由**：按输入值选指令 / 报文（G1 运行期形态；N3 已明确「多指令
   自动路由为 N3 范围外」）→ 是否立项？**→ 详版 §8.36 C-1**（B 序列级分支 vs
   C 输入值规则表，两个能力、成本差一倍，不可合并拍）
2. **响应报文解码为字段**：bytes→fields 回程（encode-only 既有边界，§8.14 暂缓）
   → 是否立项？**→ 详版 §8.36 C-2**（B 仅展示零 DDL / C 入库回写；**C 是 C-1 选 C
   的硬前置**）
3. **全量项目包迁移**：DataHub 现只出 `instructions + relations + frames`，
   整库 / 全量工程包是否立项？**→ 详版 §8.36 C-3**（注意：整库 backup/restore
   已能搬机，缺的是可读可部分导入 —— 建议 C 补域折中，第一件事 = pre-import 快照）
4. **应答是否带转义字节**（B1-1）→ **✅ 已拍板 = A「应答带转义字节」并已实施**
   （详版见 §8.35：按公开规范定「先线上、后逻辑」双口径，销 §9.7 ④ 与 D15 关联
   项 1；`escape` 关闭时判定路径与存量逐字节一致）—— **本项无需再拍**；
5. **三项暂缓是否重启**：CRC 多算法 / 长度域 BE/LE / varint-COBS → **详版（含举例、
   现状证据、成本、建议）见 §8.36 第 5 条** → **✅ 已按建议拍定（2026-10-02）**：
   ①② **触发式**（真机提出即插队，②可先于①）、③ **明确不做**。

**终态**：纯文档批（零代码、零 DDL、`pageStatus.json` 未动 → `PAGE_STATUS.md` 不重生成）；
同批 `PROJECT_HANDOVER.md` 新增条目 43（本会话**五实现批** hash：`f76d406` /
`8b8fcfc`+`9dad0e1` / `62fb68a` / `46f65a4` / `f1e38ef`，另含本批）+ 目录地图补行。

### 8.35 真机应答口径收口：应答带转义字节 → 「先线上、后逻辑」双口径（销 §9.7 ④）

**批次**：2026-10-02 · **零 DDL**（未改 `models.py` / `database.py`，`yorha.db` 不随本批
提交）；未碰 `processor.py` / `graph.py` / `Blueprint.jsx`；`/dispatch` 缺省口径逐字节
不变 —— `escape` 缺省关闭 ⇒ 收侧 `unescape=None` ⇒ 判定仍走与存量同一条单口径路径。

**背景**：§8.34 B1-1 / C-4 登记 —— `escape` 反转义 grep `response_match` 零命中，
「应答是否也带转义字节」在环回下**无法定论**，`DESIGN_CorePipeline.md` §9.7 必查 ④
与 D15 关联项 1 挂着「需真实设备帧」。本批按用户 2026-10-02 指令**不等硬件**：先搜
公开规范里真机的应答行为，再据此**模拟真机应答**写用例，把口径钉死并销项。

**调研（两条公开规范，都表明转义是链路性质、必然双向对称）**

| 规范 | 变换 | 方向 | L/CS 覆盖哪种字节 |
|---|---|---|---|
| **DL/T 645-2007**《多功能电能表通信协议》 | 数据域发送前逐字节 **+0x33**、接收端 −0x33 | **双向对称** —— 应答帧数据域同样 +33（规范示例报文：请求 `68 … 11 04 33 33 34 33 AE 16`、应答 `68 … 91 08 33 33 34 33 B9 34 33 33 6D 16`） | **线上字节** —— L = 转义后数据域长度；CS 按「已加 0x33 的实际发送字节」累加 |
| **RFC 1662 §4.2 / RFC 1549**（PPP in HDLC Framing） | 0x7D octet-stuffing | **双向对称** —— "sending and receiving implementations"、"Receiving implementations MUST correctly process all Control Escape sequences" | **逻辑字节** —— FCS 在塞字节**之前**算（"After FCS computation, the transmitter examines…"） |

RFC 的转义样例 `0x7D→0x7D5D`、`0x11→0x7D31` **正是本仓转义表的默认示例对**（
`escape.py` 文档里的 `{"7D":"7D5D"}, {"11":"7D31"}`）。

**结论（= §8.34 C-4 拍板 A，一句话：应答带转义字节，两种 LEN/CS 口径都收）**

1. **应答带转义字节** —— 对称是链路性质，真机不会「只发不回」；
2. **L/CS 覆盖哪种字节取决于该层的变换层位，两种规范各占一端** —— 而本仓**自己就是
   混合的**（`escape.py` 模块文档「内核域按逻辑字节、壳域按线上字节」：内核先算
   LEN/CS 再转义 = RFC 1662 型；外壳转义后再算 = DL/T 645 型）。所以这里**没有唯一
   答案，「两种都收」才是自洽解**，任何单选都会把一半真机判成失配；
3. → 收侧口径 = **先线上、后逻辑**（下「实现」三条）。

**实现（3 处，只做加法，成功路径与错误文案零改动）**

- `backend/core/escape.py` 新增 **`unescape_bytes(data, table)`**：`escape_bytes` 的逆
  —— 左到右**最长匹配**、单趟不回扫、空表直通；模块文档补收侧一句。歧义口径与
  RFC 1662 §4.2「发送方必须转义 Control Escape 字节自身」同一条要求（表想可逆，
  转义字节本身要在 `from` 里），配置期**不拒绝**（与 `build_table` fail-open 同纪律）。
- `backend/core/response_match.py`：`match_response` 拆出 `_match_frame`（**单口径原判定，
  逻辑一字未改**），外层加第二口径 —— 第 1 次按**线上字节**判；未过且调用方给了
  `unescape`、且表**确实能改变任一侧字节**时，`sent`/`received` **一并**还原再判第 2 次，
  第 2 次通过即命中（`reasons` 清空）；两次都过不了 → 返回**第 1 次（线上口径）**的
  reasons（诊断以线上字节为准，**绝不 fail-open**）。新参数 keyword-only、缺省 `None`。
- `backend/routers/dispatch.py` `/dispatch/transaction`：转义表提到循环外复用，建
  `rx_unescape`（表空 → `None`）喂给 `match_response`。**`detail` 文案 / 诊断形状 /
  成功路径零改动**；序列 runner 无应答匹配（grep 无调用）不需接线。

**两个设计点的依据**

- **第 2 次为什么要 `sent`/`received` 一起还原**：`echo_header_bytes` 是跨侧比较，
  只还原一侧会拿逻辑头去比线上头，造出新的假失配；
- **为什么必须「先线上」**：套壳帧的外壳 LEN/CS 是在转义**之后**算的（线上自洽），
  第 1 次就过、第 2 次不参与 —— 反过来先还原，线上锚定的字段位置立刻错位。用例
  `test_shell_reply_matches_on_wire_verdict` 钉住「给不给 `unescape` 结果相同」，
  `test_unescaping_first_would_break_it` 钉住次序反了必失配。

**测试（新 `backend/tests/test_real_device_reply.py`，17 例）**

| 组 | 钉住的口径 |
|---|---|
| `UnescapeRoundTripTests` 3 | `vectors/escape.json` 全 7 组向量 `unescape(escape(x))==x`（与 FE 同读一份）／空表直通／最长匹配左到右 |
| `LogicalStyleReplyTests` 5 | RFC 1662 型真机：**不给第二口径时的既有症状**（`LENGTH_MISMATCH(3!=5)` + `CHECKSUM_MISMATCH`）→ 给了即命中；应答确实带转义（逻辑 6B → 线上 8B）；坏帧两次都不过、reasons 不被稀释；表无作用时第 2 次直接跳过 |
| `WireStyleReplyTests` 3 | DL/T 645 型真机：第 1 次（线上）即命中；**反证次序** —— 先还原再判必失配 |
| `WrappedShellReplyTests` 2 | 两层套壳帧线上口径恒成立；改坏内层出 `STAGE[0].CHECKSUM_MISMATCH` |
| `SimulatedDeviceTransactionTests` 5 | 整链路（转义开 → 模拟真机 → `dispatch_transaction`）：逻辑型 OK／线上型 OK／坏帧 FAILED 且 history 照旧 ERROR／**escape 关闭仍是单口径 OK**／环回 echo 字节未被改动 |

**验收**：BE **630/630**（基线 613 + 17）、FE **973/973（66 文件）** EXIT=0、
`npx vite build` EXIT=0、yorha-ui 校验器 2 文件 **0 违规**（本批零前端改动）；
零 DDL → 无 `chore(db)` 提交。

**文档同步（同批）**：`DESIGN_CorePipeline.md` §9.7 ④ 与 §9.8 残留行销项、
`DESIGN_Decisions.md` D15 关联项 1 改已定口径、`PLAN_Backlog.md` §8.27 / §8.28 残留行
加销项注 + §8.34 B1-1 / C-4 标已办 + §1 ⑤ 行结论回填、`pageStatus.json` 协议页
`nextSteps` 末条销项（`PAGE_STATUS.md` 再生）、`PROJECT_HANDOVER.md` 条目 44。

**仍开放（不是 ④，别混淆）**：~~D13「有 LEN = 不需要转义」在**载荷含定界字节**时真实
设备是否异常 —— 这是**出线方向**的观察对象（§9.7 ①），与应答方向无关，仍需真机帧；
§8.34 C 组余下 4 项与 B2 功能缺口见 §8.36 / §8.37。~~
→ **销项注（2026-10-03）**：本段三条已全部收口 —— ① 出线方向由 **§8.51** 销项
（公开规范真帧 + 仓内仿真，不等硬件）；C 组 4 项 → §8.36 已全拍定；B2 功能缺口 → §8.37
R1–R10 已全落地。

### 8.36 五项待拍板详版（每项：现状代码证据 → 到底决断什么 → 举例 → 成本 → 建议）

**批次**：2026-10-02 · **纯文档、零代码改动** —— 把 §8.34 C 组从「一句话登记」展开成
**能直接拍板的详版**：每项给 ① 现状代码证据（文件 + 行为 + grep 结论）、② 要决断的
到底是哪个问题、③ 两个具体例子（一个「选 B/C 才能解」、一个「不做也能过」）、
④ A/B/C 各自成本量级与前置依赖、⑤ 建议与**不做的后果**。

**阅读约定**：成本按本仓既有节奏折算 —— 「1 批」= 实现 → BE/FE 全量测试 →
`npx vite build` → yorha-ui 校验器 → 文档同步 → **一批一提交**；「小 / 中 / 大」指
改动面（文件数 + 是否动判定路径 + 是否 DDL）。**C-4 已由 §8.35 解决**，本节实质
待拍的是 C-1 / C-2 / C-3 / C-5 四项 + C-4 的一句「请确认」。

---

#### C-1 自动选指令路由（G1 的运行期形态）

**现状（代码证据）**

- `TransactionRequest`（`backend/routers/dispatch.py`）只有单条 `hex_string` +
  可选 `instruction_id` —— **发什么由调用方先选好**，没有「按条件选」的入口。
- `sequence_steps` 字段 = `step_order / instruction_id / delay_ms / params /
  payload / plan / wrap` —— **没有 condition / branch / route 字段**；全 backend
  grep `condition|branch|route|jump|skip_to` **零命中** → 序列执行是**严格线性**。
- 设计期已有 N3「组级 presence 三态」：`BUSINESS_SCENARIOS.md` 记「设计期双支并列
  建模 + 运行期 inputs 翻转（**多指令自动路由为 N3 范围外**）」；`PLAN_Backlog.md`
  范围外清单明写「运行期按值自动选指令（多指令路由）、条件表达式」。
- `BUSINESS_SCENARIOS.md`「按输入值选指令模板 / 报文」= 🔴 **未解**，归 G1。

> **→ 上面四条现状已全部销项（本节立项之后，留档不改写）**：`TransactionRequest` 之外新开了
> 独立端点 **`POST /dispatch/routed`（只解析不发送）** + 新表 **`routing_rules`**（R36 ✅ §8.68），
> `sequence_steps` 补 **`condition`** 受限表达式（R26 ✅ §8.58），矩阵行「按输入值选指令模板 /
> 报文」**已翻 ✅**（运行期那一半 = 发前路由 R36–R40 ✅ §8.68–§8.72）。**本节是立项前的现状快照**。

**要决断的问题（一句话）**：要不要让系统**替人选指令**，以及依据是「序列执行到中间
的状态」还是「用户输入的值」—— 这是**两个不同能力**，成本差一倍，**不能合并拍**。

**举例**

- 例 A（**序列级分支**才解得了 → 对应选项 B）：序列「① 读固件版本 → ② 依版本号发
  **A 指令**或 **B 指令**→ ③ 读结果」。现状只能**固定发 3 步**，或把两条路径**拆成
  两条序列**人工切换。加条件后第 ② 步写 `fw_version >= 0x1200 → 执行，否则跳过`，
  一条序列覆盖两代设备。
- 例 B（**发前路由**才解得了 → 只有选项 C 能做，B 做不到）：同一个「执行」按钮，
  输入 `meter_id = 0001` 时该发**指令 X**、`= 0002` 时该发**指令 Y** —— 这发生在
  **进入序列之前**；序列分支只在「已选定的指令链内部」跳转，**结构上解不了**。
- 例 C（**不做也能过**的反例）：设备族只有 2–3 个时，人工在下拉里选指令十秒搞定，
  路由规则表反而多一处要维护的映射（改了指令还得同步改规则）。

**选项与成本**

| 选项 | 内容 | 成本 | 风险 / 前置 |
|---|---|---|---|
| **A 不立项** | 维持「人工选 + N3 设计期双支并列」 | **0** | 无 |
| **B 序列级分支** | `sequence_steps` 加 1 列 `condition`（**仅新增列，合 §0**）+ runner 判后执行/跳过 + 序列页步骤条件 UI + **受限表达式**（只认 `== != > < in`，**无 eval**） | **1–2 批** | 须证「无条件步骤行为逐字节不变」（存量序列全是无条件） |
| **C 输入值 → 指令规则表** | 新表 `routing_rules`（DDL 仅新增表）+ 匹配器 + 规则编辑 UI | **2–3 批** | **撞 §0 硬约束**：`/dispatch` 缺省口径不能变 → 规则匹配只能做成**独立端点**（如 `/dispatch/routed`），不得塞进 `/dispatch` 缺省路径 |

**建议**：本轮 **A（不立项）**；确有跨代设备需求时**只上 B**，C 的「发前路由」留到
真出现「多设备族共用一个入口」再议（且要单独论证 §0 冲突）。**不做的后果**：人工选
指令；多设备族时序列复制多份（维护性下降）—— **功能不缺，缺的是省事**。
**→ 2026-10-03 复议（§8.52）：改选 B 立项 → R26**（C 未立项，仍需单独论证 §0 冲突）。

---

#### C-2 响应报文解码为字段（bytes → fields）

**现状（代码证据）**

- **编码是单向的**：全仓 grep `bytes→fields / decodeFields / decodeResponse /
  parseResponse` **0 命中**；`response_match` 只输出 **pass/fail + reasons**（字节
  差异），**从不回填字段值**。
- `vectors/float_ieee.json` 有 21 组编码向量（`3.14 → 4048F5C3`），**反方向
  `4048F5C3 → 3.14` 没有任何实现**。

**要决断的问题**：命中应答之后，要不要把报文**还原成「字段 = 值」给人看**，
以及要不要**存下来**（展示是瞬时的，入库才能追溯/对账）。

**举例**

- 现状：发「读电压」→ 应答 `4048F5C3 …` → 页面只给 **MATCH OK + raw hex**；人要
  自己对照协议把 `4048F5C3` 心算成 `3.14`。排「发对了但值不对」时每条都要手工换算。
- 选 **B（仅展示）**：历史行直接显示 `voltage = 3.14 V` —— **零 DDL**。
- 选 **C（入库回写）**：`/dispatch/history` 每条带 `fields`，可直接做「上一次 vs
  这一次」对比与趋势。**C 还是 C-1 选项 C 的硬前置**：规则表要按「温度 > 80 再切
  指令」路由，**前提就是先把应答解成值**。

**选项与成本**

| 选项 | 内容 | 成本 | DDL |
|---|---|---|---|
| **A 不做** | 保持 pass/fail + hex | **0** | — |
| **B 仅展示面板** | 命中时按 `stages` / 字段规格**逆向取值**（int / bcd / float / string / bool / time_counter，**与编码器对偶**，可直接拿共享向量做双向验证）+ 发送历史展示 | **1 批**（纯 FE + 只读返回） | **否** |
| **C 入库回写** | B + `dispatch_logs` 加 1 列 `fields_json`（**仅新增列，合 §0**）+ 查询回填 | **2 批** | **是（仅新增列）** |

**建议**：**B 起步**（零 DDL、共享向量天然可反向验证、立刻让「值」可见）；C 等真有
「按应答值决策 / 追溯对账」需求再加。**依赖提醒**：若 C-1 将来选 C，**必须先做 C-2
（至少 B）**，否则规则表没有输入值可匹配。

---

#### C-3 全量项目包迁移（换机 / 跨项目）

**现状（三条路径，均已核对代码）**

1. **整库**：`POST /datahub/backup` = `shutil.copy2` 拷 sqlite 文件 →
   `backend/db/backups/`；`/restore` 回放 + **schema 自愈**（§8.33）。**能搬机**，
   但文件**不可读、不可 diff、schema 版本绑定**。
2. **工程包导出**：`GET /datahub/export/bundle` → `manifest.json + instructions.json
   + relations.json + frames/*`（指令树 + 绑定/应答规格 + 编译骨架帧）。
3. **导入端点**：关系 = `POST /datahub/import/relations`（数据中心页）；**指令** =
   指令页 IMPORT（前端 `analyzeImport` 预览冲突后**逐条 POST**，冲突跳过不覆盖）；
   **协议** = 协议页 IMPORT。

**不进任何包**（13 张表里除 `dispatch_logs` 外还缺 5 张）：`frame_recipes`（配方）、
`sequences` + `sequence_steps`（序列）、`transport_settings`（传输配置）、
`device_profiles`（设备档案）、`operator_templates`（算子模板）。

**要决断的问题**：换机 / 跨项目时**哪一份东西算「项目」** —— 整库（backup 就够）、
可读可部分导入的工程定义（要补域）、还是介于两者之间。

**举例**

- 现状痛点：把源机上做好的 **3 个配方 + 5 条序列 + 传输配置**搬到新电脑 ——
  `bundle` 里**没有它们**；只剩两条路：① 整库 `restore`（**会覆盖新机已有数据**，
  跨 schema 版本靠 §8.33 自愈兜底）；② 在源机**逐条手工重建**。
- 选 **A 的实际含义**：不是「不能迁」—— 整库 backup/restore **确实能搬**，只是
  不可读、不可合并、不可部分导入；三域包解决「读和合并」，其余靠人工。
- 选 **C**：`bundle` 扩成 8 域 + `manifest` 写每域 `domainVersion`，导入仍按域端点
  （复用 CP4-4a 的「upsert / 跳过 / 逐行报告」口径）+ **导入前自动 pre-restore
  快照**（= 与 B2-5「导入快照」**同一个需求**，应同批做）。

**选项与成本**

| 选项 | 内容 | 成本 | 备注 |
|---|---|---|---|
| **A 维持现状** | 整库靠 backup/restore，工程域靠三域包 + 指令页/协议页逐条导入 | **0** | 配方/序列/传输配置换机要重建 |
| **B 整库 ZIP 工程化** | 把 backup 升级成带 manifest 的**全表**导出 | **2 批** | **与既有 backup/restore 重叠**；导入语义（同名覆盖还是跳过）等于自造 mini-backup，风险高 |
| **C 补域 + manifest 折中** | 缺的 5 张表补进 bundle + 配套**按域导入端点** + manifest 域清单 + **pre-import 快照** | **2–3 批**（拆 2 批：先「导出补域」后「导入补端点」） | 整机/跨版本迁移**继续用 backup/restore**（唯一保证 schema 一致的路径） |

**建议**：**C**，且**第一件事就是配 pre-import 快照**（= §8.37 R1，合并推进）；
**不建议 B**（重复造 backup）。

---

#### C-4 应答是否带转义字节 —— **已解决，请确认接受**

§8.35 已拍板 **A「应答带转义字节」**并实现「先线上、后逻辑」双口径，销 §9.7 ④ 与
D15 关联项 1（17 例 + BE 630/630）。**本项无需再拍**，此处只留一句**请确认**接受该
口径 —— 确认后，真机帧只剩 §9.7 ①（载荷含定界字节的**出线**方向）一个用途。
**→ 2026-10-03 补注：该用途亦已由 §8.51 销项，真机帧不再承载任何开放用途。**

---

#### C-5 三项暂缓是否重启（CRC 多算法 / 长度域 BE-LE / varint-COBS）

**要决断的问题**：这三项当初按「无真实设备需求」暂缓，**逐项复核代码证据**后判断
是否已出现重启理由 —— 结论是 **①② 转「触发式」、③ 明确不做**（详见下）。

**① CRC 多算法**（sum / xor / crc16_modbus 之外，如 CRC16-CCITT、CRC32）

- 现状证据：BE `ChecksumHandler` 只有 `sum / xor / crc16_modbus`（CRC16 反射 poly
  `0xA001` / init `0xFFFF`）；FE `formula.js` 的 `ChecksumAlgo` 枚举**声明了 4 个含
  `CRC_32`，但 `calculateChecksum` 无该 case** → 落 default `console.warn` 返回 0。
  已有三道护栏把 CRC_32 挡在外面：`blockTypes.js` 算法下拉**只列 3 项**（注释明写
  「CRC_32 无实现，不列入」）、`validateProtocol.VALID_ALGOS` 3 值、
  `toFrameBlocks.BACKEND_ALGO` 只映射 3 项；`mapChecksumAlgo` 把
  `CRC16_CCITT / CRC32 / unknown / empty` **静默归一成 `CRC_16_MODBUS`**。
- 举例（何时必须重启）：接一台用 **CRC16-CCITT(0x1021)** 的设备 → 现在**连协议树
  都存不进去**（`VALID_ALGOS` 拒），只能改协议迁就算法。
- 成本 ≈ **1 批**：BE 算法白名单 + FE enum / switch / 下拉 / `VALID_ALGOS` 同步 +
  **共享向量补 2–3 组标准 CRC 向量**（双端读同一份 JSON 比期望值）+
  **`response_match._normalize_checksum.VALID_ALGOS` 必须同批改**（否则「发得出去、
  应答判不了」—— 这是**出线/收侧两处白名单成对改动**，必须加用例钉住）。
- 建议：**维持暂缓，改「触发式」** —— 第一台真实设备提出即做，且两处白名单一次改完。

**② 长度域 BE / LE**

- 现状证据：`backend/handlers/length.py` 出线长度域**恒 big-endian**
  （`f"{total:0{n}X}"`，**无 `byte_order` 配置**）；而**应答侧**
  `response_match._normalize_length` **已支持 `VALID_BYTE_ORDERS`（big / little）**
  → **能判不能发**的不对称。
- 举例：设备要求「长度域小端」→ 现在**发不出去**（帧里长度域反了，真机按 LEN 找不到
  帧尾）；反之别人发来小端应答，我们**判得对**。
- 成本 ≈ **1 批**：length 卡加 `byte_order`（`blockTypes.js` 的 `fields` + 出线
  handler + 校验；**收侧已就绪**）+ 2–4 组共享向量（`vectors/little_endian.json`
  现有 674B 可扩）+ 双端测试；**动编码路径 → 必须证明缺省（big）逐字节不变**。
- 建议：**与 ① 同批做或先做**（同属「补齐已判不能发的」，且更小）；触发条件 = 真机
  确认存在小端长度设备。

**③ varint / COBS（变长前缀与定界编码）**

- 现状证据：组帧元素全集 = `container / fixed / bitfield / length / checksum /
  slot`（`frontend/src/config/blockTypes.js`）—— **无变长前缀、无 COBS/HDLC 定界**；
  长度只有「定宽十六进制 LEN」一种。
- 举例：遇到 **Modbus-RTU 那类无长度域**（靠超时分帧）或 **COBS / 0x7E 定界** 的设备
  → 现在表达不了，只能 `fixed` 硬编长度或靠传输层超时兜。
- 成本 ≈ **3–4 批**：新 block 类型（FE 面板 + BE handler + 编码 PASS 顺序 +
  **`stages` 逆向解包** + 应答匹配解包）—— **凡动解包都可能影响现有 stages 判定**，
  属本仓**风险最高一档**。
- 建议：**明确维持暂缓**；真出现时**先只做出线**（不碰解包）单独立项，解包再单独一批。

**C-5 汇总**：①② = **触发式**（真机提出即做，②可先于③之前的任何时点）；③ = **不做**，
若必须做则分「出线 / 解包」两批。
**→ 2026-10-03 复议（§8.52）：三项全数立项** —— ② → **R21**（先做）、① → **R22**、
③ → **R27 出线 + R28 解包**（沿用「拆两批」口径）。
**→ ② 已完成 ✅（2026-10-03，§8.53：R21 长度域 `byte_order`）、① 已完成 ✅（同日，§8.54：R22 CRC 多算法）、③ 出线已完成 ✅（2026-10-04，§8.59：R27 varint / COBS 出线）、③ 解包已完成 ✅（同日，§8.60：R28 varint / COBS 解包）** —— **三项全数销项**。

---

**拍板结果（2026-10-02，用户逐项给出）**

| 项 | 拍板 | 落地含义 | 编入 |
|---|---|---|---|
| **C-1 自动选指令路由** | **A · 本轮不立项** | 维持「人工选 + N3 设计期双支并列」，序列仍严格线性 | 不排批（重启条件 = 真出现跨代设备 / 多设备族共用入口，届时须一并论证 §0「`/dispatch` 缺省口径不变」）→ **✅ 2026-10-06 用户翻案重启**：按**原选项 C（发前路由）**立项，编入 **R36（BE 数据层 ✅ §8.68）+ R37（引用计数与级联 ✅ §8.69）+ R38（管理面 ✅ §8.70）+ R39（加工页接线 ✅ §8.71）**；§0 论证 = 新表属「仅新增表」明文允许、`/dispatch/routed` 是**新增端点**，`/dispatch/` 与 `/transaction` 一行不改 |
| **C-2 响应解码为字段** | **C · 入库回写** | 按选项 C 的定义 = B（解码面板）+ C（`dispatch_logs.fields_json`，**仅新增列**）两步做完 | **R9（B 展示 ✅ §8.47）→ R10（C 入库 ✅ §8.48）—— 两半均已完成** |
| **C-3 全量项目包迁移** | **C · 补域 + manifest 折中** | `bundle` 扩 8 域 + 按域导入端点 + `manifest.domainVersion`；**整机/跨版本迁移仍走 backup/restore**；不选 B（重复造 backup） | **R1（pre-import 快照 ✅ §8.38）→ R7（导出补域 ✅ §8.45）→ R8（导入补端点 ✅ §8.46）** |
| **C-4 应答是否带转义** | **确认接受** | 「应答带转义字节 + 先线上、后逻辑双口径」正式定案，§9.7 ④ 与 D15 关联项 1 销项 | 已落地（§8.35，提交 `dbe15a4`） |
| **C-5 ① CRC 多算法** | ~~触发式~~ | 真机提出 CCITT/CRC32 即做，且**出线 / 收侧 `VALID_ALGOS` 两处白名单同批改**（否则发得出去、判不了） | ~~不排批 —— 触发即插队~~ → **✅ 已销（2026-10-03，§8.52 复议立项 → §8.54 R22 落地）** |
| **C-5 ② 长度域 BE/LE** | **触发式（可先于 ①）** | 真机要求小端长度即做：`length` 卡加 `byte_order`，**收侧已就绪**，只需证明缺省大端逐字节不变 | 不排批 —— 触发即插队 |
| **C-5 ③ varint / COBS** | **明确不做** | 保持暂缓；真机真要求时**先出线、解包另批**（动 `stages` 属最高风险档） | 出列 |
| **R6 方案** | **13 表统一加 `deleted_at`** | **列方案**（**仅新增列，合 §0**）+ 读端点过滤 + 回收站页；**不做 `trash_bin` 新表** | R6 按此实施（原「列 vs 表」待拍项就此关闭） |

**排期合计（R1–R10）= 11–12 批**：R1–R6 原 **7–8 批** + R7–R8（C-3，2 批）+
R9–R10（C-2，2 批）—— 明细与追加理由见 §8.37。**✅ 11 批已全数完成
（R1–R10，2026-10-03 收尾 R10 §8.48）**。

### 8.37 B2 六项功能缺口排期（用户授权「可以进行排期」）

**批次**：2026-10-02 · **纯排期文档、零代码改动** —— §8.34 B2 组 6 项排队；排序原则
= **先补安全网 → 再清欠账 → 再体验 → 再正确性 → 最后动 DDL 的大件**。每批仍走既定
节奏：**实现 → BE/FE 全量 → `npx vite build` → yorha-ui 校验器 → 文档同步 → 一批一
提交**；涉及 DDL 的单独 `chore(db)` 提交。

| 批 | 缺口（§8.34 B2 编号） | 层 | 量级 | DDL | 关键纪律 / 依赖 |
|---|---|---|---|---|---|
| ~~**R1**~~ ✅ | 5 · 数据导入无 **pre-import 自动快照** → **已落地（§8.38）** | BE | 小（1 批） | 否 | ✅ **2026-10-02 完成**：镜像 `pre-restore` 先例，新增 `safety_snapshot()` 收口「先快照、失败即中止」；顺序 = 校验 → 快照 → 回灌（**400 不落垃圾快照**、快照失败 500 且一行未写）；响应加 `preImportSnapshot`（只做加法）；`pre-import-*` 与 `pre-restore-*` 同打 `[快照]` 徽标。**与 §8.36 C-3 选 C 的前置是同一件事** → R7/R8 可直接复用 |
| **R2** | 7 · 传输配置无**上一配置回退** → **已落地（§8.39）** | BE+FE | 小（1 批） | 否 | ✅ **2026-10-02 完成**：`transport.set_config` 每次真变更压栈（有界 20）+ `revert_config()` 弹栈 + `POST /transport/config/revert`（无历史 → 400）+ `status.configHistoryDepth`（0 → 按钮置灰）+ 通讯调试页 REVERT 按钮；生效语义与 APPLY 一致（断连 + 落库 + 留痕），**回退本身不入栈**（可连退多版、退空即止），**启动装载不入栈**（`record_history=False`，否则一开机点回退就被重置回默认）；零 DDL → 栈重启即空 |
| ~~**R3**~~ ✅ | 8 · **ESLint 存量**清理 → **已清零（§8.40）** | FE | 中（1 批，**60 problems / 26 文件**） | 否 | ✅ **2026-10-02 完成**：`npm run lint` **EXIT=0、0 problems / 0 文件**（60 → 0，涉 27 文件）。**纪律落地 = 只删未用变量 + 加带理由的 disable，不改行为**；过程中撞出 **2 处真问题并顺手修掉**：`ParamConfigForm` 的 **conditional hook**（`if (!template) return null` 写在 `useEffect` 之前 → op_code 切到无模板指令时**钩子数跳变**，已改成「无模板判断进 effect 体内 + 早退挪到钩子之后」）、`NieRDatePicker` 的 **先用后声明**（`initDate` 声明在 effect 之后，已重排）。`no-control-regex` = **有意的**控字符校验 → 注释 disable。**自本批起 `npm run lint` EXIT=0 进验收门槛** |
| ~~**R4**~~ ✅ | 3 · 编排页**绑定拖拽排序** → **已落地（§8.41）** | FE | 中（1 批） | 否 | ✅ **2026-10-02 完成**：拍板口径 = **拖完只改展示序，点保存按钮才改持久序** —— 拖拽只在本地重写 `slot_order`（侧栏展示序按 (协议序, 洞号) 派生 → 立刻重排、填装预览跟着变），**零即时 PUT**；「保存更改 (SAVE)」才把**真变化的行**逐行落库，与洞位下拉**同一条持久化路径**，**零 BE 改动**。实现 = `utils/reorderBindings.js` 纯函数（拖拽/下拉共用，跨协议组直接忽略）+ `@dnd-kit/core` 把手（8px 起拖，只挂 listeners 不挂 attributes）+ `BindingRow` 抽组件（**钩子不进 `.map()`**）。**更正原行「现状 = 上移/下移按钮」**：实测**只有洞位下拉、无上下移按钮**；原行提的丢弃提示 —— 刷新**已有** `beforeunload` 拦截（`dirtyRef`）、协议切换**不丢稿**（脏行按行驻留），故**无需新增** |
| ~~**R5**~~ ✅ | 4 · **float64 编码**双端不一致 → **已落地（§8.42）** | BE+FE+向量 | 中（1 批） | 否 | ✅ **2026-10-02 完成**：`byte_len=8` 双端真出 IEEE 754 float64 大端 —— BE `encode_float_ieee(value, byte_len=4)`（**缺省参 = 存量 f32 行为**）+ `>d`、`datahub.to_block` 分派 `byte_len in (4, 8)`；FE `getFieldBytes` 改 `byteLen ∈ {4, 8}` → `Float64Array`；`vectors/float_ieee.json` **分组 `f32`（22 行，一字节未改）/ `f64`（23 行，新）** —— `bcd_scaled.json` / `time_counter.json` 本就是「同语义多表」分组先例，同一解析口径只差位宽放同一文件；提醒 `FLOAT64_UNSUPPORTED` **收窄**为 `FLOAT_IEEE_WIDTH_UNSUPPORTED`（只报 4/8 以外）；`resolveRunnerKind` 章按位宽出 F32 / F64。**更正原行「`response_match` 解码侧同步（否则能发不能判）」—— 实测不成立**：`backend/core/response_match.py` 全文 **零值解码**（547 行只做 prefix / suffix / echo_header_bytes / length / checksum / unpack 六类**字节级**比对，`sent`/`received` 都是 `bytes`；全仓 grep `struct.unpack`、`'>f'`、`'>d'` 零命中）→ 判定天然与位宽无关，**`response_match` 零改动**；真缺口在**编译侧 `datahub.to_block`**（保持 zeros → 服务端编译/导出与 FE 两套帧），本批一并修。**缺省逐字节不变证明** = `f32` 22 例两端原样全绿 + `encode_float_ieee` 单参回归 + `test_default_arg_stays_f32` 显式断言 `f(v) == f(v, 4)` + 改前 BE 644 / FE 990 全量零改动全绿 |
| ~~**R6**~~ ✅ | 6 · **软删除 / 回收站** → **已落地（R6-1 §8.43 + R6-2 §8.44）** | BE+FE | 大（2 批：DDL + FE） | **是（仅新增列）** | **拍板 = 13 表统一加 `deleted_at`（仅新增列，合 §0）+ 读端点过滤 + 回收站页，不做 `trash_bin` 新表（§8.36「R6 方案」行）。** ✅ **R6-1 2026-10-02（§8.43）**：DDL 走**已有的版本化迁移** `Migration(2, "soft_delete_deleted_at")`（apply = 逐表 `PRAGMA` → 缺则 `ALTER ADD COLUMN`，新库 `create_all` 已带 → 只验不改；verify = 13 表每张都有列，缺一回滚；既有库升级前自动整库备份；启动接线零改动）；写侧收口在 `backend/db/soft_delete.py`（`mark_deleted` / `mark_related` / `restore_related` / `purge_related` / `alive` / `trashed`）—— **级联共用同一时间戳 = 恢复判据**（不加级联标记列，独立入站的子行戳不同 → 不被父行恢复顺带捞回）；7 类可回收的 `DELETE` 改软删且**回执形状与计数键逐字不变**，读端点 `alive()` 过滤 → **列表不出现 / 单查 404 / 二次删 404 与改前硬删后同口径**；新增 `GET /trash` + `POST /trash/{kind}/{id}/restore` + `DELETE /trash/{kind}/{id}`（**kind 白名单**、列表**隐藏被父行连带入站的子行**）；`datahub` 导出 / 状态计数 / 导入宿主校验三处读侧也过滤；`dispatch_logs` / `operator_templates` / `transport_settings` 只加列不改行为。**已知取舍（§8.43 四）**：软删行**继续占唯一键**（三条 inline UNIQUE 是 `sqlite_autoindex_*`、删不掉 → 同名重建 400「已存在」、彻底删除才释放）；`response_specs` **upsert 复活**（同 id、不撞键）；配方/档案指针**删除期解除、恢复不回填**（读侧按「无配方」降级、前端回退路径原样可用）。测试 648 → **668（+20）**。 ✅ **R6-2 2026-10-02（§8.44）**：**零 DDL、零 BE 改动** —— 新增回收站页 `/trash`（`pages/Trash.jsx` + `App.jsx` 路由 + `pageStatus.json` 第 8 页、快捷键 `G`、`PAGE_STATUS.md` 已重生成）：列条目（7 类中文 / 名称 / 秒级 `UTC` 删除时间，最近删的在前）、`恢复 RESTORE` 直调、`彻底删除 PURGE` 过 `NieRModal` 不可逆确认、空态 / 错态重试、**口径面板常驻**（唯一键占用、指针不回填、日志不进站）；`api/trash.js` 三端点进 barrel，**FE 不兜白名单第二层**（白名单外 404 / 活行 400 detail 原样透出）；**五处删除确认与回执文案改口径**（指令 `describeReferences` / `describeDeletion`、协议弹窗与状态条、序列、配方、档案）由「永久删除 / 不可撤销 / 须重新新建」改为「移入回收站、可在回收站页恢复」，**不可逆警告只保留在 `PURGE` 确认里**；**各弹窗首句前缀一律不改** → `Terminal` / `Sequences` / `Protocol` 既有断言零改动通过；`App.jsx` 存量 5 处 yorha-ui 违规同批清零（去 backdrop-blur 改实底、`p-6` / `py-6` / `px-6` 收紧，第 4 批 `NieRDatePicker` 先例；stash 证 HEAD 同样存在 → 新增违规 0）。测试：新增 `trash.test.js` 5 例 + `Trash.test.jsx` 8 例、改写 `useInstructionData.test.js` 7 处断言 → **FE 1020 → 1033（+13，69 文件）**，BE 维持 **668** |

**R3 实测分布**（`npm run lint`，HEAD 实测，用作排期依据）：`no-unused-vars` **23** /
`react-hooks/exhaustive-deps` **17** / `no-useless-escape` 3 / `no-empty` 2 /
`react-hooks/rules-of-hooks` **1** / `no-undef` 1 / `no-extra-boolean-cast` 1 /
`no-control-regex` 1，余下为各文件告警 —— 合计 **60（42 errors / 18 warnings）、26 文件**。

**合计 7–8 批**（R1/R2/R3/R4 各 1、R5 1–2、R6 2）。

**为什么是这个顺序**

1. **R1/R2 先行**：两项都是「出事了能回退」的**安全网**；R1 还与 C-3 选 C 同源，
   先做可被 C-3 复用；
2. **R3 次之**：清存量欠账要在**大量改代码之前**做，否则后续每批都绕着 60 条噪声走
   （各批**不计 lint 入验收**正是为此 —— 先还债，再把 lint 变成门槛）；
3. **R4 再次**：纯 FE、零 BE 风险的体验补齐；
4. **R5 靠后**：动**编码器**（两端）+ 向量表，必须带「缺省逐字节不变」证明；
   现有 `FLOAT64_UNSUPPORTED` 提醒让它可以安全排队；
5. **R6 最后**：唯一要动 DDL 的、面最广（13 张表），放其余五项落地后再动。

**验收口径（每批）**：BE `python -m unittest discover -s backend/tests -t backend/tests`
全绿、FE `npx vitest run` 全绿、`npx vite build` EXIT=0、yorha-ui 校验器 0 违规、
`pageStatus.json` 有改动则重生成 `PAGE_STATUS.md`；**自 R3 起加 `npm run lint`
EXIT=0**（R1/R2 不提前引入 lint 门槛，避免把存量债转嫁到功能批；R3 已把存量清零 →
**R4/R5 起该门槛对每一批同样生效**）。

**拍板后追加（2026-10-02 拍板 → §8.36 拍板结果表）—— R7–R10**

| 批 | 来源 | 内容 | 层 | 量级 | DDL |
|---|---|---|---|---|---|
| ~~**R7**~~ ✅ | C-3 选 C · **导出补域** → **已落地（§8.45）** | **BE（FE 仅文案 + 注释）** | 中 | 否 | **拍板 = `bundle` 增 `recipes / sequences / transport / profiles / templates` 5 域（原 3 域 → 8 域）+ `manifest.domainVersion` 域清单 —— 本批只做出线，不碰导入。** ✅ **2026-10-02（§8.45）**：ZIP 顶层 8 个数据域 = 既有 `instructions.json` / `relations.json` / `frames/*` + 新增 5 个（`recipes` / `sequences` 内嵌步骤 / `transport` 单行 / `profiles` / `templates`）；**读侧一律 `alive()`** —— 六类回收站行不进包、序列步骤靠 `sequence_id IN (导出序列)` 天然跟随宿主；**列子集不含 `deleted_at`**（回灌后恒活行）+ 行序显式排序（序列 `(name,id)`、步骤 `(step_order,id)`、档案 `(label,id)`、算子 `op_code`、配方与绑定 `id`）→ 导出可 diff。`manifest` 加 `domainVersion`（8 域清单，键序 = 导出序）与 `domainCounts`（**键集与 domainVersion 严格相等**，纯函数 `bundle_manifest()` + 漂移守卫 `ValueError: 域清单不一致`），存量三键 `instructionCount` / `relations` / `frames` 只做加法。**同批修回 R6-1 丢失的 `export_bundle` 指令 / 绑定 / 应答规格 `alive()`**（该批编辑报成功未落盘且当时无测试盯，本批端到端测试把六处排除钉死）。**零 DDL、零新端点**（按域导入 = R8）。已知观察：拍板 5 域**不含 `protocols`** —— 换机须先经协议页导入协议，配方与绑定才认得出宿主（是否加第 9 域留 R8 决策）。测试 **668 → 676（+8）**。 |
| ~~**R8**~~ ✅ | C-3 选 C · **导入补端点** → **已落地（§8.46）** | BE+FE | 中 | 否 | **拍板 = 按域 upsert / 跳过 / 逐行报告（复用 CP4-4a `import/relations` 口径），导入前自动快照直接复用 R1 成果。** ✅ **2026-10-02（§8.46）**：`POST /datahub/import/` 补 5 条路径（`recipes` / `sequences` / `transport` / `profiles` / `templates`），回执统一 `{domain, imported, updated, skipped, warnings, preImportSnapshot}`（sequences 另带 `steps.written`）；三段式收在 `run_domain_import()` —— ① 纯函数顶层校验（非对象 / 未知键 / schemaVersion 不符 / 缺数组 → **400 不落快照**）→ ② `pre-import` 快照（复用 R1，失败 500 中止且库未被改）→ ③ 逐行独立提交（`IntegrityError` 只回滚该行 → `skipped` 带 index+id+reason，**部分成功即部分落库**）。**校验复用各域 SSOT 不写第二套**：配方 = `recipe.resolve_stages`（**definition_hash 按目标机重算**，不采信载荷）；序列 = `routers/sequence` 新抽的共用入口 `normalize_sequence`（`create` / `update` 改调之、行为逐字不变）+ 公开 `write_steps`，任一步骤宿主缺失则**整条跳过**；传输与档案 = `core.transport.validate_config`（**悬空档案指针置空并记警告**）；算子 = 形态校验 + 按 `op_code` 天然 upsert。**回收站边界**：宿主在站里 → 跳过；**自己的 id 在站里 → 跳过并提示先恢复或彻底删除**（软删行继续占唯一键，否则写出一条看不见的行）；`label` / `name` 撞车（含被回收站行占着）→ 跳过并指出占用行。FE：DataHub 新增「按域导入」面板，一个选择器按**顶层数组键**自动识别域名（`settings` → `transport`），二次确认后 POST，识别不出域不出弹窗；`api.importDomain` **不兜白名单第二层**。测试 BE **676 → 685（+9）**、FE **1033 → 1036（+3）**；**零 DDL**。回灌路径全景见 §8.46 五（协议仍走协议页导入，C-3「8 域」未扩为 9）。 |
| ~~**R9**~~ ✅ | C-2 选 C · **解码展示面板** → **已落地（§8.47）** | FE | 中 | 否 | **拍板 = 命中应答按 `stages` 逆向取值（**与编码器对偶**，拿 `vectors/*.json` 反向验证）+ 发送历史显示 `字段 = 值`，层 = FE、零 DDL。** ✅ **2026-10-03（§8.47）**：新增 `utils/InstructionDecoder.js` —— 布局与编码器**共用一份**（树布局抽成公开 `InstructionEncoder.buildLayout()`；组 `align` / `pad_to` / `repeat` / `presence` 逐字镜像进解码游标；**叶字节长度向 `getFieldBytes` 要**、值从帧里读，故是结构对偶而非第二套实现），值分派与 `_encodeFieldBytes` 同序（静态 hex → 文本 → 旧 float/decimal → 纯 hex → BITFIELD → 两补码 → BCD → FLOAT_IEEE 大端 → 缺省无符号 + `SCALED_DECIMAL` 反定标，LITTLE 先整体还原）；反向验证 = **`encode ∘ decode = id` 不动点**，扫 `float_ieee` / `int_signed` / `bcd_scaled` / `string` / `little_endian` / `bitfield` / `time_counter` 七组向量 + 一例整帧（组 `align` + `repeat ×3` + `presence` + LITTLE 混排）；接入两处 —— 事务面板 `TXN_OK` 出 `DecodedFields`、发送历史加「字段 FIELDS」列 + 详情完整字段表（解**响应**帧、`historyRows` 缺 ctx 时行形状逐字不变）；短帧标 `truncated`、尾部残字节计 `residual` 并告警，无字段布局 / 解不出一律不出面板（登记三条已知不可逆：f32 溢出位型、utf8 定长截断、AUTO_COUNTER 状态机）；**纯 FE 零 DDL**，测试 +30 → 1066 |
| ~~**R10**~~ ✅ | C-2 选 C（后半） · **入库回写** → **已落地（§8.48）** | BE+FE | 中 | **是（仅新增列）** | **拍板 = `dispatch_logs` 加 `fields_json`（**仅新增列，合 §0**）+ `/dispatch/history` 回填 `fields`。** ✅ **2026-10-03（§8.48）**：**全计划唯一 DDL 批**走既有版本化迁移 —— `migrate.py` 追加 `Migration(3, "dispatch_logs_fields_json")`（apply = 缺则 `ALTER TABLE dispatch_logs ADD COLUMN fields_json JSON`、新库 `create_all` 已带 → 只验不改；verify = 补列范围**恰好 `dispatch_logs` 一张**、列缺失即报错），`models.py` `DispatchLog` **仅新增**一列。**布局不写第二套**：解码复用编译侧 SSOT `fields_to_blocks`（presence / repeat ×N / endianness / align / `pad_to` 全在里面）+ `Orchestrator` 抽出的公开 `flatten()`（编码 `process()` 与解码共用同一份扁平流，纯重构）；值分派与 FE `decodeFieldBytes` **逐条同序**，**非有限浮点落库前折字符串**（`"Infinity"` 等，否则 `json.dumps` 出非法 JSON → 响应层 500）。**分层**：`_presence_hit` + `fields_to_blocks` 纯搬进 `core/field_blocks.py`，`datahub` **原名再导出**（测试一行未改）。**单一接缝** = `db/log_store.record_log` 自动回填（四条写入缝 manual / transaction / sequence / replay 全过；序列跑在 daemon 线程、回放没有表单输入，靠各调用方自己记得算靠不住），`resolve_log_fields` **绝不抛**（解码炸了不能反噬写日志 → 异常消息写进 `warnings` 落库）；无应答 / 指令不可解析 / 无字段布局一律 `NULL`（**空布局不出假 `residual` 警报**，与 R9 同口径）。两处回执：`DispatchRecord.fields`（与 `fields_json` **同一次解码**，绝不各算一遍）+ `/logs` `DispatchLogOut.fields`（列名 `fields_json` → 对外一律 `fields`，`AliasChoices` 同认 ORM 形与 dict 形）、JSON 导出带 `fields`、**CSV 列集 `_CSV_COLUMNS` 逐字不变**。FE `decodeHistoryRow` **优先吃 `record.fields`**（指令后来删/改也解得出、序列 daemon 帧也有上下文），空壳 / `null` / 存量行回落 R9 客户端解码、**行形状逐字不变**。存量行**不回填**（只 `ADD COLUMN`，展示层兜底）。测试 BE **685 → 723（+38：新 `test_field_decode` 35 + `test_migrate` 3）**、FE **1066 → 1069（+3，71 文件）**；`test_soft_delete` 的 0002 断言改为「从 0001 起全部待执行迁移、0002 排第一」（新增迁移不再硬编码） |

**为什么排在 R6 之后**：R1–R6 的顺序是你已批准的「安全网 → 清欠账 → 体验 → 正确性
→ 最后动 DDL」，**不在中途插队**；且 R7/R8 与 R1 同属 `datahub` 模块，实施时直接复用
R1 的快照函数。**排期合计 R1–R10 = 11–12 批 —— ✅ 已全数完成（§8.38 → §8.48）。**

**仍排期外**：**C-1 = A（不立项）**；**C-5 ①② = 触发式**（真机提出即插队）、**③ = 不做**；
§8.34 B1 组 2 项仍需真机（D13 载荷含定界字节的出线方向 / §9.7 ①）。

### 8.38 R1 · 数据导入 pre-import 自动快照（排期首项落地）

**批次**：2026-10-02 · **零 DDL**（未改 `models.py` / `database.py`，`yorha.db` 不随本批
提交）；未碰 `processor.py` / `graph.py` / `Blueprint.jsx`；`/dispatch` 缺省口径不变；
**后端 only、零前端改动** —— 快照文件名可从 `GET /datahub/status` 的 `backups` 列表看到
（带 `[快照]` 徽标），不必改前端。

**背景**：§8.34 B2-5 → §8.37 **R1** —— 恢复前有 `pre-restore` 快照、**导入没有**，属
风险不对称；C-3 选 C（§8.36 拍板）之后「导入前必须能回退」又成了 R7/R8 的硬前置，
所以排在首项。

**实现（3 处，全在 `backend/routers/datahub.py`）**

1. **新 `safety_snapshot(prefix, scenario, db_path=None, backup_dir=None)`** —— 把
   「先快照、失败即中止」这条不变量收成一处：`db_path` / `backup_dir` 缺省取模块级
   `DB_PATH` / `BACKUP_DIR`（**运行时**取值，测试可替换）；库文件不存在 → 返回 `None`
   **不报错**（首次使用前无从快照）；`OSError` → HTTPException **500** +
   `安全快照失败，已中止{场景}：{exc}`。R8 要补的其它导入端点直接复用。
2. **`POST /datahub/import/relations` 顺序改为 ① 顶层校验 → ② 快照 → ③ 逐行回灌**：
   ① `_relations_payload()` 是纯函数，**400 时既不落快照也不写库**（不留垃圾快照）；
   ② 失败 → 500 中止且**一行未写**（此时压根不需要回退）；③ 内部再校验一次（同一纯
   函数，幂等）。响应新增 **`preImportSnapshot`**（只做加法，`null` = 库文件不存在）。
3. **`_backup_entry.isSafetySnapshot` 改用常量 `SAFETY_SNAPSHOT_PREFIXES =
   ("pre-restore-", "pre-import-")`** —— 否则 `pre-import-*` 在备份列表里长得和手建
   备份一模一样，用户看不出该拿哪个回退。FE 该徽标只渲染 `[快照]` 文字、恢复按钮对所有
   条目都可点 → **不改任何现有语义**。

**测试（`backend/tests/test_datahub.py` 新 `TestImportPreSnapshot`，6 例，直调路由
函数不走 TestClient，沿 `test_bindings.py` 惯例）**

| 用例 | 钉住的不变量 |
|---|---|
| `test_snapshot_taken_before_write_and_reported` | 快照在写库**之前**留下、名字 `pre-import-*`、字节 = **回灌前**的库、响应回报该名；回灌照常 `imported=1`，原有键一个不少 |
| `test_invalid_payload_400_leaves_no_snapshot_and_no_write` | 400 → **零快照文件**且零写入（校验先行） |
| `test_snapshot_failure_aborts_import_with_500` | 快照目录位被同名文件占住 → 500、文案 `安全快照失败，已中止导入：`、**一行都没写** |
| `test_missing_db_file_skips_snapshot_but_import_works` | 库文件不存在 → `preImportSnapshot=null`，导入照常 |
| `test_helper_maps_oserror_and_tolerates_missing_db` | helper 两条分支（缺库 → `None`；快照失败 → 500 带场景词） |
| `test_pre_import_flagged_as_safety_snapshot` | `pre-import` 与 `pre-restore` 都打 `[快照]`、手建备份不打 |

（`setUp` 替换模块级 `DB_PATH` / `BACKUP_DIR` 后**必须在 `tearDown` 还原** —— 沿 §8.35
`transport.send` 泄漏的教训。）

**验收**：BE **636/636**（基线 630 + 6）、FE **973/973（66 文件）** EXIT=0、
`npx vite build` EXIT=0、yorha-ui 校验器 `DataHub.jsx` **0 违规**（本批零前端改动）；
零 DDL → 无 `chore(db)` 提交。

**文档同步（同批）**：`pageStatus.json` 数据中心页「关系数据回灌」补 pre-import 快照
口径（`PAGE_STATUS.md` 再生）、本节 §8.38、§8.37 R1 行标已办、§1 `R1–R10` 行状态、
§8.34 B2-5 标已办、`PROJECT_HANDOVER.md` 条目 47。

**范围说明（口径，不是缺口）**：本批只覆盖 `POST /datahub/import/*`（§8.34 B2-5 原文
口径）—— 该前缀下当前只有 `relations` 一个端点。**指令页 / 协议页的逐条 JSON 导入走
`POST /instructions/` 等端点，不在本批**：它们是逐条 create + 唯一冲突跳过，语义与
「整包回灌」不同；需要同等快照时另立批次。

### 8.39 R2 · 传输配置「上一配置」一键回退（进程内回退栈 · 零 DDL）

**批次**：2026-10-02 · **零 DDL**（不动 `models.py` / `database.py`，`transport_settings`
单行表结构不变）；未碰 `processor.py` / `graph.py` / `Blueprint.jsx`；`/dispatch` 缺省
口径不变；**BE + FE**。

**背景**：§8.33「不改 backlog」/ §8.34 B2-7 → §8.37 **R2** —— 改错配置只能手动改回来。
§8.33 修好的「持久化失败留痕」是**事后**从 error 事件里看见的，缺一个**当场**回退的动作。

**实现（3 个文件 + 1 个 FE 页）**

1. **`backend/core/transport.py` —— 回退栈本体**
   - `_config_history = deque(maxlen=_MAX_CONFIG_HISTORY)`（**20**）：`set_config` 里
     配置**真的变了**时把被替换掉的旧版本压入；新增 `record_history` 参数（缺省 `True`，
     只做加法）。
   - `revert_config()`：**弹栈** → `validate_config` → 断开真实连接 → 持久化 →
     `_record_event("config", "已回退到上一配置")`；返回 `{config, historyDepth}`；
     栈空 → `ValueError("没有可回退的上一配置")`。
   - `get_config_history_depth()`；`get_status()` 新增 **`configHistoryDepth`**（只做
     加法）；`reset()` 一并清栈（否则上一轮测试留下的栈让 reset 后**还回得去**）。
   - `_persist_best_effort(config)` 从 `set_config` 里**抽出**（原为内联 try/except），
     `set_config` / `revert_config` 共用 —— 否则回退路径会把「失败仍生效但要留痕」那段
     再抄一遍，将来改留痕文案就漏一处。

2. **两条关键语义**（写在 docstring 里，属于一改就错的那种）：
   - **回退本身不入栈** —— 否则退完一步立刻又能「回退回退」振荡回去，栈永远退不到空；
   - **启动装载不入栈**（`transport_store.restore_transport_config` 传
     `record_history=False`）—— 否则一开机栈里就躺一份**默认配置**，用户什么都没改点
     回退会被莫名重置回默认。档案激活属用户动作，**照常入栈**。

3. **`backend/routers/transport.py`**：`POST /transport/config/revert` →
   `{config, historyDepth}`；`ValueError` → **400**（前端按钮本就由 depth 置灰，正常
   走不到这条）。

4. **`frontend/src/pages/Terminal.jsx`**：通讯配置区新增 `回退上一配置 (REVERT)`，
   `disabled = !status?.configHistoryDepth`（0 → 置灰，免得点了必 400 白等一次往返）；
   成功后拿 `result.config` 回填表单（**与 APPLY 同回填口径**）+ `refreshStatus()` +
   `refreshProfiles()`（配置变更会清激活指针）。`api/transport.js` 新
   `revertTransportConfig` + barrel 导出。

**测试**

| 层 | 用例 | 钉住 |
|---|---|---|
| BE | `test_change_then_revert_restores_previous` | 改了才入栈，回退回到**变更前**那一版 |
| BE | `test_revert_without_history_is_400` | 栈空 → 400 + 精确 detail 文案 |
| BE | `test_revert_is_a_stack_and_drains_to_400` | 连退三版 A→B→C 回 B 再回 A，**退空即止** |
| BE | `test_no_op_change_does_not_record_history` | `set_config({})` 与重复同值 → 不入栈 |
| BE | `test_history_is_bounded_at_twenty` | 30 次变更 → depth 20，**最老一版被挤掉** |
| BE | `test_revert_persists_and_records_event` | 回退也落库（否则重启回到改错那版）+ 留 `config` 事件 |
| BE | `test_persist_failure_on_revert_still_applies_but_is_recorded` | 钩子炸了仍生效，但必须留痕 |
| BE | `test_startup_restore_does_not_record_history` | **端到端走 `restore_transport_config`**：装载生效不入栈 → 栈空 400 → 真改一次才有得退 |
| FE | 回退成功 / 无可回退置灰 / 后端 400 detail 展示 | 按钮可用性、回填、错误可见 |

`test_transport.py::test_status_shape_and_loopback_always_connected` 的**精确键集**
断言加入 `configHistoryDepth` —— 这是全仓唯一一处 `get_status()` 形状断言，改它是本批的
**主动形变**（有意加字段），不是漏改；同用例补 `depth == 0`。

**验收**：BE **644/644**（基线 636 + 8）、FE **976/976（66 文件）**（基线 973 + 3）、
`npx vite build` EXIT=0、yorha-ui 校验器 `Terminal.jsx` **0 违规**；零 DDL → 无
`chore(db)` 提交。

**边界（写清免得以后误读）**：回退栈是**进程内**的 —— §8.37 R2 定为零 DDL，故
**重启即空**；要跨重启回退就得给 `transport_settings` 加一列，那属于 R6 那档的 DDL 批，
本批不碰。

**文档同步（同批）**：`pageStatus.json` 通讯调试页「上一配置一键回退」+ `PAGE_STATUS.md`
再生、本节 §8.39、§8.37 **R2 行标已办** + **R4 行记录拍板**（用户原话：拖完只改展示序、
点保存按钮才改持久序）、§1 `R1–R10` 行状态、§8.34 B2-7 标已办、§8.33「不改 backlog」
项销号、`PROJECT_HANDOVER.md` 条目 48。

### 8.40 R3 · ESLint 存量清零（`npm run lint` 自本批起成为验收门槛）

**批次**：2026-10-02 · **纯 FE + 1 处 lint 配置**（未碰 `backend/`、`models.py`、
`processor.py` / `graph.py` / `Blueprint.jsx`；`/dispatch` 缺省口径不变）。

**背景**：§8.34 B2-8（原记录「1 error 2 warnings」→ 2026-10-02 复测纠正为
**60 problems / 42 errors / 18 warnings / 26 文件**）→ §8.37 **R3**。纪律 =
**只删未用变量 + 加带理由的 disable，不改行为**；**自本批起 `npm run lint` EXIT=0
进验收门槛**。

**结果**：`npm run lint` **EXIT=0、0 problems / 0 文件**（60 → 0，涉 27 文件；
`git diff --stat` = **27 files / +120 / −48**）。

**分布 → 处置**

| 规则 | 原条数 | 处置 |
|---|---|---|
| `no-unused-vars` | 23 | 删未用绑定（含 `catch (_) {}` → `catch { /* 中文理由 */ }`、未用 prop 解构、未用局部量）。**唯一例外** = `encoderLimits.getParamKeyLimitRef(key, opCode)` 的**占位签名**（调用方已按两参在用）→ 带理由 disable |
| `react-hooks/exhaustive-deps` | 17 | 全部**带理由 disable**：逐条写清「为什么不列这个 dep」（多为「回调每次渲染重建 → 列入会让 effect / memo 每次渲染都重跑」） |
| `no-useless-escape` | 3 | `/[^\w.\-]+/g` → `/[^\w.-]+/g`（字符类内 `\-` 无需转义）等，**正则语义逐字节不变** |
| `no-empty` | 2 | 空 `catch` → `catch { /* 中文理由 */ }`（注释使块非空，同时删掉未用的 `err` 绑定） |
| `no-undef` | 1 | 测试文件补 `import { …, beforeEach } from 'vitest'`（与仓内其它测试一致，非 ESLint 配置放水） |
| `no-extra-boolean-cast` | 1 | `!Boolean(x)` → `!x` |
| `no-control-regex` | 1 | `/[^\u0000-\u00FF]/` **是故意写的控制字符**（Latin-1 越界校验）→ 注释 disable + 说明 |
| 未使用的旧 disable 指令 | 1 | `Sequences.jsx` 里一条没人报告的旧 `exhaustive-deps` disable → 删 |
| React Compiler 规则（`set-state-in-effect` 6 / `refs` 2 / `immutability` 1 / `rules-of-hooks` 1 / `preserve-manual-memoization` 1） | 11 | **先加定点 disable → `reportUnusedDisableDirectives` 判定「没盖住任何问题」→ 逐条删回**，最终只保留 **2 条真被用上的 `set-state-in-effect`**（`SmartInput`、`InstructionProcessor`）。**最终全仓定点 disable = 20 条**（`exhaustive-deps` 16 / `set-state-in-effect` 2 / `no-unused-vars` 1 / `no-control-regex` 1） |

> **过程中的坑（值得记）**：这些 compiler 规则一度全部报错，加完 disable 却被判
> 「unused」。逐条做删/留实验（删掉 disable → 重跑 → 确认 0 条报告）后才动手，
> **没有靠猜**；这也是为什么最终只留下 20 条而不是 20+ 条「以防万一」的放行。

**顺手修掉的 2 处真问题**（本该单独立批，但正好撞在 lint 上，改动等价且有测试覆盖）：

1. **`ParamConfigForm.jsx` · `react-hooks/rules-of-hooks`（条件调用 hook）** ——
   `if (!template || !template.param_template) return null;` 原本写在 `React.useEffect`
   **之前**：`op_code` 切到「无模板」的指令时**钩子调用数会跳变**，React 直接抛错。
   改法 = 「无模板」判断**挪进 effect 体内短路**，渲染侧早退**挪到钩子之后** ——
   渲染输出与 effect 触发条件与原实现逐条等价（无模板时 effect 照样立即 `return`）。
2. **`NieRDatePicker.jsx` · `react-hooks/immutability`（先用后声明）** ——
   `initDate` 声明在使用它的 `useEffect` **之后**（且在 `if (!isOpen) return null`
   之后），运行时靠「effect 回调要等渲染函数跑完才执行」侥幸可用。
   改法 = `syncState` → `initDate` → `useEffect` → 早退，**纯重排、语义不变**。

**另一处存量（yorha-ui 校验器）**：`NieRModal.jsx` **4 条违规**
（`backdrop-blur-[2px]` / `rounded-full` / `p-8` / `px-6` ×2）—— **HEAD 就有**。
R3 改到该文件就必须过校验器 → 顺手清：去掉 blur 与圆角、`p-8`→`p-4`、
`px-6`→`px-4`（密度对齐页内既有的 `p-4` / `px-4`）。

> **比对 HEAD 的坑（必须记）**：PowerShell 5.1 的 `>` 重定向**默认写 UTF-16LE**。
> 第一次用 `git show HEAD:... > f.jsx` 去校验，得到的是**假的「0 违规」**
> （校验器按 UTF-8 读，读出乱码当然什么也匹配不到）。改用
> `cmd /c "git show ... > f.jsx"` 或 Python 写字节后才复核出**HEAD 同样 4 条**。

**验收**：`npm run lint` **EXIT=0 / 0 problems**、**BE 644/644**、
**FE 976/976（66 文件）**、`npx vite build` EXIT=0、yorha-ui 校验器
**18 个改动 `.jsx` 全部 0 违规**；零 DDL（未碰 `models.py` / `database.py`）。

**边界（写清免得以后误读）**：本批**只清欠账、不改行为** —— 除了上面两处
「等价修 + 纯重排」，其余全是删除与注释；`exhaustive-deps` 一律定点放行而**没有**
顺手补 deps，因为补 deps 会让 effect/memo 的触发时机变化，那是**行为变更**，
必须单独排批（`useInstructionLanes.allFields` 那 4 条同理，注释里已写明正解是
把空数组收成模块级常量 / `useMemo` 固定引用，留到真正动那些 memo 的批次）。

**文档同步（同批）**：本节 §8.40、§8.37 **R3 行标已办**、§1 `R1–R10` 行
（R1 ✅ R2 ✅ R3 ✅ + lint 门槛生效）、§8.34 **B2-8 标清零**、
`PROJECT_HANDOVER.md` 条目 49。

### 8.41 R4 · 编排页绑定拖拽排序（拖完只改展示序，保存才改持久序）

**批次**：2026-10-02 · **纯 FE**（**零 BE 改动、零 DDL**；未碰 `models.py` /
`processor.py` / `graph.py` / `Blueprint.jsx`，`/dispatch` 缺省口径不变）。

**拍板**（§8.37，用户原话）：**「R4 拖完改展示序，点击保存按钮才改持久序」**。

**为什么能零 BE**：侧栏展示序 = `sortedBindings` 按 **(协议序, 洞号)** 派生，而
`slot_order` 本来就是 PUT 载荷字段（`toServer()` 一直带）。所以「改展示序」= 本地重写
`slot_order`（草稿），「改持久序」=「保存更改 (SAVE)」逐行 `PUT /bindings/{id}` ——
**两者是同一字段的两个阶段（未保存 / 已保存），不是两套数据**，也就没有"拖拽专用接口"
这回事。

**落地**

1. **`frontend/src/utils/reorderBindings.js`（新，纯函数，拖拽与洞位下拉共用）**
   - `moveBindingToIndex(bindings, movedId, targetIndex)` → `{ byId, changedIds, reordered }`：
     组内换位 + **稠密重编号 0..n-1**；目标位次钳在 `0..组内余数`（原下拉口径逐条保留）；
     **只回写真变化的行**（没动的行不标脏、不进 PUT 队列）。
   - `reorderBindingsWithinGroup(bindings, movedId, overId)` → 拖拽口径 = 落在 `over`
     的**原位次**；**跨协议组直接 `null`**（洞号是组内位次，不猜"要不要顺带换协议"）。
   - 「下拉位次」与「over 位次」数值等价的推导写在文件头注释：删掉自己只会让 over
     之前的元素整体前移一位，而 `without` 同样少了自己 → 两者相等，故共用一个实现。
2. **`frontend/src/pages/Orchestration.jsx`**
   - 抽出**模块级 `BindingRow`** —— `useDraggable`/`useDroppable` 是钩子，**绝不能写进
     `.map()` 回调**（那会变成条件调用 hook，正是 R3 修 `ParamConfigForm` 那类问题）；
   - 把手 = label 前的**空白 grip**（两根 1px 横线）：
     **无文本节点** → 不动 `aside .truncate` 的 `textContent`（既有断言按行取 label）、
     **不是 button** → 不影响「行内首个 button = 删除」的既有取法、
     **只挂 `listeners` 不挂 `attributes`** → 不给行加 `role="button"` 改无障碍角色；
   - `<DndContext sensors={PointerSensor + distance:8} onDragEnd={handleDragEnd}>` **只包
     侧栏绑定列表**；8px 起拖阈值保证「点一下选中行」不会被误判成拖；
   - `handleDragEnd` → `reorderBindingsWithinGroup` → `setBindings` +（非降级模式）把
     `changedIds` 并进 `dirtyIds`；`loadFailed` 时只改本地、不标脏，与下拉/属性编辑一致。
   - 键盘与无障碍的等价路径**本来就存在**（属性面板的洞位下拉），拖拽只是鼠标侧手感。

**测试（+14 → FE 990/990，67 文件）**

- `utils/__tests__/reorderBindings.test.js` **11 例**：稠密重编号且不动别的协议、越界钳位、
  原地不动 → `changedIds` 为空、只回写真变化的行、非法目标位次退化到末位、`slotOrder`
  缺省按 0、拖到 `over` 原位（序翻转）、中间项前移**不牵连第 3 行**、**跨协议组忽略**、
  同 id / 缺行 / 缺 over → `null`。
- `pages/__tests__/Orchestration.test.jsx` **+3 例（共 32）**：
  1. **拍板口径**：松手 → 展示序立刻翻转 + `updateBinding` **零调用** + SAVE 由禁用转可用
     → 点 SAVE 才 `PUT` 新 `slot_order`、随后回到禁用；
  2. **跨协议组**落点：不换序、不标脏、SAVE 仍禁用；
  3. **只有真变化的行**进 PUT 队列：末行不动 → 断言 `updateBinding` **从未**以 `srv-3`
     被调用，且脏标记 `●` 只出现在前两行。
- **怎么测拖拽**：jsdom 没有真实指针传感器，dnd-kit 的碰撞检测依赖
  `getBoundingClientRect`（jsdom 全 0）→ 测试里 `vi.mock('@dnd-kit/core')` **只把
  `DndContext` 的 `onDragEnd` 透到 DOM 上**，由测试直接调用。被测的是**我们自己的换位 /
  标脏 / 落库口径**，不是 dnd-kit 本身（生产构建里 dnd-kit 是真的，`vite build` 已验证）。

**验收**：`npm run lint` **EXIT=0**、**BE 644/644**、**FE 990/990（67 文件）**、
`npx vite build` EXIT=0、yorha-ui 校验器 **0 违规**；零 DDL。

**顺带更正 §8.37 原行两处失实**：

- 原写「现状 = 上移/下移按钮 + `slot_order` 洞位下拉回写已落地」—— 实测**只有洞位下拉，
  没有上下移按钮**（已在 R4 行更正）。
- 原写「未保存切换协议/刷新要有丢弃提示」—— 刷新**已有** `beforeunload` 拦截
  （`dirtyRef`/`recipeDirtyRef`）、协议切换**不丢稿**（脏行按行驻留本地、切行不丢）→
  **无需新增提示**，拖拽沿用同一套脏行语义即可。

**文档同步（同批）**：本节 §8.41、§8.37 R4 行（标已办 + 现状更正）、§1 `R1–R10` 状态、
`PROJECT_HANDOVER.md` 条目 50。

### 8.42 R5 · float64 编码双端（缺省 f32 逐字节不变）

**批次**：2026-10-02 · BE + FE + 向量（**零 DDL**；未碰 `models.py`、`processor.py` /
`graph.py` / `Blueprint.jsx`，`/dispatch` 缺省口径不变）。

**目标（§8.37 R5 行）**：`FLOAT_IEEE` + `byte_len=8`（bits=64）在两端从「FE 落整数路径 /
BE 保持 zeros 的**静默不一致**」变成**真出 IEEE 754 float64 大端**，并且**动了编码器也
要证明缺省逐字节不变**。

**为什么它是「双端不一致」而不是「功能缺失」**：R5 之前 `byte_len=8` —— FE 走默认整数
编码出 `0000000000000001`，BE `datahub.to_block` 那一支 `byte_len == 4` 不命中 → 保持
zeros。**同一份指令，本地试发与服务端编译/导出给出两种不同的帧**。N1（§8.16）当时只能
挂 `FLOAT64_UNSUPPORTED` 提醒（G7 定案「提醒而非改模板」），真正修复就是本批的双端分支。

**落地**

1. **BE `backend/core/orchestrator.py` · `encode_float_ieee(value, byte_len=4)`**
   - 新增 `byte_len` 形参，**缺省 4 = 存量行为**：`byte_len == 8` → `struct.pack(">d")`
     出 16 hex，否则仍 `">f"`（契约外长度由调用方分派闸挡住，不放大影响面）。
   - 解析口径 `_float_number` **一字未改**：非有限一律 → 0，所以 NaN / ±Inf 输入在 f64
     下同样出全零，**不会写出 NaN 位型**（与 FE 同口径）。
   - `backend/routers/datahub.py` 的 `to_block` 分派条件 `byte_len == 4` →
     `byte_len in (4, 8)`。
   - LITTLE 走 `orchestrator.py` 的**字节整体逆序**，与宽度无关 → f64 自动成立（补测）。
2. **FE `frontend/src/utils/InstructionEncoder.js` · `getFieldBytes`**
   - `byteLen === 4` → `(byteLen === 4 || byteLen === 8)`，`new Float32Array(1)` →
     `byteLen === 8 ? new Float64Array(1) : new Float32Array(1)`；解析正则、
     `Number.isFinite` 归 0、平台小端 → 大端的 `.reverse()` 全部复用，
     **4 位分支的判断与取值逐字符未动**。
3. **`frontend/src/utils/formula.js` · `formatFloatToHex(value, byteLen = 4)`（补口）**
   - 这是**裸位型转换**工具（非有限就写出 ±Inf / NaN 位型），与指令编码器的「先解析、
     非有限归 0」口径**不同** —— 加宽度参数 + 把两套口径的差异写进 docstring。
   - 全仓 grep `formatFloatToHex` **零调用方** → 改它零行为风险。
4. **`frontend/src/utils/validateInstruction.js` · 提醒收窄**
   - `FLOAT64_UNSUPPORTED`（`byte_len === 8` 报）→ **`FLOAT_IEEE_WIDTH_UNSUPPORTED`**
     （`byte_len ∉ {4, 8}` 才报），message 改「4=float32 / 8=float64」。
   - 全仓 grep 该 code 只有 `validateInstruction.js` 与其测试两处（**无 UI 按 code 分派**）
     → 改名无副作用。
5. **`frontend/src/config/runnerRenderRules.js` · 章随位宽走**
   - `resolveRunnerKind` 的 `FLOAT_IEEE` 分支 → `byte_len === 8` 出 **F64** 章、否则 F32
     —— 杜绝「章写 F32、出帧却是 8 字节」的错位（本批之前 `key` 恒为 F32）。
6. **`vectors/float_ieee.json` → 分组 `{ "f32": [...], "f64": [...] }`（不拆文件）**
   - 理由：`bcd_scaled.json`（bcd/scaled）、`time_counter.json`（time/auto）、
     `presence.json`（leaf/group）**已是「同语义多表」的分组先例**（README §3 口径）；
     float32 / float64 是**同一解析口径的两种位宽**，放同一文件一眼看出「只差位宽」，
     且两端仍是同一份 JSON、新增向量只写一处。
   - `f32` **22 行一字节未改**（缺省不变的物证），`f64` 新增 **23 行**。
   - 关键锚点：`1e40` 在 f32 出 `7F800000`（IEEE 溢出）、f64 出 `483D6329F1C35CA5`；
     `1e300` / `-1e300` 只有 f64 能落有限位型；`"1e3"`（拒指数记法）、`"FF"`（非法串）、
     `{"$v":"NaN"}` / `{"$v":"Infinity"}` / `null` 在 f64 组同样 → 全零。

**`response_match` 解码侧 —— 更正 §8.37 原行的说法**

原 R5 行写「`response_match` 解码侧同步（否则能发不能判）」。**实测不成立**：
`backend/core/response_match.py` 全文**没有任何值解码** —— 547 行只有
`prefix / suffix / echo_header_bytes / length / checksum / unpack` 六类 stage 的
**字节级**比对（`match_response(spec, sent: bytes, received: bytes, ...)`，两侧都是
`bytes`）；全仓 grep `struct.unpack`、`'>f'`、`'>d'` **零命中**。所以判定路径**天然与
位宽无关**：出线帧对了，echo / length / checksum 就对。真正的「判读缺口」在**编译侧
`datahub.to_block`**（保持 zeros → 服务端编译/导出与 FE 两套帧），本批已一并修掉 ——
**`response_match` 零改动**。

**测试（BE 644 → 648；FE 990 → 1020，67 文件）**

- BE `test_encode_float_ieee.py` **6 → 10 例**：`VECTORS64`（23 行）、
  `test_default_arg_stays_f32`（**缺省参数逐字节等同改前**）、
  `test_byte_len_8_emits_float64`（`to_block` 分派真出 8 字节）、
  `test_f32_f64_dividing_line`（`1e40` 两种位宽）、缺省 8 零字节、f64 矛盾 type 仍
  zeros、f64 LITTLE 逆序；`f32` 22 例**原样保留**。
- FE `InstructionEncoder.test.js` **187 例**（+23 f64 向量 + 5 锚点）：f32 组原样保留、
  分水岭、f64 静态/输入同口径、f64 LITTLE、`encodeInstruction` 组装 8B + 1B。
- FE `validateInstruction.test.js` **+1 例**（G7 收窄成三条：8 不报 / 2 报 / 4·8 都不报）。
- FE `runnerRenderRules.test.js` **+1 例**（F64 章；4 与缺省仍 F32）。
- **缺省逐字节不变的证据链**：`f32` 22 行向量两端原样全绿 + `encode_float_ieee` 单参
  调用回归 + `test_default_arg_stays_f32` 显式断言 `f(v) == f(v, 4) == 期望` +
  改前 BE 644 / FE 990 全量零改动全绿。

**验收**：`npm run lint` **EXIT=0**、**BE 648/648**、**FE 1020/1020（67 文件）**、
`npx vite build` EXIT=0、yorha-ui 校验器 **0 违规**（7 个改动 .js）；零 DDL；
`pageStatus.json` 未改（无需重生成 `PAGE_STATUS.md`）。

**文档同步（同批）**：本节 §8.42、§8.37 R5 行（标已办 + 更正 `response_match` 说法）、
§1 `R1–R10` 状态、§8.16 N1 后记与引子、E1-4 进度块、B2 缺口第 4 条、§8.37 验收口径、
`vectors/README.md`（表清单 16 表 + `[f64]` 组说明）、`docs/BUSINESS_SCENARIOS.md`
（浮点 64 位行 / G7 行 / §8.14 注）、`PROJECT_HANDOVER.md` 条目 51 与 E1-4 已知缺口
第 1 条、`test_operator_templates.py` 注释。

### 8.43 R6-1 · 软删除 / 回收站 —— DDL + BE（13 表统一 `deleted_at`）

（2026-10-02 · **第 6 批** · 拍板 = §8.36「R6 方案」行：**13 表统一加 `deleted_at`（仅新增列，
合 §0）+ 读端点过滤 + 回收站页，不做 `trash_bin` 新表**。R6 拆两批：**本批 = DDL + BE**，
R6-2 = FE 回收站 UI。`/dispatch` 缺省口径与 `processor.py` / `graph.py` / `Blueprint.jsx` 未碰）

**一、DDL：只加 13 列，走已有的版本化迁移（§8.30），不另起 `ensure_*`**

- `backend/db/models.py`：13 张表**每张末尾**加一列 `deleted_at = Column(String(40),
  nullable=True)`（**仅新增列**，合 §0；模块顶加 R6 口径块注释）。名单不另抄 ——
  `backend/db/migrate.py::soft_delete_tables()` 从 `Base.metadata` **派生**（SSOT：models 带
  该列的表 = 需要迁移的表），verify 侧再钉死「恰好 13 张」。
- 追加 `Migration(2, "soft_delete_deleted_at", apply, verify)`：
  - **apply** = 逐表 `PRAGMA table_info` → 缺则 `ALTER TABLE ... ADD COLUMN deleted_at
    VARCHAR(40)`；新库 `create_all` 已建全列 → 逐表跳过（`ALTER` 加已存在的列会直接报错），
    等价 no-op；表尚不存在 → 跳过（交给 0001 baseline verify 报缺表）；
  - **verify** = 13 表**每张**都有 `deleted_at`，缺一即 `MigrationError` → 整体回滚、版本不前进；
  - 既有库升级前**自动整库备份**（`pre-migration-v1-to-v2-*.bak`），新库只记版本不备份。
- 启动接线**零改动**：`main.py` lifespan 本来就跑 `run_pending_migrations(engine, ...)`；
  恢复旧备份的自愈路径（`datahub._heal_schema_after_restore`）同理自动补齐。
- `backend/db/migrations/schema.sql`（目录头已声明 NON-AUTHORITATIVE）本就不含 `wrap` /
  `definition_hash`，早与权威脱钩 → **本批不同步**（权威始终是 `models.py`）。

**二、写侧语义单点收口：`backend/db/soft_delete.py`**

- `mark_deleted(row, ts)` —— 删除单行 = 打标记进回收站（不毁行），返回本次时间戳；
- `mark_related(query, Model, criteria, ts)` —— 级联软删，**只标尚未入站的行**；
- `restore_related(query, Model, criteria, ts)` —— 按「同父 + 同时间戳」把被连带的子行一并恢复；
- `purge_related(query, Model, criteria)` —— 彻底删除的级联，按外键清引用者（**不看时间戳**，
  不留孤儿行）；
- `alive(query, Model)` / `trashed(query, Model)` —— 读侧 `deleted_at IS NULL` / `IS NOT NULL`。

**「级联共用同一时间戳」是本批的关键设计**：拍板只要 `deleted_at` 一列 → **不额外加级联标记列**，
恢复判据 = `(子表, 外键列, 父 id, 子行戳 == 父行戳)`。本次之前已独立入站的子行时间戳不同 →
**不会**被父行恢复顺带捞回，也**不计入** `deleted_*` 回执计数（`mark_related` 用 `IS NULL`
限定，天然成立）。

**三、端点改动**

- **7 类可回收** = protocol / instruction / binding / recipe / sequence / profile /
  response_spec：
  - `DELETE` 一律改软删，**响应体形状与计数键逐字不变** —— `deleted_bindings` /
    `deleted_response_specs` / `orphaned_sequence_steps` / `cleared_instructions` / `204`；
  - 读端点（列表 / 单查 / 更新 / 二次删 / 引用计数）一律 `alive()` 过滤 →
    **「列表不出现、单查 404、二次删 404」与改前硬删后同口径**；
  - 级联范围 = `protocol → protocol_bindings`、`instruction → protocol_bindings +
    response_specs`。`sequence_steps` / `instruction_fields` **不打标记**（两者不独立可列，
    跟着宿主在读侧一起隐藏），彻底删除时才由 ORM cascade / `children` 清掉。
- **新增 `routers/trash.py`（`/trash`）** 统一回收站入口：
  - `GET /trash` → `{items: [{kind, id, label, deleted_at}], count}`（**最近删的在前**）；
  - `POST /trash/{kind}/{id}/restore` → `{status, kind, id, related}`（`related` = 级联恢复计数）；
  - `DELETE /trash/{kind}/{id}` → `{status, kind, id, related}`（**彻底删除**）。
  `kind` 是**白名单**（路径参数不接受任意表名 → 无注入面）；**列表隐藏「被父行连带入站」
  的子行**（判据 = 子行宿主也在站里：恢复会一起回来，不该单独占一行；独立删的子行宿主
  活着 → 正常显示）。
- **读端点过滤还覆盖 `datahub`**：`GET /datahub/export/bundle`（指令 / 绑定 / 规格三处）、
  `GET /datahub/status` 的四张表计数、`POST /datahub/import/relations` 的三处**宿主存在性
  校验** —— 否则下载包里会出现「用户刚删掉的指令」，或回灌出一条指向回收站行的活绑定。
  导出列子集本就没有 `deleted_at` → **回灌后一律是活行**。
- **三张表只加列、不改行为**：`dispatch_logs`（清空日志 = 追加型审计数据，删除即不可恢复是
  既有口径，且回收站会被海量日志行淹掉）、`operator_templates`（种子数据无删除入口）、
  `transport_settings`（单行配置无删除入口）。

**四、已知取舍（拍板「仅新增列、不做表重建」的直接后果）**

1. **软删行继续占用唯一键** —— `sequences.name` / `device_profiles.label` /
   `response_specs.instruction_id` 都是 inline UNIQUE（SQLite 落 `sqlite_autoindex_*`，
   **索引删不掉**；拍板禁止表重建 → 没法改成部分唯一索引）。**后果**：回收站里还有同名
   序列/档案时，新建或改名会 400「已存在」—— `sequence._checked_name` /
   `profile._checked_label` / `create_instruction` 的查重**故意不过滤回收站**，把这 400 明确
   落在路由上（漏到 DB 才报就是 500）；**彻底删除后键释放**
   （`test_*_reserved_while_in_trash_until_purged` 双向断言）。
2. **`response_specs` 走 upsert 复活** —— `filter(instruction_id == ...).first()`（**无**
   `deleted_at` 过滤）天然命中回收站行 → 更新 + `deleted_at = None`，**不撞唯一键、不换 id**
   （手工 SAVE 与「据此生成」两处同口径）。
3. **配方 / 档案的指针在删除期解除、恢复不回填** —— `delete_recipe` 仍清
   `instructions.default_recipe_id`（回执 `cleared_instructions` 与前端「解除 N 条指令关联」
   文案**照旧为真**、零 FE 改动），`delete_profile` 仍清 `transport_settings.active_profile_id`；
   **活行不许指向回收站行**。代价 = 恢复配方/档案后需重新指定默认配方 / 重新激活。
   读侧已兜底：`recipe.get_recipes` 加 `alive()` → 指针指向回收站行时按**「无配方」降级**回
   空数组（不是 404、不崩；前端 `recipes.find(...) || null` 与 `（配方缺失）` 回退路径原样可用）。
   配方**彻底删除**前再清一次指针（`trash._clear_recipe_links`）→ 恢复后重新指定的也不留脏行。

**五、测试（+20 → BE 668/668）**

新增 `backend/tests/test_soft_delete.py`（4 类 19 例）：

- `MigrationDeletedAtTest`（3）：13 表名单与建列；**存量库**（13 列 `DROP COLUMN` 掉 + 记
  0001 基线）被 0002 补齐（applied / from_version / to_version / integrity / **备份文件存在** /
  13 表都有列 / 版本记账）；**新库只验不改**（applied = 注册表全量，不撞重复列名）。
- `TrashProtocolTest`（3）：删除 → 读侧 404 + 入站 + 连带绑定**隐藏** + 与宿主同戳；
  恢复 → 协议与绑定一起回来、站清空；彻底删除 → 行真没了、旁支完好。
- `TrashInstructionTest`（4）：三表同戳 + 旁支 / 冻结快照 / 日志不动；恢复带回绑定与规格；
  彻底删除连 `instruction_fields` 一起删但保住快照与日志；**独立入站的子行跨宿主恢复仍留站**。
- `TrashSequenceProfileRecipeTest`（6）+ `TrashScopeTest`（2）：序列删后步骤留库、彻底删除
  才清；**序列名 / 档案名在站期间占用 400、彻底删除后释放**；配方指针三态 + 读侧降级；
  响应规格 upsert 复活；**白名单恰 7 类**（日志 / 模板 / 单行配置不进站）；标签与倒序。

`test_datahub.py` **+2**：`TestExportExcludesTrashed`（回收站行不进 ZIP）、
`test_trashed_parents_treated_as_missing`（回灌把回收站宿主当「不存在」跳过）。

改动既有测试 **6 个**（语义变更如实改写）：`test_instruction_delete`（级联软删 + 同戳 +
读侧 404）、`test_protocol_delete`（级联软删 + 旁支不动）、`test_sequence_api`（步骤留库 +
读侧 404，改名 `test_delete_marks_trash_and_keeps_steps_204`）、`test_migrate`
（`["0001_baseline"]` 硬编码改随 `REGISTRY` 派生的 `_ALL_LABELS`；`NewerDbTest` 插入版本改
`TARGET_VERSION + 1` —— 目标版本 1 → 2 后原值不再是「更高」）、`test_recoverability`
（版本标签派生 + 断言 `deleted_at` 已补齐）。

**验收**：**BE 668/668**（648 → 668）、**FE 1020/1020（67 文件）**、`npx vite build` EXIT=0、
`npm run lint` **EXIT=0**、yorha-ui 校验器 **0 违规**（**本批零 FE 改动 → 无改动文件可跑**）；
**DDL = 仅新增 13 列**（`models.py` 只加列、未加表；`processor.py` / `graph.py` /
`Blueprint.jsx` 未碰；`/dispatch` 缺省口径逐字节不变）；`pageStatus.json` 未改 → 无需重生成
`PAGE_STATUS.md`；`vectors/` 未动。

**文档同步（同批）**：本节 §8.43、§8.37 R6 行（R6-1 已办 / R6-2 待办）、§1 `R1–R10` 状态、
§8.34 B2 缺口第 6 条（后端半已收口）、`PROJECT_HANDOVER.md` 条目 52。

### 8.44 R6-2 · 软删除 / 回收站 —— FE（回收站页 + 删除文案口径）

（2026-10-02 · **第 7 批** · R6 的 FE 半：拍板 §8.36「R6 方案」里的「**回收站页**」与
§8.43 结尾留的「待办 R6-2」。**零 DDL、零后端改动** —— 只消费 R6-1 已落定的三个端点；
`processor.py` / `graph.py` / `Blueprint.jsx` 未碰，`/dispatch` 缺省口径逐字节不变）

**一、新增回收站页 `/trash`（第 8 页，快捷键 `G`）**

新文件 `frontend/src/pages/Trash.jsx`，数据页骨架照 `DataHub.jsx`（页头 + SYS 状态条 +
分节面板），三段结构：

1. **口径面板（GROUND RULES）常驻** —— 把 §8.43 四的已知取舍**如实写给操作员**：
   回收站内条目【仍占用名称】（同名序列 / 档案的新建与改名 400，彻底删除才释放）、
   配方与设备档案的指针删除期已解除（恢复后需重新指定 / 重新激活）、序列步骤等冻结
   快照随宿主隐藏但不单独入站、通讯日志清空仍是硬删不进本页。
   **宁可写「恢复后要重做一步」，也不许暗示恢复即完全回到删除前。**
2. **条目列表** —— `GET /trash` 直出，列 = 类型（7 类中文映射）/ 名称 / 删除时间 /
   操作；标题带计数 `回收站条目 (TRASH ITEMS) · N`。`deleted_at` 做**秒级截断 + `UTC`
   后缀**（微秒与偏移不进表格列，避免撑宽第三列）；空态与错态各有独立版式，
   错态给 `重试 (RETRY)`。
3. **底部 `刷新 (REFRESH)`**。

每行两个动作：`恢复 RESTORE` **直调**（幂等、可逆，不弹确认）、`彻底删除 PURGE`
**必须过 `NieRModal`** —— 弹窗写明「从数据库中移除 / 不可恢复 / 回收站内也不会再有它 /
同名在此之前一直占用名称 / 若只是想找回应改点『恢复』」。

忙态**按行而非按页**：`busy = 'restore:<id>' | 'purge:<id>'`，只禁用该行两个按钮，
其余行照常可操作；恢复 / 彻底删除成功后 `await refresh()` 回拉一次（失败**不回拉**，
条目留在列表里让用户看清 detail）。

接线三处：`App.jsx` 加 `case 'trash'`；`pageStatus.json` 追加第 8 页
（`key/path/title/status/availableNow/nextSteps`，**快捷键 `G`** —— A / B / C / D / E /
F / R 已占）；`npm run sync:page-status` **重生成 `docs/PAGE_STATUS.md`**
（`pageStatus.json` 改动即须重生成，§8.31）。同时把该文件里两处**已过期的删除口径**
一并改准：协议页「同事务级联删 `protocol_bindings`」与指令页「活配置随删清理」
→ 都改成软删 / 随删入站。

**二、API 层：`api/trash.js` 三端点进 barrel**

`listTrash()` → `GET /trash`、`restoreTrashItem(kind, id)` →
`POST /trash/{kind}/{id}/restore`、`purgeTrashItem(kind, id)` → `DELETE /trash/{kind}/{id}`；
`kind` / `id` 走 `encodeURIComponent`。**FE 不兜白名单第二层** —— 传了白名单外的值就让
后端 404 `Unknown trash kind: ...` 原样透出，活行 400 `该条目不在回收站` 同理，
避免前后端两处口径分叉（`client.js` 的 `detail` 只加不改纪律延续）。

**三、五处删除确认与回执文案改口径（本批的真正目的）**

| 位置 | 改前 | 改后 |
|---|---|---|
| `useInstructionData.describeReferences` | `警告：确认永久删除此指令？` ＋ `删除后不可撤销。确认继续？` | `警告：确认将此指令移入回收站？` ＋ `删除后移入回收站，可在「回收站」页恢复；彻底删除才不可恢复。` |
| 同上 · 四表三分行 | `协议绑定 N 条 → 随删清理（活配置）` | `→ 随删入站（活配置，随指令恢复）` |
| `describeDeletion` | `已删除指令` | `已移入回收站（指令）` |
| `Protocol` 删除弹窗 ＋ 状态条 | `删除将连带清理这些绑定。` ／ `协议已删除（连带清理 N 条绑定）` | `删除将把这些绑定一并移入回收站（随协议恢复一并回来）。` ／ `协议已移入回收站（连带清理 N 条绑定 · 一并入回收站），可在「回收站」页恢复` |
| `Sequences` 删除序列 | `步骤行一并删除，不可恢复。` | 三条要点：一并移入回收站 ／ 可在回收站恢复（步骤随序列一并回来）／ 彻底删除后才不可恢复 |
| `Orchestration` 删除配方 | `该操作不可撤销，须重新新建配方` | `配方移入回收站，可在「回收站」页恢复` ＋ `恢复后需重新指定默认配方（指针不回填）` |
| `Terminal` 删除档案 | `仅删除档案快照` | `仅删除档案快照，移入回收站可恢复` ＋ `恢复后需重新激活该档案（激活指针不回填）` |

**约束：各弹窗首句前缀一律不改** —— `确认删除档案「…」？` / `删除序列「…」？` /
`确认删除配方「…」？` / `被 N 条编排绑定引用` / `连带清理 N 条绑定` 全部保留，
因此 `Terminal.test` / `Sequences.test` / `Protocol.test` 的既有断言**零改动即通过**；
改的全是**后半句的后果描述**。**不可逆的警告只保留在回收站页的 `PURGE` 确认里** ——
删除本身已不是终局，就不该再用「不可撤销」吓唬操作员。

**四、同批收口：`App.jsx` 存量 yorha-ui 违规 5 处清零**

新增路由必然改动 `App.jsx` → 按「改动文件 0 违规」的验收口径一并收口（先例 = 第 4 批
`NieRDatePicker` 注释「清既有校验器违规」）：`backdrop-blur-md` / `backdrop-blur-sm`
去模糊改实底（`bg-nier-dark`），品牌区 `p-6` / 导航 `py-6` / 顶栏 `px-6` 收紧为 `p-4`。
**改动前已用 `git stash` 证明这 5 处在 HEAD 上同样存在** → 本批**新增违规 = 0**、
收口后 `App.jsx` = 0。

**五、测试（+13 → FE 1033/1033 · 69 文件）**

- 新增 `src/api/__tests__/trash.test.js`（**5 例**）：三端点 URL / method 逐字对齐
  （含 `response_spec` 与 `a/b` 的 `encodeURIComponent`）、白名单外 `kind` 的 404
  detail 原样透出、活行 400 `该条目不在回收站` 原样透出。
- 新增 `src/pages/__tests__/Trash.test.jsx`（**8 例**）：列条目（中文类型 / 名称 /
  秒级 UTC / 条目计数）、`kind` 中文映射、空态、错态 + 重试重拉、恢复（调用参数 +
  回拉 + 状态条级联条数）、恢复失败 detail 原文且**不重拉**、**彻底删除取消不调 /
  确认才 `DELETE`**（三条不可逆提示齐全）、口径面板三条常驻文案。
- 改写 `useInstructionData.test.js` **7 处**断言（该模块注释即「文案钉口径、改文案
  必改测试」）；`Sequences` / `Terminal` / `Protocol` / `Orchestration` 因首句前缀
  保留而**零改动**。

**验收**：**BE 668/668**（本批零后端改动，与 R6-1 同数）、**FE 1033/1033（69 文件）**、
`npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器改动文件
**0 违规**（`App.jsx` 5 处存量同批清零、`Trash.jsx` 4 处收紧至 0）；
`models.py` 未再改动 —— **R6 两批合计仅新增 13 列、未加表**；`pageStatus.json` 已改
→ `PAGE_STATUS.md` 已重生成；`vectors/` 未动；`frontend/red-report.json` 不入库。

**文档同步（同批）**：本节 §8.44、§8.37 R6 行（两批均标已办）、§1 `R1–R10` 状态、
§8.34 B2 缺口第 6 条（全收口）、`PROJECT_HANDOVER.md` 条目 53。

### 8.45 R7 · 导出补域 —— `bundle` 3 域 → 8 域 + `manifest.domainVersion`

（2026-10-02 · **第 8 批** · §8.37「R7 | C-3 选 C」行。**只动 `datahub` 一个文件的
出线侧**：`processor.py` / `graph.py` / `Blueprint.jsx` 未碰，`/dispatch` 缺省口径
逐字节不变，**零 DDL**（`models.py` 一个字符未改））

**一、8 域清单（拍板「原 3 域 → 8 域」）**

ZIP 顶层文件即域，`manifest.json` 之外正好 8 个数据域；后 5 个是本批新增：

- **改前就有 3 域**
  - `instructions.json` —— 指令树（instructions + instruction_fields + bit_fields）；
  - `relations.json` —— `protocol_bindings` + `response_specs`（批次四 4a）；
  - `frames/*`（`.bin` + `.hex`）—— 派生域：逐指令 Orchestrator 编译骨架帧；
- **本批新增 5 域**（§8.37 R7 行逐字点名的那 5 个）
  - `recipes.json` —— `frame_recipes`（`stages` 原样，`definition_hash` 在 stages 内）；
  - `sequences.json` —— `sequences` **内嵌** `sequence_steps`（步骤不单独成域，
    宿主-从属同进同出；子行内嵌后**不再重复 `sequence_id` 列**）；
  - `transport.json` —— `transport_settings`（单行约定 `id = current`，仍用数组
    统一形状，便于 R8 逐行处理）；
  - `profiles.json` —— `device_profiles`（`label` 是档案自然键）；
  - `templates.json` —— `operator_templates`（`op_code` 是主键）。

**行序一律显式排序，导出可 diff**：序列按 `(name, id)`（镜像 `GET /sequences`）、
步骤按 `(step_order, id)`、档案按 `(label, id)`、算子按 `op_code`、配方与绑定按 `id`。

**读侧口径 = 只出活行**（R6 §8.43，`alive()`）：8 个域的查询全部过 `alive()` ——
回收站里的指令 / 绑定 / 应答规格 / 配方 / 序列 / 档案**一步都不进包**；
`sequence_steps` 靠「查询时先限定 `sequence_id IN (导出序列)`」天然跟随宿主，
**宿主在站里则其步骤一条不出现**。同时**列子集不含 `deleted_at`**：
日后按域回灌得到的恒是活行，不会把源机的回收站状态搬过去。

**二、`manifest` 加两把钥匙（既有三键只做加法）**

新增 `domainVersion` = **8 域清单**（键序 = 导出序，值 = 该域自己的
`schemaVersion`；instructions / relations 沿用各自文件内的 `schemaVersion = 1`，
新域从 1 起）与 `domainCounts` = 逐域行数。

**`domainCounts` 的键集必须与 `domainVersion` 严格相等** —— 抽成纯函数
`bundle_manifest(...)` 并加**守卫测试**：往域清单里加一域却忘了补 counts
→ 直接 `ValueError: 域清单不一致`，而不是静默出一个缺域的包。
存量三键 `instructionCount` / `relations` / `frames` **一个都不动**，旧消费方
读 manifest 一个字段都不用改。

**三、边界：本批只做出线**

按域导入端点 = **R8**（复用 CP4-4a `import/relations` 的「upsert / 跳过 / 逐行报告」
口径，快照直接复用 R1 的 `safety_snapshot()`）。本批不新增任何 `POST` 端点、
不改 `POST /datahub/import/relations` 一个字节。

**四、同批修回一处 R6-1 丢失的过滤**

`export_bundle` 的**指令 / 绑定 / 应答规格**三个查询原本**没有** `alive()`，
而模块 docstring（§8.43 R6-1 那段）已经声明「聚合导出一律 `alive()` 过滤」——
即 R6-1 批里那次编辑**报成功但没落盘**（该批已知的编辑丢失问题，且当时没有
测试盯这条）。本批改这个函数时一并补回，端到端测试
`TestExportBundleEightDomains.test_zip_carries_eight_domains` 把
**六处回收站排除**（指令 / 绑定 / 应答规格 / 配方 / 序列 / 档案）逐条钉死，
此后不会再静默丢。

**五、已知观察（不扩拍板，登记备查）**

拍板点名的 5 域**不含 `protocols`** —— 协议仍在「协议页 IMPORT」那条既有路径上，
`bundle` 里只有绑定与配方对协议的**引用 id**（`protocol_id` / `stages[].protocol_id`），
没有协议本体。因此**换机迁移时必须先经协议页导入协议，配方与绑定才认得出宿主**。
本批**严格按拍板的 5 域实施**（凑 8 域，不多不少），把这一点记在这里供 R8 决策：
若 R8 的按域导入要让 `recipes` / `relations` 自洽，需再议「协议是否作为第 9 域」。

**六、测试（+8 → BE 676/676）**

`backend/tests/test_datahub.py` 新增 3 类 **8 例**：

- `TestExportDomainPayloads`（4）：5 个新域的载荷形 —— `schemaVersion`、行键、
  **`deleted_at` 一律不在列子集**、可 JSON 直序列化；序列**内嵌步骤**、
  **宿主不在导出列表的步骤被丢掉**、给定顺序保持、`sequence_id` 不重复出现。
- `TestBundleManifest`（3）：8 域清单的**键序与键集**、逐域行数 + **存量三键不变**、
  **域清单漂移守卫报 `ValueError`**。
- `TestExportBundleEightDomains`（1，临时库直调端点）：ZIP 顶层 **8 个域文件 +
  manifest**、`domainVersion` 8 键、`domainCounts` 键集相等且逐项为
  `2/0/2/1/1/1/1/1`，**六处回收站排除**与「站内序列的步骤一步不出」。

**验收**：**BE 676/676**（668 → 676）、**FE 1033/1033（69 文件）**、
`npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器改动文件
**0 违规**（`DataHub.jsx` / `datahub.js`）；**零 DDL**（`models.py` 未改）；
FE 本批只改**文案与注释**（导出回显列 8 域文件名、面板段落补 5 域与
`domainVersion` 说明、`pageStatus.json` 数据中心页口径）→ `PAGE_STATUS.md` 已重生成；
`vectors/` 未动；`frontend/red-report.json` 不入库。

**文档同步（同批）**：本节 §8.45、§8.37 R7 行标已办、§8.36 C-3 行状态、§1 `R1–R10`
状态、`PROJECT_HANDOVER.md` 条目 54。

### 8.46 R8 · 按域导入 —— R7 出线的 5 个新域补回灌（C-3 收口）

（2026-10-02 · **第 9 批** · §8.37「R8 | C-3 选 C」行。**零 DDL**（`models.py` 一个
字符未改），未碰 `processor.py` / `graph.py` / `Blueprint.jsx`，`/dispatch` 缺省口径
逐字节不变。改动集中在 `datahub.py`（5 端点 + 5 importer + 顶层校验）、
`sequence.py`（抽一个共用入口）、DataHub 页与 `api/datahub.js`。）

**一、五个端点与统一回执**

`POST /datahub/import/` 下补 5 条路径，与既有的 `/import/relations` 完全同形：

| 端点 | 载荷 | upsert 键 |
| --- | --- | --- |
| `/import/recipes` | `recipes.json` | `id` |
| `/import/sequences` | `sequences.json`（内嵌步骤） | `id` + `name` 唯一 |
| `/import/transport` | `transport.json` | `id`（恒 `current`，单行） |
| `/import/profiles` | `profiles.json` | `id` + `label` 唯一 |
| `/import/templates` | `templates.json` | `op_code`（即主键） |

回执**五条路径统一**：

```json
{"domain": "recipes", "imported": 2, "updated": 1,
 "skipped": [{"index": 1, "id": "r-bad", "reason": "协议不存在：p-404"}],
 "warnings": [], "preImportSnapshot": {"name": "pre-import-9.db"}}
```

（`sequences` 额外带 `steps.written` = 实际写入步数。）

**二、三段式：与 `/import/relations` 一字不差的纪律**

抽成 `run_domain_import(db, payload, validator, importer)`，五个端点各一行：

1. **① 顶层校验是纯函数** `_domain_rows(...)` —— 非对象 / 未知顶层键 /
   `schemaVersion` 不符 / 缺数组 → **400 且不落快照**（还没碰库）；
2. **② `pre-import` 快照** —— 复用 R1 的 `safety_snapshot()`，失败 **500 中止且库未被改**；
3. **③ 逐行独立提交** —— 校验失败 / 唯一约束冲突只回滚该行（`IntegrityError` →
   `db.rollback()` → 记进 `skipped`），**部分成功即部分落库**、不整批回滚。

**三、校验复用各域 SSOT，不写第二套口径**

- **配方** = `routers/recipe.resolve_stages`：层上限、插槽归属校验，且
  **`definition_hash` 不采信载荷**、按**目标机**的协议 `children` 重算 —— 配方搬到新
  机器当场就知道与源机是否同构；
- **序列** = `routers/sequence.normalize_sequence`（**本批新增的共用入口**，串起
  `_checked_name` → `_normalize_config` → `_normalize_steps`）；`create_sequence` /
  `update_sequence` 改调它，**行为逐字不变**（顺序、错误文案都照旧）。步骤整体替换走
  同步改公开的 `write_steps`（删旧写新，镜像 `update_sequence` 的单事务口径）。
  后果：**导入的序列等于用序列页 PUT 一遍** —— `plan` 重归一、`wrap` 按目标机配方
  重新冻结并重算指纹。
- **传输 / 档案** = `core.transport.validate_config`（`ValueError` → 单行跳过，这是
  路由层 400 的 SSOT）；
- **算子模板** = 形态校验（`op_code` / `name` / `category` 非空、`param_template` 是
  对象）—— `operator.py` 只读 + 播种，没有别的写入路径可复用。

**四、回收站边界（R6 §8.43 的回灌侧）**

两类要分开：

- **宿主在站里 → 单行跳过**：配方的某层协议、序列的某个步骤指令，只要 `alive()` 查
  不到就跳过并回报（`协议不存在：{id}` / `指令不存在：{id}`）。序列是**整条跳过** ——
  不写一条缺步的序列，与 R7「宿主-从属同进同出」是同一条纪律的回灌侧。
- **自己的 id 在站里 → 跳过并提示**：软删行**继续占唯一键**（R6 拍板只新增列），
  直接 upsert 会写出一条**看不见的行**；因此配方 / 序列 / 档案 / 传输配置命中回收站时
  一律 `先恢复或彻底删除`。
- **档案名 / 序列名撞车 → 跳过**（`label`、`name` 是 inline UNIQUE，包括被回收站行
  占着的名字），回执写清是哪一行占的。
- **传输配置的 `active_profile_id` 是逻辑指针**：目标机上没有那个活档案时**置空并记
  警告**，不带悬空指针进来（镜像 R6「指针删除期解除」的读侧降级口径）。

**五、回灌路径全景（C-3 至此收口）**

8 域出线（R7 §8.45）与回灌路径对应：

- `instructions.json` → **指令页 IMPORT**（既有，预览后逐条 POST）；
- `relations.json` → `POST /datahub/import/relations`（既有，批次四 4a）；
- `recipes / sequences / transport / profiles / templates` → **本批 5 条新端点**；
- `frames/*` → 派生物，**不回灌**（按指令重编译即可）；
- 协议本体 → **不在 8 域内**（§8.45 五的已知观察）：`协议页导出 JSON` + `协议页 IMPORT`
  这条既有路径；**换机顺序 = 协议 → relations / recipes → sequences**，否则前两者会因
  宿主缺失整批 skipped。

**六、FE：一个选择器吃 5 个域文件**

DataHub 页新增「按域导入 (DOMAIN IMPORT)」面板：选文件 → 按**顶层数组键**自动识别
域名（`recipes` / `sequences` / `settings` → `transport` / `profiles` / `templates`，
键名与 path 一一对应）→ `NieRModal` 二次确认（条目数 + upsert / 跳过 / 快照三条口径）
→ POST → 回显 `新增 / 更新 / 跳过 / 警告（+ 写入步数）` → 刷新。
**识别不出域、非法 JSON、不是对象一律不出弹窗**，直接 `sysMsg` 报错（同 4a 关系导入）。
`api.importDomain(domain, payload)` **不兜白名单第二层** —— 域名由形态识别决定，
写错的路径让后端 404 detail 原样透出。

**七、测试（BE +9 → 685，FE +3 → 1036）**

`backend/tests/test_datahub.py` 新增 **3 类 9 例**：

- `TestDomainPayloadValidation`（2）：四类顶层非法 → 400 带中文 detail、
  `schemaVersion` 缺省按当前版本收、五个域的键名各自识别；
- `TestImportDomains`（5）：配方 **hash 按目标机重算**（断言 ≠ 载荷里的
  `sha256:stale`）+ 缺协议跳过 + 同 id 再导 `updated`；序列**整行进退**（缺指令整条
  跳过、再导 1 步则旧 2 步被清）；传输单行约定 + **悬空档案指针置空并警告**；
  档案**回收站占 id 与撞名两种跳过**分别命中；算子按 `op_code` upsert + 形态跳过；
- `TestDomainImportEndpoints`（2）：**顶层 400 → `safety_snapshot` 一次都没被调**
  （纯函数先于快照）、成功路径回执带上 `preImportSnapshot`。

`DataHub.test.jsx` **12 → 15（+3）**：选序列文件 → 识别域名 → 弹确认（未发请求）→
确认才 POST 原文 + 回显四段计数与「写入步骤 2 步」+ 刷新；**五个域文件逐个识别且取消
不发请求**（`transport` 认 `settings` 键）；非法 JSON / 识别不出域直接报错。

**验收**：**BE 676 → 685/685**、**FE 1033 → 1036/1036（69 文件）**、
`npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器改动文件
**0 违规**（`DataHub.jsx` / `api/datahub.js` / `api/index.js`）；**零 DDL**；
`pageStatus.json` 数据中心页补「按域导入」口径 → `PAGE_STATUS.md` 已重生成；
`vectors/` 未动；`frontend/red-report.json` 不入库。

**已知取舍**：`frames` 不设回灌端点（重编译即可）；协议域仍不在包内（§8.45 五），
C-3 拍板的「8 域」未扩为 9 —— 若日后要一条命令搬干净，需另拍「协议是否入包」。

**文档同步（同批）**：本节 §8.46、§8.37 R8 行标已办、§8.36 C-3 行状态、
§1 `R1–R10` 状态、`PROJECT_HANDOVER.md` 条目 55。

### 8.47 R9 · 解码展示面板 —— 命中应答逆向还原成「字段 = 值」（C-2 选 C 前半 · 纯 FE · 零 DDL）

**它是什么问题**（§8.36 C-2 现状）：编码一直是单向的 —— 全仓 `decodeFields` /
`decodeResponse` / `parseResponse` **0 命中**，`response_match` 只输出 pass/fail +
reasons（字节差异），**从不回填字段值**。`vectors/float_ieee.json` 里 `3.14 → 4048F5C3`
有一整组编码向量，反方向 `4048F5C3 → 3.14` 却没有任何实现。于是发「读电压」收到应答，
页面只给 MATCH OK + raw hex，人要自己对照协议心算 —— 排「发对了但值不对」时每条都要
手工换算。

**拍板（§8.37 R9 行）** = C-2 选 C 的**前半**：命中应答按 `stages` 逆向取值
（**与编码器对偶**，拿 `vectors/*.json` 反向验证）+ 发送历史显示 `字段 = 值`；
层 = **FE**、零 DDL（入库回写 = R10 ✅ §8.48）。

#### 一 · 对偶解码器 `utils/InstructionDecoder.js`

**布局与编码器共用一份** —— 把 `encodeInstruction` 里的树布局（扁平字段 → `roots` +
逐节点 `childrenOf`）抽成公开的 `InstructionEncoder.buildLayout()`，编码与解码同调一处
（**改一必改二**）；`emitNode` 的组 `align` / `pad_to` / `repeat` / `presence` 判定逐字
镜像进解码游标：组对齐补零在首副本前一次、`pad_to` 在末副本后一次，叶按 copies 逐份
align → 内容 → pad。

**叶字节长度不自己算，向编码器要**：`getFieldBytes(field, …).length` 是唯一真相源
（长度随 op / `params.hex` / `byte_len` / 定长串而定，自算必然漂移），值再从响应帧里
**读**。⇒ 布局是**结构对偶**，不是第二套实现。

**值解码分派与 `_encodeFieldBytes` 同序**：静态 hex（`FIXED` / `HEADER` / `TAIL` /
`HEX_RAW` / 协议叶 `hex_value`）→ 文本（ascii 逐字节、utf8 走 `TextDecoder`）→ 旧
`float` / `decimal` 路径 → 纯 hex → BITFIELD 聚合整数 → INT_SIGNED 两补码（宽帧走
BigInt 防精度丢失）→ BCD packed 十进制 → FLOAT_IEEE 大端（f32/f64 按 `byte_len`
分水岭）→ 缺省无符号 + `SCALED_DECIMAL` **反定标** `raw/factor − offset`。**LITTLE 先
整体还原**（对偶 `getFieldBytes` 的 wrapper；组容器不整体逆序，与编码一致）。

**presence / repeat 走同一份值链**：调用方给了 `inputs` / `computedValues` / `now`
就与编码期**逐字一致**；不给（真机应答手上没有表单输入）走静态链，`_presenceHit`
fail-open → 缺省照读、不吞字节。返回 `{fields, consumed, total, residual, warnings}`，
把「帧长与字段布局不一致」**看得见**：短帧逐字段标 `truncated` + 警告、尾部多出的字节
计入 `residual` 并告警 —— 不静默给错值。

#### 二 · 反向验证 = `encode ∘ decode = id` 不动点（vectors 单一真相源）

拍板要求「拿 `vectors/*.json` 反向验证」，做法是**不动点断言**：取共享向量表的已知帧
→ 解成值 → 用**同一个编码器**把这个值编回同一帧 → 必须逐字节相同。它比「解出的值等于
向量里的原始输入」更强也更诚实 —— 编码本身有归一（bool → 1、非法字符串 → 0、NaN → 0、
定长补齐、LITTLE 逆序），不动点不要求解码器猜回**编码前**的原始输入，只要求它把**帧里
真实存的信息**还原到能被编码器原样复现。

覆盖表：`float_ieee.f32` 与 `f64`、`int_signed`、`bcd_scaled.bcd`、`bcd_scaled.scaled`
（反定标）、`string`（含 `pad_char` 补齐的 NUL）、`little_endian`（LITTLE 逆序的对偶）、
`bitfield.pack`、`time_counter.time`（以解出的秒数反推墙钟编回原帧）、
`time_counter.auto`（以状态回推合法前态编回原帧）。另加一例整帧：组 `align` +
`repeat ×3` + `presence` + LITTLE 混排，**解出来的值原样重编 = 命中应答逐字节相同**。

#### 三 · 两处接入

1. **指令加工 · 事务面板**：`TXN_OK` 后取「最后一次成功 attempt 的 `received`」按指令
   字段布局解码 → `DecodedFields` 面板出 `字段 = 值`（带字段数 / 字节数统计头）。
   指令无 `fields`、未命中（FAILED）、解不出 → **不出面板**（不是错误）。
2. **通讯调试 · 发送历史**：`historyRows(records, { instructionsByName })` 多出的第二个
   参数（**缺省时行形状逐字不变**）把**响应帧**解成 `字段 = 值` —— 表格新增「字段 FIELDS」
   列（单行预览 + `title` 看全量），详情「响应与错误日志」面板出完整字段表（名称 · 值 ·
   字节区间 · 警告）。解**响应**而非发送帧（值在应答里），raw hex 列仍显示发送帧。

#### 四 · 边界与降级（都登记，不藏）

- **无字段布局 → 不解码**：指令没有 `fields`（或 `fields: []`）时不出面板、也**不出**
  「尾部残字节」警告 —— 那是空布局的假警报，不是应答的问题（本批实测踩过一次，
  三字节应答 + 空布局 → 出了一条假的 `residual` 警告）。
- **解不出就不出**：无指令名 / 指令已删 / 无响应 / 映射里没有这条 → 视图模型**不加键**
  （历史列显示 `—`），不加假数据、不报错。
- **已知不可逆三条**（都有断言锚定，不是 bug）：① **f32 溢出位型**（`1e300 → 7F800000`
  即 +Inf）解得出 `Infinity` 却编不回去 —— 编码器把非有限输入归 0 是既有 byte-equal
  契约（`orchestrator._float_number` 同口径，f64 也绝不写出 Inf 位型）；② **utf8 定长
  截断**（`'中'@2B` 只留半个码点 `E4B8`）解出 `U+FFFD`、再编码成 `EFBFBD` —— 截断的
  UTF-8 天然不可逆（ascii 截断反而可逆：`'中' &0xFF → 2D` 解回 `'-'` 再编仍是 `2D`）；
  ③ **AUTO_COUNTER 是状态机**（`(Current+Step)%Max`），解出的是「编码那一刻的计数状态」
  而非输入；TIME_ACCUMULATOR 反之可逆（解出秒数、以 `base + 秒×1000` 反推墙钟即可编回
  原帧）。
- **展示层收敛 ≠ 值**：`formatFieldValue` 对非整数按 7 位有效数字收敛
  （`3.1399998664855957` → `3.14`，拍板举例就是 `voltage = 3.14 V`）并剥掉定长补齐的
  NUL / 尾空格；**解码值本身一个字节不动**（round-trip 以原值为准）。整数与 `>1e10` 的
  值不碰（免得 `12345678901` 被写成 `12345680000`）。

#### 五 · 测试与验收

- **新 `utils/__tests__/InstructionDecoder.test.js` 21 例**（三段：反向验证不动点 /
  整帧对偶 / 入口口径与异常帧）+ `DecodedFields.test.jsx` **3 例** +
  `TransactionPanel.test.jsx` **+2**（命中出面板且无警告 / 未命中与无 `fields` 均不出）+
  `terminalPanes.test.js` **+4**（解码路径 / 三种降级不加键 / 短帧标 `truncated` /
  `decodeHistoryRow` 空入参不抛）。
- **验收**：**FE 1036 → 1066/1066（71 文件）**、BE 685/685（本批未碰后端，全量复跑）、
  `npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器改动文件
  **0 违规**；**零 DDL**（`models.py` 一个字符未改）、未碰 `processor.py` / `graph.py` /
  `Blueprint.jsx`、`/dispatch` 缺省口径逐字节不变、`vectors/` 未动、
  `frontend/red-report.json` 不入库。
- **顺手清理**：把 `encodeInstruction` 的树布局抽成 `buildLayout()` 属**纯搬移**
  （搬移当时 `src/utils` 607 例全绿），不是行为改动。

**文档同步（同批）**：本节 §8.47、§8.37 R9 行标已办、§1 `R1–R10` 状态、
`pageStatus.json` 指令加工 + 通讯调试两页补「解码展示」口径 → `PAGE_STATUS.md`
重生成、`PROJECT_HANDOVER.md` 条目 56。

### 8.48 R10 · 入库回写 —— 应答解码随日志落库（C-2 选 C 后半 · BE+FE · 全计划唯一 DDL 批）

**它是什么问题**（§8.47 留下的后半）：R9 的解码是**瞬时**的 —— 结果只活在渲染那一刻。
指令后来被删/改，历史里那条应答就再也解不出来（客户端只能查活行）；序列跑在 daemon 线程，
客户端手上根本没有那帧的上下文；`vectors` 能验「编得出」，但**日志本身不留值**，事后
「按应答值决策 / 追溯对账」无据可查。

**拍板（§8.37 R10 行）** = C-2 选 C 的**后半**：`dispatch_logs` 加 `fields_json`
（**仅新增列，合 §0，全计划唯一 DDL 批**）+ `/dispatch/history` 回填 `fields`；
层 = **BE + FE**。

#### 一 · 布局不写第二套（本批最关键的一条取舍）

`fields_to_blocks` 是编译侧 SSOT（presence 门 / repeat ×N 展开 / endianness / align /
`pad_to` / `byte_length` 全在里面），解码**直接复用**；`Orchestrator._flatten_recursive`
外面套一层公开 `flatten()` —— 编码 `process()` 与解码**共用同一份扁平流**（`_PadMark`
容器补位标记 + 叶块），只是编码往 `final_hex` 追加、解码按游标往 `data` 切片。⇒ **布局算法
只有一处**，「改一必改二」的前提不破；`process()` 里只把那几行换成一次 `self.flatten()`
（纯重构，编译期输出一个字节未变）。

长度取值与 `process()` 的 `val = hex_value or "00" * byte_length` 同源：有 `hex_value` 就按
它量（＝真实出帧字节数），`byte_length` 只是占位尺寸；`length` / `checksum` 两型例外 ——
编码期由 handler 按 `byte_length` 重算覆盖，故恒按 `byte_length` 量。两者同时非零却不相等
= 配置矛盾 → 按 hex 量（真实出帧字节）并**留一条 warning**，让「帧长与字段布局对不上」
看得见而不是静默出错值。

值分派与 FE `decodeFieldBytes` **逐条同序**（静态 hex → 文本 → 旧 float/decimal → 纯 hex →
BITFIELD 聚合 → 两补码 → BCD → FLOAT_IEEE 大端 → 缺省无符号 + `SCALED_DECIMAL` 反定标），
LITTLE 先整体还原。**非有限浮点必须在落库前折成字符串**（`"Infinity"` / `"-Infinity"` /
`"NaN"`）：`json.dumps(float('inf'))` 产出的是非法 JSON，FastAPI 响应层会直接 500；给 `None`
又会把「这帧是溢出位型」这条信息悄悄吞掉。

#### 二 · 单一接缝：四条写入缝都过 `db/log_store.record_log`

写日志有四条缝（manual / transaction / sequence / replay），其中**序列路跑在 daemon 线程、
回放路没有表单输入**，靠各调用方自己记得算是靠不住的。故回填写进 `record_log`：`fields`
没传就自己 `resolve_log_fields(...)` 解一遍，传了就用传的（回执与落库共用**同一次**解码，
绝不各算一遍 —— 否则同一事件可能因指令后续被改而显示不同值）。

`resolve_log_fields` 的口径：

- **无应答**（`echo` 空）→ `NULL`，且不打 DB 查询（ERROR 路几乎全是这种）；
- **指令不可解析** → `NULL`：`instruction_id` 优先（事务 / 序列 / 回放的逻辑外键，**不看
  软删** —— 日志行留存的正是那条指令，指令进了回收站也该解得出来，这比 FE 只能查活行更强）；
  无 id 才按 `instruction_name` 找，且只在未软删行里按 id 稳定序取首个（与 FE 从
  `/instructions` 活行清单取第一个对齐）；
- **无字段布局** → `NULL`（R9 同口径：空布局只会生出「尾部残字节」假警报，不出）；
- **绝不抛**：解码跑在写日志的同一条路径上，抛了会把日志本身一起 rollback 掉 —— 真出异常
  就把消息写进 `warnings` 落库，「解不出来」看得见、不是静默变 `NULL`。

#### 三 · 分层：编译口径搬进 `core/field_blocks.py`

解码在 core，而编译口径原先躺在 `routers/datahub.py` —— **core 不能反向依赖 routers**。
故把 `_presence_hit` + `fields_to_blocks` **纯搬进** `backend/core/field_blocks.py`，`datahub`
**原名再导出**（`from backend.core.field_blocks import ...  # noqa: F401`）：测试与 datahub
内部的 `from backend.routers.datahub import fields_to_blocks` 一行未改、行为逐字不变（搬移
当时 BE 685 例全绿）。ORM → 解码器输入的字段字典在 `log_store` 里做**窄映射**（只列参与布局
的列；`bits` 不需要 —— 位域打包是编码期行为，解码侧只回聚合整数）。

#### 四 · 两处回执与读侧

1. **`/dispatch/history`**：`DispatchRecord` 多一键 `fields`（可选，缺省 `None`），manual /
   transaction / replay 三处各解一次、同时喂给回执与 `safe_log`。**内存 deque 与 DB 表不是
   同一份**，拍板要求两边都回填 —— DB 侧由 `record_log` 自己兜（序列路只走这条）。
2. **`/logs`**：列表 `DispatchLogOut.fields`（列名 `fields_json` → 对外一律 `fields`，两端
   同名同形，FE 直接喂 `DecodedFields`，别名 `AliasChoices` 同时认 ORM 形与 dict 形）+ JSON
   导出带 `fields`；**CSV 列集 `_CSV_COLUMNS` 逐字不变**（导出即归档，不改既有表头）。

#### 五 · FE：优先消费服务端回填

`decodeHistoryRow` **先吃 `record.fields`**（后端写日志那一刻解好、与 `fields_json` 是同一
次解码），拿不到才回落 R9 客户端解码。它比客户端解码强在两处：① 指令后来被删/改也解得出
（值随日志留痕，不依赖当前 `/instructions` 还在不在）；② 序列路 daemon 线程那帧，客户端当时
没有上下文。空壳（0 字段且 0 警告）视为没解出来 → 继续回落，**存量行的行形状与 R9 逐字不变**。

#### 六 · 边界与降级（都登记，不藏）

- **存量行不回填**：migration 0003 只 `ADD COLUMN`，既有行 `fields_json` 保持 `NULL` ——
  展示层退回 R9 客户端解码兜底，不做任何历史数据改写（合 §0「只做加法」）。
- **解不出就 `NULL`**，不是空对象：客户端据此回落，不会把「后端解过但空」与「后端没解」
  混为一谈。
- **BE 只出骨架帧**（`to_block` 不编 `INPUT` 值）是既有现状、与本批无关：解码读的本来就是
  设备回的那几个字节，编译侧只负责给布局与宽度。
- **告警文案与 FE 逐字相同**（非十六进制 / 奇数位 / 比字段布局短 / 尾部多出 N 字节）——
  两端显示同一句话。
- **回执的 `fields` 与 `fields_json` 必须同源**：路由里解一次、两处共用，杜绝「列表和历史
  显示不一样值」。

#### 七 · 测试与验收

- **新 `backend/tests/test_field_decode.py` 35 例**（取值层各算子锚 + 布局区间 + 告警与诚实
  回报 + 回写侧 `resolve_log_fields` 七条口径 / `record_log` 自动回填 / 手动路回执与落库同源 /
  序列钩子 / 读侧列表与导出）+ `test_migrate.py` **+3**（存量库补列且存量行留 `NULL`、新库
  只验不改、verify 真查列）+ `test_soft_delete.py` 的 0002 断言改成「从 0001 起的全部待执行
  迁移、0002 必须排第一」（新增迁移不再硬编码进断言）。
- **验收**：**BE 685 → 723/723**、**FE 1066 → 1069/1069（71 文件，`terminalPanes` +3）**、
  `npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器改动文件 **0 违规**；
  `vectors/` 未动、`frontend/red-report.json` 不入库、`processor.py` / `graph.py` /
  `Blueprint.jsx` 未碰、`/dispatch` 缺省口径逐字节不变。
- **DDL 仅此一处**：`models.py` `DispatchLog` **仅新增** `fields_json` 一列 + `migrate.py`
  追加 0003（apply = 缺则 `ALTER ... ADD COLUMN fields_json JSON`；verify = 补列范围**恰好
  `dispatch_logs` 一张**、列缺失即报错）。

**文档同步（同批）**：本节 §8.48、§8.37 R10 行标已办、§8.36 C-2 行收口、§1 `R1–R10`
全数完成、`pageStatus.json` 通讯调试页补「入库回写」口径 → `PAGE_STATUS.md` 重生成、
`PROJECT_HANDOVER.md` 条目 57。

### 8.49 R10 后剩余项盘点与排期（R11–R18 · 文档批 · 零代码）

**批次**：2026-10-03 · **纯文档批、零代码、零 DDL** —— R10 收口后，把三处待办总盘
（`PROJECT_HANDOVER.md` §5「待办 / 下一步」57 条、`pageStatus.json` 八页 `nextSteps`、
§8.34 B/C 组与 §9.7）**逐条对账**：能做的排期，不能做的写清为什么不能，已过期的说法就地纠正。

#### 一 · 对账结论：此前所有排期项已全数闭合

- HANDOVER 条目 1–57 **无一开放**（每条要么 ✅，要么划线注明已落地 / 已提交）；
- §8.37 排期 **R1–R10 共 11 批全数完成**（§8.38 → §8.48）；
- §8.16 业务场景 **N1–N5 + G5 双端硬拦插队批全部实现并真机验证**，G1–G7 结项；
- §8.34 A 组 9 处过期说法、C 组 5 项待拍板（→ §8.36 已全拍定）均已收口。

#### 二 · 本批就地纠正的三处过期说法（`pageStatus.json` = 页面状态唯一事实来源）

| 位置 | 原说法 | 纠正后（事实） |
|---|---|---|
| `pageStatus.json` 指令页 `availableNow` | B2–B8 编码器未实现语义**已在配置面显式标注**（⚠ 角标 / 横幅，仅记录不生效） | E1 批 E1-1..E1-6 已落地 → `utils/encoderLimits.js` 的 `ENCODER_LIMITS` **已清空**（`validateInstruction.test.js` 断言「B2–B8 全部撤除」），配置面不再出 ⚠；校验保留的是**结构错误阻断** |
| `pageStatus.json` 指令页 `nextSteps` | 把 B2–B8 从标注推进为**真实编码语义**（需授权修改双端编码器） | **已落地**（§1 E1 行 `23ca9c5`，2026-09-23 双端解禁）→ 删除该条，指令页只剩「补更细的字段引用测试」 |
| `pageStatus.json` 编排页 `nextSteps` | 绑定拖拽排序 —— **拖拽交互未做** | **已落地**（R4 §8.41，2026-10-02）→ 改「无」并记口径（拖完只改展示序，点 SAVE 才改持久序） |

同批给 §8.14 调研批头注与 §8.34 B3 补「**解码回程已由 R9/R10 收口**」的销项注；
`PAGE_STATUS.md` 已随 `pageStatus.json` **重生成**（`npm run sync:page-status` EXIT=0）。

#### 三 · 剩余项四类分流

**① 仍需真机（不排期，等硬件）~~：§9.7 ① 载荷含定界字节的**出线**方向（D13「有 LEN =
不需要转义」在真机上是否异常）= §8.34 B1-2 —— 与应答方向的 §8.35 不是一回事，环回下无法定论。~~
→ ✅ **已销（2026-10-03，§8.51）**：改走 §8.35 同一套**公开规范模拟真机**的方法（IEC
60870-5-104 / DL/T 645-2007 / Modbus TCP 三条有长度域协议的真帧 + 仓内 10 例仿真）——
**本类自此无开放项**，真机帧不再承载任何前置用途。

**② 触发式 / 不做（§8.36 拍板，不排批）**：C-1 = **A 不立项**；C-5 ① CRC 多算法、② 长度域
BE/LE = **真机提出即插队** → **2026-10-03 复议提前立项并落地（② R21 ✅ §8.53、① R22 ✅
§8.54，两项触发式清零）**；③ varint/COBS = **明确不做**；§8.14 余三项同源；
`BUSINESS_SCENARIOS.md` 挂账三项（epoch 模板 / 加扰混淆 / 创建后切 op）= 软缺口、有替代、不排期。
**→ 本类已于 2026-10-03 复议全数立项（§8.52，编入 R21–R28）**；唯一维持不立项的是 ③ 加工页传输（D9-A）；**挂账 ① epoch → R23 ✅ 已完成（同日，§8.55）**。

**③ 需用户拍板（登记，不自行推进 —— 自主推进到此为止）**：

1. **加工页「展示当前传输模式与连接状态 + 本页切换 loopback/TCP/串口」**（`processing` 页
   `nextSteps`）—— 与 **D9-A「传输层唯一归属点」正面冲突**（该拍板把 loopback/TCP/串口、
   目标地址、超时、档案全部划给通讯调试页与 transport 抽象）。要做得先拍两件事：**只读状态
   回显**（不冲突）与**可切换**（冲突）是两件事，可分开拍；
2. **数据中心「数据包示例下载」口径**（`datahub` 页 `nextSteps` 前半）—— 「示例」指种子数据
   样例 / 空 schema 模板 / 一条真实指令的完整包，三者成本差一个量级，口径不定不写代码；
3. **设备档案「排序」**（`terminal` 页 `nextSteps` 里的排序诉求）—— 现列表是服务端
   `label ASC`（与 `profiles.json` 导出行序一致、**导出可 diff**）；要用户自定义序就得新增
   `sort_order` 列 = **动 DDL** 并重排导出口径 → 归入拍板。**档案重命名不在此列**：后端
   `PUT /profiles/{id}` 已支持 `label` 改名与撞名查重，只缺 FE 入口（故 R15 只做重命名）。

> **2026-10-03 拍板回执**（三项全部答复）：① **维持 D9-A，不立项**（传输切换仍只归通讯调试页，
> 只登记不推进）；② 取**动态导出**口径 —— 用当前库现做一份，不用仓内静态样例 → **R19**；
> ③ **允许新增 `sort_order` 列（DDL 点头）** → **R20**。去向、排期与终态见 **§8.50**。

**④ 可直接推进 → 排期 R11–R18**（全部**零 DDL**、都不碰 `processor.py` / `graph.py` /
`Blueprint.jsx`、`/dispatch` 缺省口径逐字节不变）。

#### 四 · 排期表（R11–R18）

| 批 | 来源 | 内容 | 层 | 量级 | DDL |
|---|---|---|---|---|---|
| **R11** | 本节 | **文档批**：三处过期说法纠正 + 两处暂缓项销项注 + 本节盘点排期 + `PAGE_STATUS.md` 重生成 | 文档 | 小 | 否 |
| ~~**R12**~~ ✅ | `sequences` 页 | **序列步骤拖拽排序** → **已落地**：抽 `StepRow` 组件（钩子不进 `.map()`，同 R4 `BindingRow` 先例）+ 行首**空白 grip**（无文本节点 → 不动按钮里的 label 文本、非 button → 行内三个 button 顺序照旧、只挂 `listeners` 不挂 `attributes`）+ `DndContext`（8px 起拖阈值）→ 松手走 `utils/sequenceView.reorder` **只改草稿数组序、零即时 PUT**，点「保存定义」才整体 PUT（后端本就按数组序重编 `step_order`、整组替换 → **零 BE 改动**）；**编辑器开着的那步按区间平移跟着落点走**（与 `moveStep` 同口径，拖拽跨度可大于 1）；运行中拖拽与上移/下移同一禁用口径 | FE | 中 | 否 |
| ~~**R13**~~ ✅ | `trash` 页 | **回收站按类型筛选 + 批量恢复 / 批量彻底删除** → **已落地**：chips 按 kind 带计数（**只切可见行、不重排** —— 行序仍由后端「最近删的在前」定）+ 行首复选框 / 表头全选当前筛选 + 动作条三件（批量恢复 / 批量彻底删除 / 清除选择）；批量**仍过同一个确认弹窗**（先把名单摆出来、超 8 条折叠），执行**逐条串行、半成如实回报**「成功 N / M + 失败明细逐条列出」（后端本就是单条接口，不做整批事务、不静默吞错），跑完清空选择、`refresh` 按现存条目**剪枝勾选**（不留幽灵勾）；该类型无条目时不冒充「回收站为空」而给「清除筛选」出口 | FE | 中 | 否 |
| ~~**R14**~~ ✅ | `terminal` 页 | **串口端口枚举 + 波特率预设** → **已落地**：`GET /transport/ports`（**只读、不碰配置**）pyserial `list_ports.comports()` + **自然序**排序（`_port_sort_key` 每段打类型标记：纯字典序会把 COM10 排到 COM3 前，且保证不拿 int 比 str）；**绝不 500** —— 缺 pyserial / 枚举炸都降级 `{ports:[], source:"unavailable", error:"<原文>"}` 让配置页照常用。FE：SERIAL 段出端口芯片（点芯片填 `PORT`、悬停看描述、选中态随草稿派生）+「刷新端口」重拉 + 波特率预设档 1200..115200（点档位填输入框，**输入仍可任意键入** —— 预设不构成取值白名单），**都只改草稿**、仍需点 APPLY 才落库；`api/index.js` barrel 补 `getTransportPorts` 导出 | BE+FE | 小 | 否 |
| ~~**R15**~~ ✅ | `terminal` 页 | **设备档案重命名 + 状态 / 发送历史自动轮询** → **已落地**：① 「重命名 (RENAME)」独立入口展开改名行 —— 预填当前名、名字没改不放行，确认**只 PUT `label`**（不动配置快照，与「更新 = 写入配置快照」两码事），撞名 400 detail **原文透出**、行留着让用户改（**含回收站里占名的软删档案** —— 后端 `_checked_label` 不过滤软删），放弃零调用；② 连接状态面板「自动刷新 AUTO · 5s」开关（默认开）—— 状态与历史每 5s 一起拉，**仅标签页可见时走**（`visibilitychange` 停/起），关掉彻底停、手动刷新照旧，失败只写错误条不打断下一轮 | FE 为主 | 中 | 否 |
| ~~**R16**~~ ✅ | `terminal` 页 | **报文格式切换 hex / ascii / 二进制位图** → **已落地**：三面板上方一条「显示格式 FORMAT」开关，**一次点击换三处**（发送历史预览列 + 原始报文 + 响应面板）。hex = 8 字节/行且与存量 `hexDump` / `hexPreview` **逐字相同**（未知口径回落 hex）；ascii = 每字节 1 字符、8 字节/行（可打印原样、控制符与高位 `.`、非法 token `?`）；bin = 每字节 8 位补零、4 字节/行。**只换怎么摆、不换字节** —— 发送 / 入库 / 校验口径不碰；纯函数 `frameLines` / `framePreview` + `historyRows(ctx.frameFormat)`（不传 ctx = 逐字不变），面板 hint 随口径同步 | FE | 中 | 否 |
| ~~**R17**~~ ✅ | `datahub` 页 | **按域独立导出包** `GET /datahub/export/bundle?domains=…` → **已落地**：页面 8 域芯片（顺序 = `BUNDLE_DOMAIN_VERSIONS` 键序 = 导出序）+「导出所选域」（全不选禁用）。**缺省不带参数 = 现行 8 域逐字不变**（文件集合 / manifest 三键 / 下载文件名逐字节不动，全量按钮仍无参）；manifest 只列**包里真有的域**（`domainVersion` · `domainCounts` 键序仍按 8 域表），`instructionCount` · `relations` · `frames` 描述**这个包**（没选中的归 0 / 置空）；`frames` 独立可单选（不选不编译）；非法 `domains`（空项 / 未知 / 重复）400 带可选全集、不静默忽略；**协议仍走协议页既有导出**，不借机重开「第 9 域」决策 | BE+FE | 中 | 否 |
| ~~**R18**~~ ✅ | `instruction` 页 | **字段引用测试补强** → **已落地（纯测试零代码）**：`useInstructionData.test` +6 钉**交叉**行为（单条路径已各自覆盖）—— 块移动后删前计数照常按 id 拉（只认后端、不看本地把块挪到第几格）且确认后连草稿与脏标一起收口 / 取消确认零 DELETE 且再删一次**重新拉计数**（不跨次缓存）/ 计数拉到但 DELETE 失败 → 报错留台 · 指令与草稿都在 · 脏标不清 / 块移动 → PUT 400 → **顺序与脏态都不回滚** → 撤销回移动前 → 重试成功清横幅 · 脏标 · 撤销栈；另补 `describeDeletion` 只报非零那一段、`describeReferences` 仅日志被引用不冒充无引用 | 测试 | 小 | 否 |

**R12 终态（2026-10-03）**：**纯 FE、零 DDL、零后端改动** —— BE **723/723**（未碰后端，
全量复跑）、FE **1069 → 1072/1072（71 文件，`Sequences.test` +3**：草稿序翻转而
`updateSequence` 零调用 / 编辑器跟随落点 / 运行中忽略拖拽）、`npx vite build` EXIT=0、
`npm run lint` **EXIT=0**、yorha-ui 校验器 3 文件 **0 违规**；`pageStatus.json` 序列页两处
更新（`availableNow` 补拖拽口径 + `nextSteps` 置「无」）→ `PAGE_STATUS.md` 已重生成。

**R13 终态（2026-10-03）**：**纯 FE、零 DDL、零后端改动** —— BE **723/723**（未碰后端，
全量复跑）、FE **1072 → 1075/1075（71 文件，`Trash.test` +3**：chips 计数与子集行序 /
批量恢复逐条 POST + 成功 N / M 回执 + 选中清空 / 批量删除过弹窗取消零调用、半成明细
逐条报出）、`npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 2 文件
**0 违规**；`pageStatus.json` 回收站页 `availableNow` 补一条 + `nextSteps` 置「无」→
`PAGE_STATUS.md` 已重生成。

**R14 终态（2026-10-03）**：**零 DDL** —— BE **723 → 727/727**（新
`test_transport_ports.py` 4 例：形状与自然序 / 空列表是正常态 / 枚举抛异常降级 /
pyserial 缺失降级，两条降级路径都**绝不抛**）、FE **1075 → 1078/1078（71 文件，
`Terminal.test` +3** = 挂载即拉 + 芯片填表单 + 刷新重拉 / 预设档随 APPLY 数字提交 /
降级原文显示且配置区照常）、`npx vite build` EXIT=0、`npm run lint` **EXIT=0**、
yorha-ui 校验器 6 文件 **0 违规**；`pageStatus.json` 通讯调试页补 R14 条 + `nextSteps`
删已办的枚举项 → `PAGE_STATUS.md` 已重生成。

**R15 终态（2026-10-03）**：**纯 FE、零 DDL、零后端改动**（改名复用既有
`PUT /profiles/{id}`，轮询是纯前端 effect，后端一行未动）—— BE **727/727**（全量复跑）、
FE **1078 → 1081/1081（71 文件，`Terminal.test` +3**：改名只送 label 且预填·禁空·禁未改 /
撞名 detail 原文透出且放弃零调用 / 假时钟下 5s 一跳、切后台停、回前台恢复、关开关彻底停）、
`npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 2 文件 **0 违规**；
`pageStatus.json` 通讯调试页 `availableNow` 补 R15 条 + `nextSteps` 删已办的重命名与轮询两项
（**排序**改记为「需新增 sort_order 列 = 动 DDL，§8.49 三 已归入需拍板」）→
`PAGE_STATUS.md` 已重生成。

**R16 终态（2026-10-03）**：**纯 FE、零 DDL、零后端改动** —— BE **727/727**（全量复跑）、
FE **1081 → 1086/1086（71 文件，`terminalPanes.test` +4、`Terminal.test` +1**：
hex 与 `hexDump` / `hexPreview` 逐字相同、ascii 每字节 1 字符（含非法 token 显 `?` 的
防御）、bin 4 字节/行位图、`historyRows` 只换预览列不碰其余列、UI 一次点击换三处且切回
hex 逐字不变）、`npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 4 文件
**0 违规**；`pageStatus.json` 通讯调试页 `availableNow` 补 R16 条 + `nextSteps` 删已办的
格式项（只剩「档案自定义排序 = 待拍板」）→ `PAGE_STATUS.md` 已重生成。

**R17 终态（2026-10-03）**：**零 DDL** —— BE **727 → 733/733**（新
`test_datahub_bundle_domains.py` 6 例：`parse_bundle_domains` 缺省 / 顺序 / 三类 400 +
端到端缺省 8 域回归 / 子集只出所选 / `frames`·`instructions` 独立可选 / 显式全 8 域 ≡ 缺省）、
FE **1086 → 1092/1092（72 文件，`DataHub.test` +2、新 `api/__tests__/datahub.test.js` +4**：
芯片按 8 域表顺序下载 · 全不选禁用 / 全量无参回归 / 三种拼串口径 / 400 detail 原样透出）、
`npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 6 文件 **0 违规**；
`pageStatus.json` 数据中心页 `availableNow` 补 R17 条 + `nextSteps` 收敛成只剩「数据包示例下载
口径 = 待拍板」→ `PAGE_STATUS.md` 已重生成。

**R18 终态（2026-10-03）**：**纯测试零代码** —— BE **733/733**（未碰后端，全量复跑）、
FE **1092 → 1098/1098（72 文件，`useInstructionData.test` +6**：4 例组合面 + 2 例纯函数
分档）、`npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 2 文件 **0 违规**；
`pageStatus.json` 指令页 `availableNow` 补 R18 条 + `nextSteps` 收敛成「无 —— 指令页三条待办
全部出清」→ `PAGE_STATUS.md` 已重生成。**§8.49 排期 R11–R18 八批至此全部落地**（余账 =
三类需用户拍板项 + 一项需真实设备帧）**→ 两项余账已清零：三项拍板 2026-10-03 收齐 →
§8.50（R19/R20 落地）、真机帧一项 → §8.51 销项**。

**为什么是这个顺序**：先还「说的和做的不一样」的账（R11 文档），再做**零 BE 风险、有 R4
先例可镜像**的两批（R12 / R13），然后补通讯调试的可用性（R14 枚举 → R15 重命名 + 轮询 →
R16 显示口径），最后才是动导出接口的 R17 与纯测试的 R18。

**验收口径（每批）**：BE `python -m unittest discover -s backend/tests -t backend/tests`
全绿、FE `npx vitest run` 全绿、`npx vite build` EXIT=0、`npm run lint` EXIT=0、
yorha-ui 校验器改动文件 0 违规、`pageStatus.json` 有改动则 `npm run sync:page-status`
重生成 `PAGE_STATUS.md`；**一批一提交**（代码 + 文档合一个 feat 提交）；**R11 为文档批，
不跑测试**（沿 §8.34 / §8.36 / §8.37 先例）。

## 8.50 拍板后追加排期（R19–R20 · 2026-10-03 用户拍板）

§8.49 ③ 登记的**三项「需用户拍板」**已于 2026-10-03 拿到答复，三项全部落定 ——
自主推进不再止步于「登记不推进」，按下面的口径排 R19–R20：

| 拍板项（§8.49 ③ 原文序） | 2026-10-03 结论 | 去向 |
|---|---|---|
| 1 · 加工页「展示传输状态 + 本页切换 loopback/TCP/串口」 | **维持 D9-A（传输层唯一归属点 = 通讯调试页），不立项** | 从 `processing` 页 `nextSteps` 摘除，**只登记不推进**（§8.49 ②-1） |
| 2 · 数据中心「数据包示例下载」口径 | **动态导出** —— 用当前库现做一份，不用仓内静态样例（免维护、不会与 schema 漂移） | → **R19**（§8.49 ②-2） |
| 3 · 设备档案「自定义排序」 | **允许新增 `sort_order` 列**（`models.py` 仅新增表 / 列的既有硬约束**照旧**，本处 DDL 用户明确点头） | → **R20**（§8.49 ②-3） |

#### 四 · 排期表（R19–R20）

| 编号 | 页面 | 内容 | 类型 | 规模 | DDL |
|---|---|---|---|---|---|
| ~~**R19**~~ ✅ | `datahub` 页 | **数据包示例下载（动态导出）** → **已落地**：聚合导出区加「下载示例包 (SAMPLE)」= 复用 R17 的 `?domains=` 子集口径出**按域导入的 5 域**（recipes / sequences / transport / profiles / templates，顺序按 8 域表），与 `POST /datahub/import/{domain}` 能吃的范围逐字对齐、下下来即可试回灌；内容取自当前库现做、文件名打 `sample` 标记。**零后端改动** | FE | 小 | 否 |
| ~~**R20**~~ ✅ | `terminal` 页 | **设备档案自定义排序** → **已落地**：`models.py` **仅新增列** `device_profiles.sort_order` + `migrate.py` **REGISTRY 4 · 0004**（按 README「新增列 = 追加版本化迁移」口径，不新开 `ensure_*`）；列表排序键 **`(sort_order, label, id)`** —— 未重排（全 0）= 旧行为 label 升序**逐字不变**，重排后 1..N 稠密覆盖全部活行；新端点 **`PUT /profiles/order`**（**声明在 `PUT /{profile_id}` 之前**，单测钉死顺序）整表一次提交，`ids` 不**恰好**覆盖全部活档案（重复 / 遗漏 / 未知 / 混入回收站）一律 400 且**零写入**；新建档案未重排给 0、已有自定义序 `max+1` 追加末尾；**拖拽 + 上移下移只改草稿序、点「保存顺序」才 PUT**（镜像 R12 拍板口径）；`sort_order` 随 `profiles.json` 进包、按域回灌即还原 | BE+FE | 中 | **是** |

**R19 终态（2026-10-03）**：**纯 FE、零 DDL、零后端改动**（`backend/routers/datahub.py`
一行未动，整批只复用 R17 出线的 `?domains=` 能力） —— BE **733/733**（未碰后端，全量复跑）、
FE **1098 → 1099/1099（72 文件，`DataHub.test` +1**：示例包按 5 域调用且顺序按 8 域表 ·
文件名 `^yorha-datahub-sample-\d+\.zip$` · 文案回显域数与体积 · 全量按钮仍是无参调用）、
`npx vite build` EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 3 文件 **0 违规**；
`pageStatus.json` 数据中心页 `availableNow` 补 R19 条 + `nextSteps` 收敛成「无 —— 示例下载
已由 R19 落地，余下仅档案排序 → R20」→ `PAGE_STATUS.md` 已重生成。

**R20 终态（2026-10-03）**：**全计划第二批 DDL**（第一批是 R10 的 0003）—— `models.py`
仅新增列 `device_profiles.sort_order` + `migrate.py` **REGISTRY 4 · 0004**（`apply` 缺则
`ALTER TABLE … ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`，`verify` 钉死「恰好
device_profiles 一张」—— 多一张少一张都报错；按 `migrations/README`「新增列 = 追加版本化
迁移」的口径，不新开 `ensure_*`）。存量行拿到 **0 = 未重排** → 排序键退化成 label 升序，
**存量行为逐字不变**（回归钉子 `test_get_orders_by_label_ascending` 仍绿）。**BE 733 →
743/743**（新 `test_profile_order.py` 6 例 = 默认序回归 / 1..N 稠密且幂等 / 四类非法提交
400 且零写入 / 路由注册顺序 / 新建序号两路 / 删中间不重排；`test_migrate` +3 = 存量库补列 ·
新库只验不改 · verify 钉表与列 —— 顺带把「已记 0001/0002 → applied」的断言改成跟注册表走；
`test_datahub` +1 = `sort_order` 进包 → 回灌还原、缺席**不覆盖**、非法整行跳过）。
**FE 1099 → 1106/1106（73 文件，`Terminal.test` +3、新 `api/__tests__/profiles.test.js` +4**
= 拖 / 上移下移只改草稿序（零网络调用）· 保存才 `PUT /profiles/order` 且用返回序替换列表 ·
放弃零调用 · 400 留草稿 + 请求口径四条）、`npx vite build` EXIT=0、`npm run lint` **EXIT=0**、
yorha-ui 校验器 6 文件 **0 违规**；`pageStatus.json` 通讯调试页 `availableNow` 补 R20 条 +
`nextSteps` 收敛成「无 —— R20 落地」，**加工页 `nextSteps` 换成拍板回执**（① 维持 D9-A 不立项）
→ `PAGE_STATUS.md` 已重生成。**db 同步另开一个 `chore(db)` 提交**（沿 3a / 3c / 3d 先例）：
`python -m backend.db.migrate up` 把真库 **v1 → v4**（顺带补齐一直挂着的 0002 软删列 /
0003 `fields_json`），`backend/db/yorha.db` 不进本 feat 提交。

**为什么是这个顺序**：R19 是**零后端改动**的小批（直接复用 R17 刚出线的 `?domains=`），
先落；R20 要动 DDL 与拖拽排序、规模更大，单独一批放后面。

**验收口径**：同 §8.49（BE 全量 + FE 全量 + `npx vite build` + `npm run lint` + yorha-ui
校验器改动代码文件 0 违规 + 一批一提交）；**R20 另加 DDL 随批同步** —— 按 3a / 3c / 3d 先例：
`models.py` **仅新增列** → `ensure_*_columns` 自愈接线 → 手工 ALTER 后 `backend/db/yorha.db`
**单独同步提交**。

### 8.51 §9.7 ① 出线方向销项：联网取公开规范真帧 + 仓内仿真（「需真实设备帧」最后一项）

**批次**：2026-10-03 · **测试批 + 文档批，零产品代码改动、零 DDL、`pageStatus.json` 未动** ——
按用户 2026-10-03 指令「真实设备帧的问题，需要你自己**联网查询设备帧**并在项目里**模拟**」，
把 **§8.34 B1-2 / `DESIGN_CorePipeline.md` §9.7 ①** 这项唯一挂着「需真机帧」的开放项，
按 **§8.35 同一套方法**（联网取公开规范的真帧、**不等硬件**）收口。

#### 一 · 为什么这样能销（方法与 §8.35 同构）

- §8.35 已用「DL/T 645 + RFC 1662 两条公开规范模拟真机应答」销掉**应答方向**；本节只换
  方向（**出线**）与规范集，方法、结论强度与留痕方式完全一致；
- 待证命题只有半句：**链路壳带长度域时，载荷里的定界字节不会让帧断错**。这不是「某台设备
  的私有行为」，而是**协议规范层面可查证**的事实 —— 公开规范里就有带长度域、载荷含定界
  字节的真实帧。

#### 二 · 联网取证：三条有长度域的公开规范（A 组 · `PublicSpecFrameTest` 5 例）

| 协议 | 帧形态与长度域 | 取到的证据 → 仓内断言 |
|---|---|---|
| **IEC 60870-5-104** | `68 <len> <4 控制> <ASDU…>`，**len = 起始与长度字节之后的全部字节、无尾定界** | 公开示例帧 `68 12 0A 00 06 00 0D 01 03 00 01 00 A1 0F 00 00 00 48 41 00`（M_ME_NC_1 12.5 MW，值 `00 00 48 41` = 0x41480000 小端）；把对象地址第三字节改成 `68` → 帧内出现**第二个 68H**：按长度域切**逐字节还原**，按「下一个 68H 当帧头」重同步则在对象地址处断错（报长度 0 而实余 4 字节） |
| **DL/T 645-2007** | `68 A0..A5 68 C L DATA CS 16`，**L = 数据域字节数（不含 CS / 16H）** | 公开收发例 CS 逐帧反算 = 公开值（`8D` / `DD`）；**关键构造**：数据域 raw `0x35` / `0xE3` 经 0x33 换算上线即 `68 16` —— **0x33 换算并不保证线上不出现 68H / 16H**，真正兜住定界的是 **L 域**；扫 16H 当帧尾会在数据域里提前收帧 |
| **Modbus TCP** | MBAP `<tid> <pid> <len> <unit> <PDU>`，**len 自 unit 起计** | 写多寄存器 PDU 的寄存器值 `68 68 7E 7E` —— 68H 与 **7EH（HDLC 旗标字节）**都在载荷里，按 MBAP 长度域照常切出完整 PDU，**一个字节都没转义** |

#### 三 · 仓内仿真（B / C 组 · `RepoWireFrameTest` 3 例 + `LenLessFramingTest` 2 例）

- **B 组**（三层配方帧，主向量 = `vectors/wrap.json::three`，与 `test_wrap_api` /
  `InstructionProcessor` 同读）：注入**含每一层头尾 + 规范定界字节**的内核
  `A0 B0 C0 E0 E1 E2 68 16 7E 7D FA ED` ——
  ① 外壳定界字节**字面在帧里**（转义只发生在第 0 层之前，外壳不进转义范围）；
  ② 自外向内按 LEN 反解 `C0 → B0 → A0`，**内核与注入逐字节相同**；
  ③ 开转义对照：壳内 LEN 按**线上（转义后）字节**重算（7 而非 5），收侧 `unescape_bytes`
  可逆；④ escape 关闭 → 出线逐字节不变（§0 硬约束）。
- **C 组 · 反例**（**无 LEN** 的纯定界帧 `FA FA … ED`，RFC 1662 同构口径）：载荷含 ED 时
  「扫第一个 ED 当帧尾」断在载荷里（载荷截断 `01` + 残帧 `02 ED`）；开转义后载荷里不再有
  裸旗标字节、唯一 ED = 真帧尾、`unescape_bytes` 可逆。**同一份载荷换成有 LEN 的壳，
  一个字节不用转就切得出来** —— 两组合起来才是 D13 那半句判据的正反两面。

#### 四 · 结论与残余风险收窄

1. **D13「有 LEN = 不需要转义」由「经验判定」升级为「与公开规范一致」** —— §9.7 ① /
   §8.34 B1-2 就地销项；
2. **残余风险收窄**为「**目标设备是否按其声明的协议实现**」= 设备个体问题、不是协议层面
   问题 → 转 **触发式**（真机上若确有断帧，对那条链路开 `escape` 即可，N4 能力已具备），
   **不再作为开放项挂账**；
3. **「需真实设备帧」这一类自此无开放项**（§8.34 B1 组两项均销：B1-1 → §8.35、
   B1-2 → 本节），真机帧**不再承载任何开放项的前置用途**。

**测试**：新 `backend/tests/test_wire_delimiter.py` **10 例**（A 组 5 + B 组 3 + C 组 2）——
直调 `core/escape.py` 与 `core/frame_builder.py` **纯函数，无 DB、无 TestClient、零产品代码改动**。

**验收**：**BE 743 → 753/753**、**FE 1106/1106（73 文件，未碰前端）**、`npx vite build`
EXIT=0、`npm run lint` **EXIT=0**、yorha-ui 校验器 **0 违规（本批零前端改动 → 无文件可校）**、
md 表列数校验 `table mismatches = 0`、隐形字符 / CRLF = 0；**零 DDL → 无 `chore(db)` 提交**、
**`pageStatus.json` 未动 → `PAGE_STATUS.md` 不重生成**。

**文档同步（同批）**：`DESIGN_Decisions.md` D13 边界残余风险注、`DESIGN_CorePipeline.md`
§9.7 必查 ① + 复跑第 1 项 + 「剩余真机核对项」行、`PLAN_Backlog.md` §8.34 B1-2 / §8.35 尾 /
C-4 / §8.49 三·① 与 R18 终态 / §8.27 复跑第 1 项 / §1 新行、`PROJECT_HANDOVER.md` 条目 68
与四处状态行。

### 8.52 七项复议拍板：触发式 / 挂账 / 不做 → **全数立项** + 排期 R21–R28（文档批 · 零代码）

**批次**：2026-10-03 · **纯文档批、零代码、零 DDL、`pageStatus.json` 未动** —— §8.51 把
「需真实设备帧」销干净后，用户对 §8.49 三·②「触发式 / 不做」与 `BUSINESS_SCENARIOS.md`
挂账清单**逐项复议**，**七项全数勾选立项**（原拍板 C-1 = A 不立项、C-5 = ①② 触发式 ③ 不做、
挂账三项 = 不排期**全部推翻**）；加工页「传输展示 + 本页切换」**复议维持 D9-A 不立项**。

#### 一 · 拍板结果（2026-10-03，用户逐项勾选）

| 项 | 原拍板 | 本次复议 | 编入 |
|---|---|---|---|
| C-5 ② 长度域 BE / LE | 触发式 | **立项**（最小，收侧已就绪） | **R21** |
| C-5 ① CRC 多算法（CCITT / CRC32 / LRC） | 触发式 | **立项**（出线 + 收侧三处白名单成对改） | **R22** —— **✅ 已完成（2026-10-03，§8.54）** |
| 挂账 ① 绝对时间戳 epoch 模板 | 不排期 | **立项** | **R23** —— **✅ 已完成（2026-10-03，§8.55）** |
| 挂账 ③ 创建后切换 op | 不排期 | **立项** | **R24** —— **✅ 已完成（2026-10-03，§8.56）** |
| 挂账 ② 加扰 / 混淆字段 | 不排期 | **立项** | **R25** —— **✅ 已完成（2026-10-04，§8.57）** |
| C-1 B 序列级分支 | A 不立项 | **立项 B**（C 发前路由**仍不在本列**，要做另议） | **R26** —— **✅ 已完成（2026-10-04，§8.58）** |
| C-1 C 发前路由 | A 不立项 | 复议时**仍划在本列外**（上一行明写「要做另议」） | **2026-10-06 用户翻案另议 → 立项**：**R36 BE 数据层 ✅ + R37 引用计数与级联 ✅ + R38 管理面 ✅ + R39 加工页接线 ✅**（§8.68 / §8.69 / §8.70 / §8.71） |
| C-5 ③ varint / COBS | 明确不做 | **立项**，按原建议拆「出线 / 解包」两批 | **R27 出线 + R28 解包** |
| 加工页传输展示 + 本页切换 | 维持 D9-A 不立项 | **复议维持不立项** | 不排期 |

#### 二 · 排期表（R21–R28）

| 编号 | 内容 | 类型 | 规模 | DDL |
|---|---|---|---|---|
| **R21** | 长度域 `byte_order`（big / little）—— 修「**能判不能发**」的不对称（`handlers/length.py` 恒大端 vs 收侧 `_normalize_length` 已支持 little）<br>**✅ 已完成（2026-10-03，§8.53）**：length 卡 `byte_order` 下拉 + `LengthHandler` 反转 + `frame_builder`/`toFrameBlocks` 出口翻译 + 应答规格声明 + 设计期卡面同口径；BE 753 → 768、FE 1106 → 1117、共享向量 `length_order.json` 7 行 | BE+FE | 小 | 否 |
| **R22** | CRC16-CCITT / CRC32 / LRC —— BE `ChecksumHandler` + FE enum / 下拉 / `VALID_ALGOS` + **`response_match` 白名单同批** + 共享向量 2–3 组<br>**✅ 已完成（2026-10-03，§8.54）**：六张白名单 + `operator.py` 算子模板同批；`ALGO_FIELD_WIDTH` 只加 ≥ 下限（`crc16_modbus` 遗留精确 2 字节不动）；共享向量 `checksum_algo.json` 30 行（期望值取自 `zlib` / `binascii` 外部真值）；BE 768 → 793、FE 1117 → 1127 | BE+FE | 中 | 否 |
| **R23** | epoch 绝对时间戳模板（替代手填 INT_UNSIGNED）—— 新算子 `TIME_EPOCH`，`unit` = s/ms（缺省 s）取当前墙钟、定宽大端<br>**✅ 已完成（2026-10-03，§8.55）**：BE `encode_time_epoch` + 序列计划补丁（`_DYNAMIC_OPS` 三值 / `_EPOCH_KEYS`）+ `KNOWN_OPS` 20 → 21 + `operator.py` 算子模板；FE 编码分支 + normalize 保身份 + `EPOCH` 只读章 + 计划条目；共享向量 `time_epoch.json` 11 行双端同读；BE 793 → 808、FE 1127 → 1139 | BE+FE | 小 | 否 |
| **R24** | 创建后切换 op —— 放开 `op_code` 编辑 + 兼容校验 + 确认回执（原只能删建重录）<br>**✅ 已完成（2026-10-03，§8.56）**：属性面板 op 下拉（选项 = 有模板的算子，与调色板同源）+ `planOpSwitch` 兼容校验（容器带子块切叶 → 拦）+ `describeOpSwitch` 确认回执（保留 / 清除 / 位宽 / 字节长度）；新建与切换**单源 `applyOpDefaults`**；BE `_validate_op_switch` 保存侧兜底（只判 op 变化的字段 → 存量不锁）；**顺带修模板数组污染**（`unit` / `algo` / `encoding` / `bits` 一律落首元素标量）；BE 808 → 824、FE 1139 → 1163 | BE+FE | 中 | 否 |
| **R25** | 加扰 / 混淆字段（异或种子 / 位旋转一类语义化加扰算子）—— 新算子 `SCRAMBLE`：**明文进、密文出**，把「固定 hex」变成可换种子的可逆变体<br>**✅ 已完成（2026-10-04，§8.57）**：FE `utils/scramble.js` 口径档案 + 编码分支 / 卡面显加扰后线上 hex / 加工页只读 / 反加扰解码 / 属性面板 `PLAINTEXT` 输入与就近校验；BE `encode_scramble` + `unscramble_hex` + `_validate_scrambles`（保存侧 400）+ `field_blocks` / `field_decode` 两处接线；`KNOWN_OPS` 21 → 22 + 算子模板 `mode` / `seed` / `roll`（**缺省种子 A5** —— 加扰立刻可见，比恒等缺省更早暴露忘了设种子）；共享向量 `vectors/scramble.json` 14 行双端同读，**BE 824 → 843、FE 1163 → 1196** | BE+FE | 中 | 否 |
| **R26** | 序列级分支：`sequence_steps.condition` **仅新增列** + runner 判执行 / 跳过 + 受限表达式（`== != > < in`，**无 eval**）+ 序列页条件 UI<br>**✅ 已完成（2026-10-04，§8.58）**：**求值器双端单源语义** `backend/core/condition.py` ↔ `frontend/src/utils/condition.js`（无算术 / 括号 / 布尔连接 / 函数；变量 = 整串裸词查表；`in` = 子串或数组成员；`null` 只与 `null` 相等；长度 200 / 记号 64 / 数组 32 三道上限），11 条错误文案**双端逐字相同**；**DDL 仅新增列** —— `models.py` 加列 + `migrate.py` **Migration 0005** + `ensure_sequence_step_columns` 两列同批自愈 + datahub 导出带条件；runner = `_condition_gate`（判定排在 delay 之前）+ `_remember`（`step.<n>.status/sent/received/rtt_ms` + 解码字段平铺），`decode_vars` 回调走 `resolve_log_fields`；保存口 `_condition_spec` **只查语法**（变量到运行期才存在）→ 400 定位 `steps[i].condition`；FE 编辑器「执行条件」输入 `checkCondition` 就地红框 + APPLY 拦截 + `COND ::` 行内指示 + 跳过原因 tooltip；共享向量 `vectors/condition.json` **58 行**双端同读，**BE 843 → 878、FE 1196 → 1213** | BE+FE | 大 | **是（仅新增列）** |
| **R27** | varint / COBS **出线**（只做编码，**不碰解包**）<br>**✅ 已完成（2026-10-04，§8.59）**：length 卡 `encoding` 下拉（缺省 `fixed` = 缺失键 → 逐字节不变）+ 协议树新组帧元素 `cobs`（`Orchestrator` 第 0 步树级前置改写、由内向外、无 cobs 零遍历）；`LengthHandler` LEB128 分支 + **出线后 `byte_length` 回写**（refs Σ / checksum 同源）+ 字节序中立；`frame_builder` 出口翻译 + `expand` 停钻 + 保存侧 refs 指向 COBS 内部 400；FE `framing.js` 编码 SSOT、`InstructionEncoder` 局部缓冲子发射、偏移尺**两遍法**回灌精确出线宽；共享向量 `vectors/framing.json` **3 表 35 行**（期望值 = 对表 + 独立规范解码器往返双道）；**零 DDL → 无 `chore(db)`**；BE 878 → 917、FE 1213 → 1247 | BE+FE | 大 | 否 |
| **R28** | varint / COBS **解包**（`stages` 逆向解包 + 应答匹配），硬前置 R27<br>**✅ 已完成（2026-10-04，§8.60）**：收侧新模块 `backend/core/unframe.py`（`decode_varint` / `cobs_decode`；`framing.py` 一行不改，仍纯编码）+ 规格 `length.encoding`（fixed/varint）与 `unpack.mode=cobs` + `inner_head`/`inner_trailer`（slice 形态逐字节不变）+ 新 reason 码三条 + 生成侧**要素级降级**（varint 下只有「选中那张」的 length 靠收侧回算自洽，多层几何算不出 → 400）；FE `TransactionPanel` ENCODING 下拉（**只写非缺省值**：切回 fixed 删键）；**反向消费 `vectors/framing.json`（不新增向量文件）**，Phase 0 金标准（BE `test_response_baseline` 7 例 + FE `responseBaseline.test` 3 例）改前钉绿；**零 DDL → 无 `chore(db)`**；**BE 917 → 955、FE 1247 → 1251** | BE+FE | 大 | 否 |

**顺序理由**：先小后大 —— 先补「已判不能发」的两处不对称（R21/R22）→ 再加值表达
（R23/R25）→ 再动交互面（R24）→ 再动执行引擎（R26）→ 最后碰**风险最高档**的解包链
（R27/R28）。每批固定验收（BE 全量 + FE 全量 + `npx vite build` + `npm run lint` +
yorha-ui 校验器改动文件 0 违规 + 文档同步）+ **一批一提交**；**R26 含 DDL → `yorha.db`
另开 `chore(db)` 提交**（沿 3a / 3c / 3d / R10 / R20 先例）。

**硬约束提醒（R26/R27/R28 动判路径前必须先证）**：① 无条件步骤 / 无变长编码时**行为
逐字节不变**（§0 `/dispatch` 缺省口径）；② 不碰 `processor.py` / `graph.py` /
`Blueprint.jsx`；③ 新增 pip 依赖仍只允许 pyserial。

**触发式清单至此清零**：C-5 ①②③、C-1、`BUSINESS_SCENARIOS.md` 挂账三项**全部转立项**；
**仍不立项的只剩**加工页「展示传输 + 本页切换」（维持 D9-A，已在 `pageStatus.json`
加工页 `nextSteps` 留拍板回执）。

### 8.53 R21 长度域 `byte_order`（big / little）：补「能判不能发」的不对称

**批次**：2026-10-03 · **BE + FE，零 DDL、`models.py` 未动、`/dispatch` 缺省口径逐字节不变**
—— §8.52 排期第 1 批（先小后大之首）。现状：收侧 `response_match.VALID_BYTE_ORDERS`
本就收 `big|little`、事务面板回显规则**能配能判**；出线 `LengthHandler` 却恒
`f"{total:0{n}X}"` 大端 → 「**能判不能发**」。

#### 一 · 六处改点（改一必改二/三）

| # | 位置 | 口径 |
|---|---|---|
| ① | `frontend/src/config/blockTypes.js` | length 卡 `fields` 增 `byte_order`（`BLOCK_PROPERTY_FIELDS.byte_order`：`inputType='select'`、点路径 `parameter_config.byte_order`、`default='big'`、选项 big／little）—— 走**既有通用 select 分支**，`ProtocolPropertiesPanel.jsx` **零改动** |
| ② | `backend/handlers/length.py` | `byte_order_of()` + `apply_byte_order()`：refs 模式与旧 range 模式**两个 return 同步套用**；little = 字节对反转；缺省／枚举外回大端（镜像算法枚举外回 `crc16_modbus`）；**奇数长度不反转**（值超 `byte_length` 的畸形输出，大端路径本就奇数位，不发明语义） |
| ③ | `backend/core/frame_builder._with_byte_order` ↔ `frontend/src/utils/toFrameBlocks.js withByteOrder` | `pc.byte_order=little` → `config.params.byte_order`；**只在 little 时写键**（big／缺省／枚举外不写 → params 形状与存量逐字节一致）；**refs 缺失的 config 直通路径同样生效**（存量树只设字节序也走得通）；**checksum 块当时不吃此键**（R21 范围，§8.66 起同闸门） |
| ④ | `backend/core/response_generate._length_element` | 自动生成的回显规则 `byte_order` 改从 `pc` 取（原硬编码 `"big"`）—— 否则「出线小端、规则按大端比」必然失配 |
| ⑤ | `frontend/src/utils/protocolTree.js` `collectDeterministicBytes` | length 分支按 `pc.byte_order` 反转，与 ② 同口径 → **设计期卡面与出线逐字节一致**；大小写不敏感（两端都 lowercase 收） |
| ⑥ | `frontend/src/utils/validateProtocol.js` | W5 `BYTE_ORDER_UNKNOWN`（大小写归一后判、空串不报），镜像 W4 `ALGO_UNKNOWN` 的 fail-open 口径 |

**仅 length 卡列此字段**（拍板范围 = 长度域；checksum 的 `byte_order` 当时**未立项、需另开**
→ **已由 §8.66（R34）「另开」收掉**：checksum 卡复用同一字段定义、同一闸门、同一字节序门面）。
`protocol_api.ProtocolNodeSchema.parameter_config` 是自由 dict → **零 schema 改动、零 DDL**。
卡片 Σ 回显仍是十进制 `${sigma}B`（字节序只改「出线字节的排法」，不改长度字段的值）。

#### 二 · 顺带修（存量缺陷）：设计期 ≥2 字节真值被空格切坏

`collectDeterministicBytes` 把 `formatToHex()` 的**展示串**（已带空格，如 `"00 06"`）
直接 `.match(/.{1,2}/g)` → 空格被吃进切片 → `[00, 0x00, 06]` **多出一个 0 字节**。
单字节值看不出（既有用例全 1 字节），**2 字节 CRC／长度必错**（容器中央值显示成
`"00 00 06"` 而非 `"00 06"`，嵌套校验的中间字节同理被污染）。length / checksum
两分支同步 `.replace(/\s/g, '')`（**改一必改二**）并补回归用例（2 字节 CRC 容器
中央值）。只影响**卡面显示**，出线字节由 BE 侧决定、不受影响 —— 但 R21 的
「设计期与出线逐字节一致」对 2 字节长度**必须**先修此病才能成立。

#### 三 · 共享向量

新增 `vectors/length_order.json`（顶层数组 = 单表，**7 行**：`byte_order` /
`byte_length` / `total` / `expected`），**双端同读**：
后端 `backend/tests/test_length_byte_order.py`（refs 求和 → 大端格式化 → 按序出线）、
前端 `protocolTree.test.js`（同 Σ 的容器中央值按行断言）；`vectorsLoader.test.js`
`TABLES` 登记、`vectors/README.md` §3 表清单同步（12 文件 16 表 → **13 文件 17 表**）。
消费矩阵闸（`test_vectors_manifest.py`）与 FE 表清单闸均绿。

#### 四 · 验收

- **BE 753 → 768/768**（+15：向量逐行 1、缺省／显式 big／枚举外回大端 3、大小写
  不敏感 1、range 模式 1、`config=None` 零填 1、奇数位不反转 1、frame_builder 三态
  4（little 帧 + `logic` 回显、big 与缺省逐字节同 + params 不写键、refs 直通路径、
  checksum 不吃键）、应答声明 little／big／枚举外 3）
- **FE 1106 → 1117/1117（73 文件）**（+11：`protocolTree` +4、`toFrameBlocks` +4、
  `validateProtocol` +1、`blockTypes` +2）
- `npx vite build` EXIT=0 · `npm run lint` EXIT=0 · yorha-ui 校验器改动 js/jsx/json
  **0 违规** · md 表列数 mismatches=0 · 隐形字符／CRLF／TAB = 0
- **零 DDL**（`models.py` 未动、`yorha.db` 未动，无 `chore(db)`）；`pageStatus.json`
  仅协议页 `availableNow`／`nextSteps` 回填 + `npm run sync:page-status`

**R22 已完成 ✅（§8.54）、R23 已完成 ✅（§8.55），下一批 → R24 切 op。**

---

### 8.54 R22 CRC 多算法（CRC16-CCITT / CRC32 / LRC）：六张白名单同批成对改

**批次**：2026-10-03 · **BE + FE，零 DDL、`models.py` 未动、`/dispatch` 缺省口径逐字节不变**
—— §8.52 排期第 2 批（原 §8.36 C-5 ① 触发式项）。现状：出线 `ChecksumHandler` 与收侧
`response_match.VALID_ALGOS` 只认 `sum / xor / crc16_modbus` 三值；FE `ChecksumAlgo` 虽已声明
`CRC_32` 却**无实现**（`calculateChecksum` 落 `default:` 打 warn、`mapChecksumAlgo` 折回
`CRC_16_MODBUS`）→ 「真机提 CCITT/CRC32 即做」的触发式缺口。

#### 一 · 算法规范（双端同源，三处实现逐位一致）

| 枚举（FE） | 后端值 | 规范 | check `"123456789"` | 字段宽 |
|---|---|---|---|---|
| `CRC_16_CCITT` | `crc16_ccitt` | CRC-16/CCITT-FALSE：poly 0x1021、init 0xFFFF、refin/refout = false、xorout 0x0000 | `0x29B1` | 2 |
| `CRC_32` | `crc32` | CRC-32/ISO-HDLC：反射 poly 0xEDB88320、init = xorout = 0xFFFFFFFF | `0xCBF43926` | 4 |
| `LRC` | `lrc` | 8 位和的二进制补码 `(-sum) & 0xFF`（恒 1 字节值） | `0x23` | 1 |
| `SUM_8` / `XOR_8` / `CRC_16_MODBUS` | `sum` / `xor` / `crc16_modbus` | 既有口径逐字不变 | — | 1 / 1 / 2 |

三处实现：`frontend/src/utils/formula.js calculateChecksum`（FE 编码器 + 设计期卡面）、
`backend/handlers/checksum.py`（出线）、`backend/core/response_match.checksum_value`（收侧判定
+ P3 序列补丁写入）。

#### 二 · 六张白名单 + 一处算子模板（改一必改七）

| # | 位置 | 口径 |
|---|---|---|
| ① | `backend/core/response_match.py` | `VALID_ALGOS` 六值 + **新增 `ALGO_FIELD_WIDTH`**（`sum` / `xor` = `None` 不限、`crc16_modbus` = 2、`crc16_ccitt` = 2、`crc32` = 4、`lrc` = 1）。**`crc16_modbus` 遗留「恰好 2 字节」精确判定逐字不变**；新算法只加「≥ 宽度」**下限**（缺则 `to_bytes` 抛 OverflowError → 500，收口 400）；`default_field_bl = ALGO_FIELD_WIDTH.get(algo) or 1`；`checksum_value` 加三支 + 三函数 |
| ② | `backend/handlers/checksum.py` | refs 模式与旧区间模式**两个 `return` 同位扩**三个 `elif` + 三个方法（与 ① 逐位同源；区间模式原先缩进歪 1 格，本批新分支按正规缩进补） |
| ③ | `backend/core/frame_builder.BACKEND_ALGO` ↔ `frontend/src/utils/toFrameBlocks.js BACKEND_ALGO` | FE 枚举 → `config.params.algorithm` 出口翻译，两张表同批；值域 = ① 的 `VALID_ALGOS` |
| ④ | `backend/core/sequence_plan.py` / `backend/core/response_generate.py` | 判定路径与自动回显**共用同一张宽度表**：不足 → `raise`（计划 400）/ 弃生成 + 警告（否则生成出来也判不了 → 必 400） |
| ⑤ | `frontend/src/utils/formula.js` / `normalizeInstruction.js` | `ChecksumAlgo` 六值（**顺序与其余五处一致**）+ `calculateChecksum` 三个 `case`；`mapChecksumAlgo` **六个规范值直通、裸名 `CRC32` / `CRC16_CCITT` / unknown / 空串仍折回 `CRC_16_MODBUS`**（存量草稿出线字节不变） |
| ⑥ | `frontend/src/config/blockTypes.js` / `frontend/src/utils/validateProtocol.js` | `algo` 下拉六值（缺省 `CRC_16_MODBUS` 不变）+ `VALID_ALGOS` 六值（W4 只报真·枚举外，裸名 `CRC32` 照旧报） |
| ⑦ | `frontend/src/utils/sequenceView.js` / `InstructionForm/TransactionPanel.jsx` / `backend/routers/operator.py` | `PLAN_ALGO` + **`PLAN_ALGO_FIELD_WIDTH`（键 = 后端值域）** 冻结链加同宽下限分支；事务面板下拉三选项 → 六 + `field_byte_length` 三态缺省 4 / 2 / 1；指令页 `CHECKSUM_CRC` 算子模板 `algo` 六值 |

#### 三 · 共享向量

`vectors/checksum_algo.json`（顶层数组 **6 算法 × 5 输入 = 30 行**，`algo` / `data` /
`width` / `expected`）**双端同读**：`backend/tests/test_checksum_algorithms.py::VECTORS` ↔
`frontend/src/utils/__tests__/checksumAlgo.test.js`；`vectorsLoader.test.js` `TABLES` 登记 +
`vectors/README.md` §3（13 文件 17 表 → **14 文件 18 表**）与 §7 行注归档。

期望值**不来自本仓实现** —— `crc32 = zlib.crc32`、`crc16_ccitt = binascii.crc_hqx(data, 0xFFFF)`
（CPython 标准库独立实现）+ 三枚已发布 CRC check 值（`0x4B37` / `0x29B1` / `0xCBF43926` /
`0x23`）生成期自校验，故对双端都是**外部真值**，不是「照实现抄一份」。
**空输入不入表**：出线短路全 0、收侧 `crc16(b"") = 0xFFFF` 本就有已知分歧（沿 E1-3「各自现状
锚」先例不改，记此备查）。

#### 四 · 验收

- **BE 768 → 793/793**（+25：向量出线／收侧逐行 2、覆盖与区间模式 2、白名单与出口映射 4、
  宽度缺省／遗留精确／新下限／越界 5、计划 4、出线端到端 3、应答声明 3、存量不变 2）
- **FE 1117 → 1127/1127（74 文件）**（+10：`checksumAlgo.test.js` +8、`toFrameBlocks` +1、
  `validateProtocol` +1；另修 `sequenceView.test.js` 的「`CRC_32` 不支持 → 冻结」用例：
  本批 `CRC_32` 转正，改测**真·枚举外 `CRC_64`** 走原分支 + 新增 2 字节冻结 / 4 字节成案两例）
- `npx vite build` EXIT=0 · `npm run lint` EXIT=0 · yorha-ui 校验器改动 js/jsx/json
  **0 违规** · md 表列数 mismatches=0 · 隐形字符／CRLF／TAB = 0
- **零 DDL**（`models.py` 未动、`yorha.db` 未动，无 `chore(db)`）；`pageStatus.json`
  协议页 `availableNow`／`nextSteps` 回填 + `npm run sync:page-status`

**R23 epoch 绝对时间戳模板已完成 ✅（§8.55）、R24 创建后切换 op 已完成 ✅（§8.56）、R25 加扰 / 混淆已完成 ✅（§8.57）、R26 序列级分支已完成 ✅（§8.58）、R27 varint / COBS 出线已完成 ✅（§8.59）、R28 varint / COBS 解包已完成 ✅（§8.60）** —— §8.52 七项复议立项至此全数销项。

---

### 8.55 R23 `TIME_EPOCH` 绝对时间戳算子：替代手填 INT_UNSIGNED 语义化 epoch

**批次**：2026-10-03 · **BE + FE，零 DDL、`models.py` 未动、`/dispatch` 缺省口径逐字节不变**
—— §8.52 排期第 3 批（原 `BUSINESS_SCENARIOS.md` 挂账 ①）。现状：想要「绝对 Unix 时间戳」
只能手填 `INT_UNSIGNED` + 语义化注释（值是死的、发一次就过期），而 `TIME_ACCUMULATOR` 只能出
**相对**秒数（相对 `base_time`）→ 挂账 ①。

#### 一 · 算子定义（双端同源，改一必改二）

| 项 | 口径 |
|---|---|
| `op_code` | `TIME_EPOCH`（`OP_CODES` 第 16 项；`KNOWN_OPS` 20 → **21** —— FE 经 `Object.values(OP_CODES)` 自动收录，BE `routers/instruction.py` 白名单同批 +1） |
| 参数 | `unit ∈ {s, ms}`，**缺省 `s`**（`operator.py` `param_template = {"unit": ["s", "ms"]}` → FE `inferConfigType` 出数组 → `ParamConfigForm` 渲染 `<select>`；`unit` 在 `models.py` 无同名列、无键冲突） |
| 取值 | `raw = floor(now_ms / 1000)`（s）或 `floor(now_ms)`（ms）→ `abs(raw) & ((1 << (8 * byte_len)) - 1)` 定宽大端 —— 与 `encode_time_accumulator` 的 `& mask` 同式 |
| 位宽 | 不够 → **只截低位、不报错**（4 字节秒值覆盖到 2106、毫秒需 ≥5 字节）；富余 → 左侧零填 |
| `now` | 非有限 / 布尔 / 字符串 → BE `encode_time_epoch` 返 `None`（调用方不覆盖 `hex_value`，保持既有 `cfg.hex`/zeros 现状）、FE 回落 `Date.now()`（同 `TIME_ACCUMULATOR` 既有契约外锚） |
| 录入 | `inputs` / `value` **不参与**（墙钟压过静态值，同 E1-6 口径） |

#### 二 · 落点

**BE 五处**：

- `core/orchestrator.py` 新增 `encode_time_epoch(unit, now_ms, byte_len) -> str | None`
  （插在 `encode_auto_counter` 前，标注与 FE 同式）
- `core/field_blocks.py` 新增 `elif op == "TIME_EPOCH" and byte_len > 0 and not kids:`
  分支（`type` 闸 + `sem is not None` 才覆盖 `hex_value`，插在 AUTO_COUNTER 分支前）
- `core/sequence_plan.py` `_DYNAMIC_OPS` 三值 + `_EPOCH_KEYS = {field_id, op, offset,
  byte_len, unit}` + `_encode_dynamic` 分支 + `allowed` if/elif/else 三段 +
  `_normalize_dynamic` 分支（`unit` 必须 `s`/`ms`（大小写不敏感，归一小写）、探针墙钟
  `probe_now = 1_700_000_000_000.0`）
- `routers/instruction.py` `KNOWN_OPS` + 注释计数 15/20 → 16/21
- `routers/operator.py` `SEED_TEMPLATES` DYNAMIC 段新增「绝对时间戳」模板（无 `base_time`）

**FE 七处**：

- `constants.js` `OP_CODES.TIME_EPOCH` + `OP_PRIORITY`（DYNAMIC 组内，接在 `AUTO_COUNTER` 后）
- `utils/InstructionEncoder.js` `TIME_EPOCH` 分支：**只赋 `value`，随后走通用整数路径**
  （`Math.abs(Math.floor(v)).toString(16).padStart(...).slice(-2n)` 对正值恒等于 BE 的
  `& mask`），不另起编码轨道 → byte-equal 是结构性的，不靠人肉对齐
- `components/InstructionForm/normalizeRunnerInstruction.js` **内层与外层 keep 列表同时**
  加 `TIME_EPOCH` —— 只加内层会被外层闸放行后摊平成 `TIME_CUMULATIVE`、只加外层会落
  `INPUT`（打字被静默忽略 =「能改但无效」陷阱）
- `config/runnerRenderRules.js`：`classifyRunnerField` 加 `isEpoch`，**让它走 `isCalculated`
  而非 `isTimeCumulative`**（→ 只读、不开时间选择器、不写 `base_time`、显示取
  `computedValues` hex）、`isTimeCumulative = !isEpoch && (...)`、返回对象带 `isEpoch`；
  `resolveRunnerKind` 加 `EPOCH` 章（先于 `TIME` 分支）；`collectSemanticItems` 增
  `['unit', 'UNIT']` 且缺省补 `UNIT=s`（不亮就看不出发的是秒还是毫秒）
- `components/InstructionForm/RunnerFieldTree.jsx` suffix 的 epoch 分支（否则掉进
  `getFieldEpoch(params).getFullYear()` 显示 `2000`）
- `hooks/useInstructionLanes.js` 设计期卡面预览（`Date.now()` 出定宽 hex，同 TIME 的预览性质）
- `utils/sequenceView.js` 计划条目（`unit` 归一小写进 plan，BE `sequence_plan` 同
  `toLowerCase` 口径）；`pages/Sequences.jsx` / `utils/encoderLimits.js` / `utils/validateInstruction.js`
  注释同步

#### 三 · 共享向量

新增 `vectors/time_epoch.json`（**11 行**，行形状 `{unit, now_ms, byte_len, expected}`）
**双端同读** —— `backend/tests/test_time_epoch.py::VECTORS` ↔
`frontend/src/utils/__tests__/timeEpoch.test.js`；期望值由规范式独立生成，覆盖
s/ms（含 `MS` 大写等价）× 1/2/4/8 字节（含 1 字节非零低字节堵「恒 00」假绿、截低位、
左侧零填、epoch 起点 0、毫秒截低 32 位）；`vectorsLoader.test.js` `TABLES` 登记 +
`vectors/README.md` §3（14 文件 18 表 → **15 文件 19 表**）与 §7 行注归档。

#### 四 · 验收

- **BE 793 → 808/808**（+15：向量逐行 / 出线全链路 2、缺省与大小写 1、截位与零填 2、
  `now` 契约外 1、计划归一与键集 4、计划补丁字节等长与探针 2、白名单 / 算子模板 / 键集 3；
  `test_op_whitelist` 清单 20 → 21 同批改名 `is_exactly_21`）
- **FE 1127 → 1139/1139（75 文件）**（+12：新 `timeEpoch.test.js` 12 例 = 向量 6 +
  身份与渲染 6；`validateInstruction.test.js` 已知全集列表 20 → 21，例数不增）
- `npx vite build` EXIT=0 · `npm run lint` EXIT=0 · yorha-ui 校验器改动 js/jsx/json
  **0 违规** · md 表列数 mismatches=0 · 隐形字符／CRLF／TAB = 0
- **零 DDL**（`models.py` 未动、`yorha.db` 未动，无 `chore(db)`）；`seed.py` **不改**
  （不新增种子字段）；`processor.py` / `graph.py` / `Blueprint.jsx` 未碰

**R24 创建后切换 op 已完成 ✅（§8.56）、R25 加扰 / 混淆已完成 ✅（§8.57）、R26 序列级分支已完成 ✅（§8.58）、R27 varint / COBS 出线已完成 ✅（§8.59）、R28 varint / COBS 解包已完成 ✅（§8.60）** —— §8.52 七项复议立项至此全数销项。

### 8.56 R24 创建后切换 op：属性面板放开 `op_code` 编辑 + 兼容校验 + 确认回执

**批次**：2026-10-03 · **BE + FE，零 DDL、`models.py` 未动、`/dispatch` 缺省口径逐字节不变**
—— §8.52 排期第 4 批（原 `BUSINESS_SCENARIOS.md` 挂账 ③）。现状：属性面板 `op_code` 是只读
`<span>`，换算子只能**删了重建重录**（改名、重填值、重排 sequence 全要重来）。

**方向**：切算子 = 一次**带确认回执的受控转换**，不是「就地改个枚举」——「换算子后这个字段
还合法吗」「换完到底是哪些值」两件事必须**先看后按**。

#### 一 · 可切换算子的集合（FE `utils/opSwitch.switchableOps`）

- 选项 = **有算子模板的 `OP_CODES`**，与调色板**同源同判**：`STRUCT` 有口径无模板（G6 已结）
  → 不提供；encoder legacy 五项（`INPUT`/`FIXED`/`HEADER`/`TAIL`/`CALCULATED`）无创建入口 →
  不列。排序 `HEX_RAW` 居首、余按 `OP_PRIORITY`。
- **当前算子恒列第一**（哪怕它不在上集）：legacy 字段渲染不出空下拉、也切得走。
- 反漂移锁：`test_operator_templates.py::test_seed_is_exactly_the_switchable_op_set` =
  `KNOWN_OPS` − `STRUCT` − legacy 5（15 项）—— 少一个模板 = 那个算子切不过去。

#### 二 · 兼容校验 + 转换规则（FE `planOpSwitch` ↔ BE `_validate_op_switch` 同口径）

| 判据 | FE（下拉侧） | BE（保存侧） |
|---|---|---|
| 未知算子 | `OP_UNKNOWN` 拒 | 既有 `_validate_op_codes` 21 项白名单 400 |
| 容器（`ARRAY_GROUP`/`STRUCT`）切成叶且下挂子块 | `GROUP_HAS_CHILDREN` 拦（文案点名子块数 + 「孤儿子块」） | 400（只看本次 payload 的 `parent_id`） |
| 切入 `HEX_RAW` 且 hex 去空白长度 ≠ `byte_len*2` | 不在下拉侧拦，`handleApply` → `validateInstruction` E1 `HEX_LENGTH` 拦 | 400（同口径，堵直连 API 绕过 APPLY 的口子） |
| 同算子 | `SAME_OP`，不产生转换 | 不判（`prev == f.op_code` 跳过） |
| 新增字段 / 存量字段的历史怪形态 | —— | **不判**（`old_ops` 里没有、或 op 没变 → 跳过） |

**中性键保留**（语义与算子无关，切完还在）：`value` `refs` `presence` `align` `pad_to`
`pad_byte` `endianness` `input_base`（组 → 组另留 `max_count`；**进组摘 `value`** —— 组不吃
静态值，留着会被 `hasFixedValue` 误判成 FIXED 卡面）。**其余键一律丢**、按目标算子默认态
重建 → **切完 ≡ 新建该算子的字段**（外加保留下来的中性键）。位段 `bits` 只属于 `BITFIELD`：
切入带过来、切走摘干净（`_validate_bitfields` 只判 `BITFIELD`，不会留孤儿位段）。

#### 三 · 单源 `applyOpDefaults`（新建与切换共用）

原 `handleAddBlock` 内联的默认态（模板默认值 / `BITFIELD` 播种 8-bit 段 / `ARRAY_GROUP`
清零 + `max_count` / `bits` 派生 `byte_len` / `HEX_RAW` hex 等长 / `STRING` 8B + `type=string`
+ `encoding` 标量）**原样抽出**成 `applyOpDefaults(draft, opCode, template, {preferByteLen})`
（改一必改二 → 单源）：

- **新建**（`preferByteLen` 缺省）→ 位宽恒用模板首项，行为逐条不变（`Instruction.test.jsx`
  STRING 例照旧绿）；
- **切换**（`preferByteLen = 原 byte_len`）→ 位宽枚举**容纳得下原长度就保留**（`4B → bits 32`，
  长度域 / `refs` 不断链），容纳不下才回落首项并同步 `byte_len`（`1B → FLOAT` 得 `bits 32` /
  `4B`），回执报「位宽 + 字节长度」两行；`STRING` 同样保留原长度（创建缺省 8B 不变）；
- **顺带修（存量缺陷）模板数组污染**：`param_template` 的**数组 = 枚举选项**，旧实现原样复制
  进 `parameter_config` → 下拉显示取 `[0]` 而编码器走 `default` 分支（R23 新增的
  `TIME_EPOCH unit`、既有的 `CHECKSUM_CRC algo` 都中招）→ 一律**落首个标量**（`bits` /
  `encoding` 早有特判，等价改写）；另切入 `MAPPING` 补 `_kvArray = []`（切换不重跑选块 effect）。

#### 四 · 确认回执与受控回弹（`BlockPropertiesPanel.jsx`）

`op_code` 只读 span → 带标签的 **`算子 (Operator)` 下拉**（值绑 `tempBlockConfig.op_code`，
header 同步显示草稿算子）。`handleOpChange` 三步：

1. **先 `setTempBlockConfig(prev => ({...prev}))` 强制回弹受控下拉** —— 否则下拉 `value` 没变，
   React 不会把 DOM 值改回去，出现「下拉显示新算子、草稿还是旧算子」的假态；
2. 按 `plan` 弹 `openConfirm(describeOpSwitch(plan), action)`：回执列 **切换方向 / 保留 /
   清除 / 位宽 / 字节长度变化 / 「确认后写入草稿，仍需 APPLY 保存」**；阻断态（未知算子、
   容器带子块）给**空动作**；
3. **确认才 `setTempBlockConfig(plan.next)`**，取消 = 草稿一字未动。

#### 五 · 验收

- **BE 808 → 824/824**（+16：`test_op_switch.py` **15 例**（纯函数口径 + 端点接线：拒绝即
  存量原样、子块先挪出再切组放行、未切换的存量 HEX 长度不拦、新增字段不拦）+
  `test_operator_templates.py` 反漂移锁 1 例）
- **FE 1139 → 1163/1163（76 文件）**（+24：`utils/__tests__/opSwitch.test.js` **20 例** +
  `BlockPropertiesPanel.test.jsx` 下拉四例 —— 选项构成 / 合法切换回执 + 回弹 + 确认播种 /
  取消不动草稿 / 容器带子块拦截）
- `npx vite build` EXIT=0 · `npm run lint` EXIT=0 · yorha-ui 校验器改动 js/jsx/json
  **0 违规** · md 表列数 mismatches=0 · 隐形字符／CRLF／TAB = 0
- **零 DDL**（`models.py` 未动、`yorha.db` 未动，无 `chore(db)`）；`seed.py` **不改**（无新算子、
  无新模板字段）；`processor.py` / `graph.py` / `Blueprint.jsx` 未碰

**R25 加扰 / 混淆已完成 ✅（§8.57）、R26 序列级分支已完成 ✅（§8.58）、R27 varint / COBS 出线已完成 ✅（§8.59）、R28 varint / COBS 解包已完成 ✅（§8.60）** —— §8.52 七项复议立项至此全数销项。

### 8.57 R25 加扰 / 混淆字段：新算子 `SCRAMBLE` —— 明文进、密文出

**批次**：2026-10-04 · **BE + FE，零 DDL、`models.py` 未动、`/dispatch` 缺省口径逐字节不变**
—— §8.52 排期第 5 批（原 `BUSINESS_SCENARIOS.md` 挂账 ②）。现状：想让固定 hex「换个说法」
只能手算好密文贴进 `HEX_RAW`，换种子要整段重算，卡片上也看不出这是被加扰过的内容。

**方向**：一个**语义化加扰算子** —— 明文（`parameter_config.hex`）进、密文出，解码端反加扰
还原明文。**只动本字段字节、不引入变长编码**，因此不触碰 R27/R28 的前置（§8.52 硬约束提醒）。

#### 一 · 双端同口径（FE `utils/scramble.js` ↔ BE `core/orchestrator.py`）

| 模式 | 变换 | 参数 |
|---|---|---|
| `XOR_SEED`（缺省） | 按字节循环异或：`out[i] = plain[i] ^ seed[i % len(seed)]` | `seed` = 非空偶长 hex |
| `BIT_ROLL` | 逐字节左旋 n 位（`(b << n)` 与 `b >> (8-n)` 按位或后截 8 位） | `n = ((roll % 8) + 8) % 8` |

- **明文空 / 非 hex / 非字符串 → 补零**（BE 置 `hex_value=None`、FE 显式 `'00'.repeat(len)`）：
  绝不把非法明文发上线；**奇长明文丢末尾半字节**（双端同断）。
- **契约外 mode / seed / roll → 恒等 fail-open**：编码层只求「出线有确定值」，真正拦在保存
  侧（见二）；`roll` 负数 / 超 8 / 带小数 / 数字串统一 `((n % 8) + 8) % 8`，抹平 JS 负数 `%`
  与 Python 的差异。
- **解码是编码的逆**：XOR 自反、左旋的逆是右旋 → `decode(encode(x))` 是**不动点**。

#### 二 · 保存侧硬拦（BE `_validate_scrambles` ↔ FE `scrambleParamError` + E1）

- BE 在 create / update **两处、任何写入前**调用；只扫 `op_code === 'SCRAMBLE'` 的字段。
- 三类 400：模式不在册 / **生效模式**的参数非法（XOR 判 `seed`、BIT_ROLL 判 `roll`，早返回 ——
  另一个模式留空合法，下拉切回来即生效）/ 明文长度 ≠ `byte_len × 2`（含非 hex；空白不计，
  与 FE E1 `if (hex && …)` 同判）。
- **`_validate_op_switch` 不动** —— R24 的切算子校验不扩 `("HEX_RAW","SCRAMBLE")`，改由本函数
  覆盖（避免两处各判一半）。
- FE 同批：`scrambleParamError`（属性面板 APPLY **就近回执**）+ E1 扩到 SCRAMBLE + 新错误码
  `SCRAMBLE_PARAM`（保存阻断 / 卡面 ⛔ / 导入预览拦截同源 G5 硬拦）。

#### 三 · 编码与解码接线

- **BE**：`orchestrator.encode_scramble` + `field_blocks` 的 `elif op == "SCRAMBLE"` 分支
  （**不设 byte_len 闸** —— 加扰逐字节保长，长度只由明文定）+ `field_decode.decode_field_bytes`
  的 `0.5` 分支（反加扰后交回明文 hex，与 FE 解码器同位）。
- **FE**：`InstructionEncoder` 的 SCRAMBLE 分支放在 **slot 早返回之后、computedVal / inputValue
  优先级链之前**（带 `typeof plain === 'string'` 闸）；`InstructionDecoder` 的 `0.5` 分支排在
  staticHex 之后；`resolveDependencies` 的 size 分支把 SCRAMBLE 与 HEX_RAW 同规则（长度域 / 组
  尺寸照常按明文字数算）。
- **零改动**：`Block.jsx`（computedValue 分支优先）/ `Instruction.jsx`（`handleAddBlock` 走
  `applyOpDefaults`）/ `sequence_plan.py`（只处理 dynamic / checksum，载荷预建）/ `blockTypes.js`。

#### 四 · 卡面与加工页（**显示线上字节，编辑明文**）

- 卡面 `computedValue` = **加扰后线上 hex**（不是明文）；组内容串同样取加扰后字节；checksum 叶
  贡献加扰后字节（`scrambleHex` 后再交叶）。
- 加工页只读：`normalizeRunnerInstruction` 的 `isFixed` 与**内外两张 keep 列表**都加 SCRAMBLE
  （**含明文为空**的情形 —— 否则落进 INPUT 路径「摊平即失效」，R23 教训）；
  `runnerRenderRules` 同批补 `isFixed`（双认身份：`op_code` 与 `original_op_code`）、
  `isExplicitHex`（回显**明文**而非密文）、新 **`SCR` 芯片**（排在 isFixed 判定之前，无 kind
  样式表需同步）、语义行亮 `MODE=` 与**生效模式**的 `SEED=` / `ROLL=`（二选一）。
- 属性面板：明文走**专用 hex 输入**（label 动态 `PLAINTEXT`、`STORED:` 回显）、排除录入进制
  （与 HEX_RAW 同判不可编辑语义）、`ParamConfigForm` 在场给 `mode` / `seed` / `roll` 三入口。

#### 五 · 模板与白名单（双端同批 21 → 22）

- `OP_CODES.SCRAMBLE`（16 → 17）+ `OP_PRIORITY` 插在 `BCD_CODE` 之后；BE `KNOWN_OPS` 21 → 22，
  `test_op_whitelist::test_known_ops_set_is_exactly_22` 与 FE `opSwitch.test.js` 全集锁同批改。
- `SEED_TEMPLATES` 新增 `ENCODING` 类目模板 `{mode: [XOR_SEED, BIT_ROLL], seed: "A5", roll: 1}`：
  **数组 = 枚举选项**（下拉落首项，A1 数组污染先例）；`seed` / `roll` 是**字面值**（keyword
  类字符串会被 `applyOpDefaults` 当控件类型提示跳过，`A5` 不在册 → 照常落值）。
- **缺省种子定 A5 而非 00**：加扰立刻可见，比恒等缺省更早暴露「忘了设种子」。
- 切算子：`mode` / `seed` / `roll` 与 `hex` 都**不是中性键** → 切走即清、切入按 `byte_len`
  播等长明文（HEX_RAW → SCRAMBLE 不会把老明文串到新算子，R24「切换 ≡ 新建」口径不改）。

#### 六 · 共享向量（`vectors/scramble.json` 14 行 · §3 / §7 已注册）

双端同读：BE `test_scramble.py::VECTORS` / FE `scramble.test.js`。覆盖 XOR 单·多字节种子、种子
比明文长、`mode` 缺键缺省、BIT_ROLL `n = 1 / 3 / 8 恒等`、负 roll 双取模、数字串 roll、契约外
mode 与非法种子恒等、空白明文、奇长丢半字节、空种子恒等；每行同时断言「出线 byte-equal +
出帧一致 + 反加扰回到明文」三件套（期望值另经独立复算对拍，非抄实现输出）。

#### 七 · 验收

- **BE 824 → 843/843**（+19：`test_scramble.py` 19 例 —— 向量三断言 / 补零回落 / 契约外恒等 /
  roll 归一 / 小端先加扰后逆序 / `_validate_scrambles` 七路 400 与放行 / 白名单模板三键 / 解码
  反加扰）；`test_op_whitelist` 集合 22 + `test_time_epoch` 计数锁同步。
- **FE 1163 → 1196/1196（77 文件）**（+33：`utils/__tests__/scramble.test.js` **26 例** +
  `useInstructionLanes.test.js` 卡面三例 + `BlockPropertiesPanel.test.jsx` 面板四例；
  `opSwitch.test.js` / `validateInstruction.test.js` 全集 21 → 22）。
- `npx vite build` EXIT=0 · `npm run lint` EXIT=0 · yorha-ui 校验器改动 js/jsx/json **0 违规
  （16 文件）** · `vectors/README.md` 表清单 15 文件 19 表 → **16 / 20**（§3 行 + §7 行注）·
  md 表列数 mismatches=0 · 隐形字符／CRLF／TAB = 0。
- **零 DDL**（`models.py` 未动、`yorha.db` 未动，无 `chore(db)`）；`seed.py` **不改**（新模板在
  `operator.py`，不落库）；`processor.py` / `graph.py` / `Blueprint.jsx` 未碰。

**R26 序列级分支已完成 ✅（§8.58）、R27 varint / COBS 出线已完成 ✅（§8.59）、R28 varint / COBS 解包已完成 ✅（§8.60）** —— §8.52 七项复议立项至此全数销项。

### 8.58 R26 · 序列级分支（`sequence_steps.condition` 仅新增列）—— 2026-10-04

#### 一 · 背景与拍板

- 来源 §8.52 复议表：原案 A「不立项」被复议推翻 → **立项 B**（**C 发前路由仍不在本列**，要做另议）。
- 定位 = 步骤的「**执行条件**」：上一步（或本步之前）的执行结果 / 应答字段决定这一步**跑不跑**。这是
  **运行期跳步**，不是设计期路由 —— 不改帧、不改序列结构、不改 `/dispatch` 任何口径。
- 解禁点（§0 硬约束）：**仅新增列** —— `models.py` 只加一列 `condition VARCHAR(200) NULL`
  （无改列、无删列），`migrate.py` 加 **Migration 0005**；沿 3a / 3c / 3d / R10 / R20 先例 →
  **feat 提交在前，`yorha.db` 二进制另开 `chore(db)` 提交**。
- 硬前置：**「无条件步骤行为逐字节不变」**。实现 = `execute` 顶部
  `with_context = any(step.get("condition") for step in ...)` —— 全序列无条件 → 连 `decode_vars`
  **一次都不调**（测试注入「被调用即失败」的回调钉死，附记录键集与改前同形的断言）。

#### 二 · 表达式定案（受限 DSL，**无 eval**）

语法 = **一次比较**：`左 op 右`。

| 维度 | 定案 | 理由 |
|---|---|---|
| 运算符 | `==` `!=` `>=` `<=` `>` `<` + 关键字 `in`（6 比较符 + 1 关键字） | 拍板 5 项 + 补 `>=` / `<=`（§8.36 例 A「固件版本 ≥ 0x1200」要用） |
| 关键字 | `true` / `false` / `null` / `in` **大小写不敏感** | 与数制前缀 `0x` 同口径：关键字不管大小写，变量名照抄查表 |
| 不做 | 算术、括号、布尔连接、函数调用 | 复杂度与注入面都是坑；宁可少而正确，缺的下批再议 |
| 变量 | **整串裸词**查表（可含 `.`、`-`、中文；分隔 = 空白与 `[] ,` 引号），**整串精确匹配、不下钻** | `step.1.status` 是一个键，不是路径 → 零歧义、零注入面 |
| `in` | `a in b` ≡ `b.includes(a)`：子串 **或** 数组成员 | 双端同向（FE 曾写反成 `a.includes(b)`，靠向量对拍当场抓出） |
| `null` | **只与 `null` 相等**；`v == 0` → `false`；比大小 → 类型错 | 三值逻辑里最省心智的一致选择 |
| 布尔 | 永不当数字 | 杜绝 `true == 1` 这类「看起来对」的陷阱 |
| 上限 | `MAX_CONDITION_LEN=200` / `MAX_TOKENS=64` / `MAX_ARRAY_ITEMS=32` | 三道防线：记号上限先拦，数组上限是第二道 |

**错误文案 11 条双端逐字相同**（由 `vectors/condition.json` 的 `error` 行钉死）：`条件为空`、
`条件超长（{n} > {max} 字符）`、`条件过于复杂（{n} > {max} 个记号）`、`字符串未闭合：位置 {i}`、
`无法识别的记号：位置 {i}`、`缺少比较运算符（支持 == != >= <= > < in）`、`多余的记号：{text}`、
`数组元素过多（最多 32）`、`变量未定义：{name}`、`类型无法比较：{a} 与 {b}`、
`右侧须是数组或字符串，实得 {b}`。

#### 三 · 运行期语义（runner 四分口径）

| 条件状态 | 结果 | 附带行为 |
|---|---|---|
| 空 / 缺键 / null | **原路径** | 零额外解码（`with_context=False`）、记录形状不变 |
| 求值为真 | 执行 | 与无条件完全同路径 |
| 求值为假 | `SKIPPED` + `error = "COND: 条件不成立"` | **判定排在 delay 之前**：不延时、不建帧、不发、不落日志 |
| 求值抛错 | `ERROR` + `"COND: {原因}"` | `_step_diagnostic(stage="condition", code="CONDITION_REJECTED", data_sent=False)` → 走 `_log_step` + `stop_on_error` |

- **绝不把异常吞成 False** —— 语法 / 变量 / 类型错必须暴露成步骤错误，否则「以为会走的分支没走」
  是最难查的故障。
- 假 → `error` 非空；停止补跳过 → `error` 为空 —— **两种跳过可区分**（与 D6-C `_skip_remaining`
  互补，后者 docstring 已补此说明）。
- 变量上下文（`_remember`，仅 `with_context` 下建）：`step.<n>.status` / `step.<n>.sent` /
  `step.<n>.received` / `step.<n>.rtt_ms`（去空格 hex；无值不写键）；解码字段两个命名空间并存 =
  平铺 `<字段名>`（**最近者胜**）+ 定点 `step.<n>.<字段名>`。
- 解码 hook = 路由侧 `_decode_vars_factory`（仿 `_compile_wrap_factory`，到步执行时自开会话），
  复用 `log_store.resolve_log_fields` —— **与落库解码同一条路**，不引第二套解码；回调**永不抛**
  （解不出来 → 该步没这几个键，不反噬执行）。

#### 四 · DDL（Migration 0005 · 仅新增列）

- `models.py::SequenceStep.condition = Column(String(200), nullable=True)`（注释写明缺省路径）。
- `migrate.py::Migration(5, "sequence_steps_condition", _condition_apply, _condition_verify)`；
  `condition_tables()` 在 verify 钉死 **恰好** `["sequence_steps"]`（补列范围一张表，与 R20
  `profile_sort_tables` 同构）。
- `database.ensure_sequence_step_columns` → **两列同批自愈**（wrap + condition，一次 commit 幂等），
  兜住 `create_all` 只建表不补列的缺口。
- datahub `sequence_step_export_row` 是显式 dict → **补 `"condition"`**（漏了 = 导出再导入静默丢
  分支，往返不等价）；导入走 `SequenceStepSpec.model_validate`（加字段即通）。

#### 五 · 保存口与 FE

- **保存口只查语法、不查变量**：`routers/sequence._condition_spec` —— `None` / 非字符串 /
  strip 后空 → `None`；超长与语法 → `DiagHTTPException(400, "steps[i].condition: …", stage="condition", code="STEP_CONDITION_INVALID", target=steps[i], step=n, data_sent=False)`。
  变量到运行期才存在，「变量未定义」属运行期 `COND:` 记步错误。为此 **`diagnostics.STAGES` 新增
  `"condition"`**（仅加枚举值，不是加约束）。
- 形态：`SequenceStepSpec.condition` 与 `SequenceStepOut.condition` 均 `Optional[str] = None`；
  `_normalize_steps` 校验后进 `write_steps(condition=spec.get("condition"))`；`_to_out` 用
  `getattr(s, "condition", None)`（与 `wrap` 同口径，直连改库的存量行 / 未自愈列不炸）；
  `start_sequence` 在步 dict 带 `"condition"` 并注入 `decode_vars=_decode_vars_factory()`。
- **FE `Sequences.jsx`**：编辑器新增「执行条件（可选）」输入（`maxLength=200`、
  `data-testid="step-condition"`），`stepCondition` state 与「标签 / 延时」同轨（APPLY 才落步）——
  `checkCondition` **就地红框 + 红字**（`step-condition-error`），APPLY 先拦非法并弹 `fail` 横幅；
  `handleApplyStep` 是**重建对象**故显式 `...(stepConditionText ? { condition } : {})`；
  `saveBody` 按 `'condition' in s && s.condition` **条件包含**（键缺席 = 无条件 → 无条件步骤的请求形
  与 R26 前逐字节一致）；`toDraft` `if (!step.condition) delete step.condition`；StepRow
  `COND :: {expr}` 行内指示（`step-cond-{i}`，title 写明四分口径）；状态行 `title` 本就带 `error`
  → 跳过原因 `COND: 条件不成立` 就地可见（**无状态表结构改动**）。

#### 六 · 共享向量与测试

- `vectors/condition.json` **58 行**（每行一对象，UTF-8 LF，`expected` / `error` 二选一）；注册
  `vectors/README.md` §3 → **17 文件 / 21 表** + §7 七条注；`vectorsLoader.test.js` 增 `conditionVec`
  （TABLES 与目录同集自检 5/5 过）。
- 每行同时覆盖：6 比较符与 `in` 双形态、关键字大小写、`null` 三值、布尔非数字、变量未定义、
  类型不可比、三道上限（长度行 314 字符、记号行 70 记号）、字符串未闭合 / 无法识别记号、数组元素
  过多、括号与算术**直接判非法**、空词防御（防 tokenizer 死循环）。
- BE 新增 `test_condition.py`（14 例 = 求值器口径 + 58 向量 **FAILS=0**）与
  `test_sequence_condition.py`（18 例 = **无条件零解码零增量钉死** / 真 → 执行 / 假 → 不延时不发不
  落日志 / 非法 → `COND:` + 结构化诊断 + 快停 / `stop_on_error=False` 继续 / 变量未定义 / 类型
  不可比 / 解码字段两命名空间 / 解码回调炸了不反噬 / 保存口 400 定位与 0 写入 / 非字符串 400 /
  空白归一 null / 缺键 null / 启动注入 `decode_vars` 且步 dict 带 condition / API 全链路
  OK-OK-SKIPPED / datahub 导出带条件）。
- 迁移与自愈：`test_migrate.py` 新增 `ConditionMigrationTest` 3 例（存量库补列 + 行回填 NULL /
  新库只 verify / verify 钉死范围与列），R20 断言改 `_ALL_LABELS[3:]` **跟注册表走**（不硬编码）；
  `SequenceStepColumnSelfHealTest` 四态扩到**两列**（wrap + condition 同批自愈）。
- FE 新增 `utils/__tests__/condition.test.js`（14 例，与 BE 14 例同向量同断言）+ `Sequences.test.jsx`
  **24 → 27 例**（带条件 PUT 带键 / 无条件键缺席且形状 `toEqual` 逐字段钉死 / APPLY 拦非法 + 状态
  行 tooltip 带 `COND:` 原因）。

#### 七 · 验收

- **BE 843 → 878/878**（+35 = `test_condition` 14 + `test_sequence_condition` 18 +
  `ConditionMigrationTest` 3）。
- **FE 1196 → 1213/1213（78 文件）**（+17 = `condition.test.js` 14 + `Sequences.test.jsx` 3）。
- `npx vite build` EXIT=0 · `npm run lint` EXIT=0 · yorha-ui 校验器改动 js/jsx/json **0 违规
  （6 文件）** · `vectors/README.md` 表清单 16 文件 20 表 → **17 / 21** · md 表列数 mismatches=0 ·
  隐形字符／CRLF／TAB = 0。
- **DDL 仅新增列** → feat 提交后另开 `chore(db)`（`python -m backend.db.migrate up`，备份目录
  `backend/db/backups/` 已 gitignore）；`processor.py` / `graph.py` / `Blueprint.jsx` 未碰；
  `/dispatch` 缺省口径逐字节不变（本批零改动 dispatch 链路）；不引 pytest、无新 pip 依赖。

### 8.59 R27 · varint / COBS **出线**（只做编码，**不碰解包**）—— 2026-10-04

#### 一 · 背景与拍板

- 来源 §8.52 复议表 C-5 ③「varint / COBS」原判**不做** → 复议立项并**按原建议拆两批**：
  **R27 出线（编码）→ R28 解包（`stages` 逆向解码 + 应答匹配）**。本批只做前者。
- **硬前置（Phase 0）已先证**：在动任何一行实现之前，先抓**改前金标准**并双端钉死
  「**无变长编码时逐字节不变**」—— BE `test_framing_baseline.py`（14 例）+
  FE `framingBaseline.test.js`（5 例），金标准脚本留存于 Temp（`ev_r27_baseline.py`）。
  两条能力都必须**显式配置**才生效（`encoding` 缺省 `fixed`、协议树里没有 `cobs` 节点），
  故 §0 缺省口径由它们持续看守。
- 两项能力、**两个天然层位**（§8.36 C-5 ③ 原建议「先出线、解包另批」的落法）：

| 能力 | 层位 | 存点 | 说明 |
|---|---|---|---|
| varint 变长长度前缀 | **`length` 卡的新选项** | `parameter_config.encoding ∈ {fixed, varint}` | 缺省 `fixed` = 缺失键 = 与本批之前逐字节一致 |
| COBS 定界编码 | **协议树新组帧元素** `type: "cobs"` | `parameter_config.terminator ∈ {00, none}` | 可嵌套包住整段子树；**不是**出线 transport codec（N4 `escape` 仍在线上层，本批只对比不挪层） |

- 解禁点（§0）：**零 DDL** —— `models.py` 一行未动 → **本批无 `chore(db)`**；
  `processor.py` / `graph.py` / `Blueprint.jsx` 未碰；不引 pytest；**新 pip 依赖 = 0**
  （COBS / LEB128 全是纯函数，不引 `cobs` 类库）。

#### 二 · varint 定案

| 维度 | 定案 | 理由 |
|---|---|---|
| 算法 | **LEB128 最小长度无符号**：每字节低 7 位数据、最高位续位（1 = 后随字节）；`0 → 00`、`127 → 7F`、`128 → 8001`、`300 → AC02` | 最小字节数、字节序无关、行业通识 |
| 缺省 | `pc.encoding` 缺失 / 空 / 枚举外 → **`fixed`**（`normalize_encoding` fail-open） | 与 `byte_order` 同口径（BE fail-open、FE 校验提醒），请求形与存量逐字节一致 |
| 字节序 | **不走 `apply_byte_order`**（R21 的 `byte_order` 与 `encoding` 互不相干，同时配了也按 varint 出线） | varint 天然字节序中立，反转即错 |
| 值域 | `VARINT_MAX = 2^53-1`（JS 安全整数上限，双端同值）；负数 / 超界 / 非整数 → `ValueError` → 走既有 **400** | 超过该值两端位移开始丢精度，不再保证同字节 |
| 出线回写 | LengthHandler 出线后 **`block.byte_length = 实际字节数`** | 设计期宽度 ≠ 出线宽度，回写后下游 refs Σ / checksum 计数**同源**（`varint_len_root` 132 vs `varint_len_fixed_default` 131 正是这 1 字节） |

- FE 同口径：`InstructionEncoder` PASS1 后按 `varintWidth(值)` 回填 `fieldSizes`，
  **引用了 varint 块的 LEN 要拿到新尺寸 → 回填后再跑一遍 PASS1**（Σ 幂等，第二遍只多把
  出线宽度算进 Σ）；无 varint 块时零回填。

#### 三 · COBS 定案

- **组帧元素而非 transport codec**：`Orchestrator.process()` 的**第 0 步树级前置改写**
  `_apply_cobs()` —— 有 `cobs` 节点才遍历（**无 cobs 节点零遍历零改写**，Phase 0 金标准钉住）。
  改写**由内向外**：子树先经**同源子编译器**发射（与主帧同一套 handler，保证 LEN/CRC 语义
  完全一致）→ `encode_cobs_hex` → 替换为**定宽 `fixed` 叶**（`id` 沿用、`children` **保留**供
  LEN/CRC 卡面回显、`is_container=False`）。
- **算法**：单趟、码字节占位回填；单块 ≤ 254 字面量；码 `0xFF` = 满块闭合。
  **关键规则**：码 `0xFF` 且其后无字面量时**不写收束码** —— 否则 254 字面量出现两态、非规范。
  （该 bug 由「独立规范解码器往返」自检当场揪出，见第六节。）
- **定界**：按 `pc.terminator` 追加（`00` 缺省 → 追加 `0x00`；`none` → 不追加）。
  出线正文因此**不含裸 0x00**（`cobs` 表 16 行逐行断言）。
- **解码不进生产代码**：BE 侧由 `test_module_is_encode_only` **字面钉住**模块无解码入口；
  FE 侧解码只活在测试内的**局部参考解码器**（与 `cobsEncode` 零共享代码）。
  这正是「只做编码、不碰解包」的字面执行。

#### 四 · refs 边界与保存侧闸

- **refs 跨不过 COBS 编码边界**：`expand` 遇 `type == "cobs"` **停钻不下钻** —— 引 cobs 块
  本身 → 按其**出线字节数**计；引其**内部叶子** → 保存侧 **400 拒绝**（BE
  `routers/protocol.py::_validate_refs` 收集 `inside_cobs`，detail =
  `refs cannot reference blocks inside a COBS subtree`；FE `validateProtocol` 镜像
  `REFS_INSIDE_COBS` 中文可定位文案）。否则后端按 0 计、前端仍查得到 → 两端 Σ 分歧。
- **枚举外值双端 fail-open + FE 提醒**：`encoding` 枚举外两端回定宽 `fixed`、`terminator`
  枚举外两端回缺省 `00`（镜像 `byte_order` 既定口径：**BE 不在保存侧校验枚举**）；
  FE 出 `ENCODING_UNKNOWN` / `TERMINATOR_UNKNOWN` **warning（不阻断保存）**，防抖自动保存
  不被误报卡死。

#### 五 · API 形制与双端落点

- **纯函数层只吃 `params`**：`framing.py` 提供 `normalize_encoding(params)` /
  `terminator_of(params)`；**取 `Block` 的门面** = `length.encoding_of(block)`，与 R21
  `byte_order_of(block)` 同一形制（缺省口径 / 注释 / fail-open 三件套一致）。
- BE 五处：`core/framing.py`（SSOT：`encode_varint` / `varint_width` / `cobs_encode` /
  `encode_cobs_hex` / `hex_to_bytes` + `LENGTH_ENCODINGS` / `TERMINATORS` / `VARINT_MAX`）、
  `handlers/length.py`（`encoding_of` + `format_total` varint 分支 + 宽度回写）、
  `core/orchestrator.py`（`process()` 第 0 步 `_apply_cobs`）、`core/frame_builder.py`
  （`_with_encoding` / `_with_terminator` / `_to_blocks` cobs 分支 / `expand` 停钻）、
  `routers/protocol.py::_validate_refs`。
- FE 十处：`config/blockTypes.js`（`BLOCK_PROPERTY_FIELDS.encoding` / `.term` + `cobs` 类型
  **palette 末尾追加**（分隔线位置不变）+ `createBlock` 种子）、新 `utils/framing.js`（编码
  SSOT 对照）、`InstructionEncoder.js`（varint 分支 / cobs 局部缓冲子发射 / PASS1 回写 +
  PASS1.5）、`toFrameBlocks.js`（`withLogicParams` / `buildCobsConfig` / `expand` 停钻）、
  `validateProtocol.js`（W6 / W7 / `REFS_INSIDE_COBS`）、`byteOffsets.js`（varint 宽度 +
  `sizeOverrides` 注入 + 组游标收口）、`protocolTree.js`（`collectDeterministicBytes` 出
  varint / COBS 字节 + `computeProtocolOffsets` 两遍法）、`components/editor/Block.jsx`
  （cobs 与容器同深色组卡）。

#### 六 · 设计期口径（偏移尺 / 卡面 / 字节高亮）

- **偏移尺必须跟编码器同宽**，否则其后所有偏移错 1..n 字节：
  - `length + varint` → `size = varintWidth(值)`，值 = refs Σ + `pc.offset`（与 PASS1 /
    `LengthHandler` 的 `count + offset` 同式）；任一 ref 尺寸未知或值域外 → **未知**（`??`）。
  - `cobs` 组的出线宽取决于**子树字节**（0x00 分布、254 满块），尺子只认尺寸不编码 →
    `computeProtocolOffsets` **两遍法**：① 静态尺寸先跑（cobs 组先落 Σ 子宽，只作第二遍的
    输入）② 对每个 cobs **真编码**求出线宽（`collectDeterministicBytes` 含定界）③ 第二遍经
    `opts.sizeOverrides` 回灌 → 偏移、其后起点、总长与 BE `block_spans` 同口径。
    子树含**槽**（载荷期才定字节）/ 任一子块编不出 → 注入 `null` = **未知**，下游沿既有 `??`
    链（**不谎报成 Σ 下界**）。**无 cobs 节点 → 不跑第二遍**（零改写，存量协议尺寸/总长逐值不变）。
  - COBS 区比 Σ 子**宽**（码字节 + 定界）→ 游标按**组自身 size 收口**；普通组 Σ 子 ≥ size
    （含 pad）走既有 pad 上卷，条件不成立 → 存量口径零影响。
- **卡面**：`cobs` 走组卡（`isNestable('cobs')` → `ARRAY_GROUP` 点亮 → 深色 + `::` 标记），
  中央按尺寸出等量 `??`、页脚 `N @MM`；`length` 卡设计期 Σ 显示**仍是 refs 和**（值与
  编码无关，显示口径另案）。
- **已知限制（本批明确不修）**：
  - 载荷落 COBS 区内 → `payload_offset = None`（既有 `None` 路径不崩）；
  - COBS 区内 FE **不做字节高亮** —— `byteMap` 只记 cobs 块自身出线区间（BE `block_spans`
    同样只给 cobs id），区内的子块区间落在编码后已无对应；
  - 协议卡 UI 无 `align` / `pad` 字段（`blockTypes` 无此两列）→ 子树内配 pad 仅理论可达。

#### 七 · 存量双端差异（**R27 不修**，两侧各钉现值加注）

- `SUM_8` 且 `byte_length = 2`：BE 出 `01F7`、FE 出 `00F7`（`formula.js` 的 8 位折返）。
  与本批无关（R22 期就存在），按「只做编码不改算法」原则**不在此批动**；两侧测试各钉现值
  并互相加注，留待算法对齐批次。
- FE 编码侧**已补** `pc.offset`（`toFrameBlocks` / `frame_builder` 本就翻译它、后端
  `LengthHandler` 恒加，FE 此前漏加 → 补齐后同一棵树两端同帧）；**设计期卡面 Σ 显示**仍不加
  `offset`（显示口径另案，UI 也不出此键）。

#### 八 · 共享向量与测试

- `vectors/framing.json` **3 表 35 行**（`varint` 14 · `cobs` 16 · `frame` 5），双端同读；
  注册 `vectors/README.md` §3 → **18 文件 / 24 表**（原 17 / 21）+ §7 三条注；
  `vectorsLoader.test.js` 增 `framingVec`（TABLES 与目录同集自检过）。
- **双道自检防「期望值 = 实现自证」**：期望值既对表，又过**独立规范解码器往返**（BE 生成
  脚本内建解码器 + FE 测试局部解码器，与实现零共享）。正是这一道揪出 **2 个错向量**与
  **1 个编码器 bug**（254 字面量的收束码，见第三节）。
- `frame` 表里 `payloads` 非空的 `cobs_payload_slot` 行：载荷注入属**发送期 `blockMerge`**，
  FE 编码器测试显式跳过并钉住跳过集，BE `build_wrapped` 端到端跑。
- BE 新增 `test_framing_baseline.py`（**14** 例 · Phase 0 金标准）与 `test_framing.py`
  （**25** 例 · 向量对表 / 值域 / fail-open / COBS 往返与满块边界 / 定界三态 / `LengthHandler`
  varint 与宽度回写与 byte_order 忽略与下游 checksum 计字节 / `Orchestrator` 嵌套与空子树与
  refs 引 cobs / frame 向量 / `test_module_is_encode_only`）。
- FE 新增 `framingBaseline.test.js`（**5**）与 `framing.test.js`（**17**，含三张向量表消费 +
  规范解码器往返 + 出线正文无 `00` + 编码器端到端 + 偏移尺）；既有
  `blockTypes.test.js` +4（encoding / cobs / createBlock 种子）、`validateProtocol.test.js`
  +4（W6 / W7 / `REFS_INSIDE_COBS` / 空 cobs 零问题）、`toFrameBlocks.test.js` +4
  （encoding 翻译 / 两键并存 / terminator 三态 / expand 停钻）。

#### 九 · 验收

- **BE 878 → 917/917**（+39 = `test_framing_baseline` 14 + `test_framing` 25）。
- **FE 1213 → 1247/1247（80 文件）**（+34 = `framing.test.js` 17 + `framingBaseline` 5 +
  `blockTypes` 4 + `validateProtocol` 4 + `toFrameBlocks` 4）。
- `npx vite build` EXIT=0 · `npm run lint` EXIT=0 · yorha-ui 校验器改动 js/jsx/json
  **0 违规（16 文件）** · `vectors/README.md` 表清单 **17 文件 21 表 → 18 / 24** ·
  md 表列数 mismatches=0 · 隐形字符／CRLF／TAB = 0。
- **零 DDL → 本批无 `chore(db)`**；`processor.py` / `graph.py` / `Blueprint.jsx` 未碰；
  `/dispatch` 缺省口径逐字节不变（Phase 0 金标准 14 + 5 例持续看守）；不引 pytest、
  **无新 pip 依赖**。

**下一批：R28 varint / COBS 解包**（§8.52 排期第 8 批 · **硬前置 = R27 出线已完成 ✅**）。

### 8.60 R28 · varint / COBS **解包**（`stages` 逆向解包 + 应答匹配）—— 2026-10-04

#### 一 · 背景与硬前置（Phase 0 金标准先钉绿）

- 来源：§8.52 C-5 ③「varint / COBS」按原建议**拆两批**的后半 —— R27 只做出线（编码），
  本批做**收侧解包**：设备回帧的长度域可能是 LEB128 变长、或整段被 COBS 定界包住，
  `response_match` 必须先按**线上字节**把这两层剥开，才轮得到逐层五要素判定。
- **硬前置 = R27 出线已完成 ✅（§8.59）**；`backend/core/framing.py` 本批**一行不改**。
- **Phase 0（改前金标准先双端钉死，改完必须仍绿）**：
  - BE `backend/tests/test_response_baseline.py` **7 例**：内嵌改前金标准 JSON
    （25 normalize + 20 match + 6 多层 + 4 生成树 + 3 层链 + stage A/B/C/D），
    由 Temp `ev_r28_baseline.py` → `ev_r28_baseline.json` 机械抓取、
    `ev_r28_gen_baseline_test.py` 生成测试体（**机械生成不手抄**，防漂移）；
  - FE `frontend/src/components/InstructionForm/__tests__/responseBaseline.test.jsx`
    **3 例**：`defaultSpec()` 形状 / 改前缀 + 开 LENGTH 提交 spec 逐字节 / 只改前缀。
- 两条新能力都**显式配置**才生效（`length.encoding` 缺省 = 缺失键 = `fixed`、
  `unpack.mode` 缺省 `slice`、协议树里没有 `cobs` 节点即不涉及剥层）→ §0 缺省口径
  由 Phase 0 金标准 + `test_framing_baseline` 14 / `framingBaseline` 5 持续看守。

#### 二 · 收侧新模块 `backend/core/unframe.py`（只解不编）

| 函数 | 语义 | 报错口径 |
|---|---|---|
| `decode_varint(data, offset=0) -> (value, width)` | LEB128 最小无符号的逆向；**非最小编码接受**（`80 00` = 0，编码侧只会出最小形态，收侧放宽不产生歧义），宽度按**实际读到的字节数**报（供回算 `offset_val`） | `offset` 负 / 布尔 / 越界、续位悬空、超 `MAX_VARINT_BYTES = 8`、值超 `VARINT_MAX = 2^53-1`、非字节串 → `ValueError` / `TypeError` |
| `cobs_decode(data) -> bytes` | 标准 COBS **码字节区**（**不含定界**）的逆向；码 `0xFF` 与末块之后**不补隐式 `0x00`** | 空区、区内含 `0x00`（= 定界漏剥）、码字节要的字节数越过区尾、非字节串 → `ValueError` / `TypeError` |

- **对偶纪律**：R27「生产模块不得出现解码入口」按批次演进为「**编码模块仍无解码符号**」——
  `framing.py` 不动，`test_framing::test_encode_only_module` 继续钉死它没有 `decode*`；
  新增 `test_unframe::DecodeOnlyModuleTest` 对偶钉死本模块没有 `encode*`。
- 零 I/O、纯函数、**新 pip 依赖 = 0**（LEB128 / COBS 全手写）。

#### 三 · 规格形制与新 reason 码

| 键 | 取值 | 缺省 = 存量口径 |
|---|---|---|
| `length.encoding` | `fixed` / `varint` | **缺失键**读作 `fixed` → 存量规格逐字节不变；枚举外 → `ValueError`（`length.encoding 必须是 fixed/varint 之一`） |
| `unpack.mode` | `slice`（缺省）/ `cobs` | `slice` 形态**逐字节不变** |
| `unpack.inner_head` / `unpack.inner_trailer` | ≥ 0 | 仅 `mode=cobs` 下合法；`slice` 下写了 → `ValueError`（`仅 mode=cobs 时有效`）；`cobs` 允许 `head = trailer = 0`（整层就是一个 COBS 区本身可区分），`slice` 仍禁 0+0 |

新 reason 码（三条 —— **只在病因确实不同时新增，宁可少判不误判**）：

- `LENGTH_VARINT_INVALID(原因)`：**读不出值**（续位悬空 / 超 8 字节 / 超 `2^53-1`）。
  与「读出的值对不上」（`LENGTH_MISMATCH`）病因不同 → 不硬凑成后者。
- `STAGE[i].UNPACK_COBS_INVALID(原因)`：该层 COBS 区解码失败（区尾不够 / 区内裸 `0x00`）。
- `STAGE[i].UNPACK_INNER_TOO_SHORT(n<=m)`：解出的区内字节不足以剥掉 `inner_head + inner_trailer`。

请求侧（`tx`）解码失败**不写理由**，镜像存量 `tx=b""` 口径；单帧与分层两处 length 逻辑
抽共用 `_length_reasons(length, frame, tag="")`，reason 只差 `STAGE[i].` 前缀（**改一必改二**）。

#### 四 · 关键判定公式（varint 自洽的唯一例外）

```
expected = len(frame) + offset_val - (width - byte_length)
```

- `offset_val` 按**设计期宽度**算（生成侧 `A - head - trailer` 用 `byte_length`），
  收侧按**实际出线宽**回算 —— 两处差的 `(width - byte_length)` 正好抵消。
- 展开即 `declared = payload + A`（与 `offset_val` 同源）；`fixed` 时 `width == byte_length`
  → 修正项恒 0，**存量逐字节不变**。
- 该抵消**只对被选中的那张 length 卡成立**（推导见 `_downgrade_varint` 注释）：层内另有
  varint 卡时 `expected = declared + Σ(wᵢ - bᵢ)(i ≠ 选中项)` → 必然失配。由此定出第五节。

#### 五 · 生成侧：几何可用才生成，算不出就**逐要素降级**

| 情形 | 结果 | 理由 |
|---|---|---|
| 恰有一张 varint 卡且就是选中项 | `length` 照常生成（含 `encoding`） | 第四节公式自洽 |
| 层内另有 varint 卡 | `length` 不生成 + warning | 回算项盖不住它的宽差 |
| `checksum` 的 `span_start = head` / `span_end_pad = trailer`（refs 只圈载荷）或绝对 `field_offset` 且其前有 varint 卡 | `checksum` 不生成 + warning | 字节计数型定位，静态算不出实际宽 |
| 层内存在任意 varint 卡 | `unpack = None`（单层用不上；多层 → **400**） | `head` / `trailer` 是字节计数 |
| 插槽在 COBS 区内 | `length`/`checksum` 不生成 + warning；`unpack.mode=cobs` 仍成立 | declared / span 随载荷与 `0x00` 分布变 |
| 无槽 COBS 单元 | 整段作**一个几何单元**（`_cobs_wire` 走 `build_wrapped` 取**出线宽**），refs 越出子树 / 区间模式 → 降级 | 码字节与 `0x00` 插码不进逻辑和 |
| 嵌套 ≥ 2 层 cobs 包槽 | `unpack = None` → 多层 `build_spec` **`ValueError` → 400** | 单次 COBS 解码够不着内层，几何表达不了 |
| 无槽 COBS 区内的 length / checksum 卡 | 不生成 + warning（`_warn_hidden_logic`） | 区内叶子没有各自出线坐标 |

- **多层缺 `unpack` → `ValueError`**：`[层i …] 协议含无法静态表达的 COBS/变长几何（槽嵌套
  COBS、COBS 出线宽随载荷变，或层内另有 varint 长度域）… → 请手工编写应答规格`
  —— 分层时剥不出内层就不是「少判」而是「误判」，fail-closed 400（第二处设计选择已定案）。
- `_length_element` 走 `normalize_encoding` **fail-open**，**只写非缺省 `encoding`**。

#### 六 · FE 落点：只做规格表单，**不建无消费者的解码模块**

- `TransactionPanel.jsx` 长度区 LENGTH toggle 行右侧新增 `ENCODING` 下拉
  （`fixed · 定宽` / `varint · LEB128`）+ `patchLengthEncoding`：**选 varint 才写键、
  切回 fixed 删键**（只写非缺省值 → 与后端「缺失键 = fixed」逐字节对应，存量形态不变）。
- `BYTE_LEN` **不禁用** —— 它是设计期宽度，收侧回算 `offset_val` 要用；选 varint 时下方
  出 9px 提示（字节序无关、ORDER 不参与 / BYTE_LEN = 设计期宽度）。
- 解码只活在 BE `unframe.py`，FE 不建无消费者的解码模块（两处设计选择之一）。

#### 七 · 向量口径：**反向消费既有 `vectors/framing.json`，不新增文件**

- 新表须**双端同读**，而匹配只有后端一处消费 → 不满足条件，故不新增。
- `test_unframe.py` 逆向消费：varint 行 `hex → v`、cobs 行 `out`（先剥
  `parameter_config.terminator`）→ `in`，作解码往返真值；另与 `framing.encode_varint` /
  `encode_cobs_hex` 做直接往返 + 畸形输入报错面。
- `vectors/framing.json::_note` 与 `vectors/README.md §7` 同批改口（R27「只编码不解包」
  → R28 反向消费）；`README §3` 表清单 **18 文件 / 24 表不变**（无新增向量文件）。

#### 八 · 硬约束与解禁点

- **零 DDL** —— `models.py` 一行未动 → **本批无 `chore(db)`**；`processor.py` /
  `graph.py` / `Blueprint.jsx` 未碰；`/dispatch` 缺省口径逐字节不变（Phase 0 金标准 +
  既有 dispatch 口径测试看守）；不引 pytest；**新 pip 依赖 = 0**。

#### 九 · 验收

- **BE 917 → 955/955**（+38 = `test_response_baseline` 7（新）+ `test_unframe` 9（新）
  + `test_response_match` 23 → 35（+12）+ `test_response_generate` 41 → 51（+10））。
- **FE 1247 → 1251/1251（81 文件）**（+4 = `responseBaseline.test.jsx` 3（新）
  + `TransactionPanel.test.jsx` 13 → 14（+1））。
- `npx vite build` EXIT=0 · `npm run lint` EXIT=0 · yorha-ui 校验器改动 js/jsx/json
  **0 违规（3 文件）** · md 表列数 **mismatches=0** · 隐形字符／CRLF／TAB = 0
  （终判看 index blob，`ev33_index_hygiene.py`）。
- **零 DDL → 本批无 `chore(db)`**；`framing.py` 一行不改（`test_encode_only_module` 仍为真）；
  不引 pytest、**无新 pip 依赖**。

**§8.52 七项复议立项（R21–R28）至此全数销项 ✅。下一批 → 人工测试反馈另立 R29（§8.61）。**

### 8.61 R29 · 加工页条件存在 (PRESENCE) **展示层** —— 2026-10-04

#### 一 · 来源与定性（人工测试反馈，**非** §8.52 复议范围）

- 用户反馈原文：**「满足 IF 条件的与不满足 IF 条件的时候，指令加工中本条指令的字段从肉眼上看不出区别」**。
- 改前取证（库内 `instruction_fields` 38 行仅 2 行带 `pc.presence` + 直跑 `InstructionEncoder` 实测字节）：
  - ① `原始Hex`（HEX_RAW 1B）← `文本字段`（STRING 8B）`== "01"`：初态 `inputs.cmd="ALPHA"` →
    `414C504841000000`（8B，门掉）、键入 `"01"` → `3031000000000000FF`（9B，发）—— **字节会变，但字段行无任何标识**。
  - ② `运行秒数`（TIME_ACCUMULATOR 4B）← `枚举映射`（MAPPING 1B）`== "01"`：未动下拉 →
    `0000000000`（5B，`inputs` 无键 + `pc.value` 空 → fail-open 恒命中）、选「开」（`handleChange` 里
    `parseInt(x,16)` 转成数值 1）→ `01`（1B，**`String(1)="1" ≠ "01"` → 未命中**）、选「关」（0）→ `00`（1B）、
    硬喂字符串 `"01"` → `0100000000`（5B）。
- **两层定性**：
  1. **显示缺口（本批修）** —— §8.16 第 6 条文件面清单**本就不含 `InstructionForm`**，加工页字段树对 presence
     零感知（无 IF 角标 / 无命中态 / `n-N BYTES` 定长章仍按静态 `byte_len` 亮）→ **不是回归，是当时划在范围外**；
  2. **判定链两处（本批不修，见第七节）** —— expect 补零十六进制与枚举数值型**永不相等**、无输入框的 ref
     初态必落 fail-open。
- **拍板**：**只做显示层**（用户选定）。判定归一会翻转存量判定 → 出线字节变，属语义变更，另行排期。

#### 二 · 新纯函数 `resolvePresenceStates`（`config/runnerRenderRules.js`）

| 要点 | 口径 |
|---|---|
| 判定来源 | **只委托** `InstructionEncoder._presenceHit`（与出线编码同一套 fail-open，改一必改二）；本函数不造第二套判据 |
| 入表条件 | 字段带**对象形态**的 `pc.presence` 才进表；未配置（含非对象 / 数组）→ 不进表 → 渲染层不点角标，与 R29 之前逐像素一致 |
| 返回形状 | `{fieldId: {hit, title}}` |
| `title` 构成 | `条件字段：[ref] == expect` + `· 命中 → 发射本字段` 或 `· 未命中 → 0 字节（本帧不发）` + **fail-open 归因四支**（缺 ref_id / 缺 expect / ref 悬空 / ref 无值链） |
| 依赖方向 | `runnerRenderRules → InstructionEncoder`，编码器不回引本文件 → **无环** |

- 归因**只在命中侧**有意义（fail-open 恒命中，未命中必是真比对不等）。把「为什么这条恒发 / 不发」写进 hover，
  正因为**存量 ref 无 `pc.value`、ref 悬空这两类静态链断裂在加工页此前完全不可见**。

#### 三 · 渲染落点（三处，均为显示层）

| 文件 | 改动 | 关键点 |
|---|---|---|
| `SmartInput.jsx` | 新 prop `presence = null` | label 区（kind 章之后）出 `IF` 琥珀章；右徽标槽 `presence && !hit` → `[SKIP 0B]` **顶到最高优先**（压过 TIME_PICKER / READ_ONLY / 用量 / 长度章）—— 「这行根本不出线」比「这行能不能改」更要紧 |
| `RunnerFieldTree.jsx` | 新 prop `presenceStates = null` | 叶行 / 组头查表出章；未命中 → 外层 `opacity-50`（组未命中时**整棵子树**随之降透明）；递归向下透传 |
| `InstructionRunner.jsx` | `useMemo` 造表 + 传 prop | 依赖 `[normalizedInstruction, inputs, computedValues]`，**与 `hexPreview` / `byteMap` 同一组** → 角标与右侧 BYTE_STREAM、`LEN` 恒同步，不会出现「角标说 SKIP 但字节还在」 |

- **`presenceStates` 缺省 `null` = 零渲染**：`Sequences.jsx` 步骤编辑器复用同一 `RunnerFieldTree` 但**不传表**
  → 该页零改动（本批严格限于用户选定的加工页）。
- **输入与限宽一律不禁用**：被门掉的字段仍可键入（要靠它把条件改命中），`maxLength` / `min` / `max` /
  用量徽标全部照旧 —— 本批**不改任何限宽行为**，角标只陈述结论。

#### 四 · 明确不改（本批边界）

- `_presence_hit` 判定口径、`validateInstruction` 校验四码、`normalizeInstruction` 清洗、编码分支
  **一行未动** → **出线字节逐字不变**（新 helper 只读不写）。
- **不做 expect 十六进制补零归一**（`"01" ≡ 1`）—— 会翻转第一节 ② 的存量判定。
- BE **零改动**（`field_blocks.py` / `field_decode.py` 未碰）；`models.py` 一行未动 → **零 DDL → 无 `chore(db)`**。
- 应答解码侧不涉及：presence 未命中 → 0 字节 → `field_decode` 本就不产条目（`n <= 0` 早退在 align 之前）。

#### 五 · 测试（红测先行有据）

- 3 个新文件 **24 例**：
  - `config/__tests__/runnerRenderRules.presence.test.js` **12 例** —— 进表口径 / `String` 归一 /
    `computed` 优先 / fail-open 四支归因 / **角标结论 == 真实字节**恒等式（叶：`byteMap` 含否 ≡ `hit`；
    组：命中 4B ↔ 未命中 2B）；
  - `components/InstructionForm/__tests__/RunnerFieldTree.presence.test.jsx` **9 例** —— 不传零渲染 /
    表里没有该字段也不渲染 / 命中态 / 未命中态 / `[SKIP 0B]` 压过 `[READ_ONLY]` / 组级同权 / 父命中不豁免子；
  - `components/InstructionForm/__tests__/InstructionRunner.presence.test.jsx` **3 例** —— **装配线**：
    表真传到字段树 + 改 ref 输入角标实时翻转 + 未配 presence 的字段不出章。
- **红测证据**：`git stash` 四个实现文件后跑同批测试 → **19 failed / 2 passed**（通过的 2 条是
  「不传就不渲染」的反向用例，理应在旧代码上也通过），`stash pop` 后 **24 / 24 绿**。

#### 六 · 验收

- **BE 955/955（持平，本批零后端改动）**、**FE 1251 → 1275/1275（84 文件，+24）**。
- `npx vite build` EXIT=0 · `npm run lint` EXIT=0 · yorha-ui 校验器改动 js/jsx **7 文件 0 违规** ·
  md 表列数 **mismatches = 0** · 隐形字符 / CRLF / TAB = 0（终判看 index blob，`ev33_index_hygiene.py`）。
- **零 DDL → 本批无 `chore(db)`**；不引 pytest、**无新 pip 依赖**。

#### 七 · 登记为后续可选项（本批**不做**）

| 项 | 影响 | 为何不并入本批 |
|---|---|---|
| expect / 枚举值十六进制补零归一（`"01" ≡ 1`） | 会翻转存量判定 → **出线字节变** | 语义变更，须双端同步 + 存量影响清单，单独排期论证 |
| ref 无值链时的校验提醒（新 W 码） | 只提醒、零行为变更 | 用户本轮只选显示层 |
| `Sequences` 步骤编辑器同款角标 | 该页显示变更 | 本批严格限于加工页 |

**R29 ✅ —— 加工页「看不见条件」这一条人工反馈已收口。下一批 → R30（§8.62）就地收掉 R29 登记的两个「半成品」。**

### 8.62 R30 · presence 可见性**收口**：进制/补零假阴性提示 + 第二消费方自算 —— 2026-10-05

#### 一 · 来源（R29 自己登记的两个「半成品」，同一主题 = 看不看得见）

- 交付 R29（§8.61）后仍留两处缺口：
  1. **只说结论、不说原因** —— 样本 ② 面板 expect 存字符串 `"01"`，而枚举下拉把选项值 `parseInt(x,16)` 转成数值 `1`
     → `String(1)="1" ≠ "01"` **判不等**，但角标 title 只写「未命中 → 0 字节」，**看不出为什么**判不等；
  2. **第二个消费方一个章都不出** —— `Sequences.jsx` 步骤编辑器复用同一 `RunnerFieldTree`，R29 为把范围钉在加工页
     把缺省定成 `null = 零渲染` → 同一条指令**加工页有角标、步骤编辑器没有**，自相矛盾。
- 两处**都不改判定、不改字节**（用户此前明确只选显示层；判定归一仍待拍板）。

#### 二 · 进制 / 补零**假阴性**提示（`resolvePresenceStates` 的 `title` 追加）

| 触发条件 | 口径 |
|---|---|
| 仅 **miss** 侧 | 命中没这问题；fail-open 恒命中也不挂（提示只回答「为什么不等」） |
| expect **整串十六进制可解析** | `^[0-9A-Fa-f]+$` 且非空；`ALPHA` / `0x1` 之类一律 `NaN` |
| 解析值与当前值**数值相等** | `String(refVal) !== String(expect)` 却 `hex(expect) === num(refVal)` |

- 三条同时成立才追加 `· ⚠ 按十六进制解析 "01" = 1 与当前值 1 相等，String 归一判不等（补零/进制差异 → 未命中）`；
  **真·不同值（expect `9` / 当前 `1`）不提示** —— 宁可少判不误判，文案只陈述事实不断言用户意图。
- **纯展示**：判定仍由 `_presenceHit` 说了算，本段不参与任何比对。

#### 三 · 第二消费方自算（`RunnerFieldTree` 缺省语义：「零渲染」→「自算」）

| `presenceStates` | 行为 |
|---|---|
| `undefined`（未传） | **用本组件手上的 `fields` / `inputs` / `computedValues` 自算**（顶层只算一次，递归把表传下去） |
| `null`（显式） | 关闭（保留 R29 的逃生口） |
| 对象 | 直接用（`InstructionRunner` 走这条，带 memo 保证与 `hexPreview` / `byteMap` 同依赖） |

- 自算与显式传表**同一个 helper**，不是第二套判据 → 加工页 / 步骤编辑器口径**必然同源**，新增页面默认就有。
- **`Sequences.jsx` 一行未改**（靠组件自算生效）；`normalizeRunnerInstruction` 的 `parameter_config` 整包 spread，
  `presence` 原样透传到渲染树。

#### 四 · 明确不改

- 判定 / 校验四码 / normalize / 编码分支 **一行未动** → **出线字节逐字不变**；BE 零改动；`models.py` 未动 → **零 DDL → 无 `chore(db)`**。
- **判定归一（`"01" ≡ 1`）仍不做**（会翻转存量判定 → 字节变），继续挂在 §8.61 第七节待拍板。

#### 五 · 测试（红测先行有据）

- 新增 **15 例**（FE **1275 → 1290**）：
  - `runnerRenderRules.presence.test.js` **+7**（补零 `01` / 带字母 `0A` / ref 为字符串 / 真不同值不提示 /
    非 hex 不提示 / 命中侧不提示 / fail-open 不提示）；
  - `RunnerFieldTree.presence.test.jsx` **+5**（不传自算 miss / hit / 组级 / **显式表优先于自算** / 显式 `null` 仍可关）；
  - `InstructionRunner.presence.test.jsx` **+2**（端到端：默认 `0` vs `"01"` 不提示 → 改成 `1` 出提示**且判定仍 miss**）；
  - `Sequences.test.jsx` **+1**（**第二消费方端到端**：步骤编辑器零接线自动出 `IF(miss)` + `[SKIP 0B]`，帧同步 `FRAME 1B`）。
- **红测证据**：stash `runnerRenderRules.js` + `RunnerFieldTree.jsx` → presence 三文件 **7 failed / 31 passed**、
  `Sequences.test.jsx` **1 failed / 27 passed**，`stash pop` 后 4 文件 42 例全绿。

#### 六 · 验收

- **BE 955/955（持平）**、**FE 1275 → 1290/1290（84 文件，+15）**、`npx vite build` EXIT=0、`npm run lint` EXIT=0、
  yorha-ui 校验器改动 js/jsx **6 文件 0 违规**、md 表列数 mismatches = 0、隐形字符 / CRLF / TAB = 0；
  **零 DDL → 无 `chore(db)`**；不引 pytest、**无新 pip 依赖**。

#### 七 · §8.61 第七节剩余（仍未做）

- expect / 枚举值**十六进制补零归一**（`"01" ≡ 1`）—— **会改字节，需拍板**；
- ref 无值链的**校验提醒**（新 W 码，零行为变更）。

**R30 ✅ —— §8.61 第七节 3 项里「Sequences 同款角标」已由本批以「组件自算」方式收掉（且不止同款：新页面默认就有）。
下一批 → R31（§8.63）。**

### 8.63 R31 · presence **设计期效度**三码 —— 「配了却不成立」在保存前就点破 —— 2026-10-05

#### 一 · 来源

- R29/R30 把「**为什么**判不等」放进了加工页 / 步骤编辑器的 hover（运行前的填写现场）；
  **指令管理页（设计期）看不到** —— 用户配完保存，等真机上「一个字节都不发」才发现，太晚。
- §8.61 第七节第 ② 项「ref 无值链的校验提醒（新 W 码）」是本批的**直接来源**；本批把范围
  扩成**三码**（同一条主题的三个面：拿不到值 / 取值封闭却不相等 / 补零假阴性）。
- **零行为变更**：三码全落 warnings，保存只拦 errors → 判定与出线字节一行未动。

#### 二 · 三码（W 码 · 不阻断保存）

| 码 | 设计期形态 | 点破的结论 |
|---|---|---|
| W `PRESENCE_REF_NO_SOURCE` | 引用字段**拿不到可判定的值**：无 `pc.value`、非输入型（`INPUT`/`STRING`/`variable`）、无选项、非计算类，**且**为只读/固定算子（`HEX_RAW`/`FIXED`/`HEADER`/`TAIL`/`SCRAMBLE` 或 `readOnly`） | 编码期 `_refValue` 只能取到 `undefined` → **恒 fail-open 判命中 = 等于没配** |
| W `PRESENCE_EXPECT_UNREACHABLE` | 有下拉选项（取值**封闭集**）→ 枚举「选项归一值 ∪ 静态值」**无一**与 `String(expect)` 相等 | **选哪一项都不成立**（恒未命中 → 0 字节）——样本② 的设计期可见版 |
| W `PRESENCE_HEX_PAD` | 静态值与 expect **十六进制解析相等、`String` 归一判不等**，且非自由键入、无选项集 | 补零/进制假阴性 → **静态链恒未命中**（与 R30 hover 归因**同一谓词**） |

- 判据一律「**表外不算、宁可少判**」：可自由键入（`STRING` / `type='string'`，键入相符值即命中）、
  非锁定（拿不准它将来能不能改）、无候选全集（没有选项 → 取值不封闭）→ **一律不提醒**
  （误报会让用户对提醒脱敏，这是 `validateInstruction` 头注「when in doubt, make it a warning」的延伸）。
- 悬空 ref 由 `PRESENCE_REF_MISSING` 单独覆盖、配置不完整由 `PRESENCE_INCOMPLETE` 单独覆盖 →
  **两者都不叠报效度码**（判不了就不出，避免同一条问题刷三条）。

#### 三 · SSOT 抽取（本批唯一的一处重构）

- 新叶子模块 **`utils/presenceSemantics.js`**（零 import → 任何一层都能用，**无环**）：
  `hexNorm` / `comparableNumber` / `radixPadMismatch` / `normalizeOptionValue` / `formatEnumOptions` / `enumCandidates`。
- `runnerRenderRules.js`（R30 角标 hover）与 `validateInstruction.js`（R31 设计期提醒）**import 同一实现**；
  `formatEnumOptions` 从 `runnerRenderRules` **re-export**（`export { formatEnumOptions }`），既有 importer 与
  70 例回归测试**一行未改**。
- 理由：同一条「为什么不等」出现在**两个地方**，必须共用一个谓词，否则文案与判定会悄悄分叉
  （与 BE↔FE `_presence_hit` ↔ `_presenceHit` 的「改一必改二」同一纪律，只是这一对在 FE 内部）。

#### 四 · 明确不改

- 判定 / 校验四码 / normalize / 编码分支**一行未动** → **出线字节逐字不变**；BE 零改动
  （BE 本就无 presence 校验码，四码 + 三码都是 FE-only）；`models.py` 未动 → **零 DDL → 无 `chore(db)`**。
- **不新增 error** → 保存门（`useInstructionData` 只拦 errors）行为不变，`errors` 恒为空。

#### 五 · 测试（红测先行有据）

- 新增 **21 例**（FE **1290 → 1311**）`utils/__tests__/validateInstruction.presenceValidity.test.js`：
  ① `REF_NO_SOURCE` 8 例（含「悬空不叠报」「不完整不叠报」）、② `EXPECT_UNREACHABLE` 5 例
  （含样本②原样 / 归一后命中 / 真不同值 / 静态值在候选集 / 无选项不报）、③ `HEX_PAD` 6 例
  （含 `0A` 带字母 / 真不同值 / 判等 / 可自由键入 / 选项归 ② 不叠报）、**零行为总闸** 2 例。
- **红测证据**：实现落笔前先跑该文件 → **7 failed / 14 passed**（恰是 7 个正向断言，码尚不存在）；
  实现后 `git stash push -- validateInstruction.js runnerRenderRules.js` → **再红 7 failed / 14 passed**，
  `stash pop` → 21 例全绿；R30 既有 19 例 + `runnerRenderRules.test` 70 例（重构回归）同步全绿。

#### 六 · 验收

- **BE 955/955（持平）**、**FE 1290 → 1311/1311（85 文件，+21）**、`npx vite build` EXIT=0、
  `npm run lint` EXIT=0、yorha-ui 校验器改动 js/jsx **4 文件 0 违规**、md 表列数 mismatches = 0；
  **零 DDL → 无 `chore(db)`**；不引 pytest、**无新 pip 依赖**。

#### 七 · §8.61 / §8.62 第七节去向

- ②「ref 无值链的校验提醒（新 W 码）」→ **本批以 `PRESENCE_REF_NO_SOURCE` 收掉**（且扩成三码）；
- ① expect / 枚举**十六进制归一**（`"01" ≡ 1`）→ **仍待拍板**，是唯一会改字节的一项 → 下一批 **R32（§8.64）**。

**R31 ✅（本节的三条 W 码里 ③ `PRESENCE_HEX_PAD` 已由 §8.64 判定归一**退役**、② 的判据已改用 `presenceEqual` —— 见下节）。**
**下一批 → R32（§8.64）：判定归一（`"01" ≡ 1`），会改字节，须 BE/FE 同步 + 存量影响清单。**

### 8.64 R32 · presence **判定归一**（`"01"` ≡ 1）—— 首个「会改字节」的判定修正 —— 2026-10-05

#### 一 · 来源与拍板

- §8.61 第七节第 ① 项（§8.62 / §8.63 续挂），用户拍板「**R31 + R32 两批连做**」，并**明确接受出线字节会变**。
- 病根（样本 ②）：expect 存**字符串** `"01"`，而引用值是**数值** `1` → `String(1)="1" ≠ "01"` **恒未命中**，门等于配废。
  R30 只能在 hover 里解释「**为什么**判不等」、R31 只能在设计期提醒「这条条件达不成」—— 都是在**描述病**，不是治病。
- 本批把两者判成**等**：这正是拍板的目的，也是 §0「`/dispatch` 缺省口径逐字节不变」的**不冲突面** —— 无 presence 的指令与默认路径逐字节不变，只有「expect 是补零/带字母 hex 字符串、值是数值」这一类配置由未命中翻为命中。

#### 二 · 判定归一（谓词 `presenceEqual`）

```
presenceEqual(expect, value) =
      String(expect) === String(value)                                  // ① N3 存量口径逐字保留（数值 1 命中 "1"）
   || ( expect 是**字符串**
        && /^[0-9A-Fa-f]+$/.test(expect)                                // ② 整串 hex（无前缀、无空白）
        && Number.isSafeInteger(parseInt(expect,16))                    // ③ 安全整数内
        && comparableNumber(value) === parseInt(expect,16) )            // 数值相等 → 判等
```

三条边界（**宁可少判，只做拍板项**，各自有向量/用例锚住）：

- 归一**仅当 expect 是字符串** —— JSON 数字 `10` 不按 hex 解（现状不变，用例锁住）；
- **不做 trim** —— `" 1"` 不是整串 hex（现状不变，向量 `[{"expect": " 1"}, "AA"]` 锚住）；
- 超安全整数不归一 —— `Number.isSafeInteger` ↔ Python `2**53-1`，双端精度同阈不分叉。

**三个判定点同用一个谓词（改一必改二 + 一）：**

| 层 | 判定点 | 为什么必须跟 |
|---|---|---|
| FE 运行期 | `utils/InstructionEncoder._presenceHit` | 出线字节的真源（inputs/computed 值链） |
| FE 设计期 | `utils/byteOffsets.presenceStaticState` | 偏移尺 / 卡面静态链 —— 不跟就会「编码期命中、卡面却按 0 字节排偏移」的两端自相矛盾 |
| BE 编译期 | `core/field_blocks._presence_hit` → `_presence_equal` | byte-equal 锚点（`datahub` 再导出） |

#### 三 · 存量影响清单（会改字节的全集）

1. **`vectors/presence.json` leaf 表** `[{"ref_id":"cmd","expect":"01"}, "AA"]` → **`"AABB"`** —— **唯一一条向量变化**（两端同读一份 → 自动同步，无需改两处）。
2. 双端**新增 21 例**锁新口径（BE 8 + FE 13），其中 BE `TestPresenceRadixNormalize` / FE `InstructionEncoder` 的 R32 describe 逐条镜像同名用例。
3. **零影响面**：无 presence 的指令 / `vectors/*.json` 其余 17 份 / N3 四码 / fail-open 四支 / 判定先于 repeat 与子树递归的先后顺序 —— **一行未动**。
4. `test_field_decode`（`expect "2"` vs 值 1）、`test_encode_align`（`expect "1"` vs 值 1）、`Sequences` 的 `expect "02"` vs 初值 0 —— 均为真·不同值 → **命中结论不变，全量照绿**（BE 955 → 963 全绿即证据）。

#### 四 · 展示层随判定收口（一处翻面 + 一处退役 + 一处改判据）

- **R30 hover 注记翻面**：miss 侧的「假阴性解释」在 R32 后**已无可能成立**（能 hex 相等的必已命中）→ 注记改挂**命中侧**：
  `· 按十六进制归一判等（expect "01" ≡ 值 1 = 1，补零/进制差异不影响判定）`；fail-open 归因优先，两者互斥。
- **R31 W `PRESENCE_HEX_PAD` 退役**：「恒未命中」的前提不复存在，再报就是假警 —— 码从 `validateInstruction` 删除（测试改写为「退役后零回归」断言）。
- **R31 W `PRESENCE_EXPECT_UNREACHABLE` 改判据**：候选比对由 `String(v) !== expect` 改为 `!presenceEqual(expect, v)` —— 样本② 归一后**可达 → 不再报**，只有「归一后仍判不等」（如选项 05/06 vs expect `"0A"`）才报，文案加「（含十六进制归一）」。
- **R31 W `PRESENCE_REF_NO_SOURCE` 不受影响**（fail-open 四支未变，① 码语义照旧）。

#### 五 · 测试（红测先行有据）

- 新增 **21 例**：BE `TestPresenceRadixNormalize` **8**、FE `InstructionEncoder.presence.test.js` R32 describe **8**（含组级门）、FE `byteOffsets.presence.test.js` R32 describe **5**。
- **红测证据（实现落笔前）**：BE `test_encode_presence` → **4 failed / 14 passed**；FE encoder + byteOffsets → **6 failed / 51 passed**（正向断言全红、负向断言已绿）。实现后 BE 18/18、FE 57/57 全绿。
- R30/R31 展示层既有用例在判定翻面后**转红（预期）→ 同批改写**：`runnerRenderRules.presence` 的 miss 侧三条改命中侧、`InstructionRunner.presence` 的「仍判未命中」改「归一命中 + 无 SKIP」、`validateInstruction.presenceValidity` 的 HEX_PAD 段改退役断言。

#### 六 · 验收

- **BE 955 → 963/963**、**FE 1311 → 1323/1323（85 文件，+12）**、`npx vite build` EXIT=0、`npm run lint` EXIT=0、yorha-ui 校验器改动 js/jsx/json **0 违规**、md 表列数 mismatches = 0；
  **零 DDL → 无 `chore(db)`**（`models.py` 未动）、不引 pytest、**无新 pip 依赖**、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰。

#### 七 · 明确留白（本批不做）

- 不做空白容错（`" 1"`）、不做 JSON 数字 expect 的归一、不改 fail-open 四支、不改 N3 四码与层级顺序。

**R32 ✅ —— §8.61 第七节两项至此全部出清（② 由 R31、① 由本批）。第七节归零。**（后续：加工页展示口径由 **R33（§8.65）** 改为「未命中纯隐藏」。）

### 8.65 R33 · 加工页 presence 未命中字段**纯隐藏**（仅加工页，步骤编辑器不动）—— 2026-10-05

#### 一 · 来源与拍板

- 用户新需求（**非** §8.61 第七节范围，独立批次）：「命中即发送」的语义下，**指令加工业页面**希望按选项不同改变字段展示 —— **没有触发的字段直接隐藏掉，防止干扰使用者**。
- 两项 UX 取舍当场拍板：
  1. **纯隐藏（完全不渲染）** —— 不留占位、不留「N 个字段已隐藏 ▸ 展开」入口，一个像素不留；
  2. **仅指令加工业页面** —— 步骤编辑器（Sequences）维持 R29 形态（降透明 + `[SKIP 0B]`），因为那里要展示步骤流程全貌。
- 因为是 opt-in 开关，两页口径不再「必然同源」而是**同源判定 + 分叉展示**：判定表仍是同一张（`resolvePresenceStates`），只有**渲染动作**按页面分。

#### 二 · 实现（纯展示层，判定点一个不加）

- `RunnerFieldTree` 新增 prop **`hidePresenceMissed = false`**：
  - 计算 `presenceMiss` 后**直接 `return null`** —— 组与叶**同一个判定点**（组在此返回 → 整棵子树随之消失，子层不重复判断）；
  - 递归调用透传该 prop（深层组内字段同样隐藏）；
  - **缺省 `false` → 分支永不进入 → 未接线方逐像素不变**（`Sequences.jsx` 一行未改）。
- `InstructionRunner` 传 `hidePresenceMissed`（加工页唯一接线点）。
- **兜底事实行**：顶层 `depth === 0` 且**全部字段**都判未命中时，出一条
  `[HIDDEN] 无可填字段 · 字段的 presence 条件在当前输入下均未命中（本帧不发射）`
  —— 否则配置区空白会被当成「页面坏了」。**只陈述事实、无按钮无展开入口**（纯隐藏拍板不变）；有任一可见字段即不出现。

#### 三 · 字节口径不变（隐藏只动 DOM）

| 层 | 是否受影响 | 说明 |
|---|---|---|
| 出线编码 `InstructionEncoder` | ❌ 不变 | 未命中本就不发射字节，与是否渲染无关 |
| 偏移尺 / `byteOffsets` | ❌ 不变 | 未命中已按 0 字节排偏移 |
| `BYTE_STREAM` / `LEN` | ❌ 不变 | 同上；测试锁「字段被藏起来 LEN 照样随判定 +1」 |
| `validateInstruction` 四码 | ❌ 不变 | 校验在设计期，与加工页渲染无关 |
| 字段树 DOM | ✅ 变 | 未命中行不渲染（本批唯一改动面） |

**判定表与判定谓词（`presenceEqual` / fail-open 四支 / N3 四码）一行未改**，本批**零字节变化**。

#### 四 · 测试（红测先行有据）

- **红测证据（实现落笔前）**：新增 R33 describe → **7 failed / 26 passed**（现状照旧出降透明 + `[SKIP 0B]`）。
- 新增 **12 例**：
  - `RunnerFieldTree.presence` R33 describe **12** —— 缺省不变 / 叶未命中整行消失 / 命中照常 / 组未命中整棵子树消失 / 组命中而内层未命中（父命中不豁免子）/ 未配 presence 不受影响 / 自算路径同隐藏 / `presenceStates=null` 时不隐藏（判定显式关闭优先）/ 递归透传 / 全隐藏兜底行 + 无展开按钮 / 有可见字段不出兜底行。
  - `InstructionRunner.presence` 装配测试**同批改写**（R29 时代靠 miss 形态证明「表已接线」，R33 后加工页 miss 不可见）→ 改为两头锁：**初始即命中的指令直接出 `IF(hit)`**（证明表到了字段层）+ **默认未命中完全不出、改 ref 命中才出现、改回又消失**（双向翻转，证明隐藏由同一张表驱动而非写死），并补 LEN 不随隐藏丢字节。
- 归零后的旧断言：R29「未命中 → `[SKIP 0B]` + `opacity-50`」在加工页语境**已失效**，该形态改由 `RunnerFieldTree` **缺省分支**（= Sequences 路径）继续锁住，语义未丢。

#### 五 · 验收

- **BE 963/963（持平，本批零 BE 改动）**、**FE 1323 → 1335/1335（85 文件，+12）**、`npx vite build` EXIT=0、`npm run lint` EXIT=0、yorha-ui 校验器改动 4 文件 **0 违规**、md 表列数 mismatches = 0；
  **零 DDL → 无 `chore(db)`**（`models.py` 未动）、不引 pytest、**无新 pip 依赖**、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰。

#### 六 · 明确留白（本批不做）

- 步骤编辑器不隐藏（拍板②）；不加「已隐藏 N 个」计数角标、不加展开开关（拍板①）；
- 不动判定 / 编码 / 校验任何一码，**零字节变化**；
- 隐藏字段的**编辑入口**由 R29 约束顺延：字段被藏后，改**引用字段**的值即让它重新出现（判定驱动渲染，非写死）；或到步骤编辑器（不隐藏）里改。

**R33 ✅ —— 「未命中」从「降透明提示」改为「纯隐藏」，且仅作用于加工页。**

## 8.66 R34 校验和字节序（R21 成对缺口「另开」· 2026-10-05）

> **一句话**：§8.53（R21 长度域 BE/LE）当时登记的「checksum 的 `byte_order`
> 未立项，需另开」**开出来做完** —— 协议 checksum 卡同样支持小端出线
> （Modbus CRC16「低字节先发」就是这个形态），**复用 length 的同一字段定义、
> 同一闸门、同一字节序门面**，不新建第二套判据。

### 一 · 定位

| 项 | 内容 |
|---|---|
| 来源 | §8.53 尾行 + `blockTypes.js` 代码注释（「校验块 byte_order 不在 R21 范围」）—— 文档与代码**双重登记**的成对缺口 |
| 排期 | 2026-10-05 用户在「校验和字节序 / 前端拆包 / 发前路由」三候选中拍板选此 |
| DDL | **零**（`protocol_api.ProtocolNodeSchema.parameter_config` 是自由 dict）→ 无 `chore(db)` |
| 字节影响 | **缺省路径逐字节不变**（§0）：未配 `byte_order` / `big` / 枚举外一律大端 |

### 二 · 改动表（BE 四处）

| # | 位置 | 要点 |
|---|---|---|
| ① | `backend/handlers/base.py` | **字节序门面上移**：`byte_order_of` + `apply_byte_order` 从 `length.py` 移入 base —— length / checksum **两个 handler 同用一个谓词**（不留第二套判据）；`length.py` re-export，保住既有 `from backend.handlers.length import byte_order_of` |
| ② | `backend/handlers/checksum.py` | **两个 return 同位套用** `apply_byte_order(...)` —— refs 模式与旧区间模式（镜像 R22「算法同位扩」的规矩：换一种引用方式不换出线形态） |
| ③ | `backend/core/frame_builder._with_byte_order` | 闸门 `ntype != "length"` → `ntype not in ("length", "checksum")`；**`_with_encoding` 闸门一行未动**（varint 仍 length 专属） |
| ④ | `backend/core/response_generate._checksum_element` | 原硬编码 `"byte_order": "big"` → **从 `pc` 取**（镜像 §8.53 表第 ④ 项 `_length_element` 同款修法）—— 否则「出线小端、比对规则按大端比」**必然失配** |

**收侧本就支持、本批零改动**：`response_match` 的 `_CHECKSUM_KEYS` 早已含 `byte_order`
（`checksum_value(...).to_bytes(field_bl, cs["byte_order"])`）、`sequence_plan._normalize_checksum`
同 —— R21/R22 期留的口，`test_response_match` / `test_sequence_plan` 既有锚继续有效。

### 三 · 改动表（FE 四处）

| # | 位置 | 要点 |
|---|---|---|
| ⑤ | `config/blockTypes.js` | checksum 卡 `fields` 由 `['length','refs','algo']` 增为 `+ 'byte_order'`，**复用 `BLOCK_PROPERTY_FIELDS.byte_order` 同一定义**（同存点 / 同值域 / 同缺省 `big`）→ `ProtocolPropertiesPanel` **零 JSX 改动**（走既有通用 select 分支） |
| ⑥ | `utils/toFrameBlocks.js withLogicParams` | 闸门放开到 checksum；**`encoding` 另设 `type === 'length'` 二级闸** —— 否则 `pc.encoding='varint'` 会被误写进 checksum 的 params |
| ⑦ | `utils/protocolTree.js` | **两个计算点同用一份反转（改一必改二）**：`collectDeterministicBytes`（容器内容 / 卡面递归）+ `injectRefsSigma`（checksum 卡中央值）；抽出 `isLittleOrder` / `reverseHexPairs` 两个 helper |
| ⑧ | `utils/validateProtocol.js` | W5 `BYTE_ORDER_UNKNOWN` **同码覆盖 checksum**，文案按块型分叉（长度字节序 / 校验字节序）；W6 `ENCODING_UNKNOWN` 仍 length 专属 |

**面板读侧不写值**：`ProtocolPropertiesPanel` 取 `pc[propKey] ?? field.default`（**只读回显**）、
`createBlock` 也不播种 → 存量与新建 checksum 块的 `parameter_config` **形状不变**，
只有用户真把下拉改到 `little` 才出现该键。

### 四 · 共享向量（真值链不自证）

`vectors/checksum_order.json` —— **12 行 = 6 算法 × 2 字节序**，两端同读
（`backend/tests/test_checksum_byte_order.py` ↔ `protocolTree.test.js`，与 `vectorsLoader`
表清单同批登记）。

- `expected_big` **逐字取自 R22 `vectors/checksum_algo.json`**（zlib / binascii /
  已发布 check 值 —— 本批**不重新验证算法**，只锁字节序）；
- `expected_little` = 同串**字节反转**（little 的定义，与 R21 `length_order.json` 同一套）；
- 输入统一取标准 check 输入 `"123456789"`；其中 SUM_8 / XOR_8 / LRC 是 **1 字节**
  → 反转后与大端相同，正好把「单字节不反转」钉进表里。

### 五 · 测试（红测先行有据）

- **红测证据（实现落笔前）**：BE 新增 `test_checksum_byte_order.py` → **11 failed / 14 tests**
  （big 行全绿、little 行全红 → 红因全部由缺失特性引起）；FE 四文件新增 → **9 failed / 108 passed**。
- 新增 **BE 14 例 + FE 14 例**：向量逐行（refs 模式）/ 区间模式与 refs 同字节序 / fail-open 四支
  （缺省·big·枚举外·大小写）/ `_build_logic_config` 写键与不写键 / 无 refs 直通路径 /
  比对规则声明跟随 / 卡面与容器内容**两个计算点**同口径 / W5 覆盖 / 卡字段 SSOT 单份锁。
- **三处既有测试同批翻面**（R21 当年的「checksum 不吃此键」断言随语义失效）：

  | 文件 | 原断言 | 翻面后 |
  |---|---|---|
  | `backend/tests/test_length_byte_order.py` | `test_checksum_blocks_ignore_byte_order` | `test_checksum_blocks_honour_byte_order`（写键 + 缺省仍不写 + length 不受牵连） |
  | `frontend/src/utils/__tests__/toFrameBlocks.test.js` | 「非 length 块不写 byte_order」 | 「闸门只开两卡 —— 第三类块型仍不吃」（fixed / slot / cobs 仍 `null`） |
  | `frontend/src/config/__tests__/blockTypes.test.js` | 「checksum 不列 byte_order」 | 「checksum 列 byte_order（R21 范围拍板已由 §8.66 收掉）」 |

### 六 · 验收

- **BE 963 → 977/977**、**FE 1335 → 1349/1349（85 文件，+14）**；
- `npx vite build` EXIT=0 · `npm run lint` EXIT=0 · yorha-ui 校验器改动 10 文件 **0 违规** ·
  md 表列数 mismatches = 0；
- **零 DDL → 无 `chore(db)`**、不引 pytest、**无新 pip 依赖**、
  `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、`/dispatch` 缺省口径不变。

### 七 · 明确留白（本批不做）

- `cobs` / `slot` / `bitfield` 无字节序概念，不加字段；
- 指令域字段的 `endianness`（E1-2 B6）是**另一个域**，不并入本批；
- **不引入 trim 归一**：谓词形态沿用 R21（`String(pc.byte_order || '').toLowerCase() === 'little'`），
  避免本批顺带改动既有字节行为 —— BE `byte_order_of` 的 `.strip()` 仍只是防御
  （UI 下拉产不出带空白的值），两端在可达输入上本就同判
  —— **已由 R42 收掉 ✅（2026-10-07，§8.74：新增 `utils/byteOrder.js` 单点判据）**；
- 收侧 `response_match` / `sequence_plan` 零改动（本就支持）。

**R34 ✅ —— §8.53「checksum 的 `byte_order` 未立项，需另开」的账已还清。**

## 8.67 R35 前端路由级拆包（752kB 单 chunk 收口 · 2026-10-05）

> **一句话**：8 个页面在 `App.jsx` 里全是静态 import，`vite build` 把它们连同首屏
> 外壳揉成一个 **752.85kB** 的 `index.js`（每次都越 500kB 警告线），而用户一次只开
> 一页 —— 改成按路由动态载入 + 侧栏悬停预取，首屏降到 **325.42kB**，警告消失。

### 一 · 定位

| 项 | 内容 |
|---|---|
| 来源 | **无既有登记项**：`vite build` 每批输出的「chunk larger than 500 kB」警告本身就是债，凭据即 build 输出 |
| 排期 | 2026-10-05 用户在「路由级拆包 / 只分 vendor / 发前路由 / 拆包+trim 连做」四选项中拍板选**路由级拆包** |
| DDL | **零** → 无 `chore(db)` |
| 字节影响 | **零**（纯前端构建层，**BE 一行未改**，`/dispatch` 缺省口径不变） |
| 本批性质 | 构建 / 装配层重构，**不给任何一页新增能力** → `pageStatus.json` 零改动（见「五」） |

### 二 · 体量账（两次 `npx vite build` 实测）

| 指标 | 改前（HEAD `15b197f`） | 改后 |
|---|---|---|
| `assets/index-*.js` | 752.85 kB（gzip 243.50 kB） | **325.42 kB（gzip 113.64 kB）** |
| 500 kB 体积警告 | 每次 build 触发 | **消失** |
| 页面 chunk | 0（8 页全在首屏） | **8 个，10.43 – 56.63 kB** |

页面 chunk 明细（kB）：`Trash 10.43` · `DataHub 23.19` · `Protocol 27.06` ·
`InstructionProcessor 30.56` · `Orchestration 33.62` · `Sequences 34.01` ·
`Terminal 36.26` · `Instruction 56.63` —— 合计约 252 kB 不再进首屏。

### 三 · 改动表（FE 四处）

| # | 位置 | 要点 |
|---|---|---|
| ① | `frontend/src/utils/routeChunks.js`（新） | **页面模块单一登记表** `ROUTE_LOADERS`（R35 落笔 8 个动态 import，与 `PAGE_REGISTRY` 同集；R38 加路由规则页起 9 个）+ `routeComponent(pageKey)` 返回**缓存过的** `React.lazy` 实例（不缓存则每次渲染新建组件 → 整页重挂载）+ `prefetchRoute` 复用同一份 pending Promise（**幂等**：hover 多少次只发一次；失败 `.catch(→null)` 不打断导航）+ `__resetRouteCaches` 仅供测试隔离模块级缓存 |
| ② | `frontend/src/components/RouteLoading.jsx`（新） | Suspense fallback：`[ MODULE LOAD ]` 工业标记 + 按 `useLocation` 查 `PAGE_STATUS_BY_PATH` 出中文页名（**未知路由回落站点名，不臆造页面名**）+ `role="status"` / `aria-live="polite"`；**只陈述事实不断言进度** —— 拆包加载没有可度量的进度，画假百分比等于编造数字，8 段待机格只表达「等待中」 |
| ③ | `frontend/src/App.jsx` · 渲染 | **删 8 行静态 `import ... from './pages/…'`** → `renderRouteElement` 先 `routeComponent(pageKey)` 取组件再按页分支**原样注入各页 props**（prop 契约一行未动），未知 key 仍 `<Navigate to="/protocol" replace />` |
| ④ | `frontend/src/App.jsx` · 悬停预取 | `NavItem` 增 `pageKey`，`onMouseEnter` / `onFocus` 触发 `prefetchRoute` —— 键盘 Tab 与鼠标 hover 同待遇；**`<Suspense>` 边界放在 `key={location.pathname}` 之外**，换路由时边界自身不重建，已访问过的页面切回来不重闪 fallback |

**`manualChunks` 为什么不做（三候选里的 B′ 判负）**：依赖极轻 —— `react` / `react-dom` /
`react-router-dom` / `@dnd-kit/*` / `clsx` / `tailwind-merge` / `uuid`，无 lodash、无图表库、
无大三方件；vendor 分出去只能砍约 200 kB，而**本项目自己的代码就 >500 kB**，警告照报。
只有路由级 lazy 才把首屏真正切开。

### 四 · 红测先行有据

新增两份测试，**实现落笔前先证红**：

- `frontend/src/utils/__tests__/routeChunks.test.js`（9 例）
- `frontend/src/components/__tests__/RouteLoading.test.jsx`（4 例）

| 轮次 | 结果 | 红因归属 |
|---|---|---|
| 实现前 | 2 个测试文件**整体失败**（`Failed to resolve import "../routeChunks"` / `"../RouteLoading"`） | **缺特性本身**（模块不存在）→ 合格红 |
| 落实现后 | 1 failed：`expected 'object' to be 'function'` | **测试自身 bug** —— React 19 的 `React.lazy` 返回 lazy 组件对象而非函数；按纪律**先修测试**（改断言 `$$typeof === Symbol.for('react.lazy')`）再算数 |
| 修测试后 | **13 / 13 全绿** | 红→绿闭合 |

钉住的四条语义：

1. **`PAGE_REGISTRY` 每页各有一个、且只有一个载入器**（无缺无多）—— 拆包前提，
   将来加页忘登记会红（R35 落笔时为 8 页，R38 加「发前路由规则」页起为 9 页，
   断言按 registry 派生自动跟随，无需改数）；
2. **同页重复取用返回同一引用**（lazy 不缓存 → 整页重挂载）；
3. **prefetch 幂等**（计数桩验证 N 次 hover 只 1 次载入）+ **失败吞异常不打断导航**；
4. fallback **只按 `PAGE_STATUS_BY_PATH` 报页名**，未知路由回落站点名。

### 五 · `pageStatus.json` 为何零改动

`pageStatus.json` 按页登记「**本页**具备哪些能力」（`availableNow`）与「本页下一步」
（`nextSteps`），并生成 `docs/PAGE_STATUS.md`。R35 是**应用外壳 / 构建层**改动
（首屏变小、切页多一个 loading 态），**不给任何一页新增能力** —— 塞进任一页的
`availableNow` 都是张冠李戴。故本批 json 与生成物 `docs/PAGE_STATUS.md` **双双不动**，
记账改走 §1 表 + 本节 + HANDOVER 条目 84（与 `chore(db)` 批次同类：
无页面能力变化即不登记）。

### 六 · 验收

- **BE 977/977（持平，本批零后端改动）**、**FE 1349 → 1362/1362（87 文件，+13）**；
- `npx vite build` EXIT=0（**无 chunk 体积警告**）· `npm run lint` EXIT=0 ·
  yorha-ui 校验器改动 5 文件 **0 违规** · md 表列数 mismatches = 0 · index blob 卫生
  STAGED / BAD = 0；
- **零 DDL → 无 `chore(db)`**、不引 pytest、**无新 pip 依赖**、
  `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、`/dispatch` 缺省口径不变。

### 七 · 明确留白（本批不做）

- **不做 `manualChunks` 分 vendor**（理由见「三」，判负）；
- **不做路由预渲染 / SSR**：内网单页应用，无 SEO 诉求，引入渲染层得不偿失；
- **发前路由**（`BUSINESS_SCENARIOS` G1 尾注；§8.52 C-1 拍板 A 不立项，翻案需用户确认），
  本批不涉 —— **→ 2026-10-06 用户翻案已立项，见 §8.68**；
- **`byte_order` trim 归一**（§8.66 留白）本批不涉 ——
  **→ R42 已落地 ✅（2026-10-07，§8.74）**。

**R35 ✅ —— 每页只加载自己那块，首屏 752kB → 325kB。**

> **2026-10-07 注（过期悬账就地销掉）**：本批**从未登记过人工验证点** —— 构建 / 装配层改动，
> 红测 13/13 与两次 `npx vite build` 的体量账已覆盖；§1 `R35` 行、本节 §8.67 全文、
> `PROJECT_HANDOVER.md` 条目 84、`pageStatus.json` 四处复核**皆无待验项**。会话笔记里曾带过
> 一条「R35 人工验证点待用户回报」，**查无出处**，就地销账 —— 不把查不到来源的悬账记在用户头上。

## 8.68 R36 发前路由 · BE 数据层（新表 + 匹配器 + 解析端点）

**批次**：2026-10-06 · **纯 BE · 仅新增表（合 §0）→ 零 Migration、无 `chore(db)`、
`/dispatch` 缺省口径逐字节不变** —— §8.52 复议时被**明确划在本列外**的 C-1 选项 C，
用户翻案重启。

### 一 · 立项由来（原拍板 A 不立项 → 2026-10-06 翻案）

§8.36 C-1 立了三个选项：**A** 不立项 / **B** 序列级分支 / **C** 发前路由。
§8.52 复议**只立项了 B**（编入 R26），拍板表里并明写「C 发前路由**仍不在本列**，要做
另议」。本批即那次「另议」：用户对 A 不立项**翻案**，按**原选项 C** 规格立项。原承诺「2–3 批」，
实分 **4 批** —— 拆分点在 §8.68 八 的留白自然分界；其中 R38 又经 2026-10-06 用户拍板
（question 工具回执）**再拆两批**：先独立管理页、后加工页接线。

- **R36（本批）**：新表 + 匹配器 + CRUD + `POST /dispatch/routed` 解析；
- **R37**：引用计数与级联集成 + 回收站中文名（**✅ §8.69**）—— 先把「删指令会留下
  悬空规则」这个数据完整性洞补上，**再**让 UI 能造出命中它的数据；
- **R38**：规则编辑 UI = 独立「发前路由规则」页，规则的增删改查 + 排序草稿 + 启停
  （**✅ §8.70**，纯 FE 零 DDL）；
- **R39**：加工页自动选指令接线（真正「换指令」的动作，**✅ §8.71**，纯 FE 零 DDL）。

**例 B（只有 C 解得了）**：同一个「执行」按钮，输入 `meter_id = 0001` 该发指令 X、
`= 0002` 该发指令 Y —— 这发生在**进入序列之前**；R26 的序列分支只在「已选定的指令链
内部」跳转，**结构上解不了**。

### 二 · 新表 `routing_rules`（§0 论证）

| 列 | 类型 | 语义 |
|---|---|---|
| `id` | VARCHAR(36) PK | uuid4 |
| `name` | VARCHAR(128) UNIQUE | 规则名；软删行**继续占用**（§8.43 已知取舍） |
| `condition` | VARCHAR(200) | 受限表达式，SSOT = `core/condition.py` |
| `instruction_id` | VARCHAR(36) | **逻辑外键** → `instructions.id`（同 `op_code` 先例，不加 FK） |
| `sort_order` | INTEGER 默认 0 | 匹配优先级，升序小者先判 |
| `enabled` | INTEGER 默认 1 | 0 = 暂时踢出匹配，行保留 |
| `description` | TEXT | 备注 |
| `created_at` / `updated_at` | TEXT | ISO-8601 UTC（镜像 `frame_recipes`） |
| `deleted_at` | VARCHAR(40) | NULL = 活行，非 NULL = 回收站（R6 口径） |

- **合 §0**：新表属「**仅新增表**」明文允许；`models.py` 没有任何改列 / 删列。
- **零 Migration**：`main.py` 的 `Base.metadata.create_all` **对既有库也会建新表**
  （它补不了列，但建得了表），REGISTRY 五条全是加列 → 本批**不动 `migrate.py` 的
  REGISTRY**。历史上的新表批（E4 / P1 / P2 / P3 / P5）都有 `chore(db): 同步 yorha.db`
  跟进，但现行节奏明令**排除 `backend/db/yorha.db`** → 本批**单笔 feat、无 `chore(db)`**
  （库由启动时 `create_all` 自建，无物可落盘）。
- **不加 FK 的理由**：软删 / 恢复语义会被外键绑死；悬空目标改由**查询侧拦**
  （目标指令入回收站即不作候选，见 §四）。

### 三 · 匹配口径（五条，`backend/core/routing.py`）

**复用 `core/condition.py`，不造第二套判据** —— 一条规则 = 一次比较，与
`sequence_steps.condition` 同一门语言、同一份 SSOT，FE `utils/condition.js` 逐行同语义、
共享向量 `vectors/condition.json` 58 行。本模块**不碰** `condition.py`，只在上面套一层
「挑哪条」。

| # | 口径 | 为什么 |
|---|---|---|
| 1 | 定序 = `(sort_order 升序, name 升序, id 升序)` | 总序确定，不依赖插入顺序与数据库返回顺序 |
| 2 | **first-match-wins**，判真即止 | 一条规则一票，不叠权重、不做打分 |
| 3 | `enabled=0` 与 `deleted_at` 非 NULL **不参与** | 白做两层防御：查询侧已滤，匹配器再滤一次 |
| 4 | 条件**语法**坏掉 → 记 `invalid` 并**继续往下扫** | 保存侧已 400，运行期踩到只可能来自改库；一条坏规则既不该让整条路由 500，更不该让它误命中 |
| 5 | 变量不在输入里 / 类型不可比 → **普通不命中，不记 `invalid`** | 输入侧不满足是正常结果，不是规则缺陷 |

**第 4、5 条怎么分开**：两者抛的同为 `ConditionError`，所以先单独 `parse_condition`
过一遍 —— **解析期**挂 = 规则坏了（记 `invalid`），**求值期**挂 = 这次输入没给它要的键
（静默跳过）。`v == 1 == 2` 与 `nope == 1` 各占一类，两条都有既有测试钉住。

**全无命中 → `matched=false`，绝不回落到第一条**（不猜）。

### 四 · 端点 `POST /dispatch/routed`（新增，只解析不发送）

- **§0**：`/dispatch/`（`dispatch_frame`）与 `/dispatch/transaction` **一行不改**；
  发前路由是**独立端点**，缺省口径逐字节不变。
- **回执六键**：`matched` / `rule` / `instruction_id` / `instruction` / `invalid` /
  `considered` —— **没有** `status`·`attempts`·`hex_string`（那三个是 `DispatchRecord`
  的字段，出现即说明串进了缺省口径；有测试逐键断言）。命中顺带回**指令全文**，
  FE 省一次 `/instructions` 往返。
- **只读**：不写库、不碰 transport、不记 dispatch 日志。
- **两层静态跳过**（都记进 `invalid`，不 500、也不误命中别的规则）：目标指令已入
  回收站 / 不存在（`INSTRUCTION_MISSING`）、条件语法坏掉。
- **CRUD `/routing-rules`**：`GET` 列表（`alive()` + 同一套定序键，**列表顺序 = 匹配
  顺序**）、`POST` 建、`GET`/`PUT`/`DELETE` 单条。三条校验 —— `parse_condition` 语法
  → 400、目标必须是**活**指令 → 404、判重查**全表**（不排回收站，否则软删行的唯一键
  会漏到 DB 报 500）→ 400；`PUT` **先校验再落笔**，任一不合法整单中止。
- **回收站白名单补 `routing_rule`**：没有这条，`DELETE` 打的软删标记就是**永久黑洞**
  —— 读侧 `alive()` 滤掉、回收站又不认识它，行从此不可见也不可恢复。

### 五 · 意外发现并修好：`migrate.py` 三条 verify 的范围钉（**真故障，不是测试写死**）

新表落笔后 BE 全量 **16 errors + 3 failures**，查下去是**会让每个库都起不来**的真故障：

- `_soft_delete_verify`（0002）钉 `len(带 deleted_at 的表) == 13`；
- `_profile_sort_verify`（0004）钉 `== ["device_profiles"]`；
- `_condition_verify`（0005）钉 `== ["sequence_steps"]`。

三者都是「**从 `Base.metadata` 全量派生 + 精确集合断言**」。`routing_rules` 天生带
`deleted_at` / `sort_order` / `condition` 三列 → 三条同时红 → `run_pending_migrations`
**整条回滚并抛 `MigrationError`** → `main.py` 启动序列直接失败。

**改口径为「冻结史实名单 ∩ models」**（`_scope_tables`，0002–0005 四条共用）：

- **冻结名单** = 这条历史迁移当时动过哪些表（史实，不随 schema 演进而改）。
  新表由 `create_all` 整表建出，**轮不到这条 ALTER** 去补列；
- **∩ models** = 防漏卡：名单里哪张表在 models 里被误删了该列，交集立刻缩水 →
  `len != 13` 照样报错，不会变成「apply 跳过 + verify 走过场」。

于是**两个防漏方向都还在**（少一张报错、DB 缺列报错），只是不再因为「多了一张新表」
而误伤 —— 那本来就不归某条历史 ALTER 管。`tests/test_soft_delete.py` 的
`EXPECTED_13_TABLES` 与 `migrate.R6_TABLES` **各自手写一份、互为交叉校验**（两边不等
会当场红）；**针对这条口径的既有断言 0 条需要改** —— `test_migrate` 三处
`assertEqual(xxx_tables(), [原表])`、`test_soft_delete` 的 `13` 计数与
`EXPECTED_13_TABLES` 全部**原样通过**，说明这次改的是口径本身，不是在挪球门。

> 同批**另一条**既有钉确实翻面了，但与迁移口径无关：`TrashScopeTest` 的
> 「白名单恰好 7 类」因 R36 正当新增 `routing_rule` 变成 8 类。改写时把它**真实意图**
> （日志 / 模板 / 单行配置**始终不进站**）补成显式 `assertNotIn` —— 原来只比集合，
> 反而看不出「为什么是这 7 个」。归入红测先行表的「测试自身需随新事实改写」一档。

> 这也解释了为什么本批**必须**碰 `migrate.py`（原计划「不动 migrate.py」只说对了
> REGISTRY / 迁移条目那一半）。

### 六 · 红测先行有据

新增 `backend/tests/test_routing.py`，**实现落笔前先证红**：

| 轮次 | 结果 | 红因归属 |
|---|---|---|
| 实现前 | 1 个测试文件**整体失败**（`ModuleNotFoundError: No module named 'backend.core.routing'`） | **缺特性本身** → 合格红 |
| 落实现后 | 1 failed：恢复后重建同名命中 400 | **测试自身 bug** —— 恢复后原行仍在、本就该占名（§8.43），按纪律**先修测试**再算数 |
| 修测试后 | **22 / 22 全绿** | 红→绿闭合 |
| 全量回归 | 另 1 failed：`TrashScopeTest`「白名单恰好 7 类」实得 8 类 | **测试需随新事实改写**（R36 正当新增 `routing_rule`），改写时补显式 `assertNotIn` 强化原意；与上面两档**性质不同**，不属「缺特性」也不属「测试写错」 |

钉住的语义：定序与 first-match-wins · 停用 / 回收站不参与 · 坏条件记 `invalid` 且
**不中断扫描** · 未定义变量**不记 `invalid`** · 无命中**不猜** · CRUD 四种拒绝 +
**校验失败不留半改状态** · 目标指令入站 → 跳过不 500 · 解析回执**无 `DispatchRecord`
三键** · 回收站落地与恢复、软删占名、彻底删除释放键。

### 七 · 验收

- **BE 977 → 999/999**（新增 `test_routing` 22 例）、**FE 1362/1362（持平，纯 BE 批）**；
- `npx vite build` EXIT=0 · `npm run lint` EXIT=0 · yorha-ui 校验器 0 违规 ·
  md 表列数 mismatches = 0 · index blob 卫生 STAGED / BAD = 0；
- **仅新增表 → 零 Migration、无 `chore(db)`**、不引 pytest、**无新 pip 依赖**、
  `processor.py` / `graph.py` / `Blueprint.jsx` 未碰；
- **实机**：`openapi.json` 上 `/dispatch/routed` 与 `/routing-rules` 五方法齐备、
  `/dispatch/` 与 `/dispatch/transaction` 原样；建规则 → 命中回指令全文 → 不命中
  `matched=false` → 空输入 `considered=1`·`invalid=0`（未定义变量不记缺陷）→
  删除后回收站可见。

### 八 · 明确留白（本批不做 → R37 ✅ / R38 ✅ / R39 ✅）

- **指令删除的引用计数与级联**（`get_instruction_references` 加 `routing_rules` 键 +
  `delete_instruction` 的 `mark_related`）与 **回收站 FE 中文名** →
  **R37 已落地 ✅（§8.69）**，本节留白**已销两条**；
- **规则编辑 UI**（FE）—— R36 纯 BE，页面上看不到也建不了规则 →
  **R38 已落地 ✅（§8.70）**，**本节留白已销第三条**；
- **加工页自动选指令接线**（FE）—— 真正「换指令」的动作 →
  **R39 已落地 ✅（§8.71）**，**本节留白已销第四条**；
- **`byte_order` trim 归一**（§8.66 留白）本批不涉 ——
  **→ R42 已落地 ✅（2026-10-07，§8.74）**。

**R36 ✅ —— 「该发哪条指令」有了数据层答案，`/dispatch` 缺省口径一个字节没动。**

## 8.69 R37 发前路由 · 集成收尾（引用计数 + 同戳级联 + 回收站）

**批次**：2026-10-06 · **BE 小改 + FE 文案，零 DDL → 无 `chore(db)`、无 Migration**
—— R36 §8.68 八 挂的两条留白一次销完。

### 一 · 为什么先做这个，而不是直接做 UI

R36 的留白里有三件事，性质完全不同：

| 项 | 不做的后果 | 拆批 |
|---|---|---|
| 引用计数 + 级联 | 删指令 → 规则变**悬空行**（解析时 `INSTRUCTION_MISSING` 跳过），用户**从头到尾不知道自己删掉了什么** | **本批（R37）** |
| 规则编辑 UI | 页面上看不到也建不了规则 | **R38 ✅（§8.70）** |
| 加工页接线 | 「换指令」的动作没落地 | **R39 ✅（§8.71）** |

前一件是**数据完整性**，后两件是**可见性**。顺序反了的代价是：UI 先上线，用户在 UI 里
造出成批规则，然后一个不留神删掉目标指令 —— 一次性产出成批悬空规则，而 UI 当时**没有
任何一处**会提示。先把洞补上，再开闸。

**后两件又经 2026-10-06 用户拍板再拆一次**（question 工具回执）：R38 只做**管理面**、
R39 才做**接线** —— 理由是两者的验收面不同：CRUD 的红测全落在文案与请求形状上，纯 FE
能自动验收；而接线真正改变「执行」行为，要实机冒烟才算数。先给规则一个家，再让它被用。

### 二 · 三分口径归类：`routing_rules` 是「活配置」

D14② 把四张表按数据性质分三类（活配置级联 / 冻结快照留失效 / 日志只读留）。新表落位：

- **`routing_rules` = 活配置** —— 用户手写、指向某条指令的配置，与 `protocol_bindings`
  / `response_specs` 同档。目标入站时**同戳**级联，恢复时一并捞回。

三处改动，缺一环就断：

| # | 位置 | 改动 | 漏了会怎样 |
|---|---|---|---|
| ① | `instruction.get_instruction_references` | 加 `routing_rules`（**只数活行**）并计入 `total` | 弹窗不提规则 = **对用户隐瞒一次删改** |
| ② | `instruction.delete_instruction` | `mark_related(RoutingRule, instruction_id, ts)` + 回执 `deleted_routing_rules` | 规则留在站外成悬空行 |
| ③ | `trash.py` 的 `instruction` `children` | 补 `("routing_rules", RoutingRule, instruction_id)` | 同戳级联**白做** —— 恢复了宿主，规则还留在站外 |

③ 是最隐蔽的一处：②只管**进去**，③才管**回来**。写测试时正是它单独红了一轮，
`KeyError` 和断言双红之后才暴露。

### 三 · 刻意的例外：`routing_rule` 在回收站**不隐藏**

`trash.py` 有一条通用规则 —— **「宿主在回收站就连带子行一起隐藏」**（判据 = 子行的宿主
也在站里），理由是「恢复父行会一并回来，它们不该单独占一行」。这条对 `routing_rule`
**不成立**：

> 判据是**时间戳的代理**。规则先独立删除（戳 `t1`）、指令随后入站（戳 `t2`）时，它被判
> 「宿主在站」而**隐藏**；但恢复指令按**同戳 `t2`** 捞子行 —— 捞不回 `t1` 的它。于是它
> 既不在列表里、也没被恢复，**从此再也看不见**。

这正是 R36 给 `routing_rule` 立白名单时点名要防的「永久黑洞」，只是换了个入口进来。
`routing_rules` 因此**始终自己占一行**：代价是宿主连带入站时列表多几行，
换来**任何一行都够得着**（可恢复、可彻底删除）。`binding` / `response_spec` 沿用原判据不动
——— 它们的既有行为由 `test_standalone_child_keeps_its_own_entry_across_parent_restore`
钉着，本批不顺手改别人的口径。

### 四 · FE 文案与页签（`useInstructionData.js` + `Trash.jsx`）

- `describeReferences` 新增一行 `· 发前路由规则 N 条 → 随删入站（活配置，随指令恢复）`，
  **排在应答规格之后、序列步骤之前** —— 三类活配置连着排，读者一眼看出同档；
  无引用句补一词（`绑定 / 应答规格 / 发前路由规则 / 序列步骤 / 通讯日志`）；
- `describeDeletion` 新增 `发前路由规则 N 条级联`，沿用 **R18「只报非零那一段」**口径 ——
  零不占位、不写「0 条」；
- `Trash.jsx` 的 `KIND_LABELS` 加 `routing_rule: 路由规则`；`KIND_ORDER = Object.keys(
  KIND_LABELS)` **自动跟上**，筛选 chip 不用另配；`relatedText` 通用求和，恢复回执多了
  `routing_rules` 键也自动并入「级联 N 条」。
- 模块注释与 `KIND_LABELS` 上方说明同步改写（7 类 → 8 类 + 例外说明）。

### 五 · `pageStatus.json` 两处陈述已陈旧（改后跑 `sync:page-status`）

| 位置 | 改前 | 为什么必须改 |
|---|---|---|
| 指令页 · 删除前引用计数 | 「四表计数」/「活配置（协议绑定 / 应答规格）」 | 计数与清单都是**当前事实**，加了第五表就是错了 |
| 回收站页 · 软删除 | 「7 类对象」 | 同上，现为 8 类 |
| 回收站页 · summary / 统一入口 | 未列「路由规则」；隐藏规则未说例外 | 页面用途与已知取舍必须如实 |

改完在 `frontend/` 跑 `npm run sync:page-status` 再校 `docs/PAGE_STATUS.md`。

### 六 · 红测先行有据

| 轮次 | 结果 | 红因归属 |
|---|---|---|
| 实现前（BE） | 4 errors + 1 failure：`KeyError: 'routing_rules'`、`list_rules` 里规则仍在列 | **缺特性本身**（计数键 + 级联都没做）→ 合格红 |
| 实现前（FE） | 3 failed：文案不含「发前路由规则」 | **缺特性本身** → 合格红 |
| 落实现后 | BE 仍剩 1 failed：恢复后 `['rr-2'] != ['rr-1','rr-2']` | **缺特性本身** —— `trash.py` 的 `children` 没接（§二 ③），同档红因 |
| 全量回归 | 3 failed：`res.related` 多出 `routing_rules: 0` 键 | **测试随新事实改写**（回执从两键变三键），补键不补语义 |

钉住的语义：计数**只数活行** · 级联**同戳**且恢复**一起回来** · 独立入站的规则
**不被宿主吞掉也不被隐藏** · 引用弹窗与删除回执**非零才报**。

### 七 · 验收

- **BE 999 → 1002/1002**（`test_instruction_delete` 9 例）、**FE 1362 → 1365/1365（+3）**；
- `npx vite build` EXIT=0 · `npm run lint` EXIT=0 · yorha-ui 校验器 **4 个改动文件
  （3 js/jsx + `pageStatus.json`）0 违规** · md 表列数 mismatches = 0；
- **零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、无新 pip 依赖、
  `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径未动**。

### 八 · 留白（→ R38 ✅ / R39 ✅）

- **规则编辑 UI**（规则的增删改查页面）→ **R38 已落地 ✅（§8.70）**；
- **加工页自动选指令接线**（真正「换指令」的动作）→ **R39 已落地 ✅（§8.71）**；
- **`byte_order` trim 归一**（§8.66 留白）不涉 —— **→ R42 已落地 ✅（2026-10-07，§8.74）**。

**R37 ✅ —— 删指令不再留下没人知道的悬空规则，恢复也一并回来。**

## 8.70 R38 发前路由 · 管理面（独立规则页 · CRUD + 排序草稿 + 启停）（2026-10-06）

R36 给了「该发哪条指令」的数据层答案，R37 补齐了删改时的数据完整性；R38 把规则第一次
**摆到页面上**。**零 DDL、零 BE 改动** —— `backend/` 一个字节没碰（`models.py` 无改列改表，
无 Migration、无 `chore(db)`）。

### 一 · 落点与拆批：两问两答（question 工具回执，2026-10-06）

| 问 | 拍板 | 论据 |
|---|---|---|
| 规则编辑 UI 放哪 | **新建独立「发前路由规则」页**（`/routing`，第 9 页，快捷键 `H`） | 规则是**独立实体**而非某条指令的附属：要跨规则调 `sort_order`（first-match-wins 的语义全在顺序上）、要条件编辑与启停批量操作，塞进指令页或加工页都装不下；后端 `/routing-rules` 本就是独立 CRUD。代价只是侧栏多一项 |
| 一批做完还是拆两批 | **拆两批：先 CRUD（R38）后接线（R39）** —— **两批均已落地：R38 ✅（§8.70）/ R39 ✅（§8.71）** | 两件事的验收面不同 —— CRUD 的红测全落在**文案与请求形状**上，纯 FE 可全自动验收；接线真正改变「执行」行为，须实机冒烟才算数。避免中间态「能建规则但没人用它」被掩在同一批里 |

（**否掉的两个**：挂指令页 → 一条规则只能在它的目标指令下改到，跨指令比较优先级要来回
切换；挂加工页 → 该页以运行 / 下发为主，把结构编辑混进去会加重本已很重的一屏。）

### 二 · 页面四件事（`frontend/src/pages/RoutingRules.jsx`）

1. **列表顺序 = 匹配顺序。** 后端按 `(sort_order, name, id)` 定序，FE **照单渲染不重排**。
   first-match-wins 之下「看得见的顺序」就是「谁先判真」，不能让它有第二种解释 —— 所以
   排序保存一律**稠密重编 0..N-1**（`renumber`）：`sort_order` 一旦全体互不相同，`(name, id)`
   兜底就永不生效，不存在「看起来一样、其实按名字排」的暗坑。
2. **表单就地校验，不送后端吃 400。** `utils/routingView.validateRuleDraft` 分三块拦：
   名称空 / 超长（`MAX_RULE_NAME = 128`，与 `RoutingRuleCreate.max_length` 同一个数）/ 撞名；
   条件空 / 语法坏 —— **一律委托 `utils/condition.checkCondition`**，与序列步骤编辑器、
   BE `core/condition.py` 同一份 SSOT，错误文案逐字同源，**不另造一套**；目标指令未选。
   多错并存逐字段都报，不只报第一个。拦不到的只剩两类，交给后端 400 + `describeRoutingSaveError`
   兜底：**回收站里占名的软删行**（FE 的 `liveNames` 只有活行，后端判重查全表）与
   **目标指令在提交与落笔之间刚被删**（404 `Instruction not found`）。
3. **启停 / 删除逐行走行级端点。** ON/OFF chip → `PUT` 翻 `enabled`（停用 = 后端 `select_rule`
   静态跳过，不删行、随时开回）；删除须过 `NieRModal` 二次确认 → `DELETE` 软删进回收站
   （`kind = routing_rule`，可恢复；R37 起目标指令入站时同戳级联、恢复指令会一并捞回）。
4. **排序只改草稿，点保存才落库。** 上移 / 下移调 `moveRule` **零请求**，底部出
   「● N 条顺序待保存」（N = `changedSortOrder` 的行数 —— 两行换位时**两行**的
   `sort_order` 都变，N = 2 而不是「挪了几行」）；点「保存顺序 SAVE ORDER」才按草稿
   **只 PUT `sort_order` 真变化的行**（后端无批量排序端点，逐行提交，少发一行是一行），
   「放弃 REVERT」零调用重拉回 baseline。

### 三 · 四处接缝（加一页要动的地方全在这里）

| 接缝 | 改动 | 谁钉住它 |
|---|---|---|
| `frontend/src/api/routing.js`（新） | `/routing-rules` 五方法（`list` / `get` / `create` / `update` / `delete`），PUT 是**整体替换**、恒为完整六字段 | `api/__tests__/routing.test.js`（URL / method / JSON 体 / detail 透出） |
| `frontend/src/config/pageStatus.json` 第 9 条 | `key=path=shortcut=H` 等 10 字段；数组序即侧栏序（插在「回收站」之前）+ `npm run sync:page-status` | `pageRegistry.test.js` 新增的四断言 + R35 就有的「键 / 路径 / 快捷键各自唯一」 |
| `frontend/src/utils/routeChunks.js` | `routing: () => import('../pages/RoutingRules')` | R35 挂的 `ROUTE_KEYS == registry keys` 同集断言（忘登记即红） |
| `frontend/src/App.jsx` | `case 'routing': return <Page instructions={instructions} />`（只吃指令列表供目标指令下拉，不写共享状态） | **无自动化测试** —— 漏写即静默回落 `/protocol`，**本批实机冒烟已验（见五）** |

`utils/routingView.js`（新）是页面的纯逻辑层，四个函数各有专测 —— 抽纯函数即为钉口径。

### 四 · 红测先行有据（4 文件 → 两档记账）

| 档 | 内容 |
|---|---|
| **缺特性（红）** | `api/__tests__/routing.test.js`、`utils/__tests__/routingView.test.js`、`pages/__tests__/RoutingRules.test.jsx` 三个新文件全红，红因 = `Failed to resolve import "../routing"`（等模块不存在）；`pageRegistry.test.js` 新增断言红因 = `expected undefined to be '/routing'`。**四者全部 = 缺特性本身** |
| **测试自身 bug（先修再算数）** | `renderPage` 辅助写死 `await findByText('meter 0001')` —— 空态列表里根本没有该行 → 改等**恒存在的表头计数**（`发前路由规则 (ROUTING RULES) · N 条`）。改后 11/11 绿 |
| **落笔自查改正（不计红）** | 顺序脏计数初稿断言写 `1 条顺序待保存`，两行换位实为**两行**都要写 → 断言改 `2`。该断言在红跑里因模块不存在从未执行到，属落实现前的自查改正，不进红账 |

**红 → 绿闭合**：4 文件全红 → 落实现 → 全绿；再跑全量回归确认零回退。

### 五 · 验收（2026-10-06）

- **FE 全量 1365 → 1405/1405（+40 = 7 api + 21 routingView + 11 页面 + 1 注册表）**；
- **BE 全量 1002/1002**（本批零 BE 改动，复跑确认零回退）；
- `npx vite build` 0 · `npm run lint` 0 · yorha-ui 校验器 **11 个改动文件 0 违规** ·
  `ev40_md_all.py` mismatches = 0；
- 产物 **9 个页面 chunk**（`RoutingRules-DGiWm4jJ.js` 15.67 kB），首屏 `index` 仍无
  >500kB 警告（R35 的拆包前提未被破坏）。

**实机冒烟（BE `127.0.0.1:8000` + Vite `5173`，2026-10-06）** —— 专验唯一没有自动化测试的
`App.jsx` `case`，顺带把页面主链走一遍：

| 步 | 观测 | 结论 |
|---|---|---|
| 直达 `GET /routing` | 渲染 `PAGE H // ROUTING` + 侧栏 9 项含「发前路由规则[H]」+ 空态「暂无发前路由规则 (NO RULES)」 | `case 'routing'` 生效，**未回落 `/protocol`** |
| 新建（名称 / 条件 / 目标指令 → 保存） | `SYS: 已保存规则「冒烟规则 alpha」`，列表出 `#1 … sort 0 COND :: meter_id == 0001 → 示例心跳帧 ● ON`，`GET /routing-rules` 回读 `sort_order 0 / enabled 1` | POST 载荷与回读一致，新建落末位（空表 = 0） |
| 建第二条后点「下移」首行 | **后端仍 `alpha=0 / beta=1`（草稿期零请求）**，界面 `● 2 条顺序待保存` 且序已换为 beta→alpha | 排序只改草稿成立 |
| 点「保存顺序 SAVE ORDER」 | 后端变 `beta=0 / alpha=1`，`SYS: 顺序已保存（更新 2 条 · 未变 0 条）`，脏标清 | 只 PUT 真变化的行成立 |
| 点「删除」→ 确认前 | `NieRModal` 出「删除路由规则…」，**后端仍 2 条（未发 DELETE）** | 二次确认是真拦 |
| 确认 | `SYS: 已删除规则「冒烟规则 alpha」（软删，可到回收站找回）`，后端剩 1 条，`GET /trash` 出 `kind=routing_rule` 且中文名正确 | DELETE 软删 + R37 中文名闭环 |
| 清场 | 规则 0 条、回收站 `routing_rule` 0 条 | 冒烟数据不留痕（`yorha.db` 本就永不入索引） |

### 六 · 留白（→ R39 ✅ / R40 ✅ / 仍未排）

- **加工页自动选指令接线** —— 接 `POST /dispatch/routed`（只解析不发送），把命中结果接到
  加工页的「选指令」动作上 → **R39 已落地 ✅（§8.71）**；
- **规则页「试解析」入口**（在规则表上就地输一条输入 → 看会命中哪条 / 为什么没命中）
  —— **R40 已落地 ✅（§8.72）**：页底通栏 `试解析 (DRY RUN)` 面板 + 四行结果表；
  「**为什么没命中**」到回执级为止（扫了几条 / 哪几条是结构性缺陷），**逐条规则的判定轨迹
  另议**（要给 `POST /dispatch/routed` 加 `trace` 字段）——
  **→ R43 已落地 ✅（2026-10-07，§8.75）**；
- **`byte_order` trim 归一**（§8.66 留白）不涉 —— **→ R42 已落地 ✅（2026-10-07，§8.74）**；
  规则表未进数据中心 8 域清单
  （`BUNDLE_DOMAIN_VERSIONS` 无 `routing_rules`），要随数据包迁移另议，不擅自扩域
  —— **→ R44 已落地 ✅（2026-10-07，§8.76，8 域 → 9 域）**。

**R38 ✅ —— 规则第一次能在页面上被建出来、排序出来、停掉、删掉。**

## 8.71 R39 发前路由 · 加工页接线（路由输入 → 命中即选指令）（2026-10-06）

**批次**：2026-10-06 · **纯 FE，零 DDL、零 BE 改动** —— 后端 `POST /dispatch/routed`
R36 就绪，本批只把它接到加工页的「选指令」动作上。`models.py` 无改列改表、**无
Migration、无 `chore(db)`**、不引 pytest、无新 pip 依赖，`processor.py` / `graph.py` /
`Blueprint.jsx` 未碰，**`/dispatch` 缺省口径一行未动**。

R36 给了「该发哪条指令」的数据层答案，R37 补上删改的数据完整性，R38 把规则摆到页面上；
R39 是四批里唯一**改变执行行为**的一批 —— 所以按 §8.69 与 §8.70 拆批拍板的理由，**这一批
的验收面是实机冒烟**：红测只能证明「调了什么、显示了什么」，证明不了「真把指令切过去了」。

### 一 · 接线三块（每块都能单独红测）

| 块 | 文件 | 职责 |
|---|---|---|
| 线缆 | `frontend/src/api/dispatch.js` + `api/index.js` | 新增 `resolveRoute(inputs)` → `POST /dispatch/routed`，体恒 `{ inputs }`。回执六键与 `/dispatch` 缺省三键（`status` / `attempts` / `hex_string`）**不重叠** —— 一旦重叠即说明串进了缺省端点 |
| 纯逻辑 | `frontend/src/utils/routeResolve.js`（新） | 行增删改、值的类型解析、回执 → 中文事实文案四档、目标指令不在册时补进列表（**已在册返回原引用**，不制造无意义的重渲染）；**零依赖无环**，页面只管接线 |
| 页面 | `frontend/src/pages/InstructionProcessor.jsx` | 「路由输入 (ROUTE INPUTS)」条 + `解析 RESOLVE` + 状态条 + `回到上一条 (UNDO)`；状态唯一落点是既有 `setActiveInstructionId`，不新造第二套选中态 |

同批把渲染条件 `activeInstructionId` 改判为 **`currentInstruction`**：回执给了目标 id 却查
不到那条指令时，落到「选一条指令」空态而不是拿 `null` 去渲染 `InstructionRunner` 崩掉。
正常路径（目标在册 / 已被 `mergeResolvedInstruction` 补进列表）**分支不可达，行为逐字不变**。

### 二 · 值的类型：实机冒烟当场抓到的缺口

R36 的后端测试通篇写的是 `resolve_route({"meter_id": 1}, …)` —— **整数**。而加工页的输入框
只可能给出**字符串**。两者一接就断：

| 现象 | 成因 | 后果 |
|---|---|---|
| 条件写 `meter_id == 0001`、输入框打 `0001`，后端回 `matched=false` | 条件里的 `0001` 是**数字字面量**（求值为 1），输入送来的是字符串 `"0001"` | `core/condition._equal` 对**数字 vs 字符串抛 `ConditionError`**，`resolve_route` 当普通不命中吞掉 → **规则永远不成立，且没有任何提示** |
| 同理 `fw_version >= 3` 这类**数值比较符** | `>` `<` `>=` `<=` 只在两端同为数字时才有意义 | 整类条件从页面侧**静默失效** |

所以**值必须按类型发**，而类型无法从「一串文本」里凭空猜出来。定的口径是
**「按 JSON 标量解析」**（`utils/routeResolve.js::parseInputValue`）：

- 纯数字（`0001` / `1.50` / `-2` / `1e3`）→ **数字**（`0001` → `1`，与条件字面量同型）；
- **显式加引号**（`"0001"`）→ **字符串** —— 前导零的表号这类值的**唯一出口**；
- 其余（`abc` / `V1.2` / `0x10` / 引号不配对）→ **按字符串原文发**，不报错、不改写；
- 键去两端空白、**空键行整行不发**（手抖多敲一个空格不该让整条规则静默不命中）。

面板顶栏把这条规则**写在脸上**（`值按 JSON 标量解析（0001 → 数字，"0001" → 字符串）`），
每行右侧再出一枚**类型徽标**（`空` / `数字` / `字符串`）—— 让操作员当场看见「这行会按什么
类型发出去」，而不是等解析失败再猜。**不做类型下拉**：多一列控件换不来更多信息，
徽标 + 提示语已经把选择路径说全了。

**这是「测试随新事实改写」，不是缺特性也不是测试 bug** —— 红测阶段两处断言写的是
`{ meter_id: '0001' }`（按当时的理解送串），冒烟证伪后随类型语义一并改写为
`{ meter_id: 1 }` 并补 `parseInputValue` / `describeInputType` 专测。

### 三 · 状态文案四档（只陈述事实，不断言用户意图）

`describeResolve(res, { previousName })` 返回 `{ matched, text }`，前缀 `SYS:`（失败 `ERR:`）：

| 档 | 触发 | 文案 |
|---|---|---|
| 命中且带回目标 | `matched=true` 且能取到 `instruction_id` | `命中规则「r」→ 已切到指令「x」。` |
| 命中但没带回目标 | `matched=true` 却取不到 id | `命中规则「r」→ 但回执未带回目标指令，未切换。` —— **不谎称切了** |
| 无命中（扫过规则） | `matched=false` 且 `considered>0` | `无命中 —— 扫过 N 条规则都不成立，维持当前指令「z」不猜。` |
| 无命中（零参与） | `matched=false` 且 `considered=0` | `无命中 —— 没有任何规则参与（无规则或全部停用），维持当前指令「z」不猜。` |

`invalid` 非空时两支都追加 `另有 N 条结构性缺陷已跳过（条件语法坏掉 / 目标指令不在册）。`
（**照抄后端判定，FE 不重算哪条坏**）；当前没有选中指令时写 `维持当前未选中状态不猜`，
**不硬造一个指令名**；请求失败出 `解析失败 —— <message>`，后端没给 message 落
`无法连接后端服务`（沿 R38 `describeRoutingSaveError` 同一兜底口径）。**回退**另起一条
`已回到指令「z」。`，回退按钮只在**真的切过**之后出现（无命中不记 undo，免得回退成空操作）。

### 四 · 红测先行

实现前跑 3 个测试文件，**13 failed + 1 文件整体红**，红因逐条对得上缺特性：

| 文件 | 红因 | 归档 |
|---|---|---|
| `utils/__tests__/routeResolve.test.js` | `Failed to resolve import "../routeResolve"` —— 模块不存在 | 缺特性 |
| `api/__tests__/dispatch.test.js` | `resolveRoute is not a function` —— 方法不存在 | 缺特性 |
| `pages/__tests__/InstructionProcessor.test.jsx` | 面板标题 / 输入行 / 解析按钮查不到 —— 面板不存在 | 缺特性 |

同一轮里 **23 条既有用例全绿**（红因不来自既有面）。落实现后翻 **2 条断言**随 §二 的类型
语义改写 → **测试随新事实改写**；本批**没有**出现「测试自身 bug」这一档。三档分开记账。

### 五 · 实机冒烟（8 组，真后端 8000 + 真浏览器 5173）

| 操作 | 观察 | 判据 |
|---|---|---|
| 直达 `/processing` | 面板常驻执行区上方：标题 / `POST /dispatch/routed · 0 项有效` / 一行空输入 / `解析 RESOLVE` / `收起 COLLAPSE` | 接线在页面上 |
| 键 ` meter_id `、值 ` 0001 ` → 解析 | 徽标 `空 → 数字`、计数 `1 项有效`、`SYS: 命中规则「冒烟规则 R39」→ 已切到指令「示例状态包」。`，右栏标题 `ID: SAMPLE-INST-STATUS`，出 `回到上一条 (UNDO)` | 空白去掉、类型对、**真切了指令** |
| 点 `回到上一条 (UNDO)` | `SYS: 已回到指令「示例心跳帧」。`，`ID: SAMPLE-INST-HEARTBEAT`，回退按钮消失 | 一键回退成立 |
| 值改 `9999` → 解析 | `SYS: 无命中 —— 扫过 1 条规则都不成立，维持当前指令「示例心跳帧」不猜。`，指令未动、无回退按钮 | **不猜**成立 |
| 条件改 `meter_id == "0001"`，值 `0001` → 解析 | 徽标 `数字` → 仍 `无命中` | 数字 vs 字符串**确实不同型**（§二 缺口坐实） |
| 同条件，值 `"0001"` → 解析 | 徽标 `字符串` → `命中` + 切到示例状态包 + 出回退 | 加引号出口可用，**类型语义双向验证** |
| `+ 添加 ADD` → `删除输入 2` → `收起 COLLAPSE` → `展开 EXPAND` | 输入行 1 → 2 → 1 → 0（按钮变 `展开 EXPAND`，`解析` 仍可用）→ 1 | 行编辑与让位成立 |
| 控制台 + 清场 | 0 error（404 仅既有示例资源）；冒烟规则软删 + `DELETE /trash/routing_rule/{id}` 彻底清除，规则 0 条 | 不留痕 |

### 六 · 验收

- **FE 1405 → 1445/1445（+40 = 27 纯逻辑 + 6 api + 7 页面）**、**BE 1002/1002**（零改动复跑）；
- `npx vite build` EXIT=0 · `npm run lint` EXIT=0 **且 0 warning** · yorha-ui 校验器
  **7 个改动文件 0 违规** · md 表列数 mismatches = 0；
- **零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、无新 pip 依赖、
  `processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径未动**。

**顺带一处 lint 治理**：组件变大后 `react-hooks/set-state-in-effect`（v7 编译器分析）不再
报 `setWrapInfo` 那一行，原有的 `eslint-disable-next-line` 被判 **unused（新引入的 1 条
warning）** → 移除该失效指令，lint 回到 **0 问题**；指令上方解释「为何此处同步置 loading」
的注释**原样保留**。规则若日后重新开始报点，会以 error 形式直接叫出来，比留一条死指令强。

### 七 · 留白

- **规则页「试解析」入口**（§8.70 六 挂的那条）→ **R40 已落地 ✅（§8.72）**。本批的留白只是
  「定位与文案各自独立」那半句：规则页走的是**页底通栏面板 + 四行结果表**，与加工页的
  「命中即切指令」两套动作语境分开写；
- **`byte_order` trim 归一**（§8.66）不涉 —— **→ R42 已落地 ✅（2026-10-07，§8.74）**；
- **规则表仍不在数据中心 8 域清单**（`BUNDLE_DOMAIN_VERSIONS` 无 `routing_rules`），
  要随数据包迁移另议，不擅自扩域 —— **→ R44 已落地 ✅（2026-10-07，§8.76）**；
- **输入表不做持久化**：本仓前端**零 `localStorage` 先例**，本批不为此新引一种落盘样式；
  刷新即回到一行空输入。真要常驻站点参数（表号、线别），另开一批连「谁清、谁改」一起拍 ——
  **→ R47 已落地 ✅（2026-10-07，§8.79）**。

**R39 ✅ —— 「按输入挑指令」第一次在页面上被真正执行，并且能一键退回。**

## 8.72 R40 发前路由 · 规则页试解析（键值 → 看会命中哪条）（2026-10-07）

**批次**：2026-10-07 · **纯 FE，零 DDL、零 BE 改动** —— `POST /dispatch/routed` 自 R36 起就是
只解析不发送的只读端点，规则页要的答案后端**全都给了**（命中哪条 / 扫了几条 / 哪几条有结构性
缺陷），本批只做入口与转写。`models.py` 无改列改表、**无 Migration、无 `chore(db)`**、不引
pytest、无新 pip 依赖，`processor.py` / `graph.py` / `Blueprint.jsx` 未碰，
**`/dispatch` 缺省口径一行未动**。

### 一 · 来源（§8.70 六 与 §8.71 七 **两处同挂**的那条留白）

R38 建页时就登记了「**在规则表上就地输一条输入 → 看会命中哪条 / 为什么没命中**」；R39 把接线
落在加工页（要发之前那一侧）后，又在 §8.71 七 复述了同一条留白。四批闭环之后，规则作者仍处在
「**写完规则没法验**」的状态 —— 只能等真发送才知道挑中了哪条。本批补的就是这个洞。

**落点选页底通栏，不塞进右栏表单**：试解析的判据是**已落库的全部规则**（first-match-wins 下
第 3 条判真才是答案），与「正在编辑哪一条」无关；右栏是单条规则的编辑上下文，把面板放进去等于
暗示「只试这一条」。

### 二 · 改动四块

| 块 | 文件 | 职责 |
|---|---|---|
| 纯逻辑 | `frontend/src/utils/routeResolve.js` | 新增 `describeDryRun(res)` → `{ matched, headline, rows }`，`rows` **恒四行**（命中规则 / 目标指令 / 参与扫描 / 缺陷跳过）；`invalid` 清单由文件内 `describeInvalid` 逐条拼 `规则「名」：原因`，与 `describeResolve` 同一份回执同源转写 |
| 共用行表 | `frontend/src/components/RouteInputTable.jsx`（新） | 两页扁平键值行表的**唯一排版实现**（键值框 + 类型徽标 + 行删除）；默认 `idPrefix="route"` 与 `labels` = 加工页原文。**边界划在排版**：不持状态、不发请求、不渲染「+ 添加」按钮 |
| 规则页 | `frontend/src/pages/RoutingRules.jsx` | 页底 `试解析 (DRY RUN)` 面板：行表 + `试解析 DRY RUN` 按钮 + SYS/ERR 一行事实 + 四行结果表（`<dl>` 扁平键值）+ 未命中时的三类原因脚注 |
| 加工页 | `frontend/src/pages/InstructionProcessor.jsx` | 内联行表换成 `<RouteInputTable>`（DOM 与 `aria-label` / `testid` **逐字节不变**），删掉随之多余的三个 import |

**判定口径仍只有一处**：键值解析在 `utils/routeResolve.toInputsMap`（两页共用），条件求值
100% 在后端 —— FE 连「自己扫一遍每条规则试试」都不做，那就是第二套判据。

### 三 · 文案断在「命中 / 无命中」

同一份回执，两种动作语境：加工页真会切指令（`describeResolve` 写「已切到指令…」），规则页试解析
**一行状态都不改** —— 所以 `describeDryRun` 绝不复用那句「已切到」，否则就是谎称这页也切了。

| 回执 | headline | 关键行 |
|---|---|---|
| `matched=true` 且带回目标指令 | `命中 —— 规则「X」→ 指令「Y」（只解析，不发送）。` | 参与扫描 = `N 条` |
| `matched=true` 但没带回指令 | `命中 —— 规则「X」，但回执未带回目标指令。` | 目标指令 = `（回执未带回目标指令）` |
| `matched=false`、`considered>0` | `无命中 —— 扫过 N 条规则都不成立。` | 命中规则 / 目标指令 = `（无命中）` |
| `matched=false`、`considered=0` | `无命中 —— 没有任何规则参与（无规则或全部停用）。` | 参与扫描 = `0 条 —— 无规则或全部停用` |

`considered` 与 `invalid` **由后端给，FE 不自己数**；`invalid` 非空时挤进 `缺陷跳过` 一行，
**不进 headline**（一句里只说一件事）。

### 四 · 「按已保存的规则计算」这条事实边界

后端只看得见已落库的行 —— 表单草稿、顺序草稿对它都不存在。因此：

- 面板口径行**常驻**写明「按已保存的规则计算（表单与顺序的未保存改动不参与）」，不靠推断用户
  此刻有没有改东西（推断错了就是撒谎）；
- 顺序有草稿时**当场点破**：`N 条顺序待保存 —— 试解析按已落库顺序计算`（琥珀条）—— 缺这句，
  用户会对着按旧顺序算出来的答案推新顺序，直接推错；
- 右栏固定一句 `只回显结果 —— 不选中规则、不改表单与顺序`，点过之后**不再补**任何
  「已为你做了什么」的文案。

### 五 · 第二消费方带来的收口（抽 `RouteInputTable`）

R39 只有一张输入表时，行表排版就写在加工页里；R40 要在规则页摆**第二张**，此时两条路都难看：
抄一遍 → 类型徽标 / 空键不发 / 删到只剩一行禁删三条细口径有了两个出处，迟早各走各的；就地抽
组件 → 加工页可能被改坏。本批选抽取，靠三件事保零回归：

1. `idPrefix` / `labels` 的**默认值就是加工页原文**（`路由键 N` / `路由值 N` / `删除输入 N` /
   `route-type-N`），调用方不传即逐字节等价；
2. 「+ 添加 ADD」**留在页面**：两页按钮的视觉语言本就不同（加工页 `RouteButton`、规则页
   `ActionButton`），不把这层差异塞进共用组件；
3. R39 那 13 条既有用例**一次不改全绿** —— 这就是「抽取没改行为」的证据。

### 六 · 红测先行有据

- **2 个新文件 13 条全红**：`utils/__tests__/routeResolve.dryrun.test.js`（7 条，
  `describeDryRun is not a function`）+ `pages/__tests__/RoutingRules.dryrun.test.jsx`（6 条，
  面板 / 按钮 / 结果表**不存在**）—— **红因全部 = 缺特性本身**，无一条属「测试自身 bug」；
- 落实现后翻 **1 条既有用例随新事实改写**（`RoutingRules.test.jsx` 的
  `findByText(/2 条顺序待保存/)`）：新面板的琥珀条里也有这半句，同一子串在页面上出现两处 →
  断言**收窄**到顺序条原文 `^● 2 条顺序待保存$`。是**收窄不是放水**，原意（顺序条出现）原样保留；
- 两文件 **13/13 绿**，全量 **FE 1445 → 1458/1458（+13 = 7 纯逻辑 + 6 页面）**、
  **BE 1002/1002 持平**（本批零 BE 改动）。

### 七 · 实机冒烟（8 组 · 后端 8000 + dev 5173）

| 步 | 操作 | 观察到 | 判据 |
|---|---|---|---|
| 1 | 进 `/routing` | 页底常驻 `试解析 (DRY RUN)` + `POST /dispatch/routed · 只解析不发送`，口径行 `0 项有效`，输入 1 行徽标 `空`，`+ 添加 ADD` / `试解析 DRY RUN` 齐；**未跑过不出结果行** | 面板常驻、不假装有结果 |
| 2 | 键填 `  meter_id  `、值填 ` 0001 ` 点试解析 | 徽标转 `数字`、口径行转 `1 项有效`；`SYS: 命中 —— 规则「冒烟规则 R40-A」→ 指令「示例心跳帧」（只解析，不发送）。` + 四行表（`1 条` / `0 条`） | 去空白与 JSON 标量解析成立 |
| 3 | 值改 `0003` 再试 | `SYS: 无命中 —— 扫过 2 条规则都不成立。`，两行 `（无命中）`，脚注出三类原因 | 不猜、不硬造规则名 |
| 4 | 值改 `"0001"`（带引号 = 字符串）再试 | **仍无命中**（条件是数字字面量 `0001`） | 类型语义从规则页同样可见 |
| 5 | `+ 添加 ADD` → 删第 2 行 → 再点第 1 行 × | 第 2 行出 / 删；只剩 1 行时 × 为 `disabled`、点击无效 | 至少留一行（同加工页口径） |
| 6 | 点首行「下移」→「放弃 REVERT」 | 琥珀条 `2 条顺序待保存 —— 试解析按已落库顺序计算` 出 / 消失 | 顺序草稿联动点破 |
| 7 | 回 `/processing` 填 `meter_id / 0002` 点解析 | `SYS: 命中规则「冒烟规则 R40-B」→ 已切到指令「示例状态包」。`，执行区切到示例状态包 | **抽取未改 R39 行为**（回归） |
| 8 | 控制台 + 清场 | `/routing` **0 error 0 warning**（`/processing` 仅 3 条既有 `response-specs/{id} 404 = 未配置常态`，与本批无关）；清场后规则 0 条、回收站 `routing_rule` 0 条 | 冒烟数据不留痕 |

### 八 · 验收与留白

**验收**：`npx vite build` EXIT=0 · `npm run lint` EXIT=0（0 问题 0 警告）· yorha-ui 校验器
改动 **8 个 js / jsx / json 文件 0 违规** · md 表列数 mismatches = 0 · `ev33` BAD = 0 ·
**零 DDL → 无 `chore(db)`**、不引 pytest、无新 pip 依赖、`processor.py` / `graph.py` /
`Blueprint.jsx` 未碰、`/dispatch` 缺省口径不变。

> **校验器口径（本批顺手钉死，后续批免得再查一遍）**：只传 **js / jsx / json** —— 4 个 md
> 不在其列。`docs/PLAN_Backlog.md` 与 `PROJECT_HANDOVER.md` 里有 **34 条历史 CSS 字样**
> （`rounded-sm` / `shadow-md` / `px-6` …，全是当年「改掉它」的史实记述），**HEAD 版本跑出来
> 同样 34 条、逐条相同**，与本批无关；R38 的「11 文件」与 R39 的「7 文件」也都是 js / jsx / json
> 的口径。
>
> **→ R48 已改口径 ✅（2026-10-07，§8.80）**：固定验收的校验器跑批自 R48 起 =
> **本批改动的 js / jsx / json + 全仓 md（14 份，只扫围栏代码块）**，另加一项
> `node scripts/test-yorha-md-validator.mjs`（md 口径的可复跑断言）。上面这段是 R40 当时的
> 口径记录，**原样留档不改写**；后续批按新口径跑。

**文档同步（同批）**：§1 新增 `R40` 行 + §8.70 六 / §8.71 七 两处留白改指（逐条判定轨迹另议）
+ §8.68 前的「立项前现状快照」补一条销项注；`PROJECT_HANDOVER.md` 条目 89 + 目录地图 4 行
（`routeResolve.js` / `InstructionProcessor.jsx` / `RoutingRules.jsx` 改 + `RouteInputTable.jsx` 补）
+ 修掉第 85 条残留的「R39（待排）」；`pageStatus.json` 两页（规则页补 `availableNow` 试解析条、
`nextSteps` 换 trace 留白；加工页**补登记** R39 漏登的「路由输入」条）+ `npm run sync:page-status`
重生成 `PAGE_STATUS.md`；**`BUSINESS_SCENARIOS.md` 8 处过期说法就地纠正** —— 72 / 91 改指 R40 +
47 / 48（「全库无 presence」「无 presence 概念 🔴」→ N3 组级 presence 早已落地）+ 49（pad 🔴 → N5 ✅
G4）+ 62（R28 解包「待排」→ §8.60 已落地）+ 73（解码回程 ⏸ → R9 + R10 ✅ §8.47 / §8.48）+ 头注
「仍暂缓」块与挂账第 4 条尾巴 → **§8.14 四项暂缓、挂账四项至此清零**。

**明确留白（本批不做）**：

- **逐条规则的判定轨迹（trace）**：试解析现在只给「命中哪条 / 扫了几条 / 哪几条有结构性缺陷」，
  给不出「**每条规则为什么没成立**」—— 比较不成立 / 变量不在输入 / 类型不可比，三者在回执里同为
  不命中。要做须给 `POST /dispatch/routed` 回执加 `trace` 字段，属 **BE 契约改动**（现有逐键断言
  测试要随新事实改写），**另议排批**  —— **→ R43 已落地 ✅（2026-10-07，§8.75）**；
- **输入表不做持久化**（§8.71 七 同款留白）—— 不涉；**规则表仍不在数据中心 8 域清单**
  —— **→ R44 已落地 ✅（2026-10-07，§8.76）**；
  **`byte_order` trim 归一**（§8.66）→ **R42 已落地 ✅（2026-10-07，§8.74）**。

**R40 ✅ —— 规则作者第一次能在页面上验自己写的规则，而不必等一次真发送。**

## 8.73 R41 文档卫生（过期指路清零 · 2026-10-07）

**批次**：2026-10-07 · **纯文档 + `pageStatus.json` 文案**，零功能改动 —— `backend/` 与
`frontend/src/` 下**代码一个字节没碰**（改的只是 `config/pageStatus.json` 里两串
`nextSteps` 文案）。`models.py` 无改列改表、**零 DDL → 无 Migration、无 `chore(db)`**、
不引 pytest、无新 pip 依赖、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、
**`/dispatch` 缺省口径一字未动**。**无红测** —— 本批零代码改动，红测先行的口径不适用
（R11 §8.49 文档批同款）。

### 一 · 来源（为什么单独开一批）

R1–R40 **全部排批且全部落地**之后，登记面上仍残留**指向未来批次的标记**。功能一项都不缺，
缺的是**账面自身的时间一致性** —— 接手人读到「下一批 R23」会以为 R23 没做，读到「余下仅
设备档案排序」会去追一个早已合掉的项。三类症状：

1. **声称「下一批 / 余下仅」而目标批次已完成** —— `pageStatus.json` 两处；
2. **状态标记漏翻** —— §1 `R21–R28` 行首仍是 🔄，而该行**八个子批状态格全是 ✅**；
3. **留白漏标** —— 同一段里已标「R37 销掉 ✅」「R38 销掉 ✅」，唯独 R39 那条没标；
   留白小节**正文已逐条标 ✅，只有标题括注没跟上**。

**排期依据**：`BUSINESS_SCENARIOS.md` 的 7 处过期说法已在 R40 按用户拍板「一起改掉再提交」
清过一次；本轮把扫出的、属**登记面**的残留单独收口，不与功能批混在一次提交里。

### 二 · 改动（8 处，逐处一处一因）

| # | 文件 · 位置 | 改前 | 改后 |
|---|---|---|---|
| 1 | `pageStatus.json` `/protocol` `nextSteps`（R22 条尾） | 下一批 R23（epoch 绝对时间戳模板），排期见 PLAN §8.52。 | R23（epoch 绝对时间戳模板）亦已落地 ✅（2026-10-03，PLAN §8.55）。 |
| 2 | `pageStatus.json` `/datahub` `nextSteps` | 余下仅设备档案自定义排序（→ R20，`sort_order` DDL 已由用户拍板解禁）。 | 设备档案自定义排序亦已落地 ✅（→ R20，2026-10-03，PLAN §8.50）；本页 nextSteps 无余项。 |
| 3 | PLAN §1 `R21–R28` 行状态格 | 行首 🔄 | 行首 ✅ |
| 4 | PLAN §8.68 八 标题 | 本批不做 → R37 / R38 / R39 | 本批不做 → R37 ✅ / R38 ✅ / R39 ✅ |
| 5 | PLAN §8.69 八 标题 | → R38 / R39 | → R38 ✅ / R39 ✅ |
| 6 | PLAN §8.70 六 标题 | → R39 / R40 / 仍未排 | → R39 ✅ / R40 ✅ / 仍未排 |
| 7 | HANDOVER 条目 85 状态句 | 「加工页自动选指令接线」仍列为留白（同段只标 R37 / R38） | 括注改 R37 ✅ / R38 ✅ / R39 ✅，正文补「**已由 R39 销掉 ✅（§8.71）**」 |
| 8 | HANDOVER 条目 86 状态句 | 明确留白（→ R38 / R39） | 明确留白（→ R38 ✅ / R39 ✅） |

**刻意不动的**（判断口径，免得下批又翻一遍）：

- §8.5x / §8.6x 各节**尾注**「下一批 → R31」「下一批：R28 …」—— 是**当批的排期快照**
  （历史留档），改成 ✅ 才是造假；**只改声明当前状态的登记面**（`pageStatus` `nextSteps`、
  §1 状态格、留白小节标题、HANDOVER 条目状态句）。
- HANDOVER 条目 85–89 各条**同步清单**里「拍板表改「R38 ✅ / R39 待排」」这类**复述当时
  改了什么**的句子，同理留档。
- 条目 87（R38）状态句**本就已标 R39 ✅ / R40 ✅**，不动。

### 三 · 验收与留白

**验收**：`npx vite build` EXIT=0 · `npm run lint` EXIT=0（0 问题 0 警告）· yorha-ui 校验器
本批改动 **1 个 json 文件 0 违规**（md 不在校验器口径内 —— `PLAN_Backlog.md` /
`PROJECT_HANDOVER.md` 的 34 条历史 CSS 字样 **HEAD 版本同样 34 条、逐条相同**）·
md 表列数 mismatches = 0 · `ev33` STAGED=0 BAD=0 · **零 DDL → 无 Migration、无 `chore(db)`**。

**明确留白（本批不做）**：

- **校验器 md 口径**：那 34 条历史 CSS 字样（`rounded-sm` / `shadow-md` …，全是当年「改掉它」
  的史实记述）要让 md 过检须二选一 —— 改写史实措辞，或给校验器 md 规则加白名单；后者改的是
  **仓外** `~/.agents/skills/yorha-ui`，**另议**；
  **→ R48 已落地 ✅（2026-10-07，§8.80）**：两条**都没走** —— 取第三条路，把 md 的扫描面
  收窄到**围栏代码块**（散文与行内代码是史实记述、围栏才是活代码），史实措辞一字未改、
  白名单一个没建，二选一因此不必发生；
- **输入表持久化** —— 不涉
  （**`byte_order` trim 归一**已由 **R42 ✅ §8.74**、**规则 trace** 由 **R43 ✅ §8.75**、
  **规则表进 8 域清单** 由 **R44 ✅ §8.76** 收掉，三者均已不是留白）。

**文档同步（同批）**：§1 新增 `R41` 行 + §8.73 本节；`PROJECT_HANDOVER.md` 条目 90 +
其内两处状态句改写；`pageStatus.json` 两处 `nextSteps` 文案 + `npm run sync:page-status`
重生成 `PAGE_STATUS.md`。

**R41 ✅ —— 登记面不再有指向未来批次的过期断言，历史排期快照原样留档。**

## 8.74 R42 `byte_order` trim 归一（FE 单点判据 · 2026-10-07）

**批次**：2026-10-07 · **纯 FE**，零 DDL、**零 BE 改动** —— `handlers/base.py::byte_order_of`、
`core/frame_builder._with_byte_order`、`core/response_generate` 本就 `.strip()`，本批一个字节
没动它们。`models.py` 无改列改表、**无 Migration、无 `chore(db)`**、不引 pytest、无新 pip 依赖，
`processor.py` / `graph.py` / `Blueprint.jsx` 未碰，**`/dispatch` 缺省口径一字未动**。

### 一 · 来源（§8.66 七 的留白，7 处同挂）

R34（§8.66 七）把「**不引入 trim 归一**」写进留白，理由是「UI 下拉产不出带空白的值，两端在
可达输入上本就同判」。这个理由**只覆盖下拉这一个入口**：值照样能由**导入 / API 直写**进来
（冒烟就是 `POST /protocols/` 直写），而 BE `byte_order_of` 从 R21 起就是
`str(order).strip().lower()` —— 它的 docstring 还写着「与 FE
`String(pc.byte_order).trim().toLowerCase()` 同口径」，**那句在 FE 侧从来不成立**：FE 三处
谓词只有 W5 一路带 `.trim()`。

于是同一个 `' LITTLE '` 会**卡面判大端（FE 不 trim）、后端判小端（BE trim）** —— 设计期
卡面、出线翻译、后端 handler 三方可能判成两种字节序。本批把 FE 三处谓词收敛到单点。

**7 处留白同挂**：§8.67 七 / §8.68 七 / §8.69 八 / §8.70 六 / §8.71 七 / §8.72 八 /
§8.73 三 均登记过「`byte_order` trim 归一 —— 不涉」，本批一并改指。

### 二 · 改动（1 新增 + 3 接线）

| # | 文件 | 职责 |
|---|---|---|
| ① | `frontend/src/utils/byteOrder.js`（**新增**） | **FE 侧唯一的字节序取值判据**：`normalizeByteOrder(raw)` = `String(raw ?? '').trim().toLowerCase()`（`''` = 未配置）、`isLittleByteOrder(raw)` = 归一后只认 `little`，其余（含枚举外）一律大端 fail-open —— 与 `byte_order_of` 的 `str(order).strip().lower()` 逐字对齐；**本模块只归一不判枚举**，故 W5「在枚举内才不报」的语义原样不变 |
| ② | `frontend/src/utils/protocolTree.js` | 两处谓词接线：checksum 的 `isLittleOrder`（`collectDeterministicBytes` 容器内容 + `injectRefsSigma` 卡中央值**两个计算点共用**）+ length 分支的就地写法 → `isLittleByteOrder` |
| ③ | `frontend/src/utils/toFrameBlocks.js` | 出口翻译闸门 `withLogicParams` 的就地谓词 → `isLittleByteOrder`；**params 形状与缺省口径不变**（归一后是 `little` 才写键，`big` / 缺省 / 枚举外不写） |
| ④ | `frontend/src/utils/validateProtocol.js` | W5 的 `String(...).trim().toLowerCase()` → `normalizeByteOrder` —— **三处谓词里唯一原本带 trim 的一路**，行为逐字不变，只是不再自带第二套归一 |

**范围钉死（按 §8.66 留白原文）**：只管 **FE 谓词 + 卡面 / 出口翻译 / W5 四处接线**；
**收侧 `response_match` / `sequence_plan` 零改动**（fail-closed 不动，本就支持）；
指令域字段 `endianness`（E1-2 B6）是**另一个域**，不并入；`pc.encoding` 不 trim
（未登记在册，超范围）。

**为什么新增单点文件、而不是就地加 3 个 `.trim()`**：对齐 BE `byte_order_of` 的「单点判据」
纪律（R34 把字节序门面上移 base 就是同一个理由），并**坐实**它 docstring 里那句
「与 FE `.trim().toLowerCase()` 同口径」—— R42 之前不实，R42 起才成立。

### 三 · 红测先行有据

- **新建 `utils/__tests__/byteOrder.test.js` 3 条**：实现前**整文件加载即红**（被测模块
  尚不存在）；
- **3 条行为锚同步红**：`protocolTree.test.js` length（`' LITTLE '` → 期望 `06 00`、
  实得 `00 06`）+ checksum（`' little '` → 期望 `37 4B`、实得 `4B 37`）、
  `toFrameBlocks.test.js`（params 未写键）—— **红因 3 条全为缺特性本身**，
  无一条属「测试自身 bug」；
- `validateProtocol.test.js` 的 2 条（`' LITTLE '` 不报 W5）**实现前就绿** —— W5 原先
  自带 `.trim()`，属**已有特性**，按三档记账归「测试随新事实改写」侧的**行为锚**，
  不冒充红测。

**改写 1 条既有测试注释**：`protocolTree.test.js` 原「不额外引入 trim —— 沿用既有谓词形态」
已随本批失效，就地改成指向 R42（原断言一字未动，仍绿）。

### 四 · 实机冒烟（后端 8055 + dev 5174 · 回收站清零）

| 步 | 操作 | 观察到 | 判据 |
|---|---|---|---|
| 1 | `POST /protocols/` 直写协议 `R42 冒烟 trim 归一`，length 卡与 checksum 卡 `parameter_config.byte_order` 均写 ` LITTLE `，另建净值对照卡写 `little` | 后端**原样保留**脏值（回读仍是 ` LITTLE `，两处） | 保存侧不替用户改写输入（BE 零改动） |
| 2 | 进 `/protocol` 读卡面出线 | `G(脏)` = `06 00`、`G2(净)` = `06 00`、`G3(脏校验)` = `FF 2E` | 脏值按**小端**出线（修复前 FE 不 trim 判 big → `00 06`）；脏净同判 |
| 3 | 属性面板 `⚠ 3 提醒` 展开 | 三条全是 `「L」/「L2」/「C」HEX 与字节长度不一致（2/4 字符，运行期按算法重算/填槽）` —— **无一条 W5** | `BYTE_ORDER_UNKNOWN` 未报（归一后在枚举内），提醒是既有的 HEX 长度提示，与本批无关 |
| 4 | 控制台核对 | **0 error 0 warning**（仅 1 条 React DevTools info） | 无运行期异常 |
| 5 | 清场 | `DELETE /protocols/{id}` 200 → `DELETE /trash/protocol/{id}` 200 → 回收站 **0 条**、协议列表回到冒烟前 3 条 | 冒烟数据不留痕 |

### 五 · 验收与留白

**验收**：4 文件 **105/105（+6）** · FE 全量 **1464/1464（95 文件，+1/+6）** ·
BE **1002/1002 持平**（零改动）· `npx vite build` EXIT=0 · `npm run lint` EXIT=0
（0 问题 0 警告）· yorha-ui 校验器改动 **9 个 js / json 文件 0 违规**（8 js + 1 json） · md 表列数
mismatches = 0 · `ev33` STAGED=0 BAD=0 · **零 DDL → 无 Migration、无 `chore(db)`**、
不引 pytest、无新 pip 依赖。

**明确留白（本批不做）**：

- **收侧 `response_match` / `sequence_plan` 不碰** —— 两边对 `byte_order` 本就 fail-closed
  支持，改它要另开契约批；
- **指令域 `endianness`（E1-2 B6）不并入** —— 另一个域、另一套值域；
- **`pc.encoding` 不做 trim 归一** —— 未登记在册，超出 §8.66 留白原文范围。

**文档同步（同批）**：§1 新增 `R42` 行 + §8.74 本节 + §8.66 七 销项注 + 7 处留白改指
（§8.67 / §8.68 / §8.69 / §8.70 / §8.71 / §8.72 / §8.73）；`PROJECT_HANDOVER.md` 条目 91 +
目录地图补 `byteOrder.js` 行；`pageStatus.json` 相关页补记 + `npm run sync:page-status`
重生成 `PAGE_STATUS.md`。

**R42 ✅ —— 同一个 `byte_order` 值，卡面、出线、W5、后端四方判成同一个字节序。**

## 8.75 R43 规则 trace（逐条判定轨迹 · 2026-10-07）

**批次**：2026-10-07 · **BE + FE**，**零 DDL** —— `models.py` 无改列改表、**无 Migration、
无 `chore(db)`**、不引 pytest、无新 pip 依赖，`processor.py` / `graph.py` / `Blueprint.jsx` 未碰，
**`/dispatch` 缺省口径一行未动**（改的只是**新增**只读端点 `POST /dispatch/routed` 的回执）。

### 一 · 来源（§8.72 八 与 §8.73 三 两处同挂的那条留白）

R40 把「试解析」做到了回执级：扫了几条 / 哪几条是结构性缺陷 / 命中没有。但
**比较不成立 / 变量不在输入 / 类型不可比，三者在回执里同为 `matched=false`** —— 规则作者只看得到
「无命中」，说不出**自己那一条**卡在哪一类。规则攒到五条以上，「扫过 3 条都不成立」基本没法定位。

留白原文（§8.72 八）已经把做法写死：**要给 `POST /dispatch/routed` 回执加 `trace` 字段，属 BE
契约改动**（现有逐键断言测试要随新事实改写）。本批照此执行。

### 二 · 契约：`trace` = 定序全序，一行一条规则

`RouteResolveResponse` 新增 `trace: List[RouteTraceEntry]`，每行五键：

| 键 | 谁给 | 含义 |
|---|---|---|
| `id` / `name` / `condition` | 后端 | 规则三元组，与 `invalid` 同形，FE 原样显示 |
| `code` | 后端 | 机器码（FE 高亮 / 测试断言用），见下表 |
| `detail` | 后端 | **事实载荷**：变量名 / 两个类型名 / 语法错误原文，可空 |

| `code` | 什么时候给出 | `detail` |
|---|---|---|
| `MATCHED` | 判真命中 —— 轨迹到此为止，其后行是 `NOT_EVALUATED` | 空 |
| `COND_FALSE` | 比较求值成功但为假 | 空 |
| `VAR_UNDEFINED` | 求值期抛 `变量未定义：X` | `X` |
| `TYPE_INCOMPARABLE` | 求值期抛 `类型无法比较：A 与 B` | `A 与 B` |
| `COND_ERROR` | 求值期其它错误（如 `右侧须是数组或字符串…`） | 错误原文 |
| `CONDITION_INVALID` | **解析期**语法坏（同时记进 `invalid`） | 错误原文 |
| `DISABLED` | `enabled=0`，不参与也不算进 `considered` | 空 |
| `NOT_EVALUATED` | 前面已有命中 → **没被求值过** | 空 |
| `INSTRUCTION_MISSING` | 目标指令不在册（`resolve_route` 那层静态跳过，同时记进 `invalid`） | 空 |

**前八种**由 `core/routing.TRACE_CODES` 登记（`select_rule` 产出）；**第九种** `INSTRUCTION_MISSING`
不在那里 —— `select_rule` 根本看不见悬空规则（它们进不了 `usable`），由 `resolve_route` 自己补，
故 FE `TRACE_LABELS` 是它的**超集**，两处注释都写明了这层不对称。

**为什么是「机器码 + 载荷」而不是后端直接给中文**：中文是展示，归 FE（与本仓其它文案同处）；
而 `detail` **不许 FE 自己从条件里抠** —— 变量名与两个类型名是 `condition.py` 抛出来的，FE 只能
原样接。反过来 FE 也不扫第二遍条件：`routeResolve.js` 连条件求值都不做（不造第二套判据）。

**判定与 `considered` 一个字没改**：

- `select_rule` 原先命中即 `return`；现在改成记一行 `MATCHED` 后置 `stopped=True`、**走完循环只为
  补 `NOT_EVALUATED`** —— 尾部规则**不 parse、不求值、不累加 `considered`**；
- 停用与解析期坏掉那两处原先是裸 `continue`，改成「跳过并记一行」；
- **回收站行仍直接跳过不记**（列表页本就看不见它们，轨迹只覆盖「看得见的行」）；
- `matched` / `rule` / `invalid` / `considered` 四键逐字不变。

### 三 · 改动（3 BE + 2 FE + 5 测试文件）

| 层 | 文件 | 职责 |
|---|---|---|
| BE 纯匹配器 | `backend/core/routing.py` | 新增 `TRACE_CODES` / `EVAL_CODE_PREFIXES` / `_eval_code`（按 `ConditionError` **文案前缀**分类并剥前缀得 `detail`）/ `_trace_row`；`select_rule` 返回值由四键变五键 |
| BE 契约 | `backend/schemas/routing_api.py` | 新增 `RouteTraceEntry`；`RouteResolveResponse` 加 `trace`（`default_factory` → 旧调用方零改动） |
| BE 解析入口 | `backend/routers/routing.py` | 把 `select_rule` 的轨迹与本层静态跳过（`INSTRUCTION_MISSING`）按**同一定序**并回一张表 |
| FE 纯逻辑 | `frontend/src/utils/routeResolve.js` | 新增 `TRACE_LABELS` + `traceReasonText(code, detail)` + `describeTrace`；`describeDryRun` 返回值多一项 `trace`；**`describeInvalid` 改走同一张码表** —— 同一条规则在「缺陷跳过」与轨迹里出现两次，措辞必须同源（原先 `reason` 是码就原样显示 `INSTRUCTION_MISSING`） |
| FE 页面 | `frontend/src/pages/RoutingRules.jsx` | 结果表下方出 `逐条判定轨迹 (TRACE) · N 条` 有序表（`data-testid="dry-trace-{n}"`，`MATCHED` 行黄字）；口径列表补一条；未命中脚注改成「是哪一条、哪一类见上方轨迹」 |
| FE 注释 | `frontend/src/api/dispatch.js` | 回执键列表补 `trace` |

### 四 · 红测先行有据

- **BE 新增 13 条**：`SelectRuleTraceTest` 6 + `EvalCodePrefixTest` 2 + `ResolveRouteTraceTest` 5 ——
  实现前 **12 红**（`KeyError: 'trace'` / `AttributeError: trace` /
  `ImportError: EVAL_CODE_PREFIXES` / `assertIn('trace', payload)` 失败），红因**全为缺特性**；
- **FE 新增 8 条**：`routeResolve.dryrun.test.js` 4 + `RoutingRules.dryrun.test.jsx` 4 ——
  实现前 **6 红**（`describeDryRun(...).trace` 为 `undefined`、页面查无
  `data-testid="dry-trace-0"`），红因**全为缺特性**；余下 2 条是「回执没有 trace / 后端失败 →
  不出轨迹块」的护栏，实现前就绿（当时本来就没有轨迹块），**不冒充红测**。

**三档记账**：

1. **随新事实改写 3 条** —— BE `test_empty_ruleset` 的四键全等断言补 `trace: []`；FE
   `describeDryRun` 两条**完整形状** `toEqual` 各补 `trace: []`（`matched` / `headline` / `rows`
   逐字未动，不是放水）；
2. **测试自身 bug 先修 2 条** —— 红批里写的两条页面护栏用 `/逐条判定轨迹/` 做**否定**断言，
   撞上了同批新加的**口径列表同名词**，改成锚到结果区标题 `/逐条判定轨迹 \(TRACE\)/`；
3. **缺特性 18 条** —— 即上面的 12 + 6，实现后全绿。

`EvalCodePrefixTest` 额外钉住**文案漂移**：轨迹码是按 `ConditionError` 文案前缀分的类，
`condition.py` 改一句前缀，分类就静默退化成兜底码 —— 这两条测试从分类这一侧反向验，漂移即红。

### 五 · 实机冒烟（后端 8055 + dev 5174 · 回收站清零）

建 5 条规则各占一类（`sort_order` 0..4）。悬空那条用**直接改库软删指令**造：`DELETE /instructions/{id}`
会级联软删相关规则，页面上根本留不下悬空行 —— 该分支本就只来自直改库 / R37 之前的旧行。

| 输入 | 回执 | 轨迹（顺序 = 列表顺序） |
|---|---|---|
| `meter_id = 999` | `matched=false` · `considered=3` · `invalid` 1 条 | #1 `COND_FALSE` / #2 `VAR_UNDEFINED` detail=`line` / #3 `DISABLED` / #4 `INSTRUCTION_MISSING` / #5 `COND_FALSE` |
| `meter_id = 1` | `matched=true` · `considered=1` | #1 `MATCHED` / #2 #3 #5 `NOT_EVALUATED` / #4 仍 `INSTRUCTION_MISSING`（与 `invalid` 无条件收录它的既有口径一致） |

页面读数：`缺陷跳过` 行由 `规则「…」：INSTRUCTION_MISSING` 变成
**`规则「R43 smoke dangling」：目标指令不在册`**；`逐条判定轨迹 (TRACE) · 5 条` 逐行
`#序号 / 规则名 / 条件 / 中文原因`，`dry-trace-0..4` 五个 testid 齐，`MATCHED` 行黄字；
控制台 **0 error 0 warning**（仅 1 条 React DevTools info）；清场后规则表回原状、**回收站 0 条**，
8055 / 5174 两个后台壳已停。

### 六 · 验收与留白

**验收**：BE **1002 → 1015/1015（+13）** · FE **1464 → 1472/1472（95 文件，+8）** ·
`npx vite build` EXIT=0 · `npm run lint` EXIT=0（0 问题 0 警告）· yorha-ui 校验器改动
**6 个 js / jsx / json 文件 0 违规**（5 js / jsx + 1 json） · md 表列数 mismatches = 0 · `ev33` STAGED=0 BAD=0 ·
**零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、无新 pip 依赖、
`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径一行未动**。

**明确留白（本批不做）**：

- **加工页不加轨迹** —— `describeResolve` 消费的是同一份回执，但加工页是「命中即切」的动作语境，
  一行事实已够；要加另议 —— **→ R45 已落地 ✅（2026-10-07，§8.77，`describeTrace` 提为导出、
  两页共用一张轨迹表）**；
- **不为「数值 / 字符串互换」这类高频错单独开码** —— `TYPE_INCOMPARABLE` 的 `detail` 已经把
  两个类型名带出来了，再细分是文案不是判据；
- **输入表不做持久化**（§8.71 七 同款留白）—— 不涉；**规则表仍不在数据中心 8 域清单**
  （`BUNDLE_DOMAIN_VERSIONS` 无 `routing_rules`）——
  **→ R44 已落地 ✅（2026-10-07，§8.76，8 域 → 9 域）**。

**文档同步（同批）**：§1 新增 `R43` 行 + §8.75 本节 + §8.70 六 / §8.73 三 两处 trace 留白改指；
`PROJECT_HANDOVER.md` 条目 92 + 条目 89 / 90 两处留白改指（顺带把条目 89 里 R42 那句
「不涉」一并改指）+ 目录地图改 `routeResolve.js` / `RoutingRules.jsx` 两行；`pageStatus.json`
`/routing` 补记 + `npm run sync:page-status` 重生成 `PAGE_STATUS.md`。

**R43 ✅ —— 规则作者第一次能逐条读到「为什么不命中」，而不必逐条去猜。**

## 8.76 R44 规则表进数据包（`routing_rules` 第 9 域 · 2026-10-07）

**批次**：2026-10-07 · **BE + FE**，**零 DDL** —— `routing_rules` 表 R36 就已建出（§8.52 C-1
选项 C），本批**只新增域文件与端点**，`models.py` 一行未改、**无 Migration、无 `chore(db)`**、
不引 pytest、无新 pip 依赖，`processor.py` / `graph.py` / `Blueprint.jsx` 未碰，
**`/dispatch` 缺省口径一行未动**。

### 一 · 来源（四批同挂的那条留白 · 2026-10-07 question 工具回执拍板）

R7（§8.45）拍板「原 3 域 → 8 域」时**刻意不含规则表**，留白原文是「若要随数据包迁移另议，
不擅自扩域」—— 在 §8.70 六、§8.71 七、§8.72 八、§8.73 三、§8.75 七 **五处同挂**（本批一并改指）。R36–R43 四批把规则做成了
可建、可排序、可试解析、可读轨迹的实体，却**换不了机**：别的域一个 ZIP 就走，唯独规则只能一条条
手抄。本批选题由 question 工具回执拍板（同批候选：输入表持久化 / 校验器 md 口径 / 暂不排批）。

### 二 · 域清单：8 → 9

`ROUTING_RULES_SCHEMA_VERSION = 1` 入 `BUNDLE_DOMAIN_VERSIONS` **排末尾**：

| 域 | R7 起 | R44 起 |
|---|---|---|
| `instructions` · `relations` · `frames` · `recipes` · `sequences` · `transport` · `profiles` · `templates` | 第 1–8 位 | 第 1–8 位，**相对导出序一个字节没动** |
| `routing_rules` | 无 | **第 9 位（新增）** |

`GET /datahub/export/bundle` 多出 `routing_rules.json`；`manifest` 的 `domainVersion` /
`domainCounts` 各多一键。纯函数 `bundle_manifest` 的漂移守卫（`ValueError: 域清单不一致`）
把 counts 表**顺带也钉住**了 —— 少写一键立刻炸。新端点 `POST /datahub/import/routing_rules`
与既有五个按域导入端点同形（三段式：顶层校验 400 不落快照 → `pre-import` 快照 → 逐行提交）。

> **这是「现行口径」的一次有意变更**：R17（§8.49）当年钉死的「缺省不带参数 = 现行 8 域逐字不变」
> 从本批起变成 9 域。历史小节（§8.45 / §8.49）里仍写 8 域 —— 那是当时的事实，不改。

### 三 · 导出形：行序即优先级，记账列不进包

`routing_rule_export_row` 的列 = `models.py` 列序**减三个记账列**：

| 进包 | 不进包 |
|---|---|
| `id` · `name` · `condition` · `instruction_id` · `sort_order` · `enabled` · `description` | `created_at` · `updated_at` · `deleted_at` |

不进包的理由镜像 profiles / templates / sequences 的既有先例：时间戳是**机器本地记账**不是内容 ——
进包即导出可 diff，回灌用目标机时钟，也不会把源机的回收站状态搬过去。

**行序 = 匹配顺序** `(sort_order, name, id)`，正是 `core/routing.py` 的匹配定序键：
回灌即还原优先级。排序**收在 `routing_rules_export_payload` 一处**，调用方传进来的顺序不作数 ——
导出与匹配两处各排一次序，迟早悄悄分叉。`name` 走码位序，与 SQLite `BINARY` 排序一致。

**只出活行**：`alive()` 过滤，站内规则不进包（与其余 8 域同一条 R6 §8.43 纪律）。

### 四 · 回灌形：四条口径全部镜像既有纪律

`import_routing_rules` 逐行独立提交、逐行报告，四条判据**没有一条是新造的**：

| 口径 | 镜像的既有出处 | 不过时 |
|---|---|---|
| 条件语法 → `core/condition.parse_condition` | 规则页保存侧 `routing._validate_condition`（SSOT） | 单行跳过，报「条件语法不成立」 |
| 目标指令必须是**活行** | `routing._require_instruction` + `import_sequences` 的宿主缺失 | 单行跳过，报「指令不存在」 |
| 名称唯一**查全表含回收站占名** | `routing._ensure_name_free` | 单行跳过，报「规则名已存在（行 X）」 |
| `id` 自己在站里 | `import_profiles` 的同款 | 跳过并提示「先恢复或彻底删除」 |

**为什么不直接 upsert 悬空规则**：`routing_rules` 不加 FK（§0 明文，悬空由查询侧拦），
回灌一条目标指令不存在的规则，等于**亲手写出一条一进包就是缺陷的行** —— 它在发前路由里直接变成
`INSTRUCTION_MISSING`，而 R43 刚把那一档标成「只能直改库造出来」。故与序列同款：宿主缺失整条跳过，
不写半条。

`sort_order` / `enabled` 是**可选行字段**（镜像 R20 `profiles.sort_order`）：在场必须合法且
`bool` 不算数；缺席则**建行取 0 / 1、改行保留目标库已有的值**。`condition` / `instruction_id` /
`description` 载荷即真值（缺席即清空）。

### 五 · FE 四处接线

- `BUNDLE_DOMAINS` 加第 9 颗芯片 `routing_rules` —— 顺序仍**后端 `BUNDLE_DOMAIN_VERSIONS`
  键序 = 导出序**，送后端前按这张表排序；
- `DOMAIN_KEYS` + `DOMAIN_LABELS` —— 按顶层数组键自动识别（零白名单第二层，与 R8 同纪律），
  中文名「发前路由规则」；
- `SAMPLE_DOMAINS` 第 6 个示例域 —— 保住 `DataHub.jsx` 里那句既有不变量
  「示例包 = `POST /datahub/import/{domain}` 能吃的范围逐字对齐」；
- 全量导出文案 `8 域` → `9 域`（补 `routing_rules.json`）、按域导入面板提示与导出说明 8 → 9。

### 六 · 红测与三档记账

**红测先行有据** —— BE 新建 `backend/tests/test_datahub_routing_rules.py` **18 条全红**，
红因**全为缺特性**：`AttributeError`（`ROUTING_RULES_SCHEMA_VERSION` /
`routing_rules_export_payload` / `routing_rules_rows` / `import_routing_rules` 四个符号不存在）
+ `AssertionError`（`routing_rules` 不在 9 域清单）+ `KeyError`（manifest counts 少一域）
+ `400 未知域：routing_rules`（`domains=` 子集选不到）+ `routing_rules.json not found`（ZIP 里没有）。

**FE 的红靠 `git stash` 只暂存实现文件取回**：`frontend/src/pages/DataHub.jsx` 回到实现前状态，
跑 `DataHub.test.jsx` 得 **5 failed / 14 passed** —— 其中 1 条是 R44 新测（缺特性），
4 条是**随新事实改写过的断言对旧实现红**（证明它们钉的是新事实），还原后两次全量全绿。

**三档记账**（一批三档分开记，不混账）：

| 档 | 条数 | 明细 |
|---|---|---|
| 缺特性（真红测） | **19** | BE 18 + FE 1 |
| 测试随新事实改写 | **9** | BE 5（`test_eight_domain_inventory` → `test_nine_domain_inventory` 的清单与 `len 8→9`、`test_counts_and_legacy_keys` 的 counts 表补键、`test_zip_carries_eight_domains` → `test_zip_carries_nine_domains` 补文件与计数、bundle_domains 的 `default_is_still_the_full_*` 与 `explicit_all_*` 两处更名）+ FE 4（芯片清单与顺序注释、全量导出文案、示例包数组、域键识别用例） |
| 测试自身 bug 先修 | **0** | 本批无 |

**验收**：BE **1015 → 1033/1033（+18）** · FE **1472 → 1473/1473（95 文件，+1）** ·
`npx vite build` EXIT=0 · `npm run lint` EXIT=0（0 问题 0 警告）· yorha-ui 校验器改动
**3 个 js / jsx / json 文件 0 违规**（2 js/jsx + 1 json）· `ev40` TOTAL_PROBLEMS=0 ·
`ev33` STAGED=0 BAD=0 · **零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、
无新 pip 依赖、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、
**`/dispatch` 缺省口径一行未动**。

> **FE 全量首跑出过 1 条 `Terminal.test.jsx` 历史预览红**（`Unable to find an element with the
> text: AA 55 ……`）—— 本批未触碰该页；单跑 29/29 绿，随后两次全量 95 文件 1473 条全绿。
> 按**测试抖动**记账：不改测试、不改实现，如实登记。

### 七 · 明确留白（本批不做）

- **协议数据仍不在 9 域内** —— 拍板 R7 那批就明确过「协议不进域」，本批不重开；
- **输入表不做持久化**（§8.71 七 同款留白）、**校验器 md 口径**（改仓外 skill 须另议）—— 不涉；
- **不做批量导入端点** —— 按域导入仍是一次一个域，「先灌指令再灌规则」的顺序要求由回执的
  「指令不存在」逐行告知，不新开编排。

**文档同步（同批）**：§1 新增 `R44` 行 + §8.76 本节 + §8.70 六 / §8.71 七 / §8.72 八 / §8.73 三 /
§8.75 七 五处「规则表进 8 域清单」留白改指；`PROJECT_HANDOVER.md` 新条目 93 + 四处同款留白改指 +
目录地图 `datahub.py` / `DataHub.jsx` 两行；`pageStatus.json` `/datahub` 的导出陈述改 9 域
+ 留白销项 + `nextSteps` 改指，并 `npm run sync:page-status` 重生成 `PAGE_STATUS.md`。

**R44 ✅ —— 规则表终于随包走：换一台机，规则与指令、配方、序列一起进 ZIP，而不是一条条手抄。**

## 8.77 R45 加工页判定轨迹（同一份回执两页共用 · 2026-10-07）

### 一 · 来源（§8.75 七 那条刻意留白）

R43 给回执加 `trace` 时**明确留了白**：

> **加工页不加轨迹** —— `describeResolve` 消费的是同一份回执，但加工页是「命中即切」的动作语境，
> 一行事实已够；要加另议；

理由本身当时成立（加工页是动作语境、面板紧贴执行区）。但 R43 落地后账面上出现一个**不对称**：
同一份 `POST /dispatch/routed` 回执，规则作者在 `/routing` 的「试解析」里能读到三行「为什么不命中」，
**在 `/processing` 真按下「解析 RESOLVE」并真切了指令的那一刻，却只有一行状态条** —— 要看轨迹得
换到另一个页面、按同一份输入再解析一次。留白说的是「另议」，本批即那次另议。

**2026-10-07 question 工具回执拍板选此项**（余三候选：输入表持久化 / 校验器 md 口径 / 暂不排批）。

### 二 · 改动（2 个文件，纯 FE）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `frontend/src/utils/routeResolve.js` | `const describeTrace` → **`export const describeTrace`**（一行） | 同一份回执两处消费，轨迹**必须走同一张表** |
| `frontend/src/pages/InstructionProcessor.jsx` | 新增 `routeTrace` 状态 + 状态条下方出轨迹块 | 销 §8.75 七 留白 |

`describeDryRun` 内部改调同一个 `describeTrace`，**返回值逐字不变** —— R43 在
`routeResolve.dryrun.test.js` / `RoutingRules.dryrun.test.jsx` 里的 8 条既有用例**一次不改全绿**，
即「提取没改行为」的证据。

### 三 · 三条边界

1. **回执没给 `trace`**（旧后端 / 字段缺席）→ `describeTrace` 出 `[]` → 不出块，
   状态条照旧写事实。**不硬造一行**（与规则页同款口径）。
2. **只回显不改判** —— 命中才切、无命中不切**仍是 R39 原口径**；条件求值在后端
   `core/condition.py`，FE 连第二遍条件都不扫。轨迹是那次解析的**事实记录**，不是新的判定点。
3. **`回到上一条 (UNDO)` 只改状态条、不清轨迹** —— 撤回的是「切指令」这个动作，
   规则与输入都没变，那次解析为什么命中仍是真的。

**清理口径**：一次解析开始就 `setRouteTrace([])`、失败也清 —— **不残留上一次的轨迹**
（否则失败时会把上一次成功的三行留在屏上，读者会以为是本次结果）。

**落点**：轨迹块挂在**状态条下方、与 `routeExpanded` 无关** —— 结论属于状态条那一层，
收起输入表是为让出执行区高度，不该把结论一起收走。`data-testid="route-trace-{n}"`
与规则页 `dry-trace-{n}` **同形不同名**（同一页两个 testid 前缀会撞）。

### 四 · 红测先行有据

新增 **8 条**（util 3 + 页面 5），实现前 **7 红 1 绿**：

| 档 | 条数 | 明细 |
|---|---|---|
| 缺特性（真红测） | **7** | util 3 条整文件加载即红 —— `describeTrace does not provide an export named 'describeTrace'`；页面 4 条 `Unable to find an element with the text: 逐条判定轨迹 (TRACE) …` |
| 护栏（实现前即绿） | **1** | 「回执不带 `trace` → 不出块」—— 实现前本就没有轨迹块，断言自然成立；**如实登记，不冒充红测** |
| 测试随新事实改写 | **0** | 本批没有既有断言被新事实推翻 |
| 测试自身 bug 先修 | **0** | 本批无 |

页面 5 条覆盖：命中出块 + `MATCHED` 黄字 + 真切指令 / 码走同一张码表（中文 + `detail` 接尾 +
**不认识的码原样透出不猜**）/ 无命中也出轨迹且**仍不切指令** / 旧后端不带 `trace` 不出块 /
失败清轨迹。

**验收**：BE **1033/1033 持平**（零改动）· FE **1473 → 1481/1481（95 文件，+8）** ·
`npx vite build` EXIT=0 · `npm run lint` EXIT=0（0 问题 0 警告）· yorha-ui 校验器改动
**4 个 js / jsx + 1 json 文件 0 违规** · `ev40` TOTAL_PROBLEMS=0 · `ev33` STAGED=0 BAD=0 ·
**零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、无新 pip 依赖、
`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径一行未动**。

> **FE 全量首跑出过 1 条 `Terminal.test.jsx` 历史预览红**（`Unable to find an element with the
> text: AA 55 ……`）—— **与 R44 §8.76 登记的是同一条**，本批未触碰该页；单跑 29/29 绿，
> 随后**两次全量 95 文件 1481 条全绿**。按**测试抖动**记账：不改测试、不改实现，如实登记。

### 五 · 实机冒烟（后端 8055 + dev 5174 · 回收站清零）

三条规则各占一类 —— `R45 smoke A`（`meter_id == 1`，启用）、`R45 smoke B`（`line == 1`，变量
不在输入）、`R45 smoke C`（同 A 条件，**停用**）。`POST /dispatch/routed` 先把回执看清楚：

| 输入 | 状态条 | 轨迹 |
|---|---|---|
| `meter_id=999` | 无命中 —— 扫过 2 条规则都不成立，维持当前指令不猜 | #1 `比较不成立` · #2 `变量不在本次输入里：line` · #3 `已停用（不参与匹配）` |
| `meter_id=1` | 命中规则「R45 smoke A」→ 已切到指令「示例心跳帧」 | #1 `判真命中`**黄字** · #2 #3 `未轮到 —— 前面已有命中，按 first-match-wins 不再看` |
| 点 `回到上一条 (UNDO)` | 已回到指令「示例心跳帧」 | **轨迹仍三行**（边界 ③） |

**控制台做了 A/B 对照**（本批唯一一处需要定性的 error）：带 R45 的页面出 2 条
`Failed to load resource: 404` → `git stash` 暂存两份运行时改动、同一 URL 重开一页 →
**同样出 2 条**，且都是 `GET /response-specs/{instruction_id} 404`（该指令无存档应答规格，
FE 自 P2 起就按 404 当「未配置」处理，测试里也这么 mock）。**定性 = 既有口径，本批新增 0 error。**
清场后规则表 `[]`、**回收站 0 条**，8055 / 5174 两个后台壳已停。

> `git stash` 往返把两份文件写成了 CRLF（各 326 / 221 行）—— 当场转回 LF 并复核，
> 提交前字节核验 BAD=0。

### 六 · 明确留白（本批不做）

- **输入表不做持久化**（§8.71 七 同款留白）、**校验器 md 口径**（改仓外 skill 须另议）—— 不涉；
- **不为轨迹块做折叠 / 虚拟列表** —— 规则条数目前个位数，未见上限问题；条数真上来再说，
  不预设不存在的性能问题；
- **轨迹不进 `pageStatus` 之外的任何持久面** —— 它是回执的瞬时呈现，不落库、不进导出包。

**文档同步（同批）**：§1 新增 `R45` 行 + §8.77 本节 + §8.75 七 留白改指；`PROJECT_HANDOVER.md`
新条目 94 + 条目 92 留白改指 + 目录地图 `routeResolve.js` / `InstructionProcessor.jsx` 两行；
`pageStatus.json` `/processing` 补记 + `/routing` 的 `nextSteps` 改指，并
`npm run sync:page-status` 重生成 `PAGE_STATUS.md`。

**R45 ✅ —— 解析发生在哪一页，「为什么」就在哪一页读得到，而且是同一张表。**

## 8.78 R46 TIME 字段点击范围收窄（只有值区才开时间配置弹窗 · 2026-10-07）

### 一 · 来源（实机反馈直提，无既有登记项）

2026-10-07 实机手工验证 `/processing` 时当场反馈，两句原话指的是同一件事：

> 对于时间类型的字段，希望点击这个元素才出现标记 —— 指值区那块
> `div.flex-1.flex.items-stretch`（里面是取值框 + 年份后缀）

> 现在是点击整个元素都会出现时间配置弹窗 —— 指整行
> `div.flex.items-stretch.relative`（种类章 + IF 角标 + 标签 + 值区 + `[TIME_PICKER]` 徽标）

**无既有登记项** —— R36–R45 的留白到 R45 收口时已全部销完，这是新报上来的交互问题，
不是某条留白的正主。

**2026-10-07 question 工具回执拍板其作 R46**（原拍板给 R46 的「输入表持久化」顺延 R47，
校验器 md 口径仍待另议）。

### 二 · 改动（1 个实现文件 + 2 个测试文件，纯 FE）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `frontend/src/components/InstructionForm/SmartInput.jsx` | 最外层 div 的 `onClick` 去掉开弹窗那一支、只留字节定位选中；值区 `div.flex-1` 新挂 `onClick` | 触发点从整行收窄到值区 |
| `frontend/src/components/InstructionForm/__tests__/SmartInput.test.jsx` | 新增 3 条（值区 / 标签 / 徽标） | 单元级锁「谁能把弹窗叫出来」 |
| `frontend/src/pages/__tests__/InstructionProcessor.test.jsx` | 新增 2 条（点标签不弹 / 点值区弹） | 页面级锁实机反馈那句话 |

**改前**：`onClick`（`RunnerFieldTree.handleTimeClick` → `onOpenDatePicker`）与 `onSelect`
两个回调**同挂最外层 div**，所以整行任意位置点下去都同时做两件事。
**改后**：开弹窗只由**值区**触发，字节定位选中**仍在最外层**。

### 三 · 三条边界

1. **字节定位选中仍是全行语义** —— 点标签、点右徽标、点值区都会高亮字节 + 出读数条。
   第 4 批 #2 的既有用例「点字段出 `SEL :: 字段名 · 偏移 · 长度`」**一次不改全绿**。
2. **值区不 `stopPropagation`** —— 点值区先开弹窗，事件继续冒泡到外层的 `onSelect`，
   两件事一起；原外层那句 `e.stopPropagation()` 随 `onClick` 一起退场，但
   `RunnerFieldTree` 叶行外层的 `stopPropagation()` 仍在，「嵌套组内选中不被外层组 id
   覆盖成整组」的既有隔离不受影响。
3. **非 TIME 字段零变化** —— 它们的 `onClick` 本就是 `undefined`，值区不挂处理器；
   可编辑字段的聚焦、键入、类型徽标与长度徽标照旧。

### 四 · 红测先行有据

新增 **5 条**（`SmartInput.test.jsx` 3 + `InstructionProcessor.test.jsx` 2），
实现前 **3 红 2 绿**：

| 档 | 条数 | 明细 |
|---|---|---|
| 缺特性（真红测） | **3** | 单元级点标签 / 点徽标 `expected "vi.fn()" to not be called at all, but actually been called 1 times` ×2；页面级点标签 `expected <span …></span> to be null` —— 三条红因同为「触发点还没收到值区」 |
| 护栏（实现前即绿） | **2** | 单元级与页面级各一条「点值区 → 开时间配置弹窗」：改前整行就开，断言自然成立；**如实登记，不冒充红测** |
| 测试随新事实改写 | **0** | 本批没有既有断言被新事实推翻 |
| 测试自身 bug 先修 | **0** | 本批无 |

**验收**：BE **1033/1033 持平**（零改动）· FE **1481 → 1486/1486（95 文件，+5）** ·
`npx vite build` EXIT=0 · `npm run lint` EXIT=0（0 问题 0 警告）· yorha-ui 校验器改动
**3 个 js / jsx + 1 json 文件 0 违规** · `ev40` TOTAL_PROBLEMS=0 · `ev33` STAGED=0 BAD=0 ·
**零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、无新 pip 依赖、
`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径一行未动**。

> **FE 全量跑了三遍**：两遍 **95 文件 1486 条全绿**；一遍出 1 failed —— 正是 R44 §8.76 与
> R45 §8.77 都登记过的那条 `Terminal.test.jsx` 历史预览抖动
> （`Unable to find an element with the text: AA 55 ……`），本批未触碰该页，
> **单跑 29/29 绿**。按**测试抖动**记账：不改测试、不改实现，如实登记。

### 五 · 实机冒烟（后端 8055 + dev 5174 · 零数据改动）

选中「示例心跳帧」（TIME 字段 `运行秒数`，`base_time` 折算显示 `2025`），三态：

| 操作 | 时间配置弹窗 | 字节定位 |
|---|---|---|
| 点**标签** `运行秒数` | **不出** | `SEL :: 运行秒数 · 0X05-0X08 · 4B` + 该字段导轨亮（边界 ①） |
| 点**值区**（取值框 + 年份后缀） | **出** —— `时间配置 (TEMPORAL)` · 年 月 日 时 分 秒 · 取消 确认 | 同上照旧 |
| 点右徽标 `[TIME_PICKER]` | **不出** | 定位保留（边界 ①） |

**控制台 0 条新增 error** —— 只有 2 条 `GET /response-specs/sample-inst-heartbeat 404`，
与 R45 §8.77 已做 A/B 对照定性的是同一类（该指令无存档应答规格，FE 自 P2 起按 404 当
「未配置」处理）。本批只改点击目标，**不创建、不删除任何数据**，无需清场。

### 六 · 明确留白（本批不做）

- **输入表持久化**（原定 R46，已顺延 **R47**）→ **R47 已落地 ✅（2026-10-07，§8.79）**；
  **校验器 md 口径**（改仓外 skill 须另议）—— 不涉；
- **不给值区加额外 hover 高亮 / 点击提示** —— 整行已有 `cursor-pointer hover:bg-nier-light/5`，
  不为一次范围收窄新增视觉层；
- **不改字节定位选中的全行语义** —— 要把它一并收窄到值区属于另一件事，另议排批。

**文档同步（同批）**：§1 新增 `R46` 行 + §8.78 本节；`PROJECT_HANDOVER.md` 新条目 95；
`pageStatus.json` `/processing` 补记一条，并 `npm run sync:page-status` 重生成 `PAGE_STATUS.md`
（R36–R45 的留白改指**一条都不涉及** —— 本批无既有登记项可销）。

**R46 ✅ —— 点哪一块就是哪一块：只有值区才弹时间配置，点标签与徽标只是把字节定位到那一行。**

## 8.79 R47 输入表持久化（两页共用一份本机草稿 · 2026-10-07）

**批次**：2026-10-07 · **纯 FE，零 DDL、零 BE 改动** —— 落盘走浏览器 `localStorage`，后端一行
未碰，`POST /dispatch/routed` 本批连调都不调。`models.py` 无改列改表、**无 Migration、
无 `chore(db)`**、不引 pytest、无新 pip 依赖，`processor.py` / `graph.py` / `Blueprint.jsx`
未碰，**`/dispatch` 缺省口径一行未动**。

### 一 · 来源（§8.71 七 第 4 条留白：R39 登记、R46 批内顺延）

R39 建「路由输入」时把这条挂在 §8.71 七：

> **输入表不做持久化**：本仓前端**零 `localStorage` 先例**，本批不为此新引一种落盘样式；
> 刷新即回到一行空输入。真要常驻站点参数（表号、线别），**另开一批连「谁清、谁改」一起拍**。

R46 批内（2026-10-07）由 question 工具回执把它排为 R47（原拍板给 R46 的正是这一条），本批
落地 —— **销的就是这一条**。它同时在 §8.72 / §8.75 / §8.76 / §8.77 / §8.78 各批留白里被
以「§8.71 七 同款留白」的字样反复引用，那些是各批自己当时的口径记录，**只在正主处销一次**。

### 二 · 拍板（question 回执一次问齐三问）

| 问 | 拍板 |
|---|---|
| 存哪几列（行的存取范围） | **整表原样存（含空行）** —— 存进去什么读回来就什么，不补行不筛行 |
| 加工页与规则页存一份还是两份 | **两页共用一份** —— 单点槽，切页接着用 |
| 存多久、谁清谁改 | **localStorage + 显式「清空输入 (CLEAR)」按钮** —— 键入即写，按钮主动清 |

### 三 · 改动（1 个新文件 + 2 个页面 + 2 个测试文件，纯 FE）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `frontend/src/utils/routeInputsPersist.js` | **新建**：`ROUTE_INPUTS_KEY` + `loadRouteInputs` / `saveRouteInputs` / `clearRouteInputs` | 落盘收在一处，两页不各排各的 |
| `frontend/src/pages/InstructionProcessor.jsx` | `routeRows` 改读槽 + 行变更口 `handleRouteRows` + `handleClearRouteInputs` + 清空按钮 | 加工页那一侧接线 |
| `frontend/src/pages/RoutingRules.jsx` | `dryRows` 同上（`handleDryRows` / `handleClearDryInputs`）+ 清空按钮 | 规则页那一侧接线 |
| `frontend/src/utils/__tests__/routeInputsPersist.test.js` | **新建** 9 条 | 单元级锁「存什么读什么 + 存储故障不抛」 |
| 两个页面测试文件 | 各 3 条 + 文件级 `beforeEach` 清库 | 页面级锁同槽回显与清空入口 |

**实现要点两句话**：读用 `useState(() => loadRouteInputs() ?? emptyRouteInputs())` 惰性初始化
（每页挂载读一次，切页即重读 —— 两页互不常驻，所以「共用」的就是那个槽）；写挂在**唯一的行
变更口**上 —— 改键值、加行、删行三条路都走 `handleRouteRows` / `handleDryRows`，否则
「改的存了、加的没存」会读回一张对不上的表。`routeResolve.js` 的解析口径（键去空白、空键不发、
值按 JSON 标量）**一行未动**，本层只管数据进出。

### 四 · 三条边界

1. **「存什么读什么」与「默认一行」是两件事** —— 读回 `null`（没存过）才给
   `emptyRouteInputs()`；形状合法的空数组原样给空数组（本层不臆造行）；行不是
   `{key, value}` 字符串的一律当「没存过」——宁可回默认一行，也不回半张表。
2. **存储故障只降级不报错** —— `getItem` / `setItem` / `removeItem` 全部 try/catch：
   隐私模式读不到、配额满写不进、本机那份被改坏，都当「本机没存过」，输入表照常打开
   —— **表打不开比表是空的严重得多**。
3. **清空只清输入** —— 删本机槽 + 屏上回默认一行空行；解析状态条、逐条判定轨迹、UNDO、
   选中指令、规则表、表单与顺序草稿都与输入无关，一并不动；也**不做二次确认**
   （清的是本机草稿，不删任何后端数据，删完 ADD 还能加回来）。

### 五 · 红测先行有据

新增 **15 条**（新文件 9 + 加工页 3 + 规则页 3），实现前 **15 红 0 绿**：

| 档 | 条数 | 明细 |
|---|---|---|
| 缺特性（真红测） | **15** | 单元 9 条整文件红（`routeInputsPersist` 模块不存在）；页面 6 条 = `expected null to be truthy` ×2（键入没落盘）、`expected '' to be 'meter_id'` ×2（本机那份没回显）、`Unable to find … name "清空输入 (CLEAR)"` ×2（清空入口缺失） |
| 护栏（实现前即绿） | **0** | 本批没有 |
| 测试随新事实改写 | **0** | 既有断言零改动 |
| 测试自身 bug 先修 | **0** | 本批无 |

**另有一处新增钩子，单列不冒充红测**：两个页面测试文件各加一条文件级
`beforeEach(() => window.localStorage.clear())` —— 引入「键入即写」后，同文件先跑的用例会
把行留给后跑的用例，「空输入表 / 0 项有效」这类既有断言会被上一条的残留带偏。这是隔离不是
改动断言：加钩子前后，两文件的既有用例**全绿且一条没改**。

**验收**：BE **1033/1033 持平**（零改动）· FE **1486 → 1501/1501（96 文件，+15，+1 文件）** ·
`npx vite build` EXIT=0 · `npm run lint` EXIT=0（0 问题 0 警告）· yorha-ui 校验器改动
**6 个 js / jsx + 1 json 文件 0 违规** · `ev40` TOTAL_PROBLEMS=0 · `ev33` STAGED=0 BAD=0 ·
**零 DDL → 无 Migration、无 `chore(db)`**、不引 pytest、无新 pip 依赖、
`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、**`/dispatch` 缺省口径一行未动**。

### 六 · 实机冒烟（后端 8055 + dev 5174 · 后端与库零改动）

| 操作 | 结果 |
|---|---|
| 加工页键入 `meter_id = 0001`，再点 `+ 添加 ADD` | 本机槽是**两行**（含空行），状态条 `1 项有效` |
| 切到规则页 `/routing` | **原样回显同两行**（同槽共用），状态条同为 `1 项有效` |
| 点 `清空输入 (CLEAR)` | 槽归 `null`，屏上回默认**一行空行** |
| 再键入两行 → **刷新页面** | 两行仍在（本机槽跨刷新） |
| 回加工页 `/processing` | 同槽回显；再点清空 → 槽 `null`、回默认一行，**解析按钮与选中指令 `ID: SAMPLE-INST-HEARTBEAT` 都不动** |

**控制台 0 条新增 error** —— 只有 2 条 `GET /response-specs/sample-inst-heartbeat 404`，与
R45 §8.77 已做 A/B 对照定性的是同一类。冒烟全程**没点任何解析 / 试解析 / 新建规则按钮**，
后端与库零改动，写进本机槽的两行也已随最后一步清空，无需清场。

### 七 · 明确留白（本批不做）

- **不在状态条加一行「存本机」常驻提示** —— 显式清空入口已经把「有一份本机草稿」摆在屏上，
  再加常驻提示属于文案扩面，另议排批；
- **清空不做二次确认** —— 现在直接生效（口径见边界 ③），要改成「点了先问一句」另议；
- **校验器 md 口径**（改仓外 skill 须另议）不涉 ——
  **→ R48 已落地 ✅（2026-10-07，§8.80，仓外 skill 改动已获用户授权）**；
  `byte_order` trim 归一等其余留白未动。

**文档同步（同批）**：§1 新增 `R47` 行 + §8.79 本节；**销 §8.71 七 第 4 条**（原文就地标注
→ R47 已落地）与 §8.78 六 的顺延项就地标注已收口；`PROJECT_HANDOVER.md` 条目 96；
`pageStatus.json` 的 `/processing` 与 `/routing` 各补记一条，并 `npm run sync:page-status`
重生成 `PAGE_STATUS.md`。

**R47 ✅ —— 表号不用再打第二遍：切页、刷新都还在，清空是一下子的事。**

## 8.80 R48 校验器 md 口径（`.md` 纳入 · 只扫围栏代码块 · 2026-10-07）

**批次**：2026-10-07 · **仓外 skill 改动（用户已授权）+ 仓内新增可复跑测试 · 零 DDL、
零 BE 改动、零 FE 业务代码改动** —— 动的是 `~/.agents/skills/yorha-ui`，仓内只多一个
测试脚本与一份 fixture 数据；`models.py` 无改列改表、**无 Migration、无 `chore(db)`**、
不引 pytest、无新 pip 依赖，`processor.py` / `graph.py` / `Blueprint.jsx` 未碰，
**`/dispatch` 缺省口径一行未动**。

### 一 · 来源与拍板（§8.73 八 与 HANDOVER 条目 90 两处同挂的留白正主）

R41（§8.73 八）原文：

> **校验器 md 口径**：那 34 条历史 CSS 字样（`rounded-sm` / `shadow-md` …，全是当年「改掉它」
> 的史实记述）要让 md 过检须二选一 —— 改写史实措辞，或给校验器 md 规则加白名单；后者改的是
> **仓外** `~/.agents/skills/yorha-ui`，**另议**。

2026-10-07 question 回执**拍板选此题并授权改仓外 skill**（余三候选：输入表持久化 → 已顺延
R47 ✅、`Terminal.test.jsx` 抖动治理、暂不排批）。两问一次问齐：

| 问 | 拍板 |
|---|---|
| `.md` 纳入后扫描面取哪一种 | **只扫围栏代码块，散文不看** |
| 固定验收是否把 md 传进校验器 | **传，且传全仓 md** |

**摸底先取数再定口径**（初测的「16 份」含 2 份 `venv` 第三方 LICENSE —— 本地虚拟环境、
不进 git、换台机器就不存在，已从枚举排除；终值 **14 份，与 `git ls-files` 同数**）：

| 事实 | 数 |
|---|---|
| 仓内 md / 围栏块 | **14 份 / 26 个** |
| 围栏语言直方图 | `bash` 11 · 无标注 7 · `sql` 2 · `json` 2 · `mermaid` 2 · `python` 1 · `typescript` 1 |
| 进扫描面的围栏（样式 / 标记语言，含别名） | **1 个**（`typescript` 标注，其内 0 违规） |
| 散文里的历史 CSS 字样 | 34 条（与 R41 登记同源，PLAN + HANDOVER 两处） |
| 同一批文件按**整文件判**（R48 之前的行为） | **3 文件 36 条**（PLAN_Backlog 21 / PROJECT_HANDOVER 13 / PLAN_InstructionManagement 2），命中 `NO_BORDER_RADIUS` `NO_BOX_SHADOW` `NO_GLASSMORPHISM` `NO_SOFT_SAAS_PADDING` 四族 |
| 按**围栏口径判**（目标） | **0 条** |

于是三条路里取**第三条**：① 改写史实措辞（丢掉 `p-6 → p-3` 这类具体证据）、② 加白名单
（仓外 skill 要长期养一份清单）都不要，**③ 把扫描面收到围栏代码块** —— 散文与行内代码是
「当年改掉它」的**记述**，围栏块才是**可复制的活标记**。二选一因此**都不必发生**，
这一条留白也由此销掉。

### 二 · 改动（仓外 3 个文件 + 仓内 1 个测试 + 6 份 fixture 数据）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `~/.agents/skills/yorha-ui/scripts/validate-yorha-ui.mjs` | `SCANNED_EXTENSIONS` 加 `.md` / `.markdown`；新增 `validateMarkdown`（围栏抽取 `extractMarkdownFences` + 语言判定 `markdownStyleLanguage` + 行号回贴 `fenceLineNumber`）与分流口 `validateSource(name, source)`；`formatReport` 对带行号的违规多出一行 `Line: N (md fence)`；`printUsage` 与文件头写明 md 口径 | md 只是**多一个扫描面**，判据仍是一条规则链 |
| `~/.agents/skills/yorha-ui/references/rules.md` | 新增 **§9 Markdown scan surface (Markdown 口径)** | 校验器文件头指向它，不留空指针 |
| `~/.agents/skills/yorha-ui/SKILL.md` | 工作流第 4 步补一句「`.md` 也接受，只判围栏块」 | 读 skill 的人知道 md 怎么判 |
| `scripts/test-yorha-md-validator.mjs`（仓内 · 新） | 8 条断言的可复跑测试 | **仓外 skill 改动不进本仓提交**，用它当防回滚护栏 |
| `scripts/fixtures/md-validator/*.txt`（仓内 · 新 6 份） | 故意违规的 fixture 数据 | 放置理由见「三 · 2」 |

**判据一个字没动**：`validateYoRHaCode`（8 条规则 + advisory + 去重）**逐字未改**，md 走
的正是它。`main` 原先一律 `validateYoRHaCode(code)`，现改 `validateSource(name, code)`；
非 md 文件分流后**回到原来那一行**，js / css 行为零变化。

### 三 · 四条边界

1. **只认反引号围栏，且必须带语言标注** —— `~~~` 围栏与四空格缩进代码块**按散文处理**
   （fail-open：宁可漏判也不误判文档）；围栏标注是裸 token（`css`），查集合前先归一成
   带点扩展名（`.css`），`typescript` / `javascript` / `tailwind` 等 GitHub 别名另走
   `MD_LANGUAGE_ALIASES`。
2. **fixture 放数据文件是刻意放置，不是掩盖** —— fixture **必须**含违规样式（否则测不到
   东西），而校验器对 `.mjs` 是**全文判**（它连自己的源码都判出 8 条：正则字面量里全是
   `box-shadow` 这类词）。内联进测试源码 → 这个文件自己 9 条违规，「改动文件 0 违规」
   当场不成立；写成仓内 `.md` → 被「全仓 md 0 违规」那条断言反过来咬住。故放
   `scripts/fixtures/md-validator/*.txt` —— `.txt` **不在** `SCANNED_EXTENSIONS` 里。
   哪天扫描面扩到 `.txt`，这条会当场叫出来，不会被悄悄漏过去。
3. **行号只在 md 出现** —— `Line: N (md fence)` 的 N = 围栏起始行 + 块内偏移；match 文本
   在块里对不上时退回块起始行（宁可粗也别错）。非 md 文件不带这一行。
4. **仓外改动不进本仓提交** —— skill 是共享资产，本仓只记**事实（口径 + 取数 + 对照）**
   与**可复跑测试**；改动要点写在本节，日后据此可与仓外那份逐条比对或重建。

### 四 · 红测先行有据

新增 `scripts/test-yorha-md-validator.mjs`，**实现落笔前先证红**（7 条）：

| 档 | 条数 | 明细 |
|---|---|---|
| 缺特性（真红测） | **3** | ② md 违规输出带行号（当时压根没有「md 行号」这回事）；④ 散文 / 行内 / 无标注 / bash / json 围栏应为 0，却被整文件判咬出 **6 条**；⑦ 全仓 md 应为 0，实为 **3 文件 36 条** |
| 护栏（实现前即绿） | **4** | ① css 围栏违规能被抓到、③ html 围栏能被抓到、⑤ 干净 md 为 0、⑥ js 既有违规照旧 —— **整文件判本来就会命中这四处**，属已有特性，**不冒充红测** |
| 测试自身 bug 先修 | **1** | 首跑 ⑥ 的 js fixture 写成 camelCase（`boxShadow` / `borderRadius`），而规则族只认 CSS 声明与 Tailwind 类名 → **先修 fixture 再算数** |
| 测试随新事实改写 | **0** | 无既有断言被改 |

**实现中被红测当场抓到 1 个 bug**：围栏语言是裸 token `css`，样式集合里却是 `.css`、
别名表又漏了 `css` → **css 块根本不判**（html 恰好在别名表里才通过）。修法 = 查集合前
先把裸 token 归一成带点扩展名。**实现后追加 1 条 `typescript` 别名护栏**（刚修的正是这条
脆弱路径），**如实单列，不冒充红测**。终态 **8/8 绿**。

**验收**：BE **1033/1033 持平**（零改动）· FE **1501/1501 持平**（零改动）·
`npx vite build` EXIT=0 · `npm run lint` EXIT=0（0 问题 0 警告）· yorha-ui 校验器
（1 个 `test-yorha-md-validator.mjs` + **全仓 14 份 md**）**0 违规** · md 口径测试 **8/8** ·
`ev40` TOTAL_PROBLEMS=0 · `ev33` STAGED=0 BAD=0 · **零 DDL → 无 Migration、无 `chore(db)`**、
不引 pytest、无新 pip 依赖、`processor.py` / `graph.py` / `Blueprint.jsx` 未碰、
**`/dispatch` 缺省口径一行未动**。

**自检取证（证明没引入新违规）**：拿改后的校验器扫**它自己那份 skill 目录** —— 同一批文件按
**旧行为（整文件判）** 是 **41 条**、按**新行为** 是 **9 条**：其中 8 条是
`validate-yorha-ui.mjs` 自身源码里的正则字面量（`.mjs` 分流路径一行未改，纯既有问题），
1 条是 `components.md` 围栏里的既有示例（整文件判下是 2 条，收窄后剩 1 条）。
**净变化 = 未新增任何违规，反而少了 32 条误判。**

### 五 · 人工验证（无应用代码改动 → 不做浏览器冒烟）

本批**零页面能力变化、零请求、零后端改动**，浏览器里没有可验的新东西，故不启 8055 / 5174。
人工验证改以三件**可复跑**的事实为准：① `node scripts/test-yorha-md-validator.mjs` →
**8/8**（跑一次就是一次验证）；② 校验器对**全仓 14 份 md** → **0 违规**；③ skill 自检
**旧 41 → 新 9** 的对照。`pageStatus.json` 与生成物 `docs/PAGE_STATUS.md` **双双不动** ——
与 R35 §8.67「五」同款理由：不给任何一页新增能力，塞进任一页的 `availableNow` 都是张冠李戴。

### 六 · 固定验收清单自此演进

自 R48 起 = BE 全量 + FE 全量 + `npx vite build` + `npm run lint` +
**yorha-ui 校验器（本批改动的 js / jsx / json + 全仓 md）** +
**md 口径测试 `node scripts/test-yorha-md-validator.mjs`** +
`ev40` md 表列数 mismatches = 0 + `ev33` 索引卫生 BAD = 0。
§8.70 八 那段「只传 js / jsx / json」的旧口径已就地标注改指，原样留档不改写。

### 七 · 明确留白（本批不做）

- **skill 自检那 9 条既有违规不在本批范围** —— 8 条 validator 自身源码的正则字面量 +
  1 条 `components.md` 围栏示例，**都早于 R48**；要收须改 skill 内容（那是内容问题不是
  口径问题），**另议排批**；
- **`~~~` 围栏与缩进代码块不判**（fail-open），要认它们另议；
- **`.txt` 等其余非扫描扩展名不纳入** —— 一旦纳入，fixture 的放置就要重议（见「三 · 2」）。

**文档同步（同批）**：§1 新增 `R48` 行 + §8.80 本节；**销 §8.73 八 第 1 条**（原文就地标注
→ R48 已落地、实走第三条路）+ §8.70 八 校验器口径注就地标注改指 + §8.79 七 的「md 口径不涉」
就地标注已收口；§8.67 末尾补注**过期悬账（R35 人工验证点）就地销掉**；
`PROJECT_HANDOVER.md` 新增条目 97 + 条目 90 留白处销项；`pageStatus.json` 不动（理由见「五」）。

**R48 ✅ —— md 进了校验器：散文还是散文，围栏才是代码。**

## 9. 保留勿动（非任务，勿清理）

- `backend/core/processor.py` / `graph.py` 未接线（Phase-2 遗留，保留勿删，
  勿引入新依赖）
- `pymysql` 保留；`backend/db/yorha.db` git 跟踪；`/dispatch` 文档口径
  自 E2-T5 起更新为「默认进程内环回 + 可切换 TCP/串口真实传输」
