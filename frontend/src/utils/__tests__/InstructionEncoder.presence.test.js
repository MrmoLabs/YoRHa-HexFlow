import { describe, it, expect } from 'vitest';
import { InstructionEncoder } from '../InstructionEncoder';
import { loadVectors } from '../../../../vectors/vectors.js';
import presenceVec from '../../../../vectors/presence.json';

// ─── N3 (G1 · PLAN §8.16): presence 条件存在 —— 编码期判定（红测先行） ────
// 口径（LEAF/GROUP/COMBINED 向量单一真相源 = vectors/presence.json，CP2b/D11-①
// 与 backend/tests/test_encode_presence.py 同读这一份）：
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

// CP2b (D11-①): 单一真相源 = vectors/presence.json —— 两端同读一份，新增向量只写一处。
// [presence, expectedHex] —— 帧 = cmd(AA) + gated(BB)
const LEAF_VECTORS = loadVectors(presenceVec.leaf);

// CP2b (D11-①): 单一真相源 = vectors/presence.json —— 两端同读一份，新增向量只写一处。
// [presence, repeat_type, repeat_count, expectedHex] —— 帧 = cmd(AA) + 组(11)
const GROUP_VECTORS = loadVectors(presenceVec.group);

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

// ─── R32 (§8.64): 判定归一 —— expect 是十六进制**字符串**时与数值等价 ────────
// 拍板项（§8.61 第七节 ① / §8.63 第七节）：样本 ② expect 存字符串 "01"，而引用
// 值是数值 1 → 旧口径 `String(1) !== "01"` **恒未命中**，门等于配废。
// R32 让两者**判等**（双端 byte-equal：field_blocks._presence_hit 同批改）。
//
// 三条边界（宁可少判，只做拍板项）：
//   · 归一**仅当 expect 是字符串**（JSON 数字 10 不按 hex 解 → 现状不变）；
//   · expect 必须**整串** `^[0-9A-Fa-f]+$`（空白 / 前缀 / `ALPHA` 一律不归一）；
//   · 数值**超出安全整数**不归一（双端定长精度一致，避免 JS/Python 大整数分叉）。
describe('R32 presence 十六进制归一（"01" ≡ 1 · 双端 byte-equal）', () => {
    const frameWith = (expectVal, refValue) => enc({
        fields: [
            cmdField(refValue),
            leaf('opt', 1, 'BB', { ref_id: 'cmd', expect: expectVal }),
        ],
    });

    it('expect "01" + ref 值 1 → 归一命中（BB 出线）', () => {
        expect(frameWith('01', 1)).toBe('AABB');
    });

    it('expect "0A" + ref 值 10 → 归一命中（带字母的补零形态）', () => {
        expect(frameWith('0A', 10)).toBe('AABB');
    });

    it('ref 是字符串 "1"、expect "01" → 归一命中（归一不看 ref 侧类型）', () => {
        expect(frameWith('01', '1')).toBe('AABB');
    });

    it('真·不同值（expect "9" / ref 1）→ 解析值不等 → 仍未命中', () => {
        expect(frameWith('9', 1)).toBe('AA');
    });

    it('expect 带空白（" 1"）→ 不是整串 hex → 不归一，仍未命中（现状不变）', () => {
        expect(frameWith(' 1', 1)).toBe('AA');
    });

    it('expect 是数字 10、ref 值 16 → 不归一（归一仅限字符串 expect，现状不变）', () => {
        expect(frameWith(10, 16)).toBe('AA');
    });

    it('expect 非十六进制（"ALPHA"）/ ref 1 → 不归一，仍未命中', () => {
        expect(frameWith('ALPHA', 1)).toBe('AA');
    });

    it('组级门同样归一：expect "01" + ref 值 1 → 整棵树发射', () => {
        expect(enc({
            fields: [cmdField(1), group('g', 1, [kid('a', '11', 'g')],
                { ref_id: 'cmd', expect: '01' })],
        })).toBe('AA11');
    });
});
