import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import Block from '../Block';

// ─── N3 (G1 · PLAN §8.16): 条件存在 IF 角标（红测先行） ────
// Block 自读 pc.presence（零 prop 传递），header 加 IF chip，
// title = `条件字段：[ref] == expect`；非法（非对象/数组）不渲染。
// presence 与 issue 标色角标同区（宽度地板同吃 contentMin）。

afterEach(cleanup);

const renderBlock = (props) =>
    render(
        <DndContext>
            <Block id="b1" {...props} />
        </DndContext>
    );

const chipOf = (container) => container.querySelector('[data-presence-chip]');

describe('Block presence IF 角标', () => {
    it('完整 presence → 渲染 IF 角标，title 显判定式', () => {
        const { container } = renderBlock({
            name: 'OPT',
            op_code: 'HEX_RAW',
            byte_len: 1,
            parameter_config: { hex: 'BB', presence: { ref_id: 'cmd', expect: '1' } },
        });
        const chip = chipOf(container);
        expect(chip).not.toBeNull();
        expect(chip.textContent).toBe('IF');
        expect(chip.getAttribute('title')).toBe('条件字段：[cmd] == 1');
    });

    it('数值 expect → title 原样显示', () => {
        const { container } = renderBlock({
            name: 'OPT',
            parameter_config: { presence: { ref_id: 'cmd', expect: 2 } },
        });
        expect(chipOf(container).getAttribute('title')).toBe('条件字段：[cmd] == 2');
    });

    it('不完整 presence（缺 expect）→ 角标仍渲染，缺省位显 ?', () => {
        const { container } = renderBlock({
            name: 'OPT',
            parameter_config: { presence: { ref_id: 'cmd' } },
        });
        expect(chipOf(container).getAttribute('title')).toBe('条件字段：[cmd] == ?');
    });

    it('无 presence → 不渲染角标（存量卡零回归）', () => {
        const { container } = renderBlock({
            name: 'OPT',
            parameter_config: { hex: 'BB' },
        });
        expect(chipOf(container)).toBeNull();
    });

    it('非法 presence（非对象/数组）→ 不渲染角标（与编码 fail-open 同口径）', () => {
        const str = renderBlock({ name: 'A', parameter_config: { presence: 'bad' } });
        expect(chipOf(str.container)).toBeNull();
        cleanup();
        const arr = renderBlock({ name: 'B', parameter_config: { presence: [1] } });
        expect(chipOf(arr.container)).toBeNull();
    });
});
