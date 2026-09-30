import { describe, it, expect } from 'vitest';
import { normalizeFieldPayload } from '../normalizeInstruction';

// ─── N3 (G1 · PLAN §8.16): presence 白名单清洗（红测先行） ────
// - 合法对象 → 只保留 {ref_id, expect}（ref_id 归一为字符串），残键剔除；
// - 非对象（字符串/数组/null）→ 删键；
// - 无 presence 的存量负载 → 逐字段零变化（不注入键）；
// - 不完整配置（仅 ref_id / 仅 expect）→ 保留（fail-open 编码 + W 提醒核对）。

const f = (cfg) => ({
    id: 'a', name: 'A', op_code: 'INT_SIGNED', byte_len: 1, sequence: 0,
    parent_id: null, parameter_config: cfg, bits: [],
});
const pc = (field) => normalizeFieldPayload(field).parameter_config;

describe('N3 normalize presence 往返', () => {
    it('完整配置原样保留', () => {
        const out = pc(f({ presence: { ref_id: 'cmd', expect: '1' } }));
        expect(out.presence).toEqual({ ref_id: 'cmd', expect: '1' });
    });

    it('残键剔除（白名单只留 ref_id/expect）', () => {
        const out = pc(f({ presence: { ref_id: 'cmd', expect: '1', _picking: true, junk: 3 } }));
        expect(out.presence).toEqual({ ref_id: 'cmd', expect: '1' });
    });

    it('ref_id 数值归一为字符串', () => {
        const out = pc(f({ presence: { ref_id: 42, expect: 1 } }));
        expect(out.presence).toEqual({ ref_id: '42', expect: 1 });
    });

    it('expect 类型原样保留（数值不被字符串化）', () => {
        const out = pc(f({ presence: { ref_id: 'cmd', expect: 2 } }));
        expect(out.presence).toEqual({ ref_id: 'cmd', expect: 2 });
    });
});

describe('N3 normalize 非法 presence 清洗', () => {
    const bad = [
        ['字符串', 'oops'],
        ['数组', [1, 2]],
        ['数值', 7],
        ['null', null],
    ];
    bad.forEach(([name, presence]) => {
        it(`${name} → 删键`, () => {
            const out = pc(f({ value: 3, presence }));
            expect('presence' in out).toBe(false);
            expect(out.value).toBe(3); // 其余配置不受影响
        });
    });
});

describe('N3 normalize 不完整配置保留（fail-open 配置不丢）', () => {
    it('仅 ref_id → 保留', () => {
        const out = pc(f({ presence: { ref_id: 'cmd' } }));
        expect(out.presence).toEqual({ ref_id: 'cmd' });
    });

    it('仅 expect → 保留', () => {
        const out = pc(f({ presence: { expect: '1' } }));
        expect(out.presence).toEqual({ expect: '1' });
    });
});

describe('N3 normalize 存量负载零变化', () => {
    it('无 presence → 不注入键', () => {
        const out = pc(f({ hex: 'AA', value: 1 }));
        expect('presence' in out).toBe(false);
        expect(out).toEqual({ hex: 'AA', value: 1 });
    });

    it('空 parameter_config → 不注入键', () => {
        const out = pc(f(undefined));
        expect('presence' in out).toBe(false);
    });
});
