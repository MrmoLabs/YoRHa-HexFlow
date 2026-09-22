// C1-c: pure drop-hint SIDE derivation extracted from Canvas.handleDragOver —
// which edge of the hovered card the 2px amber insertion line sits on.
// The dragged card lands on over's RIGHT when it currently sits BEFORE it
// (arrayMove preview order), LEFT otherwise.
//
// @param {Array<{id: string>}|null|undefined} items cards of the hovered (over) lane
// @param {string} activeId dragged card id
// @param {string} overId hovered card id
// @returns {'right'|'left'|null} 'right' before over / 'left' after over /
//   'left' when either id is missing (default) / null on self-over (clear hint)
export function computeInsertionSide(items, activeId, overId) {
    if (activeId === overId) return null;
    if (!Array.isArray(items)) return 'left';
    const aIdx = items.findIndex((i) => i.id === activeId);
    const oIdx = items.findIndex((i) => i.id === overId);
    if (aIdx === -1 || oIdx === -1) return 'left';
    return aIdx < oIdx ? 'right' : 'left';
}
