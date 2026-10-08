import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import Instruction from '../Instruction';

// N2 (G2) 创建链路断言：vi.mock 工厂被提升到 import 之前，工厂/断言要引用的
// spy 必须经 vi.hoisted 提前创建；调色板 mock 在渲染时捕获 onAddBlock 供直调。
const deps = vi.hoisted(() => ({
    updateLocalInstruction: vi.fn(),
    onAddBlock: null,
    // R55（PLAN §8.86）：脏态开关由用例就地改写 —— UNSAVED 徽标只在真脏时渲染
    hasUnsavedChanges: false,
    // R56（PLAN §8.88）：LEN 行 VAR/FIXED 标记字色由用例就地改写
    fields: [],
}));

// Mock Child Components
vi.mock('../../components/editor/Canvas', () => ({
    default: () => <div data-testid="mock-canvas">Canvas Component</div>
}));
vi.mock('../../components/editor/InstructionListSidebar', () => ({
    default: () => <div data-testid="mock-sidebar">Sidebar Component</div>
}));
vi.mock('../../components/editor/BlockPropertiesPanel', () => ({
    default: () => <div data-testid="mock-props">Properties Component</div>
}));
vi.mock('../../components/editor/ComponentPalette', () => ({
    default: (props) => {
        deps.onAddBlock = props.onAddBlock;
        return <div data-testid="mock-palette">Palette Component</div>;
    }
}));

// Mock Custom Hooks (Contract Verification)
// If Instruction.jsx fails to destructure these correctly, test fails.
vi.mock('../../hooks/useInstructionData', () => ({
    useInstructionData: () => ({
        instructions: [],
        activeInstructionId: null,
        isLoading: false,
        addInstruction: vi.fn(),
        deleteInstruction: vi.fn(),
        loadInstructions: vi.fn(),
        updateLocalInstruction: deps.updateLocalInstruction,
        saveChanges: vi.fn(),
        revertChanges: vi.fn(),
        statusMsg: '',
        hasUnsavedChanges: deps.hasUnsavedChanges,
        currentInstruction: { id: 'mock', fields: deps.fields },
        // N2：STRING 模板形状与 backend SEED_TEMPLATES 同步（创建特判断言用）。
        operatorTemplates: {
            STRING: {
                op_code: 'STRING',
                name: '文本字段',
                category: 'BASE',
                description: '定长文本',
                param_template: { value: 'string', encoding: ['ascii', 'utf8'], pad_char: '00' },
            },
        },
    })
}));

vi.mock('../../hooks/useSelectionSystem', () => ({
    useSelectionSystem: () => ({
        selectedId: null,
        pickingMode: { isActive: false },
        setSelectedId: vi.fn(),
        handlePickBlock: vi.fn(),
        cancelPicking: vi.fn(),
        setPickingMode: vi.fn()
    })
}));

vi.mock('../../hooks/useInstructionLanes', () => ({
    useInstructionLanes: () => ({
        processedLanes: [],
        expandedGroupIds: [],
        handleNavigateGroup: vi.fn(),
        setFocusedParentId: vi.fn()
    })
}));

describe('Instruction Page (Smoke Test)', () => {
    it('should render main layout without crashing', () => {
        render(<Instruction />);

        // Check for presence of key layout containers
        expect(screen.getByTestId('mock-sidebar')).toBeDefined();
        expect(screen.getByTestId('mock-canvas')).toBeDefined();
        expect(screen.getByTestId('mock-palette')).toBeDefined();
    });

    // R55（PLAN §8.86）：未保存徽标 = 深红语义类 text-warn（原 text-yellow-500 压沙底 1.28）；
    // 干净态不渲染（不假装有未保存）。用例收尾把开关拨回，别污染后一条用例。
    it('R55 语义色：脏态 UNSAVED 徽标用 text-warn，干净态不渲染', () => {
        deps.hasUnsavedChanges = false;
        const { unmount } = render(<Instruction />);
        expect(screen.queryByText('UNSAVED')).toBeNull();
        unmount();

        deps.hasUnsavedChanges = true;
        try {
            render(<Instruction />);
            const badge = screen.getByText('UNSAVED');
            expect(badge.className).toContain('text-warn');
            expect(badge.className).not.toContain('text-yellow-500');
        } finally {
            deps.hasUnsavedChanges = false;
        }
    });

    // R56（PLAN §8.88）：LEN 行 VAR 标记 = 深琥珀语义类 text-hl
    // （原 text-[#E58D28] 压沙底实测 1.73:1）；FIXED 支本就降透明、不在口径内。
    it('R56 语义色：LEN 行 VAR 标记用 text-hl（presence 门完整 → variable）', () => {
        deps.fields = [
            { id: 'cmd', name: '命令字', op_code: 'FIXED', byte_len: 1, sequence: 0,
                parent_id: null, parameter_config: { hex: 'AA', value: 1 } },
            { id: 'gated', name: '体', op_code: 'FIXED', byte_len: 1, sequence: 1,
                parent_id: null, parameter_config: { hex: 'BB', presence: { ref_id: 'cmd', expect: '2' } } },
        ];
        try {
            render(<Instruction />);
            expect(screen.getByText('VAR').className).toContain('text-hl');
        } finally {
            deps.fields = [];
        }
    });
});

describe('Instruction 创建链路（N2 · G2 字符串入口）', () => {
    it('STRING 模板新建 → byte_len=8 / type=string / encoding 规范化标量 / value keyword 不复制', () => {
        render(<Instruction />);
        expect(typeof deps.onAddBlock).toBe('function');

        deps.updateLocalInstruction.mockClear();
        act(() => deps.onAddBlock('STRING'));

        expect(deps.updateLocalInstruction).toHaveBeenCalledTimes(1);
        const next = deps.updateLocalInstruction.mock.calls[0][0];
        const created = next.fields[next.fields.length - 1];

        expect(created.op_code).toBe('STRING');
        expect(created.byte_len).toBe(8);
        expect(created.parameter_config.type).toBe('string');
        // param_template 的 encoding 是数组（面板下拉源）→ 创建时必须归一为标量
        expect(created.parameter_config.encoding).toBe('ascii');
        expect(created.parameter_config.pad_char).toBe('00');
        // value: "string" 是表单控件 keyword → 不复制进 pc
        expect(created.parameter_config.value).toBeUndefined();
    });
});
