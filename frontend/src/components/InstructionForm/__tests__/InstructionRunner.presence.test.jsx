import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import InstructionRunner from '../InstructionRunner';

// R29 (§8.61): 装配线测试 —— InstructionRunner 必须把 presence 状态表真的传给
// RunnerFieldTree（漏接 = 角标永不出现，纯函数与布局各自全绿也照样白做）。
// 同时锁「改 ref 输入 → 角标与 [SKIP 0B] 实时翻转」，即显示层与编码端同步。

vi.mock('../../../api', () => ({
    api: {
        getResponseSpec: vi.fn().mockResolvedValue(null),
        saveResponseSpec: vi.fn().mockResolvedValue({}),
        sendTransaction: vi.fn().mockResolvedValue({}),
        dispatchPayload: vi.fn().mockResolvedValue({ id: 'log-1', byte_count: 0 }),
        exportHexFile: vi.fn().mockResolvedValue({}),
        compileWrapped: vi.fn().mockResolvedValue({}),
        getBindings: vi.fn().mockResolvedValue([]),
        getRecipes: vi.fn().mockResolvedValue([])
    }
}));

import { api } from '../../../api';

beforeEach(() => {
    vi.clearAllMocks();
    api.getResponseSpec.mockResolvedValue(null);
});

const INSTRUCTION = {
    id: 'inst-presence',
    name: '分支指令',
    fields: [
        {
            id: 'cmd', name: '命令字', op_code: 'INPUT', byte_len: 1, sequence: 0,
            parameter_config: { type: 'number' }
        },
        {
            id: 'gated', name: '原始Hex', op_code: 'HEX_RAW', byte_len: 1, sequence: 1,
            parameter_config: { hex: 'FF', presence: { ref_id: 'cmd', expect: '1' } }
        },
    ],
};

const setup = () => render(
    <InstructionRunner
        instruction={INSTRUCTION}
        onSend={() => {}}
        onOpenDatePicker={() => {}}
        wrapInfo={null}
    />
);

const setupWith = (instruction) => render(
    <InstructionRunner
        instruction={instruction}
        onSend={() => {}}
        onOpenDatePicker={() => {}}
        wrapInfo={null}
    />
);

describe('InstructionRunner · presence 状态表装配', () => {
    it('表已接线：叶字段渲染 IF 角标（默认输入 0 → 未命中 → [SKIP 0B]）', async () => {
        setup();
        const chip = await waitFor(() => {
            const el = document.querySelector('[data-runner-presence-chip]');
            expect(el).toBeTruthy();
            return el;
        });
        expect(chip.getAttribute('data-runner-presence-chip')).toBe('miss');
        expect(chip.getAttribute('title')).toContain('条件字段：[cmd] == 1');
        expect(document.querySelector('[data-runner-presence-skip]')).toBeTruthy();
        expect(document.querySelector('[data-runner-presence-skip]').textContent).toBe('[SKIP 0B]');
    });

    it('改 ref 输入 → 命中翻转：SKIP 消失、角标转 hit', async () => {
        setup();
        await waitFor(() => expect(document.querySelector('[data-runner-presence-chip]')).toBeTruthy());

        // cmd 是首行输入（字段序 0）；显示形态由 resolveFieldDisplay 决定，
        // 这里只按位置取，不钉死它渲染成 hex 还是 number 通道。
        const input = document.querySelector('input');
        fireEvent.change(input, { target: { value: '1' } });

        await waitFor(() => {
            expect(document.querySelector('[data-runner-presence-chip]')
                .getAttribute('data-runner-presence-chip')).toBe('hit');
        });
        expect(document.querySelector('[data-runner-presence-skip]')).toBeNull();
        expect(document.querySelector('[data-runner-presence-chip]').getAttribute('title'))
            .toContain('命中 → 发射本字段');
    });

    it('未配置 presence 的 ref 自己不出角标', async () => {
        setup();
        await waitFor(() => expect(document.querySelector('[data-runner-presence-chip]')).toBeTruthy());
        const chips = document.querySelectorAll('[data-runner-presence-chip]');
        expect(chips.length).toBe(1); // 只有 gated，cmd 不配 presence
    });
});

// ─── R30 (§8.62) → R32 (§8.64): 补零/进制差异的**端到端可见** ────────────────
// 样本 ②：面板 expect 存字符串 "01"、ref 当前值是数值 1 —— R30 时代 String 归一
// 判不等 → 恒未命中，角标只好补「为什么判不等」；R32 拍板归一后两者**判命中**，
// 注记改挂在命中侧（「字符串不一样为什么还命中」）。纯展示，判定与出线字节由
// _presenceHit 说了算。
describe('InstructionRunner · R32 归一命中注记（端到端）', () => {
    const HEXPAD = {
        id: 'inst-hexpad',
        name: '补零指令',
        fields: [
            {
                id: 'cmd', name: '命令字', op_code: 'INPUT', byte_len: 1, sequence: 0,
                parameter_config: { type: 'number' }
            },
            {
                id: 'gated', name: '原始Hex', op_code: 'HEX_RAW', byte_len: 1, sequence: 1,
                parameter_config: { hex: 'FF', presence: { ref_id: 'cmd', expect: '01' } }
            },
        ],
    };

    it('默认值 0 vs expect "01"（真·不同值）→ 未命中且**不**出归一注记', async () => {
        setupWith(HEXPAD);
        await waitFor(() => expect(document.querySelector('[data-runner-presence-chip]')).toBeTruthy());
        expect(document.querySelector('[data-runner-presence-chip]')
            .getAttribute('data-runner-presence-chip')).toBe('miss');
        expect(document.querySelector('[data-runner-presence-chip]').getAttribute('title'))
            .not.toContain('按十六进制归一判等');
    });

    it('ref 改成 1 → R32 归一判**命中**，title 出「按十六进制归一判等」、不再有 SKIP', async () => {
        setupWith(HEXPAD);
        await waitFor(() => expect(document.querySelector('[data-runner-presence-chip]')).toBeTruthy());

        fireEvent.change(document.querySelector('input'), { target: { value: '1' } });

        const chip = await waitFor(() => {
            const el = document.querySelector('[data-runner-presence-chip]');
            expect(el.getAttribute('data-runner-presence-chip')).toBe('hit');
            return el;
        });
        expect(chip.getAttribute('title')).toContain('按十六进制归一判等');
        expect(chip.getAttribute('title')).toContain('expect "01"');
        expect(chip.getAttribute('title')).toContain('命中 → 发射本字段');
        expect(chip.getAttribute('title')).not.toContain('未命中 → 0 字节（本帧不发）');
        expect(document.querySelector('[data-runner-presence-skip]')).toBeNull(); // 命中 → 不再跳段
    });
});
