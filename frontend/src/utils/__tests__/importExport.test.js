import { describe, it, expect } from 'vitest';
import { analyzeImport, analyzeProtocolImport } from '../importExport';

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

// ─── 批次四 P3-2: 协议导入（analyzeImport 的协议侧对称） ───────────────────
const validProto = (over = {}) => ({
    id: 'p-src',
    label: '外来协议',
    type: 'container',
    description: '外部导出',
    children: [
        { id: 'n1', label: '帧头', type: 'fixed', byte_length: 2, hex_value: 'AA 55', children: [] },
        {
            id: 'n2', label: 'LENGTH', type: 'length', byte_length: 1, hex_value: '00',
            parameter_config: { type: 'length', refs: ['n1'] }, children: []
        }
    ],
    ...over
});

describe('analyzeProtocolImport (批次四 P3-2 协议导入分流)', () => {
    it('rejects a file without a protocols array', () => {
        const report = analyzeProtocolImport({ foo: 1 }, [], makeGen());
        expect(report.total).toBe(0);
        expect(report.payloads).toEqual([]);
        expect(report.errors[0].messages[0]).toMatch(/protocols/);
    });

    it('accepts a bare array and the {protocols} wrapper (对称导出包装)', () => {
        expect(analyzeProtocolImport([validProto()], [], makeGen()).payloads).toHaveLength(1);
        expect(analyzeProtocolImport({ schemaVersion: 1, protocols: [validProto()] }, [], makeGen()).payloads).toHaveLength(1);
    });

    it('builds POST-ready payload: 全树新 id + refs 自含重映射 + 白名单净化 + 算法归一', () => {
        const report = analyzeProtocolImport({
            schemaVersion: 1,
            protocols: [validProto({
                children: [
                    { id: 'n1', label: '帧头', type: 'fixed', byte_length: 2, hex_value: 'AA 55', children: [], editorState: { zoom: 3 } },
                    {
                        id: 'n2', label: 'LENGTH', type: 'length', byte_length: 1, hex_value: '00',
                        parameter_config: { type: 'length', refs: ['n1'] }, children: []
                    },
                    {
                        id: 'n3', label: '校验', type: 'checksum', byte_length: 1, hex_value: '00',
                        parameter_config: { type: 'checksum', refs: ['n1'], algorithm: 'CRC32' }, children: []
                    }
                ]
            })]
        }, [], makeGen());
        expect(report.errors).toEqual([]);
        expect(report.payloads).toHaveLength(1);
        const payload = report.payloads[0];

        expect(payload.id).not.toBe('p-src');
        expect(payload.type).toBe('container');
        expect(payload.description).toBe('外部导出');

        const ids = payload.children.map(c => c.id);
        expect(ids).not.toContain('n1');
        expect(new Set(ids).size).toBe(3);
        // refs 指向克隆后的新 id（自含，落库不会 400 refs target not found）
        const length = payload.children.find(c => c.type === 'length');
        const fixed = payload.children.find(c => c.type === 'fixed');
        expect(length.parameter_config.refs).toEqual([fixed.id]);
        // 白名单：编辑器私有键不落库
        expect(fixed.editorState).toBeUndefined();
        // 算法归一（mapChecksumAlgo: CRC32 → CRC_16_MODBUS，两端回退口径统一）
        const checksum = payload.children.find(c => c.type === 'checksum');
        expect(checksum.parameter_config.algorithm).toBe('CRC_16_MODBUS');
        expect(checksum.parameter_config.refs).toEqual([fixed.id]);
    });

    it('structural errors block the entry: 悬空 ref / 缺 children / 缺 id', () => {
        const dangling = analyzeProtocolImport([validProto({
            children: [
                { id: 'n2', label: 'L', type: 'length', byte_length: 1, parameter_config: { type: 'length', refs: ['ghost'] }, children: [] }
            ]
        })], [], makeGen());
        expect(dangling.payloads).toEqual([]);
        expect(dangling.errors[0].messages.join(' ')).toContain('REF_DANGLING');

        const noChildren = analyzeProtocolImport([{ label: '无树' }], [], makeGen());
        expect(noChildren.errors[0].messages[0]).toMatch(/children/);

        const idless = analyzeProtocolImport([validProto({
            children: [{ label: '无id', type: 'fixed', byte_length: 1, children: [] }]
        })], [], makeGen());
        expect(idless.payloads).toEqual([]);
        expect(idless.errors[0].messages[0]).toMatch(/id/);
    });

    it('label 空闲保真；撞名升序 (导入)/(导入N)，文件内重名同样消耗', () => {
        const free = analyzeProtocolImport([validProto()], [], makeGen());
        expect(free.payloads[0].label).toBe('外来协议');

        const escalated = analyzeProtocolImport(
            [validProto()],
            [{ label: '外来协议' }, { label: '外来协议 (导入)' }],
            makeGen()
        );
        expect(escalated.payloads[0].label).toBe('外来协议 (导入2)');

        const inFile = analyzeProtocolImport(
            [validProto(), validProto({ id: 'p-2' })],
            [],
            makeGen()
        );
        expect(inFile.payloads.map(p => p.label)).toEqual(['外来协议', '外来协议 (导入)']);
    });
});
