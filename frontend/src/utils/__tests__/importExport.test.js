import { describe, it, expect } from 'vitest';
import { analyzeImport } from '../importExport';

const makeGen = () => {
    let n = 0;
    return () => `imp-${++n}`;
};

const validInst = (over = {}) => ({
    id: 'src-id',
    device_code: 'DEV-001',
    code: 'IMP-001',
    name: '导入指令',
    type: 'STATIC',
    description: 'demo',
    fields: [
        {
            id: 'f1', parent_id: null, sequence: 0, name: '帧头', op_code: 'HEX_RAW',
            byte_len: 2, endianness: 'BIG', repeat_type: 'NONE', repeat_count: 1,
            parameter_config: { hex: 'AA 55' }, bits: [],
        },
        {
            id: 'f2', parent_id: null, sequence: 1, name: '长度', op_code: 'LENGTH_CALC',
            byte_len: 1, endianness: 'BIG', repeat_type: 'NONE', repeat_count: 1,
            parameter_config: { refs: ['f1'], formula: '[帧头]' }, bits: [],
        },
    ],
    ...over,
});

describe('analyzeImport (P3-2 导入分流；导出已按反馈移除)', () => {
    it('rejects a file without an instructions array', () => {
        const report = analyzeImport({ foo: 1 }, [], makeGen());
        expect(report.payloads).toEqual([]);
        expect(report.errors[0].messages[0]).toMatch(/instructions/);
        expect(report.total).toBe(0);
    });

    it('accepts both a bare array and {instructions} wrappers', () => {
        expect(analyzeImport([validInst()], [], makeGen()).payloads).toHaveLength(1);
        expect(analyzeImport({ schemaVersion: 1, instructions: [validInst()] }, [], makeGen()).payloads).toHaveLength(1);
    });

    it('builds POST-ready payloads with fresh self-contained field ids', () => {
        const report = analyzeImport([validInst()], [], makeGen());
        expect(report.conflicts).toEqual([]);
        expect(report.errors).toEqual([]);
        const payload = report.payloads[0];

        // instruction-level id dropped (backend mints it), metadata kept
        expect('id' in payload).toBe(false);
        expect(payload.name).toBe('导入指令');
        expect(payload.code).toBe('IMP-001');
        expect(payload.device_code).toBe('DEV-001');
        expect(payload.type).toBe('STATIC');

        // fresh field ids, refs remapped onto the clone (E2-safe)
        const ids = payload.fields.map(f => f.id);
        expect(ids).not.toContain('f1');
        expect(ids).not.toContain('f2');
        expect(new Set(ids).size).toBe(2);
        const length = payload.fields.find(f => f.op_code === 'LENGTH_CALC');
        expect(length.parameter_config.refs).toEqual([payload.fields.find(f => f.op_code === 'HEX_RAW').id]);
        expect(length.parameter_config.formula).toBe('[帧头]');
    });

    it('splits existing name/code collisions into conflicts (never overwrites)', () => {
        const existing = [{ name: '别的指令', code: 'IMP-001' }];
        const report = analyzeImport([validInst()], existing, makeGen());
        expect(report.payloads).toEqual([]);
        expect(report.conflicts).toEqual([
            { name: '导入指令', code: 'IMP-001', reason: '代号重复' },
        ]);

        const byName = analyzeImport([validInst()], [{ name: '导入指令', code: 'OTHER' }], makeGen());
        expect(byName.conflicts[0].reason).toBe('名称重复');
    });

    it('treats duplicates WITHIN the file as conflicts', () => {
        const report = analyzeImport([validInst(), validInst()], [], makeGen());
        expect(report.payloads).toHaveLength(1);
        expect(report.conflicts).toHaveLength(1);
        expect(report.total).toBe(2);
    });

    it('flags empty name/code and missing fields', () => {
        const report = analyzeImport([
            { name: '', code: 'X', fields: [] },
            { name: '无字段', code: 'Y' },
            'garbage',
        ], [], makeGen());
        expect(report.conflicts[0].reason).toBe('名称或代号为空');
        expect(report.errors.map(e => e.messages[0]).join(' ')).toMatch(/fields/);
        expect(report.payloads).toEqual([]);
    });

    it('surfaces structural validation errors with their codes', () => {
        const bad = validInst();
        bad.fields[1] = { ...bad.fields[1], name: '帧头' }; // E3 label duplicate
        const report = analyzeImport([bad], [], makeGen());
        expect(report.payloads).toEqual([]);
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0].messages.join(' ')).toContain('LABEL_DUPLICATE');
    });
});
