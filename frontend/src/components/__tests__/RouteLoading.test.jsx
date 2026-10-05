import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RouteLoading from '../RouteLoading';

const renderAt = (path) =>
    render(
        <MemoryRouter initialEntries={[path]}>
            <RouteLoading />
        </MemoryRouter>
    );

// Suspense fallback：只陈述「正在载入哪个模块」，不承诺进度百分比。
describe('RouteLoading（R35 拆包 fallback）', () => {
    it('暴露 role=status 供读屏播报', () => {
        const { container } = renderAt('/protocol');
        const region = container.querySelector('[role="status"]');
        expect(region).toBeTruthy();
        expect(region.getAttribute('aria-live')).toBe('polite');
    });

    it('已登记路由显示中文页名', () => {
        renderAt('/sequences');
        expect(screen.getByText(/序列编排/)).toBeTruthy();
    });

    it('未知路由回落到站点名，不臆造页面名', () => {
        renderAt('/nope');
        expect(screen.getByText(/YoRHa-HexFlow/)).toBeTruthy();
    });

    it('带方括号的工业标记 + 等宽字体（数据一律 mono）', () => {
        const { container } = renderAt('/protocol');
        expect(screen.getByText(/\[ MODULE LOAD \]/)).toBeTruthy();
        expect(container.querySelector('.font-mono')).toBeTruthy();
    });
});
