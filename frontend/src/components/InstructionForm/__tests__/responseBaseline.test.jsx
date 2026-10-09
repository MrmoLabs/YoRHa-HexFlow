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

// R28（PLAN §8.52 排期第 8 批 · §8.60 定案）Phase 0 硬前置：前端**没有任何**应答
// 解包 / 匹配代码（判定全在后端 response_match），它对面板的全部职责就是「把规格
// 对象原样交出去」。故 FE 侧的不变量 = 提交形状：R28 给 length 新增的 `encoding`
// 键**只写非缺省值**（varint 才写，缺失键 = fixed = 存量口径），下面的金标准在改后
// 必须逐字节相同 —— 一旦有人给缺省规格塞了新键，这条就红。
//
// 金标准抓自 R28 改动之前的实现（与 BE backend/tests/test_response_baseline.py 同批）。

const INSTRUCTION = { id: 'instr-1', name: '示例指令', code: '0x10' };
const PAYLOAD = 'AABB01';

const NOT_FOUND = () => Object.assign(new Error('nf'), { response: { status: 404 } });

describe('R28 Phase 0：规格提交形状金标准（无变长编码时逐字节不变）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.getResponseSpec.mockRejectedValue(NOT_FOUND());
        api.saveResponseSpec.mockResolvedValue({ id: 's1', instruction_id: 'instr-1', spec: {} });
    });

    it('defaultSpec() 形状钉死（与后端 default_spec() 同形、无 R28 新键）', () => {
        expect(defaultSpec()).toEqual({
            mode: 'echo',
            prefix: '',
            suffix: '',
            echo_header_bytes: 0,
            length: null,
            checksum: null,
            ignore_ranges: []
        });
        expect(Object.keys(defaultSpec())).toEqual([
            'mode', 'prefix', 'suffix', 'echo_header_bytes', 'length', 'checksum', 'ignore_ranges'
        ]);
    });

    it('改前缀 + 打开 LENGTH → 提交的 spec 逐字节同形（length 不含 encoding 键）', async () => {
        render(<TransactionPanel instruction={INSTRUCTION} payload={PAYLOAD} />);
        fireEvent.click(await screen.findByRole('button', { name: /SPEC ▸/ }));

        fireEvent.change(screen.getByPlaceholderText('AA55'), { target: { value: 'AA55' } });
        fireEvent.click(screen.getByRole('button', { name: /LENGTH OFF/ }));
        expect(screen.getByText('OFFSET_VAL')).not.toBeNull();

        fireEvent.click(screen.getByRole('button', { name: /SAVE \*/ }));
        await waitFor(() => expect(api.saveResponseSpec).toHaveBeenCalledTimes(1));

        const [id, spec] = api.saveResponseSpec.mock.calls[0];
        expect(id).toBe('instr-1');
        expect(JSON.stringify(spec)).toBe(JSON.stringify({
            mode: 'echo',
            prefix: 'AA55',
            suffix: '',
            echo_header_bytes: 0,
            length: { offset: 0, byte_length: 1, offset_val: 0, byte_order: 'big' },
            checksum: null,
            ignore_ranges: []
        }));
        // 只改一个字段 → 对象键集也钉死（防止「顺手多塞一个缺省键」）
        expect(Object.keys(spec)).toEqual([
            'mode', 'prefix', 'suffix', 'echo_header_bytes', 'length', 'checksum', 'ignore_ranges'
        ]);
        expect(Object.keys(spec.length)).toEqual(['offset', 'byte_length', 'offset_val', 'byte_order']);
    });

    it('只改前缀（不开 LENGTH）→ 顶层形状与金标准一致', async () => {
        render(<TransactionPanel instruction={INSTRUCTION} payload={PAYLOAD} />);
        fireEvent.click(await screen.findByRole('button', { name: /SPEC ▸/ }));
        fireEvent.change(screen.getByPlaceholderText('AA55'), { target: { value: 'AA55' } });
        fireEvent.click(screen.getByRole('button', { name: /SAVE \*/ }));
        await waitFor(() => expect(api.saveResponseSpec).toHaveBeenCalledTimes(1));

        const [, spec] = api.saveResponseSpec.mock.calls[0];
        expect(spec).toEqual({
            mode: 'echo',
            prefix: 'AA55',
            suffix: '',
            echo_header_bytes: 0,
            length: null,
            checksum: null,
            ignore_ranges: []
        });
    });
});
