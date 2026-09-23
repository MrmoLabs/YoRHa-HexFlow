import React, { useState, useEffect, useMemo, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import Canvas from '../components/editor/Canvas';
import { api } from '../api';
import { mergeProtocolInstruction, buildLanes, getTotalBytes, countSlots } from '../utils/blockMerge';
import { InstructionEncoder } from '../utils/InstructionEncoder';
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
    label: binding.label || '',
    // B2: 组内稠密位次出线（本地缺省按 0，服务端列默认 0 对齐）
    slot_order: binding.slotOrder ?? 0
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
    // C1 封装试发：发送中闸 + 回显（SENT: hex / SEND FAILED: detail 含 409）
    const [isSending, setIsSending] = useState(false);
    const [sendMsg, setSendMsg] = useState('');
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
            instructionId: instructions[0]?.id || '',
            slotOrder: 0
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

    // B3 稠密位次：组内成员变更（加/删/换洞）→ 重编号 0..n-1，仅回写真变化行；
    // 挂载不调用（零回写零钳制，服务端行原样显示）。
    const renumberGroup = (base, protocolId) => {
        const group = base
            .filter(b => b.protocolId === protocolId)
            .slice()
            .sort((a, b) => (a.slotOrder ?? 0) - (b.slotOrder ?? 0));
        const numbered = group.map((b, i) => ({ ...b, slotOrder: i }));
        const byId = new Map(numbered.map(b => [b.id, b]));
        const next = base.map(b => byId.get(b.id) || b);
        const changed = numbered.filter((b, i) => (group[i].slotOrder ?? 0) !== i);
        return { next, changed };
    };

    // CRUD Handlers（本地态即时反馈，服务端写入按上方口径）
    const handleAddBinding = () => {
        const protocolId = protocols[0]?.id || '';
        const newBinding = {
            id: uuidv4(),
            label: '新绑定 (NEW)',
            protocolId,
            instructionId: instructions[0]?.id || '',
            // 组内追加：先占组尾洞号，renumberGroup 再落稠密位次
            slotOrder: bindings.filter(b => b.protocolId === protocolId).length
        };
        const base = [...bindings, newBinding];
        const { next, changed } = renumberGroup(base, protocolId);
        const posted = next.find(b => b.id === newBinding.id) || newBinding;
        setBindings(next);
        setActiveBindingId(newBinding.id);
        if (loadFailed) return;
        api.createBinding(toServer(posted))
            .catch((err) => setSyncMsg(syncErrorText('创建失败', err)));
        // 组内老行位次被挤动 → 补写（新行随 createBinding 出线，不重复 PUT）
        changed
            .filter(b => b.id !== newBinding.id)
            .forEach(b => putBinding(toServer(b)));
    };

    const handleDeleteBinding = (e, id) => {
        e.stopPropagation();
        if (bindings.length <= 1) return;
        const target = bindings.find(b => b.id === id);
        const base = bindings.filter(b => b.id !== id);
        const { next, changed } = target
            ? renumberGroup(base, target.protocolId)
            : { next: base, changed: [] };
        setBindings(next);
        if (activeBindingId === id) setActiveBindingId(next[0].id);
        if (loadFailed) return;
        api.deleteBinding(id)
            .catch((err) => setSyncMsg(syncErrorText('删除失败', err)));
        changed.forEach(b => putBinding(toServer(b)));
    };

    // B3 洞位下拉：组内换位（目标位次钳在 0..组内余数）→ 稠密重编号 → 回写变化行
    const handleSlotOrderChange = (targetIndex) => {
        if (!currentBinding) return;
        const group = bindings
            .filter(b => b.protocolId === currentBinding.protocolId)
            .slice()
            .sort((a, b) => (a.slotOrder ?? 0) - (b.slotOrder ?? 0));
        const without = group.filter(b => b.id !== currentBinding.id);
        const at = Math.max(0, Math.min(Number(targetIndex), without.length));
        const reordered = [...without.slice(0, at), currentBinding, ...without.slice(at)]
            .map((b, i) => ({ ...b, slotOrder: i }));
        const byId = new Map(reordered.map(b => [b.id, b]));
        setBindings(prev => prev.map(b => byId.get(b.id) || b));
        if (loadFailed) return;
        reordered.forEach((b) => {
            const before = bindings.find(x => x.id === b.id);
            if ((before?.slotOrder ?? 0) !== b.slotOrder) putBinding(toServer(b));
        });
    };

    // C1 封装试发：合并树走前端 InstructionEncoder 编译（与指令页同链路：
    // getInitialValues → resolveDependencies → encodeInstruction）→ POST /dispatch。
    // instruction_name 用当前绑定指令名；409/失败 detail 透出在 sendMsg。
    const handleTrialSend = async () => {
        if (!mergedBlocks.length || isSending) return;
        setIsSending(true);
        setSendMsg('');
        try {
            const source = { blocks: mergedBlocks };
            const inputs = InstructionEncoder.getInitialValues(source);
            const computed = InstructionEncoder.resolveDependencies(source, inputs);
            const { hexString } = InstructionEncoder.encodeInstruction(source, inputs, computed);
            const instructionName = selectedInstruction?.label || selectedInstruction?.name || null;
            await api.dispatchPayload(hexString, instructionName);
            setSendMsg(`SENT: ${hexString}`);
        } catch (err) {
            setSendMsg(`SEND FAILED: ${err?.message || 'UNKNOWN'}`);
        } finally {
            setIsSending(false);
        }
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

    // B2 组作用域合并：组 = 同 protocolId 的绑定按 slot_order（洞号）升序 →
    // 指令数组依洞序填洞；指令缺失的行跳过（filter(Boolean)）。单绑定退化为
    // E4 原语义（数组长度 1 走同一路径）。
    const groupBindings = useMemo(() => {
        if (!currentBinding) return [];
        return bindings
            .filter(b => b.protocolId === currentBinding.protocolId)
            .slice()
            .sort((a, b) => (a.slotOrder ?? 0) - (b.slotOrder ?? 0));
    }, [bindings, currentBinding]);

    const mergedBlocks = useMemo(() => {
        if (!currentBinding) return [];
        const protocol = protocols.find(p => p.id === currentBinding.protocolId);
        const groupInstructions = groupBindings
            .map(b => instructions.find(i => i.id === b.instructionId))
            .filter(Boolean);
        return mergeProtocolInstruction(protocol, groupInstructions);
    }, [currentBinding, groupBindings, instructions, protocols]);

    // B3 洞位/对账：洞号 = 当前绑定在组内的稠密位次；洞数 = 协议树 DFS slot 计数。
    const holeRank = Math.max(0, groupBindings.findIndex(b => b.id === currentBinding?.id));
    const holeCount = useMemo(() => {
        const protocol = protocols.find(p => p.id === currentBinding?.protocolId);
        return countSlots(protocol?.children || []);
    }, [protocols, currentBinding?.protocolId]);
    const holeWarning = !currentBinding
        ? ''
        : holeCount === 0
            ? '无 SLOT：指令将追加末尾'
            : groupBindings.length > holeCount
                ? `洞位不足：${groupBindings.length} 条绑定 > ${holeCount} 个洞（溢出追加末尾）`
                : groupBindings.length < holeCount
                    ? `空洞：${holeCount - groupBindings.length} 个洞未被绑定填充`
                    : '';

    // 侧栏按（协议序, 洞号）重排：协议序 = protocols 数组序；服务端 GET /bindings
    // 仍全局 slot_order 排，前端不按全局洞号穿插跨协议绑定。
    const sortedBindings = useMemo(() => {
        const protoIndex = (b) => {
            const i = protocols.findIndex(p => p.id === b.protocolId);
            return i === -1 ? protocols.length : i;
        };
        return [...bindings].sort((a, b) => protoIndex(a) - protoIndex(b)
            || ((a.slotOrder ?? 0) - (b.slotOrder ?? 0)));
    }, [bindings, protocols]);

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
                    {sortedBindings.map(b => (
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
                                <div className="flex gap-2 mt-1">
                                    <button
                                        onClick={handleExportBinary}
                                        disabled={!mergedBlocks.length || isExporting}
                                        className="border border-nier-light/60 text-nier-light text-[10px] font-mono tracking-widest px-3 py-1 hover:bg-nier-light hover:text-nier-dark transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {isExporting ? 'EXPORTING...' : 'EXPORT .BIN'}
                                    </button>
                                    {/* C1 封装试发：同合并树前端编译 → POST /dispatch */}
                                    <button
                                        onClick={handleTrialSend}
                                        disabled={!mergedBlocks.length || isSending}
                                        className="border border-nier-light/60 text-nier-light text-[10px] font-mono tracking-widest px-3 py-1 hover:bg-nier-light hover:text-nier-dark transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {isSending ? 'SENDING...' : '封装试发 (TRIAL SEND)'}
                                    </button>
                                </div>
                                {exportMsg && (
                                    <div className={`text-[9px] font-mono mt-0.5 ${exportMsg === 'EXPORT OK' ? 'text-green-400' : 'text-red-400'}`}>
                                        {exportMsg}
                                    </div>
                                )}
                                {sendMsg && (
                                    <div className={`text-[9px] font-mono mt-0.5 break-all ${sendMsg.startsWith('SENT') ? 'text-green-400' : 'text-red-400'}`}>
                                        {sendMsg}
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

                        {/* B3 洞位下拉：value = 组内稠密位次（holeRank）；改洞 →
                            handleSlotOrderChange 组内重编号 0..n-1 仅回写变化行 */}
                        <div className="flex flex-col gap-1">
                            <label htmlFor="hole-rank" className="text-xs opacity-70 uppercase tracking-widest">
                                洞位 (HOLE) · #{holeRank} / {Math.max(groupBindings.length - 1, 0)}
                            </label>
                            <select
                                id="hole-rank"
                                value={holeRank}
                                onChange={(e) => handleSlotOrderChange(Number(e.target.value))}
                                className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono"
                            >
                                {groupBindings.map((b, i) => (
                                    <option key={b.id} value={i} className="bg-nier-dark text-white">
                                        {i}{b.id === currentBinding.id ? ` · 本绑定` : ` · ${b.label}`}
                                    </option>
                                ))}
                            </select>
                            {holeWarning && (
                                <div data-testid="hole-warning" className="text-[10px] font-mono text-yellow-400 tracking-widest">
                                    ⚠ {holeWarning}
                                </div>
                            )}
                        </div>

                        <div className="p-4 border border-dashed border-nier-light/30 bg-nier-light/5 text-xs leading-5">
                            <h3 className="font-bold mb-2">AUTO-ASSEMBLY RULE</h3>
                            <p className="opacity-70">
                                同协议的 {groupBindings.length} 条绑定按洞号（slot_order 升序）依次填入协议的 {holeCount} 个 SLOT。
                            </p>
                            <p className="mt-2 opacity-70">
                                绑定多于洞时溢出部分追加末尾；洞多于绑定时空洞保留（发射期归零）。
                            </p>
                        </div>
                    </div>
                )}
            </aside>
        </div>
    );
}
