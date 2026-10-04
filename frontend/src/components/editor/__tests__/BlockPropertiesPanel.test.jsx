import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

// ─── R24（§8.52 挂账 ③）: 创建后切换算子 —— 只读 span → 下拉 + 兼容校验 + 确认回执 ───
describe('BlockPropertiesPanel 切算子下拉（R24）', () => {
    const TPL = {
        HEX_RAW: { param_template: { hex: 'input' } },
        INT_UNSIGNED: { param_template: { bits: [8, 16, 32, 64] } },
        STRING: { param_template: { value: 'string', encoding: ['ascii', 'utf8'], pad_char: '00' } },
        ARRAY_GROUP: { param_template: { max_count: 'number' } },
    };

    const intBlock = {
        id: 'b1', name: '甲', op_code: 'INT_UNSIGNED', byte_len: 4,
        parameter_config: { bits: 32 }, sequence: 0, parent_id: null,
    };

    const renderPanel = (block, fields = [block]) => render(
        <BlockPropertiesPanel
            {...baseProps}
            operatorTemplates={TPL}
            selectedBlock={block}
            currentInstruction={{ id: 'i1', name: 'T', code: 'T1', device_code: 'D1', fields }}
            validationIssues={{ errors: [], warnings: [] }}
        />
    );

    it('op_code 从只读 span 变成下拉：选项 = 有模板的算子，当前值选中', () => {
        renderPanel(intBlock);
        const sel = screen.getByLabelText('算子 (Operator)');
        expect(sel.value).toBe('INT_UNSIGNED');

        const opts = [...sel.options].map(o => o.value);
        expect(opts).toContain('HEX_RAW');
        expect(opts).toContain('STRING');
        expect(opts).toContain('ARRAY_GROUP');
        expect(opts).not.toContain('STRUCT'); // 在 OP_CODES 但无算子模板 → 与调色板同源不提供
    });

    it('合法切换 → 确认回执（列保留/清除），确认前下拉已回弹，确认后草稿播种目标默认态', () => {
        renderPanel(intBlock);
        baseProps.openConfirm.mockClear();

        fireEvent.change(screen.getByLabelText('算子 (Operator)'), { target: { value: 'STRING' } });

        expect(baseProps.openConfirm).toHaveBeenCalledTimes(1);
        const [msg, action] = baseProps.openConfirm.mock.calls.at(-1);
        expect(msg).toContain('切换算子：INT_UNSIGNED → STRING');
        expect(msg).toContain('清除：bits');
        expect(msg).toContain('APPLY');

        // ① 受控回弹：确认前下拉仍显示原算子（不会出现「显示新算子、草稿还是旧」的假态）
        expect(screen.getByLabelText('算子 (Operator)').value).toBe('INT_UNSIGNED');

        // ② 确认 → 草稿换算子并按目标算子播种（type/encoding 播种、bits 摘除）
        act(() => action());
        const pushed = baseProps.onTempChange.mock.calls.at(-1)[0];
        expect(pushed.op_code).toBe('STRING');
        expect(pushed.parameter_config.type).toBe('string');
        expect(pushed.parameter_config.encoding).toBe('ascii');
        expect(pushed.parameter_config.bits).toBeUndefined();
    });

    it('取消 → 草稿一字未动（仍为原算子）', () => {
        renderPanel(intBlock);
        baseProps.openConfirm.mockClear();

        fireEvent.change(screen.getByLabelText('算子 (Operator)'), { target: { value: 'HEX_RAW' } });
        // 只取回执，不执行 action = 用户点「取消」
        expect(baseProps.openConfirm).toHaveBeenCalledTimes(1);
        const pushed = baseProps.onTempChange.mock.calls.at(-1)[0];
        expect(pushed.op_code).toBe('INT_UNSIGNED');
        expect(screen.getByLabelText('算子 (Operator)').value).toBe('INT_UNSIGNED');
    });

    it('容器带子块切成叶算子 → 拦（回执点名孤儿子块），即便「确认」也不转换', () => {
        const grp = {
            id: 'g1', name: '容器', op_code: 'ARRAY_GROUP', byte_len: 0,
            parameter_config: { max_count: 1 }, sequence: 0, parent_id: null,
        };
        const kid = {
            id: 'k1', name: '子', op_code: 'HEX_RAW', byte_len: 1,
            parameter_config: { hex: '00' }, sequence: 1, parent_id: 'g1',
        };
        renderPanel(grp, [grp, kid]);
        baseProps.openConfirm.mockClear();

        fireEvent.change(screen.getByLabelText('算子 (Operator)'), { target: { value: 'INT_UNSIGNED' } });

        const [msg, action] = baseProps.openConfirm.mock.calls.at(-1);
        expect(msg).toContain('无法切换算子');
        expect(msg).toContain('1 个子块');
        expect(msg).toContain('孤儿');
        expect(screen.getByLabelText('算子 (Operator)').value).toBe('ARRAY_GROUP');

        act(() => action()); // 阻断态的回执是空动作，即便调用也不改变草稿
        const pushed = baseProps.onTempChange.mock.calls.at(-1)[0];
        expect(pushed.op_code).toBe('ARRAY_GROUP');
    });
});

// ─── R25 (§8.57): 加扰字段 —— 明文输入框（PLAINTEXT）+ 加扰参数 + 就近校验 ────
describe('BlockPropertiesPanel R25 加扰字段 (SCRAMBLE)', () => {
    const SCRAMBLE_TPL = {
        SCRAMBLE: { param_template: { mode: ['XOR_SEED', 'BIT_ROLL'], seed: 'A5', roll: 1 } },
    };

    const renderScramble = (parameter_config, byte_len = 2) => render(
        <BlockPropertiesPanel
            {...baseProps}
            operatorTemplates={SCRAMBLE_TPL}
            selectedBlock={{
                id: 'f1', name: '加扰', op_code: 'SCRAMBLE', byte_len,
                parameter_config, sequence: 0, parent_id: null,
            }}
            currentInstruction={{
                id: 'i1', name: 'T', code: 'T1', device_code: 'D1',
                fields: [],
            }}
            validationIssues={{ errors: [], warnings: [] }}
        />
    );

    it('明文输入框在场（PLAINTEXT 标签）、模板参数渲染、录入进制不渲染', () => {
        const { container } = renderScramble({ hex: 'AABB', seed: 'A5' });
        expect(screen.getByText(/PLAINTEXT/)).toBeDefined();
        expect(screen.getByText(/STORED: AABB/)).toBeDefined();
        // SCRAMBLE 与 HEX_RAW 同判「不可编辑语义」→ 录入进制不渲染
        expect(screen.queryByText(/录入进制/)).toBeNull();
        // ParamConfigForm 在场（op ≠ HEX_RAW/BITFIELD）→ 三键齐
        const html = container.innerHTML;
        ['mode', 'seed', 'roll'].forEach((k) => expect(html).toContain(k));
        expect(html).toContain('XOR_SEED');
    });

    it('APPLY：非法种子 → 就近回执拒绝，不调 onSaveBlock', () => {
        renderScramble({ hex: 'AABB', seed: 'A' });
        baseProps.openConfirm.mockClear();
        baseProps.onSaveBlock.mockClear();

        fireEvent.click(screen.getByRole('button', { name: /应用配置 \(APPLY\)/ }));

        expect(baseProps.onSaveBlock).not.toHaveBeenCalled();
        const [msg, action] = baseProps.openConfirm.mock.calls.at(-1);
        expect(msg).toContain('校验错误');
        expect(msg).toContain('XOR 种子无效');
        // 阻断态回执是空动作
        act(() => action());
        expect(baseProps.onSaveBlock).not.toHaveBeenCalled();
    });

    it('APPLY：明文长度 ≠ byte_len×2 → 拒绝（与 HEX_RAW 同校验口径）', () => {
        renderScramble({ hex: 'AA', seed: 'A5' }, 2);
        baseProps.openConfirm.mockClear();
        baseProps.onSaveBlock.mockClear();

        fireEvent.click(screen.getByRole('button', { name: /应用配置 \(APPLY\)/ }));

        expect(baseProps.onSaveBlock).not.toHaveBeenCalled();
        const [msg] = baseProps.openConfirm.mock.calls.at(-1);
        expect(msg).toContain('需要 2 字节');
    });

    it('APPLY：合法 → onSaveBlock 收到去空白后的明文（大小写保留，出线时统一转大写，同 HEX_RAW 口径）', () => {
        renderScramble({ hex: 'aa bb', seed: 'A5' }, 2);
        baseProps.onSaveBlock.mockClear();
        baseProps.openConfirm.mockClear();

        fireEvent.click(screen.getByRole('button', { name: /应用配置 \(APPLY\)/ }));

        expect(baseProps.openConfirm).not.toHaveBeenCalled();
        const saved = baseProps.onSaveBlock.mock.calls.at(-1)[0];
        expect(saved.parameter_config.hex).toBe('aabb');
        expect(saved.parameter_config.seed).toBe('A5');
        expect(saved.op_code).toBe('SCRAMBLE');
    });
});
