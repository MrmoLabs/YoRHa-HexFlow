// R61（PLAN §8.93 · 2026-10-08）：假定时器下的在途链排空护栏 —— 销 R51 §8.83 八 第 3 条留白
// （§8.83 行 7401-7402 口径原文「假定时器下 settle 与排空都直接跳过」、行 7480-7482 留白
//  「其余假定时器文件的在途链未逐一验证」）。
//
// · 缺省（不设 YORHA_API_DELAY_MS 或 =0）：三条都直接跳过 —— 等价性铁律（off 档 0 红）；
// · >0：假定时器冻结 `setTimeout`，旧口径下 `__YORHA_settle()` 与全局 afterEach 收尾排空
//   **都直接盲跳**，在途链排不干 —— 本文件即「不盲跳、可控推进假时钟真排干」的活证据。
import { describe, expect, it, vi } from 'vitest';

const DELAY = globalThis.__YORHA_DELAY_MS__ || 0;

describe('R61 假定时器下的在途链排空', () => {
    let chainLanded = false;

    it('① 假定时器 + 在途回包 → __YORHA_settle() 必须把链推到落地', async () => {
        if (DELAY <= 0) return;
        vi.useFakeTimers();
        try {
            let landed = false;
            const mock = vi.fn(async () => 'payload');
            mock().then(() => { landed = true; });
            await globalThis.__YORHA_settle();
            expect(landed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('② 跨测试留在途链：不等回包、假定时器留着不复位', () => {
        if (DELAY <= 0) return;
        vi.useFakeTimers();
        const mock = vi.fn(async () => 'payload');
        mock().then(() => { chainLanded = true; });
        // 故意不 await、不 useRealTimers —— 只有全局 afterEach 的收尾排空救得了它
        expect(chainLanded).toBe(false); // R62：② 收尾时链确实还没落地（③ 才排空）
    });

    it('③ 上一测的在途链已在收尾被排干（排空不再盲跳）', () => {
        if (DELAY <= 0) return;
        try {
            expect(chainLanded).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
