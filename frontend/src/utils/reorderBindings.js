// ── R4 · 编排页组内换位（拖拽 / 洞位下拉共用）── PLAN §8.41 ────────────────
// 侧栏展示序 = (协议序, 洞号) 派生（见 Orchestration.sortedBindings），所以**本地改
// slot_order 就是「改展示序」**；真正落库只由「保存更改 (SAVE)」逐行 PUT 完成（复用
// 反馈 #4 的手动保存脏行模型，零 BE 改动 —— slot_order 本来就是 PUT 载荷字段）。
//
// 三条口径钉在这里，避免拖拽和下拉各写一遍：
//  ① 组 = 同 protocolId 的绑定。洞号是**组内**稠密位次，跨协议比大小没有意义；
//  ② 拖到别的协议组直接忽略（返回 null），不猜「要不要顺带换协议」；
//  ③ 结果必然是 0..n-1 稠密重编号，且只回写**真变化**的行（没动的行不标脏、
//     不进 PUT 队列）。
//
// 下拉传的是「在去掉自己后的组里插到第几位」，拖拽传的是「over 行在原组里的
// 位次」——两者数值相同（删掉自己只会让 over 之前的元素整体前移一位，而 without
// 同样少了自己），故共用一个实现。

const slotOf = (b) => b.slotOrder ?? 0;

const sortedGroup = (bindings, moved) =>
    bindings
        .filter((b) => b.protocolId === moved.protocolId)
        .slice()
        .sort((a, b) => slotOf(a) - slotOf(b));

/**
 * 把 movedId 这一行移动到「去掉自己后的组内」第 targetIndex 位，并稠密重编号。
 * @returns {{byId: Map<string, object>, changedIds: string[], reordered: object[]} | null}
 */
export function moveBindingToIndex(bindings, movedId, targetIndex) {
    const moved = bindings.find((b) => b.id === movedId);
    if (!moved) return null;

    const group = sortedGroup(bindings, moved);
    const without = group.filter((b) => b.id !== movedId);
    const raw = Number(targetIndex);
    const at = Number.isFinite(raw)
        ? Math.max(0, Math.min(raw, without.length))
        : without.length;

    const reordered = [...without.slice(0, at), moved, ...without.slice(at)]
        .map((b, i) => ({ ...b, slotOrder: i }));
    const byId = new Map(reordered.map((b) => [b.id, b]));
    const changedIds = group
        .filter((before) => slotOf(byId.get(before.id)) !== slotOf(before))
        .map((before) => before.id);

    return { byId, changedIds, reordered };
}

/**
 * 拖拽口径：把 movedId 拖到 overId 所在位置。跨协议组 / 找不到行 → null（调用方原样不动）。
 */
export function reorderBindingsWithinGroup(bindings, movedId, overId) {
    if (!movedId || !overId || movedId === overId) return null;
    const moved = bindings.find((b) => b.id === movedId);
    const over = bindings.find((b) => b.id === overId);
    if (!moved || !over) return null;
    if (moved.protocolId !== over.protocolId) return null;

    const at = sortedGroup(bindings, moved).findIndex((b) => b.id === overId);
    if (at === -1) return null;
    return moveBindingToIndex(bindings, movedId, at);
}
