// R20（PLAN §8.50 ②-3 · 2026-10-03 拍板解禁 DDL）：整表顺序一次提交的**请求口径**钉在
// 这里，与 backend/routers/profile.py 的 `reorder_profiles(payload: ProfileOrderUpdate)` 对齐：
//   · `PUT /profiles/order` —— **字面路径**，不是 `/profiles/{id}`（后端也把它注册在参数
//     路由之前，单测钉死了那个顺序）；
//   · body = `{ ids: [...] }`，草稿序**原样送**（顺序即语义，FE 不排序、不兜白名单）；
//   · 400（重复 / 遗漏 / 混入回收站）的 `detail` 原样透出，FE 不改写不吞。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reorderProfiles } from '../profiles';

describe('profiles api — reorderProfiles 整表顺序一次提交', () => {
    let calls;

    beforeEach(() => {
        calls = [];
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
            calls.push([url, init]);
            return { ok: true, status: 200, json: async () => [] };
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('PUT /profiles/order + body {ids}，顺序按草稿原样送（不排序不重排）', async () => {
        await reorderProfiles(['pf-3', 'pf-1', 'pf-2']);

        expect(calls).toHaveLength(1);
        const [url, init] = calls[0];
        expect(url).toMatch(/\/profiles\/order$/);
        expect(init.method).toBe('PUT');
        expect(init.headers['Content-Type']).toBe('application/json');
        expect(JSON.parse(init.body)).toEqual({ ids: ['pf-3', 'pf-1', 'pf-2'] });
    });

    it('返回的就是响应体（新顺序的列表），可直接替换本地状态不多拉一次 GET', async () => {
        const list = [
            { id: 'pf-1', label: 'A', sort_order: 2 },
            { id: 'pf-2', label: 'B', sort_order: 1 }
        ];
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => list })));

        await expect(reorderProfiles(['pf-1', 'pf-2'])).resolves.toEqual(list);
    });

    it('400 的 detail 原样透出（FE 不改写不吞）', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 400,
            json: async () => ({ detail: "顺序与在册档案不一致：未列出 ['pf-9'] / 不认识 []" })
        })));

        await expect(reorderProfiles(['pf-1'])).rejects.toThrow(/顺序与在册档案不一致/);
    });

    it('路径是字面 /profiles/order —— 不会被 /profiles/{id} 那条吃掉', async () => {
        await reorderProfiles(['pf-1', 'pf-2']);

        expect(calls[0][0]).toMatch(/\/profiles\/order$/);
        expect(calls[0][0]).not.toMatch(/\/profiles\/pf-1$/);
    });
});
