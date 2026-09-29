import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import NieRDatePicker from '../NieRDatePicker';

// 第 4 批验收期取证：isOpen=false 时组件在 useState/useEffect 之前早退（0 hooks），
// 翻转为 true 后补挂 2 hooks —— 钩子数跳变触发 React 内部错误
// （"Expected static flag was missing"，经 console.error 输出）。
// 锁定契约：isOpen false→true 切换全程无 React 内部错误（早退必须后置于 hooks）。

describe('NieRDatePicker（isOpen 切换 hooks 稳定性）', () => {
    it('isOpen false→true 切换不产生 React 内部错误', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const props = { initialValue: '2026-01-01T00:00:00', onConfirm: vi.fn(), onCancel: vi.fn() };
            const { rerender } = render(<NieRDatePicker isOpen={false} {...props} />);
            rerender(<NieRDatePicker isOpen {...props} />);
            rerender(<NieRDatePicker isOpen={false} {...props} />);

            const msgs = spy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
            expect(msgs).not.toMatch(/Internal React error|static flag/);
        } finally {
            spy.mockRestore();
        }
    });
});
