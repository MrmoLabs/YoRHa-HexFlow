// 批次四 4b（DESIGN_CorePipeline §7 批次四 ②）：绑定矩阵 —— 指令 → 默认协议 → 槽位。
// 纯函数（DataHub 页「绑定矩阵」直用，utils/__tests__/bindingMatrix.test.js 锁形）。
//
// 口径：
// - 一行一条**指令**（含零绑定的指令 —— 覆盖率本身就是治理信息）；
// - `is_default` 行出「默认协议」格，其余进「其它绑定」；`is_default` 在 API 侧
//   序列化为布尔、DB 里是 0/1，故一律按真值判断；
// - **孤儿关系不静默抹平**（§6.2「不静默」口径的读侧延伸）：协议行缺失 →
//   `protocolMissing`；`slot_id` 在协议树里找不到 → `slotMissing`，交 UI 出琥珀徽标；
// - `stale` 只认 `true`（`false`/`null` 不亮徽标，与编排页/指令页两处同口径）。

const walk = (children, visit) => {
    for (const node of children || []) {
        if (!node) continue;
        visit(node);
        if (Array.isArray(node.children)) walk(node.children, visit);
    }
};

// 槽节点查找（与后端 routers/binding.find_slot_node 同形：仅认 type === 'slot'）
export const findSlotNode = (children, slotId) => {
    if (!slotId) return null;
    let found = null;
    walk(children, (node) => {
        if (!found && node.id === slotId && node.type === 'slot') found = node;
    });
    return found;
};

const cellFor = (binding, protocolMap) => {
    const protocol = protocolMap.get(binding.protocol_id) || null;
    const slotNode = protocol ? findSlotNode(protocol.children, binding.slot_id) : null;
    return {
        id: binding.id,
        label: binding.label,
        protocolId: binding.protocol_id,
        protocolLabel: protocol ? protocol.label : null,
        protocolMissing: !protocol,
        slotId: binding.slot_id || null,
        slotLabel: slotNode ? (slotNode.label || slotNode.id) : null,
        slotMissing: Boolean(binding.slot_id) && !slotNode,
        slotOrder: binding.slot_order ?? 0,
        stale: binding.stale === true
    };
};

const sortBindings = (list) => [...list].sort((a, b) => {
    const order = (a.slot_order ?? 0) - (b.slot_order ?? 0);
    return order !== 0 ? order : String(a.id).localeCompare(String(b.id));
});

export const buildBindingMatrix = (instructions, bindings, protocols) => {
    const protocolMap = new Map((protocols || []).map((p) => [p.id, p]));
    const byInstruction = new Map();
    for (const b of bindings || []) {
        const key = b.instruction_id;
        if (!byInstruction.has(key)) byInstruction.set(key, []);
        byInstruction.get(key).push(b);
    }

    const rows = (instructions || [])
        .map((inst) => {
            const mine = sortBindings(byInstruction.get(inst.id) || []);
            const defaults = mine.filter((b) => Boolean(b.is_default));
            return {
                id: inst.id,
                code: inst.code,
                name: inst.name,
                deviceCode: inst.device_code,
                defaultBinding: defaults.length ? cellFor(defaults[defaults.length - 1], protocolMap) : null,
                // 同指令多条默认（脏数据）也标出来：extraDefaults 交 UI 计数
                extraDefaults: Math.max(0, defaults.length - 1),
                others: mine
                    .filter((b) => !b.is_default)
                    .map((b) => cellFor(b, protocolMap))
            };
        })
        .sort((a, b) => {
            const dev = String(a.deviceCode || '').localeCompare(String(b.deviceCode || ''));
            if (dev !== 0) return dev;
            const code = String(a.code || '').localeCompare(String(b.code || ''));
            if (code !== 0) return code;
            return String(a.id).localeCompare(String(b.id));
        });

    const allCells = rows.flatMap((r) => (r.defaultBinding ? [r.defaultBinding, ...r.others] : r.others));
    return {
        rows,
        summary: {
            instructions: rows.length,
            bindings: allCells.length,
            withDefault: rows.filter((r) => r.defaultBinding).length,
            unbound: rows.filter((r) => !r.defaultBinding && r.others.length === 0).length,
            danglingSlots: allCells.filter((c) => c.slotMissing).length,
            missingProtocols: allCells.filter((c) => c.protocolMissing).length,
            staleBindings: allCells.filter((c) => c.stale).length,
            extraDefaults: rows.reduce((n, r) => n + r.extraDefaults, 0)
        }
    };
};

// 槽位格文案：显式槽 → 槽标签 / 悬空；无显式槽 → 按序位次；无绑定 → '—'
export const slotCellText = (cell) => {
    if (!cell) return '—';
    if (cell.slotId) return cell.slotMissing ? `悬空 ${cell.slotId}` : (cell.slotLabel || cell.slotId);
    return `按序 ${cell.slotOrder}`;
};

export const protocolCellText = (cell) => {
    if (!cell) return '—';
    if (cell.protocolMissing) return `（协议已删）${cell.protocolId}`;
    return cell.protocolLabel || cell.protocolId;
};
