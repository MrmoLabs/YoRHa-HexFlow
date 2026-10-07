// R40（PLAN §8.72）：规则页「试解析 (DRY RUN)」入口 —— 规则作者写完一条规则
// 后，就地给一组输入看**会命中哪条、扫了几条、哪些规则有结构性缺陷**。
//
// 三条页面级口径（与后端 resolve_route 逐字对齐，FE 只呈现不改判）：
//  ① **按已保存的规则计算**：表单与顺序的未保存改动不参与 —— 后端只看得见已落库
//     的行；顺序有草稿时当场写出「N 条顺序待保存」，不让人对着旧顺序的结果推新顺序；
//  ② **只回显不改状态**：试解析不选中任何规则、不动表单、不动顺序，文案里也不出现
//     「已切换」这类话（加工页 R39 才有切换动作）；
//  ③ **输入表与加工页同一份实现**：utils/routeResolve 的 toInputsMap（键去空白、
//     空键不发、值按 JSON 标量解析）+ 共用组件 RouteInputTable。
//
// 本仓未装 @testing-library/jest-dom → 只用裸断言。
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
        resolveRoute: vi.fn(),   // R40：试解析
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

const HIT = {
    matched: true,
    rule: { id: 'r-1', name: 'meter 0001', condition: 'meter_id == 0001' },
    instruction_id: 'i-1',
    instruction: { id: 'i-1', name: '执行 X' },
    invalid: [],
    considered: 1,
};
const MISS = {
    matched: false,
    rule: null,
    instruction_id: null,
    instruction: null,
    invalid: [],
    considered: 2,
};

const renderPage = async (rules = [RULE_A, RULE_B]) => {
    api.listRoutingRules.mockResolvedValue(rules);
    render(<RoutingRules instructions={INSTRUCTIONS} />);
    await screen.findByText(new RegExp(`发前路由规则 \\(ROUTING RULES\\) · ${rules.length} 条`));
};

const fillInputs = (key, value) => {
    fireEvent.change(screen.getByLabelText('试解析键 1'), { target: { value: key } });
    fireEvent.change(screen.getByLabelText('试解析值 1'), { target: { value } });
};

const runDry = () => fireEvent.click(screen.getByRole('button', { name: '试解析 DRY RUN' }));

describe('R40 规则页试解析（§8.72）', () => {
    beforeEach(() => {
        api.listRoutingRules.mockResolvedValue([RULE_A, RULE_B]);
        api.createRoutingRule.mockResolvedValue(null);
        api.updateRoutingRule.mockResolvedValue(RULE_A);
        api.deleteRoutingRule.mockResolvedValue({ status: 'deleted', id: 'r-1' });
        api.resolveRoute.mockResolvedValue(HIT);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('面板常驻：标题 + 按已保存规则计算的口径行 + 空输入表 + ADD 按钮', async () => {
        await renderPage();

        expect(screen.getByText('试解析 (DRY RUN)')).toBeTruthy();
        expect(screen.getByText(/按已保存的规则计算/)).toBeTruthy();
        expect(screen.getByText(/0 项有效/)).toBeTruthy();
        expect(screen.getByLabelText('试解析键 1')).toBeTruthy();
        expect(screen.getByLabelText('试解析值 1')).toBeTruthy();
        expect(screen.getByRole('button', { name: '+ 添加 ADD' })).toBeTruthy();
        expect(screen.getByRole('button', { name: '试解析 DRY RUN' })).toBeTruthy();
        // 尚未跑过 → 不出结果行（不假装有结果）
        expect(screen.queryByText(/^SYS:/)).toBeNull();
        expect(screen.queryByText(/^ERR:/)).toBeNull();
    });

    it('填键值点试解析 → 送 JSON 标量（0001 → 数字）→ 出命中 headline 与四行结果表', async () => {
        await renderPage();
        fillInputs(' meter_id ', ' 0001 ');
        runDry();

        await waitFor(() => expect(api.resolveRoute).toHaveBeenCalledTimes(1));
        expect(api.resolveRoute).toHaveBeenCalledWith({ meter_id: 1 });

        expect(await screen.findByText(/^SYS: 命中 —— 规则「meter 0001」→ 指令「执行 X」（只解析，不发送）。$/)).toBeTruthy();
        expect(screen.getByText('命中规则')).toBeTruthy();
        expect(screen.getByTestId('dry-result-0').textContent).toBe('meter 0001');
        expect(screen.getByTestId('dry-result-1').textContent).toBe('执行 X');
        expect(screen.getByTestId('dry-result-2').textContent).toBe('1 条');
        expect(screen.getByTestId('dry-result-3').textContent).toBe('0 条');
        // 只回显：不选中任何规则、不发任何写请求
        expect(api.updateRoutingRule).not.toHaveBeenCalled();
        expect(api.createRoutingRule).not.toHaveBeenCalled();
        expect(api.deleteRoutingRule).not.toHaveBeenCalled();
    });

    it('无命中 → SYS 写清扫了几条，两行结果出「（无命中）」，不猜一条规则顶上', async () => {
        api.resolveRoute.mockResolvedValue(MISS);
        await renderPage();
        fillInputs('meter_id', '0003');
        runDry();

        expect(await screen.findByText(/^SYS: 无命中 —— 扫过 2 条规则都不成立。$/)).toBeTruthy();
        expect(screen.getAllByText('（无命中）')).toHaveLength(2);
        expect(screen.getByTestId('dry-result-2').textContent).toBe('2 条');
        expect(api.updateRoutingRule).not.toHaveBeenCalled();
    });

    it('后端失败 → ERR 行给事实与原文，不出半张结果表', async () => {
        api.resolveRoute.mockRejectedValueOnce(new Error('backend down'));
        await renderPage();
        fillInputs('meter_id', '1');
        runDry();

        expect(await screen.findByText(/^ERR: 解析失败 —— backend down$/)).toBeTruthy();
        expect(screen.queryByTestId('dry-result-0')).toBeNull();
    });

    it('添加 / 删除输入行：加行出新键值框，删到只剩一行时 × 禁用', async () => {
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: '+ 添加 ADD' }));
        expect(screen.getByLabelText('试解析键 2')).toBeTruthy();

        fireEvent.click(screen.getByLabelText('删除试解析输入 2'));
        expect(screen.queryByLabelText('试解析键 2')).toBeNull();

        fireEvent.click(screen.getByLabelText('删除试解析输入 1'));
        // 至少留一行（同加工页口径），按钮在此为 disabled
        expect(screen.getByLabelText('试解析键 1')).toBeTruthy();
    });

    it('顺序有未保存改动 → 当场写出「N 条顺序待保存」，并说明按已落库顺序算', async () => {
        await renderPage();
        expect(screen.queryByText(/顺序待保存 —— 试解析按已落库顺序计算/)).toBeNull();

        fireEvent.click(screen.getByLabelText('下移 meter 0001'));
        expect(await screen.findByText(/2 条顺序待保存 —— 试解析按已落库顺序计算/)).toBeTruthy();
        // 面板口径行始终在：表单与顺序的未保存改动不参与
        expect(screen.getByText(/表单与顺序的未保存改动不参与/)).toBeTruthy();
    });
});

// ── R43（PLAN §8.75）逐条判定轨迹 ─────────────────────────────────────────
// 「比较不成立 / 变量不在输入 / 类型不可比」三者在回执里同为不命中，此前页面只
// 列出这**三类可能**、说不出**是哪条规则、哪一类**。轨迹把后端给的一行一规则
// 摆出来 —— FE 只排版，判定仍在后端 `core/condition.py`。
describe('R43 试解析 · 逐条判定轨迹（§8.75）', () => {
    beforeEach(() => {
        api.listRoutingRules.mockResolvedValue([RULE_A, RULE_B]);
        api.createRoutingRule.mockResolvedValue(null);
        api.updateRoutingRule.mockResolvedValue(RULE_A);
        api.deleteRoutingRule.mockResolvedValue({ status: 'deleted', id: 'r-1' });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('未命中 → 结果表下方逐行列出每条规则与它的未命中原因', async () => {
        api.resolveRoute.mockResolvedValue({
            ...MISS,
            trace: [
                { id: 'r-1', name: 'meter 0001', condition: 'meter_id == 0001', code: 'VAR_UNDEFINED', detail: 'meter_id' },
                { id: 'r-2', name: 'meter 0002', condition: 'meter_id == 0002', code: 'NOT_EVALUATED', detail: '' },
            ],
        });
        await renderPage();
        fillInputs('meter_id', '0003');
        runDry();

        expect(await screen.findByText(/^SYS: 无命中 —— 扫过 2 条规则都不成立。$/)).toBeTruthy();
        expect(screen.getByText(/逐条判定轨迹 \(TRACE\) · 2 条/)).toBeTruthy();

        const first = screen.getByTestId('dry-trace-0');
        expect(first.textContent).toContain('#1');
        expect(first.textContent).toContain('meter 0001');
        expect(first.textContent).toContain('meter_id == 0001');
        expect(first.textContent).toContain('变量不在本次输入里：meter_id');

        const second = screen.getByTestId('dry-trace-1');
        expect(second.textContent).toContain('#2');
        expect(second.textContent).toContain('未轮到');
        // 只回显：轨迹同样不选中规则、不发写请求
        expect(api.updateRoutingRule).not.toHaveBeenCalled();
    });

    it('命中 → 轨迹同样出，命中那行标 MATCHED、其后规则标未轮到', async () => {
        api.resolveRoute.mockResolvedValue({
            ...HIT,
            trace: [
                { id: 'r-1', name: 'meter 0001', condition: 'meter_id == 0001', code: 'MATCHED', detail: '' },
                { id: 'r-2', name: 'meter 0002', condition: 'meter_id == 0002', code: 'NOT_EVALUATED', detail: '' },
            ],
        });
        await renderPage();
        fillInputs('meter_id', '0001');
        runDry();

        expect(await screen.findByText(/^SYS: 命中 —— 规则「meter 0001」→ 指令「执行 X」（只解析，不发送）。$/)).toBeTruthy();
        expect(screen.getByTestId('dry-trace-0').textContent).toContain('判真命中');
        expect(screen.getByTestId('dry-trace-1').textContent).toContain('未轮到');
    });

    it('回执没有 trace（旧后端）→ 不出轨迹块，结果表照常', async () => {
        api.resolveRoute.mockResolvedValue(HIT);
        await renderPage();
        fillInputs('meter_id', '0001');
        runDry();

        expect(await screen.findByText(/^SYS: 命中/)).toBeTruthy();
        expect(screen.queryByText(/逐条判定轨迹 \(TRACE\)/)).toBeNull();
        // 口径列表里也有「逐条判定轨迹」这个词 —— 断言锚到结果区标题，别误伤
        expect(screen.queryByTestId('dry-trace-0')).toBeNull();
        expect(screen.getByTestId('dry-result-0')).toBeTruthy();
    });

    it('后端失败 → 连轨迹块一起不出（回执都没有，不假装有轨迹）', async () => {
        api.resolveRoute.mockRejectedValueOnce(new Error('backend down'));
        await renderPage();
        fillInputs('meter_id', '1');
        runDry();

        expect(await screen.findByText(/^ERR: 解析失败 —— backend down$/)).toBeTruthy();
        expect(screen.queryByText(/逐条判定轨迹 \(TRACE\)/)).toBeNull();
        // 口径列表里也有「逐条判定轨迹」这个词 —— 断言锚到结果区标题，别误伤
        expect(screen.queryByTestId('dry-trace-0')).toBeNull();
    });
});
