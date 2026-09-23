import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import Protocol from '../Protocol';
import { api } from '../../api';

vi.mock('../../api', () => ({
    api: {
        createProtocol: vi.fn(),
        updateProtocol: vi.fn(),
        deleteProtocol: vi.fn()
    }
}));

vi.mock('../../components/editor/Canvas', () => ({
    default: ({ lanes, onSelect, onMoveItem }) => (
        <div data-testid="mock-canvas">
            <div>{lanes.map(lane => `${lane.parentName}:${lane.items.length}`).join('|')}</div>
            {lanes.flatMap(lane => lane.items).map((item, index) => (
                <React.Fragment key={item.id}>
                    <button onClick={() => onSelect(item.id)}>
                        {item.label}
                    </button>
                    {/* Drag surrogate: Canvas exposes onMoveItem for drag-and-drop */}
                    <button data-testid={`move-${item.id}`} onClick={() => onMoveItem(item.id, null, index + 1)}>
                        move {item.label}
                    </button>
                </React.Fragment>
            ))}
        </div>
    )
}));

function ProtocolHarness({ initialProtocols }) {
    const [protocols, setProtocols] = useState(initialProtocols);
    return <Protocol protocols={protocols} setProtocols={setProtocols} />;
}

describe('Protocol Page', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should create a new protocol via the API and select it', async () => {
        vi.useRealTimers();
        const setProtocols = vi.fn();
        api.createProtocol.mockResolvedValue({
            id: 'proto-2',
            label: '新协议 (NEW)',
            type: 'container',
            children: []
        });

        render(
            <Protocol
                protocols={[
                    { id: 'proto-1', label: '示例协议', type: 'container', children: [] }
                ]}
                setProtocols={setProtocols}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: '+' }));

        await waitFor(() => {
            expect(api.createProtocol).toHaveBeenCalledWith(expect.objectContaining({
                label: '新协议 (NEW)',
                type: 'container',
                children: []
            }));
        });

        expect(setProtocols).toHaveBeenCalled();
        vi.useFakeTimers();
    });

    it('should debounce protocol label updates before saving', async () => {
        const setProtocols = vi.fn();
        api.updateProtocol.mockResolvedValue({
            id: 'proto-1',
            label: '改名后的协议',
            type: 'container',
            children: []
        });

        render(
            <Protocol
                protocols={[
                    { id: 'proto-1', label: '示例协议', type: 'container', children: [] }
                ]}
                setProtocols={setProtocols}
            />
        );

        fireEvent.change(screen.getByDisplayValue('示例协议'), {
            target: { value: '改名后的协议' }
        });

        expect(api.updateProtocol).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(400);
            await Promise.resolve();
        });

        expect(api.updateProtocol).toHaveBeenCalledWith('proto-1', {
            label: '改名后的协议',
            type: 'container',
            description: null,
            children: []
        });
    });

    it('A+B 内联展开：默认全展开，点容器卡 toggle，ENTER 重聚焦，深层编辑持久化整树', async () => {
        api.updateProtocol.mockImplementation(async (id, payload) => ({ id, ...payload }));

        render(
            <ProtocolHarness
                initialProtocols={[
                    {
                        id: 'proto-1',
                        label: '主协议',
                        type: 'container',
                        children: [
                            {
                                id: 'group-1',
                                label: '载荷容器',
                                type: 'container',
                                byte_length: 0,
                                children: [
                                    {
                                        id: 'fixed-1',
                                        label: '固定头',
                                        type: 'fixed',
                                        byte_length: 1,
                                        hex_value: 'AA'
                                    }
                                ]
                            }
                        ]
                    }
                ]}
            />
        );

        // 切协议默认全展开（镜像 useInstructionLanes:50-53）：根泳道 + 子泳道同时在场
        const canvas = screen.getByTestId('mock-canvas');
        expect(canvas.textContent).toContain('主协议:1');
        expect(canvas.textContent).toContain('载荷容器:1');

        // 点容器卡 = 选中 + 收起（指令页 select+navigate 双发的页面层实现）
        fireEvent.click(screen.getByRole('button', { name: '载荷容器' }));
        expect(screen.getByTestId('mock-canvas').textContent).not.toContain('载荷容器:1');

        // 属性面板 ENTER 保留（内联化 = 确保展开 + 聚焦）
        fireEvent.click(screen.getByRole('button', { name: /进入容器/i }));
        expect(screen.getByTestId('mock-canvas').textContent).toContain('载荷容器:1');

        // 子泳道内叶块编辑 → 防抖持久化整棵深树
        fireEvent.click(screen.getByRole('button', { name: '固定头' }));
        fireEvent.change(screen.getByDisplayValue('固定头'), {
            target: { value: '固定尾' }
        });

        await act(async () => {
            vi.advanceTimersByTime(400);
            await Promise.resolve();
        });

        expect(api.updateProtocol).toHaveBeenLastCalledWith('proto-1', expect.objectContaining({
            label: '主协议',
            type: 'container',
            children: [
                expect.objectContaining({
                    id: 'group-1',
                    label: '载荷容器',
                    type: 'container',
                    children: [
                        expect.objectContaining({
                            id: 'fixed-1',
                            label: '固定尾',
                            type: 'fixed'
                        })
                    ]
                })
            ]
        }));
    });

    it('新容器从调色板加入后自动展开成内联泳道（镜像 Instruction.jsx:266-271）', async () => {
        api.updateProtocol.mockImplementation(async (id, payload) => ({ id, ...payload }));

        render(
            <ProtocolHarness
                initialProtocols={[
                    { id: 'proto-1', label: '主协议', type: 'container', children: [] }
                ]}
            />
        );

        expect(screen.getByTestId('mock-canvas').textContent).not.toContain('新容器:');

        fireEvent.click(screen.getByTitle('新建容器'));

        expect(screen.getByRole('button', { name: '新容器' })).toBeDefined();
        // 自动展开 → 新容器的空子泳道立即在场（不进折叠层盲加子块）
        expect(screen.getByTestId('mock-canvas').textContent).toContain('新容器:0');

        await act(async () => {
            vi.advanceTimersByTime(400);
            await Promise.resolve();
        });

        expect(api.updateProtocol).toHaveBeenCalledWith('proto-1', expect.objectContaining({
            children: [
                expect.objectContaining({
                    label: '新容器',
                    type: 'container',
                    byte_length: 0,
                    children: []
                })
            ]
        }));
    });

    it('should reorder blocks via the canvas move (drag) callback and persist the order', async () => {
        api.updateProtocol.mockImplementation(async (id, payload) => ({ id, ...payload }));

        render(
            <ProtocolHarness
                initialProtocols={[
                    {
                        id: 'proto-1',
                        label: '主协议',
                        type: 'container',
                        children: [
                            { id: 'block-a', label: '甲块', type: 'fixed', byte_length: 1, hex_value: 'AA' },
                            { id: 'block-b', label: '乙块', type: 'fixed', byte_length: 1, hex_value: 'BB' }
                        ]
                    }
                ]}
            />
        );

        // Drag 甲块 to index 1 (after 乙块)
        fireEvent.click(screen.getByTestId('move-block-a'));

        await act(async () => {
            vi.advanceTimersByTime(400);
            await Promise.resolve();
        });

        expect(api.updateProtocol).toHaveBeenCalledWith('proto-1', expect.objectContaining({
            children: [
                expect.objectContaining({ id: 'block-b', label: '乙块' }),
                expect.objectContaining({ id: 'block-a', label: '甲块' })
            ]
        }));
    });

    it('should edit block properties in the properties panel and persist them', async () => {
        api.updateProtocol.mockImplementation(async (id, payload) => ({ id, ...payload }));

        render(
            <ProtocolHarness
                initialProtocols={[
                    {
                        id: 'proto-1',
                        label: '主协议',
                        type: 'container',
                        children: [
                            { id: 'block-a', label: '甲块', type: 'fixed', byte_length: 1, hex_value: 'AA' }
                        ]
                    }
                ]}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: '甲块' }));

        // Byte length field (rendered from config/blockTypes.js field defs)
        const lengthLabel = screen.getByText('字节长度 (Length)');
        fireEvent.change(lengthLabel.parentElement.querySelector('input'), {
            target: { value: '4' }
        });

        // Hex value field (fixed blocks only)
        const hexLabel = screen.getByText('十六进制值 (Hex)');
        fireEvent.change(hexLabel.parentElement.querySelector('input'), {
            target: { value: 'FF' }
        });

        await act(async () => {
            vi.advanceTimersByTime(400);
            await Promise.resolve();
        });

        expect(api.updateProtocol).toHaveBeenCalledWith('proto-1', expect.objectContaining({
            children: [
                expect.objectContaining({ id: 'block-a', byte_length: 4, hex_value: 'FF' })
            ]
        }));
    });

    it('should add a block from the palette using the block type config defaults', async () => {
        api.updateProtocol.mockImplementation(async (id, payload) => ({ id, ...payload }));

        render(
            <ProtocolHarness
                initialProtocols={[
                    { id: 'proto-1', label: '主协议', type: 'container', children: [] }
                ]}
            />
        );

        fireEvent.click(screen.getByTitle('添加固定块 (Fixed)'));

        expect(screen.getByRole('button', { name: '固定块' })).toBeDefined();

        await act(async () => {
            vi.advanceTimersByTime(400);
            await Promise.resolve();
        });

        expect(api.updateProtocol).toHaveBeenCalledWith('proto-1', expect.objectContaining({
            children: [
                expect.objectContaining({
                    label: '固定块',
                    type: 'fixed',
                    byte_length: 1,
                    hex_value: '00',
                    config: {}
                })
            ]
        }));
    });

    it('should surface a save failure status when the API rejects', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        api.updateProtocol.mockRejectedValue(new Error('boom'));

        try {
            render(
                <Protocol
                    protocols={[
                        { id: 'proto-1', label: '示例协议', type: 'container', children: [] }
                    ]}
                    setProtocols={vi.fn()}
                />
            );

            fireEvent.change(screen.getByDisplayValue('示例协议'), {
                target: { value: '改名后的协议' }
            });

            await act(async () => {
                vi.advanceTimersByTime(400);
                await Promise.resolve();
            });

            expect(api.updateProtocol).toHaveBeenCalled();
            expect(screen.getByText(/协议保存失败/)).toBeDefined();
        } finally {
            errorSpy.mockRestore();
        }
    });
});
