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

// 指令加工编辑反馈（第 4 批 #1/#4）：TIME 字段取值形态 + 定长输入限制。
describe('SmartInput 第 4 批：TIME 取值形态 + 定长限制', () => {
    it('#1 pickerMode：DOM 仍只读，但徽标 [TIME_PICKER]（非 [READ_ONLY]）、实线无斜纹、标签满亮', () => {
        render(
            <SmartInput
                label="运行秒数" value="2026-01-01 00:00:00" readOnly pickerMode
                type="text" onChange={() => {}}
            />
        );

        const input = screen.getByDisplayValue('2026-01-01 00:00:00');
        expect(input.readOnly).toBe(true); // 键入仍禁止（值走日期选择器）
        expect(screen.getByText('[TIME_PICKER]')).toBeTruthy();
        expect(screen.queryByText('[READ_ONLY]')).toBeNull();
        expect(input.className).not.toContain('border-dashed');
        expect(input.className).toContain('cursor-pointer');
        expect(input.style.backgroundImage).toBe(''); // 无锁定斜纹
        // 标签不降 40% 灰（可交互对象满亮）
        expect(screen.getByText('运行秒数').className).not.toContain('/40');
    });

    it('#1 pickerMode：点击行触发 onSelect（字节定位联动），且不触发 onChange', () => {
        const onSelect = vi.fn();
        const onChange = vi.fn();
        render(
            <SmartInput
                label="运行秒数" value="2026-01-01 00:00:00" readOnly pickerMode
                type="text" onChange={onChange} onSelect={onSelect}
            />
        );

        fireEvent.click(screen.getByText('[TIME_PICKER]'));
        expect(onSelect).toHaveBeenCalledTimes(1);

        fireEvent.change(screen.getByDisplayValue('2026-01-01 00:00:00'), { target: { value: '123' } });
        expect(onChange).not.toHaveBeenCalled();
    });

    it('#4 hex maxLength：超长字符截断（缓冲与回调同步）+ 徽标 n/N BYTES', () => {
        const onChange = vi.fn();
        render(<SmartInput label="命令字" value="0" type="hex" maxLength={2} byteLen={1} onChange={onChange} />);

        const input = screen.getByDisplayValue('0');
        fireEvent.change(input, { target: { value: 'AABB' } });
        expect(onChange).toHaveBeenCalledWith('AA');
        expect(input.value).toBe('AA');
        expect(screen.getByText('1/1 BYTES')).toBeTruthy();

        // 未超限不改动
        fireEvent.change(input, { target: { value: '0F' } });
        expect(onChange).toHaveBeenLastCalledWith('0F');
        expect(screen.getByText('1/1 BYTES')).toBeTruthy();
    });

    it('#4 number min/max：超界即时钳制（本地缓冲与回调同步）+ 徽标 [nB]', () => {
        const onChange = vi.fn();
        render(<SmartInput label="计数" value="5" type="number" min={0} max={255} byteLen={1} onChange={onChange} />);

        const input = screen.getByDisplayValue('5');
        fireEvent.change(input, { target: { value: '999' } });
        expect(onChange).toHaveBeenCalledWith(255);
        expect(input.value).toBe('255');
        expect(screen.getByText('[1B]')).toBeTruthy();

        fireEvent.change(input, { target: { value: '-3' } });
        expect(onChange).toHaveBeenLastCalledWith(0);
    });

    it('#4 不误伤：无 byteLen 的可编辑 hex 徽标仍 [HEX]', () => {
        render(<SmartInput label="自由位" value="AB" type="hex" onChange={() => {}} />);
        expect(screen.getByText('[HEX]')).toBeTruthy();
        expect(screen.queryByText(/BYTES/)).toBeNull();
    });
});

// 批 1：字段级十进制录入（加工页 decimal 通道）。
describe('SmartInput 批 1：十进制通道', () => {
    it('decimal 通道：输入按十进制解析发数值（不回退 hex 解析）+ 徽标 [DEC]', () => {
        const onChange = vi.fn();
        render(<SmartInput label="速度" value="255" type="decimal" onChange={onChange} />);

        const input = screen.getByDisplayValue('255');
        fireEvent.change(input, { target: { value: '10' } });
        expect(onChange).toHaveBeenCalledWith(10); // 10 是十进制 10（hex 通道下才是 16）
        expect(screen.getByText('[DECIMAL]')).toBeTruthy();
    });

    it('decimal 通道 + byteLen：min/max 钳制 + 徽标按值折算字节 [nB]', () => {
        const onChange = vi.fn();
        render(<SmartInput label="速度" value="5" type="decimal" min={0} max={255} byteLen={1} onChange={onChange} />);

        const input = screen.getByDisplayValue('5');
        fireEvent.change(input, { target: { value: '300' } });
        expect(onChange).toHaveBeenCalledWith(255);
        expect(input.value).toBe('255');
        expect(screen.getByText('[1B]')).toBeTruthy();

        // 0 值 → 0 位 → 徽标仍为字段字节上限（[nB] 语义是上限提示，非已用量）
        fireEvent.change(input, { target: { value: '0' } });
        expect(onChange).toHaveBeenLastCalledWith(0);
    });

    it('decimal 通道：负数域（INT_SIGNED）不被误钳成 0', () => {
        const onChange = vi.fn();
        render(<SmartInput label="温度" value="0" type="decimal" min={-128} max={127} byteLen={1} onChange={onChange} />);

        const input = screen.getByDisplayValue('0');
        fireEvent.change(input, { target: { value: '-40' } });
        expect(onChange).toHaveBeenLastCalledWith(-40);
    });
});

// 优化批 1（市场调研后优化）：三态进制 HEX/DEC/BIN + 前缀识别
// （Wireshark / 010 Editor 惯例：0x / 0b 前缀按前缀取进制，前缀只是输入糖）。
describe('SmartInput 优化批 1：BIN 通道与进制前缀', () => {
    it('binary 通道：[01] 过滤 → 二进制解析发数值；01 外字符不产 NaN', () => {
        const onChange = vi.fn();
        render(<SmartInput label="掩码" value="00000000" type="binary" byteLen={1} maxLength={8} onChange={onChange} />);

        const input = screen.getByDisplayValue('00000000');
        fireEvent.change(input, { target: { value: '11110000' } });
        expect(onChange).toHaveBeenLastCalledWith(240);
        // 定长徽标按位计（n/N BITS）
        expect(screen.getByText('8/8 BITS')).toBeTruthy();

        fireEvent.change(input, { target: { value: '1012' } }); // '2' 被过滤 → '101'
        expect(onChange).toHaveBeenLastCalledWith(5);
    });

    it('binary 通道：0b 前缀输入糖 + 超位宽截断', () => {
        const onChange = vi.fn();
        render(<SmartInput label="掩码" value="00000000" type="binary" byteLen={1} maxLength={8} onChange={onChange} />);

        const input = screen.getByDisplayValue('00000000');
        fireEvent.change(input, { target: { value: '0b1010' } });
        expect(onChange).toHaveBeenLastCalledWith(10);
        fireEvent.change(input, { target: { value: '111111111' } }); // 9 位 → 截 8
        expect(onChange).toHaveBeenLastCalledWith(255);
    });

    it('hex 通道：0x/0X 前缀容忍并归一纯 hex（maxLength 不吃前缀；前缀进行中不发半截值）', () => {
        const onChange = vi.fn();
        render(<SmartInput label="命令" value="00" type="hex" maxLength={2} byteLen={1} onChange={onChange} />);

        const input = screen.getByDisplayValue('00');
        fireEvent.change(input, { target: { value: '0x1A' } });
        expect(onChange).toHaveBeenLastCalledWith('1A');
        fireEvent.change(input, { target: { value: '0X1ABC' } });
        expect(onChange).toHaveBeenLastCalledWith('1A');

        // 前缀进行中（'0x'）：保留缓冲、不发半截值
        onChange.mockClear();
        fireEvent.change(input, { target: { value: '0x' } });
        expect(onChange).not.toHaveBeenCalled();
        expect(input.value).toBe('0x');
    });

    it('dec 通道：0x/0b 前缀按前缀进制解析并数值域钳制（宽容解析锁定）', () => {
        const onChange = vi.fn();
        render(<SmartInput label="计数" value="0" type="decimal" min={0} max={255} byteLen={1} onChange={onChange} />);

        const input = screen.getByDisplayValue('0');
        fireEvent.change(input, { target: { value: '0xFF' } });
        expect(onChange).toHaveBeenLastCalledWith(255);
        fireEvent.change(input, { target: { value: '0b10100000' } });
        expect(onChange).toHaveBeenLastCalledWith(160);
        fireEvent.change(input, { target: { value: '0x1FF' } }); // 511 → 钳 255
        expect(onChange).toHaveBeenLastCalledWith(255);
        expect(input.value).toBe('255');
    });

    it('binary 无定长 → [BINARY] 徽标（hex/dec 徽标口径不变）', () => {
        const { unmount } = render(<SmartInput label="自由位" value="1010" type="binary" onChange={() => {}} />);
        expect(screen.getByText('[BINARY]')).toBeTruthy();
        unmount();

        render(<SmartInput label="命令" value="AA" type="hex" onChange={() => {}} />);
        expect(screen.getByText('[HEX]')).toBeTruthy();
    });
});

// R46（PLAN §8.78）：TIME 字段「开时间配置弹窗」的点击范围**收窄到值区**。
// 反馈原话：现在点整行（标签 / 右徽标 / 值区任意处）都会弹时间配置，只希望
// 点**值区**那块才弹。字节定位选中（onSelect）仍是全行语义 —— 不在此批改动内。
describe('SmartInput R46：时间配置弹窗只由值区触发', () => {
    const TIME_PROPS = {
        label: '运行秒数', value: '2026-01-01 00:00:00',
        readOnly: true, pickerMode: true, type: 'text',
    };
    const setup = () => {
        const onClick = vi.fn();
        const onSelect = vi.fn();
        render(<SmartInput {...TIME_PROPS} onChange={() => {}} onClick={onClick} onSelect={onSelect} />);
        return { onClick, onSelect };
    };

    it('点值区（取值框）→ 触发 onClick 开弹窗，onSelect 照旧', () => {
        const { onClick, onSelect } = setup();

        fireEvent.click(screen.getByDisplayValue('2026-01-01 00:00:00'));
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('点标签 → 不触发 onClick（只 onSelect：字节定位照旧）', () => {
        const { onClick, onSelect } = setup();

        fireEvent.click(screen.getByText('运行秒数'));
        expect(onClick).not.toHaveBeenCalled();
        expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('点右徽标 [TIME_PICKER] → 不触发 onClick（只 onSelect）', () => {
        const { onClick, onSelect } = setup();

        fireEvent.click(screen.getByText('[TIME_PICKER]'));
        expect(onClick).not.toHaveBeenCalled();
        expect(onSelect).toHaveBeenCalledTimes(1);
    });
});
