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

    it('W: LITTLE endianness warns as B6 without blocking', () => {
        const { errors, warnings } = validateInstruction(inst([
            blk({ endianness: 'LITTLE' }),
        ]));
        expect(errors).toEqual([]);
        expect(warnings.some(w => w.code === 'B6')).toBe(true);
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
    it('maps block-level ops/properties to B2–B8 refs', () => {
        expect(getBlockLimitRefs({ op_code: 'FLOAT_IEEE' })).toContain('B2');
        expect(getBlockLimitRefs({ op_code: 'BCD_CODE' })).toContain('B3');
        expect(getBlockLimitRefs({ op_code: 'SCALED_DECIMAL' })).toContain('B4');
        expect(getBlockLimitRefs({ op_code: 'INT_SIGNED' })).toContain('B5');
        expect(getBlockLimitRefs({ op_code: 'HEX_RAW', endianness: 'LITTLE' })).toContain('B6');
        expect(getBlockLimitRefs({ op_code: 'ARRAY_GROUP', repeat_type: 'FIXED' })).toContain('B7');
        expect(getBlockLimitRefs({ op_code: 'AUTO_COUNTER' })).toContain('B8');
        expect(getBlockLimitRefs({ op_code: 'HEX_RAW' })).toEqual([]);
        expect(getBlockLimitRefs(null)).toEqual([]);
    });

    it('maps param keys to limit refs per op_code', () => {
        expect(getParamKeyLimitRef('factor', 'SCALED_DECIMAL')).toBe('B4');
        expect(getParamKeyLimitRef('offset', 'ANY')).toBe('B4');
        expect(getParamKeyLimitRef('max_count', 'ARRAY_GROUP')).toBe('B7');
        expect(getParamKeyLimitRef('step', 'AUTO_COUNTER')).toBe('B8');
        expect(getParamKeyLimitRef('step', 'HEX_RAW')).toBeNull();
        expect(getParamKeyLimitRef('algorithm', 'CHECKSUM_CRC')).toBeNull();
    });

    it('defines text for every ref B2–B8', () => {
        ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'].forEach((ref) => {
            expect(ENCODER_LIMITS[ref]).toBeTruthy();
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
