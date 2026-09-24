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
    { id: 'inst-2', name: '关门指令', fields: [] }
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
