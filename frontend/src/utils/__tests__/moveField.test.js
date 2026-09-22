import { describe, it, expect } from 'vitest';
import { moveField } from '../moveField';

// C1-d: Instruction.jsx onMoveItem splice 逻辑的纯函数契约。
const f = (id, parent_id, sequence) => ({
    id, parent_id, sequence, name: id, op_code: 'HEX_RAW', byte_len: 1,
});

describe('moveField (卡片移动 / 车道重排)', () => {
    it('同道换序：重插到目标位 + 同道 sequence 连续重排，原数组不被改', () => {
        const fields = [f('a', null, 0), f('b', null, 1), f('c', null, 2)];
        const out = moveField(fields, 'c', null, 0);

        expect(out.map((x) => x.id)).toEqual(['c', 'a', 'b']);
        expect(out.map((x) => x.sequence)).toEqual([0, 1, 2]);
        expect(fields.map((x) => x.id)).toEqual(['a', 'b', 'c']); // 输入未变异
    });

    it('换 parent：字段迁入目标组，parent_id 跟随 + 目标道重排；源道余者不动', () => {
        const fields = [
            f('a', null, 0), f('b', null, 1), f('g', null, 0),
            f('k1', 'g', 0), f('k2', 'g', 1),
        ];
        const out = moveField(fields, 'b', 'g', 1);

        const moved = out.find((x) => x.id === 'b');
        expect(moved.parent_id).toBe('g');
        expect(moved.sequence).toBe(1);

        const kids = out.filter((x) => x.parent_id === 'g');
        expect(kids.map((x) => x.id)).toEqual(['k1', 'b', 'k2']);
        expect(kids.map((x) => x.sequence)).toEqual([0, 1, 2]);

        expect(out.find((x) => x.id === 'a')).toMatchObject({ parent_id: null, sequence: 0 });
        expect(out.find((x) => x.id === 'g')).toMatchObject({ parent_id: null, sequence: 0 });
    });

    it('目标道按 sequence 排序后定位（乱序道也按显示序插入）', () => {
        const fields = [f('a', null, 5), f('b', null, 1), f('c', null, 3)];
        const out = moveField(fields, 'a', null, 0);
        // siblings 排序 → [b(1), c(3)]；a 插到 0 → [a, b, c]
        expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c']);
        expect(out.map((x) => x.sequence)).toEqual([0, 1, 2]);
    });

    it('源字段缺失 → 返回同一引用（页面据此跳过 updateLocalInstruction）', () => {
        const fields = [f('a', null, 0)];
        expect(moveField(fields, 'ghost', null, 0)).toBe(fields);
    });

    it('非数组输入防御：原样返回', () => {
        expect(moveField(undefined, 'a', null, 0)).toBeUndefined();
        expect(moveField(null, 'a', null, 0)).toBeNull();
    });
});
