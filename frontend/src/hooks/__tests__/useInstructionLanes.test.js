import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInstructionLanes } from '../useInstructionLanes';

describe('useInstructionLanes', () => {
    const mockInstruction = {
        id: 'inst-1',
        fields: [
            { id: 'g1', op_code: 'ARRAY_GROUP', label: 'Group 1', sequence: 0 },
            { id: 'b1', parent_id: 'g1', label: 'b1', sequence: 0 },
            { id: 'b2', label: 'Root Block', sequence: 1 },
            // Formula Block
            {
                id: 'calc',
                op_code: 'LENGTH_CALC',
                parameter_config: { formula: '([b1] + 10)' },
                byte_len: 1
            }
        ]
    };

    it('should build recursive lanes structure (Expand logic)', () => {
        const { result } = renderHook(() => useInstructionLanes(mockInstruction, 'inst-1'));

        // Initially expandedGroupIds is empty/populated by default effect?
        // Let's check default behavior: hook sets all groups expanded on mount
        expect(result.current.expandedGroupIds).toContain('g1');

        // Should have Root Lane + Group Lane
        expect(result.current.processedLanes).toHaveLength(2);

        // Collapse Group
        act(() => {
            result.current.handleNavigateGroup('g1');
        });

        // Should now only have Root Lane (Group 1 is child of root, but visual lanes depend on expansion)
        // Wait, logic says: "Find expands within this lane... if expanded, build children".
        // So if collapsed, children lanes are not built.
        expect(result.current.expandedGroupIds).not.toContain('g1');
        expect(result.current.processedLanes).toHaveLength(1); // Only root
    });

    it('should evaluate formulas in processedLanes', () => {
        // We need a setup where [b1] has a value.
        // The hook logic uses 'byte_len' as value for normal blocks.
        // b1 byte_len is undefined in mock -> 0.
        // Let's update mock
        const complexMock = { ...mockInstruction };
        complexMock.fields[1].byte_len = 5; // b1 = 5

        const { result } = renderHook(() => useInstructionLanes(complexMock, 'inst-1'));

        const rootLane = result.current.processedLanes.find(l => l.parentId === null);
        const calcBlock = rootLane.items.find(i => i.id === 'calc');

        // Formula: ([b1] + 10) -> (5 + 10) = 15 -> 0F
        expect(calcBlock.parameter_config.computedValue).toBe('0F');
    });

    it('should process TIME_ACCUMULATOR', () => {
        // Mock System Time: 2026-01-01 12:00:00 UTC
        const mockNow = new Date('2026-01-01T12:00:00Z');
        vi.setSystemTime(mockNow);

        const timeMock = {
            fields: [
                {
                    id: 't1',
                    op_code: 'TIME_ACCUMULATOR',
                    parameter_config: { base_time: '2026-01-01T10:00:00Z' },
                    byte_len: 4
                }
            ]
        };

        const { result } = renderHook(() => useInstructionLanes(timeMock, 'inst-1'));
        const item = result.current.processedLanes[0].items[0];

        // Diff = 2 hours = 7200 seconds -> 0x00001C20
        // Hex formatting checks
        expect(item.parameter_config.computedValue).toBe('00 00 1C 20');

        vi.useRealTimers();
    });

    it('should process AUTO_COUNTER', () => {
        const counterMock = {
            fields: [{ id: 'ac1', op_code: 'AUTO_COUNTER', parameter_config: { start_val: 255 }, byte_len: 1 }]
        };
        const { result } = renderHook(() => useInstructionLanes(counterMock, 'inst-1'));
        const item = result.current.processedLanes[0].items[0];

        // 255 -> FF
        expect(item.parameter_config.computedValue).toBe('FF');
    });

    it('should handle missing formula variables', () => {
        const brokenMock = {
            fields: [
                { id: 'calc', op_code: 'LENGTH_CALC', parameter_config: { formula: '[Missing]' } }
            ]
        };
        const { result } = renderHook(() => useInstructionLanes(brokenMock, 'inst-1'));

        const item = result.current.processedLanes[0].items[0];
        // Missing var maps to undefined/0 or ?? depending on implementation
        // Implementation: nameToValueMap[v] === "??" check?
        // Actually, map logic uses f.name || f.label.
        // If 'Missing' is not in fields, nameToValueMap['Missing'] is undefined.
        // evaluateFormula logic handles undefined vars usually as 0 or error.

        // However, let's verify runtime safety
        expect(item.parameter_config.computedValue).toBe('??');
    });

    it('resolves LENGTH_CALC formulas referencing a group (group value = Σ children, seed 示例状态包 scenario)', () => {
        // Mirrors backend/db/seed.py 示例状态包: [状态块](组 1+2+1=4B) + [帧尾](1B) → 05
        const statusMock = {
            fields: [
                { id: 'hdr', name: '帧头', op_code: 'HEX_RAW', sequence: 0, byte_len: 2 },
                { id: 'g', name: '状态块', op_code: 'ARRAY_GROUP', sequence: 1, byte_len: 0 },
                { id: 'mode', parent_id: 'g', name: '运行模式', op_code: 'MAPPING', sequence: 0, byte_len: 1 },
                { id: 'volt', parent_id: 'g', name: '母线电压', op_code: 'INT_UNSIGNED', sequence: 1, byte_len: 2 },
                { id: 'temp', parent_id: 'g', name: '模块温度', op_code: 'INT_UNSIGNED', sequence: 2, byte_len: 1 },
                { id: 'tail', name: '帧尾', op_code: 'HEX_RAW', sequence: 3, byte_len: 1 },
                {
                    id: 'len', name: '长度', op_code: 'LENGTH_CALC', sequence: 2, byte_len: 1,
                    parameter_config: { formula: '[状态块] + [帧尾]' },
                },
            ],
        };
        const { result } = renderHook(() => useInstructionLanes(statusMock, 'inst-status'));

        const root = result.current.processedLanes.find(l => l.parentId === null);
        const lenBlock = root.items.find(i => i.id === 'len');
        expect(lenBlock.parameter_config.computedValue).toBe('05'); // 4 + 1

        // P1: the group item itself carries its Σ extent as computedValue
        // (insurance for cards rendered without the offset-ruler prop).
        const groupBlock = root.items.find(i => i.id === 'g');
        expect(groupBlock.byte_len).toBe(0);
        expect(groupBlock.parameter_config.computedValue).toBe('4B');
    });

    it('keeps group-in-formula as ?? when the group total is undeterminable', () => {
        const brokenGroupMock = {
            fields: [
                { id: 'g', name: '组', op_code: 'ARRAY_GROUP', sequence: 0 },
                { id: 'mystery', parent_id: 'g', name: '未知子块', sequence: 0 }, // no byte_len
                {
                    id: 'len', op_code: 'LENGTH_CALC', sequence: 1, byte_len: 1,
                    parameter_config: { formula: '[组] + 1' },
                },
            ],
        };
        const { result } = renderHook(() => useInstructionLanes(brokenGroupMock, 'inst-x'));
        const root = result.current.processedLanes.find(l => l.parentId === null);
        const lenBlock = root.items.find(i => i.id === 'len');
        expect(lenBlock.parameter_config.computedValue).toBe('??');

        // Undeterminable group → its own injected display value is "??" too
        const groupBlock = root.items.find(i => i.id === 'g');
        expect(groupBlock.parameter_config.computedValue).toBe('??');
    });

    it('LENGTH_CALC with refs but no formula infers sum-of-refs (New Instruction 682 scenario)', () => {
        const refsOnlyMock = {
            fields: [
                { id: 'hex1', name: '原始Hex', op_code: 'HEX_RAW', sequence: 0, byte_len: 1, parameter_config: { hex: '00' } },
                { id: 'u1', name: '无符号整数', op_code: 'INT_UNSIGNED', sequence: 1, byte_len: 1, parameter_config: { bits: 8 } },
                { id: 's1', name: '有符号整数', op_code: 'INT_SIGNED', sequence: 2, byte_len: 2, parameter_config: { bits: 16 } },
                {
                    id: 'len', name: '长度计算', op_code: 'LENGTH_CALC', sequence: 3, byte_len: 1,
                    // legacy persisted state: refs + stale computedValue, no formula
                    parameter_config: { refs: ['hex1', 'u1', 's1'], computedValue: '??' },
                },
            ],
        };
        const { result } = renderHook(() => useInstructionLanes(refsOnlyMock, 'inst-682'));
        const root = result.current.processedLanes.find(l => l.parentId === null);
        const lenBlock = root.items.find(i => i.id === 'len');
        expect(lenBlock.parameter_config.computedValue).toBe('04'); // 1 + 1 + 2
    });

    it('refs-only LENGTH_CALC with a dangling ref stays ?? (honest unknown)', () => {
        const danglingMock = {
            fields: [
                {
                    id: 'len', name: '长度计算', op_code: 'LENGTH_CALC', sequence: 0, byte_len: 1,
                    parameter_config: { refs: ['ghost-id'] },
                },
            ],
        };
        const { result } = renderHook(() => useInstructionLanes(danglingMock, 'inst-dangle'));
        const root = result.current.processedLanes.find(l => l.parentId === null);
        const lenBlock = root.items.find(i => i.id === 'len');
        expect(lenBlock.parameter_config.computedValue).toBe('??');
    });
});
