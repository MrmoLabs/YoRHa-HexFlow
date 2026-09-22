import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHistory } from '../useHistory';

// C1-a: P4-1 undo/redo 栈契约 — push/undo/redo 互换、clear、上限、新 push 清 redo。
describe('useHistory (P4-1 撤销/重做栈)', () => {
    it('初始 canUndo/canRedo 皆 false；push 后 canUndo true', () => {
        const { result } = renderHook(() => useHistory());
        expect(result.current.canUndo).toBe(false);
        expect(result.current.canRedo).toBe(false);

        act(() => result.current.push({ id: 'A' }));
        expect(result.current.canUndo).toBe(true);
        expect(result.current.canRedo).toBe(false);
    });

    it('undo ↔ redo 互换：undo 返回旧快照并把当前压入 redo，redo 反向', () => {
        const { result } = renderHook(() => useHistory());
        act(() => result.current.push({ id: 'A' }));

        let undone;
        act(() => { undone = result.current.undo({ id: 'live' }); });
        expect(undone).toEqual({ id: 'A' });
        expect(result.current.canUndo).toBe(false);
        expect(result.current.canRedo).toBe(true);

        let redone;
        act(() => { redone = result.current.redo({ id: 'A' }); });
        expect(redone).toEqual({ id: 'live' });
        expect(result.current.canUndo).toBe(true);
        expect(result.current.canRedo).toBe(false);
    });

    it('空栈 undo/redo 返回 null（不产生任何状态变化）', () => {
        const { result } = renderHook(() => useHistory());
        let v;
        act(() => { v = result.current.undo({ id: 'live' }); });
        expect(v).toBeNull();
        act(() => { v = result.current.redo({ id: 'live' }); });
        expect(v).toBeNull();
        expect(result.current.canUndo).toBe(false);
        expect(result.current.canRedo).toBe(false);
    });

    it('新 push 清空 redo 分支（线性历史）', () => {
        const { result } = renderHook(() => useHistory());
        act(() => result.current.push({ id: 'A' }));
        act(() => result.current.undo({ id: 'live' }));
        expect(result.current.canRedo).toBe(true);

        act(() => result.current.push({ id: 'B' }));
        expect(result.current.canRedo).toBe(false);
        expect(result.current.canUndo).toBe(true);
    });

    it('clear 同时清空两栈（切指令/保存/重载场景）', () => {
        const { result } = renderHook(() => useHistory());
        act(() => result.current.push({ id: 'A' }));
        act(() => result.current.undo({ id: 'live' }));
        expect(result.current.canRedo).toBe(true);

        act(() => result.current.clear());
        expect(result.current.canUndo).toBe(false);
        expect(result.current.canRedo).toBe(false);
    });

    it('上限 50：push 55 只留最新 50（第 51 次 undo 为 null）', () => {
        const { result } = renderHook(() => useHistory());
        act(() => {
            for (let i = 1; i <= 55; i++) result.current.push({ id: `E${i}` });
        });

        let count = 0;
        act(() => {
            let v = result.current.undo({ id: 'live' });
            while (v) {
                count += 1;
                v = result.current.undo({ id: 'live' });
            }
        });
        expect(count).toBe(50);
    });

    it('push(null/undefined) 被忽略（脏检查入口防御）', () => {
        const { result } = renderHook(() => useHistory());
        act(() => result.current.push(null));
        act(() => result.current.push(undefined));
        expect(result.current.canUndo).toBe(false);
    });
});
