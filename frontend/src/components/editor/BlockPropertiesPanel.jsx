import React, { useState, useEffect } from 'react';
import ParamConfigForm from './ParamConfigForm';
import BitFieldEditor from './BitFieldEditor';
import { v4 as uuidv4 } from 'uuid';
import { mapChecksumAlgo } from '../../utils/normalizeInstruction';

const controlledValue = (value, fallback = '') => (value ?? fallback);

export default function BlockPropertiesPanel({
    selectedBlock,
    currentInstruction, // { id, name, code, device_code, fields }
    operatorTemplates,
    hasUnsavedChanges,
    onUpdateInstruction, // (updatedInst) => void
    onSaveInstruction, // () => void
    onDeleteInstruction, // (e, id) => void
    onDeleteBlock, // (id) => void
    onSaveBlock, // (updatedBlock) => Promise<void> (Handles Auto-Save)
    openConfirm, // (msg, action) => void
    onOpenDatePicker, // (key, val) => void
    // Picking Props
    pickingMode,
    setPickingMode,
    onPickBlock,
    onTempChange // (tempBlockConfig | null) => void — live canvas preview
}) {
    // Local Edit State
    const [tempBlockConfig, setTempBlockConfig] = useState(null);
    const [hexInputMode, setHexInputMode] = useState('HEX');

    // Live preview: push temp edits upward so the page can mirror them on the
    // selected card in real time (display only — APPLY/SAVE still persists).
    useEffect(() => {
        onTempChange?.(tempBlockConfig);
    }, [tempBlockConfig]);

    // Semantic signature of the selected block: detects EXTERNAL changes
    // (cascade ref-scrub after deleting another block, revert/reset, rename
    // formula sync) so the temp editor is rebuilt instead of silently
    // overwriting them on APPLY. Structural fields (sequence/parent_id) are
    // excluded: drags change them but must not discard un-applied edits —
    // handleSaveBlock takes structure from the saved state instead.
    const selectedBlockSignature = selectedBlock
        ? JSON.stringify((({ sequence, parent_id, updatedAt, ...semantic }) => semantic)(selectedBlock))
        : null;

    // Sync with Selection
    useEffect(() => {
        // Abort active ref-picking when the selection changes: the stale
        // onUpdateRefs closure would otherwise write refs into the newly
        // selected block's config (cross-block contamination).
        setPickingMode?.(prev => (prev?.isActive
            ? { isActive: false, fieldKey: null, currentRefs: [], onUpdateRefs: null }
            : prev));
        if (selectedBlock) {
            const initialParams = { ...selectedBlock.parameter_config };
            const opTemplate = operatorTemplates[selectedBlock.op_code];

            // Convert kv_pair_list object to array for stable editing
            if (opTemplate?.param_template?.options === 'kv_pair_list') {
                const pairs = initialParams.options || {};
                const byteLen = selectedBlock.byte_len || 1;

                // STORAGE FORMAT: { "LABEL": "HEX_VAL" }
                // Convert to Array for Editor
                initialParams._kvArray = Object.entries(pairs).map(([k, v]) => {
                    let hexUnpadded = v;
                    if (typeof v === 'number') {
                        hexUnpadded = v.toString(16).toUpperCase();
                    } else if (typeof v === 'string') {
                        hexUnpadded = v.trim();
                    }
                    const padded = (hexUnpadded || "").padStart(byteLen * 2, '0').toUpperCase();
                    return {
                        id: uuidv4(),
                        val: padded, // Value
                        label: k     // Label (Key)
                    };
                });
            }

            // B1: normalize checksum algo to the encoder enum on read, so the
            // select shows a real working value and apply persists the alias.
            if (initialParams.algo !== undefined) {
                initialParams.algo = mapChecksumAlgo(initialParams.algo);
                initialParams.algorithm = initialParams.algo;
            }

            setTempBlockConfig({
                ...selectedBlock,
                parameter_config: initialParams
            });
        } else {
            setTempBlockConfig(null);
        }
    }, [selectedBlock?.id, selectedBlockSignature]); // Semantic signature: rebuild on EXTERNAL content changes so APPLY cannot overwrite them with a stale copy; structural drags keep dirty edits alive.

    const handleTempUpdate = (updates) => {
        setTempBlockConfig(prev => ({ ...prev, ...updates }));
    };

    const handleTempParamUpdate = (key, val) => {
        setTempBlockConfig(prev => {
            const parameter_config = { ...prev.parameter_config, [key]: val };

            // A1/A2: bit-width params drive byte_len (INT*/FLOAT bits, BCD bytes) —
            // otherwise picking 16/32/64 in the select changes nothing on the wire.
            if (key === 'bits') {
                const bitsNum = Number(val);
                if (Number.isFinite(bitsNum) && bitsNum > 0) {
                    return { ...prev, parameter_config, byte_len: Math.ceil(bitsNum / 8) };
                }
                return { ...prev, parameter_config };
            }
            if (key === 'bytes') {
                const byteNum = Number(val);
                if (Number.isFinite(byteNum) && byteNum > 0) {
                    return { ...prev, parameter_config, byte_len: byteNum };
                }
                return { ...prev, parameter_config };
            }
            // B1: keep parameter_config.algorithm (the key the encoder reads) in sync.
            if (key === 'algo') {
                parameter_config.algorithm = mapChecksumAlgo(val);
            }
            return { ...prev, parameter_config };
        });
    };

    const handleStartPicking = (key, currentRefs) => {
        setPickingMode({
            isActive: true,
            fieldKey: key,
            currentRefs: currentRefs || [],
            onUpdateRefs: (newRefs) => {
                setTempBlockConfig(prev => {
                    if (!prev) return null; // Safety check
                    return {
                        ...prev,
                        parameter_config: { ...prev.parameter_config, [key]: newRefs }
                    };
                });
            }
        });
    };

    const handleStopPicking = () => {
        setPickingMode({
            isActive: false,
            fieldKey: null,
            currentRefs: [],
            onUpdateRefs: null
        });
    };

    const handleApply = () => {
        if (!tempBlockConfig) return;
        const opTemplate = operatorTemplates[tempBlockConfig.op_code];

        // 1. HEX_RAW Validation
        if (tempBlockConfig.op_code === 'HEX_RAW') {
            const byteLen = tempBlockConfig.byte_len || 1;
            const hexVal = (tempBlockConfig.parameter_config?.hex || "").replace(/\s/g, '');
            if (hexVal.length !== byteLen * 2) {
                openConfirm(`校验错误：\n需要 ${byteLen} 字节 (${byteLen * 2} 字符)。\n当前 ${hexVal.length} 字符。`, () => { });
                return;
            }
            const updatedBlock = {
                ...tempBlockConfig,
                parameter_config: { ...tempBlockConfig.parameter_config, hex: hexVal }
            };
            onSaveBlock(updatedBlock);
        }
        // 2. Enum Mapping Validation
        else if (opTemplate?.param_template?.options === 'kv_pair_list') {
            const kvArray = tempBlockConfig.parameter_config?._kvArray || [];
            const byteLen = tempBlockConfig.byte_len || 1;
            const newOptions = {};

            for (const item of kvArray) {
                if (!item.label || !item.label.trim()) continue;
                const label = item.label.trim();
                if (newOptions[label]) {
                    openConfirm(`校验错误：\n重复标签 "${label}"。标签必须唯一。`, () => { });
                    return;
                }
                if (!item.val) {
                    openConfirm(`校验错误：\n标签 "${label}" 没有值。`, () => { });
                    return;
                }
                const hexStr = item.val.trim();
                // Strict Hex Check
                if (!/^[0-9A-Fa-f]+$/.test(hexStr)) {
                    openConfirm(`校验错误：\n值 "${item.val}" 必须是有效的十六进制字符串。`, () => { });
                    return;
                }
                if (hexStr.length !== byteLen * 2) {
                    openConfirm(`校验错误：\n值 "${hexStr}" 有 ${hexStr.length} 字符。\n需要 ${byteLen * 2} 字符。`, () => { });
                    return;
                }
                newOptions[label] = hexStr.toUpperCase();
            }

            const finalParams = { ...tempBlockConfig.parameter_config, options: newOptions };
            delete finalParams._kvArray;

            const updatedBlock = {
                ...tempBlockConfig,
                parameter_config: finalParams
            };
            onSaveBlock(updatedBlock);
        }
        // 3. Default
        else {
            onSaveBlock(tempBlockConfig);
        }
    };


    return (
        <aside className="w-80 border-l border-nier-light bg-nier-dark/95 backdrop-blur-sm p-4 flex flex-col z-20 shadow-[-5px_0_15px_rgba(0,0,0,0.5)] overflow-y-auto">
            <h2 className="text-lg border-b-2 border-nier-light mb-6 pb-1 font-bold tracking-wider">属性配置 (PROPERTIES)</h2>

            {currentInstruction && !selectedBlock && (
                <div className="space-y-6 text-sm">
                    {/* Instruction Meta */}
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">设备前缀 (Device)</label>
                        <input type="text" value={currentInstruction.device_code || ''} onChange={(e) => onUpdateInstruction({ ...currentInstruction, device_code: e.target.value })} className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide" />
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">指令代号 (Code)</label>
                        <input type="text" value={currentInstruction.code || ''} onChange={(e) => onUpdateInstruction({ ...currentInstruction, code: e.target.value })} className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide" />
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">指令名称 (Name)</label>
                        <input type="text" value={controlledValue(currentInstruction.name ?? currentInstruction.label, '')} onChange={(e) => onUpdateInstruction({ ...currentInstruction, name: e.target.value })} className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide" />
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">指令类型 (Type)</label>
                        <select
                            value={currentInstruction.type || 'STATIC'}
                            onChange={(e) => onUpdateInstruction({ ...currentInstruction, type: e.target.value })}
                            className="bg-nier-dark border border-nier-light/50 text-nier-light text-xs p-1 focus:outline-none"
                        >
                            <option value="STATIC" className="bg-nier-dark text-nier-light">静态 (STATIC)</option>
                            <option value="DYNAMIC" className="bg-nier-dark text-nier-light">动态 (DYNAMIC)</option>
                        </select>
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">说明 (Description)</label>
                        <textarea
                            rows={2}
                            value={currentInstruction.description || ''}
                            onChange={(e) => onUpdateInstruction({ ...currentInstruction, description: e.target.value })}
                            className="bg-transparent border border-nier-light/30 focus:border-nier-light focus:outline-none p-1 font-mono text-xs tracking-wide resize-none"
                        />
                    </div>

                    {/* Instruction Actions */}
                    <div className="pt-8 flex flex-col gap-3 border-t border-nier-light/20">
                        {hasUnsavedChanges && (
                            <button onClick={onSaveInstruction} className="w-full bg-nier-light/10 border border-nier-light text-nier-light hover:bg-nier-light hover:text-black py-2 px-4 uppercase text-xs tracking-widest transition-colors font-bold">
                                保存更改 (SAVE)
                            </button>
                        )}
                        <button onClick={(e) => onDeleteInstruction(e, currentInstruction.id)} className="w-full border border-red-500/50 text-red-500 hover:bg-red-500 hover:text-white py-2 px-4 uppercase text-xs tracking-widest transition-colors">
                            删除指令 (DELETE)
                        </button>
                    </div>
                </div>
            )}

            {selectedBlock && tempBlockConfig && (
                <div className="space-y-5 text-sm animate-in fade-in slide-in-from-right-4 duration-300">
                    <div className="text-[10px] opacity-40 font-mono flex justify-between">
                        <span>{selectedBlock.id}</span>
                        <span className="text-nier-light">{selectedBlock.op_code}</span>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">字段标签 (Label)</label>
                        <input type="text" value={controlledValue(tempBlockConfig.name ?? tempBlockConfig.label, '')} onChange={(e) => handleTempUpdate({ name: e.target.value })} className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide" />
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">字节长度 (Length)</label>
                        <input type="number" min="0" value={controlledValue(tempBlockConfig.byte_len ?? tempBlockConfig.byte_length, 0)} onChange={e => handleTempUpdate({ byte_len: parseInt(e.target.value) || 0 })} className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono" />
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">字节序 (Endian · 仅存储, 编码暂按大端)</label>
                        <select
                            value={controlledValue(tempBlockConfig.endianness, 'BIG')}
                            onChange={e => handleTempUpdate({ endianness: e.target.value })}
                            className="bg-nier-dark border border-nier-light/50 text-nier-light text-xs p-1 focus:outline-none"
                        >
                            <option value="BIG" className="bg-nier-dark text-nier-light">大端 (BIG)</option>
                            <option value="LITTLE" className="bg-nier-dark text-nier-light">小端 (LITTLE)</option>
                        </select>
                    </div>

                    {/* Dynamic Params */}
                    <div className="p-3 border border-white/10 bg-white/5 space-y-3">
                        <div className="text-[9px] opacity-50 border-b border-white/10 pb-1 mb-2">配置参数 (CONFIG)</div>
                        {selectedBlock.op_code !== 'HEX_RAW' && selectedBlock.op_code !== 'BITFIELD' && (
                            <ParamConfigForm
                                blockState={tempBlockConfig}
                                instructionFields={currentInstruction.fields}
                                operatorTemplates={operatorTemplates}
                                onUpdateParam={handleTempParamUpdate}
                                hexInputMode={hexInputMode}
                                setHexInputMode={setHexInputMode}
                                onOpenDatePicker={onOpenDatePicker}
                                onStartPicking={handleStartPicking}
                                onStopPicking={handleStopPicking}
                                pickingMode={pickingMode}
                            />
                        )}

                        {/* BITFIELD: Dedicated bit layout editor */}
                        {selectedBlock.op_code === 'BITFIELD' && (
                            <BitFieldEditor
                                bits={tempBlockConfig.bits || []}
                                byteLen={tempBlockConfig.byte_len || 0}
                                onUpdateBits={(nextBits) => handleTempUpdate({ bits: nextBits })}
                            />
                        )}

                        {/* HEX_RAW Input (Manual) - Multi Format */}
                        {selectedBlock.op_code === 'HEX_RAW' && (
                            <div className="flex flex-col gap-2">
                                <div className="flex justify-between items-end">
                                    <label className="text-[10px] opacity-70 uppercase tracking-widest">VALUE ({hexInputMode})</label>
                                    <div className="flex text-[10px] gap-1 border border-nier-light/30 p-0.5 bg-black">
                                        {['HEX', 'DEC', 'BIN'].map(m => (
                                            <button
                                                key={m}
                                                onClick={() => setHexInputMode(m)}
                                                className={`px-2 py-0.5 transition-all ${hexInputMode === m ? 'bg-nier-light text-black font-bold' : 'text-nier-light hover:bg-nier-light/20'}`}
                                            >
                                                {m}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <input
                                    type="text"
                                    value={(() => {
                                        const rawHex = tempBlockConfig.parameter_config?.hex || "00";
                                        if (!rawHex) return "";
                                        const val = parseInt(rawHex, 16);
                                        if (isNaN(val)) return rawHex;
                                        if (hexInputMode === 'DEC') return val.toString(10);
                                        if (hexInputMode === 'BIN') return val.toString(2).padStart(rawHex.length * 4, '0');
                                        return rawHex.toUpperCase();
                                    })()}
                                    onChange={(e) => {
                                        const input = e.target.value;
                                        let newHex = "";
                                        try {
                                            if (input === "") newHex = "";
                                            else if (hexInputMode === 'DEC') {
                                                const d = parseInt(input, 10);
                                                if (!isNaN(d)) newHex = d.toString(16).toUpperCase();
                                            } else if (hexInputMode === 'BIN') {
                                                const b = parseInt(input, 2);
                                                if (!isNaN(b)) newHex = b.toString(16).toUpperCase();
                                            } else {
                                                newHex = input.toUpperCase().replace(/[^0-9A-F]/g, '');
                                            }
                                            handleTempUpdate({ parameter_config: { ...tempBlockConfig.parameter_config, hex: newHex } });
                                        } catch (err) { }
                                    }}
                                    className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide"
                                />
                                <div className="text-[9px] opacity-30 text-right">
                                    STORED: {tempBlockConfig.parameter_config?.hex || "00"}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Repeat Strategy */}
                    {(selectedBlock.op_code === 'ARRAY_GROUP' || selectedBlock.op_code === 'STRUCT') && (
                        <div className="p-3 border border-dashed border-nier-light/50 space-y-3">
                            <div className="text-[9px] opacity-100 font-bold text-nier-light">重复策略 (REPEAT)</div>
                            <select
                                value={controlledValue(tempBlockConfig.repeat_type, 'NONE')}
                                onChange={e => handleTempUpdate({ repeat_type: e.target.value })}
                                className="w-full bg-nier-dark border border-nier-light/50 text-nier-light text-xs p-1 focus:outline-none"
                            >
                                <option value="NONE" className="bg-nier-dark text-nier-light">无重复 (Single)</option>
                                <option value="FIXED" className="bg-nier-dark text-nier-light">固定次数 (Fixed)</option>
                                <option value="DYNAMIC" className="bg-nier-dark text-nier-light">动态引用 (Dynamic Ref)</option>
                            </select>

                            {tempBlockConfig.repeat_type === 'FIXED' && (
                                <div className="flex flex-col gap-1">
                                    <label className="text-[9px]">次数 (COUNT)</label>
                                    <input type="number" value={controlledValue(tempBlockConfig.repeat_count, 1)} onChange={e => handleTempUpdate({ repeat_count: parseInt(e.target.value) })} className="bg-transparent border-b border-white/30 text-xs" />
                                </div>
                            )}
                            {tempBlockConfig.repeat_type === 'DYNAMIC' && (
                                <div className="flex flex-col gap-1">
                                    <label className="text-[9px]">关联字段 (REF ID)</label>
                                    <select
                                        value={tempBlockConfig.repeat_ref_id || ''}
                                        onChange={e => handleTempUpdate({ repeat_ref_id: e.target.value })}
                                        className="w-full bg-nier-dark border border-nier-light/50 text-nier-light text-xs p-1 focus:outline-none"
                                    >
                                        <option value="" className="bg-nier-dark text-nier-light">-- SELECT REF --</option>
                                        {currentInstruction.fields.filter(b => b.id !== selectedBlock.id).map(b => (
                                            <option key={b.id} value={b.id} className="bg-nier-dark text-nier-light">{b.name} ({b.sequence})</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="pt-8 border-t border-nier-light/20 flex flex-col gap-3">
                        <button onClick={handleApply} className="w-full bg-nier-light/20 border border-nier-light text-nier-light hover:bg-nier-light hover:text-black py-2 px-4 uppercase text-xs tracking-widest transition-colors font-bold">
                            应用配置 (APPLY)
                        </button>
                        <button onClick={() => onDeleteBlock(selectedBlock.id)} className="w-full border border-red-500/50 text-red-500 hover:bg-red-500 hover:text-white py-2 px-4 uppercase text-xs tracking-widest transition-colors">
                            删除 (DELETE)
                        </button>
                    </div>
                </div>
            )}
        </aside>
    );
}
