// Maps frontend blocks to the backend FrameRequest block schema for
// POST /export/binary (Orchestrator compile).
// Extracted verbatim from pages/Orchestration.jsx (logic unchanged).
//
// Backend Block schema requires id/type/label/byte_length; frontend blocks
// carry byte_len/op_code/name, so map them explicitly before posting.
export const toFrameBlocks = (nodes) => (nodes || []).map(node => {
    const children = node.children?.length ? toFrameBlocks(node.children) : [];
    const opCode = String(node.op_code || '').toUpperCase();
    let type = node.type;
    if (!type) {
        if (opCode === 'LENGTH_CALC') type = 'length';
        else if (opCode === 'CHECKSUM_CRC') type = 'checksum';
        else if (opCode === 'ARRAY_GROUP' || children.length) type = 'container';
        else type = 'fixed';
    }
    const byteLength = Number.isFinite(node.byte_length)
        ? node.byte_length
        : (Number.isFinite(node.byte_len) ? node.byte_len : 0);

    return {
        id: String(node.id),
        type: String(type),
        label: String(node.label || node.name || node.id),
        byte_length: byteLength,
        hex_value: node.hex_value || node.parameter_config?.hex || null,
        config: node.config || null,
        children,
        is_container: Boolean(node.is_container) || children.length > 0,
        is_enabled: node.is_enabled !== false
    };
});
