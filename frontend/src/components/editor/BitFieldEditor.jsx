import React from 'react';
import { v4 as uuidv4 } from 'uuid';

/**
 * BITFIELD 位域布局编辑器
 * 编辑字段级别的 bits 数组：[{ id, sequence, bit_name, start_bit, bit_len, default_val }]
 * 存储约定：start_bit 以“整字段的位偏移”计算，bit 0 为最低有效位 (LSB)。
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

    const maxEnd = list.reduce((acc, b) => {
        const start = Number(b.start_bit) || 0;
        const len = Math.max(1, Number(b.bit_len) || 1);
        return Math.max(acc, start + len);
    }, 0);
    const requiredBytes = Math.ceil(maxEnd / 8);

    const update = (index, patch) => {
        const next = list.map((b, i) => (i === index ? { ...b, ...patch } : b));
        onUpdateBits(next);
    };

    const remove = (index) => {
        onUpdateBits(list.filter((_, i) => i !== index));
    };

    const add = () => {
        // 新位段默认接在当前最高位之后
        onUpdateBits([...list, emptyBit(list.length)]);
    };

    const totalDefault = list.reduce((acc, b) => {
        const start = Number(b.start_bit) || 0;
        const len = Math.max(1, Number(b.bit_len) || 1);
        const maxVal = len >= 32 ? 0xFFFFFFFF : (1 << len) - 1;
        const val = Math.max(0, Math.min(maxVal, Number(b.default_val) || 0));
        return acc + (val * Math.pow(2, start));
    }, 0);

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
                            className={`grid grid-cols-[1fr_44px_36px_48px_16px] gap-1 items-center ${hasConflict ? 'bg-red-500/20 border border-red-500/60 px-0.5' : ''}`}
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

            {/* LIVE PREVIEW */}
            <div className="border-t border-white/10 pt-1.5 space-y-0.5 text-[9px] font-mono">
                <div className="flex justify-between">
                    <span className="opacity-50">默认打包值 (HEX)</span>
                    <span className="text-yellow-500">
                        0x{totalDefault.toString(16).toUpperCase().padStart(Math.max(2, requiredBytes * 2), '0')}
                    </span>
                </div>
                <div className="flex justify-between">
                    <span className="opacity-50">所需字节 (REQ)</span>
                    <span className={requiredBytes > (byteLen || 0) ? 'text-red-400' : 'text-nier-light'}>
                        {requiredBytes} / {byteLen || 0}
                        {requiredBytes > (byteLen || 0) ? ' ⚠ TOO SMALL' : ''}
                    </span>
                </div>
                {conflicts.size > 0 && (
                    <div className="text-red-400 tracking-wider">⚠ 位范围重叠 (BIT OVERLAP)</div>
                )}
            </div>
        </div>
    );
}
