import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import InstructionRunner from '../InstructionRunner';

// R29 (§8.61): 装配测试 —— InstructionRunner 必须把 presence 状态表真的传给
// RunnerFieldTree（漏接 = 判定不驱动渲染，纯函数与布局各自全绿也照样白做）。
// R33 (§8.65) 翻面：加工页**未命中即纯隐藏**（用户拍板），故「表已接线」不再能
// 靠 miss 形态证明 —— 改为两头锁：① 初始即命中的指令直接出 IF(hit) 角标（证明
// 表到了字段层）；② 默认未命中的字段**完全不出**，改 ref 命中后才出现（证明
// 隐藏由同一张表驱动，不是写死的）。Sequences 步骤编辑器不接这个开关，仍出
// 降透明 + [SKIP 0B]（那套形态锁在 RunnerFieldTree.presence.test.jsx 缺省分支）。

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

// 初始即命中的变体（默认输入 0 == expect '0'）—— 用来在**不改任何输入**的前提
// 下证明状态表真的传到了字段层（R33 后 miss 形态在加工页不可见，不能再靠它证明）。
const INSTRUCTION_HIT_AT_ZERO = {
    id: 'inst-presence-hit',
    name: '常命中指令',
    fields: [
        {   // ref 默认 0；下方 gated 的 expect 同为 0 → 一渲染即命中
            id: 'cmd', name: '命令字', op_code: 'INPUT', byte_len: 1, sequence: 0,
            parameter_config: { type: 'number' }
        },
        {
            id: 'gated', name: '原始Hex', op_code: 'HEX_RAW', byte_len: 1, sequence: 1,
            parameter_config: { hex: 'FF', presence: { ref_id: 'cmd', expect: '0' } }
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

const text = () => document.body.textContent || '';

describe('InstructionRunner · presence 状态表装配（R33：判定驱动显隐）', () => {
    it('初始即命中 → 字段行出 IF(hit) 角标 + 判定式 title，且无 SKIP（表已接线）', async () => {
        setupWith(INSTRUCTION_HIT_AT_ZERO);
        const chip = await waitFor(() => {
            const el = document.querySelector('[data-runner-presence-chip]');
            expect(el).toBeTruthy();
            return el;
        });
        expect(chip.getAttribute('data-runner-presence-chip')).toBe('hit');
        expect(chip.getAttribute('title')).toContain('条件字段：[cmd] == 0');
        expect(chip.getAttribute('title')).toContain('命中 → 发射本字段');
        expect(document.querySelector('[data-runner-presence-skip]')).toBeNull();
        expect(text()).toContain('原始Hex');
    });

    it('默认输入 0 → 未命中 → 字段行完全不出；改 ref 命中才出现、改回又消失（双向翻转）', async () => {
        setup();
        await waitFor(() => expect(text()).toContain('命令字'));
        // 起点：未命中 → 纯隐藏，且不留任何 R29 时代的形态残迹
        expect(text()).not.toContain('原始Hex');
        expect(document.querySelector('[data-runner-presence-chip]')).toBeNull();
        expect(document.querySelector('[data-runner-presence-skip]')).toBeNull();

        // cmd 是首行输入（字段序 0）；显示形态由 resolveFieldDisplay 决定，
        // 这里只按位置取，不钉死它渲染成 hex 还是 number 通道。
        fireEvent.change(document.querySelector('input'), { target: { value: '1' } });

        const chip = await waitFor(() => {
            const el = document.querySelector('[data-runner-presence-chip]');
            expect(el).toBeTruthy();
            return el;
        });
        expect(chip.getAttribute('data-runner-presence-chip')).toBe('hit');
        expect(chip.getAttribute('title')).toContain('命中 → 发射本字段');
        expect(text()).toContain('原始Hex');

        // 改回 0 → 再次未命中 → 字段行收起（无陈旧 DOM 残留）
        fireEvent.change(document.querySelector('input'), { target: { value: '0' } });
        await waitFor(() => expect(text()).not.toContain('原始Hex'));
        expect(document.querySelector('[data-runner-presence-chip]')).toBeNull();
    });

    it('未配置 presence 的 ref 自己不出角标（只有 gated 有章）', async () => {
        setupWith(INSTRUCTION_HIT_AT_ZERO);
        await waitFor(() => expect(document.querySelector('[data-runner-presence-chip]')).toBeTruthy());
        const chips = document.querySelectorAll('[data-runner-presence-chip]');
        expect(chips.length).toBe(1); // 只有 gated，cmd 不配 presence
    });

    it('隐藏是纯展示层：LEN 随判定走，不因字段被藏而丢字节', async () => {
        setup();
        const lenOf = () => {
            const m = text().match(/LEN:\s*(\d+)\s*BYTES/);
            return m ? Number(m[1]) : null;
        };
        await waitFor(() => expect(lenOf()).not.toBeNull());
        const before = lenOf();   // gated 未命中 → 0 字节

        fireEvent.change(document.querySelector('input'), { target: { value: '1' } });
        await waitFor(() => expect(document.querySelector('[data-runner-presence-chip]')).toBeTruthy());
        expect(lenOf()).toBe(before + 1);   // 命中 → 多发 1 字节，隐藏与否不改编码
    });
});

// ─── R30 (§8.62) → R32 (§8.64): 补零/进制差异的**端到端可见** ────────────────
// 样本 ②：面板 expect 存字符串 "01"、ref 当前值是数值 1 —— R30 时代 String 归一
// 判不等 → 恒未命中；R32 拍板归一后两者**判命中**，注记挂在命中侧（「字符串不
// 一样为什么还命中」）。R33 后加工页的未命中侧不再渲染，故「真·不同值」这一支
// 改锁**字段不出现**（若归一误判成命中，字段会冒出来 + 注记也会冒出来）。
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

    it('默认值 0 vs expect "01"（真·不同值）→ 未命中 → 字段隐藏、全页无归一注记', async () => {
        setupWith(HEXPAD);
        await waitFor(() => expect(text()).toContain('命令字'));
        expect(text()).not.toContain('原始Hex');
        expect(document.querySelector('[data-runner-presence-chip]')).toBeNull();
        expect(text()).not.toContain('按十六进制归一判等');
    });

    it('ref 改成 1 → R32 归一判**命中**，字段出现、title 出「按十六进制归一判等」、无 SKIP', async () => {
        setupWith(HEXPAD);
        await waitFor(() => expect(text()).toContain('命令字'));

        fireEvent.change(document.querySelector('input'), { target: { value: '1' } });

        const chip = await waitFor(() => {
            const el = document.querySelector('[data-runner-presence-chip]');
            expect(el).toBeTruthy();
            return el;
        });
        expect(chip.getAttribute('data-runner-presence-chip')).toBe('hit');
        expect(chip.getAttribute('title')).toContain('按十六进制归一判等');
        expect(chip.getAttribute('title')).toContain('expect "01"');
        expect(chip.getAttribute('title')).toContain('命中 → 发射本字段');
        expect(chip.getAttribute('title')).not.toContain('未命中 → 0 字节（本帧不发）');
        expect(document.querySelector('[data-runner-presence-skip]')).toBeNull(); // 命中 → 不再跳段
        expect(text()).toContain('原始Hex');
    });
});
