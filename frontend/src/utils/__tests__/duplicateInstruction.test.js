import { describe, it, expect } from 'vitest';
import { buildDuplicateInstructionPayload } from '../duplicateInstruction';

const makeGen = () => {
    let n = 0;
    return () => `gen-${++n}`;
};

const sourceInstruction = () => ({
    id: 'src-1',
    device_code: 'DEV-001',
    code: 'SRC',
    name: '源指令',
    type: 'STATIC',
    description: 'demo',
    fields: [
        { id: 'h', parent_id: null, sequence: 0, name: '帧头', op_code: 'HEX_RAW', byte_len: 2, parameter_config: { hex: 'AA 55' }, bits: [] },
        {
            id: 'g', parent_id: null, sequence: 1, name: '状态块', op_code: 'ARRAY_GROUP', byte_len: 0,
            parameter_config: { max_count: 1 }, bits: [],
        },
        { id: 'c', parent_id: 'g', sequence: 0, name: '子项', op_code: 'INT_UNSIGNED', byte_len: 2, repeat_ref_id: 'h', parameter_config: { bits: 16 }, bits: [] },
        {
            id: 'l', parent_id: null, sequence: 2, name: '长度', op_code: 'LENGTH_CALC', byte_len: 1,
            // 'ghost' does not exist → must be dropped (E2 REF_DANGLING on save)
            parameter_config: { refs: ['g', 'c', 'ghost'], formula: '[状态块] + [子项]' },
            bits: [],
        },
        {
            id: 'bf', parent_id: null, sequence: 3, name: '位域', op_code: 'BITFIELD', byte_len: 1,
            parameter_config: {},
            bits: [{ id: 'bit-1', sequence: 0, bit_name: 'MODE', start_bit: 0, bit_len: 4, default_val: 0 }],
        },
    ],
});

describe('buildDuplicateInstructionPayload (P2-1 复制指令)', () => {
    it('derives a free name/code and keeps metadata', () => {
        const payload = buildDuplicateInstructionPayload(sourceInstruction(), [], makeGen());
        expect(payload.name).toBe('源指令 (副本)');
        expect(payload.code).toBe('SRC-COPY');
        expect(payload.device_code).toBe('DEV-001');
        expect(payload.type).toBe('STATIC');
        expect(payload.description).toBe('demo');
    });

    it('escalates suffixes until name AND code are free', () => {
        const existing = [
            { name: '源指令 (副本)', code: 'OTHER' },
            { name: '源指令 (副本2)', code: 'SRC-COPY' },
            { name: 'unrelated', code: 'SRC-COPY2' },
        ];
        const payload = buildDuplicateInstructionPayload(sourceInstruction(), existing, makeGen());
        expect(payload.name).toBe('源指令 (副本3)');
        expect(payload.code).toBe('SRC-COPY3');
    });

    it('mints fresh field/bit ids and remaps parent, repeat_ref and refs', () => {
        const source = sourceInstruction();
        const before = JSON.parse(JSON.stringify(source));
        const payload = buildDuplicateInstructionPayload(source, [], makeGen());

        const sourceIds = new Set(source.fields.map(f => f.id));
        payload.fields.forEach(f => {
            expect(sourceIds.has(f.id)).toBe(false);
        });

        const copyChild = payload.fields.find(f => f.op_code === 'INT_UNSIGNED');
        const copyGroup = payload.fields.find(f => f.op_code === 'ARRAY_GROUP');
        const copyLen = payload.fields.find(f => f.op_code === 'LENGTH_CALC');
        const copyBit = payload.fields.find(f => f.op_code === 'BITFIELD');

        // subtree stays attached inside the copy
        expect(copyChild.parent_id).toBe(copyGroup.id);
        // repeat_ref remapped onto the copy's ids
        expect(copyChild.repeat_ref_id).toBe(payload.fields.find(f => f.op_code === 'HEX_RAW').id);
        // refs self-contained: 'ghost' dropped, others point at the copy
        expect(copyLen.parameter_config.refs).toEqual([copyGroup.id, copyChild.id]);
        // bits got fresh ids
        expect(copyBit.bits[0].id).not.toBe('bit-1');
        // structure preserved
        expect(copyLen.parameter_config.formula).toBe('[状态块] + [子项]');
        expect(payload.fields).toHaveLength(source.fields.length);

        // source object untouched (pure)
        expect(JSON.parse(JSON.stringify(source))).toEqual(before);
    });

    it('fields without links keep null parent (root)', () => {
        const payload = buildDuplicateInstructionPayload(sourceInstruction(), [], makeGen());
        const head = payload.fields.find(f => f.name === '帧头');
        expect(head.parent_id).toBeNull();
        expect(head.repeat_ref_id).toBeNull();
    });
});


