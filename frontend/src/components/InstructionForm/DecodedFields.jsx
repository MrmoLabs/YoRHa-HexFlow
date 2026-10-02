import React from 'react';
import { formatFieldValue } from '../../utils/InstructionDecoder';

// R9（PLAN §8.46 · §8.37 R9 行 · C-2 选 B 前半）：**命中应答的解码展示** ——
// 把 `InstructionDecoder.decodeInstruction` 的结果渲染成一列 `字段 = 值`。
// 零 DDL、零后端改动（入库回写 = R10）。紧凑预览走 `fieldsText()`（历史行用），
// 这里是完整视图：字段名 + 值 + 字节区间，短帧 / 尾部残字节等 warning 照登不藏。

const DecodedFields = ({ decoded, title = 'HIT RESPONSE · 命中应答解码' }) => {
    if (!decoded) return null;
    const { fields, total, residual, warnings } = decoded;
    if (!fields.length && !warnings.length) return null;

    return (
        <div className="border border-nier-light/20 p-3 space-y-2">
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-nier-light/40">
                    {title}
                </span>
                <span className="text-[9px] font-mono text-nier-light/25">
                    {fields.length}F / {total}B{residual > 0 ? ` / +${residual}B` : ''}
                </span>
            </div>

            <ul className="space-y-0.5" data-testid="decoded-fields">
                {fields.map((f) => (
                    <li
                        key={`${f.fieldId}@${f.start}`}
                        className="flex items-baseline justify-between gap-3 border-b border-nier-light/10 pb-0.5 last:border-b-0"
                        title={`${f.name} ${f.opCode || '—'} · ${f.start}–${f.end} 字节${f.truncated ? ' · 帧长不足，已截断' : ''}`}
                    >
                        <span className="font-mono text-[10px] text-nier-light/50 truncate">{f.name}</span>
                        <span className={`font-mono text-[10px] ${f.truncated ? 'text-yellow-400' : 'text-nier-light'}`}>
                            {formatFieldValue(f.value)}
                        </span>
                    </li>
                ))}
            </ul>

            {warnings.length > 0 && (
                <ul className="space-y-0.5" data-testid="decoded-warnings">
                    {warnings.map((w) => (
                        <li key={w} className="font-mono text-[9px] text-yellow-400/90">// {w}</li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default DecodedFields;
