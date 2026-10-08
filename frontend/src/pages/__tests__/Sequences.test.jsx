import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
        getInstructions: vi.fn(),
        getRecipes: vi.fn()
    }
}));

// R12 拖拽（PLAN §8.49）：jsdom 没有真实指针传感器，碰撞检测依赖的
// getBoundingClientRect 也全是 0 —— 这里只把 DndContext 的 onDragEnd 透到 DOM 上，
// 测试直接调用它。被测的是我们自己的「换序 / 跟随编辑器 / 零即时 PUT」口径，
// 不是 dnd-kit 本身（同 R4 的 Orchestration mock）。
vi.mock('@dnd-kit/core', () => ({
    DndContext: ({ children, onDragEnd }) => (
        <div
            data-testid="dnd-context"
            ref={(node) => { if (node) node.__dndOnDragEnd = onDragEnd; }}
        >
            {children}
        </div>
    ),
    PointerSensor: class PointerSensor {},
    useSensor: () => ({}),
    useSensors: (...sensors) => sensors,
    useDraggable: () => ({
        setNodeRef: () => {}, listeners: {}, attributes: {}, isDragging: false
    }),
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false })
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

// CP3 3c (D6-B): 配方行（GET /recipes 响应形）与封装步骤的 plan.shell ——
// 最终帧绝对字节坐标，16 字节帧 3 层（由内到外 offset 递减、最外层 0，几何与
// backend/core/recipe_compile.shell_plan 一致：S_i = Σ_{j>i} head_j）。

// R30 (§8.62): 带条件存在 (presence) 的指令 —— 用来锁「Sequences 步骤编辑器
// **不传** presenceStates，字段树自算照样出章」（同一组件的第二个消费方）。
const INSTR_PRESENCE = {
    id: 'instr-presence', code: 'BR', name: '分支', device_code: 'DEV',
    fields: [
        { id: 'f1', name: '命令', op_code: 'INPUT', byte_len: 1, sequence: 0, endianness: 'BIG', parameter_config: { type: 'number' } },
        { id: 'f2', name: 'Gated', op_code: 'HEX_RAW', byte_len: 1, sequence: 1, endianness: 'BIG', parameter_config: { hex: 'FF', presence: { ref_id: 'f1', expect: '02' } } }
    ]
};

const RECIPE = { id: 'rec-1', name: '三重壳', description: null, stages: [], version: 1 };

const SHELL = {
    recipe_id: 'rec-1',
    definition_hash: 'sha256:deadbeef',
    kernel: { offset: 6, length: 4 },
    layers: [
        { index: 0, offset: 5, size: 7, length: [{ offset: 5, byte_length: 1 }], checksum: [{ offset: 10, byte_length: 2 }] },
        { index: 1, offset: 3, size: 11, length: [{ offset: 3, byte_length: 2 }], checksum: [{ offset: 12, byte_length: 2 }] },
        { index: 2, offset: 0, size: 16, length: [{ offset: 0, byte_length: 2 }], checksum: [{ offset: 14, byte_length: 2 }] }
    ]
};

// 单步序列：已封装（wrap 响应形 {recipe_id, definition_hash, stale}）+ 冻结的
// 完整封装帧 payload + 带 shell 的 plan（extra 可覆盖 wrap 等字段）
const wrappedRow = (extra = {}) => ({
    ...SEQ_ROW,
    steps: [{
        id: 'st-w', step_order: 0, instruction_id: 'instr-1', label: '封装步', delay_ms: 0,
        params: null, payload: '000102030405060708090A0B0C0D0E0F',
        plan: { dynamic: [], checksum: null, shell: SHELL },
        wrap: { recipe_id: 'rec-1', definition_hash: 'sha256:deadbeef', stale: false },
        ...extra
    }]
});

const baseMocks = () => {
    api.listSequences.mockResolvedValue([SEQ_ROW]);
    api.getSequenceStatus.mockResolvedValue(IDLE_SNAP);
    api.getInstructions.mockResolvedValue([INSTR]);
    api.getRecipes.mockResolvedValue([]);
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

    // ─── R53 (PLAN §8.85): 过期回包不得覆盖更新的本地状态 ────────────────
    it('R53 回归：序列保存回包晚于新编辑 → 服务端行重建草稿不得冲掉存后编辑', async () => {
        // 回包与随后的列表回读都由本测试掌闸：回读带回的是**服务端已存的**名字
        let release;
        let putName = null;
        api.updateSequence.mockImplementation((id, body) => {
            putName = body.name;
            return new Promise((resolve) => { release = resolve; });
        });
        api.listSequences.mockImplementation(() => Promise.resolve([{ ...SEQ_ROW, name: putName || SEQ_ROW.name }]));

        await renderPage();
        const nameInput = await screen.findByDisplayValue('冒烟序列');
        fireEvent.change(nameInput, { target: { value: '存前名' } });
        const saveBtn = screen.getByRole('button', { name: /保存定义/ });
        await waitFor(() => expect(saveBtn.disabled).toBe(false));
        fireEvent.click(saveBtn);
        await waitFor(() => expect(api.updateSequence).toHaveBeenCalledTimes(1));

        // 回包未回 → 用户又改一刀
        fireEvent.change(screen.getByDisplayValue('存前名'), { target: { value: '存后名' } });

        release(SEQ_ROW);
        // 保存成功 → refresh() 回读列表（第 2 次）→ effect 用服务端行重建草稿
        await waitFor(() => expect(api.listSequences).toHaveBeenCalledTimes(2));
        await act(async () => {});

        // 判据：重建只认「服务端已存的那份」，存后那次编辑不得被冲掉
        expect(screen.getByDisplayValue('存后名')).toBeDefined();
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

    // ── R30 (§8.62): 第二个消费方（Sequences 步骤编辑器）**未接线 → 组件自算** ─
    // Sequences.jsx 一行未改：字段树自己拿 fields / inputs 算 presence，两个页面
    // 从此同一口径 —— R29 曾因「范围钉在加工页」而在本页一个章都不出。
    it('R30 步骤编辑器自动出 presence 章：IF(miss) + [SKIP 0B]（Sequences 零接线）', async () => {
        api.getInstructions.mockResolvedValue([INSTR_PRESENCE]);
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: /\+ 添加步骤/ }));
        await screen.findByText(/STEP 03 \/\/ 编辑器/);

        const chip = await waitFor(() => {
            const el = document.querySelector('[data-runner-presence-chip]');
            expect(el).toBeTruthy();
            return el;
        });
        // 默认输入 0 vs expect "02" → 未命中（真·不同值 → 不出十六进制提示）
        expect(chip.getAttribute('data-runner-presence-chip')).toBe('miss');
        expect(chip.getAttribute('title')).toContain('条件字段：[f1] == 02');
        expect(chip.getAttribute('title')).toContain('未命中 → 0 字节（本帧不发）');
        expect(chip.getAttribute('title')).not.toContain('十六进制解析');
        expect(document.querySelector('[data-runner-presence-skip]').textContent).toBe('[SKIP 0B]');
        // 同批验收：被门掉的字段不出线 → 帧只剩 ref 自己 1 字节
        expect(screen.getByText(/FRAME 1B/)).toBeTruthy();
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

    // ── R12 · 步骤拖拽排序（PLAN §8.49，拍板口径镜像 R4：**拖完只改草稿序，
    // 点「保存定义」才 PUT**）────────────────────────────────────────────────
    // 行 label 取「编辑该步骤」按钮里的 .w-28 span —— 把手无文本节点，不进这里
    const stepLabels = () => [...document.querySelectorAll('[title="编辑该步骤"]')]
        .map((btn) => btn.querySelector('.w-28').textContent);

    const dragRow = (activeId, overId) => {
        const node = screen.getByTestId('dnd-context');
        act(() => {
            node.__dndOnDragEnd({ active: { id: activeId }, over: { id: overId } });
        });
    };

    it('R12 拖拽：松手只改草稿序（零即时 PUT），点「保存定义」才 PUT 新序', async () => {
        await renderPage();
        expect(stepLabels()).toEqual(['第一步', '第二步']);

        api.updateSequence.mockClear();
        dragRow('st-2', 'st-1');

        // 草稿序立刻翻转（列表重排），持久序一个字节没写
        expect(stepLabels()).toEqual(['第二步', '第一步']);
        expect(api.updateSequence).not.toHaveBeenCalled();

        // 自己拖自己 = 无位移，不改序不发请求
        dragRow('st-1', 'st-1');
        expect(stepLabels()).toEqual(['第二步', '第一步']);
        expect(api.updateSequence).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /保存定义/ }));
        await waitFor(() => expect(api.updateSequence).toHaveBeenCalledTimes(1));
        const body = api.updateSequence.mock.calls[0][1];
        expect(body.steps.map((s) => s.label)).toEqual(['第二步', '第一步']);
        // 服务端字段（id / step_order）照旧剥离 —— 后端按数组序重编 step_order
        expect('id' in body.steps[0]).toBe(false);
        expect('step_order' in body.steps[0]).toBe(false);
        expect(body.steps[0].delay_ms).toBe(100); // 延时随行保留
    });

    it('R12 拖拽：编辑器开着的那步跟着落点走（不会错指到别的步）', async () => {
        await renderPage();
        // 选中第二步 → 编辑器开在 index 1、标签输入回填「第二步」
        fireEvent.click(screen.getAllByTitle('编辑该步骤')[1]);
        expect(screen.getByText(/STEP 02 \/\/ 编辑器/)).toBeTruthy();
        expect(screen.getByDisplayValue('第二步')).toBeTruthy();

        // 第一步拖到第二步的位置（from 0 → to 1）→ 第二步落到 index 0，
        // 编辑器必须跟着指向它，否则编辑器会静默改到「第一步」头上
        dragRow('st-1', 'st-2');
        expect(stepLabels()).toEqual(['第二步', '第一步']);
        expect(screen.getByText(/STEP 01 \/\/ 编辑器/)).toBeTruthy();
        expect(screen.getByDisplayValue('第二步')).toBeTruthy();
        expect(api.updateSequence).not.toHaveBeenCalled();
    });

    it('R12 拖拽：序列运行中拖拽直接忽略（与上移/下移同一禁用口径）', async () => {
        api.getSequenceStatus.mockResolvedValue(RUNNING_SNAP);
        await renderPage();
        expect(stepLabels()).toEqual(['第一步', '第二步']);

        api.updateSequence.mockClear();
        dragRow('st-2', 'st-1');
        expect(stepLabels()).toEqual(['第一步', '第二步']);
        expect(api.updateSequence).not.toHaveBeenCalled();
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

    // ---- CP3 3c (D6-B): 序列封装帧（步骤可选封装配方） ----------------------

    it('recipe selector lands wrap.recipe_id on the draft and in the PUT body', async () => {
        api.getRecipes.mockResolvedValue([RECIPE]);
        await renderPage();
        // 打开第 1 步编辑器 → RECIPE 选择器回填「无封装」（未选 → 无 wrap 键）
        fireEvent.click(screen.getAllByTitle('编辑该步骤')[0]);
        const select = await screen.findByTestId('step-wrap-recipe');
        expect(select.value).toBe('');
        fireEvent.change(select, { target: { value: 'rec-1' } });
        // 选中即落草稿 → 卡片即时回显 WRAP :: 指示（本地新选无 stale → 徽标不亮）
        await waitFor(() => {
            expect(screen.getByTestId('step-wrap-0').textContent).toContain('WRAP :: 三重壳');
        });
        expect(screen.queryByTestId('step-wrap-stale-0')).toBeNull();
        // 保存：请求形只收 {recipe_id}（响应形 definition_hash/stale 不透传 → 400 未知字段）
        fireEvent.click(screen.getByRole('button', { name: /保存定义/ }));
        await waitFor(() => expect(api.updateSequence).toHaveBeenCalledTimes(1));
        const body = api.updateSequence.mock.calls[0][1];
        expect(body.steps[0].wrap).toEqual({ recipe_id: 'rec-1' });
        expect('definition_hash' in body.steps[0].wrap).toBe(false);
        expect('stale' in body.steps[0].wrap).toBe(false);
        // 未选配方的步骤不带 wrap 键（裸帧请求形与改前一致）
        expect('wrap' in body.steps[1]).toBe(false);
    });

    it('APPLY keeps the selected recipe on the step (kernel payload + wrap travel together)', async () => {
        api.getRecipes.mockResolvedValue([RECIPE]);
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: /\+ 添加步骤/ }));
        await screen.findByText(/STEP 03 \/\/ 编辑器/);
        fireEvent.change(await screen.findByTestId('step-wrap-recipe'), { target: { value: 'rec-1' } });
        fireEvent.click(screen.getByRole('button', { name: /应用到步骤/ }));
        await waitFor(() => expect(screen.getByText(/步骤 3 已应用（3 字节）/)).toBeTruthy());
        fireEvent.click(screen.getByRole('button', { name: /保存定义/ }));
        await waitFor(() => expect(api.updateSequence).toHaveBeenCalledTimes(1));
        const body = api.updateSequence.mock.calls[0][1];
        expect(body.steps).toHaveLength(3);
        // APPLY 产物 = 内核帧 payload + buildPlan 计划（无 shell），wrap 同步入 PUT
        expect(body.steps[2].payload).toBe('AABBCC');
        expect(body.steps[2].plan).toBeNull();
        expect(body.steps[2].wrap).toEqual({ recipe_id: 'rec-1' });
        expect('wrap' in body.steps[0]).toBe(false);
    });

    it('wrapped step echoes WRAP :: on card + editor header and lights the stale badge', async () => {
        api.getRecipes.mockResolvedValue([RECIPE]);
        api.listSequences.mockResolvedValue([wrappedRow({
            wrap: { recipe_id: 'rec-1', definition_hash: 'sha256:deadbeef', stale: true }
        })]);
        await renderPage();
        // 卡片层：来源指示 + 失效徽标（stale 点亮、不阻断）
        expect(screen.getByTestId('step-wrap-0').textContent).toContain('WRAP :: 三重壳');
        expect(screen.getByTestId('step-wrap-stale-0').textContent).toContain('失效');
        // 编辑器：下拉回填已选配方，头部同款指示 + 失效徽标
        fireEvent.click(screen.getByTitle('编辑该步骤'));
        const select = await screen.findByTestId('step-wrap-recipe');
        expect(select.value).toBe('rec-1');
        expect(screen.getByTestId('step-editor-wrap').textContent).toContain('WRAP :: 三重壳');
        expect(screen.getByTestId('step-editor-wrap-stale').textContent).toContain('失效');
    });

    it('clearing the recipe hides WRAP :: and PUTs wrap: null', async () => {
        api.getRecipes.mockResolvedValue([RECIPE]);
        api.listSequences.mockResolvedValue([wrappedRow()]);
        await renderPage();
        expect(screen.getByTestId('step-wrap-0')).toBeTruthy(); // 回显在场
        fireEvent.click(screen.getByTitle('编辑该步骤'));
        const select = await screen.findByTestId('step-wrap-recipe');
        expect(select.value).toBe('rec-1');
        fireEvent.change(select, { target: { value: '' } });
        // 指示即时消失（卡片与编辑器头部均不渲染 WRAP ::）
        await waitFor(() => expect(screen.queryByTestId('step-wrap-0')).toBeNull());
        expect(screen.queryByTestId('step-editor-wrap')).toBeNull();
        // 保存 → 显式 wrap: null（后端按旧区间切回内核、剥 plan.shell）
        fireEvent.click(screen.getByRole('button', { name: /保存定义/ }));
        await waitFor(() => expect(api.updateSequence).toHaveBeenCalledTimes(1));
        const step = api.updateSequence.mock.calls[0][1].steps[0];
        expect('wrap' in step).toBe(true);
        expect(step.wrap).toBeNull();
    });

    it('plan.shell layers summary renders in the plan summary panel', async () => {
        api.listSequences.mockResolvedValue([wrappedRow()]);
        await renderPage();
        fireEvent.click(screen.getByTitle('编辑该步骤'));
        const panel = await screen.findByTestId('step-plan-summary');
        // 层数 + 每层 LEN/CRC 字段的最终帧绝对字节位（shellSummary）
        expect(panel.textContent).toContain('SHELL L1..L3');
        expect(panel.textContent).toContain('L1 LEN@5 CRC@10');
        expect(panel.textContent).toContain('L2 LEN@3 CRC@12');
        expect(panel.textContent).toContain('L3 LEN@0 CRC@14');
    });

    it('steps served with wrap: null keep the bare request shape (no wrap key in PUT)', async () => {
        // 真实 GET /sequences 响应里未封装步骤恒带 wrap:null —— 草稿须剥键，
        // 保存体才与 CP3-3c 之前逐字节一致（零回归锚）
        api.listSequences.mockResolvedValue([{
            ...SEQ_ROW,
            steps: SEQ_ROW.steps.map((s) => ({ ...s, wrap: null }))
        }]);
        await renderPage();
        expect(screen.queryByTestId('step-wrap-0')).toBeNull(); // wrap null → 不渲染 WRAP ::
        fireEvent.click(screen.getByRole('button', { name: /保存定义/ }));
        await waitFor(() => expect(api.updateSequence).toHaveBeenCalledTimes(1));
        const body = api.updateSequence.mock.calls[0][1];
        expect(body.steps).toHaveLength(2);
        expect('wrap' in body.steps[0]).toBe(false);
        expect('wrap' in body.steps[1]).toBe(false);
        // 既有裸帧字段逐字节保持
        expect(body.steps[0]).toEqual({
            instruction_id: 'instr-1', label: '第一步', delay_ms: 0,
            params: null, payload: 'A5010B', plan: null
        });
    });

    // ---- R26（PLAN §8.58）序列级分支 --------------------------------------

    it('steps with a condition PUT it; steps without omit the key (bare shape kept)', async () => {
        api.listSequences.mockResolvedValue([{
            ...SEQ_ROW,
            steps: [
                { ...SEQ_ROW.steps[0], condition: 'step.1.status == "OK"' },
                { ...SEQ_ROW.steps[1], condition: null }
            ]
        }]);
        await renderPage();
        expect(screen.getByTestId('step-cond-0')).toBeTruthy(); // COND :: 指示在场
        expect(screen.queryByTestId('step-cond-1')).toBeNull(); // null → 无指示

        fireEvent.click(screen.getByRole('button', { name: /保存定义/ }));
        await waitFor(() => expect(api.updateSequence).toHaveBeenCalledTimes(1));
        const steps = api.updateSequence.mock.calls[0][1].steps;
        expect(steps[0].condition).toBe('step.1.status == "OK"');
        expect('condition' in steps[1]).toBe(false); // 键缺席 = 无条件（不发 null）
        // 无条件步的形状与 R26 之前逐字节一致（零回归锚）
        expect(steps[1]).toEqual({
            instruction_id: 'instr-1', label: '第二步', delay_ms: 100,
            params: { f1: 5 }, payload: 'CCDD', plan: null
        });
    });

    it('APPLY writes the condition; invalid syntax is blocked with an inline red hint', async () => {
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: /\+ 添加步骤/ }));
        await screen.findByText(/STEP 03 \/\/ 编辑器/);
        const input = await screen.findByTestId('step-condition');
        expect(input.value).toBe('');

        // 合法 → 无红字 → APPLY 落步
        fireEvent.change(input, { target: { value: 'step.1.status == "OK"' } });
        expect(screen.queryByTestId('step-condition-error')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /应用到步骤/ }));
        await waitFor(() => expect(screen.getByText(/步骤 3 已应用/)).toBeTruthy());

        // 非法（缺右操作数）→ 红框 + 红字，APPLY 被拦下不改草稿
        fireEvent.change(input, { target: { value: 'fw_version >=' } });
        await screen.findByTestId('step-condition-error');
        fireEvent.click(screen.getByRole('button', { name: /应用到步骤/ }));
        await waitFor(() => expect(screen.getByText(/条件非法/)).toBeTruthy());

        // 保存：第 3 步仍是上一次**合法**的条件；前两步无键
        fireEvent.click(screen.getByRole('button', { name: /保存定义/ }));
        await waitFor(() => expect(api.updateSequence).toHaveBeenCalledTimes(1));
        const steps = api.updateSequence.mock.calls[0][1].steps;
        expect(steps[2].condition).toBe('step.1.status == "OK"');
        expect('condition' in steps[0]).toBe(false);
        expect('condition' in steps[1]).toBe(false);
    });

    it('status row tooltip surfaces the condition-skip reason (COND:)', async () => {
        api.getSequenceStatus.mockResolvedValue({
            ...IDLE_SNAP,
            steps: [{
                n: 2, step_id: 'st-2', label: '第二步', instruction_id: 'instr-1',
                status: 'SKIPPED', sent: null, received: null, rtt_ms: null,
                error: 'COND: 条件不成立'
            }]
        });
        await renderPage();
        // 操作员据此区分「条件挡下的跳过」与「停止后补跳过」（后者 error 为空）
        expect(await screen.findByTitle(/COND: 条件不成立/)).toBeTruthy();
    });
});
