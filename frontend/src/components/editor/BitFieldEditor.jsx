import React, { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { buildBitGrid, buildStripLayout, rangeToSegment, defaultSegmentName, packBits, formatBinaryBytes } from '../../utils/bitGrid';
import { parseValueTable, formatValueTable, sanitizeValueTable } from '../../utils/bitMeta';

/**
 * BITFIELD 位域布局编辑器
 * 编辑字段级别的 bits 数组：[{ id, sequence, bit_name, start_bit, bit_len, default_val }]
 * 存储约定：start_bit 以“整字段的位偏移”计算，bit 0 为最低有效位 (LSB)。
 *
 * 批 2：上方加位网格（byte×8，bit0 在右 = LSB 口径）——
 *  - 点击式设段：点起始格上膛 → 点终止格提交 { start_bit, bit_len }
 *  - 点已有位段的格子 = 选中该段（与下方表格行双向联动）
 *  - 重叠位红标、溢出位段照常渲染（容量告警另由 requiredBytes 表达）
 * 打包预览走 bitGrid.packBits（与编码器同口径，见其镜像测试）。
 *
 * R68：默认主视图改为「连续位带拼图条」（一条横向带 = 整字段）——
 *  - 段 = 带名带宽角标的拼图块，间隙 = 逐位虚线缺块（点即补段）；
 *  - msb 视角（文档阅读序，高位在左，默认）/ lsb 视角（存储序）可切；
 *  - 字节边界竖线 + 连续位号标尺；拖拽画段、拖两端柄改宽、双击段名内联改名；
 *  - 旧 byte×8 网格降为切换副视图（视图按钮），批 2 契约原样保留。
 * 存储口径（start_bit LSB）、打包、校验零触碰；两视图共享 bitGrid 纯函数层。
 */
const emptyBit = (sequence) => ({
    id: uuidv4(),
    sequence,
    bit_name: '',
    start_bit: 0,
    bit_len: 1,
    default_val: 0
});

const findOverlaps = (bits) => {
    const occupied = new Map(); // bitIndex -> bit_name
    const conflicts = new Set();
    bits.forEach((b) => {
        const start = Number(b.start_bit) || 0;
        const len = Math.max(1, Number(b.bit_len) || 1);
        for (let i = start; i < start + len; i++) {
            if (occupied.has(i)) {
                conflicts.add(b.id);
                conflicts.add(occupied.get(i));
            } else {
                occupied.set(i, b.id);
            }
        }
    });
    return conflicts;
};

/**
 * R69：默认值录入解析（纯函数）—— 0b 前缀二进制（Wireshark/010 惯例）或十进制。
 *  - '0b1010' / '0B1010' → 10（大小写不敏感，仅 [01] 才算合法二进制）
 *  - '0x1F' / '0X1f' → 31（R70 ④：多 bit 字段值切 HEX 录入，与 0b 并存，[0-9a-f]）
 *  - '-40' / '12' → 十进制（既有 number 输入口径迁移）
 *  - ''（清空）→ null，调用方按旧口径写回 minVal
 *  - '0b' 半截 / 垃圾 → null，调用方不写回（草稿缓冲，不发半截值）
 */
const parseBitDefaultInput = (text) => {
    const t = String(text ?? '').trim();
    if (/^0b[01]+$/i.test(t)) return parseInt(t.slice(2), 2);
    if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16); // R70 ④：HEX 录入
    if (t === '') return null;
    if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
    return null;
};

export default function BitFieldEditor({ bits, byteLen = 1, bitLen = 0, onUpdateBits }) {
    const list = Array.isArray(bits) ? bits : [];
    const conflicts = findOverlaps(list);

    // 批 2：位网格 + 点击式设段（上膛起点）+ 选中段（与表格行联动）
    const [armedBit, setArmedBit] = useState(null);
    const [selectedIndex, setSelectedIndex] = useState(null);
    // R70（§8.102）：bitLen = 声明真实 bit 数（位真容量，grid/strip 同口径；
    // 未声明/非法 → 0，回落 byteLen×8 既有口径）。
    const bitCap = Number.isInteger(Number(bitLen)) && Number(bitLen) > 0 ? Number(bitLen) : 0;
    const grid = buildBitGrid(list, byteLen, bitCap);

    // R68：连续位带拼图条（默认主视图）。存储口径零触碰，纯展示/交互层：
    //  - stripView：strip（默认拼图条）/ grid（批 2 网格副视图）
    //  - orient：msb 文档阅读序（高位在左）/ lsb 存储序（bit0 在左）
    //  - stripArm 跨点击持久的上膛区间；stripDrag 按住期间的作画会话
    //  - stripResize 拖柄改宽会话（start = LSB 侧、end = MSB 侧，与视角无关）
    const [stripView, setStripView] = useState('strip');
    const [orient, setOrient] = useState('msb');
    const [stripArm, setStripArm] = useState(null);
    const [stripDrag, setStripDrag] = useState(null);
    const [stripResize, setStripResize] = useState(null);
    const [stripRename, setStripRename] = useState(null);
    // R69：默认值输入本地草稿 —— 0b 前缀录入不被受控回写打断（'0b' 半截时
    // 不写回、显示保持草稿原文）；blur 清草稿回显十进制定值。
    const [defaultDraft, setDefaultDraft] = useState(null); // { idx, text } | null
    const strip = buildStripLayout(list, byteLen, orient, bitCap);

    const update = (index, patch) => {
        const next = list.map((b, i) => (i === index ? { ...b, ...patch } : b));
        onUpdateBits(next);
    };

    const remove = (index) => {
        onUpdateBits(list.filter((_, i) => i !== index));
        if (selectedIndex === index) setSelectedIndex(null);
    };

    const add = () => {
        // 新位段默认接在当前最高位之后
        onUpdateBits([...list, emptyBit(list.length)]);
    };

    // 格子点击：占用格 = 选中该段（并清上膛）；空格 = 上膛/提交位段
    const handleCellClick = (cell) => {
        if (cell.owner >= 0) {
            setSelectedIndex(cell.owner);
            setArmedBit(null);
            return;
        }
        if (armedBit === null) {
            setArmedBit(cell.bitIndex);
            return;
        }
        const range = rangeToSegment(armedBit, cell.bitIndex);
        setArmedBit(null);
        if (!range) return;
        onUpdateBits([...list, { ...emptyBit(list.length), ...range, bit_name: defaultSegmentName(range.start_bit) }]);
    };

    // ── R68 位带交互（提交与批 2 网格同口径：emptyBit + rangeToSegment） ──
    const inArm = (bit) => stripArm !== null
        && bit >= Math.min(stripArm.from, stripArm.hover)
        && bit <= Math.max(stripArm.from, stripArm.hover);

    const commitStripSegment = (from, to) => {
        const range = rangeToSegment(from, to);
        setStripArm(null);
        if (!range) return;
        onUpdateBits([...list, { ...emptyBit(list.length), ...range, bit_name: defaultSegmentName(range.start_bit) }]);
    };

    // 缺块按下：首击上膛；已上膛则把终点接到新格（拖拽与两下设段同一状态轨）。
    // 状态机走 mousedown/mouseup（真浏览器一次点击 = 完整按下松开序列）；
    // 测试侧同构（press = mouseDown + mouseUp），单一提交路径无双轨。
    const onStripGapDown = (bit) => {
        setStripDrag((d) => d || { hadArm: stripArm !== null });
        setStripArm((a) => (a ? { ...a, hover: bit } : { from: bit, hover: bit }));
    };

    // 按住划过任一位（缺块/段内位）：更新拖拽区间或改宽目标位
    const onStripHover = (bit) => {
        if (stripDrag) setStripArm((a) => (a ? { ...a, hover: bit } : a));
        if (stripResize) setStripResize((r) => (r ? { ...r, target: bit } : r));
    };

    // 点段（含段内冒泡）= 选中该段（表格行联动，网格上膛同清）
    const onStripSegDown = (owner) => {
        setSelectedIndex(owner);
        setArmedBit(null);
    };

    // 拖柄起手：end = MSB 侧边界、start = LSB 侧边界（存储语义，视角无关）
    const onStripEdgeDown = (e, idx, edge) => {
        e.stopPropagation();
        const b0 = list[idx] || {};
        const s0 = Number(b0.start_bit) || 0;
        const l0 = Math.max(1, Number(b0.bit_len) || 1);
        setStripResize({ idx, edge, target: edge === 'end' ? s0 + l0 - 1 : s0 });
    };

    // 带上松开：改宽会话先提交；画段仅在「已上膛的第二击」或「拖过头」时提交
    const onStripMouseUp = () => {
        if (stripResize) {
            const { idx, edge, target } = stripResize;
            setStripResize(null);
            const b0 = list[idx] || {};
            const s0 = Number(b0.start_bit) || 0;
            const l0 = Math.max(1, Number(b0.bit_len) || 1);
            const end0 = s0 + l0 - 1;
            let start = s0;
            let end = end0;
            if (edge === 'end') end = Math.min(Math.max(Number(target), s0), strip.capacity - 1);
            else start = Math.max(Math.min(Number(target), end0), 0);
            if (start === s0 && end === end0) return; // 无变化不写回（免得空转保存）
            onUpdateBits(list.map((b, i) => (i === idx ? { ...b, start_bit: start, bit_len: end - start + 1 } : b)));
            return;
        }
        if (!stripDrag) return;
        const had = stripDrag.hadArm;
        setStripDrag(null);
        if (!stripArm) return;
        if (had || stripArm.hover !== stripArm.from) commitStripSegment(stripArm.from, stripArm.hover);
    };

    const totalDefault = packBits(list, grid.requiredBytes || 1);
    // R69: 打包 hex → 逐位 0/1（bit0 = LSB = 串尾；超出打包宽度的位显 0）
    const defaultBin = formatBinaryBytes(totalDefault).join('').replace(/\s/g, '');
    const digitOf = (bit) => {
        const i = defaultBin.length - 1 - bit;
        return i >= 0 && i < defaultBin.length ? defaultBin[i] : '0';
    };

    return (
        <div className="flex flex-col gap-2 border border-dashed border-nier-light/50 p-2 space-y-2">
            <div className="flex justify-between items-center">
                <div className="text-[9px] font-bold text-nier-light">位域布局 (BIT LAYOUT)</div>
                <div className="flex items-center gap-1">
                    {/* R68 视图切换：位带（默认拼图条）/ 网格（批 2 byte×8 副视图） */}
                    <div className="flex border border-nier-light/30">
                        <button
                            type="button"
                            data-view-btn="strip"
                            onClick={() => setStripView('strip')}
                            title="连续位带（拼图条）"
                            className={`text-[8px] px-1.5 py-0.5 transition-colors ${stripView === 'strip' ? 'bg-nier-light text-nier-dark' : 'opacity-60 hover:opacity-100'}`}
                        >
                            位带
                        </button>
                        <button
                            type="button"
                            data-view-btn="grid"
                            onClick={() => setStripView('grid')}
                            title="byte×8 网格（批 2 副视图）"
                            className={`text-[8px] px-1.5 py-0.5 transition-colors ${stripView === 'grid' ? 'bg-nier-light text-nier-dark' : 'opacity-60 hover:opacity-100'}`}
                        >
                            网格
                        </button>
                    </div>
                    {stripView === 'strip' && (
                        <div className="flex border border-nier-light/30">
                            <button
                                type="button"
                                data-orient-btn="msb"
                                onClick={() => setOrient('msb')}
                                title="文档阅读序：高位在左"
                                className={`text-[8px] px-1.5 py-0.5 transition-colors ${orient === 'msb' ? 'bg-nier-light text-nier-dark' : 'opacity-60 hover:opacity-100'}`}
                            >
                                MSB←
                            </button>
                            <button
                                type="button"
                                data-orient-btn="lsb"
                                onClick={() => setOrient('lsb')}
                                title="存储序：bit0 在左"
                                className={`text-[8px] px-1.5 py-0.5 transition-colors ${orient === 'lsb' ? 'bg-nier-light text-nier-dark' : 'opacity-60 hover:opacity-100'}`}
                            >
                                LSB→
                            </button>
                        </div>
                    )}
                    <button
                        onClick={add}
                        className="text-[9px] bg-nier-light/10 hover:bg-nier-light hover:text-nier-dark px-2 py-0.5 transition-colors border border-nier-light/30"
                    >
                        + ADD BIT
                    </button>
                </div>
            </div>

            {/* R68：连续位带拼图条（默认主视图）—— 段 = 带名带色拼图块，间隙 =
                逐位虚线缺块，字节边界竖线 + 连续位号标尺。存储口径不变。 */}
            {stripView === 'strip' && (
                <div
                    className="border border-nier-light/20 p-1 flex flex-col gap-1"
                    data-strip="true"
                    data-strip-view={orient}
                    onMouseUp={onStripMouseUp}
                >
                    <div className="flex items-center justify-between text-[8px] opacity-60 uppercase tracking-widest">
                        <span>位带 (BIT STRIP) · {orient === 'msb' ? '高位在左' : '低位在左'}</span>
                        <span className={stripArm !== null ? 'text-nier-light' : 'opacity-50'}>
                            {stripArm !== null ? `起点 bit${stripArm.from} → 拖/点终点` : '拖拽画段 / 点两格设段'}
                        </span>
                    </div>
                    {/* 连续位号标尺（视角序；绝对位号 = 存储 LSB 口径） */}
                    <div className="flex" data-strip-ruler="true">
                        {strip.ruler.map(n => (
                            <span
                                key={n}
                                data-strip-ruler-no={n}
                                className="flex-1 text-center text-[6px] font-mono opacity-60 leading-none"
                            >
                                {n}
                            </span>
                        ))}
                    </div>
                    {/* 位带本体：单位（段/缺块）按视角序排布，字节边界竖线压顶层 */}
                    <div className="relative flex h-7 border border-nier-light/20">
                        {strip.boundaries.map(b => (
                            <div
                                key={b.bit}
                                data-strip-byte={b.bit}
                                className="absolute top-0 bottom-0 w-px bg-nier-light/30 pointer-events-none"
                                style={{ left: `${b.xPct}%` }}
                            />
                        ))}
                        {strip.units.map((u, ui) => {
                            if (u.kind === 'gap') {
                                return (
                                    <div key={`gap-${ui}`} className="flex" style={{ flexGrow: u.bits.length }}>
                                        {u.bits.map(bit => (
                                            <div
                                                key={bit}
                                                data-strip-gap={bit}
                                                data-strip-arm={inArm(bit) ? bit : undefined}
                                                onMouseDown={() => onStripGapDown(bit)}
                                                onMouseOver={() => onStripHover(bit)}
                                                title={`空 bit${bit} · 点两格/拖拽设段`}
                                                className={`flex-1 border transition-colors cursor-crosshair ${inArm(bit) ? 'border-dashed border-nier-light/60 bg-nier-light/10' : 'border-nier-light/20 bg-nier-light/5 hover:bg-nier-light/20'}`}
                                            />
                                        ))}
                                    </div>
                                );
                            }
                            // 拖柄语义与视角无关：start = LSB 侧、end = MSB 侧
                            //（msb 视角下 end 在左、start 在右）
                            const leftEdge = orient === 'msb' ? 'end' : 'start';
                            const rightEdge = orient === 'msb' ? 'start' : 'end';
                            return (
                                <div
                                    key={`seg-${u.owner}`}
                                    data-strip-seg={u.owner}
                                    data-conflict={u.conflict ? 'true' : undefined}
                                    data-strip-selected={selectedIndex === u.owner ? 'true' : undefined}
                                    onMouseDown={() => onStripSegDown(u.owner)}
                                    onClick={() => onStripSegDown(u.owner)}
                                    onDoubleClick={() => setStripRename(u.owner)}
                                    title={`${u.name || '(未命名)'} · bit${Math.min(...u.bits)}..${Math.max(...u.bits)} · ${u.bits.length}b${u.conflict ? ' · 位范围重叠' : ''}`}
                                    className={`relative flex ${u.conflict ? 'border border-red-500 bg-red-500/30' : 'border border-nier-light/40'} ${selectedIndex === u.owner ? 'ring-1 ring-nier-light' : ''}`}
                                    style={{ flexGrow: u.bits.length }}
                                >
                                    {/* 改宽拖柄（两端各一）：窄竖条压带边，不挡段内指针 */}
                                    <span
                                        data-strip-edge={leftEdge}
                                        data-strip-edge-seg={u.owner}
                                        onMouseDown={(e) => onStripEdgeDown(e, u.owner, leftEdge)}
                                        className="absolute left-0 top-0 bottom-0 w-1 bg-nier-dark/60 cursor-ew-resize z-10"
                                    />
                                    <span
                                        data-strip-edge={rightEdge}
                                        data-strip-edge-seg={u.owner}
                                        onMouseDown={(e) => onStripEdgeDown(e, u.owner, rightEdge)}
                                        className="absolute right-0 top-0 bottom-0 w-1 bg-nier-dark/60 cursor-ew-resize z-10"
                                    />
                                    {/* 段名标签（双击容器任意处进入改名）；不吃指针事件，
                                        点击穿透到段内位 → 冒泡选中段 */}
                                    {stripRename === u.owner ? (
                                        <input
                                            type="text"
                                            data-strip-rename={u.owner}
                                            value={list[u.owner]?.bit_name ?? ''}
                                            autoFocus
                                            onChange={(e) => update(u.owner, { bit_name: e.target.value })}
                                            onBlur={() => setStripRename(null)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === 'Escape') setStripRename(null);
                                            }}
                                            className="absolute inset-x-1 top-0 z-20 bg-nier-dark border border-nier-light/50 text-[8px] font-mono text-nier-light px-0.5 focus:outline-none"
                                        />
                                    ) : (
                                        <span
                                            data-strip-label={u.owner}
                                            title="双击改名"
                                            className="absolute inset-x-0 top-0 z-10 text-[7px] font-mono text-nier-light truncate px-1 pointer-events-none"
                                        >
                                            {u.name || '—'} ({u.bits.length}b)
                                        </span>
                                    )}
                                    {/* 段内逐位命中层：悬停/改宽目标位号都从这里取 */}
                                    {u.bits.map(bit => (
                                        <div
                                            key={bit}
                                            data-strip-bit={bit}
                                            data-strip-arm={inArm(bit) ? bit : undefined}
                                            onMouseOver={() => onStripHover(bit)}
                                            className="flex-1"
                                            style={u.conflict ? undefined : { backgroundColor: `${u.color}66` }}
                                        />
                                    ))}
                                </div>
                            );
                        })}
                    </div>

                    {/* R69: 逐位 0/1 值流行（位带下方）—— 默认打包值按位直觉回显，
                        段同色、字节边界竖线与位带对齐、视角镜像随 ruler；值 =
                        packBits 同源 hex 逐位展开（存储/打包口径零触碰）。 */}
                    <div className="relative flex border border-t-0 border-nier-light/20" data-strip-values="true">
                        {strip.boundaries.map(b => (
                            <div
                                key={`vb-${b.bit}`}
                                data-strip-value-byte={b.bit}
                                className="absolute top-0 bottom-0 w-px bg-nier-light/30 pointer-events-none"
                                style={{ left: `${b.xPct}%` }}
                            />
                        ))}
                        {strip.ruler.map(n => {
                            const u = strip.units.find(x => x.kind === 'seg' && x.bits.includes(n));
                            return (
                                <span
                                    key={n}
                                    data-strip-value-bit={n}
                                    className="flex-1 text-center text-[7px] font-mono leading-none py-0.5"
                                    style={u && !u.conflict ? { backgroundColor: u.color } : undefined}
                                >
                                    {digitOf(n)}
                                </span>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* 批 2：位网格（bit0 在最右 = LSB 口径）。R68 起为切换副视图，契约原样：
                点空格上膛 → 再点一格提交位段；点占用格 = 选中该段（表格行同步高亮）。 */}
            {stripView === 'grid' && (
                <div className="border border-nier-light/20 p-1 flex flex-col gap-1" data-bit-grid={armedBit !== null ? 'armed' : 'idle'}>
                    <div className="flex items-center justify-between text-[8px] opacity-60 uppercase tracking-widest">
                        <span>位图 (BIT MAP) · 右端为 bit0</span>
                        <span className={armedBit !== null ? 'text-nier-light' : 'opacity-50'}>
                            {armedBit !== null ? `起点 bit${armedBit} → 选终点` : '点两格设段 / 点色块选段'}
                        </span>
                    </div>
                    {/* 优化批 4：位号标尺 —— 列头标 7..0（LSb0 口径；绝对位号 = B行号×8 + 本列位号） */}
                    <div className="flex items-center gap-1" data-bit-ruler="true">
                        <span className="w-6 text-right" />
                        {[7, 6, 5, 4, 3, 2, 1, 0].map(n => (
                            <span key={n} data-bit-ruler-no={n} className="flex-1 text-center text-[8px] font-mono opacity-70">
                                {n}
                            </span>
                        ))}
                        <span className="w-6" />
                    </div>
                    {grid.bytes.map((row, r) => (
                        <div key={r} className="flex items-center gap-1" data-byte-row={r}>
                            <span className="text-[8px] opacity-40 font-mono w-6 text-right">B{r}</span>
                            {row.map(cell => {
                                const armed = armedBit !== null && Math.min(armedBit, cell.bitIndex) <= cell.bitIndex && cell.bitIndex <= Math.max(armedBit, cell.bitIndex);
                                const sel = cell.owner >= 0 && cell.owner === selectedIndex;
                                // 优化批 2：占用格 title 带值表名称解码（MODE = 1 (开) · bit0）
                                const seg = cell.owner >= 0 ? list[cell.owner] : null;
                                const segVt = seg ? sanitizeValueTable(seg.value_table) : null;
                                const segLabel = segVt ? (segVt.find(e => e.value === Number(seg.default_val)) || {}).label : undefined;
                                const note = segLabel ? ` = ${seg.default_val} (${segLabel})` : '';
                                return (
                                    <div
                                        key={cell.bitIndex}
                                        data-bit-cell={cell.bitIndex}
                                        data-owner={cell.owner >= 0 ? cell.owner : null}
                                        data-conflict={cell.conflict ? 'true' : null}
                                        data-bit-arm={armed ? 'true' : null}
                                        onClick={() => handleCellClick(cell)}
                                        title={cell.owner >= 0
                                            ? `${cell.name}${note} · bit${cell.bitIndex}`
                                            : `空闲 bit${cell.bitIndex} · 点击设段`}
                                        className={`flex-1 h-4 border cursor-pointer transition-colors ${cell.owner >= 0 ? '' : 'bg-nier-light/5 hover:bg-nier-light/20'} ${cell.conflict ? 'border-red-500 bg-red-500/30' : 'border-nier-light/30'} ${armed ? 'border-dashed border-nier-light/60' : ''} ${sel ? 'ring-1 ring-nier-light' : ''}`}
                                        style={cell.owner >= 0 ? { backgroundColor: cell.conflict ? undefined : `${cell.color}55` } : undefined}
                                    />
                                );
                            })}
                            <span className="text-[8px] opacity-40 font-mono w-6">B{r}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="grid grid-cols-[1fr_44px_36px_48px_96px_18px_16px] gap-1 text-[8px] opacity-50 uppercase tracking-widest px-0.5">
                <span>名称 (NAME)</span>
                <span className="text-right">起始位</span>
                <span className="text-right">位宽</span>
                <span className="text-right">默认值</span>
                <span>值表 (VAL_TABLE)</span>
                <span className="text-center">U/S</span>
                <span />
            </div>

            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto pr-1">
                {list.map((b, idx) => {
                    const hasConflict = conflicts.has(b.id);
                    const len = Math.max(1, Number(b.bit_len) || 1);
                    // 优化批 3（DBC signed）：默认值域按两补码（S 行允许负值），
                    // 无符号域不变（len>=32 → 4294967295）。
                    const signed = b.signed === true;
                    const maxVal = signed ? Math.pow(2, len - 1) - 1 : (len >= 32 ? 4294967295 : (1 << len) - 1);
                    const minVal = signed ? -Math.pow(2, len - 1) : 0;
                    // 优化批 2（DBC VAL_）：默认值 → 值表名称回显
                    const vt = sanitizeValueTable(b.value_table);
                    const vtHit = vt ? vt.find(e => e.value === Number(b.default_val)) : null;
                    const vtLabel = vtHit ? vtHit.label : undefined;
                    return (
                        <div
                            key={b.id || idx}
                            data-bit-row={idx}
                            data-selected={selectedIndex === idx ? 'true' : 'false'}
                            onClick={() => setSelectedIndex(idx)}
                            className={`grid grid-cols-[1fr_44px_36px_48px_96px_18px_16px] gap-1 items-center cursor-pointer ${hasConflict ? 'bg-red-500/20 border border-red-500/60 px-0.5' : ''} ${selectedIndex === idx ? 'border-l-2 border-nier-light pl-1' : ''}`}
                            title={hasConflict ? '位范围重叠 (BIT OVERLAP)' : undefined}
                        >
                            <input
                                type="text"
                                placeholder="BIT_NAME"
                                value={b.bit_name || ''}
                                onChange={(e) => update(idx, { bit_name: e.target.value })}
                                className="bg-transparent border-b border-nier-light/30 text-[10px] font-mono text-nier-light focus:border-nier-light focus:outline-none py-0.5 uppercase"
                            />
                            <input
                                type="number"
                                min="0"
                                value={b.start_bit ?? 0}
                                onChange={(e) => update(idx, { start_bit: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                                className="bg-transparent border-b border-nier-light/30 text-[10px] font-mono text-nier-light text-right focus:border-nier-light focus:outline-none py-0.5"
                            />
                            <input
                                type="number"
                                min="1"
                                max="64"
                                value={b.bit_len ?? 1}
                                onChange={(e) => update(idx, { bit_len: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                                className="bg-transparent border-b border-nier-light/30 text-[10px] font-mono text-nier-light text-right focus:border-nier-light focus:outline-none py-0.5"
                            />
                            <input
                                type="text"
                                data-bit-default={idx}
                                min={minVal}
                                max={maxVal}
                                value={defaultDraft && defaultDraft.idx === idx ? defaultDraft.text : String(b.default_val ?? 0)}
                                onChange={(e) => {
                                    const text = e.target.value;
                                    // R69: 草稿缓冲 —— '0b' 半截/垃圾不写回不丢字；
                                    // 合法（0b 二进制或十进制）→ 钳制到值域写回。
                                    setDefaultDraft({ idx, text });
                                    const parsed = parseBitDefaultInput(text);
                                    if (parsed === null) {
                                        if (String(text).trim() === '') update(idx, { default_val: minVal });
                                        return;
                                    }
                                    update(idx, { default_val: Math.max(minVal, Math.min(maxVal, parsed)) });
                                }}
                                onBlur={() => setDefaultDraft(null)}
                                title={vtLabel !== undefined ? `${b.default_val ?? 0} = ${vtLabel}` : '默认值'}
                                className="bg-transparent border-b border-nier-light/30 text-[10px] font-mono text-nier-light text-right focus:border-nier-light focus:outline-none py-0.5"
                            />
                            {/* 优化批 2：值表（DBC VAL_）单行文本 —— 0=关,1:开（':' 兼容） */}
                            <input
                                type="text"
                                data-bit-vt={idx}
                                placeholder="0=关,1:开"
                                value={formatValueTable(b.value_table)}
                                onChange={(e) => {
                                    const table = parseValueTable(e.target.value);
                                    update(idx, table ? { value_table: table } : { value_table: undefined });
                                }}
                                title="值表：0=关,1:开（把打包值解码成名称）"
                                className="bg-transparent border-b border-nier-light/30 text-[9px] font-mono text-nier-light focus:border-nier-light focus:outline-none py-0.5"
                            />
                            {/* 优化批 3：有符号开关（U/S）—— 点击切 signed，位图/子位/回发同步 */}
                            <button
                                type="button"
                                data-bit-signed={idx}
                                onClick={() => update(idx, { signed: !signed })}
                                title={signed ? '有符号位段（两补码）— 点击切回无符号' : '无符号位段 — 点击切为有符号'}
                                className={`text-[8px] font-black leading-none px-0.5 py-1 border transition-colors ${signed
                                    ? 'bg-nier-light text-black border-nier-light'
                                    : 'border-nier-light/30 text-muted hover:border-nier-light/70 hover:text-nier-light'}`}
                            >
                                {signed ? 'S' : 'U'}
                            </button>
                            <button
                                onClick={() => remove(idx)}
                                className="text-warn/90 hover:text-warn text-[10px] px-0.5"
                                title="DELETE BIT"
                            >
                                ×
                            </button>
                        </div>
                    );
                })}
                {list.length === 0 && (
                    <div className="text-[9px] opacity-30 text-center py-2 border border-dashed border-white/10">
                        NO BITS DEFINED
                    </div>
                )}
            </div>

            {/* LIVE PREVIEW（批 2：打包值改由 bitGrid.packBits 出，与编码器同口径） */}
            <div className="border-t border-white/10 pt-1.5 space-y-0.5 text-[9px] font-mono">
                <div className="flex justify-between" data-preview-hex="true">
                    <span className="opacity-50">默认打包值 (HEX)</span>
                    <span className="text-hl">
                        0x{totalDefault}
                    </span>
                </div>
                {/* R69: 0b 二进制回显行 —— 与 HEX 行同源（packBits 同一 hex 直出），
                    补 0/1 直觉（半字节分组便于逐位对读）。 */}
                <div className="flex justify-between" data-preview-bin="true">
                    <span className="opacity-50">默认打包值 (BIN)</span>
                    <span className="text-hl">
                        0b{formatBinaryBytes(totalDefault).join(' ')}
                    </span>
                </div>
                <div className="flex justify-between">
                    <span className="opacity-50">所需字节 (REQ)</span>
                    <span className={grid.overflow ? 'text-warn' : 'text-nier-light'}>
                        {grid.requiredBytes} / {byteLen || 0}
                        {grid.overflow ? ' ⚠ TOO SMALL' : ''}
                    </span>
                </div>
                {conflicts.size > 0 && (
                    <div className="text-warn tracking-wider">⚠ 位范围重叠 (BIT OVERLAP)</div>
                )}
            </div>
        </div>
    );
}
