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
        expect(PAGE_STATUS_BY_KEY.terminal?.implemented).toBe(false);
        expect(PAGE_STATUS_BY_KEY.datahub?.implemented).toBe(true);
    });
});
