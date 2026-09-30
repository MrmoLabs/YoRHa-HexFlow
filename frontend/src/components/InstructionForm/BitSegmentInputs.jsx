import React from 'react';
import { unpackBits, writeBitSegment } from '../../utils/bitGrid';

/**
 * 批 3：加工页 BITFIELD 的**子位录入**面板（与整包 hex/dec 输入并存）。
 *
 * 单一真源 = 字段整数输入值（inputs[field.id]）：本组件只做「拆包展示 → 回写单段」。
 *  - 改子位 → writeBitSegment：只重写本段位，间隙位（无主位）与其它段原样保留
 *  - 整包输入变化 → 行值由 unpackBits 重新派生（双向同步，零额外状态）
 *  - 无输入态 → 逐段回显 bits[].default_val（与整包显示的打包默认值同源）
 *
 * 编码口径：onChange 回传的是**同一个字段整数**，InstructionEncoder 的
 * BITFIELD 分支（inputValue → packed）零改动。
 */
export default function BitSegmentInputs({ bits, value, onChange, onSelectField }) {
    const rows = unpackBits(value, bits);
    if (rows.length === 0) return null; // 无合法位段 → 不渲染面板

    return (
        <div className="ml-40 mt-0.5 mb-1 flex flex-col gap-0.5" data-bit-segments="true">
            <div className="text-[8px] font-black text-nier-light/40 uppercase tracking-tighter">
                子位 (SUB-BITS) · 十进制
            </div>
            {rows.map(seg => (
                <div
                    key={seg.id ?? `${seg.start}-${seg.len}`}
                    data-bit-seg={seg.name}
                    onClick={onSelectField ? (e) => { e.stopPropagation(); onSelectField(); } : undefined}
                    className={`flex items-center gap-1 ${onSelectField ? 'cursor-pointer hover:bg-nier-light/5' : ''}`}
                >
                    <span className="text-[9px] font-mono text-nier-light/80 w-16 truncate uppercase" title={seg.name}>
                        {seg.name}
                    </span>
                    <span className="text-[8px] font-mono text-nier-light/40 w-14">
                        [b{seg.start + seg.len - 1}..b{seg.start}]
                    </span>
                    {/* 批 3：子位十进制输入——值钳到本段域，回写只重写本段位 */}
                    <input
                        type="number"
                        min="0"
                        max={Math.pow(2, seg.len) - 1}
                        data-bit-max={Math.pow(2, seg.len) - 1}
                        value={seg.value}
                        onChange={(e) => onChange(writeBitSegment(value, {
                            start_bit: seg.start, bit_len: seg.len
                        }, e.target.value, bits))}
                        onClick={(e) => e.stopPropagation()}
                        className="bg-transparent border-b border-nier-light/40 text-nier-light font-mono text-[10px] text-right w-14 focus:border-nier-light focus:outline-none py-0.5"
                    />
                </div>
            ))}
        </div>
    );
}
