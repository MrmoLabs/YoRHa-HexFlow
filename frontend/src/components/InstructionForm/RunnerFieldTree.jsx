import React from 'react';
import { SmartInput } from './SmartInput';
import BitSegmentInputs from './BitSegmentInputs';
import { ENCODER_LIMITS } from '../../utils/encoderLimits';
import {
    classifyRunnerField,
    resolveFieldDisplay,
    collectSemanticItems,
    getFieldEpoch,
    computeFieldInputLimits
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
    onOpenDatePicker, // (iso, callback) => void
    selectedFieldId = null,   // 第 4 批 #2：选中字段（字节流高亮联动）
    onSelectField = null      // (fieldId) => void
}) {
    return fields.map((field) => {
        const params = field.parameter_config || {};
        // FIX: Robust classification from config/runnerRenderRules.js
        // (re-applied at render time; falls back to preserved original_op_code)
        const { isCalculated, isTimeCumulative, isEditable, isEnum }
            = classifyRunnerField(field);

        const isSelected = selectedFieldId === field.id;
        const subFields = field.fields || [];

        if (subFields.length > 0) {
            return (
                <div key={field.id} className={`${depth > 0 ? 'ml-6' : ''}`}>
                    <div
                        className={`border-l pl-4 py-2 my-2 bg-nier-light/[0.02] ${isSelected ? 'border-[#E58D28]' : 'border-nier-light/10'} ${onSelectField ? 'cursor-pointer hover:bg-nier-light/[0.05]' : ''}`}
                        onClick={onSelectField ? (e) => {
                            // stopPropagation：选中本组即止，不被外层容器覆盖（嵌套组）
                            e.stopPropagation();
                            onSelectField(field.id);
                        } : undefined}
                        title={onSelectField ? '点击选中整块 → 字节流高亮对应区间' : undefined}
                    >
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
                            selectedFieldId={selectedFieldId}
                            onSelectField={onSelectField}
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
        // 第 4 批 #4：定长限制（指令管理 byte_len 定死 → 截断/钳制 + 长度徽标）
        const limits = computeFieldInputLimits(field);
        // 第 4 批 #2：选中态导轨（amber 定位轨优先于 hover 轨，互斥分支防撞类）
        const railCls = isSelected
            ? 'border-[#E58D28]'
            : `border-transparent ${readOnly && !isTimeCumulative ? '' : 'hover:border-nier-light/10 focus-within:border-nier-light/30'}`;

        return (
            <div
                key={field.id}
                className={`${depth > 0 ? 'ml-6' : ''}`}
                onClick={(e) => {
                    // 叶行点击在 SmartInput onSelect 后即止 —— 不冒泡到组容器，
                    // 防止嵌套组内选中被外层组 id 覆盖成「整组高亮」
                    e.stopPropagation();
                }}
            >
                <div className={`group/field transition-all border-l-2 ${railCls}`}>
                    <SmartInput
                        label={field.name || field.label || 'PARAM'}
                        value={displayValue}
                        onChange={handleChange}
                        type={inputType}
                        options={formattedOptions}
                        readOnly={readOnly}
                        onClick={isTimeCumulative ? handleTimeClick : undefined} // Trigger picker
                        pickerMode={isTimeCumulative} // 第 4 批 #1：TIME 不标 READ_ONLY
                        onSelect={onSelectField ? () => onSelectField(field.id) : undefined}
                        maxLength={limits?.maxLength}
                        min={limits?.min}
                        max={limits?.max}
                        byteLen={limits?.byteLen}
                        highlight={isCalculated || isTimeCumulative}
                        suffix={params.unit || (isTimeCumulative ? `${getFieldEpoch(params).getFullYear()}` : '')}
                        placeholder={placeholder}
                    />
                    {/* 批 3：BITFIELD 子位录入（与上方整包输入并存；单一真源 = 字段整数） */}
                    {isEditable && field.op_code === 'BITFIELD' && Array.isArray(field.bits) && field.bits.length > 0 && (
                        <BitSegmentInputs
                            bits={field.bits}
                            value={inputs[field.id]}
                            onChange={(packed) => onFieldChange(field.id, packed)}
                            onSelectField={onSelectField ? () => onSelectField(field.id) : undefined}
                        />
                    )}
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
