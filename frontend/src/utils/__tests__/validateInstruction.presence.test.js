import { describe, it, expect } from 'vitest';
import { validateInstruction } from '../validateInstruction';

// ─── N3 (G1 · PLAN §8.16): presence 校验四码（红测先行） ────
// E  PRESENCE_SELF         —— 自引用（引用自身 id）
// W  PRESENCE_REF_MISSING  —— ref 指向不存在字段（编码 fail-open 提醒）
// W  PRESENCE_INCOMPLETE   —— 配置不完整（非对象 / 缺 ref_id / 缺 expect）
//                             → 编码按命中处理（fail-open），提醒核对或清除
// W  PRESENCE_OVERLAP      —— 同 ref 同 expect 的多支并存（建议合并）

const f = (id, seq, cfg = {}) => ({
    id, name: id.toUpperCase(), op_code: 'INT_SIGNED', byte_len: 1,
    sequence: seq, parent_id: null, parameter_config: { value: 1, ...cfg },
});
const instr = (fields) => ({ fields });
const codes = (r, level) => r[level].map(e => e.code).filter(c => c.startsWith('PRESENCE'));

describe('N3 E PRESENCE_SELF（自引用）', () => {
    it('presence.ref_id 指向自身 → error', () => {
        const r = validateInstruction(instr([f('a', 0, { presence: { ref_id: 'a', expect: '1' } })]));
        expect(r.errors.some(e => e.code === 'PRESENCE_SELF' && e.blockId === 'a')).toBe(true);
        expect(codes(r, 'warnings')).toEqual([]);
    });
});

describe('N3 W PRESENCE_REF_MISSING（悬空 ref）', () => {
    it('ref_id 不在字段表 → warning，不产生 error', () => {
        const r = validateInstruction(instr([f('a', 0, { presence: { ref_id: 'ghost', expect: '1' } })]));
        expect(r.warnings.some(w => w.code === 'PRESENCE_REF_MISSING' && w.blockId === 'a')).toBe(true);
        expect(r.errors).toEqual([]);
    });

    it('ref 存在 → 不报 REF_MISSING', () => {
        const r = validateInstruction(instr([
            f('a', 0, { presence: { ref_id: 'b', expect: '1' } }),
            f('b', 1),
        ]));
        expect(r.warnings.some(w => w.code === 'PRESENCE_REF_MISSING')).toBe(false);
    });
});

describe('N3 W PRESENCE_INCOMPLETE（fail-open 配置提醒）', () => {
    const cases = [
        ['缺 expect', { ref_id: 'b' }],
        ['缺 ref_id', { expect: '1' }],
        ['空对象', {}],
        ['expect 空串', { ref_id: 'b', expect: '' }],
        ['非对象（字符串）', 'oops'],
        ['非对象（数组）', [1]],
    ];
    cases.forEach(([name, presence]) => {
        it(`${name} → warning，且不产生 error（fail-open 不阻断保存）`, () => {
            const r = validateInstruction(instr([
                f('a', 0, { presence }),
                f('b', 1),
            ]));
            expect(r.warnings.some(w => w.code === 'PRESENCE_INCOMPLETE' && w.blockId === 'a')).toBe(true);
            expect(r.errors).toEqual([]);
        });
    });
});

describe('N3 W PRESENCE_OVERLAP（同 ref 同 expect 多支并存）', () => {
    it('两支完全同条件 → 恰好一条 warning，落在后出现的字段', () => {
        const r = validateInstruction(instr([
            f('a', 0, { presence: { ref_id: 'c', expect: '1' } }),
            f('b', 1, { presence: { ref_id: 'c', expect: '1' } }),
            f('c', 2),
        ]));
        const overlaps = r.warnings.filter(w => w.code === 'PRESENCE_OVERLAP');
        expect(overlaps).toHaveLength(1);
        expect(overlaps[0].blockId).toBe('b');
    });

    it('同 ref 不同 expect（真分支）→ 不报 OVERLAP', () => {
        const r = validateInstruction(instr([
            f('a', 0, { presence: { ref_id: 'c', expect: '1' } }),
            f('b', 1, { presence: { ref_id: 'c', expect: '2' } }),
            f('c', 2),
        ]));
        expect(r.warnings.some(w => w.code === 'PRESENCE_OVERLAP')).toBe(false);
    });

    it('不同 ref 同 expect → 不报 OVERLAP', () => {
        const r = validateInstruction(instr([
            f('a', 0, { presence: { ref_id: 'b', expect: '1' } }),
            f('b', 1, { presence: { ref_id: 'c', expect: '1' } }),
            f('c', 2),
        ]));
        expect(r.warnings.some(w => w.code === 'PRESENCE_OVERLAP')).toBe(false);
    });
});

describe('N3 合法 presence 零误报', () => {
    it('完整配置（ref 存在 + expect 非空、无重复）→ 四码全无', () => {
        const r = validateInstruction(instr([
            f('a', 0, { presence: { ref_id: 'b', expect: '1' } }),
            f('b', 1),
        ]));
        expect(codes(r, 'errors')).toEqual([]);
        expect(codes(r, 'warnings')).toEqual([]);
    });

    it('无 presence 的存量字段 → 四码全无（存量零回归）', () => {
        const r = validateInstruction(instr([f('a', 0), f('b', 1)]));
        expect(codes(r, 'errors')).toEqual([]);
        expect(codes(r, 'warnings')).toEqual([]);
    });
});
