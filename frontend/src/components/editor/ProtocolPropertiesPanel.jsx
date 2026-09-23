import React from 'react';
import { getBlockFields, isNestable } from '../../config/blockTypes';
import { findNode } from '../../utils/protocolTree';

// Right-hand properties panel for the Protocol editor page.
// Extracted verbatim from pages/Protocol.jsx (logic unchanged).
export default function ProtocolPropertiesPanel({
    showProtocolLevel, // activeProtocolId && currentProtocol && !selectedId
    currentProtocol,
    selectedBlock,
    onProtocolLabelChange, // (updatedProtocol) => void  (apply + schedule save)
    onEnterContainer, // (block) => void
    onUpdateBlock, // (id, updates) => void
    onDeleteBlock, // (id) => void
    pickingMode, // { isActive, fieldKey, anchorId, currentRefs, onUpdateRefs }
    onStartPicking, // (fieldKey, currentRefs, onUpdateRefs) => void
    onStopPicking // () => void
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
                    {getBlockFields(selectedBlock.type).map((field) => {
                        // A2: refs 专用分支（FieldPickerParam 形态）—— dot-path key
                        // 通用 input 无法承载数组；芯片 label 解自 findNode、单删直写。
                        if (field.inputType === 'refs') {
                            const refs = Array.isArray(selectedBlock.parameter_config?.refs)
                                ? selectedBlock.parameter_config.refs
                                : [];
                            const isPicking = pickingMode?.isActive && pickingMode?.fieldKey === 'refs';
                            const setRefs = (next) => onUpdateBlock(selectedBlock.id, {
                                parameter_config: {
                                    ...(selectedBlock.parameter_config || {}),
                                    type: selectedBlock.type,
                                    refs: next
                                }
                            });
                            return (
                                <div key={field.id} className="flex flex-col gap-1 border border-dashed border-nier-light/30 p-2 bg-nier-light/5">
                                    <div className="flex justify-between items-center">
                                        <label className="text-xs opacity-70 uppercase tracking-widest">{field.label}</label>
                                        <span className="text-[9px] font-bold text-yellow-500">{refs.length} REF(S)</span>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => (isPicking ? onStopPicking() : onStartPicking('refs', refs, setRefs))}
                                        className={`w-full py-1 text-[10px] uppercase tracking-widest transition-all border ${isPicking ? 'bg-yellow-500 text-black border-yellow-500 animate-pulse font-bold' : 'bg-transparent border-nier-light/50 text-nier-light hover:bg-nier-light hover:text-black'}`}
                                    >
                                        {isPicking ? 'STOP PICKING (DONE)' : 'SELECT FIELDS'}
                                    </button>
                                    {refs.length > 0 && (
                                        <div className="flex flex-wrap gap-1">
                                            {refs.map(refId => {
                                                const target = currentProtocol ? findNode(currentProtocol, refId) : null;
                                                const refLabel = target?.label || refId;
                                                return (
                                                    <span
                                                        key={refId}
                                                        data-testid={`ref-chip-${refId}`}
                                                        className="inline-flex items-center gap-1 border border-nier-light/40 px-1.5 py-0.5 text-[10px] font-mono"
                                                    >
                                                        {refLabel}
                                                        <button
                                                            type="button"
                                                            aria-label={`remove ref ${refLabel}`}
                                                            onClick={() => setRefs(refs.filter(x => x !== refId))}
                                                            className="text-red-400 hover:text-red-300"
                                                        >
                                                            ×
                                                        </button>
                                                    </span>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        }
                        return (
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
                        );
                    })}

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
