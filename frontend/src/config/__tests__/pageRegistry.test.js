import { describe, it, expect } from 'vitest';
import { PAGE_REGISTRY, PAGE_STATUS_BY_KEY, PAGE_STATUS_BY_PATH } from '../pageRegistry';

describe('pageRegistry', () => {
    it('should keep page keys, paths and shortcuts unique', () => {
        const keys = PAGE_REGISTRY.map((page) => page.key);
        const paths = PAGE_REGISTRY.map((page) => page.path);
        const shortcuts = PAGE_REGISTRY.map((page) => page.shortcut);

        expect(new Set(keys).size).toBe(keys.length);
        expect(new Set(paths).size).toBe(paths.length);
        expect(new Set(shortcuts).size).toBe(shortcuts.length);
    });

    it('should expose implemented state for routed pages', () => {
        expect(PAGE_STATUS_BY_PATH['/protocol']?.implemented).toBe(true);
        expect(PAGE_STATUS_BY_PATH['/instruction']?.implemented).toBe(true);
        expect(PAGE_STATUS_BY_KEY.terminal?.implemented).toBe(true);
        expect(PAGE_STATUS_BY_KEY.datahub?.implemented).toBe(true);
    });

    // R38（PLAN §8.70）：第 9 页「发前路由规则」—— 只钉新页自己的四个值，
    // 页数由「键/路径/快捷键各自唯一」那条用例自动跟随（8 → 9 不改断言）。
    it('R38 新增发前路由规则页：key / path / 中文名 / 快捷键齐备', () => {
        expect(PAGE_STATUS_BY_KEY.routing?.path).toBe('/routing');
        expect(PAGE_STATUS_BY_KEY.routing?.titleZh).toBe('发前路由规则');
        expect(PAGE_STATUS_BY_KEY.routing?.implemented).toBe(true);
        expect(PAGE_STATUS_BY_PATH['/routing']?.shortcut).toBe('H');
    });
});
