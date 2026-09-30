import { describe, it, expect } from 'vitest';
import { InstructionEncoder } from '../InstructionEncoder';

// ─── N3 (G1 · PLAN §8.16): presence 条件存在 —— 编码期判定（红测先行） ────
// 口径（LEAF/GROUP/COMBINED 向量与 backend/tests/test_encode_presence.py
// 同步，改一必改二）：
// - 判定链 = computed > inputs > pc.value（_repeatCount DYNAMIC 同链），
//   比较 String(refVal) === String(expect)（数值 1 命中 '1'）；
// - fail-open：presence 非对象 / 缺 ref_id / 缺 expect / 值链不可解析
//   （ref 悬空或无值）→ 视为命中（半成品配置不吞字节，防数据丢失）；
// - 判定先于 repeat 展开：组未命中 → 整棵子树 0 字节（连 ×N 都不展开）；
//   命中组内子字段各自独立判 presence（父命中不豁免子）；
// - 未命中字段被 checksum refs 引用 → 0 字节进校验；
//   被 LENGTH_CALC refs 引用 → 尺寸 0（computed 不含）。

const strip = (r) => r.hexString.replace(/\s/g, '');
const enc = (instr, inputs = {}) => {
    const computed = InstructionEncoder.resolveDependencies(instr, inputs);
    return strip(InstructionEncoder.encodeInstruction(instr, inputs, computed));
};

// ref 源字段：FIXED hex 发射 + pc.value 供 presence 值链（E1-5 ref 字段同构）
const cmdField = (value = 1) => ({
    id: 'cmd', name: 'CMD', op_code: 'FIXED', byte_len: 1, sequence: 0, parent_id: null,
    parameter_config: { hex: 'AA', value },
});

// 门控叶（FIXED hex）
const leaf = (id, seq, hex, presence) => ({
    id, name: id.toUpperCase(), op_code: 'FIXED', byte_len: 1, sequence: seq, parent_id: null,
    parameter_config: { hex, ...(presence !== undefined ? { presence } : {}) },
});

// 门控组（fields 嵌套，E1-5 build 同构）
const group = (id, seq, kids, presence, repeat = {}) => ({
    id, name: id.toUpperCase(), byte_len: 0, sequence: seq, parent_id: null,
    parameter_config: { ...(presence !== undefined ? { presence } : {}) },
    ...repeat,
    fields: kids,
});

const kid = (id, hex, pid) => ({
    id, name: id.toUpperCase(), op_code: 'FIXED', byte_len: 1, sequence: 0,
    parent_id: pid, parameter_config: { hex },
});

// 与 backend/tests/test_encode_presence.py LEAF_VECTORS 同步
// [presence, expectedHex] —— 帧 = cmd(AA) + gated(BB)
const LEAF_VECTORS = [
    [{ ref_id: 'cmd', expect: '1' }, 'AABB'],   // 命中
    [{ ref_id: 'cmd', expect: '2' }, 'AA'],     // 未命中
    [{ ref_id: 'cmd', expect: '01' }, 'AA'],    // String 严格归一（'1' ≠ '01'）
    [{ ref_id: 'cmd', expect: ' 1' }, 'AA'],    // 不 trim，严格比较
    [{}, 'AABB'],                               // fail-open：非对象字段缺失
    [{ ref_id: 'cmd' }, 'AABB'],                // fail-open：缺 expect
    [{ expect: '1' }, 'AABB'],                  // fail-open：缺 ref_id
    ['bad', 'AABB'],                            // fail-open：非对象
    [null, 'AABB'],                             // fail-open：null
    [{ ref_id: 'ghost', expect: '1' }, 'AABB'], // fail-open：ref 悬空
    [{ ref_id: 'cmd', expect: null }, 'AABB'],  // fail-open：expect null
    [{ ref_id: 'cmd', expect: '' }, 'AABB'],    // fail-open：expect 空串
    [{ ref_id: 'cmd', expect: 1 }, 'AABB'],     // 数值 expect 命中字符串值
];

// 与 backend/tests/test_encode_presence.py GROUP_VECTORS 同步
// [presence, repeat_type, repeat_count, expectedHex] —— 帧 = cmd(AA) + 组(11)
const GROUP_VECTORS = [
    [{ ref_id: 'cmd', expect: '2' }, 'FIXED', 3, 'AA'],           // 未命中 → 连 ×3 都不展开
    [{ ref_id: 'cmd', expect: '1' }, 'FIXED', 3, 'AA111111'], // 命中 → ×3
    [{ ref_id: 'cmd', expect: '1' }, 'NONE', 1, 'AA11'],
    [{}, 'FIXED', 2, 'AA1111'],                                   // fail-open → 照常展开
    [{ ref_id: 'ghost', expect: '1' }, 'FIXED', 2, 'AA1111'],     // 悬空 fail-open → 照常展开
];

const buildLeaf = (presence) => ({
    fields: [cmdField(), leaf('opt', 1, 'BB', presence)],
});

const buildGroup = (presence, repeat_type, repeat_count) => ({
    fields: [
        cmdField(),
        group('g', 1, [kid('a', '11', 'g')], presence, { repeat_type, repeat_count }),
    ],
});

describe('N3 presence LEAF_VECTORS（命中/未命中/fail-open/归一 · 双端同步）', () => {
    LEAF_VECTORS.forEach(([presence, expected], i) => {
        it(`vector#${i} presence=${JSON.stringify(presence)} → ${expected}`, () => {
            expect(enc(buildLeaf(presence))).toBe(expected);
        });
    });
});

describe('N3 presence GROUP_VECTORS（组级门控 + repeat 交互 · 双端同步）', () => {
    GROUP_VECTORS.forEach(([presence, rt, rc, expected], i) => {
        it(`vector#${i} ${rt}×${String(rc)} presence=${JSON.stringify(presence)} → ${expected}`, () => {
            expect(enc(buildGroup(presence, rt, rc))).toBe(expected);
        });
    });

    it('DYNAMIC repeat + 组未命中 → 0 字节（判定先于 repeat 展开）', () => {
        // ref 字段静态 value=2、presence expect='9' → 未命中；若判定晚于 repeat
        // 展开则组内容仍会被门控到 0 —— 钉死 outcome：组子树整棵不发。
        const instr = {
            fields: [
                { id: 'ref', name: 'REF', op_code: 'FIXED', byte_len: 1, sequence: 0, parent_id: null, parameter_config: { hex: '02', value: 2 } },
                group('g', 1, [kid('a', '11', 'g')], { ref_id: 'ref', expect: '9' },
                    { repeat_type: 'DYNAMIC', repeat_ref_id: 'ref' }),
            ],
        };
        expect(enc(instr)).toBe('02');
    });

    it('DYNAMIC repeat + 组命中 → 按计数展开（门控放行不破坏 E1-5）', () => {
        const instr = {
            fields: [
                { id: 'ref', name: 'REF', op_code: 'FIXED', byte_len: 1, sequence: 0, parent_id: null, parameter_config: { hex: '02', value: 2 } },
                group('g', 1, [kid('a', '11', 'g')], { ref_id: 'ref', expect: '2' },
                    { repeat_type: 'DYNAMIC', repeat_ref_id: 'ref' }),
            ],
        };
        expect(enc(instr)).toBe('021111');
    });
});

describe('N3 presence 嵌套独立（父命中不豁免子）', () => {
    it('命中组内：未命中子跳过、无门子照发', () => {
        const instr = {
            fields: [
                cmdField(),
                group('g', 1, [
                    { ...leaf('a', 0, '11', { ref_id: 'cmd', expect: '2' }), parent_id: 'g' }, // 未命中
                    kid('b', '22', 'g'),                                                        // 无门
                ], { ref_id: 'cmd', expect: '1' }),
            ],
        };
        expect(enc(instr)).toBe('AA22');
    });

    it('命中组内：命中子照发', () => {
        const instr = {
            fields: [
                cmdField(),
                group('g', 1, [
                    { ...leaf('a', 0, '11', { ref_id: 'cmd', expect: '1' }), parent_id: 'g' },
                ], { ref_id: 'cmd', expect: '1' }),
            ],
        };
        expect(enc(instr)).toBe('AA11');
    });

    it('内层组 presence 独立判定（外层命中 + 内层未命中 → 内层子树 0）', () => {
        const instr = {
            fields: [
                cmdField(),
                group('outer', 1, [
                    group('inner', 0, [kid('x', '33', 'inner')], { ref_id: 'cmd', expect: '2' }),
                    kid('y', '44', 'outer'),
                ], { ref_id: 'cmd', expect: '1' }),
            ],
        };
        expect(enc(instr)).toBe('AA44');
    });
});

describe('N3 presence 值链（inputs/computed 优先于静态 value）', () => {
    it('inputs 覆盖静态 value：静态 1 未命中 expect 2，inputs.cmd=2 命中', () => {
        const instr = buildLeaf({ ref_id: 'cmd', expect: '2' });
        expect(enc(instr)).toBe('AA');
        // 输入同时驱动 cmd 自身发射（既有 Computed > Input > Fixed 优先级 → 02）
        expect(enc(instr, { cmd: 2 })).toBe('02BB');
    });

    it('computed 进判定链：LENGTH_CALC 计算值命中/未命中', () => {
        const build = (refs) => ({
            fields: [
                { id: 'a', name: 'A', op_code: 'FIXED', byte_len: 1, sequence: 0, parent_id: null, parameter_config: { hex: '01' } },
                { id: 'b', name: 'B', op_code: 'FIXED', byte_len: 1, sequence: 1, parent_id: null, parameter_config: { hex: '02' } },
                { id: 'len', name: 'LEN', op_code: 'LENGTH_CALC', byte_len: 1, sequence: 2, parent_id: null, parameter_config: { refs } },
                leaf('opt', 3, 'BB', { ref_id: 'len', expect: '2' }),
            ],
        });
        // computed.len = 1+1 = 2 → 命中 → BB 发射
        expect(enc(build(['a', 'b']))).toBe('010202BB');
        // refs 只剩 a → len=1 → 未命中 → BB 不发（len 字节仍发 01）
        expect(enc(build(['a']))).toBe('010201');
    });
});

describe('N3 presence INPUT 字段初值进链（运行期按值路由）', () => {
    it('getInitialValues 默认值驱动门控', () => {
        const instr = {
            fields: [
                { id: 'cmd', name: 'CMD', op_code: 'INPUT', byte_len: 1, sequence: 0, parent_id: null, parameter_config: { type: 'number', default: 1 } },
                leaf('opt', 1, 'BB', { ref_id: 'cmd', expect: '1' }),
            ],
        };
        const inputs = InstructionEncoder.getInitialValues(instr);
        expect(inputs.cmd).toBe(1);
        expect(enc(instr, inputs)).toBe('01BB');
    });
});

describe('N3 派生字段联动（checksum 0 字节进校验 / length 尺寸 0）', () => {
    const cksInstr = (presence) => ({
        fields: [
            { id: 'cmd', name: 'CMD', op_code: 'FIXED', byte_len: 1, sequence: 0, parent_id: null, parameter_config: { hex: '01', value: 1 } },
            leaf('gated', 1, '2A', presence),
            { id: 'cks', name: 'CKS', op_code: 'CHECKSUM_CRC', byte_len: 1, sequence: 2, parent_id: null, parameter_config: { refs: ['cmd', 'gated'], algorithm: 'XOR_8' } },
        ],
    });

    it('未命中字段被 checksum refs 引用 → 0 字节进校验（XOR 只吃 cmd）', () => {
        const instr = cksInstr({ ref_id: 'cmd', expect: '2' }); // 未命中
        const computed = InstructionEncoder.resolveDependencies(instr, {});
        expect(computed.cks).toBe(0x01);              // XOR(01)
        expect(enc(instr)).toBe('0101');              // cmd + 校验值 01
    });

    it('命中字段全量进校验', () => {
        const instr = cksInstr({ ref_id: 'cmd', expect: '1' }); // 命中
        const computed = InstructionEncoder.resolveDependencies(instr, {});
        expect(computed.cks).toBe(0x01 ^ 0x2A);       // XOR(01,2A)=2B
        expect(enc(instr)).toBe('012A2B');
    });

    const lenInstr = (presence) => ({
        fields: [
            { id: 'cmd', name: 'CMD', op_code: 'HEX_RAW', byte_len: 1, sequence: 0, parent_id: null, parameter_config: { hex: '01', value: 1 } },
            leaf('gated', 1, '2A', presence),
            { id: 'len', name: 'LEN', op_code: 'LENGTH_CALC', byte_len: 1, sequence: 2, parent_id: null, parameter_config: { refs: ['cmd', 'gated'] } },
        ],
    });

    it('未命中字段被 LENGTH_CALC refs 引用 → fieldSizes 0（computed 不含）', () => {
        const computed = InstructionEncoder.resolveDependencies(lenInstr({ ref_id: 'cmd', expect: '2' }), {});
        expect(computed.len).toBe(1);
    });

    it('命中字段进 LENGTH_CALC 求和', () => {
        const computed = InstructionEncoder.resolveDependencies(lenInstr({ ref_id: 'cmd', expect: '1' }), {});
        expect(computed.len).toBe(2);
    });
});

describe('N3 COMBINED 向量（与 BE frame byte-equal）', () => {
    it('命中叶 + 未命中叶 + 命中组(×2) + 未命中组 → AA BB 1111', () => {
        const instr = {
            fields: [
                cmdField(),
                leaf('optHit', 1, 'BB', { ref_id: 'cmd', expect: '1' }),
                leaf('optMiss', 2, 'CC', { ref_id: 'cmd', expect: '2' }),
                group('gHit', 3, [kid('a', '11', 'gHit')], { ref_id: 'cmd', expect: '1' }, { repeat_type: 'FIXED', repeat_count: 2 }),
                group('gMiss', 4, [kid('b', '22', 'gMiss')], { ref_id: 'cmd', expect: '2' }),
            ],
        };
        expect(enc(instr)).toBe('AABB1111');
        const r = InstructionEncoder.encodeInstruction(instr, {}, InstructionEncoder.resolveDependencies(instr, {}));
        expect(r.byteMap.map(e => e.fieldId)).toEqual(['cmd', 'optHit', 'a', 'a']);
    });
});

describe('N3 三验收场景（§8.16 · G1）', () => {
    it('可选字段：presence 命中带载荷、未命中仅余帧头/命令', () => {
        const build = (expectVal) => ({
            fields: [
                { id: 'hdr', name: 'HDR', op_code: 'FIXED', byte_len: 1, sequence: 0, parent_id: null, parameter_config: { hex: '55' } },
                { id: 'cmd', name: 'CMD', op_code: 'INPUT', byte_len: 1, sequence: 1, parent_id: null, parameter_config: { type: 'number', default: 1 } },
                leaf('payload', 2, 'AABB', { ref_id: 'cmd', expect: expectVal }),
            ],
        });
        const inputs = InstructionEncoder.getInitialValues(build('1'));
        expect(enc(build('1'), inputs)).toBe('5501AABB');
        expect(enc(build('2'), inputs)).toBe('5501');
    });

    it('TLV count + 分支：计数字段值驱动两支并列建模，按值只发命中支', () => {
        const instr = {
            fields: [
                { id: 'cnt', name: 'CNT', op_code: 'FIXED', byte_len: 1, sequence: 0, parent_id: null, parameter_config: { hex: '02', value: 2 } },
                group('tlvA', 1, [kid('a1', '11', 'tlvA'), { ...kid('a2', '22', 'tlvA'), sequence: 1 }],
                    { ref_id: 'cnt', expect: '2' }, { repeat_type: 'FIXED', repeat_count: 2 }),
                group('tlvB', 2, [kid('b1', '33', 'tlvB')], { ref_id: 'cnt', expect: '3' }),
            ],
        };
        expect(enc(instr)).toBe('0211221122');
        // 计数换 3 → 支换边：A 支整棵不发、B 支发
        const instr3 = JSON.parse(JSON.stringify(instr));
        instr3.fields[0].parameter_config.value = 3;
        instr3.fields[0].parameter_config.hex = '03';
        expect(enc(instr3)).toBe('0333');
    });

    it('按值路由设计期表达：cmd=1 只发 A 支、cmd=2 只发 B 支（inputs 覆盖）', () => {
        const instr = {
            fields: [
                { id: 'cmd', name: 'CMD', op_code: 'INPUT', byte_len: 1, sequence: 0, parent_id: null, parameter_config: { type: 'number', default: 1 } },
                leaf('branchA', 1, '11', { ref_id: 'cmd', expect: '1' }),
                leaf('branchB', 2, '22', { ref_id: 'cmd', expect: '2' }),
            ],
        };
        expect(enc(instr, { cmd: 1 })).toBe('0111');
        expect(enc(instr, { cmd: 2 })).toBe('0222');
    });
});
