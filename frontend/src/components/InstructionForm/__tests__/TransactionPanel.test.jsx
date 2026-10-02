import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../api', () => ({
    api: {
        getResponseSpec: vi.fn(),
        saveResponseSpec: vi.fn(),
        deleteResponseSpec: vi.fn(),
        sendTransaction: vi.fn()
    }
}));

import { api } from '../../../api';
import TransactionPanel from '../TransactionPanel';
import { defaultSpec } from '../../../utils/transactionView';

const INSTRUCTION = { id: 'instr-1', name: '示例指令', code: '0x10' };
const PAYLOAD = 'AABB01';

const OK_RECORD = {
    id: 1700000000001,
    timestamp: '2026-09-23T00:00:00Z',
    channel: 'LOOPBACK',
    status: 'OK',
    byte_count: 3,
    hex_string: 'AA BB 01',
    instruction_name: '示例指令',
    instruction_id: 'instr-1',
    spec_source: 'default',
    broadcast: false,
    echo: 'AABB01',
    attempts: [
        { n: 1, status: 'OK', sent: 'AA BB 01', received: 'AA BB 01', rtt_ms: 0.4, reasons: [], error: null }
    ],
    stats: { attempts: 1, rtt_ms_last: 0.4, rtt_ms_avg: 0.4, rtt_ms_max: 0.4 }
};

const FAILED_RECORD = {
    ...OK_RECORD,
    status: 'FAILED',
    spec_source: 'inline',
    echo: '00FF',
    attempts: [
        { n: 1, status: 'MATCH_FAILED', sent: 'AA BB 01', received: '00 FF', rtt_ms: 0.5, reasons: ['SUFFIX_MISMATCH'], error: null },
        { n: 2, status: 'NO_RESPONSE', sent: 'AA BB 01', received: '', rtt_ms: 500, reasons: [], error: null }
    ],
    stats: { attempts: 2, rtt_ms_last: 0.5, rtt_ms_avg: 0.5, rtt_ms_max: 0.5 }
};

describe('TransactionPanel（P2 事务发送面板）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('挂载拉取规格：404 = 未配置常态 → 本地默认、无错误条', async () => {
        const err = new Error('not found');
        err.response = { status: 404 };
        api.getResponseSpec.mockRejectedValue(err);

        render(<TransactionPanel instruction={INSTRUCTION} payload={PAYLOAD} />);

        await waitFor(() => expect(api.getResponseSpec).toHaveBeenCalledWith('instr-1'));
        expect(screen.getByText(':: Transaction ::')).toBeDefined();
        expect(screen.queryByText(/SPEC LOAD FAILED/)).toBeNull();
        expect(screen.getByRole('button', { name: /SPEC ▸/ })).toBeDefined(); // 编辑器默认折叠
    });

    it('打开编辑器改前缀 → SAVE 变脏标记 → 保存调 saveResponseSpec 并清脏', async () => {
        api.getResponseSpec.mockRejectedValue(Object.assign(new Error('nf'), { response: { status: 404 } }));
        api.saveResponseSpec.mockResolvedValue({ id: 's1', instruction_id: 'instr-1', spec: {} });

        render(<TransactionPanel instruction={INSTRUCTION} payload={PAYLOAD} />);
        fireEvent.click(await screen.findByRole('button', { name: /SPEC ▸/ }));

        const prefix = screen.getByPlaceholderText('AA55');
        fireEvent.change(prefix, { target: { value: 'AA55' } });
        expect(screen.getByRole('button', { name: /SAVE \*/ })).toBeDefined(); // 脏标记

        fireEvent.click(screen.getByRole('button', { name: /SAVE \*/ }));
        await waitFor(() => expect(api.saveResponseSpec).toHaveBeenCalledTimes(1));
        const [id, spec] = api.saveResponseSpec.mock.calls[0];
        expect(id).toBe('instr-1');
        expect(spec.prefix).toBe('AA55');
        expect(spec.mode).toBe('echo');
        await screen.findByText('SPEC SAVED');
        expect(screen.getByRole('button', { name: /^SAVE$/ })).toBeDefined(); // 脏标记已清
    });

    it('拉取失败（非 404）→ 错误条可见且降级本地默认仍可用', async () => {
        api.getResponseSpec.mockRejectedValue(new Error('network down'));

        render(<TransactionPanel instruction={INSTRUCTION} payload={PAYLOAD} />);
        await screen.findByText(/SPEC LOAD FAILED: network down/);
        expect(screen.getByRole('button', { name: /SEND_TRANSACTION/ })).toBeDefined();
    });

    it('干净规格发送 → response_spec=null，渲染 TXN_OK 汇总与逐次 attempt', async () => {
        api.getResponseSpec.mockRejectedValue(Object.assign(new Error('nf'), { response: { status: 404 } }));
        api.sendTransaction.mockResolvedValue(OK_RECORD);

        render(<TransactionPanel instruction={INSTRUCTION} payload={PAYLOAD} />);
        fireEvent.click(await screen.findByRole('button', { name: /SEND_TRANSACTION/ }));

        await waitFor(() => expect(api.sendTransaction).toHaveBeenCalledTimes(1));
        const body = api.sendTransaction.mock.calls[0][0];
        expect(body.hex_string).toBe(PAYLOAD);
        expect(body.instruction_id).toBe('instr-1');
        expect(body.response_spec).toBeNull();      // 干净 → 交后端按 instruction_id 解析
        expect(body.timeout_ms).toBe(500);
        expect(body.retries).toBe(2);
        expect(body.interval_ms).toBe(50);
        expect(body.broadcast).toBe(false);

        await screen.findByText(/TXN_OK · 1 ATTEMPT · RTT 0\.4 ms/);
        expect(screen.getByText('#1')).toBeDefined();
        expect(screen.getByText('OK')).toBeDefined();
        expect(screen.getByText('0.4 ms')).toBeDefined();
        expect(screen.getByText('DEFAULT')).toBeDefined(); // spec_source
    });

    it('脏规格发送 → response_spec 内联；FAILED 记录渲染原因', async () => {
        api.getResponseSpec.mockRejectedValue(Object.assign(new Error('nf'), { response: { status: 404 } }));
        api.sendTransaction.mockResolvedValue(FAILED_RECORD);

        render(<TransactionPanel instruction={INSTRUCTION} payload={PAYLOAD} />);
        fireEvent.click(await screen.findByRole('button', { name: /SPEC ▸/ }));
        fireEvent.change(screen.getByPlaceholderText('AA55'), { target: { value: '0D0A' } });
        fireEvent.click(screen.getByRole('button', { name: /SEND_TRANSACTION/ }));

        await waitFor(() => expect(api.sendTransaction).toHaveBeenCalledTimes(1));
        const body = api.sendTransaction.mock.calls[0][0];
        expect(body.response_spec).toEqual(expect.objectContaining({ prefix: '0D0A' }));

        await screen.findByText(/TXN_FAILED · 2 ATTEMPTS · RTT 0\.5 ms/);
        expect(screen.getByText('SUFFIX_MISMATCH')).toBeDefined();
        expect(screen.getByText('NO_RESPONSE')).toBeDefined();
        expect(screen.getByText('INLINE')).toBeDefined();
    });

    it('空帧禁用发送；广播开关翻转；发送异常显示错误条', async () => {
        api.getResponseSpec.mockRejectedValue(Object.assign(new Error('nf'), { response: { status: 404 } }));
        api.sendTransaction.mockRejectedValue(new Error('boom'));

        const { rerender } = render(<TransactionPanel instruction={INSTRUCTION} payload="" />);
        expect(screen.getByRole('button', { name: /SEND_TRANSACTION/ }).disabled).toBe(true);

        const broadcast = screen.getByRole('button', { name: /BROADCAST/ });
        expect(broadcast.getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(broadcast);
        expect(screen.getByRole('button', { name: /BROADCAST/ }).getAttribute('aria-pressed')).toBe('true');

        rerender(<TransactionPanel instruction={INSTRUCTION} payload={PAYLOAD} />);
        fireEvent.click(screen.getByRole('button', { name: /SEND_TRANSACTION/ }));
        await screen.findByText(/TXN ERROR: boom/);
    });

    it('LENGTH/CHECKSUM 折叠开关与忽略区间非法文本提示', async () => {
        api.getResponseSpec.mockRejectedValue(Object.assign(new Error('nf'), { response: { status: 404 } }));

        render(<TransactionPanel instruction={INSTRUCTION} payload={PAYLOAD} />);
        fireEvent.click(await screen.findByRole('button', { name: /SPEC ▸/ }));

        const lengthToggle = screen.getByRole('button', { name: /LENGTH OFF/ });
        fireEvent.click(lengthToggle);
        expect(screen.getByRole('button', { name: /LENGTH ON/ })).toBeDefined();
        expect(screen.getByText('OFFSET_VAL')).toBeDefined(); // 子字段展开

        fireEvent.change(screen.getByPlaceholderText('4-6,10-12'), { target: { value: '6-4' } });
        expect(screen.getByText(/格式非法/)).toBeDefined();
        // 非法区间 → SAVE 禁用（不落半截状态）
        expect(screen.getByRole('button', { name: /SAVE/ }).disabled).toBe(true);
    });

    // ─── CP3 3d (D7-A): 应答规格失效徽标 ─────────────────────────────────
    // 口径：仅 stale === true 出徽标；false（仍匹配）/ null（无出处，手工规格）
    // 一律不渲染。徽标挂在规格编辑器头部（RESPONSE_SPEC 行）。
    const openSpecWith = async (stale) => {
        api.getResponseSpec.mockResolvedValue({
            id: 's1',
            instruction_id: 'instr-1',
            spec: defaultSpec(),
            stage: null,
            definition_hash: 'sha256:fixture',
            stale
        });
        render(<TransactionPanel instruction={INSTRUCTION} payload={PAYLOAD} />);
        fireEvent.click(await screen.findByRole('button', { name: /SPEC ▸/ }));
    };

    it('D7-A stale=true → 编辑器头部出「规格已失效 STALE」徽标，字段编辑重渲染后仍在', async () => {
        await openSpecWith(true);

        expect(screen.getByTestId('response-spec-stale').textContent).toContain('规格已失效 STALE');

        // 本地改字段（脏稿重渲染）→ 徽标不丢
        fireEvent.change(screen.getByPlaceholderText('AA55'), { target: { value: 'AA55' } });
        expect(screen.getByTestId('response-spec-stale')).toBeDefined();
        expect(screen.getByRole('button', { name: /SAVE \*/ })).toBeDefined();
    });

    it('D7-A stale=false（仍匹配）→ 不渲染徽标', async () => {
        await openSpecWith(false);
        expect(screen.getByText('RESPONSE_SPEC')).toBeDefined(); // 编辑器头部在场
        expect(screen.queryByTestId('response-spec-stale')).toBeNull();
    });

    it('D7-A stale=null（无出处的手工规格）→ 不渲染徽标', async () => {
        await openSpecWith(null);
        expect(screen.queryByTestId('response-spec-stale')).toBeNull();
    });

    it('D7-A 404（未配置规格）→ 本地默认且无徽标（降级路径不崩）', async () => {
        api.getResponseSpec.mockRejectedValue(Object.assign(new Error('nf'), { response: { status: 404 } }));
        render(<TransactionPanel instruction={INSTRUCTION} payload={PAYLOAD} />);
        fireEvent.click(await screen.findByRole('button', { name: /SPEC ▸/ }));
        expect(await screen.findByText('RESPONSE_SPEC')).toBeDefined();
        expect(screen.queryByTestId('response-spec-stale')).toBeNull();
    });
});
