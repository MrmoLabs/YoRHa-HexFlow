import { describe, it, expect } from 'vitest';
import { computeByteOffsets, formatOffset } from '../byteOffsets';

const inst = (fields) => ({ fields });

describe('computeByteOffsets', () => {
    it('flat chain: offsets 0/2/4/5/9 and total 11 (acceptance example)', () => {
        const res = computeByteOffsets(inst([
            { id: 'head', byte_len: 2, sequence: 0, parent_id: null },
            { id: 'len', byte_len: 2, sequence: 1, parent_id: null },
            { id: 'cmd', byte_len: 1, sequence: 2, parent_id: null },
            { id: 'data', byte_len: 4, sequence: 3, parent_id: null },
            { id: 'crc', byte_len: 2, sequence: 4, parent_id: null },
        ]));
        expect(res.byId.get('head').offset).toBe(0);
        expect(res.byId.get('len').offset).toBe(2);
        expect(res.byId.get('cmd').offset).toBe(4);
        expect(res.byId.get('data').offset).toBe(5);
        expect(res.byId.get('crc').offset).toBe(9);
        expect(res.total).toBe(11);
        expect(res.exact).toBe(true);
    });

    it('orders by sequence even when the fields array is jumbled', () => {
        const res = computeByteOffsets(inst([
            { id: 'b', byte_len: 1, sequence: 1, parent_id: null },
            { id: 'c', byte_len: 1, sequence: 2, parent_id: null },
            { id: 'a', byte_len: 2, sequence: 0, parent_id: null },
        ]));
        expect(res.byId.get('a').offset).toBe(0);
        expect(res.byId.get('b').offset).toBe(2);
        expect(res.byId.get('c').offset).toBe(3);
    });

    it('nested groups: group start = root start + preceding siblings; children counted from group start; following sibling continues after Σ children', () => {
        const res = computeByteOffsets(inst([
            { id: 'a', byte_len: 2, sequence: 0, parent_id: null },
            { id: 'g', sequence: 1, parent_id: null },               // group (no byte_len)
            { id: 'g1', byte_len: 1, sequence: 0, parent_id: 'g' },
            { id: 'g2', sequence: 1, parent_id: 'g' },               // nested group
            { id: 'g2a', byte_len: 3, sequence: 0, parent_id: 'g2' },
            { id: 'tail', byte_len: 1, sequence: 2, parent_id: null },
        ]));
        expect(res.byId.get('a').offset).toBe(0);
        expect(res.byId.get('g')).toEqual({ offset: 2, size: 4, isGroup: true });
        expect(res.byId.get('g1').offset).toBe(2);
        expect(res.byId.get('g2')).toEqual({ offset: 3, size: 3, isGroup: true });
        expect(res.byId.get('g2a').offset).toBe(3);
        expect(res.byId.get('tail').offset).toBe(6);
        expect(res.total).toBe(7);
        expect(res.exact).toBe(true);
    });

    it('dynamic size falls back to computedValue byte count when byte_len is missing', () => {
        const res = computeByteOffsets(inst([
            { id: 'dyn', sequence: 0, parent_id: null, parameter_config: { computedValue: '0F' } },
            { id: 'next', byte_len: 1, sequence: 1, parent_id: null },
        ]));
        expect(res.byId.get('dyn').size).toBe(1);
        expect(res.byId.get('next').offset).toBe(1);
        expect(res.total).toBe(2);
        expect(res.exact).toBe(true);
    });

    it('unknown size: own offset stays, later offsets become null, total is a lower bound', () => {
        const res = computeByteOffsets(inst([
            { id: 'head', byte_len: 2, sequence: 0, parent_id: null },
            { id: 'unk', sequence: 1, parent_id: null },                 // no byte_len, no computedValue
            { id: 'tail', byte_len: 4, sequence: 2, parent_id: null },
        ]));
        expect(res.byId.get('head').offset).toBe(0);
        expect(res.byId.get('unk').offset).toBe(2);
        expect(res.byId.get('unk').size).toBeNull();
        expect(res.byId.get('tail').offset).toBeNull();
        expect(res.total).toBe(6);   // lower bound: known sizes only (2 + 4; unknown block missing)
        expect(res.exact).toBe(false);
    });

    it('computedValue "??" counts as unknown (placeholder from useInstructionLanes)', () => {
        const res = computeByteOffsets(inst([
            { id: 'x', sequence: 0, parent_id: null, parameter_config: { computedValue: '??' } },
        ]));
        expect(res.byId.get('x').size).toBeNull();
        expect(res.exact).toBe(false);
    });

    it('a group with one unknown child is unknown, but its own start offset remains', () => {
        const res = computeByteOffsets(inst([
            { id: 'head', byte_len: 1, sequence: 0, parent_id: null },
            { id: 'g', sequence: 1, parent_id: null },
            { id: 'ok', byte_len: 2, sequence: 0, parent_id: 'g' },
            { id: 'bad', sequence: 1, parent_id: 'g' },
            { id: 'after', byte_len: 1, sequence: 2, parent_id: null },
        ]));
        expect(res.byId.get('g').offset).toBe(1);
        expect(res.byId.get('g').size).toBeNull();
        expect(res.byId.get('after').offset).toBeNull();
        expect(res.exact).toBe(false);
    });

    it('treats orphan parent_id as root (blockMerge convention)', () => {
        const res = computeByteOffsets(inst([
            { id: 'orphan', byte_len: 2, sequence: 1, parent_id: 'ghost' },
            { id: 'root', byte_len: 1, sequence: 0, parent_id: null },
        ]));
        expect(res.byId.get('root').offset).toBe(0);
        expect(res.byId.get('orphan').offset).toBe(1);
        expect(res.byId.get('orphan').isGroup).toBe(false);
    });

    it('handles empty / missing instruction gracefully', () => {
        expect(computeByteOffsets(null)).toEqual({ byId: new Map(), total: 0, exact: true, variable: false });
        expect(computeByteOffsets({ fields: [] }).total).toBe(0);
    });

    it('classifies plain fixed chains as FIXED (variable=false)', () => {
        const res = computeByteOffsets(inst([
            { id: 'a', byte_len: 1, sequence: 0, parent_id: null },
        ]));
        expect(res.variable).toBe(false);
        expect(res.exact).toBe(true);
    });

    it('classifies DYNAMIC repeat as variable while keeping the encoder-aligned total (B7: one copy)', () => {
        const res = computeByteOffsets(inst([
            { id: 'g', sequence: 0, parent_id: null, repeat_type: 'DYNAMIC', repeat_ref_id: 'len-field' },
            { id: 'g1', byte_len: 2, sequence: 0, parent_id: 'g' },
            { id: 'tail', byte_len: 1, sequence: 1, parent_id: null },
        ]));
        expect(res.variable).toBe(true);
        expect(res.exact).toBe(true);       // current structure is still computable
        expect(res.total).toBe(3);          // Σ once — matches what the encoder emits
        expect(res.byId.get('g').size).toBe(2);
    });

    it('classifies value-driven sizes (computedValue fallback) as variable', () => {
        const res = computeByteOffsets(inst([
            { id: 'dyn', sequence: 0, parent_id: null, parameter_config: { computedValue: '0F 0F' } },
        ]));
        expect(res.byId.get('dyn').size).toBe(2);
        expect(res.exact).toBe(true);
        expect(res.variable).toBe(true);
    });

    it('an EMPTY group is a known 0 bytes (seed rows carry byte_len=0) and does not poison offsets', () => {
        const res = computeByteOffsets(inst([
            { id: 'head', byte_len: 2, sequence: 0, parent_id: null },
            { id: 'emptyg', sequence: 1, parent_id: null, op_code: 'ARRAY_GROUP', byte_len: 0 },
            { id: 'tail', byte_len: 1, sequence: 2, parent_id: null },
        ]));
        expect(res.byId.get('emptyg')).toEqual({ offset: 2, size: 0, isGroup: true });
        expect(res.byId.get('tail').offset).toBe(2);
        expect(res.exact).toBe(true);
        expect(res.total).toBe(3);
    });

    it('unknown size implies variable', () => {
        const res = computeByteOffsets(inst([
            { id: 'unk', sequence: 0, parent_id: null },
        ]));
        expect(res.variable).toBe(true);
        expect(res.exact).toBe(false);
    });
});

describe('formatOffset', () => {
    it('formats plain, group and unknown entries', () => {
        expect(formatOffset({ offset: 0, size: 2, isGroup: false })).toBe('@00');
        expect(formatOffset({ offset: 9, size: 2, isGroup: false })).toBe('@09');
        expect(formatOffset({ offset: 10, size: 1, isGroup: false })).toBe('@0A');
        expect(formatOffset({ offset: 2, size: 4, isGroup: true })).toBe('@02..');
        expect(formatOffset({ offset: null, size: null, isGroup: false })).toBe('··');
        expect(formatOffset(undefined)).toBe('··');
    });
});
