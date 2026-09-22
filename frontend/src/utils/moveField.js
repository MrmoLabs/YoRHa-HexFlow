// C1-d: pure field-move extracted verbatim from Instruction.jsx onMoveItem —
// splice a card into a (possibly different) parent lane and renumber that
// lane's siblings contiguously by display order.
//
// @param {Array<object>} fields currentInstruction.fields (flat parent_id tree)
// @param {string} itemId moved field id
// @param {string|null} newParentId target lane parent id (null = root lane)
// @param {number} newIndex insertion index WITHIN the sorted target lane
// @returns {Array<object>} new fields array — or the SAME reference when the
//   source field is missing (caller skips updateLocalInstruction, matching the
//   original early-return). Never mutates the input.
export function moveField(fields, itemId, newParentId, newIndex) {
    if (!Array.isArray(fields)) return fields;
    const allFields = [...fields];
    const itemIndex = allFields.findIndex((f) => f.id === itemId);
    if (itemIndex === -1) return fields; // 原样返回（源字段缺失）

    const item = { ...allFields[itemIndex] };
    allFields.splice(itemIndex, 1);

    const siblings = allFields
        .filter((f) => (f.parent_id || null) === newParentId)
        .sort((a, b) => a.sequence - b.sequence);
    siblings.splice(newIndex, 0, item);
    const updatedSiblings = siblings.map((sib, idx) => ({
        ...sib,
        parent_id: newParentId,
        sequence: idx,
    }));

    const finalFields = allFields.filter((f) => (f.parent_id || null) !== newParentId);
    finalFields.push(...updatedSiblings);
    return finalFields;
}
