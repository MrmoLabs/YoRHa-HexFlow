import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BlockPropertiesPanel from '../BlockPropertiesPanel';

// ─── N5 (G4 · PLAN §8.16): 面板「对齐 / 填充 (ALIGN · PAD_TO)」独立区（红测先行）──
// 交互 = align / pad_to / pad_byte 三个输入 + 清除；APPLY 往返把三键落到块配置。
// 语义提示随摘要行给出（内容起点对齐 / 内容末尾补到边界 / 填充字节），
// 非法值由校验提醒（ALIGN_INVALID / PAD_TO_INVALID）承担，面板只做录入。

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

const blockWith = (pc) => ({
    id: 'b1',
    name: 'OPT',
    op_code: 'INT_SIGNED',
    byte_len: 1,
    sequence: 1,
    parent_id: null,
    parameter_config: { value: 9, ...pc },
});

const renderPanel = (pc) => {
    const block = blockWith(pc);
    return render(
        <BlockPropertiesPanel
            {...baseProps}
            selectedBlock={block}
            currentInstruction={{
                id: 'i1', name: 'TEST', code: 'T1', device_code: 'D1',
                fields: [block, { id: 'cmd', name: 'CMD', op_code: 'HEX_RAW', byte_len: 1, sequence: 0, parameter_config: { hex: 'AA' } }],
            }}
        />
    );
};

const lastTemp = () => baseProps.onTempChange.mock.calls.at(-1)[0];

beforeEach(() => {
    vi.clearAllMocks();
});

describe('BlockPropertiesPanel ALIGN 区渲染', () => {
    it('选中块渲染「对齐 / 填充」区，回显三键配置', () => {
        renderPanel({ align: '4', pad_to: '8', pad_byte: 'FF' });
        expect(screen.getByTestId('align-section')).toBeDefined();
        expect(screen.getByTestId('align-input').value).toBe('4');
        expect(screen.getByTestId('padto-input').value).toBe('8');
        expect(screen.getByTestId('padbyte-input').value).toBe('FF');
        expect(screen.getByTestId('align-summary').textContent).toContain('4');
    });

    it('无 pad 配置 → 区仍在，摘要显未配置态、三输入为空', () => {
        renderPanel(undefined);
        expect(screen.getByTestId('align-section')).toBeDefined();
        expect(screen.getByTestId('align-summary').textContent).toContain('未配置');
        expect(screen.getByTestId('align-input').value).toBe('');
        expect(screen.getByTestId('padto-input').value).toBe('');
        expect(screen.getByTestId('padbyte-input').value).toBe('');
    });
});

describe('BlockPropertiesPanel align/pad_to 编辑往返', () => {
    it('align 输入 → temp 推送 parameter_config.align（原样存串，编码期归一）', () => {
        renderPanel(undefined);
        fireEvent.change(screen.getByTestId('align-input'), { target: { value: '4' } });
        expect(lastTemp().parameter_config.align).toBe('4');
    });

    it('pad_to / pad_byte 输入 → temp 推送对应键', () => {
        renderPanel(undefined);
        fireEvent.change(screen.getByTestId('padto-input'), { target: { value: '8' } });
        expect(lastTemp().parameter_config.pad_to).toBe('8');
        fireEvent.change(screen.getByTestId('padbyte-input'), { target: { value: 'FF' } });
        expect(lastTemp().parameter_config.pad_byte).toBe('FF');
    });

    it('CLEAR → align/pad_to/pad_byte 三键全部摘除', () => {
        renderPanel({ align: '4', pad_to: '8', pad_byte: 'FF' });
        fireEvent.click(screen.getByTestId('align-clear'));
        const pc = lastTemp().parameter_config;
        expect(pc.align).toBeUndefined();
        expect(pc.pad_to).toBeUndefined();
        expect(pc.pad_byte).toBeUndefined();
        expect(pc.value).toBe(9); // 其余键不动
    });

    it('APPLY → onSaveBlock 回传含 align 三键的块配置（往返落库）', () => {
        renderPanel(undefined);
        fireEvent.change(screen.getByTestId('align-input'), { target: { value: '4' } });
        fireEvent.change(screen.getByTestId('padto-input'), { target: { value: '8' } });
        fireEvent.click(screen.getByText('应用配置 (APPLY)'));
        const saved = baseProps.onSaveBlock.mock.calls.at(-1)[0];
        expect(saved.parameter_config.align).toBe('4');
        expect(saved.parameter_config.pad_to).toBe('8');
    });
});
