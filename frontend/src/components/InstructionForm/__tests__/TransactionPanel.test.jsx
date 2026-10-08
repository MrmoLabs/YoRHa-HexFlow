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

    // ─── R28 (PLAN §8.52 第 8 批 · §8.60 定案): length.encoding 只写非缺省值 ──
    it('LENGTH ENCODING: varint 写键、fixed 删键（BYTE_LEN 不禁用 = 设计期宽度）', async () => {
        api.getResponseSpec.mockRejectedValue(Object.assign(new Error('nf'), { response: { status: 404 } }));

        render(<TransactionPanel instruction={INSTRUCTION} payload={PAYLOAD} />);
        fireEvent.click(await screen.findByRole('button', { name: /SPEC ▸/ }));
        // R51（PLAN §8.83）：规格拉取（本例 404 → 降级本地默认）**落定后再动编辑器** ——
        // 否则回包 setSpec(defaultSpec()) 会把随后的 LENGTH 打开冲掉
        await globalThis.__YORHA_settle();
        fireEvent.click(screen.getByRole('button', { name: /LENGTH OFF/ }));

        const box = screen.getByLabelText('length encoding');
        expect(box.value).toBe('fixed'); // 缺省 = 无键 → 读回 fixed（与后端口径同）
        expect(screen.queryByText(/设计期宽度/)).toBeNull(); // fixed 不出 varint 说明

        // BYTE_LEN 在 varint 下仍可编辑（它是设计期宽度，收侧回算 offset_val 要用）
        fireEvent.change(box, { target: { value: 'varint' } });
        expect(screen.getByText(/设计期宽度/)).toBeDefined();
        expect(screen.getByLabelText('length encoding').value).toBe('varint');
        const byteLen = screen.getByText('BYTE_LEN').parentElement.querySelector('input');
        expect(byteLen.disabled).toBe(false);

        fireEvent.click(screen.getByRole('button', { name: /SAVE \*/ }));
        await waitFor(() => expect(api.saveResponseSpec).toHaveBeenCalledTimes(1));
        expect(api.saveResponseSpec.mock.calls[0][1].length).toEqual({
            offset: 0, byte_length: 1, offset_val: 0, byte_order: 'big', encoding: 'varint'
        });

        // 切回 fixed = **删键**（不是写 "fixed"）—— 存量规格形态逐字节不变
        fireEvent.change(screen.getByLabelText('length encoding'), { target: { value: 'fixed' } });
        expect(screen.queryByText(/设计期宽度/)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /SAVE \*/ }));
        await waitFor(() => expect(api.saveResponseSpec).toHaveBeenCalledTimes(2));
        const [, second] = api.saveResponseSpec.mock.calls[1];
        expect(second.length).toEqual({
            offset: 0, byte_length: 1, offset_val: 0, byte_order: 'big'
        });
        expect(Object.keys(second.length)).not.toContain('encoding');
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
        // R51：先等拉取落定再断言「不出徽标」—— 否则徽标还没轮到上屏，
        // toBeNull() 会**假通过**（探测只抓红、抓不到这种，是分析这批红时发现的）
        await globalThis.__YORHA_settle();
    };

    it('D7-A stale=true → 编辑器头部出「规格已失效 STALE」徽标，字段编辑重渲染后仍在', async () => {
        await openSpecWith(true);

        // R51：徽标要等 getResponseSpec 的回包把 stale=true 写进来
        await waitFor(() => expect(screen.getByTestId('response-spec-stale').textContent).toContain('规格已失效 STALE'));

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
        // R51：同上，404 降级落定后再断言「无徽标」，防假通过
        await globalThis.__YORHA_settle();
        expect(screen.queryByTestId('response-spec-stale')).toBeNull();
    });

    // ─── R9（PLAN §8.46 · C-2 选 B 前半）: 命中应答逆向解码展示 ───────────
    const DECODE_INSTRUCTION = {
        id: 'instr-1',
        name: '示例指令',
        code: '0x10',
        fields: [
            {
                id: 'h', name: 'HEADER', op_code: 'FIXED', byte_len: 2, sequence: 0,
                parameter_config: { hex: 'AABB' }
            },
            {
                id: 'v', name: 'VOLTAGE', op_code: 'FLOAT_IEEE', byte_len: 4, sequence: 1,
                parameter_config: {}
            }
        ]
    };
    const DECODED_RECORD = {
        ...OK_RECORD,
        attempts: [{
            n: 1, status: 'OK', sent: 'AA BB 40 48 F5 C3', received: 'AA BB 40 48 F5 C3',
            rtt_ms: 0.3, reasons: [], error: null
        }]
    };
    const nf404 = () => Object.assign(new Error('nf'), { response: { status: 404 } });

    it('R9 命中应答 → 出「字段 = 值」解码面板（4048F5C3 → 3.14），无警告', async () => {
        api.getResponseSpec.mockRejectedValue(nf404());
        api.sendTransaction.mockResolvedValue(DECODED_RECORD);

        render(<TransactionPanel instruction={DECODE_INSTRUCTION} payload={PAYLOAD} />);
        fireEvent.click(await screen.findByRole('button', { name: /SEND_TRANSACTION/ }));

        const box = await screen.findByTestId('decoded-fields');
        expect(box.textContent).toContain('HEADER');
        expect(box.textContent).toContain('"AABB"');
        expect(box.textContent).toContain('VOLTAGE');
        expect(box.textContent).toContain('3.14'); // float32 尾噪在展示层收敛
        expect(screen.queryByTestId('decoded-warnings')).toBeNull();
    });

    it('R9 未命中（FAILED）→ 不出解码面板；指令无 fields 也降级不出', async () => {
        api.getResponseSpec.mockRejectedValue(nf404());

        api.sendTransaction.mockResolvedValue(FAILED_RECORD);
        const first = render(<TransactionPanel instruction={DECODE_INSTRUCTION} payload={PAYLOAD} />);
        fireEvent.click(await screen.findByRole('button', { name: /SEND_TRANSACTION/ }));
        await screen.findByText(/TXN_FAILED/);
        expect(screen.queryByTestId('decoded-fields')).toBeNull();
        first.unmount();

        // 无字段布局（字段列表为空）→ 一帧也解不出，静默降级不报错
        api.sendTransaction.mockResolvedValue(OK_RECORD);
        render(<TransactionPanel instruction={INSTRUCTION} payload={PAYLOAD} />);
        fireEvent.click(await screen.findByRole('button', { name: /SEND_TRANSACTION/ }));
        await screen.findByText(/TXN_OK/);
        expect(screen.queryByTestId('decoded-fields')).toBeNull();
    });
});
