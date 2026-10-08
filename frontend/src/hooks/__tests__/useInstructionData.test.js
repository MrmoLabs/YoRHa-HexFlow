import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useInstructionData, describeReferences, describeDeletion } from '../useInstructionData';
import { moveField } from '../../utils/moveField';
import { api } from '../../api';

// Mock API
vi.mock('../../api', () => ({
    api: {
        getInstructions: vi.fn(),
        getOperatorTemplates: vi.fn(),
        createInstruction: vi.fn(),
        updateInstruction: vi.fn(),
        deleteInstruction: vi.fn(),
        // 批次二 (D12/D14②): 删前引用计数
        getInstructionReferences: vi.fn()
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

    // 批次二 (D12/D14②): 删前 GET 引用计数 → 弹窗列出受影响项与处置 → 确认才删
    it('deleteInstruction 先取引用计数，确认文案按三分口径列受影响项', async () => {
        const { result } = renderHook(() => useInstructionData());
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        api.getInstructionReferences.mockResolvedValue({
            instruction_id: 'inst-1', bindings: 2, response_specs: 1,
            sequence_steps: 3, dispatch_logs: 4, total: 10
        });
        api.deleteInstruction.mockResolvedValue({
            status: 'deleted', deleted_bindings: 2, deleted_response_specs: 1,
            orphaned_sequence_steps: 3
        });

        let message = null;
        let action = null;
        await act(async () => {
            await result.current.deleteInstruction('inst-1', (msg, cb) => {
                message = msg;
                action = cb;
            });
        });

        expect(api.getInstructionReferences).toHaveBeenCalledWith('inst-1');
        expect(message).toContain('本指令被 10 处引用');
        expect(message).toContain('协议绑定 2 条 → 随删入站');
        expect(message).toContain('应答规格 1 条 → 随删入站');
        expect(message).toContain('序列步骤 3 条 → 保留');
        expect(message).toContain('通讯日志 4 条 → 只读保留');
        // 确认前不删
        expect(api.deleteInstruction).not.toHaveBeenCalled();

        await act(async () => { await action(); });
        expect(api.deleteInstruction).toHaveBeenCalledWith('inst-1');
        expect(result.current.instructions).toHaveLength(1);
        // 回执并入状态条（级联与留失效都要看得见）
        expect(result.current.statusMsg).toContain('绑定 2 条级联');
        expect(result.current.statusMsg).toContain('序列步骤 3 条留失效');
    });

    it('引用计数接口失败时降级回原文案（不拦删除）', async () => {
        const { result } = renderHook(() => useInstructionData());
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        api.getInstructionReferences.mockRejectedValue(new Error('500'));
        api.deleteInstruction.mockResolvedValue({});

        let message = null;
        let action = null;
        await act(async () => {
            await result.current.deleteInstruction('inst-1', (msg, cb) => {
                message = msg;
                action = cb;
            });
        });
        expect(message).toContain('警告：确认将此指令移入回收站？');
        await act(async () => { await action(); });
        expect(api.deleteInstruction).toHaveBeenCalledWith('inst-1');
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

    // ─── R18（PLAN §8.49 · §8.49 R18 行）：字段引用测试补强 ───────────────────
    // 单条路径（计数 / 块移动 / 保存失败）各自已有测试；这里钉**交叉**行为：
    // references 计数 × 块移动、references 计数 × 删除失败、块移动 × 保存失败恢复。
    describe('R18 references 计数 × 块移动 / 保存失败恢复（组合面）', () => {
        const FIELDS = [
            { id: 'f-a', parent_id: null, sequence: 0, name: 'Alpha', op_code: 'HEX_RAW', byte_len: 1, parameter_config: {} },
            { id: 'f-b', parent_id: null, sequence: 1, name: 'Beta', op_code: 'HEX_RAW', byte_len: 1, parameter_config: {} }
        ];
        const ids = (inst) => (inst?.fields || []).map((f) => f.id);
        const withFields = () => {
            api.getInstructions.mockResolvedValue([
                { ...mockInstructions[0], fields: FIELDS },
                mockInstructions[1]
            ]);
        };
        const load = async () => {
            const { result } = renderHook(() => useInstructionData());
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            return result;
        };
        // 指令页 onMoveItem 的原样组合：纯函数 moveField → updateLocalInstruction
        const moveBlock = (result, itemId, newIndex) => {
            const current = result.current.currentInstruction;
            act(() => {
                result.current.updateLocalInstruction({
                    ...current,
                    fields: moveField(current.fields, itemId, null, newIndex)
                });
            });
        };

        it('块移动只动草稿：删前计数照常按 id 拉，确认后连草稿与脏标一起收口', async () => {
            withFields();
            const result = await load();
            moveBlock(result, 'f-b', 0);
            expect(ids(result.current.instructions[0])).toEqual(['f-b', 'f-a']); // 草稿 overlay
            expect(result.current.hasUnsavedChanges).toBe(true);

            api.getInstructionReferences.mockResolvedValue({
                instruction_id: 'inst-1', bindings: 1, response_specs: 0,
                sequence_steps: 0, dispatch_logs: 0, total: 1
            });
            api.deleteInstruction.mockResolvedValue({});

            let message = null;
            let action = null;
            await act(async () => {
                await result.current.deleteInstruction('inst-1', (msg, cb) => {
                    message = msg;
                    action = cb;
                });
            });

            // 计数只认后端按 id 拉，**不看本地把块挪到了第几格**
            expect(api.getInstructionReferences).toHaveBeenCalledWith('inst-1');
            expect(message).toContain('本指令被 1 处引用');
            expect(message).toContain('协议绑定 1 条 → 随删入站');
            expect(message).not.toContain('应答规格'); // 0 分项不列行
            expect(api.deleteInstruction).not.toHaveBeenCalled();

            await act(async () => { await action(); });
            expect(api.deleteInstruction).toHaveBeenCalledWith('inst-1');
            expect(result.current.instructions).toHaveLength(1);
            expect(result.current.currentInstruction.id).toBe('inst-2'); // 活动切下一条
            expect(result.current.hasUnsavedChanges).toBe(false); // 删除把草稿与脏标一并清
            expect(result.current.statusMsg).toContain('已移入回收站');
        });

        it('取消确认零 DELETE；再点删除重新拉一次计数（不跨次缓存）', async () => {
            const result = await load();
            api.getInstructionReferences.mockResolvedValue({
                bindings: 0, response_specs: 0, sequence_steps: 2,
                dispatch_logs: 0, total: 2
            });
            api.deleteInstruction.mockResolvedValue({});

            let message = null;
            let action = null;
            await act(async () => {
                await result.current.deleteInstruction('inst-1', (msg, cb) => {
                    message = msg;
                    action = cb;
                });
            });
            expect(message).toContain('序列步骤 2 条 → 保留');
            expect(message).not.toContain('协议绑定');

            // 用户点「取消」= 不执行回调 —— 计数拉到了也一行不删
            expect(action).toBeInstanceOf(Function);
            expect(api.deleteInstruction).not.toHaveBeenCalled();
            expect(result.current.instructions).toHaveLength(2);

            await act(async () => {
                await result.current.deleteInstruction('inst-1', () => { });
            });
            expect(api.getInstructionReferences).toHaveBeenCalledTimes(2);
            expect(api.deleteInstruction).not.toHaveBeenCalled();
        });

        it('计数拉到、确认后 DELETE 失败 → 报错留台、指令与草稿都在、脏标不清', async () => {
            withFields();
            const result = await load();
            act(() => {
                result.current.updateLocalInstruction({
                    ...result.current.currentInstruction,
                    name: '未保存的名字'
                });
            });
            api.getInstructionReferences.mockResolvedValue({
                bindings: 0, response_specs: 0, sequence_steps: 0,
                dispatch_logs: 3, total: 3
            });
            api.deleteInstruction.mockRejectedValue(new Error('Network Error'));

            let action = null;
            await act(async () => {
                await result.current.deleteInstruction('inst-1', (msg, cb) => {
                    action = cb;
                });
            });
            await act(async () => { await action(); });

            expect(result.current.instructions).toHaveLength(2);
            expect(result.current.statusMsg).toContain('删除失败');
            expect(result.current.hasUnsavedChanges).toBe(true); // 失败不清脏标
            expect(result.current.currentInstruction.name).toBe('未保存的名字'); // 草稿不丢
        });

        it('块移动 → PUT 400 → 顺序与脏态都不回滚；撤销回移动前 → 重试成功清横幅与脏标', async () => {
            withFields();
            const result = await load();
            expect(ids(result.current.currentInstruction)).toEqual(['f-a', 'f-b']);

            moveBlock(result, 'f-b', 0);
            expect(ids(result.current.instructions[0])).toEqual(['f-b', 'f-a']);

            api.updateInstruction.mockRejectedValueOnce({
                response: { status: 400, data: { detail: '指令名称或代号必须唯一' } }
            });
            await act(async () => { await result.current.saveChanges(vi.fn()); });

            expect(result.current.saveError).toContain('服务端拒绝（400）');
            expect(result.current.hasUnsavedChanges).toBe(true); // 不静默回滚
            expect(ids(result.current.instructions[0])).toEqual(['f-b', 'f-a']); // 顺序也保留
            expect(result.current.canUndo).toBe(true);

            act(() => result.current.undo()); // 撤销回到移动前
            expect(ids(result.current.instructions[0])).toEqual(['f-a', 'f-b']);

            api.updateInstruction.mockResolvedValueOnce({});
            await act(async () => { await result.current.saveChanges(vi.fn()); });
            expect(result.current.saveError).toBe(''); // 横幅随成功清空
            expect(result.current.hasUnsavedChanges).toBe(false);
            expect(result.current.canUndo).toBe(false); // 保存 = 新基线（历史清空）
        });
    });

    // ─── 人工验证反馈 #2：管理页工作副本（草稿）不出门 ─────────────────────
    // 共享 instructions 态是加工页/编排页读的真源 —— 草稿编辑只允许存在于
    // hook 内（overlay），saveChanges 成功才写穿共享态。
    describe('草稿隔离（反馈 #2）', () => {
        it('updateLocalInstruction 只写 hook 内草稿：共享 setInstructions 不被调用，管理页视图仍见草稿', () => {
            const setExternal = vi.fn();
            const { result } = renderHook(() => useInstructionData({
                instructions: mockInstructions,
                setInstructions: setExternal,
                disableInitialLoad: true,
            }));

            act(() => { result.current.setActiveInstructionId('inst-1'); });
            act(() => { result.current.updateLocalInstruction({ ...mockInstructions[0], name: '草稿名' }); });

            // 加工页读的共享态零写入 → 未保存编辑不外泄
            expect(setExternal).not.toHaveBeenCalled();
            // 管理页自身仍能看到草稿 + 脏标
            expect(result.current.currentInstruction.name).toBe('草稿名');
            expect(result.current.hasUnsavedChanges).toBe(true);
        });

        it('saveChanges 成功 → 写穿共享态（functional）并清草稿/脏标', async () => {
            const setExternal = vi.fn();
            api.updateInstruction.mockResolvedValue({});
            const { result } = renderHook(() => useInstructionData({
                instructions: mockInstructions,
                setInstructions: setExternal,
                disableInitialLoad: true,
            }));

            act(() => { result.current.setActiveInstructionId('inst-1'); });
            act(() => { result.current.updateLocalInstruction({ ...mockInstructions[0], name: '已保存名' }); });
            // 草稿期共享态零写入（当前实现恰在此泄漏一次 —— 这里钉死区分）
            expect(setExternal).not.toHaveBeenCalled();
            await act(async () => { await result.current.saveChanges(); });

            expect(api.updateInstruction).toHaveBeenCalledTimes(1);
            expect(setExternal).toHaveBeenCalledTimes(1);
            const updater = setExternal.mock.calls[0][0];
            expect(typeof updater).toBe('function');
            expect(updater(mockInstructions).find(i => i.id === 'inst-1').name).toBe('已保存名');
            expect(result.current.hasUnsavedChanges).toBe(false);
        });

        it('脏态时外部共享态推进不覆盖草稿；放弃脏标后回落外部基准', () => {
            const { result, rerender } = renderHook(
                ({ list }) => useInstructionData({
                    instructions: list,
                    setInstructions: vi.fn(),
                    disableInitialLoad: true,
                }),
                { initialProps: { list: mockInstructions } }
            );

            act(() => { result.current.setActiveInstructionId('inst-1'); });
            act(() => { result.current.updateLocalInstruction({ ...mockInstructions[0], name: '草稿中' }); });

            // 模拟加工页/WebUpdate 推进共享态（服务端版本）
            const serverList = [{ ...mockInstructions[0], name: '服务端版' }, mockInstructions[1]];
            rerender({ list: serverList });

            expect(result.current.currentInstruction.name).toBe('草稿中');
            expect(result.current.instructions.find(i => i.id === 'inst-1').name).toBe('草稿中');

            // 放弃脏标 → 草稿丢弃，回落外部基准
            act(() => { result.current.setHasUnsavedChanges(false); });
            expect(result.current.currentInstruction.name).toBe('服务端版');
        });
    });

    // ─── R53 (PLAN §8.85): 过期回包不得覆盖更新的本地状态 ────────────────
    it('R53 回归：保存回包晚于新编辑 → 草稿与脏标不得被过期回包清掉', async () => {
        // 回包由本测试掌闸（mockImplementation 不进延迟注入 → 0ms / 15ms 档同形）
        let release;
        api.updateInstruction.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

        const { result } = renderHook(() => useInstructionData({
            instructions: mockInstructions,
            setInstructions: vi.fn(),
            disableInitialLoad: true,
        }));

        act(() => { result.current.setActiveInstructionId('inst-1'); });
        act(() => { result.current.updateLocalInstruction({ ...mockInstructions[0], name: '存前' }); });
        expect(result.current.hasUnsavedChanges).toBe(true);

        act(() => { result.current.saveChanges(); });
        await waitFor(() => expect(api.updateInstruction).toHaveBeenCalledTimes(1));

        // 回包未回 → 用户又改一刀（工作副本仍是 hook 内草稿）
        act(() => { result.current.updateLocalInstruction({ ...mockInstructions[0], name: '存后' }); });

        await act(async () => {
            release({});
            await Promise.resolve();
            await Promise.resolve();
        });

        // 判据：这份回包对应的是**上一次**保存 —— 存后那次编辑不得被判成已保存
        //（清草稿 + 清脏标 = 下一次保存的 payload 里不再有它，共享态被写回旧快照）
        expect(result.current.hasUnsavedChanges).toBe(true);
        expect(result.current.currentInstruction.name).toBe('存后');
    });


    // ─── 优化批（调研后优化 2/3）：位段元数据零 DDL 存储 ─────────────────────
    // bit_fields 表无 JSON 列 → signed/value_table 骑 pc.bit_meta：
    // 读取合并回 bits（编辑视图单源），保存拆分回落 pc（normalizeInstructionPayload）。
    const bitInstruction = {
        id: 'inst-bit',
        device_code: 'DEV-900',
        code: 'CMD-900',
        name: '位域指令',
        type: 'STATIC',
        fields: [{
            id: 'f-bit',
            name: '控制位',
            op_code: 'BITFIELD',
            byte_len: 1,
            parameter_config: {
                input_base: 'dec',
                bit_meta: {
                    b1: { signed: true, value_table: [{ value: 0, label: '关' }, { value: 1, label: '开' }] }
                }
            },
            bits: [
                { id: 'b1', sequence: 0, bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1 },
                { id: 'b2', sequence: 1, bit_name: 'EN', start_bit: 2, bit_len: 1, default_val: 1 }
            ]
        }]
    };

    it('读取合并：pc.bit_meta 按位段 id 合并回 bits（编辑视图单源）', async () => {
        api.getInstructions.mockResolvedValue([bitInstruction]);
        const { result } = renderHook(() => useInstructionData());
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        const field = result.current.instructions[0].fields[0];
        expect(field.bits[0]).toMatchObject({
            signed: true,
            value_table: [{ value: 0, label: '关' }, { value: 1, label: '开' }]
        });
        expect(field.bits[1].signed).toBeUndefined();
        // pc 原样保留（bit_meta 不被消费掉 —— 保存时重建同源）
        expect(field.parameter_config.bit_meta).toBeTruthy();
        expect(field.parameter_config.input_base).toBe('dec');
    });

    it('保存拆分：updateInstruction 负载 bits 干净、meta 落 pc.bit_meta（以 bits 为准重建）', async () => {
        // 编辑态：bits 上携带**新**元数据（读取合并后的单源 + 用户改过值表），
        // pc.bit_meta 是**陈旧**的 —— 保存必须按 bits 重建覆盖，而非透传旧值。
        const edited = {
            ...bitInstruction,
            fields: [{
                ...bitInstruction.fields[0],
                parameter_config: {
                    input_base: 'dec',
                    bit_meta: { b1: { value_table: [{ value: 0, label: '旧' }] } }
                },
                bits: [
                    {
                        id: 'b1', sequence: 0, bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1,
                        signed: true, value_table: [{ value: 0, label: '关' }, { value: 1, label: '开' }]
                    },
                    { id: 'b2', sequence: 1, bit_name: 'EN', start_bit: 2, bit_len: 1, default_val: 1 }
                ]
            }]
        };
        api.getInstructions.mockResolvedValue([edited]);
        const { result } = renderHook(() => useInstructionData());
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        api.updateInstruction.mockResolvedValue({});
        await act(async () => { await result.current.saveChanges(); });

        expect(api.updateInstruction).toHaveBeenCalledTimes(1);
        const payload = api.updateInstruction.mock.calls[0][1];
        const f = payload.fields[0];
        // bits 落库列口径干净（元数据不进 bit_fields 行）
        expect(f.bits[0].signed).toBeUndefined();
        expect(f.bits[0].value_table).toBeUndefined();
        // 按 bits 重建（陈旧的 pc.bit_meta 被覆盖）
        expect(f.parameter_config.bit_meta).toEqual({
            b1: { signed: true, value_table: [{ value: 0, label: '关' }, { value: 1, label: '开' }] }
        });
        // 保存未被 validateInstruction 拦截（meta 不构成结构错误）
        expect(result.current.hasUnsavedChanges).toBe(false);
    });
});

// 批次二 (D12/D14②): 删除文案三分口径 —— 导出为纯函数即为钉口径（改文案必改测试）
describe('describeReferences / describeDeletion 三分口径', () => {
    it('无引用：原文案 + 无引用说明', () => {
        const msg = describeReferences({ total: 0, bindings: 0, response_specs: 0, sequence_steps: 0, dispatch_logs: 0 });
        expect(msg).toContain('警告：确认将此指令移入回收站？');
        expect(msg).toContain('无引用');
    });

    it('计数接口失败（null）也走无引用分支，不抛错', () => {
        expect(() => describeReferences(null)).not.toThrow();
        expect(describeReferences(null)).toContain('无引用');
    });

    it('四表分别标注：活配置级联 / 冻结快照保留 / 日志只读', () => {
        const msg = describeReferences({ bindings: 1, response_specs: 2, sequence_steps: 3, dispatch_logs: 4, total: 10 });
        expect(msg).toMatch(/协议绑定 1 条 → 随删入站/);
        expect(msg).toMatch(/应答规格 2 条 → 随删入站/);
        expect(msg).toMatch(/序列步骤 3 条 → 保留/);
        expect(msg).toMatch(/通讯日志 4 条 → 只读保留/);
    });

    it('计数为 0 的表不出行（文案不噪音）', () => {
        const msg = describeReferences({ bindings: 0, response_specs: 0, sequence_steps: 1, dispatch_logs: 0, total: 1 });
        expect(msg).not.toContain('协议绑定');
        expect(msg).toContain('序列步骤 1 条');
    });

    it('describeDeletion：回执并入状态条，空回执退回原文案', () => {
        expect(describeDeletion(undefined)).toBe('已移入回收站（指令）');
        expect(describeDeletion({ deleted_bindings: 0, deleted_response_specs: 0, orphaned_sequence_steps: 0 })).toBe('已移入回收站（指令）');
        const msg = describeDeletion({ deleted_bindings: 2, deleted_response_specs: 1, orphaned_sequence_steps: 3 });
        expect(msg).toContain('绑定 2 条级联');
        expect(msg).toContain('应答规格 1 条级联');
        expect(msg).toContain('序列步骤 3 条留失效');
    });

    // R18（PLAN §8.49）：只有一类命中时不凑满三段 —— 缺的那一段不报 0、不占位
    it('describeDeletion：只报非零那一段（部分级联不写「0 条」）', () => {
        expect(describeDeletion({ deleted_bindings: 0, deleted_response_specs: 2, orphaned_sequence_steps: 0 }))
            .toBe('已移入回收站（指令） · 应答规格 2 条级联');
        expect(describeDeletion({ deleted_bindings: 0, deleted_response_specs: 0, orphaned_sequence_steps: 4 }))
            .toBe('已移入回收站（指令） · 序列步骤 4 条留失效');
        expect(describeDeletion({ deleted_bindings: 3, deleted_response_specs: 0, orphaned_sequence_steps: 0 }))
            .toBe('已移入回收站（指令） · 绑定 3 条级联');
    });

    // R18：只有日志被引用（最轻的一档）也得说清楚「只读保留」，不能掉进无引用分支
    it('describeReferences：仅日志被引用时列日志行且不冒充无引用', () => {
        const msg = describeReferences({
            bindings: 0, response_specs: 0, sequence_steps: 0, dispatch_logs: 5, total: 5
        });
        expect(msg).toContain('本指令被 5 处引用');
        expect(msg).toContain('通讯日志 5 条 → 只读保留');
        expect(msg).not.toContain('无引用');
    });

    // R37（PLAN §8.69）：发前路由规则归「活配置」—— 单列一行、计入 total
    it('describeReferences：发前路由规则单列一行并计入总数', () => {
        const msg = describeReferences({
            bindings: 0, response_specs: 0, sequence_steps: 0, dispatch_logs: 0,
            routing_rules: 2, total: 2
        });
        expect(msg).toContain('本指令被 2 处引用');
        expect(msg).toMatch(/发前路由规则 2 条 → 随删入站/);
        expect(msg).not.toContain('无引用');
    });

    it('describeReferences：只有发前路由规则被引用时也不冒充无引用', () => {
        const msg = describeReferences({
            bindings: 0, response_specs: 0, sequence_steps: 0, dispatch_logs: 0,
            routing_rules: 1, total: 1
        });
        expect(msg).toContain('本指令被 1 处引用');
        expect(msg).toContain('发前路由规则 1 条');
        expect(msg).not.toContain('无引用');
    });

    it('describeDeletion：发前路由规则级联非零才报（零不占位）', () => {
        expect(
            describeDeletion({
                deleted_bindings: 0, deleted_response_specs: 0,
                orphaned_sequence_steps: 0, deleted_routing_rules: 3
            })
        ).toBe('已移入回收站（指令） · 发前路由规则 3 条级联');
        expect(
            describeDeletion({
                deleted_bindings: 0, deleted_response_specs: 0,
                orphaned_sequence_steps: 0, deleted_routing_rules: 0
            })
        ).toBe('已移入回收站（指令）');
    });
});
