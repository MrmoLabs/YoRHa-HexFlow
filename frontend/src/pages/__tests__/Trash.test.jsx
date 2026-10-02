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

    it('口径面板常驻：唯一键占用 / 指针不回填 / 日志仍是硬删', async () => {
        render(<Trash />);
        await screen.findByText(/回收站条目/);

        expect(screen.getByText(/仍占用名称/)).toBeTruthy();
        expect(screen.getByText(/同名序列 \/ 档案的新建与改名会被 400 拒绝/)).toBeTruthy();
        expect(screen.getByText(/需重新指定、重新激活/)).toBeTruthy();
        expect(screen.getByText(/通讯日志清空仍是硬删，不进本页/)).toBeTruthy();
    });
});
