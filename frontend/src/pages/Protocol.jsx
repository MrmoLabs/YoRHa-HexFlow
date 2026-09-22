import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Canvas from '../components/editor/Canvas';
import ProtocolListSidebar from '../components/editor/ProtocolListSidebar';
import ProtocolPropertiesPanel from '../components/editor/ProtocolPropertiesPanel';
import { v4 as uuidv4 } from 'uuid';
import { api } from '../api';
import { serializeProtocol, findNode } from '../utils/protocolTree';
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
    const [pathIds, setPathIds] = useState(currentProtocol ? [currentProtocol.id] : []);

    useEffect(() => {
        // Flush first: the dirty payload of the protocol we are leaving must be
        // persisted BEFORE lastPersistedSignatureRef is overwritten below.
        flushPendingSave();

        if (!currentProtocol) {
            setPathIds([]);
            setSelectedId(null);
            lastPersistedSignatureRef.current = '';
            return;
        }

        setPathIds([currentProtocol.id]);
        setSelectedId(null);
        lastPersistedSignatureRef.current = serializeProtocol(currentProtocol);
    }, [activeProtocolId, currentProtocol?.id]);

    const activeContainerNode = currentProtocol
        ? (findNode(currentProtocol, pathIds[pathIds.length - 1]) || currentProtocol)
        : null;
    const currentBlocks = activeContainerNode?.children || [];
    const pathNodes = pathIds
        .map((id) => findNode(currentProtocol, id))
        .filter(Boolean);
    const currentLanes = useMemo(() => [{
        depth: 0,
        parentId: null,
        parentName: activeContainerNode?.label || 'ROOT SEQUENCE',
        items: currentBlocks
    }], [activeContainerNode, currentBlocks]);

    useEffect(() => {
        if (selectedId && !currentBlocks.some(block => block.id === selectedId)) {
            setSelectedId(null);
        }
    }, [currentBlocks, selectedId]);

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

    const updateTree = useCallback((newChildren) => {
        if (!currentProtocol || !activeContainerNode) return;

        const updateRecursive = (node) => {
            if (node.id === activeContainerNode.id) {
                return { ...node, children: newChildren };
            }
            if (!node.children) return node;
            return {
                ...node,
                children: node.children.map(updateRecursive)
            };
        };

        const newRoot = updateRecursive(currentProtocol);
        applyProtocolUpdate(newRoot);
        scheduleProtocolSave(newRoot);
    }, [activeContainerNode, applyProtocolUpdate, currentProtocol, scheduleProtocolSave]);

    const handleSetBlocks = (newBlocks) => {
        updateTree(newBlocks);
    };

    const handleAddBlock = (type) => {
        handleSetBlocks([...currentBlocks, createBlock(type, uuidv4)]);
    };

    const handleDeleteBlock = (id) => {
        const newBlocks = currentBlocks.filter(b => b.id !== id);
        handleSetBlocks(newBlocks);
        if (selectedId === id) setSelectedId(null);
    };

    const handleUpdateBlock = (id, updates) => {
        const newBlocks = currentBlocks.map(b => b.id === id ? { ...b, ...updates } : b);
        handleSetBlocks(newBlocks);
    };

    // Navigation Logic
    const handleEnterContainer = (block) => {
        if (isNestable(block.type)) {
            setPathIds(prev => [...prev, block.id]);
            setSelectedId(null);
        }
    };

    const handleBreadcrumbClick = (index) => {
        setPathIds(prev => prev.slice(0, index + 1));
        setSelectedId(null);
    };

    const selectedBlock = currentBlocks.find(b => b.id === selectedId);

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

            {/* Canvas Area */}
            <section className="flex-1 relative bg-[url('/grid.png')] bg-repeat opacity-90 overflow-hidden flex flex-col">
                {/* Breadcrumbs */}
                    <div className="h-10 border-b border-nier-light bg-nier-dark/90 flex items-center px-4 gap-2 text-xs font-mono">
                    {pathNodes.map((node, index) => (
                        <React.Fragment key={node.id}>
                            <button
                                onClick={() => handleBreadcrumbClick(index)}
                                className={`hover:underline ${index === pathNodes.length - 1 ? 'font-bold decoration-2' : 'opacity-60'}`}
                            >
                                {node.label}
                            </button>
                            {index < pathNodes.length - 1 && <span className="opacity-30">/</span>}
                        </React.Fragment>
                    ))}
                </div>

                <Canvas
                    lanes={currentLanes}
                    onMoveItem={(itemId, _newParentId, newIndex) => {
                        const reordered = [...currentBlocks];
                        const oldIndex = reordered.findIndex(block => block.id === itemId);
                        if (oldIndex === -1 || oldIndex === newIndex) return;
                        const [moved] = reordered.splice(oldIndex, 1);
                        reordered.splice(newIndex, 0, moved);
                        handleSetBlocks(reordered);
                    }}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    focusedParentId={null}
                    onSetFocusedLane={() => { }}
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
            />
        </div>
    );
}
