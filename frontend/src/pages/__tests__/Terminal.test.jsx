import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import Terminal from '../Terminal';
import { api } from '../../api';

vi.mock('../../api', () => ({
    api: {
        getTransportConfig: vi.fn(),
        setTransportConfig: vi.fn(),
        getTransportStatus: vi.fn(),
        revertTransportConfig: vi.fn(),
        getTransportPorts: vi.fn(),
        getDispatchHistory: vi.fn(),
        clearDispatchHistory: vi.fn(),
        dispatchPayload: vi.fn(),
        getProfiles: vi.fn(),
        createProfile: vi.fn(),
        updateProfile: vi.fn(),
        deleteProfile: vi.fn(),
        activateProfile: vi.fn(),
        // R20（PLAN §8.50 ②-3）：整表顺序一次提交 → PUT /profiles/order
        reorderProfiles: vi.fn()
    }
}));

const CONFIG = {
    mode: 'loopback',
    tcp: { host: '127.0.0.1', port: 9000, connect_timeout_ms: 3000, read_timeout_ms: 2000 },
    serial: { port: 'COM3', baudrate: 9600, bytesize: 8, parity: 'N', stopbits: 1, read_timeout_ms: 2000 },
    // N4 (G3): 传输层帧字节转义（缺省关闭）
    escape: { enabled: false, pairs: [] }
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

// P1 设备档案夹具：pf-2 激活中且被改过（is_active + modified 徽标各一）。
const PROFILES = [
    { id: 'pf-1', label: '环回基准', config: CONFIG, is_active: false, modified: false },
    {
        id: 'pf-2',
        label: '产线网关',
        config: { ...CONFIG, mode: 'tcp', tcp: { host: '10.1.2.3', port: 502, connect_timeout_ms: 3000, read_timeout_ms: 2000 } },
        is_active: true,
        modified: true
    }
];

// R50（PLAN §8.82 · 2026-10-08）：mock 响应延迟开关 —— 把「等请求不等渲染」这类竞态
// 从**概率性抖动**变成**确定性失败**。缺省 0ms 时与 mockResolvedValue /
// mockRejectedValue 逐字等价；探测跑法：YORHA_API_DELAY_MS=15 npx vitest run
const API_DELAY_MS = Number(globalThis.process?.env?.YORHA_API_DELAY_MS || 0); // eslint 只给了 browser 全局，process 走属性访问
const ok = (fn, value) => fn.mockImplementation(
    () => (API_DELAY_MS > 0
        ? new Promise((resolve) => { setTimeout(() => resolve(value), API_DELAY_MS); })
        : Promise.resolve(value)),
);
const fail = (fn, error) => fn.mockImplementation(
    () => (API_DELAY_MS > 0
        ? new Promise((_, reject) => { setTimeout(() => reject(error), API_DELAY_MS); })
        : Promise.reject(error)),
);

// R50（PLAN §8.82 · 2026-10-08）：挂载后必须等数据回来才断言 / 才操作 —— 组件没有
// loading 门，主界面是同步渲染的，所以「等请求被调用」不等于「数据已上屏」，两者
// 之间的空档就是那 19 条抖动的来源。这里把等待收成一个口子：
//   · 真实定时器：等满 API_DELAY_MS + 1ms（缺省 0ms 时也留一轮 flush）；
//   · fake timers（R15 那类）：setTimeout 不会自己走，直接推进同样时长。
const settle = async () => {
    await act(async () => {
        await new Promise((resolve) => {
            setTimeout(resolve, API_DELAY_MS + 1);
            if (vi.isFakeTimers()) vi.advanceTimersByTime(API_DELAY_MS + 1);
        });
        await Promise.resolve();
    });
};

const renderTerminal = async () => {
    render(<Terminal />);
    await settle();
};

const mountApis = () => {
    ok(api.getTransportConfig, CONFIG);
    ok(api.getTransportStatus, STATUS);
    ok(api.getDispatchHistory, RECORDS);
    ok(api.clearDispatchHistory, { status: 'cleared', remaining: 0 });
    ok(api.getProfiles, PROFILES);
    // R14（PLAN §8.49）：串口端口枚举（只读，挂载即拉一次）
    ok(api.getTransportPorts, {
        ports: [{ device: 'COM1', description: '通信端口' }],
        source: 'pyserial'
    });
};

describe('Terminal Page（E3 通讯调试）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mountApis();
    });

    // R50（PLAN §8.82）：收尾把**在途的异步链排空**再放行下一个测试 —— 否则上一个测试的
    // apply / 更新之类 handler 在下一个测试里才落地，会把 mock 调用记到别人账上（实测：
    // 下一个测试 status 多记 1 次而 history 不多记，正好等于 apply 只刷 status/profiles）。
    afterEach(async () => {
        await settle();
    });

    it('挂载即拉取配置/状态/历史并渲染五区块', async () => {
        await renderTerminal();

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
        expect(screen.getByText(/…\+2/)).toBeDefined();
    });

    it('点击历史行切换原始报文与错误详情', async () => {
        await renderTerminal();
        await waitFor(() => screen.getByText('DE AD BE EF'));

        fireEvent.click(screen.getByText('DE AD BE EF')); // 表格预览格 → 选中 ERROR 记录

        await waitFor(() => {
            expect(screen.getAllByText('DE AD BE EF').length).toBeGreaterThanOrEqual(2); // 表格 + raw dump
        });
        expect(screen.getByText('无响应（发送失败，见下方错误日志）')).toBeDefined();
        expect(screen.queryByText('B1 B2 B3')).toBeNull(); // 响应面板切走
    });

    it('切到 TCP 模式改 host 后应用，patch 数值字段为数字', async () => {
        ok(api.setTransportConfig, {
            ...CONFIG,
            mode: 'tcp',
            tcp: { ...CONFIG.tcp, host: '10.0.0.5' }
        });
        await renderTerminal();
        await waitFor(() => expect(api.getTransportConfig).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole('button', { name: /网络 TCP/ }));
        fireEvent.change(screen.getByPlaceholderText('127.0.0.1'), { target: { value: '10.0.0.5' } });
        fireEvent.click(screen.getByRole('button', { name: /应用配置/ }));

        await waitFor(() => expect(api.setTransportConfig).toHaveBeenCalledTimes(1));
        expect(api.setTransportConfig).toHaveBeenCalledWith({
            mode: 'tcp',
            tcp: { host: '10.0.0.5', port: 9000, connect_timeout_ms: 3000, read_timeout_ms: 2000 },
            serial: { port: 'COM3', baudrate: 9600, bytesize: 8, parity: 'N', stopbits: 1, read_timeout_ms: 2000 },
            escape: { enabled: false, pairs: [] } // N4: escape 段随 patch 全量提交
        });
        await waitFor(() => {
            expect(screen.getByText(/配置已生效：模式 TCP/)).toBeDefined();
        });
        expect(api.getTransportStatus).toHaveBeenCalledTimes(2); // 应用后刷新状态
        expect(screen.getByDisplayValue('10.0.0.5')).toBeDefined(); // 草稿回填生效配置
    });

    it('串口模式暴露参数并按字符串→数字提交（stopbits 1.5）', async () => {
        ok(api.setTransportConfig, {
            ...CONFIG,
            mode: 'serial',
            serial: { ...CONFIG.serial, baudrate: 115200, parity: 'E', stopbits: 1.5 }
        });
        await renderTerminal();
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
            serial: { port: 'COM3', baudrate: 115200, bytesize: 8, parity: 'E', stopbits: 1.5, read_timeout_ms: 2000 },
            escape: { enabled: false, pairs: [] } // N4: escape 段随 patch 全量提交
        });
    });

    it('发送：合法 hex 启用按钮并回写 SENT，非法 hex 禁用', async () => {
        ok(api.dispatchPayload, {
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
        await renderTerminal();
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
        await renderTerminal();
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
        fail(api.getTransportConfig, new Error('network down'));
        fail(api.getTransportStatus, new Error('network down'));
        fail(api.getDispatchHistory, new Error('network down'));

        await renderTerminal();

        await waitFor(() => {
            expect(screen.getByText('配置不可用')).toBeDefined();
        });
        expect(screen.getByText('状态不可用')).toBeDefined();
        expect(screen.getByText(/ERR: network down/)).toBeDefined();
        expect(screen.getByRole('button', { name: /发送 \(SEND\)/ })).toBeDefined();
        expect(screen.getByRole('button', { name: /刷新 \(REFRESH\)/ })).toBeDefined();
    });

    // ---- P1 设备档案 ----

    it('P1: 挂载拉取档案并渲染选项与激活星标', async () => {
        await renderTerminal();
        await waitFor(() => expect(api.getProfiles).toHaveBeenCalledTimes(1));

        expect(screen.getByText('设备档案 (DEVICE PROFILES)')).toBeDefined();
        expect(screen.getByLabelText(/档案 PROFILE/)).toBeDefined();
        // 选项文案 = 名称 · 摘要（激活加 ★），来自 profileOptionLabel 纯函数
        expect(screen.getByText('环回基准 · LOOPBACK')).toBeDefined();
        expect(screen.getByText('产线网关 · TCP 10.1.2.3:502 ★')).toBeDefined();
        expect(screen.getByText(/当前生效 LOOPBACK/)).toBeDefined();
    });

    it('P1: 输入名称存为档案 → createProfile({label}) + 列表刷新 + 输入清空', async () => {
        ok(api.createProfile, {
            id: 'pf-3', label: '新台架', config: CONFIG, is_active: true, modified: false
        });
        await renderTerminal();
        await waitFor(() => screen.getByText('设备档案 (DEVICE PROFILES)'));

        const saveBtn = screen.getByRole('button', { name: /存为档案/ });
        expect(saveBtn.disabled).toBe(true); // 无名称禁用

        fireEvent.change(screen.getByPlaceholderText(/新档案名称/), { target: { value: '新台架' } });
        expect(saveBtn.disabled).toBe(false);
        fireEvent.click(saveBtn);

        await waitFor(() => expect(api.createProfile).toHaveBeenCalledWith({ label: '新台架' }));
        await waitFor(() => expect(api.getProfiles).toHaveBeenCalledTimes(2));
        expect(screen.getByText(/档案已保存：新台架/)).toBeDefined();
        expect(screen.getByPlaceholderText(/新档案名称/).value).toBe('');
    });

    it('P1: 应用档案 → activate 回填生效配置、刷新状态与档案、展示徽标', async () => {
        ok(api.activateProfile, {
            id: 'pf-2',
            label: '产线网关',
            is_active: true,
            modified: false,
            config: {
                ...CONFIG,
                mode: 'tcp',
                tcp: { host: '10.1.2.3', port: 502, connect_timeout_ms: 3000, read_timeout_ms: 2000 }
            }
        });
        await renderTerminal();
        await waitFor(() => screen.getByText('设备档案 (DEVICE PROFILES)'));

        const actBtn = screen.getByRole('button', { name: /应用档案/ });
        expect(actBtn.disabled).toBe(true); // 未选档案禁用

        fireEvent.change(screen.getByLabelText(/档案 PROFILE/), { target: { value: 'pf-2' } });
        fireEvent.click(screen.getByRole('button', { name: /应用档案/ }));

        await waitFor(() => expect(api.activateProfile).toHaveBeenCalledWith('pf-2'));
        await waitFor(() => expect(api.getProfiles).toHaveBeenCalledTimes(2));
        expect(screen.getByText(/档案已应用：产线网关 · 模式 TCP/)).toBeDefined();
        expect(api.getTransportStatus).toHaveBeenCalledTimes(2); // 挂载 1 + 应用后刷新
        // 生效配置回填 → 草稿切到 TCP 表单
        expect(screen.getByRole('button', { name: /网络 TCP/ })).toBeDefined();
        expect(screen.getByDisplayValue('10.1.2.3')).toBeDefined();
        // 选中的激活档案展示徽标（pf-2 夹具 is_active + modified）
        expect(screen.getByText('已激活')).toBeDefined();
        expect(screen.getByText('已修改')).toBeDefined();
    });

    it('P1: 更新写入当前生效配置；删除需确认后才 DELETE', async () => {
        ok(api.updateProfile, {
            id: 'pf-1', label: '环回基准', config: CONFIG, is_active: false, modified: false
        });
        ok(api.deleteProfile, { status: 'deleted', id: 'pf-1' });
        await renderTerminal();
        await waitFor(() => screen.getByText('设备档案 (DEVICE PROFILES)'));

        fireEvent.change(screen.getByLabelText(/档案 PROFILE/), { target: { value: 'pf-1' } });
        fireEvent.click(screen.getByRole('button', { name: /更新 \(UPDATE\)/ }));
        await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith('pf-1', { config: CONFIG }));
        await waitFor(() => expect(screen.getByText(/档案已更新：环回基准/)).toBeDefined());

        // R50：更新要等 refreshProfiles 跑完 busy 才放掉 —— busy 期间按钮文案是「处理中…」，
        // 直接按 /删除档案/ 找不到（与「等请求不等渲染」同族：等的是真上屏，不是调用发生）。
        await waitFor(() => expect(screen.getByRole('button', { name: /删除档案/ })).toBeDefined());
        fireEvent.click(screen.getByRole('button', { name: /删除档案/ }));
        expect(screen.getByText(/确认删除档案/)).toBeDefined();
        expect(api.deleteProfile).not.toHaveBeenCalled(); // 未确认不发 DELETE

        fireEvent.click(screen.getByRole('button', { name: /确认/ }));
        await waitFor(() => expect(api.deleteProfile).toHaveBeenCalledWith('pf-1'));
        await waitFor(() => expect(api.getProfiles).toHaveBeenCalledTimes(3)); // 挂载 + 更新 + 删除
        expect(screen.getByText(/档案已删除：环回基准/)).toBeDefined();
        expect(screen.getByLabelText(/档案 PROFILE/).value).toBe(''); // 选中已清
    });

    it('P1: 档案操作失败显示区内错误条', async () => {
        fail(api.createProfile, new Error('档案名已存在：环回基准'));
        await renderTerminal();
        await waitFor(() => screen.getByText('设备档案 (DEVICE PROFILES)'));

        fireEvent.change(screen.getByPlaceholderText(/新档案名称/), { target: { value: '环回基准' } });
        fireEvent.click(screen.getByRole('button', { name: /存为档案/ }));

        await waitFor(() => expect(screen.getByText(/ERR: 档案名已存在/)).toBeDefined());
    });

    // ---- N4 (G3): 传输层帧字节转义（配置面板） ----

    it('N4: 转义区渲染且缺省关闭、无规则时不显示样例', async () => {
        await renderTerminal();
        await waitFor(() => expect(screen.getByText('帧字节转义 ESCAPE')).toBeDefined());

        expect(screen.getByText('关闭 DISABLED')).toBeDefined();
        expect(screen.getByRole('button', { name: '启用 ON' })).toBeDefined();
        expect(screen.queryByText(/样例 SAMPLE/)).toBeNull();
        expect(screen.queryByText(/未列入受保护字节/)).toBeNull();
    });

    it('N4: 增改规则行 + 启用后随 APPLY 全量提交 escape 段', async () => {
        ok(api.setTransportConfig, {
            ...CONFIG,
            escape: { enabled: true, pairs: [['7D', '7D5D']] }
        });
        await renderTerminal();
        await waitFor(() => expect(screen.getByText('帧字节转义 ESCAPE')).toBeDefined());

        fireEvent.click(screen.getByRole('button', { name: /添加规则/ }));
        fireEvent.change(screen.getAllByPlaceholderText('7D')[0], { target: { value: '7d' } });
        fireEvent.change(screen.getAllByPlaceholderText('7D5D')[0], { target: { value: '7d5d' } });
        fireEvent.click(screen.getByRole('button', { name: '启用 ON' }));

        // 样例预览与 BE 向量同字节：AA 7D BB → AA 7D 5D BB
        await waitFor(() => {
            expect(screen.getByText('AA 7D BB → AA 7D 5D BB')).toBeDefined();
        });

        fireEvent.click(screen.getByRole('button', { name: /应用配置/ }));
        await waitFor(() => expect(api.setTransportConfig).toHaveBeenCalledTimes(1));
        expect(api.setTransportConfig).toHaveBeenCalledWith({
            mode: 'loopback',
            tcp: { host: '127.0.0.1', port: 9000, connect_timeout_ms: 3000, read_timeout_ms: 2000 },
            serial: { port: 'COM3', baudrate: 9600, bytesize: 8, parity: 'N', stopbits: 1, read_timeout_ms: 2000 },
            escape: { enabled: true, pairs: [['7d', '7d5d']] }
        });
        await waitFor(() => expect(screen.getByText('已启用 ENABLED')).toBeDefined());
        // 生效值回填（BE 归一为大写）
        await waitFor(() => expect(screen.getAllByPlaceholderText('7D')[0].value).toBe('7D'));
    });

    it('N4: 删除规则行（多行仅删目标行）', async () => {
        ok(api.getTransportConfig, {
            ...CONFIG,
            escape: { enabled: true, pairs: [['7D', '7D5D'], ['11', '7D31']] }
        });
        await renderTerminal();
        await waitFor(() => expect(screen.getAllByPlaceholderText('7D')).toHaveLength(2));

        fireEvent.click(screen.getAllByRole('button', { name: '删除' })[1]);

        expect(screen.getAllByPlaceholderText('7D')).toHaveLength(1);
        expect(screen.getAllByPlaceholderText('7D5D')[0].value).toBe('7D5D');
    });

    it('N4: 前缀未受保护时面板给出歧义提醒', async () => {
        ok(api.getTransportConfig, {
            ...CONFIG,
            escape: { enabled: true, pairs: [['11', '7D31']] }
        });
        await renderTerminal();
        await waitFor(() => expect(screen.getByText(/未列入受保护字节/)).toBeDefined());
    });
    // R2（PLAN §8.37）：回退上一配置 —— 按钮由 status.configHistoryDepth 决定是否置灰，
    // 成功后拿生效配置回填表单（同 APPLY 口径）并刷新状态与档案（配置变更会清激活指针）。
    it('R2 回退上一配置：调 /config/revert 并回填生效配置', async () => {
        ok(api.getTransportStatus, { ...STATUS, configHistoryDepth: 1 });
        ok(api.revertTransportConfig, {
            config: { ...CONFIG, mode: 'tcp', tcp: { ...CONFIG.tcp, host: '10.0.0.9' } },
            historyDepth: 0
        });

        await renderTerminal();
        await waitFor(() => expect(api.getTransportConfig).toHaveBeenCalledTimes(1));

        const button = screen.getByRole('button', { name: /回退上一配置/ });
        expect(button.disabled).toBe(false);
        expect(screen.getByText('可回退 1 版')).toBeDefined();

        fireEvent.click(button);

        await waitFor(() => expect(api.revertTransportConfig).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.getByText(/已回退到上一配置：模式 TCP/)).toBeDefined());
        expect(screen.getByText(/还可回退 0 版/)).toBeDefined();
        expect(api.getTransportStatus).toHaveBeenCalledTimes(2); // 挂载 1 + 回退后刷新
        expect(screen.getByDisplayValue('10.0.0.9')).toBeDefined(); // 草稿回填生效配置
    });

    it('R2 无可回退历史时按钮置灰', async () => {
        ok(api.getTransportStatus, { ...STATUS, configHistoryDepth: 0 });

        await renderTerminal();
        await waitFor(() => expect(api.getTransportConfig).toHaveBeenCalledTimes(1));

        expect(screen.getByRole('button', { name: /回退上一配置/ }).disabled).toBe(true);
        expect(screen.getByText('暂无可回退配置')).toBeDefined();
        expect(api.revertTransportConfig).not.toHaveBeenCalled();
    });

    it('R2 回退被后端拒（400）时把 detail 显示在配置区', async () => {
        ok(api.getTransportStatus, { ...STATUS, configHistoryDepth: 1 });
        fail(api.revertTransportConfig, new Error('没有可回退的上一配置'));

        await renderTerminal();
        await waitFor(() => expect(api.getTransportConfig).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole('button', { name: /回退上一配置/ }));

        await waitFor(() => expect(screen.getByText(/没有可回退的上一配置/)).toBeDefined());
        expect(api.revertTransportConfig).toHaveBeenCalledTimes(1);
    });

    // ── R14 · 串口端口枚举 + 波特率预设（PLAN §8.49）────────────────────────────
    it('R14 串口枚举：挂载即拉一次，切 serial 后出端口芯片，点芯片填表单、点刷新重拉', async () => {
        ok(api.getTransportPorts, {
            ports: [
                { device: 'COM1', description: '通信端口' },
                { device: 'COM3', description: 'USB-SERIAL CH340 (COM3)' }
            ],
            source: 'pyserial'
        });
        await renderTerminal();
        await waitFor(() => expect(api.getTransportPorts).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole('button', { name: /串口 SERIAL/ }));

        const com3 = screen.getByRole('button', { name: /^COM3$/ });
        expect(com3.getAttribute('title')).toBe('USB-SERIAL CH340 (COM3)');
        // 草稿 port = COM3 → 该芯片标亮，说明选中态是派生的、不是写死的
        expect(com3.getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', { name: /^COM1$/ }).getAttribute('aria-pressed')).toBe('false');

        fireEvent.click(screen.getByRole('button', { name: /^COM1$/ }));
        expect(screen.getByDisplayValue('COM1')).toBeDefined();

        // 枚举只是给表单省事 —— 点它不触发 APPLY（配置仍需点「应用配置」才落库）
        expect(api.setTransportConfig).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /刷新端口 REFRESH/ }));
        await waitFor(() => expect(api.getTransportPorts).toHaveBeenCalledTimes(2));
    });

    it('R14 波特率预设：点档位填输入框、随 APPLY 以数字提交（输入仍可任意键入）', async () => {
        ok(api.setTransportConfig, {
            ...CONFIG,
            mode: 'serial',
            serial: { ...CONFIG.serial, baudrate: 115200 }
        });
        await renderTerminal();
        await waitFor(() => expect(api.getTransportConfig).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole('button', { name: /串口 SERIAL/ }));
        const preset = screen.getByRole('button', { name: '115200' });
        expect(preset.getAttribute('aria-pressed')).toBe('false'); // 草稿是 9600

        fireEvent.click(preset);
        expect(screen.getByPlaceholderText('9600').value).toBe('115200');
        expect(screen.getByRole('button', { name: '115200' }).getAttribute('aria-pressed')).toBe('true');

        fireEvent.click(screen.getByRole('button', { name: /应用配置/ }));
        await waitFor(() => expect(api.setTransportConfig).toHaveBeenCalledTimes(1));
        const patch = api.setTransportConfig.mock.calls[0][0];
        expect(patch.mode).toBe('serial');
        expect(patch.serial.baudrate).toBe(115200); // 预设只改草稿，提交口径仍是数字
    });

    it('R14 枚举降级：source=unavailable → error 原文显示，配置区照常可用', async () => {
        ok(api.getTransportPorts, {
            ports: [],
            source: 'unavailable',
            error: 'pyserial 未安装：No module named serial'
        });
        await renderTerminal();
        await waitFor(() => expect(api.getTransportPorts).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole('button', { name: /串口 SERIAL/ }));
        // 降级如实报（不静默），且不出任何端口芯片
        expect(screen.getByText(/枚举降级：pyserial 未安装/)).toBeDefined();
        expect(screen.queryByRole('button', { name: /^COM3$/ })).toBeNull();

        // 枚举是锦上添花 —— 配置字段与 APPLY 照常
        expect(screen.getByText('波特率 BAUDRATE')).toBeDefined();
        expect(screen.getByRole('button', { name: /应用配置/ })).toBeDefined();
        expect(screen.getByRole('button', { name: /刷新端口 REFRESH/ })).toBeDefined();
    });

    // ── R15 · 档案重命名 + 自动轮询（PLAN §8.49）──────────────────────────────────
    it('R15 档案重命名：预填当前名 → 确认只 PUT label（不带 config）+ 列表刷新 + 回执', async () => {
        ok(api.updateProfile, { ...PROFILES[0], label: '环回基准·产线' });
        await renderTerminal();
        await waitFor(() => screen.getByText('设备档案 (DEVICE PROFILES)'));

        fireEvent.change(screen.getByLabelText(/档案 PROFILE/), { target: { value: 'pf-1' } });
        fireEvent.click(screen.getByRole('button', { name: /重命名 \(RENAME\)/ }));

        const input = screen.getByPlaceholderText('档案新名称');
        expect(input.value).toBe('环回基准'); // 预填当前名
        // 名字没改 → 确认禁用（后端吃得下同名请求，但那是一次白跑的往返）
        expect(screen.getByRole('button', { name: /确认改名 \(CONFIRM\)/ }).disabled).toBe(true);

        fireEvent.change(input, { target: { value: '环回基准·产线' } });
        fireEvent.click(screen.getByRole('button', { name: /确认改名 \(CONFIRM\)/ }));

        await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
        expect(api.updateProfile.mock.calls[0]).toEqual(['pf-1', { label: '环回基准·产线' }]);
        // 改名**不带 config** —— 不该动配置快照，与「更新（写入配置）」两码事
        expect(api.updateProfile.mock.calls[0][1].config).toBeUndefined();
        await waitFor(() => expect(api.getProfiles).toHaveBeenCalledTimes(2));
        expect(screen.getByText(/档案已重命名：环回基准 → 环回基准·产线/)).toBeDefined();
        expect(screen.queryByPlaceholderText('档案新名称')).toBeNull(); // 成功即收起
        expect(api.activateProfile).not.toHaveBeenCalled();
    });

    it('R15 改名撞名 400：detail 原文显示且行不收起；放弃则零调用', async () => {
        fail(api.updateProfile, new Error('档案名已存在：产线网关'));
        await renderTerminal();
        await waitFor(() => screen.getByText('设备档案 (DEVICE PROFILES)'));

        fireEvent.change(screen.getByLabelText(/档案 PROFILE/), { target: { value: 'pf-1' } });
        fireEvent.click(screen.getByRole('button', { name: /重命名 \(RENAME\)/ }));
        fireEvent.click(screen.getByRole('button', { name: /放弃 \(CANCEL\)/ }));
        expect(api.updateProfile).not.toHaveBeenCalled();
        expect(screen.queryByPlaceholderText('档案新名称')).toBeNull();

        // 再开 → 撞名：后端 detail（含回收站占名口径）原样透出，行**留着**让用户改
        fireEvent.click(screen.getByRole('button', { name: /重命名 \(RENAME\)/ }));
        fireEvent.change(screen.getByPlaceholderText('档案新名称'), { target: { value: '产线网关' } });
        fireEvent.click(screen.getByRole('button', { name: /确认改名 \(CONFIRM\)/ }));

        await waitFor(() => expect(screen.getByText(/档案名已存在：产线网关/)).toBeDefined());
        expect(screen.getByPlaceholderText('档案新名称')).toBeDefined();
        expect(api.getProfiles).toHaveBeenCalledTimes(1); // 失败不刷列表
    });

    it('R15 自动轮询：默认 5s 拉状态与历史，切后台即停、回前台恢复，关开关彻底停', async () => {
        vi.useFakeTimers();
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        try {
            await renderTerminal();
            await act(async () => { await Promise.resolve(); });
            // 挂载同步拉一次（状态 + 历史）
            expect(api.getTransportStatus).toHaveBeenCalledTimes(1);
            expect(api.getDispatchHistory).toHaveBeenCalledTimes(1);
            expect(screen.getByRole('button', { name: /自动刷新 AUTO · 5s/ })).toBeDefined();

            // 5s 一跳：状态与历史各再拉一次
            await act(async () => { vi.advanceTimersByTime(5000); });
            expect(api.getTransportStatus).toHaveBeenCalledTimes(2);
            expect(api.getDispatchHistory).toHaveBeenCalledTimes(2);

            // 切后台 → visibilitychange 清定时器，20s 内不再拉
            Object.defineProperty(document, 'hidden', { configurable: true, value: true });
            await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
            await act(async () => { vi.advanceTimersByTime(20000); });
            expect(api.getTransportStatus).toHaveBeenCalledTimes(2);

            // 回前台 → 恢复轮询
            Object.defineProperty(document, 'hidden', { configurable: true, value: false });
            await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
            await act(async () => { vi.advanceTimersByTime(5000); });
            expect(api.getTransportStatus).toHaveBeenCalledTimes(3);

            // 关掉开关 → effect 清理，彻底不再拉（手动刷新按钮仍在）
            fireEvent.click(screen.getByRole('button', { name: /自动刷新 AUTO · 5s/ }));
            expect(screen.getByRole('button', { name: /自动刷新停 AUTO OFF/ })).toBeDefined();
            await act(async () => { vi.advanceTimersByTime(30000); });
            expect(api.getTransportStatus).toHaveBeenCalledTimes(3);
            expect(api.getDispatchHistory).toHaveBeenCalledTimes(3);
        } finally {
            delete document.hidden;
            vi.useRealTimers();
        }
    });

    it('R16 显示格式：三面板共用一个开关 —— ascii 同时换历史预览与原始报文，切回 hex 逐字不变', async () => {
        await renderTerminal();
        await waitFor(() => expect(api.getDispatchHistory).toHaveBeenCalledTimes(1));

        const HEX_PREVIEW = 'AA 55 01 02 03 04 05 06 07 08 …+2';
        const preTexts = () => [...document.querySelectorAll('pre')].map((node) => node.textContent);
        expect(screen.getByText(HEX_PREVIEW)).toBeDefined(); // 历史预览（hex 缺省）
        expect(preTexts()).toContain('AA 55 01 02 03 04 05 06\n07 08 09 0A'); // 原始报文 8 字节/行

        const asciiBtn = screen.getByRole('button', { name: 'ASCII' });
        expect(asciiBtn.getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(asciiBtn);

        // 一次点击换三处：历史预览列 + 原始报文（+ 响应面板 'B1 B2 B3' → '...'）
        expect(screen.queryByText(HEX_PREVIEW)).toBeNull();
        expect(screen.getByText('.U........ …+2')).toBeDefined();
        expect(preTexts()).toContain('.U......\n....');
        expect(screen.getByRole('button', { name: 'ASCII' }).getAttribute('aria-pressed')).toBe('true');

        // 切回 HEX：与存量逐字相同（帧内容从头到尾没变过）
        fireEvent.click(screen.getByRole('button', { name: 'HEX' }));
        expect(screen.getByText(HEX_PREVIEW)).toBeDefined();
        expect(preTexts()).toContain('AA 55 01 02 03 04 05 06\n07 08 09 0A');
        expect(screen.getByRole('button', { name: 'HEX' }).getAttribute('aria-pressed')).toBe('true');
    });

    // ---- R20 设备档案自定义排序（PLAN §8.50 ②-3 · 2026-10-03 拍板解禁 DDL）----

    it('R20 排序：只改草稿序、点「保存顺序」才 PUT，成功即用返回的新顺序替换列表', async () => {
        ok(api.reorderProfiles, [PROFILES[1], PROFILES[0]]);
        await renderTerminal();
        await waitFor(() => screen.getByText('设备档案 (DEVICE PROFILES)'));
        const select = screen.getByLabelText(/档案 PROFILE/);
        const optionLabels = () => [...select.options].map((node) => node.textContent);
        const save = () => screen.getByRole('button', { name: /保存顺序 \(SAVE ORDER\)/ });

        expect(optionLabels()[1]).toContain('环回基准'); // 落位仍是服务端给的原序

        fireEvent.click(screen.getByRole('button', { name: /排序顺序 \(REORDER\)/ }));
        expect(save().disabled).toBe(true); // 顺序没动 → 不放行
        expect(screen.getByText(/顺序未改动/)).toBeDefined();

        fireEvent.click(screen.getAllByTitle('下移')[0]); // 草稿里把 pf-1 挪到 pf-2 后面
        expect(save().disabled).toBe(false);
        expect(screen.getByText(/顺序已改动/)).toBeDefined();
        // 拖 / 上移下移**只改草稿序**：此刻一次网络调用都没有（拍板口径）
        expect(api.reorderProfiles).not.toHaveBeenCalled();

        fireEvent.click(save());
        await waitFor(() => expect(api.reorderProfiles).toHaveBeenCalledTimes(1));
        expect(api.reorderProfiles).toHaveBeenCalledWith(['pf-2', 'pf-1']);

        // 成功：排序区收起 + 回执 + 下拉按新顺序渲染（端点回的就是新顺序，不再多拉一次）
        // R50：先等回执再查收起 —— 点保存后 busy='order'，按钮文案换成「处理中…」，
        // 此时 toBeNull() 是**假通过**；回执与收起在同一趟提交里，等回执即等真结果。
        await waitFor(() => expect(screen.getByText(/档案顺序已保存（2 条）/)).toBeDefined());
        await waitFor(() => expect(screen.queryByRole('button', { name: /保存顺序/ })).toBeNull());
        expect(optionLabels()[1]).toContain('产线网关');
        expect(optionLabels()[2]).toContain('环回基准');
    });

    it('R20 排序：挪动后点「放弃」零调用且行收起，列表仍是原顺序', async () => {
        await renderTerminal();
        await waitFor(() => screen.getByText('设备档案 (DEVICE PROFILES)'));
        const select = screen.getByLabelText(/档案 PROFILE/);

        fireEvent.click(screen.getByRole('button', { name: /排序顺序 \(REORDER\)/ }));
        fireEvent.click(screen.getAllByTitle('下移')[0]);
        fireEvent.click(screen.getByRole('button', { name: /放弃 \(CANCEL\)/ }));

        expect(api.reorderProfiles).not.toHaveBeenCalled(); // 放弃 = 零调用
        expect(screen.queryByRole('button', { name: /保存顺序/ })).toBeNull();
        expect([...select.options].map((node) => node.textContent)[1]).toContain('环回基准');
    });

    it('R20 排序被后端拒（400）：detail 原文显示且草稿留着，可改完再存', async () => {
        fail(api.reorderProfiles, 
            new Error("顺序与在册档案不一致：未列出 ['pf-3'] / 不认识 []")
        );
        await renderTerminal();
        await waitFor(() => screen.getByText('设备档案 (DEVICE PROFILES)'));

        fireEvent.click(screen.getByRole('button', { name: /排序顺序 \(REORDER\)/ }));
        fireEvent.click(screen.getAllByTitle('下移')[0]);
        fireEvent.click(screen.getByRole('button', { name: /保存顺序 \(SAVE ORDER\)/ }));

        await waitFor(() => expect(api.reorderProfiles).toHaveBeenCalledTimes(1));
        // R50：等的是回执上屏，不是「调用发生」—— 拒绝回执是 15ms 后才落地的。
        await waitFor(() => expect(screen.getByText(/ERR: 顺序与在册档案不一致/)).toBeDefined());
        // 草稿不丢：排序区还开着、顺序仍是改过的那版（保存按钮仍亮，可改完再存）
        expect(screen.getByRole('button', { name: /保存顺序 \(SAVE ORDER\)/ }).disabled).toBe(false);
        expect(screen.getByText(/顺序已改动/)).toBeDefined();
    });

});
