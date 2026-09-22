import React from 'react';
import { SmartInput } from './SmartInput';

// Recursive renderer for the dynamic send form's field tree.
// Extracted verbatim from InstructionRunner.jsx renderFields (logic unchanged).

// DRY Helper: Get Date object for the field's base time (epoch)
const getFieldEpoch = (params) => {
    const baseTimeStr = params.base_time || '2000-01-01T00:00:00';
    return new Date(baseTimeStr.includes('T') ? baseTimeStr : baseTimeStr.replace(' ', 'T'));
};

export default function RunnerFieldTree({
    fields,
    depth = 0,
    inputs,
    computedValues,
    onFieldChange, // (fieldId, value) => void
    onOpenDatePicker // (iso, callback) => void
}) {
    return fields.map((field) => {
        const params = field.parameter_config || {};
        // FIX: Robust check using preserved original_op_code
        const originalOp = String(field.original_op_code || '').toUpperCase();

        // Re-apply robust classification logic in render time
        const isCalculated = field.op_code === 'CALCULATED' || field.op_code === 'LENGTH_CALC' || field.op_code === 'CHECKSUM_CRC' || params.formula === 'auto' || params.type === 'length' || params.type === 'checksum';
        const isTimeCumulative = field.op_code === 'TIME_CUMULATIVE' || originalOp === 'TIME_CUMULATIVE' || originalOp === 'TIME_ACCUMULATOR' || params.type === 'time_cumulative';

        const isFixed = (field.op_code === 'FIXED' || originalOp === 'HEX_RAW' || originalOp === 'FIXED' || field.op_code === 'HEX_RAW' || params.readOnly) && !isTimeCumulative;

        const isEditable = !isCalculated && !isFixed;
        const rawOptions = params.options;
        const hasOptions = rawOptions && (Array.isArray(rawOptions) ? rawOptions.length > 0 : Object.keys(rawOptions).length > 0);
        const isEnum = hasOptions || field.op_code === 'MAPPING';

        const subFields = field.fields || [];

        if (subFields.length > 0) {
            return (
                <div key={field.id} className={`${depth > 0 ? 'ml-6' : ''}`}>
                    <div className="border-l border-nier-light/10 pl-4 py-2 my-2 bg-nier-light/[0.02]">
                        <div className="flex items-center gap-2 mb-2 opacity-60">
                            <div className="w-2 h-2 bg-nier-light/30"></div>
                            <span className="text-[10px] font-black uppercase tracking-widest text-nier-light">
                                {field.name || field.label || 'BLOCK'}
                            </span>
                        </div>
                        <RunnerFieldTree
                            fields={subFields}
                            depth={depth + 1}
                            inputs={inputs}
                            computedValues={computedValues}
                            onFieldChange={onFieldChange}
                            onOpenDatePicker={onOpenDatePicker}
                        />
                    </div>
                </div>
            );
        }

        // LEAF NODE
        // Normalize option values with the SAME rule InstructionEncoder.getInitialValues
        // uses (hex-looking string -> number). The stored input state is numeric, so if
        // option values stayed hex strings, String(opt.value) would never match
        // String(displayValue) and the controlled <select> renders blank.
        const normalizeOptionValue = (v) =>
            (typeof v === 'string' && /^[0-9A-Fa-f]+$/.test(v)) ? (parseInt(v, 16) || 0) : v;
        const formattedOptions = Array.isArray(rawOptions)
            ? rawOptions.map(opt => typeof opt === 'object' ? { ...opt, value: normalizeOptionValue(opt.value) } : { label: String(opt), value: normalizeOptionValue(opt) })
            : (rawOptions ? Object.entries(rawOptions).map(([k, v]) => ({ label: k, value: normalizeOptionValue(v) })) : []);

        let displayValue = '';
        let placeholder = '';
        let inputType = !isEditable ? 'text' : (isEnum && formattedOptions.length > 0 ? 'select' : (params.type || 'number'));

        // 1. Fixed / ReadOnly Fields: Show the exact HEX or Value
        if (isFixed) {
            const isExplicitHex = originalOp === 'HEX_RAW' || field.op_code === 'HEX_RAW';
            let rawVal = params.hex || params.value;

            if (!rawVal && isExplicitHex) {
                // Default to Zero based on byte_len if missing
                rawVal = '00'.repeat(field.byte_len || 1);
            }

            displayValue = String(rawVal || '').toUpperCase();

            if (!displayValue) {
                placeholder = 'NO DATA';
            }
        } else if (isTimeCumulative) {
            // TIME CUMULATIVE LOGIC
            // Value is Seconds since base_time (default: 2000-01-01 00:00:00)
            const BASE_TIME = getFieldEpoch(params);
            const seconds = inputs[field.id] || 0;
            const currentTime = new Date(BASE_TIME.getTime() + (seconds * 1000));

            // Format: YYYY-MM-DD HH:mm:ss
            const pad = n => n.toString().padStart(2, '0');
            displayValue = `${currentTime.getFullYear()}-${pad(currentTime.getMonth() + 1)}-${pad(currentTime.getDate())} ${pad(currentTime.getHours())}:${pad(currentTime.getMinutes())}:${pad(currentTime.getSeconds())}`;
            inputType = 'text'; // Show formatted text

            // Override Input Props for Picker
        } else if (isCalculated || isEnum) {
            // FIX: Priority to Computed Values for calculated fields
            // If it's Enum, input is source of truth. If Calculated, computedValues is source.
            if (isCalculated) {
                displayValue = computedValues[field.id] !== undefined ? computedValues[field.id] : 0;
                inputType = 'hex'; // Usually Length/Checksum are hex
                // Auto-format for display
                if (typeof displayValue === 'number' && field.byte_len !== undefined) {
                    if (field.byte_len === 0) {
                        displayValue = '';
                    } else {
                        const targetLen = field.byte_len * 2;
                        displayValue = displayValue.toString(16).toUpperCase().padStart(targetLen, '0').slice(-targetLen);
                    }
                }
            } else {
                displayValue = inputs[field.id] !== undefined ? inputs[field.id] : (computedValues[field.id] || 0);
            }
        } else {
            const rawValue = inputs[field.id];
            if (field.byte_len && field.byte_len > 0) {
                const currentVal = rawValue ?? 0;
                if (!params.type || params.type === 'number' || params.type === 'hex') {
                    inputType = 'hex';
                    if (typeof currentVal === 'number') {
                        displayValue = currentVal.toString(16).toUpperCase().padStart(field.byte_len * 2, '0');
                    } else {
                        displayValue = String(currentVal || '').toUpperCase();
                    }
                    placeholder = '0'.repeat(field.byte_len * 2);
                } else {
                    displayValue = rawValue;
                }
            } else {
                displayValue = rawValue;
                placeholder = '?? [VAR]';
            }
        }

        const handleChange = (val) => {
            // FIX: Enum handling for HEX strings
            if (isEnum) {
                // If the value looks like a hex string (e.g. "AA"), parse it as base 16
                // But if it's already a number, just use it.
                const strVal = String(val);
                // Check if option value was intended as hex
                // We can try to match it against options to see the original type?
                // Or just generic "Auto Detect" approach:
                if (typeof val === 'string' && /^[0-9A-Fa-f]+$/.test(val)) {
                    // It's a hex string (e.g. 'AA', '0A') form the option value
                    const num = parseInt(val, 16);
                    onFieldChange(field.id, isNaN(num) ? 0 : num);
                    return;
                }
            }

            if (inputType === 'hex' && typeof val === 'string') {
                // Convert hex string back to integer for storage
                const num = parseInt(val, 16);
                onFieldChange(field.id, isNaN(num) ? 0 : num);
            } else {
                onFieldChange(field.id, val);
            }
        };

        const handleTimeClick = () => {
            if (onOpenDatePicker) {
                // Calculate current ISO for picker
                const BASE_TIME = getFieldEpoch(params);
                const seconds = inputs[field.id] || 0;
                const currentIso = new Date(BASE_TIME.getTime() + (seconds * 1000)).toISOString();

                onOpenDatePicker(currentIso, (newIso) => {
                    const newDate = new Date(newIso);
                    const diffSeconds = Math.floor((newDate.getTime() - BASE_TIME.getTime()) / 1000);
                    onFieldChange(field.id, diffSeconds); // Allow negative for "before base time"
                });
            }
        };

        return (
            <div key={field.id} className={`${depth > 0 ? 'ml-6' : ''}`}>
                <div className="group/field transition-all border-l-2 border-transparent hover:border-nier-light/10 focus-within:border-nier-light/30">
                    <SmartInput
                        label={field.name || field.label || 'PARAM'}
                        value={displayValue}
                        onChange={handleChange}
                        type={inputType}
                        options={formattedOptions}
                        readOnly={!isEditable || isTimeCumulative} // ReadOnly if time (use click)
                        onClick={isTimeCumulative ? handleTimeClick : undefined} // Trigger picker
                        highlight={isCalculated || isTimeCumulative}
                        suffix={params.unit || (isTimeCumulative ? `${getFieldEpoch(params).getFullYear()}` : '')}
                        placeholder={placeholder}
                    />
                    {params.description && (
                        <div className="text-[9px] font-bold text-nier-light/30 ml-40 -mt-1 mb-2 opacity-0 group-hover/field:opacity-100 transition-opacity uppercase tracking-tighter">
                            {params.description}
                        </div>
                    )}
                </div>
            </div>
        );
    });
}
