import { describe, it, expect } from 'vitest';
import { InstructionDecoder, formatFieldValue, fieldsText } from '../InstructionDecoder';
import { InstructionEncoder } from '../InstructionEncoder';
import { loadVectors } from '../../../../vectors/vectors.js';
import bcdScaledVec from '../../../../vectors/bcd_scaled.json';
import bitFieldVec from '../../../../vectors/bitfield.json';
import floatIeeeVec from '../../../../vectors/float_ieee.json';
import intSignedVec from '../../../../vectors/int_signed.json';
import littleEndianVec from '../../../../vectors/little_endian.json';
import stringVec from '../../../../vectors/string.json';
import timeCounterVec from '../../../../vectors/time_counter.json';

// R9（PLAN §8.46 · §8.37 R9 行 · C-2 选 B 前半）：**反向验证** —— 拍板要求
// 「按 stages 逆向取值，与编码器对偶，拿 vectors/*.json 反向验证」。
//
// 主性质 = **encode(decode(x)) === x 不动点**：拿共享向量表的已知帧解成值、
// 再用同一个编码器把这个值编回同一帧。它比「解出的值等于向量里的原始输入」
// 更强也更诚实 —— 编码本身有归一（bool→1、非法字符串→0、NaN→0、定长补齐、
// LITTLE 逆序），不动点不要求解码器猜回**编码前**的原始输入，只要求它把
// **帧里真实存的信息**还原到能被编码器原样复现。
//
// 约定：重编时只把「值驱动」字段塞 inputs；静态 hex 字段（FIXED / HEADER /
// TAIL / HEX_RAW 的 params.hex / 协议叶 hex_value）由 parameter_config 自己
// 说了算，塞 inputs 反而会压过 hex 分支走错路（编码器 163–169 的 else-if 链）。

const strip = (hex) => String(hex).replace(/\s/g, '');
const toHex = (hex) => strip(hex).toUpperCase();

// 静态 hex 字段的判据（与编码器 163–169 的 else-if 链一一对应）。
const isStaticHex = (f) => {
    const pc = f.parameter_config || {};
    if (['FIXED', 'HEADER', 'TAIL', 'HEX_RAW'].includes(f.op_code)) {
        return Boolean(pc.hex || f.hex_value);
    }
    return !f.op_code && Boolean(f.hex_value);
};

const decodeOne = (field, hex) => {
    const r = InstructionDecoder.decodeInstruction({ fields: [field] }, hex, {});
    expect(r.residual).toBe(0);
    expect(r.warnings).toEqual([]);
    expect(r.fields).toHaveLength(1);
    return r.fields[0].value;
};

// 不动点：解出的值回喂编码器 → 必须复现同一帧。
const roundTrip = (field, expectedHex) => {
    const value = decodeOne(field, expectedHex);
    const inputs = isStaticHex(field) ? {} : { [field.id]: value };
    const again = strip(InstructionEncoder.encodeInstruction({ fields: [field] }, inputs, {}).hexString);
    expect(toHex(again)).toBe(toHex(expectedHex));
    return value;
};

describe('InstructionDecoder · 反向验证（vectors 单一真相源 · 不动点 encode∘decode = id）', () => {
    const floatField = (byteLen) => ({
        id: 'x', name: 'X', op_code: 'FLOAT_IEEE', byte_len: byteLen, sequence: 0,
        parameter_config: {},
    });

    it('float_ieee f32/f64：双向量表逐行不动点（f32 溢出位型单列锚定）', () => {
        const TAB = loadVectors(floatIeeeVec);
        const ROWS = [...TAB.f32.map((r) => [r, 4]), ...TAB.f64.map((r) => [r, 8])];
        let overflow = 0;
        ROWS.forEach(([[input, expected], byteLen]) => {
            const v = decodeOne(floatField(byteLen), expected);
            expect(typeof v).toBe('number');
            expect(input === null || input !== undefined).toBe(true);
            if (!Number.isFinite(v)) {
                // **已知不可逆**：f32 溢出位型（1e300 → 7F800000 = +Inf）。编码器把
                // 非有限输入归 0 是既有 byte-equal 契约（orchestrator._float_number
                // 同口径、f64 也绝不写出 Inf 位型），故 Inf 位型解得出却编不回去。
                overflow += 1;
                expect([Infinity, -Infinity]).toContain(v);
                return;
            }
            const again = strip(InstructionEncoder.encodeInstruction(
                { fields: [floatField(byteLen)] }, { x: v }, {}).hexString);
            expect(toHex(again)).toBe(toHex(expected));
        });
        expect(overflow).toBe(2); // f32 的 ±1e300 两行，其余全表不动点
    });

    it('拍板举例：4048F5C3 → 3.14（读电压不用再心算）', () => {
        expect(decodeOne(floatField(4), '4048F5C3')).toBeCloseTo(3.14, 6);
        expect(roundTrip(floatField(4), '4048F5C3')).toBeCloseTo(3.14, 6);
    });

    it('int_signed 两补码：-1@1=FF / -1@8=FFFFFFFFFFFFFFFF / 128→80 归一', () => {
        const field = (byteLen) => ({
            id: 's1', name: 'S', op_code: 'INT_SIGNED', byte_len: byteLen, sequence: 0,
            parameter_config: { bits: byteLen * 8 },
        });
        expect(decodeOne(field(1), 'FF')).toBe(-1);
        expect(decodeOne(field(2), 'FFFF')).toBe(-1);
        expect(decodeOne(field(8), 'FFFFFFFFFFFFFFFF')).toBe(-1);
        expect(decodeOne(field(1), '80')).toBe(-128);
        expect(decodeOne(field(4), '80000000')).toBe(-2147483648);
        loadVectors(intSignedVec).forEach(([, byteLen, expected]) => {
            expect(typeof roundTrip(field(byteLen), expected)).toBe('number');
        });
    });

    it('bcd：packed BCD → 十进制（0025 → 25），全表不动点', () => {
        const field = (byteLen) => ({
            id: 'x', name: 'X', op_code: 'BCD_CODE', byte_len: byteLen, sequence: 0,
            parameter_config: {},
        });
        expect(decodeOne(field(2), '0025')).toBe(25);
        expect(decodeOne(field(1), '42')).toBe(42);
        loadVectors(bcdScaledVec.bcd).forEach(([, byteLen, expected]) => {
            expect(typeof roundTrip(field(byteLen), expected)).toBe('number');
        });
    });

    it('bcd_scaled：SCALED_DECIMAL 反定标 raw/factor − offset（30 → 5@f2o10）', () => {
        const field = (factor, offset, byteLen) => ({
            id: 'x', name: 'X', op_code: 'SCALED_DECIMAL', byte_len: byteLen, sequence: 0,
            parameter_config: { factor, offset },
        });
        expect(decodeOne(field(2, 10, 2), '001E')).toBe(5);
        expect(decodeOne(field(1, 2.5, 1), '09')).toBe(6.5);
        loadVectors(bcdScaledVec.scaled)
            .map(([v, f, o, len, hex]) => [v, f ?? undefined, o ?? undefined, len, hex])
            .forEach(([, factor, offset, byteLen, expected]) => {
                roundTrip(field(factor, offset, byteLen), expected);
            });
    });

    it('string：定长文本（含 pad_char 补齐的 NUL）逐行不动点', () => {
        const field = (byteLen, encoding, padChar) => {
            const cfg = { type: 'string' };
            if (encoding !== undefined) cfg.encoding = encoding;
            if (padChar !== undefined) cfg.pad_char = padChar;
            return { id: 'x', name: 'X', op_code: 'STRING', byte_len: byteLen, sequence: 0, parameter_config: cfg };
        };
        const ROWS = loadVectors(stringVec)
            .map(([v, len, enc, pad, hex]) => [v, len, enc ?? undefined, pad ?? undefined, hex]);
        // 已知不可逆行：utf8 多字节被定长**截断**（如 '中'@2B 只留下半个码点
        // E4B8）→ 解码只得到 U+FFFD，再编码成 EFBFBD。截断的 UTF-8 天然不可逆，
        // **不入不动点**，单列断言把这件事说清楚（不是解码器的 bug）。
        const utf8Len = (s) => Array.from(new TextEncoder().encode(String(s))).length;
        const LOSSY = new Set(ROWS
            .filter(([v, len, enc]) => enc === 'utf8' && utf8Len(v) > len)
            .map((r) => r[4]));
        ROWS.filter(([, , , , hex]) => !LOSSY.has(hex)).forEach(([value, byteLen, encoding, padChar, expected]) => {
            roundTrip(field(byteLen, encoding, padChar), expected);
            expect(value === null || value !== undefined).toBe(true);
        });
        expect(LOSSY.size).toBeGreaterThan(0); // 表里确实存在不可逆行，排除不是空跑
        expect(decodeOne(field(2, 'utf8', '00'), 'E4B8')).toBe('\uFFFD');
        // ascii 截断反而可逆：'中' &0xFF → 2D，解回 '-' 再编码仍是 2D
        expect(decodeOne(field(2, 'ascii', '00'), '2D00')).toBe('-\u0000');
        expect(toHex(strip(InstructionEncoder.encodeInstruction(
            { fields: [field(2, 'ascii', '00')] }, { x: '-\u0000' }, {}).hexString))).toBe('2D00');
    });

    it('little_endian：LITTLE 整体逆序的对偶（FEFF → -2 → FEFF）', () => {
        const field = ([endian, op, byteLen, cfg]) => ({
            id: 'e1', name: 'E', op_code: op, byte_len: byteLen, sequence: 0,
            ...(endian ? { endianness: endian } : {}),
            parameter_config: { ...(cfg || {}) },
        });
        expect(decodeOne(
            field(['LITTLE', 'INT_SIGNED', 2, { value: -2 }]), 'FEFF')).toBe(-2);
        expect(decodeOne(
            field(['LITTLE', 'HEX_RAW', 2, { hex: 'AA BB' }]), 'BBAA')).toBe('AABB');
        expect(decodeOne(
            field(['LITTLE', 'FIXED', 2, { hex: '1234' }]), '3412')).toBe('1234');
        loadVectors(littleEndianVec).forEach((row) => {
            const [, , , , expected] = row;
            roundTrip(field(row), expected);
        });
    });

    it('bitfield：子位打包还原成聚合整数', () => {
        const field = (bits, byteLen) => ({
            id: 'x', name: 'X', op_code: 'BITFIELD', byte_len: byteLen, sequence: 0,
            parameter_config: {},
            bits: bits.map(([start, len, def]) => ({ start_bit: start, bit_len: len, default_val: def })),
        });
        expect(decodeOne(field([[0, 4, 5], [4, 4, 10]], 1), 'A5')).toBe(0xA5);
        loadVectors(bitFieldVec.pack).forEach(([bits, byteLen, expected]) => {
            const v = roundTrip(field(bits, byteLen), expected);
            expect(typeof v).toBe('number');
        });
    });

    it('time_counter：TIME 解成秒数、AUTO 解成计数状态（状态机不假装可逆）', () => {
        const timeField = (base, byteLen) => ({
            id: 't', name: 'T', op_code: 'TIME_ACCUMULATOR', byte_len: byteLen, sequence: 0,
            parent_id: null, parameter_config: { base_time: base },
        });
        const autoField = (startVal, step, maxVal, byteLen) => ({
            id: 'c', name: 'C', op_code: 'AUTO_COUNTER', byte_len: byteLen, sequence: 0,
            parent_id: null, parameter_config: { start_val: startVal, step, max: maxVal },
        });

        loadVectors(timeCounterVec.time).forEach(([base, , byteLen, value, expected]) => {
            const seconds = decodeOne(timeField(base, byteLen), expected);
            expect(typeof seconds).toBe('number');
            expect(value === null || value !== undefined).toBe(true);
            // 不动点：以「解出的秒数」反推墙钟 → 编回同一帧
            const baseMs = Date.parse(base ?? '');
            const again = strip(InstructionEncoder.encodeInstruction(
                { fields: [timeField(base, byteLen)] }, {}, {}, { now: baseMs + seconds * 1000 }).hexString);
            expect(toHex(again)).toBe(toHex(expected));
        });
        expect(decodeOne(timeField('2000-01-01T00:00:00Z', 2), '0064')).toBe(100);

        loadVectors(timeCounterVec.auto).forEach(([value, startVal, step, maxVal, byteLen, expected]) => {
            // AUTO_COUNTER 是状态机（(Current+Step)%Max），**不是可逆变换** ——
            // 解出的是「编码这一刻的计数状态」，再以它回推一个合法前态编回原帧。
            const state = decodeOne(autoField(startVal, step, maxVal, byteLen), expected);
            expect(typeof state).toBe('number');
            const stepNum = Number(step) || 0;
            const again = strip(InstructionEncoder.encodeInstruction(
                { fields: [autoField(startVal, step, maxVal, byteLen)] },
                { c: state - stepNum }, {}).hexString);
            expect(toHex(again)).toBe(toHex(expected));
            expect(value === null || value !== undefined).toBe(true);
        });
    });
});

describe('InstructionDecoder · 整帧对偶（组 align / repeat / presence / 混排）', () => {
    const instr = {
        fields: [
            {
                id: 'h', name: 'HEADER', op_code: 'FIXED', byte_len: 2, sequence: 0,
                parameter_config: { hex: 'AA55' },
            },
            {
                id: 'len', name: 'LEN', op_code: 'INT_UNSIGNED', byte_len: 1, sequence: 1,
                parameter_config: {},
            },
            {
                id: 'mode', name: 'MODE', op_code: 'INT_UNSIGNED', byte_len: 1, sequence: 2,
                parameter_config: {},
            },
            {
                id: 'vol', name: 'VOLTAGE', op_code: 'FLOAT_IEEE', byte_len: 4, sequence: 3,
                endianness: 'LITTLE', parameter_config: {},
            },
            {
                id: 'opt', name: 'OPTIONAL', op_code: 'BCD_CODE', byte_len: 2, sequence: 4,
                parameter_config: { presence: { ref_id: 'mode', expect: '1' } },
            },
            {
                id: 'g', name: 'PAIRS', byte_len: 0, sequence: 5, endianness: 'LITTLE',
                repeat_type: 'FIXED', repeat_count: 3, parameter_config: { align: 4 },
                fields: [
                    {
                        id: 'p1', name: 'P1', op_code: 'BCD_CODE', byte_len: 1, sequence: 0,
                        parameter_config: { value: 12 },
                    },
                    {
                        id: 'p2', name: 'P2', op_code: 'INT_UNSIGNED', byte_len: 1, sequence: 1,
                        parameter_config: { value: 7 },
                    },
                ],
            },
            {
                id: 'tail', name: 'TAIL', op_code: 'FIXED', byte_len: 1, sequence: 6,
                parameter_config: { hex: '0D' },
            },
        ],
    };

    const names = (r) => r.fields.map((f) => f.name);
    const valueOf = (r, name) => r.fields.find((f) => f.name === name).value;

    it('命中应答 → 逐字段还原成「字段 = 值」（presence 命中那条在）', () => {
        const inputs = { len: 4, mode: 1, vol: 3.14, opt: 12 };
        const enc = InstructionEncoder.encodeInstruction(instr, inputs, {});
        const dec = InstructionDecoder.decodeInstruction(instr, enc.hexString, { inputs });

        expect(dec.warnings).toEqual([]);
        expect(dec.residual).toBe(0);
        expect(names(dec)).toEqual(
            ['HEADER', 'LEN', 'MODE', 'VOLTAGE', 'OPTIONAL', 'P1', 'P2', 'P1', 'P2', 'P1', 'P2', 'TAIL']);
        expect(dec.fields[0].value).toBe('AA55');
        expect(valueOf(dec, 'LEN')).toBe(4);
        expect(valueOf(dec, 'VOLTAGE')).toBeCloseTo(3.14, 6);
        expect(valueOf(dec, 'OPTIONAL')).toBe(12);
        expect(dec.fields.filter((f) => f.name === 'P1')).toHaveLength(3); // repeat ×3
        expect(fieldsText(dec)).toContain('VOLTAGE = 3.14');
    });

    it('整帧不动点：把解出来的值原样重编 → 与命中应答逐字节相同', () => {
        const inputs = { len: 4, mode: 1, vol: 3.14, opt: 12 };
        const enc = InstructionEncoder.encodeInstruction(instr, inputs, {});
        const dec = InstructionDecoder.decodeInstruction(instr, enc.hexString, { inputs });
        const byId = Object.fromEntries(
            instr.fields.flatMap((f) => [[f.id, f], ...((f.fields || []).map((k) => [k.id, k]))]));
        const reInputs = {};
        dec.fields.forEach((f) => {
            const src = byId[f.fieldId];
            if (src && !isStaticHex(src)) reInputs[f.fieldId] = f.value;
        });
        const again = InstructionEncoder.encodeInstruction(instr, reInputs, {});
        expect(again.hexString).toBe(enc.hexString);
    });

    it('presence 未命中（mode=0）→ 解码同样不吞字段、不错位', () => {
        const inputs = { len: 4, mode: 0, vol: 1.5 };
        const enc = InstructionEncoder.encodeInstruction(instr, inputs, {});
        const dec = InstructionDecoder.decodeInstruction(instr, enc.hexString, { inputs });
        expect(names(dec)).not.toContain('OPTIONAL');
        expect(dec.warnings).toEqual([]);
        expect(dec.residual).toBe(0);
    });

    it('真机应答无 inputs（静态链 + presence fail-open）仍按同一布局解完', () => {
        const inputs = { len: 4, mode: 1, vol: 3.14 };
        const enc = InstructionEncoder.encodeInstruction(instr, inputs, {});
        const dec = InstructionDecoder.decodeInstruction(instr, enc.hexString, {});
        expect(dec.warnings).toEqual([]);
        expect(dec.residual).toBe(0);
        expect(valueOf(dec, 'LEN')).toBe(4);
        expect(valueOf(dec, 'VOLTAGE')).toBeCloseTo(3.14, 6);
    });
});

describe('InstructionDecoder · 入口口径与异常帧', () => {
    const field = {
        id: 'x', name: 'X', op_code: 'INT_UNSIGNED', byte_len: 2, sequence: 0,
        parameter_config: {},
    };
    const instr = { fields: [field] };

    it('空入参 → 空结果（不抛）', () => {
        expect(InstructionDecoder.decodeInstruction(null, 'AABB', {}))
            .toEqual({ fields: [], consumed: 0, total: 0, residual: 0, warnings: [] });
        expect(InstructionDecoder.decodeInstruction(instr, '', {}).fields).toEqual([]);
    });

    it('非 hex → 0 字段 + 明确 warning', () => {
        const r = InstructionDecoder.decodeInstruction(instr, 'GG HH', {});
        expect(r.fields).toEqual([]);
        expect(r.warnings).toEqual(['响应含非十六进制字符，无法解码']);
    });

    it('奇数位 → 丢末半字节并提醒', () => {
        const r = InstructionDecoder.decodeInstruction(instr, 'ABC', {});
        expect(r.warnings[0]).toContain('奇数位');
        // parseHexBytes 沿用编码器口径：'C' 单半字节按 0x0C 补成整字节（不改既有行为）
        expect(r.total).toBe(2);
    });

    it('短帧 → 标 truncated 并提醒，不留静默错值', () => {
        const r = InstructionDecoder.decodeInstruction(instr, 'AA', {});
        expect(r.fields[0].truncated).toBe(true);
        expect(r.residual).toBe(0);
        expect(r.warnings.some((w) => w.includes('比字段布局短'))).toBe(true);
    });

    it('长帧 → residual 计数 + 尾部未映射提醒', () => {
        const r = InstructionDecoder.decodeInstruction(instr, '0001 0203', {});
        expect(r.fields).toHaveLength(1);
        expect(r.residual).toBe(2);
        expect(r.warnings).toEqual(['响应尾部多出 2 字节未映射到任何字段']);
    });

    it('group pad_to / align 参与布局（读侧跳过补零）', () => {
        const g = {
            fields: [
                { id: 'a', name: 'A', op_code: 'FIXED', byte_len: 1, sequence: 0, parameter_config: { hex: 'AA' } },
                {
                    id: 'b', name: 'B', op_code: 'FIXED', byte_len: 1, sequence: 1,
                    parameter_config: { hex: 'CC', align: 4 },
                },
            ],
        };
        const enc = InstructionEncoder.encodeInstruction(g, {}, {});
        expect(toHex(enc.hexString)).toBe('AA000000CC');
        const dec = InstructionDecoder.decodeInstruction(g, enc.hexString, {});
        expect(dec.warnings).toEqual([]);
        expect(dec.fields.map((f) => f.value)).toEqual(['AA', 'CC']);
    });
});

describe('formatFieldValue / fieldsText（展示层）', () => {
    it('数字原样、文本带引号并剥掉定长补齐', () => {
        expect(formatFieldValue(3.14)).toBe('3.14');
        expect(formatFieldValue(0)).toBe('0');
        expect(formatFieldValue(null)).toBe('—');
        expect(formatFieldValue('AB\u0000\u0000')).toBe('"AB"');
        expect(formatFieldValue('AB  ')).toBe('"AB"');
        expect(formatFieldValue('AA55')).toBe('"AA55"');
    });

    it('fieldsText 拼成 `字段 = 值 · …`；空解码 → 空串', () => {
        expect(fieldsText(null)).toBe('');
        expect(fieldsText({ fields: [] })).toBe('');
        expect(fieldsText({
            fields: [
                { name: 'voltage', value: 3.14 },
                { name: 'mode', value: 'OK\0' },
            ],
        })).toBe('voltage = 3.14 · mode = "OK"');
    });
});
