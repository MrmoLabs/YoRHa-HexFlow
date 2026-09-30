# 指令编制业务场景全集 × 系统能力矩阵

> 目的：把「指令编制」业务可能遇到的报文场景**一次盘满**，对照系统能力给出
> 覆盖矩阵与缺口清单，作为排期（`PLAN_Backlog.md` §8.16）的唯一输入基线。
> 避免"用户提一个、查一个"的逐点式发现。
>
> 维护口径：新业务场景 → 先入本档矩阵（定级 ✅/⚠️/🔴/⏸/⚪）→ 缺口进
> §8.16 排期或挂账 → 实现完成后本档状态列就地更新。
>
> 调研基线（已成立、不重复盘）：
> - `PLAN_Backlog.md` §8.14 调研差距表：已做 1-4（BIN 三态 / 位段值表 /
>   有符号位段 / 位号标尺）；**已立暂缓**：CRC 多算法（CCITT/CRC32/LRC）、
>   长度域 BE/LE、varint/COBS 组帧、解码回程（后端 encode-only 边界）。
> - `PROJECT_HANDOVER.md` E1-4：float64 编码**范围外保留现状**（如需另立子项）。
> - 定级图例：✅ 覆盖 ｜ ⚠️ 半残（有功能但有坑）｜ 🔴 真缺口 ｜ ⏸ 已立暂缓
>   ｜ ⚪ 软缺口（有替代，挂账）。

## 一、字段值表达（一个值怎么表示）

| 场景 | 状态 | 证据 / 备注 |
|---|---|---|
| 无符号 / 有符号定宽整数 8-64b | ✅ | `InstructionEncoder` INT_UNSIGNED 默认路径 + INT_SIGNED 补码分支，双端 byte-equal |
| 浮点 32 位 | ✅ | E1-4 向量锚定（`encode_float_ieee` ↔ FLOAT 分支） |
| 浮点 64 位 | 🟡 | **已摘静默**（N1 校验提醒 `FLOAT64_UNSUPPORTED` 配出即提醒）：编码仍不可用——FE 落整数路径、BE 保持 zeros，两端不一致；模板 `bits:[32,64]` 只影响新建默认（取首元素 32），真正入口是手改 byte_len → G7 按定案落地（提醒而非改模板） |
| 定点小数（比例 + 偏移） | ✅ | SCALED_DECIMAL，双端定标口径一致 |
| BCD 码 | ✅ | BCD_CODE 分支 |
| 枚举 / 值表 | ✅ | MAPPING（整值枚举）+ 位段 VAL_TABLE（§8.14 优化 2） |
| 按位标志 / 位段 | ✅ | BITFIELD + 位图 + signed + 标尺（§8.13/8.14） |
| ASCII 字符串 | ✅ | N2 落地：`STRING` 模板入口（8B/ascii/0x00 默认）+ `byte_len` 定长 pad/截断 + ascii code point / utf8 双模式（孤立代理项 U+FFFD），>0xFF 静态值校验 W6 提醒，双端 byte-equal 向量锚定；存量 `INPUT+type=string` 同吃定长 → G2 已解 |
| 绝对时间戳（epoch） | ⚪ | 只能 INT_UNSIGNED 手工语义化（TIME_ACCUMULATOR 是增量）→ 挂账 |
| 相对 / 累积时间 | ✅ | TIME_ACCUMULATOR |
| 计数器（回绕） | ✅ | AUTO_COUNTER start/step/max |
| 固定 HEX 值 | ✅ | HEX_RAW + 三态录入（§8.13/8.14） |
| 长度字段 | ✅ | LENGTH_CALC + 四则公式（`formula.js`：±*/() + [ref]） |
| 校验字段 | ✅ | SUM_8 / XOR_8 / CRC_16_MODBUS；CRC32/CCITT/LRC ⏸已立（§8.14） |

## 二、结构组织（字段之间怎么组织）

| 场景 | 状态 | 证据 / 备注 |
|---|---|---|
| 顺序 / 定长 / 嵌套组 | ✅ | ARRAY_GROUP + parent_id 树 |
| 固定次数重复 | ✅ | `repeat_type=FIXED` |
| 动态次数重复（次数由字段值定） | ✅ | `repeat_type=DYNAMIC + repeat_ref_id`（同构重复） |
| **值 → 不同嵌套（分支 / 变体）** | 🔴 | `cmd=A` 一种结构、`cmd=B` 另一种——数据模型零概念（全库无 branch/variant/union/presence）；**TLV（每单元 value 随 tag 变长）、按值路由指令同属此族** → 缺口 G1 |
| 可选 / 存在性字段 | 🔴 | 无 presence 概念 → G1 方案 B 副产品 |
| 填充 / 对齐（pad 到字节边界） | 🔴 | 只能 HEX_RAW 手工算长度 → 缺口 G4 |
| 保留 / 占位字段 | ✅ | HEX_RAW 填 00 |
| 校验排除字段 | ✅ | refs 正向选择即可绕开 |
| 长度含头 / 含自身 | ✅ | 公式常量偏移（`[len]+2`） |

## 三、字节 / 位布局（值 → 字节怎么摆）

| 场景 | 状态 | 证据 / 备注 |
|---|---|---|
| 字段级 BE/LE 混排 | ✅ | E1-2 `endianness=LITTLE` 整体逆序，双端向量锚定，面板有下拉 |
| 长度域 BE/LE | ⏸ | §8.14 已立暂缓 |
| 位序 LSb0 | ✅ | §8.14 调研确认与 DBC 口径吻合，不推翻 |
| **帧字节转义（0x7D 类框架字节）** | ✅ | §8.16 **N4**（真机验证通过 2026-09-30，第 10 单已提交 `b7f9fa7`）：传输层·内核转义后套壳 —— 传输配置 `escape {enabled, pairs}` 零 DDL、单趟映射覆盖 0x7D 字头 / 0x10 前缀 / 非前缀多字节替换、出线三路（dispatch 裸发·套壳 / 事务 / 序列）接线、replay 不二次转义、外壳 `FA FA…ED` 字面不转、关闭态逐字节不变 → 缺口 G3 已解（`orchestrator.py` 占位注释保留，编码链不在此转义） |
| varint / COBS 组帧 | ⏸ | §8.14 已立暂缓 |
| 加扰 / 混淆 | ⚪ | 无 → 挂账 |

## 四、运行 / 加工期（下半程）

| 场景 | 状态 | 证据 / 备注 |
|---|---|---|
| 三态录入（HEX/DEC/BIN）+ 钳制 + 前缀 | ✅ | §8.13 批 1 + §8.14 优化 1 |
| 值表下拉与名称回显 | ✅ | §8.14 优化 2 |
| 输入 → 派生字段联动 | ✅ | 公式引擎 / computedValue（仅四则，**无条件表达式**→ 条件长度归 G1 族） |
| **按输入值选指令模板 / 报文** | 🔴 | G1 的运行期形态 |
| 解码回程 bytes→fields | ⏸ | §8.14 已立暂缓（encode-only 既有边界） |
| 输入范围 / 格式校验 | ✅ | SmartInput maxLength + 数值域钳制 |
| 校验清单 → 画布标色 | ✅ | §8.15（本批第 6 单） |

## 五、工程护栏（防线，非业务场景）

| 事项 | 状态 | 备注 |
|---|---|---|
| 未知 op_code 入库静默错码 | ✅ | FE 保存前 W5 `OP_UNKNOWN` 提醒已上（N1，已知全集 = OP_CODES ∪ encoder legacy，STRING 自动跟随）；BE 白名单拒绝策略仍挂账（须先摸存量 op 全集）→ G5 按定案落地 |
| 创建后切换 op | ⚪ | 属性面板 op_code 只读，只能删了重建 → 挂账 |
| STRUCT 有口径无创建入口 | ✅ | N1 定性：正式定为**存量兼容口径、不补创建模板**（`ARRAY_GROUP+repeat=NONE` 已覆盖纯结构组语义）→ G6 已结 |

---

## 新缺口清单（本轮盘查首次记录）

| # | 缺口 | 定级 | 去向 |
|---|---|---|---|
| **G1** | 条件分支 / 变体族（分支、可选字段、TLV、按值路由） | ✅ 已解 | §8.16 **N3** 组级 presence（真机验证通过 2026-09-30，第 9 单已提交 `8e9612f`）：静态三态 + fail-open + IF 角标 + 面板往返 + JSON 零 DDL 落库实测；设计期双支并列建模 + 运行期 inputs 翻转（多指令自动路由为 N3 范围外）；存量零 `pc.value` → 静态 0B 门需 ref 带 value（见 §8.16 N3 状态行） |
| **G2** | 字符串三连（无入口 / 不定长 / 非 ASCII 脏字节） | ✅ 已解 | §8.16 **N2**（真机验证通过 2026-09-30，第 8 单已提交 `848e248`） |
| **G3** | 帧字节转义 escaping（后端空 placeholder） | ✅ 已解 | §8.16 **N4**（真机验证通过 2026-09-30，第 10 单已提交 `b7f9fa7`）：层位定案「传输层 · 内核转义后套壳」，配置骑 transport config JSON 零 DDL；**内核域按逻辑字节、壳域按线上字节**；画布与 `/compile/*` 预览仍为逻辑帧，线上字节见发送历史 raw 事件 |
| **G4** | 填充 / 对齐 | ✅ 已解 | §8.16 **N5**（真机验证通过 2026-09-30，第 11 单已提交 `d8f0d65`）：字段级 `align`（内容起点补到 N 边界）/ `pad_to`（内容末尾补到 N 边界）/ `pad_byte` 骑 `parameter_config` 零 DDL；归一 1..4096 非法 → 0 fail-open（`ALIGN_INVALID`/`PAD_TO_INVALID` 提醒，pad_byte 非法静默 0x00，零 error 不锁保存）；pad 进发射流/偏移尺/LEN/卡宽（卡间空隙即填充字节）、不进长度公式/checksum/byteMap/页脚 LEN（内容口径）；presence 未命中与 repeat=0 不补、LITTLE 反转不涉 pad；FE=BE byte-equal + `/dispatch` 裸发 echo 实测 |
| **G5** | 未知 op 静默错码无护栏 | ✅ 已解（定案范围） | §8.16 **N1** FE W5 提醒已上；BE 白名单挂账（存量摸底后另排） |
| **G6** | STRUCT 创建入口缺失 | ✅ 已定性 | §8.16 N1：正式定为存量兼容、不补模板 |
| **G7** | float64 可配出但静默错码（FE/BE 还不一致） | ✅ 已按定案落地 | §8.16 **N1** 校验提醒摘陷阱（模板不动） |

## 挂账（软缺口，有替代，不排期）

- 绝对时间戳 epoch 模板（INT_UNSIGNED 手工顶）
- 加扰 / 混淆字段
- 创建后切换 op（删建即可）
- BE 保存侧 op 白名单拒绝——**前置摸底已完成（2026-09-30，只读）**：存量
  `instruction_fields` 31 行的 op_code 全集 = {HEX_RAW 9, LENGTH_CALC 5,
  INT_UNSIGNED 5, MAPPING 4, CHECKSUM_CRC 3, ARRAY_GROUP 2, TIME_ACCUMULATOR 1,
  INT_SIGNED 1, AUTO_COUNTER 1}，**9 种全部在 KNOWN_OPS（SEED 14 ∪ legacy 5）
  之内**，无 legacy（INPUT/FIXED/HEADER/TAIL/CALCULATED 0 行）、无未知 op、
  无存量 `pc.type='string'` 字段 → 白名单取 KNOWN_OPS 全集**不会锁死任何历史
  数据**，策略（保存侧 400 拒绝 vs 仅警告）可随时拍板插队，不再阻塞于摸底。
- 帧转义之外的组帧族（varint/COBS——已立 §8.14 暂缓，不重复排）
