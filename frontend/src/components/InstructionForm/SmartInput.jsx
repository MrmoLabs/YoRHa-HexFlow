import React, { useState, useEffect, useRef } from 'react';
import { parseBcdInput, parseFloatInput } from '../../config/runnerRenderRules';

/**
 * A mission-grade HUD input component following NieR aesthetics.
 * Features a local buffer state to prevent "Input Lock" during typing.
 * Supports standard inputs and dropdown selections (Enum).
 * 第 14 单：新增 kind 章（字段种类徽标 + tooltip）、float/bcd 专属通道
 * （解析助手在 config/runnerRenderRules.js，纯函数单测）、usage 用量徽标。
 */
export const SmartInput = ({
    label,
    value,
    onChange,
    type = 'text', // 'text' | 'number' | 'hex' | 'decimal' | 'binary' | 'float' | 'bcd' | 'select'
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
    maxLength = null,        // hex/bcd 通道字符数上限（hex=byte_len×2 / bcd=nibble 数）
    min = undefined,         // number 通道数值下限
    max = undefined,         // number 通道数值上限
    byteLen = null,          // 定长字节数（驱动 n/N BYTES / [nB] 徽标）
    // 第 14 单：字段种类章（label 前小徽标）+ 文本用量徽标（n/N CHARS|BYTES）
    kindLabel = null,
    kindTitle = null,
    usage = null,            // { used, total, unit, over } | null
    // R29 (§8.61)：条件存在 (PRESENCE) —— { hit, title } | null（null = 该字段
    // 未配置 presence → 零渲染，与 R29 之前逐像素一致）。判定与出线编码同源
    // （runnerRenderRules.resolvePresenceStates → InstructionEncoder._presenceHit），
    // 角标只陈述结论不改任何编码/限宽行为（maxLength/min/max/usage 一律照旧）。
    presence = null
}) => {
    // Local buffer to allow unnatural typing (e.g. "05", "0x", or ".") without immediate state correction
    const [localValue, setLocalValue] = useState(String(value ?? ''));
    const isFocused = useRef(false);

    const pickerActive = readOnly && pickerMode;

    // Sync from parent ONLY when not focused to avoid fighting the user
    useEffect(() => {
        if (!isFocused.current) {
            // 外部 value → 本地草稿的**单向同步**（失焦期才写回）。改成派生 state 会
            // 动受控/非受控边界，行为风险大于收益 —— R3 存量定点放行（§8.40）。
            // eslint-disable-next-line react-hooks/set-state-in-effect
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
        } else if (type === 'float') {
            // 第 14 单：十进制小数通道 —— 与编码端 float32 分支同语法（严格十进制
            // 小数、不吃指数）；半截（'-'/'.'/'1.'）与非法字符保留缓冲不发半截值。
            const res = parseFloatInput(raw);
            setLocalValue(res.text);
            if (res.value !== null) onChange(res.value);
        } else if (type === 'bcd') {
            // 第 14 单：BCD 数字通道 —— 只进 0-9，按 nibble 数限宽（不移位），
            // 发十进制数值（逐 nibble 打包由编码端完成）。空缓冲不发值。
            const res = parseBcdInput(raw, maxLength);
            setLocalValue(res.text);
            if (res.value !== null) onChange(res.value);
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
            onClick={() => {
                // 第 4 批 #2：行点击 → 上层选中字段（字节流高亮联动）。
                // R46（§8.78）：开时间弹窗的 onClick 不在这一层 —— 触发点已
                // 收到下方的值区，点标签 / 右徽标只做字节定位，不再整行误弹。
                if (onSelect) onSelect();
            }}
        >
            <div className="flex items-stretch relative">
                {label && (
                    <div className="flex items-center gap-2 mr-3 min-w-[140px] shrink-0">
                        {/* accent bar: full-contrast when editable, ghosted when locked */}
                        <div className={`w-1 h-4 ${readOnly && !pickerActive ? 'bg-[#4a4a4a]/25' : 'bg-[#4a4a4a]/80'}`}></div>
                        {/* 第 14 单：字段种类章（算子语义 tooltip；右徽标继续承载状态/长度） */}
                        {kindLabel && (
                            <span
                                title={kindTitle}
                                className={`text-[8px] font-black font-mono leading-none border px-1 py-[2px] uppercase tracking-tighter shrink-0 select-none cursor-help ${readOnly && !pickerActive ? 'text-[#4a4a4a]/40 border-[#4a4a4a]/25' : 'text-[#4a4a4a]/85 border-[#4a4a4a]/45'}`}
                            >
                                {kindLabel}
                            </span>
                        )}
                        {/* R29 (§8.61)：条件存在 IF 角标 —— 琥珀状态章（title =
                            判定式 + 命中结论 + fail-open 归因）。与编辑器画布
                            Block.jsx 的 data-presence-chip 同语义、同文案骨架。 */}
                        {presence && (
                            <span
                                data-runner-presence-chip={presence.hit ? 'hit' : 'miss'}
                                title={presence.title}
                                className={`text-[8px] font-black font-mono leading-none border px-1 py-[2px] uppercase tracking-tighter shrink-0 select-none cursor-help ${presence.hit
                                    ? 'text-[#E58D28] border-[#E58D28]/60'
                                    : 'text-[#4a4a4a]/45 border-[#4a4a4a]/30'}`}
                            >
                                IF
                            </span>
                        )}
                        <span className={`text-[11px] font-black uppercase tracking-widest truncate ${readOnly && !pickerActive ? 'text-[#4a4a4a]/40' : 'text-[#4a4a4a]'}`}>
                            {label}
                        </span>
                    </div>
                )}

                {/* R46（§8.78）：时间配置弹窗的触发点收在**值区**这一块 ——
                    点标签、点右徽标只做字节定位选中，不再整行误弹。这里不
                    stopPropagation，事件继续冒泡到最外层的 onSelect：点值区
                    = 开弹窗 + 选中字段，两件事一起。 */}
                <div
                    className="flex-1 flex items-stretch"
                    onClick={onClick ? () => onClick() : undefined}
                >
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
                    {presence && !presence.hit ? (
                        // R29 (§8.61)：presence 未命中 → 本字段本帧 0 字节。该结论
                        // 优先于 TIME_PICKER / READ_ONLY / 用量 / 长度章 —— 「这行
                        // 根本不出线」比「这行能不能改」更需要先被看见。
                        <span
                            data-runner-presence-skip
                            title={presence.title}
                            className="text-[9px] font-black text-[#E58D28] border border-[#E58D28]/60 px-1.5 py-0.5 uppercase tracking-tighter whitespace-nowrap select-none"
                        >
                            [SKIP 0B]
                        </span>
                    ) : readOnly && pickerActive ? (
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
                    ) : usage ? (
                        // 第 14 单：定长文本用量徽标（n/N CHARS|BYTES；超定长 =
                        // 编码端截断 → 琥珀警示，优先于通用长度徽标）
                        <span
                            className={`text-[9px] font-black uppercase tracking-tighter whitespace-nowrap select-none ${usage.over ? 'text-[#E58D28]' : 'text-[#4a4a4a]/60'}`}
                            title={usage.over
                                ? `超定长 ${usage.total}（${usage.unit === 'BYTES' ? '字节' : '字符'}）：编码端截断到 ${usage.total}，当前 ${usage.used}`
                                : `定长 ${usage.total} ${usage.unit === 'BYTES' ? '字节' : '字符'}，已用 ${usage.used}`}
                        >
                            {usage.used}/{usage.total} {usage.unit}
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
