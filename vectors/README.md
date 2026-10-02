# vectors/ —— 双端共享向量表（CP2b · D11 分段 ①）

**单一真相源**：本目录的 `*.json` 就是后端（Python）与前端（JS）测试钉的同一张向量表。
**新增 / 修改向量只写这里一处**——两端测试各自读取，不再有「改一必改二」的手抄同步。

> 迁移前的形态：同一张表在 `backend/tests/*.py` 与 `frontend/src/**/__tests__/*.js`
> 各抄一份，靠注释「逐行同步，改一必改二」维持一致（D11-① 的痛点）。
> 迁移由 CP2b 完成：14 张平面向量表 + 1 处三处同值场景树（`wrap.json`）。

---

## 1. 跨语言特殊值约定（2026-10-01 拍板：`$v` 包装对象）

JSON 没有 `Infinity` / `NaN`，而向量里确实要喂这两个值（如 `[NaN, 1, "00"]`）：

| 语义 | JSON 写法 | Python 解出 | JS 解出 |
|---|---|---|---|
| 正无穷 | `{"$v": "Infinity"}` | `float("inf")` | `Infinity` |
| 负无穷 | `{"$v": "-Infinity"}` | `float("-inf")` | `-Infinity` |
| 非数 | `{"$v": "NaN"}` | `float("nan")` | `NaN` |

- **其余标量按 JSON 原型天然分型**：`null` / `true` / 数字 / 字符串。
  因此字符串输入 `"1e3"`、`"-4"`、`""` 与数值 `1.5`、`0` 不会互相混淆——
  这正是「为什么不用字符串哨兵」的原因（哨兵会和真字符串撞车）。
- 特殊值对象**只允许恰好一个 `$v` 键**；加载器遇到 `$v` 携带未知值或混键**直接抛错**
  （不 fail-open，防止把畸形标记当普通对象静默放行）。
- `nan` 的比较：Python `nan != nan` 与 JS `NaN !== NaN` 同为「永不相等」，
  所以所有向量都以**期望 hex** 作断言，不直接比较浮点值。

## 2. 读法（两端加载器逐条同口径，改一必改二）

| 端 | 写法 |
|---|---|
| 后端 | `from vectors.load_vectors import load_vectors`<br>`load_vectors("<name>")` → 顶层数组；`load_vectors("<name>", "<key>")` → 多表对象取表 |
| 前端 | `import { loadVectors } from '../../../../vectors/vectors.js';`<br>`import raw from '../../../../vectors/<name>.json';` → `loadVectors(raw)` / `loadVectors(raw.<key>)` |

- 前端相对路径按测试文件位置上溯到仓库根：现有 5 个消费文件都在
  `frontend/src/utils/__tests__/`，故为 `../../../../`。
- 文件形态：**顶层数组 = 单表**；**顶层对象 = 多表**（用 key 取，如 `bcd_scaled.bcd`）。
- 严格 JSON（不带注释）：Vite/vitest 的 JSON import 与 Python `json` 都只吃标准 JSON，
  行注见本文末尾「行注归档」。
- 迁移时已校验：**无任何大于 2⁵³−1 的整数**，JS `Number` 精度无损。

## 3. 表清单（12 文件 / 15 表）

| JSON | 表 · 行数 | 后端消费 | 前端消费 |
|---|---|---|---|
| `int_signed.json` | 24 | `test_encode_int_signed.py::VECTORS` | `InstructionEncoder.test.js` E1-1 |
| `little_endian.json` | 7 | `test_encode_little_endian.py::VECTORS` | 同上 E1-2 |
| `bcd_scaled.json` | `bcd` 17 · `scaled` 16 | `test_encode_bcd_scaled.py` | 同上 E1-3 |
| `float_ieee.json` | 22 | `test_encode_float_ieee.py::VECTORS` | 同上 E1-4 |
| `repeat.json` | 11 | `test_encode_repeat.py::VECTORS` | 同上 E1-5 |
| `time_counter.json` | `time` 5 · `auto` 11 | `test_encode_time_counter.py` | 同上 E1-6 |
| `string.json` | 13 | `test_encode_string.py::VECTORS` | 同上 STRING |
| `align.json` | 16 | `test_encode_align.py::VECTORS` | `InstructionEncoder.align.test.js` |
| `presence.json` | `leaf` 13 · `group` 5 | `test_encode_presence.py` | `InstructionEncoder.presence.test.js` |
| `escape.json` | 7 | `test_escape.py::VECTORS` | `escapeTable.test.js` |
| `bitfield.json` | `pack` 7 | `test_protocol_bitfield.py::PACK_VECTORS` | `bitGrid.test.js` |
| `wrap.json` | `main`：children 4 + payloads 1 + expect | `test_frame_builder.py` · `test_wrap_api.py` | `blockMerge.test.js` |

> `wrap.json` 是三处同值场景树（`FA FA / 02 / 01 02 / ED`），迁表前在三个文件里各写一遍。

## 4. 形状差异适配（值不变，各端在测试侧归一）

JSON 只有一种表达，两端原本的记法差异靠 **3 个稳定适配**消掉：

1. **`null` ↔ `undefined`**（JSON 无 `undefined`）：后端 `None` 落成 JSON `null`，
   FE 侧在 `repeat.ref_value`、`bcd_scaled.scaled.factor/offset`、`string.encoding/pad_char`
   用 `?? undefined` 还原成「不写键」——否则 `Number(null) === 0` 会把「缺省」误当 0。
2. **`children` ↔ `fields`**（align 组树键名）：BE 组节点用 `children`、FE 用 `fields`，
   FE 侧 `toFe()` 递归改名。
3. **`[start, len, default]` 三元组 ↔ `{start_bit, bit_len, default_val}`**（bitfield）：
   FE 侧 `map` 归一，并把期望 hex 去空格后与两端实现同钉。

> `wrap.json` 里 BE 的 `config: {}` 等冗余键 FE 直接忽略，无需适配（已由
> `blockMerge.test.js` 30 例钉住）。

## 5. 尚未迁入的「同源」锚点（**不是**向量表）

以下两端仍然各自持有一份，因为它们钉的是**实现语义**而非同一张数据表，改一必改二依然成立：

- `backend/core/pad.py` ↔ `frontend/src/utils/padSpec.js`（padSpec 口径）
- `backend/routers/op_whitelist.py` ↔ FE `validateInstruction` 的 `KNOWN_OPS`
- `backend/core/escape.py` 的转义语义 ↔ `escapeTable.js`（表已共享，实现仍双写）

## 6. 验收方式（防分叉的自动化口径）

迁表的收口不是「跑一次绿」，而是**持续拦住回潮**。四道闸全部是可执行用例：

| 闸 | 执行者 | 拦什么 |
|---|---|---|
| 消费矩阵 | `backend/tests/test_vectors_manifest.py::test_every_vector_table_consumed_by_both_sides` | 每张 `vectors/*.json` 必须同时被**后端测试 + 前端测试**引用；单侧消费即红（正是手抄时代的失守方式：另一端改实现不再报警） |
| 引用可解析 | 同文件 `test_load_vectors_references_all_resolve` | 测试里 `load_vectors("<name>")` 引用的表必须真实存在（新增表忘落 JSON / 改名漏改 → 红） |
| 可读 + `$v` 纪律 | 同文件 `test_every_table_readable_and_non_empty` / `test_illegal_v_markers_rejected` + 前端 `frontend/src/utils/__tests__/vectorsLoader.test.js` | 表非空可读；`$v` 混键 / 未知值两端同口径抛错；FE 侧表清单与 `vectors/` 目录**同集**（新增 JSON 忘登记 → 红） |
| 入库卫生 | 同文件 `test_repo_ignores_python_bytecode` | `.gitignore` 必须含 `__pycache__/` 与 `*.py[cod]`，且 `git ls-files` 索引里不得有 `__pycache__` / `*.pyc`（加载器会在本目录生成 `vectors/__pycache__`） |

- **两张验收单不重复扫仓**：后端那份扫两侧文件做矩阵，前端这份只测自己这半（加载器
  约定 + 目录同集），两侧的「验收单自身」都被排除在消费统计之外 —— 它们只扫描、
  不钉数据，不能算数。
- **新增一张向量表的固定动作**：落 `vectors/<name>.json` → 后端测试 `load_vectors("<name>")`
  引用 → 前端测试 `import ... 'vectors/<name>.json'` 引用 → 前端 `TABLES` 登记一行。
  少任何一步，四道闸之一当场红。
- **迁移范围与遗留**：范围 = 11 张平面向量表 + `wrap.json` 三处同值场景树（§3 表清单）；
  不迁的是**实现语义锚点**（`pad.py`↔`padSpec.js`、白名单、转义实现）—— 那些仍各自
  一份、改一必改二（§5）。

## 7. 行注归档

迁表时两端测试里的逐行注释（JSON 不支持注释）按表归档于此，`#N` = 该表下标（0 起）。


### align.json

- `#0` align 已对齐 → 0 补位
- `#1` align 补 1 / 补 3
- `#3` pad_to 帧尾补 2
- `#4` pad_byte 改填充字节值
- `#5` align + pad_to 同字段：内容起点 4、内容末尾 5 → 补到 8（补 3）
- `#6` 组级 align：组内容起点补位到 4（归入前一字段的 span）
- `#7` 重复组内子字段 align：逐副本按绝对偏移算（非 Σ×reps 常数）
- `#8` presence 未命中 → 字段与 pad 都不发
- `#9` presence 命中 → 照常补位
- `#10` pad_to 在末副本之后补一次（副本共 2 字节 → 补 6）
- `#11` LITTLE：pad 不参与反转（pad 在反转后的字段字节之外）
- `#12` 非法 align → 忽略（fail-open）
- `#14` 数值串 → 归一（同 byte_len 的 Number/floor 口径）
- `#15` 非法 pad_byte → 0x00

### bcd_scaled.json[bcd]

- `#0` [value, byte_len, expected] — floor 解析、abs、超长截高位保低 2n 位
- `#13` byte_len=0 不入表：FE 既有 `byte_len || 1` 归一 / BE `>0` 守卫属通用边角，非 B3 语义

### bcd_scaled.json[scaled]

- `#0` (5+10)*2=30
- `#0` [value, factor, offset, byte_len, expected] — (v+off)*fac → abs(floor) → 定宽
- `#1` 恒等回归（factor/offset 缺省）
- `#2` 空串=缺省 恒等
- `#3` floor
- `#4` abs(floor) 口径（通用路径一致）
- `#7` 溢出截高位 mod 2^8
- `#8` 非有限 → 0
- `#9` 数字字符串 base
- `#10` factor 数字字符串
- `#11` (7+2.5)=9.5 → floor 9

### float_ieee.json

- `#0` [value, expectedHex] — IEEE 754 float32 大端（网络序），恒 4 字节
- `#12` 严格十进制字符串
- `#13` 非法串 → 0
- `#14` 拒指数记法（同 E1-1 正则）→ 0
- `#17` 非有限 → 0
- `#20` 超 f32 范围 → +Infinity（IEEE 溢出）

### little_endian.json

- `#0` [endianness, op, byte_len, cfg, expectedHex] — 先按大端出值，再整体逆序
- `#0` 大端 FFFE → FEFF
- `#2` 单字节不动
- `#4` 小写容错归一
- `#5` 缺省 BIG 回归
- `#6` 显式 BIG 回归

### presence.json[group]

- `#0` 未命中 → 连 ×3 都不展开
- `#1` 命中 → ×3
- `#3` fail-open → 照常展开
- `#4` 悬空 fail-open → 照常展开

### presence.json[leaf]

- `#0` 命中
- `#1` 未命中
- `#2` String 严格归一（'1' ≠ '01'）
- `#3` 不 trim，严格比较
- `#4` fail-open：非对象字段缺失
- `#5` fail-open：缺 expect
- `#6` fail-open：缺 ref_id
- `#7` fail-open：非对象
- `#8` fail-open：null
- `#9` fail-open：ref 悬空
- `#10` fail-open：expect null
- `#11` fail-open：expect 空串
- `#12` 数值 expect 命中字符串值

### repeat.json

- `#4` floor → ×2
- `#5` 非 number 防御 → ×1
- `#6` ref 静态 value → ×2
- `#7` 严格十进制字符串
- `#8` 非法串 → 0 份
- `#9` ref 字段无 value → 0 份
- `#10` ref_id 悬空 → 0 份

### time_counter.json[auto]

- `#0` (5+1)%10
- `#1` 回绕到 0
- `#2` 负值双重取模 → 7（JS/Python 同）
- `#3` max 缺省 → 不回绕
- `#4` step 缺省 → 0；负值无回绕 → abs 现状
- `#5` value 缺省 → start_val
- `#6` step 非法 → 0；max 非正 → 不回绕
- `#7` (9+5)%7 = 0
- `#8` value=0 显式（不落到 start_val）
- `#9` byte_len=1
- `#10` 严格十进制字符串 Current

### time_counter.json[time]

- `#0` 100s
- `#1` 90s（naive 本地时区）
- `#2` now < base → -5 → abs
- `#3` 超宽截断 300 mod 2^8
- `#4` 90min，空格分隔
