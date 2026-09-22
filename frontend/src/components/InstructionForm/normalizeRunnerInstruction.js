// Normalizes a backend instruction into the render/form schema used by the
// dynamic send form (InstructionRunner).
// Extracted verbatim from InstructionRunner.jsx — logic unchanged.
// NOTE: this maps field schemas for rendering/inputs only; the actual hex
// encoding lives in utils/InstructionEncoder.js (keep both sides in sync
// with backend/core/orchestrator.py).

const processFields = (items) => {
    // 0. Pre-process: If items is a flat list with parent_id, build the tree first.
    let rootItems = items;
    const hasParentIds = items.some(i => i.parent_id);

    if (hasParentIds) {
        const map = {};
        items.forEach(i => map[i.id] = { ...i, fields: [] }); // Create clones with empty fields
        const roots = [];
        items.forEach(i => {
            if (i.parent_id && map[i.parent_id]) {
                map[i.parent_id].fields.push(map[i.id]);
            } else {
                roots.push(map[i.id]);
            }
        });
        rootItems = roots;
    }

    // Respect field ordering if provided (Backend uses 'sequence')
    const sortNodes = (nodes) => {
        nodes.sort((a, b) => (a.sequence ?? a.order ?? 0) - (b.sequence ?? b.order ?? 0));
        nodes.forEach(n => {
            if (n.fields && n.fields.length > 0) sortNodes(n.fields);
        });
        return nodes;
    };

    const sortedItems = sortNodes(rootItems);

    const mapToSchema = (nodes) => {
        return nodes.map(f => {
            // Recursive processing
            const processedChildren = f.fields && f.fields.length > 0 ? mapToSchema(f.fields) : [];

            if (f.op_code || f.parameter_config) {
                // Inherit or process
                const op = String(f.op_code || '').toUpperCase();
                const type = String(f.type || f.parameter_config?.type || '').toLowerCase();

                // Advanced Recognition: Length/Calculated
                // FIX: Explicitly include LENGTH_CALC and CHECKSUM_CRC
                const isCalculated = op === 'CALCULATED' || op === 'LENGTH_CALC' || op === 'CHECKSUM_CRC' || type === 'length' || type === 'calculated' || type === 'checksum';

                // Advanced Recognition: Inputs
                // FIX: Broaden Fixed detection. "Raw HEX" might be 'HEX' or just have a value.
                const hasFixedValue = (f.parameter_config?.hex || f.parameter_config?.value) !== undefined && !f.parameter_config?.variable;
                const isFixed = op === 'FIXED' || op === 'HEX_RAW' || op === 'HEX' || op === 'BITFIELD' || type === 'fixed' || type === 'hex_raw' || f.parameter_config?.readOnly || hasFixedValue;
                const isInput = !isCalculated && !isFixed;

                return {
                    id: f.id,
                    name: f.name || f.label,
                    op_code: (['LENGTH_CALC', 'CHECKSUM_CRC', 'HEX_RAW', 'BITFIELD', 'TIME_CUMULATIVE', 'TIME_ACCUMULATOR'].includes(op) || type === 'time_cumulative') ? (['LENGTH_CALC', 'CHECKSUM_CRC', 'HEX_RAW', 'BITFIELD'].includes(op) ? op : 'TIME_CUMULATIVE') : (isInput ? 'INPUT' : (isCalculated ? 'CALCULATED' : 'FIXED')),
                    original_op_code: f.op_code, // Preserve original for render logic fallback
                    bits: Array.isArray(f.bits) ? f.bits : [], // Bit layout for BITFIELD packing
                    parameter_config: {
                        hex: f.hex_value, // Legacy mapping support if needed, mostly in param_config now
                        ...f.parameter_config,
                        value: f.value ?? f.parameter_config?.value,
                        variable: isInput,
                        formula: type === 'length' ? 'auto' : (f.formula || f.parameter_config?.formula),
                        type: type.includes('float') || type.includes('decimal') ? 'decimal' : (type || 'number'),
                        unit: f.unit || f.parameter_config?.unit,
                        description: f.description || f.parameter_config?.description,
                        options: f.options || f.parameter_config?.options
                    },
                    byte_len: f.byte_length || f.byte_len || 1,
                    fields: processedChildren
                };
            }
            return f;
        });
    };

    return mapToSchema(sortedItems);
};

export const normalizeRunnerInstruction = (instruction) => {
    if (!instruction) return null;
    const fields = processFields(instruction.fields || instruction.blocks || []);
    return { ...instruction, fields };
};
