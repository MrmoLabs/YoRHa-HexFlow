import React, { useMemo, useState, useEffect } from 'react';
import Canvas from '../components/editor/Canvas';
import { v4 as uuidv4 } from 'uuid';
import NieRModal from '../components/ui/NieRModal';
import NieRDatePicker from '../components/ui/NieRDatePicker';
import InstructionListSidebar from '../components/editor/InstructionListSidebar';
import ComponentPalette from '../components/editor/ComponentPalette';
import BlockPropertiesPanel from '../components/editor/BlockPropertiesPanel';
import { useInstructionData } from '../hooks/useInstructionData';
import { useInstructionLanes } from '../hooks/useInstructionLanes';
import { useSelectionSystem } from '../hooks/useSelectionSystem';
import { validateInstruction } from '../utils/validateInstruction';

export default function Instruction({ instructions: initialInstructions, setInstructions: setSharedInstructions, onWebUpdate, reloadInstructions }) {
    // 1. Data Hook
    const {
        instructions,
        activeInstructionId,
        setActiveInstructionId,
        currentInstruction,
        operatorTemplates,
        isOperatorTemplatesLoading,
        operatorTemplatesError,
        statusMsg,
        hasUnsavedChanges,
        loadInstructions,
        loadOperatorTemplates,
        updateLocalInstruction,
        addInstruction,
        deleteInstruction,
        saveChanges,
        revertChanges,
        setInstructions, // exposed for functional updates
        setHasUnsavedChanges
    } = useInstructionData({
        instructions: initialInstructions,
        setInstructions: setSharedInstructions,
        onWebUpdate,
        fetchInstructions: reloadInstructions,
        disableInitialLoad: true
    });

    // 2. Selection Hook
    const {
        selectedId,
        setSelectedId,
        pickingMode,
        setPickingMode,
        handlePickBlock,
        cancelPicking
    } = useSelectionSystem();

    // 3. Lanes/UI Hook
    const {
        expandedGroupIds,
        setExpandedGroupIds,
        focusedParentId,
        setFocusedParentId,
        processedLanes,
        handleNavigateGroup
    } = useInstructionLanes(currentInstruction, activeInstructionId);

    // P0-2: structural validation of the working copy — recomputed on every
    // local edit (pure). Errors block saveChanges (see useInstructionData)
    // and are listed in the properties panel with click-to-locate; warnings
    // surface B2–B8 encoder-limit notices without blocking.
    const validationIssues = useMemo(
        () => validateInstruction(currentInstruction),
        [currentInstruction]
    );

    // P0-3: guard unsaved edits against refresh/close.
    useEffect(() => {
        if (!hasUnsavedChanges) return;
        const onBeforeUnload = (e) => {
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [hasUnsavedChanges]);

    // Abort ref-picking whenever the target instruction or selection changes:
    // a stale onUpdateRefs closure would otherwise write refs into another
    // block's config, and after switching instructions canvas clicks would keep
    // toggling refs instead of selecting blocks (until ESC).
    useEffect(() => {
        setPickingMode(prev => (prev.isActive
            ? { isActive: false, fieldKey: null, currentRefs: [], onUpdateRefs: null }
            : prev));
    }, [activeInstructionId, selectedId, setPickingMode]);

    // Local UI State
    const [searchTerm, setSearchTerm] = useState('');
    const [modalConfig, setModalConfig] = useState({ isOpen: false, message: '', onConfirm: null, onCancel: null });
    const [datePickerState, setDatePickerState] = useState({ isOpen: false, value: null, onConfirmCallback: null });

    const openConfirm = (msg, action) => {
        setModalConfig({
            isOpen: true,
            message: msg,
            onConfirm: () => { action(); setModalConfig(prev => ({ ...prev, isOpen: false })); },
            onCancel: () => setModalConfig(prev => ({ ...prev, isOpen: false }))
        });
    };

    // --- Derived State Helpers ---
    const flattenedProcessed = processedLanes.flatMap(l => l.items);
    const selectedBlock = flattenedProcessed.find(b => b.id === selectedId);

    // Live preview: mirror the properties panel's temp edits onto the matching
    // card so byte_len / name / hex changes show up before APPLY (display only —
    // derived computedValue always stays sourced from processedLanes).
    const [previewBlock, setPreviewBlock] = useState(null);
    const displayLanes = useMemo(() => {
        if (!previewBlock?.id) return processedLanes;
        return processedLanes.map(lane => ({
            ...lane,
            items: lane.items.map(item => (
                item.id === previewBlock.id
                    ? {
                        ...item,
                        ...previewBlock,
                        id: item.id,
                        parameter_config: {
                            ...item.parameter_config,
                            ...previewBlock.parameter_config,
                            computedValue: item.parameter_config?.computedValue
                        }
                    }
                    : item
            ))
        }));
    }, [processedLanes, previewBlock]);
    const visibleInstructions = useMemo(() => {
        const keyword = searchTerm.trim().toLowerCase();
        if (!keyword) return instructions;

        return instructions.filter(instruction => (
            `${instruction.name || instruction.label || ''} ${instruction.code || ''} ${instruction.device_code || ''}`
                .toLowerCase()
                .includes(keyword)
        ));
    }, [instructions, searchTerm]);

    // --- Actions ---
    // Helper: Ensure Unique Name
    const getUniqueName = (baseName, excludeId = null) => {
        let name = baseName;
        let counter = 1;
        const existingNames = new Set(
            currentInstruction.fields
                .filter(f => f.id !== excludeId)
                .map(f => f.name || f.label)
        );
        while (existingNames.has(name)) {
            name = `${baseName}_${counter}`;
            counter++;
        }
        return name;
    }

    const handleAddBlock = (opCode) => {
        if (!currentInstruction) return;
        const template = operatorTemplates[opCode] || operatorTemplates['HEX_RAW'];
        if (!template) return; // Templates not loaded yet — avoid crashing on undefined.
        const currentParentId = focusedParentId;
        const siblings = currentInstruction.fields.filter(f => (f.parent_id || null) === currentParentId);
        const nextSeq = siblings.length > 0 ? Math.max(...siblings.map(s => Number(s.sequence) || 0)) + 1 : 0;

        const defaultParams = {};
        if (template.param_template) {
            const keywords = ['datetime', 'number', 'string', 'field_picker', 'kv_pair_list', 'input', 'bit_editor'];
            Object.entries(template.param_template).forEach(([key, val]) => {
                if (typeof val !== 'string' || !keywords.includes(val)) defaultParams[key] = val;
            });
        }

        const newBlock = {
            id: uuidv4(),
            parent_id: currentParentId,
            sequence: nextSeq,
            op_code: opCode,
            name: getUniqueName(template?.name || opCode),
            parameter_config: defaultParams,
            children: [],
            repeat_type: template.repeat_type || 'NONE',
            repeat_count: template.repeat_count || 1,
            byte_len: template.byte_len || 1,
        };

        if (opCode === 'BITFIELD') {
            // Seed one 8-bit segment so the editor has something to show immediately
            newBlock.byte_len = 1;
            newBlock.bits = [{ id: uuidv4(), sequence: 0, bit_name: 'VALUE', start_bit: 0, bit_len: 8, default_val: 0 }];
        }
        if (opCode === 'ARRAY_GROUP') {
            newBlock.byte_len = 0;
            if (!newBlock.parameter_config.max_count) newBlock.parameter_config.max_count = 1;
        }
        if (template?.param_template?.bits) {
            // A1: parameter_config.bits may have been copied as the template ARRAY
            // ([8,16,32,64]) — Math.ceil(array/8) === NaN, which poisoned byte_len.
            // Always store the scalar default and derive byte_len from it.
            const rawBits = template.param_template.bits;
            const defaultBits = Number(Array.isArray(rawBits) ? rawBits[0] : rawBits);
            if (Number.isFinite(defaultBits) && defaultBits > 0) {
                newBlock.parameter_config.bits = defaultBits;
                newBlock.byte_len = Math.ceil(defaultBits / 8);
            }
        }

        // HEX_RAW: default hex must match byte_len exactly (APPLY validates the
        // length), and byte_len may have been adjusted by the bits template above.
        if (opCode === 'HEX_RAW') {
            const byteLen = newBlock.byte_len || 1;
            const currentHex = String(newBlock.parameter_config.hex || '').replace(/\s/g, '');
            if (currentHex.length !== byteLen * 2) {
                newBlock.parameter_config.hex = '00'.repeat(byteLen);
            }
        }

        // A brand-new group should be immediately visible & focusable, otherwise
        // the user would be adding children into a collapsed lane they can't see.
        if (opCode === 'ARRAY_GROUP') {
            setExpandedGroupIds(prev => (prev.includes(newBlock.id) ? prev : [...prev, newBlock.id]));
            setFocusedParentId(newBlock.id);
        }

        updateLocalInstruction({ ...currentInstruction, fields: [...currentInstruction.fields, newBlock] });
    };

    const promptDeleteBlock = (id) => {
        openConfirm("删除所选积木？", () => {
            setInstructions(prev => {
                const active = prev.find(i => i.id === activeInstructionId);
                if (!active) return prev;

                // Cascade: collect the block AND every descendant. Fields form a
                // flat parent_id tree — deleting only the group itself would leave
                // its children pointing at a dead parent, i.e. invisible orphans.
                const removed = new Set([id]);
                let grew = true;
                while (grew) {
                    grew = false;
                    active.fields.forEach(f => {
                        if (f.parent_id && removed.has(f.parent_id) && !removed.has(f.id)) {
                            removed.add(f.id);
                            grew = true;
                        }
                    });
                }

                // Purge dangling references (checksum/length refs & dynamic repeat)
                // so surviving blocks don't keep pointing at deleted fields.
                const scrubbed = active.fields
                    .filter(b => !removed.has(b.id))
                    .map(b => {
                        const refs = b.parameter_config?.refs;
                        const refsGone = Array.isArray(refs) && refs.some(r => removed.has(r));
                        const repeatGone = b.repeat_ref_id && removed.has(b.repeat_ref_id);
                        if (!refsGone && !repeatGone) return b;
                        const parameter_config = { ...b.parameter_config };
                        if (refsGone) parameter_config.refs = refs.filter(r => !removed.has(r));
                        return {
                            ...b,
                            parameter_config,
                            repeat_ref_id: repeatGone ? null : b.repeat_ref_id
                        };
                    });

                return prev.map(i => i.id === active.id ? { ...i, fields: scrubbed } : i);
            });
            setHasUnsavedChanges(true);
            if (selectedId === id) setSelectedId(null);
        });
    }

    const handleSaveBlock = (updatedBlock) => {
        const originalName = currentInstruction.fields.find(f => f.id === updatedBlock.id)?.name;
        if (updatedBlock.name !== originalName) {
            const uniqueName = getUniqueName(updatedBlock.name, updatedBlock.id);
            if (uniqueName !== updatedBlock.name) {
                updatedBlock.name = uniqueName;
                openConfirm(`名称冲突自动修正：\n已重命名为 "${uniqueName}"`, () => { });
            }
        }

        const oldBlock = currentInstruction.fields.find(b => b.id === updatedBlock.id);
        const oldName = oldBlock?.name || oldBlock?.label;
        const newName = updatedBlock.name || updatedBlock.label;
        const isRename = oldName !== newName;
        updatedBlock.updatedAt = Date.now();

        // Structure is never edited in the panel: take parent/sequence from the
        // SAVED state so a stale temp copy cannot silently revert a drag/move
        // that happened while this block was selected.
        if (oldBlock) {
            updatedBlock.parent_id = oldBlock.parent_id;
            updatedBlock.sequence = oldBlock.sequence;
        }

        let newFields = currentInstruction.fields.map(b => b.id === updatedBlock.id ? updatedBlock : b);

        if (isRename) {
            newFields = newFields.map(b => {
                const refs = b.parameter_config?.refs || [];
                const formula = b.parameter_config?.formula;
                if (refs.includes(updatedBlock.id) && typeof formula === 'string' && oldName) {
                    const escapedOld = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`\\[${escapedOld}\\]`, 'g');
                    const newFormula = formula.replace(regex, `[${newName}]`);
                    return { ...b, parameter_config: { ...b.parameter_config, formula: newFormula } };
                }
                return b;
            });
        }
        const newInst = { ...currentInstruction, fields: newFields };
        updateLocalInstruction(newInst);
        // Note: The original code did autosave here via api.updateInstruction directly
        // but maintained local state too. For stricter SRP, we might want to delegate.
        // But keeping it consistent with old behavior:
        // However, 'updateLocalInstruction' in hook only updates STATE.
        // We can call saveChanges optionally or allow the user to save.
        // The original code did an auto-save on block config update.
        // Let's replicate that via the hook's api calls if needed, or just leave as Unsaved Changes.
        // Original: api.updateInstruction(...) .then statusMsg
        // Let's trust "Unsaved Changes" flow for now or use saveChanges() if we want auto-save.
        // For compliance, let's stick to the "User Rules" -> Explicit is better. 
        // But to minimize friction, I will NOT auto-save here, just mark unsaved.
    }

    const handleCanvasClick = (e) => {
        if (pickingMode.isActive) return;
        if (e.target === e.currentTarget || e.target.classList.contains('canvas-bg')) {
            setSelectedId(null);
        }
    };

    const handleSelectInstWrapper = (id) => {
        if (hasUnsavedChanges && activeInstructionId !== id) {
            openConfirm("放弃未保存的更改？", () => {
                loadInstructions().then(() => {
                    setActiveInstructionId(id);
                    setSelectedId(null);
                    setHasUnsavedChanges(false);
                });
            });
        } else {
            setActiveInstructionId(id);
            setSelectedId(null);
            if (activeInstructionId !== id) setHasUnsavedChanges(false);
        }
    };

    return (
        <div className="flex-1 flex overflow-hidden relative">
            <NieRModal isOpen={modalConfig.isOpen} message={modalConfig.message} onConfirm={modalConfig.onConfirm} onCancel={modalConfig.onCancel} />
            <NieRDatePicker
                isOpen={datePickerState.isOpen}
                initialValue={datePickerState.value}
                onConfirm={(iso) => { datePickerState.onConfirmCallback && datePickerState.onConfirmCallback(iso); setDatePickerState(prev => ({ ...prev, isOpen: false })); }}
                onCancel={() => setDatePickerState(prev => ({ ...prev, isOpen: false }))}
            />
            {statusMsg && (
                <div className="absolute top-2 right-2 z-50 text-[10px] font-mono bg-nier-dark border border-nier-light px-2 text-nier-light animate-pulse">
                    SYS: {statusMsg}
                </div>
            )}
            <InstructionListSidebar
                instructions={visibleInstructions}
                activeInstructionId={activeInstructionId}
                searchTerm={searchTerm}
                setSearchTerm={setSearchTerm}
                onSearch={null}
                onSelect={handleSelectInstWrapper}
                onAdd={() => addInstruction(openConfirm)}
                onDelete={(e, id) => deleteInstruction(id, openConfirm)}
                hasUnsavedChanges={hasUnsavedChanges}
            />
            <ComponentPalette
                operatorTemplates={operatorTemplates}
                onAddBlock={handleAddBlock}
                isLoading={isOperatorTemplatesLoading}
                error={operatorTemplatesError}
                hasInstruction={Boolean(currentInstruction)}
                onRetry={loadOperatorTemplates}
            />
            <section className="flex-1 relative bg-[url('/grid.png')] bg-repeat opacity-90 overflow-hidden flex flex-col canvas-bg" onClick={handleCanvasClick}>
                <div className="h-10 border-b border-nier-light bg-nier-dark/90 flex items-center justify-between px-4 gap-2 text-xs font-mono opacity-50">
                    <div className="flex items-center gap-2 cursor-pointer hover:text-nier-light" onClick={() => setSelectedId(null)}>
                        <span>KERNEL EDITOR // {currentInstruction?.device_code} / {currentInstruction?.code}</span>
                    </div>
                    <div className="flex gap-2">
                        {hasUnsavedChanges && <span className="text-yellow-500 animate-pulse">UNSAVED</span>}
                        {hasUnsavedChanges && (
                            <button onClick={() => revertChanges(openConfirm)} className="hover:text-nier-light hover:underline">RESET</button>
                        )}
                    </div>
                </div>
                <Canvas
                    lanes={displayLanes}
                    onMoveItem={(itemId, newParentId, newIndex) => {
                        const allFields = [...currentInstruction.fields];
                        const itemIndex = allFields.findIndex(f => f.id === itemId);
                        if (itemIndex === -1) return;
                        const item = { ...allFields[itemIndex] };
                        allFields.splice(itemIndex, 1);
                        const siblings = allFields.filter(f => (f.parent_id || null) === newParentId).sort((a, b) => a.sequence - b.sequence);
                        siblings.splice(newIndex, 0, item);
                        const updatedSiblings = siblings.map((sib, idx) => ({ ...sib, parent_id: newParentId, sequence: idx }));
                        const finalFields = allFields.filter(f => (f.parent_id || null) !== newParentId);
                        finalFields.push(...updatedSiblings);
                        updateLocalInstruction({ ...currentInstruction, fields: finalFields });
                    }}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    pickingMode={pickingMode}
                    onPickBlock={handlePickBlock}
                    onCancelPick={cancelPicking}
                    focusedParentId={focusedParentId}
                    onSetFocusedLane={setFocusedParentId}
                    isModalOpen={modalConfig.isOpen}
                    expandedGroupIds={expandedGroupIds}
                    onNavigateGroup={handleNavigateGroup}
                />
            </section>
            <BlockPropertiesPanel
                selectedBlock={selectedBlock}
                currentInstruction={currentInstruction}
                operatorTemplates={operatorTemplates}
                hasUnsavedChanges={hasUnsavedChanges}
                onUpdateInstruction={updateLocalInstruction}
                onSaveInstruction={() => saveChanges(openConfirm)}
                onDeleteInstruction={(e, id) => deleteInstruction(id, openConfirm)}
                onDeleteBlock={promptDeleteBlock}
                onSaveBlock={handleSaveBlock}
                openConfirm={openConfirm}
                onOpenDatePicker={(val, cb) => setDatePickerState({ isOpen: true, value: val, onConfirmCallback: cb })}
                pickingMode={pickingMode}
                setPickingMode={setPickingMode}
                onPickBlock={handlePickBlock}
                onTempChange={setPreviewBlock}
                validationIssues={validationIssues}
                onLocateBlock={(id) => { if (id) setSelectedId(id); }}
            />
        </div>
    );
}
