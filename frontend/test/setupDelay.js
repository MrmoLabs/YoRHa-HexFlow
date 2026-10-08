// R51（PLAN §8.83 · 2026-10-08）：全仓 mock 响应延迟注入 —— 把「等请求不等渲染」这类竞态
// 从**概率性抖动**变成**确定性失败**，从而能一次跑出全仓隐患清单。
//
// · 缺省（不设 YORHA_API_DELAY_MS，或 =0）：本文件**一个钩子都不装**，与没有它逐字等价；
// · >0：把 vi.fn() 造出来的 mock 的 mockResolvedValue / mockRejectedValue（含 Once 变体）
//   改成「**调用时**才起算延迟」的等价实现 —— 与原语义的差别只有响应何时到。
//
// 与 Terminal.test.jsx 文件内那套 ok()/fail() 的分工：那套是**单文件**的确定性复现器
// （R50 的产物，固定验收第 10 项在用），本文件负责**其余 95 个测试文件**；两者都读同一个
// 环境量，但 Terminal 自己的实现直接写 mockImplementation，不会与这里叠成双倍延迟。
import { afterEach, vi } from 'vitest';

const DELAY_MS = Number(globalThis.process?.env?.YORHA_API_DELAY_MS || 0);

// 让测试能断言「注入确实生效」（护栏用），而不是靠猜。
globalThis.__YORHA_DELAY_MS__ = DELAY_MS;

// 共用等待口（与 R50 Terminal.test.jsx 里 settle() 同款，抽到全仓共用）：
// 把在途响应回包等回来。缺省（0ms）立即返回 —— 与没有它逐字等价。
globalThis.__YORHA_settle = async () => {
    if (DELAY_MS <= 0) return;
    // 假定时器下 setTimeout 被冻结、等不到回包 —— 交回给测试自己推进时间。
    if (vi.isFakeTimers()) return;
    await new Promise((resolve) => {
        setTimeout(resolve, DELAY_MS + 5);
    });
};

if (DELAY_MS > 0) {
    const originalFn = vi.fn;
    const resolveLater = (value) => () => new Promise((resolve) => {
        setTimeout(() => resolve(value), DELAY_MS);
    });
    const rejectLater = (error) => () => new Promise((_, reject) => {
        setTimeout(() => reject(error), DELAY_MS);
    });

    vi.fn = (...args) => {
        const mock = originalFn(...args);
        mock.mockResolvedValue = (value) => mock.mockImplementation(resolveLater(value));
        mock.mockRejectedValue = (error) => mock.mockImplementation(rejectLater(error));
        if (typeof mock.mockResolvedValueOnce === 'function') {
            mock.mockResolvedValueOnce = (value) => mock.mockImplementationOnce(resolveLater(value));
            mock.mockRejectedValueOnce = (error) => mock.mockImplementationOnce(rejectLater(error));
        }
        return mock;
    };

    // 根治跨测试在途链污染（R50 根因 ③ 的全仓版）：上一个测试没等完的响应
    // 会在下一个测试里落地、记到别人账上。收尾统一排空再放行下一个测试。
    afterEach(async () => {
        if (vi.isFakeTimers()) return; // 假定时器下排空会冻死钩子，跳过
        await new Promise((resolve) => {
            setTimeout(resolve, DELAY_MS + 5);
        });
    });
}
