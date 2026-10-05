import { describe, it, expect } from 'vitest';
import { computeByteOffsets, presenceStaticState } from '../byteOffsets';

// ─── N3 (G1 · PLAN §8.16): 设计期 presence 静态尺寸口径（红测先行） ────
// - 判定链 = 静态 pc.value（DYNAMIC repeat 静态 resolve 先例），
//   String(refVal) === String(expect)；
// - 未命中 → 0B（判定先于 repeat：组连 ×N 都不展开，DYNAMIC 也不落 ??）；
// - ref 在场但无静态值（运行输入才有）→ 尺寸落 ??（「未知落 ??」先例）；
// - 悬空 ref / 配置不完整 → fail-open（编码恒发射 → 无门 → 正常尺寸）；
// - 组未命中 → 整棵子树 0（子字段尺寸同步归 0）；
// - presence 门完整（hit/miss/unknown）→ 发射随运行值变化 → variable=true。
// 结构口径：computeByteOffsets 只走 parent_id 扁平链（与存量指令负载同构）。

const F = (id, seq, cfg, parent_id = null, extra = {}) => ({
    id, name: id.toUpperCase(), op_code: 'FIXED', byte_len: 1, sequence: seq,
    parent_id, parameter_config: cfg, ...extra,
});
const cmd = (value = 1) => F('cmd', 0, value === undefined ? { hex: 'AA' } : { hex: 'AA', value });

describe('N3 byteOffsets 叶级 presence 静态预判', () => {
    it('未命中 → size 0（后继偏移不被污染，总长不含）', () => {
        const offsets = computeByteOffsets({ fields: [
            cmd(1),
            F('gated', 1, { hex: 'BB', presence: { ref_id: 'cmd', expect: '2' } }),
            F('next', 2, { hex: 'CC' }),
        ] });
        expect(offsets.byId.get('gated').size).toBe(0);
        expect(offsets.byId.get('next').offset).toBe(1);
        expect(offsets.total).toBe(2);
        expect(offsets.exact).toBe(true);
        expect(offsets.variable).toBe(true); // presence 门完整 → 运行值可翻转 → VAR
    });

    it('命中 → 正常尺寸链', () => {
        const offsets = computeByteOffsets({ fields: [
            cmd(1),
            F('gated', 1, { hex: 'BB', presence: { ref_id: 'cmd', expect: '1' } }),
            F('next', 2, { hex: 'CC' }),
        ] });
        expect(offsets.byId.get('gated').size).toBe(1);
        expect(offsets.byId.get('next').offset).toBe(2);
        expect(offsets.total).toBe(3);
    });

    it('ref 在场但无静态值（运行输入）→ 尺寸 ??（null，后继落 ··）', () => {
        const offsets = computeByteOffsets({ fields: [
            F('cmd', 0, { hex: 'AA' }),                    // 无 value
            F('gated', 1, { hex: 'BB', presence: { ref_id: 'cmd', expect: '1' } }),
            F('next', 2, { hex: 'CC' }),
        ] });
        expect(offsets.byId.get('gated').size).toBeNull();
        expect(offsets.exact).toBe(false);
        expect(offsets.byId.get('next').offset).toBeNull();
        expect(offsets.variable).toBe(true);
    });

    it('悬空 ref → fail-open 无门 → 正常尺寸（编码恒发射）', () => {
        const offsets = computeByteOffsets({ fields: [
            cmd(1),
            F('gated', 1, { hex: 'BB', presence: { ref_id: 'ghost', expect: '1' } }),
        ] });
        expect(offsets.byId.get('gated').size).toBe(1);
        expect(offsets.variable).toBe(false); // 无完整门 → 静态可知
    });

    it('配置不完整 → fail-open 无门 → 正常尺寸', () => {
        const offsets = computeByteOffsets({ fields: [
            cmd(1),
            F('gated', 1, { hex: 'BB', presence: { ref_id: 'cmd' } }),
            F('gated2', 2, { hex: 'CC', presence: {} }),
            F('gated3', 3, { hex: 'DD', presence: 'bad' }),
        ] });
        expect(offsets.byId.get('gated').size).toBe(1);
        expect(offsets.byId.get('gated2').size).toBe(1);
        expect(offsets.byId.get('gated3').size).toBe(1);
        expect(offsets.variable).toBe(false);
    });
});

describe('N3 byteOffsets 组级 presence（判定先于 repeat）', () => {
    it('未命中 + FIXED×3 → size 0（不展开、不落 ??）', () => {
        const offsets = computeByteOffsets({ fields: [
            cmd(1),
            { id: 'g', name: 'G', byte_len: 0, sequence: 1, parent_id: null,
                repeat_type: 'FIXED', repeat_count: 3,
                parameter_config: { presence: { ref_id: 'cmd', expect: '2' } } },
            F('a', 0, { hex: '11' }, 'g'),
            F('next', 2, { hex: 'CC' }),
        ] });
        expect(offsets.byId.get('g').size).toBe(0);
        expect(offsets.byId.get('next').offset).toBe(1);
        expect(offsets.total).toBe(2);
        expect(offsets.variable).toBe(true);
    });

    it('未命中 + DYNAMIC repeat → size 0（presence 先于 repeat：DYNAMIC 不落 ??）', () => {
        const offsets = computeByteOffsets({ fields: [
            cmd(1),
            { id: 'g', name: 'G', byte_len: 0, sequence: 1, parent_id: null,
                repeat_type: 'DYNAMIC', repeat_ref_id: 'cmd',
                parameter_config: { presence: { ref_id: 'cmd', expect: '2' } } },
            F('a', 0, { hex: '11' }, 'g'),
        ] });
        expect(offsets.byId.get('g').size).toBe(0);
        expect(offsets.exact).toBe(true); // 已判死 0，不是未知
    });

    it('命中 + FIXED×3 → Σ×N 正常展开', () => {
        const offsets = computeByteOffsets({ fields: [
            cmd(1),
            { id: 'g', name: 'G', byte_len: 0, sequence: 1, parent_id: null,
                repeat_type: 'FIXED', repeat_count: 3,
                parameter_config: { presence: { ref_id: 'cmd', expect: '1' } } },
            F('a', 0, { hex: '11' }, 'g'),
        ] });
        expect(offsets.byId.get('g').size).toBe(3);
    });

    it('组未命中 → 子树内子字段尺寸同步 0（组未命中整棵子树不发）', () => {
        const offsets = computeByteOffsets({ fields: [
            cmd(1),
            { id: 'g', name: 'G', byte_len: 0, sequence: 1, parent_id: null,
                parameter_config: { presence: { ref_id: 'cmd', expect: '2' } } },
            F('a', 0, { hex: '11' }, 'g'),
            F('b', 1, { hex: '22', presence: { ref_id: 'cmd', expect: '1' } }, 'g'),
            F('next', 2, { hex: 'CC' }),
        ] });
        expect(offsets.byId.get('g').size).toBe(0);
        expect(offsets.byId.get('a').size).toBe(0); // 父未命中 → 子不发射
        expect(offsets.byId.get('b').size).toBe(0); // 子自身命中也不豁免（父门在上）
        expect(offsets.byId.get('next').offset).toBe(1);
    });
});

describe('N3 presenceStaticState 导出语义（lanes 复用）', () => {
    it('完整配置 → hit / miss / unknown；无门 → null', () => {
        const fields = [
            cmd(1),
            F('noVal', 1, { hex: 'BB' }),
            F('a', 2, { hex: 'CC', presence: { ref_id: 'cmd', expect: '1' } }),
            F('b', 3, { hex: 'DD', presence: { ref_id: 'cmd', expect: '2' } }),
            F('c', 4, { hex: 'EE', presence: { ref_id: 'noVal', expect: '1' } }),
            F('d', 5, { hex: 'FF' }),
        ];
        const byId = new Map(fields.map(x => [x.id, x]));
        expect(presenceStaticState(fields[2], byId)).toBe('hit');
        expect(presenceStaticState(fields[3], byId)).toBe('miss');
        expect(presenceStaticState(fields[4], byId)).toBe('unknown');
        expect(presenceStaticState(fields[5], byId)).toBeNull();
        expect(presenceStaticState(cmd(1), byId)).toBeNull();
    });
});

// ─── R32 (§8.64): 设计期静态链同批归一（与 _presenceHit 改一必改二） ─────────
// 设计期的偏移尺 / 尺寸口径走 presenceStaticState，若它不跟归一，就会出现
// 「编码期命中、卡面却按 0 字节排偏移」的两端自相矛盾。
describe('R32 presenceStaticState 十六进制归一', () => {
    const st = (expectVal, refValue) => {
        const fields = [cmd(refValue),
            F('gated', 1, { hex: 'BB', presence: { ref_id: 'cmd', expect: expectVal } })];
        return presenceStaticState(fields[1], new Map(fields.map(x => [x.id, x])));
    };

    it('expect "01" + 静态值 1 → hit（与编码期同口径）', () => {
        expect(st('01', 1)).toBe('hit');
    });

    it('expect "0A" + 静态值 10 → hit', () => {
        expect(st('0A', 10)).toBe('hit');
    });

    it('真·不同值（expect "9" / 1）→ 仍 miss', () => {
        expect(st('9', 1)).toBe('miss');
    });

    it('expect 带空白（" 1"）→ 非整串 hex → 不归一，仍 miss', () => {
        expect(st(' 1', 1)).toBe('miss');
    });

    it('expect 是数字 10 / 静态值 16 → 不归一，仍 miss（归一仅限字符串 expect）', () => {
        expect(st(10, 16)).toBe('miss');
    });
});
