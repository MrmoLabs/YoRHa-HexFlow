// Render rules for the processing page's dynamic send form
// (components/InstructionForm/RunnerFieldTree.jsx).
// Extracted verbatim from RunnerFieldTree render logic (behavior unchanged);
// pure functions so every rule is unit-testable in isolation.
// NOTE: these rules only drive DISPLAY. Encoding semantics live in
// utils/InstructionEncoder.js / backend/core/orchestrator.py — keep in sync.

import { mapChecksumAlgo } from '../utils/normalizeInstruction';
import { getParamKeyLimitRef } from '../utils/encoderLimits';
import { SCRAMBLE_MODES, cleanHexText } from '../utils/scramble';
// R29 (§8.61): presence 展示状态只**委托**编码端判定（同源 fail-open，改一必改二）。
// InstructionEncoder 不回引本文件 → 无环。
import { InstructionEncoder } from '../utils/InstructionEncoder';
// R30 (§8.62) / R31 (§8.63): presence 的**比较口径**（补零/进制谓词 + 选项归一）
// 与 utils/validateInstruction 的设计期校验**共用同一实现** —— leaf 模块零依赖，无环。
// 改一必改二：本文件的角标 hover 与设计期提醒必须说同一件事。
import { formatEnumOptions, radixPadMismatch } from '../utils/presenceSemantics';
export { formatEnumOptions };

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

    // R23 (§8.52 排期 · 挂账 ①): 绝对时间戳 —— 身份认 op_code 与 original_op_code
    // 两条（normalize 只在「保身份」表里放行 TIME_EPOCH，存量草稿可能已被摊平）。
    // 走 isCalculated（计算类）而非 TIME_CUMULATIVE：显示取 computedValues 的 hex、
    // 只读、不挂「点开选时刻」时间选择器（epoch 没有 base_time 可选）。
    const isEpoch = field.op_code === 'TIME_EPOCH' || originalOp === 'TIME_EPOCH';

    const isCalculated = isEpoch
        || field.op_code === 'CALCULATED'
        || field.op_code === 'LENGTH_CALC'
        || field.op_code === 'CHECKSUM_CRC'
        || params.formula === 'auto'
        || params.type === 'length'
        || params.type === 'checksum';

    const isTimeCumulative = !isEpoch && (field.op_code === 'TIME_CUMULATIVE'
        || originalOp === 'TIME_CUMULATIVE'
        || originalOp === 'TIME_ACCUMULATOR'
        || params.type === 'time_cumulative');

    // Boolean(): the || chain ends in params.readOnly which may be undefined
    // (original code relied on falsy — coerce so the flag is always a boolean).
    // 第 15 单：HEADER/TAIL 是固定字节 —— 编码端直读 params.hex（或走 FIXED 分支），
    // 任何可编辑输入都不会改变出帧，「能改但无效」即欺骗 → 一律判只读固定。
    const isFixed = Boolean(field.op_code === 'FIXED'
        || originalOp === 'HEX_RAW'
        || field.op_code === 'HEX_RAW'
        // R25: SCRAMBLE 的明文是定义侧配置（加工页键入不进编码分支，「能改但无效」
        // 即欺骗）→ 与 HEX_RAW 同判只读固定；两认身份（存量被 normalize 摊平的兜底）。
        || originalOp === 'SCRAMBLE'
        || field.op_code === 'SCRAMBLE'
        || originalOp === 'FIXED'
        || originalOp === 'HEADER'
        || originalOp === 'TAIL'
        || field.op_code === 'HEADER'
        || field.op_code === 'TAIL'
        || params.readOnly)
        && !isTimeCumulative;

    const isEditable = !isCalculated && !isFixed;

    const rawOptions = params.options;
    const hasOptions = Boolean(rawOptions && (Array.isArray(rawOptions)
        ? rawOptions.length > 0
        : Object.keys(rawOptions).length > 0));
    // 第 15 单：枚举身份认 original_op_code —— normalize 把 MAPPING 摊平成 INPUT
    // （编码字节等价），但「这是枚举映射」的身份不能丢。下拉控件由 hasOptions
    // 另行把闸（无选项造不出下拉），身份（种类章/提示）走 isEnum。
    const isEnum = hasOptions || field.op_code === 'MAPPING' || originalOp === 'MAPPING';

    return { params, originalOp, isEpoch, isCalculated, isTimeCumulative, isFixed, isEditable, hasOptions, isEnum };
};

// 选项归一（normalizeOptionValue / formatEnumOptions）已上移到
// utils/presenceSemantics —— 设计期校验也要按同一口径枚举「可取值」，故并线维护。

// TIME_CUMULATIVE display: seconds since base_time -> 'YYYY-MM-DD HH:mm:ss'.
// Negative seconds (before base time) are allowed.
export const formatTimeDisplay = (params, seconds) => {
    const base = getFieldEpoch(params);
    const current = new Date(base.getTime() + (seconds * 1000));
    const pad = n => n.toString().padStart(2, '0');
    return `${current.getFullYear()}-${pad(current.getMonth() + 1)}-${pad(current.getDate())} `
        + `${pad(current.getHours())}:${pad(current.getMinutes())}:${pad(current.getSeconds())}`;
};

// 第 14 单：BCD 回显 —— 存量值可能是 number（hex/dec 通道时期已存数值）或
// 定义侧静态字符串。纯数字串按十进制解读（BCD 语义），其余走 toDecimalValue
// 兜底（hex 串等历史形态）。
const toBcdNumber = (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v === 'number') return v;
    const s = String(v).trim();
    if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
    return toDecimalValue(v);
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
        const isExplicitHex = originalOp === 'HEX_RAW' || field.op_code === 'HEX_RAW'
            // R25: SCRAMBLE 回显**明文**（pc.hex，同 HEX_RAW 的零填充兜底）—— 线上
            // 加扰字节在 BYTE_STREAM 预览里看（编码端产出），字段行讲定义侧明文。
            || originalOp === 'SCRAMBLE' || field.op_code === 'SCRAMBLE'
            || originalOp === 'HEADER' || field.op_code === 'HEADER'
            || originalOp === 'TAIL' || field.op_code === 'TAIL';
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
    } else if (isCalculated || (isEnum && options.length > 0)) {
        // 3a. Calculated: computedValues is source of truth, hex-formatted
        // 第 15 单：enum 分支按 hasOptions（options.length）把闸 —— 无选项的
        // 枚举落到 4（普通通道 + 字节钳制），身份提示由语义行 NO OPTIONS 承接。
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
        // 第 14 单：种类通道贴合 —— FLOAT_IEEE / BCD_CODE 强制专属通道。
        // 两者编码端只认「数值 / 十进制小数串」（float32 分支严格正则、BCD 逐
        // 十进制数字打包），默认 hex 通道会把 '3.14' 剥成 '314'、把 1234 显示成
        // '4D2' —— 输入语义错位。input_base 在这两类上让位（定义侧选了也无效）。
        const kindOps = [field.original_op_code, field.op_code]
            .filter(Boolean).map(v => String(v).toUpperCase());
        if (kindOps.includes('FLOAT_IEEE')) {
            inputType = 'float';
            displayValue = rawValue;
            placeholder = '0.0';
        } else if (kindOps.includes('BCD_CODE')) {
            inputType = 'bcd';
            displayValue = toBcdNumber(rawValue);
            const bcdLimits = computeFieldInputLimits(field);
            placeholder = bcdLimits && bcdLimits.max != null ? `0..${bcdLimits.max}` : '0';
        } else if (field.byte_len && field.byte_len > 0) {
            const currentVal = rawValue ?? 0;
            if (!params.type || params.type === 'number' || params.type === 'hex') {
                // 批 1：字段级录入进制（定义侧 parameter_config.input_base）。
                // dec = 十进制录入/回显（不补零）；值存储恒数值 → encoder 无感。
                if (isDecimalEntry(params)) {
                    inputType = 'decimal';
                    displayValue = toDecimalValue(rawValue);
                    // 第 14 单：占位即域 —— 十进制通道空态直接亮出字段数值域
                    const decLimits = computeFieldInputLimits(field);
                    placeholder = decLimits && decLimits.min != null && decLimits.max != null
                        ? `${decLimits.min}..${decLimits.max}` : '0';
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
// 第 15 单：ctx.inputs 可选 —— 在场时 AUTO_COUNTER 追加 NEXT 预览（下帧编码值）。
export const collectSemanticItems = (field = {}, ctx = {}) => {
    const params = field.parameter_config || {};
    const items = [
        ['factor', 'FACTOR'], ['offset', 'OFFSET'], ['step', 'STEP'], ['max', 'MAX'],
        ['start_val', 'START'], ['bytes', 'BYTES'], ['max_count', 'MAX LOOP'],
        // R23: TIME_EPOCH 的 unit（s|ms）—— 不亮出来就看不出发的是秒还是毫秒。
        ['algorithm', 'ALGO'], ['algo', 'ALGO'], ['unit', 'UNIT']
    ].reduce((acc, [k, label]) => {
        if (k === 'algo' && params.algorithm !== undefined) return acc; // prefer encoder key
        const raw = params[k];
        if (raw === undefined || raw === null || raw === '') return acc;
        const shown = (k === 'algorithm' || k === 'algo') ? mapChecksumAlgo(raw) : raw;
        acc.push({ text: `${label}=${shown}`, ref: getParamKeyLimitRef(k, field.op_code) });
        return acc;
    }, []);

    // R23 (§8.52 排期 · 挂账 ①): TIME_EPOCH —— unit 缺省 s：算子模板下拉没被点过
    // 时也要看得出发的是秒还是毫秒（否则语义行整个空掉）。
    if (classifyRunnerField(field).isEpoch && !params.unit) {
        items.push({ text: 'UNIT=s', ref: null });
    }

    // 第 15 单：CNT 下帧预览 —— NEXT = 推进后的编码值，与 advanceAutoCounter /
    // 编码端 E1-6 同口径（发送成功后 inputs 被推进，这里实时亮出下一帧会发什么）。
    const next = advanceAutoCounter(field, ctx.inputs ? ctx.inputs[field.id] : undefined);
    if (next !== null) items.push({ text: `NEXT=${next}`, ref: null });

    // 第 15 单：枚举身份在场但选项表缺失（存量 MAPPING 摊平/复制丢参）—— 无选项
    // 造不出下拉，但身份和配置指引必须露出：琥珀警示 + title 指向指令管理。
    const cls = classifyRunnerField(field);
    if (cls.isEnum && !cls.hasOptions) {
        items.push({
            text: 'NO OPTIONS',
            warn: true,
            title: '枚举映射未配置选项表：手动录入数值；到「指令管理」为该字段配置 options 后自动出下拉'
        });
    }

    // R25 (§8.57): 加扰字段 —— 「怎么加扰」不亮出来就看不出线上发的是明文还是密文。
    // MODE 缺省 XOR_SEED 照 R23 UNIT 先例恒亮（模板下拉没被点过也要说得出）；只亮
    // **生效模式**的那一个参数（另一个模式的参数留空是合法的，切回来即生效）。
    const scrambleOp = String(field.original_op_code || field.op_code || '').toUpperCase();
    if (scrambleOp === 'SCRAMBLE') {
        const modeNow = String(params.mode ?? 'XOR_SEED').trim().toUpperCase();
        items.push({
            text: `MODE=${SCRAMBLE_MODES.includes(modeNow) ? modeNow : String(params.mode ?? '')}`,
            ref: null,
        });
        items.push(modeNow === 'BIT_ROLL'
            ? { text: `ROLL=${params.roll ?? 0}`, ref: null }
            : { text: `SEED=${cleanHexText(params.seed) || '00'}`, ref: null });
    }
    return items;
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
    const { params, isCalculated, isTimeCumulative, isFixed, isEditable, isEnum, hasOptions }
        = classifyRunnerField(field);
    // 第 15 单：枚举「不设限」的前提是选项在场（选项即约束）—— 无选项 MAPPING
    // 落普通通道，字节钳制必须保留（否则 01/FF 这类代码字段可敲出溢出域）。
    if (!isEditable || isCalculated || isFixed || isTimeCumulative || (isEnum && hasOptions)) return null;

    const ptype = String(params.type || '').toLowerCase();
    if (['string', 'text', 'float', 'decimal'].includes(ptype)) return null;

    const byteLen = Number(field.byte_len ?? field.byte_length);
    if (!Number.isFinite(byteLen) || byteLen <= 0) return null;

    // 第 14 单：FLOAT_IEEE 不设限 —— f32 小数域（NaN/±Inf/超范围由编码端兜底
    // → 0 / IEEE 溢出），整数域对小数录入只会误钳。type=float/decimal 已在上方
    // ptype 名单；这里补 op 级（type 缺省/number 正是编码端 float32 分支要求的
    // 组合，也正是会落进整数域的那批）。
    const opU14 = String(field.original_op_code || field.op_code || '').toUpperCase();
    if (opU14 === 'FLOAT_IEEE') return null;

    // 第 14 单：BCD 数字域 —— 2n 个 nibble 每位 0..9 → 0..(10^(2n)-1)，与编码端
    // 逐 nibble 打包口径一致；输入端按位宽限幅（maxLength = 2n 位数，SmartInput
    // bcd 分支消费）。超 16 位十进制（> MAX_SAFE）直接封顶，同整数域口径。
    if (opU14 === 'BCD_CODE') {
        const digits = byteLen * 2;
        const MAX_SAFE14 = BigInt(Number.MAX_SAFE_INTEGER);
        let bcdMax;
        if (digits > 16) {
            bcdMax = Number.MAX_SAFE_INTEGER;
        } else {
            const full = 10n ** BigInt(digits);
            bcdMax = (full - 1n) > MAX_SAFE14 ? Number.MAX_SAFE_INTEGER : Number(full - 1n);
        }
        return { byteLen, maxLength: digits, min: 0, max: bcdMax };
    }

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

// ===== 第 14 单（加工页字段种类感知）=====

// 字段算子（含 normalizeRunnerInstruction 保留的 original_op_code），全大写。
const runnerOpOf = (field = {}) =>
    [field.original_op_code, field.op_code]
        .filter(Boolean)
        .map(v => String(v).toUpperCase());

// 第 15 单：CNT 自动推进 —— 编码器是纯函数，「跨帧状态机在调用方」（E1-6 注释）。
// 发送成功后加工页把 Current 推进为 (Current+Step)%Max，与编码端分支逐句同口径：
// type 闸 / floor 解析 / input > 静态 value > start_val / max 双重取模。非计数
// 字段或闸外 type → null（不推进）。跨帧状态由 UI 输入态承载，序列页仍走后端重算。
export const advanceAutoCounter = (field = {}, current) => {
    if (!runnerOpOf(field).includes('AUTO_COUNTER')) return null;
    const params = field.parameter_config || {};
    const ptype = String(params.type ?? '').toLowerCase();
    if (!['', 'number'].includes(ptype)) return null;
    const floorNum = (x) => {
        if (typeof x === 'number') { const f = Math.floor(x); return Number.isFinite(f) ? f : 0; }
        if (typeof x === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(x.trim())) {
            const f = Math.floor(Number(x.trim())); return Number.isFinite(f) ? f : 0;
        }
        return 0;
    };
    const hasCur = params.value !== undefined && params.value !== null && params.value !== '';
    const rawCur = current !== undefined ? current : (hasCur ? params.value : params.start_val);
    let n = floorNum(rawCur) + floorNum(params.step);
    const mxRaw = params.max;
    const mx = typeof mxRaw === 'number' ? mxRaw
        : (typeof mxRaw === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(mxRaw.trim())
            ? Number(mxRaw.trim()) : NaN);
    if (Number.isFinite(mx) && mx > 0) n = ((n % mx) + mx) % mx;
    return n;
};

// 种类章：label 前的小徽标（SmartInput kindLabel/kindTitle）。右徽标继续承载
// 状态/长度语义（READ_ONLY / n·N BYTES / TIME_PICKER），种类章独立回答「这是
// 什么算子的字段」。lane 判定复用 classifyRunnerField —— 章说的种类就是输入
// 实际走的通道，杜绝「章 F32、输入却是 hex 通道」的错位。
export const resolveRunnerKind = (field = {}) => {
    const { params, isEpoch, isTimeCumulative, isCalculated, isFixed, isEnum, hasOptions }
        = classifyRunnerField(field);
    const ops = runnerOpOf(field);
    const isOp = (...names) => names.some(n => ops.includes(n));

    // 第 15 单：HDR 身份先于 isFixed —— 帧头/帧尾本质是固定字节（isFixed 管只读），
    // 但 normalize 会把 op 改成 FIXED/INPUT，不先认 original 算子就掉 FIX/IN，
    // 帧头语义（对齐/包络锚点）从章上消失。
    if (isOp('HEADER', 'TAIL')) return { key: 'HDR', label: 'HDR', title: 'HDR // 帧头/帧尾：固定字节，只读回显（对齐/包络锚点）' };
    // R25 (§8.57): 加扰字段先于 FIX —— 本质是只读固定字节，但「明文 ≠ 线上字节」是
    // 这个字段唯一要讲清楚的事，掉进 FIX 就看不出发出去的是密文了。
    if (isOp('SCRAMBLE')) return { key: 'SCR', label: 'SCR', title: 'SCR // 加扰字段：定义侧明文按 mode（异或种子/位旋转）加扰后出线，只读回显明文（线上字节见 BYTE_STREAM）' };
    if (isFixed) return { key: 'FIX', label: 'FIX', title: 'FIX // 固定字节（定义侧静态值），不可编辑' };
    // R23 (§8.52 排期 · 挂账 ①): 绝对时间戳先于 TIME 分支 —— 它没有 base_time、
    // 也不许点开选时刻（当前墙钟由发送时刻决定），讲成「累计时间」会误导。
    if (isEpoch) return { key: 'EPOCH', label: 'EPOCH', title: 'EPOCH // 绝对时间戳：发送时取当前墙钟（unit = s|ms），只读不参与录入' };
    if (isTimeCumulative) return { key: 'TIME', label: 'TIME', title: 'TIME // 累计时间：base_time + 秒数，点击输入框选时刻' };
    if (isCalculated) {
        if (isOp('LENGTH_CALC') || params.type === 'length') return { key: 'LEN', label: 'LEN', title: 'LEN // 长度字段：引用字段合计自动计算' };
        if (isOp('CHECKSUM_CRC') || params.type === 'checksum') return { key: 'CKSUM', label: 'CKSUM', title: 'CKSUM // 校验和：按算法与引用集自动计算' };
        return { key: 'CALC', label: 'CALC', title: 'CALC // 公式/计算字段：自动求值，不可编辑' };
    }
    if (isEnum) return hasOptions
        ? { key: 'MAP', label: 'MAP', title: 'MAP // 枚举映射：从选项表取值' }
        : { key: 'MAP', label: 'MAP', title: 'MAP // 枚举映射（未配置选项表）：手动录入数值，配置 options 后自动出下拉' };
    // R5（§8.42）：byte_len=8 起真出 float64 → 章要跟着说 F64，杜绝「章 F32、
    // 出帧却是 8 字节」的错位；其余位宽仍标 F32（校验 W 已提醒两端不一致）。
    if (isOp('FLOAT_IEEE')) {
        const bl = Number(field.byte_len ?? field.byte_length);
        return bl === 8
            ? { key: 'F64', label: 'F64', title: 'F64 // IEEE754 float64 大端（恒 8B）：十进制小数录入' }
            : { key: 'F32', label: 'F32', title: 'F32 // IEEE754 float32 大端（恒 4B）：十进制小数录入' };
    }
    if (isOp('BCD_CODE')) return { key: 'BCD', label: 'BCD', title: 'BCD // 压缩 BCD：十进制数字逐 nibble 打包（每位 0-9）' };
    if (isOp('SCALED_DECIMAL')) return { key: 'SCALE', label: 'SCALE', title: 'SCALE // 定标整数：编码 =（输入 + OFFSET）× FACTOR' };
    if (isOp('STRING') || params.type === 'string' || params.type === 'text') return { key: 'TEXT', label: 'TEXT', title: 'TEXT // 定长文本：ascii|utf8 编码，pad/截断到 byte_len' };
    if (isOp('INT_SIGNED')) return { key: 'SINT', label: 'SINT', title: 'SINT // 有符号整数（两补码域）' };
    if (isOp('INT_UNSIGNED')) return { key: 'UINT', label: 'UINT', title: 'UINT // 无符号整数（0 .. 2^8n − 1）' };
    if (isOp('BITFIELD')) return { key: 'BIT', label: 'BIT', title: 'BIT // 位域：下方位图按位录入，整包按字节打包' };
    if (isOp('AUTO_COUNTER')) return { key: 'CNT', label: 'CNT', title: 'CNT // 自动计数器：START/STEP/MAX 语义见下' };
    if (isOp('STRUCT')) return { key: 'STRUCT', label: 'STRUCT', title: 'STRUCT // 结构组：子字段顺序打包' };
    if (isOp('ARRAY_GROUP')) return { key: 'ARRAY', label: 'ARRAY', title: 'ARRAY // 数组组：repeat 展开' };
    if (isOp('INPUT')) return { key: 'IN', label: 'IN', title: 'IN // 通用输入字段' };
    return { key: 'VAR', label: 'VAR', title: 'VAR // 通用可编辑字段' };
};

// 第 14 单：定长文本用量徽标（n/N CHARS|BYTES）。ascii：1 code point = 1 字节
// （编码端 codePointAt &0xFF）；utf8：TextEncoder 字节数。over = 超定长（编码端
// pad/截断）→ UI 琥珀警示。无有效 byte_len → null（徽标退回通用形态）。
export const computeStringUsage = (field = {}, value) => {
    const params = field.parameter_config || {};
    const byteLen = Number(field.byte_len ?? field.byte_length);
    if (!Number.isFinite(byteLen) || byteLen <= 0) return null;
    const s = String(value ?? '');
    const utf8 = String(params.encoding ?? 'ascii').toLowerCase() === 'utf8';
    const used = utf8 ? new TextEncoder().encode(s).length : [...s].length;
    return { used, total: byteLen, unit: utf8 ? 'BYTES' : 'CHARS', over: used > byteLen };
};

// 第 14 单：SmartInput 新通道解析助手（纯函数单测，组件只接线）。
// BCD：仅十进制数字入缓冲，按 nibble 数（maxLength = 2n 位数）限宽 —— 输入端
// 不移位（限宽后永不触达编码端「截高位保低位」分支）。value = null 表示空
// 缓冲，组件保留缓冲不发半截值（与 dec 通道同款行为）。
export const parseBcdInput = (raw, maxLength) => {
    const cap = (maxLength === null || maxLength === undefined || !Number.isFinite(Number(maxLength)))
        ? undefined : Number(maxLength);
    const clean = String(raw ?? '').replace(/[^0-9]/g, '').slice(0, cap);
    return { text: clean, value: clean === '' ? null : Number(clean) };
};

// float：与编码端 float32 分支同口径的严格十进制小数语法（不含指数 —— '1e5'
// 在 FLOAT_IEEE 分支会被静默置 0，宁可不发值也不静默丢精度）。半截形态
// （'' / '-' / '.' / '-.'）与非法字符 → value = null，组件保留缓冲。
const FLOAT_STRICT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
export const parseFloatInput = (raw) => {
    const text = String(raw ?? '');
    if (!FLOAT_STRICT.test(text.trim())) return { text, value: null };
    const n = Number(text.trim());
    return { text, value: Number.isFinite(n) ? n : null };
};

// ─── R29 (§8.61): 条件存在 (PRESENCE) —— 加工页展示层状态表 ────────────────
//
// 判定**只**委托 InstructionEncoder._presenceHit（与出线编码同一套 fail-open
// 口径，改一必改二）；本函数不自造第二套判据，只负责「谁配了 presence +
// 把结果聚合成渲染可用的 {hit, title}」。因此该表与 BYTE_STREAM / LEN 的
// 真实字节恒同源 —— 角标说 SKIP，字节流里就真的没有那段。
//
// 不进表 = 没配 presence（含非对象/数组）→ 渲染层不点 IF 角标，行为与
// R29 之前逐像素一致（Sequences 步骤编辑器不传本表 → 完全不渲染）。
//
// title 是纯展示字符串（判定式 + 命中结论 + fail-open 归因），把「为什么
// 这条不发/恒发」直接写在 hover 上 —— 存量 ref 无 pc.value、ref 悬空这两类
// 静态链断裂在加工页此前完全不可见。
export const resolvePresenceStates = (fields = [], inputs = {}, computedValues = {}) => {
    const flat = InstructionEncoder.flattenAll(Array.isArray(fields) ? fields : []);
    const idSet = new Set(flat.filter(f => f && f.id !== undefined && f.id !== null).map(f => f.id));
    const states = {};
    flat.forEach((f) => {
        if (!f || f.id === undefined || f.id === null) return;
        const cfg = f.parameter_config;
        const pres = (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg.presence : undefined;
        if (!pres || typeof pres !== 'object' || Array.isArray(pres)) return; // 未配置 → 不点角标

        const refId = pres.ref_id ?? null;
        const expect = pres.expect ?? null;
        const hasRef = !(refId === undefined || refId === null || String(refId) === '');
        const hasExpect = !(expect === undefined || expect === null || String(expect) === '');
        const dangling = hasRef && !idSet.has(refId);
        const refVal = (hasRef && !dangling)
            ? InstructionEncoder._refValue(refId, inputs, computedValues, flat)
            : undefined;

        // fail-open 归因只在「命中」侧有意义（fail-open 恒命中，未命中必是
        // 真比对不等）；缺 ref_id / 缺 expect / 悬空 / 无值链 四支与
        // _presence_hit 的 return True 分支一一对应。
        let reason = '';
        if (!hasRef) reason = ' · 缺 ref_id → fail-open 按命中';
        else if (!hasExpect) reason = ' · 缺 expect → fail-open 按命中';
        else if (dangling) reason = ' · ref 悬空 → fail-open 按命中';
        else if (refVal === undefined || refVal === null) reason = ' · ref 无值链 → fail-open 按命中';

        const hit = InstructionEncoder._presenceHit(f, inputs, computedValues, flat);
        // R32 (§8.64) 归一后 `01` ≡ 1 **判命中** → R30 那条「假阴性解释」在 miss 侧
        // 已无可能成立（能 hex 相等的必已命中）→ 注记改挂**命中侧**：解释「字符串
        // 不一样为什么还命中」。纯展示，判定仍由 _presenceHit 说了算。
        let radixNote = '';
        if (hit && !reason && hasExpect && refVal !== undefined && refVal !== null
            && String(expect) !== String(refVal)) {
            const pad = radixPadMismatch(expect, refVal);
            if (pad) {
                radixNote = ` · 按十六进制归一判等（expect "${String(expect)}" ≡ 值 `
                    + `${String(refVal)} = ${pad.expectNum}，补零/进制差异不影响判定）`;
            }
        }
        states[f.id] = {
            hit,
            title: `条件字段：[${hasRef ? String(refId) : '?'}] == ${hasExpect ? String(expect) : '?'}`
                + (hit ? ` · 命中 → 发射本字段${reason || radixNote}` : ' · 未命中 → 0 字节（本帧不发）'),
        };
    });
    return states;
};

// hexNorm / comparableNumber / radixPadMismatch / 选项归一：见 utils/presenceSemantics
// （R30 角标 hover 与 R31 设计期提醒共用同一谓词，改一必改二）。
