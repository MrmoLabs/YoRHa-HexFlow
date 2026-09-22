import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Orchestration from '../Orchestration';

// 总长度读数：值与 "Bytes" 单位分属兄弟节点，取标签所在块的合并文本
const totalSize = () => screen.getByText(/总长度/).parentElement.textContent;

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

    it('should display total size including injected payload bytes', () => {
        render(
            <Orchestration
                protocols={[
                    {
                        id: 'proto-1',
                        label: '示例协议壳',
                        children: [
                            { id: 'header', label: '帧头', type: 'fixed', byte_length: 2, hex_value: 'AA' },
                            { id: 'slot', label: '载荷插槽', type: 'slot', byte_length: 0 },
                            { id: 'tail', label: '帧尾', type: 'fixed', byte_length: 1, hex_value: '16' }
                        ]
                    }
                ]}
                instructions={[
                    {
                        id: 'inst-1',
                        name: '示例指令',
                        fields: [
                            { id: 'field-1', parent_id: null, sequence: 0, name: '命令字', byte_length: 4 },
                            { id: 'field-2', parent_id: null, sequence: 1, name: '参数', byte_length: 8 }
                        ]
                    }
                ]}
            />
        );

        // 2 (帧头) + 4 + 8 (载荷) + 1 (帧尾) = 15 —— 载荷不得计 0（C5 回归锁）
        expect(totalSize()).toContain('15 Bytes');
    });

    it('should append payload when the protocol has no slot and count the full size', () => {
        render(
            <Orchestration
                protocols={[
                    {
                        id: 'proto-1',
                        label: '无槽协议',
                        children: [
                            { id: 'header', label: '帧头', type: 'fixed', byte_length: 3, hex_value: 'AA' }
                        ]
                    }
                ]}
                instructions={[
                    {
                        id: 'inst-1',
                        name: '示例指令',
                        fields: [
                            { id: 'field-1', parent_id: null, sequence: 0, name: '命令字', byte_length: 5 }
                        ]
                    }
                ]}
            />
        );

        const canvas = screen.getByTestId('mock-canvas').textContent;
        expect(canvas).toContain('帧头');
        expect(canvas).toContain('命令字');
        // 追加顺序：协议块在前、载荷在末尾
        expect(canvas.indexOf('帧头')).toBeLessThan(canvas.indexOf('命令字'));
        expect(totalSize()).toContain('8 Bytes');
    });

    it('should render hex stream for leaf blocks and bracket containers', () => {
        const { container } = render(
            <Orchestration
                protocols={[
                    {
                        id: 'proto-1',
                        label: '协议',
                        children: [
                            { id: 'header', label: '帧头', type: 'fixed', byte_length: 1, hex_value: 'AA' },
                            { id: 'slot', label: '插槽', type: 'slot', byte_length: 0 }
                        ]
                    }
                ]}
                instructions={[
                    {
                        id: 'inst-1',
                        name: '示例指令',
                        fields: [
                            // 无 hex_value → 按 byte_length 补 00；缺 byte_length 不得崩溃
                            { id: 'field-1', parent_id: null, sequence: 0, name: '裸字段', byte_length: 2 },
                            { id: 'field-2', parent_id: null, sequence: 1, name: '零长字段' }
                        ]
                    }
                ]}
            />
        );

        const stream = container.querySelector('.break-all');
        expect(stream).not.toBeNull();
        expect(stream.textContent).toContain('AA');
        expect(stream.textContent).toContain('0000');
        // 协议壳叶子显示 hex 而非 [标签]；缺 byte_length 块显示空 hex 且页面不崩
        expect(stream.textContent).not.toContain('[帧头]');
        expect(totalSize()).toContain('3 Bytes');
    });

    it('should keep the export button disabled while the merged assembly is empty', () => {
        render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '空协议', children: [] }]}
                instructions={[{ id: 'inst-1', name: '空指令', fields: [] }]}
            />
        );

        expect(totalSize()).toContain('0 Bytes');
        const btn = screen.getByRole('button', { name: 'EXPORT .BIN' });
        expect(btn.disabled).toBe(true);
    });
});
