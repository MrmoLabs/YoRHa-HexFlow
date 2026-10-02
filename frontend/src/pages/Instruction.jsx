import React, { useMemo, useState, useEffect, useRef } from 'react';
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
import { computeByteOffsets } from '../utils/byteOffsets';
import { moveField } from '../utils/moveField';
import { analyzeImport } from '../utils/importExport';
import InstructionTable from '../components/editor/InstructionTable';
import { api } from '../api';

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
        undo, // P4-1 撤销
        redo, // P4-1 重做
        canUndo, // P4-1 栈空禁用
        canRedo, // P4-1 栈空禁用
        saveError, // P4-2 保存失败横幅
        setSaveError, // P4-2 关闭横幅
        addInstruction,
        duplicateInstruction,
        deleteInstruction,
        saveChanges,
        revertChanges,
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

    // P1: byte-offset ruler + total frame length — recomputed on every structural
    // edit (add/delete/drag/APPLY all mutate currentInstruction). exact=false
    // means some block has unknown size → total is a lower bound ("+").
    const byteOffsets = useMemo(
        () => computeByteOffsets(currentInstruction),
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
    // P3-1: 'list' = canvas view (default), 'table' = table view replaces the
    // canvas in the section area. searchTerm/activeSelection live outside the
    // views, so toggling back loses nothing.
    const [viewMode, setViewMode] = useState('list');
    const importInputRef = useRef(null);
    const [modalConfig, setModalConfig] = useState({ isOpen: false, message: '', onConfirm: null, onCancel: null });

    // P4-1: Ctrl+Z / Ctrl+Shift+Z 撤销/重做 —— 输入控件聚焦时或弹窗打开时
    // 不响应（不劫持正常文本撤销）。声明必须在 modalConfig 之后（依赖数组求值）。
    useEffect(() => {
        const onHistoryKey = (e) => {
            const t = e.target;
            const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
            if (typing || modalConfig.isOpen) return;
            if (!(e.ctrlKey || e.metaKey)) return;
            if (e.key === 'z' || e.key === 'Z') {
                e.preventDefault();
                if (e.shiftKey) redo(); else undo();
            }
        };
        window.addEventListener('keydown', onHistoryKey);
        return () => window.removeEventListener('keydown', onHistoryKey);
    }, [undo, redo, modalConfig.isOpen]);
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

        // N2 (G2): 文本字段 —— 8B 默认；pc.type='string' 是编码/显示/校验链的
        // 触发键（param_template 的 keyword 值不会复制进 pc，必须特判设置）；
        // encoding 数组（面板下拉源）创建时归一为标量 'ascii'（A1 数组污染先例）。
        if (opCode === 'STRING') {
            newBlock.byte_len = 8;
            newBlock.parameter_config.type = 'string';
            if (Array.isArray(newBlock.parameter_config.encoding)) {
                newBlock.parameter_config.encoding = 'ascii';
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
            // 反馈 #2 草稿隔离：与新增/编辑同漏斗 —— 工作副本改动只进 hook 内
            // 草稿（updateLocalInstruction），不再经共享 setInstructions 直写。
            const active = currentInstruction;
            if (!active) return;

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

            updateLocalInstruction({ ...active, fields: scrubbed });
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

    // 人工验证第 3 轮 #1: 复制块 UI 入口撤除（指令页不再深拷贝块；
    // duplicateBlockInInstruction util 已随本轮删除）。

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

    // P3-2 导入：parse → analyzeImport（validate + 冲突分流）→ 预览 →
    // 顺序 POST → 结果汇总。冲突/错误只跳过并报告，绝不覆盖（后端 name 与
    // code 双唯一）。
    const handleImportFileChosen = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = ''; // 允许重复选择同一文件
        if (!file) return;

        let raw;
        try {
            raw = JSON.parse(await file.text());
        } catch (err) {
            openConfirm(`文件解析失败：${err?.message || '无效内容'}\n（需要有效的 JSON 文件）`, () => {});
            return;
        }

        const report = analyzeImport(raw, instructions);
        const head = [
            `导入预览：共 ${report.total} 条`,
            `新增 ${report.payloads.length} ／ 冲突跳过 ${report.conflicts.length} ／ 校验错误 ${report.errors.length}`,
        ];
        const conflictLines = report.conflicts.slice(0, 5)
            .map(c => `  冲突「${c.name}」(${c.code || '—'}): ${c.reason}`);
        if (report.conflicts.length > 5) conflictLines.push(`  …另有 ${report.conflicts.length - 5} 条冲突`);
        const errorLines = report.errors.slice(0, 5)
            .map(x => `  错误「${x.name}」: ${x.messages[0]}${x.messages.length > 1 ? ` 等 ${x.messages.length} 项` : ''}`);
        if (report.errors.length > 5) errorLines.push(`  …另有 ${report.errors.length - 5} 条错误`);
        const summary = [...head, ...conflictLines, ...errorLines].join('\n');

        if (report.payloads.length === 0) {
            openConfirm(`${summary}\n没有可导入的指令。`, () => {});
            return;
        }

        openConfirm(`${summary}\n\n确认导入？（不覆盖任何现有指令）`, async () => {
            let ok = 0;
            const failed = [];
            for (const p of report.payloads) {
                try {
                    await api.createInstruction(p);
                    ok += 1;
                } catch (err) {
                    failed.push(`「${p.name}」: ${err?.response?.data?.detail || err?.message || '未知错误'}`);
                }
            }
            try { await loadInstructions(); } catch { /* 列表刷新尽力而为 */ }
            openConfirm(
                [`导入完成：成功 ${ok} ／ 失败 ${failed.length}`, ...failed.slice(0, 6)].join('\n'),
                () => {}
            );
        });
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
                viewMode={viewMode}
                onToggleView={() => setViewMode(m => (m === 'list' ? 'table' : 'list'))}
                onSelect={handleSelectInstWrapper}
                onAdd={() => addInstruction(openConfirm)}
                onDuplicate={(id) => duplicateInstruction(id, openConfirm)}
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
                    <div className="flex gap-2 items-center">
                        <button
                            onClick={undo}
                            disabled={!canUndo}
                            title="撤销上一步编辑 (CTRL+Z)"
                            className="border border-nier-light/40 px-1.5 leading-none hover:bg-nier-light hover:text-black disabled:opacity-30 disabled:pointer-events-none transition-colors"
                        >
                            撤销
                        </button>
                        <button
                            onClick={redo}
                            disabled={!canRedo}
                            title="重做 (CTRL+SHIFT+Z)"
                            className="border border-nier-light/40 px-1.5 leading-none hover:bg-nier-light hover:text-black disabled:opacity-30 disabled:pointer-events-none transition-colors"
                        >
                            重做
                        </button>
                        <button
                            onClick={() => importInputRef.current && importInputRef.current.click()}
                            title="从 JSON 文件导入指令 (IMPORT)"
                            className="border border-nier-light/40 px-1.5 leading-none hover:bg-nier-light hover:text-black transition-colors"
                        >
                            导入
                        </button>
                        <span
                            className="font-bold"
                            title={byteOffsets.variable
                                ? (byteOffsets.exact
                                    ? `变长指令：含动态重复或值驱动长度，当前结构可算约 ${byteOffsets.total} 字节`
                                    : `变长指令：存在未知长度块，${byteOffsets.total}B 为下限`)
                                : `定长指令：总长恒为 ${byteOffsets.total} 字节`}
                        >
                            LEN {byteOffsets.variable && byteOffsets.exact && '~'}{byteOffsets.total}B{!byteOffsets.exact && '+'}
                            <span className={`ml-1 ${byteOffsets.variable ? 'text-[#E58D28]' : 'opacity-50'}`}>
                                {byteOffsets.variable ? 'VAR' : 'FIXED'}
                            </span>
                        </span>
                        {hasUnsavedChanges && <span className="text-yellow-500 animate-pulse">UNSAVED</span>}
                        {hasUnsavedChanges && (
                            <button onClick={() => revertChanges(openConfirm)} className="hover:text-nier-light hover:underline">RESET</button>
                        )}
                    </div>
                </div>
                {/* P4-2: persistent save-failure banner (retryable) — P0-2
                    validation failures use the modal path instead. */}
                {saveError && (
                    <div className="border-b border-[#E58D28]/60 bg-nier-dark flex items-center gap-3 px-4 py-1.5 text-[11px] font-mono text-[#FFB74D]">
                        <span className="font-bold whitespace-nowrap">保存失败 SAVE FAILED</span>
                        <span className="flex-1 truncate" title={saveError}>{saveError}</span>
                        <span className="opacity-70 whitespace-nowrap">本地更改保留 · RESET 可放弃</span>
                        <button
                            onClick={() => saveChanges(openConfirm)}
                            className="border border-[#FFB74D]/60 px-1.5 leading-none hover:bg-[#FFB74D] hover:text-black transition-colors"
                        >
                            重试
                        </button>
                        <button
                            onClick={() => setSaveError('')}
                            title="关闭横幅（本地更改仍保留）"
                            className="border border-[#FFB74D]/60 px-1.5 leading-none hover:bg-[#FFB74D] hover:text-black transition-colors"
                        >
                            ×
                        </button>
                    </div>
                )}
                <input
                    ref={importInputRef}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={handleImportFileChosen}
                />
                {viewMode === 'table' ? (
                    <InstructionTable
                        instructions={visibleInstructions}
                        activeInstructionId={activeInstructionId}
                        onSelect={handleSelectInstWrapper}
                        searchTerm={searchTerm}
                        setSearchTerm={setSearchTerm}
                    />
                ) : (
                <Canvas
                    lanes={displayLanes}
                    offsets={byteOffsets.byId}
                    onMoveItem={(itemId, newParentId, newIndex) => {
                        // C1-d: splice 逻辑抽为纯函数 moveField（单测覆盖）；
                        // 源字段缺失 → 同一引用 → 跳过 updateLocalInstruction。
                        const nextFields = moveField(currentInstruction.fields, itemId, newParentId, newIndex);
                        if (nextFields !== currentInstruction.fields) {
                            updateLocalInstruction({ ...currentInstruction, fields: nextFields });
                        }
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
                    validationIssues={validationIssues}
                />
                )}
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
