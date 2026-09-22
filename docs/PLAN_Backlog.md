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
- 解禁 `backend/db/models.py`：**仅限 E4 绑定持久化新表**（不改既有表结构，
  SQLite `create_all` 自动建表）。
- 其余硬约束继续有效：不碰 `processor.py` / `graph.py` / `Blueprint.jsx`；
  不移除 `pymysql`；`yorha.db` 保持 git 跟踪；`/dispatch` 环回口径在 E2-T5
  真实传输落地前不变；提交时机 = 每批人工验证后。

## 1. 批次总览与执行顺序

| 批次 | 内容 | 状态 |
|---|---|---|
| M1 | A1 加工页 refs 无 formula 修复 + C1 指令页测试债 + C2 位域后端强校验 | 🔄 实现完成，待人工验证 |
| M2 | C3 数据中心页一期 + C4 协议页测试收敛 + C5 编排回归 + C6 加工页渲染下沉 + C7 隐式约定收敛 + C8 README 同步 | ⬜ |
| E1 | B1 B2–B8 真实编码语义（6 子项，双端编码器解禁） | ⬜ |
| E2 | B2 传输层 T1→T2→T3→T4→T5（T2 TCP 无依赖先行，T3 串口 pyserial） | ⬜ |
| E3 | B3 通讯调试页 /terminal 实装（依赖 E2） | ⬜ |
| E4 | B4 编排绑定持久化（甲案：新表） | ⬜ |

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

- **E1-1** B5 INT_SIGNED 按位宽补码（替换 `Math.abs`）
- **E1-2** B6 `endianness=LITTLE` 真实字节序反转
- **E1-3** B3 BCD_CODE 打包 + B4 SCALED factor/offset 定标
- **E1-4** B2 FLOAT_IEEE（float32）
- **E1-5** B7 ARRAY_GROUP repeat 展开 N 次 ⚠️ **联动**：`byteOffsets` /
  编排页 `getTotalBytes` / 指令页 LEN 三处总长口径同步改 + Phase 1 测试更新
- **E1-6** B8 TIME_ACCUMULATOR / AUTO_COUNTER 语义生效（base_time / step / max）

## 5. E2 明细（传输层）

- **T1** transport 抽象：loopback 保留为默认模式（`/dispatch` 口径不变）
- **T2** TCP 模式（socket 标准库，无新依赖）：host/port/超时/连接状态事件
- **T3** 串口模式（**pyserial，已解禁**）：COM/波特率/校验/停止位
- **T4** `POST /transport/config` API + 发送历史三类事件（原始/响应/错误）
- **T5** 文档口径更新（真实传输落地后才改 /dispatch 描述）

## 6. E3 明细（/terminal 通讯调试页）

- 通讯配置模型 UI（串口参数/目标地址/发送模式，接 E2 配置 API）
- 三面板：发送历史 / 原始报文 / 响应与错误日志
- 验收：`pageStatus.json` `terminal.implemented` → true，人工验证清单过

## 7. E4 明细（编排绑定持久化，甲案）

- `models.py` 新表 `ProtocolBinding`（不改既有表；`create_all` 自动建表）
- 新端点 CRUD（绑定 = protocol_id + instruction_id + 插槽序）+ 编排页读写接线
- 验收：刷新/重启后 bindings 仍在；编排页行为回归

## 8. 保留勿动（非任务，勿清理）

- `backend/core/processor.py` / `graph.py` 未接线（Phase-2 遗留，保留勿删，
  勿引入新依赖）
- `pymysql` 保留；`backend/db/yorha.db` git 跟踪；`/dispatch` 文档口径
  在 E2-T5 前固定为进程内环回
