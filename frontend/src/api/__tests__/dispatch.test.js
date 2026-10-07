// R39（PLAN §8.71）：发前路由解析 —— POST /dispatch/routed 只解析不发送。
//
// 与 R38 的 routing.test.js 同理：这里只钉**线缆形状**（打到哪个地址、用什么动词、
// 带什么体），不复述业务口径 —— first-match-wins / 无命中不猜 / 坏条件记 invalid
// 全在后端 resolve_route，FE 兜第二套必然分叉。
//
// 关键区分：`/dispatch/routed` 与缺省 `/dispatch/` 是**两个不同端点**，前者的回执
// RouteResolveResponse **没有** status / attempts / hex_string（§0 硬约束：/dispatch
// 缺省口径逐字节不变）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRoute } from '../dispatch';

const ok = (data) => ({ ok: true, status: 200, json: async () => data });

const HIT = {
    matched: true,
    rule: { id: 'r-1', name: 'meter 0001', condition: 'meter_id == 0001', instruction_id: 'i-1' },
    instruction_id: 'i-1',
    instruction: { id: 'i-1', name: '开门指令' },
    invalid: [],
    considered: 3,
};

const MISS = {
    matched: false,
    rule: null,
    instruction_id: null,
    instruction: null,
    invalid: [],
    considered: 2,
};

describe('dispatch api（发前路由解析 /dispatch/routed）', () => {
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
            return ok(HIT);
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('resolveRoute → POST /dispatch/routed（**不是**缺省 /dispatch/，也不带尾斜杠）', async () => {
        await resolveRoute({ meter_id: '0001' });
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('POST');
        expect(calls[0].url).toMatch(/\/dispatch\/routed$/);
        expect(calls[0].url).not.toMatch(/\/dispatch\/$/);
    });

    it('体恒为 { inputs } 包一层（RouteResolveRequest 就这一个键，扁平字符串键）', async () => {
        await resolveRoute({ meter_id: '0001', line: 'A' });
        expect(JSON.parse(calls[0].body)).toEqual({ inputs: { meter_id: '0001', line: 'A' } });
        expect(calls[0].headers).toMatchObject({ 'Content-Type': 'application/json' });
    });

    it('缺参也包一层空 inputs（不发 undefined、不发裸 {}）', async () => {
        await resolveRoute();
        expect(JSON.parse(calls[0].body)).toEqual({ inputs: {} });
    });

    it('命中回执原样返回（matched / rule / instruction / invalid / considered 一个字段不改）', async () => {
        await expect(resolveRoute({})).resolves.toEqual(HIT);
    });

    it('无命中回执也原样返回（FE 不改判、不就地兜一条指令）', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ok(MISS)));
        await expect(resolveRoute({})).resolves.toEqual(MISS);
    });

    it('请求失败（非 2xx）detail 原样透出，不被改写、不吞', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 422,
            json: async () => ({ detail: 'inputs must be an object' }),
        })));
        await expect(resolveRoute({})).rejects.toThrow('inputs must be an object');
    });
});
