import React, { useState } from 'react';
import { getBlockFields, isNestable } from '../../config/blockTypes';
import { findNode } from '../../utils/protocolTree';

// Right-hand properties panel for the Protocol editor page.
// Extracted verbatim from pages/Protocol.jsx (logic unchanged).
export default function ProtocolPropertiesPanel({
    showProtocolLevel, // activeProtocolId && currentProtocol && !selectedId
    currentProtocol,
    selectedBlock,
    onProtocolMetaChange, // (updatedProtocol) => void  (apply + draft update) — 批次四: label + description 共用（原 onProtocolLabelChange 改名）；反馈 #3: 落库走 SAVE
    onEnterContainer, // (block) => void
    onUpdateBlock, // (id, updates) => void
    onDeleteBlock, // (id) => void
    pickingMode, // { isActive, fieldKey, anchorId, currentRefs, onUpdateRefs }
    onStartPicking, // (fieldKey, currentRefs, onUpdateRefs) => void
    onStopPicking, // () => void
    validationIssues, // { errors, warnings } — 批次二 P0-4 结构校验（页面级）
    onLocateBlock, // (blockId) => void — 点击清单条目定位（展开祖先 + 选中）
    hasUnsavedChanges, // 反馈 #3 手动保存 —— 草稿脏时显示 SAVE 按钮
    onSaveProtocol // () => void — 点击 = saveChanges（写穿共享 + 清草稿）
}) {
    // warnings 展开态（镜像 BlockPropertiesPanel:34 / :261-269 折叠口径）
    const [showWarnings, setShowWarnings] = useState(false);
    return (
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-nier-light bg-nier-dark/95 p-4 flex flex-col z-20 shadow-[-5px_0_15px_rgba(0,0,0,0.1)]">
            <h2 className="text-lg border-b-2 border-nier-light mb-6 pb-1 font-bold tracking-wider">属性配置 (PROPERTIES)</h2>

            {/* 人工验证第 3 轮 #3: 顶部 SAVE 撤除——「保存更改」移到面板底部
                动作区（见 aside 末尾，协议级/块级两视图都可达）。 */}

            {/* 批次二 P0-4: 结构校验清单 —— 与指令页 BlockPropertiesPanel:233-281
                同款（errors 红容器 + 可点击定位、warnings 折叠）。差异：协议页
                清单**常驻面板顶部**（选中块时不隐藏）—— 手动保存下用户点定位
                后恰在块视图里边修边看。 */}
            {validationIssues && (validationIssues.errors.length > 0 || validationIssues.warnings.length > 0) && (
                <div className={`p-2 space-y-1 border mb-4 ${validationIssues.errors.length > 0 ? 'border-[#D94834] bg-[#D94834]/15' : 'border-[#E58D28] bg-[#E58D28]/10'}`}>
                    <div className="flex flex-wrap gap-2 items-baseline mb-1">
                        {validationIssues.errors.length > 0 && (
                            <span className="bg-[#D94834] text-nier-light font-bold uppercase tracking-widest px-1 py-0.5 text-[10px]">
                                ⛔ {validationIssues.errors.length} 结构错误
                            </span>
                        )}
                        <span className="bg-[#E58D28] text-nier-dark font-bold uppercase tracking-widest px-1 py-0.5 text-[10px]">
                            ⚠ {validationIssues.warnings.length} 提醒
                        </span>
                        {validationIssues.errors.length === 0 && (
                            <span className="text-[10px] text-nier-light/70">（不阻断保存）</span>
                        )}
                    </div>
                    {validationIssues.errors.slice(0, 8).map((err, i) => (
                        <button
                            key={`err-${i}`}
                            type="button"
                            onClick={() => err.blockId && onLocateBlock?.(err.blockId)}
                            className="block w-full text-left text-[11px] font-bold text-nier-light hover:text-white hover:underline truncate"
                        >
                            ⛔ {err.message}
                        </button>
                    ))}
                    {validationIssues.warnings.length > 0 && (
                        <button
                            type="button"
                            onClick={() => setShowWarnings(v => !v)}
                            className="text-[10px] font-bold text-[#E58D28] underline"
                        >
                            {showWarnings ? '收起提醒' : `展开提醒 (${validationIssues.warnings.length})`}
                        </button>
                    )}
                    {showWarnings && validationIssues.warnings.slice(0, 20).map((warn, i) => (
                        <button
                            key={`warn-${i}`}
                            type="button"
                            onClick={() => warn.blockId && onLocateBlock?.(warn.blockId)}
                            className="block w-full text-left text-[10px] text-nier-light hover:text-white truncate"
                        >
                            ⚠ {warn.message}
                        </button>
                    ))}
                </div>
            )}

            {showProtocolLevel && currentProtocol && (
                /* Protocol Level Properties — 批次四: + description（schema
                    既有字段，此前无 UI 入口；落库经 saveProtocol 载荷 :189 既有
                    description 键，签名 serializeProtocol 含 description → 防抖
                    链自然覆盖） */
                <div className="space-y-6 text-sm">
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">协议名称 (Protocol Name)</label>
                        <input
                            type="text"
                            value={currentProtocol.label}
                            onChange={(e) => {
                                const updatedProto = { ...currentProtocol, label: e.target.value };
                                onProtocolMetaChange(updatedProto);
                            }}
                            className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide"
                        />
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">协议描述 (Description)</label>
                        <textarea
                            rows={4}
                            value={currentProtocol.description || ''}
                            placeholder="可选：用途 / 版本备注…"
                            onChange={(e) => {
                                const updatedProto = { ...currentProtocol, description: e.target.value };
                                onProtocolMetaChange(updatedProto);
                            }}
                            className="bg-transparent border border-nier-light/50 focus:border-nier-light focus:outline-none p-2 font-mono tracking-wide resize-y text-xs"
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
                        // 批次四: select 分支（dot-path 存点 parameter_config.*
                        // 通用 input 无法承载 —— 同 refs 口径按 inputType 分流）。
                        // 读 pc[末段] ?? field.default；写入时带 type（镜像 refs
                        // 分支，存量行缺 type 时补上编码器 PASS1 闸用的键）。
                        if (field.inputType === 'select') {
                            const pc = selectedBlock.parameter_config || {};
                            const propKey = field.key.split('.').pop();
                            const value = pc[propKey] ?? field.default ?? '';
                            return (
                                <div key={field.id} className="flex flex-col gap-1">
                                    <label className="text-xs opacity-70 uppercase tracking-widest">{field.label}</label>
                                    <select
                                        value={value}
                                        onChange={(e) => onUpdateBlock(selectedBlock.id, {
                                            parameter_config: {
                                                ...pc,
                                                type: selectedBlock.type,
                                                [propKey]: e.target.value
                                            }
                                        })}
                                        className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide"
                                    >
                                        {field.options.map(opt => (
                                            <option key={opt.value} value={opt.value} className="bg-nier-dark text-nier-light">{opt.label}</option>
                                        ))}
                                    </select>
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

                    <div className="pt-4 border-t border-nier-light/20 space-y-2">
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

            {/* 人工验证第 3 轮 #3: SAVE 移到面板底部动作区——协议级/块级两视图
                共用（view 条件之后、mt-auto 贴底），镜像指令页 BlockPropertiesPanel
                的底部动作区口径。 */}
            {hasUnsavedChanges && (
                <div className="pt-4 flex flex-col gap-3 border-t border-nier-light/20 mt-auto">
                    <button
                        onClick={onSaveProtocol}
                        className="w-full bg-nier-light/10 border border-nier-light text-nier-light hover:bg-nier-light hover:text-black py-2 px-4 uppercase text-xs tracking-widest transition-colors font-bold"
                    >
                        保存更改 (SAVE)
                    </button>
                </div>
            )}
        </aside>
    );
}
