import React, { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { buildBitGrid, rangeToSegment, defaultSegmentName, packBits } from '../../utils/bitGrid';

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

export default function BitFieldEditor({ bits, byteLen = 1, onUpdateBits }) {
    const list = Array.isArray(bits) ? bits : [];
    const conflicts = findOverlaps(list);

    // 批 2：位网格 + 点击式设段（上膛起点）+ 选中段（与表格行联动）
    const [armedBit, setArmedBit] = useState(null);
    const [selectedIndex, setSelectedIndex] = useState(null);
    const grid = buildBitGrid(list, byteLen);
    const conflictSet = new Set(grid.conflictBits);

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

    const totalDefault = packBits(list, grid.requiredBytes || 1);

    return (
        <div className="flex flex-col gap-2 border border-dashed border-nier-light/50 p-2 space-y-2">
            <div className="flex justify-between items-center">
                <div className="text-[9px] font-bold text-nier-light">位域布局 (BIT LAYOUT)</div>
                <button
                    onClick={add}
                    className="text-[9px] bg-nier-light/10 hover:bg-nier-light hover:text-nier-dark px-2 py-0.5 transition-colors border border-nier-light/30"
                >
                    + ADD BIT
                </button>
            </div>

            {/* 批 2：位网格（bit0 在最右 = LSB 口径）。点空格上膛 → 再点一格提交位段；
                点占用格 = 选中该段（表格行同步高亮）。 */}
            <div className="border border-nier-light/20 p-1 flex flex-col gap-1" data-bit-grid={armedBit !== null ? 'armed' : 'idle'}>
                <div className="flex items-center justify-between text-[8px] opacity-60 uppercase tracking-widest">
                    <span>位图 (BIT MAP) · 右端为 bit0</span>
                    <span className={armedBit !== null ? 'text-nier-light' : 'opacity-50'}>
                        {armedBit !== null ? `起点 bit${armedBit} → 选终点` : '点两格设段 / 点色块选段'}
                    </span>
                </div>
                {grid.bytes.map((row, r) => (
                    <div key={r} className="flex items-center gap-1" data-byte-row={r}>
                        <span className="text-[8px] opacity-40 font-mono w-6 text-right">B{r}</span>
                        {row.map(cell => {
                            const armed = armedBit !== null && Math.min(armedBit, cell.bitIndex) <= cell.bitIndex && cell.bitIndex <= Math.max(armedBit, cell.bitIndex);
                            const sel = cell.owner >= 0 && cell.owner === selectedIndex;
                            return (
                                <div
                                    key={cell.bitIndex}
                                    data-bit-cell={cell.bitIndex}
                                    data-owner={cell.owner >= 0 ? cell.owner : null}
                                    data-conflict={cell.conflict ? 'true' : null}
                                    data-bit-arm={armed ? 'true' : null}
                                    onClick={() => handleCellClick(cell)}
                                    title={cell.owner >= 0
                                        ? `${cell.name} · bit${cell.bitIndex}`
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

            <div className="grid grid-cols-[1fr_44px_36px_48px_16px] gap-1 text-[8px] opacity-50 uppercase tracking-widest px-0.5">
                <span>名称 (NAME)</span>
                <span className="text-right">起始位</span>
                <span className="text-right">位宽</span>
                <span className="text-right">默认值</span>
                <span />
            </div>

            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto pr-1">
                {list.map((b, idx) => {
                    const hasConflict = conflicts.has(b.id);
                    const len = Math.max(1, Number(b.bit_len) || 1);
                    const maxVal = len >= 32 ? 4294967295 : (1 << len) - 1;
                    return (
                        <div
                            key={b.id || idx}
                            data-bit-row={idx}
                            data-selected={selectedIndex === idx ? 'true' : 'false'}
                            onClick={() => setSelectedIndex(idx)}
                            className={`grid grid-cols-[1fr_44px_36px_48px_16px] gap-1 items-center cursor-pointer ${hasConflict ? 'bg-red-500/20 border border-red-500/60 px-0.5' : ''} ${selectedIndex === idx ? 'border-l-2 border-nier-light pl-1' : ''}`}
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
                                type="number"
                                min="0"
                                max={maxVal}
                                value={b.default_val ?? 0}
                                onChange={(e) => {
                                    const raw = parseInt(e.target.value, 10);
                                    const v = isNaN(raw) ? 0 : Math.max(0, Math.min(maxVal, raw));
                                    update(idx, { default_val: v });
                                }}
                                className="bg-transparent border-b border-nier-light/30 text-[10px] font-mono text-nier-light text-right focus:border-nier-light focus:outline-none py-0.5"
                            />
                            <button
                                onClick={() => remove(idx)}
                                className="text-red-500/50 hover:text-red-500 text-[10px] px-0.5"
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
                <div className="flex justify-between">
                    <span className="opacity-50">默认打包值 (HEX)</span>
                    <span className="text-yellow-500">
                        0x{totalDefault}
                    </span>
                </div>
                <div className="flex justify-between">
                    <span className="opacity-50">所需字节 (REQ)</span>
                    <span className={grid.overflow ? 'text-red-400' : 'text-nier-light'}>
                        {grid.requiredBytes} / {byteLen || 0}
                        {grid.overflow ? ' ⚠ TOO SMALL' : ''}
                    </span>
                </div>
                {conflicts.size > 0 && (
                    <div className="text-red-400 tracking-wider">⚠ 位范围重叠 (BIT OVERLAP)</div>
                )}
            </div>
        </div>
    );
}
