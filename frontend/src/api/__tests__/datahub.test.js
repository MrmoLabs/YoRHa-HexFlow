// R17（PLAN §8.49 · §8.49 R17 行）：按域独立导出 —— `?domains=` 的**拼串口径**钉在这里，
// 与 backend/routers/datahub.py 的 `export_bundle(domains: Optional[str])` 参数名逐字对齐：
//   · 不传 / 传空数组 → **不带该参数**（存量全 8 域请求一个字节都不变）；
//   · 传数组 → `?domains=a,b`（逗号分隔 + encodeURIComponent）；
//   · 非法域名由后端 400 报，FE **不兜白名单第二层**（与 importDomain 同纪律）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportDataBundle } from '../datahub';

describe('datahub api — exportDataBundle 按域导出', () => {
    let urls;

    beforeEach(() => {
        urls = [];
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            urls.push(url);
            return { ok: true, status: 200, blob: async () => 'zip-bytes' };
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('不传参数 → 不带 ?domains（缺省 = 后端全 8 域）', async () => {
        await exportDataBundle();
        expect(urls).toHaveLength(1);
        expect(urls[0]).toMatch(/\/datahub\/export\/bundle$/);
    });

    it('传空数组 → 同样不带 ?domains（不当成「空域名」发出去吃 400）', async () => {
        await exportDataBundle([]);
        expect(urls).toHaveLength(1);
        expect(urls[0]).toMatch(/\/datahub\/export\/bundle$/);
    });

    it('传数组 → ?domains=逗号分隔且整体做 encodeURIComponent', async () => {
        await exportDataBundle(['recipes', 'sequences']);
        expect(urls[0]).toMatch(/\/datahub\/export\/bundle\?domains=recipes%2Csequences$/);
        await exportDataBundle(['transport']);
        expect(urls[1]).toMatch(/\/datahub\/export\/bundle\?domains=transport$/);
    });

    it('400 detail 原样透出（未知域后端报，FE 不改写不吞）', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 400,
            json: async () => ({ detail: '未知域：protocols（可选：instructions）' })
        })));
        await expect(exportDataBundle(['protocols']))
            .rejects.toThrow('未知域：protocols（可选：instructions）');
    });
});
