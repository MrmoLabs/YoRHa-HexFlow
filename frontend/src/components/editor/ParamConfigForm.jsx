import React from 'react';
import FieldPickerParam from './paramConfig/FieldPickerParam';
import KvPairListParam from './paramConfig/KvPairListParam';
import FormulaParam from './paramConfig/FormulaParam';
import { toControlledScalar, inferConfigType } from './paramConfig/paramConfigUtils';
import { getParamKeyLimitRef, ENCODER_LIMITS } from '../../utils/encoderLimits';

// P0-1: amber badge for param keys whose semantics the encoder ignores (B2–B8).
function ParamLimitBadge({ paramKey, opCode }) {
    const ref = getParamKeyLimitRef(paramKey, opCode);
    if (!ref) return null;
    return <span title={ENCODER_LIMITS[ref]} className="ml-1 inline-block bg-[#E58D28] text-nier-dark font-bold px-0.5 cursor-help">⚠{ref}</span>;
}

export default function ParamConfigForm({
    blockState,
    instructionFields,
    operatorTemplates,
    onUpdateParam, // (key, val) => void
    hexInputMode,
    setHexInputMode,
    onOpenDatePicker, // (key, val) => void
    onStartPicking, // (key, currentRefs) => void
    onStopPicking, // () => void
    pickingMode // { isActive, fieldKey, ... }
}) {
    const template = operatorTemplates[blockState.op_code];
    if (!template || !template.param_template) return null;

    // AUTO-RECONCILE SQL IMPORTS (Name-based formula to UUID refs)
    React.useEffect(() => {
        const formula = blockState.parameter_config?.formula;
        const refs = blockState.parameter_config?.refs || [];
        if (typeof formula === 'string' && formula.includes('[') && refs.length === 0) {
            const matches = formula.match(/\[([^\]]+)\]/g) || [];
            const names = matches.map(m => m.slice(1, -1));
            const resolvedRefs = names.map(name => {
                const f = instructionFields?.find(fi => (fi.name || fi.label) === name);
                return f?.id;
            }).filter(Boolean);

            if (resolvedRefs.length > 0) {
                console.log(`Auto-resolving refs for ${blockState.name} from formula: ${formula}`);
                onUpdateParam('refs', [...new Set(resolvedRefs)]);
            }
        }
    }, [blockState.id, blockState.parameter_config?.formula]);

    return Object.entries(template.param_template).map(([key, rawConfig]) => {
        const val = blockState.parameter_config?.[key];
        const configType = inferConfigType(rawConfig);

        // 0. Field Picker (Logic Fields)
        if (configType === 'field_picker') {
            return (
                <FieldPickerParam
                    key={key}
                    paramKey={key}
                    val={val}
                    pickingMode={pickingMode}
                    onStartPicking={onStartPicking}
                    onStopPicking={onStopPicking}
                />
            );
        }

        // 1. Enum / Array Select
        if (Array.isArray(configType)) {
            const selectValue = Array.isArray(val)
                ? (val[0] ?? configType[0])
                : (val ?? configType[0] ?? '');

            return (
                <div key={key} className="flex flex-col gap-1">
                    <label className="text-[10px] opacity-70 uppercase tracking-widest">{key}<ParamLimitBadge paramKey={key} opCode={blockState.op_code} /></label>
                    <select
                        value={toControlledScalar(selectValue, '')}
                        onChange={(e) => {
                            const raw = e.target.value;
                            // Smart parse: if it looks like a number, parse it
                            const parsed = isNaN(raw) ? raw : (raw.includes('.') ? parseFloat(raw) : parseInt(raw, 10));
                            onUpdateParam(key, parsed);
                        }}
                        className="bg-nier-dark border border-nier-light/30 text-xs p-1 text-nier-light focus:border-nier-light focus:outline-none"
                    >
                        {configType.map(opt => <option key={opt} value={opt} className="bg-nier-dark text-nier-light">{opt}</option>)}
                    </select>
                </div>
            )
        }

        // 2. Key-Value List (Enum Mapping)
        if (key === 'options' && configType === 'kv_pair_list') {
            // Use internal array state for rendering (prepared by parent)
            const kvArray = blockState.parameter_config?._kvArray || [];

            return (
                <KvPairListParam
                    key={key}
                    paramKey={key}
                    kvArray={kvArray}
                    onUpdateParam={onUpdateParam}
                    hexInputMode={hexInputMode}
                    setHexInputMode={setHexInputMode}
                />
            );
        }

        // 3. DateTime
        if (configType === 'datetime') {
            return (
                <div key={key} className="flex flex-col gap-1">
                    <label className="text-[10px] opacity-70 uppercase tracking-widest">{key}</label>
                    <div
                        onClick={() => onOpenDatePicker(val, (newDate) => onUpdateParam(key, newDate))}
                        className="bg-transparent border-b border-nier-light/50 py-1 font-mono text-xs text-nier-light cursor-pointer hover:bg-nier-light/10 flex justify-between items-center group/date"
                    >
                        <span className={!val ? "opacity-50" : ""}>{val ? val.replace('T', ' ') : 'YYYY-MM-DD HH:MM:SS'}</span>
                        <span className="opacity-30 text-[8px] group-hover/date:opacity-100 transition-opacity">EDIT</span>
                    </div>
                </div>
            )
        }

        // 4. Advanced Formula Input (Logic Fields)
        if (key === 'formula') {
            return (
                <FormulaParam
                    key={key}
                    paramKey={key}
                    val={val}
                    blockState={blockState}
                    instructionFields={instructionFields}
                    onUpdateParam={onUpdateParam}
                />
            );
        }

        // 5. Standard Input (Number/Text)
        return (
            <div key={key} className="flex flex-col gap-1">
                <label className="text-[10px] opacity-70 uppercase tracking-widest">
                    {key === 'max_count' ? 'LOOP COUNT' : key}
                    <ParamLimitBadge paramKey={key} opCode={blockState.op_code} />
                </label>
                <input
                    type={configType === 'number' ? 'number' : 'text'}
                    step={configType === 'number' ? 'any' : undefined}
                    value={toControlledScalar(val, '')}
                    onChange={(e) => {
                        let v = e.target.value;
                        if (configType === 'number') {
                            // A7: an emptied number input must not store NaN
                            v = v === '' ? '' : parseFloat(v);
                            if (typeof v === 'number' && isNaN(v)) v = '';
                        }
                        onUpdateParam(key, v);
                    }}
                    className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono text-sm"
                />
            </div>
        );
    });
}
