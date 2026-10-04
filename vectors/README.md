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

## 3. 表清单（18 文件 / 24 表）

| JSON | 表 · 行数 | 后端消费 | 前端消费 |
|---|---|---|---|
| `int_signed.json` | 24 | `test_encode_int_signed.py::VECTORS` | `InstructionEncoder.test.js` E1-1 |
| `length_order.json` | 7 | `test_length_byte_order.py::VECTORS` | `protocolTree.test.js` R21 长度字节序 |
| `little_endian.json` | 7 | `test_encode_little_endian.py::VECTORS` | 同上 E1-2 |
| `bcd_scaled.json` | `bcd` 17 · `scaled` 16 | `test_encode_bcd_scaled.py` | 同上 E1-3 |
| `float_ieee.json` | `f32` 22 · `f64` 23 | `test_encode_float_ieee.py::VECTORS` / `::VECTORS64` | 同上 E1-4（R5） |
| `repeat.json` | 11 | `test_encode_repeat.py::VECTORS` | 同上 E1-5 |
| `time_counter.json` | `time` 5 · `auto` 11 | `test_encode_time_counter.py` | 同上 E1-6 |
| `time_epoch.json` | 11 | `test_time_epoch.py::VECTORS` | `timeEpoch.test.js` R23 绝对时间戳 |
| `string.json` | 13 | `test_encode_string.py::VECTORS` | 同上 STRING |
| `align.json` | 16 | `test_encode_align.py::VECTORS` | `InstructionEncoder.align.test.js` |
| `presence.json` | `leaf` 13 · `group` 5 | `test_encode_presence.py` | `InstructionEncoder.presence.test.js` |
| `escape.json` | 7 | `test_escape.py::VECTORS` | `escapeTable.test.js` |
| `checksum_algo.json` | 30 | `test_checksum_algorithms.py::VECTORS` | `checksumAlgo.test.js` R22 CRC 多算法 |
| `bitfield.json` | `pack` 7 | `test_protocol_bitfield.py::PACK_VECTORS` | `bitGrid.test.js` |
| `scramble.json` | 14 | `test_scramble.py::VECTORS` | `scramble.test.js` R25 加扰字段 |
| `condition.json` | 58 | `test_condition.py::VECTORS` | `condition.test.js` R26 序列条件 |
| `framing.json` | `varint` 14 · `cobs` 16 · `frame` 5 | `test_framing.py` | `framing.test.js` R27 varint / COBS 出线 |
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

### checksum_algo.json（R22 · CRC 多算法）

- `algo` —— FE `ChecksumAlgo` 编码（`SUM_8` / `XOR_8` / `CRC_16_MODBUS` /
  `CRC_16_CCITT` / `CRC_32` / `LRC`）；后端经 `frame_builder.BACKEND_ALGO` 翻成
  `sum` / `xor` / `crc16_modbus` / `crc16_ccitt` / `crc32` / `lrc`。
- `data` —— 输入字节的紧凑大写 hex，**恒 ≥ 1 字节**（空输入在出线短路全 0、
  收侧 `crc16(b"") = 0xFFFF` 本就有已知分歧，不入表）。
- `width` —— 断言用的校验字段宽 = 该算法的 `ALGO_FIELD_WIDTH` 下限。
- `expected` —— 大写 hex、按 `width` 左侧零填；**期望值取自外部真值**
  （`crc32 = zlib.crc32`、`crc16_ccitt = binascii.crc_hqx(data, 0xFFFF)`，
  另用三枚已发布 CRC check 值自校验），**不是照本仓实现抄的表**。
- 5 组输入：`00`（单零字节，试左侧零填）/ `01` / `0102`（字节序敏感）/
  `DEADBEEF` / `313233343536373839`（ASCII `123456789`，标准 check 向量）。

### float_ieee.json[f32]

- `#0` [value, expectedHex] — IEEE 754 float32 大端（网络序），恒 4 字节
- `#12` 严格十进制字符串
- `#13` 非法串 → 0
- `#14` 拒指数记法（同 E1-1 正则）→ 0
- `#17` 非有限 → 0
- `#20` 超 f32 范围 → +Infinity（IEEE 溢出）

### float_ieee.json[f64]（R5）

- `#0` [value, expectedHex] — IEEE 754 **float64** 大端（网络序），恒 8 字节；同一 JSON
  分组的两表共用**同一解析口径**（`_float_number` / FE 分支：非有限一律归 0、拒指数记法），
  只差位宽 —— 因此 NaN / ±Inf 输入在两组里都出全零，不会写出 NaN 位型
- `#12` `1e40` —— **两种位宽的分水岭**：f32 溢出 `7F800000`、f64 正常 `483D6329F1C35CA5`
- `#13` `1e300` / `-1e300` —— f32 溢出、f64 有限位型（f64 才能表达的大数域）
- `#15` 严格十进制字符串 `"3.14"` → 同数字 `3.14`
- `#16` 非法串 `"FF"` → 0
- `#17` 拒指数记法 `"1e3"` → 0（同 E1-1 正则）
- `#18` `true` → 1.0、`#19` `false` → 0.0
- `#20..#22` `{"$v":"NaN"}` / `{"$v":"Infinity"}` / `null` → 全零

### length_order.json

> **R21（§8.53 · 2026-10-03，非迁移、按 §6「新增表固定动作」落的新表）**：
> 协议 length 卡字节序出线向量。行键 = `byte_order` / `byte_length` / `total` /
> `expected`；`total` = **引用尺寸之和 Σ**（后端 `LengthHandler` 走 refs 求和、前端
> `strictSigma` 同值），`expected` = 该 `byte_length` 宽度下按 `byte_order` 出线的字节。
> 双端消费：`backend/tests/test_length_byte_order.py` ↔ `frontend/.../protocolTree.test.js`。

- `#0` / `#1` 同 Σ=6、同 2 字节：大端 `0006` ↔ 小端 `0600`（最常见形态）
- `#2` / `#3` Σ=258（0x0102）：高低字节换位最直观（`0102` ↔ `0201`）
- `#4` / `#5` 1 字节 Σ=255：大小端**同值** `FF`（钉住「单字节无差异」边界）
- `#6` 4 字节 Σ=300：整串按字节对逆序（`0000012C` → `2C010000`）

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

### time_epoch.json（R23 · 绝对时间戳）

- `#0` 2023-11-14T22:13:20Z（1700000000 s）4 字节
- `#1` 同刻带 999 ms → floor 截到整秒（期望同 `#0`）
- `#2` 2 字节截低 16 位 → `F100`（位宽不够只截低位、不报错）
- `#3` 1 字节 + 低字节非零（+7 s → `07`，堵「1 字节恒 00」的假绿）
- `#4` 8 字节左侧零填
- `#5` epoch 起点 0 → `00000000`
- `#6` ms 口径 8 字节（1700000000123）
- `#7` ms 口径 4 字节截低 32 位 → `CFE5687B`
- `#8` ms 起点 0 → 全 0
- `#9` `unit` 大写 `MS` → 与 `ms` 等价（双端 `toLowerCase` 同口径）
- `#10` 2025-01-01T00:00:00Z（1735689600 s）4 字节

### scramble.json（R25 · 加扰字段 / 混淆）

一行 = `plain` × `mode` × `seed` × `roll` → `expected`（加扰后 hex，大写无空白）。`mode` 缺键 =
缺省 `XOR_SEED`，`seed` / `roll` 缺键 = 该模式的参数缺省。双端同读（BE `test_scramble.py::VECTORS`
/ FE `scramble.test.js`），口径档案 `frontend/src/utils/scramble.js` ↔
`backend/core/orchestrator.py::encode_scramble`；解码是编码的逆（XOR 自反、左旋逆右旋）→
`decode(encode(x))` 是不动点。

- `#0` XOR 单字节种子 `A5` → `01020304` = `A4A7A6A1`
- `#1` XOR 多字节种子 `5AA5` 按字节循环异或 → `5A5A4A85`
- `#2` 种子比明文长 → 只用得到的前缀（`01^5A = 5B`）
- `#3` **`mode` 缺键** → 缺省 XOR_SEED（`11223344 ^ A5 = B48796E1`）
- `#4` BIT_ROLL `roll=1`：`81` → `03`（bit7 回卷到 bit0）
- `#5` BIT_ROLL `roll=3`：`1F00` → `F800`
- `#6` BIT_ROLL `roll=8` → 恒等（mod 8 归零）
- `#7` BIT_ROLL `roll=-1` → `((n%8)+8)%8 = 7`（抹平 JS 负数 `%` 与 Python 的差异）→ `01`
- `#8` `roll` 是数字串 `"3"` → 与数值同解（`F800`）
- `#9` 契约外 `mode=FOO` → **恒等** fail-open（保存侧 400 先拦，编码侧只求出线有确定值）
- `#10` 非法种子（奇长 `"A"`）→ 恒等（同上，两层各司其职）
- `#11` 明文带空格 `AA 55` → 去空白后加扰 → `0FF0`
- `#12` 奇长明文 `ABC` → 丢末尾半字节只编 `AB` → `AA`
- `#13` **`seed` 缺键** → 空种子恒等（`0F10` 原样出线）

### condition.json（R26 · 序列步骤条件）

一行 = `expr` × `vars` → **`expected`（true / false）或 `error`（预期错误文案）**，二选一。
双端同读（BE `test_condition.py::VECTORS` / FE `condition.test.js`），口径档案
`backend/core/condition.py` ↔ `frontend/src/utils/condition.js`：一条条件 = 一次比较，
运算符恰 6 个（`==` `!=` `>=` `<=` `>` `<` + 关键字 `in`），**无 eval、无括号、无算术、
无布尔连接**；变量名是**一整个裸词**、查表 = **整串精确匹配**（`step.1.status` 是一个键，
不下钻）。`error` 行的文案两端**逐字相同** —— 文案改一必改二。

- `#0`–`#10` 六运算符 + `0x` / `0b` / 小数 / 负号 / 整数与小数同比
- `#11`–`#16` 状态与字符串比较（`step.1.status` 带点键、`>=` 字典序）
- `#17`–`#21` `in` 两形态：**子串**（`"A501" in step.1.received`）与**数组成员**
- `#22`–`#30` `true` / `null` 口径 —— **`null` 只与 `null` 相等**（`nil == 0` → false，
  比大小 → 类型错）
- `#31`–`#34` 中文 / 点号 / 连字符变量名 + 平铺键优先于带点键（整串匹配，非前缀）
- `#35`–`#55` 错误面：类型不可比、`in` 右侧非串非数组、变量未定义、缺运算符、
  多余记号、非法字符、括号与 `&&` 拒收、未闭合字符串 —— **全部 fail-closed**
- `#56`–`#57` 三条上限：长度 200、记号 64（数组 32 是第二道，记号上限先拦）

### framing.json（R27 · varint / COBS 出线）

三张表只钉**编码** —— 收侧 `stages` 逆向解包与应答匹配属 R28，本批一行不碰、也不进表。
双端同读（BE `test_framing.py::load_vectors` / FE `framing.test.js`），口径档案
`backend/core/framing.py` ↔ `frontend/src/utils/framing.js`：两者都不含解码入口（BE 侧由
`test_module_is_encode_only` 字面钉住，FE 侧解码只活在测试的局部参考解码器里）。

- `varint`（14 行）`v` → LEB128 最小长度无符号 `hex`：`#0` 0 → `00`；`#1`–`#3` 单字节与
  7/8 位进位边界（`127 → 7F`、`128 → 8001`）；`#5` `255 → FF01`、`#6` `300 → AC02`；
  `#7`/`#8` 14/15 位边界（`16383 → FF7F`、`16384 → 808001`）；`#9`–`#13` 20/21/28 位
  与 `1000000`、`2^32-1`。值域上限 `2^53-1`、负数与非整数拒收不进表（各端单测钉）。
- `cobs`（16 行）`in`（hex，可空）× `term`（`00` / `none`）→ `out`：
  `#0`/`#1` 空输入两态（`01` / `0100`）；`#2`–`#4` 全零（`00` → `0101`、`0000` → `010101`）；
  `#5`/`#6` 无零字节（`AABB` → `03AABB`，`00` 定界追加在尾）；`#7`–`#10` 零字节插码与
  **尾零收束码**（`AA00BB00` → `02AA02BB01`、`00AABB00` → `0103AABB01`）；`#11` 254×`AA`
  → `FF`+254 字面量（**满块闭合、其后不写收束码**）；`#12` 255×`AA` → 满块 + `02AA`；
  `#13` 254×`AA`+`00` → `FF`+254 字面量+`0101`；`#14` 同上再跟 `BB` → …+`0102BB`；
  `#15` 与 `#13` 同输入但 `term=00` → 尾追加 `00`。`out` 正文一律**无 0x00**（定界除外）。
- `frame`（5 行）整树 → `expect_hex` / `expect_length`：`#0`/`#1` 同树只差 `encoding` 键
  （`varint` Σ=128 → `8001` 2 字节、出线后 `byte_length` 回写 → 132 字节；缺省 `fixed`
  按设计期 1 字节出 `80` → 131 字节）；`#2` COBS 包住含长度卡的子树（`05FAFA010700`）；
  `#3` **`payloads` 非空** —— 载荷注入属发送期 `blockMerge`，FE 编码器测试跳过、BE
  `build_wrapped` 端到端跑；`#4` 子树含 `00` 字节 → COBS 插码（`0102AA00`）。
