// R30 (§8.62) / R31 (§8.63) 共用的 **presence 比较口径**（叶子模块：零依赖 →
// 任何一层都能 import，绝不产生环）。
//
// 为什么单独成文件：同一条「为什么判不等」的解释要出现在**两个**地方 ——
//   · 加工页 / 步骤编辑器的角标 hover（R30 · resolvePresenceStates 的 title 追加）
//   · 指令管理页设计期的校验提醒（R31 · W PRESENCE_HEX_PAD）
// 两处必须用**同一个谓词**，否则文案与判定会悄悄分叉。改一必改二。
//
// 硬性质：纯函数、不 import 任何东西、不碰判定（判定的 SSOT 仍是
// InstructionEncoder._presenceHit）—— 这里只回答「为什么不等」。

/**
 * 整串十六进制 → 数值。
 * 只允许 `0-9A-Fa-f`（非空、无前缀、无空白）——`parseInt('0x1',16)` 这类前缀形态
 * 一律拒绝，避免把用户写错的东西也"解释"成相等；不可解析 → NaN。
 */
export const hexNorm = (v) => {
    if (v === undefined || v === null) return NaN;
    const s = String(v).trim();
    if (s === '' || !/^[0-9A-Fa-f]+$/.test(s)) return NaN;
    const n = parseInt(s, 16);
    return Number.isFinite(n) ? n : NaN;
};

/**
 * 当前值 → 可比较的数：number 原样；纯十进制字符串取 Number；其余 NaN。
 * （`'01'` 走十进制 → 1；`'0A'` 含字母 → NaN —— 十六进制解释交给 hexNorm。）
 */
export const comparableNumber = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (typeof v === 'string' && v.trim() !== '' && /^[+-]?\d+(\.\d+)?$/.test(v.trim())) {
        const n = Number(v.trim());
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
