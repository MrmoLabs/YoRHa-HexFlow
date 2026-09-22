# 计划：指令管理页增强（P0/P1/P2）

> 创建于 2026-09-22。对应评估结论：主干已满足指令码配置场景，本计划补齐可信度（P0）、
> 高频功能（P1）、体验与工程性（P2）三层缺口。
> 交接文档见 `PROJECT_HANDOVER.md`；加工页 PRD 见 `docs/PRD_InstructionProcessing.md`。

## 0. 硬约束（全程有效）

- **不改** `backend/core/orchestrator.py`、`frontend/src/utils/InstructionEncoder.js` 编码逻辑；
  B2–B8 编码器限制只做 UI 标注与文档，不实现编码语义。
- **不改** schema / models（SQLite 仅 `create_all`，无迁移）；`backend/db/yorha.db` 保持 git 跟踪。
- **不碰** `backend/core/processor.py`、`backend/core/graph.py`、`frontend/src/pages\Blueprint.jsx` 逻辑。
- **不加新 npm / pip 依赖**；全部能力手写。
- `/dispatch` 文档口径固定为进程内环回（loopback）。
- 每阶段结束跑 `npm run test -- --run`（当前基线 47/47）与 `npx vite build`（513 modules），如实报告。
- 提交时机由人工验证后指示（延续既往节奏）。

## 1. 里程碑总览

| 阶段 | 级别 | 内容 | 规模 | 依赖 |
|------|------|------|------|------|
| Phase 0 | P0 | 编码器限制显式标注 + 保存前统一校验 + 离开保护 | S–M | 无 |
| Phase 1 | P1 | 字节偏移标尺 + 指令总长 | M | 无 |
| Phase 2 | P1 | 指令/块复制派生 + 骨架模板 | M | Phase 0（复用校验） |
| Phase 3 | P1 | 指令集表格视图与检索 + JSON 导入导出 | L | Phase 0（导入复用校验） |
| Phase 4 | P2 | 撤销/重做 + 保存失败恢复 + 拖拽落点指示线/连线处理 + 回归测试补齐 | L | Phase 0–2 稳定后 |

每阶段 = 实现 → 测试/构建 → 人工验证清单 → 更新 `pageStatus.json` 与 `PROJECT_HANDOVER.md` 相关条目。

---

## 2. Phase 0 — P0 可信度（✅ 已完成 2026-09-22，测试 64/64、构建 515 modules）

### P0-1 编码器限制显式标注（「假配置」治理）

- **问题**：字节序、INT_SIGNED 负数、FLOAT_IEEE、BCD、factor/offset/step、repeat、
  计数器/时间等语义**可配置但编码器不消费**（B2–B8），用户会误判为生效。
- **改动文件**：
  - 新增 `frontend/src/utils/encoderLimits.js`：单一事实源
    `ENCODER_LIMITATIONS = { <配置项>: { ref: 'B2'…, text: '当前编码器未实现…' } }`；
  - `BlockPropertiesPanel.jsx`、`ParamConfigForm.jsx`（管理页配置面）：
    受影响控件旁加琥珀色警示标（`⚠ B2` 类角标）+ hover tooltip 全文；**不删除、不禁用已有值**；
  - 加工页 `RunnerFieldTree.jsx` 同标（只标注，不改语义）；
  - `PROJECT_HANDOVER.md` §7 增加"UI 标注已落地"交叉引用。
- **验收**：任选 B2–B8 对应控件，可见角标与解释文案；已有配置值不受影响；测试/构建通过。

### P0-2 保存前统一校验（validateInstruction）

- **改动文件**：
  - 新增 `frontend/src/utils/validateInstruction.js`（纯函数，可测）：
    - **Error（阻断保存）**：位域重叠 / 位域超出 byte_len；refs 指向不存在的字段；
      HEX_RAW 长度 ≠ byte_len；同层 label 重复；LENGTH_CALC 循环依赖；校验块覆盖区为空。
    - **Warning（提示不阻断）**：命中 B2–B8 的配置项；byte_len 缺失/为 0；
      嵌套组内 sequence 断档（依赖自愈路径）。
  - `Instruction.jsx` / `useInstructionForm.js`：保存入口先跑校验，Error 存在则阻止 PUT，
    在 SAVE 按钮附近渲染问题清单（逐条定位到块：点击可选中该块）；Warning 常驻可折叠。
  - 面板 APPLY 级既有校验（HEX 长度、标签唯一）保留为第一道，中心校验兜底全量。
- **验收**：构造位域重叠指令 → 保存被阻止且列表指出块；修复后保存成功；纯 Warning 不挡保存。
- **测试**：`__tests__/validateInstruction.test.js`（覆盖全部 Error/Warning 分支，≥8 例）。

### P0-3 未保存离开保护

- **改动文件**：`Instruction.jsx` 加 `beforeunload`（`hasUnsavedChanges` 为真时拦截）；
  `Protocol.jsx` 有 ≤350ms 防抖待保存（`pendingSaveRef`）时同样拦截。
- **验收**：改动未保存时刷新/关标签有浏览器确认；保存后离开无提示。

---

## 3. Phase 1 — P1 结构可读性（偏移标尺 + 总长）（✅ 已完成 2026-09-22，测试 76/76、构建 516 modules）

- **改动文件**：
  - 新增 `frontend/src/utils/byteOffsets.js`（纯函数）：
    按 `parent_id/sequence` 遍历计算每块字节偏移；根泳道顺序累计；
    嵌套组起点 = 父块起点 + 组内累计；组总长 = Σ 子块（动态长度用当前 `computedValue`，
    不可计算时占位 `··` 并显示 `+` 后缀）。
  - `Block.jsx` footer 增加偏移角标（`@00` 单色 mono，组显示 `@00..`）；
  - `Instruction.jsx` 顶栏显示指令总字节数（复用/对齐编排页 `getTotalBytes` 口径）。
- **验收**：`[HEAD 2B][LEN 2B][CMD 1B][DATA 4B][CRC 2B]` 显示偏移 0/2/4/5/9，总长 11B；
  拖拽/增删块后偏移实时重算；嵌套组起点正确。
- **测试**：`byteOffsets` 纯函数用例（含嵌套、动态占位）。
- **2026-09-22 增补（人工反馈迭代）**：
  - 组卡片中心不再硬编码 `??`——能算出 Σ 子块时直显 `4B`（未知才 `??`），组 footer 同步显示总长；
  - 空组（seed `byte_len=0`）按已知 0 字节处理，不污染后续偏移；
  - 顶栏区分**定长/变长**：`LEN 11B FIXED`（全静态）/ `LEN ~11B VAR`（DYNAMIC 重复或值驱动长度，可算）/ `LEN 6B+ VAR`（含未知，下限）；
    口径对齐编码器实际输出（B7：重复只展开一次，显示值以编码为准，⚠B7 继续标注）。
  - 修复 LENGTH_CALC 公式引用组恒为 `??` 的缺陷：`useInstructionLanes` 的 `nameToValueMap`
    原把组硬编码为 `"??"`，`[状态块] + [帧尾]` 因此短路——现取 byteOffsets 的 Σ 组值
    （真未知才 `??`）；示例状态包长度现算出 `05`。同步移除死字段 `_displayLen`。
  - 智能卡片宽度：`宽 = max(60px 底线, 字节数×40, 内容下限)`——footer（`2B @00` / `??B @02..`
    + OPEN）不再被相邻卡片遮挡；组卡按 Σ 比例（状态块 4B → 160px）。footer 顺序改为
    **字节数在前、偏移在后**（人工反馈）。
  - 组卡片双保险：Σ 同时注入 `parameter_config.computedValue`（`4B`/`??`），偏移标尺 prop
    缺失时回退显示（byteOffsets 组分支仅走 Σ 子级、不读 computedValue，无反向污染）。
  - 修复「有 refs 无 formula」的 LENGTH_CALC 恒显 `??`（New Instruction 682 实例）：
    数据模型以 formula 为表达式源头、refs 只是其变量镜像（seed：`refs:[组,帧尾]` ↔
    `[状态块] + [帧尾]`），历史数据可能只剩 refs——预览按该约定**合成求和公式**
    （真公式恒优先；悬空 ref 仍诚实显示 `??`），问题清单新增 Warning `LENGTH_NO_FORMULA`
    披露推断并提示补全公式。加工页（编码器为禁区）对该形态仍不可算，补全公式落库即可修复，
    待授权另立任务。

---

## 4. Phase 2 — P1 生产力（复制派生 + 骨架模板）

### P2-1 复制/派生

- **复制指令**：列表项"复制"→ 取源指令、重新生成 id（若后端发号则清空后 POST，见 §7 调研点）、
  `name + ' (副本)'`、code 冲突按后端约束处理（调研后定）→ 落库并选中新指令。
- **复制块**：面板/右键"复制块"→ 深拷贝（含子组与 bit_fields），新 id 插入源块之后；
  指向源块的 refs **保持指向原块**（文档注明，避免歧义）。
- **文件**：`Instruction.jsx`、`BlockPropertiesPanel.jsx`、可能新增 `utils/duplicateInstruction.js`（纯函数）。
- **测试**：深拷贝 id 唯一性、子结构完整、refs 行为用例。

### P2-2 骨架模板

- 新增 `frontend/src/utils/skeletons.js`：内置 2–3 种帧骨架
  （如 `HEAD(2B)+LEN(2B)+CMD(1B)+PAYLOAD(4B)+CRC(2B)`，及精简 4B 变体）；
  工具栏"骨架"菜单一键插入当前根泳道末尾（HEX_RAW 为主，校验/长度用真实算子若 seed 允许）。
- 插入后自动选中首块并标脏。**验收**：一键得到完整帧骨架，偏移/总长随之正确。

---

## 5. Phase 3 — P1 规模化运营（表格视图 + 导入导出）

### P3-1 指令集表格视图与检索

- 指令列表区加 **列表/表格** 切换与搜索框：
  表格列 = code / device_code / 名称 / 总字节 / 字段数（更新时间视后端字段调研结果）；
  搜索按 code + name 不分大小写过滤。
- 纯前端过滤，不加接口。**验收**：30+ 指令下秒级筛选，切回列表无状态丢失。

### P3-2 JSON 导入/导出

- **导出**：`GET /instructions` 全量 → 带 `schemaVersion` 与导出时间的 JSON 下载。
- **导入**：选文件 → 解析 → 逐条过 `validateInstruction` → 预览（新增/冲突/错误计数）
  → 确认后顺序 POST，逐条结果汇总；冲突（code 唯一约束）默认跳过并报告，不覆盖。
- 入口放指令管理页工具栏；`pageStatus.json` datahub 条目同步更新其"已支持"边界。
- **验收**：导出→清空/另库→导入往返结构一致；坏文件有明确错误不落脏数据。
- **测试**：导出 payload 形状、导入解析与校验分流的纯函数用例。

---

## 6. Phase 4 — P2 体验与工程性

### P4-1 撤销/重做

- 在 `updateLocalInstruction` 咽喉点包一层历史（`useHistory` 手写，栈上限 50）：
  结构性操作（增删块/移动/APPLY/导入/骨架/复制）前压栈；`Ctrl+Z / Ctrl+Shift+Z`
  与工具栏按钮；撤销保持脏态语义（仍需保存）。拖拽以 dragEnd 一次为一历史步。
- **验收**：连续增删拖拽后可逐步回退；栈空按钮禁用；不影响已保存基线。

### P4-2 保存失败恢复

- PUT 失败：本地脏态**保留**，顶栏错误横幅（错误摘要 + 重试按钮），RESET 仍可用；
  禁止静默回滚。与 P0-2 区分：校验失败≠网络失败，两条路径文案分开。

### P4-3 拖拽落点指示线 + 连线处理

- 落点：dragOver 时记录 `overId`，在目标块左/右缘渲染 2px 琥珀插入线（复用现有
  `dragOverLaneIndex` 状态机扩展）。
- refs 连线：拖拽期间整体 `opacity-0`（隐藏），drop 后随 `lanes` 变化自然重算
  （不做逐帧跟随，避免性能坑）。

### P4-4 回归测试补齐

- 把 Canvas `handleDragEnd` 落点推导抽为纯函数 `computeFinalPlacement` 并单测
  （同 lane / 背景落点 / 跨 lane / 不可解析 over 四分支）——钉死拖拽避让修复。
- 目标：基线 47 → 65+ 全绿；`vite build` 通过。

---

## 7. 调研点（实现前先确认，影响设计）

1. **指令 id / code 生成与唯一约束**（`backend/models` + `routers/instruction.py`）：
   决定复制与导入是"后端发号"还是"前端重新生成"。Phase 2/3 前置。
2. **指令列表可用字段**（是否有 `updated_at` 等）：决定表格列。Phase 3 前置。
3. **LENGTH_CALC / CHECKSUM 在 seed 中的真实可用性**：决定骨架模板用真实算子还是 HEX_RAW 占位。Phase 2 前置。
4. **Protocol 页防抖窗口与 beforeunload 交互**：确认 `pendingSaveRef` 判空时机。Phase 0 内联处理。
5. **动态长度块的偏移显示口径**：✅ 已于 Phase 1 定稿——尺寸解析顺序 `byte_len > 0` →
   `parameter_config.computedValue` 字节数（hex 非 `??`）→ 未知；未知块自身起点照常显示，
   其**后**块偏移显示 `··`，总长降级为下限（`+` 后缀）。

## 8. 交付与验证节奏

1. 按 Phase 0 → 1 → 2 → 3 → 4 顺序执行；每阶段结束：
   - `npm run test -- --run`（如实报告通过数与基线增长）
   - `npx vite build`
   - 给出该阶段人工验证清单（3–5 条可在 :5174 直接操作的场景）
   - 同步 `pageStatus.json` / `PROJECT_HANDOVER.md` 对应条目
2. 等待人工验证反馈 → 修复 → 按指示做本地提交（可每阶段一提交）。
3. 全部完成后输出总结：能力矩阵（前/后）、测试基线变化、遗留项。
