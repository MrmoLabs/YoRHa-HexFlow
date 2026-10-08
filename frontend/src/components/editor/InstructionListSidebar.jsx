import React from 'react';

export default function InstructionListSidebar({
    instructions,
    activeInstructionId,
    searchTerm,
    setSearchTerm,
    onSearch, // Optional specific search handler if separate from set
    onSelect, // (id) => void
    onAdd, // () => void | null (null hides the button)
    viewMode, // 'list' | 'table' — P3-1 视图切换
    onToggleView, // () => void | null（null 隐藏切换按钮）
    onDuplicate, // (id) => void | null (null hides the button) — P2-1 复制指令
    onDelete, // (e, id) => void | null (null hides the button)
    hasUnsavedChanges
}) {
    return (
        <aside className="w-48 border-r border-nier-light/30 bg-nier-dark/50 flex flex-col">
            <div className="p-4 border-b border-nier-light/30 flex flex-col gap-2">
                <div className="flex justify-between items-center">
                    <span className="text-xs font-bold tracking-widest text-nier-light">指令库 (DATABASE)</span>
                    <div className="flex items-center gap-2">
                        {onToggleView && (
                            <button
                                onClick={onToggleView}
                                title={viewMode === 'table' ? '切换到列表视图 (LIST)' : '切换到表格视图 (TABLE)'}
                                className="border border-nier-light/40 text-[9px] px-1 py-0.5 leading-none tracking-widest text-muted hover:bg-nier-light hover:text-black transition-colors"
                            >
                                {viewMode === 'table' ? '列表' : '表格'}
                            </button>
                        )}
                        {onAdd && (
                            <button onClick={onAdd} className="hover:text-nier-highlight text-lg leading-none transition-colors text-muted">+</button>
                        )}
                    </div>
                </div>
                {/* Search Input */}
                <input
                    type="text"
                    placeholder="SEARCH..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && onSearch && onSearch(searchTerm)}
                    className="bg-nier-light/5 border border-nier-light/30 text-[10px] p-1 text-nier-light outline-none focus:border-nier-light font-mono placeholder:text-muted"
                />
            </div>
            <div className="flex-1 overflow-y-auto">
                {instructions.map(inst => (
                    <div key={inst.id}
                        onClick={() => onSelect(inst.id)}
                        className={`p-3 border-b border-nier-light/10 cursor-pointer flex justify-between items-center group ${inst.id === activeInstructionId ? 'bg-nier-light text-nier-dark' : 'text-muted hover:bg-nier-light/5'}`}
                    >
                        <div className="truncate text-xs flex-1">{inst.name || inst.label}</div>
                        <div className="flex items-center gap-2 shrink-0">
                            {inst.id === activeInstructionId && hasUnsavedChanges && <span className="text-[9px] text-warn">*</span>}
                            {onDuplicate && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation(); // Don't also select the row
                                        onDuplicate(inst.id);
                                    }}
                                    title="复制指令 (DUPLICATE)"
                                    className={`hidden group-hover:block text-[9px] font-bold tracking-widest leading-none px-1 transition-colors ${inst.id === activeInstructionId ? 'text-nier-dark/70 hover:text-nier-dark' : 'text-muted hover:text-nier-light'}`}
                                >
                                    副本
                                </button>
                            )}
                            {onDelete && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation(); // Don't also select the row
                                        onDelete(e, inst.id);
                                    }}
                                    title="删除指令 (DELETE)"
                                    className={`hidden group-hover:block text-[11px] leading-none px-1 transition-colors ${inst.id === activeInstructionId ? 'text-nier-dark/60 hover:text-red-600' : 'text-warn/90 hover:text-warn'}`}
                                >
                                    ×
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </aside>
    );
}
