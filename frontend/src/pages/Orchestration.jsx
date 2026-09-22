import React, { useState, useEffect, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import Canvas from '../components/editor/Canvas';
import { api } from '../api';
import { mergeProtocolInstruction, buildLanes, getTotalBytes } from '../utils/blockMerge';
import { toFrameBlocks } from '../utils/toFrameBlocks';
import { triggerBlobDownload } from '../utils/download';

export default function Orchestration({ protocols, instructions }) {
    // State for Bindings (Mappings)
    const [bindings, setBindings] = useState([]);
    const [activeBindingId, setActiveBindingId] = useState(null);
    const [isExporting, setIsExporting] = useState(false);
    const [exportMsg, setExportMsg] = useState('');

    // Initial Binding
    useEffect(() => {
        if (bindings.length === 0) {
            const initial = {
                id: uuidv4(),
                label: '默认绑定 (DEFAULT)',
                protocolId: protocols[0]?.id,
                instructionId: instructions[0]?.id
            };
            setBindings([initial]);
            setActiveBindingId(initial.id);
        }
    }, [bindings.length, instructions, protocols]);

    useEffect(() => {
        if (!bindings.length) return;

        setBindings(prev => prev.map(binding => ({
            ...binding,
            protocolId: binding.protocolId || protocols[0]?.id,
            instructionId: binding.instructionId || instructions[0]?.id
        })));
    }, [instructions, protocols]);

    const currentBinding = bindings.find(b => b.id === activeBindingId) || bindings[0];

    // CRUD Handlers
    const handleAddBinding = () => {
        const newBinding = {
            id: uuidv4(),
            label: '新绑定 (NEW)',
            protocolId: protocols[0]?.id,
            instructionId: instructions[0]?.id
        };
        setBindings([...bindings, newBinding]);
        setActiveBindingId(newBinding.id);
    };

    const handleDeleteBinding = (e, id) => {
        e.stopPropagation();
        if (bindings.length <= 1) return;
        const remaining = bindings.filter(b => b.id !== id);
        setBindings(remaining);
        if (activeBindingId === id) setActiveBindingId(remaining[0].id);
    };

    const handleUpdateBinding = (id, updates) => {
        setBindings(bindings.map(b => b.id === id ? { ...b, ...updates } : b));
    };

    // MERGE LOGIC: Combine Protocol + Instruction (see utils/blockMerge.js)
    const mergedBlocks = useMemo(() => {
        if (!currentBinding) return [];
        const protocol = protocols.find(p => p.id === currentBinding.protocolId);
        const instruction = instructions.find(i => i.id === currentBinding.instructionId);
        return mergeProtocolInstruction(protocol, instruction);
    }, [currentBinding, instructions, protocols]);

    const mergedLanes = useMemo(() => buildLanes(mergedBlocks), [mergedBlocks]);

    const totalBytes = getTotalBytes(mergedBlocks);
    const selectedInstruction = instructions.find(i => i.id === currentBinding?.instructionId);

    // Export merged blocks as .bin (server-side compile via Orchestrator)
    const handleExportBinary = async () => {
        if (!mergedBlocks.length || isExporting) return;
        setIsExporting(true);
        setExportMsg('');
        try {
            const bindingLabel = (currentBinding?.label || 'binding').replace(/[^\w.\-]+/g, '_');
            const blob = await api.exportBinaryFromBlocks(toFrameBlocks(mergedBlocks), `${bindingLabel}.bin`);
            triggerBlobDownload(blob, `${bindingLabel}.bin`);
            setExportMsg('EXPORT OK');
        } catch (err) {
            setExportMsg(`EXPORT FAILED: ${err?.message || 'UNKNOWN'}`);
        } finally {
            setIsExporting(false);
        }
    };

    return (
        <div className="flex-1 flex overflow-hidden">
            {/* Binding List Sidebar */}
            <aside className="w-48 border-r border-nier-light/30 bg-nier-dark/50 flex flex-col">
                <div className="p-4 border-b border-nier-light/30 flex justify-between items-center">
                    <span className="text-xs font-bold tracking-widest">绑定列表 (Bindings)</span>
                    <button onClick={handleAddBinding} className="hover:text-white text-lg leading-none">+</button>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {bindings.map(b => (
                        <div
                            key={b.id}
                            onClick={() => setActiveBindingId(b.id)}
                            className={`p-3 border-b border-nier-light/10 cursor-pointer hover:bg-white/5 flex justify-between group ${b.id === activeBindingId ? 'bg-nier-light/10 text-white font-bold' : 'text-nier-light/70'}`}
                        >
                            <div className="truncate text-xs">{b.label}</div>
                            <button onClick={(e) => handleDeleteBinding(e, b.id)} className="opacity-0 group-hover:opacity-100 hover:text-red-400">×</button>
                        </div>
                    ))}
                </div>
            </aside>

            {/* Main Area */}
            <section className="flex-1 flex flex-col bg-[url('/grid.png')] relative">
                {/* Configuration Header */}
                <div className="h-16 border-b border-nier-light/50 bg-nier-dark/90 flex items-center px-6 gap-8 z-20">
                    {currentBinding && (
                        <>
                            <div className="flex flex-col gap-1 w-64">
                                <label className="text-[10px] opacity-70 uppercase tracking-widest">协议外壳 (Protocol Shell)</label>
                                <select
                                    value={currentBinding.protocolId}
                                    onChange={(e) => handleUpdateBinding(currentBinding.id, { protocolId: e.target.value })}
                                    className="bg-transparent border-b border-nier-light/50 text-sm focus:outline-none focus:border-nier-light py-1 font-mono"
                                >
                                    {protocols.map(p => <option key={p.id} value={p.id} className="bg-nier-dark text-white">{p.label}</option>)}
                                </select>
                            </div>

                            <div className="text-xl opacity-50 font-thin">+</div>

                            <div className="flex flex-col gap-1 w-64">
                                <label className="text-[10px] opacity-70 uppercase tracking-widest">指令内核 (Instruction Kernel)</label>
                                <select
                                    value={currentBinding.instructionId}
                                    onChange={(e) => handleUpdateBinding(currentBinding.id, { instructionId: e.target.value })}
                                    className="bg-transparent border-b border-nier-light/50 text-sm focus:outline-none focus:border-nier-light py-1 font-mono"
                                >
                                    {instructions.map(i => <option key={i.id} value={i.id} className="bg-nier-dark text-white">{i.label || i.name}</option>)}
                                </select>
                            </div>

                            <div className="ml-auto flex flex-col items-end">
                                <label className="text-[10px] opacity-70 uppercase tracking-widest">总长度 (Total Size)</label>
                                <div className="text-xl font-bold font-mono">{totalBytes} <span className="text-sm font-normal opacity-50">Bytes</span></div>
                                <button
                                    onClick={handleExportBinary}
                                    disabled={!mergedBlocks.length || isExporting}
                                    className="mt-1 border border-nier-light/60 text-nier-light text-[10px] font-mono tracking-widest px-3 py-1 hover:bg-nier-light hover:text-nier-dark transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    {isExporting ? 'EXPORTING...' : 'EXPORT .BIN'}
                                </button>
                                {exportMsg && (
                                    <div className={`text-[9px] font-mono mt-0.5 ${exportMsg === 'EXPORT OK' ? 'text-green-400' : 'text-red-400'}`}>
                                        {exportMsg}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Visual Preview */}
                <div className="flex-1 overflow-hidden relative flex flex-col">
                    <div className="absolute top-4 left-6 text-xs font-mono opacity-50 tracking-widest">
                        ASSEMBLY PREVIEW //
                        {protocols.find(p => p.id === currentBinding?.protocolId)?.label} ::
                        {selectedInstruction?.label || selectedInstruction?.name}
                    </div>

                    <Canvas
                        lanes={mergedLanes}
                        onMoveItem={() => { }}
                        selectedId={null}
                        onSelect={() => { }}
                        isReadOnly={true}
                        focusedParentId={null}
                        onSetFocusedLane={() => { }}
                    />
                </div>

                {/* Footer / Hex Dump Preview */}
                <div className="h-32 border-t border-nier-light/50 bg-nier-dark/95 p-4 font-mono text-xs overflow-y-auto">
                    <div className="opacity-50 mb-2 tracking-widest uppercase">Hex Stream Simulation</div>
                    <div className="break-all leading-relaxed opacity-80">
                        {/* Mock Hex Stream based on structure */}
                        {mergedBlocks.map((b, i) => (
                            <span key={i} className={`mr-2 ${b.isInjected ? 'text-yellow-400 font-bold' : ''}`}>
                                {b.children ? `[${b.label}]` : (b.hex_value || '00'.repeat(b.byte_length)).toUpperCase()}
                            </span>
                        ))}
                    </div>
                    <div className="mt-2 text-[10px] text-yellow-400 opacity-70">* Yellow indicates injected Payload</div>
                </div>
            </section>

            {/* Right Panel (Details - Binding Info) */}
            <aside className="w-80 border-l border-nier-light bg-nier-dark/95 backdrop-blur-sm p-4 flex flex-col z-20 shadow-[-5px_0_15px_rgba(0,0,0,0.1)]">
                <h2 className="text-lg border-b-2 border-nier-light mb-6 pb-1 font-bold tracking-wider">绑定属性 (BINDING)</h2>
                {currentBinding && (
                    <div className="space-y-6 text-sm">
                        <div className="flex flex-col gap-1">
                            <label className="text-xs opacity-70 uppercase tracking-widest">绑定名称 (Label)</label>
                            <input
                                type="text"
                                value={currentBinding.label}
                                onChange={(e) => handleUpdateBinding(currentBinding.id, { label: e.target.value })}
                                className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide"
                            />
                        </div>

                        <div className="p-4 border border-dashed border-nier-light/30 bg-nier-light/5 text-xs leading-5">
                            <h3 className="font-bold mb-2">AUTO-ASSEMBLY RULE</h3>
                            <p className="opacity-70">
                                The system looks for a 'SLOT' block in the Protocol.
                                It replaces the Slot with the entire Instruction block list.
                            </p>
                            <p className="mt-2 opacity-70">
                                If no Slot is found, instructions are appended to the end.
                            </p>
                        </div>
                    </div>
                )}
            </aside>
        </div>
    );
}
