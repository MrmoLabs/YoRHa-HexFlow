// 统一诊断反馈（PLAN §8.32）：client 层如何把后端的结构化 `diagnostic` 变成人能读的一行摘要。
// 纪律：`detail` 文案一个字不改，diagnostic 只做加法（挂 error.diagnostic + 消息前缀）。
import { describe, expect, it } from 'vitest';
import { formatApiErrorDetail, formatDiagnostic, handleResponse } from '../client';

const okResponse = (data) => ({ ok: true, status: 200, json: async () => data });
const errResponse = (status, data) => ({ ok: false, status, json: async () => data });

const catchError = async (promise) => {
    try {
        await promise;
        return null;
    } catch (error) {
        return error;
    }
};

describe('formatDiagnostic', () => {
    it('把结构化诊断压成一行摘要（层 · 层号 · 定位 · 是否已发 · 码）', () => {
        expect(formatDiagnostic({
            stage: 'wrap',
            layer: 2,
            target: 'proto-x',
            data_sent: false,
            code: 'WRAP_LAYER_REJECT',
        })).toBe('封装 · 第 2 层 · 定位 proto-x · 未发送 · WRAP_LAYER_REJECT');
    });

    it('序列步与传输层的摘要形态', () => {
        expect(formatDiagnostic({ stage: 'sequence', step: 3, data_sent: false }))
            .toBe('序列 · 第 3 步 · 未发送');
        expect(formatDiagnostic({ stage: 'transport', data_sent: false, byte_count: 2 }))
            .toBe('传输 · 未发送'); // byte_count 不进摘要（留给结构化字段）
    });

    it('缺失字段逐段跳过，空值整段为空', () => {
        expect(formatDiagnostic({ stage: 'transport' })).toBe('传输');
        expect(formatDiagnostic({ data_sent: true })).toBe('已发送');
        expect(formatDiagnostic(null)).toBe('');
        expect(formatDiagnostic(undefined)).toBe('');
        expect(formatDiagnostic({})).toBe('');
        expect(formatDiagnostic({ stage: null })).toBe('');
    });

    it('未知 stage 原样透出，不吞信息', () => {
        expect(formatDiagnostic({ stage: 'weird' })).toBe('weird');
    });
});

describe('handleResponse', () => {
    it('成功路径原样返回数据（不加任何字段）', async () => {
        await expect(handleResponse(okResponse({ a: 1 }))).resolves.toEqual({ a: 1 });
    });

    it('错误：detail 原文 + 挂 error.diagnostic + 消息前压摘要', async () => {
        const diagnostic = {
            stage: 'wrap',
            code: 'WRAP_LAYER_REJECT',
            message: '第 2 层（壳）：洞位不足',
            layer: 2,
            data_sent: false,
        };
        const data = { detail: '第 2 层（壳）：洞位不足', diagnostic };
        const error = await catchError(handleResponse(errResponse(400, data)));

        expect(error).not.toBeNull();
        expect(error.message).toBe(
            '[封装 · 第 2 层 · 未发送 · WRAP_LAYER_REJECT] 第 2 层（壳）：洞位不足'
        );
        expect(error.diagnostic).toEqual(diagnostic);
        // 既有消费方读 error.response.data.detail —— 原样可读
        expect(error.response.status).toBe(400);
        expect(error.response.data.detail).toBe('第 2 层（壳）：洞位不足');
    });

    it('无 diagnostic 的错误：消息逐字不变（向后兼容）', async () => {
        const data = { detail: 'Protocol not found' };
        const error = await catchError(handleResponse(errResponse(404, data)));
        expect(error.message).toBe('Protocol not found');
        expect(error.diagnostic).toBeUndefined();
        expect(error.response.data).toEqual(data);
    });

    it('detail 为校验数组时仍走既有格式化（无 diagnostic 不加前缀）', async () => {
        const data = {
            detail: [{ loc: ['body', 'hex_string'], msg: 'field required' }],
        };
        const error = await catchError(handleResponse(errResponse(422, data)));
        expect(error.message).toBe('body.hex_string: field required');
        expect(error.diagnostic).toBeUndefined();
    });

    it('data_sent 缺省时不硬造「未发送」字样', async () => {
        const data = {
            detail: '配方没有可编译的阶段',
            diagnostic: { stage: 'wrap', code: 'RECIPE_EMPTY' },
        };
        const error = await catchError(handleResponse(errResponse(400, data)));
        expect(error.message).toBe('[封装 · RECIPE_EMPTY] 配方没有可编译的阶段');
    });
});

describe('formatApiErrorDetail（既有口径不回归）', () => {
    it('字符串原样、数组逐项定位、对象 JSON 化', () => {
        expect(formatApiErrorDetail('boom')).toBe('boom');
        expect(formatApiErrorDetail([{ loc: ['body', 'x'], msg: 'bad' }])).toBe('body.x: bad');
        expect(formatApiErrorDetail({ a: 1 })).toBe('{"a":1}');
        expect(formatApiErrorDetail(undefined)).toBe('API request failed');
    });
});
