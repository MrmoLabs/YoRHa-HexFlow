// Render rules for the processing page's dynamic send form
// (components/InstructionForm/RunnerFieldTree.jsx).
// Extracted verbatim from RunnerFieldTree render logic (behavior unchanged);
// pure functions so every rule is unit-testable in isolation.
// NOTE: these rules only drive DISPLAY. Encoding semantics live in
// utils/InstructionEncoder.js / backend/core/orchestrator.py — keep in sync.

import { mapChecksumAlgo } from '../utils/normalizeInstruction';
import { getParamKeyLimitRef } from '../utils/encoderLimits';

// DRY Helper: Get Date object for the field's base time (epoch).
// Accepts both 'YYYY-MM-DDTHH:mm:ss' and 'YYYY-MM-DD HH:mm:ss'.
export const getFieldEpoch = (params = {}) => {
    const baseTimeStr = params.base_time || '2000-01-01T00:00:00';
    return new Date(baseTimeStr.includes('T') ? baseTimeStr : baseTimeStr.replace(' ', 'T'));
};

// A4: pack BITFIELD default_val bits into the exact hex the encoder emits
// (display-only mirror of InstructionEncoder's BITFIELD branch).
export const packBitfieldDefault = (bits, byteLen) => {
    let packed = 0;
    (Array.isArray(bits) ? bits : []).forEach(b => {
        const start = Number.isFinite(Number(b.start_bit)) ? Number(b.start_bit) : 0;
        const len = Math.max(1, Number.isFinite(Number(b.bit_len)) ? Number(b.bit_len) : 1);
        const mask = len >= 32 ? 0xFFFFFFFF : ((1 << len) - 1);
        const raw = Number.isFinite(Number(b.default_val)) ? Number(b.default_val) : 0;
        packed |= (raw & mask) << start;
    });
    packed = packed >>> 0;
    const target = Math.max(1, byteLen) * 2;
    return packed.toString(16).toUpperCase().padStart(target, '0').slice(-target);
};

// 批 1：字段级录入进制。定义侧 BlockPropertiesPanel 参数区顶部固定行写
// parameter_config.input_base（'hex' 缺省 / 'dec'）——加工页据此把定长整数字段
// 从 hex 通道切到十进制通道。只换 UI 解析/回显层：值存储恒数值，
// InstructionEncoder / 后端口径不变。非法值一律回退 hex（存量零影响）。
export const isDecimalEntry = (params = {}) =>
    String(params.input_base || '').toLowerCase() === 'dec';

// 优化批 1（市场调研）：三态进制第三态 —— 二进制（位模式）录入/回显。
// 与 dec 同族：只换 UI 解析/回显层，值存储恒数值 → encoder/后端口径不变。
export const isBinaryEntry = (params = {}) =>
    String(params.input_base || '').toLowerCase() === 'bin';

// 十进制通道的显示值：数值原值（不补零）。BITFIELD 无输入态回退的是
// packBitfieldDefault 的 hex 串 → 按 hex 解析回打包整数，与 hex 通道同值。
const toDecimalValue = (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v === 'number') return v;
    const s = String(v).trim();
    if (/^[0-9A-Fa-f]+$/.test(s)) return parseInt(s, 16);
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
};

// 二进制通道的显示值：按位宽定宽位模式串（负数按字节宽两补码位模式；
// 超宽取模）。BITFIELD 的 hex 串默认值经 toDecimalValue 同源转换。
const toBinaryValue = (v, bitWidth) => {
    const n = toDecimalValue(v);
    if (n === undefined || !Number.isFinite(n)) return undefined;
    const width = Math.max(1, Math.floor(bitWidth));
    const modulus = Math.pow(2, width);
    const u = ((Math.floor(n) % modulus) + modulus) % modulus;
    return u.toString(2).padStart(width, '0');
};

// Field classification: which render lane a leaf field lands in.
// NOTE: Fixed detection also falls back to preserved original_op_code
// (normalizeRunnerInstruction may rewrite op_code to 'FIXED'/'INPUT').
export const classifyRunnerField = (field = {}) => {
    const params = field.parameter_config || {};
    const originalOp = String(field.original_op_code || '').toUpperCase();

    const isCalculated = field.op_code === 'CALCULATED'
        || field.op_code === 'LENGTH_CALC'
        || field.op_code === 'CHECKSUM_CRC'
        || params.formula === 'auto'
        || params.type === 'length'
        || params.type === 'checksum';

    const isTimeCumulative = field.op_code === 'TIME_CUMULATIVE'
        || originalOp === 'TIME_CUMULATIVE'
        || originalOp === 'TIME_ACCUMULATOR'
        || params.type === 'time_cumulative';

    // Boolean(): the || chain ends in params.readOnly which may be undefined
    // (original code relied on falsy — coerce so the flag is always a boolean).
    const isFixed = Boolean(field.op_code === 'FIXED'
        || originalOp === 'HEX_RAW'
        || originalOp === 'FIXED'
        || field.op_code === 'HEX_RAW'
        || params.readOnly)
        && !isTimeCumulative;

    const isEditable = !isCalculated && !isFixed;

    const rawOptions = params.options;
    const hasOptions = Boolean(rawOptions && (Array.isArray(rawOptions)
        ? rawOptions.length > 0
        : Object.keys(rawOptions).length > 0));
    const isEnum = hasOptions || field.op_code === 'MAPPING';

    return { params, originalOp, isCalculated, isTimeCumulative, isFixed, isEditable, hasOptions, isEnum };
};

// Normalize option values with the SAME rule InstructionEncoder.getInitialValues
// uses (hex-looking string -> number). The stored input state is numeric, so if
// option values stayed hex strings, String(opt.value) would never match
// String(displayValue) and the controlled <select> renders blank.
const normalizeOptionValue = (v) =>
    (typeof v === 'string' && /^[0-9A-Fa-f]+$/.test(v)) ? (parseInt(v, 16) || 0) : v;

// Accepts: array of {label,value} objects / array of primitives / object map.
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

// TIME_CUMULATIVE display: seconds since base_time -> 'YYYY-MM-DD HH:mm:ss'.
// Negative seconds (before base time) are allowed.
export const formatTimeDisplay = (params, seconds) => {
    const base = getFieldEpoch(params);
    const current = new Date(base.getTime() + (seconds * 1000));
    const pad = n => n.toString().padStart(2, '0');
    return `${current.getFullYear()}-${pad(current.getMonth() + 1)}-${pad(current.getDate())} `
        + `${pad(current.getHours())}:${pad(current.getMinutes())}:${pad(current.getSeconds())}`;
};

// Resolve the final controlled-input triple for a leaf field.
// Returns { displayValue, placeholder, inputType, options }.
export const resolveFieldDisplay = (field, { inputs = {}, computedValues = {} } = {}) => {
    const { params, originalOp, isCalculated, isTimeCumulative, isFixed, isEditable, isEnum }
        = classifyRunnerField(field);
    const options = formatEnumOptions(params.options);

    let displayValue = '';
    let placeholder = '';
    let inputType = !isEditable ? 'text' : (isEnum && options.length > 0 ? 'select' : (params.type || 'number'));

    if (isFixed) {
        // 1. Fixed / ReadOnly Fields: Show the exact HEX or Value
        const isExplicitHex = originalOp === 'HEX_RAW' || field.op_code === 'HEX_RAW';
        let rawVal = params.hex || params.value;

        if (!rawVal && isExplicitHex) {
            // Default to Zero based on byte_len if missing
            rawVal = '00'.repeat(field.byte_len || 1);
        }

        displayValue = String(rawVal || '').toUpperCase();

        if (!displayValue) {
            placeholder = 'NO DATA';
        }
    } else if (isTimeCumulative) {
        // 2. TIME CUMULATIVE: seconds since base_time, shown formatted/read-only
        displayValue = formatTimeDisplay(params, inputs[field.id] || 0);
        inputType = 'text';
    } else if (isCalculated || isEnum) {
        // 3a. Calculated: computedValues is source of truth, hex-formatted
        if (isCalculated) {
            displayValue = computedValues[field.id] !== undefined ? computedValues[field.id] : 0;
            inputType = 'hex';
            if (typeof displayValue === 'number' && field.byte_len !== undefined) {
                if (field.byte_len === 0) {
                    displayValue = '';
                } else {
                    const targetLen = field.byte_len * 2;
                    displayValue = displayValue.toString(16).toUpperCase().padStart(targetLen, '0').slice(-targetLen);
                }
            }
        } else {
            // 3b. Enum: inputs is source of truth (computedValues as fallback)
            displayValue = inputs[field.id] !== undefined ? inputs[field.id] : (computedValues[field.id] || 0);
        }
    } else {
        // 4. Plain editable input
        let rawValue = inputs[field.id];
        // A4: until the user provides an input, show the packed default_val
        // bytes — the value the encoder actually emits for BITFIELD.
        if (rawValue === undefined && field.op_code === 'BITFIELD') {
            rawValue = packBitfieldDefault(field.bits, field.byte_len || 1);
        }
        if (field.byte_len && field.byte_len > 0) {
            const currentVal = rawValue ?? 0;
            if (!params.type || params.type === 'number' || params.type === 'hex') {
                // 批 1：字段级录入进制（定义侧 parameter_config.input_base）。
                // dec = 十进制录入/回显（不补零）；值存储恒数值 → encoder 无感。
                if (isDecimalEntry(params)) {
                    inputType = 'decimal';
                    displayValue = toDecimalValue(rawValue);
                    placeholder = '0';
                } else if (isBinaryEntry(params)) {
                    // 优化批 1：二进制位模式回显（按位宽补零）。
                    inputType = 'binary';
                    const width = field.byte_len * 8;
                    displayValue = toBinaryValue(rawValue, width);
                    placeholder = '0'.repeat(width);
                } else {
                    inputType = 'hex';
                    if (typeof currentVal === 'number') {
                        displayValue = currentVal.toString(16).toUpperCase().padStart(field.byte_len * 2, '0');
                    } else {
                        displayValue = String(currentVal || '').toUpperCase();
                    }
                    placeholder = '0'.repeat(field.byte_len * 2);
                }
            } else {
                displayValue = rawValue;
            }
        } else {
            displayValue = rawValue;
            placeholder = '?? [VAR]';
        }
    }

    return { displayValue, placeholder, inputType, options };
};

// A6: surface semantic params (scale factor/offset, counter step/max,
// checksum algo, ...) the send form would otherwise hide from the operator.
// Each item may carry an encoder-limit ref (B4/B7/B8...) -> ⚠ badge in UI.
export const collectSemanticItems = (field = {}) => {
    const params = field.parameter_config || {};
    return [
        ['factor', 'FACTOR'], ['offset', 'OFFSET'], ['step', 'STEP'], ['max', 'MAX'],
        ['start_val', 'START'], ['bytes', 'BYTES'], ['max_count', 'MAX LOOP'],
        ['algorithm', 'ALGO'], ['algo', 'ALGO']
    ].reduce((acc, [k, label]) => {
        if (k === 'algo' && params.algorithm !== undefined) return acc; // prefer encoder key
        const raw = params[k];
        if (raw === undefined || raw === null || raw === '') return acc;
        const shown = (k === 'algorithm' || k === 'algo') ? mapChecksumAlgo(raw) : raw;
        acc.push({ text: `${label}=${shown}`, ref: getParamKeyLimitRef(k, field.op_code) });
        return acc;
    }, []);
};

// 第 4 批 #4：定长字段输入限制 —— 指令管理里 byte_len 定死的字段，加工页
// 不允许超长/超范围输入。返回 { byteLen, maxLength?, min?, max? } 或 null（不设限）。
// - 不设限：只读/计算/时间字段（不可键入）、枚举（选项即约束）、
//   string/text/float/decimal（非整数域）、无有效 byte_len；
// - hex 通道（params.type 缺省/number/hex —— resolveFieldDisplay 分支 4 同判据）
//   → maxLength = byteLen×2（十六进制字符数上限）；
// - 数值域：无符号 0..2^(8n)-1（超 2^53 封顶 MAX_SAFE_INTEGER）、INT_SIGNED
//   两补码域；SCALED_DECIMAL 按 factor/offset 反算输入域（factor=0 恒 0 →
//   任意输入合法、不设域；factor<0 不等式反向）。钳制发生在 SmartInput，
//   编码端 InstructionEncoder 口径不变。
export const computeFieldInputLimits = (field = {}) => {
    const { params, isCalculated, isTimeCumulative, isFixed, isEditable, isEnum }
        = classifyRunnerField(field);
    if (!isEditable || isCalculated || isFixed || isTimeCumulative || isEnum) return null;

    const ptype = String(params.type || '').toLowerCase();
    if (['string', 'text', 'float', 'decimal'].includes(ptype)) return null;

    const byteLen = Number(field.byte_len ?? field.byte_length);
    if (!Number.isFinite(byteLen) || byteLen <= 0) return null;

    // 整数位域（BigInt 精确，超安全整数封顶）
    const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
    const bits = BigInt(byteLen * 8);
    const signed = String(field.original_op_code || field.op_code || '').toUpperCase() === 'INT_SIGNED';
    let min = 0;
    let max;
    if (signed) {
        const half = 1n << (bits - 1n);
        max = (half - 1n) > MAX_SAFE ? Number.MAX_SAFE_INTEGER : Number(half - 1n);
        min = half > MAX_SAFE ? -Number.MAX_SAFE_INTEGER : -Number(half);
    } else {
        const full = 1n << bits;
        max = (full - 1n) > MAX_SAFE ? Number.MAX_SAFE_INTEGER : Number(full - 1n);
    }

    // SCALED_DECIMAL：编码为 (v+offset)*factor，反算输入域
    const op = String(field.original_op_code || field.op_code || '').toUpperCase();
    if (op === 'SCALED_DECIMAL' && ['', 'number'].includes(ptype)) {
        const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(String(v).trim()));
        const off = Number.isFinite(num(params.offset)) ? num(params.offset) : 0;
        const fac = Number.isFinite(num(params.factor)) ? num(params.factor) : 1;
        if (fac === 0) {
            min = null; // 编码恒 0，任意输入合法
        } else {
            const lo = fac > 0 ? Math.ceil(min / fac - off) : Math.ceil(max / fac - off);
            const hi = fac > 0 ? Math.floor(max / fac - off) : Math.floor(min / fac - off);
            if (lo <= hi) { min = lo; max = hi; } else { min = null; }
        }
    }

    const out = { byteLen };
    if (isBinaryEntry(params)) {
        // 优化批 1：二进制通道 → maxLength = 位宽（二进制字符数上限）。
        // 不回吐数值域：位模式语义（0..2^(8n)-1 由位宽天然蕴含；负数/
        // 有符号域交给 dec 通道），也无 hex 字符数上限。
        out.maxLength = byteLen * 8;
    } else {
        // 批 1：十进制通道不回吐 hex 字符数上限（maxLength 只被 SmartInput 的 hex
        // 分支消费），数值域照用 —— 与 resolveFieldDisplay 同判据（isDecimalEntry）。
        if (!isDecimalEntry(params) && (!ptype || ptype === 'number' || ptype === 'hex')) out.maxLength = byteLen * 2;
        if (min !== null) { out.min = min; out.max = max; }
    }
    return out;
};
