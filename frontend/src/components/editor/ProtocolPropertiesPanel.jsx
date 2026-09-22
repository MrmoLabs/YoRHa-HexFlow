import React from 'react';
import { getBlockFields, isNestable } from '../../config/blockTypes';

// Right-hand properties panel for the Protocol editor page.
// Extracted verbatim from pages/Protocol.jsx (logic unchanged).
export default function ProtocolPropertiesPanel({
    showProtocolLevel, // activeProtocolId && currentProtocol && !selectedId
    currentProtocol,
    selectedBlock,
    onProtocolLabelChange, // (updatedProtocol) => void  (apply + schedule save)
    onEnterContainer, // (block) => void
    onUpdateBlock, // (id, updates) => void
    onDeleteBlock // (id) => void
}) {
    return (
        <aside className="w-80 border-l border-nier-light bg-nier-dark/95 p-4 flex flex-col z-20 shadow-[-5px_0_15px_rgba(0,0,0,0.1)]">
            <h2 className="text-lg border-b-2 border-nier-light mb-6 pb-1 font-bold tracking-wider">属性配置 (PROPERTIES)</h2>

            {showProtocolLevel && currentProtocol && (
                /* Protocol Level Properties */
                <div className="space-y-6 text-sm">
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">协议名称 (Protocol Name)</label>
                        <input
                            type="text"
                            value={currentProtocol.label}
                            onChange={(e) => {
                                const updatedProto = { ...currentProtocol, label: e.target.value };
                                onProtocolLabelChange(updatedProto);
                            }}
                            className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide"
                        />
                    </div>
                </div>
            )}

            {selectedBlock ? (
                <div className="space-y-6 text-sm animate-in fade-in slide-in-from-right-4 duration-300">
                    {/* Common Properties */}
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">标签 (Label)</label>
                        <input
                            type="text"
                            value={selectedBlock.label}
                            onChange={(e) => onUpdateBlock(selectedBlock.id, { label: e.target.value })}
                            className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide"
                        />
                    </div>

                    {isNestable(selectedBlock.type) && (
                        <button
                            onClick={() => onEnterContainer(selectedBlock)}
                            className="mt-4 w-full border border-nier-light bg-nier-light/10 text-nier-light py-2 px-4 hover:bg-nier-light hover:text-nier-dark transition-colors font-bold tracking-widest text-xs"
                        >
                            进入容器 (ENTER) &gt;
                        </button>
                    )}

                    {/* Type-driven property fields (see config/blockTypes.js) */}
                    {getBlockFields(selectedBlock.type).map((field) => (
                        <div key={field.id} className="flex flex-col gap-1">
                            <label className="text-xs opacity-70 uppercase tracking-widest">{field.label}</label>
                            <input
                                type={field.inputType}
                                {...(field.min !== undefined ? { min: field.min } : {})}
                                value={selectedBlock[field.key] ?? ''}
                                onChange={(e) => onUpdateBlock(selectedBlock.id, { [field.key]: field.parse(e.target.value) })}
                                className={`bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono${field.inputType === 'text' ? ' uppercase' : ''}`}
                            />
                        </div>
                    ))}

                    <div className="pt-4 border-t border-nier-light/20">
                        <button
                            onClick={() => onDeleteBlock(selectedBlock.id)}
                            className="w-full border border-red-500/50 text-red-400 hover:bg-red-500 hover:text-white py-2 px-4 uppercase text-xs tracking-widest transition-colors"
                        >
                            删除 (DELETE)
                        </button>
                    </div>
                </div>
            ) : (
                <div className="h-full flex flex-col items-center justify-center opacity-30 gap-2">
                    <p className="italic text-center">选择模块以编辑</p>
                    <p className="text-[10px] font-mono">SELECT MODULE TO CONFIGURE</p>
                </div>
            )}
        </aside>
    );
}
