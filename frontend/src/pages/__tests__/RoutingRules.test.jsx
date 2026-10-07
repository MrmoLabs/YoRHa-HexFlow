// R38（PLAN §8.70）：发前路由规则页 —— 列表即匹配顺序（first-match-wins 的
// 唯一可视化）、表单就地校验（不送后端吃 400）、启停 / 删除确认、
// **排序只改草稿、点保存顺序才回写真变化的行**。
//
// 本仓未装 @testing-library/jest-dom → 只用裸断言（存在 = toBeTruthy /
// getBy* 自身抛错）。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import RoutingRules from '../RoutingRules';
import { api } from '../../api';

vi.mock('../../api', () => ({
    api: {
        listRoutingRules: vi.fn(),
        createRoutingRule: vi.fn(),
        updateRoutingRule: vi.fn(),
        deleteRoutingRule: vi.fn(),
    }
}));

const INSTRUCTIONS = [
    { id: 'i-1', name: '执行 X', code: 'CMD_X' },
    { id: 'i-2', name: '执行 Y', code: 'CMD_Y' },
];

const RULE_A = {
    id: 'r-1',
    name: 'meter 0001',
    condition: 'meter_id == 0001',
    instruction_id: 'i-1',
    sort_order: 0,
    enabled: 1,
    description: null,
};
const RULE_B = {
    id: 'r-2',
    name: 'meter 0002',
    condition: 'meter_id == 0002',
    instruction_id: 'i-2',
    sort_order: 1,
    enabled: 0,
    description: null,
};
const RULE_C = {
    id: 'r-3',
    name: 'meter 0003',
    condition: 'meter_id == 0003',
    instruction_id: 'i-1',
    sort_order: 2,
    enabled: 1,
    description: null,
};

const renderPage = async (rules = [RULE_A, RULE_B]) => {
    api.listRoutingRules.mockResolvedValue(rules);
    render(<RoutingRules instructions={INSTRUCTIONS} />);
    // 等恒存在的表头计数（不能等某一行 —— 空态列表里没有行）
    await screen.findByText(new RegExp(`发前路由规则 \\(ROUTING RULES\\) · ${rules.length} 条`));
};

const fillValidNewRule = () => {
    fireEvent.click(screen.getByRole('button', { name: /新建 NEW/ }));
    fireEvent.change(screen.getByLabelText('规则名称 NAME'), { target: { value: 'meter 0003' } });
    fireEvent.change(screen.getByLabelText('命中条件 CONDITION'), { target: { value: 'meter_id == 0003' } });
    fireEvent.change(screen.getByLabelText('目标指令 TARGET'), { target: { value: 'i-1' } });
};

describe('发前路由规则页 RoutingRules', () => {
    beforeEach(() => {
        api.listRoutingRules.mockResolvedValue([RULE_A, RULE_B]);
        api.createRoutingRule.mockResolvedValue(RULE_C);
        api.updateRoutingRule.mockResolvedValue(RULE_A);
        api.deleteRoutingRule.mockResolvedValue({ status: 'deleted', id: 'r-1' });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('列条目按后端返回序出 #1/#2 + 名称 + 条件 + 目标指令名 + 启停章', async () => {
        await renderPage();

        expect(screen.getByText(/发前路由规则 \(ROUTING RULES\) · 2 条/)).toBeTruthy();
        expect(screen.getByText('#1')).toBeTruthy();
        expect(screen.getByText('#2')).toBeTruthy();
        expect(screen.getByText('meter 0002')).toBeTruthy();
        expect(screen.getByText('COND :: meter_id == 0001')).toBeTruthy();
        expect(screen.getByText('执行 Y')).toBeTruthy();
        expect(screen.getByLabelText('切换启停 meter 0001').textContent).toContain('ON');
        expect(screen.getByLabelText('切换启停 meter 0002').textContent).toContain('OFF');
        expect(api.listRoutingRules).toHaveBeenCalledTimes(1);
    });

    it('空态：写明暂无规则并给新建出口', async () => {
        await renderPage([]);
        expect(await screen.findByText(/暂无发前路由规则 \(NO RULES\)/)).toBeTruthy();
        expect(screen.queryByLabelText('上移 meter 0001')).toBeNull();
        expect(screen.getByRole('button', { name: /新建 NEW/ })).toBeTruthy();
    });

    it('读取失败 → ERR 行，点重试重拉一次', async () => {
        api.listRoutingRules
            .mockRejectedValueOnce(new Error('500'))
            .mockResolvedValueOnce([]);
        render(<RoutingRules instructions={INSTRUCTIONS} />);

        expect(await screen.findByText(/ERR:/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /重试 RETRY/ }));
        expect(api.listRoutingRules).toHaveBeenCalledTimes(2);
        expect(await screen.findByText(/暂无发前路由规则 \(NO RULES\)/)).toBeTruthy();
    });

    it('新建：名称为空就地拦下 —— 出红字且不发请求', async () => {
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: /新建 NEW/ }));
        fireEvent.click(screen.getByRole('button', { name: /^保存 SAVE$/ }));

        expect(await screen.findByText(/名称不能为空/)).toBeTruthy();
        expect(api.createRoutingRule).not.toHaveBeenCalled();
    });

    it('新建：条件语法坏就地红字（同一套 condition SSOT），不送后端吃 400', async () => {
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: /新建 NEW/ }));
        fireEvent.change(screen.getByLabelText('规则名称 NAME'), { target: { value: 'r-x' } });
        fireEvent.change(screen.getByLabelText('命中条件 CONDITION'), { target: { value: 'meter_id' } });
        fireEvent.change(screen.getByLabelText('目标指令 TARGET'), { target: { value: 'i-1' } });
        fireEvent.click(screen.getByRole('button', { name: /^保存 SAVE$/ }));

        expect(await screen.findByText(/缺少比较运算符/)).toBeTruthy();
        expect(api.createRoutingRule).not.toHaveBeenCalled();
    });

    it('新建：目标指令未选 → 就地红字', async () => {
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: /新建 NEW/ }));
        fireEvent.change(screen.getByLabelText('规则名称 NAME'), { target: { value: 'r-x' } });
        fireEvent.change(screen.getByLabelText('命中条件 CONDITION'), { target: { value: 'meter_id == 1' } });
        fireEvent.click(screen.getByRole('button', { name: /^保存 SAVE$/ }));

        expect(await screen.findByText(/请选择.*指令/)).toBeTruthy();
        expect(api.createRoutingRule).not.toHaveBeenCalled();
    });

    it('新建成功 → 带完整载荷落 POST，状态条回执并重拉列表', async () => {
        // 第 1 次拉 = 现状两条，保存后重拉 = 带上新建那条
        api.listRoutingRules
            .mockResolvedValueOnce([RULE_A, RULE_B])
            .mockResolvedValueOnce([RULE_A, RULE_B, RULE_C]);
        await renderPage();
        fillValidNewRule();
        fireEvent.click(screen.getByRole('button', { name: /^保存 SAVE$/ }));

        await waitFor(() => expect(api.createRoutingRule).toHaveBeenCalledTimes(1));
        expect(api.createRoutingRule).toHaveBeenCalledWith({
            name: 'meter 0003',
            condition: 'meter_id == 0003',
            instruction_id: 'i-1',
            // 新建落末尾：存量 max(sort_order) = 1（r-2）→ 末位 +1 = 2
            sort_order: 2,
            enabled: 1,
            description: null,
        });
        expect(await screen.findByText(/已保存规则「meter 0003」/)).toBeTruthy();
        expect(await screen.findByText('meter 0003')).toBeTruthy();
    });

    it('启停 chip → PUT 同一行 enabled 翻面，本地章同步', async () => {
        await renderPage();
        fireEvent.click(screen.getByLabelText('切换启停 meter 0001'));

        await waitFor(() => expect(api.updateRoutingRule).toHaveBeenCalledTimes(1));
        expect(api.updateRoutingRule).toHaveBeenCalledWith('r-1', {
            name: 'meter 0001',
            condition: 'meter_id == 0001',
            instruction_id: 'i-1',
            sort_order: 0,
            enabled: 0,
            description: null,
        });
        expect(screen.getByLabelText('切换启停 meter 0001').textContent).toContain('OFF');
    });

    it('删除需二次确认：取消零调用，确认才 DELETE 并出回收站提示', async () => {
        await renderPage();
        fireEvent.click(screen.getByLabelText('删除 meter 0001'));
        expect(screen.getByText(/删除路由规则「meter 0001」/)).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: /取消 \(CANCEL\)/ }));
        expect(api.deleteRoutingRule).not.toHaveBeenCalled();

        fireEvent.click(screen.getByLabelText('删除 meter 0001'));
        fireEvent.click(await screen.findByRole('button', { name: /确认 \(CONFIRM\)/ }));
        await waitFor(() => expect(api.deleteRoutingRule).toHaveBeenCalledWith('r-1'));
        expect(await screen.findByText(/回收站/)).toBeTruthy();
    });

    it('下移只改草稿（零请求）→ 出顺序脏计数；点保存顺序才逐行 PUT 真变化的行', async () => {
        await renderPage();

        fireEvent.click(screen.getByLabelText('下移 meter 0001'));
        expect(api.updateRoutingRule).not.toHaveBeenCalled();
        // 换位 = **两行**的 sort_order 都变（不是「挪了几行」而是「几行要写」）
        // R40 起「…条顺序待保存」这句在两处出现（顺序条 + 试解析按已落库顺序算的
        // 黄条），故此处收窄到顺序条原文（`● N 条顺序待保存`），不再宽松匹配。
        expect(await screen.findByText(/^● 2 条顺序待保存$/)).toBeTruthy();
        // 草稿序立刻跟上：meter 0002 已排到最前（展示序 = 匹配序，不等落库）
        expect(screen.getAllByText(/meter 000[12]$/).map((n) => n.textContent))
            .toEqual(['meter 0002', 'meter 0001']);

        fireEvent.click(screen.getByRole('button', { name: /保存顺序 SAVE ORDER/ }));
        await waitFor(() => expect(api.updateRoutingRule).toHaveBeenCalledTimes(2));
        expect(api.updateRoutingRule).toHaveBeenCalledWith('r-1', expect.objectContaining({ sort_order: 1 }));
        expect(api.updateRoutingRule).toHaveBeenCalledWith('r-2', expect.objectContaining({ sort_order: 0 }));
        expect(await screen.findByText(/顺序已保存/)).toBeTruthy();
        expect(screen.queryByText(/条顺序待保存/)).toBeNull();
    });

    it('后端 400 判重 detail 兜底透出（FE 只拦得到活行，回收站占名靠它）', async () => {
        api.createRoutingRule.mockRejectedValueOnce(new Error('Routing rule name already exists'));
        await renderPage();
        fillValidNewRule();
        fireEvent.click(screen.getByRole('button', { name: /^保存 SAVE$/ }));

        expect(await screen.findByText(/名称已存在/)).toBeTruthy();
        expect(screen.getByText(/回收站/)).toBeTruthy();
    });
});
