// R30 (§8.62) / R31 (§8.63) / R32 (§8.64) 共用的 **presence 比较口径**（叶子模块：
// 零依赖 → 任何一层都能 import，绝不产生环）。
//
// 为什么单独成文件：同一条「为什么判不等」的解释要出现在**两个**地方 ——
//   · 加工页 / 步骤编辑器的角标 hover（R30 · resolvePresenceStates 的 title 追加）
//   · 指令管理页设计期的校验提醒（R31 · W PRESENCE_* 提醒）
// 而 R32 更进一步：**判定本身**（FE 运行期 / FE 设计期 / BE 编译期三处）也必须
// 走同一个谓词 `presenceEqual`，否则「角标说命中、卡面按 0 字节排偏移、后端却出
// 字节」这类分叉会立刻出现。改一必改二。
//
// 硬性质：纯函数、不 import 任何东西 —— 判定的语义 SSOT 是本文件的
// `presenceEqual`（与 BE `_presence_hit` byte-equal），各层只负责 fail-open 前置。

/**
 * 整串十六进制 → 数值。**仅接受字符串**（R32：JSON 数字不按 hex 解，现状不变）。
 * 只允许 `0-9A-Fa-f`（非空、无前缀、无空白）——`parseInt('0x1',16)` 这类前缀形态
 * 一律拒绝，避免把用户写错的东西也"解释"成相等；不可解析 → NaN。
 * **不做 trim**：`" 1"` 不是整串 hex（拍板范围是补零/进制，不含空白容错）。
 * 超出 JS 安全整数 → NaN（BE 同阈 2^53-1，双端精度一致、不会分叉）。
 */
export const hexNorm = (v) => {
    if (typeof v !== 'string') return NaN;
    if (v === '' || !/^[0-9A-Fa-f]+$/.test(v)) return NaN;
    const n = parseInt(v, 16);
    return Number.isSafeInteger(n) ? n : NaN;
};

/**
 * 当前值 → 可比较的数：number 原样；**不带空白**的十进制字符串取 Number；其余 NaN。
 * （`'01'` 走十进制 → 1；`'0A'` 含字母 → NaN —— 十六进制解释交给 hexNorm。）
 */
export const comparableNumber = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (typeof v === 'string' && /^[+-]?\d+(\.\d+)?$/.test(v)) {
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
};

/**
 * **补零 / 进制假阴性**谓词：按十六进制解析相等、按 String 归一判不等。
 * 三条同时成立才返回 `{ expectNum, valueNum }`，否则 null：
 *   1. expect 整串十六进制可解析（`ALPHA` / `0x1` → NaN → 不算）
 *   2. 当前值可比较为数
 *   3. 两个数值相等 **且** String 归一确实判不等（本来判等 → 没有"判不等"这回事）
 * 调用方各自决定要不要挂在 miss 侧 / 静态值上 —— 本谓词只做数学判断。
 */
export const radixPadMismatch = (expectVal, valueVal) => {
    const expectNum = hexNorm(expectVal);
    const valueNum = comparableNumber(valueVal);
    if (!Number.isFinite(expectNum) || !Number.isFinite(valueNum)) return null;
    if (expectNum !== valueNum) return null;
    if (String(expectVal) === String(valueVal)) return null;
    return { expectNum, valueNum };
};

/**
 * **presence 判定的比较谓词**（R32 · §8.64 拍板）：先按 `String()` 归一判等
 * （数值 1 命中 `"1"`，N3 存量口径逐字保留），不等再按**十六进制归一**判等
 * （`"01"` ≡ 1、`"0A"` ≡ 10）—— 样本 ② 的病根。
 * 三个判定点**必须同用本函数**（改一必改二，双端还有 field_blocks._presence_hit）：
 *   · utils/InstructionEncoder._presenceHit      —— FE 运行期（inputs/computed 值链）
 *   · utils/byteOffsets.presenceStaticState     —— FE 设计期静态链（偏移尺/卡面）
 *   · backend/core/field_blocks._presence_hit   —— BE 编译期（byte-equal 锚点）
 * 调用方**先做 fail-open 前置**（expect 空 / ref 无值 → 恒命中），本函数只管比对。
 */
export const presenceEqual = (expectVal, valueVal) =>
    String(expectVal) === String(valueVal) || radixPadMismatch(expectVal, valueVal) !== null;

// 选项值归一：与 InstructionEncoder.getInitialValues 同一口径（十六进制样字符串
// → 数值）。存储态是数值 —— 若选项值仍是 hex 串，String(opt.value) 永远对不上
// String(displayValue)，受控 <select> 会渲染成空白。
export const normalizeOptionValue = (v) =>
    (typeof v === 'string' && /^[0-9A-Fa-f]+$/.test(v)) ? (parseInt(v, 16) || 0) : v;

// 接受：{label,value} 对象数组 / 基本类型数组 / 对象映射 → 规范化的选项数组。
export const formatEnumOptions = (rawOptions) => {
    if (Array.isArray(rawOptions)) {
        return rawOptions.map(opt => (typeof opt === 'object'
            ? { ...opt, value: normalizeOptionValue(opt.value) }
            : { label: String(opt), value: normalizeOptionValue(opt) }));
    }
    if (rawOptions) {
        return Object.entries(rawOptions).map(([k, v]) => ({ label: k, value: normalizeOptionValue(v) }));
    }
    return [];
};

/**
 * 引用字段的**全部可取值**（设计期能穷举的候选集）：下拉选项归一值 + 静态 pc.value。
 * 集合为空 → 调用方**不得**下"恒不成立"的结论（取值不封闭，判据不成立）。
 */
export const enumCandidates = (rawOptions, staticValue) => {
    const vals = formatEnumOptions(rawOptions).map(o => o.value);
    if (staticValue !== undefined) vals.push(staticValue);
    return vals;
};
