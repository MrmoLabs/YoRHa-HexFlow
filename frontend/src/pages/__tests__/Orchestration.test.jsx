import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Orchestration from '../Orchestration';
import { api } from '../../api';

// E4：编排页绑定读写接线 /bindings CRUD —— 挂载加载、加/删/改回写、防抖与降级。
const totalSize = () => screen.getByText(/总长度/).parentElement.textContent;

vi.mock('../../components/editor/Canvas', () => ({
    default: ({ lanes }) => (
        <div data-testid="mock-canvas">
            {lanes.flatMap(lane => lane.items.map(item => item.label || item.name)).join('|')}
        </div>
    )
}));

vi.mock('../../api', () => ({
    api: {
        getBindings: vi.fn(),
        createBinding: vi.fn(),
        updateBinding: vi.fn(),
        deleteBinding: vi.fn(),
        exportBinaryFromBlocks: vi.fn(),
        compileWrapped: vi.fn(),
        dispatchPayload: vi.fn()
    }
}));

const mountApis = () => {
    api.getBindings.mockResolvedValue([]);
    api.createBinding.mockImplementation((payload) => Promise.resolve({ ...payload, slot_order: 0 }));
    api.updateBinding.mockImplementation((id, payload) => Promise.resolve({ ...payload, id }));
    api.deleteBinding.mockResolvedValue({ status: 'deleted' });
    api.exportBinaryFromBlocks.mockResolvedValue(new Blob(['']));
    api.compileWrapped.mockResolvedValue({ hex_string: 'AA 05 01', total_length: 3, warnings: [] });
    api.dispatchPayload.mockResolvedValue({ status: 'ok', hex_string: 'AA 05' });
};

// 等待挂载加载 + 默认绑定落定（加载链路为异步微任务）
const awaitDefaultBinding = () => screen.findByText('默认绑定 (DEFAULT)', undefined, { timeout: 2000 });

describe('Orchestration Page', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mountApis();
    });

    it('should inject instruction blocks into the protocol slot', async () => {
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

        await awaitDefaultBinding();
        expect(screen.getByTestId('mock-canvas').textContent).toContain('帧头');
        expect(screen.getByTestId('mock-canvas').textContent).toContain('命令字');
        expect(screen.getByTestId('mock-canvas').textContent).toContain('帧尾');
        expect(screen.getByText('* Yellow indicates injected Payload')).toBeDefined();
    });

    it('should add a second binding entry', async () => {
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

        await awaitDefaultBinding();
        expect(screen.getAllByText(/绑定/i).length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: '+' }));

        expect(screen.getByText('新绑定 (NEW)')).toBeDefined();
        expect(screen.getByText('默认绑定 (DEFAULT)')).toBeDefined();
    });

    it('should display total size including injected payload bytes', async () => {
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

        await awaitDefaultBinding();
        // 2 (帧头) + 4 + 8 (载荷) + 1 (帧尾) = 15 —— 载荷不得计 0（C5 回归锁）
        expect(totalSize()).toContain('15 Bytes');
    });

    it('should append payload when the protocol has no slot and count the full size', async () => {
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

        await awaitDefaultBinding();
        const canvas = screen.getByTestId('mock-canvas').textContent;
        expect(canvas).toContain('帧头');
        expect(canvas).toContain('命令字');
        // 追加顺序：协议块在前、载荷在末尾
        expect(canvas.indexOf('帧头')).toBeLessThan(canvas.indexOf('命令字'));
        expect(totalSize()).toContain('8 Bytes');
    });

    it('should render hex stream for leaf blocks and bracket containers', async () => {
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

        await awaitDefaultBinding();
        const stream = container.querySelector('.break-all');
        expect(stream).not.toBeNull();
        expect(stream.textContent).toContain('AA');
        expect(stream.textContent).toContain('0000');
        // 协议壳叶子显示 hex 而非 [标签]；缺 byte_length 块显示空 hex 且页面不崩
        expect(stream.textContent).not.toContain('[帧头]');
        expect(totalSize()).toContain('3 Bytes');
    });

    it('should keep the export button disabled while the merged assembly is empty', async () => {
        render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '空协议', children: [] }]}
                instructions={[{ id: 'inst-1', name: '空指令', fields: [] }]}
            />
        );

        await awaitDefaultBinding();
        expect(totalSize()).toContain('0 Bytes');
        const btn = screen.getByRole('button', { name: 'EXPORT .BIN' });
        expect(btn.disabled).toBe(true);
    });

    it('loads server-side bindings on mount and does not re-seed defaults', async () => {
        api.getBindings.mockResolvedValue([
            { id: 'srv-1', label: '服务端绑定A', protocol_id: 'proto-1', instruction_id: 'inst-1', slot_order: 0 },
            { id: 'srv-2', label: '服务端绑定B', protocol_id: 'proto-1', instruction_id: 'inst-1', slot_order: 1 }
        ]);

        render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '协议A', children: [] }]}
                instructions={[{ id: 'inst-1', name: '指令A', fields: [] }]}
            />
        );

        expect(await screen.findByText('服务端绑定A')).toBeDefined();
        expect(screen.getByText('服务端绑定B')).toBeDefined();
        expect(api.getBindings).toHaveBeenCalledTimes(1);
        // 服务端已有绑定 → 不种默认、不 POST
        expect(screen.queryByText('默认绑定 (DEFAULT)')).toBeNull();
        expect(api.createBinding).not.toHaveBeenCalled();
        // 默认选中首条（服务端顺序）
        expect(api.updateBinding).not.toHaveBeenCalled(); // id 齐全 → 无回填写入
    });

    it('persists a new binding via POST /bindings', async () => {
        render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '协议A', children: [] }]}
                instructions={[{ id: 'inst-1', name: '指令A', fields: [] }]}
            />
        );

        await awaitDefaultBinding();
        expect(api.createBinding).toHaveBeenCalledWith(expect.objectContaining({
            protocol_id: 'proto-1',
            instruction_id: 'inst-1',
            label: '默认绑定 (DEFAULT)'
        }));

        fireEvent.click(screen.getByRole('button', { name: '+' }));
        await waitFor(() => expect(api.createBinding).toHaveBeenCalledTimes(2));
        expect(api.createBinding).toHaveBeenLastCalledWith(expect.objectContaining({
            label: '新绑定 (NEW)',
            protocol_id: 'proto-1',
            instruction_id: 'inst-1'
        }));
    });

    it('PUTs select changes immediately and debounces label edits (400ms)', async () => {
        const { container } = render(
            <Orchestration
                protocols={[
                    { id: 'proto-1', label: '协议A', children: [] },
                    { id: 'proto-2', label: '协议B', children: [] }
                ]}
                instructions={[{ id: 'inst-1', name: '指令A', fields: [] }]}
            />
        );

        await awaitDefaultBinding();
        api.updateBinding.mockClear();

        // 协议选择 → 即时 PUT（label/select 为兄弟节点结构，容器查询定位控件）
        const protocolSelect = container.querySelectorAll('select')[0];
        fireEvent.change(protocolSelect, { target: { value: 'proto-2' } });
        await waitFor(() => expect(api.updateBinding).toHaveBeenCalledTimes(1));
        expect(api.updateBinding).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            protocol_id: 'proto-2'
        }));

        // label 输入 → 不立即 PUT（防抖），到期后按合并快照落盘
        const beforeLabel = api.updateBinding.mock.calls.length;
        const labelInput = screen.getByDisplayValue('默认绑定 (DEFAULT)');
        fireEvent.change(labelInput, { target: { value: '改名了' } });
        expect(api.updateBinding.mock.calls.length).toBe(beforeLabel);

        await waitFor(
            () => expect(api.updateBinding.mock.calls.length).toBeGreaterThan(beforeLabel),
            { timeout: 2000 }
        );
        const lastCall = api.updateBinding.mock.calls.at(-1);
        expect(lastCall[1]).toEqual(expect.objectContaining({
            label: '改名了',
            protocol_id: 'proto-2' // 防抖快照携带最新选择（不被旧值回冲）
        }));
    });

    it('deletes a binding via DELETE and shrinks the list', async () => {
        render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '协议A', children: [] }]}
                instructions={[{ id: 'inst-1', name: '指令A', fields: [] }]}
            />
        );

        await awaitDefaultBinding();
        fireEvent.click(screen.getByRole('button', { name: '+' }));
        expect(screen.getByText('新绑定 (NEW)')).toBeDefined();

        const newRow = screen.getByText('新绑定 (NEW)').parentElement;
        fireEvent.click(newRow.querySelector('button'));

        expect(screen.queryByText('新绑定 (NEW)')).toBeNull(); // 本地即时收缩
        await waitFor(() => expect(api.deleteBinding).toHaveBeenCalledTimes(1));
        expect(api.deleteBinding).toHaveBeenCalledWith(expect.any(String));
    });

    it('degrades to local-only editing when loading fails', async () => {
        api.getBindings.mockRejectedValue(new Error('backend down'));

        render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '协议A', children: [] }]}
                instructions={[{ id: 'inst-1', name: '指令A', fields: [] }]}
            />
        );

        expect(await screen.findByText(/加载失败/)).toBeDefined();
        expect(await screen.findByText('默认绑定 (DEFAULT)')).toBeDefined();
        // 加载失败 → 不向后端写任何东西
        expect(api.createBinding).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: '+' }));
        expect(screen.getByText('新绑定 (NEW)')).toBeDefined();
        expect(api.createBinding).not.toHaveBeenCalled();
        expect(api.updateBinding).not.toHaveBeenCalled();
    });

    // B2 组作用域合并：同协议多绑定按 slot_order 升序 → 指令数组依洞序填洞
    //（服务端行乱序返回也要按 slot_order 归位；单绑定退化为 E4 原语义）。
    it('B2 组作用域合并：同协议多绑定按 slot_order 升序依洞填装', async () => {
        api.getBindings.mockResolvedValue([
            { id: 'srv-2', label: '绑定乙', protocol_id: 'proto-1', instruction_id: 'inst-2', slot_order: 1 },
            { id: 'srv-1', label: '绑定甲', protocol_id: 'proto-1', instruction_id: 'inst-1', slot_order: 0 }
        ]);

        render(
            <Orchestration
                protocols={[{
                    id: 'proto-1',
                    label: '双洞协议',
                    children: [
                        { id: 's1', label: '洞一', type: 'slot', byte_length: 0, hex_value: '00' },
                        { id: 's2', label: '洞二', type: 'slot', byte_length: 0, hex_value: '00' }
                    ]
                }]}
                instructions={[
                    { id: 'inst-1', name: '指令一', fields: [{ id: 'f1', parent_id: null, sequence: 0, name: '载荷1', byte_length: 1 }] },
                    { id: 'inst-2', name: '指令二', fields: [{ id: 'f2', parent_id: null, sequence: 0, name: '载荷2', byte_length: 1 }] }
                ]}
            />
        );

        await screen.findByText('绑定乙');
        const canvas = screen.getByTestId('mock-canvas');
        await waitFor(() => expect(canvas.textContent).toContain('载荷1'));
        expect(canvas.textContent).toContain('载荷2');
        // slot_order 升序：甲(0)→洞一、乙(1)→洞二
        expect(canvas.textContent.indexOf('载荷1')).toBeLessThan(canvas.textContent.indexOf('载荷2'));
    });

    // B3 洞位下拉（稠密位次）：改洞 → 组内重编号 0..n-1 仅回写变化行 →
    // 填装序翻转；countSlots 对账 → 洞位不足/空洞/无 SLOT 警示。
    it('B3 洞位下拉：换洞回写 slot_order 并翻转填装序，countSlots 洞位不足警示', async () => {
        api.getBindings.mockResolvedValue([
            { id: 'srv-1', label: '绑定甲', protocol_id: 'proto-1', instruction_id: 'inst-1', slot_order: 0 },
            { id: 'srv-2', label: '绑定乙', protocol_id: 'proto-1', instruction_id: 'inst-2', slot_order: 1 }
        ]);

        render(
            <Orchestration
                protocols={[{
                    id: 'proto-1',
                    label: '单洞协议',
                    children: [{ id: 's1', label: '洞一', type: 'slot', byte_length: 0, hex_value: '00' }]
                }]}
                instructions={[
                    { id: 'inst-1', name: '指令一', fields: [{ id: 'f1', parent_id: null, sequence: 0, name: '载荷1', byte_length: 1 }] },
                    { id: 'inst-2', name: '指令二', fields: [{ id: 'f2', parent_id: null, sequence: 0, name: '载荷2', byte_length: 1 }] }
                ]}
            />
        );

        await screen.findByText('绑定甲');
        // 2 绑定 > 1 洞 → countSlots 对账警示
        expect(screen.getByText(/洞位不足/)).toBeDefined();

        // 洞号 = 同协议绑定按 slot_order 升序的位次（甲在首位 → #0）
        const holeSelect = screen.getByLabelText(/洞位/);
        expect(holeSelect.value).toBe('0');

        api.updateBinding.mockClear();
        fireEvent.change(holeSelect, { target: { value: '1' } });
        await waitFor(() => {
            expect(api.updateBinding).toHaveBeenCalledWith('srv-1', expect.objectContaining({ slot_order: 1 }));
            expect(api.updateBinding).toHaveBeenCalledWith('srv-2', expect.objectContaining({ slot_order: 0 }));
        });

        // 组序翻转 → 乙(载荷2) 填第一洞
        await waitFor(() => {
            const canvas = screen.getByTestId('mock-canvas');
            expect(canvas.textContent.indexOf('载荷2')).toBeLessThan(canvas.textContent.indexOf('载荷1'));
        });
    });

    // 侧栏重排：服务端 GET /bindings 仍全局 slot_order 排 → 前端按
    // (协议序, 洞号) 重排，跨协议绑定不按全局洞号穿插。
    it('侧栏按（协议序, 洞号）重排', async () => {
        api.getBindings.mockResolvedValue([
            { id: 'b-a1', label: '甲1', protocol_id: 'proto-a', instruction_id: 'inst-1', slot_order: 1 },
            { id: 'b-b1', label: '乙1', protocol_id: 'proto-b', instruction_id: 'inst-1', slot_order: 0 },
            { id: 'b-a2', label: '甲2', protocol_id: 'proto-a', instruction_id: 'inst-1', slot_order: 0 }
        ]);

        const { container } = render(
            <Orchestration
                protocols={[
                    { id: 'proto-a', label: '协议A', children: [] },
                    { id: 'proto-b', label: '协议B', children: [] }
                ]}
                instructions={[{ id: 'inst-1', name: '指令A', fields: [] }]}
            />
        );

        await screen.findByText('甲1');
        const rows = [...container.querySelectorAll('aside:first-of-type .truncate')]
            .map(el => el.textContent);
        expect(rows).toEqual(['甲2', '甲1', '乙1']);
    });

    it('C1 封装试发：空组装禁发', async () => {
        render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '空协议', children: [] }]}
                instructions={[{ id: 'inst-1', name: '空指令', fields: [] }]}
            />
        );

        await awaitDefaultBinding();
        const btn = screen.getByRole('button', { name: /封装试发/ });
        expect(btn.disabled).toBe(true);
        fireEvent.click(btn);
        expect(api.dispatchPayload).not.toHaveBeenCalled();
    });

    // C1 封装试发闭环（批次一 D4 改线）：逐指令前端编码内核 → POST /compile/wrapped
    //（后端唯一封装入口）→ POST /dispatch 发封装帧；失败（含 409 detail）透出。
    it('C1 封装试发：编码内核 → compileWrapped → dispatchPayload，SENT 回显 / 失败透出', async () => {
        render(
            <Orchestration
                protocols={[{
                    id: 'proto-1',
                    label: '壳协议',
                    children: [
                        { id: 'h', label: '帧头', type: 'fixed', byte_length: 1, hex_value: 'AA' },
                        { id: 's', label: '洞', type: 'slot', byte_length: 0, hex_value: '00' }
                    ]
                }]}
                instructions={[{
                    id: 'inst-1',
                    name: '示例指令',
                    fields: [{ id: 'f1', parent_id: null, sequence: 0, name: '命令字', byte_length: 1 }]
                }]}
            />
        );

        await awaitDefaultBinding();

        fireEvent.click(screen.getByRole('button', { name: /封装试发/ }));
        // 逐指令编码内核（byte_length 1 无 op → '00'）→ compileWrapped 走后端封装
        await waitFor(() => expect(api.compileWrapped).toHaveBeenCalledTimes(1));
        expect(api.compileWrapped).toHaveBeenCalledWith({
            protocolId: 'proto-1',
            payloads: ['00'],
            slotIds: [null],
            startOrder: 0
        });
        await waitFor(() => expect(api.dispatchPayload).toHaveBeenCalledTimes(1));
        expect(api.dispatchPayload).toHaveBeenCalledWith('AA 05 01', '示例指令');
        expect(await screen.findByText(/^SENT:/)).toBeDefined();

        api.dispatchPayload.mockRejectedValueOnce(new Error('409: dispatch in flight'));
        fireEvent.click(screen.getByRole('button', { name: /封装试发/ }));
        expect(await screen.findByText(/SEND FAILED: 409/)).toBeDefined();
    });

    // 批次一 (D1 一行两用): 星标 = 指令默认封装绑定 —— 设默认须点击确认（人工
    // 验证反馈 1：改变绑定关系语义的操作要有确认环节），取消默认直执行；
    // 确认后 PUT is_default、服务端同事务清旧默认 → 本地同步清星；三字段出线。
    it('D1 星标：设默认弹确认（取消不 PUT、确认才 PUT）并本地同指令清旧星，取消星直执行', async () => {
        api.getBindings.mockResolvedValue([
            { id: 'srv-1', label: '绑定甲', protocol_id: 'proto-1', instruction_id: 'inst-1',
                slot_order: 0, slot_id: 's1', is_default: true, priority: 0 },
            { id: 'srv-2', label: '绑定乙', protocol_id: 'proto-1', instruction_id: 'inst-1',
                slot_order: 1, slot_id: null, is_default: false, priority: 0 }
        ]);
        render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '协议A', children: [] }]}
                instructions={[{ id: 'inst-1', name: '指令A', fields: [] }]}
            />
        );

        await screen.findByText('绑定乙');
        const starOf = (label) => screen.getByText(label).parentElement
            .querySelector('[title*="默认封装"]');

        // 甲已默认 → ★ 常显；乙未默认 → ☆
        expect(starOf('绑定甲').textContent).toBe('★');
        expect(starOf('绑定乙').textContent).toBe('☆');

        // 点乙星（设默认）→ 只弹确认框，未 PUT、本地未变
        fireEvent.click(starOf('绑定乙'));
        expect(await screen.findByText(/默认封装绑定/)).toBeDefined();
        expect(api.updateBinding).not.toHaveBeenCalled();
        expect(starOf('绑定乙').textContent).toBe('☆');

        // 取消 → 关弹窗，仍未 PUT
        fireEvent.click(screen.getByRole('button', { name: /取消 \(CANCEL\)/ }));
        await waitFor(() => expect(screen.queryByText(/默认封装绑定/)).toBeNull());
        expect(api.updateBinding).not.toHaveBeenCalled();

        // 再点星 → 确认才 PUT（三字段透传：is_default true / slot_id null / priority 0）
        fireEvent.click(starOf('绑定乙'));
        await screen.findByText(/默认封装绑定/);
        fireEvent.click(screen.getByRole('button', { name: /确认 \(CONFIRM\)/ }));
        await waitFor(() => expect(api.updateBinding).toHaveBeenCalledWith('srv-2', expect.objectContaining({
            is_default: true, slot_id: null, priority: 0
        })));
        // 本地同指令清旧星（服务端同事务清，被清行不再回写 → 仅 1 次 PUT）
        expect(starOf('绑定甲').textContent).toBe('☆');
        expect(starOf('绑定乙').textContent).toBe('★');
        expect(api.updateBinding).toHaveBeenCalledTimes(1);

        // 取消星（低风险逆操作）→ 直执行，不弹确认
        fireEvent.click(starOf('绑定乙'));
        await waitFor(() => expect(api.updateBinding).toHaveBeenLastCalledWith(
            'srv-2', expect.objectContaining({ is_default: false })
        ));
        expect(screen.queryByText(/默认封装绑定/)).toBeNull();
    });
});
