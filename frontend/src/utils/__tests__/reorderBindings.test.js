import { describe, it, expect } from 'vitest';
import { moveBindingToIndex, reorderBindingsWithinGroup } from '../reorderBindings';

// R4 · 编排页组内换位（PLAN §8.41）—— 拖拽与洞位下拉共用的纯实现。
// 三条口径：① 组 = 同 protocolId；② 跨组不猜、返回 null；③ 结果稠密重编号且
// 只回写真变化的行。

const mk = (id, protocolId, slotOrder) => ({ id, protocolId, slotOrder });

// 按**新展示序**核对：组内按重编号后的 slotOrder，组外（别的协议）原样接在后面
const take = (result, bindings) => [
    ...result.reordered,
    ...bindings.filter((b) => !result.byId.has(b.id))
];

describe('utils/reorderBindings · moveBindingToIndex（洞位下拉路径）', () => {
    it('组内换位 → 稠密重编号 0..n-1，且不动别的协议', () => {
        const bindings = [
            mk('a', 'p1', 0), mk('b', 'p1', 1), mk('c', 'p1', 2),
            mk('x', 'p2', 0)
        ];
        const r = moveBindingToIndex(bindings, 'c', 0);
        expect(take(r, bindings)).toEqual([
            mk('c', 'p1', 0), mk('a', 'p1', 1), mk('b', 'p1', 2),
            mk('x', 'p2', 0)
        ]);
    });

    it('目标位次越界钳在 0..组内余数（原下拉口径）', () => {
        const bindings = [mk('a', 'p1', 0), mk('b', 'p1', 1), mk('c', 'p1', 2)];
        const at0 = moveBindingToIndex(bindings, 'c', -5);
        expect(at0.reordered.map((b) => b.id)).toEqual(['c', 'a', 'b']);
        const atEnd = moveBindingToIndex(bindings, 'a', 99);
        expect(atEnd.reordered.map((b) => b.id)).toEqual(['b', 'c', 'a']);
    });

    it('原地不动 → changedIds 为空（不标脏、不进 PUT 队列）', () => {
        const bindings = [mk('a', 'p1', 0), mk('b', 'p1', 1)];
        const r = moveBindingToIndex(bindings, 'a', 0);
        expect(r.changedIds).toEqual([]);
        expect(r.reordered.map((b) => b.slotOrder)).toEqual([0, 1]);
    });

    it('只回写真变化的行（后位未受影响的行不标脏）', () => {
        const bindings = [mk('a', 'p1', 0), mk('b', 'p1', 1), mk('c', 'p1', 2)];
        // b 移到首位 → a/b 变、c 仍是 2
        const r = moveBindingToIndex(bindings, 'b', 0);
        expect(r.changedIds.sort()).toEqual(['a', 'b']);
        expect(take(r, bindings).map((b) => `${b.id}:${b.slotOrder}`))
            .toEqual(['b:0', 'a:1', 'c:2']);
    });

    it('缺行 / 非法目标位次 → null 或退化到末位，不抛', () => {
        expect(moveBindingToIndex([mk('a', 'p1', 0)], 'nope', 0)).toBeNull();
        const r = moveBindingToIndex([mk('a', 'p1', 0), mk('b', 'p1', 1)], 'a', 'oops');
        expect(r.reordered.map((b) => b.id)).toEqual(['b', 'a']);
        expect(r.changedIds.sort()).toEqual(['a', 'b']);
    });

    it('slotOrder 缺省按 0 处理（本地新建行）', () => {
        const bindings = [{ id: 'a', protocolId: 'p1' }, mk('b', 'p1', 1)];
        const r = moveBindingToIndex(bindings, 'b', 0);
        expect(r.reordered.map((b) => `${b.id}:${b.slotOrder}`)).toEqual(['b:0', 'a:1']);
    });
});

describe('utils/reorderBindings · reorderBindingsWithinGroup（拖拽路径）', () => {
    it('拖到同组 over 行 → 落在 over 原位（序翻转 + 稠密重编号）', () => {
        const bindings = [mk('a', 'p1', 0), mk('b', 'p1', 1)];
        const r = reorderBindingsWithinGroup(bindings, 'b', 'a');
        expect(take(r, bindings)).toEqual([mk('b', 'p1', 0), mk('a', 'p1', 1)]);
        expect(r.changedIds.sort()).toEqual(['a', 'b']);
    });

    it('中间项前移到首位：只牵连前两行，第 3 行位次不变', () => {
        const bindings = [mk('a', 'p1', 0), mk('b', 'p1', 1), mk('c', 'p1', 2)];
        const r = reorderBindingsWithinGroup(bindings, 'b', 'a');
        expect(r.changedIds.sort()).toEqual(['a', 'b']);
        expect(take(r, bindings).map((b) => `${b.id}:${b.slotOrder}`))
            .toEqual(['b:0', 'a:1', 'c:2']);
    });

    it('**跨协议组拖拽直接忽略**（返回 null，不猜要不要顺带换协议）', () => {
        const bindings = [mk('a', 'p1', 0), mk('b', 'p2', 0)];
        expect(reorderBindingsWithinGroup(bindings, 'b', 'a')).toBeNull();
        expect(reorderBindingsWithinGroup(bindings, 'a', 'b')).toBeNull();
    });

    it('同 id / 缺行 / 缺 over → null', () => {
        const bindings = [mk('a', 'p1', 0), mk('b', 'p1', 1)];
        expect(reorderBindingsWithinGroup(bindings, 'a', 'a')).toBeNull();
        expect(reorderBindingsWithinGroup(bindings, 'ghost', 'a')).toBeNull();
        expect(reorderBindingsWithinGroup(bindings, 'a', 'ghost')).toBeNull();
        expect(reorderBindingsWithinGroup(bindings, 'a', null)).toBeNull();
    });

    it('跨组过滤后 over 不在组内 → null（防御：同协议号但被过滤过）', () => {
        const bindings = [mk('a', 'p1', 0)];
        expect(reorderBindingsWithinGroup(bindings, 'a', 'a')).toBeNull();
    });
});
