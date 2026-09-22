import React from 'react';
import { SmartInput } from './SmartInput';
import { ENCODER_LIMITS } from '../../utils/encoderLimits';
import {
    classifyRunnerField,
    resolveFieldDisplay,
    collectSemanticItems,
    getFieldEpoch
} from '../../config/runnerRenderRules';

// Recursive renderer for the dynamic send form's field tree.
// Extracted verbatim from InstructionRunner.jsx renderFields.
// All classification / option / display-value / semantic rules live in
// config/runnerRenderRules.js (unit-tested) — this file only does layout.

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
        // FIX: Robust classification from config/runnerRenderRules.js
        // (re-applied at render time; falls back to preserved original_op_code)
        const { isCalculated, isTimeCumulative, isEditable, isEnum }
            = classifyRunnerField(field);

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
        // Display rules (fixed/time/calculated/enum/plain + hex formatting)
        // live in config/runnerRenderRules.js — resolve once here.
        const { displayValue, placeholder, inputType, options: formattedOptions }
            = resolveFieldDisplay(field, { inputs, computedValues });

        // A6: surface semantic params (scale factor/offset, counter step/max,
        // checksum algo, ...) the send form would otherwise hide from the operator.
        const semanticItems = collectSemanticItems(field);

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

        // ReadOnly if time (input readOnly; click opens the picker) or static
        const readOnly = !isEditable || isTimeCumulative;

        return (
            <div key={field.id} className={`${depth > 0 ? 'ml-6' : ''}`}>
                {/* hover/focus rail only on enterable rows — static read-only rows stay dead */}
                <div className={`group/field transition-all border-l-2 border-transparent ${readOnly && !isTimeCumulative ? '' : 'hover:border-nier-light/10 focus-within:border-nier-light/30'}`}>
                    <SmartInput
                        label={field.name || field.label || 'PARAM'}
                        value={displayValue}
                        onChange={handleChange}
                        type={inputType}
                        options={formattedOptions}
                        readOnly={readOnly}
                        onClick={isTimeCumulative ? handleTimeClick : undefined} // Trigger picker
                        highlight={isCalculated || isTimeCumulative}
                        suffix={params.unit || (isTimeCumulative ? `${getFieldEpoch(params).getFullYear()}` : '')}
                        placeholder={placeholder}
                    />
                    {semanticItems.length > 0 && (
                        <div className="text-[9px] font-mono text-nier-light/60 ml-40 -mt-0.5 mb-1 uppercase tracking-tighter">
                            {semanticItems.map((it, i) => (
                                <React.Fragment key={`${it.text}-${i}`}>
                                    {i > 0 && ' · '}
                                    <span
                                        title={it.ref ? ENCODER_LIMITS[it.ref] : undefined}
                                        className={it.ref ? 'text-[#E58D28] font-bold cursor-help' : undefined}
                                    >
                                        {it.text}{it.ref ? ' ⚠' : ''}
                                    </span>
                                </React.Fragment>
                            ))}
                        </div>
                    )}
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
