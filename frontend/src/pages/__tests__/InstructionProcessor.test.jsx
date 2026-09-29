import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import InstructionProcessor from '../InstructionProcessor';

// 批次一 (D4-A): 加工页 wrap 状态机（ok / none / failed / missing 降级裸发）
// + 封装预览 300ms 防抖 compileWrapped + TRANSMIT / TransactionPanel 双路带 wrap。

vi.mock('../../api', () => ({
    api: {
        getBindings: vi.fn(),
        getOperatorTemplates: vi.fn(),
        dispatchPayload: vi.fn(),
        compileWrapped: vi.fn(),
        getResponseSpec: vi.fn(),
        saveResponseSpec: vi.fn(),
        sendTransaction: vi.fn(),
        exportHexFile: vi.fn()
    }
}));

import { api } from '../../api';

const PROTOCOLS = [{
    id: 'p-1', label: '外壳协议', type: 'container',
    children: [
        { id: 'h', label: '帧头', type: 'fixed', byte_length: 1, hex_value: 'AA', children: [] },
        { id: 's', label: '槽', type: 'slot', byte_length: 0, children: [] }
    ]
}];

const INSTRUCTIONS = [
    {
        id: 'inst-1', name: '开门指令',
        fields: [
            { id: 'f1', parent_id: null, sequence: 0, name: '命令字',
                op_code: 'HEX_RAW', byte_length: 1, parameter_config: { hex: '01' } }
        ]
    },
    { id: 'inst-2', name: '关门指令', fields: [] },
    // 第 4 批：定长可编辑 hex（h1）+ TIME 字段（h2）
    {
        id: 'inst-3', name: '心跳指令',
        fields: [
            { id: 'h1', parent_id: null, sequence: 0, name: '命令字',
                op_code: 'INPUT', byte_length: 1, parameter_config: {} },
            { id: 'h2', parent_id: null, sequence: 1, name: '运行秒数',
                op_code: 'TIME_ACCUMULATOR', byte_length: 4,
                parameter_config: { base_time: '2026-01-01T00:00:00' } }
        ]
    },
    // 第 4 批 #2 修复回归：两层嵌套（头组 > 内组 > 叶）+ 根级叶
    // 字节序：段头 AA [0,1) · 段尾 00 [1,2) · 尾字节 00 [2,3)
    {
        id: 'inst-4', name: '嵌套指令',
        fields: [
            { id: 'g1', parent_id: null, sequence: 0, name: '头组',
                op_code: 'BLOCK', parameter_config: {}, byte_length: 0 },
            { id: 'g2', parent_id: 'g1', sequence: 0, name: '内组',
                op_code: 'BLOCK', parameter_config: {}, byte_length: 0 },
            { id: 'n1', parent_id: 'g2', sequence: 0, name: '段头',
                op_code: 'HEX_RAW', byte_length: 1, parameter_config: { hex: 'AA' } },
            { id: 'n2', parent_id: 'g2', sequence: 1, name: '段尾',
                op_code: 'INPUT', byte_length: 1, parameter_config: {} },
            { id: 'n3', parent_id: null, sequence: 1, name: '尾字节',
                op_code: 'INPUT', byte_length: 1, parameter_config: {} }
        ]
    }
];

const DEFAULT_ROW = {
    id: 'b-1', protocol_id: 'p-1', instruction_id: 'inst-1',
    label: '默认封装', slot_order: 0, slot_id: 's', is_default: true, priority: 0
};

const OK_RECORD = {
    id: 1700000000001,
    timestamp: '2026-09-24T00:00:00Z',
    channel: 'LOOPBACK',
    status: 'OK',
    byte_count: 3,
    hex_string: 'AA 00 01',
    instruction_name: '开门指令',
    instruction_id: 'inst-1',
    spec_source: 'default',
    broadcast: false,
    echo: 'AA0001',
    attempts: [
        { n: 1, status: 'OK', sent: 'AA 00 01', received: 'AA 00 01', rtt_ms: 0.4, reasons: [], error: null }
    ],
    stats: { attempts: 1, rtt_ms_last: 0.4, rtt_ms_avg: 0.4, rtt_ms_max: 0.4 }
};

const renderPage = (protocols = PROTOCOLS) => render(
    <InstructionProcessor
        instructions={INSTRUCTIONS}
        setInstructions={vi.fn()}
        reloadInstructions={vi.fn()}
        protocols={protocols}
    />
);

// hook 自动选中首条指令 → 标题与侧栏同名；点选限在侧栏 aside 内消歧
const sidebar = () => within(document.querySelector('aside'));

const selectInstruction = async () => {
    fireEvent.click(await sidebar().findByText('开门指令'));
};

describe('InstructionProcessor wrap 状态机（批次一 D4-A）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.getResponseSpec.mockRejectedValue(
            Object.assign(new Error('nf'), { response: { status: 404 } })
        );
        api.getOperatorTemplates.mockResolvedValue([]);
        api.dispatchPayload.mockResolvedValue({ id: 1, status: 'SENT', byte_count: 3 });
        api.compileWrapped.mockResolvedValue({ hex_string: 'AA 00 01', total_length: 3, warnings: [] });
        api.sendTransaction.mockResolvedValue(OK_RECORD);
    });

    it('ok：默认绑定解析 → 默认开自动预览（300ms 防抖）→ TRANSMIT/事务同带 wrap', async () => {
        api.getBindings.mockResolvedValue([DEFAULT_ROW]);
        renderPage();
        await selectInstruction();

        // 状态机 ok 且开关默认开（挂载按 ?instruction_id= 过滤取 is_default 行）
        await screen.findByText(/WRAP ACTIVE/);
        expect(api.getBindings).toHaveBeenCalledWith('inst-1');

        // 默认开 → 300ms 防抖自动调 compileWrapped（内核 hex + 默认槽）
        await waitFor(() => expect(api.compileWrapped).toHaveBeenCalledTimes(1), { timeout: 2000 });
        expect(api.compileWrapped).toHaveBeenCalledWith({
            protocolId: 'p-1', payloads: ['01'], slotIds: ['s'], startOrder: 0
        });
        // 预览面板回显封装后帧
        await screen.findByText('AA 00 01', undefined, { timeout: 2000 });

        // TRANSMIT 带 wrap（内核载荷出线，后端套壳）
        fireEvent.click(screen.getByRole('button', { name: /TRANSMIT_DATA/ }));
        await waitFor(() => expect(api.dispatchPayload).toHaveBeenCalledTimes(1));
        expect(api.dispatchPayload).toHaveBeenCalledWith('01', '开门指令', {
            protocol_id: 'p-1', slot_id: 's', slot_order: 0
        });

        // TransactionPanel 同带 wrap（开关联动）
        fireEvent.click(screen.getByRole('button', { name: /SEND_TRANSACTION/ }));
        await waitFor(() => expect(api.sendTransaction).toHaveBeenCalledTimes(1));
        expect(api.sendTransaction.mock.calls[0][0].wrap).toEqual({
            protocol_id: 'p-1', slot_id: 's', slot_order: 0
        });
    });

    it('开关切裸发：ok 态点关 → TRANSMIT 带 null 且预览请求被取消', async () => {
        api.getBindings.mockResolvedValue([DEFAULT_ROW]);
        renderPage();
        await selectInstruction();
        await screen.findByText(/WRAP ACTIVE/);

        // 300ms 防抖前点关 → 清定时器，compileWrapped 不发
        fireEvent.click(screen.getByRole('button', { name: /WRAP ●/ }));
        await screen.findByText(/WRAP READY/);
        expect(api.compileWrapped).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /TRANSMIT_DATA/ }));
        await waitFor(() => expect(api.dispatchPayload).toHaveBeenCalledTimes(1));
        expect(api.dispatchPayload).toHaveBeenCalledWith('01', '开门指令', null);
    });

    it('none：无默认行 → 开关禁用、TRANSMIT 裸发且不调 compileWrapped', async () => {
        api.getBindings.mockResolvedValue([]);
        renderPage();
        await selectInstruction();

        await screen.findByText(/NO DEFAULT BINDING/);
        expect(api.getBindings).toHaveBeenCalledWith('inst-1');
        expect(screen.getByRole('button', { name: /WRAP ○/ }).disabled).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: /TRANSMIT_DATA/ }));
        await waitFor(() => expect(api.dispatchPayload).toHaveBeenCalledTimes(1));
        expect(api.dispatchPayload).toHaveBeenCalledWith('01', '开门指令', null);
        expect(api.compileWrapped).not.toHaveBeenCalled();
    });

    it('failed：绑定拉取失败 → 降级裸发并挂失败态', async () => {
        api.getBindings.mockRejectedValue(new Error('backend down'));
        renderPage();
        await selectInstruction();

        await screen.findByText(/BINDING LOAD FAILED/);
        expect(screen.getByRole('button', { name: /WRAP ○/ }).disabled).toBe(true);
    });

    it('missing：默认行协议不在册 → 降级裸发', async () => {
        api.getBindings.mockResolvedValue([{ ...DEFAULT_ROW, protocol_id: 'ghost' }]);
        renderPage();
        await selectInstruction();

        await screen.findByText(/PROTOCOL MISSING/);
        expect(screen.getByRole('button', { name: /WRAP ○/ }).disabled).toBe(true);
    });

    it('换指令 → 按新 instruction_id 重新解析默认绑定', async () => {
        api.getBindings.mockResolvedValue([]);
        renderPage();
        await selectInstruction();
        await waitFor(() => expect(api.getBindings).toHaveBeenCalledWith('inst-1'));

        fireEvent.click(await sidebar().findByText('关门指令'));
        await waitFor(() => expect(api.getBindings).toHaveBeenCalledWith('inst-2'));
    });
});

// 指令加工编辑反馈（第 4 批 #1/#2/#4）：TIME 字段不再标 READ_ONLY、
// 点击字段高亮字节流 + 读数条、定长 hex 截断与 n/N BYTES 徽标。
describe('指令加工编辑反馈（第 4 批）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.getResponseSpec.mockRejectedValue(
            Object.assign(new Error('nf'), { response: { status: 404 } })
        );
        api.getOperatorTemplates.mockResolvedValue([]);
        api.getBindings.mockResolvedValue([]);
        api.dispatchPayload.mockResolvedValue({ id: 1, status: 'SENT', byte_count: 5 });
        api.compileWrapped.mockResolvedValue({ hex_string: '00 00 00 00 00', total_length: 5, warnings: [] });
        api.sendTransaction.mockResolvedValue(OK_RECORD);
    });

    const selectHeartbeat = async () => {
        fireEvent.click(await sidebar().findByText('心跳指令'));
    };

    it('#1 TIME 字段显示 [TIME_PICKER] 而非 [READ_ONLY]（编辑形式仍为日期选择器）', async () => {
        renderPage();
        await selectHeartbeat();

        await screen.findByText('[TIME_PICKER]');
        expect(screen.queryByText('[READ_ONLY]')).toBeNull();
    });

    it('#2 点击字段 → BYTE_STREAM_OUTPUT 高亮对应字节 + 读数条（字段名 · 偏移 · 长度）', async () => {
        renderPage();
        await selectHeartbeat();
        await screen.findByText('BYTE_STREAM_OUTPUT');

        // 运行秒数 = 第 2 字段（1 字节命令字之后 4 字节）→ @0x01-0x04
        fireEvent.click(screen.getByText('运行秒数'));

        const readout = screen.getByTestId('byte-readout');
        expect(readout.textContent).toContain('运行秒数');
        expect(readout.textContent).toContain('0x01-0x04');

        const selected = document.querySelector('[data-byte-segment][data-selected]');
        expect(selected).toBeTruthy();
        expect(selected.getAttribute('data-field-id')).toBe('h2');
        // 段内逐字节 XX XX 分隔（与整帧格式一致，不连写）
        expect(selected.textContent).toBe('00 00 00 00');

        // 未选中段不带 selected 标记
        expect(document.querySelectorAll('[data-byte-segment]').length).toBeGreaterThan(1);
        expect(document.querySelectorAll('[data-byte-segment][data-selected]').length).toBe(1);
    });

    it('#4 定长 hex 字段：徽标 n/N BYTES，超长输入被截断（2 字符 = 1 字节）', async () => {
        renderPage();
        await selectHeartbeat();

        await screen.findByText('1/1 BYTES');
        const input = screen.getByDisplayValue('00');
        fireEvent.change(input, { target: { value: 'AA BB' } });
        expect(input.value).toBe('AA');
    });

    it('#2 修复：嵌套组内点叶字段 → 只高亮该字段自身字节（不被冒泡升成整块）', async () => {
        renderPage();
        fireEvent.click(await sidebar().findByText('嵌套指令'));
        await screen.findByText('BYTE_STREAM_OUTPUT');

        // 段尾 = 内组叶字段，1 字节 @0x01（当前 bug：冒泡到组容器 → 整组高亮）
        fireEvent.click(screen.getByText('段尾'));

        const readout = screen.getByTestId('byte-readout');
        expect(readout.textContent).toContain('段尾');
        expect(readout.textContent).toContain('0x01-0x01');
        expect(readout.textContent).not.toContain('头组');
        expect(readout.textContent).not.toContain('内组');

        const selected = document.querySelectorAll('[data-byte-segment][data-selected]');
        expect(selected.length).toBe(1);
        expect(selected[0].getAttribute('data-field-id')).toBe('n2');
        expect(selected[0].textContent).toBe('00');
    });

    it('#2 修复：点击内组头 → 选中内组整块，不被外层头组覆盖', async () => {
        renderPage();
        fireEvent.click(await sidebar().findByText('嵌套指令'));
        await screen.findByText('BYTE_STREAM_OUTPUT');

        fireEvent.click(screen.getByText('内组'));

        const readout = screen.getByTestId('byte-readout');
        expect(readout.textContent).toContain('内组');
        expect(readout.textContent).not.toContain('头组');
        expect(readout.textContent).toContain('0x00-0x00'); // 段头
        expect(readout.textContent).toContain('0x01-0x01'); // 段尾
        expect(readout.textContent).toContain('2B');

        const selected = document.querySelectorAll('[data-byte-segment][data-selected]');
        expect(selected.length).toBe(2);
    });
});
