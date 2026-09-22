// P4-4: pure drop-placement derivation extracted from Canvas.handleDragEnd —
// the exact semantics the drag preview shows, now unit-testable (4 branches):
//   1. same lane, over = card      → over's index (arrayMove semantics)
//   2. same lane, over = background → end of the lane (items.length - 1)
//   3. cross lane (item already spliced into the target lane mid-drag,
//      over resolves there)         → parentId follows the lane containing ACTIVE
//   4. unresolvable over (gap release, unknown id, out-of-range container)
//      → no-op move at the item's CURRENT index (order stays stable)
// over = null → null (released outside any droppable; caller resets preview).
//
// @param {Array<{parentId: string|null, items: Array<{id: string}>}>} lanes
// @param {string} activeId dragged item id
// @param {string|null} overId droppable id (card id or 'lane-container-N')
// @returns {{parentId: string|null, index: number}|null}
export function computeFinalPlacement(lanes, activeId, overId) {
    if (overId === null || overId === undefined) return null;

    const activeLaneIdx = lanes.findIndex(l => l.items.some(i => i.id === activeId));
    if (activeLaneIdx === -1) return null;
    const activeLane = lanes[activeLaneIdx];

    // Which lane does `over` point at? (-1 = unresolvable)
    let overLaneIdx = -1;
    const overStr = String(overId);
    if (overStr.startsWith('lane-container-')) {
        const idx = parseInt(overStr.split('-')[2], 10);
        overLaneIdx = Number.isNaN(idx) ? -1 : idx;
    } else {
        overLaneIdx = lanes.findIndex(l => l.items.some(i => i.id === overId));
    }

    let finalIndex;
    if (overLaneIdx === activeLaneIdx) {
        // Same lane (incl. post cross-lane splice): derive from `over` with
        // arrayMove semantics — insert-after-remove at `overIdx` reproduces
        // exactly what the strategy preview shows on screen.
        if (overStr.startsWith('lane-container-')) {
            finalIndex = activeLane.items.length - 1; // lane background → end
        } else {
            finalIndex = activeLane.items.findIndex(i => i.id === overId);
        }
    } else {
        // Transient/unresolvable `over` (e.g. released mid-gap between lanes):
        // trust the current physical position — a no-op move keeps order stable.
        finalIndex = activeLane.items.findIndex(i => i.id === activeId);
    }

    if (finalIndex < 0) return null;
    return { parentId: activeLane.parentId, index: finalIndex };
}
