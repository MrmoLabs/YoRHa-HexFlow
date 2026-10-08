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
//
// R61（PLAN §8.93 · 2026-10-08）：销 R51 §8.83 八 第 3 条留白（§8.83 行 7401-7402 口径原文
// 「假定时器下 settle 与排空都直接跳过」、行 7480-7482 留白「其余假定时器文件的在途链未逐一
// 验证」）—— 两个盲跳点改为**有界推进假时钟**：假定时器冻结的是 `setTimeout`，等不到回包的
// 解法不是「跳过等待」，而是「把秒表交出来」。思路承 R52 §8.84 的 `__YORHA_harnessSettle`
// （假定时器下不跳过、直接 `advanceTimersByTime`；当时只作临时复检、跑完 `git checkout` 还原、
// 未入库），本批把它**收编进 `__YORHA_settle` 本体**，不另起第二个等待口。
import { afterEach, vi } from 'vitest';

const DELAY_MS = Number(globalThis.process?.env?.YORHA_API_DELAY_MS || 0);

// 让测试能断言「注入确实生效」（护栏用），而不是靠猜。
globalThis.__YORHA_DELAY_MS__ = DELAY_MS;

// ── R61 有界排空：假定时器档「推进假时钟」+ 真定时器档「有界续等」 ─────────────
// 界在哪（防死循环的双控）：① 轮数上限 SETTLE_MAX_ROUNDS；② 假档累计推进量上限 SETTLE_MAX_MS。
// 假档每轮推 `DELAY_MS + 5`（与真档那句 `setTimeout(DELAY_MS + 5)` 对齐），自己在账的在途链
// 清零、或时钟上没挂起计时器就早退 —— 与真档「等回包落地即收工」同义。
// 两个档都只在 `DELAY_MS > 0` 的门内被走到（0ms 缺省早 return，钩子都不装）。
const SETTLE_MAX_ROUNDS = 8;
const SETTLE_MAX_MS = 1000;
const SETTLE_MICROTASK_TICKS = 6;

// 在途链分账：本文件起算的延迟回包计时器（**发起 +1、落地 -1**），按「发起那一刻是不是假时钟」
// 分两本账。分账的理由：假时钟上的计时器可能被 `vi.useRealTimers()` 整个丢弃（丢弃 = 永不落地），
// 真定时器档若把它算进去会白等；真档只看 real 账，假档先看 fake 账再看时钟余量。
const pending = { real: 0, fake: 0 };

// 回包落地后的 then 链、React 的调度都在微任务里：每轮推进前后各排一遍（有界）。
const flushMicrotasks = async () => {
    for (let i = 0; i < SETTLE_MICROTASK_TICKS; i += 1) await Promise.resolve();
};

const drainFakeClock = async () => {
    const step = Math.max(DELAY_MS + 5, 1);
    let advanced = 0;
    for (let round = 0; round < SETTLE_MAX_ROUNDS; round += 1) {
        // 先排微任务：让**已落地**的回包把下一跳的计时器挂上，再看时钟还剩什么。
        await flushMicrotasks();
        if (pending.fake === 0) break;     // 自己的在途链清零 → 一秒表都不动
        if (vi.getTimerCount() === 0) break; // 时钟上没挂起的了（含被丢弃的陈账）
        const burst = Math.min(step, SETTLE_MAX_MS - advanced);
        if (burst <= 0) break;
        await vi.advanceTimersByTimeAsync(burst);
        advanced += burst;
    }
    await flushMicrotasks();
};

// 真定时器档：先等一轮 `DELAY_MS + 5` —— 与 R51 旧口径逐字一致（也覆盖不进本文件记账的
// 手动掌闸等待，如 R50 `Terminal.test.jsx` 自己的 ok()/fail()）；本文件记账的在途链还没清零，
// 就按同一时长**有界续等**（多跳链的第二跳、第三跳也在内）。
const waitReal = async () => {
    // 走到真定时器档 = 假时钟已经卸载 —— 假账上挂着的只会是「随卸载被丢弃、永不落地」的陈账，
    // 就地清零（分账口径的另一半），免得下次假档拿陈账去白推时钟。
    pending.fake = 0;
    for (let round = 0; round < SETTLE_MAX_ROUNDS; round += 1) {
        await new Promise((resolve) => {
            setTimeout(resolve, DELAY_MS + 5);
        });
        if (pending.real === 0) break;
    }
};

// 共用等待口（与 R50 Terminal.test.jsx 里 settle() 同款，抽到全仓共用）：
// 把在途响应回包等回来。缺省（0ms）立即返回 —— 与没有它逐字等价。
globalThis.__YORHA_settle = async () => {
    if (DELAY_MS <= 0) return;
    // R61：假定时器下不再盲跳 —— 有界推进假时钟，在途回包照样逼得出来。
    if (vi.isFakeTimers()) {
        await drainFakeClock();
        return;
    }
    await waitReal();
};

if (DELAY_MS > 0) {
    const originalFn = vi.fn;

    // 已进延迟链的实现打标：重复包装一律跳过（幂等 —— 防「延迟套延迟」的双倍延迟）。
    const DELAY_WRAPPED = Symbol.for('yorha.delayWrapped');
    const mark = (fn) => { fn[DELAY_WRAPPED] = true; return fn; };

    // R61：延迟回包计时器统一走这里 —— 发起记账（+1）、落地销账（-1），`pending` 两本账
    // 由此读出「还有几条在途链」，供真档有界续等与假档有界推进判「排干了没」。
    const delayTimer = (cb) => {
        const side = vi.isFakeTimers() ? 'fake' : 'real';
        pending[side] += 1;
        return setTimeout(() => {
            pending[side] -= 1;
            cb();
        }, DELAY_MS);
    };

    const resolveLater = (value) => mark(() => new Promise((resolve) => {
        delayTimer(() => resolve(value));
    }));
    const rejectLater = (error) => mark(() => new Promise((_, reject) => {
        delayTimer(() => reject(error));
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
                    (value) => { delayTimer(() => resolve(value)); },
                    (error) => { delayTimer(() => reject(error)); }
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
        // R61：假定时器下不再盲跳 —— 有界推进假时钟把在途链排干。
        // 会冻死钩子的从来不是「推进」，是「无界硬等」；界 = 轮数与累计推进量双上限。
        if (vi.isFakeTimers()) {
            await drainFakeClock();
            return;
        }
        // 真定时器档同样收成「排干为止」：单次固定等待盖不住多跳链（第一跳在窗口内落地、
        // 它的 then 又挂出第二跳），第二跳会漏到下一个测试 —— 审计实测 Sequences 6 至 7 条。
        await waitReal();
    });
}
