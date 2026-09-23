import React from 'react';

// Protocol list sidebar for the Protocol editor page.
// Extracted verbatim from pages/Protocol.jsx (logic unchanged).
export default function ProtocolListSidebar({
    protocols,
    activeProtocolId,
    onSelect, // (id) => void
    onAdd, // () => void
    onDuplicate, // (id) => void | null (null hides the button) — 批次三 P1-1 复制协议
    onDelete // (event, id) => void
}) {
    return (
        <aside className="w-48 border-r border-nier-light/30 bg-nier-dark/50 flex flex-col">
            <div className="p-4 border-b border-nier-light/30 flex justify-between items-center">
                <span className="text-xs font-bold tracking-widest">协议列表</span>
                <button onClick={onAdd} className="hover:text-white text-lg leading-none">+</button>
            </div>
            <div className="flex-1 overflow-y-auto">
                {protocols.map(p => (
                    <div
                        key={p.id}
                        onClick={() => onSelect(p.id)}
                        className={`p-3 border-b border-nier-light/10 cursor-pointer hover:bg-white/5 flex justify-between group ${p.id === activeProtocolId ? 'bg-nier-light/10 text-white font-bold' : 'text-nier-light/70'}`}
                    >
                        <div className="truncate text-xs">{p.label}</div>
                        <div className="flex items-center gap-2 shrink-0">
                            {onDuplicate && (
                                // 镜像 InstructionListSidebar:56-67 的副本按钮（stopPropagation
                                // 免得顺手选中源行 —— 复制成功本就会切到副本）
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDuplicate(p.id);
                                    }}
                                    title="复制协议 (DUPLICATE)"
                                    className={`hidden group-hover:block text-[9px] font-bold tracking-widest leading-none px-1 transition-colors ${p.id === activeProtocolId ? 'text-nier-dark/70 hover:text-nier-dark' : 'text-nier-light/70 hover:text-nier-light'}`}
                                >
                                    副本
                                </button>
                            )}
                            <button onClick={(e) => onDelete(e, p.id)} className="opacity-0 group-hover:opacity-100 hover:text-red-400">×</button>
                        </div>
                    </div>
                ))}
            </div>
        </aside>
    );
}
