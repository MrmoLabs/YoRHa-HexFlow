# 实施设计：指令—协议封装主管线（Core Pipeline）

> 创建于 2026-09-24。依据 `docs/DESIGN_Decisions.md` 已拍板结论（12 条全选 A）。
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
  E1 批次建立的双端向量表在收敛完成前**继续双跑**，不撤。
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
| 序列 Runner | `sequence_steps` **不动**（冻结 payload 口径不变）；序列级封装为后续批（D6-B 条款，见 §7 批次三） | 零改 |
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
| **封装帧** | 协议树 + 槽契约（结构） | **不定值**（无参数参与外壳） | **每次发送即时编译**；序列冻结封装帧 = 批次三引入（保存冻结 payload_full + plan 扩外壳 length/checksum 区间） |
| 应答规格（D5-A） | 协议定义派生初值 | 手工增量覆盖 | 匹配引擎消费（现状 `response_match`） |

> 规则一句话：**结构在设计期定、值在编译期定、时间性量与封装在发送期定。**

## 6. 校验责任表（D8-A）与引用完整性矩阵（D12-A）

### 6.1 三层校验

| 层 | 拦什么 | 强制侧 | 现状 → 目标 |
|---|---|---|---|
| 保存时（结构） | 位域重叠/超容量、refs 悬空/自引、hex 非法、version 冲突 | **后端** 400/409（前端 `validateInstruction`/`validateProtocol` 前置同文案） | ✅ 已有 |
| 绑定时（关系） | `slot_id` 存在、`accepts` 白名单命中、默认唯一、`(protocol, instruction)` 重复 | **后端**（`routers/binding.py`，同事务） | ⬜ 批次一补 |
| 发送时（值） | 溢出/欠载 `fit_policy`、长度自洽、校验和必算 | **后端**（`frame_builder`，预览同步给 warning） | ⬜ 批次二补（批次一先 warning 不阻断） |

### 6.2 删除 × 引用矩阵

| 删除对象 | protocol_bindings | response_specs | sequence_steps | dispatch_logs | 处置 |
|---|---|---|---|---|---|
| **指令** | 级联删 | 级联删 | 级联删步骤（快照失去宿主） | 只读保留（id/name 已冗余存文本） | 批次二：删前 `GET` 引用计数 → 弹窗警示（镜像协议页 P0-1）+ 后端同事务级联兜底 |
| **协议** | 级联删（已有 P0-1） | — | —（序列存内核帧，不含协议） | 只读保留 | ✅ 已有 |
| **槽节点**（协议内删块） | `slot_id` 悬空 → 置 NULL 并回执 warning（不静默：回执带 N） | — | — | — | 批次二随绑定矩阵 |

## 7. 分批实施与验收标准

> 节奏沿仓库纪律：实现 → 前后端全量测试 EXIT=0 → `vite build` EXIT=0 →
> yorha-ui 校验器 0 新增违规 → 文档同步（pageStatus/PAGE_STATUS/BACKLOG）→
> 人工验证 → **一批一提交**；含 DDL 批次 yorha.db 单独同步提交。

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

- D3 槽契约执行（`fit_policy=reject` 生效 + warning 徽标 + 新建槽 UI 默认 reject）
  + D12 删除级联（指令删除引用计数弹窗 + 后端同事务级联，镜像 `test_protocol_delete.py`）。
  验收：`test_frame_builder` 契约用例（reject/append/zero_fill 三态 + accepts 拒）+
  `test_instruction_delete.py`（级联矩阵四表）；编排页溢出 warning 徽标测试。

### 批次三（演进）

- D5-A：协议页「据此生成 response_spec」（fixed→echo_header / length→length /
  checksum→checksum 映射，生成后可手工改，落 `response_specs` upsert）。
- D6-B：序列封装帧（步骤级可选 `wrap` 配置 + 保存冻结完整帧 + `plan` 扩外壳
  length/checksum 区间；沿 `normalize_plan` 键集纪律）。
- D7-A：`definition_hash`（指令/协议结构指纹）三处失效徽标（binding/sequence_step/
  response_spec），warning 不阻断。
  验收：生成映射用例、序列封装往返过 `match_response`、hash 失效/不失配徽标用例。

### 批次四（治理）

- 关系数据导入导出（bindings + response_specs 并入 DataHub ZIP 或独立包）、
- D9/D10 文档划界落 README/PAGE_STATUS、绑定矩阵视图（指令 → 默认协议 → 槽位）、
- D8 校验表全量核对（逐行「已有/已补」销项）。

## 8. 明确不做（本次拍板范围外）

- 跨协议引用 `PROTOCOL_REF`（D2-B）：无真实分层复用需求前不启动；
- 协议携带传输配置（D9-B）、协议 `device_code`（D10-B）：等绑定矩阵落地后再议；
- 应答双向协议树解码（D5-B）：D5-A 生成机制不够用时再升级；
- 传输层 / 通讯调试页任何改动（本设计全程不碰 transport）。
