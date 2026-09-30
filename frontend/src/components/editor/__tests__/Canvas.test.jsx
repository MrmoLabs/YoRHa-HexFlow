import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Canvas from '../Canvas';

// 验证反馈批次：校验清单经 Canvas 按 blockId 映射到每张卡（Block.issue）。
// 蓝图/编排页不传 validationIssues → 空映射，卡片现状不变。
const lanes = [{
    depth: 0,
    parentId: null,
    parentName: 'P',
    items: [
        { id: 'a', label: '帧头', type: 'fixed', byte_length: 1, hex_value: 'FA' },
        { id: 'b', label: '载荷', type: 'slot', byte_length: 1 },
    ],
}];

describe('Canvas 校验标色透传', () => {
    it('errors/warnings 按 blockId 映射到对应卡（红/琥珀角标 + 消息 title）', () => {
        const { container } = render(
            <Canvas
                lanes={lanes}
                validationIssues={{
                    errors: [{ blockId: 'a', code: 'HEX_LENGTH', message: '「帧头」HEX 长度与字节长度不符' }],
                    warnings: [{ blockId: 'b', code: 'HEX_EMPTY', message: '「载荷」HEX 值为空' }],
                }}
            />
        );
        const chipA = container.querySelector('#block-a [data-issue-chip]');
        const chipB = container.querySelector('#block-b [data-issue-chip]');
        expect(chipA).toBeTruthy();
        expect(chipA.getAttribute('data-issue-chip')).toBe('error');
        expect(chipA.getAttribute('title')).toContain('HEX 长度');
        expect(chipB).toBeTruthy();
        expect(chipB.getAttribute('data-issue-chip')).toBe('warning');
        expect(chipB.getAttribute('title')).toContain('HEX 值为空');
    });

    it('不传 validationIssues（蓝图/编排页口径）→ 全卡无角标', () => {
        const { container } = render(<Canvas lanes={lanes} />);
        expect(container.querySelector('[data-issue-chip]')).toBeNull();
    });

    it('清单为空 → 无角标；后续编辑新增问题实时点亮（prop 驱动）', () => {
        const { container, rerender } = render(
            <Canvas lanes={lanes} validationIssues={{ errors: [], warnings: [] }} />
        );
        expect(container.querySelector('[data-issue-chip]')).toBeNull();

        rerender(
            <Canvas lanes={lanes} validationIssues={{
                errors: [{ blockId: 'b', code: 'BIT_OVERLAP', message: '「载荷」位域重叠' }],
                warnings: [],
            }} />
        );
        const chip = container.querySelector('#block-b [data-issue-chip]');
        expect(chip).toBeTruthy();
        expect(chip.getAttribute('data-issue-chip')).toBe('error');
    });
});
