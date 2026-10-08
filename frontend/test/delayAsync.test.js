// R60（PLAN §8.92 · 2026-10-08）：注入盲区闭合护栏 —— async 形态 mock 的返回 Promise
// 也必须吃延迟。R51（§8.83）登记的 27 处盲区 = `vi.fn(async …)` 14 处（5 个 api 测试）+
// `mockImplementation(async …)` 13 处（Protocol）：async 函数微任务即达、不进延迟，
// 15ms 探测对这 27 处是盲区（抖动 / 缺等待的假通过照不出来）。
//
// · 缺省（不设 YORHA_API_DELAY_MS 或 =0）：本文件两条都直接跳过 —— 等价性铁律（off 档 0 红）；
// · >0：两种 async 形态的 resolve 都必须被推迟到 DELAY 之后，而非微任务即达。
import { describe, expect, it, vi } from 'vitest';

const DELAY = globalThis.__YORHA_DELAY_MS__ || 0;

// 真定时器下的宏任务刻度：微任务全部排干后才触发回调 ——
// 若 mock 的 resolve 走微任务即达，此刻必然已落定；走延迟则必然未落定。
const macrotaskTick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('R60 注入盲区：async 形态 mock 进延迟', () => {
    it('vi.fn(async …) 的 resolve 被推迟（缺省 0ms 跳过，不设 env 等价）', async () => {
        if (DELAY <= 0) return;
        let settled = false;
        const mock = vi.fn(async () => 'payload');
        const pending = mock().then(() => { settled = true; });
        await macrotaskTick();
        expect(settled).toBe(false);
        await pending;
        expect(settled).toBe(true);
    });

    it('mockImplementation(async …) 的 resolve 被推迟（缺省 0ms 跳过，不设 env 等价）', async () => {
        if (DELAY <= 0) return;
        let settled = false;
        const mock = vi.fn();
        mock.mockImplementation(async () => 'payload');
        const pending = mock().then(() => { settled = true; });
        await macrotaskTick();
        expect(settled).toBe(false);
        await pending;
        expect(settled).toBe(true);
    });
});
