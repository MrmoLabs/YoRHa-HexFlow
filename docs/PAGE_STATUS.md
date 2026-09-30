# 页面实现状态

本文件由 `frontend/src/config/pageStatus.json` 生成，用于作为页面导航、占位说明和文档状态的统一参考。

## 已落地主链路

- `协议定义` (/protocol)
- `指令管理` (/instruction)
- `指令加工` (/processing)
- `编排绑定` (/orchestration)
- `通讯调试` (/terminal)
- `数据中心` (/datahub)
- `序列编排` (/sequences)

## 占位或待实现页面



---

## 协议定义 / Protocol Definition

- 路径: `/protocol`
- 快捷键: `A`
- 当前状态: 已接入 SQLite / FastAPI 主链路
- 摘要: 协议定义页用于维护协议外壳、容器结构、固定块、长度块、校验块和插槽块，当前已经接入仓库内 SQLite 与 FastAPI 协议接口。

### 已具备
- 协议列表已通过 SQLite 持久化。
- 支持协议新增、删除、块编辑与嵌套容器内联展开导航（点容器卡展开/收起，指令页同款泳道，A+B）。
- 协议修改为手动保存：编辑/撤销/重做只进本地草稿（保存前共享列表零写入），顶栏显 UNSAVED、属性面板底部动作区出「保存更改 (SAVE)」（协议级/块级两视图字段之后——第 3 轮 #3），点击才落库；切协议/新建/复制/导入带草稿先弹「放弃未保存的更改？」，未保存刷新被 beforeunload 拦截（人工验证反馈 2 第 2 轮）。
- 交互测试覆盖拖拽重排、块属性编辑、调色板添加与保存失败提示（C4）。
- 块类型与属性定义收敛到 config/blockTypes.js，调色板与属性面板由配置驱动、零页面硬编码（C4）。
- length/checksum 卡可挂 refs 结构引用（SELECT FIELDS 画布点选取/删，自引用拒并给 SYS 状态提示，slot 可引 —— 定义期可确定的 checksum（refs 全字面、无槽无悬空）直填设计期真值、其余维持按字节数等量 ??（2B → ?? ??），发送期填槽改写为注入块后按真值 Σ，refs 存 parameter_config.refs 随「保存更改」落库；一期 A2/A3 + ②）。
- length 卡设计期 Σ 回显：refs 引用块尺寸和注入卡面（十进制 `${sigma}B` 直出，checksum 仅在 refs 全可确定（字面 hex、无槽无悬空）时注入设计期真值、否则保持按字节等量 ??，悬空/refs 含槽（含容器裹槽）不注入；一期 A4 + ② + 人工验证反馈 2）。
- 删除协议前检查编排绑定引用：有引用弹窗警示连带清理（确认后端 DELETE 同事务级联删 protocol_bindings 并回显「连带清理 N 条」），无引用直删；仅剩一个协议禁删并给 SYS 提示（批次一 P0-1）。
- 删块级联剥离其他块指向它的 refs（含容器子孙），防悬空引用落库 400「refs target not found」整树卡保存（批次一 P0-2，protocolTree 单测锁形）。
- 保存失败恢复：顶栏横幅区分「服务端拒绝 / 网络·服务错误」并透传后端 detail，失败后草稿保留（离开拦截继续武装），重试 = 重发草稿、× 只关横幅不清草稿；创建/删除失败状态栏同样透传 detail（批次一 P0-3，反馈 2 第 2 轮改手动语义）。
- 保存前结构校验 validateProtocol：errors 阻断保存（点 SAVE 即拦、草稿保留；HEX 非 hex 字符、fixed 长度严等 byte_length×2、refs 四类悬空/自引、重复 id），warnings 不阻断（运算块长度差/同层重名/checksum 未挂引用）；属性面板常驻问题清单，点击条目展开祖先容器并选中问题块，修复后再点保存放行（批次二 P0-4，validateProtocol 单测 10 例锁形）。
- 撤销/重做：顶栏 撤销/重做 按钮 + Ctrl+Z / Ctrl+Shift+Z（输入聚焦或弹窗打开不响应），栈上限 50、新编辑作废 redo；手动保存语义下撤销/重做只动草稿不落库，保存 = 新基线清史、切协议清史（批次二 P1-5，复用指令页 useHistory，反馈 2 第 2 轮改手动）。
- 复制协议：侧栏行悬停「副本」按钮 → 整树新 id + refs 自含重映射（丢悬空防 POST 400）+ label「(副本)」升序防撞，POST 直建并切到副本（批次三 P1-1，protocolTree 单测锁形）。
- 复制块入口已按人工验证第 3 轮 #1 移除：两页属性面板不再出「复制块 (DUPLICATE)」（侧栏「副本」整条协议复制保留）；底座 duplicateNode 纯函数 + 3 单测已按人工验证拍板连删（protocolTree.js 仅存协议级复制与 JSON 导入共用的 cloneTreeWithNewIds）。
- 协议 JSON 导出/导入：顶栏 导出 = 当前工作副本原样下盘 {schemaVersion, protocols:[…]}；导入 = parse → analyzeProtocolImport（结构校验 + 全树重生 id + refs 自含重映射 + 撞名「(导入)」升序）→ 预览弹窗 → 顺序 POST 追加**不覆盖**，成功切到首个导入项（批次四 P3-2，镜像指令页 importInputRef 范式，importExport 单测锁形）。
- 协议级属性：属性面板协议级视图新增「协议描述」textarea（schema 既有字段零 DDL，落库走既有 description 载荷 + serializeProtocol 签名 → 手动保存链覆盖；onProtocolLabelChange 改名 onProtocolMetaChange，label/description 共用草稿 commit 入口）（批次四 P3-1）。
- checksum 算法配置：卡面「校验算法」下拉（SUM8 / XOR8 / CRC16-MODBUS，缺省 CRC16-MODBUS）存 parameter_config.algorithm（前端编码器 PASS2 同源直读）；编排导出 toFrameBlocks 出口把 refs（按数组序展开叶子 id、容器 ref 展开子树文档序、悬空丢弃）+ 算法枚举翻译进 config.params，后端 LengthHandler/ChecksumHandler 新增 refs 集合模式 —— 打通 R2 死 config:{} 恒 00 断点（无 refs 键的旧 range 模式原样保留）；validateProtocol 新增 W4 算法枚举外 warning（批次四 P3-3，toFrameBlocks / 后端 test_logic_refs_config 锁形）。
- 卡面取值口径：能确定的值直接显示、不确定按字节数出等量 ??（formula.formatUnknown，1B→??、4B→?? ?? ?? ??）—— length 挂可解析 refs 出 `${sigma}B`、checksum refs 全可确定按算法出设计期真值（缺省 CRC_16_MODBUS 同编码器，嵌套容器裹槽同拒）、其余出等量 ??；容器卡中央值 = 嵌套内容逐块拼接（字面 hex 子块出 pretty、未知子块按 byte_length 出等量 ??，如 AA 55 ?? ??，空容器中央 = 空白（第 3 轮 #2：不显 ?? 也不显 0B，页脚仍 `0B @00` 尺寸）；未配置固定块照显存储值（`0000`→`00 00`、`00`→`00`，撤第 2 轮「全 0 → ??」回退，`??` 仅限无法确定内容的卡）；protocolTree.injectContainerContent 链式接入 displayLanes，纯派生不落库；卡面取值口径改造，protocolTree/Block 单测锁形）。
- version 乐观并发：读取响应带 version（新建恒 1、每次成功写 +1），保存携带本地最后见到的值、服务端不符 409 拒收陈旧写（先于 refs 校验）；保存失败横幅三分类（版本冲突 / 服务端拒绝 / 网络·服务错误），冲突态给「强制覆盖」（按 id 拉最新 version 后带本地负载重发）与「加载最新」（放弃本地、服务端版本替换工作副本并清历史）双动作，非冲突仍走「重试」；不带 version 的直调写跳过比对直接覆盖（旧客户端兼容）；存量库缺列由启动自愈补列回填（批次五）。
- 位域块（bitfield）结构化位定义：调色板新增「位域 BIT」卡（1 字节叶子块），属性面板复用指令侧位编辑器（位图 + 点击式设段 + 打包预览）；位段存块级 bits 数组（后端 ProtocolNodeSchema 显式透传，走 children JSON 列零 DDL），toFrameBlocks 出口搬进 config.params.bits，后端 Orchestrator 发射期单点打包（handlers/bitfield.py，静态默认值语义、发送期不可改值）；保存前 validateProtocol 拦位域重叠/超容量（镜像后端 _validate_bits 400），卡面显示打包后的真实字节；存量 fixed/长度/校验/槽块逐字不变、无 wrap 裸发路径不回归（批 4）。
- 位段元数据（优化批）：位域块位段支持有符号（signed，两补码）与值表（value_table，[{value,label}]，DBC VAL_ 同形）—— 协议侧随 children JSON 列往返（BitFieldSchema 显式透传，刷新不丢，零 DDL），协议 JSON 导入白名单保留元数据并清洗脏值表（非数组丢弃、非法项过滤、无 meta 不注入键）；打包口径不变（负 default 走两补码位模式，与指令侧 packBits 同批向量锁定），落库校验仍只拦重叠/超容量。
- 校验标色（验证反馈批次）：属性面板的 ⛔/⚠ 清单同步点亮画布对应卡 —— 非选中态卡片边框按级别变色（结构错误红 #D94834 / 提醒琥珀 #E58D28，与面板同色系），header 右侧出 ⛔/⚠ 角标、悬停看全量消息（与清单同文）；同卡错误优先，选中态保 3px 亮边只留角标，清单随编辑实时重算；不带清单的页（蓝图/编排）零变化。

### 后续建议
- 跨容器拖拽落点 moveNode 已实现并经 protocolTree 单测锁形（含环守卫）；人工跨泳道拖拽目视验证待补。
- ② slot refs 新语义人工复测待补（slot 拾取计数进位/自引用 SYS 提示/含槽卡面 ??/组装试发 SENT 长度含载荷真值）。

---

## 指令管理 / Instruction Management

- 路径: `/instruction`
- 快捷键: `B`
- 当前状态: 已接入 SQLite / FastAPI 主链路
- 摘要: 指令管理页用于维护指令元信息、模块模板编排和积木属性，当前已经接入 SQLite 指令与算子模板接口。

### 已具备
- 支持指令新增、删除、保存、重置和本地未保存状态提示。
- 草稿隔离：管理页编辑只进 draftInstruction 单槽草稿（撤销/重做同草稿漏斗），共享指令列表保存成功才写穿 —— 指令加工页看不到管理页未保存的新增/改动（人工验证反馈 2 第 2 轮）。
- 模块模板支持加载态、错误态和重试。
- 指令字段已通过统一 payload 规范化后再写回后端。
- 新增 BITFIELD 位域算子：独立位布局编辑器，bits 明细持久化到 bit_fields 表。
- 位域布局可视化（批 2）：位图（byte×8、bit0 在右 = LSB 口径）替代纯数字表格做主视图 —— 空闲格点两下即生成位段、点色块选中该段并与表格行双向联动、重叠位红标、溢出位段照常渲染；表格保留精确数值编辑，位名/位宽/默认值/打包预览沿用。
- 字段级录入进制（批 1）：属性面板「配置参数 (CONFIG)」区顶部固定行「录入进制 (INPUT BASE) HEX | DEC」存 parameter_config.input_base（缺省 hex，大小写不敏感、非法值回退）；加工页据此把定长整数字段切十进制通道（十进制原值显示、数值域钳制、[nB] 徽标），HEX_RAW/BITFIELD 打包值不适用该行；值存储恒为数值，编码端口径不变。
- 录入进制扩为三态 HEX|DEC|BIN（优化批）：BIN = 二进制位模式录入（加工页按位宽定宽回显、n/N BITS 徽标）；录入宽容 0x/0b 进制前缀（0x 前缀在 hex 通道剥离归一纯 hex、0x/0b 在 dec 通道按前缀进制解析，前缀只是输入糖不挤占定长截断）。
- 位段元数据（优化批）：位图表格新增「值表 (VAL_TABLE)」列（单行文本 0=关,1:开，':' 兼容、中文逗号容忍）与 U/S 有符号开关（S 行默认值放开两补码域负值）；位图格 title、默认值 title、值表列回显名称解码；网格顶部新增位号标尺 7..0 列头（LSb0 口径，绝对位号 = 行号×8 + 列位号，免得自己数位）。元数据 signed/value_table 零 DDL 存 parameter_config.bit_meta（读取按位段 id 合并回 bits、保存/导入按 bits 重建拆分，单源幂等）。
- 校验标色（验证反馈批次）：属性面板的 ⛔/⚠ 提醒清单同步点亮画布对应字段卡 —— 非选中态边框按级别变色（结构错误红 #D94834 / 提醒琥珀 #E58D28），header 右侧出 ⛔/⚠ 角标、悬停看全量消息；同卡错误优先，选中态保 3px 亮边只留角标，清单随编辑实时重算。
- 文本字段算子（N2 · G2）：调色板 BASE 组新增「文本字段 STRING」—— 定长文本录入与出帧（encoding 下拉 ascii|utf8、pad_char 填充字节 hex、byte_len 定长 pad/截断，新建默认 8B / ascii / 0x00），属性面板 value 走文本输入；编码按 code point 出单字节（>0xFF 静态值校验提醒 STRING_NON_ASCII 建议切 utf8，utf8 出 UTF-8 流、孤立代理项 → U+FFFD），LENGTH_CALC 尺寸按定长字节算、卡面显原文、加工页初始值 = 静态 value 可继续键入；后端 encode_string 同口径双端 byte-equal（test_encode_string 向量表锚定），存量 INPUT + type=string 同吃定长与 ASCII 出帧。
- 保存前结构校验：位域重叠/超容量、引用悬空、标签重复、公式循环依赖、校验块覆盖区为空会阻断保存，问题清单可点击定位到块。
- B2–B8 编码器未实现语义已在配置面显式标注（⚠角标/横幅与保存提醒，仅记录不生效）。
- 字节偏移标尺与指令总长：每块 footer 显示 @偏移（组显示 @00..、动态未知显示 ··），顶栏 LEN 总长并标注 FIXED/VAR（定长直示 nB，变长可算 ~nB，未知下限 nB+），组卡片中央值 = 嵌套内容逐块拼接（字面 hex 子块出 pretty、未知子块按字节数出等量 ??，如 AA 55 ?? ??，页脚/标尺仍显 Σ 尺寸），拖拽/增删后实时重算。
- 复制指令：列表「副本」一键派生新指令（重生成字段 id、重映射 parent/repeat/refs、名称与代号自动去重后落库并选中）；属性面板「复制块 (DUPLICATE)」入口已按人工验证第 3 轮 #1 移除（duplicateBlockInInstruction util 随删，侧栏「副本」整条指令复制保留）。
- 画布平移：在画布任意空白处（卡片与控件除外）长按鼠标左键拖动即可横纵平移视图，内容层带滚动余量保证双轴可拖，松手不会清除选中或误触泳道聚焦；拖卡行为不受影响。
- 表格视图：侧栏指令库头部可切换「表格」视图（列 = 代号/设备/名称/总长 FIXED-VAR/字段数，内容全部居中、表头自带检索框并与侧栏搜索同步），与列表共享同一搜索过滤与未保存更改确认，切回列表状态不丢；无更新时间列（后端字段无 updated_at）。
- JSON 导入：顶栏「导入」选文件后经解析 → 结构校验 → 冲突分流（name/code 与存量或文件内重复只跳过并报告，绝不覆盖）预览计数后顺序落库并二次汇总结果；导出功能已按人工反馈移除。
- 撤销/重做：顶栏「撤销/重做」按钮与 Ctrl+Z / Ctrl+Shift+Z，历史上限 50 步、栈空禁用；切换指令、保存或重载会重置历史，撤销后仍需手动保存。
- 保存失败恢复：PUT 失败不清脏态，顶栏横幅区分「服务端拒绝」与「网络/服务错误」并提供重试与关闭，RESET 可放弃；结构校验失败仍走独立弹窗（两者文案分流）。
- 拖拽落点：悬停目标卡片时在其左/右缘显示 2px 琥珀插入线，拖拽期间 refs 连线整体隐藏并在落定后自动重算，Esc 取消会回滚预览并清理指示线。
- 页面↔hook 契约显式化（C7）：选项校验抽为 hooks/instructionDataOptions.js（非法选项降级+警告）、hook 全量 JSDoc、页面解构键 ⊆ hook 返回键的静态契约测试。
- 卡面取值口径：能确定的值直接显示、不确定按字节数出等量 ??（formula.formatUnknown）—— LENGTH_CALC 结果十进制 `${result}B` 直出（公式含未知/无公式同样出等量 ??）、CHECKSUM 空 refs 出等量 ??、TIME_ACCUMULATOR 中央值下方新增 BASE 基准时间小字（如 BASE 2026-09-23 14:00，未配置 → BASE ?；无基准注入等量 ?? 占位、有基准保留 hex 差值口径）；未配置固定/hex 块照显存储值（`0000`→`00 00`、`00`→`00`，`??` 仅限无法确定内容的卡——第 3 轮 #2，与协议页同口径）（卡面取值口径改造，useInstructionLanes/Block 单测锁形）。
- 对齐/填充（N5 · G4）：属性面板新增「对齐 / 填充 (ALIGN · PAD_TO)」独立区 —— align（内容起点补到 N 字节边界）/ pad_to（内容末尾补到 N 字节边界）/ pad_byte 填充字节 三输入 + 清除 + 口径摘要（未配置 → 不补位），叶子/组两支卡片均可编辑；两键骑 parameter_config 零 DDL，归一 1..4096（bool/非数/越界 → 0 即关闭）fail-open —— 非法 align/pad_to 出 ALIGN_INVALID/PAD_TO_INVALID 提醒（零 error 不锁保存）、pad_byte 非法静默回落 0x00；卡面 A4·P8 角标（title 说明补位语义）、卡片宽度 = 内容 + 归属 pad → 卡间空隙即填充字节且与偏移尺 @ 芯片逐格对齐，顶栏 LEN 与偏移尺按线上字节含 pad（页脚 LEN / PASS0 长度公式 / checksum 参与区 / byteMap 仍为内容口径不变）；presence 未命中与 repeat=0 不补，组 align 首副本前 / pad_to 末副本后补一次、叶逐副本按绝对游标算，LITTLE 反转不涉 pad；双端 byte-equal（test_encode_align 16 条共享向量 + 真机 FE=BE / 裸发 echo 实测）。

### 后续建议
- 补更细的字段引用测试（块移动与保存失败恢复已覆盖）。
- 把 B2–B8 从标注推进为真实编码语义（需授权修改双端编码器）。

---

## 指令加工 / Instruction Processing

- 路径: `/processing`
- 快捷键: `R`
- 当前状态: 已接入共享指令数据链路 / 传输抽象下发 + 事务发送（应答规格持久化）+ 封装发送（默认协议 wrap）
- 摘要: 指令加工页用于基于现有指令定义填写参数并预组装 payload，当前已经复用共享指令数据状态，并通过后端 /dispatch（传输抽象，默认环回）下发与导出十六进制文件；P2 起新增事务发送面板：应答匹配规格按指令持久化、超时/重发/间隔与广播无应答可控，返回逐次 attempt 与 RTT 统计。批次一起支持按指令默认协议的封装发送：内核 payload 按默认绑定套协议外壳（wrap），无可用绑定自动降级裸发。

### 已具备
- 与指令管理页共享同一份指令列表状态。
- 支持按当前指令结构渲染参数填写表单。
- 支持打开日期选择器并预览发送 payload。
- 发送经后端 /dispatch 走传输抽象（默认环回，可经 /transport/config 切换 TCP/串口真实传输），日志展示成功、失败与等待状态。
- 支持将当前 payload 导出为 .hex 文件下载。
- 参数渲染规则抽为 config/runnerRenderRules.js（字段分类/选项归一/显示值解析/语义标签/定长输入限制，纯函数 + 33 项单测），RunnerFieldTree 只保留布局（C6）。
- P2 事务发送面板（TransactionPanel）：应答规格编辑（帧头回显/长度自洽/校验反算/掩码忽略区间/前缀后缀五要素，PUT /response-specs 按指令存取，404 = 未配置常态）+ 超时/重发/间隔参数与广播无应答开关，POST /dispatch/transaction 返回逐次 attempt（状态/RTT/失配原因）与统计。
- 批次一 (D4-A) 封装发送：挂载按 GET /bindings?instruction_id= 取 is_default 行解析默认协议外壳，wrap 状态机 ok/none/failed/missing（无默认行/拉取失败/协议不在册均降级裸发 + 状态提示）；「:: Wrap ::」开关默认开 → TRANSMIT 与 TransactionPanel 同带 wrap 由后端唯一封装入口套壳，封装预览 300ms 防抖调 POST /compile/wrapped（与发送同参同字节，回显完整帧与洞位 warnings），可手动关回裸发。
- 指令加工编辑反馈四条之一：TIME 类字段（运行秒数）改满亮实线取值形态 + [TIME_PICKER] 徽标与 title 提示（仍点选日期、按 base_time 换算秒数，不再误标 [READ_ONLY] 斜纹锁定板，标签/accent 条恢复满对比）。
- 十进制录入（批 1）：定义侧把字段配成 input_base=dec 后，加工页该字段走十进制通道（十进制原值、无 hex 补零、超界按字段字节数数值域即时钳制、徽标 [nB] 标字节上限）；hex 通道字段不受影响（n/N BYTES 徽标与截断照旧）。
- BITFIELD 子位录入（批 3）：位域字段在整包输入下方展开子位行（位名 + 十进制输入 + [b3..b0] 位域注记），两者并存双向同步 —— 改子位只重写本段位（间隙位与其它段原样保留），改整包则子位反向重算，无输入态子位回显 default_val；回写仍是同一个字段整数，编码器零改动。
- BIN 通道与进制前缀（优化批）：input_base=bin 的定长整数字段走二进制通道（位模式定宽回显、超位宽按字符截断、徽标 n/N BITS 标位上限，无数值域——位模式语义，负数/数值域交给 dec 通道）；录入宽容前缀：hex 通道剥 0x/0X 归一纯 hex（前缀不挤占 byte_len×2 截断、'0x' 进行中保留缓冲不发半截值），dec 通道 0xFF/0b10100000 按前缀进制解析后照常数值域钳制，bin 通道 0b 输入糖。
- 子位值表与有符号（优化批）：值表位段在子位行渲染成下拉选名称（label+值 双显，当前值不在表内追加原值选项、不留空），选择仍回传打包整数（只动本段）；signed 位段子位行按两补码域显示负值并钳制（如 8 位 −128..127，0xD8 显 −40），回写负值转位模式、邻段与间隙位保留。
- 指令加工编辑反馈四条之二：点击字段（含整块容器）→ BYTE_STREAM_OUTPUT 按 InstructionEncoder byteMap 逐字段分段反白高亮（span title 回显字段名 @偏移），下方「SEL :: 字段名 · 0xNN-0xNN · NB」读数条同步，未选中显点击提示，换指令自动复位；嵌套组内点叶字段精确到该字段自身字节（叶行/组头 stopPropagation 隔离冒泡，不被外层组 id 覆盖成整组），点组头才选中整块子树；字节段内亦逐字节 XX XX 空格分隔（与整帧格式一致，不连写），高亮仍按整字段段反白。
- 指令加工编辑反馈四条之三：右栏三分区标题 + 中文用途释义 —— BYTE STREAM 字节流预览（随输入实时重算 / 点击定位）、PROTOCOL WRAP 协议封装（预览·发送·事务同参同字节）、TRANSMIT 发送与导出（CTRL+ENT 快捷、.hex 落盘）；Transaction / TransmissionLog 自带 :: 标题不重复。
- 指令加工编辑反馈四条之四：定长字段输入限制 computeFieldInputLimits（指令管理 byte_len 定死）—— hex 通道截断 byte_len×2 字符 + 「n/N BYTES」长度徽标（非 hex 通道 [nB]），数值按 0..2^(8n)-1 即时钳制（INT_SIGNED 两补码域、SCALED_DECIMAL 按 factor/offset 反算输入域、超 2^53 封顶 MAX_SAFE_INTEGER；编码端口径不变）。
- BYTE_STREAM 全字节口径（N5 · 对齐/填充）：字段 byteMap 只记内容字节 —— align/pad_to 填充字节不在任何字段区间内，分段器以无主段（fieldId null，不参与点击高亮）补齐中缝与首尾，渲染串恒 = hexPreview 全字节、与 LEN: N BYTES 同口径（否则预览会吞掉线上真实发出的填充字节）。

### 后续建议
- 展示当前传输模式与连接状态（GET /transport/status），支持在本页切换 loopback/TCP/串口。

---

## 编排绑定 / Orchestration Binding

- 路径: `/orchestration`
- 快捷键: `C`
- 当前状态: 绑定已持久化（新表 protocol_bindings，批次一 + slot_id/is_default/priority 三字段）
- 摘要: 编排绑定页将协议壳与指令内核组合成完整报文结构：读取数据库中的协议与指令、插槽注入预览，绑定列表经 /bindings CRUD 持久化（刷新/重启后仍在）。

### 已具备
- 支持选择协议壳和指令内核进行合成预览。
- 支持按插槽规则将指令结构注入协议壳。
- 提供结构预览和基础长度统计（总长度已含注入载荷字节）。
- 支持将合成后的块结构提交后端 Orchestrator 编译并导出 .bin 文件。
- 绑定增删/星标即写后端（POST/DELETE/PUT）；属性编辑（名称/协议/指令/洞位）只进本地草稿并标脏，属性面板底部动作区「保存更改 (SAVE)」逐行落库——底部常驻 `● N 条未保存` 计数行（0 muted / >0 琥珀）+ SAVE 常驻渲染（干净或加载失败时 disabled），侧栏脏行 label 前出琥珀 ●（title=有未保存更改）（原 400ms 防抖 + 卸载冲刷退役，改 beforeunload 拦截；加载失败降级本地编辑提示条，降级态不标脏）（人工验证反馈 2 第 2 轮 + 第 3 轮 #4/#6）。
- 属性面板四分区标注：绑定标识 (IDENTITY) / 结构选择 (STRUCTURE) / 洞位 (HOLE) / 操作 (ACTIONS)；协议外壳 + 指令内核两个 select 从头部下沉到「结构选择」分区（头部只留 总长度 + EXPORT/试发，AUTO-ASSEMBLY RULE 归洞位分区）（第 3 轮 #6②）。
- 中心区分栏修复：section 补 min-w-0 + overflow-hidden（flex item min-width:auto 根因，右栏不再被挤出视口），属性 aside 补 shrink-0 + overflow-y-auto，与协议/指令页对齐（第 3 轮 #5）。
- 同协议多绑定按 slot_order 升序依洞填装（N 指令帧级合并为 1 帧，单绑定退化原语义），侧栏按（协议序, 洞号）重排（一期 B1/B2）。
- 洞位下拉改洞即组内重编号 0..n-1 并标脏（稠密位次，挂载零回写，SAVE 落库变化行）；countSlots 对账三态警示：无 SLOT / 洞位不足 / 空洞（一期 B3）。
- 绑定行星标 = 该指令的默认封装绑定（is_default，批次一 D1 一行两用，放删除按钮后）：点星 PUT 后端同事务清同指令旧默认（部分唯一索引兜底）、本地同步清星；toServer/toLocal 出线 slot_id/is_default/priority 三字段。
- 「封装试发」（批次一 D4 改线）：组内逐指令前端编码内核 hex → POST /compile/wrapped（后端唯一封装入口：洞位分配 + length/checksum 真值重算）→ POST /dispatch 发封装帧，SENT 回显附洞位 warnings、失败（含 409 detail）透出，空组装禁发（一期 C1 + 批次一改线）。
- 回归测试覆盖总长度、插槽缺失追加与边界结构及持久化接线（加载/增删/手动保存/降级）：blockMerge 纯函数 28 例（含双端共享向量 FA FA 02 01 02 ED）+ 页面级 22 例（含星标默认封装、手动保存、离开拦截、底部保存区/四分区/脏点/分栏）。

### 后续建议
- 绑定拖拽排序（slot_order 洞位下拉回写已落地，拖拽交互未做）。
- 绑定集导入导出与跨项目迁移。
- 洞位填装与封装试发链路人工目视验证待补。

---

## 通讯调试 / Communication Terminal

- 路径: `/terminal`
- 快捷键: `D`
- 当前状态: 已接入传输配置、设备档案与三面板
- 摘要: 通讯调试页提供传输配置模型（发送模式 loopback/TCP/串口 + 目标地址/串口参数，接 /transport/config）、设备档案区（/profiles 命名快照 + 激活切换，配置经 lifespan 钩子落库、重启恢复）、连接状态与状态事件（GET /transport/status），以及发送历史 / 原始报文 / 响应与错误日志三面板（数据源 /dispatch 有界历史，raw/response/error 三类事件）。

### 已具备
- 配置发送模式与目标参数（loopback 默认；TCP host/port/连接与读取超时；串口 COM/波特率/数据位/校验位/停止位），应用后立即生效并刷新连接状态。
- 传输配置持久化（P1）：每次应用配置即落库 transport_settings，后端重启自动恢复上次生效配置。
- 设备档案区（P1）：把当前生效配置存为命名档案（存为档案）、一键切换（应用档案）、用当前配置覆盖所选档案（更新）、删除（需确认）；下拉项带摘要与激活 ★，已激活/已修改徽标随选中展示，激活后被手工改配置会自动失活。
- 查看连接状态与状态事件（connected/disconnected/error，GET /transport/status），手动刷新。
- 发送历史面板：手动发送十六进制帧（非法输入禁用发送）、按记录选择（时间/通道/状态/字节/预览）、刷新与清空（清空需确认）。
- 原始报文面板：选中记录的完整帧 hex dump（8 字节/行）与 meta（ID/通道/字节数/状态）。
- 响应与错误日志面板：选中记录的响应事件 hex dump 或失败原因，以及全部 ERROR 记录汇总。

### 后续建议
- 档案重命名与排序（当前仅创建/更新配置/删除/激活）。
- 串口端口枚举（列出本机可用 COM 口）与波特率预设表。
- 连接状态与发送历史的自动轮询或推送（当前为手动刷新）。
- 报文格式切换（hex / ascii / 二进制位图）。

---

## 数据中心 / Data Hub

- 路径: `/datahub`
- 快捷键: `E`
- 当前状态: 已接入 SQLite / FastAPI 环境状态与备份链路
- 摘要: 数据中心页一期提供数据的工程化操作台：环境状态面板展示数据库路径、行数与后端版本；聚合导出把全量指令 JSON 与逐指令骨架帧打包为 ZIP；备份/恢复通过后端端点复制与替换 yorha.db（恢复前自动留安全快照）。

### 已具备
- 协议、指令和算子模板已经由 SQLite 持久化。
- 项目支持通过后端 API 读取与修改协议、指令数据。
- 指令加工页已支持导出 .hex、编排页支持导出 .bin（由 /export 提供）。
- 指令管理页已支持指令 JSON 导入（结构校验与冲突分流预览，2026-09-22）。
- 环境状态面板：DB 路径 / 大小 / 修改时间、五表行数、后端版本，可手动刷新（GET /datahub/status）。
- 聚合导出：ZIP 打包 instructions.json（与指令页导入格式对称）+ manifest.json + 逐指令 frames/*.bin|hex（Orchestrator 编译骨架帧）。
- 数据库备份 / 恢复：新建备份复制到 backend/db/backups/（已 gitignore）；恢复前自动留 pre-restore 安全快照、释放连接池、清理 WAL/SHM 残留后原子替换，并有二次确认与文件名防穿越校验。

### 后续建议
- 补数据包示例下载与算子模板/协议的独立导出包。
- 编排绑定关系持久化后再纳入聚合导出范围。

---

## 序列编排 / Sequence Orchestration

- 路径: `/sequences`
- 快捷键: `F`
- 当前状态: 新表 sequences / sequence_steps + 单槽后台 Runner + 1.5s 状态轮询 + 手动发送互斥
- 摘要: 序列编排页维护多步骤发送序列：步骤帧保存时由 encodeInstruction 编译定值（表单参数冻结为 params），TIME/COUNTER/校验字段按 plan 在每次发送时重算；定义持久化到新表 sequences / sequence_steps，运行经单槽后台 Runner（协作式停止、出错即停开关），/sequences/status 每 1.5s 轮询运行快照；序列运行期手动 /dispatch 与事务发送 409 互斥。

### 已具备
- 序列定义 CRUD：新建、重命名/描述与配置（出错即停、读超时）、步骤增删与上移下移、整体保存（PUT 替换），删除需二次确认。
- 步骤编辑器：选择指令 → RunnerFieldTree 动态表单填参 → 实时 hex 帧预览，「应用」编译 payload + 冻结 params + 生成发送计划。
- 计划编译为纯函数 utils/sequenceView.buildPlan（键集与后端 normalize_plan 严格同形；动态字段计数与校验算法摘要徽标；自含重叠/算法不支持等后端会 400 的形态在生成侧降级为冻结并给警告）。
- 运行控制：启动（404 缺失 / 400 无步骤 / 409 忙 分流提示）、停止（恒 200 幂等），运行期定义编辑/删除/启动入口前端禁用。
- 状态面板 1.5s 轮询：待机/运行/完成/失败/停止徽标、进度 current/total、逐步状态（OK/ERROR/SKIPPED）与 RTT、运行级错误与停止请求标志。
- 与手动发送互斥：序列运行中 /dispatch、/dispatch/transaction 返回 409（加工页发送错误条可见该文案）。

### 后续建议
- 步骤拖拽排序（当前为上移/下移按钮位序回写）。
