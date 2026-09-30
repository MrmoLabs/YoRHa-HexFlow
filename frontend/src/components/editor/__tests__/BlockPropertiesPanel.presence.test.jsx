import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import BlockPropertiesPanel from '../BlockPropertiesPanel';

// ─── N3 (G1 · PLAN §8.16): 面板「条件存在 (PRESENCE)」尾部独立区（红测先行）──
// 交互 = ref 拾取（复用 refs pickingMode，单 ref 不变量 currentRefs 归一）
//       + expect 文本输入 + 清除；APPLY 往返把 presence 落到块配置。

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

const blockWith = (presence) => ({
    id: 'b1',
    name: 'OPT',
    op_code: 'INT_SIGNED',
    byte_len: 1,
    sequence: 1,
    parent_id: null,
    parameter_config: { value: 9, ...(presence !== undefined ? { presence } : {}) },
});

const renderPanel = (presence, pickingMode) => {
    const block = blockWith(presence);
    return render(
        <BlockPropertiesPanel
            {...baseProps}
            {...(pickingMode ? { pickingMode } : {})}
            selectedBlock={block}
            currentInstruction={{
                id: 'i1', name: 'TEST', code: 'T1', device_code: 'D1',
                fields: [block, { id: 'cmd', name: 'CMD', op_code: 'HEX_RAW', byte_len: 1, sequence: 0, parameter_config: { hex: 'AA' } }],
            }}
        />
    );
};

const lastTemp = () => baseProps.onTempChange.mock.calls.at(-1)[0];
const pickCalls = () => baseProps.setPickingMode.mock.calls
    .filter(c => typeof c[0] === 'object' && c[0] && c[0].fieldKey === 'presence_ref');

// baseProps 是模块级共享 mock —— 逐用例清调用记录，防跨用例取到陈旧闭包。
beforeEach(() => {
    vi.clearAllMocks();
});

describe('BlockPropertiesPanel PRESENCE 区渲染', () => {
    it('选中块渲染「条件存在 (PRESENCE)」区，回显完整配置', () => {
        renderPanel({ ref_id: 'cmd', expect: '1' });
        expect(screen.getByTestId('presence-section')).toBeDefined();
        expect(screen.getByTestId('presence-summary').textContent).toContain('cmd');
        expect(screen.getByTestId('presence-summary').textContent).toContain('1');
        expect(screen.getByTestId('presence-expect').value).toBe('1');
    });

    it('无 presence → 区仍在，摘要显未配置态、expect 输入为空', () => {
        renderPanel(undefined);
        expect(screen.getByTestId('presence-section')).toBeDefined();
        expect(screen.getByTestId('presence-summary').textContent).toContain('未配置');
        expect(screen.getByTestId('presence-expect').value).toBe('');
    });
});

describe('BlockPropertiesPanel presence 编辑往返', () => {
    it('expect 输入 → temp 推送 presence.expect', () => {
        renderPanel({ ref_id: 'cmd', expect: '1' });
        fireEvent.change(screen.getByTestId('presence-expect'), { target: { value: '2' } });
        expect(lastTemp().parameter_config.presence).toEqual({ ref_id: 'cmd', expect: '2' });
    });

    it('无 presence 时键入 expect → 建立半成品配置（fail-open 可存）', () => {
        renderPanel(undefined);
        fireEvent.change(screen.getByTestId('presence-expect'), { target: { value: '1' } });
        expect(lastTemp().parameter_config.presence).toEqual({ expect: '1' });
    });

    it('PICK → setPickingMode 携带 presence_ref 门；onUpdateRefs 单 ref 落配置', () => {
        renderPanel({ ref_id: 'cmd', expect: '1' });
        fireEvent.click(screen.getByTestId('presence-pick'));

        const calls = pickCalls();
        expect(calls).toHaveLength(1);
        const picking = calls.at(-1)[0];
        expect(picking.isActive).toBe(true);
        expect(picking.currentRefs).toEqual(['cmd']);
        expect(typeof picking.onUpdateRefs).toBe('function');

        // 画布勾选第二块（handlePickBlock 追加到 currentRefs）—— 直调回调须
        // 包 act：真实点击走事件处理器（天然 act 边界），测试内裸调不刷新 state。
        act(() => picking.onUpdateRefs(['cmd', 'b2']));
        expect(lastTemp().parameter_config.presence.ref_id).toBe('b2');
        // 单 ref 不变量：currentRefs 归一为 [chosen]（functional 二次收敛）
        const normalize = baseProps.setPickingMode.mock.calls.at(-1)[0];
        expect(typeof normalize).toBe('function');
        expect(normalize({ isActive: true, fieldKey: 'presence_ref', currentRefs: ['cmd', 'b2'] }))
            .toEqual({ isActive: true, fieldKey: 'presence_ref', currentRefs: ['b2'] });
    });

    it('onUpdateRefs 空数组 → 摘除 ref_id（expect 保留则配置半存，双清则删键）', () => {
        renderPanel({ ref_id: 'cmd', expect: '1' });
        fireEvent.click(screen.getByTestId('presence-pick'));
        act(() => pickCalls().at(-1)[0].onUpdateRefs([]));
        const pc = lastTemp().parameter_config;
        expect('ref_id' in pc.presence).toBe(false);
        expect(pc.presence.expect).toBe('1');
    });

    it('清除按钮 → presence 键整体摘除', () => {
        renderPanel({ ref_id: 'cmd', expect: '1' });
        fireEvent.click(screen.getByTestId('presence-clear'));
        expect('presence' in lastTemp().parameter_config).toBe(false);
    });

    it('APPLY → onSaveBlock 回传 presence（配置往返闭环）', () => {
        renderPanel({ ref_id: 'cmd', expect: '1' });
        fireEvent.click(screen.getByRole('button', { name: '应用配置 (APPLY)' }));
        expect(baseProps.onSaveBlock).toHaveBeenCalledTimes(1);
        const saved = baseProps.onSaveBlock.mock.calls[0][0];
        expect(saved.parameter_config.presence).toEqual({ ref_id: 'cmd', expect: '1' });
        expect(saved.parameter_config.value).toBe(9);
    });
});

describe('BlockPropertiesPanel presence 拾取态', () => {
    it('本区拾取中 → 按钮切 STOP；他区拾取 → 本区保持 PICK', () => {
        const { unmount } = renderPanel({ ref_id: 'cmd' }, { isActive: true, fieldKey: 'presence_ref', currentRefs: ['cmd'], onUpdateRefs: null });
        expect(screen.getByTestId('presence-pick').textContent).toContain('停止拾取');
        unmount();

        renderPanel({ ref_id: 'cmd' }, { isActive: true, fieldKey: 'refs', currentRefs: [], onUpdateRefs: null });
        expect(screen.getByTestId('presence-pick').textContent).toContain('拾取条件字段');
    });
});
