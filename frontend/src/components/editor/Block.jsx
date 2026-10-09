import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { OP_CODES } from '../../constants';
import { formatOffset } from '../../utils/byteOffsets';
import { formatUnknown } from '../../utils/formula';
import { packBits, formatBinaryBytes, buildStripLayout, BIT_GRID_COLORS } from '../../utils/bitGrid';
import { padSpec } from '../../utils/padSpec';

export default function Block({ id, label, name, byte_length, byte_len, bit_len, type, op_code, hex_value, parameter_config, bits, isSelected, isPickMode, isPickRef, isGroupActive, offsetMeta, bitView = false, bitMeta = null, issue = null, onClick }) {
    // Normalize Props (Backend v4 vs v3)
    const displayLabel = name || label || 'BLOCK';
    const length = byte_len || byte_length || 1;
    const effectiveHex = hex_value || parameter_config?.hex;
    // 人工验证第 3 轮 #2: 未配置固定块（含全 0 默认占位）也显示存储值
    // （`0000`→`00 00`）—— ?? 仅限无法确定内容的卡；编码字节契约不变。

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
    // 依赖 op_code 显式相等：OP_CODES.STRUCT 曾缺键导致 undefined===undefined
    // 对协议块（无 op_code）恒真——全部被误判成组卡（反馈 #1 根因，常量已补键）。
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

    // R69（返工终拍 B）：位域卡面 = 泳道式多卡 —— 泳道头（段数 chip + 总览
    // 位带）+ 泳道体（实线带，每段一张独立卡：色块 + 段名 + 位宽 + 段 0/1
    // 值），缺块占一张 GAP 卡；根去卡壳、与 hex 容器泳道虚线泳道区分；图例与
    // 整行值流删除（段卡即图例、段值即值流）。纯展示层：packBits 打包口径
    // 零触碰（镜像测试在 bitGrid.test.js），后端 bitfield.py 与编码器无感；
    // 段名 break-all 不截断（段卡换行变高，不丢名）。
    const isBitfield = type === 'bitfield';
    // R70（§8.102）位真：声明 bit_len（真实 bit 数）→ 打包到 ceil(bit_len/8) 字节、
    // 位带容量 = bit_len（10bit 头画 10 格 + 尾部 PAD，所见即所得）；否则回落
    // byte_length×8（既有口径零触碰）。
    const bitLenRaw = Number(bit_len);
    const bitLen = Number.isInteger(bitLenRaw) && bitLenRaw > 0 ? bitLenRaw : 0;
    const bitFace = React.useMemo(() => {
        if (!isBitfield) return null;
        const packTarget = bitLen ? Math.ceil(bitLen / 8) : length;
        const packed = packBits(bits, packTarget);
        const binBytes = formatBinaryBytes(packed);
        const strip = buildStripLayout(bits, packTarget, 'msb', bitLen);
        // 独立子卡：位带单位逐张出卡 —— 段卡 = 色块 + 段名 + 位宽 + 段 0/1
        // 值（msb 视角序、半字节分组，与打包值同源逐位展开），缺块单元也占
        // 一张；digit 从打包值串尾取（bit0 = LSB = 串尾），超出打包宽度显 0。
        const packedBin = binBytes.join('').replace(/\s/g, '');
        const digit = (bit) => {
            const i = packedBin.length - 1 - bit;
            return i >= 0 && i < packedBin.length ? packedBin[i] : '0';
        };
        const group4 = (v) => v.replace(/(.{4})/g, '$1 ').trim();
        const subs = strip.units.map((u, ui) => ({
            key: ui,
            kind: u.kind,
            name: u.kind === 'seg' ? (u.name || '(未命名)') : null,
            color: u.conflict ? '#D94834' : u.color,
            conflict: !!u.conflict,
            len: u.bits.length,
            value: group4(u.bits.map(digit).join('')),
        }));
        return { packed, binBytes, strip, subs };
    }, [isBitfield, bits, length, bitLen]);

    // Footer byte length: trust byteOffsets when the ruler is wired (accurate
    // "??B" for unknown instead of the legacy `|| 1` guess); fall back to the
    // legacy display when no offsets were passed (e.g. Orchestration page).
    // R70（§8.102 三 · 自适应位视图）：含 sub-byte/bit 定义帧（bitView=true）→
    // footer 切 bit 单位（偏移尺 bit 刻度：宽 `10b`、偏移 `@b0`）；纯字节帧
    // bitView=false 沿原字节口径 `2B @00` 零扰动。
    const footerBytes = bitView && bitMeta
        ? `${bitMeta.bitWidth}b`
        : offsetMeta
            ? (typeof offsetMeta.size === 'number' ? `${offsetMeta.size}B` : '??B')
            : (isGroupCard ? '' : `${length}B`);
    const offsetStr = bitView && bitMeta
        ? `@b${bitMeta.bitOffset}`
        : offsetMeta ? formatOffset(offsetMeta) : '';
    // R70（自适应位视图）：tooltip 随视图切 —— 位视图标「bit 偏移 N」，字节视图标
    // 「字节偏移 0xN」（渲染 title 引用；byte 视图 offsetMeta 缺席时 span 不渲染，title 不可见）。
    const offsetTitle = bitView && bitMeta
        ? `bit 偏移 ${bitMeta.bitOffset}`
        : `字节偏移 ${offsetMeta?.offset == null ? '未知（前序块长度动态）' : `0x${offsetMeta.offset.toString(16).toUpperCase()}`}`;

    // P1 smart width: byte-extent driven (group = Σ children via offsetMeta,
    // leaf = byte_len) with a content-aware floor so the footer
    // (`2B @00` / `??B @02..` + OPEN) never gets clipped by the next card.
    // N5 (G4): pad（归属本卡的填充字节 = 自身 pad_to + 下一字段 align 前置 pad
    // + 组内子字段 pad）计入宽度 → 卡片跨度与偏移尺 @ 芯片逐格对齐，卡间空隙
    // 即填充字节；无 pad 配置时 padBytes=0，宽度语义逐字节不变。
    const padBytes = offsetMeta && typeof offsetMeta.pad === 'number' ? offsetMeta.pad : 0;
    const extentBytes = (isGroupCard
        ? (offsetMeta && typeof offsetMeta.size === 'number' ? offsetMeta.size : 0)
        : length) + padBytes;
    const footerText = [footerBytes, offsetStr, isBitfield && bitFace ? `0x${bitFace.packed}` : null].filter(Boolean).join(' ');
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
    // 验证标色角标（⛔/⚠ 芯片）约占 26px，与标签/页脚同吃宽度地板
    const issueNeed = issue ? 26 : 0;
    // N3 (G1): 条件存在 IF 角标 —— presence 配置即点亮（Block 自读
    // parameter_config.presence，零 prop 传递；非法非对象/数组与编码
    // fail-open 同口径不点亮）。宽度地板与 issue chip 同口径（26px）。
    const presenceCfg = parameter_config?.presence;
    const presenceChip = !!(presenceCfg && typeof presenceCfg === 'object' && !Array.isArray(presenceCfg));
    const presenceNeed = presenceChip ? 26 : 0;
    // N5 (G4): 对齐/填充角标 —— Block 自读 parameter_config.align / pad_to
    // （归一复用 utils/padSpec，与编码 fail-open 同口径：非法不点亮），一枚
    // 角标显示 A{N} / P{N} / A4·P8；title 说明补位语义。画布上「卡片间空隙」
    // 即填充字节（宽度 = 内容 + 归属 pad，与偏移尺 @ 芯片逐格对齐）。
    const padCfg = padSpec(parameter_config);
    const padChip = padCfg.align > 0 || padCfg.padTo > 0;
    const padText = [
        padCfg.align > 0 ? `A${padCfg.align}` : null,
        padCfg.padTo > 0 ? `P${padCfg.padTo}` : null,
    ].filter(Boolean).join('·');
    const padTitle = [
        padCfg.align > 0 ? `对齐：内容起点补位到 ${padCfg.align} 字节边界` : null,
        padCfg.padTo > 0 ? `填充：内容末尾补位到 ${padCfg.padTo} 字节边界` : null,
    ].filter(Boolean).join('；');
    const padNeed = padChip ? Math.ceil(padText.length * 5.4) + 8 : 0;
    // R69: 位域泳道地板 —— 泳道体每行至多 4 张段卡（88px + 间距 6），泳道头
    // 段数 chip 与总览位带同宽嵌行不另占需求；+30 = 根 p-2 内缩 + 泳道体 p-1.5。
    // 非位域卡不参与（既有 60px 地板 / 字节驱动宽度语义逐字节不变）。
    const lanePerRow = bitFace ? Math.max(1, Math.min(bitFace.subs.length, 4)) : 0;
    const laneBodyNeed = bitFace ? lanePerRow * 88 + (lanePerRow - 1) * 6 + 30 : 0;
    const contentMin = Math.max(footerNeed, labelPx, baseNeed, issueNeed, presenceNeed, padNeed, laneBodyNeed) + 20; // card padding + safety margin

    // 验证反馈批次：校验标色 —— 错误红 / 提醒琥珀（与属性面板同色系）。
    // 内联 borderColor 优先于主题类；选中态（3px 亮边）与拾取态让位，角标不受影响。
    const issueColor = issue?.level === 'error' ? '#D94834'
        : issue?.level === 'warning' ? '#E58D28' : null;

    const style = {
        transform: CSS.Transform.toString(transform),
        // Inline `transition` overrides the Tailwind `transition-colors` class, so
        // compose everything we want animated: strategy transforms (drag avoidance),
        // width (live byte_len preview), and theme/hover colors.
        transition: transition
            ? `${transition}, width 200ms ease, background-color 200ms ease, border-color 200ms ease`
            : transition,
        width: `${Math.max(60, extentBytes * 40, contentMin)}px`, // Smart width: byte extent + content floor
        ...(issueColor && !isSelected && !isPickMode ? { borderColor: issueColor } : {}),
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
            // R27（§8.59）: cobs 是结构/组帧元素（可嵌套包子树）→ 与容器同深色，
            // 不与 fixed 的浅色字面块混淆。
            'length', 'checksum', 'container', 'group', 'cobs'
        ].includes(op);

        // R69 返工终拍 B：位域卡 = 泳道式多卡 —— 根去卡壳（透明无框，泳道头/
        // 体与段卡自己成卡；选中/拖拽/拾取态描边仍由 getClasses 叠加），与 hex
        // 容器泳道（border-dashed + 外置标题 + FOCUS）视觉区分。
        if (type === 'bitfield') return 'border-transparent bg-transparent text-nier-light';

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
                base += "border-dashed border-nier-light/50 text-muted hover:bg-orange-200 hover:border-nier-light cursor-alias ";
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
    // deps 按「真正参与计算的字段」手动收敛（只用 offsetMeta.size，不是整个 offsetMeta）。
    const displayValue = React.useMemo(() => {
        // 1. Injected computed value wins: group/container content concat
        //    (lanes 注入的嵌套内容串) or formula engine result.
        if (parameter_config?.computedValue !== undefined) {
            return parameter_config.computedValue;
        }

        // N2 (G2): 文本字段 —— 卡面显原文（value/default），空串显空白；无静态
        // 值或带 hex 的回落既有分支（?? 占位与协议 hex 现状不迁移）。
        if ((op_code === 'STRING' || parameter_config?.type === 'string') && !effectiveHex) {
            const text = parameter_config?.value ?? parameter_config?.default;
            if (text !== undefined && text !== null) return String(text);
        }

        // Special Case: Nested Group — 中央值 = 嵌套内容逐块拼接（已知出 hex、
        // 未知出等量 ??）；内容未注入但尺寸已知 → 按尺寸出等量 ??（页脚仍
        // 显示 `4B @00` 尺寸口径）；空容器（size 0）中央 = 空白——不显 ?? 也
        // 不显 `0B`（人工验证第 3 轮 #2）；尺寸未知 → "??"。
        if (isGroupCard) {
            if (offsetMeta && typeof offsetMeta.size === 'number') {
                if (offsetMeta.size === 0) return ''; // 空容器中央 = 空白
                // 未注入真值 → 按尺寸出等量 ??（长度不是取值）。
                return formatUnknown(offsetMeta.size);
            }
            return "??"; // User Request: Show ?? when undeterminable
        }

        // 2. If it's a HEX block with manual value
        // FIX: Also check OP_CODE because 'type' might not be 'hex' for raw blocks
        // A+B: 协议 fixed 块的 hex_value 也上卡（原条件 type==='hex' 协议永不
        // 命中 → 属性面板改 hex 卡片零反馈）；无 hex_value 时保持默认占位。
        // 人工验证第 3 轮 #2: 未配置固定块照显存储值（0000→00 00、00→00），
        // 撤「全 0 = 未配置 → ??」回退；?? 只留无 hex / 非法 hex 的卡。
        if ((type === 'hex' || type === 'fixed' || op_code === 'HEX_RAW') && effectiveHex) {
            // Format "AA55" to "AA 55"
            return effectiveHex.replace(/\s/g, '').match(/.{1,2}/g)?.join(' ').toUpperCase() || effectiveHex;
        }

        // 2.5 协议设计期长度/校验域无公式可算 → 对齐指令页 LENGTH_CALC/
        // CHECKSUM 的 "??" 口径（运行期才有真值），按字节数出等量占位，
        // 替代误导性 00 占位。
        if (type === 'length' || type === 'checksum') return formatUnknown(length);

        // 2.6 批 4: 位域块 —— 卡面显示位段打包后的真实字节（与编码期同口径，
        // packBits 镜像后端 handlers/bitfield.py），而不是 hex_value。
        if (type === 'bitfield') {
            const packed = packBits(bits, length);
            return packed.match(/.{1,2}/g)?.join(' ') || packed;
        }

        // 3. Default: 未配置/不确定 → 按字节数出等量 ??（反馈 #1：不再用
        // 误导性 "00" 填充冒充取值）。
        return formatUnknown(length);
        // deps 已按「真正参与计算的字段」手动收敛（只用到 offsetMeta.size，不是整个
        // offsetMeta）；补成全量会让卡面 memo 每次渲染失效 → 渲染数上升。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [type, effectiveHex, length, parameter_config?.computedValue, op_code, isGroupCard, offsetMeta?.size, bits, parameter_config?.value, parameter_config?.default]);

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
                <span className="flex items-center gap-1 shrink-0">
                    {/* Visual indicator for Group — isGroupMark 与宽度地板同源
                        （协议容器经 offsetMeta.isGroup 点亮，指令组走 op_code） */}
                    {isGroupMark && <span className="opacity-50 shrink-0">::</span>}
                    {/* N3 (G1): 条件存在 —— presence 角标（title 显判定式，
                        缺省位 `?` 对应 fail-open 的不完整配置，与面板/校验同语义） */}
                    {presenceChip && (
                        <span
                            data-presence-chip
                            title={`条件字段：[${presenceCfg.ref_id ?? '?'}] == ${presenceCfg.expect ?? '?'}`}
                            className="text-[9px] leading-none px-1 border border-nier-light/70 text-nier-light font-bold shrink-0"
                        >
                            IF
                        </span>
                    )}
                    {/* N5 (G4): 对齐/填充角标 —— A{align} / P{pad_to}（非法值与
                        编码 fail-open 同口径不点亮）；卡片间空隙即填充字节 */}
                    {padChip && (
                        <span
                            data-pad-chip
                            title={padTitle}
                            className="text-[9px] leading-none px-1 border border-nier-light/70 text-nier-light font-bold shrink-0"
                        >
                            {padText}
                        </span>
                    )}
                    {/* 验证反馈批次：校验标色角标 —— title 悬停显全量消息（与面板清单同文） */}
                    {issue && (
                        <span
                            data-issue-chip={issue.level}
                            title={issue.messages.join('\n')}
                            className={`text-[9px] leading-none px-1 font-bold shrink-0 ${issue.level === 'error'
                                ? 'bg-[#D94834] text-black'
                                : 'bg-[#E58D28] text-black'}`}
                        >
                            {issue.level === 'error' ? '⛔' : '⚠'}
                        </span>
                    )}
                </span>
            </div>

            {/* Bitfield lane — R69 返工终拍 B：位域卡 = 泳道式多卡（根去卡壳）
                —— 泳道头（段数 chip + 总览位带，头内嵌）+ 泳道体（实线窄带，
                每段一张独立卡、缺块一张 GAP 卡），与 hex 容器泳道（虚线 + 外置
                标题 + FOCUS）区分；值流/图例删除；hex 打包值留页脚小字。 */}
            {isBitfield ? (
                <div className="flex-1 flex flex-col gap-1 w-full" data-card-lane="true">
                    {/* 泳道头：段数 chip + 总览位带（内嵌行，区别于泳道外置标题） */}
                    <div className="flex items-center gap-1.5 w-full" data-card-lane-head="true">
                        <span
                            className="text-[8px] font-mono tracking-widest px-1 border border-nier-light/25 shrink-0 opacity-80"
                            title={`位段泳道 · ${bitFace.subs.length} 片（段 + 缺块）`}
                        >
                            {`BITS·${bitFace.subs.length}`}
                        </span>
                        <div className="flex flex-1 h-1.5 border border-nier-light/30 min-w-[40px]" data-card-strip="true">
                            {bitFace.strip.units.map((u, ui) => (u.kind === 'gap' ? (
                                <div key={`cg-${ui}`} className="flex" style={{ flexGrow: u.bits.length }}>
                                    {u.bits.map(bit => (
                                        <div key={bit} data-card-strip-gap={bit} className="flex-1 bg-nier-light/5" />
                                    ))}
                                </div>
                            ) : (
                                <div
                                    key={`cs-${ui}`}
                                    data-card-strip-seg={u.owner}
                                    data-conflict={u.conflict ? 'true' : undefined}
                                    className="flex-1 border border-nier-dark/40"
                                    style={{ flexGrow: u.bits.length, backgroundColor: u.conflict ? '#D94834' : u.color }}
                                />
                            )))}
                        </div>
                    </div>

                    {/* 泳道体：实线窄带 + 浅底（区分 hex 容器泳道的虚线大框），
                        每段一张独立卡（色块 + 段名 + 段 0/1 值 + 位宽），缺块占
                        一张 GAP 虚线卡；段名 break-all 不截断、卡随行伸展。 */}
                    <div
                        className="flex flex-wrap gap-1.5 p-1.5 w-full border border-nier-light/25 bg-nier-light/5"
                        data-card-lane-body="true"
                    >
                        {bitFace.subs.map((t, i) => (t.kind === 'gap' ? (
                            <div
                                key={`sg-${t.key}`}
                                data-card-seg-gap={i}
                                className="flex flex-col gap-0.5 border border-dashed border-nier-light/25 px-2 py-1.5 min-w-[88px] grow opacity-60"
                                title="未覆盖位（缺块）"
                            >
                                <span className="text-[8px] font-mono tracking-wider">GAP</span>
                                <span className="text-[11px] font-bold font-mono leading-tight">{t.value}</span>
                                <span className="text-[8px] font-mono opacity-60">{t.len}b</span>
                            </div>
                        ) : (
                            <div
                                key={`ss-${t.key}`}
                                data-card-seg={i}
                                className="flex flex-col gap-0.5 border border-nier-light/30 bg-nier-dark px-2 py-1.5 min-w-[88px] grow"
                                style={t.conflict ? { borderColor: '#D94834' } : undefined}
                                title={t.name}
                            >
                                <span className="flex items-center gap-1 min-w-0">
                                    <span
                                        data-card-seg-chip={i}
                                        className="w-2.5 h-2.5 shrink-0 border border-nier-dark/50"
                                        style={{ backgroundColor: t.color }}
                                    />
                                    <span
                                        className="text-[9px] font-mono min-w-0 break-all"
                                        style={t.conflict ? { color: '#D94834' } : undefined}
                                    >{t.name}</span>
                                </span>
                                <span data-card-seg-val={i} className="text-[11px] font-bold font-mono leading-tight">{t.value}</span>
                                <span className="text-[8px] font-mono opacity-60">{t.len}b</span>
                            </div>
                        )))}
                    </div>
                </div>
            ) : (
                <div className="flex-1 flex items-center justify-center text-sm font-bold font-mono break-all text-center leading-tight overflow-hidden px-1">
                    {displayValue}
                </div>
            )}

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
                        <span className="font-mono" title={offsetTitle}>
                            {offsetStr}
                        </span>
                    )}
                    {/* R69: hex 打包值降为页脚小字（卡面已让位给泳道段卡） */}
                    {isBitfield && (
                        <span data-card-hex="true" className="font-mono" title="位段打包值（十六进制）">0x{bitFace.packed}</span>
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
