import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import BitFieldEditor from '../BitFieldEditor';

// 批 2：位域布局可视化 —— 位网格 + 点击式设段，与下方数值表格双向同步。

const BITS = [
    { id: 'a', bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1 }
];

const cellOf = (bitIndex) => document.querySelector(`[data-bit-cell="${bitIndex}"]`);

describe('BitFieldEditor 位图可视化（批 2）', () => {
    it('渲染 byte_len × 8 位网格（bit0 在最右）', () => {
        render(<BitFieldEditor bits={[]} byteLen={2} onUpdateBits={vi.fn()} />);

        expect(document.querySelectorAll('[data-byte-row]')).toHaveLength(2);
        expect(document.querySelectorAll('[data-bit-cell]')).toHaveLength(16);
        // 第 0 行左端是 bit7（MSB），右端是 bit0（LSB）
        expect(cellOf(7)).toBeTruthy();
        expect(cellOf(0)).toBeTruthy();
    });

    it('已有位段在网格上着色归属（title 回显位名与位域）', () => {
        render(<BitFieldEditor bits={BITS} byteLen={1} onUpdateBits={vi.fn()} />);

        const ownerCell = cellOf(0); // MODE 占 bit0..bit1
        expect(ownerCell.getAttribute('data-owner')).toBe('0');
        expect(ownerCell.getAttribute('title')).toContain('MODE');
        expect(cellOf(2).getAttribute('data-owner')).toBeNull();
    });

    it('点击式设段：点起始格 → 点终止格 → 提交新位段（写入 onUpdateBits）', () => {
        const onUpdateBits = vi.fn();
        render(<BitFieldEditor bits={[]} byteLen={1} onUpdateBits={onUpdateBits} />);

        fireEvent.click(cellOf(4));
        // 已上膛：等待终点（不提交）
        expect(onUpdateBits).not.toHaveBeenCalled();
        expect(document.querySelector('[data-bit-arm]')).toBeTruthy();

        fireEvent.click(cellOf(7));
        expect(onUpdateBits).toHaveBeenCalledTimes(1);
        const next = onUpdateBits.mock.calls[0][0];
        expect(next).toHaveLength(1);
        expect(next[0]).toMatchObject({ start_bit: 4, bit_len: 4, bit_name: 'BIT_4', default_val: 0 });
        expect(next[0].id).toBeTruthy(); // 有稳定 id，表格可编辑
    });

    it('设段方向无关（点高格再点低格）+ 同格 = 1 位段', () => {
        const onUpdateBits = vi.fn();
        const { unmount } = render(<BitFieldEditor bits={[]} byteLen={1} onUpdateBits={onUpdateBits} />);
        fireEvent.click(cellOf(6));
        fireEvent.click(cellOf(5));
        expect(onUpdateBits.mock.calls[0][0][0]).toMatchObject({ start_bit: 5, bit_len: 2 });
        unmount();

        const spy = vi.fn();
        render(<BitFieldEditor bits={[]} byteLen={1} onUpdateBits={spy} />);
        fireEvent.click(cellOf(1));
        fireEvent.click(cellOf(1));
        expect(spy.mock.calls[0][0][0]).toMatchObject({ start_bit: 1, bit_len: 1 });
    });

    it('点已有位段的格子 = 选中该段（表格行高亮同步），不上膛', () => {
        render(<BitFieldEditor bits={BITS} byteLen={1} onUpdateBits={vi.fn()} />);

        fireEvent.click(cellOf(0));
        expect(document.querySelector('[data-bit-arm]')).toBeNull();
        const row = document.querySelector('[data-bit-row="0"]');
        expect(row.getAttribute('data-selected')).toBe('true');
    });

    it('表格行点击 → 网格上对应位段同步选中（双向联动）', () => {
        render(<BitFieldEditor bits={BITS} byteLen={1} onUpdateBits={vi.fn()} />);

        const row = document.querySelector('[data-bit-row="0"]');
        fireEvent.click(within(row).getByDisplayValue('MODE'));
        expect(row.getAttribute('data-selected')).toBe('true');
        expect(cellOf(0).className).toContain('ring-1');
    });

    it('重叠位段：冲突格红标 + 冲突提示行（不静默取一段）', () => {
        render(
            <BitFieldEditor
                bits={[
                    { id: 'a', bit_name: 'A', start_bit: 0, bit_len: 4, default_val: 0 },
                    { id: 'b', bit_name: 'B', start_bit: 2, bit_len: 4, default_val: 0 }
                ]}
                byteLen={1}
                onUpdateBits={vi.fn()}
            />
        );

        expect(cellOf(2).getAttribute('data-conflict')).toBe('true');
        expect(cellOf(3).getAttribute('data-conflict')).toBe('true');
        expect(screen.getByText(/位范围重叠/)).toBeTruthy();
    });

    it('预览：默认打包值 hex + 所需字节超限告警（溢出段在网格上可见）', () => {
        render(
            <BitFieldEditor
                bits={[{ id: 'a', bit_name: 'W', start_bit: 8, bit_len: 8, default_val: 0x12 }]}
                byteLen={1}
                onUpdateBits={vi.fn()}
            />
        );

        // 段在 bit8..bit15（高字节）→ 打包值 0x1200（按所需字节 2B 定宽）
        expect(screen.getByText('0x1200')).toBeTruthy();
        expect(screen.getByText(/TOO SMALL/)).toBeTruthy();
        // 溢出段格子仍渲染（byteCount 跟随 requiredBytes）
        expect(cellOf(15)).toBeTruthy();
    });
});
