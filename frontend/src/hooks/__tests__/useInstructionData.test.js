import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useInstructionData } from '../useInstructionData';
import { api } from '../../api';

// Mock API
vi.mock('../../api', () => ({
    api: {
        getInstructions: vi.fn(),
        getOperatorTemplates: vi.fn(),
        createInstruction: vi.fn(),
        updateInstruction: vi.fn(),
        deleteInstruction: vi.fn()
    }
}));

describe('useInstructionData', () => {
    const mockInstructions = [
        { id: 'inst-1', device_code: 'DEV-001', code: 'CMD-001', name: 'Test 1', type: 'STATIC', fields: [] },
        { id: 'inst-2', device_code: 'DEV-002', code: 'CMD-002', name: 'Test 2', type: 'STATIC', fields: [] }
    ];
    const mockTemplates = [
        { op_code: 'HEX_RAW', label: 'Hex' }
    ];

    beforeEach(() => {
        vi.clearAllMocks();
        api.getInstructions.mockResolvedValue(mockInstructions);
        api.getOperatorTemplates.mockResolvedValue(mockTemplates);
    });

    it('should load initial data on mount', async () => {
        const { result } = renderHook(() => useInstructionData());

        // Initial state
        expect(result.current.isLoading).toBe(true);

        // Wait for async load
        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });

        // Verify data
        expect(result.current.instructions).toHaveLength(2);
        expect(result.current.operatorTemplates).toHaveProperty('HEX_RAW');
        expect(result.current.activeInstructionId).toBe('inst-1'); // Default to first
    });

    it('should handle API failure gracefully', async () => {
        api.getInstructions.mockRejectedValue(new Error('Network Error'));
        const { result } = renderHook(() => useInstructionData());

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });

        expect(result.current.statusMsg).toContain('离线模式');
    });

    it('should keep instructions available when operator templates fail to load', async () => {
        api.getOperatorTemplates.mockRejectedValue(new Error('Template Error'));

        const { result } = renderHook(() => useInstructionData());

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
            expect(result.current.isOperatorTemplatesLoading).toBe(false);
        });

        expect(result.current.instructions).toHaveLength(2);
        expect(result.current.activeInstructionId).toBe('inst-1');
        expect(result.current.operatorTemplates).toEqual({});
        expect(result.current.operatorTemplatesError).toBe('模块模板加载失败');
    });

    it('should add new instruction', async () => {
        const { result } = renderHook(() => useInstructionData());
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        const newInst = { id: 'inst-3', name: 'New Inst' };
        api.createInstruction.mockResolvedValue(newInst);

        await act(async () => {
            await result.current.addInstruction();
        });

        expect(api.createInstruction).toHaveBeenCalled();
        expect(result.current.instructions).toHaveLength(3);
        expect(result.current.activeInstructionId).toBe('inst-3');
    });

    it('should delete instruction', async () => {
        const { result } = renderHook(() => useInstructionData());
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        api.deleteInstruction.mockResolvedValue({});

        await act(async () => {
            await result.current.deleteInstruction('inst-1');
        });

        expect(api.deleteInstruction).toHaveBeenCalledWith('inst-1');
        expect(result.current.instructions).toHaveLength(1);
        expect(result.current.activeInstructionId).toBe('inst-2'); // Should switch to next available
    });

    it('should track unsaved changes on local update', async () => {
        const { result } = renderHook(() => useInstructionData());
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        expect(result.current.hasUnsavedChanges).toBe(false);

        // Simulate modification
        const updated = { ...mockInstructions[0], name: 'Modified' };
        act(() => {
            result.current.updateLocalInstruction(updated);
        });

        expect(result.current.instructions[0].name).toBe('Modified');
        expect(result.current.hasUnsavedChanges).toBe(true);
    });

    it('should save changes successfully', async () => {
        const { result } = renderHook(() => useInstructionData());
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        api.updateInstruction.mockResolvedValue({});

        await act(async () => {
            await result.current.saveChanges();
        });

        // Should call API with ID and Payload
        expect(api.updateInstruction).toHaveBeenCalledWith('inst-1', expect.objectContaining({
            device_code: 'DEV-001',
            code: 'CMD-001',
            name: 'Test 1',
            type: 'STATIC',
            fields: []
        }));
        expect(result.current.hasUnsavedChanges).toBe(false);
        expect(result.current.statusMsg).toBe('已保存');
    });

    it('should revert changes to original state (reload)', async () => {
        const { result } = renderHook(() => useInstructionData());
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        // Modify first
        const updated = { ...mockInstructions[0], name: 'Modified' };
        act(() => {
            result.current.updateLocalInstruction(updated);
        });
        expect(result.current.instructions[0].name).toBe('Modified');

        // Revert (Reload)
        await act(async () => {
            result.current.revertChanges();
        });

        expect(api.getInstructions).toHaveBeenCalledTimes(2); // Mounting + Revert
        // API mock returns original mockInstructions, so state should reset
        // Wait for async state update
        await waitFor(() => {
            const current = result.current.instructions.find(i => i.id === 'inst-1');
            expect(current.name).toBe('Test 1');
        });
    });

    it('should clear invalid active selection after filtering reload', async () => {
        const { result } = renderHook(() => useInstructionData());
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        act(() => {
            result.current.setActiveInstructionId('inst-2');
        });

        api.getInstructions.mockResolvedValueOnce([{ id: 'inst-1', device_code: 'DEV-001', code: 'CMD-001', name: 'Test 1', type: 'STATIC', fields: [] }]);

        await act(async () => {
            await result.current.loadInstructions('inst-1');
        });

        expect(result.current.activeInstructionId).toBe('inst-1');
    });

    it('should not auto-fetch instructions when shared ownership disables initial load', async () => {
        const fetchInstructions = vi.fn().mockResolvedValue(mockInstructions);

        const { result } = renderHook(() => useInstructionData({
            instructions: mockInstructions,
            setInstructions: vi.fn(),
            fetchInstructions,
            disableInitialLoad: true
        }));

        await waitFor(() => {
            expect(result.current.isOperatorTemplatesLoading).toBe(false);
        });

        expect(api.getInstructions).not.toHaveBeenCalled();
        expect(fetchInstructions).not.toHaveBeenCalled();
        expect(result.current.instructions).toEqual(mockInstructions);
        expect(result.current.activeInstructionId).toBe('inst-1');
    });

    // C1-b: P4-2 saveError 路径 — PUT 失败横幅与 P0-2 校验拦截的分界。
    describe('saveChanges — P4-2 saveError 路径', () => {
        const load = async () => {
            const { result } = renderHook(() => useInstructionData());
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            return result;
        };

        it('PUT 网络失败（无 response）→「网络/服务错误」+ 脏态保留', async () => {
            const result = await load();
            act(() => result.current.updateLocalInstruction({ ...mockInstructions[0], name: 'Dirty' }));
            api.updateInstruction.mockRejectedValueOnce(new Error('Network Error'));

            const openConfirm = vi.fn();
            await act(async () => { await result.current.saveChanges(openConfirm); });

            expect(result.current.saveError).toContain('网络/服务错误');
            expect(result.current.saveError).toContain('Network Error');
            expect(result.current.hasUnsavedChanges).toBe(true); // 不静默回滚
            expect(result.current.statusMsg).toContain('保存失败');
            expect(openConfirm).not.toHaveBeenCalled(); // 仅 400/422 弹确认
        });

        it('PUT 400 →「服务端拒绝（400）」+ detail + 弹确认', async () => {
            const result = await load();
            api.updateInstruction.mockRejectedValueOnce({
                response: { status: 400, data: { detail: '指令名称或代号必须唯一' } },
            });

            const openConfirm = vi.fn();
            await act(async () => { await result.current.saveChanges(openConfirm); });

            expect(result.current.saveError).toContain('服务端拒绝（400）');
            expect(result.current.saveError).toContain('指令名称或代号必须唯一');
            expect(openConfirm).toHaveBeenCalledWith(
                expect.stringContaining('保存失败'),
                expect.any(Function)
            );
        });

        it('上次失败后保存成功 → saveError 清空 + 脏态清除', async () => {
            const result = await load();
            api.updateInstruction.mockRejectedValueOnce(new Error('boom'));
            await act(async () => { await result.current.saveChanges(vi.fn()); });
            expect(result.current.saveError).not.toBe('');

            api.updateInstruction.mockResolvedValueOnce({});
            await act(async () => { await result.current.saveChanges(vi.fn()); });

            expect(result.current.saveError).toBe('');
            expect(result.current.hasUnsavedChanges).toBe(false);
        });

        it('P0-2 结构校验拦截 → 不设置 saveError、不发 PUT', async () => {
            const result = await load();
            // 悬空引用字段（REF_DANGLING 结构错误，参照 validateInstruction E2）
            act(() => {
                result.current.updateLocalInstruction({
                    ...mockInstructions[0],
                    fields: [{
                        id: 'f-bad', parent_id: null, sequence: 0,
                        name: 'BadLen', op_code: 'LENGTH_CALC', byte_len: 1,
                        parameter_config: { refs: ['ghost-field'] },
                    }],
                });
            });

            const openConfirm = vi.fn();
            await act(async () => { await result.current.saveChanges(openConfirm); });

            expect(result.current.saveError).toBe(''); // 校验失败 ≠ 网络失败
            expect(api.updateInstruction).not.toHaveBeenCalled();
            expect(result.current.statusMsg).toContain('保存被阻止');
            expect(openConfirm).toHaveBeenCalledWith(
                expect.stringContaining('结构错误'),
                expect.any(Function)
            );
        });
    });
});
