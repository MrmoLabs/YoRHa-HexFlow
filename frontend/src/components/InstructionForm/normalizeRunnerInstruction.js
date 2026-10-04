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
                // 第 14 单（N2 契约对齐）：STRING 的静态 value 是「初值」不是「静态
                // 载荷」—— 加工页初始值 = 静态 value 且可继续键入（pageStatus N2
                // 行），带值即判死会让 CMD-632 这类文本字段整行只读（真机坐实）。
                // 仅 TEXT 种类豁免；其余算子 value→FIXED 存量契约不动。
                const isStringField = op === 'STRING' || type === 'string';
                const hasFixedValue = !isStringField
                    && (f.parameter_config?.hex || f.parameter_config?.value) !== undefined
                    && !f.parameter_config?.variable;
                const isFixed = op === 'FIXED' || op === 'HEX_RAW' || op === 'HEX' || op === 'BITFIELD'
                    // R25: SCRAMBLE 的明文是**定义侧配置**（pc.hex），编码端直读它加扰
                    // 出线 —— 可编辑输入压根不进编码分支（「能改但无效」即欺骗，同
                    // 第 15 单 HEADER/TAIL 口径）；显空明文也要判死，否则 hasFixedValue
                    // 落空 → isInput → 变量字段被创建出来、键入无处生效。
                    || op === 'SCRAMBLE'
                    || type === 'fixed' || type === 'hex_raw' || f.parameter_config?.readOnly || hasFixedValue;
                const isInput = !isCalculated && !isFixed;

                // 第 14 单：种类算子身份保留 —— 可编辑时 FLOAT_IEEE/BCD_CODE/
                // INT_SIGNED/SCALED_DECIMAL/AUTO_COUNTER 原样进编码器：encode 的
                // f32/打包 BCD/两补码/定标/计数分支按 op 门控（InstructionEncoder
                // 行 173/205/302/318/340），摊平成 INPUT 即全部死亡（真机实锤：
                // FLOAT 3.14 → 00 00 00 03、BCD 1234 → 04 D2）。带静态 value
                // （isFixed）不保留 → 仍走 FIXED 存量语义；MAPPING/INT_UNSIGNED
                // 编码字节等价、TIME_* 手动选时刻覆盖语义、组结构 —— 维持摊平。
                const keepKindOp = isInput
                    && ['FLOAT_IEEE', 'BCD_CODE', 'INT_SIGNED', 'SCALED_DECIMAL', 'AUTO_COUNTER'].includes(op);
                return {
                    id: f.id,
                    name: f.name || f.label,
                    // R23: TIME_EPOCH 与 LENGTH_CALC/CHECKSUM 同列「保身份」——
                    // 编码分支按 op 门控（InstructionEncoder TIME_EPOCH 分支取
                    // 墙钟），摊平成 INPUT 即退回静态 value 路径 → 时间戳失效。
                    // R25: SCRAMBLE 同理且更凶 —— 摊平成 FIXED 后编码端读 params.hex
                    // **原样出线**（不加扰），明文直接上总线（内外表同加，改一必改二）。
                    op_code: (keepKindOp || ['LENGTH_CALC', 'CHECKSUM_CRC', 'HEX_RAW', 'BITFIELD', 'SCRAMBLE', 'TIME_CUMULATIVE', 'TIME_ACCUMULATOR', 'TIME_EPOCH'].includes(op) || type === 'time_cumulative') ? ((keepKindOp || ['LENGTH_CALC', 'CHECKSUM_CRC', 'HEX_RAW', 'BITFIELD', 'SCRAMBLE', 'TIME_EPOCH'].includes(op)) ? op : 'TIME_CUMULATIVE') : (isInput ? 'INPUT' : (isCalculated ? 'CALCULATED' : 'FIXED')),
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
