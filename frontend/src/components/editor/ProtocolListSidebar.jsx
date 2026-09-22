import React from 'react';

// Protocol list sidebar for the Protocol editor page.
// Extracted verbatim from pages/Protocol.jsx (logic unchanged).
export default function ProtocolListSidebar({
    protocols,
    activeProtocolId,
    onSelect, // (id) => void
    onAdd, // () => void
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
                        <button onClick={(e) => onDelete(e, p.id)} className="opacity-0 group-hover:opacity-100 hover:text-red-400">×</button>
                    </div>
                ))}
            </div>
        </aside>
    );
}
