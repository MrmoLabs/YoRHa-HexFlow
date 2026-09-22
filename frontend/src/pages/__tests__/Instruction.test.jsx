import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import Instruction from '../Instruction';

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
    default: () => <div data-testid="mock-palette">Palette Component</div>
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
        updateLocalInstruction: vi.fn(),
        saveChanges: vi.fn(),
        revertChanges: vi.fn(),
        statusMsg: '',
        hasUnsavedChanges: false,
        currentInstruction: { id: 'mock', fields: [] },
        operatorTemplates: {}
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
});
