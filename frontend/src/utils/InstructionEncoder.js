import { evaluateFormula, formatToHex, formatFloatToHex, calculateChecksum, ChecksumAlgo } from './formula';

/**
 * Core Logic for the Instruction Processing Engine.
 * Decouples "Byte Generation" from "UI Rendering".
 */
export const InstructionEncoder = {
    /**
     * Helper to flatten nested fields/blocks for linear encoding.
     * MODIFIED: Now optionally keeps parent containers for reference, 
     * but we usually want a list of *everything* to build the symbol table.
     */
    flattenAll: function (items) {
        let flat = [];
        if (!items) return flat;
        const sortedItems = [...items].sort((a, b) => (a.sequence ?? a.order ?? 0) - (b.sequence ?? b.order ?? 0));

        sortedItems.forEach(item => {
            flat.push(item);
            if (item.fields || item.blocks || item.children) {
                flat = flat.concat(this.flattenAll(item.fields || item.blocks || item.children));
            }
        });
        return flat;
    },

    /**
     * Generates the initial user input state based on default values.
     */
    getInitialValues: function (instruction) {
        const initialInputs = {};
        if (!instruction) return initialInputs;

        const rawFields = instruction.fields || instruction.blocks || [];
        const allFields = this.flattenAll(rawFields);

        allFields.forEach(field => {
            const params = field.parameter_config || {};
            const op = String(field.op_code || '').toUpperCase();
            const type = String(params.type || '').toLowerCase();
            const isInput = op === 'INPUT' || params.variable;

            if (isInput) {
                if (params.default !== undefined) {
                    initialInputs[field.id] = params.default;
                } else if (params.options) {
                    // Enum Default: First option's value
                    const opts = params.options;
                    if (Array.isArray(opts) && opts.length > 0) {
                        const first = opts[0];
                        let val = typeof first === 'object' ? first.value : first;
                        // HEX String to Number auto-conversion for consistency
                        if (typeof val === 'string' && /^[0-9A-Fa-f]+$/.test(val)) {
                            val = parseInt(val, 16);
                        }
                        initialInputs[field.id] = val;
                    } else if (typeof opts === 'object' && Object.keys(opts).length > 0) {
                        let val = Object.values(opts)[0];
                        if (typeof val === 'string' && /^[0-9A-Fa-f]+$/.test(val)) {
                            val = parseInt(val, 16);
                        }
                        initialInputs[field.id] = val;
                    } else {
                        initialInputs[field.id] = 0;
                    }
                } else if (type === 'string' || type === 'text') {
                    initialInputs[field.id] = '';
                } else {
                    initialInputs[field.id] = 0;
                }
            }
        });
        return initialInputs;
    },

    /**
     * Helper to get byte data for a specific field based on current value and params.
     * Supports RECURSIVE generation for Groups.
     */
    getFieldBytes: function (field, inputs, computedValues, allFields) {
        const params = field.parameter_config || {};
        const byteLen = field.byte_len || 1;
        const op = field.op_code;

        // 0. Groups / Arrays (Recursive)
        // If it has children, its bytes are the sum of its children
        if (field.fields && field.fields.length > 0) {
            let groupBytes = [];
            // Sort children
            const children = [...field.fields].sort((a, b) => (a.sequence ?? a.order ?? 0) - (b.sequence ?? b.order ?? 0));
            children.forEach(child => {
                const childBytes = this.getFieldBytes(child, inputs, computedValues, allFields);
                groupBytes = groupBytes.concat(childBytes);
            });
            return groupBytes;
        }

        // LEAF NODES logic
        const inputValue = inputs[field.id];
        const computedVal = computedValues[field.id];
        // Priority: Computed > Input > Fixed
        // EXCEPT for HEX_RAW where 'hex' param might be the "value" even if input is undefined

        let value = 0;
        if (computedVal !== undefined) value = computedVal;
        else if (inputValue !== undefined) value = inputValue;
        else if (params.hex && (op === 'FIXED' || op === 'HEADER' || op === 'TAIL')) return this.parseHexBytes(params.hex);
        else if (op === 'HEX_RAW' && params.hex) return this.parseHexBytes(params.hex); // Raw Hex string
        else value = params.value || 0;

        // 1. Strings
        if (params.type === 'string') {
            const str = String(value || '');
            const bytes = [];
            for (let i = 0; i < str.length; i++) {
                bytes.push(str.charCodeAt(i));
            }
            return bytes;
        }
        // 2. Float/Decimal
        if (params.type === 'float' || params.type === 'decimal') {
            const farr = new Float32Array(1);
            farr[0] = value || 0;
            const barr = new Uint8Array(farr.buffer);
            return Array.from(barr).reverse();
        }
        // 3. HEX_RAW (Input driven)
        if (op === 'HEX_RAW' || params.type === 'hex') {
            if (typeof value === 'string') return this.parseHexBytes(value);
            // Number fallthrough
        }

        // 3.5 BITFIELD: pack sub-bits -> integer -> fixed-width bytes
        if (op === 'BITFIELD') {
            let packed;
            if (inputValue !== undefined || computedVal !== undefined) {
                // Runtime input/computed value overrides static bit defaults
                packed = Math.floor(Number(value) || 0);
            } else {
                packed = 0;
                const subBits = Array.isArray(field.bits) ? field.bits : [];
                subBits.forEach(bit => {
                    const start = Number.isFinite(bit.start_bit) ? bit.start_bit : 0;
                    const len = Math.max(1, Number.isFinite(bit.bit_len) ? bit.bit_len : 1);
                    const mask = len >= 32 ? 0xFFFFFFFF : ((1 << len) - 1);
                    const raw = Number.isFinite(bit.default_val) ? bit.default_val : 0;
                    packed |= (raw & mask) << start; // JS bitwise is 32-bit; fields <= 32 bits are the common case
                });
            }
            // Treat packed result as unsigned
            packed = packed >>> 0;
            const hexStr = packed.toString(16).toUpperCase();
            const target = byteLen * 2;
            return this.parseHexBytes(hexStr.padStart(target, '0').slice(-target));
        }

        // 4. Standard Integers
        // Handle negative? standard hex conversion usually implies unsigned unless specified
        if (byteLen === 0) return [];

        const hex = Math.abs(Math.floor(value)).toString(16).toUpperCase();
        const targetLen = byteLen * 2;
        // slice(-0) returns the whole string, which is wrong for 0 length. 
        // But we handled byteLen===0 above.
        const padded = hex.padStart(targetLen, '0').slice(-targetLen);
        return this.parseHexBytes(padded);
    },

    parseHexBytes: function (hexStr) {
        const clean = hexStr.replace(/\s/g, '');
        const bytes = [];
        for (let i = 0; i < clean.length; i += 2) {
            bytes.push(parseInt(clean.substr(i, 2), 16));
        }
        return bytes;
    },


    /**
     * Resolves all derived fields (CALCULATED / Formulas / Checksums) based on current inputs.
     */
    resolveDependencies: function (instruction, inputs) {
        const computedValues = {};
        if (!instruction) return computedValues;

        const rawFields = instruction.fields || instruction.blocks || [];

        // CRITICAL: We need ALL nodes (including parents) to resolve Group references
        const allFieldsMap = this.flattenAll(rawFields);

        // --- PASS 0: CALCULATE SIZES (Bottom-Up Approach required for Groups?) ---
        // Actually, we can just calculate leaf sizes, then Aggregate for groups.
        const fieldSizes = {};

        // 0.1 Leaf Sizes
        allFieldsMap.forEach(field => {
            const params = field.parameter_config || {};
            // If group, skip (will calc later)
            if (field.fields?.length > 0) return;

            // Default
            let size = field.byte_len || 1;

            if (params.type === 'string') {
                const val = inputs[field.id] || params.value || '';
                size = val.length;
            } else if (field.op_code === 'HEX_RAW') {
                const val = inputs[field.id] || params.hex || '';
                if (typeof val === 'string') size = Math.ceil(val.replace(/\s/g, '').length / 2);
            }
            fieldSizes[field.id] = size;
        });

        // 0.2 Group Sizes (Recursive Function)
        const getOrCalcSize = (item) => {
            if (fieldSizes[item.id] !== undefined) return fieldSizes[item.id];

            if (item.fields && item.fields.length > 0) {
                let total = 0;
                item.fields.forEach(child => total += getOrCalcSize(child));
                fieldSizes[item.id] = total;
                return total;
            }
            return 0; // Should have been caught in 0.1 if leaf
        };

        // Trigger calculation for all top-level items (which cascades down)
        // Or just map over allFieldsMap again? Mapping all ensures we catch nested groups.
        allFieldsMap.forEach(f => getOrCalcSize(f));


        // --- PASS 1: RESOLVE LENGTH_CALC ---
        allFieldsMap.forEach(field => {
            if (field.op_code !== 'LENGTH_CALC') return;
            const params = field.parameter_config || {};
            const refs = params.refs || [];

            // Build Symbol Table for Formula (Name/ID -> Size)
            const sizeTable = {};
            allFieldsMap.forEach(f => {
                const name = f.name || f.label;
                sizeTable[name] = fieldSizes[f.id] || 0;
                sizeTable[f.id] = fieldSizes[f.id] || 0;
            });

            let result = 0;
            if (params.formula && params.formula !== 'auto') {
                result = evaluateFormula(params.formula, sizeTable);
            } else {
                if (refs.length > 0) {
                    // Simply sum the sizes of referenced fields (which may be Groups)
                    result = refs.reduce((acc, refId) => acc + (fieldSizes[refId] || 0), 0);
                }
            }
            computedValues[field.id] = result;
            // Update this field's size in the map in case it's referenced later?
            // Typically Length itself is fixed size (e.g. 2 bytes), so fieldSizes[field.id] is already correct (2).
            // The *Computed Value* is what changes, not the Field Size.
        });

        // --- PASS 2: RESOLVE CHECKSUM & CALC ---
        // Need to respect calculation order. Simple approach: Calculate everything.
        allFieldsMap.forEach(field => {
            if (field.op_code === 'LENGTH_CALC') return; // Done

            const params = field.parameter_config || {};

            if (field.op_code === 'CHECKSUM_CRC' || params.type === 'checksum') {
                const refs = params.refs || [];
                if (refs.length > 0) {
                    let allBytes = [];
                    refs.forEach(refId => {
                        const refField = allFieldsMap.find(f => f.id === refId);
                        if (refField) {
                            // Recursive Byte Fetching
                            const bytes = this.getFieldBytes(refField, inputs, computedValues, allFieldsMap);
                            allBytes = allBytes.concat(bytes);
                        }
                    });
                    const algo = params.algorithm || ChecksumAlgo.CRC_16_MODBUS;
                    computedValues[field.id] = calculateChecksum(algo, allBytes);
                }
            }
            else if (field.op_code === 'CALCULATED') {
                const valueTable = {};
                allFieldsMap.forEach(f => {
                    const name = f.name || f.label;
                    // Only meaningful for scalar fields. For Groups, what is "value"? 
                    // Usually formulas don't math on Groups directly unless custom.
                    // We'll skip deep group objects.
                    if (!f.fields || f.fields.length === 0) {
                        let val = inputs[f.id];
                        if (computedValues[f.id] !== undefined) val = computedValues[f.id];
                        else if (val === undefined) val = (f.parameter_config?.value || 0);
                        valueTable[name] = val;
                        valueTable[f.id] = val;
                    }
                });
                if (params.formula) {
                    computedValues[field.id] = evaluateFormula(params.formula, valueTable);
                }
            }
        });

        return computedValues;
    },

    /**
     * Generates the final Hex string.
     */
    encodeInstruction: function (instruction, inputs, computedValues) {
        let hexParts = [];
        let byteMap = [];
        let currentByteIndex = 0;

        if (!instruction) return { hexString: '', byteMap: [] };

        const rawFields = instruction.fields || instruction.blocks || [];
        // Flatten ALL to encode
        const allFields = this.flattenAll(rawFields);

        // Render Only LEAF Nodes to the stream
        // (Parents are abstract containers)
        const leafFields = allFields.filter(f => !f.fields || f.fields.length === 0);

        leafFields.forEach(field => {
            // Use shared getFieldBytes for consistency?
            // Yes, but we need to update HexParts and ByteMap manually for visual mapping.
            // Actually getFieldBytes handles logic, we just need to format it.

            const bytes = this.getFieldBytes(field, inputs, computedValues, allFields);
            const byteLen = bytes.length;

            // Format bytes to Hex String
            const hexStr = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');

            hexParts.push(hexStr);
            byteMap.push({ start: currentByteIndex, end: currentByteIndex + byteLen, fieldId: field.id });
            currentByteIndex += byteLen;
        });

        const rawFull = hexParts.join('');
        const pretty = rawFull.match(/.{1,2}/g)?.join(' ') || '';

        return {
            hexString: pretty,
            byteMap
        };
    }
};
