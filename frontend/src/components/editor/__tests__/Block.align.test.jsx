import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import Block from '../Block';

// ─── N5 (G4 · PLAN §8.16): 对齐/填充角标（红测先行） ────
// Block 自读 pc.align / pc.pad_to（归一复用 utils/padSpec，零 prop 传递），
// header 加一枚角标：A{align} / P{pad_to} / A4·P8；title 说明补位语义。
// 非法值（≤0 / 超上限）与编码 fail-open 同口径不点亮；与 presence/issue
// 角标同区（宽度地板同吃 contentMin）。画布上「卡片间空隙」即填充字节。

afterEach(cleanup);

const renderBlock = (props) =>
    render(
        <DndContext>
            <Block id="b1" {...props} />
        </DndContext>
    );

const chipOf = (container) => container.querySelector('[data-pad-chip]');

describe('Block 对齐/填充角标', () => {
    it('align=4 → 角标 A4，title 说明起始偏移补位', () => {
        const { container } = renderBlock({
            name: 'PAY',
            byte_len: 2,
            parameter_config: { align: 4 },
        });
        const chip = chipOf(container);
        expect(chip).not.toBeNull();
        expect(chip.textContent).toBe('A4');
        expect(chip.getAttribute('title')).toContain('对齐');
    });

    it('pad_to=8 → 角标 P8，title 说明结束偏移补位', () => {
        const { container } = renderBlock({
            name: 'TAIL',
            byte_len: 2,
            parameter_config: { pad_to: 8 },
        });
        const chip = chipOf(container);
        expect(chip.textContent).toBe('P8');
        expect(chip.getAttribute('title')).toContain('填充');
    });

    it('两者同设 → 同一枚角标显 A4·P8', () => {
        const { container } = renderBlock({
            name: 'BOTH',
            parameter_config: { align: 4, pad_to: 8 },
        });
        expect(chipOf(container).textContent).toBe('A4·P8');
    });

    it('非法 / 未配置 → 无角标（fail-open 同编码口径）', () => {
        const none = renderBlock({ name: 'PLAIN', parameter_config: { hex: 'AA' } });
        expect(chipOf(none.container)).toBeNull();
        cleanup();
        const invalid = renderBlock({ name: 'BAD', parameter_config: { align: 0 } });
        expect(chipOf(invalid.container)).toBeNull();
    });
});
