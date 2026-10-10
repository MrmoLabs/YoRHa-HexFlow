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

// R71（§8.102 三 · 位视图帧级 chrome）：含 sub-byte/bit 定义帧（hasSubByte）
// → 帧头显「Σ 真实 bit → 打包字节 · 尾 PAD」、帧尾出 PAD 灰标（打包补零不承载
// 字段）；纯字节帧 hasSubByte=false 两件都不渲染（零扰动）。
const bitLanes = [{
    depth: 0,
    parentId: null,
    parentName: 'FRAME',
    items: [
        { id: 'head', label: '主导头', type: 'bitfield', byte_length: 2, bit_len: 10,
            bits: [{ id: 'v', bit_name: 'VER', start_bit: 0, bit_len: 10, default_val: 0x295 }] },
    ],
}];
const bitLayout = (over = {}) => ({
    blocks: new Map([['head', { bitOffset: 0, bitWidth: 10, isContainer: false }]]),
    totalBits: 10, hasSubByte: true, packedBytes: 2, tailPadBits: 6,
    ...over,
});

describe('Canvas（R71 位视图帧级 chrome）', () => {
    it('含 sub-byte 帧：帧头显 Σ10b → 2B · PAD 6b；帧尾出 PAD 灰标（6b）', () => {
        const { container } = render(<Canvas lanes={bitLanes} bitLayout={bitLayout()} />);
        const summary = container.querySelector('[data-testid="frame-bit-summary"]');
        expect(summary).toBeTruthy();
        expect(summary.textContent).toContain('Σ 10b');
        expect(summary.textContent).toContain('→ 2B');
        expect(summary.textContent).toContain('PAD 6b');
        const pad = container.querySelector('[data-testid="frame-tail-pad"]');
        expect(pad).toBeTruthy();
        expect(pad.textContent).toContain('PAD');
        expect(pad.textContent).toContain('6b');
        // 帧尾灰标挂在根泳道（帧卡流）末尾，与缺块 GAP 卡同视觉语言（虚线）
        expect(pad.className).toContain('border-dashed');
    });

    it('纯字节帧（hasSubByte=false）→ 帧头摘要与帧尾灰标都不渲染（零扰动）', () => {
        const { container } = render(
            <Canvas lanes={lanes} bitLayout={bitLayout({ hasSubByte: false, tailPadBits: 0 })} />
        );
        expect(container.querySelector('[data-testid="frame-bit-summary"]')).toBeNull();
        expect(container.querySelector('[data-testid="frame-tail-pad"]')).toBeNull();
    });

    it('hasSubByte 但 tailPad=0（整字节收尾）→ 帧头摘要不带 PAD 段、帧尾无灰标', () => {
        const { container } = render(
            <Canvas lanes={bitLanes} bitLayout={bitLayout({ totalBits: 16, tailPadBits: 0 })} />
        );
        const summary = container.querySelector('[data-testid="frame-bit-summary"]');
        expect(summary).toBeTruthy();
        expect(summary.textContent).toContain('Σ 16b');
        expect(summary.textContent).not.toContain('PAD');
        expect(container.querySelector('[data-testid="frame-tail-pad"]')).toBeNull();
    });
});
