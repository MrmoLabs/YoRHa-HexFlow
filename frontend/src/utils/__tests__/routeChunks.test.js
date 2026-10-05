import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PAGE_REGISTRY } from '../../config/pageRegistry';
import {
    ROUTE_LOADERS,
    ROUTE_KEYS,
    routeComponent,
    prefetchRoute,
    hasRoute,
    __resetRouteCaches,
} from '../routeChunks';

// 每个页面必须各有自己的动态 import 载入器（路由级拆包的前提）。
const registryKeys = PAGE_REGISTRY.map((p) => p.key);

describe('routeChunks（R35 路由级拆包）', () => {
    beforeEach(() => __resetRouteCaches());
    afterEach(() => __resetRouteCaches());

    it('PAGE_REGISTRY 每个页面各登记一个 chunk 载入器，无缺无多', () => {
        expect([...ROUTE_KEYS].sort()).toEqual([...registryKeys].sort());
    });

    it('每个载入器都是动态 import（不能退化成静态 import 页面模块）', () => {
        ROUTE_KEYS.forEach((key) => {
            expect(typeof ROUTE_LOADERS[key]).toBe('function');
        });
    });

    it('未知 pageKey 一律 null / false / null（交给默认 /protocol 跳转）', () => {
        expect(routeComponent('nope')).toBeNull();
        expect(hasRoute('nope')).toBe(false);
        expect(prefetchRoute('nope')).toBeNull();
    });

    it('同一页面重复取用返回同一引用（lazy 每次新建会整页重挂载）', () => {
        const first = routeComponent('protocol');
        // React 19 的 lazy 返回 lazy 组件对象（$$typeof），不是函数。
        expect(first?.$$typeof).toBe(Symbol.for('react.lazy'));
        expect(routeComponent('protocol')).toBe(first);
        expect(routeComponent('protocol')).toBe(first);
    });

    it('不同页面各自成 chunk（引用不同）', () => {
        expect(routeComponent('protocol')).not.toBe(routeComponent('trash'));
    });

    it('prefetch 幂等：重复触发只发起一次载入', async () => {
        const original = ROUTE_LOADERS.terminal;
        let calls = 0;
        ROUTE_LOADERS.terminal = () => {
            calls += 1;
            return original();
        };
        try {
            await Promise.all([
                prefetchRoute('terminal'),
                prefetchRoute('terminal'),
                prefetchRoute('terminal'),
            ]);
            await prefetchRoute('terminal');
            expect(calls).toBe(1);
        } finally {
            ROUTE_LOADERS.terminal = original;
        }
    });

    it('prefetch 完成后 routeComponent 仍是同一引用（不重置组件）', async () => {
        const before = routeComponent('datahub');
        await prefetchRoute('datahub');
        expect(routeComponent('datahub')).toBe(before);
    });

    it('prefetch 成功后返回 pageKey，便于调用方记账', async () => {
        await expect(prefetchRoute('sequences')).resolves.toBe('sequences');
    });

    it('载入失败时 prefetch 吞掉异常（hover 预取失败不得打断导航）', async () => {
        const original = ROUTE_LOADERS.trash;
        ROUTE_LOADERS.trash = () => Promise.reject(new Error('boom'));
        try {
            await expect(prefetchRoute('trash')).resolves.toBeNull();
        } finally {
            ROUTE_LOADERS.trash = original;
        }
    });
});
