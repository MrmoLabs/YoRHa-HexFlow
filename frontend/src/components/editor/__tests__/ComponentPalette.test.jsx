import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ComponentPalette from '../ComponentPalette';

describe('ComponentPalette', () => {
    it('should render operator templates grouped by backend categories', () => {
        render(
            <ComponentPalette
                operatorTemplates={{
                    HEX_RAW: { op_code: 'HEX_RAW', name: '原始Hex', category: 'BASE', description: '固定十六进制值' },
                    ARRAY_GROUP: { op_code: 'ARRAY_GROUP', name: '嵌套组', category: 'STRUCT', description: '循环容器' }
                }}
                onAddBlock={() => { }}
            />
        );

        expect(screen.getByText('BASE')).toBeDefined();
        expect(screen.getByText('STRUCT')).toBeDefined();
        expect(screen.getByText('原始Hex')).toBeDefined();
        expect(screen.getByText('嵌套组')).toBeDefined();
    });

    it('should show retry state when operator templates fail', () => {
        const onRetry = vi.fn();

        render(
            <ComponentPalette
                operatorTemplates={{}}
                onAddBlock={() => { }}
                error="模块模板加载失败"
                onRetry={onRetry}
            />
        );

        fireEvent.click(screen.getByText('RETRY'));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });
});
