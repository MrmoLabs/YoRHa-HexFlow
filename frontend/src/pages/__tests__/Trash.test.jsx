// R6-2（PLAN §8.44）：回收站页 —— 列条目 / 恢复 / 彻底删除确认 / 空态与错态 /
// 口径面板（唯一键占用、指针不回填）。
// 本仓未装 @testing-library/jest-dom → 只用裸断言（存在 = toBeTruthy / getBy* 自身抛错）。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Trash from '../Trash';
import { api } from '../../api';

vi.mock('../../api', () => ({
    api: {
        listTrash: vi.fn(),
        restoreTrashItem: vi.fn(),
        purgeTrashItem: vi.fn()
    }
}));

const ITEM = {
    kind: 'sequence',
    id: 'seq-1',
    label: '冒烟序列',
    deleted_at: '2026-10-02T09:15:00.123456+00:00'
};

const PURGE_ITEM = {
    kind: 'response_spec',
    id: 'rs-1',
    label: '指令 X 的应答规格',
    deleted_at: '2026-10-01T23:59:59.000001+00:00'
};

describe('回收站页 Trash', () => {
    beforeEach(() => {
        api.listTrash.mockResolvedValue({ items: [ITEM], count: 1 });
        api.restoreTrashItem.mockResolvedValue({ status: 'restored', kind: 'sequence', id: 'seq-1', related: { steps: 2 } });
        api.purgeTrashItem.mockResolvedValue({ status: 'purged', kind: 'sequence', id: 'seq-1', related: { steps: 2 } });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('列条目：类型中文 + 名称 + 秒级删除时间 + 条目计数', async () => {
        render(<Trash />);
        expect(await screen.findByText('冒烟序列')).toBeTruthy();
        expect(screen.getByText('序列')).toBeTruthy();
        expect(screen.getByText('2026-10-02 09:15:00 UTC')).toBeTruthy();
        expect(screen.getByText(/回收站条目 \(TRASH ITEMS\) · 1/)).toBeTruthy();
        expect(api.listTrash).toHaveBeenCalledTimes(1);
    });

    it('kind 白名单中文映射（response_spec → 应答规格）', async () => {
        api.listTrash.mockResolvedValue({ items: [PURGE_ITEM], count: 1 });
        render(<Trash />);
        expect(await screen.findByText('应答规格')).toBeTruthy();
        expect(screen.getByText('指令 X 的应答规格')).toBeTruthy();
    });

    it('空态：明确写「回收站为空」并说明误删可来此找回', async () => {
        api.listTrash.mockResolvedValue({ items: [], count: 0 });
        render(<Trash />);
        expect(await screen.findByText(/回收站为空 \(TRASH EMPTY\)/)).toBeTruthy();
        expect(screen.getByText(/误删时可在此找回/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /恢复 RESTORE/ })).toBeNull();
    });

    it('读取失败 → ERR 行，点重试重拉一次', async () => {
        api.listTrash.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce({ items: [], count: 0 });
        render(<Trash />);

        expect(await screen.findByText(/ERR: 500/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /重试 \(RETRY\)/ }));
        await waitFor(() => expect(api.listTrash).toHaveBeenCalledTimes(2));
        expect(await screen.findByText(/回收站为空 \(TRASH EMPTY\)/)).toBeTruthy();
    });

    it('恢复：调 POST {kind,id} → 回拉列表，状态条回显级联条数', async () => {
        render(<Trash />);
        fireEvent.click(await screen.findByRole('button', { name: '恢复 RESTORE' }));

        await waitFor(() => expect(api.restoreTrashItem).toHaveBeenCalledWith('sequence', 'seq-1'));
        expect(api.purgeTrashItem).not.toHaveBeenCalled();
        // 成功后重拉一次列表
        await waitFor(() => expect(api.listTrash).toHaveBeenCalledTimes(2));
        expect(await screen.findByText(/已恢复序列「冒烟序列」/)).toBeTruthy();
        expect(screen.getByText(/（级联 2 条）/)).toBeTruthy();
    });

    it('恢复失败：detail 原文进状态条，条目仍在列表', async () => {
        api.restoreTrashItem.mockRejectedValue(new Error('该条目不在回收站'));
        render(<Trash />);
        fireEvent.click(await screen.findByRole('button', { name: '恢复 RESTORE' }));

        expect(await screen.findByText(/恢复失败：该条目不在回收站/)).toBeTruthy();
        expect(await screen.findByText('冒烟序列')).toBeTruthy();
        expect(api.listTrash).toHaveBeenCalledTimes(1); // 失败不重拉
    });

    it('彻底删除必须过弹窗：取消不调，确认才 DELETE', async () => {
        render(<Trash />);
        fireEvent.click(await screen.findByRole('button', { name: '彻底删除 PURGE' }));

        // 弹窗先出来，且明说不可恢复 + 提示改点「恢复」
        expect(await screen.findByText(/确认彻底删除序列「冒烟序列」？/)).toBeTruthy();
        expect(screen.getByText(/此操作不可恢复/)).toBeTruthy();
        expect(screen.getByText(/应改点「恢复」/)).toBeTruthy();
        expect(api.purgeTrashItem).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /取消 \(CANCEL\)/ }));
        await waitFor(() => expect(screen.queryByText(/确认彻底删除/)).toBeNull());
        expect(api.purgeTrashItem).not.toHaveBeenCalled();

        // 再开 → 确认才执行
        fireEvent.click(screen.getByRole('button', { name: '彻底删除 PURGE' }));
        await screen.findByText(/确认彻底删除序列「冒烟序列」？/);
        fireEvent.click(screen.getByRole('button', { name: /确认 \(CONFIRM\)/ }));
        await waitFor(() => expect(api.purgeTrashItem).toHaveBeenCalledWith('sequence', 'seq-1'));
        expect(await screen.findByText(/已彻底删除序列「冒烟序列」/)).toBeTruthy();
        expect(api.restoreTrashItem).not.toHaveBeenCalled();
    });

    // ── R13 · 类型筛选 + 批量（PLAN §8.49）────────────────────────────────────
    // 行集合直接问复选框 —— aria-label = `选择 <类型>「<名称>」`
    const rowLabels = () => [...document.querySelectorAll('input[type="checkbox"][aria-label^="选择 "]')]
        .map((el) => el.getAttribute('aria-label'));

    const mkItem = (kind, id, label) => ({
        kind, id, label, deleted_at: '2026-10-02T09:15:00.123456+00:00'
    });

    it('R13 类型筛选：chips 带计数，点类型只留该类型行；切回「全部」行序不变', async () => {
        api.listTrash.mockResolvedValue({
            items: [
                mkItem('instruction', 'i-1', '指令甲'),
                mkItem('sequence', 'seq-1', '冒烟序列'),
                mkItem('instruction', 'i-2', '指令乙'),
                mkItem('profile', 'p-1', '档案甲')
            ],
            count: 4
        });
        render(<Trash />);
        await screen.findByText('冒烟序列');

        // 计数与 chips 同源（items 派生，不另打接口）
        const allChip = screen.getByRole('button', { name: /^全部 4$/ });
        expect(screen.getByRole('button', { name: /^指令 2$/ })).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: /^指令 2$/ }));
        expect(rowLabels()).toEqual(['选择 指令「指令甲」', '选择 指令「指令乙」']);
        // 筛选只切可见行、不重排 —— 子集内仍是后端「最近删的在前」
        expect(screen.getByRole('button', { name: /^指令 2$/ }).getAttribute('aria-pressed')).toBe('true');

        fireEvent.click(allChip);
        expect(rowLabels()).toHaveLength(4);
        expect(rowLabels()[0]).toBe('选择 指令「指令甲」');
        expect(rowLabels()[3]).toBe('选择 档案「档案甲」');
    });

    it('R13 批量恢复：勾两行 → 逐条 POST、回执报成功 N / M、选择清空', async () => {
        api.listTrash.mockResolvedValue({ items: [ITEM, PURGE_ITEM], count: 2 });
        api.restoreTrashItem
            .mockResolvedValueOnce({ status: 'restored', kind: 'sequence', id: 'seq-1', related: {} })
            .mockResolvedValueOnce({ status: 'restored', kind: 'response_spec', id: 'rs-1', related: {} });
        render(<Trash />);
        await screen.findByText('冒烟序列');

        const boxes = screen.getAllByLabelText(/^选择 /);
        expect(boxes).toHaveLength(2);
        fireEvent.click(boxes[0]);
        fireEvent.click(boxes[1]);
        expect(screen.getByText('已选 2 条')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: /^批量恢复 \(2\)$/ }));
        await waitFor(() => expect(api.restoreTrashItem).toHaveBeenCalledTimes(2));
        expect(api.restoreTrashItem.mock.calls).toEqual([['sequence', 'seq-1'], ['response_spec', 'rs-1']]);
        expect(api.purgeTrashItem).not.toHaveBeenCalled();
        // 逐条回报：成功 N / M（失败明细另一条用例覆盖）
        expect(await screen.findByText(/批量恢复：成功 2 \/ 2 条/)).toBeTruthy();
        // 选择清空 → 两个批量按钮回到禁用态
        await waitFor(() => expect(screen.getByRole('button', { name: /^批量恢复 \(0\)$/ }).disabled).toBe(true));
        expect(screen.getByRole('button', { name: /^批量彻底删除 \(0\)$/ }).disabled).toBe(true);
    });

    it('R13 批量彻底删除：过弹窗（取消零调用），确认后逐条执行、失败逐条报出', async () => {
        api.listTrash.mockResolvedValue({ items: [ITEM, PURGE_ITEM], count: 2 });
        api.purgeTrashItem
            .mockResolvedValueOnce({ status: 'purged', kind: 'sequence', id: 'seq-1', related: {} })
            .mockRejectedValueOnce(new Error('被引用中，拒绝彻底删除'));
        render(<Trash />);
        await screen.findByText('冒烟序列');

        const boxes = screen.getAllByLabelText(/^选择 /);
        fireEvent.click(boxes[0]);
        fireEvent.click(boxes[1]);
        fireEvent.click(screen.getByRole('button', { name: /^批量彻底删除 \(2\)$/ }));

        // 弹窗先出：把名单摆出来 + 明说半成口径
        expect(await screen.findByText(/确认彻底删除所选 2 条？/)).toBeTruthy();
        expect(screen.getByText(/· 序列「冒烟序列」/)).toBeTruthy();
        expect(screen.getByText(/半成如实回报/)).toBeTruthy();
        expect(api.purgeTrashItem).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /取消 \(CANCEL\)/ }));
        await waitFor(() => expect(screen.queryByText(/确认彻底删除所选/)).toBeNull());
        expect(api.purgeTrashItem).not.toHaveBeenCalled();

        // 再开 → 确认才执行
        fireEvent.click(screen.getByRole('button', { name: /^批量彻底删除 \(2\)$/ }));
        await screen.findByText(/确认彻底删除所选 2 条？/);
        fireEvent.click(screen.getByRole('button', { name: /确认 \(CONFIRM\)/ }));

        await waitFor(() => expect(api.purgeTrashItem).toHaveBeenCalledTimes(2));
        expect(api.purgeTrashItem.mock.calls).toEqual([['sequence', 'seq-1'], ['response_spec', 'rs-1']]);
        // 半成不静默：成功 N / M + 失败明细逐条列出
        expect(await screen.findByText(/批量彻底删除：成功 1 \/ 2 条/)).toBeTruthy();
        expect(await screen.findByText(/被引用中，拒绝彻底删除/)).toBeTruthy();
        expect(api.restoreTrashItem).not.toHaveBeenCalled();
    });

    it('口径面板常驻：唯一键占用 / 指针不回填 / 日志仍是硬删', async () => {
        render(<Trash />);
        await screen.findByText(/回收站条目/);

        expect(screen.getByText(/仍占用名称/)).toBeTruthy();
        expect(screen.getByText(/同名序列 \/ 档案的新建与改名会被 400 拒绝/)).toBeTruthy();
        expect(screen.getByText(/需重新指定、重新激活/)).toBeTruthy();
        expect(screen.getByText(/通讯日志清空仍是硬删，不进本页/)).toBeTruthy();
    });
});
