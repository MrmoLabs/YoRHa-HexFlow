import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import Block from '../Block';

const renderBlock = (props) =>
    render(
        <DndContext>
            <Block id="b1" {...props} />
        </DndContext>
    );

// Card root: Block sets `id="block-b1"` on its root div.
const cardOf = (container) => container.querySelector('#block-b1');
// Center value container (unique `flex-1` class on the byte indicator div).
const centerOf = (container) => container.querySelector('.flex-1');
const offsetSpanOf = (container) => container.querySelector('[title^="字节偏移"]');

describe('Block (P1 offset ruler + smart width)', () => {
    it('group card: center shows per-byte unknowns when content is un-injected, footer shows Σ bytes before offset, width follows Σ extent', () => {
        const { container } = renderBlock({
            name: '状态块',
            op_code: 'ARRAY_GROUP',
            byte_len: 0,
            offsetMeta: { offset: 2, size: 4, isGroup: true },
        });

        // 内容未注入 → 中央 = 按尺寸的等量 ??（未知出等量 ?；页脚仍显尺寸 4B）
        expect(centerOf(container).textContent).toBe('?? ?? ?? ??');

        // Order: bytes (`4B`) come before the offset badge (`@02..`)
        const offsetSpan = offsetSpanOf(container);
        expect(offsetSpan).toBeTruthy();
        expect(offsetSpan.textContent).toBe('@02..');
        expect(offsetSpan.previousElementSibling.textContent).toBe('4B');

        // Σ-driven width: 4B × 40px
        expect(cardOf(container).style.width).toBe('160px');
    });

    it('group card without the ruler shows the lanes-injected nested content string', () => {
        const { container } = renderBlock({
            name: '状态块',
            op_code: 'ARRAY_GROUP',
            parameter_config: { computedValue: 'AA 55 ?? ??' },
        });

        expect(centerOf(container).textContent).toBe('AA 55 ?? ??');
        expect(offsetSpanOf(container)).toBeNull();
    });

    it('unknown group size still shows ?? and widens enough to fit `??B @02..`', () => {
        const { container } = renderBlock({
            name: '组',
            op_code: 'ARRAY_GROUP',
            byte_len: 0,
            offsetMeta: { offset: 2, size: null, isGroup: true },
        });

        expect(centerOf(container).textContent).toBe('??');
        expect(screen.getByText('??B')).toBeTruthy();
        // content floor: ceil(9 chars × 5.4) + 20 = 69px > legacy 60px floor
        expect(parseInt(cardOf(container).style.width, 10)).toBeGreaterThanOrEqual(66);
    });

    it('leaf cards keep byte-driven width, 60px floor, and bytes-before-offset footer', () => {
        const twoByte = renderBlock({
            name: '帧头',
            op_code: 'HEX_RAW',
            byte_len: 2,
            offsetMeta: { offset: 0, size: 2 },
        });
        expect(cardOf(twoByte.container).style.width).toBe('80px');
        const offsetSpan = offsetSpanOf(twoByte.container);
        expect(offsetSpan.textContent).toBe('@00');
        expect(offsetSpan.previousElementSibling.textContent).toBe('2B');

        // Isolate the second render (duplicate block id in one document).
        cleanup();
        const oneByte = renderBlock({
            name: '帧尾',
            op_code: 'HEX_RAW',
            byte_len: 1,
            offsetMeta: { offset: 7, size: 1 },
        });
        // content floor for `1B @07` (6ch × 5.4 + 20 ≈ 53) stays under the 60px floor
        expect(cardOf(oneByte.container).style.width).toBe('60px');
    });

    it('long names render single-line complete: label width floor overrides the byte width', () => {
        const { container } = renderBlock({
            name: '长度计算_原始数据块副本',
            op_code: 'HEX_RAW',
            byte_len: 1,
            offsetMeta: { offset: 0, size: 1 },
        });

        const label = container.querySelector('#block-b1 span');
        expect(label.className).toContain('whitespace-nowrap'); // 不换行
        expect(label.parentElement.className).not.toContain('text-ellipsis'); // 不截断

        // 11 CJK + `_`: ceil(11×11.5 + 8 + 6) = 141 → +20 = 161px ≥ 150，
        // 宽度地板被标签撑开，覆盖单行完整显示（byte_len=1 本为 60px）。
        expect(parseInt(cardOf(container).style.width, 10)).toBeGreaterThanOrEqual(150);
    });

    // ─── 卡面取值口径：能确定 → 直接显示；不确定 → 按字节数出等量 ?? ───────
    it('length / checksum cards show per-byte unknowns (2B → "?? ??", not a single ??)', () => {
        const twoByteLen = renderBlock({
            name: '长度', type: 'length', byte_length: 2,
            offsetMeta: { offset: 0, size: 2 },
        });
        expect(centerOf(twoByteLen.container).textContent).toBe('?? ??');

        cleanup();
        const oneByteCrc = renderBlock({
            name: '校验', type: 'checksum', byte_length: 1,
            offsetMeta: { offset: 2, size: 1 },
        });
        expect(centerOf(oneByteCrc.container).textContent).toBe('??');
    });

    it('TIME_ACCUMULATOR renders a BASE line under the center value (configured / unconfigured)', () => {
        const { container } = renderBlock({
            name: '基准时间', op_code: 'TIME_ACCUMULATOR', byte_len: 4,
            parameter_config: { base_time: '2026-09-23T14:00:00Z' },
            offsetMeta: { offset: 0, size: 4 },
        });
        // ISO T 分隔与秒位剥除 → YYYY-MM-DD HH:mm
        expect(container.textContent).toContain('BASE 2026-09-23 14:00');

        cleanup();
        const unconfigured = renderBlock({
            name: '基准时间', op_code: 'TIME_ACCUMULATOR', byte_len: 4,
            offsetMeta: { offset: 0, size: 4 },
        });
        expect(unconfigured.container.textContent).toContain('BASE ?');
    });
});
