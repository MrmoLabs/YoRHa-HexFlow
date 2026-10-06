// R38（PLAN §8.70）：发前路由规则 API —— 五个方法的 URL / method 必须与
// backend/routers/routing.py 的路由逐字对齐（前缀 /routing-rules，无尾斜杠）。
//
// 这里只钉**线缆形状**（打到哪个地址、用什么动词、带什么体），不复述业务口径：
// 口径由后端 select_rule / 判重 / 语法校验说了算，FE 兜第二套必然分叉。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    listRoutingRules,
    getRoutingRule,
    createRoutingRule,
    updateRoutingRule,
    deleteRoutingRule,
} from '../routing';

const ok = (data) => ({ ok: true, status: 200, json: async () => data });

const PAYLOAD = {
    name: 'meter 0001',
    condition: 'meter_id == 0001',
    instruction_id: 'i-1',
    sort_order: 3,
    enabled: 1,
    description: null,
};

describe('routing api（/routing-rules 五方法）', () => {
    let calls;

    beforeEach(() => {
        calls = [];
        vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
            calls.push({
                url,
                method: init.method || 'GET',
                body: init.body ?? null,
                headers: init.headers || {},
            });
            return ok({ id: 'r-1' });
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('listRoutingRules → GET /routing-rules（无 method 即 GET）', async () => {
        await listRoutingRules();
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('GET');
        expect(calls[0].url).toMatch(/\/routing-rules$/);
    });

    it('getRoutingRule → GET /routing-rules/{id}，id 做 encodeURIComponent', async () => {
        await getRoutingRule('a/b');
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('GET');
        expect(calls[0].url).toMatch(/\/routing-rules\/a%2Fb$/);
    });

    it('createRoutingRule → POST /routing-rules + JSON 体（Content-Type 头带上）', async () => {
        await createRoutingRule(PAYLOAD);
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('POST');
        expect(calls[0].url).toMatch(/\/routing-rules$/);
        expect(JSON.parse(calls[0].body)).toEqual(PAYLOAD);
        expect(calls[0].headers).toMatchObject({ 'Content-Type': 'application/json' });
    });

    it('updateRoutingRule → PUT /routing-rules/{id} + JSON 体（整体替换，非 PATCH）', async () => {
        await updateRoutingRule('r-1', PAYLOAD);
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('PUT');
        expect(calls[0].url).toMatch(/\/routing-rules\/r-1$/);
        expect(JSON.parse(calls[0].body)).toEqual(PAYLOAD);
    });

    it('deleteRoutingRule → DELETE /routing-rules/{id}（不带 body）', async () => {
        await deleteRoutingRule('r-1');
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('DELETE');
        expect(calls[0].url).toMatch(/\/routing-rules\/r-1$/);
        expect(calls[0].body).toBeNull();
    });

    it('后端 400「name already exists」detail 原样透出（不被改写、不吞）', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 400,
            json: async () => ({ detail: 'Routing rule name already exists' })
        })));
        await expect(createRoutingRule(PAYLOAD)).rejects.toThrow('Routing rule name already exists');
    });

    it('后端 404「Instruction not found」detail 原样透出（目标指令入站/不存在）', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 404,
            json: async () => ({ detail: 'Instruction not found' })
        })));
        await expect(updateRoutingRule('r-1', PAYLOAD)).rejects.toThrow('Instruction not found');
    });
});
