import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Sequences from '../Sequences';
import { api } from '../../api';

// 本仓未装 @testing-library/jest-dom → 只用裸断言：
// 存在 = toBeTruthy / 取不到时 getBy* 自身抛错；禁用态取元素 .disabled 属性。

vi.mock('../../api', () => ({
    api: {
        listSequences: vi.fn(),
        createSequence: vi.fn(),
        updateSequence: vi.fn(),
        deleteSequence: vi.fn(),
        startSequence: vi.fn(),
        stopSequence: vi.fn(),
        getSequenceStatus: vi.fn(),
        getInstructions: vi.fn()
    }
}));

// ---- 形状对齐 backend/schemas/sequence_api.py 的快照与定义 ------------------

const IDLE_SNAP = {
    running: false, result: 'idle',
    sequence_id: null, sequence_name: null,
    total_steps: 0, current_step: null,
    started_at: null, finished_at: null,
    stop_requested: false, error: null, steps: []
};

const RUNNING_SNAP = {
    running: true, result: 'running',
    sequence_id: 'seq-1', sequence_name: '冒烟序列',
    total_steps: 1, current_step: 1,
    started_at: '2026-09-23T04:10:43.021151+00:00', finished_at: null,
    stop_requested: false, error: null,
    steps: [{
        n: 1, step_id: 'st-1', label: '第一步', instruction_id: 'instr-1',
        status: 'OK', sent: 'A5 01', received: 'A501', rtt_ms: 0.5, error: null
    }]
};

const SEQ_ROW = {
    id: 'seq-1', name: '冒烟序列', description: 'desc',
    config: { stop_on_error: true, read_timeout_ms: null },
    steps: [
        { id: 'st-1', step_order: 0, instruction_id: 'instr-1', label: '第一步', delay_ms: 0, params: null, payload: 'A5010B', plan: null },
        { id: 'st-2', step_order: 1, instruction_id: 'instr-1', label: '第二步', delay_ms: 100, params: { f1: 5 }, payload: 'CCDD', plan: null }
    ]
};

// 全 FIXED 字段：帧由 params.hex 决定，无需输入即可编译出确定 payload（AABBCC）
const INSTR = {
    id: 'instr-1', code: 'NOP', name: '空操作', device_code: 'DEV',
    fields: [
        { id: 'f1', name: 'X', op_code: 'FIXED', byte_len: 2, sequence: 0, endianness: 'BIG', parameter_config: { hex: 'AABB' } },
        { id: 'f2', name: 'Y', op_code: 'FIXED', byte_len: 1, sequence: 1, endianness: 'BIG', parameter_config: { hex: 'CC' } }
    ]
};

const baseMocks = () => {
    api.listSequences.mockResolvedValue([SEQ_ROW]);
    api.getSequenceStatus.mockResolvedValue(IDLE_SNAP);
    api.getInstructions.mockResolvedValue([INSTR]);
    // 页面生成名 = `序列 ${sequences.length + 1}`：现存 1 条 → 序列 2
    api.createSequence.mockResolvedValue({ ...SEQ_ROW, id: 'seq-new', name: '序列 2', steps: [] });
    api.updateSequence.mockResolvedValue(SEQ_ROW);
    api.deleteSequence.mockResolvedValue(null);
    api.startSequence.mockResolvedValue(RUNNING_SNAP);
    api.stopSequence.mockResolvedValue(IDLE_SNAP);
};

const renderPage = async () => {
    const utils = render(<Sequences />);
    await waitFor(() => expect(api.listSequences).toHaveBeenCalled());
    await waitFor(() => expect(api.getSequenceStatus).toHaveBeenCalled());
    // 名称输入回填 = 列表已渲染且首条已自动选中（effect 链已收敛）
    await screen.findByDisplayValue('冒烟序列');
    // 「追加一步」title 随指令库加载翻转 → instructions state 已就位
    await screen.findByTitle('追加一步（默认首条指令）');
    return utils;
};

describe('Sequences Page', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        baseMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('mount loads definitions, status and instruction library; header shows shortcut F', async () => {
        await renderPage();
        expect(api.getInstructions).toHaveBeenCalledTimes(1);
        expect(screen.getByText('序列编排')).toBeTruthy();
        expect(screen.getByText(/PAGE F/)).toBeTruthy();
        expect(screen.getByText('冒烟序列')).toBeTruthy();
        expect((await screen.findByText('待机'))).toBeTruthy(); // IDLE_SNAP.result
    });

    it('polls /sequences/status every 1.5s and clears interval on unmount', async () => {
        vi.useFakeTimers();
        render(<Sequences />);
        await vi.advanceTimersByTimeAsync(0);  // 冲刷挂载首拍
        expect(api.getSequenceStatus).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1500);
        expect(api.getSequenceStatus).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1500);
        expect(api.getSequenceStatus).toHaveBeenCalledTimes(3);
    });

    it('saving PUTs the whole definition and strips server-side step fields', async () => {
        await renderPage();
        const nameInput = await screen.findByDisplayValue('冒烟序列');
        fireEvent.change(nameInput, { target: { value: '改名序列' } });
        const saveBtn = screen.getByRole('button', { name: /保存定义/ });
        await waitFor(() => expect(saveBtn.disabled).toBe(false));
        fireEvent.click(saveBtn);
        await waitFor(() => expect(api.updateSequence).toHaveBeenCalledTimes(1));
        const [id, body] = api.updateSequence.mock.calls[0];
        expect(id).toBe('seq-1');
        expect(body.name).toBe('改名序列');
        expect(body.config).toEqual({ stop_on_error: true, read_timeout_ms: null });
        expect(body.steps).toHaveLength(2);
        // 服务端字段剥离（后端重建行并重编 step_order）
        expect(body.steps[0]).toEqual({
            instruction_id: 'instr-1', label: '第一步', delay_ms: 0,
            params: null, payload: 'A5010B', plan: null
        });
        expect('id' in body.steps[0]).toBe(false);
        expect('step_order' in body.steps[0]).toBe(false);
    });

    it('save stays disabled while any step is uncompiled', async () => {
        api.listSequences.mockResolvedValue([{
            ...SEQ_ROW,
            steps: [{ id: 'st-x', step_order: 0, instruction_id: 'instr-1', label: '坏步', delay_ms: 0, params: null, payload: '', plan: null }]
        }]);
        await renderPage();
        expect(screen.getByRole('button', { name: /保存定义/ }).disabled).toBe(true);
        expect(screen.getByText(/全部已编译/)).toBeTruthy();
    });

    it('save 400 detail (steps[i] locator) surfaces in the red banner', async () => {
        api.updateSequence.mockRejectedValue(new Error('steps[0]: payload 超长'));
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: /保存定义/ }));
        await waitFor(() => {
            expect(screen.getByText(/ERR: steps\[0\]/)).toBeTruthy();
        });
    });

    it('delete requires confirmation: cancel keeps, confirm calls API', async () => {
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: /删除所选/ }));
        expect(screen.getByText(/删除序列「冒烟序列」/)).toBeTruthy();
        // NieRModal 按钮固定文案（组件不支持 confirmLabel 定制）
        fireEvent.click(screen.getByRole('button', { name: /取消 \(CANCEL\)/ }));
        expect(api.deleteSequence).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /删除所选/ }));
        fireEvent.click(await screen.findByRole('button', { name: /确认 \(CONFIRM\)/ }));
        await waitFor(() => expect(api.deleteSequence).toHaveBeenCalledWith('seq-1'));
    });

    it('start transitions status to running and renders step rows', async () => {
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: /启动序列/ }));
        await waitFor(() => expect(api.startSequence).toHaveBeenCalledWith('seq-1'));
        await screen.findByText('运行中');
        expect(screen.getByText('OK')).toBeTruthy();
        expect(screen.getByText(/PROGRESS 1\/1/)).toBeTruthy();
    });

    it('start 409 (busy) shows the mutual-exclusion message', async () => {
        api.startSequence.mockRejectedValue(new Error('序列运行中，先停止当前序列再启动'));
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: /启动序列/ }));
        await waitFor(() => {
            expect(screen.getByText(/ERR: 序列运行中/)).toBeTruthy();
        });
    });

    it('stop is always available (idempotent) and posts to stopSequence', async () => {
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: /^停止$/ }));
        await waitFor(() => expect(api.stopSequence).toHaveBeenCalledTimes(1));
    });

    it('running state disables definition editing, delete, create and start', async () => {
        api.getSequenceStatus.mockResolvedValue(RUNNING_SNAP);
        await renderPage();
        await screen.findByText('运行中');
        expect(screen.getByDisplayValue('冒烟序列').disabled).toBe(true);
        expect(screen.getByRole('button', { name: /\+ 新建序列/ }).disabled).toBe(true);
        expect(screen.getByRole('button', { name: /删除所选/ }).disabled).toBe(true);
        expect(screen.getByRole('button', { name: /启动序列/ }).disabled).toBe(true);
        expect(screen.getByRole('button', { name: /^停止$/ }).disabled).toBe(false);
        expect(screen.getByText(/序列运行中 — 定义编辑已禁用/)).toBeTruthy();
    });

    it('add step + APPLY compiles payload from encodeInstruction (fixed-frame fixture)', async () => {
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: /\+ 添加步骤/ }));
        // 编辑器展开（fixture 已有 2 步 → 新增为第 3 步），实时帧预览 = AABBCC（3 字节）
        await screen.findByText(/STEP 03 \/\/ 编辑器/);
        expect(screen.getByText(/AABBCC/)).toBeTruthy();
        expect(screen.getByText(/FRAME 3B/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /应用到步骤/ }));
        await waitFor(() => {
            expect(screen.getByText(/步骤 3 已应用（3 字节）/)).toBeTruthy();
        });
        // 保存转为可用（既有 2 步 payload 均非空 + 新步已编译）
        await waitFor(() => {
            expect(screen.getByRole('button', { name: /保存定义/ }).disabled).toBe(false);
        });
        fireEvent.click(screen.getByRole('button', { name: /保存定义/ }));
        await waitFor(() => expect(api.updateSequence).toHaveBeenCalledTimes(1));
        const body = api.updateSequence.mock.calls[0][1];
        expect(body.steps).toHaveLength(3);
        expect(body.steps[2].payload).toBe('AABBCC');
        expect(body.steps[2].instruction_id).toBe('instr-1');
    });

    it('move step down reorders the draft and PUT follows new order', async () => {
        await renderPage();
        const downBtns = await screen.findAllByTitle('下移');
        fireEvent.click(downBtns[0]); // 第一步 → 下移
        fireEvent.click(screen.getByRole('button', { name: /保存定义/ }));
        await waitFor(() => expect(api.updateSequence).toHaveBeenCalledTimes(1));
        const body = api.updateSequence.mock.calls[0][1];
        expect(body.steps.map((s) => s.label)).toEqual(['第二步', '第一步']);
        // 延时随行保留
        expect(body.steps[0].delay_ms).toBe(100);
    });

    it('create posts empty definition and selects the result', async () => {
        // 第二次 refresh 拿到新建行 → effect 回挂 seq-new 并回填名称
        api.listSequences
            .mockResolvedValueOnce([SEQ_ROW])
            .mockResolvedValueOnce([{ ...SEQ_ROW, id: 'seq-new', name: '序列 2', steps: [] }]);
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: /\+ 新建序列/ }));
        await waitFor(() => expect(api.createSequence).toHaveBeenCalledTimes(1));
        const body = api.createSequence.mock.calls[0][0];
        expect(body.steps).toEqual([]);
        expect(body.name).toBe('序列 2'); // sequences.length(1) + 1
        expect(body.config).toEqual({ stop_on_error: true, read_timeout_ms: null });
        await waitFor(() => {
            expect(screen.getByDisplayValue('序列 2')).toBeTruthy();
        });
    });

    it('step with missing instruction shows the 失效 badge + read-only notice (payload preserved)', async () => {
        api.listSequences.mockResolvedValue([{
            ...SEQ_ROW,
            steps: [{ id: 'st-gone', step_order: 0, instruction_id: 'instr-gone', label: '孤儿',
                delay_ms: 0, params: null, payload: 'AABB', plan: null, instruction_missing: true }]
        }]);
        await renderPage();
        // 批次二 (D14②): 列表层先给失效徽标（不打开编辑器也看得见）
        expect(screen.getByText('失效')).toBeTruthy();

        fireEvent.click(screen.getByTitle('编辑该步骤'));
        // 编辑降只读：宿主悬空提示（帧已冻结仍可运行）+ 指令下拉锁死
        // （下拉里的「（宿主指令已删除）」占位项会同文案 → 用提示正文区分）
        await screen.findByText(/步骤帧是冻结快照/);
        expect(screen.getByText('（宿主指令已删除）')).toBeTruthy();
        // 已编译 payload 保留（行上 2B 徽标仍在）
        expect(screen.getByText('2B')).toBeTruthy();
    });

    it('steps served without instruction_missing still badge when host absent locally', async () => {
        // 本地兜底：服务端未带标记（老会话）但 instructions 列表已无宿主 → 同样打标
        api.listSequences.mockResolvedValue([{
            ...SEQ_ROW,
            steps: [{ id: 'st-gone', step_order: 0, instruction_id: 'instr-gone', label: '孤儿',
                delay_ms: 0, params: null, payload: 'AABB', plan: null }]
        }]);
        await renderPage();
        expect(screen.getByText('失效')).toBeTruthy();
    });
});
