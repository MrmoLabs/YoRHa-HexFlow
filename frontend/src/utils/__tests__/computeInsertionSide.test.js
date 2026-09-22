import { describe, it, expect } from 'vitest';
import { computeInsertionSide } from '../computeInsertionSide';

// C1-c: Canvas handleDragOver 侧别推导四分支。
const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('computeInsertionSide (拖拽插入线侧别)', () => {
    it('active 在 over 之前 → right（落在 over 右缘）', () => {
        expect(computeInsertionSide(items, 'a', 'c')).toBe('right');
        expect(computeInsertionSide(items, 'a', 'b')).toBe('right');
    });

    it('active 在 over 之后 → left（落在 over 左缘）', () => {
        expect(computeInsertionSide(items, 'c', 'a')).toBe('left');
        expect(computeInsertionSide(items, 'b', 'a')).toBe('left');
    });

    it('任一 id 缺失（含跨道：active 不在 over 所在道）→ left 默认', () => {
        expect(computeInsertionSide(items, 'ghost', 'a')).toBe('left');
        expect(computeInsertionSide(items, 'a', 'ghost')).toBe('left');
        expect(computeInsertionSide(null, 'a', 'b')).toBe('left');
        expect(computeInsertionSide(undefined, 'a', 'b')).toBe('left');
    });

    it('self-over → null（清除插入线）', () => {
        expect(computeInsertionSide(items, 'a', 'a')).toBeNull();
    });
});
