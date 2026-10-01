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
> **范围外保持现状**：bits=64（byte_len=8）仍走整数路径 / BE zeros（float64 不在
> E1-4 范围，如需另立）；矛盾 type=float/string/hex 模板不会产生，FE 走既有分支、
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
> 口径）不重复排。
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

## 9. 保留勿动（非任务，勿清理）

- `backend/core/processor.py` / `graph.py` 未接线（Phase-2 遗留，保留勿删，
  勿引入新依赖）
- `pymysql` 保留；`backend/db/yorha.db` git 跟踪；`/dispatch` 文档口径
  自 E2-T5 起更新为「默认进程内环回 + 可切换 TCP/串口真实传输」
