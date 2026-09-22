// Pure merge/lane helpers for the Orchestration page.
// Extracted verbatim from pages/Orchestration.jsx (logic unchanged).

const normalizeInstructionBlocks = (instruction) => {
    const blocks = instruction?.blocks;
    if (blocks?.length) return blocks;

    const fields = instruction?.fields || [];
    const fieldMap = new Map(fields.map(field => [field.id, { ...field, label: field.label || field.name, children: [] }]));
    const roots = [];

    fieldMap.forEach(field => {
        if (field.parent_id && fieldMap.has(field.parent_id)) {
            fieldMap.get(field.parent_id).children.push(field);
        } else {
            roots.push(field);
        }
    });

    return roots.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
};

// Deep Clone to avoid mutating original AND Prefix IDs to avoid collisions
const cloneBlocks = (blocks, prefix) => {
    return blocks.map(b => {
        const newBlock = { ...b, id: `${prefix}-${b.id}` };
        if (newBlock.children) {
            newBlock.children = cloneBlocks(newBlock.children, prefix);
        }
        return newBlock;
    });
};

// MERGE LOGIC: Combine Protocol + Instruction
// Logic: Find the FIRST 'slot' block and inject instruction blocks.
// If no slot found, append to the end of the root container (fallback).
export const mergeProtocolInstruction = (protocol, instruction) => {
    if (!protocol) return [];

    // Deep Clone to avoid mutating original AND Prefix IDs to avoid collisions
    const mergedRoot = { ...protocol };
    if (mergedRoot.children) {
        mergedRoot.children = cloneBlocks(mergedRoot.children, 'p');
    }

    if (instruction) {
        const instructionBlocks = cloneBlocks(normalizeInstructionBlocks(instruction), 'i');

        const injectIntoSlot = (nodes) => {
            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].type === 'slot') {
                    // FOUND SLOT: Replace with instruction blocks
                    // Mark them as "Injected" for styling if needed
                    const injected = instructionBlocks.map(ib => ({ ...ib, isInjected: true }));
                    nodes.splice(i, 1, ...injected);
                    return true; // Stop after first slot filled
                }
                if (nodes[i].children) {
                    if (injectIntoSlot(nodes[i].children)) return true;
                }
            }
            return false;
        };

        const injected = injectIntoSlot(mergedRoot.children || []);

        if (!injected && mergedRoot.children) {
            // Fallback: Append if no slot
            const injected = instructionBlocks.map(ib => ({ ...ib, isInjected: true }));
            mergedRoot.children.push(...injected);
        }
    }

    return mergedRoot.children || [];
};

export const buildLanes = (nodes, parentId = null, parentName = 'ROOT SEQUENCE', depth = 0) => {
    const lanes = [{
        depth,
        parentId,
        parentName,
        items: nodes || []
    }];

    (nodes || []).forEach(node => {
        if (node.children?.length) {
            lanes.push(...buildLanes(node.children, node.id, node.label || node.name || 'GROUP CONTENT', depth + 1));
        }
    });

    return lanes;
};

export const getTotalBytes = (blocks) => {
    let total = 0;
    blocks.forEach(b => {
        // Leaf = node without child nodes. `children: []` (which
        // normalizeInstructionBlocks attaches to every field) is NOT a
        // container — counting it as one recursed into nothing and dropped
        // the whole payload from the displayed total.
        if (b.children?.length) total += getTotalBytes(b.children);
        else total += (b.byte_length || 0);
    });
    return total;
};
