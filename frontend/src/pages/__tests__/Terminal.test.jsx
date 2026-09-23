import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Terminal from '../Terminal';
import { api } from '../../api';

vi.mock('../../api', () => ({
    api: {
        getTransportConfig: vi.fn(),
        setTransportConfig: vi.fn(),
        getTransportStatus: vi.fn(),
        getDispatchHistory: vi.fn(),
        clearDispatchHistory: vi.fn(),
        dispatchPayload: vi.fn()
    }
}));

const CONFIG = {
    mode: 'loopback',
    tcp: { host: '127.0.0.1', port: 9000, connect_timeout_ms: 3000, read_timeout_ms: 2000 },
    serial: { port: 'COM3', baudrate: 9600, bytesize: 8, parity: 'N', stopbits: 1, read_timeout_ms: 2000 }
};

const STATUS = {
    mode: 'loopback',
    connected: true,
    last_error: null,
    events: [{ ts: '2026-09-23T01:00:00+00:00', event: 'connected', detail: '127.0.0.1:9000' }]
};

const RECORDS = [
    {
        id: 101,
        timestamp: '2026-09-23T01:00:00+00:00',
        channel: 'TCP',
        status: 'SENT',
        byte_count: 12,
        hex_string: 'AA 55 01 02 03 04 05 06 07 08 09 0A',
        instruction_name: 'probe',
        echo: 'B1B2B3',
        events: [
            { type: 'raw', hex_string: 'AA 55 01 02 03 04 05 06 07 08 09 0A', message: null },
            { type: 'response', hex_string: 'B1 B2 B3', message: null }
        ]
    },
    {
        id: 102,
        timestamp: '2026-09-23T01:00:01+00:00',
        channel: 'TCP',
        status: 'ERROR',
        byte_count: 4,
        hex_string: 'DE AD BE EF',
        instruction_name: null,
        echo: '',
        events: [
            { type: 'raw', hex_string: 'DE AD BE EF', message: null },
            { type: 'error', hex_string: null, message: 'TCP 连接 127.0.0.1:18899 失败' }
        ]
    }
];

const mountApis = () => {
    api.getTransportConfig.mockResolvedValue(CONFIG);
    api.getTransportStatus.mockResolvedValue(STATUS);
    api.getDispatchHistory.mockResolvedValue(RECORDS);
    api.clearDispatchHistory.mockResolvedValue({ status: 'cleared', remaining: 0 });
};

describe('Terminal Page（E3 通讯调试）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mountApis();
    });

    it('挂载即拉取配置/状态/历史并渲染五区块', async () => {
        render(<Terminal />);

        await waitFor(() => expect(api.getTransportConfig).toHaveBeenCalledTimes(1));
        expect(api.getTransportStatus).toHaveBeenCalledTimes(1);
        expect(api.getDispatchHistory).toHaveBeenCalledWith(50);

        expect(screen.getByText('通讯配置 (TRANSPORT CONFIG)')).toBeDefined();
        expect(screen.getByText('连接状态 (CONNECTION)')).toBeDefined();
        expect(screen.getByText('发送历史 (SEND HISTORY)')).toBeDefined();
        expect(screen.getByText('原始报文 (RAW FRAME)')).toBeDefined();
        expect(screen.getByText('响应与错误日志 (RESPONSE · ERROR)')).toBeDefined();

        // 连接状态 + 默认选中首条：raw dump 尾字节（预览格截断不含 '09 0A'）与 response 各自可见
        expect(screen.getByText('已连接 CONNECTED')).toBeDefined();
        await waitFor(() => {
            expect(screen.getByText(/09 0A/)).toBeDefined();
        });
        expect(screen.getByText('B1 B2 B3')).toBeDefined();
        // 错误日志汇总包含 ERROR 记录原因
        expect(screen.getAllByText(/TCP 连接 127\.0\.0\.1:18899 失败/).length).toBeGreaterThanOrEqual(1);
        // 历史两行 + 预览截断标记
        expect(screen.getByText('DE AD BE EF')).toBeDefined();
        expect(screen.getByText(/\…\+2/)).toBeDefined();
    });

    it('点击历史行切换原始报文与错误详情', async () => {
        render(<Terminal />);
        await waitFor(() => screen.getByText('DE AD BE EF'));

        fireEvent.click(screen.getByText('DE AD BE EF')); // 表格预览格 → 选中 ERROR 记录

        await waitFor(() => {
            expect(screen.getAllByText('DE AD BE EF').length).toBeGreaterThanOrEqual(2); // 表格 + raw dump
        });
        expect(screen.getByText('无响应（发送失败，见下方错误日志）')).toBeDefined();
        expect(screen.queryByText('B1 B2 B3')).toBeNull(); // 响应面板切走
    });

    it('切到 TCP 模式改 host 后应用，patch 数值字段为数字', async () => {
        api.setTransportConfig.mockResolvedValue({
            ...CONFIG,
            mode: 'tcp',
            tcp: { ...CONFIG.tcp, host: '10.0.0.5' }
        });
        render(<Terminal />);
        await waitFor(() => expect(api.getTransportConfig).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole('button', { name: /网络 TCP/ }));
        fireEvent.change(screen.getByPlaceholderText('127.0.0.1'), { target: { value: '10.0.0.5' } });
        fireEvent.click(screen.getByRole('button', { name: /应用配置/ }));

        await waitFor(() => expect(api.setTransportConfig).toHaveBeenCalledTimes(1));
        expect(api.setTransportConfig).toHaveBeenCalledWith({
            mode: 'tcp',
            tcp: { host: '10.0.0.5', port: 9000, connect_timeout_ms: 3000, read_timeout_ms: 2000 },
            serial: { port: 'COM3', baudrate: 9600, bytesize: 8, parity: 'N', stopbits: 1, read_timeout_ms: 2000 }
        });
        await waitFor(() => {
            expect(screen.getByText(/配置已生效：模式 TCP/)).toBeDefined();
        });
        expect(api.getTransportStatus).toHaveBeenCalledTimes(2); // 应用后刷新状态
        expect(screen.getByDisplayValue('10.0.0.5')).toBeDefined(); // 草稿回填生效配置
    });

    it('串口模式暴露参数并按字符串→数字提交（stopbits 1.5）', async () => {
        api.setTransportConfig.mockResolvedValue({
            ...CONFIG,
            mode: 'serial',
            serial: { ...CONFIG.serial, baudrate: 115200, parity: 'E', stopbits: 1.5 }
        });
        render(<Terminal />);
        await waitFor(() => expect(api.getTransportConfig).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole('button', { name: /串口 SERIAL/ }));
        expect(screen.getByText('波特率 BAUDRATE')).toBeDefined();
        expect(screen.getByText('停止位 STOPBITS')).toBeDefined();

        fireEvent.change(screen.getByPlaceholderText('9600'), { target: { value: '115200' } });
        fireEvent.change(screen.getByLabelText(/校验位/), { target: { value: 'E' } });
        fireEvent.change(screen.getByLabelText(/停止位/), { target: { value: '1.5' } });
        fireEvent.click(screen.getByRole('button', { name: /应用配置/ }));

        await waitFor(() => expect(api.setTransportConfig).toHaveBeenCalledTimes(1));
        expect(api.setTransportConfig).toHaveBeenCalledWith({
            mode: 'serial',
            tcp: { host: '127.0.0.1', port: 9000, connect_timeout_ms: 3000, read_timeout_ms: 2000 },
            serial: { port: 'COM3', baudrate: 115200, bytesize: 8, parity: 'E', stopbits: 1.5, read_timeout_ms: 2000 }
        });
    });

    it('发送：合法 hex 启用按钮并回写 SENT，非法 hex 禁用', async () => {
        api.dispatchPayload.mockResolvedValue({
            id: 9001,
            timestamp: '2026-09-23T02:00:00+00:00',
            channel: 'LOOPBACK',
            status: 'SENT',
            byte_count: 2,
            hex_string: '01 02',
            instruction_name: null,
            echo: '0102',
            events: [
                { type: 'raw', hex_string: '01 02', message: null },
                { type: 'response', hex_string: '01 02', message: null }
            ]
        });
        render(<Terminal />);
        await waitFor(() => expect(api.getDispatchHistory).toHaveBeenCalledTimes(1));

        const sendButton = screen.getByRole('button', { name: /发送 \(SEND\)/ });
        expect(sendButton.disabled).toBe(true);

        const input = screen.getByPlaceholderText(/HEX 输入/);
        fireEvent.change(input, { target: { value: 'ABC' } });
        expect(sendButton.disabled).toBe(true); // 奇数位

        fireEvent.change(input, { target: { value: '01 02' } });
        expect(sendButton.disabled).toBe(false);
        expect(screen.getByText('2 B')).toBeDefined(); // 字节预览

        fireEvent.click(sendButton);
        await waitFor(() => expect(api.dispatchPayload).toHaveBeenCalledWith('01 02', null));
        await waitFor(() => {
            expect(screen.getByText(/SENT id=9001 · LOOPBACK · 2 字节/)).toBeDefined();
        });
        expect(api.getDispatchHistory).toHaveBeenCalledTimes(2); // 发送后刷新
        expect(api.getTransportStatus).toHaveBeenCalledTimes(2);
    });

    it('清空历史需确认；挂载失败时三处错误可见', async () => {
        render(<Terminal />);
        await waitFor(() => screen.getByText('DE AD BE EF'));

        fireEvent.click(screen.getByRole('button', { name: /清空 \(CLEAR\)/ }));
        expect(screen.getByText(/确认清空发送历史/)).toBeDefined();
        expect(api.clearDispatchHistory).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /确认/ }));
        await waitFor(() => expect(api.clearDispatchHistory).toHaveBeenCalledTimes(1));
        await waitFor(() => {
            expect(screen.getByText(/发送历史已清空/)).toBeDefined();
        });
        expect(api.getDispatchHistory).toHaveBeenCalledTimes(2);
    });

    it('挂载失败：三面板各自报错且布局可用', async () => {
        api.getTransportConfig.mockRejectedValue(new Error('network down'));
        api.getTransportStatus.mockRejectedValue(new Error('network down'));
        api.getDispatchHistory.mockRejectedValue(new Error('network down'));

        render(<Terminal />);

        await waitFor(() => {
            expect(screen.getByText('配置不可用')).toBeDefined();
        });
        expect(screen.getByText('状态不可用')).toBeDefined();
        expect(screen.getByText(/ERR: network down/)).toBeDefined();
        expect(screen.getByRole('button', { name: /发送 \(SEND\)/ })).toBeDefined();
        expect(screen.getByRole('button', { name: /刷新 \(REFRESH\)/ })).toBeDefined();
    });
});
