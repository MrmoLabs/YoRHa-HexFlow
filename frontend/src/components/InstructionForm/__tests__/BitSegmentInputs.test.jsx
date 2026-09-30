import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import BitSegmentInputs from '../BitSegmentInputs';

// 批 3：加工侧 BITFIELD 子位录入（与整包输入并存）。
// 单一真源 = 字段整数输入值；子位行是派生视图，回写只动本段位。

const BITS = [
    { id: 'a', bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1 },
    { id: 'b', bit_name: 'EN', start_bit: 2, bit_len: 1, default_val: 1 }
];

const row = (name) => screen.getByText(name).closest('[data-bit-seg]');

describe('BitSegmentInputs（加工侧子位录入）', () => {
    it('每个位段一行：位名 + 十进制输入 + 位域注记 [b3..b0] + 取值上限', () => {
        render(<BitSegmentInputs bits={BITS} value={0x0F} onChange={vi.fn()} />);

        const modeRow = row('MODE');
        expect(modeRow).toBeTruthy();
        expect(modeRow.textContent).toContain('[b1..b0]'); // 高位在左
        expect(screen.getByText('[b2..b2]')).toBeTruthy();
        // 上限以数据属性给出（UI 按需提示）
        expect(modeRow.querySelector('input').getAttribute('data-bit-max')).toBe('3');
    });

    it('值回显：来自字段整数（0x0F → MODE=3、EN=1）', () => {
        render(<BitSegmentInputs bits={BITS} value={0x0F} onChange={vi.fn()} />);
        expect(row('MODE').querySelector('input').value).toBe('3');
        expect(row('EN').querySelector('input').value).toBe('1');
    });

    it('无输入态：子位回显 default_val（与整包显示的打包默认值同源）', () => {
        render(<BitSegmentInputs bits={BITS} value={undefined} onChange={vi.fn()} />);
        expect(row('MODE').querySelector('input').value).toBe('1');
        expect(row('EN').querySelector('input').value).toBe('1');
    });

    it('改子位 → 只回写本段（回传单整数，间隙位保留）', () => {
        const onChange = vi.fn();
        render(<BitSegmentInputs bits={BITS} value={0x0F} onChange={onChange} />);

        fireEvent.change(row('MODE').querySelector('input'), { target: { value: '1' } });
        expect(onChange).toHaveBeenCalledWith(0x0D);

        fireEvent.change(row('EN').querySelector('input'), { target: { value: '0' } });
        expect(onChange).toHaveBeenLastCalledWith(0x0B);
    });

    it('越界/非法输入 → 钳制到本段域（不溢出邻段），空串不提交 NaN', () => {
        const onChange = vi.fn();
        render(<BitSegmentInputs bits={BITS} value={0x00} onChange={onChange} />);

        fireEvent.change(row('MODE').querySelector('input'), { target: { value: '9' } });
        expect(onChange).toHaveBeenLastCalledWith(0x03);

        fireEvent.change(row('MODE').querySelector('input'), { target: { value: '' } });
        expect(onChange).toHaveBeenLastCalledWith(0x00);
    });

    it('无合法位段 → 不渲染子位面板（no rows, no empty chrome）', () => {
        const { container } = render(<BitSegmentInputs bits={[]} value={0} onChange={vi.fn()} />);
        expect(container.querySelector('[data-bit-seg]')).toBeNull();
    });
});
