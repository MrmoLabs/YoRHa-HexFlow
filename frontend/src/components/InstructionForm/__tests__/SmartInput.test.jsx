import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SmartInput } from '../SmartInput';

// M2 人工验证期反馈：加工页只读字段与非只读字段区分度不够。
// 本组测试锁定视觉区分契约（样式类）与行为契约（readOnly 不触发 onChange）。

describe('SmartInput 只读/可编辑区分度', () => {
    it('只读：原生 readOnly 属性 + 反白 [READ_ONLY] 徽标（不显示类型徽标）', () => {
        render(<SmartInput label="CRC" value="A5" readOnly type="hex" onChange={() => {}} />);

        const input = screen.getByDisplayValue('A5');
        expect(input.readOnly).toBe(true);

        expect(screen.getByText('[READ_ONLY]')).toBeTruthy();
        expect(screen.queryByText('[HEX]')).toBeNull();
    });

    it('只读：斜纹警示填充 + 虚线边框 + 默认光标（锁定板样式）', () => {
        render(<SmartInput label="LEN" value="0000" readOnly type="hex" onChange={() => {}} />);

        const input = screen.getByDisplayValue('0000');
        expect(input.className).toContain('border-dashed');
        expect(input.className).toContain('cursor-default');
        // 行内样式保证深色填充不受 CSS 类顺序影响（CSS 序列化会把 0.10 规范成 0.1）
        expect(input.style.backgroundColor).toBe('rgba(74, 74, 74, 0.1)');
        expect(input.style.backgroundImage).toContain('repeating-linear-gradient');
        // 可编辑态绝不能带虚线
        expect(input.className).not.toContain('border-solid');
    });

    it('可编辑：实线边框 + 文本光标 + 类型徽标（不显示 READ_ONLY）', () => {
        render(<SmartInput label="SPEED" value="01" type="hex" onChange={() => {}} />);

        const input = screen.getByDisplayValue('01');
        expect(input.readOnly).toBe(false);
        expect(input.className).toContain('cursor-text');
        expect(input.className).not.toContain('border-dashed');
        expect(input.style.backgroundImage).toBe('');

        expect(screen.getByText('[HEX]')).toBeTruthy();
        expect(screen.queryByText('[READ_ONLY]')).toBeNull();
    });

    it('标签亮度区分：可编辑满亮、只读降到 40%', () => {
        const { unmount } = render(<SmartInput label="A" value="1" onChange={() => {}} />);
        expect(screen.getByText('A').className).toContain('text-[#4a4a4a]');
        unmount();

        render(<SmartInput label="B" value="1" readOnly onChange={() => {}} />);
        expect(screen.getByText('B').className).toContain('text-[#4a4a4a]/40');
    });

    it('行为锁：readOnly 时不触发 onChange（视觉改造不得改变交互）', () => {
        const onChange = vi.fn();
        render(<SmartInput label="FIXED" value="AA" readOnly type="hex" onChange={onChange} />);

        const input = screen.getByDisplayValue('AA');
        fireEvent.change(input, { target: { value: 'BB' } });
        expect(onChange).not.toHaveBeenCalled();
        expect(input.value).toBe('AA'); // 本地缓冲也不漂移
    });

    it('可编辑 select 下拉在只读时降级为只读 input（行为沿用原实现）', () => {
        const { unmount } = render(
            <SmartInput
                label="MODE"
                value={1}
                type="select"
                options={[{ label: 'ON', value: 1 }, { label: 'OFF', value: 0 }]}
                onChange={() => {}}
            />
        );
        expect(screen.getByRole('combobox')).toBeTruthy();
        unmount();

        render(
            <SmartInput
                label="MODE"
                value={1}
                type="select"
                readOnly
                options={[{ label: 'ON', value: 1 }]}
                onChange={() => {}}
            />
        );
        expect(screen.queryByRole('combobox')).toBeNull();
        expect(screen.getByDisplayValue('1').readOnly).toBe(true);
    });
});
