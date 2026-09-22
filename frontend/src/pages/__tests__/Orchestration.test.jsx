import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Orchestration from '../Orchestration';

vi.mock('../../components/editor/Canvas', () => ({
    default: ({ lanes }) => (
        <div data-testid="mock-canvas">
            {lanes.flatMap(lane => lane.items.map(item => item.label || item.name)).join('|')}
        </div>
    )
}));

describe('Orchestration Page', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should inject instruction blocks into the protocol slot', () => {
        render(
            <Orchestration
                protocols={[
                    {
                        id: 'proto-1',
                        label: '示例协议壳',
                        children: [
                            { id: 'header', label: '帧头', type: 'fixed', byte_length: 1, hex_value: 'AA', children: [] },
                            { id: 'slot', label: '载荷插槽', type: 'slot', byte_length: 0, children: [] },
                            { id: 'tail', label: '帧尾', type: 'fixed', byte_length: 1, hex_value: '16', children: [] }
                        ]
                    }
                ]}
                instructions={[
                    {
                        id: 'inst-1',
                        name: '示例指令',
                        fields: [
                            { id: 'field-1', parent_id: null, sequence: 0, name: '命令字', byte_length: 1 }
                        ]
                    }
                ]}
            />
        );

        expect(screen.getByTestId('mock-canvas').textContent).toContain('帧头');
        expect(screen.getByTestId('mock-canvas').textContent).toContain('命令字');
        expect(screen.getByTestId('mock-canvas').textContent).toContain('帧尾');
        expect(screen.getByText('* Yellow indicates injected Payload')).toBeDefined();
    });

    it('should add a second binding entry', () => {
        render(
            <Orchestration
                protocols={[
                    { id: 'proto-1', label: '协议A', children: [] }
                ]}
                instructions={[
                    { id: 'inst-1', name: '指令A', fields: [] }
                ]}
            />
        );

        expect(screen.getAllByText(/绑定/i).length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: '+' }));

        expect(screen.getByText('新绑定 (NEW)')).toBeDefined();
        expect(screen.getByText('默认绑定 (DEFAULT)')).toBeDefined();
    });
});
