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
    it('group card: center shows Σ, footer shows bytes before offset, width follows Σ extent', () => {
        const { container } = renderBlock({
            name: '状态块',
            op_code: 'ARRAY_GROUP',
            byte_len: 0,
            offsetMeta: { offset: 2, size: 4, isGroup: true },
        });

        expect(centerOf(container).textContent).toBe('4B');

        // Order: bytes (`4B`) come before the offset badge (`@02..`)
        const offsetSpan = offsetSpanOf(container);
        expect(offsetSpan).toBeTruthy();
        expect(offsetSpan.textContent).toBe('@02..');
        expect(offsetSpan.previousElementSibling.textContent).toBe('4B');

        // Σ-driven width: 4B × 40px
        expect(cardOf(container).style.width).toBe('160px');
    });

    it('group card without the ruler falls back to the lanes-injected computedValue', () => {
        const { container } = renderBlock({
            name: '状态块',
            op_code: 'ARRAY_GROUP',
            parameter_config: { computedValue: '4B' },
        });

        expect(centerOf(container).textContent).toBe('4B');
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
});
