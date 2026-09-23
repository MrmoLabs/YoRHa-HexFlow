// Pure tree helpers for the Protocol editor page.
// Extracted verbatim from pages/Protocol.jsx (logic unchanged).
// A+B 批：内联展开泳道 / 跨容器移动 / 偏移标尺适配 —— 对标指令页
// useInstructionLanes（buildLanes+expandedGroupIds+焦点自愈）与 moveField
// （splice 口径），全部纯函数、children 树上操作、不落库。

import { computeByteOffsets } from './byteOffsets';
import { isNestable } from '../config/blockTypes';

export const serializeProtocol = (protocol) => JSON.stringify({
    label: protocol?.label || '',
    type: protocol?.type || 'container',
    description: protocol?.description || null,
    children: protocol?.children || []
});

export const findNode = (root, id) => {
    if (!root || !id) return null;
    if (root.id === id) return root;
    if (!root.children) return null;

    for (const child of root.children) {
        const found = findNode(child, id);
        if (found) return found;
    }

    return null;
};

// children 树 → computeByteOffsets 的扁平适配：容器打 ARRAY_GROUP 标（仅适配
// 层，不落库）以复用已测的组尺寸与空组 size=0 语义（isGroupOp 分支——协议容器
// 无 op_code，不打标的话空容器会被当 byte_length=0 的叶子判成未知尺寸并污染
// 后续偏移）；叶子直传 byte_length（resolveSize 读 byte_len ?? byte_length）。
export const computeProtocolOffsets = (protocol) => {
    if (!protocol) return { byId: new Map(), total: 0, exact: true, variable: false };
    const fields = [];
    const walk = (nodes, parentId) => {
        (nodes || []).forEach((node, index) => {
            const kids = node.children || [];
            const isContainer = isNestable(node.type) || kids.length > 0;
            fields.push({
                ...node,
                ...(isContainer ? { op_code: node.op_code || 'ARRAY_GROUP' } : {}),
                parent_id: parentId,
                sequence: index
            });
            if (kids.length) walk(kids, node.id);
        });
    };
    walk(protocol.children, null);
    return computeByteOffsets({ fields });
};

// useInstructionLanes.buildLanes 的 children 树版：只对 expandedIds 下钻，
// DFS 序推 lane —— Canvas.RenderLaneNode 按 parentId 挂子泳道、画层级连线。
export const buildProtocolLanes = (protocol, expandedIds) => {
    if (!protocol) return [];
    const lanes = [];
    const expanded = new Set(expandedIds || []);
    const walk = (nodes, parentId, parentName, depth) => {
        lanes.push({ depth, parentId, parentName, items: nodes || [] });
        (nodes || []).forEach(node => {
            if (isNestable(node.type) && expanded.has(node.id)) {
                walk(node.children || [], node.id, node.label || 'GROUP', depth + 1);
            }
        });
    };
    walk(protocol.children || [], null, protocol.label || 'ROOT SEQUENCE', 0);
    return lanes;
};

// moveField 的树版 + 环守卫：树模型下环 = findNode/buildLanes 栈溢出冻结
// （扁平 parent_id 模型只是块不可见），协议侧必须拒收。落点语义对齐
// computeFinalPlacement：newParentId null=根泳道、index=目标层显示序（先摘
// 后插 = arrayMove）。源缺失 / 目标是自身或子孙 / 目标非容器 → 原引用早退
// （调用方跳过持久化，同 moveField 口径）。
export const moveNode = (root, itemId, newParentId, index) => {
    if (!root) return root;
    const item = findNode(root, itemId);
    if (!item) return root;
    if (newParentId != null) {
        if (newParentId === itemId) return root;
        if (findNode(item, newParentId)) return root; // 目标在自己子树内 → 成环
        const target = findNode(root, newParentId);
        if (!target || !isNestable(target.type)) return root;
    }

    let moved = null;
    const detach = (nodes) => nodes
        .map(node => {
            if (node.id === itemId) { moved = node; return null; }
            if (node.children?.length) return { ...node, children: detach(node.children) };
            return node;
        })
        .filter(Boolean);
    const remaining = detach(root.children || []);
    if (!moved) return root;

    const insert = (nodes) => {
        const arr = [...nodes];
        const at = Math.max(0, Math.min(index ?? arr.length, arr.length));
        arr.splice(at, 0, moved);
        return arr;
    };
    if (newParentId == null) return { ...root, children: insert(remaining) };

    const rebuild = (nodes) => nodes.map(node => node.id === newParentId
        ? { ...node, children: insert(node.children || []) }
        : (node.children?.length ? { ...node, children: rebuild(node.children) } : node));
    return { ...root, children: rebuild(remaining) };
};

// 树剪枝 = 子树整体移除（对齐指令页 flat 模型手写级联删除的最终效果）。
export const removeNode = (root, id) => {
    if (!root) return root;
    const strip = (nodes) => nodes
        .filter(node => node.id !== id)
        .map(node => node.children?.length ? { ...node, children: strip(node.children) } : node);
    return { ...root, children: strip(root.children || []) };
};

export const updateNode = (root, id, updates) => {
    if (!root) return root;
    const patch = (node) => node.id === id
        ? { ...node, ...updates }
        : (node.children?.length ? { ...node, children: node.children.map(patch) } : node);
    return patch(root);
};

// 切协议默认全展开（镜像 useInstructionLanes:50-53 的 groupIds 全量）。
export const collectContainerIds = (root) => {
    const ids = [];
    const walk = (nodes) => (nodes || []).forEach(node => {
        if (isNestable(node.type)) { ids.push(node.id); walk(node.children); }
    });
    walk(root?.children);
    return ids;
};
