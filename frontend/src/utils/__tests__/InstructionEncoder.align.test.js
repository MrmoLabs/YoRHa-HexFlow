import { describe, it, expect } from 'vitest';
import { InstructionEncoder } from '../InstructionEncoder';

// ─── N5 (G4 · PLAN §8.16): 字段级 align/pad_to 填充对齐 —— 编码期出帧 ────────
// VECTORS 与 backend/tests/test_encode_align.py 逐行同步（改一必改二）。
// 口径：
// - align = N → 内容**起点**绝对偏移补位到 ≡0 (mod N)；pad_to = N → 内容**末尾**
//   补位到 ≡0 (mod N)；已对齐 0 字节；
// - pad_byte ≤2 位 hex → 填充字节值，否则 0x00；非法 align/pad_to → 忽略（fail-open）；
// - 组：align 首副本前补一次、pad_to 末副本后补一次；子字段逐副本按绝对偏移算；
// - presence 未命中 / repeat=0 → 字段与 pad 都不发；
// - LITTLE：pad 不参与字节序反转（pad 在 getFieldBytes 反转之外）；
// - pad 进 hexString（线上字节）与 byteMap 的**位置**，但不进 byteMap 区间
//   （byteMap 只记内容，同 PASS0 长度/校验的内容口径）。

const strip = (r) => r.hexString.replace(/\s/g, '');
const enc = (specs) => {
    const instr = build(specs);
    const computed = InstructionEncoder.resolveDependencies(instr, {});
    return strip(InstructionEncoder.encodeInstruction(instr, {}, computed));
};

const L = (id, hex, opts = {}) => ({
    id, name: id.toUpperCase(), op_code: 'FIXED', byte_len: hex.length / 2,
    sequence: 0, parent_id: null,
    parameter_config: {
        hex,
        ...(opts.align !== undefined ? { align: opts.align } : {}),
        ...(opts.pad_to !== undefined ? { pad_to: opts.pad_to } : {}),
        ...(opts.pad_byte !== undefined ? { pad_byte: opts.pad_byte } : {}),
        ...(opts.presence !== undefined ? { presence: opts.presence } : {}),
        ...(opts.value !== undefined ? { value: opts.value } : {}),
    },
    ...(opts.endianness ? { endianness: opts.endianness } : {}),
});

const G = (id, kids, opts = {}) => ({
    id, name: id.toUpperCase(), op_code: 'ARRAY_GROUP', byte_len: 0,
    sequence: 0, parent_id: null,
    parameter_config: {
        ...(opts.align !== undefined ? { align: opts.align } : {}),
        ...(opts.pad_to !== undefined ? { pad_to: opts.pad_to } : {}),
        ...(opts.pad_byte !== undefined ? { pad_byte: opts.pad_byte } : {}),
        ...(opts.presence !== undefined ? { presence: opts.presence } : {}),
    },
    ...(opts.repeat ? { repeat_type: opts.repeat[0], repeat_count: opts.repeat[1] } : {}),
    fields: kids.map((k, i) => ({ ...k, parent_id: id, sequence: i })),
});

// 顶层按位置定序（与 BE frame_of 同规则）
const build = (specs) => ({ fields: specs.map((f, i) => ({ ...f, sequence: i })) });

// 与 backend/tests/test_encode_align.py VECTORS 同步：(字段规格, 期望帧 hex)
const VECTORS = [
    // align 已对齐 → 0 补位
    [[L('a', 'AABB'), L('b', 'CC', { align: 2 })], 'AABBCC'],
    // align 补 1 / 补 3
    [[L('a', 'AA'), L('b', 'CC', { align: 2 })], 'AA00CC'],
    [[L('a', 'AA'), L('b', 'CC', { align: 4 })], 'AA000000CC'],
    // pad_to 帧尾补 2
    [[L('a', 'AABB', { pad_to: 4 }), L('b', 'CC')], 'AABB0000CC'],
    // pad_byte 改填充字节值
    [[L('a', 'AA'), L('b', 'CC', { align: 2, pad_byte: 'FF' })], 'AAFFCC'],
    // align + pad_to 同字段：内容起点 4、内容末尾 5 → 补到 8（补 3）
    [[L('a', 'AA'), L('b', 'CC', { align: 4, pad_to: 8 })], 'AA000000CC000000'],
    // 组级 align：组内容起点补位到 4（归入前一字段的 span）
    [[L('a', 'AA'), G('g', [L('x', 'BB'), L('y', 'CC')], { align: 4 })], 'AA000000BBCC'],
    // 重复组内子字段 align：逐副本按绝对偏移算（非 Σ×reps 常数）
    [[G('g', [L('x', 'AA', { align: 2 })], { repeat: ['FIXED', 2] })], 'AA00AA'],
    // presence 未命中 → 字段与 pad 都不发
    [[L('a', 'AA', { value: 1 }), L('b', 'CC', { align: 2, presence: { ref_id: 'a', expect: '9' } })], 'AA'],
    // presence 命中 → 照常补位
    [[L('a', 'AA', { value: 1 }), L('b', 'CC', { align: 2, presence: { ref_id: 'a', expect: '1' } })], 'AA00CC'],
    // pad_to 在末副本之后补一次（副本共 2 字节 → 补 6）
    [[G('g', [L('x', 'BB')], { repeat: ['FIXED', 2], pad_to: 8 })], 'BBBB000000000000'],
    // LITTLE：pad 不参与反转（pad 在反转后的字段字节之外）
    [[L('a', 'AA'), L('b', '1234', { align: 4, endianness: 'LITTLE' })], 'AA0000003412'],
    // 非法 align → 忽略（fail-open）
    [[L('a', 'AA'), L('b', 'CC', { align: 0 })], 'AACC'],
    [[L('a', 'AA'), L('b', 'CC', { align: '9999' })], 'AACC'],
    // 数值串 → 归一（同 byte_len 的 Number/floor 口径）
    [[L('a', 'AA'), L('b', 'CC', { align: '4' })], 'AA000000CC'],
    // 非法 pad_byte → 0x00
    [[L('a', 'AA'), L('b', 'CC', { align: 2, pad_byte: 'Z' })], 'AA00CC'],
];

describe('N5 align/pad_to VECTORS（双端 byte-equal · 改一必改二）', () => {
    VECTORS.forEach(([specs, expected], i) => {
        it(`vector#${i} → ${expected}`, () => {
            expect(enc(specs)).toBe(expected);
        });
    });
});

describe('N5 align/pad_to 的 byteMap 口径（内容区间，pad 位置仍为线上绝对偏移）', () => {
    it('align 前置 pad 不进 byteMap：区间跳过填充、start 为内容绝对位置', () => {
        const instr = build([L('a', 'AA'), L('b', 'CC', { align: 2 })]);
        const computed = InstructionEncoder.resolveDependencies(instr, {});
        const { byteMap } = InstructionEncoder.encodeInstruction(instr, {}, computed);
        expect(byteMap).toEqual([
            { start: 0, end: 1, fieldId: 'a' },
            { start: 2, end: 3, fieldId: 'b' },
        ]);
    });

    it('pad_to 后置 pad 不进 byteMap（下一字段内容位置右移）', () => {
        const instr = build([L('a', 'AABB', { pad_to: 4 }), L('b', 'CC')]);
        const computed = InstructionEncoder.resolveDependencies(instr, {});
        const { byteMap } = InstructionEncoder.encodeInstruction(instr, {}, computed);
        expect(byteMap).toEqual([
            { start: 0, end: 2, fieldId: 'a' },
            { start: 4, end: 5, fieldId: 'b' },
        ]);
    });
});
