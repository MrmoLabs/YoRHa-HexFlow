// Field/instruction payload normalization — the single place where frontend
// payloads are coerced into the backend instruction schema before save.
// Extracted verbatim from hooks/useInstructionData.js (logic unchanged);
// hooks/useInstructionData.js re-exports these for existing consumers.
// NOTE: field naming convention: instructions fields use `byte_len`,
// block structures use `byte_length` (see PROJECT_HANDOVER.md §7).

export const normalizeFieldPayload = (field, fallbackSequence = 0) => ({
    id: field.id,
    parent_id: field.parent_id || null,
    sequence: Number.isFinite(field.sequence) ? field.sequence : fallbackSequence,
    name: String(field.name || field.label || field.op_code || 'UNNAMED'),
    op_code: String(field.op_code || 'HEX_RAW'),
    byte_len: Number.isFinite(field.byte_len) ? field.byte_len : (Number.isFinite(field.byte_length) ? field.byte_length : 0),
    endianness: field.endianness === 'LITTLE' ? 'LITTLE' : 'BIG',
    repeat_type: ['NONE', 'FIXED', 'DYNAMIC'].includes(field.repeat_type) ? field.repeat_type : 'NONE',
    repeat_ref_id: field.repeat_ref_id || null,
    repeat_count: Number.isFinite(field.repeat_count) ? field.repeat_count : 1,
    parameter_config: field.parameter_config && typeof field.parameter_config === 'object'
        ? Object.fromEntries(
            Object.entries(field.parameter_config).filter(([, value]) => value !== undefined)
        )
        : {},
    // Bit-level layout for BITFIELD fields: [{ id, bit_name, start_bit, bit_len, default_val }]
    bits: Array.isArray(field.bits)
        ? field.bits.map((bit, index) => ({
            id: bit.id,
            sequence: Number.isFinite(bit.sequence) ? bit.sequence : index,
            bit_name: String(bit.bit_name || bit.name || 'BIT'),
            start_bit: Number.isFinite(bit.start_bit) ? bit.start_bit : 0,
            bit_len: Number.isFinite(bit.bit_len) ? bit.bit_len : 1,
            default_val: Number.isFinite(bit.default_val) ? bit.default_val : 0
        }))
        : [],
    children: []
});

export const normalizeInstructionPayload = (instruction) => ({
    device_code: String(instruction.device_code || '').trim(),
    code: String(instruction.code || '').trim(),
    name: String(instruction.name || instruction.label || '').trim(),
    description: instruction.description ?? null,
    type: ['STATIC', 'DYNAMIC'].includes(instruction.type) ? instruction.type : 'STATIC',
    fields: Array.isArray(instruction.fields)
        ? instruction.fields.map((field, index) => normalizeFieldPayload(field, index))
        : []
});
