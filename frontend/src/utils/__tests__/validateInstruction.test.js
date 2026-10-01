import { describe, it, expect } from 'vitest';
import { validateInstruction } from '../validateInstruction';
import { getBlockLimitRefs, getParamKeyLimitRef, ENCODER_LIMITS } from '../encoderLimits';

const inst = (fields) => ({ id: 'i1', name: 'T', code: 'T1', device_code: 'DEV', fields });
const blk = (over = {}) => ({
    id: 'f1',
    name: 'A',
    op_code: 'HEX_RAW',
    byte_len: 1,
    sequence: 0,
    parent_id: null,
    parameter_config: { hex: 'AA' },
    ...over,
});

describe('validateInstruction', () => {
    it('accepts a clean instruction (no errors, no warnings)', () => {
        const { errors, warnings } = validateInstruction(inst([
            blk({ id: 'f1', name: 'HEAD' }),
            blk({ id: 'f2', name: 'TAIL', sequence: 1 }),
        ]));
        expect(errors).toEqual([]);
        expect(warnings).toEqual([]);
    });

    it('E1: flags HEX_RAW length mismatch', () => {
        const { errors } = validateInstruction(inst([
            blk({ parameter_config: { hex: 'ABC' } }),
        ]));
        expect(errors.some(e => e.code === 'HEX_LENGTH')).toBe(true);
    });

    it('W: empty hex warns but does not error', () => {
        const { errors, warnings } = validateInstruction(inst([
            blk({ parameter_config: { hex: '' } }),
        ]));
        expect(errors).toEqual([]);
        expect(warnings.some(w => w.code === 'HEX_EMPTY')).toBe(true);
    });

    it('E2: flags dangling refs', () => {
        const { errors } = validateInstruction(inst([
            blk({ id: 'f1', name: 'A' }),
            blk({ id: 'f2', name: 'B', sequence: 1, parameter_config: { hex: 'BB', refs: ['nope'] } }),
        ]));
        expect(errors.some(e => e.code === 'REF_DANGLING')).toBe(true);
    });

    it('E3: flags duplicate field labels', () => {
        const { errors } = validateInstruction(inst([
            blk({ id: 'f1', name: 'DUP' }),
            blk({ id: 'f2', name: 'DUP', sequence: 1 }),
        ]));
        expect(errors.some(e => e.code === 'LABEL_DUPLICATE')).toBe(true);
    });

    it('E4: flags overlapping bitfields', () => {
        const { errors } = validateInstruction(inst([
            blk({
                id: 'bf1', name: 'BF', op_code: 'BITFIELD', byte_len: 1,
                parameter_config: {},
                bits: [
                    { name: 'a', start_bit: 0, bit_len: 4 },
                    { name: 'b', start_bit: 2, bit_len: 4 },
                ],
            }),
        ]));
        expect(errors.some(e => e.code === 'BIT_OVERLAP')).toBe(true);
    });

    it('E4: flags bitfields exceeding byte capacity', () => {
        const { errors } = validateInstruction(inst([
            blk({
                id: 'bf1', name: 'BF', op_code: 'BITFIELD', byte_len: 1,
                parameter_config: {},
                bits: [{ name: 'a', start_bit: 6, bit_len: 4 }],
            }),
        ]));
        expect(errors.some(e => e.code === 'BIT_OVERFLOW')).toBe(true);
    });

    it('E5: flags formula cycles between two fields', () => {
        const { errors } = validateInstruction(inst([
            blk({ id: 'fa', name: 'A', parameter_config: { hex: '01', formula: '[B] + 1' } }),
            blk({ id: 'fb', name: 'B', sequence: 1, parameter_config: { hex: '02', formula: '[A] + 1' } }),
        ]));
        expect(errors.some(e => e.code === 'FORMULA_CYCLE')).toBe(true);
    });

    it('E5: own-name formula token (LHS declaration) is NOT a cycle', () => {
        const { errors } = validateInstruction(inst([
            blk({ id: 'fl', name: 'Len', parameter_config: { hex: '01', formula: '[Len] + 1' } }),
        ]));
        expect(errors).toEqual([]);
    });

    it('W: unresolvable formula reference warns instead of blocking', () => {
        const { errors, warnings } = validateInstruction(inst([
            blk({ id: 'f1', name: 'A', parameter_config: { hex: '01', formula: '[Ghost] + 1' } }),
        ]));
        expect(errors).toEqual([]);
        expect(warnings.some(w => w.code === 'FORMULA_UNRESOLVED')).toBe(true);
    });

    it('E6: checksum in root-first position has empty coverage', () => {
        const { errors } = validateInstruction(inst([
            blk({ id: 'ck', name: 'CRC', op_code: 'CHECKSUM_CRC' }),
            blk({ id: 'f2', name: 'BODY', sequence: 1 }),
        ]));
        expect(errors.some(e => e.code === 'CHECKSUM_EMPTY_COVERAGE')).toBe(true);
    });

    it('E6: checksum in second position is fine', () => {
        const { errors } = validateInstruction(inst([
            blk({ id: 'f1', name: 'HEAD' }),
            blk({ id: 'ck', name: 'CRC', op_code: 'CHECKSUM_CRC', sequence: 1 }),
        ]));
        expect(errors).toEqual([]);
    });

    it('W: LITTLE endianness no longer warns — B6 withdrawn (E1-2)', () => {
        const { errors, warnings } = validateInstruction(inst([
            blk({ endianness: 'LITTLE' }),
        ]));
        expect(errors).toEqual([]);
        expect(warnings.some(w => w.code === 'B6')).toBe(false);
    });

    it('W: duplicate sequence within the same parent warns', () => {
        const { errors, warnings } = validateInstruction(inst([
            blk({ id: 'f1', name: 'A', sequence: 0 }),
            blk({ id: 'f2', name: 'B', sequence: 0 }),
        ]));
        expect(errors).toEqual([]);
        expect(warnings.some(w => w.code === 'SEQ_DUPLICATE')).toBe(true);
    });
});

describe('encoderLimits', () => {
    it('maps block-level ops/properties to refs — B2–B8 全部已解（E1-1..E1-6）', () => {
        // B2 已解（E1-4）：FLOAT_IEEE float32 双端落地，不再挂限制标注
        expect(getBlockLimitRefs({ op_code: 'FLOAT_IEEE' })).toEqual([]);
        // B3/B4 已解（E1-3）：packed BCD 与 (value+offset)*factor 定标双端落地
        expect(getBlockLimitRefs({ op_code: 'BCD_CODE' })).toEqual([]);
        expect(getBlockLimitRefs({ op_code: 'SCALED_DECIMAL' })).toEqual([]);
        // B5 已解（E1-1）：INT_SIGNED 补码双端落地，不再挂限制标注
        expect(getBlockLimitRefs({ op_code: 'INT_SIGNED' })).toEqual([]);
        // B6 已解（E1-2）：LITTLE 反转双端落地，不再挂限制标注
        expect(getBlockLimitRefs({ op_code: 'HEX_RAW', endianness: 'LITTLE' })).toEqual([]);
        // B7 已解（E1-5）：repeat 组 FIXED/DYNAMIC 真实展开，不再挂限制标注
        expect(getBlockLimitRefs({ op_code: 'ARRAY_GROUP', repeat_type: 'FIXED' })).toEqual([]);
        // B8 已解（E1-6）：TIME 墙钟 Current−BaseTime / AUTO_COUNTER
        // (Current+Step)%Max 双端落地，不再挂限制标注
        expect(getBlockLimitRefs({ op_code: 'AUTO_COUNTER' })).toEqual([]);
        expect(getBlockLimitRefs({ op_code: 'TIME_ACCUMULATOR' })).toEqual([]);
        expect(getBlockLimitRefs({ op_code: 'HEX_RAW' })).toEqual([]);
        expect(getBlockLimitRefs(null)).toEqual([]);
    });

    it('maps param keys to limit refs per op_code', () => {
        // B4 已解（E1-3）：定标参与编码，不再挂限制引用
        expect(getParamKeyLimitRef('factor', 'SCALED_DECIMAL')).toBeNull();
        expect(getParamKeyLimitRef('offset', 'ANY')).toBeNull();
        // B7 已解（E1-5）：max_count 语义参数不再挂限制引用
        expect(getParamKeyLimitRef('max_count', 'ARRAY_GROUP')).toBeNull();
        // B8 已解（E1-6）：step/max 参与 (Current+Step)%Max，不再挂限制引用
        expect(getParamKeyLimitRef('step', 'AUTO_COUNTER')).toBeNull();
        expect(getParamKeyLimitRef('max', 'AUTO_COUNTER')).toBeNull();
        expect(getParamKeyLimitRef('step', 'HEX_RAW')).toBeNull();
        expect(getParamKeyLimitRef('algorithm', 'CHECKSUM_CRC')).toBeNull();
    });

    it('B2–B8 全部撤除（E1-1..E1-6）—— ENCODER_LIMITS 清空', () => {
        expect(ENCODER_LIMITS).toEqual({});
        ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'].forEach((ref) => {
            expect(ENCODER_LIMITS[ref]).toBeUndefined();
        });
    });
});

describe('validateInstruction — LENGTH_CALC refs without formula (W3)', () => {
    it('warns when refs exist but formula is missing (preview infers sum-of-refs)', () => {
        const { errors, warnings } = validateInstruction(inst([
            blk(),
            blk({ id: 'f2', name: 'L', sequence: 1, op_code: 'LENGTH_CALC', parameter_config: { refs: ['f1'] } }),
        ]));
        expect(errors).toEqual([]);
        const w = warnings.find((x) => x.code === 'LENGTH_NO_FORMULA');
        expect(w).toBeTruthy();
        expect(w.blockId).toBe('f2');
    });

    it('does not warn when a formula is present', () => {
        const { warnings } = validateInstruction(inst([
            blk(),
            blk({ id: 'f2', name: 'L', sequence: 1, op_code: 'LENGTH_CALC', parameter_config: { refs: ['f1'], formula: '[A]' } }),
        ]));
        expect(warnings.some((x) => x.code === 'LENGTH_NO_FORMULA')).toBe(false);
    });
});

// N1 护栏批（PLAN §8.16 · G5/G7）：未知算子静默错码 + float64 可配出陷阱。
describe('validateInstruction N1 护栏（G5 未知算子 / G7 float64）', () => {
    it('W G7: FLOAT_IEEE byte_len=8 提醒 float64 未支持（FE/BE 口径不一致）', () => {
        const { errors, warnings } = validateInstruction(inst([
            blk({ op_code: 'FLOAT_IEEE', byte_len: 8, parameter_config: {} }),
        ]));
        expect(errors).toEqual([]);
        const w = warnings.find((x) => x.code === 'FLOAT64_UNSUPPORTED');
        expect(w).toBeTruthy();
        expect(w.blockId).toBe('f1');
        expect(w.message).toMatch(/32/);
    });

    it('W G7: FLOAT_IEEE 32 位（byte_len=4）不报', () => {
        const { warnings } = validateInstruction(inst([
            blk({ op_code: 'FLOAT_IEEE', byte_len: 4, parameter_config: {} }),
        ]));
        expect(warnings.some((x) => x.code === 'FLOAT64_UNSUPPORTED')).toBe(false);
    });

    it('G5 双端硬拦: 未知 op_code 升 error（保存阻断，W5 → E；BE 同口径 400）', () => {
        const { errors, warnings } = validateInstruction(inst([
            blk({ op_code: 'WEIRD_OP', parameter_config: {} }),
        ]));
        const e = errors.find((x) => x.code === 'OP_UNKNOWN');
        expect(e).toBeTruthy();
        expect(e.blockId).toBe('f1');
        expect(e.message).toMatch(/WEIRD_OP/);
        expect(warnings.some((x) => x.code === 'OP_UNKNOWN')).toBe(false);
    });

    it('G5 双端硬拦: 小写 op 同样拦（KNOWN_OPS 大小写敏感，BE 同口径）', () => {
        const { errors } = validateInstruction(inst([
            blk({ op_code: 'hex_raw', parameter_config: {} }),
        ]));
        expect(errors.some((x) => x.code === 'OP_UNKNOWN')).toBe(true);
    });

    it('G5 双端硬拦: 已知全集（OP_CODES 15 + encoder legacy 5 = 20）不误报', () => {
        const known = [
            'HEX_RAW', 'INT_UNSIGNED', 'INT_SIGNED', 'FLOAT_IEEE', 'SCALED_DECIMAL',
            'BCD_CODE', 'BITFIELD', 'MAPPING', 'ARRAY_GROUP', 'STRUCT',
            'LENGTH_CALC', 'CHECKSUM_CRC', 'TIME_ACCUMULATOR', 'AUTO_COUNTER',
            'STRING',
            'INPUT', 'FIXED', 'HEADER', 'TAIL', 'CALCULATED',
        ];
        const { errors, warnings } = validateInstruction(inst(
            known.map((op, i) => blk({
                id: `k${i}`, name: `K${i}`, op_code: op, sequence: i, parameter_config: {},
            })),
        ));
        expect(warnings.some((x) => x.code === 'OP_UNKNOWN')).toBe(false);
        expect(errors.some((x) => x.code === 'OP_UNKNOWN')).toBe(false);
    });
});

// N2 字符串批（PLAN §8.16 · G2 字符集）：静态文本含 >0xFF 且非 utf8 → 脏字节提醒。
describe('validateInstruction N2 文本字段（G2 字符集）', () => {
    it('W: STRING 静态值含 >0xFF 且未启 utf8 → STRING_NON_ASCII', () => {
        const { errors, warnings } = validateInstruction(inst([
            blk({ op_code: 'STRING', byte_len: 4, parameter_config: { type: 'string', value: '中A' } }),
        ]));
        expect(errors).toEqual([]);
        const w = warnings.find((x) => x.code === 'STRING_NON_ASCII');
        expect(w).toBeTruthy();
        expect(w.blockId).toBe('f1');
        expect(w.message).toMatch(/utf8/);
    });

    it('W: encoding=utf8 不报（UTF-8 是正解）', () => {
        const { warnings } = validateInstruction(inst([
            blk({ op_code: 'STRING', byte_len: 4, parameter_config: { type: 'string', encoding: 'utf8', value: '中' } }),
        ]));
        expect(warnings.some((x) => x.code === 'STRING_NON_ASCII')).toBe(false);
    });

    it('W: ≤0xFF 字符（纯 ASCII / Latin-1）不报', () => {
        const { warnings } = validateInstruction(inst([
            blk({ op_code: 'STRING', byte_len: 8, parameter_config: { type: 'string', value: 'Hello_42é' } }),
        ]));
        expect(warnings.some((x) => x.code === 'STRING_NON_ASCII')).toBe(false);
    });

    it('W: 存量 INPUT + type=string 按 default 同口径检查', () => {
        const { warnings } = validateInstruction(inst([
            blk({ op_code: 'INPUT', byte_len: 4, parameter_config: { type: 'string', default: '中文' } }),
        ]));
        expect(warnings.some((x) => x.code === 'STRING_NON_ASCII')).toBe(true);
    });

    it('STRING 属已知算子全集（OP_UNKNOWN 不误报，errors/warnings 双清）', () => {
        const { errors, warnings } = validateInstruction(inst([
            blk({ op_code: 'STRING', byte_len: 8, parameter_config: {} }),
        ]));
        expect(warnings.some((x) => x.code === 'OP_UNKNOWN')).toBe(false);
        expect(errors.some((x) => x.code === 'OP_UNKNOWN')).toBe(false);
    });
});
