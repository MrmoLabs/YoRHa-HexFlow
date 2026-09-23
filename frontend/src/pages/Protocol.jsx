import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Canvas from '../components/editor/Canvas';
import ProtocolListSidebar from '../components/editor/ProtocolListSidebar';
import ProtocolPropertiesPanel from '../components/editor/ProtocolPropertiesPanel';
import { v4 as uuidv4 } from 'uuid';
import { api } from '../api';
import { serializeProtocol, findNode, buildProtocolLanes, computeProtocolOffsets, moveNode, removeNode, updateNode, collectContainerIds, injectRefsSigma } from '../utils/protocolTree';
import { BLOCK_TYPES, createBlock, isNestable } from '../config/blockTypes';

export default function Protocol({ protocols, setProtocols }) {
    const [activeProtocolId, setActiveProtocolId] = useState(protocols[0]?.id || null);
    const [statusMsg, setStatusMsg] = useState('');
    const [selectedId, setSelectedId] = useState(null);
    const saveTimerRef = useRef(null);
    const statusTimerRef = useRef(null);
    const lastPersistedSignatureRef = useRef('');
    // Debounced-save bookkeeping: remember the pending payload so protocol
    // switches / unmount can FLUSH it instead of dropping it. Otherwise the
    // switch effect rewrites lastPersistedSignatureRef with the IN-MEMORY
    // (dirty) state, the pending save then sees matching signatures and
    // silently skips persisting the edits (lost on reload).
    const pendingSaveRef = useRef(null);
    const flushPendingSave = () => {
        if (!pendingSaveRef.current) return;
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        // saveProtocol is declared later in the component but this helper only
        // ever runs from effects after render; failures surface via showStatus.
        saveProtocol(pending).catch(() => { /* surfaced below in saveProtocol */ });
    };

    useEffect(() => {
        if (!activeProtocolId && protocols.length > 0) {
            setActiveProtocolId(protocols[0].id);
        } else if (!protocols.find(p => p.id === activeProtocolId) && protocols.length > 0) {
            setActiveProtocolId(protocols[0].id);
        }
    }, [protocols, activeProtocolId]);

    useEffect(() => {
        return () => {
            // Persist pending edits instead of dropping them on unmount
            flushPendingSave();
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }
            if (statusTimerRef.current) {
                clearTimeout(statusTimerRef.current);
            }
        };
    }, []);

    // P0-3: a debounced save inside the 350ms window must not be lost to a
    // refresh — block unload while one is pending (refs read at event time).
    useEffect(() => {
        const onBeforeUnload = (e) => {
            if (pendingSaveRef.current || saveTimerRef.current) {
                e.preventDefault();
                e.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, []);

    const showStatus = useCallback((message, durationMs = 0) => {
        if (statusTimerRef.current) {
            clearTimeout(statusTimerRef.current);
            statusTimerRef.current = null;
        }

        setStatusMsg(message);

        if (durationMs > 0) {
            statusTimerRef.current = setTimeout(() => {
                setStatusMsg('');
            }, durationMs);
        }
    }, []);

    const currentProtocol = protocols.find(p => p.id === activeProtocolId) || protocols[0] || null;
    // A+B：内联展开 + 泳道焦点（对标 useInstructionLanes 的
    // expandedGroupIds/focusedParentId；下钻 pathIds/面包屑退役）
    const [expandedContainerIds, setExpandedContainerIds] = useState([]);
    const [focusedParentId, setFocusedParentId] = useState(null);

    useEffect(() => {
        // Flush first: the dirty payload of the protocol we are leaving must be
        // persisted BEFORE lastPersistedSignatureRef is overwritten below.
        flushPendingSave();

        if (!currentProtocol) {
            setExpandedContainerIds([]);
            setFocusedParentId(null);
            setSelectedId(null);
            lastPersistedSignatureRef.current = '';
            return;
        }

        // 切协议默认全展开 + 焦点回根（镜像 useInstructionLanes:50-53）
        setExpandedContainerIds(collectContainerIds(currentProtocol));
        setFocusedParentId(null);
        setSelectedId(null);
        lastPersistedSignatureRef.current = serializeProtocol(currentProtocol);
    }, [activeProtocolId, currentProtocol?.id]);

    const currentLanes = useMemo(
        () => buildProtocolLanes(currentProtocol, expandedContainerIds),
        [currentProtocol, expandedContainerIds]
    );
    // 偏移标尺：容器经适配层判组 → 中心 Σ/??、页脚 @范围（指令页同款效果）
    const protocolOffsets = useMemo(
        () => computeProtocolOffsets(currentProtocol),
        [currentProtocol]
    );
    // A4 设计期 Σ 回显：纯派生注入 computedValue（不落库、checksum 不注入、
    // 悬空/尺寸 null 不注入）→ 画布 Block.jsx:140 原样显示。
    const displayLanes = useMemo(
        () => injectRefsSigma(currentLanes, protocolOffsets.byId),
        [currentLanes, protocolOffsets]
    );

    // 焦点自愈（镜像 useInstructionLanes:58-64）：指向已删/非容器 → 清根
    useEffect(() => {
        if (!focusedParentId) return;
        const node = findNode(currentProtocol, focusedParentId);
        if (!node || !isNestable(node.type)) setFocusedParentId(null);
    }, [focusedParentId, currentProtocol]);

    // 选中块从树上消失（结构删除）→ 清选
    useEffect(() => {
        if (selectedId && !findNode(currentProtocol, selectedId)) {
            setSelectedId(null);
        }
    }, [currentProtocol, selectedId]);

    const applyProtocolUpdate = useCallback((nextProtocol) => {
        setProtocols(prev => prev.map(protocol => protocol.id === nextProtocol.id ? nextProtocol : protocol));
    }, [setProtocols]);

    const saveProtocol = useCallback(async (nextProtocol) => {
        const nextSignature = serializeProtocol(nextProtocol);

        if (lastPersistedSignatureRef.current === nextSignature) {
            return nextProtocol;
        }

        try {
            showStatus('保存中...');
            const saved = await api.updateProtocol(nextProtocol.id, {
                label: nextProtocol.label,
                type: nextProtocol.type,
                description: nextProtocol.description || null,
                children: nextProtocol.children || []
            });
            lastPersistedSignatureRef.current = serializeProtocol(saved);
            applyProtocolUpdate(saved);
            showStatus('协议已保存', 1200);
            return saved;
        } catch (error) {
            console.error('Failed to save protocol', error);
            showStatus('协议保存失败', 1500);
            throw error;
        }
    }, [applyProtocolUpdate, showStatus]);

    const scheduleProtocolSave = useCallback((nextProtocol) => {
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
        }
        pendingSaveRef.current = nextProtocol; // dirty payload, flushed on switch/unmount

        showStatus('待保存...');
        saveTimerRef.current = setTimeout(() => {
            pendingSaveRef.current = null;
            saveTimerRef.current = null;
            saveProtocol(nextProtocol).catch(() => { /* surfaced via showStatus */ });
        }, 350);
    }, [saveProtocol, showStatus]);

    const handleAddProtocol = async () => {
        const newProto = {
            id: uuidv4(),
            label: '新协议 (NEW)',
            type: 'container',
            children: []
        };
        try {
            showStatus('创建协议...');
            const created = await api.createProtocol(newProto);
            setProtocols(prev => [...prev, created]);
            setActiveProtocolId(created.id);
            showStatus('协议已创建', 1200);
        } catch (error) {
            console.error('Failed to create protocol', error);
            showStatus('协议创建失败', 1500);
        }
    };

    const handleDeleteProtocol = async (e, id) => {
        e.stopPropagation();
        if (protocols.length <= 1) return;
        try {
            showStatus('删除协议...');
            await api.deleteProtocol(id);
            const remaining = protocols.filter(p => p.id !== id);
            setProtocols(prev => prev.filter(protocol => protocol.id !== id));
            if (activeProtocolId === id) setActiveProtocolId(remaining[0]?.id || null);
            showStatus('协议已删除', 1200);
        } catch (error) {
            console.error('Failed to delete protocol', error);
            showStatus('协议删除失败', 1500);
        }
    };

    // ===== 树操作（protocolTree.js 纯函数；commit = 乐观更新 + 防抖持久化） =====
    const commitTree = (newRoot) => {
        applyProtocolUpdate(newRoot);
        scheduleProtocolSave(newRoot);
    };

    const handleAddBlock = (type) => {
        if (!currentProtocol) return;
        // 落点 = 焦点泳道（focusedParentId ?? 根），镜像指令页加块进焦点组
        const parent = focusedParentId ? findNode(currentProtocol, focusedParentId) : currentProtocol;
        if (!parent) return;
        const block = createBlock(type, uuidv4);
        commitTree(updateNode(currentProtocol, parent.id, {
            children: [...(parent.children || []), block]
        }));
        // 新容器立即展开 + 聚焦（镜像 Instruction.jsx:266-271：否则用户往看不见的
        // 折叠泳道里加子块）
        if (isNestable(type)) {
            setExpandedContainerIds(prev => (prev.includes(block.id) ? prev : [...prev, block.id]));
            setFocusedParentId(block.id);
        }
    };

    const handleDeleteBlock = (id) => {
        if (!currentProtocol) return;
        // 树剪枝 = 子树整体移除（对齐指令页 flat 模型手写级联的最终效果）
        commitTree(removeNode(currentProtocol, id));
        if (selectedId === id) setSelectedId(null);
    };

    const handleUpdateBlock = (id, updates) => {
        if (!currentProtocol) return;
        commitTree(updateNode(currentProtocol, id, updates));
    };

    // 跨泳道拖拽落点（computeFinalPlacement 已算好 parentId/index）；环/非法
    // 目标 moveNode 原引用早退 → 不持久化（同 moveField 缺源早退口径）
    const handleMoveItem = (itemId, newParentId, newIndex) => {
        if (!currentProtocol) return;
        const next = moveNode(currentProtocol, itemId, newParentId, newIndex);
        if (next !== currentProtocol) commitTree(next);
    };

    // 画布点卡 = 选中 + 容器 toggle 展开。共享 Canvas 对组的双发（select +
    // onNavigateGroup）以 op_code==='ARRAY_GROUP' 为闸，协议容器无 op_code →
    // 在页面层接，零动共享组件。焦点时序对齐指令页：收起时 Canvas 先经
    // onSetFocusedLane 落父泳道（Canvas.jsx:292），展开时这里覆焦到新泳道。
    const handleCanvasSelect = (id) => {
        setSelectedId(id);
        if (!id || !currentProtocol) return;
        const node = findNode(currentProtocol, id);
        if (!node || !isNestable(node.type)) return;
        setExpandedContainerIds(prev => {
            if (prev.includes(id)) return prev.filter(x => x !== id);
            setFocusedParentId(id); // 镜像 handleNavigateGroup:236（updater 内覆焦，幂等）
            return [...prev, id];
        });
    };

    // ENTER = 确保展开 + 聚焦（原"下钻进入"的内联化，属性面板入口保留）
    const handleEnterContainer = (block) => {
        if (!block || !isNestable(block.type)) return;
        setExpandedContainerIds(prev => (prev.includes(block.id) ? prev : [...prev, block.id]));
        setFocusedParentId(block.id);
    };

    // A3 refs 拾取：锚 = 发起 refs 分支的卡（length/checksum）。slot 不可锚
    // （后端 _validate_refs 400）、自引用不可锚（面板发起即锚定当前卡，点锚
    // 自身直接拒绝）。toggle 经 onUpdateRefs 回写 parameter_config.refs
    // （handleUpdateBlock → 防抖落库）；镜像 useSelectionSystem 的中止语义。
    const [pickingMode, setPickingMode] = useState({
        isActive: false, fieldKey: null, anchorId: null, currentRefs: [], onUpdateRefs: null
    });
    const handleStartPicking = (fieldKey, currentRefs, onUpdateRefs) => {
        setPickingMode({ isActive: true, fieldKey, anchorId: selectedId, currentRefs: currentRefs || [], onUpdateRefs });
    };
    const handleStopPicking = () => {
        setPickingMode({ isActive: false, fieldKey: null, anchorId: null, currentRefs: [], onUpdateRefs: null });
    };
    const handlePickBlock = (targetId) => {
        if (!pickingMode.isActive || !currentProtocol) return;
        const target = findNode(currentProtocol, targetId);
        if (!target || target.type === 'slot' || targetId === pickingMode.anchorId) return;
        const current = pickingMode.currentRefs || [];
        const next = current.includes(targetId)
            ? current.filter(x => x !== targetId)
            : [...current, targetId];
        setPickingMode(prev => ({ ...prev, currentRefs: next }));
        pickingMode.onUpdateRefs?.(next);
    };
    // 中止闸（镜像 Instruction.jsx:104-112）：切协议 / 改选中 → 取消拾取
    useEffect(() => {
        setPickingMode(prev => (prev.isActive
            ? { isActive: false, fieldKey: null, anchorId: null, currentRefs: [], onUpdateRefs: null }
            : prev));
    }, [activeProtocolId, selectedId]);
    // ESC 不接（焦点在输入时不拦截）：面板 STOP 按钮 + 画布背景点击 onCancelPick 兜底

    const selectedBlock = selectedId ? findNode(currentProtocol, selectedId) : null;

    if (!currentProtocol) {
        return (
            <div className="flex-1 flex items-center justify-center text-nier-light/40 font-mono tracking-widest">
                LOADING PROTOCOLS...
            </div>
        );
    }

    return (
        <div className="flex-1 flex overflow-hidden">
            {statusMsg && (
                <div className="absolute top-2 right-2 z-50 text-[10px] font-mono bg-nier-dark border border-nier-light px-2 text-nier-light animate-pulse">
                    SYS: {statusMsg}
                </div>
            )}
            {/* Protocols List Sidebar */}
            <ProtocolListSidebar
                protocols={protocols}
                activeProtocolId={activeProtocolId}
                onSelect={setActiveProtocolId}
                onAdd={handleAddProtocol}
                onDelete={handleDeleteProtocol}
            />

            {/* Palette Sidebar */}
            <aside className="w-14 border-r border-nier-light flex flex-col items-center py-4 gap-4 z-10 bg-nier-dark select-none">
                {BLOCK_TYPES.map((blockType, index) => (
                    <React.Fragment key={blockType.type}>
                        {index === 1 && <div className="w-8 h-[1px] bg-nier-light/30 my-2"></div>}
                        <button
                            onClick={() => handleAddBlock(blockType.type)}
                            className={`w-10 h-10 border border-nier-light flex flex-col items-center justify-center text-xs hover:bg-nier-light hover:text-nier-dark active:bg-white active:text-black cursor-pointer leading-3${blockType.palette.dashed ? ' border-dashed' : ''}`}
                            title={blockType.palette.title}
                        >
                            {blockType.palette.mainLabel}
                            <span className="scale-[0.6]">{blockType.palette.subLabel}</span>
                        </button>
                    </React.Fragment>
                ))}
            </aside>

            {/* Canvas Area — A+B: 层级由内联泳道标签/连线表达（指令页同款），
                面包屑下钻条退役；偏移标尺、焦点泳道、跨容器落点全量接线 */}
            <section className="flex-1 relative bg-[url('/grid.png')] bg-repeat opacity-90 overflow-hidden flex flex-col">
                <Canvas
                    lanes={displayLanes}
                    offsets={protocolOffsets.byId}
                    onMoveItem={handleMoveItem}
                    selectedId={selectedId}
                    onSelect={handleCanvasSelect}
                    focusedParentId={focusedParentId}
                    onSetFocusedLane={setFocusedParentId}
                    pickingMode={pickingMode}
                    onPickBlock={handlePickBlock}
                    onCancelPick={handleStopPicking}
                />
            </section>

            {/* Right Panel (Details) */}
            <ProtocolPropertiesPanel
                showProtocolLevel={Boolean(activeProtocolId && currentProtocol && !selectedId)}
                currentProtocol={currentProtocol}
                selectedBlock={selectedBlock}
                onProtocolLabelChange={(updatedProto) => {
                    applyProtocolUpdate(updatedProto);
                    scheduleProtocolSave(updatedProto);
                }}
                onEnterContainer={handleEnterContainer}
                onUpdateBlock={handleUpdateBlock}
                onDeleteBlock={handleDeleteBlock}
                pickingMode={pickingMode}
                onStartPicking={handleStartPicking}
                onStopPicking={handleStopPicking}
            />
        </div>
    );
}
