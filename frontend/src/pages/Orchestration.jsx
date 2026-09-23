import React, { useState, useEffect, useMemo, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import Canvas from '../components/editor/Canvas';
import { api } from '../api';
import { mergeProtocolInstruction, buildLanes, getTotalBytes } from '../utils/blockMerge';
import { toFrameBlocks } from '../utils/toFrameBlocks';
import { triggerBlobDownload } from '../utils/download';

// E4 编排绑定持久化：绑定列表接后端 /bindings CRUD（新表 protocol_bindings）。
// 行为口径：挂载 GET 对账 → 空表种默认绑定（服务端也 POST 一份）→ 加/删即时
// 写、协议/指令选择即时 PUT、label 输入 400ms 防抖合并（卸载冲刷）；加载失败
// 降级为纯本地编辑（提示条，不写后端）。props 到位后回填缺失 id 并补写。

// 本地态 ⇄ API 载荷（snake_case 出线，字段与 backend/schemas/binding_api.py 对齐）
const toServer = (binding) => ({
    id: binding.id,
    protocol_id: binding.protocolId || '',
    instruction_id: binding.instructionId || '',
    label: binding.label || ''
});

const toLocal = (row) => ({
    id: row.id,
    label: row.label,
    protocolId: row.protocol_id,
    instructionId: row.instruction_id,
    slotOrder: row.slot_order
});

const syncErrorText = (prefix, err) => `${prefix}：${err?.message || '后端不可用'}`;

export default function Orchestration({ protocols, instructions }) {
    // State for Bindings (Mappings)
    const [bindings, setBindings] = useState([]);
    const [activeBindingId, setActiveBindingId] = useState(null);
    const [isExporting, setIsExporting] = useState(false);
    const [exportMsg, setExportMsg] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    const [syncMsg, setSyncMsg] = useState('');

    // 持久化节拍：label 打字合并 400ms 防抖；pending 载荷用于卸载冲刷
    const persistTimerRef = useRef(null);
    const pendingRef = useRef(null);

    const putBinding = (payload) =>
        api.updateBinding(payload.id, payload)
            .then(() => { pendingRef.current = null; })
            .catch((err) => setSyncMsg(syncErrorText('更新失败', err)));

    // 1) 挂载拉取服务端绑定；失败降级本地编辑并提示
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const rows = await api.getBindings();
                if (!alive) return;
                setBindings(rows.map(toLocal));
                if (rows.length) setActiveBindingId(rows[0].id);
                setSyncMsg('');
            } catch (err) {
                if (!alive) return;
                setLoadFailed(true);
                setSyncMsg(syncErrorText('加载失败', err) + '（本地编辑不持久化）');
            } finally {
                if (alive) setLoaded(true);
            }
        })();
        return () => { alive = false; };
    }, []);

    // 2) 加载完成后空表种默认绑定：服务端空则同步 POST 落库；加载失败仅本地
    useEffect(() => {
        if (!loaded || bindings.length) return;
        const initial = {
            id: uuidv4(),
            label: '默认绑定 (DEFAULT)',
            protocolId: protocols[0]?.id || '',
            instructionId: instructions[0]?.id || ''
        };
        setBindings([initial]);
        setActiveBindingId(initial.id);
        if (!loadFailed) {
            api.createBinding(toServer(initial))
                .catch((err) => setSyncMsg(syncErrorText('创建失败', err)));
        }
    }, [loaded, loadFailed, bindings.length, protocols, instructions]);

    // 3) props 到位后回填缺失的 protocol/instruction id，并补写服务端
    useEffect(() => {
        if (!loaded || !bindings.length) return;
        const changed = [];
        const next = bindings.map((binding) => {
            const protocolId = binding.protocolId || protocols[0]?.id || '';
            const instructionId = binding.instructionId || instructions[0]?.id || '';
            if (protocolId === binding.protocolId && instructionId === binding.instructionId) {
                return binding;
            }
            const merged = { ...binding, protocolId, instructionId };
            changed.push(merged);
            return merged;
        });
        if (!changed.length) return;
        setBindings(next);
        if (!loadFailed) {
            changed.forEach((binding) => {
                api.updateBinding(binding.id, toServer(binding))
                    .catch((err) => setSyncMsg(syncErrorText('更新失败', err)));
            });
        }
    }, [loaded, loadFailed, instructions, protocols, bindings]);

    // 卸载冲刷：仍有未落盘的防抖写 → 立即补一笔（路由切走/F5 场景）
    useEffect(() => () => {
        if (persistTimerRef.current) {
            clearTimeout(persistTimerRef.current);
            const payload = pendingRef.current;
            if (payload) api.updateBinding(payload.id, payload).catch(() => {});
        }
    }, []);

    const currentBinding = bindings.find(b => b.id === activeBindingId) || bindings[0];

    // CRUD Handlers（本地态即时反馈，服务端写入按上方口径）
    const handleAddBinding = () => {
        const newBinding = {
            id: uuidv4(),
            label: '新绑定 (NEW)',
            protocolId: protocols[0]?.id || '',
            instructionId: instructions[0]?.id || ''
        };
        setBindings([...bindings, newBinding]);
        setActiveBindingId(newBinding.id);
        if (loadFailed) return;
        api.createBinding(toServer(newBinding))
            .catch((err) => setSyncMsg(syncErrorText('创建失败', err)));
    };

    const handleDeleteBinding = (e, id) => {
        e.stopPropagation();
        if (bindings.length <= 1) return;
        const remaining = bindings.filter(b => b.id !== id);
        setBindings(remaining);
        if (activeBindingId === id) setActiveBindingId(remaining[0].id);
        if (loadFailed) return;
        api.deleteBinding(id)
            .catch((err) => setSyncMsg(syncErrorText('删除失败', err)));
    };

    const handleUpdateBinding = (id, updates) => {
        const next = bindings.map(b => b.id === id ? { ...b, ...updates } : b);
        setBindings(next);
        const merged = next.find(b => b.id === id);
        if (!merged || loadFailed) return;

        const payload = toServer(merged);
        pendingRef.current = payload;
        if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
        if (Object.prototype.hasOwnProperty.call(updates, 'label')) {
            // label 打字：400ms 尾随防抖，多次击键合并为最终快照
            persistTimerRef.current = setTimeout(() => {
                persistTimerRef.current = null;
                putBinding(payload);
            }, 400);
        } else {
            // 协议/指令选择：立即落盘（同时清掉更早的 label 待写，避免旧快照回冲）
            persistTimerRef.current = null;
            putBinding(payload);
        }
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
                {syncMsg && (
                    <div className="px-3 py-2 border-b border-nier-light/20 text-[10px] font-mono text-red-300 break-all">
                        {syncMsg}
                    </div>
                )}
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
                <div className="p-2 border-t border-nier-light/20 text-[9px] font-mono opacity-40 tracking-widest text-center">
                    PERSIST // /bindings CRUD
                </div>
            </aside>

            {/* Main Area */}
            <section className="flex-1 flex flex-col bg-[url('/grid.png')] relative">
                {/* Configuration Header */}
                <div className="h-16 border-b border-nier-light/50 bg-nier-dark/90 flex items-center px-4 gap-8 z-20">
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
                                {b.children?.length ? `[${b.label}]` : (b.hex_value || '00'.repeat(b.byte_length || 0)).toUpperCase()}
                            </span>
                        ))}
                    </div>
                    <div className="mt-2 text-[10px] text-yellow-400 opacity-70">* Yellow indicates injected Payload</div>
                </div>
            </section>

            {/* Right Panel (Details - Binding Info) */}
            <aside className="w-80 border-l border-nier-light bg-nier-dark/95 p-4 flex flex-col z-20 shadow-[-5px_0_15px_rgba(0,0,0,0.1)]">
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
