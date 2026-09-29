import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import Protocol from '../Protocol';
import { api } from '../../api';
import { triggerBlobDownload } from '../../utils/download';
import { ChecksumAlgo, calculateChecksum, formatToHex } from '../../utils/formula';

vi.mock('../../api', () => ({
    api: {
        createProtocol: vi.fn(),
        // 批次五: 冲突双动作按 id 拉最新行（强制覆盖 / 加载最新）
        getProtocol: vi.fn(),
        updateProtocol: vi.fn(),
        deleteProtocol: vi.fn(),
        getBindings: vi.fn() // 批次一 P0-1: 删前引用检查
    }
}));

vi.mock('../../utils/download', () => ({
    triggerBlobDownload: vi.fn() // 批次四 P3-2: 导出断言用
}));

// jsdom 兼容：Blob/FileReader 兜底读文本（.text() 视 jsdom 版本而定）
const readBlob = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(blob);
});
// 旧 jsdom 的 File 无 .text() → 实例级兜底（页面 handler 走 file.text()）
const makeJsonFile = (content) => {
    const file = new File([content], 'p.json', { type: 'application/json' });
    if (typeof file.text !== 'function') file.text = async () => content;
    return file;
};

// 反馈 #3 手动保存：点面板「保存更改 (SAVE)」+ 微任务排空（fake/real 计时器两用）
const saveViaButton = async () => {
    fireEvent.click(screen.getByRole('button', { name: '保存更改 (SAVE)' }));
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
};

vi.mock('../../components/editor/Canvas', () => ({
    // 拾取分支对标真实 Canvas handleBlockClick（:293 isActive → onPickBlock，
    // 否则 onSelect）；computedValue 露出供 A4 Σ 回显断言（无值时不追加文本，
    // 既有按钮 accessible name 不变）。
    default: ({ lanes, onSelect, onMoveItem, pickingMode, onPickBlock }) => (
        <div data-testid="mock-canvas">
            <div>{lanes.map(lane => `${lane.parentName}:${lane.items.length}`).join('|')}</div>
            {lanes.flatMap(lane => lane.items).map((item, index) => (
                <React.Fragment key={item.id}>
                    <button onClick={() => (pickingMode?.isActive ? onPickBlock?.(item.id) : onSelect(item.id))}>
                        {item.label}
                        {item.parameter_config?.computedValue ? ` ${item.parameter_config.computedValue}` : ''}
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

    it('反馈 #3 手动保存：编辑只进本地草稿 —— 无自动 PUT，SAVE 按钮落库后消失、共享态写穿', async () => {
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

        // 草稿态：共享态零写入 + SAVE 按钮出现
        expect(setProtocols).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: '保存更改 (SAVE)' })).toBeTruthy();
        expect(api.updateProtocol).not.toHaveBeenCalled();

        // 超过原 350ms 防抖窗口 → 依然零自动 PUT
        await act(async () => {
            vi.advanceTimersByTime(500);
            await Promise.resolve();
        });
        expect(api.updateProtocol).not.toHaveBeenCalled();

        // 点击保存 → PUT 一次（载荷同旧口径）
        await saveViaButton();

        expect(api.updateProtocol).toHaveBeenCalledWith('proto-1', {
            label: '改名后的协议',
            type: 'container',
            description: null,
            children: []
        });
        // 保存成功：草稿毕业 → 按钮消失 + 共享态写穿（一次）
        expect(screen.queryByRole('button', { name: '保存更改 (SAVE)' })).toBeNull();
        expect(setProtocols).toHaveBeenCalledTimes(1);
    });

    it('反馈 #3 切协议确认：脏态点侧栏他协议弹「放弃未保存的更改？」，取消留原协议、确认弃草稿切换（全程零 PUT）', () => {
        render(
            <ProtocolHarness
                initialProtocols={[
                    { id: 'proto-1', label: '甲协议', type: 'container', children: [] },
                    { id: 'proto-2', label: '乙协议', type: 'container', children: [] }
                ]}
            />
        );

        fireEvent.change(screen.getByDisplayValue('甲协议'), { target: { value: '甲改' } });

        // 点侧栏「乙协议」→ 弹确认（而非直接切）
        fireEvent.click(screen.getByText('乙协议'));
        expect(screen.getByText('放弃未保存的更改？')).toBeTruthy();

        // 取消 → 留在甲 + 草稿保留（顶栏 = 草稿名、SAVE 按钮在）
        fireEvent.click(screen.getByRole('button', { name: /取消/ }));
        expect(screen.getByText(/PROTOCOL EDITOR \/\/ 甲改/)).toBeTruthy();
        expect(screen.getByRole('button', { name: '保存更改 (SAVE)' })).toBeTruthy();

        // 再点乙 → 确认 → 切到乙、草稿弃置
        fireEvent.click(screen.getByText('乙协议'));
        fireEvent.click(screen.getByRole('button', { name: /确认/ }));
        expect(screen.getByText(/PROTOCOL EDITOR \/\/ 乙协议/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: '保存更改 (SAVE)' })).toBeNull();

        // 切回甲 → 看到的是已保存名（草稿确实丢了）；全程零 PUT
        fireEvent.click(screen.getByText('甲协议'));
        expect(screen.getByDisplayValue('甲协议')).toBeTruthy();
        expect(screen.queryByDisplayValue('甲改')).toBeNull();
        expect(api.updateProtocol).not.toHaveBeenCalled();
    });

    it('反馈 #3 离开拦截：脏态刷新 preventDefault，干净态不拦', () => {
        render(
            <Protocol
                protocols={[{ id: 'proto-1', label: '示例协议', type: 'container', children: [] }]}
                setProtocols={vi.fn()}
            />
        );

        const clean = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(clean);
        expect(clean.defaultPrevented).toBe(false);

        fireEvent.change(screen.getByDisplayValue('示例协议'), { target: { value: '改' } });

        const dirty = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(dirty);
        expect(dirty.defaultPrevented).toBe(true);
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

        // 点容器卡 = 选中 + 收起（指令页 select+navigate 双发的页面层实现）。
        // 容器中央值 = 子块内容拼接（fixed 'AA' 注入）→ accessible name 带内容后缀。
        fireEvent.click(screen.getByRole('button', { name: '载荷容器 AA' }));
        expect(screen.getByTestId('mock-canvas').textContent).not.toContain('载荷容器:1');

        // 属性面板 ENTER 保留（内联化 = 确保展开 + 聚焦）
        fireEvent.click(screen.getByRole('button', { name: /进入容器/i }));
        expect(screen.getByTestId('mock-canvas').textContent).toContain('载荷容器:1');

        // 子泳道内叶块编辑 → 反馈 #3：进草稿（零自动 PUT），点保存持久化整棵深树
        fireEvent.click(screen.getByRole('button', { name: '固定头' }));
        fireEvent.change(screen.getByDisplayValue('固定头'), {
            target: { value: '固定尾' }
        });

        expect(api.updateProtocol).not.toHaveBeenCalled();
        await saveViaButton();

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

        expect(api.updateProtocol).not.toHaveBeenCalled(); // 反馈 #3：无自动落库
        await saveViaButton();

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

        // Drag 甲块 to index 1 (after 乙块) → 进草稿，点保存落库（反馈 #3）
        fireEvent.click(screen.getByTestId('move-block-a'));

        expect(api.updateProtocol).not.toHaveBeenCalled();
        await saveViaButton();

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

        // Hex value field (fixed blocks only) — 批次二: fixed 严等 byte_length×2
        // （4 字节 → 8 hex 字符），非法组合会被 validateProtocol 阻断落库
        const hexLabel = screen.getByText('十六进制值 (Hex)');
        fireEvent.change(hexLabel.parentElement.querySelector('input'), {
            target: { value: 'FF FF FF FF' }
        });

        expect(api.updateProtocol).not.toHaveBeenCalled(); // 反馈 #3：无自动落库
        await saveViaButton();

        expect(api.updateProtocol).toHaveBeenCalledWith('proto-1', expect.objectContaining({
            children: [
                expect.objectContaining({ id: 'block-a', byte_length: 4, hex_value: 'FF FF FF FF' })
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

        expect(api.updateProtocol).not.toHaveBeenCalled(); // 反馈 #3：无自动落库
        await saveViaButton();

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

            expect(api.updateProtocol).not.toHaveBeenCalled(); // 反馈 #3：无自动落库
            await saveViaButton();

            expect(api.updateProtocol).toHaveBeenCalled();
            expect(screen.getByText(/协议保存失败/)).toBeDefined();
        } finally {
            errorSpy.mockRestore();
        }
    });

    // A2/A3 refs 拾取链路：面板 SELECT FIELDS → 画布点选 toggle 入 refs →
    // 芯片单删；② 范围修订：slot 可作 refs 目标（定义期 Σ 不注入维持 ??、
    // 发送期填槽改写为注入块 id），自引用仍拒 + 状态栏提示；变更经防抖落库。
    it('A2/A3 refs 拾取：点选入 refs、slot 可引、自引用拒+提示、芯片单删、持久化', async () => {
        api.updateProtocol.mockImplementation(async (id, payload) => ({ id, ...payload }));

        render(
            <ProtocolHarness
                initialProtocols={[{
                    id: 'proto-1',
                    label: '主协议',
                    type: 'container',
                    children: [
                        { id: 'fixed-a', label: '甲块', type: 'fixed', byte_length: 2, hex_value: 'DE AD' },
                        { id: 'slot-a', label: '插槽', type: 'slot', byte_length: 1, hex_value: '00' },
                        {
                            id: 'len-a',
                            label: 'LENGTH',
                            type: 'length',
                            byte_length: 2,
                            hex_value: '00',
                            parameter_config: { type: 'length', refs: [] }
                        }
                    ]
                }]}
            />
        );

        // 选中 length 卡 → 面板 refs 专用分支（计数 + SELECT FIELDS，非通用 input）
        fireEvent.click(screen.getByRole('button', { name: 'LENGTH' }));
        expect(screen.getByText('0 REF(S)')).toBeDefined();

        // 进入拾取 → 画布点甲块 = 入 refs（mock 与真实 Canvas 同路由：isActive→onPickBlock）
        fireEvent.click(screen.getByRole('button', { name: 'SELECT FIELDS' }));
        fireEvent.click(screen.getByRole('button', { name: '甲块' }));
        expect(screen.getByText('1 REF(S)')).toBeDefined();

        // ② slot 可作 refs 目标 —— 计数进位；refs 已含槽 → 定义期 Σ 不注入
        fireEvent.click(screen.getByRole('button', { name: '插槽' }));
        expect(screen.getByText('2 REF(S)')).toBeDefined();
        // 自引用仍拒 + 状态栏提示（SYS 行）。前缀正则防 'move LENGTH' 移位按钮误中。
        fireEvent.click(screen.getByRole('button', { name: /^LENGTH/ }));
        expect(screen.getByText('2 REF(S)')).toBeDefined();
        expect(screen.getByText(/SYS: 不能引用自身/)).toBeDefined();

        // 反馈 #3：点保存持久化 —— refs 落 children[i].parameter_config
        expect(api.updateProtocol).not.toHaveBeenCalled();
        await saveViaButton();
        expect(api.updateProtocol).toHaveBeenCalledWith('proto-1', expect.objectContaining({
            children: expect.arrayContaining([
                expect.objectContaining({
                    id: 'len-a',
                    parameter_config: expect.objectContaining({ type: 'length', refs: ['fixed-a', 'slot-a'] })
                })
            ])
        }));

        // 芯片单删（label 解自 findNode，删按钮在芯片内）→ 逐删至清空
        fireEvent.click(screen.getByTestId('ref-chip-fixed-a').querySelector('button'));
        expect(screen.getByText('1 REF(S)')).toBeDefined();
        fireEvent.click(screen.getByTestId('ref-chip-slot-a').querySelector('button'));
        expect(screen.getByText('0 REF(S)')).toBeDefined();
    });

    // A4 设计期 Σ 回显：仅 length 卡注入 computedValue（宽度=卡 byte_length）；
    // 人工验证反馈 2（严格口径）：checksum refs 全可确定 → 设计期真值注入
    // （name 追加值）；悬空 ref 不注入（维持等量 ??）。
    it('A4 Σ 回显：length 卡 refs 尺寸和注入画布，确定 checksum 注入真值、悬空不注入', () => {
        render(
            <ProtocolHarness
                initialProtocols={[{
                    id: 'proto-1',
                    label: '主协议',
                    type: 'container',
                    children: [
                        { id: 'fixed-a', label: '甲块', type: 'fixed', byte_length: 2, hex_value: 'DE AD' },
                        {
                            id: 'len-a',
                            label: '长度',
                            type: 'length',
                            byte_length: 2,
                            hex_value: '00',
                            parameter_config: { type: 'length', refs: ['fixed-a'] }
                        },
                        {
                            id: 'sum-a',
                            label: '校验',
                            type: 'checksum',
                            byte_length: 1,
                            hex_value: '00',
                            parameter_config: { type: 'checksum', refs: ['fixed-a'] }
                        },
                        {
                            id: 'len-b',
                            label: '长度悬空',
                            type: 'length',
                            byte_length: 1,
                            hex_value: '00',
                            parameter_config: { type: 'length', refs: ['ghost'] }
                        }
                    ]
                }]}
            />
        );

        // Σ=2 → 十进制 `2B` 注入按钮文本（mock 露出 computedValue）
        expect(screen.getByRole('button', { name: '长度 2B' })).toBeDefined();
        // checksum 不注入 → accessible name 仅 label
        // 确定 checksum 注入真值：缺省 CRC_16_MODBUS（与编码器同源）→ name 追加值
        const want = formatToHex(calculateChecksum(ChecksumAlgo.CRC_16_MODBUS, [0xDE, 0xAD]), 1);
        expect(screen.getByRole('button', { name: `校验 ${want}` })).toBeDefined();
        // 悬空 ref → size null → 不注入
        expect(screen.getByRole('button', { name: '长度悬空' })).toBeDefined();
    });

    // ─── 批次一 P0-1: 删协议前检查编排绑定引用 ─────────────────────────────
    const twoProtocols = [
        { id: 'proto-1', label: '被绑协议', type: 'container', children: [] },
        { id: 'proto-2', label: '其他协议', type: 'container', children: [] }
    ];

    it('有绑定引用 → 弹窗警示连带清理，取消不删、确认才删', async () => {
        vi.useRealTimers();
        api.getBindings.mockResolvedValue([
            { id: 'b1', protocol_id: 'proto-1', instruction_id: 'i1', label: '绑定1', slot_order: 0 },
            { id: 'b2', protocol_id: 'proto-1', instruction_id: 'i2', label: '绑定2', slot_order: 1 },
            { id: 'b3', protocol_id: 'proto-2', instruction_id: 'i3', label: '绑定3', slot_order: 2 }
        ]);
        api.deleteProtocol.mockResolvedValue({ status: 'deleted', id: 'proto-1', deleted_bindings: 2 });

        render(<Protocol protocols={twoProtocols} setProtocols={vi.fn()} />);
        const row = screen.getByText('被绑协议').parentElement;

        fireEvent.click(within(row).getByRole('button', { name: '×' }));

        await waitFor(() => expect(screen.getByText(/被 2 条编排绑定引用/)).toBeDefined());
        expect(api.deleteProtocol).not.toHaveBeenCalled();

        // 取消 → 弹窗关、协议仍在、未调 DELETE
        fireEvent.click(screen.getByRole('button', { name: /取消/ }));
        await waitFor(() => expect(screen.queryByText(/编排绑定引用/)).toBeNull());
        expect(api.deleteProtocol).not.toHaveBeenCalled();
        expect(within(row).getByRole('button', { name: '×' })).toBeDefined();

        // 再开 → 确认才执行删除
        fireEvent.click(within(row).getByRole('button', { name: '×' }));
        await waitFor(() => expect(screen.getByText(/被 2 条编排绑定引用/)).toBeDefined());
        fireEvent.click(screen.getByRole('button', { name: /确认/ }));
        await waitFor(() => expect(api.deleteProtocol).toHaveBeenCalledWith('proto-1'));
        // 后端级联计数回显
        await waitFor(() => expect(screen.getByText(/连带清理 2 条绑定/)).toBeDefined());
    });

    it('无绑定引用 → 直接删除（不弹窗）', async () => {
        vi.useRealTimers();
        api.getBindings.mockResolvedValue([]);
        api.deleteProtocol.mockResolvedValue({ status: 'deleted', id: 'proto-2', deleted_bindings: 0 });

        render(<Protocol protocols={twoProtocols} setProtocols={vi.fn()} />);
        const row = screen.getByText('其他协议').parentElement;

        fireEvent.click(within(row).getByRole('button', { name: '×' }));

        await waitFor(() => expect(api.deleteProtocol).toHaveBeenCalledWith('proto-2'));
        expect(screen.queryByText(/编排绑定引用/)).toBeNull();
    });

    it('仅剩一个协议时禁删：不查引用不调 DELETE，状态栏提示', () => {
        render(
            <Protocol
                protocols={[{ id: 'proto-1', label: '唯一协议', type: 'container', children: [] }]}
                setProtocols={vi.fn()}
            />
        );
        const row = screen.getByText('唯一协议').parentElement;

        fireEvent.click(within(row).getByRole('button', { name: '×' }));

        expect(api.getBindings).not.toHaveBeenCalled();
        expect(api.deleteProtocol).not.toHaveBeenCalled();
        expect(screen.getByText(/SYS: 至少保留一个协议/)).toBeDefined();
    });

    // ─── 批次一 P0-3: 保存失败恢复 ─────────────────────────────────────────
    it('保存失败 → 横幅透传 400 detail + 草稿保留，重试成功清横幅', async () => {
        vi.useRealTimers();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        const rejection = new Error('refs target not found');
        rejection.response = { status: 400, data: { detail: 'refs target not found' } };
        api.updateProtocol.mockRejectedValueOnce(rejection);

        try {
            render(
                <Protocol
                    protocols={[{ id: 'proto-1', label: '示例协议', type: 'container', children: [] }]}
                    setProtocols={vi.fn()}
                />
            );

            fireEvent.change(screen.getByDisplayValue('示例协议'), {
                target: { value: '改名后的协议' }
            });

            // 反馈 #3：点保存 → 首 PUT 失败 → 横幅带服务端 detail（草稿保留）
            await saveViaButton();
            await waitFor(() => expect(api.updateProtocol).toHaveBeenCalledTimes(1));
            await waitFor(() => expect(screen.getByText(/服务端拒绝.*refs target not found/)).toBeDefined());
            expect(screen.getByRole('button', { name: '保存更改 (SAVE)' })).toBeTruthy();

            // 重试 = 重发草稿（失败后草稿仍在）→ 再次 PUT（二次成功）
            api.updateProtocol.mockResolvedValue({
                id: 'proto-1', label: '改名后的协议', type: 'container', children: []
            });
            fireEvent.click(screen.getByRole('button', { name: '重试' }));
            await waitFor(() => expect(api.updateProtocol).toHaveBeenCalledTimes(2));
            // 成功 → 横幅清除（脏态已落库）
            await waitFor(() => expect(screen.queryByText(/保存失败 SAVE FAILED/)).toBeNull());
        } finally {
            errorSpy.mockRestore();
        }
    });

    // ─── 批次五: version 乐观并发 ───────────────────────────────────────────
    it('PUT 携带本地 version，成功后以响应新 version 续存', async () => {
        vi.useRealTimers();
        api.updateProtocol
            .mockResolvedValueOnce({ id: 'proto-1', label: '改名一', type: 'container', description: null, children: [], version: 2 })
            .mockResolvedValueOnce({ id: 'proto-1', label: '改名二', type: 'container', description: null, children: [], version: 3 });

        render(
            <ProtocolHarness
                initialProtocols={[{ id: 'proto-1', label: '初始', type: 'container', description: null, children: [], version: 1 }]}
            />
        );

        fireEvent.change(screen.getByDisplayValue('初始'), { target: { value: '改名一' } });
        await saveViaButton();
        expect(api.updateProtocol).toHaveBeenCalledTimes(1);
        expect(api.updateProtocol.mock.calls[0][1]).toMatchObject({ label: '改名一', version: 1 });

        // 成功响应的 version 2 已回写本地（共享行已更新）→ 下一次 PUT 必须带 2（1 已陈旧）
        await waitFor(() => expect(screen.getByDisplayValue('改名一')).toBeDefined());
        fireEvent.change(screen.getByDisplayValue('改名一'), { target: { value: '改名二' } });
        await saveViaButton();
        expect(api.updateProtocol).toHaveBeenCalledTimes(2);
        expect(api.updateProtocol.mock.calls[1][1]).toMatchObject({ label: '改名二', version: 2 });
        expect(screen.queryByText(/版本冲突/)).toBeNull();
    });

    it('保存 409 → 冲突横幅双动作（无「重试」）；强制覆盖 = GET 最新 version 重发成功清横幅', async () => {
        vi.useRealTimers();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        const rejection = new Error('Protocol version conflict: expected 1, current 2');
        rejection.response = { status: 409, data: { detail: 'Protocol version conflict: expected 1, current 2' } };
        api.updateProtocol.mockRejectedValueOnce(rejection);
        api.getProtocol.mockResolvedValue({ id: 'proto-1', label: '远端', type: 'container', description: null, children: [], version: 7 });

        try {
            render(
                <ProtocolHarness
                    initialProtocols={[{ id: 'proto-1', label: '示例协议', type: 'container', description: null, children: [], version: 1 }]}
                />
            );
            fireEvent.change(screen.getByDisplayValue('示例协议'), { target: { value: '本地改名' } });

            await saveViaButton(); // 反馈 #3：手动保存才 PUT
            await waitFor(() => expect(api.updateProtocol).toHaveBeenCalledTimes(1));
            // 横幅透传 409 文案 + 冲突态给双动作；原样「重试」必再 409 = 死路，不给
            await waitFor(() => expect(screen.getByText(/版本冲突.*409/)).toBeDefined());
            expect(screen.getByRole('button', { name: '强制覆盖' })).toBeDefined();
            expect(screen.getByRole('button', { name: '加载最新' })).toBeDefined();
            expect(screen.queryByRole('button', { name: '重试' })).toBeNull();

            // 强制覆盖：GET 最新行(version 7) → 带本地负载 + 7 重发 → 成功清横幅
            api.updateProtocol.mockResolvedValue({ id: 'proto-1', label: '本地改名', type: 'container', description: null, children: [], version: 8 });
            fireEvent.click(screen.getByRole('button', { name: '强制覆盖' }));
            await waitFor(() => expect(api.getProtocol).toHaveBeenCalledWith('proto-1'));
            await waitFor(() => expect(api.updateProtocol).toHaveBeenCalledTimes(2));
            expect(api.updateProtocol.mock.calls[1][1]).toMatchObject({ label: '本地改名', version: 7 });
            await waitFor(() => expect(screen.queryByText(/版本冲突/)).toBeNull());
            expect(screen.queryByRole('button', { name: '强制覆盖' })).toBeNull();
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('冲突「加载最新」= 拉服务端版本替换本地、放弃脏负载不再重发，后续编辑带新 version', async () => {
        vi.useRealTimers();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        const rejection = new Error('Protocol version conflict: expected 1, current 3');
        rejection.response = { status: 409, data: { detail: 'Protocol version conflict: expected 1, current 3' } };
        api.updateProtocol.mockRejectedValueOnce(rejection);
        api.getProtocol.mockResolvedValue({ id: 'proto-1', label: '远端最新', type: 'container', description: null, children: [], version: 3 });

        try {
            render(
                <ProtocolHarness
                    initialProtocols={[{ id: 'proto-1', label: '示例协议', type: 'container', description: null, children: [], version: 1 }]}
                />
            );
            fireEvent.change(screen.getByDisplayValue('示例协议'), { target: { value: '本地改名' } });
            await saveViaButton(); // 反馈 #3：手动保存才 PUT
            await waitFor(() => expect(api.updateProtocol).toHaveBeenCalledTimes(1));
            await waitFor(() => expect(screen.getByRole('button', { name: '加载最新' })).toBeDefined());

            fireEvent.click(screen.getByRole('button', { name: '加载最新' }));
            await waitFor(() => expect(screen.getByDisplayValue('远端最新')).toBeDefined());
            // 放弃本地：不重发、横幅关闭、草稿已清（SAVE 按钮消失）
            expect(api.updateProtocol).toHaveBeenCalledTimes(1);
            expect(screen.queryByRole('button', { name: '保存更改 (SAVE)' })).toBeNull();
            expect(screen.queryByText(/版本冲突/)).toBeNull();

            // 之后再编辑 → 带加载到的 version 3 正常保存（冲突已解除）
            api.updateProtocol.mockResolvedValue({ id: 'proto-1', label: '再次编辑', type: 'container', description: null, children: [], version: 4 });
            fireEvent.change(screen.getByDisplayValue('远端最新'), { target: { value: '再次编辑' } });
            await saveViaButton();
            await waitFor(() => expect(api.updateProtocol).toHaveBeenCalledTimes(2));
            expect(api.updateProtocol.mock.calls[1][1]).toMatchObject({ label: '再次编辑', version: 3 });
        } finally {
            errorSpy.mockRestore();
        }
    });

    // ─── 批次二 P0-4: 保存前结构校验 ─────────────────────────────────────
    it('非法 HEX 阻断保存：不 PUT、SYS 提示、面板清单点击定位，修复后自动放行', async () => {
        api.updateProtocol.mockImplementation(async (id, payload) => ({ id, ...payload }));

        render(
            <ProtocolHarness
                initialProtocols={[{
                    id: 'proto-1',
                    label: '主协议',
                    type: 'container',
                    children: [
                        { id: 'block-a', label: '甲块', type: 'fixed', byte_length: 1, hex_value: 'AA' },
                        { id: 'block-b', label: '乙块', type: 'fixed', byte_length: 1, hex_value: 'BB' }
                    ]
                }]}
            />
        );

        // 改 block-a 的 hex 为非十六进制垃圾 → 点保存被闸拦（反馈 #3 手动保存）
        fireEvent.click(screen.getByRole('button', { name: '甲块' }));
        const hexLabel = screen.getByText('十六进制值 (Hex)');
        fireEvent.change(hexLabel.parentElement.querySelector('input'), { target: { value: 'GG' } });

        await saveViaButton();

        // 阻断：PUT 未发生 + SYS 状态 + 面板常驻错误清单（带 blockId 定位文案）
        expect(api.updateProtocol).not.toHaveBeenCalled();
        expect(screen.getByText(/SYS: 保存被阻止：1 个结构错误/)).toBeDefined();
        expect(screen.getByText(/⛔ 「甲块」HEX 含非十六进制字符/)).toBeDefined();

        // 切选另一块 → 清单仍常驻（不随选中态隐藏）；点清单条目 → 定位回甲块
        fireEvent.click(screen.getByRole('button', { name: '乙块' }));
        expect(screen.getByDisplayValue('乙块')).toBeDefined();
        fireEvent.click(screen.getByText(/⛔ 「甲块」HEX 含非十六进制字符/));
        expect(screen.getByDisplayValue('甲块')).toBeDefined();

        // 修复 → 再点保存放行 + 清单同步消失
        fireEvent.change(screen.getByText('十六进制值 (Hex)').parentElement.querySelector('input'), {
            target: { value: 'FF' }
        });
        await saveViaButton();
        expect(api.updateProtocol).toHaveBeenCalledWith('proto-1', expect.objectContaining({
            children: expect.arrayContaining([
                expect.objectContaining({ id: 'block-a', hex_value: 'FF' })
            ])
        }));
        expect(screen.queryByText(/结构错误/)).toBeNull();
    });

    // ─── 批次二 P1-5: 撤销/重做（反馈 #3 改手动：撤销/重做只动草稿，落库走
    // SAVE；保存 = 新基线清史，镜像指令页 P4-1） ─────────────────────────────
    it('撤销/重做（反馈 #3）：编辑/撤销/重做全程零自动 PUT，SAVE 落库并清史，切协议清史', async () => {
        api.updateProtocol.mockImplementation(async (id, payload) => ({ id, ...payload }));

        render(
            <ProtocolHarness
                initialProtocols={[
                    {
                        id: 'proto-1', label: '主协议', type: 'container',
                        children: [{ id: 'block-a', label: '甲块', type: 'fixed', byte_length: 1, hex_value: 'AA' }]
                    },
                    { id: 'proto-2', label: '副协议', type: 'container', children: [] }
                ]}
            />
        );

        // 初始无历史 → 双钮禁用
        expect(screen.getByRole('button', { name: '撤销' }).disabled).toBe(true);
        expect(screen.getByRole('button', { name: '重做' }).disabled).toBe(true);

        // 编辑 → 进草稿（SAVE 按钮出现），零自动落库
        fireEvent.click(screen.getByRole('button', { name: '甲块' }));
        fireEvent.change(screen.getByDisplayValue('甲块'), { target: { value: '甲改' } });
        expect(screen.getByRole('button', { name: '保存更改 (SAVE)' })).toBeTruthy();
        await act(async () => {
            vi.advanceTimersByTime(500);
            await Promise.resolve();
        });
        expect(api.updateProtocol).toHaveBeenCalledTimes(0);

        // 撤销 → 画布回旧名（仍是草稿），零自动落库
        const undoBtn = screen.getByRole('button', { name: '撤销' });
        expect(undoBtn.disabled).toBe(false);
        fireEvent.click(undoBtn);
        expect(screen.getByRole('button', { name: '甲块' })).toBeTruthy();
        expect(screen.getByRole('button', { name: '重做' }).disabled).toBe(false);
        await act(async () => {
            vi.advanceTimersByTime(500);
            await Promise.resolve();
        });
        expect(api.updateProtocol).toHaveBeenCalledTimes(0);

        // 重做 → 恢复编辑态，仍零落库
        fireEvent.click(screen.getByRole('button', { name: '重做' }));
        expect(screen.getByDisplayValue('甲改')).toBeTruthy();
        await act(async () => {
            vi.advanceTimersByTime(500);
            await Promise.resolve();
        });
        expect(api.updateProtocol).toHaveBeenCalledTimes(0);

        // Ctrl+Z（window 焦点、非输入态）→ 再撤销回旧名
        fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
        expect(screen.getByRole('button', { name: '甲块' })).toBeTruthy();

        // 重做回编辑态 → SAVE 落库 = PUT #1（甲改），成功即清史（新基线）
        fireEvent.click(screen.getByRole('button', { name: '重做' }));
        await saveViaButton();
        expect(api.updateProtocol).toHaveBeenCalledTimes(1);
        expect(api.updateProtocol).toHaveBeenLastCalledWith('proto-1', expect.objectContaining({
            children: [expect.objectContaining({ id: 'block-a', label: '甲改' })]
        }));
        expect(screen.queryByRole('button', { name: '保存更改 (SAVE)' })).toBeNull();
        expect(screen.getByRole('button', { name: '撤销' }).disabled).toBe(true);
        expect(screen.getByRole('button', { name: '重做' }).disabled).toBe(true);

        // 切协议（干净态直接切）= 新基线 → 双钮仍禁用
        fireEvent.click(screen.getByText('副协议'));
        expect(screen.getByRole('button', { name: '撤销' }).disabled).toBe(true);
        expect(screen.getByRole('button', { name: '重做' }).disabled).toBe(true);
    });

    // ─── 批次三 P1-1: 复制协议 ─────────────────────────────────────────
    it('复制协议：侧栏「副本」→ POST 新 id / 新 label / 子树新 id，成功切到副本', async () => {
        vi.useRealTimers();
        try {
            api.createProtocol.mockImplementation(async (payload) => ({ ...payload }));

            render(
                <ProtocolHarness
                    initialProtocols={[{
                        id: 'proto-1',
                        label: '主协议',
                        type: 'container',
                        children: [
                            { id: 'block-a', label: '甲块', type: 'fixed', byte_length: 1, hex_value: 'AA' }
                        ]
                    }]}
                />
            );

            fireEvent.click(screen.getByTitle('复制协议 (DUPLICATE)'));

            await waitFor(() => expect(api.createProtocol).toHaveBeenCalledTimes(1));
            const payload = api.createProtocol.mock.calls[0][0];
            expect(payload.label).toBe('主协议 (副本)');
            expect(payload.id).not.toBe('proto-1');
            expect(payload.children[0].id).not.toBe('block-a'); // 整树新 id，不与源撞主键

            // 成功 → 切到副本（顶栏 + 侧栏出现新 label），且新副本 = 持久化基线
            await waitFor(() => expect(screen.getAllByText(/主协议 \(副本\)/).length).toBeGreaterThan(0));
            expect(api.updateProtocol).not.toHaveBeenCalled(); // 无自动保存被触发（反馈 #3）
        } finally {
            vi.useFakeTimers();
        }
    });

    // ─── 人工验证第 3 轮 #1: 复制块入口移除（块级只留删除；侧栏「副本」保留） ──
    it('复制块按钮不存在：块级属性面板无「复制块 (DUPLICATE)」，删除 (DELETE) 保留', () => {
        render(
            <ProtocolHarness
                initialProtocols={[{
                    id: 'proto-1',
                    label: '主协议',
                    type: 'container',
                    children: [
                        { id: 'block-a', label: '甲块', type: 'fixed', byte_length: 1, hex_value: 'AA' }
                    ]
                }]}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: '甲块' }));
        expect(screen.getByDisplayValue('甲块')).toBeDefined(); // 块级视图已进入

        expect(screen.queryByRole('button', { name: '复制块 (DUPLICATE)' })).toBeNull();
        expect(screen.getByRole('button', { name: '删除 (DELETE)' })).toBeDefined(); // 删除保留
    });

    // ─── 人工验证第 3 轮 #3: SAVE 移到属性面板底部动作区 ─────────────────────
    it('SAVE 位于属性面板底部：协议级/块级两视图均在字段之后（镜像指令页动作区）', () => {
        render(
            <ProtocolHarness
                initialProtocols={[{
                    id: 'proto-1',
                    label: '主协议',
                    type: 'container',
                    description: '备注',
                    children: [
                        { id: 'block-a', label: '甲块', type: 'fixed', byte_length: 1, hex_value: 'AA' }
                    ]
                }]}
            />
        );

        // 协议级视图：改名标脏 → SAVE 出现且在协议名称 input 之后
        fireEvent.change(screen.getByDisplayValue('主协议'), { target: { value: '主协议改' } });
        let saveBtn = screen.getByRole('button', { name: '保存更改 (SAVE)' });
        let anchor = screen.getByDisplayValue('主协议改');
        expect(anchor.compareDocumentPosition(saveBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        // 块级视图：选中块改标签 → SAVE 仍在块字段之后（顶栏 SAVE 已撤）
        fireEvent.click(screen.getByRole('button', { name: '甲块' }));
        fireEvent.change(screen.getByDisplayValue('甲块'), { target: { value: '甲块改' } });
        saveBtn = screen.getByRole('button', { name: '保存更改 (SAVE)' });
        anchor = screen.getByDisplayValue('甲块改');
        expect(anchor.compareDocumentPosition(saveBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        // R3 #5 三页属性栏类名对齐：协议页属性 aside 补 shrink-0 + overflow-y-auto
        expect(saveBtn.closest('aside').className).toContain('shrink-0');
        expect(saveBtn.closest('aside').className).toContain('overflow-y-auto');
    });

    // ─── 批次四 P3-2: 协议 JSON 导出 ─────────────────────────────────────
    it('导出：顶栏按钮 → 下载 {schemaVersion, protocols:[当前工作副本]} JSON', async () => {
        vi.useRealTimers(); // FileReader 事件需真实事件循环（fake timers 会冻住 onload）
        render(
            <ProtocolHarness
                initialProtocols={[{
                    id: 'proto-1', label: '主协议', type: 'container', description: '备注',
                    children: [{ id: 'block-a', label: '甲块', type: 'fixed', byte_length: 1, hex_value: 'AA' }]
                }]}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: '导出' }));

        expect(triggerBlobDownload).toHaveBeenCalledTimes(1);
        const [blob, filename] = triggerBlobDownload.mock.calls[0];
        expect(filename).toBe('主协议.protocol.json');
        const parsed = JSON.parse(await readBlob(blob));
        expect(parsed.schemaVersion).toBe(1);
        expect(parsed.protocols).toHaveLength(1);
        expect(parsed.protocols[0].label).toBe('主协议');
        expect(parsed.protocols[0].description).toBe('备注');
        // 工作副本原样（id 保留在文件里，导入侧再重生）
        expect(parsed.protocols[0].children[0].id).toBe('block-a');
    });

    // ─── 批次四 P3-2: 协议 JSON 导入 ─────────────────────────────────────
    it('导入：选文件 → 预览弹窗 → 确认 POST（新 id、refs 重映射、label 保真）并切到导入项', async () => {
        vi.useRealTimers();
        api.createProtocol.mockImplementation(async (payload) => ({ ...payload }));

        render(
            <ProtocolHarness
                initialProtocols={[{ id: 'proto-1', label: '主协议', type: 'container', children: [] }]}
            />
        );

        const src = {
            schemaVersion: 1,
            protocols: [{
                id: 'p-x', label: '外来协议', type: 'container', description: '外部',
                children: [
                    { id: 'sa', label: '头', type: 'fixed', byte_length: 2, hex_value: 'AA 55' },
                    { id: 'sl', label: '长度', type: 'length', byte_length: 1, hex_value: '00', parameter_config: { type: 'length', refs: ['sa'] } }
                ]
            }]
        };
        const input = document.querySelector('input[type="file"]');
        expect(input).toBeTruthy();
        fireEvent.change(input, { target: { files: [makeJsonFile(JSON.stringify(src))] } });

        // 预览弹窗（NieRModal，摘要首行）
        await waitFor(() => expect(screen.getByText(/导入预览：共 1 个/)).toBeTruthy());
        fireEvent.click(screen.getByRole('button', { name: /确认/ }));

        await waitFor(() => expect(api.createProtocol).toHaveBeenCalledTimes(1));
        const payload = api.createProtocol.mock.calls[0][0];
        expect(payload.label).toBe('外来协议'); // 空闲名保真（不加 (副本)）
        expect(payload.id).not.toBe('p-x');
        expect(payload.description).toBe('外部');
        const ids = payload.children.map(c => c.id);
        expect(ids).not.toContain('sa');
        expect(payload.children[1].parameter_config.refs).toEqual([ids[0]]); // 自含重映射

        // 成功 → 追加列表并切到导入项（顶栏标题 = 新协议）
        await waitFor(() => expect(screen.getByText(/PROTOCOL EDITOR \/\/ 外来协议/)).toBeTruthy());
    });

    // ─── 批次四: checksum 算法配置 ───────────────────────────────────────
    it('算法下拉：checksum 卡选择 → parameter_config.algorithm 点保存落库（缺省 CRC_16_MODBUS）', async () => {
        api.updateProtocol.mockImplementation(async (id, payload) => ({ id, ...payload }));

        render(
            <ProtocolHarness
                initialProtocols={[{
                    id: 'proto-1', label: '主协议', type: 'container',
                    children: [{
                        id: 'c-a', label: '校验', type: 'checksum', byte_length: 1, hex_value: '00',
                        parameter_config: { type: 'checksum', refs: [] }
                    }]
                }]}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: '校验' }));
        const select = screen.getByText('校验算法 (Algorithm)').parentElement.querySelector('select');
        expect(select.value).toBe('CRC_16_MODBUS'); // 缺省显示（与两端回退口径同源）

        fireEvent.change(select, { target: { value: 'SUM_8' } });
        expect(api.updateProtocol).not.toHaveBeenCalled(); // 反馈 #3：无自动落库
        await saveViaButton();

        expect(api.updateProtocol).toHaveBeenCalledWith('proto-1', expect.objectContaining({
            children: [expect.objectContaining({
                id: 'c-a',
                parameter_config: { type: 'checksum', refs: [], algorithm: 'SUM_8' }
            })]
        }));
    });
});
