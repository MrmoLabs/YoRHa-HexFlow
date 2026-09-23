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
| P2 | A 事务化发送引擎（应答匹配规则可配 + 超时重发 + RTT/成功率统计） | ✅ |
| P3 | B1 序列编排后端（新表 sequences / sequence_steps + 后台 Runner + 轮询状态 + 与手动发送互斥） | ⬜ |
| P4 | B2 序列编排前端（新菜单页「序列编排」，pageStatus 第 7 项，快捷键 F） | ⬜ |
| P5 | D 通讯日志落库 + 导出 + 回放（新表 dispatch_logs，三路写入，CSV/JSON 导出，日志重发） | ⬜ |

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
> 页面 `Terminal.jsx` 全量重写（弃 FeaturePlaceholder 占位，组件保留未删——仅此一
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

## 9. 保留勿动（非任务，勿清理）

- `backend/core/processor.py` / `graph.py` 未接线（Phase-2 遗留，保留勿删，
  勿引入新依赖）
- `pymysql` 保留；`backend/db/yorha.db` git 跟踪；`/dispatch` 文档口径
  自 E2-T5 起更新为「默认进程内环回 + 可切换 TCP/串口真实传输」
