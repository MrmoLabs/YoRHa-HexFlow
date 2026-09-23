import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { OP_CODES } from '../../constants';
import { formatOffset } from '../../utils/byteOffsets';
import { formatUnknown } from '../../utils/formula';

export default function Block({ id, label, name, byte_length, byte_len, type, op_code, hex_value, parameter_config, children, isSelected, isPickMode, isPickRef, isGroupActive, offsetMeta, onClick }) {
    // Normalize Props (Backend v4 vs v3)
    const displayLabel = name || label || 'BLOCK';
    const length = byte_len || byte_length || 1;
    const effectiveHex = hex_value || parameter_config?.hex;

    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id });

    // P1 optim: a group shows its COMPUTED total (Σ children, sourced from
    // byteOffsets via offsetMeta) instead of a hard-coded "??" — "??" stays
    // only for a genuinely unknown size (some child byte_len missing).
    const isGroupCard = op_code === OP_CODES.ARRAY_GROUP || op_code === OP_CODES.STRUCT || offsetMeta?.isGroup === true;

    // TIME_ACCUMULATOR：基准时间必须第一时间可见（BASE 小字，中央值下方）。
    // 未配置 → `BASE ?`；配置值规整到 `YYYY-MM-DD HH:mm`（ISO T 分隔与秒位
    // 剥除），已是目标格式则原样直出。判定对齐 getThemeStyle 的 op 取链。
    const timeOp = op_code || parameter_config?.op_code;
    const isTimeAccum = timeOp === OP_CODES.TIME_ACCUMULATOR || type === 'time_cumulative';
    const baseTimeStr = React.useMemo(() => {
        const raw = parameter_config?.base_time;
        if (!raw) return null;
        const s = String(raw).replace('T', ' ');
        return s.length > 16 ? s.slice(0, 16) : s;
    }, [parameter_config?.base_time]);
    const baseLineText = `BASE ${baseTimeStr || '?'}`;

    // Footer byte length: trust byteOffsets when the ruler is wired (accurate
    // "??B" for unknown instead of the legacy `|| 1` guess); fall back to the
    // legacy display when no offsets were passed (e.g. Orchestration page).
    const footerBytes = offsetMeta
        ? (typeof offsetMeta.size === 'number' ? `${offsetMeta.size}B` : '??B')
        : (isGroupCard ? '' : `${length}B`);
    const offsetStr = offsetMeta ? formatOffset(offsetMeta) : '';

    // P1 smart width: byte-extent driven (group = Σ children via offsetMeta,
    // leaf = byte_len) with a content-aware floor so the footer
    // (`2B @00` / `??B @02..` + OPEN) never gets clipped by the next card.
    const extentBytes = isGroupCard
        ? (offsetMeta && typeof offsetMeta.size === 'number' ? offsetMeta.size : 0)
        : length;
    const footerText = [footerBytes, offsetStr].filter(Boolean).join(' ');
    // Label floor: 名称必须单行完整显示（不截断、不换行）→ 卡片宽度必须容纳
    // 标签。10px + tracking-widest ≈ CJK 11.5px / latin 8px 每字符（含估算安全
    // 量）；组卡另加 `::` 指示位。header 与 footer 分属两行 → 取较大值（非求和），
    // 短名称不触发（字节驱动宽度语义与 60px 地板保持不变）。
    // `::` 判定（与 header 渲染同源）：op_code 组，或偏移标尺判组——协议容器
    // 无 op_code，经 computeProtocolOffsets 的 isGroup 点亮（宽度地板须同步）。
    const isGroupMark = op_code === 'ARRAY_GROUP' || offsetMeta?.isGroup === true;
    const labelPx = Math.ceil(
        [...displayLabel].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? 11.5 : 8), 0)
        + (isGroupMark ? 18 : 0) // `::` + gap-1
        + 6                      // estimate safety margin
    );
    const footerNeed = Math.ceil(footerText.length * 5.4) // 9px monospace ≈ 5.4px/char
        + (isGroupActive ? 26 : 0);            // OPEN marker + gap
    // BASE 行地板：TIME 卡的 `BASE 2026-09-23 14:00`（8px mono ≈ 4.8px/char）
    // 单行放不下会折行，宽度须容纳（与 footer/label 同属取较大值口径）。
    const baseNeed = isTimeAccum ? Math.ceil(baseLineText.length * 4.8) + 8 : 0;
    const contentMin = Math.max(footerNeed, labelPx, baseNeed) + 20; // card padding + safety margin

    const style = {
        transform: CSS.Transform.toString(transform),
        // Inline `transition` overrides the Tailwind `transition-colors` class, so
        // compose everything we want animated: strategy transforms (drag avoidance),
        // width (live byte_len preview), and theme/hover colors.
        transition: transition
            ? `${transition}, width 200ms ease, background-color 200ms ease, border-color 200ms ease`
            : transition,
        width: `${Math.max(60, extentBytes * 40, contentMin)}px`, // Smart width: byte extent + content floor
    };

    // Style Mapping: Based on Information Density
    // Light (Beige) = Simple/Static
    // Dark (Charcoal) = Complex/Logic/Structure
    const getThemeStyle = () => {
        // Map op_codes or types to specific styles
        const darkStyle = 'border-nier-light bg-nier-light text-nier-dark font-bold';
        const lightStyle = 'border-nier-light bg-nier-dark text-nier-light';

        // Check top-level op_code first, then nested, then type
        const op = op_code || parameter_config?.op_code || type;

        const isDark = [
            OP_CODES.LENGTH_CALC, OP_CODES.CHECKSUM_CRC, OP_CODES.ARRAY_GROUP,
            'length', 'checksum', 'container', 'group'
        ].includes(op);

        if (isDark) return darkStyle;
        if (type === 'optional') return 'border-dashed border-nier-light text-nier-light opacity-80';
        // 协议插槽 = 下游注入占位：沙底 + 虚线（对齐调色板 SLOT 虚线语义，
        // 与 optional 同族但保留浅色实体底）
        if (type === 'slot') return 'border-dashed border-nier-light bg-nier-dark text-nier-light';

        return lightStyle; // Default to Light (HEX_RAW, CMD, etc)
    };

    const getClasses = () => {
        let base = "min-h-[6rem] h-auto border flex flex-col justify-between p-2 select-none group relative z-10 transition-colors duration-200 ";

        // PICKING MODE VISUALS (Always distinct)
        if (isPickMode) {
            if (isPickRef) {
                base += "bg-orange-300 border-nier-light text-nier-light shadow-[0_0_10px_rgba(253,224,71,0.5)] z-40 cursor-pointer ";
            } else {
                base += "border-dashed border-nier-light/50 text-nier-light/70 hover:bg-orange-200 hover:border-nier-light cursor-alias ";
            }
            if (isSelected) base += "border-2 border-nier-light opacity-50 cursor-default ";
        } else {
            // NORMAL MODE
            base += getThemeStyle();

            // Active Group Indicator (Open Folder State)
            if (isGroupActive) {
                base += " ring-2 ring-nier-light ring-offset-2 ring-offset-nier-dark ";
            }

            if (isSelected) {
                // User Request: Thick border instead of orange ring (Reserve orange for errors)
                base += " z-40 border-[3px] border-nier-light shadow-[0_0_15px_rgba(0,0,0,0.2)] scale-[1.02] ";
            } else {
                base += " hover:brightness-95 cursor-pointer ";
            }
        }

        if (isDragging) base += " opacity-5 z-50 ring-2 ring-white scale-105";

        return base;
    };


    // Logic for display value
    // 卡面取值口径：能确定 → 直接显示（组/容器=嵌套内容拼接串，长度=十进制，
    // HEX=字面 hex）；不确定 → 按字节数出等量 "??"（1B→"??"、2B→"?? ??"），
    // 不再用固定 "??" 或误导性 "00"。
    const displayValue = React.useMemo(() => {
        // 1. Injected computed value wins: group/container content concat
        //    (lanes 注入的嵌套内容串) or formula engine result.
        if (parameter_config?.computedValue !== undefined) {
            return parameter_config.computedValue;
        }

        // Special Case: Nested Group — 中央值 = 嵌套内容逐块拼接（已知出 hex、
        // 未知出等量 ??）；内容未注入但尺寸已知 → 按尺寸出等量 ??（页脚仍
        // 显示 `4B @00` 尺寸口径）；尺寸未知 → "??"。
        if (isGroupCard) {
            if (offsetMeta && typeof offsetMeta.size === 'number') {
                const size = offsetMeta.size;
                return size > 0 ? formatUnknown(size) : '0B';
            }
            return "??"; // User Request: Show ?? when undeterminable
        }

        // 2. If it's a HEX block with manual value
        // FIX: Also check OP_CODE because 'type' might not be 'hex' for raw blocks
        // A+B: 协议 fixed 块的 hex_value 也上卡（原条件 type==='hex' 协议永不
        // 命中 → 属性面板改 hex 卡片零反馈）；无 hex_value 时保持默认占位。
        if ((type === 'hex' || type === 'fixed' || op_code === 'HEX_RAW') && effectiveHex) {
            // Format "AA55" to "AA 55"
            return effectiveHex.replace(/\s/g, '').match(/.{1,2}/g)?.join(' ').toUpperCase() || effectiveHex;
        }

        // 2.5 协议设计期长度/校验域无公式可算 → 对齐指令页 LENGTH_CALC/
        // CHECKSUM 的 "??" 口径（运行期才有真值），按字节数出等量占位，
        // 替代误导性 00 占位。
        if (type === 'length' || type === 'checksum') return formatUnknown(length);

        // 3. Default: "00 " repeated for unknown/unset
        const safeLen = Math.max(1, Math.floor(length));
        return Array(safeLen).fill('00').join(' ');
    }, [type, effectiveHex, length, parameter_config?.computedValue, op_code, isGroupCard, offsetMeta?.size]);

    return (
        <div
            ref={setNodeRef}
            id={`block-${id}`} // DOM reference for Canvas lines
            style={style}
            {...attributes}
            {...listeners}
            className={getClasses()}
            onClick={(e) => {
                e.stopPropagation(); // Prevent parent click
                onClick?.(e);
            }}
        >
            {/* Logic Field Indicators */}
            {isPickRef && (
                <div className="absolute -top-2 -right-2 bg-yellow-400 text-black text-[9px] font-bold px-1 z-50">
                    REF
                </div>
            )}

            {/* Header/Label — 单行完整显示（不截断、不换行）：超长名称由 P1
                content floor 的 labelPx 把卡片宽度撑到容纳标签。 */}
            <div className="text-[10px] tracking-widest uppercase border-b border-current pb-1 mb-1 flex justify-between gap-1">
                <span className="whitespace-nowrap" title={displayLabel}>{displayLabel}</span>
                {/* Visual indicator for Group — isGroupMark 与宽度地板同源
                    （协议容器经 offsetMeta.isGroup 点亮，指令组走 op_code） */}
                {isGroupMark && <span className="opacity-50 shrink-0">::</span>}
            </div>

            {/* Byte Indicator centered */}
            <div className="flex-1 flex items-center justify-center text-sm font-bold font-mono break-all text-center leading-tight overflow-hidden px-1">
                {displayValue}
            </div>

            {/* TIME_ACCUMULATOR 基准时间：中央值下方小字（未配置 → BASE ?） */}
            {isTimeAccum && (
                <div className="text-[8px] font-mono text-center opacity-70 leading-tight break-all px-1">
                    {baseLineText}
                </div>
            )}

            {/* Footer info: byte len + P1 offset ruler (@00 plain / @00.. group / ·· unknown) */}
            <div className="text-[9px] flex justify-between opacity-70 mt-1 w-full min-h-[14px] gap-1">
                <span className="flex gap-1 min-w-0">
                    {/* User Request: bytes before offset (`2B @00`) */}
                    <span>{footerBytes}</span>
                    {offsetMeta && (
                        <span className="font-mono" title={`字节偏移 ${offsetMeta.offset === null ? '未知（前序块长度动态）' : `0x${offsetMeta.offset.toString(16).toUpperCase()}`}`}>
                            {formatOffset(offsetMeta)}
                        </span>
                    )}
                </span>
                {isGroupActive && <span className="text-[8px] animate-pulse">OPEN</span>}
            </div>

            {/* Corner Decors (Nier) */}
            <div className="absolute top-0 right-0 w-1 h-1 bg-current opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="absolute bottom-0 left-0 w-1 h-1 bg-current opacity-0 group-hover:opacity-100 transition-opacity"></div>
        </div>
    );
}
