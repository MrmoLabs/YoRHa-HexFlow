# YoRHa-HexFlow Instruction Editor - Technical Specification

## 1. 核心业务逻辑流程 (Core Business Workflow)

> 页面导航与实现状态请以 `frontend/src/config/pageStatus.json` 和生成文档 `docs/PAGE_STATUS.md` 为准，避免与页面实现状态漂移。

### 1.1 数据加载与初始化
1. **Load**: 用户访问页面，`useInstructionData` 挂载。
2. **Fetch**: 调用后端 API 获取指令列表。
3. **Select**: 默认选中第一个指令，若无指令则状态为空。
4. **Transform**: 将后端扁平化的 `fields` 数组加载到内存。

### 1.2 编辑与交互循环
1. **Render**: `useInstructionLanes` 将扁平 `fields` 基于 `parent_id` 递归转换为嵌套的 **Swimlanes (泳道)** 结构。
2. **Drag & Drop**: 用户拖拽积木。
   - `Canvas` 接收 `onDragEnd` 事件。
   - 计算新的 `sequence` 和 `parent_id`。
   - 更新本地 `instructions` 状态 (Optimistic UI)。
3. **Properties Edit**: 用户点击积木。
   - 右侧 `BlockPropertiesPanel` 显示属性。
   - 修改属性（如 Byte Length, Name）。
   - 触发 `updateLocalInstruction`，标记 `hasUnsavedChanges = true`。
4. **Formula Calculation**: 
   - 每次渲染时，`useInstructionLanes` 遍历所有积木。
   - 解析 `parameter_config.formula`（如 `[FieldA] + 1`）。
   - 实时计算 `computedValue` 并注入到积木 Props 中用于显示。

### 1.3 持久化
1. **Save**: 用户点击保存。
2. **Commit**: `useInstructionData` 将当期指令对象 POST 到 API。
3. **Sync**: 后端确认成功后，清除 `hasUnsavedChanges` 标记。

---

## 2. 模块划分 (Module Architecture)

### 2.1 表现层 (View Layer)
- **Instruction.jsx**: 页面入口，负责顶层布局和组件编排。
- **Canvas.jsx**: 核心画布，负责渲染泳道和处理拖拽事件区域。
- **components/editor/Block.jsx**: 最小原子组件，负责不同 OP_CODE 的差异化渲染（主题、形状）。

### 2.2 逻辑层 (Logic Hooks) - **SRP 核心**
- **useInstructionData**: 负责 CRUD、API 通信、脏数据检查。
- **useSelectionSystem**: 负责点击选择、Shift 多选（预留）、拾取模式 (Picking Mode)。
- **useInstructionLanes**: 负责将扁平数据树形化、处理 Group 展开/折叠、执行公式引擎。
- **useCanvasConnections**: 负责计算 SVG 贝塞尔曲线（逻辑引用线、层级关系线）。

### 2.3 工具层 (Utils)
- **InstructionEncoder.js**: 编码核心。`getInitialValues`（默认值）→ `resolveDependencies`（长度/校验/公式）→ `encodeInstruction`（生成 hex 与 byteMap）。`BITFIELD` 按 `sum(default_val << start_bit)` 打包，运行时输入值优先。
- **formula.js**: 纯函数库，包含安全的公式解析器 (`evaluateFormula`) 和 十六进制格式化器 (`formatToHex`)。
- **constants.js**: 单一可信源，定义 `OP_CODES`, `CATEGORIES`, `OP_PRIORITY` 等常量。

### 2.4 后端链路 (Backend)
- **routers**: `instruction` / `protocol` / `operator`（CRUD + 种子）、`export`（hex/bin 下载）、`dispatch`（进程内环回，非真实传输）。
- **core/orchestrator.py**: 块森林 → 扁平流 → 区间 length/checksum → hex，供 `/compile` 与 `/export/binary` 使用。
- **db**: SQLite（`backend/db/yorha.db`），表结构以 `backend/db/models.py` 为准（含 `bit_fields`）。

---

## 3. 技术栈选型 (Technology Stack)

| 技术 | 选型原因 |
| :--- | :--- |
| **React 19** | 组件化开发，Hooks 机制完美契合业务逻辑分离 (SRP) 的需求（`package.json` 中实际版本 ^19.2）。 |
| **Vite 7** | 开发服务器与构建链路（`package.json` 中实际版本 ^7.2）。 |
| **@dnd-kit** | 相比 `react-beautiful-dnd` 更轻量且模块化，支持自定义碰撞检测，适合复杂的嵌套泳道拖拽。 |
| **TailwindCSS** | 原子类 CSS，结合 `index.css` 的 Theme 配置，能快速构建 Nier: Automata 风格的高定制 UI。 |
| **Vitest** | 兼容 Jest API 但基于 Vite，速度极快，适合作为开发环境的实时测试运行器。 |
| **React Testing Library** | 专注行为测试（Render, Click），而非实现细节，保证重构不破环功能。 |

---

## 4. 潜在技术难点 (Technical Challenges)

### 4.1 无限嵌套与性能
- **问题**: `ARRAY_GROUP` 允许无限层级嵌套，递归渲染可能导致 React 渲染深度过深，拖拽时重绘卡顿。
- **对策**: 
  - 使用 `React.memo` 优化 Block 组件。
  - `useInstructionLanes` 仅在展开 (Expanded) 时才计算子节点，未展开节点视为由父级管理的黑盒。

### 4.2 动态公式依赖解析
- **问题**: 公式可能引用尚未定义的字段，或引用链发生循环 (A->B->A)。
- **对策**: 
  - 目前 `evaluateFormula` 采用简单解析，若引用不存在则默认 0。
  - 未来需实现 **拓扑排序 (Topological Sort)** 以确保计算顺序正确，并检测循环依赖。

### 4.3 SVG 连线坐标同步
- **问题**: DOM 元素位置随滚动、展开/折叠动态变化，SVG 线条需实时重绘。
- **对策**: `useCanvasConnections` 监听 `lanes` 变化和 ResizeObserver，但在快速滚动时仍可能有帧延迟。

---

## 5. 安全性 (Security)
- **XSS 防护**: `formula.js` 中的解析器严禁使用 `eval()`，而是通过正则白名单 (`/[^0-9+\-*/().\s]/`) 过滤后使用 `new Function`，防止任意代码执行。
