// Pure tree helpers for the Protocol editor page.
// Extracted verbatim from pages/Protocol.jsx (logic unchanged).

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
