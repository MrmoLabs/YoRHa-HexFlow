import { describe, it, expect } from 'vitest';
import { computeByteOffsets } from '../byteOffsets';

// ─── N5 (G4 · PLAN §8.16): 偏移尺的 pad 口径（红测先行） ──────────────────────
// 口径（与发射流 byte-equal 对齐）：
// - offset = 字段**内容起点**（align 补位后的地址 —— 对齐芯片显示的就是它）；
// - size = 内容字节（既有口径零改动：组 = Σ children × reps，不含 pad）；
// - pad = 归入本字段 span 的填充字节（own pad_to + 被下一字段借走的 align 前置
//   pad + 组内子字段 pad 汇总）—— 仅 >0 时写入（既有 toEqual 全形状断言零改动）；
// - total = 线上总长（含 pad，游标驱动）。
// 布局：卡片宽度 = size + pad → 与标尺逐格对齐、@ 芯片即内容起点。

const offsetsOf = (specs) => {
    // byteOffsets 吃扁平列表（parent_id 关联）——嵌套 helper 产物先摊平，
    // 与前端 GET /instructions 的返回形态一致。
    const flat = [];
    const push = (f) => {
        const { fields: nested, ...rest } = f;
        flat.push(rest);
        (nested || []).forEach(push);
    };
    specs.forEach(push);
    return computeByteOffsets({ fields: flat });
};
const padOf = (meta) => (meta && typeof meta.pad === 'number' ? meta.pad : 0);

const L = (id, hex, opts = {}) => ({
    id, name: id.toUpperCase(), op_code: 'FIXED', byte_len: hex.length / 2,
    sequence: opts.seq ?? 0, parent_id: opts.pid ?? null,
    parameter_config: {
        hex,
        ...(opts.align !== undefined ? { align: opts.align } : {}),
        ...(opts.pad_to !== undefined ? { pad_to: opts.pad_to } : {}),
        ...(opts.presence !== undefined ? { presence: opts.presence } : {}),
        ...(opts.value !== undefined ? { value: opts.value } : {}),
    },
});

const G = (id, kids, opts = {}) => ({
    id, name: id.toUpperCase(), op_code: 'ARRAY_GROUP', byte_len: 0,
    sequence: opts.seq ?? 0, parent_id: opts.pid ?? null,
    parameter_config: {
        ...(opts.align !== undefined ? { align: opts.align } : {}),
        ...(opts.pad_to !== undefined ? { pad_to: opts.pad_to } : {}),
    },
    ...(opts.repeat ? { repeat_type: opts.repeat[0], repeat_count: opts.repeat[1] } : {}),
    fields: kids.map((k, i) => ({ ...k, parent_id: id, sequence: i })),
});

describe('N5 byteOffsets pad 口径', () => {
    it('align 前置 pad 归入前一字段 span；offset = 内容起点；total 含 pad', () => {
        const res = offsetsOf([L('a', 'AA', { seq: 0 }), L('b', 'CC', { seq: 1, align: 2 })]);
        expect(res.byId.get('a')).toEqual({ offset: 0, size: 1, isGroup: false, pad: 1 });
        expect(res.byId.get('b')).toEqual({ offset: 2, size: 1, isGroup: false });
        expect(res.total).toBe(3);
    });

    it('pad_to 归入本字段 span（内容末尾 → 下一字段内容起点）', () => {
        const res = offsetsOf([L('a', 'AABB', { seq: 0, pad_to: 4 }), L('b', 'CC', { seq: 1 })]);
        expect(res.byId.get('a')).toEqual({ offset: 0, size: 2, isGroup: false, pad: 2 });
        expect(res.byId.get('b')).toEqual({ offset: 4, size: 1, isGroup: false });
        expect(res.total).toBe(5);
    });

    it('组级 align：组内容起点补位，前置 pad 归入前一字段；子字段偏移随之右移', () => {
        const res = offsetsOf([
            L('a', 'AA', { seq: 0 }),
            G('g', [L('x', 'BB'), L('y', 'CC')], { seq: 1, align: 4 }),
        ]);
        expect(res.byId.get('a')).toEqual({ offset: 0, size: 1, isGroup: false, pad: 3 });
        expect(res.byId.get('g')).toEqual({ offset: 4, size: 2, isGroup: true });
        expect(res.byId.get('x')).toEqual({ offset: 4, size: 1, isGroup: false });
        expect(res.byId.get('y').offset).toBe(5);
        expect(res.total).toBe(6);
    });

    it('重复组内子字段逐副本对齐：组 span 含副本间填充（非 Σ×reps 常数）', () => {
        const res = offsetsOf([
            G('g', [L('x', 'AA', { align: 2 })], { seq: 0, repeat: ['FIXED', 2] }),
        ]);
        expect(res.byId.get('g')).toEqual({ offset: 0, size: 2, isGroup: true, pad: 1 });
        expect(res.byId.get('x')).toEqual({ offset: 0, size: 1, isGroup: false });
        expect(res.total).toBe(3);
    });

    it('presence 静态未命中 → 字段 0 字节且不补 pad（与发射口径一致）', () => {
        const res = offsetsOf([
            L('a', 'AA', { seq: 0, value: 1 }),
            L('b', 'CC', { seq: 1, align: 2, presence: { ref_id: 'a', expect: '9' } }),
        ]);
        expect(res.byId.get('b')).toEqual({ offset: 1, size: 0, isGroup: false });
        expect(res.total).toBe(1);
    });

    it('回归：无 pad 配置 → span/total 与既有口径逐字节一致（pad 键不写入）', () => {
        const res = offsetsOf([L('a', 'AA', { seq: 0 }), L('b', 'CC', { seq: 1 })]);
        expect(res.byId.get('a')).toEqual({ offset: 0, size: 1, isGroup: false });
        expect(padOf(res.byId.get('a'))).toBe(0);
        expect(res.byId.get('b').offset).toBe(1);
        expect(res.total).toBe(2);
        expect(res.exact).toBe(true);
        expect(res.variable).toBe(false);
    });
});
