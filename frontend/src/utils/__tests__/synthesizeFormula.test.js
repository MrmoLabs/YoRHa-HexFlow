import { describe, it, expect } from 'vitest';
import { synthesizeFormula } from '../synthesizeFormula';

// Fixture covering the Σ preview口径: name first, label fallback, nameless.
const fields = [
    { id: 'f-head', name: '帧头' },
    { id: 'f-body', name: '状态块' },
    { id: 'f-tail', label: '帧尾' }, // name 未设 → label 兜底
    { id: 'f-nameless' },
];

describe('synthesizeFormula (A1-a refs → formula)', () => {
    it('全部可解析 → "[A] + [B]"，镜像 Σ 口径（去重、name||label）', () => {
        expect(synthesizeFormula(['f-head', 'f-body'], fields)).toBe('[帧头] + [状态块]');
        expect(synthesizeFormula(['f-tail'], fields)).toBe('[帧尾]'); // label 兜底
        expect(synthesizeFormula(['f-head', 'f-head', 'f-body'], fields))
            .toBe('[帧头] + [状态块]'); // 去重（Set，同 useInstructionLanes）
    });

    it('refs 为空 / 非数组 / fields 缺失 → null', () => {
        expect(synthesizeFormula([], fields)).toBeNull();
        expect(synthesizeFormula(null, fields)).toBeNull();
        expect(synthesizeFormula('f-head', fields)).toBeNull();
        expect(synthesizeFormula(['f-head'], [])).toBeNull();
        expect(synthesizeFormula(['f-head'], undefined)).toBeNull();
    });

    it('任一 ref 悬空 → null（不合成半截公式，先修引用）', () => {
        expect(synthesizeFormula(['ghost'], fields)).toBeNull();
        expect(synthesizeFormula(['f-head', 'ghost'], fields)).toBeNull();
    });

    it('字段无 name/label → null（无法生成可求值 token）', () => {
        expect(synthesizeFormula(['f-nameless'], fields)).toBeNull();
    });
});
