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
    onClick = null,
    // 第 4 批：TIME 字段取值形态 + 定长限制 + 字节定位联动
    pickerMode = false,      // readOnly + pickerMode → 日期选择器取值形态（非锁定板）
    onSelect = null,         // 点击行 → 通知上层选中字段（BYTE_STREAM 高亮联动）
    maxLength = null,        // hex 通道字符数上限（= byte_len×2）
    min = undefined,         // number 通道数值下限
    max = undefined,         // number 通道数值上限
    byteLen = null           // 定长字节数（驱动 n/N BYTES / [nB] 徽标）
}) => {
    // Local buffer to allow unnatural typing (e.g. "05", "0x", or ".") without immediate state correction
    const [localValue, setLocalValue] = useState(String(value ?? ''));
    const isFocused = useRef(false);

    const pickerActive = readOnly && pickerMode;

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
                // 第 4 批 #4：定长数值域即时钳制（本地缓冲与回调同步）
                let out = num;
                if (Number.isFinite(max)) out = Math.min(out, max);
                if (Number.isFinite(min)) out = Math.max(out, min);
                if (out !== num) setLocalValue(String(out));
                onChange(out);
            }
        } else if (type === 'binary') {
            // 优化批 1：二进制通道 —— 0b 前缀（输入糖）→ 纯 [01] → 按位宽
            // 截断 → 二进制解析发**数值**（与 dec 同：值存储恒数值，encoder 无感）。
            const clean = raw.replace(/^0[bB]/, '').replace(/[^01]/g, '')
                .slice(0, Number.isFinite(maxLength) ? maxLength : undefined);
            if (clean === '') {
                // 前缀进行中（'0b'）保留缓冲；纯垃圾清空 —— 都不发半截值
                setLocalValue(/^0[bB]$/.test(raw) ? raw : '');
                return;
            }
            setLocalValue(clean);
            onChange(parseInt(clean, 2));
        } else if (type === 'hex') {
            // 优化批 1：0x/0X 前缀容忍（Wireshark/010 惯例）—— 前缀是输入糖，
            // 剥离后按纯 hex 处理，回显归一为纯 hex（maxLength 不被前缀挤占）。
            if (/^0[xX]$/.test(raw)) {
                setLocalValue(raw); // 前缀进行中：保留缓冲、不发半截值
                return;
            }
            let cleanHex = raw.toUpperCase().replace(/^0X/, '').replace(/[^0-9A-F]/g, '');
            // 第 4 批 #4：定长 hex 截断（byte_len×2 字符 = 字段字节数）
            if (Number.isFinite(maxLength)) cleanHex = cleanHex.slice(0, maxLength);
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
    // Picker lane (第 4 批 #1): TIME 字段经日期选择器取值 —— 可交互对象的满亮
    // 实线外观（非锁定斜纹板），但 input 仍 DOM 只读（值只由选择器写入）。
    const pickerClasses = "text-[#4a4a4a] border-2 border-[#4a4a4a]/40 hover:border-[#4a4a4a] focus:border-[#4a4a4a] focus:bg-[#d1cbaf]/25 cursor-pointer";

    // hex 定长徽标：已用字节数（向上取整，半字节按 1 计 —— encoder parseInt 单字节）
    const usedBytes = (byteLen != null && Number.isFinite(Number(byteLen)) && Number(byteLen) > 0)
        ? Math.min(Number(byteLen), Math.ceil(String(localValue ?? '').replace(/[^0-9A-Fa-f]/g, '').length / 2))
        : null;

    // 优化批 1：二进制定长徽标按**位**计（n/N BITS，n = 已用位数）
    const usedBits = (type === 'binary' && byteLen != null && Number.isFinite(Number(byteLen)) && Number(byteLen) > 0)
        ? Math.min(Number(byteLen) * 8,
            String(localValue ?? '').replace(/^0[bB]/i, '').replace(/[^01]/g, '').length)
        : null;

    return (
        <div
            className={`flex flex-col gap-1 py-1 ${highlight ? 'animate-pulse' : ''} group w-full ${className} ${onClick || onSelect ? 'cursor-pointer hover:bg-nier-light/5' : ''}`}
            onClick={(e) => {
                if (onClick) {
                    e.stopPropagation();
                    onClick();
                }
                // 第 4 批 #2：行点击 → 上层选中字段（字节流高亮联动）
                if (onSelect) onSelect();
            }}
        >
            <div className="flex items-stretch relative">
                {label && (
                    <div className="flex items-center gap-2 mr-3 min-w-[140px] shrink-0">
                        {/* accent bar: full-contrast when editable, ghosted when locked */}
                        <div className={`w-1 h-4 ${readOnly && !pickerActive ? 'bg-[#4a4a4a]/25' : 'bg-[#4a4a4a]/80'}`}></div>
                        <span className={`text-[11px] font-black uppercase tracking-widest truncate ${readOnly && !pickerActive ? 'text-[#4a4a4a]/40' : 'text-[#4a4a4a]'}`}>
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
                            className={`${baseClasses} ${readOnly ? (pickerActive ? pickerClasses : readClasses) : editClasses} flex-1 min-w-0 placeholder:text-[#4a4a4a]/20 ${onClick ? 'pointer-events-none' : ''}`}
                            style={readOnly && !pickerActive ? readStyle : undefined}
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
                    {readOnly && pickerActive ? (
                        // 第 4 批 #1：TIME 取值形态 —— 可交互满亮徽标，非锁定板
                        <span
                            className="text-[9px] font-black text-[#4a4a4a] border border-[#4a4a4a]/50 px-1.5 py-0.5 uppercase tracking-tighter whitespace-nowrap select-none"
                            title="TIME_PICKER // 点击选择时间（按 base_time 换算秒数）"
                        >
                            [TIME_PICKER]
                        </span>
                    ) : readOnly ? (
                        // Inverted (charcoal-on-sand) chip: the strongest anchor in the row
                        <span
                            className="text-[9px] font-black text-[#dad4bb] bg-[#4a4a4a] px-1.5 py-0.5 uppercase tracking-tighter whitespace-nowrap select-none"
                            title="READ_ONLY // 由固定/计算块生成，不可直接编辑"
                        >
                            [READ_ONLY]
                        </span>
                    ) : usedBytes != null && type === 'hex' ? (
                        // 第 4 批 #4：定长 hex 长度徽标（n/N BYTES，n = 已用字节）
                        <span
                            className="text-[9px] font-black text-[#4a4a4a]/60 uppercase tracking-tighter whitespace-nowrap select-none"
                            title={`长度上限 ${byteLen} 字节（${Number(byteLen) * 2} 个十六进制字符）`}
                        >
                            {usedBytes}/{byteLen} BYTES
                        </span>
                    ) : usedBits != null ? (
                        // 优化批 1：定长二进制徽标按位计（n/N BITS）
                        <span
                            className="text-[9px] font-black text-[#4a4a4a]/60 uppercase tracking-tighter whitespace-nowrap select-none"
                            title={`长度上限 ${Number(byteLen) * 8} 位（${byteLen} 字节）`}
                        >
                            {usedBits}/{Number(byteLen) * 8} BITS
                        </span>
                    ) : usedBytes != null ? (
                        // 第 4 批 #4：非 hex 通道只标字节上限
                        <span
                            className="text-[9px] font-black text-[#4a4a4a]/60 uppercase tracking-tighter whitespace-nowrap select-none"
                            title={`长度上限 ${byteLen} 字节`}
                        >
                            [{byteLen}B]
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
