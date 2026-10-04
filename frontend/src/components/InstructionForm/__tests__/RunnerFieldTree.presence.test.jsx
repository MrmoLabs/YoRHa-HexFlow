import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import RunnerFieldTree from '../RunnerFieldTree';

// R29 (§8.61): 加工页字段树的「条件存在 (PRESENCE)」展示层（红测先行）。
// 锁三件事：① 不传 presenceStates → 零渲染（Sequences 步骤编辑器零改动）；
// ② 命中/未命中两种形态（IF 角标 + [SKIP 0B] + 行降透明）；③ 组级同权、
// SKIP 结论优先于 READ_ONLY（「这行根本不出线」比「这行能不能改」更要紧）。

const baseProps = {
    inputs: {},
    computedValues: {},
    onFieldChange: () => {},
    onOpenDatePicker: () => {},
};

const cmd = {
    id: 'cmd', name: '命令字', op_code: 'INPUT', byte_len: 1,
    parameter_config: { type: 'number' }
};
const gated = {
    id: 'gated', name: '原始Hex', op_code: 'HEX_RAW', byte_len: 1,
    parameter_config: { hex: 'FF' }
};
const branchGroup = {
    id: 'grp', name: '分支A', op_code: 'NONE',
    parameter_config: {},
    fields: [{ id: 'inner', name: '内层', op_code: 'HEX_RAW', byte_len: 1, parameter_config: { hex: 'AA' } }]
};

const HIT = { hit: true, title: '条件字段：[cmd] == 1 · 命中 → 发射本字段' };
const MISS = { hit: false, title: '条件字段：[cmd] == 1 · 未命中 → 0 字节（本帧不发）' };

const chips = (root) => root.querySelectorAll('[data-runner-presence-chip]');
const skips = (root) => root.querySelectorAll('[data-runner-presence-skip]');

describe('RunnerFieldTree · 未传 presenceStates（Sequences 兼容）', () => {
    it('叶 + 组都不渲染 IF / SKIP 任何章', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, { ...gated }, branchGroup]} {...baseProps} />
        );
        expect(chips(container).length).toBe(0);
        expect(skips(container).length).toBe(0);
        expect(container.querySelector('.opacity-50')).toBeNull();
    });

    it('presenceStates 里没有本字段 → 同样不渲染（未配置 ≠ 命中）', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[cmd, gated]}
                {...baseProps}
                presenceStates={{ unrelated: HIT }}
            />
        );
        expect(chips(container).length).toBe(0);
        expect(skips(container).length).toBe(0);
    });
});

describe('RunnerFieldTree · 叶字段命中态', () => {
    it('渲染 IF 角标（hit）+ title 判定式，且不出现 SKIP、不降透明', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[cmd, gated]}
                {...baseProps}
                presenceStates={{ gated: HIT }}
            />
        );
        const chip = container.querySelector('[data-runner-presence-chip]');
        expect(chip).toBeTruthy();
        expect(chip.getAttribute('data-runner-presence-chip')).toBe('hit');
        expect(chip.textContent).toBe('IF');
        expect(chip.getAttribute('title')).toContain('条件字段：[cmd] == 1');
        expect(chip.getAttribute('title')).toContain('命中 → 发射本字段');

        expect(skips(container).length).toBe(0);
        expect(container.querySelector('.opacity-50')).toBeNull();
    });
});

describe('RunnerFieldTree · 叶字段未命中态（0 字节）', () => {
    it('IF 角标标 miss + 右侧 [SKIP 0B] + 行降透明', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[cmd, gated]}
                {...baseProps}
                presenceStates={{ gated: MISS }}
            />
        );
        const chip = container.querySelector('[data-runner-presence-chip]');
        expect(chip.getAttribute('data-runner-presence-chip')).toBe('miss');
        expect(chip.getAttribute('title')).toContain('未命中 → 0 字节（本帧不发）');

        const skip = container.querySelector('[data-runner-presence-skip]');
        expect(skip).toBeTruthy();
        expect(skip.textContent).toBe('[SKIP 0B]');
        expect(skip.getAttribute('title')).toContain('未命中 → 0 字节');

        const row = container.querySelector('.opacity-50');
        expect(row).toBeTruthy();
        expect(row.textContent).toContain('[SKIP 0B]'); // 降透明的正是那条被门掉的行
    });

    it('SKIP 结论优先于 READ_ONLY（只读章被顶掉，不出两个徽标打架）', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[gated]}
                {...baseProps}
                presenceStates={{ gated: MISS }}
            />
        );
        expect(container.textContent).toContain('[SKIP 0B]');
        expect(container.textContent).not.toContain('[READ_ONLY]');
    });

    it('ref 自己（命中支）不受影响：只有配了 presence 的字段出章', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[cmd, gated]}
                {...baseProps}
                presenceStates={{ gated: MISS }}
            />
        );
        expect(chips(container).length).toBe(1);
        expect(skips(container).length).toBe(1);
    });
});

describe('RunnerFieldTree · 组级 presence（同权）', () => {
    it('组命中：组头出 IF(hit)，子树不降透明', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[branchGroup]}
                {...baseProps}
                presenceStates={{ grp: HIT }}
            />
        );
        const chip = container.querySelector('[data-runner-presence-chip]');
        expect(chip).toBeTruthy();
        expect(chip.getAttribute('data-runner-presence-chip')).toBe('hit');
        expect(skips(container).length).toBe(0);
        expect(container.querySelector('.opacity-50')).toBeNull();
    });

    it('组未命中：组头出 IF(miss) + [SKIP 0B]，整棵子树降透明', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[branchGroup]}
                {...baseProps}
                presenceStates={{ grp: MISS }}
            />
        );
        expect(container.querySelector('[data-runner-presence-chip]')
            .getAttribute('data-runner-presence-chip')).toBe('miss');
        expect(container.querySelector('[data-runner-presence-skip]').textContent).toBe('[SKIP 0B]');
        expect(container.querySelector('.opacity-50')).toBeTruthy();
    });

    it('组命中但子字段未命中 → 子字段自己的 SKIP 仍出（父命中不豁免子）', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[branchGroup]}
                {...baseProps}
                presenceStates={{ grp: HIT, inner: MISS }}
            />
        );
        expect(chips(container).length).toBe(2);   // 组头 + 子字段
        expect(skips(container).length).toBe(1);   // 只有子字段 SKIP
    });
});
