import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BlockPropertiesPanel from '../BlockPropertiesPanel';

const baseProps = {
    operatorTemplates: {},
    hasUnsavedChanges: true,
    onUpdateInstruction: vi.fn(),
    onSaveInstruction: vi.fn(),
    onDeleteInstruction: vi.fn(),
    onDeleteBlock: vi.fn(),
    onSaveBlock: vi.fn(),
    openConfirm: vi.fn(),
    onOpenDatePicker: vi.fn(),
    pickingMode: { isActive: false },
    setPickingMode: vi.fn(),
    onPickBlock: vi.fn(),
    onTempChange: vi.fn(),
};

describe('BlockPropertiesPanel validation issues (P0-2)', () => {
    it('renders the issue list at meta view and locates the offending block on click', () => {
        const onLocateBlock = vi.fn();
        const { container } = render(
            <BlockPropertiesPanel
                {...baseProps}
                selectedBlock={null}
                currentInstruction={{
                    id: 'i1',
                    name: 'TEST',
                    code: 'T1',
                    device_code: 'D1',
                    fields: [],
                }}
                validationIssues={{
                    errors: [{ blockId: 'f9', message: '字段标签重复「X」' }],
                    warnings: [{ blockId: null, message: '模拟提醒（仅渲染）' }],
                }}
                onLocateBlock={onLocateBlock}
            />
        );

        // Error row rendered as bright full-strength text
        const errBtn = screen.getByText(/字段标签重复「X」/);
        expect(errBtn).toBeDefined();

        // P0 fix: the issue box sits at the TOP of the meta section (before the
        // first form field), so a blocked save is visible without scrolling.
        const html = container.innerHTML;
        expect(html.indexOf('字段标签重复')).toBeLessThan(html.indexOf('设备前缀'));

        fireEvent.click(errBtn);
        expect(onLocateBlock.mock.calls[0][0]).toBe('f9');

        // Warnings collapsed by default, expandable
        const toggle = screen.getByText(/展开提醒/);
        fireEvent.click(toggle);
        expect(screen.getByText(/模拟提醒/)).toBeDefined();
    });
});

// 批 1：字段级「录入进制」配置 —— 存 parameter_config.input_base，
// 加工页据此切十进制通道（值存储恒数值，编码端口径不变）。
describe('BlockPropertiesPanel 录入进制配置 (批 1)', () => {
    // 带一个算子模板参数，作为「参数区顶部固定行」的顺序基准
    const withBlock = (parameter_config) => render(
        <BlockPropertiesPanel
            {...baseProps}
            operatorTemplates={{ INPUT: { param_template: { start_val: { type: 'number' } } } }}
            selectedBlock={{
                id: 'f1', name: '速度', op_code: 'INPUT', byte_len: 1,
                parameter_config
            }}
            currentInstruction={{ id: 'i1', name: 'T', code: 'T1', device_code: 'D1', fields: [] }}
        />
    );

    it('参数区顶部固定行：「录入进制 (INPUT BASE)」HEX/DEC 切换，排在模板参数之前', () => {
        withBlock({});
        expect(screen.getByText(/录入进制/)).toBeDefined();

        const html = document.body.innerHTML;
        // 「配置参数 (CONFIG)」标题之下、模板参数（start_val）之上
        expect(html.indexOf('录入进制')).toBeGreaterThan(html.indexOf('配置参数 (CONFIG)'));
        expect(html.indexOf('录入进制')).toBeLessThan(html.indexOf('start_val'));
    });

    it('缺省显示 HEX 为当前态；切到 DEC 写回 parameter_config.input_base', () => {
        withBlock({});
        fireEvent.click(screen.getByRole('button', { name: 'DEC' }));

        // 写入经 handleTempParamUpdate → onTempChange 推送（面板用 temp 缓冲 + APPLY 落库）
        const pushed = baseProps.onTempChange.mock.calls.at(-1)[0];
        expect(pushed.parameter_config.input_base).toBe('dec');
    });

    it('存量字段（已存 dec）回显为 DEC 态；切回 HEX 写 hex', () => {
        withBlock({ input_base: 'dec' });
        const decBtn = screen.getByRole('button', { name: 'DEC' });
        expect(decBtn.className).toContain('bg-nier-light');

        fireEvent.click(screen.getByRole('button', { name: 'HEX' }));
        const pushed = baseProps.onTempChange.mock.calls.at(-1)[0];
        expect(pushed.parameter_config.input_base).toBe('hex');
    });

    it('不可编辑语义的块（HEX_RAW 固定值 / BITFIELD 打包值）不显示该配置', () => {
        withBlock({});
        expect(screen.getByText(/录入进制/)).toBeDefined();

        render(
            <BlockPropertiesPanel
                {...baseProps}
                selectedBlock={{
                    id: 'f2', name: '固定', op_code: 'HEX_RAW', byte_len: 1,
                    parameter_config: { hex: 'AA' }
                }}
                currentInstruction={{ id: 'i1', name: 'T', code: 'T1', device_code: 'D1', fields: [] }}
            />
        );
        // HEX_RAW 面板无录入进制行（固定值不走录入通道）
        expect(screen.getAllByText(/录入进制/)).toHaveLength(1);
    });
});

describe('BlockPropertiesPanel encoder-limit banner (P0-1)', () => {
    it('shows no B6 banner for a LITTLE-endian block (B6 withdrawn, E1-2)', () => {
        const block = {
            id: 'b1',
            name: 'LE_FLAG',
            op_code: 'HEX_RAW',
            byte_len: 1,
            endianness: 'LITTLE',
            parameter_config: { hex: 'AA' },
            sequence: 0,
            parent_id: null,
        };
        render(
            <BlockPropertiesPanel
                {...baseProps}
                selectedBlock={block}
                currentInstruction={{
                    id: 'i1',
                    name: 'TEST',
                    code: 'T1',
                    device_code: 'D1',
                    fields: [block],
                }}
                validationIssues={{ errors: [], warnings: [] }}
                onLocateBlock={vi.fn()}
            />
        );

        expect(screen.queryByText(/编码器限制（仅记录配置，不参与编码）/)).toBeNull();
        expect(screen.queryByText(/\[B6\]/)).toBeNull();
    });
});

// ─── 人工验证第 3 轮 #1: 复制块入口移除（两页属性面板都不出 DUPLICATE） ─────
describe('BlockPropertiesPanel 复制块按钮移除（R3 #1）', () => {
    it('块级视图不渲染「复制块 (DUPLICATE)」（即便传入 onDuplicateBlock），APPLY/DELETE 保留', () => {
        const block = {
            id: 'b1', name: '甲', op_code: 'HEX_RAW', byte_len: 1,
            parameter_config: { hex: 'AA' }, sequence: 0, parent_id: null,
        };
        const { container } = render(
            <BlockPropertiesPanel
                {...baseProps}
                onDuplicateBlock={vi.fn()}
                selectedBlock={block}
                currentInstruction={{
                    id: 'i1', name: 'TEST', code: 'T1', device_code: 'D1',
                    fields: [block],
                }}
            />
        );

        expect(screen.queryByRole('button', { name: '复制块 (DUPLICATE)' })).toBeNull();
        expect(screen.getByRole('button', { name: '应用配置 (APPLY)' })).toBeDefined();
        expect(screen.getByRole('button', { name: '删除 (DELETE)' })).toBeDefined();

        // R3 #5: 指令页属性 aside 类名对齐（补 shrink-0；overflow-y-auto 既有）
        const panelAside = container.querySelector('aside');
        expect(panelAside.className).toContain('shrink-0');
        expect(panelAside.className).toContain('overflow-y-auto');
    });
});
