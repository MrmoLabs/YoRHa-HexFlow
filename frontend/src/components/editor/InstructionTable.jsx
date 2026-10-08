import React, { useMemo } from 'react';
import { computeByteOffsets } from '../../utils/byteOffsets';

// P3-1: table view of the instruction list.
// Columns = code / device_code / name / total bytes / field count —
// InstructionResponse carries no updated_at (backend model maps none), so
// there is deliberately NO timestamp column (plan调研点2).
// 人工反馈迭代：①所有单元格居中对齐；②表头自带检索框，绑定页面级
// searchTerm（与侧栏搜索同一状态，双向同步），显示匹配行数。
// Rows honour the same filter as the list view; clicking a row selects
// through the page wrapper (unsaved-changes confirmation preserved).
export default function InstructionTable({
    instructions = [],
    activeInstructionId,
    onSelect,
    searchTerm = '',
    setSearchTerm
}) {
    const rows = useMemo(() => instructions.map(inst => {
        const offsets = computeByteOffsets(inst);
        return {
            id: inst.id,
            code: inst.code || '',
            device: inst.device_code || '',
            name: inst.name || inst.label || '',
            total: offsets.total,
            variable: offsets.variable,
            exact: offsets.exact,
            fieldCount: Array.isArray(inst.fields) ? inst.fields.length : 0,
        };
    }), [instructions]);

    const th = 'text-center px-3 py-2 tracking-widest font-bold whitespace-nowrap';
    const td = 'px-3 py-1.5 whitespace-nowrap text-center';

    return (
        <div className="flex-1 flex flex-col overflow-hidden bg-nier-dark/70">
            <div className="border-b border-nier-light/30 bg-nier-dark px-3 py-2 flex items-center gap-2">
                <span className="text-[10px] font-bold tracking-widest text-muted whitespace-nowrap">检索 FILTER</span>
                <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm && setSearchTerm(e.target.value)}
                    placeholder="SEARCH BY CODE / NAME / DEVICE..."
                    className="flex-1 min-w-0 bg-nier-light/5 border border-nier-light/30 text-[10px] p-1 text-nier-light outline-none focus:border-nier-light font-mono placeholder:text-muted"
                />
                <span className="text-[10px] font-mono text-hl whitespace-nowrap">MATCH {rows.length}</span>
            </div>
            <div className="flex-1 overflow-auto">
                <table className="w-full text-xs font-mono border-collapse">
                    <thead>
                        <tr className="bg-nier-dark border-b border-nier-light/40 text-muted">
                            <th className={th}>代号 CODE</th>
                            <th className={th}>设备 DEVICE</th>
                            <th className={th}>名称 NAME</th>
                            <th className={th}>总长 LEN</th>
                            <th className={th}>字段数 FIELDS</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 && (
                            <tr>
                                <td colSpan={5} className="px-3 py-3 text-center text-muted italic">
                                    无匹配指令 (NO MATCH)
                                </td>
                            </tr>
                        )}
                        {rows.map(r => (
                            <tr
                                key={r.id}
                                onClick={() => onSelect && onSelect(r.id)}
                                className={`cursor-pointer border-b border-nier-light/10 transition-colors ${r.id === activeInstructionId ? 'bg-nier-light text-nier-dark font-bold' : 'text-muted hover:bg-nier-light/10'}`}
                            >
                                <td className={`${td} font-bold`}>{r.code}</td>
                                <td className={td}>{r.device}</td>
                                <td className={`${td} max-w-[280px] overflow-hidden text-ellipsis`}>{r.name}</td>
                                <td className={td}>
                                    {r.variable && r.exact && '~'}{r.total}B{!r.exact && '+'}
                                    <span className={`ml-1 ${r.variable ? 'text-[#E58D28]' : 'opacity-50'}`}>
                                        {r.variable ? 'VAR' : 'FIXED'}
                                    </span>
                                </td>
                                <td className={td}>{r.fieldCount}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
