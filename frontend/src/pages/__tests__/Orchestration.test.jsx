import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
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
        // CP3 3b (D13): 编排页配方编辑器 + 试发改走配方
        getRecipes: vi.fn(),
        createRecipe: vi.fn(),
        updateRecipe: vi.fn(),
        deleteRecipe: vi.fn(),
        exportBinaryFromBlocks: vi.fn(),
        compileWrapped: vi.fn(),
        dispatchPayload: vi.fn(),
        // 批次二 (D14③): 试发改带 wrap 下发（后端先转义内核再套壳）
        dispatchWrappedGroup: vi.fn()
    }
}));

// R4 拖拽（PLAN §8.41）：jsdom 没有真实指针传感器，碰撞检测依赖的
// getBoundingClientRect 也全是 0 —— 这里只把 DndContext 的 onDragEnd 透到 DOM 上，
// 测试直接调用它。被测的是我们自己的「换位 / 标脏 / 落库」口径，不是 dnd-kit 本身。
vi.mock('@dnd-kit/core', () => ({
    DndContext: ({ children, onDragEnd }) => (
        <div
            data-testid="dnd-context"
            ref={(node) => { if (node) node.__dndOnDragEnd = onDragEnd; }}
        >
            {children}
        </div>
    ),
    PointerSensor: class PointerSensor {},
    useSensor: () => ({}),
    useSensors: (...sensors) => sensors,
    useDraggable: () => ({
        setNodeRef: () => {}, listeners: {}, attributes: {}, isDragging: false
    }),
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false })
}));

const mountApis = () => {
    api.getBindings.mockResolvedValue([]);
    api.createBinding.mockImplementation((payload) => Promise.resolve({ ...payload, slot_order: 0 }));
    api.updateBinding.mockImplementation((id, payload) => Promise.resolve({ ...payload, id }));
    api.deleteBinding.mockResolvedValue({ status: 'deleted' });
    // CP3 3b: 配方默认空表（既有用例不进配方态 → 属性面板仍 3 个 select）
    api.getRecipes.mockResolvedValue([]);
    api.createRecipe.mockImplementation((payload) => Promise.resolve({
        version: 1, description: null, instruction_id: null, stages: [], ...payload
    }));
    api.updateRecipe.mockImplementation((id, payload) => Promise.resolve({
        id, version: 2, description: null, instruction_id: null, stages: [], ...payload
    }));
    api.deleteRecipe.mockResolvedValue({ status: 'deleted', cleared_instructions: 0 });
    api.exportBinaryFromBlocks.mockResolvedValue(new Blob(['']));
    api.compileWrapped.mockResolvedValue({ hex_string: 'AA 05 01', total_length: 3, warnings: [] });
    api.dispatchPayload.mockResolvedValue({ status: 'ok', hex_string: 'AA 05' });
    api.dispatchWrappedGroup.mockResolvedValue({ status: 'SENT', hex_string: 'AA 05 01', warnings: [] });
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

    it('反馈 #4 手动保存：label/协议选择只进本地草稿（零防抖零即时 PUT），SAVE 按钮落库后消失', async () => {
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

        // 协议选择（原即时 PUT）+ label（原 400ms 防抖）→ 都只进草稿（label/select 为兄弟节点结构，容器查询定位控件）
        fireEvent.change(container.querySelectorAll('select')[0], { target: { value: 'proto-2' } });
        fireEvent.change(screen.getByDisplayValue('默认绑定 (DEFAULT)'), { target: { value: '改名了' } });

        expect(api.updateBinding).not.toHaveBeenCalled();
        // 反馈 #6③：脏态 SAVE 可用（底部常驻按钮 + disabled 联动）
        expect(screen.getByRole('button', { name: '保存更改 (SAVE)' }).disabled).toBe(false);

        // 超过原 400ms 防抖窗口仍零 PUT
        await new Promise(r => setTimeout(r, 500));
        expect(api.updateBinding).not.toHaveBeenCalled();

        // 点保存 → 一次 PUT 携带合并快照（label + 最新选择，不被旧值回冲）
        fireEvent.click(screen.getByRole('button', { name: '保存更改 (SAVE)' }));
        await waitFor(() => expect(api.updateBinding).toHaveBeenCalledTimes(1));
        expect(api.updateBinding).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            label: '改名了',
            protocol_id: 'proto-2'
        }));
        // 保存成功 → 草稿毕业，SAVE 常驻但回到禁用态（反馈 #6③）
        await waitFor(() => expect(screen.getByRole('button', { name: '保存更改 (SAVE)' }).disabled).toBe(true));
    });

    it('反馈 #4 离开拦截：有未保存属性编辑时刷新被拦，干净态不拦', async () => {
        render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '协议A', children: [] }]}
                instructions={[{ id: 'inst-1', name: '指令A', fields: [] }]}
            />
        );

        await awaitDefaultBinding();

        const clean = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(clean);
        expect(clean.defaultPrevented).toBe(false);

        fireEvent.change(screen.getByDisplayValue('默认绑定 (DEFAULT)'), { target: { value: '改' } });

        const dirty = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(dirty);
        expect(dirty.defaultPrevented).toBe(true);
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

        // 反馈 #4：降级模式的属性编辑不标脏（提示条已声明本地不持久化）
        fireEvent.change(screen.getByDisplayValue('默认绑定 (DEFAULT)'), { target: { value: '再改名' } });
        expect(screen.getByDisplayValue('再改名')).toBeDefined();
        expect(api.updateBinding).not.toHaveBeenCalled();
        // 反馈 #6③：降级模式 SAVE 常驻但禁用（loadFailed 不落库）
        expect(screen.getByRole('button', { name: '保存更改 (SAVE)' }).disabled).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: '+' }));
        expect(screen.getByText('新绑定 (NEW)')).toBeDefined();
        expect(api.createBinding).not.toHaveBeenCalled();
        expect(api.updateBinding).not.toHaveBeenCalled();
        // 反馈 #6③：降级加行同样不出可点 SAVE（常驻但禁用）
        expect(screen.getByRole('button', { name: '保存更改 (SAVE)' })).toBeDefined();
        expect(screen.getByRole('button', { name: '保存更改 (SAVE)' }).disabled).toBe(true);
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
        // 反馈 #6③：干净态 SAVE 常驻但禁用
        expect(screen.getByRole('button', { name: '保存更改 (SAVE)' }).disabled).toBe(true);

        api.updateBinding.mockClear();
        fireEvent.change(holeSelect, { target: { value: '1' } });
        // 反馈 #4：换洞只进草稿（零即时 PUT）；#6③ 脏态 SAVE 由禁用转可用
        expect(api.updateBinding).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: '保存更改 (SAVE)' }).disabled).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: '保存更改 (SAVE)' }));
        await waitFor(() => {
            expect(api.updateBinding).toHaveBeenCalledWith('srv-1', expect.objectContaining({ slot_order: 1 }));
            expect(api.updateBinding).toHaveBeenCalledWith('srv-2', expect.objectContaining({ slot_order: 0 }));
        });
        await waitFor(() => expect(screen.getByRole('button', { name: '保存更改 (SAVE)' }).disabled).toBe(true));

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

    // C1 封装试发闭环（批次一 D4 改线 → 批次二 D14③ 再改线）：逐指令前端编码内核
    // → **带 wrap 直接 POST /dispatch**（后端逐条转义内核 → 再套壳），不再「先
    // /compile/wrapped 套壳 → 再裸发整帧」；record.warnings → 琥珀徽标独立渲染。
    it('C1 封装试发：编码内核 → dispatchWrappedGroup 带 wrap 下发，SENT 回显 / 失败透出', async () => {
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
        // 逐指令编码内核（byte_length 1 无 op → '00'）→ 一组载荷带 wrap 下发
        await waitFor(() => expect(api.dispatchWrappedGroup).toHaveBeenCalledTimes(1));
        expect(api.dispatchWrappedGroup).toHaveBeenCalledWith({
            protocolId: 'proto-1',
            payloads: ['00'],
            slotIds: [null],
            startOrder: 0,
            instructionName: '示例指令'
        });
        // 层位改线：不再走「先套壳再裸发」两跳
        expect(api.compileWrapped).not.toHaveBeenCalled();
        expect(await screen.findByText(/^SENT:/)).toBeDefined();

        api.dispatchWrappedGroup.mockRejectedValueOnce(new Error('409: dispatch in flight'));
        fireEvent.click(screen.getByRole('button', { name: /封装试发/ }));
        expect(await screen.findByText(/SEND FAILED: 409/)).toBeDefined();
    });

    // 批次二 (D3): 封装期溢出/欠载告警不得静默 —— record.warnings 走独立琥珀
    // 徽标（不再拼进 SENT 文本），且不阻断发送（append/zero_fill 路径）。
    it('C1 封装试发 warnings：独立琥珀徽标渲染，SENT 文本不拼接', async () => {
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

        api.dispatchWrappedGroup.mockResolvedValueOnce({
            status: 'SENT',
            hex_string: 'AA 01',
            warnings: ['空洞：1 个洞未被载荷填充']
        });
        fireEvent.click(screen.getByRole('button', { name: /封装试发/ }));

        const chips = await screen.findByTestId('trial-send-warnings');
        expect(chips.textContent).toContain('空洞：1 个洞未被载荷填充');
        const sent = screen.getByText(/^SENT:/);
        expect(sent.textContent).not.toContain('空洞');
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

    // ─── 人工验证第 3 轮 #4/#6③: SAVE 移到底部动作区（常驻 + 计数行） ─────
    it('R3 #4/#6③：SAVE 位于属性面板底部（绑定名称之后），常驻计数行「N 条未保存」', async () => {
        render(
            <Orchestration
                protocols={[
                    { id: 'proto-1', label: '协议A', children: [] },
                    { id: 'proto-2', label: '协议B', children: [] }
                ]}
                instructions={[{ id: 'inst-1', name: '指令A', fields: [] }]}
            />
        );

        await awaitDefaultBinding();

        // 干净态：常驻计数行（0 条 muted）+ SAVE 常驻但禁用
        expect(screen.getByText('0 条未保存')).toBeDefined();
        expect(screen.getByRole('button', { name: '保存更改 (SAVE)' }).disabled).toBe(true);

        // 改名标脏 → 计数 1、SAVE 可用；SAVE 在绑定名称 input 之后（面板底部）
        fireEvent.change(screen.getByDisplayValue('默认绑定 (DEFAULT)'), { target: { value: '改名了' } });
        expect(screen.getByText('1 条未保存')).toBeDefined();
        const saveBtn = screen.getByRole('button', { name: '保存更改 (SAVE)' });
        expect(saveBtn.disabled).toBe(false);
        const nameInput = screen.getByDisplayValue('改名了');
        // DOM 顺序：SAVE后于字段 → compareDocumentPosition 报 FOLLOWING
        expect(nameInput.compareDocumentPosition(saveBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    // ─── 人工验证第 3 轮 #6②: 属性面板四分区 + 结构 select 从头部移入 ─────
    it('R3 #6②：四分区标注（IDENTITY/STRUCTURE/HOLE/ACTIONS），三个 select 全在属性面板且协议外壳在前', async () => {
        const { container } = render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '协议A', children: [] }]}
                instructions={[{ id: 'inst-1', name: '指令A', fields: [] }]}
            />
        );

        await awaitDefaultBinding();

        // 四分区工业标签
        expect(screen.getByText('绑定标识 (IDENTITY)')).toBeDefined();
        expect(screen.getByText('结构选择 (STRUCTURE)')).toBeDefined();
        expect(screen.getByText('洞位 (HOLE)')).toBeDefined();
        expect(screen.getByText('操作 (ACTIONS)')).toBeDefined();

        // 中心头部不再承载结构 select（总长度/EXPORT 仍留头部）；面板内 DOM
        // 顺序 = 协议外壳 → 指令内核 → 洞位（原 select[0]/getByLabelText 断言不破）
        expect(container.querySelectorAll('section select')).toHaveLength(0);
        const selects = container.querySelectorAll('aside select');
        expect(selects).toHaveLength(3);
        expect(selects[0].value).toBe('proto-1');
        expect(selects[2].id).toBe('hole-rank');
        expect(totalSize()).toContain('Bytes'); // 头部总长度保留
    });

    // ─── 人工验证第 3 轮 #6①: 侧栏脏行琥珀点 ────────────────────────────
    it('R3 #6①：侧栏脏行显示琥珀 ●（title=有未保存更改），干净行不显示', async () => {
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
        expect(container.querySelector('[title="有未保存更改"]')).toBeNull();

        // 协议选择只进草稿 → 行标脏 → 侧栏行出现琥珀点
        fireEvent.change(container.querySelectorAll('select')[0], { target: { value: 'proto-2' } });
        const dot = container.querySelector('[title="有未保存更改"]');
        expect(dot).not.toBeNull();
        expect(dot.textContent).toBe('●');
    });

    // ─── 人工验证第 3 轮 #5: 分栏宽度（中心区可收缩 + 属性栏不收缩） ─────
    it('R3 #5：中心 section 带 min-w-0/overflow-hidden（可收缩），属性 aside shrink-0 + overflow-y-auto', async () => {
        const { container } = render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '协议A', children: [] }]}
                instructions={[{ id: 'inst-1', name: '指令A', fields: [] }]}
            />
        );

        await awaitDefaultBinding();

        const section = container.querySelector('section');
        expect(section.className).toContain('overflow-hidden');
        expect(section.className).toContain('min-w-0');

        const asides = container.querySelectorAll('aside');
        const panelAside = asides[asides.length - 1];
        expect(panelAside.className).toContain('shrink-0');
        expect(panelAside.className).toContain('overflow-y-auto');
    });

    // ─── CP3 3b (D13): 编排页配方编辑器 + 试发改走配方 ─────────────────────
    const PROTO_SHELL = {
        id: 'proto-1',
        label: '壳协议A',
        children: [
            { id: 'h', label: '帧头', type: 'fixed', byte_length: 1, hex_value: 'AA' },
            { id: 's0', label: '洞1', type: 'slot', byte_length: 0, hex_value: '00' },
            { id: 's1', label: '洞2', type: 'slot', byte_length: 0, hex_value: '00' }
        ]
    };
    const RECIPE_ROW = {
        id: 'recipe-1', name: '外壳配方', description: null, version: 1,
        instruction_id: null, stages: [{ protocol_id: 'proto-1' }]
    };
    const renderRecipePage = () => render(
        <Orchestration
            protocols={[PROTO_SHELL, { id: 'proto-2', label: '壳协议B', children: [] }]}
            instructions={[
                {
                    id: 'inst-1', name: '指令A',
                    fields: [{ id: 'f1', parent_id: null, sequence: 0, name: '命令字', byte_length: 1 }]
                },
                { id: 'inst-2', name: '指令B', fields: [] }
            ]}
        />
    );
    const selectRecipe = async (id = 'recipe-1') => {
        await waitFor(() => expect(screen.getByTestId('recipe-select')).toBeDefined());
        fireEvent.change(screen.getByTestId('recipe-select'), { target: { value: id } });
        await waitFor(() => expect(screen.getByTestId('recipe-save')).toBeDefined());
    };
    const slotChips = () => within(screen.getByTestId('recipe-slots-0')).getAllByRole('button');

    it('CP3 3b 配方编辑器：新建立即落库 → 改名/加层只进草稿 → SAVE 一次 PUT（带 version + 归一 stages），脏点与离开拦截联动', async () => {
        renderRecipePage();
        await awaitDefaultBinding();
        await waitFor(() => expect(api.getRecipes).toHaveBeenCalledTimes(1));

        // 未选配方：只给新建入口（不占属性面板 select → 既有用例 select 计数不破）
        await waitFor(() => expect(screen.getByTestId('recipe-new').disabled).toBe(false));
        expect(screen.queryByTestId('recipe-select')).toBeNull();

        // 新建：立即 POST 落库（沿本页「空表种默认绑定」先例），首层缺省首协议
        fireEvent.click(screen.getByTestId('recipe-new'));
        await waitFor(() => expect(api.createRecipe).toHaveBeenCalledTimes(1));
        expect(api.createRecipe).toHaveBeenCalledWith(expect.objectContaining({
            id: expect.any(String),
            stages: [{ protocol_id: 'proto-1' }]
        }));
        await waitFor(() => expect(screen.getByTestId('recipe-stage-count').textContent).toContain('1 / 4'));
        expect(screen.getByTestId('recipe-dirty').textContent).toBe('配方已同步');
        expect(screen.getByTestId('recipe-save').disabled).toBe(true);
        expect(api.updateRecipe).not.toHaveBeenCalled();

        // 改名 + 加层 → 只进草稿（手动保存语义：零防抖零即时 PUT）
        fireEvent.change(screen.getByTestId('recipe-name'), { target: { value: '三层外壳' } });
        fireEvent.click(screen.getByTestId('recipe-add-stage'));
        expect(screen.getByTestId('recipe-stage-count').textContent).toContain('2 / 4');
        expect(api.updateRecipe).not.toHaveBeenCalled();
        expect(screen.getByTestId('recipe-dirty').textContent).toBe('配方未保存');
        expect(screen.getByTestId('recipe-save').disabled).toBe(false);

        // 离开拦截：配方脏稿同样拦刷新（与绑定脏点同口径）
        const dirtyUnload = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(dirtyUnload);
        expect(dirtyUnload.defaultPrevented).toBe(true);

        // SAVE → 一次 PUT 带合并快照 + 版本乐观并发（id = 新建时前端 uuid）
        fireEvent.click(screen.getByTestId('recipe-save'));
        await waitFor(() => expect(api.updateRecipe).toHaveBeenCalledTimes(1));
        expect(api.updateRecipe).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            name: '三层外壳',
            stages: [{ protocol_id: 'proto-1' }, { protocol_id: 'proto-1' }],
            version: 1
        }));
        // 保存成功 → 草稿毕业、脏点清零、离开不再拦
        await waitFor(() => expect(screen.getByTestId('recipe-dirty').textContent).toBe('配方已同步'));
        const cleanUnload = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(cleanUnload);
        expect(cleanUnload.defaultPrevented).toBe(false);
    });

    it('CP3 3b stage 操作：加层封顶 4、上/下移换序、换协议清槽、选槽位次 badge、删层保底 1', async () => {
        api.getRecipes.mockResolvedValue([{ ...RECIPE_ROW }]);
        renderRecipePage();
        await awaitDefaultBinding();
        await selectRecipe();

        expect(screen.getByTestId('recipe-stage-count').textContent).toContain('1 / 4');

        // 选槽 = 成员关系 + 选择顺序（#n = 第 n 条载荷，「位置对应 payloads」）
        expect(slotChips()).toHaveLength(2);
        fireEvent.click(slotChips()[0]);
        expect(slotChips()[0].getAttribute('aria-pressed')).toBe('true');
        expect(slotChips()[0].textContent).toBe('#1 洞1');
        fireEvent.click(slotChips()[1]);
        expect(slotChips()[1].textContent).toBe('#2 洞2');
        // 取消第 1 位 → 后一位顶上（位次重排，不留空洞）
        fireEvent.click(slotChips()[0]);
        expect(slotChips()[0].getAttribute('aria-pressed')).toBe('false');
        expect(slotChips()[1].textContent).toBe('#1 洞2');

        // 加层到 4 → 封顶禁用（服务端同口径 400）
        fireEvent.click(screen.getByTestId('recipe-add-stage'));
        fireEvent.click(screen.getByTestId('recipe-add-stage'));
        fireEvent.click(screen.getByTestId('recipe-add-stage'));
        expect(screen.getByTestId('recipe-stage-count').textContent).toContain('4 / 4');
        expect(screen.getByTestId('recipe-add-stage').disabled).toBe(true);

        // 第 2 层换协议（槽位作废 → 置空回稠密位次）→ 上移到首位
        fireEvent.change(screen.getByTestId('recipe-protocol-1'), { target: { value: 'proto-2' } });
        expect(screen.getByTestId('recipe-protocol-0').value).toBe('proto-1');
        fireEvent.click(screen.getByRole('button', { name: '第 2 层上移' }));
        expect(screen.getByTestId('recipe-protocol-0').value).toBe('proto-2');
        expect(screen.getByTestId('recipe-protocol-1').value).toBe('proto-1');
        // 下移复原（可逆）
        fireEvent.click(screen.getByRole('button', { name: '第 1 层下移' }));
        expect(screen.getByTestId('recipe-protocol-0').value).toBe('proto-1');

        // 删层：可减到 1 层，之后禁删（服务端「至少 1 层」同口径）
        for (let i = 0; i < 3; i += 1) {
            fireEvent.click(screen.getByRole('button', { name: '删除第 1 层' }));
        }
        expect(screen.getByTestId('recipe-stage-count').textContent).toContain('1 / 4');
        expect(screen.getByRole('button', { name: '删除第 1 层' }).disabled).toBe(true);
    });

    it('CP3 3b 试发改走配方：选中配方 → dispatchWrappedGroup 带 recipeId（不带 protocolId/slotIds），配方脏稿禁发', async () => {
        api.getRecipes.mockResolvedValue([{ ...RECIPE_ROW }]);
        renderRecipePage();
        await awaitDefaultBinding();
        await selectRecipe();

        // 头部 wrap 来源指示切到配方
        expect(screen.getByTestId('trial-wrap-source').textContent).toContain('配方 外壳配方');
        expect(screen.getByTestId('trial-wrap-source').textContent).not.toContain('组协议');

        fireEvent.click(screen.getByRole('button', { name: /封装试发/ }));
        await waitFor(() => expect(api.dispatchWrappedGroup).toHaveBeenCalledTimes(1));
        // 配方路径：槽位与层序归配方阶段所有 → protocolId/slotIds/startOrder 一个都不下发
        expect(api.dispatchWrappedGroup).toHaveBeenCalledWith({
            recipeId: 'recipe-1',
            payloads: ['00'],
            instructionName: '指令A'
        });
        // 层位口径不变：不走「先套壳再裸发」两跳
        expect(api.compileWrapped).not.toHaveBeenCalled();
        expect(await screen.findByText(/^SENT:/)).toBeDefined();

        // 配方脏稿 → 试发禁用（后端只认已落库配方，带脏稿试发 = 预想与出线不一致）
        fireEvent.change(screen.getByTestId('recipe-name'), { target: { value: '改了名' } });
        expect(screen.getByRole('button', { name: /封装试发/ }).disabled).toBe(true);
        expect(screen.getByTestId('trial-wrap-source').textContent).toContain('配方 改了名');
    });

    it('CP3 3b 关联指令换绑：先清旧指针再设新指针（_link_instruction 不回清旧指针）', async () => {
        api.getRecipes.mockResolvedValue([{ ...RECIPE_ROW, instruction_id: 'inst-1' }]);
        renderRecipePage();
        await awaitDefaultBinding();
        await selectRecipe();

        expect(screen.getByTestId('recipe-link').value).toBe('inst-1');
        fireEvent.change(screen.getByTestId('recipe-link'), { target: { value: 'inst-2' } });
        expect(screen.getByTestId('recipe-dirty').textContent).toBe('配方未保存');

        fireEvent.click(screen.getByTestId('recipe-save'));
        await waitFor(() => expect(api.updateRecipe).toHaveBeenCalledTimes(2));

        // 第 1 步：清掉 inst-1 的指针（否则它继续指向本配方，「0 或 1 条」不变量破）
        expect(api.updateRecipe.mock.calls[0][0]).toBe('recipe-1');
        expect(api.updateRecipe.mock.calls[0][1]).toEqual({ instruction_id: '' });
        // 第 2 步：带清空后的 version 再设新指针 + 同批保存名称与层级
        expect(api.updateRecipe.mock.calls[1][1]).toMatchObject({
            instruction_id: 'inst-2',
            version: 2
        });
        // 回显：草稿毕业为服务端行（link 反查 = inst-2）
        await waitFor(() => expect(screen.getByTestId('recipe-link').value).toBe('inst-2'));
    });

    // ─── CP3 3d (D7-A): 绑定失效徽标 ─────────────────────────────────────
    // 口径：仅 stale === true 出徽标（侧栏绑定行内）；false / null / 缺键均不出。
    it('D7-A stale=true → 侧栏绑定行渲染「绑定已失效 STALE」徽标', async () => {
        api.getBindings.mockResolvedValue([
            { id: 'srv-1', label: '失效绑定', protocol_id: 'proto-1', instruction_id: 'inst-1', slot_order: 0, stale: true }
        ]);
        render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '协议A', children: [] }]}
                instructions={[{ id: 'inst-1', name: '指令A', fields: [] }]}
            />
        );

        const badge = await screen.findByTestId('binding-stale');
        expect(badge.textContent).toContain('绑定已失效 STALE');
        expect(screen.getByText('失效绑定')).toBeDefined();
        // 同批行只出 1 枚（不重复渲染）
        expect(screen.getAllByTestId('binding-stale')).toHaveLength(1);
    });

    it('D7-A stale=false / null → 不渲染徽标', async () => {
        api.getBindings.mockResolvedValue([
            { id: 'srv-1', label: '仍匹配', protocol_id: 'proto-1', instruction_id: 'inst-1', slot_order: 0, stale: false },
            { id: 'srv-2', label: '无出处', protocol_id: 'proto-1', instruction_id: 'inst-1', slot_order: 1, stale: null }
        ]);
        render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '协议A', children: [] }]}
                instructions={[{ id: 'inst-1', name: '指令A', fields: [] }]}
            />
        );

        expect(await screen.findByText('仍匹配')).toBeDefined();
        expect(screen.getByText('无出处')).toBeDefined();
        expect(screen.queryByTestId('binding-stale')).toBeNull();
    });

    // ── R4 · 绑定拖拽排序（PLAN §8.41，拍板：**拖完只改展示序，点保存按钮才改
    // 持久序**）────────────────────────────────────────────────────────────
    const sidebarRowsRaw = (container) =>
        [...container.querySelectorAll('aside:first-of-type .truncate')]
            .map((el) => el.textContent);

    // 脏行琥珀点 ● 在 label 之前 —— 断「展示序」时先剥掉，另用 raw 断脏标记
    const sidebarRows = (container) =>
        sidebarRowsRaw(container).map((text) => text.replace(/^●/, ''));

    const dragRow = (activeId, overId) => {
        const node = screen.getByTestId('dnd-context');
        act(() => {
            node.__dndOnDragEnd({ active: { id: activeId }, over: { id: overId } });
        });
    };

    it('R4 拖拽：松手只改展示序（零即时 PUT），点保存更改 (SAVE) 才改持久序', async () => {
        api.getBindings.mockResolvedValue([
            { id: 'srv-1', label: '绑定甲', protocol_id: 'proto-1', instruction_id: 'inst-1', slot_order: 0 },
            { id: 'srv-2', label: '绑定乙', protocol_id: 'proto-1', instruction_id: 'inst-1', slot_order: 1 }
        ]);

        const { container } = render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '协议一', children: [] }]}
                instructions={[{ id: 'inst-1', name: '指令一', fields: [] }]}
            />
        );

        await screen.findByText('绑定甲');
        expect(sidebarRows(container)).toEqual(['绑定甲', '绑定乙']);
        expect(screen.getByRole('button', { name: '保存更改 (SAVE)' }).disabled).toBe(true);

        api.updateBinding.mockClear();
        dragRow('srv-2', 'srv-1');

        // 展示序立刻翻转（本地草稿），持久序一个字节没写
        expect(sidebarRows(container)).toEqual(['绑定乙', '绑定甲']);
        expect(api.updateBinding).not.toHaveBeenCalled();
        // 脏行 = 真变化的两行 → SAVE 由禁用转可用（与洞位下拉同一条路径）
        expect(screen.getByRole('button', { name: '保存更改 (SAVE)' }).disabled).toBe(false);

        fireEvent.click(screen.getByRole('button', { name: '保存更改 (SAVE)' }));
        await waitFor(() => {
            expect(api.updateBinding).toHaveBeenCalledWith('srv-2', expect.objectContaining({ slot_order: 0 }));
            expect(api.updateBinding).toHaveBeenCalledWith('srv-1', expect.objectContaining({ slot_order: 1 }));
        });
        await waitFor(() => expect(screen.getByRole('button', { name: '保存更改 (SAVE)' }).disabled).toBe(true));
    });

    it('R4 拖拽：跨协议组的落点直接忽略（不换序、不标脏、不 PUT）', async () => {
        api.getBindings.mockResolvedValue([
            { id: 'srv-1', label: '甲1', protocol_id: 'proto-a', instruction_id: 'inst-1', slot_order: 0 },
            { id: 'srv-2', label: '乙1', protocol_id: 'proto-b', instruction_id: 'inst-1', slot_order: 0 }
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
        expect(sidebarRows(container)).toEqual(['甲1', '乙1']);

        api.updateBinding.mockClear();
        dragRow('srv-2', 'srv-1');

        expect(sidebarRows(container)).toEqual(['甲1', '乙1']);
        expect(api.updateBinding).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: '保存更改 (SAVE)' }).disabled).toBe(true);
    });

    it('R4 拖拽：只有位次真变化的行进 PUT 队列（末行未动 → 不标脏）', async () => {
        api.getBindings.mockResolvedValue([
            { id: 'srv-1', label: '甲1', protocol_id: 'proto-1', instruction_id: 'inst-1', slot_order: 0 },
            { id: 'srv-2', label: '甲2', protocol_id: 'proto-1', instruction_id: 'inst-1', slot_order: 1 },
            { id: 'srv-3', label: '甲3', protocol_id: 'proto-1', instruction_id: 'inst-1', slot_order: 2 }
        ]);

        const { container } = render(
            <Orchestration
                protocols={[{ id: 'proto-1', label: '协议一', children: [] }]}
                instructions={[{ id: 'inst-1', name: '指令一', fields: [] }]}
            />
        );

        await screen.findByText('甲1');
        api.updateBinding.mockClear();
        // 甲2 → 首位：甲2=0 / 甲1=1 / 甲3 仍是 2（末行不动 → 不进队列）
        dragRow('srv-2', 'srv-1');
        // 展示序翻转，且**只有**前两行带脏标记（甲3 位次没动 → 不标脏）
        expect(sidebarRowsRaw(container)).toEqual(['●甲2', '●甲1', '甲3']);
        expect(sidebarRows(container)).toEqual(['甲2', '甲1', '甲3']);
        expect(api.updateBinding).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: '保存更改 (SAVE)' }));
        await waitFor(() => {
            expect(api.updateBinding).toHaveBeenCalledWith('srv-2', expect.objectContaining({ slot_order: 0 }));
            expect(api.updateBinding).toHaveBeenCalledWith('srv-1', expect.objectContaining({ slot_order: 1 }));
        });
        expect(api.updateBinding).not.toHaveBeenCalledWith('srv-3', expect.anything());
        await waitFor(() => expect(screen.getByRole('button', { name: '保存更改 (SAVE)' }).disabled).toBe(true));
    });
});
