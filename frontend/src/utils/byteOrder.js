// ─── R42（§8.74 · `byte_order` trim 归一）：FE 侧唯一的字节序取值判据 ─────────
//
// 为什么要有这个文件 —— 同一件事只许有一处判据。R21（§8.53）与 R34（§8.66）把
// 同一个谓词就地写了三遍（卡面 length 分支 / checksum `isLittleOrder` / 出口翻译
// 闸门），其中只有 `validateProtocol` 的 W5 一路带了 `.trim()`；而 BE
// `handlers/base.py::byte_order_of` 从 R21 起就是 `str(order).strip().lower()`，
// 它的 docstring 还写着「与 FE `String(pc.byte_order).trim().toLowerCase()` 同
// 口径」—— **R42 之前那句在 FE 侧不成立**：同一个值会卡面判大端、出线判小端。
//
// 口径（与 `byte_order_of` 逐字对齐）：
//   - 首尾空白 + 大小写不敏感：`' LITTLE '` ≡ `little`；
//   - 归一后不在 {big, little} → **fail-open 回大端**（枚举判定归调用方，
//     本模块只负责归一，故 W5 的「在枚举内才不报」语义原样不变）；
//   - 缺失 / 空串 = 未配置 → `normalizeByteOrder` 返 `''`（W5 据此「不报」）。
//
// 范围（§8.66 留白原文钉死）：只管**协议 length / checksum 卡的
// `parameter_config.byte_order`**。指令域字段 `endianness`（E1-2 B6）是**另一个
// 域**，不并入；收侧 `response_match` / `sequence_plan` 的枚举 fail-closed 也
// 不在本批范围（本就支持，零改动）。

/** 原始值 → 归一串（`''` = 未配置），镜像 `byte_order_of` 的 `str(...).strip().lower()`。 */
export const normalizeByteOrder = (raw) => String(raw ?? '').trim().toLowerCase();

/** 是否按小端出线 —— 归一后只认 `little`，其余（含枚举外）一律大端 fail-open。 */
export const isLittleByteOrder = (raw) => normalizeByteOrder(raw) === 'little';
