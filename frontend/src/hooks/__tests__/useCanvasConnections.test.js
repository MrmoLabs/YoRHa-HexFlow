import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCanvasConnections } from '../useCanvasConnections';

describe('useCanvasConnections', () => {
    // Mock DOM elements
    const mockContentRef = { current: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000, bottom: 1000 }) } };

    // Helper to mock element rects
    const mockRects = {
        'block-1': { left: 100, top: 100, width: 50, height: 50, bottom: 150 },
        'block-2': { left: 300, top: 300, width: 50, height: 50, bottom: 350 }, // Target Logic
        'lane-0': { left: 50, top: 200, width: 200, height: 200, bottom: 400 },   // Lane
        'block-p1': { left: 100, top: 50, width: 50, height: 50, bottom: 100 }    // Parent
    };

    const originalGetElementById = document.getElementById;

    beforeEach(() => {
        // Mock document.getElementById
        document.getElementById = vi.fn((id) => {
            if (mockRects[id]) {
                return {
                    getBoundingClientRect: () => mockRects[id]
                };
            }
            return null;
        });

        // Use fake timers to trigger the setTimeout logic in hook
        vi.useFakeTimers();
    });

    afterEach(() => {
        document.getElementById = originalGetElementById;
        vi.useRealTimers();
    });

    it('should calculate LOGIC paths when in picking mode', () => {
        const lanes = [
            { items: [{ id: '1', parameter_config: { refs: [] } }] }
        ];

        // Setup: Selected Source = block-1, Target = block-2
        // pickingMode.currentRefs = ['block-2'] (simulating ID)
        // But hook logic expects IDs.

        const { result } = renderHook(() =>
            useCanvasConnections(lanes, '1', { isActive: true, currentRefs: ['2'] }, mockContentRef)
        );

        // Advance timer
        act(() => {
            vi.runAllTimers();
        });

        // 1 (100,100) -> 2 (300,300)
        // Hook logic: logicPaths.push...
        // Source element: block-1
        // Target element: block-2 (from currentRefs)

        // Assert
        expect(result.current.connectionPaths).toHaveLength(1);
        expect(result.current.connectionPaths[0].id).toBe('2');
        expect(result.current.connectionPaths[0].d).toContain('M'); // Should be a path string
    });

    it('should calculate HIERARCHY paths', () => {
        // Setup: Lane 0 has parentId 'p1'.
        // block-p1 is at 100,50.
        // lane-0 is at 50,200.
        const lanes = [{ parentId: 'p1', items: [] }];

        const { result } = renderHook(() =>
            useCanvasConnections(lanes, null, null, mockContentRef)
        );

        act(() => {
            vi.runAllTimers();
        });

        expect(result.current.hierarchyLines).toHaveLength(1);
        expect(result.current.hierarchyLines[0].id).toBe('link-p1');

        // Check Path Logic roughly
        // Start: Parent Bottom Center -> (100 + 25, 100) = (125, 100)
        // End: Lane Left + 20 -> (50 + 20, 200) = (70, 200)
        const d = result.current.hierarchyLines[0].d;
        expect(d).toContain('M 125 100');
    });
});
