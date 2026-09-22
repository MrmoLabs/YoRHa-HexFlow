// Field/instruction payload normalization — the single place where frontend
// payloads are coerced into the backend instruction schema before save.
// Extracted verbatim from hooks/useInstructionData.js (logic unchanged);
// hooks/useInstructionData.js re-exports these for existing consumers.
// NOTE: field naming convention: instructions fields use `byte_len`,
// block structures use `byte_length` (see PROJECT_HANDOVER.md §7).

// B1 (checksum convergence): maps legacy/template algo names onto the exact
// enum implemented by frontend ChecksumAlgo (formula.js) — the encoder reads
// parameter_config.algorithm. Unknown / CRC_32 (no implementation) fall back
// to CRC_16_MODBUS, which is what the encoder has always effectively computed.
export const mapChecksumAlgo = (algo) => {
    const v = String(algo || '').trim();
    if (v === 'SUM_8' || v === 'XOR_8' || v === 'CRC_16_MODBUS') return v;
    if (v === 'XOR_SUM') return 'XOR_8';
    if (v === 'ADD_SUM') return 'SUM_8';
    return 'CRC_16_MODBUS'; // CRC16_CCITT / CRC32 / unknown / empty
};

// B1: alias algo -> algorithm (the key the encoder reads) at payload level so
// even blocks that never pass through the properties panel persist the alias.
const aliasChecksumAlgo = (field) => {
    const pc = field.parameter_config;
    if (pc && typeof pc === 'object' && pc.algorithm === undefined && pc.algo !== undefined) {
        return { ...field, parameter_config: { ...pc, algorithm: mapChecksumAlgo(pc.algo) } };
    }
    return field;
};

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
        ? instruction.fields.map((field, index) => normalizeFieldPayload(aliasChecksumAlgo(field), index))
        : []
});
