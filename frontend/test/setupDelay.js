// R51（PLAN §8.83 · 2026-10-08）：全仓 mock 响应延迟注入 —— 把「等请求不等渲染」这类竞态
// 从**概率性抖动**变成**确定性失败**，从而能一次跑出全仓隐患清单。
//
// · 缺省（不设 YORHA_API_DELAY_MS，或 =0）：本文件**一个钩子都不装**，与没有它逐字等价；
// · >0：把 vi.fn() 造出来的 mock 的 mockResolvedValue / mockRejectedValue（含 Once 变体）
//   改成「**调用时**才起算延迟」的等价实现 —— 与原语义的差别只有响应何时到。
//
// R60（PLAN §8.92 · 2026-10-08）：销掉 R51 登记的注入盲区 27 处 —— async 形态的 mock
// （`vi.fn(async …)` 14 处 + `mockImplementation(async …)` 13 处）返回 Promise 微任务即达、
// 不进延迟，15ms 探测对这 27 处是盲区。现在**只包 async 函数形态**（判据 = AsyncFunction，
// 与登记的 27 处逐一对应）：回调体照旧**调用时立即执行**（副作用、记账一字不差），被推迟的
// 只有「响应何时到」；处理器在**调用当下**就挂上原 Promise（在途拒绝不露 unhandled 窗口），
// 计时器只把已落定的结果推迟 DELAY_MS 再放行。非 async 形态一个不碰 —— R50 Terminal 自己的
// ok()/fail() 与手动掌闸 Promise（`mockImplementation(() => new Promise(…))`）照旧不进这里。
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

    // 已进延迟链的实现打标：重复包装一律跳过（幂等 —— 防「延迟套延迟」的双倍延迟）。
    const DELAY_WRAPPED = Symbol.for('yorha.delayWrapped');
    const mark = (fn) => { fn[DELAY_WRAPPED] = true; return fn; };

    const resolveLater = (value) => mark(() => new Promise((resolve) => {
        setTimeout(() => resolve(value), DELAY_MS);
    }));
    const rejectLater = (error) => mark(() => new Promise((_, reject) => {
        setTimeout(() => reject(error), DELAY_MS);
    }));

    // R60：async 函数形态判定（async 箭头与 async function 同为 AsyncFunction）。
    const isAsyncFn = (fn) => typeof fn === 'function'
        && fn.constructor?.name === 'AsyncFunction';

    // R60：async 形态的返回 Promise 也进延迟 —— 与原语义的差别只有响应何时到。
    const delayAsync = (impl) => {
        if (!isAsyncFn(impl) || impl[DELAY_WRAPPED]) return impl;
        const wrapped = function (...args) {
            const ret = impl.apply(this, args);
            return new Promise((resolve, reject) => {
                ret.then(
                    (value) => { setTimeout(() => resolve(value), DELAY_MS); },
                    (error) => { setTimeout(() => reject(error), DELAY_MS); }
                );
            });
        };
        return mark(wrapped);
    };

    vi.fn = (...args) => {
        const next = args.length > 0 && isAsyncFn(args[0])
            ? [delayAsync(args[0]), ...args.slice(1)]
            : args;
        const mock = originalFn(...next);
        // 先取原始口再改写：值设定器要直连它，绕开 R60 的包装（防双倍延迟）。
        const implNow = mock.mockImplementation.bind(mock);
        const implOnceNow = mock.mockImplementationOnce.bind(mock);
        // R51 原口径（语义一字未动）：「调用时才起算延迟」的等价实现。
        mock.mockResolvedValue = (value) => implNow(resolveLater(value));
        mock.mockRejectedValue = (error) => implNow(rejectLater(error));
        if (typeof mock.mockResolvedValueOnce === 'function') {
            mock.mockResolvedValueOnce = (value) => implOnceNow(resolveLater(value));
            mock.mockRejectedValueOnce = (error) => implOnceNow(rejectLater(error));
        }
        // R60：显式 mockImplementation（含 Once）的 async 形态也进延迟。
        mock.mockImplementation = (fn) => implNow(delayAsync(fn));
        if (typeof mock.mockImplementationOnce === 'function') {
            mock.mockImplementationOnce = (fn) => implOnceNow(delayAsync(fn));
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
