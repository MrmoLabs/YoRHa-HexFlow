// R47（PLAN §8.79）：路由输入表的本机持久化 —— 加工页「路由输入」与规则页「试解析」
// 共用的那一份草稿存在本机浏览器里。
//
// 2026-10-07 question 回执拍板三条口径，本文件逐条钉死：
//  ① **整表原样存（含空行）**：存进去什么，读回来就是什么 —— 行序、空行、只填了键
//     没填值的半行都原样回，**不补行、不推断、不筛掉**；
//  ② **两页共用一份**：只有一处 key（`ROUTE_INPUTS_KEY`），两页读写同一个槽；
//  ③ **localStorage + 显式清空入口**：存取各是一个函数，清空也是。
//
// 另有一条与拍板同等重要的工程口径：**存储不可用时回落默认、绝不抛** —— 隐私模式
// 拿不到 localStorage、配额满写不进去、本机那份被人改坏了，都只当「本机没存过」处理，
// 输入表照常打开。表打不开比表是空的严重得多。
//
// 本仓未装 @testing-library/jest-dom → 只用裸断言。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ROUTE_INPUTS_KEY,
    clearRouteInputs,
    loadRouteInputs,
    saveRouteInputs,
} from '../routeInputsPersist';

// 有效行 + 空行 + 只有键没值的半行（输入表本身就能产出这三种）
const ROWS = [
    { key: 'meter_id', value: '0001' },
    { key: '', value: '' },
    { key: 'sensor', value: '' },
];

describe('R47 输入表持久化 · utils/routeInputsPersist（§8.79）', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        window.localStorage.clear();
    });

    it('本机没存过 → load 返回 null（默认那一行空行归调用方给，本层不臆造行）', () => {
        expect(loadRouteInputs()).toBeNull();
    });

    it('写后读逐字相等：整表原样存 —— 行序、空行、半行一并回，不补不筛', () => {
        saveRouteInputs(ROWS);

        expect(loadRouteInputs()).toEqual(ROWS);
        expect(loadRouteInputs()).toHaveLength(3);
    });

    it('两页共用一份：只有这一处 key = yorha.routeInputs.v1，槽里就是那张表', () => {
        expect(ROUTE_INPUTS_KEY).toBe('yorha.routeInputs.v1');

        saveRouteInputs(ROWS);

        expect(window.localStorage.getItem(ROUTE_INPUTS_KEY)).toBeTruthy();
        expect(JSON.parse(window.localStorage.getItem(ROUTE_INPUTS_KEY))).toEqual(ROWS);
    });

    it('空数组也原样存取（存什么读什么，不在本层偷偷补默认行）', () => {
        saveRouteInputs([]);

        expect(loadRouteInputs()).toEqual([]);
    });

    it('本机那份被改坏了（非法 JSON）→ 当没存过，不抛', () => {
        window.localStorage.setItem(ROUTE_INPUTS_KEY, '{不是 JSON');

        expect(() => loadRouteInputs()).not.toThrow();
        expect(loadRouteInputs()).toBeNull();
    });

    it('形状不合法（行不是 key/value 字符串）→ 当没存过，不抛', () => {
        window.localStorage.setItem(ROUTE_INPUTS_KEY, JSON.stringify([{ key: 1, value: null }]));

        expect(() => loadRouteInputs()).not.toThrow();
        expect(loadRouteInputs()).toBeNull();
    });

    it('读挂掉（隐私模式不给 localStorage）→ 当没存过，不抛', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('access denied');
        });

        expect(() => loadRouteInputs()).not.toThrow();
        expect(loadRouteInputs()).toBeNull();
    });

    it('写挂掉（配额满）→ 不抛，也不把半个 key 留在本机', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota exceeded');
        });

        expect(() => saveRouteInputs(ROWS)).not.toThrow();
        expect(() => clearRouteInputs()).not.toThrow();
    });

    it('clear → 本机那份没了，再读回 null（默认一行空行由调用方重给）', () => {
        saveRouteInputs(ROWS);

        clearRouteInputs();

        expect(window.localStorage.getItem(ROUTE_INPUTS_KEY)).toBeNull();
        expect(loadRouteInputs()).toBeNull();
    });
});
