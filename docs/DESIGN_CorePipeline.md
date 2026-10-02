# 实施设计：指令—协议封装主管线（Core Pipeline）

> 创建于 2026-09-24。依据 `docs/DESIGN_Decisions.md` 已拍板结论（D1–D12 于
> 2026-09-24 全选 A；**D13 于 2026-10-01 拍板 = A 封装配方**，见 §9）。
> 本文 = 目标数据模型（DDL 草案）+ 三时间点量归属表 + 校验责任表 + 引用完整性
> 矩阵 + 分批实施与验收标准。硬约束沿 `docs/PLAN_Backlog.md` §0：
> `models.py` 仅新增表/列（启动自愈补列先例 `ensure_protocol_version_column`）、
> 不碰 `processor.py` / `graph.py` / `Blueprint.jsx`、`/dispatch` 既有口径不变
> （新增能力走**可选字段/新端点**，缺省行为逐字节兼容）、一批一提交、
> 含 DDL 的批次 yorha.db 单独同步提交。

## 1. 目标管线（拍板后定稿）

```
设计期                     编译期                        发送期
────────                   ────────                     ────────
指令管理  → instruction ─┐
                        ├→ POST /compile/wrapped ─→ 完整帧 → transport → 应答
协议定义  → protocol  ───┤      (frame_builder)                    ↓
编排绑定  → binding  ────┘      后端唯一封装入口          response_spec(由协议生成,D5)
指令加工  → params ───→ 内核帧 ─┘
```

- **封装唯一入口** = 后端 `core/frame_builder.py`（D4-A）：四条发送路径
  （`/dispatch`、`/dispatch/transaction`、序列 Runner、日志回放）+ 编排导出
  + 加工页预览全部经它；前端 `blockMerge` 降级为**同源预览镜像**（有单测锁双端一致）。
- **前端预览、后端定稿**（D11-A）：预览失配可容忍，**发送产物以后端为准**；
  E1 批次建立的双端向量表在收敛完成前**继续双跑**，不撤。→ **D11-① 已实施
  （CP2b，2026-10-01）**：双跑从「两端各抄一张表」改为**同读一份
  `vectors/*.json`**（新增向量只写一处），② 发送前比对 / ③ 全量替换不在本期。
- **协议单层 + 容器嵌套**（D2-A）：不做跨协议引用，复用靠复制（批次三 P1-1 已有）。

## 2. D1 落地：绑定模型（DDL 草案）

`protocol_bindings` **仅新增三列**（SQLite `ALTER TABLE ADD COLUMN`，由启动自愈补列，
镜像 `database.ensure_protocol_version_column`；存量行默认值回填）：

```sql
ALTER TABLE protocol_bindings ADD COLUMN slot_id   TEXT    NULL;     -- 显式目标槽节点 id
ALTER TABLE protocol_bindings ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;  -- 该指令的默认封装协议
ALTER TABLE protocol_bindings ADD COLUMN priority   INTEGER NOT NULL DEFAULT 0;  -- 多候选择序（大者先）
-- 每指令至多一个默认协议（部分唯一索引，SQLite 3.8+ 支持）
CREATE UNIQUE INDEX IF NOT EXISTS ux_bindings_default
    ON protocol_bindings(instruction_id) WHERE is_default = 1;
```

**语义**（一行 = 一条关系，两用列各司其职）：

| 用途 | 读哪些列 | 消费方 |
|---|---|---|
| 填槽关系（现状） | `protocol_id + instruction_id + slot_order`（`slot_id` 为空时按稠密序号 `slot_order` 找洞，**与现状逐字节一致**） | 编排页分组填洞、`frame_builder` |
| 显式槽位（新增） | `slot_id` 非空 → 直接锚定协议树节点，优先于 `slot_order`；协议删槽后 `slot_id` 悬空 → 校验报错（不静默回退） | `frame_builder`、绑定矩阵视图 |
| 默认协议（新增） | 每 `instruction_id` 取 `is_default=1` 那行的 `protocol_id` | 加工页封装预览/发送、事务、序列 |

**基数约定**：~~`(protocol_id, instruction_id)` 至多一行（防重复填洞）~~ **撤销**
（2026-09-24 批次一实施确认，见 PLAN_Backlog §8.8 偏离注记 1：编排页「同协议
多绑定依洞填装」本为一对多语义，加唯一约束会破坏既有行为；防重复收敛到两个
部分唯一索引）；一条指令可出现在多个协议的绑定里，`is_default=1` 每指令全局
唯一（`ux_bindings_default` 兜底），协议内显式 `slot_id` 不重复
（`ux_bindings_slot` 兜底）。

**写路径**：`routers/binding.py` 现有 CRUD 扩展——`POST/PUT` 接受三个新字段
（缺省 None = 不改，沿用 E4 局部更新口径）；设默认时事务内先清同指令旧默认；
`GET /bindings` 回带新列。前端编排页：绑定行加「默认 ★」切换；加工页挂载拉
`GET /bindings?instruction_id=` 取默认协议（**加载失败降级裸发 + 侧栏提示**，
沿编排页降级先例）。

## 3. D3 落地：插槽契约（零 DDL，`parameter_config` 扩展）

`config/blockTypes.js` slot 块新增三字段（存 `parameter_config`，`ProtocolNodeSchema`
已透传 `parameter_config`，**无 DDL**）：

| 键 | 类型 | 缺省（= 现状口径，存量零回归） | 含义 |
|---|---|---|---|
| `max_bytes` | int \| null | `null`（不限） | 注入载荷字节上限 |
| `accepts` | string[] | `[]`（不限） | 可注入指令的 `device_code` 白名单（D10-A 的近似表达） |
| `fit_policy` | `{overflow, underflow}` | `{overflow:'append', underflow:'zero_fill'}` = 现状静默口径 | 溢出：`append`\|`reject`；欠载：`zero_fill`\|`reject` |

- `frame_builder` 强制执行：`reject` → 报错（HTTP 400 detail / 预览 red banner），
  含槽 id 与实际/允许字节数；`append`/`zero_fill` 保留现状行为并给 **warning 徽标**。
- `validateProtocol` 新增 warning：`max_bytes` 小于已知注入下限、`slot_id` 悬空。
- 新建槽 UI 默认建议 `reject`，存量槽不动（选项 A 的「默认取现状」条款）。

## 4. D4/D11 落地：frame_builder 与编译权威

**`backend/core/frame_builder.py`（新文件）**：

```python
def build_wrapped(protocol_tree, instruction_ids, bindings, *, now=None) -> WrapResult:
    """协议树 + 绑定填槽 → 完整帧。语义逐条镜像前端 blockMerge.mergeProtocolInstruction：
    按 (slot_id ?? slot_order) DFS 填洞 / 溢出与欠载按 fit_policy / 填槽记改写表
    （槽 p-id → 注入 i-ids）供 refs 展开 → length/checksum PASS1/PASS2 真值重算
    （复用 orchestrator.handlers，含「槽可被 length 引用」新语义）。"""
```

- **纯函数**，不碰 DB、不碰 transport；`WrapResult = {hex, byte_count, warnings, errors}`。
- 语义锚定：`blockMerge.test.js` 现有 27 例语义**移植为后端向量**
  （`backend/tests/test_frame_builder.py`，同一组用例双端各钉一份，改一必改二 —— 沿
  E1 向量表先例）。

> **实施偏离（2026-09-24 批次一，详见 PLAN_Backlog §8.8 偏离注记 2）**：实际签名
> `build_wrapped(protocol_children, payloads, slot_ids=None, start_order=0) ->
> {"hex", "total_length", "warnings"}` —— 指令编码留在前端（既有 encodeInstruction
> 链路），后端入参收**已编码内核 hex 载荷**；同因 `POST /compile/wrapped` 请求形为
> `{protocol_id, payloads, slot_ids?, start_order?}`（非「instruction_id + 参数」）。
> 取舍 = D4-A/D11-A 分批收敛：本批先收**封装唯一入口**（协议树查库 + 洞位分配 +
> length/checksum 真值重算恒在后端），编译权威全量收敛（前端仅乐观预览）留后批。

**接线（缺省全兼容）**：

| 消费方 | 改动 | 兼容口径 |
|---|---|---|
| `POST /dispatch` | `DispatchRequest` 增可选 `wrap: {protocol_id, slot_bindings?}`；缺省 = 现裸帧路径零改 | 既有调用/测试逐字节不变 |
| `POST /dispatch/transaction` | 同上可选 `wrap` | 同上 |
| 序列 Runner | `sequence_steps` 冻结 payload 口径不变；**序列级封装已随 3c 落地**（步骤级可选 `wrap` + `plan` 扩外壳逐层区间，见 §7 批次三 / §9.7 3c） | 未封装步骤逐字节不变 |
| 日志回放 | 回放已落库 `hex_string`，原样重发（帧已封装过），**不套** | 零改 |
| `POST /compile/wrapped`（新） | 加工页/编排页预览与「定稿」：传 instruction_id + 参数 → 返回内核帧 + 完整帧 | 新端点，无存量影响 |
| 编排页「封装试发」 | 改调 `/compile/wrapped` 定稿再 `/dispatch`（或直接带 `wrap`） | 行为等价（同源后） |

## 5. 三时间点量归属表（D6-A 成文）

| 量 | 设计期（管理/协议页） | 编译期（加工填参 / 序列保存） | 发送期 |
|---|---|---|---|
| 块结构 / 字节布局 | 定义（instruction_fields / protocols.children） | 派生 byteOffsets | 不变 |
| 静态值 / fixed | 定义 hex | 直接输出 | 不变 |
| 输入参数 | 默认值 | **加工页**：用户输入即定值；**序列**：冻结进 `params` | 序列按 `plan` 不重算参数（已拍板口径，P3） |
| LENGTH | 显示 `??` / Σ 下限 | 按 refs 算（填槽前） | **frame_builder 注入后真值重算**（含槽 refs 改写） |
| CHECKSUM | `??` | 内核帧反算 | **封装帧整体反算**（协议外壳 refs 纳入 span） |
| TIME_ACCUMULATOR | 基准 `base_time` | 差值预览 | 发送墙钟重算（序列 `plan.dynamic` 已实现；加工页即时编译天然满足） |
| AUTO_COUNTER | start/step/max | 当前值 | 序列按发送重算；加工页手动推进 |
| **封装帧** | 协议树 + 槽契约（结构） | **不定值**（无参数参与外壳） | **每次发送即时编译**；序列冻结封装帧 = **3c 已落地**（保存冻结 payload_full + `plan.shell` 逐层 length/checksum 区间，发送期切回内核按配方重算 → 冻结 vs 重算分离） |
| 应答规格（D5-A） | 协议定义派生初值 | 手工增量覆盖 | 匹配引擎消费（现状 `response_match`） |

> 规则一句话：**结构在设计期定、值在编译期定、时间性量与封装在发送期定。**

## 6. 校验责任表（D8-A）与引用完整性矩阵（D12-A）

### 6.1 三层校验

| 层 | 拦什么 | 强制侧 | 现状 → 目标 |
|---|---|---|---|
| 保存时（结构） | 位域重叠/超容量、refs 悬空/自引、hex 非法、version 冲突 | **后端** 400/409（前端 `validateInstruction`/`validateProtocol` 前置同文案） | ✅ 已有 |
| 绑定时（关系） | `slot_id` 存在、`accepts` 白名单命中、默认唯一、`(protocol, instruction)` 重复 | **后端**（`routers/binding.py`，同事务） | ✅ 批次一落地（`validate_binding` + 部分唯一索引兜底） |
| 发送时（值） | 溢出/欠载 `fit_policy`、长度自洽、校验和必算 | **后端**（`frame_builder`，预览同步给 warning） | ✅ **批次二落地（CP2）**：三态执行，`reject` → 400（缺省 `append`/`zero_fill` 仍只 warning） |

> **第四层「配方期（组合）」由 D13 增设**，见 §9.5（stage 协议存在 / stage 0 槽与
> 内核载荷匹配 / `definition_hash` 失效告警 / 层数上限）。

### 6.2 删除 × 引用矩阵

| 删除对象 | protocol_bindings | response_specs | sequence_steps | dispatch_logs | 处置 |
|---|---|---|---|---|---|
| **指令** | 级联删 | 级联删 | **失效标记不阻断**（宿主悬空打徽标 + 该步骤编辑降只读，零 DDL；**D14 ② 拍板**） | 只读保留（id/name 已冗余存文本） | 批次二：删前 `GET` 引用计数 → 弹窗警示（镜像协议页 P0-1）+ **活配置**后端同事务级联兜底 |
| **协议** | 级联删（已有 P0-1） | — | —（序列存内核帧，不含协议） | 只读保留 | ✅ 已有 |
| **槽节点**（协议内删块） | `slot_id` 悬空 → 置 NULL 并回执 warning（不静默：回执带 N） | — | — | — | 批次二随绑定矩阵 |

## 7. 分批实施与验收标准

> 节奏沿仓库纪律：实现 → 前后端全量测试 EXIT=0 → `vite build` EXIT=0 →
> yorha-ui 校验器 0 新增违规 → 文档同步（pageStatus/PAGE_STATUS/BACKLOG）→
> 人工验证 → **一批一提交**；含 DDL 批次 yorha.db 单独同步提交。
>
> **D13 配方并入本节「批次三（演进）」扩容**（2026-10-01 排批确认）：3a/3b/3c
> 子批见下，明细与验收见 §9.7；**硬前置 = 本节批次二**（复用其 `fit_policy=reject`
> 执行分支，避免同一段代码改两次）。

### 批次一（主线闭环：绑定 → 封装 → 发送）★ 首批

> **进度（2026-09-24）**：1a–1d 全部实现，自动化验收全绿 —— BE **296/296**、
> FE **542/542（40 文件）**、`vite build` EXIT=0、yorha-ui 校验器 0 违规；
> 本批含 DDL（三列 + 两部分唯一索引） → yorha.db 沿先例单独同步提交。
> 两处实施偏离（撤销「(protocol_id, instruction_id) 至多一行」基数约束 /
> `build_wrapped` 收已编码内核 hex 载荷签名）见 `PLAN_Backlog.md` §8.8。
> 待人工验证 → 一批一提交。

- **1a 数据层（DDL）**：`protocol_bindings` 三列 + 部分唯一索引 + 启动自愈补列
  （镜像 `ensure_protocol_version_column`，幂等/表缺 no-op）；`binding.py` 三字段
  CRUD + 设默认事务清旧默认；绑定期关系校验（6.1 第二行）。
  验收：`test_bindings.py` 扩例（新字段透传 / 设默认清旧 / 唯一索引冲突 400 /
  存量行缺省回填 / 重启持久化）；补列自愈单测（镜像 `test_protocol_version`）。
- **1b frame_builder**：`core/frame_builder.py` + `test_frame_builder.py`
  （blockMerge 27 例语义移植双端钉死）+ `/compile/wrapped` 端点。
  验收：同输入双端 byte-equal；溢出/欠载现状口径（append/zero_fill）回归锚。
- **1c 发送接线**：`/dispatch`、`/dispatch/transaction` 可选 `wrap` 字段
  （缺省零改）；加工页右侧新增「封装预览」（默认协议帧 + 完整帧对照，
  按 §2 读 `is_default`）与「封装发送」开关（默认开，无绑定/拉取失败降级裸发 + 提示）。
  验收：加工页测试（预览渲染 / 封装发送带 wrap / 降级裸发 / 开关切裸发）；
  `dispatch.py` 缺省裸帧既有测试**零改全绿**；curl 冒烟（带 wrap 往返 + 不带 wrap 回归）。
- **1d 文档**：pageStatus processing/orchestration 条目、PAGE_STATUS 生成器再生成、
  BACKLOG 批次表 +HANDOVER 待办同步；§5/§6 表随本文档引用。

### 批次二（防错）

> ✅ **已落地（CP2，2026-10-01）**：下三项全部实现并自动化全绿 —— BE **426/426**、
> FE **915/915（63 文件）**、`npx vite build` EXIT=0、yorha-ui 校验器 13 文件 0 违规；
> **零 DDL**（`models.py` 未动、`yorha.db` 不随本批提交），`/dispatch` 裸发缺省
> 口径逐字节不变。**人工验证 5 项已通过 → 已提交 `5afe706`（2026-10-01）。**
> 明细与验收见 `PLAN_Backlog.md` §8.19。
> D11-① 已拆出 **CP2b**（见下），未随本批实施 → **CP2b 已于同日实施完毕**
> （`PLAN_Backlog.md` §8.20，单一真相源 = 根目录 `vectors/`）。

- D3 槽契约执行（`fit_policy=reject` 生效 + warning 徽标 + 新建槽 UI 默认 reject）
  + D12 删除级联（指令删除引用计数弹窗 + 后端同事务级联，镜像 `test_protocol_delete.py`）。
  验收：`test_frame_builder` 契约用例（reject/append/zero_fill 三态 + accepts 拒）+
  `test_instruction_delete.py`（级联矩阵四表）；编排页溢出 warning 徽标测试。
- **转义层位统一**（2026-10-01 新发现，详见 `DESIGN_Decisions.md` D13「边界
  （转义）」）：编排页「封装试发」当前 = `/compile/wrapped` 出完整帧 → `/dispatch`
  **不带 wrap** → `escape` 收到**已封装整帧**，与带 `wrap` 的「只转内核」语义不一致
  （`escape` 缺省关闭时无影响，开启后两路径出字节不同）。改线为**带 `wrap` 下发**
  （复用批次一 1c 口径），层位统一「套壳前转义内核」。
  验收：`test_escape.py` 增「带 wrap / 不带 wrap 层位」用例；`escape` 开启 + 配方
  试发的字节与 `/dispatch` 带 wrap **byte-equal**；`escape` 关闭回归逐字节不变。
- **D14 三个口径（2026-10-01 拍板 = A/A/A，开工前置已满足）**，落地口径：
  ① **存量槽不迁移**（保持 `append`/`zero_fill`，本批只把静默变显式 = warning 徽标；
  新建槽 UI 默认 `reject`，与上第一条合并实现）；
  ② **删指令时 `sequence_steps` = 失效标记不阻断**（删前 `GET` 引用计数弹窗告知
  「N 条序列步骤引用本指令」→ 确认后**只删指令**；序列页宿主悬空打失效徽标 +
  该步骤编辑降只读，**零 DDL**，判据 = `instruction_id` 悬空读时 LEFT JOIN）；
  活配置（`protocol_bindings`/`response_specs`）**级联删**、日志（`dispatch_logs`）
  **只读保留** —— 与 §6.2 矩阵同步（矩阵原「级联删步骤」已按 D14 ② 修正）；
  ③ 转义层位 = **带 `wrap` 下发**（见上条）。
  验收：`test_instruction_delete.py` 覆盖三分口径（活配置删 / 步骤留 + 悬空标识 /
  日志留）+ 弹窗计数；**不存在「删指令连带改写已保存序列步骤」的用例**。
- **D11 分段 ①（共享 fixture 化）→ 2026-10-01 排批调整：拆为 CP2b**（随本批之后
  单独成批，**不阻塞 CP3**——CP3 只硬前置本批的 reject 分支）。拆批原因 = 成本
  重估：向量表含 `Infinity`/`NaN`/`true` 等**JSON 无法直接表达**的值，需先定
  跨语言特殊值约定再迁 ~13 组 / ~15 个测试文件，与本批「防错」主题不同、回归面
  独立。批次二（CP2）**只含防错**三项。明细见 `PLAN_Backlog.md` §1 CP2b。
  → ✅ **CP2b 已完成（2026-10-01）**：特殊值约定 = **`$v` 包装对象**，两端测试
  改读 `vectors/*.json`（15 表 / 19 文件），新增向量只写一处；
  明细见 `PLAN_Backlog.md` §8.20 与 `vectors/README.md`。

### 批次三（演进 · 2026-10-01 扩容：并入 D13 封装配方）

> **硬前置 = 批次二**（`fit_policy=reject` 执行分支被 3a 复用）。原三项保留，
> 其中 D7-A 拆两处：**配方消费方（stages hash）随 3a**、binding/
> response_spec 两处仍留本批末（3d）。
>
> ✅ **3a 已提交 `e63d76f`（代码+文档）/ `438f3af`（db 同步），2026-10-01**：
> **含 DDL** —— `frame_recipes` 新表 + `instructions.default_recipe_id` 补列自愈（`database.ensure_recipe_columns`，
> 镜像 `ensure_protocol_version_column` 先例）→ yorha.db 沿先例**单独同步提交**。
> 自动化全绿：BE **466/466**（基线 426 + 40）、FE **920/920（63 文件，基线 915 + 5）**、
> `npx vite build` EXIT=0、yorha-ui 校验器 0 违规；另跑**真路由冒烟 25 项 PASS**
> （单测直调函数验不到的路由注册 / 出线 JSON / 删除清引用 / 残留清零）。
> **两处实施注**（明细 `PLAN_Backlog.md` §8.21）：
> ① **`/dispatch`、`/dispatch/transaction` 的 `wrap.recipe_id` 接线提前并入 3a**
> —— 原属 3b，因加工页「预览 / TRANSMIT / 事务三路同参同字节」是批次一立下的
> 不变量，缺接线则配方态预览帧与出线帧**不同字节**；3b 因此只余编排页编辑器与
> 编排页试发改线；
> ② 配方路径 `fit_policy` 缺省 `reject` **溢出与欠载两侧都缺省**（§9.2 甲案的
> 「欠载留空 + warning」是缺省口径描述，本批按 §9.5-2 / D13「配方路径强制
> `reject`」执行；槽上**显式**配置仍照写生效，存量单协议路径缺省零改）。
>
> ✅ **3b 已提交 `c4b1f7f`（代码+文档），2026-10-01**：**纯前端批、零 DDL**（未改
> `models.py`/`database.py` → **无 `chore(db)` 提交**；`/dispatch` 缺省口径由既有
> 用例 + curl 裸帧回归**双钉**，未碰 `processor.py`/`graph.py`/`Blueprint.jsx`）。
> 编排页属性面板新增**分区 4/5「封装配方 (RECIPE)」**（§9.4）：有序 stage 加层 /
> 上移 / 下移 / 删层 + 选协议 + 选槽（位次 badge `#n` = 第 n 条载荷，**换协议即清槽**）、
> 层数 **1..4**、删层保底 1、**新建即 POST 落库**、手动保存 + `version` **409**、
> 配方脏稿纳入 `beforeunload` 且**禁切换 / 禁新建 / 禁试发**；**未建配方时编辑器不占
> 任何 select** → 既有「四分区 select = 3」用例**零改全绿**。头部 `WRAP :: 配方` 来源
> 指示（改名未保存即时跟随）；**试发改走配方** = `wrap.recipe_id`（**不下发
> `slot_ids`/`start_order`**），未选配方 = 原组协议参数对象**逐字不变**。另补**关联指令
> 下拉**（加工页降级链第 1 级的读入口）—— 换绑须**先清旧指针再设新指针**
> （`_link_instruction` 不回清旧指针，否则破 `RecipeResponse`「0 或 1 条」不变量）。
> 终态：FE **924/924（基线 920 + 4）**、BE 466/466、`vite build` EXIT=0、校验器 0 违规、
> **真 curl 冒烟 13 项 ALL PASS**（真 uvicorn + `curl.exe`）。明细 `PLAN_Backlog.md` §8.22。
>
> ✅ **3c 已提交 `fbad083`（代码+文档）/ `17c6830`（db 同步），2026-10-01**：
> **含 DDL** —— `sequence_steps` 新增 `wrap JSON` 单列自愈（`database.
> ensure_sequence_step_columns`，镜像 3a `ensure_recipe_columns` 先例）→ yorha.db
> 沿先例**单独同步提交**。步骤级可选 `wrap:{recipe_id}`，**冻结 vs 重算分离**（D6-B）：
> ① **保存期** 入参先 `normalize_plan` 归一 → 有 `wrap` 即切内核 + `compile_recipe` →
> `shell_plan` 注入 **`plan.shell`**（每层 length/checksum 的**本帧坐标**区间）→ 完整帧
> 二次归一后冻结进 `payload`，`wrap = {recipe_id, definition_hash}` 落库（请求形只收
> `{recipe_id}`，未知键 400；`definition_hash`/`stale` 属响应形）；
> ② **发送期** `_frame_for_send` 分支 —— 无 shell = `apply_plan → 整帧转义`
> （**逐字节不变**，`test_bare_frame_path_unchanged` 口径不受影响）；有 shell =
> `kernel_slice → 内核侧 apply_plan → 内核转义 → compile_wrap 套壳 → 整帧出线`
> （层位同 dispatch「先转内核再套壳」），编译失败记 `WRAP: {原因}`（与 `PLAN:`/`TRANSPORT:` 三分）；
> ③ **读侧** `_wrap_with_stale` 按 recipe_id 比 `current_fingerprint`（配方 stages 或所引
> 协议任一改动 → `stale=true` 徽标点亮，**不阻断运行**）；
> ④ **回退** 传 `plan` 带 shell 但 `wrap` 缺席/null → 按旧区间切回内核 + `core_plan`
> 剥 shell —— 两种前端形态均幂等，**前端只透传不计算**。
> 前端 = 配方选择器 + `WRAP :: <配方名>` 回显（卡片 + 编辑器头部）+ `stale` 徽标 +
> `plan.shell` 层摘要（新纯函数 `shellSummary`），**`buildPlan` 输出键集一行未改**
> （shell 由后端注入 = 单一真相源，另有用例钉死键集）。
> 终态：BE **496/496（基线 466 + 30）**、FE **932/932（63 文件，基线 924 + 8）**、
> `npx vite build` EXIT=0、yorha-ui 校验器 4 文件 0 违规、**真路由冒烟 30 项 ALL PASS**
> + **真浏览器 UI 验证 6 项通过**。明细 `PLAN_Backlog.md` §8.23。

- **3a 配方数据层 + 串行编译**（详见 §9.1–§9.3、§9.5）：`frame_recipes` 新表 +
  `instructions.default_recipe_id` 补列自愈 + `/recipes` CRUD + `/compile/wrapped`
  `recipe_id` 串行编译 + `stages[]` 分层回显 + `definition_hash` 回写/比对 +
  加工页分层堆叠预览与降级链三级。
- **3b 配方编辑器 + 发送接线**（详见 §9.4、§9.3）：编排页配方编辑器（有序 stage
  增删/排序/选槽/手动保存/离开拦截）+ `/dispatch`、`/dispatch/transaction` 接
  `recipe_id` + 试发改走配方。
- **3c 序列封装帧 D6-B**（与配方合流，详见 §9.7）：步骤级可选 `wrap: {recipe_id}` +
  保存冻结完整帧 + `plan` 扩外壳 length/checksum **逐层区间**；沿 `normalize_plan`
  键集纪律。
- **3d 应答与失效徽标**（**前置 = D15 已拍板 A**，2026-10-01）：
  D5-A 协议页「据此生成 response_spec」（fixed→echo_header / length→length /
  checksum→checksum 映射，生成后可手工改，落 `response_specs` upsert）——
  **按 D15-A 实施**：`response_specs` 增 `stage` 列（仅新增列），「据此生成」
  **按配方每层各执行一次**，`response_match` 按 `stages` **逆序解包**逐层跑
  五要素（无配方 = 单层退化，存量零改）；**不得按 D5 原字面的单层生成实现**。
  + D7-A 余下两处失效徽标（binding / response_spec）。

  验收：`test_frame_recipes.py` 与 `test_wrap_api.py` 扩例、配方三层帧主向量
  三端钉死、**生成映射按层用例 + 多层应答（外壳帧 → 逆序解包 → 内层五要素）
  匹配用例 + 单层存量退化回归**、序列封装往返过 `match_response`、
  hash 失效/不失配徽标用例（子批明细见 §9.7）。

  > ✅ **3d 已提交 `PENDING_FEAT`（代码+文档）/ `PENDING_DB`（db 同步），2026-10-01**：
  > **含 DDL** —— `response_specs.stage` + `response_specs.definition_hash`、
  > `protocol_bindings.definition_hash` 共 **3 列、仅新增列**（新建
  > `database.ensure_response_spec_columns`，`ensure_binding_columns` 扩第 4 列，
  > `main.py` lifespan 接线）→ yorha.db 沿 3a/3c 先例**手工只跑这 3 条 ALTER**后
  > **单独同步提交**（不带任何业务行变动）。
  > ① **D5-A 按 D15-A 修订实施** —— 新建 `core/response_generate.py`：
  > `resolve_layers`（默认配方 → 逐层 / 默认协议 → 单层 / 皆无 → 400）→ 每层按
  > **fixed→`echo_header_bytes`、length→`length_element`、checksum→`checksum_element`**
  > 各映射一次 → **每层一份 spec 塞 `stages[]`**（`stage` = 落库的那层序号；**1 层
  > 不写 `stages` 键**，天然退化成存量形），生成后 `normalize_spec` 归一 +
  > `chain_fingerprint` 记出处（解析不出 → `definition_hash = NULL`）。
  > ② **`response_match` 逆序解包** —— spec 带 `stages` 时按 **i = n-1 → 0** 逐层跑
  > 五要素（head/trailer **同时剥 `received`/`sent`**，reasons 前缀 `STAGE[i].`），
  > 顶层禁 echo/length/checksum；**无 `stages` 键走原单帧路径逐字节不变**
  > （`test_bare_frame_path_unchanged` 钉死口径）。**后插槽字段**（绝对位置无法
  > 静态定位）新增 `offset_from_end` / `field_offset_from_end`，与绝对
  > `offset`/`field_offset` 互斥（非 0 同给 → 400）。
  > ③ **D7-A 余下两处失效徽标** —— `POST /response-specs/{instruction_id}/generate`
  > 写 spec + stage + 出处，`GET /response-specs/targets?protocol_id=` 给候选
  > （`uses_protocol` 前置，声明在 `/{instruction_id}` 之前）；绑定**创建记出处、
  > 仅 `protocol_id` 真变时重记**（改 label/priority 不抹提示）；读侧 `stale`
  > **三态**（NULL 出处 → `None`、链解析不出 → `true`、比对一致 → `false`），
  > **前端只在 `stale === true` 出琥珀徽标**（binding / response_spec 两处同口径）。
  > 终态：BE **537/537**（基线 496 + 41）、FE **944/944**（63 文件，基线 932 + 12）、
  > `npx vite build` EXIT=0、yorha-ui 校验器 8 文件 0 违规、**真路由冒烟 43 项
  > ALL PASS**（真 uvicorn：无链 400 / 三层生成 / 逆序解包失配出 `STAGE[0].` /
  > 改协议两处同时 stale / 手工 PUT 保留出处）。明细 `PLAN_Backlog.md` §8.24。

### 批次四（治理）

- 关系数据导入导出（bindings + response_specs 并入 DataHub ZIP 或独立包）、
- D9/D10 文档划界落 README/PAGE_STATUS、绑定矩阵视图（指令 → 默认协议 → 槽位）、
- D8 校验表全量核对（逐行「已有/已补」销项）。

## 8. 明确不做（本次拍板范围外）

- 跨协议引用 `PROTOCOL_REF`（D2-B）：**2026-10-01 经 D13 改判**——真实形态为
  「外壳套外壳」，但组合机制走**封装配方 + 串行编译**（§9），`PROTOCOL_REF` 挂起，
  重开条件四条见 `DESIGN_Decisions.md` D13；
- 协议携带传输配置（D9-B）、协议 `device_code`（D10-B）：等绑定矩阵落地后再议；
- 应答双向协议树解码（D5-B）：D5-A 生成机制不够用时再升级 —— **注意 D15-A
  （应答按配方逐层解包）不属「不做」**，它是 D5-A 的实施口径、已排进 3d；
- 传输层 / 通讯调试页任何改动（本设计全程不碰 transport）。

---

## 9. D13 落地：封装配方（frame_recipes）

> 依据 `DESIGN_Decisions.md` D13（2026-10-01 拍板 = **A 封装配方 + 串行编译**）。
> 真实形态 = **丙「外壳套外壳」**：内核 → 应用壳 → 链路壳各自独立定义、发送期
> 叠加。硬约束沿 §0 与 `PLAN_Backlog.md` §0：`models.py` 仅新增表/列、
> `/dispatch` 既有口径不变（新增走可选字段）、不碰 `processor.py`/`graph.py`/
> `Blueprint.jsx`、一批一提交、含 DDL 批次 yorha.db 单独同步提交。
>
> **核心取巧点**：`build_wrapped` 收与出**都是 hex 字符串**，第 n 层的输出直接
> 喂第 n+1 层的 `payloads` → **`frame_builder.py` 一行不改**；配方是有序数组，
> **环在结构上不可能存在**，故无需拓扑求值、无需放开 refs 跨树、双端编译器不动。

### 9.1 数据模型（新表 + 一列，均为允许项）

```sql
-- 新表（SQLite create_all 自动建表，镜像 sequences / sequence_steps 先例）
CREATE TABLE IF NOT EXISTS frame_recipes (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    stages      TEXT NOT NULL,   -- JSON 数组（有序：index 0 = 最内层，直接包内核）
    version     INTEGER NOT NULL DEFAULT 1,  -- 镜像 protocols.version 乐观并发
    created_at  TEXT,
    updated_at  TEXT
);
-- 每指令至多一个默认配方（单列 = 结构上天然唯一，无需部分唯一索引）
ALTER TABLE instructions ADD COLUMN default_recipe_id TEXT NULL;  -- 启动自愈补列
```

- **补列自愈**镜像 `ensure_protocol_version_column` / `ensure_binding_columns`
  （幂等、表缺 no-op、存量行回填 NULL）；
- **写路径**：新 `routers/recipe.py`（CRUD，命名沿 `/recipes`）；
  `schemas/recipe_api.py` 出线 `stages`（服务端解析校验，非裸字符串）；
- **`protocol_bindings` 不动**（D13 关联 D1）：它继续管第 0 层填洞，
  配方是其上的**新一层关系**，两者互斥消费、非叠加。

**`stages` 单项形态**：

```json
[{"protocol_id": "proto-app",  "slot_ids": ["p-slot-a"], "definition_hash": "sha256:…"},
 {"protocol_id": "proto-link", "slot_ids": ["p-slot-x"], "definition_hash": "sha256:…"}]
```

| 键 | 类型 | 语义 |
|---|---|---|
| `protocol_id` | string 必填 | 该层外壳（一棵独立协议树，落库校验存在性 404） |
| `slot_ids` | string[] 可空 | 该层承载槽，**位置对应 payloads**；空/缺省 = 稠密位次（镜像 `build_wrapped(start_order)` 口径） |
| `definition_hash` | string 服务端回写 | 该层协议的结构指纹，**保存与编译时由后端算并回写**，非用户输入 |

### 9.2 阶段载荷口径（首批取甲案）

| 案 | 内容 | 结论 |
|---|---|---|
| **甲（首批）** | **stage 0 的 `payloads` = 内核载荷组**（编排页组填洞语义，可多条指令）；**stage n≥1 的 `payloads` = 仅 `[前层输出]`**，占该层承载槽；该层若还有其他槽 → 欠载留空（发射归零）并出 warning | 形态丙够用，语义与 `build_wrapped` 现状逐条一致 |
| 乙（后续） | `slot_ids` 升级为 `slots: [{slot_id, source: prev\|kernel\|常量}]`，支持一层多载荷 | 出现真实需求再扩，**本期不做** |

### 9.3 编译入口、降级链与分层回显

**编译算法**（`routers/compile.py` 内串行，镜像 §4 接线口径）：

```
frame ← 内核组 hex（既有 encodeInstruction / 编排组）
for i, stage in enumerate(recipe.stages):
    payloads   ← 内核载荷组 if i == 0 else [frame]
    start_ord  ← 请求 start_order if i == 0 else 0
    out ← build_wrapped(load(stage.protocol_id).children, payloads,
                        slot_ids=stage.slot_ids, start_order=start_ord)
    frame ← out.hex；阶段回显 append({protocol_id, hex, total_length, warnings})
return {hex: frame, total_length, warnings, stages: [...]}
```

**端点契约**（全部为**可选字段**，缺省口径逐字节不变）：

| 端点 | 改动 | 兼容口径 |
|---|---|---|
| `POST /compile/wrapped` | 请求增 `recipe_id`（与 `protocol_id` **互斥**，都不给 → 400）；响应增 `stages[]`，`hex`/`total_length` 仍为**最终帧** | 旧调用方零改（字段恒在、语义不变） |
| `POST /dispatch`、`/dispatch/transaction` | `WrapSpec{protocol_id?, recipe_id?, slot_id?, slot_order?}`，`recipe_id` 优先 | 都不带 → 裸帧**逐字节现状**（硬约束） |
| `/recipes`（新） | CRUD + `?instruction_id=` 过滤（镜像 `/bindings` 先例） | 新端点 |

**降级链**（加工页 wrap 状态机扩枚举，互斥取第一个命中）：
`配方(recipe) → 默认协议(protocol, is_default) → 裸发(none)`；拉取失败仍 `failed`
→ 降级裸发 + 侧栏提示（沿批次一 1c 口径，不新造交互）。

### 9.4 UI 归属

| 页面 | 承担 | 依据 |
|---|---|---|
| **编排绑定页** | **配方编辑器**：有序 stage 列表（加层/上移/下移/删层 + 选协议 + 选槽）、`/recipes` 手动保存（沿本页 SAVE 底置范式）、试发走 `compileWrapped({recipe_id})` | 它本就是「壳 + 核组合」页；D9 划界协议页只管线帧格式 |
| **指令加工页** | PROTOCOL WRAP 分区**两栏 → 分层堆叠**：每层一行（协议 label + 该层 hex + 该层 LEN/CRC 卡面回显 + 洞位 warnings + 相对上层的字节差 Δ），300ms 防抖调 `/compile/wrapped` 与发送同参同字节；hash 失效出徽标 | 复用协议页卡面取值口径（`??` / 真值）与批次一预览防抖 |
| **协议定义页** | **不动** | 层仍是一棵独立的树 |

### 9.5 校验与防错（本批必须同做，否则配方 = 静默错帧制造器）

1. **`definition_hash` 提前到本批**（原 D7-A 排批次三）：配方是跨协议依赖，
   子协议一改下层帧静默变。→ 编译/加载时后端比对，不符出「配方已失效」
   **warning 不阻断**（D7-A 口径）。**hash 只在后端算**（`frame_builder` 权威、
   加工页预览也走后端），前端只比对字符串 → 免去 D7 原担心的「双端同构」成本；
2. **配方路径 `fit_policy` 缺省 `reject`** —— **主动偏离 D3「默认取现状零回归」**：
   该约束只管存量槽与存量路径，配方**零存量**；多层下溢出 append 的字节会被下一层
   当正常载荷收下，错误被放大。→ 复用批次二落地的执行分支（**故本批排在批次二之后**）；
3. **D8 三层校验表增第四行**：

| 层 | 拦什么 | 强制侧 |
|---|---|---|
| 保存时（结构） | 位域/refs/hex/version | 后端 400/409 ✅ |
| 绑定时（关系） | 槽存在、accepts 命中、默认唯一 | 后端 ✅（批次一） |
| 发送时（值） | fit_policy、长度自洽、校验必算 | 后端 ✅（**批次二 CP2**） |
| **配方期（组合）** | stage 协议存在 404、stage 0 槽与内核载荷匹配、hash 失效告警、**层数上限（建议 ≤4）** | 后端（`/recipes` 保存 + `/compile/wrapped` 编译）**本批补** |

### 9.6 三时间点量归属表（§5）补一行

| 量 | 设计期 | 编译期 | 发送期 |
|---|---|---|---|
| **封装配方** | `stages` 结构 + 各层协议树 | `slot_ids` 冻结进配方（结构在设计期/保存期定） | **逐层即时编译**：每层 length/checksum 按该层注入后真值重算；`definition_hash` 每次比对 |

> 规则一句话的配方版：**配方的结构随协议定义走、层间装配随发送走。**

### 9.7 排批：并入批次三（2026-10-01 拍板确认）

> **硬前置 = 批次二**（`fit_policy=reject` 执行 + 槽契约 + 删除级联）：本节 3a
> 直接复用其 reject 分支，避免同一段代码改两次。批次三原三项（D5-A / D6-B /
> D7-A）全部保留，其中 **D6-B 就是 3c**、**D7-A 的配方消费方并入 3a**、
> **D7-A 余下两处与 D5-A 归 3d**（3d 前置 = **D15 已拍板 A**，D5-A 按其修订）。
> 总览见 §7「批次三」。

| 子批 | 内容 | 验收 |
|---|---|---|
| **3a 数据层 + 串行编译** ✅ 已提交 `e63d76f` + `438f3af`（2026-10-01） | `frame_recipes` DDL + `default_recipe_id` 补列自愈 + `/recipes` CRUD + `/compile/wrapped` `recipe_id` 串行编译 + `stages[]` 回显 + `definition_hash` 回写/比对 + 加工页分层堆叠预览与降级链三级。**实施时并入 3b 的 `dispatch` `wrap.recipe_id` 接线**（三路同字节所需，见 §7 3a 进度注 ①） | ✅ `test_frame_recipes.py` 新建（CRUD / 补列自愈幂等 / hash 回写与失效 / 层数上限 / stage 404 / version 409 / 删引用回执）、`test_wrap_api.py` 扩（**recipe 三层帧往返**、配方 vs 单协议**同内核 byte-equal 双跑**、配方路径缺省 `reject` 对照存量 warning、dispatch/事务带 recipe、缺省裸帧**零回归**）、FE `InstructionProcessor` 5 例（分层预览 + 失效徽标 + 降级三级）；三层帧主向量**一处钉死改一必改三** = `vectors/wrap.json` 表 `three`（沿 §7 共享向量先例） |
| **3b 配方编辑器 + 发送接线** ✅ 已提交 `c4b1f7f`（2026-10-01） | 编排页配方编辑器（有序 stage 增删/排序/选槽/手动保存/离开拦截 + 关联指令换绑）、~~`/dispatch` 与 `/dispatch/transaction` 接 `recipe_id`~~（**已提前随 3a 实施**）、试发改走配方（**未选配方 = 现状组协议逐字节不变**） | ✅ Orchestration 配方编辑 **4 例**（其余用例**零改**，含「四分区 select = 3」）、`dispatch.py` 缺省裸帧既有测试**零改全绿**、**curl 冒烟 13 项 ALL PASS**（真 uvicorn + `curl.exe`：带 recipe 往返 = 预览同字节 / 不带 wrap 裸帧回归 / 组协议回归 / 残留清零）；**零 DDL** |
| **3c 序列封装帧（D6-B）** ✅ 已提交 `fbad083` + `17c6830`（db），2026-10-01 | 序列步骤可选 `wrap: {recipe_id}`、保存冻结完整帧 + `plan` 扩外壳 length/checksum **逐层区间**（`plan.shell`）、发送按配方重算、读侧 `stale` 失效徽标、**含 DDL**（`sequence_steps.wrap` 单列自愈） | ✅ **自动化三项全过** —— ① 序列封装往返过 `match_response`（`test_sequence_wrap.py`：三层冻结帧 `sent == received` 且与主向量 `three` 同字节）；② **冻结 vs 重算用例**（内核 `plan.dynamic` 在套壳下重算 + 配方协议改动后重算、冻结 `payload`/`plan.shell` 字节不动）；③ **`normalize_plan` 键集纪律**（无 shell 时仍是 `{dynamic, checksum}`、未知键 400、嵌套不变量逐条、`core_plan`/`kernel_slice` 往返）；另补 `ensure_sequence_step_columns` **补列自愈四态**（镜像 `ensure_recipe_columns` 模板）；**真路由冒烟 30 项 + 真浏览器 UI 验证 6 项 ALL PASS** |
| **3d 应答与失效徽标（原批次三内容）** ✅ 已提交 `PENDING_FEAT` + `PENDING_DB`（db），2026-10-01 | **D5-A 按 D15-A 修订实施**：`response_specs` 增 `stage` 列 + 「据此生成」按配方每层各执行一次 + `response_match` 按 `stages` 逆序解包逐层跑五要素（无配方 = 单层退化）；D7-A 余下 binding/response_spec 两处失效徽标；**含 DDL**（3 列仅新增：`response_specs.stage` / `response_specs.definition_hash` / `protocol_bindings.definition_hash`） | ✅ ① **生成映射按层用例**（`test_response_generate.py` 新建 **41 例**：`resolve_layers` 三分支 / 每层 fixed→`echo_header_bytes`、length→`offset_val = A - head - trailer`、checksum→`span` 映射 / 引用不足与区间越界跳过出 warning / **单层不写 `stages` 键** / `chain_fingerprint` 失败回 NULL）；② **多层应答逆序解包匹配用例**（三层帧 `C008B005A0020102E0E1E2` 正向命中 + **改坏最内层 length → `MATCH_FAILED` 且 reasons 前缀 `STAGE[0].`** + 顶层要素禁用与 `mode` 禁 `echo` 校验）；③ **单层存量退化回归**（无 `stages` 走旧路径，`test_bare_frame_path_unchanged` 与存量 `response_match` 用例**零改全绿**）；④ **hash 失效/不失配徽标用例**（生成后 `stale=false` → 改协议 → spec 与 binding **同时 `stale=true`** → 回滚即复位；手工 PUT 保留出处、`stage` 镜像随 spec 重算）；FE 补 **12 例**（Protocol 6 + TransactionPanel 3 + Orchestration 3）；**真路由冒烟 43 项 ALL PASS** |

- **节奏**沿 §7：测试 EXIT=0 → `vite build` EXIT=0 → yorha-ui 校验器 0 违规 →
  文档同步 → 人工验证 → 一批一提交；**3a 含 DDL（新表 + 补列）→ yorha.db 单独同步提交**；
- **人工验证必查**：① 三层真实链路帧目视核对（载荷出现定界字节时设备是否异常 ——
  D13「有 LEN = 不需要转义」为经验判定）；② 分层堆叠视图逐层字节与协议页卡面一致；
  ③ 改动中间层协议 → 加工页失效徽标点亮；④ **3d 用真实应答帧核对**：设备回的
  外壳帧能否逆序解包、内层五要素命中；**应答是否也带转义字节**（D15 关联待确认项）；
  ⑤ **3c 序列封装**：序列页选配方 → APPLY → 保存，卡片字节数 = 冻结完整帧、`PLAN`
  摘要出 `SHELL L1..LN` 逐层 LEN/CRC 偏移（与后端 `shell_plan` 同坐标）；运行后
  逐步 `sent` 与冻结帧**同字节**（外壳重算等价）；改中间层协议 → `WRAP ::` 旁
  `stale` 徽标点亮；**未选配方步骤的 PUT 请求体与改前逐字节一致**。
  ✅ **3a①②③ / 3b①②③ / 3c⑤ 共 7 项已执行通过（2026-10-01）**；
  ④ **3d 真实应答帧核对已随 3d 冒烟执行（2026-10-01）** —— 三层应答帧
  `C008B005A0020102E0E1E2` 经 `stages` 逆序解包后内层五要素命中、最内层 length
  改坏即出 `STAGE[0].LENGTH_...`；「应答是否也带转义字节」一项**仍待真实设备确认**
  （`escape` 反转义未接进 `response_match`，见 §9.8 与 D15 关联待确认项）。

### 9.8 本期明确不做

- **转义（不新建能力）**：**已有 N4 实现**（`backend/core/escape.py`，配置骑传输
  配置 `escape` 段、**缺省关闭**、先转内核再套壳、壳域按线上字节重算），**不属配方
  范围** —— 配方链固定在第 0 层之前转义、stage 1…n 不再转义；不新建
  `output_transform`（满足 D13 重开条件 ④ 才另议）。**已知层位不一致**（封装试发
  路径对整帧转义，与 `/dispatch` 带 `wrap` 语义不同）建议并入批次二，详见
  `DESIGN_Decisions.md` D13「边界（转义）」；
- **多载荷 stage（9.2 乙案）**：形态丙单承载槽够用；
- 传输层进配方（D9 划界）；`PROTOCOL_REF`（D13 重开条件四条）；
- ~~应答规格生成（D5-A）、`definition_hash` 在 binding/response_spec 两处的失效徽标
  （D7-A 其余消费方）~~ —— **已随 3d 完成（2026-10-01）**：D5-A 按 **D15-A**
  （`stage` 列 + 按层生成 + `stages` 逆序解包）实施，D7-A 三处消费方（配方 /
  binding / response_spec）全数落地，见 §7 批次三 3d 进度注与 §9.7 3d 行；
  **唯一残留待确认项** = 应答是否也要反转义（见 §9.7 ④ 与 D15 关联项 1）；
