import React, { useState, useEffect, useRef } from 'react';

/**
 * A mission-grade HUD input component following NieR aesthetics.
 * Features a local buffer state to prevent "Input Lock" during typing.
 * Supports standard inputs and dropdown selections (Enum).
 */
export const SmartInput = ({
    label,
    value,
    onChange,
    type = 'text', // 'text', 'number', 'hex', 'decimal', 'select'
    options = [], // [{ label: 'Name', value: 0x01 }]
    readOnly = false,
    highlight = false,
    autoFocus = false,
    suffix = null,
    className = "",
    placeholder = "",
    onClick = null
}) => {
    // Local buffer to allow unnatural typing (e.g. "05", "0x", or ".") without immediate state correction
    const [localValue, setLocalValue] = useState(String(value ?? ''));
    const isFocused = useRef(false);

    // Sync from parent ONLY when not focused to avoid fighting the user
    useEffect(() => {
        if (!isFocused.current) {
            setLocalValue(String(value ?? ''));
        }
    }, [value]);

    const handleFocus = (e) => {
        isFocused.current = true;
        if (!readOnly && e.target.select) {
            e.target.select();
        }
    };

    const handleBlur = () => {
        isFocused.current = false;
        // Final sync: ensure local value matches the true value on blur
        setLocalValue(String(value ?? ''));
    };

    const handleChange = (e) => {
        if (readOnly) return;
        const raw = e.target.value;
        setLocalValue(raw);

        // Parsing logic based on type
        if (type === 'number' || type === 'decimal') {
            if (raw === '' || raw === '-' || raw === '.') {
                // Don't emit partials to parent yet to avoid NaN ripples
                return;
            }
            const num = Number(raw);
            if (!isNaN(num)) {
                onChange(num);
            }
        } else if (type === 'hex') {
            const cleanHex = raw.toUpperCase().replace(/[^0-9A-F]/g, '');
            setLocalValue(cleanHex);
            onChange(cleanHex);
        } else if (type === 'select') {
            // Options are usually numbers or strings
            const selectedOpt = options.find(o => String(o.value) === raw);
            onChange(selectedOpt ? selectedOpt.value : raw);
        } else {
            onChange(raw);
        }
    };

    // Compact HUD aesthetics - NieR: Automata standard (High-Density)
    const baseClasses = "bg-[#d1cbaf]/5 font-mono outline-none text-left px-3 py-1.5 text-base font-bold tracking-wider transition-all duration-150 uppercase w-full";
    // Editable: solid light border that snaps dark on hover/focus (clearly enterable)
    const editClasses = "text-[#4a4a4a] border-2 border-[#4a4a4a]/25 hover:border-[#4a4a4a]/60 focus:border-[#4a4a4a] focus:bg-[#d1cbaf]/25 cursor-text";
    // Read-only (Fixed/Calculated): dark hatch fill + dashed border = locked plate
    const readClasses = "text-[#4a4a4a]/60 bg-[#4a4a4a]/10 border-2 border-dashed border-[#4a4a4a]/40 cursor-default";
    // Inline so the locked fill wins over base bg regardless of CSS order:
    // 135° hazard hatch stripes read as "generated, not enterable" at a glance.
    const readStyle = {
        backgroundColor: 'rgba(74,74,74,0.10)',
        backgroundImage: 'repeating-linear-gradient(135deg, rgba(74,74,74,0) 0 6px, rgba(74,74,74,0.10) 6px 12px)'
    };

    return (
        <div
            className={`flex flex-col gap-1 py-1 ${highlight ? 'animate-pulse' : ''} group w-full ${className} ${onClick ? 'cursor-pointer hover:bg-nier-light/5' : ''}`}
            onClick={(e) => {
                if (onClick) {
                    e.stopPropagation();
                    onClick();
                }
            }}
        >
            <div className="flex items-stretch relative">
                {label && (
                    <div className="flex items-center gap-2 mr-3 min-w-[140px] shrink-0">
                        {/* accent bar: full-contrast when editable, ghosted when locked */}
                        <div className={`w-1 h-4 ${readOnly ? 'bg-[#4a4a4a]/25' : 'bg-[#4a4a4a]/80'}`}></div>
                        <span className={`text-[11px] font-black uppercase tracking-widest truncate ${readOnly ? 'text-[#4a4a4a]/40' : 'text-[#4a4a4a]'}`}>
                            {label}
                        </span>
                    </div>
                )}

                <div className="flex-1 flex items-stretch">
                    {type === 'select' && !readOnly ? (
                        <select
                            className={`${baseClasses} ${editClasses}`}
                            value={String(localValue)}
                            onChange={handleChange}
                            onFocus={handleFocus}
                            onBlur={handleBlur}
                        >
                            {options.map((opt, i) => (
                                <option key={i} value={String(opt.value)} className="bg-[#dad4bb] text-[#4a4a4a]">
                                    {opt.label || opt.name || opt.value}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <input
                            type="text"
                            className={`${baseClasses} ${readOnly ? readClasses : editClasses} flex-1 min-w-0 placeholder:text-[#4a4a4a]/20 ${onClick ? 'pointer-events-none' : ''}`}
                            style={readOnly ? readStyle : undefined}
                            value={localValue}
                            onChange={handleChange}
                            onFocus={handleFocus}
                            onBlur={handleBlur}
                            readOnly={readOnly}
                            autoFocus={autoFocus}
                            spellCheck={false}
                            autoComplete="off"
                            placeholder={placeholder}
                        />
                    )}

                    {suffix && (
                        <div className="bg-[#4a4a4a]/80 text-[#dad4bb] px-2 flex items-center justify-center text-[10px] font-black font-mono select-none uppercase tracking-tighter shrink-0">
                            {suffix}
                        </div>
                    )}
                </div>

                <div className="w-24 shrink-0 flex items-center justify-end px-2">
                    {readOnly ? (
                        // Inverted (charcoal-on-sand) chip: the strongest anchor in the row
                        <span
                            className="text-[9px] font-black text-[#dad4bb] bg-[#4a4a4a] px-1.5 py-0.5 uppercase tracking-tighter whitespace-nowrap select-none"
                            title="READ_ONLY // 由固定/计算块生成，不可直接编辑"
                        >
                            [READ_ONLY]
                        </span>
                    ) : (
                        <span className="text-[9px] font-black text-[#4a4a4a]/35 uppercase tracking-tighter whitespace-nowrap select-none">
                            {`[${type.toUpperCase()}]`}
                        </span>
                    )}
                </div>
            </div>

            {readOnly && highlight && (
                <div className="text-[8px] font-black text-[#4a4a4a]/40 uppercase ml-36 tracking-tighter flex items-center gap-1">
                    <span className="w-1 h-1 bg-[#4a4a4a]/40 animate-ping"></span>
                    SYNC_FIELD
                </div>
            )}
        </div>
    );
};
