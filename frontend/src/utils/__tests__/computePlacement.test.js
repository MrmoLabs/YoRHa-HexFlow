import { describe, it, expect } from 'vitest';
import { computeFinalPlacement } from '../computePlacement';

// Minimal lane fixtures mirroring Canvas localLanes shape.
const lane = (parentId, ids) => ({ parentId, items: ids.map(id => ({ id })) });

const makeLanes = () => [
    lane(null, ['a', 'b', 'c']),   // lane-container-0
    lane(null, ['x', 'y']),        // lane-container-1
    lane('grp-1', ['k']),          // lane-container-2 (child lane)
];

describe('computeFinalPlacement (P4-4 落点推导四分支)', () => {
    it('branch 1 — same lane, over = card → over index (arrayMove semantics)', () => {
        const lanes = makeLanes();
        // drag 'a' onto 'c': insert-after-remove at overIdx
        expect(computeFinalPlacement(lanes, 'a', 'c')).toEqual({ parentId: null, index: 2 });
        // drag 'c' onto 'a': lands at over's index
        expect(computeFinalPlacement(lanes, 'c', 'a')).toEqual({ parentId: null, index: 0 });
    });

    it('branch 2 — same lane, over = lane background → end of that lane', () => {
        const lanes = makeLanes();
        expect(computeFinalPlacement(lanes, 'a', 'lane-container-0'))
            .toEqual({ parentId: null, index: 2 }); // items.length - 1
        // child lane background keeps the child parentId
        expect(computeFinalPlacement(lanes, 'k', 'lane-container-2'))
            .toEqual({ parentId: 'grp-1', index: 0 });
    });

    it('branch 3 — cross lane (item already spliced into target lane) → parentId follows ACTIVE lane', () => {
        // mid-drag cross-lane preview moved 'z' into lane 0 ahead of the drop:
        const lanes = [
            lane(null, ['z', 'a', 'b', 'c']),
            lane(null, ['x', 'y']),
        ];
        const result = computeFinalPlacement(lanes, 'z', 'b');
        expect(result).toEqual({ parentId: null, index: 2 }); // over's index in ACTIVE's lane
        expect(result.parentId).toBe(lanes[0].parentId); // NOT lane 1's parent
    });

    it('branch 4 — unresolvable over → no-op move at the current position', () => {
        const lanes = makeLanes();
        // unknown card id (not in any lane)
        expect(computeFinalPlacement(lanes, 'b', 'ghost')).toEqual({ parentId: null, index: 1 });
        // out-of-range lane container → same no-op fallback
        expect(computeFinalPlacement(lanes, 'b', 'lane-container-9')).toEqual({ parentId: null, index: 1 });
        // over resolves to a DIFFERENT lane than active's (transient state)
        expect(computeFinalPlacement(lanes, 'a', 'x')).toEqual({ parentId: null, index: 0 });
    });

    it('released outside any droppable / unknown active → null', () => {
        const lanes = makeLanes();
        expect(computeFinalPlacement(lanes, 'a', null)).toBeNull();
        expect(computeFinalPlacement(lanes, 'a', undefined)).toBeNull();
        expect(computeFinalPlacement(lanes, 'ghost', 'b')).toBeNull();
    });

    it('child-lane moves carry the child parentId', () => {
        const lanes = makeLanes();
        expect(computeFinalPlacement(lanes, 'k', 'lane-container-2'))
            .toEqual({ parentId: 'grp-1', index: 0 });
    });
});
