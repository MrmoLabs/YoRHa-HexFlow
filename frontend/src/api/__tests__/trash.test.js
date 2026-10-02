// R6-2（PLAN §8.44）：回收站 API —— 三个端点的 URL / method 必须与
// backend/routers/trash.py 的路由逐字对齐（路径参数走白名单，FE 不兜第二层）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listTrash, purgeTrashItem, restoreTrashItem } from '../trash';

const ok = (data) => ({ ok: true, status: 200, json: async () => data });

describe('trash api（三端点）', () => {
    let calls;

    beforeEach(() => {
        calls = [];
        vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
            calls.push({ url, method: init.method || 'GET' });
            return ok({ items: [], count: 0 });
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('listTrash → GET /trash（无 method 即 GET）', async () => {
        await listTrash();
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('GET');
        expect(calls[0].url).toMatch(/\/trash$/);
    });

    it('restoreTrashItem → POST /trash/{kind}/{id}/restore，kind/id 做 encodeURIComponent', async () => {
        await restoreTrashItem('response_spec', 'a/b');
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('POST');
        expect(calls[0].url).toMatch(/\/trash\/response_spec\/a%2Fb\/restore$/);
    });

    it('purgeTrashItem → DELETE /trash/{kind}/{id}', async () => {
        await purgeTrashItem('protocol', 'p-1');
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('DELETE');
        expect(calls[0].url).toMatch(/\/trash\/protocol\/p-1$/);
    });

    it('白名单外 kind 的 404 detail 原样透出（不被改写、不吞）', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 404,
            json: async () => ({ detail: 'Unknown trash kind: nope' })
        })));
        await expect(purgeTrashItem('nope', 'x')).rejects.toThrow('Unknown trash kind: nope');
    });

    it('活行 400「该条目不在回收站」原文透出（恢复/清除的守卫）', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 400,
            json: async () => ({ detail: '该条目不在回收站' })
        })));
        await expect(restoreTrashItem('protocol', 'live-id')).rejects.toThrow('该条目不在回收站');
    });
});
