import React, { useState, useEffect, useRef } from 'react';
import {
    DndContext,
    closestCenter,
    pointerWithin,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    useDroppable,
    DragOverlay,
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import Block from './Block';
import { buildIssueMap } from '../../utils/issueBadges';
import { useCanvasConnections } from '../../hooks/useCanvasConnections';
import { computeFinalPlacement } from '../../utils/computePlacement';
import { computeInsertionSide } from '../../utils/computeInsertionSide';

// Lane Component to handle Droppable logic cleanly
function LaneContainer({ lane, index, children, isActiveLane, onSetFocusedLane }) {
    const { setNodeRef } = useDroppable({
        id: `lane-container-${index}`,
        data: { laneIndex: index, parentId: lane.parentId }
    });

    return (
        <div
            ref={setNodeRef}
            onClick={(e) => {
                e.stopPropagation();
                onSetFocusedLane && onSetFocusedLane(lane.parentId);
            }}
            className={`relative flex gap-1 items-end min-w-max p-4 border border-dashed min-h-[140px] transition-all duration-300 cursor-pointer
                ${isActiveLane ? 'border-nier-light/40 bg-nier-light/5 opacity-100 grayscale-0 scale-[1.01]' : 'border-nier-light/10 bg-transparent opacity-80 grayscale scale-100'}
            `}
        >
            {children}
        </div>
    );
}

export default function Canvas({
    lanes = [],
    offsets = null, // P1: Map<id, {offset,size,isGroup}> byte-offset ruler (from utils/byteOffsets)
    onMoveItem, // (itemId, newParentId, newIndex) => void
    selectedId,
    onSelect,
    pickingMode,
    onPickBlock,
    onCancelPick,
    onNavigateGroup, // Toggle Expand/Collapse
    focusedParentId = null,
    onSetFocusedLane,
    isModalOpen = false,
    validationIssues = null // 验证反馈批次: {errors, warnings}（带 blockId）→ 卡片标色
}) {

    const [activeDragId, setActiveDragId] = useState(null);
    const [dragOverLaneIndex, setDragOverLaneIndex] = useState(null); // Track which lane is hovered (by index for local DnD)
    // P4-3: amber insertion-line hint — { side, left, top, height } in content
    // coordinates, or null (lane backgrounds keep the focus highlight only).
    const [dropHint, setDropHint] = useState(null);

    // 验证反馈批次：校验清单 → Map<blockId, {level, messages}>（错误优先、
    // 消息聚合）。不传（蓝图/编排页）→ 空 Map，卡片现状零变化。
    const issueMap = React.useMemo(() => buildIssueMap(validationIssues), [validationIssues]);

    // Refs
    const canvasRef = useRef(null);
    const contentRef = useRef(null);

    // P2-feedback (v2): long-press the LEFT button on EMPTY space and drag to
    // pan (mouse only). Start area = anywhere on the canvas EXCEPT cards (dnd)
    // and controls — most "blank-looking" pixels belong to lane / wrapper
    // elements, so requiring the bare root as target made the gesture feel
    // dead. Once movement crosses the 3px threshold the pointer stream is
    // captured by the canvas (the drag never dies crossing cards/overlays);
    // the content wrapper carries a min scroll slack so short/wide content
    // still has BOTH axes to pan into (no more dead vertical axis). The
    // release click is swallowed in onClickCapture so panning never
    // deselects or re-focuses a lane (lane stopPropagation can't bypass it).
    const panRef = useRef(null);
    const suppressClickRef = useRef(false);

    useEffect(() => {
        const finishPan = (suppressClick) => {
            const pan = panRef.current;
            if (!pan) return;
            if (suppressClick && pan.moved) suppressClickRef.current = true;
            try {
                if (canvasRef.current?.hasPointerCapture?.(pan.pointerId)) {
                    canvasRef.current.releasePointerCapture(pan.pointerId);
                }
            } catch { /* capture already released */ }
            panRef.current = null;
            canvasRef.current?.classList.remove('cursor-grabbing');
        };

        const handlePanMove = (e) => {
            const pan = panRef.current;
            if (!pan || e.pointerId !== pan.pointerId) return;
            if (e.buttons === 0) { finishPan(false); return; } // released outside the window
            const dx = e.clientX - pan.startX;
            const dy = e.clientY - pan.startY;
            if (!pan.moved) {
                if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return; // still a click candidate
                pan.moved = true;
                canvasRef.current?.classList.add('cursor-grabbing');
                try { canvasRef.current?.setPointerCapture?.(pan.pointerId); } catch { /* ok */ }
            }
            canvasRef.current.scrollLeft = pan.startScrollLeft - dx;
            canvasRef.current.scrollTop = pan.startScrollTop - dy;
        };
        const handlePanUp = (e) => {
            if (panRef.current && e.pointerId === panRef.current.pointerId) finishPan(true);
        };
        const handlePanCancel = (e) => {
            if (panRef.current && e.pointerId === panRef.current.pointerId) finishPan(false);
        };
        window.addEventListener('pointermove', handlePanMove);
        window.addEventListener('pointerup', handlePanUp);
        window.addEventListener('pointercancel', handlePanCancel);
        return () => {
            window.removeEventListener('pointermove', handlePanMove);
            window.removeEventListener('pointerup', handlePanUp);
            window.removeEventListener('pointercancel', handlePanCancel);
        };
    }, []);

    const handlePanPointerDown = (e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        const t = e.target;
        if (!canvasRef.current || !canvasRef.current.contains(t)) return;
        // cards keep dnd; controls keep their clicks
        if (t.closest && t.closest('button, a, input, select, textarea, [id^="block-"]')) return;
        suppressClickRef.current = false; // fresh gesture — any stale flag is void
        e.preventDefault(); // no text selection while dragging
        panRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            startScrollLeft: canvasRef.current.scrollLeft,
            startScrollTop: canvasRef.current.scrollTop,
            moved: false,
        };
    };

    // useCanvasConnections Hook (Replaces lengthy useEffect)
    const { connectionPaths, hierarchyLines } = useCanvasConnections(lanes, selectedId, pickingMode, contentRef);
    // Full-content signature: localLanes must re-sync on ANY lanes change
    // (byte_len / name / hex / computedValue…, not just structure) so live
    // property edits and canvas previews actually reach the rendered cards.
    // DnD is unaffected: mid-drag the incoming lanes content stays identical,
    // so the effect below does not clobber local drag state.
    const lanesSignature = JSON.stringify(lanes);

    // SENSORS
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { distance: 8 },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
            keyboardCodes: {
                start: isModalOpen ? [] : ['Space', 'Enter'],
                cancel: ['Escape'],
                end: ['Space', 'Enter']
            }
        })
    );

    // Local state for DnD visual updates
    const [localLanes, setLocalLanes] = useState(lanes);
    const previousLanesSignatureRef = useRef(lanesSignature);
    useEffect(() => {
        if (previousLanesSignatureRef.current !== lanesSignature) {
            previousLanesSignatureRef.current = lanesSignature;
            setLocalLanes(lanes);
        }
    }, [lanes, lanesSignature]);

    const handleDragStart = (event) => { setActiveDragId(event.active.id); }

    const handleDragOver = (event) => {
        const { active, over } = event;
        if (!over) { setDragOverLaneIndex(null); return; }

        const findLane = (id) => {
            if (String(id).startsWith('lane-container-')) {
                const idx = parseInt(id.split('-')[2]);
                return localLanes[idx];
            }
            return localLanes.find(l => l.items.find(i => i.id === id));
        };

        const sourceLane = findLane(active.id);
        const targetLane = findLane(over.id);

        if (!sourceLane || !targetLane) return;

        // P4-3: 2px amber insertion line on the target CARD's edge (lane
        // backgrounds keep the existing focus highlight; self-over clears it).
        // Side follows the arrayMove preview: the dragged card lands on over's
        // RIGHT when it currently sits before it, LEFT otherwise. Rect math is
        // relative to the positioned content layer (the line is absolute in it).
        if (over.id === active.id || String(over.id).startsWith('lane-container-')) {
            setDropHint(null);
        } else {
            const el = document.getElementById(`block-${over.id}`);
            const origin = contentRef.current;
            if (el && origin) {
                const er = el.getBoundingClientRect();
                const cr = origin.getBoundingClientRect();
                const overLane = localLanes.find(l => l.items.some(i => i.id === over.id));
                // C1-c: 侧别推导抽为纯函数（computeInsertionSide，单测覆盖）；
                // self-over 已在外层清除，?? 'left' 仅为几何兜底。
                const side = computeInsertionSide(overLane ? overLane.items : null, active.id, over.id) ?? 'left';
                const left = Math.round((side === 'right' ? er.right : er.left) - cr.left);
                const top = Math.round(er.top - cr.top);
                const height = Math.round(er.height);
                // Bail out on identical geometry so steady hovering doesn't re-render.
                setDropHint(prev => (prev && prev.side === side && prev.left === left && prev.top === top && prev.height === height)
                    ? prev
                    : { side, left, top, height });
            } else {
                setDropHint(null);
            }
        }

        let newLaneIndex = null;
        if (over.id.toString().startsWith('lane-container-')) {
            newLaneIndex = parseInt(over.id.split('-')[2]);
        } else if (targetLane) {
            newLaneIndex = localLanes.indexOf(targetLane);
        }
        if (newLaneIndex !== null) setDragOverLaneIndex(newLaneIndex);

        if (sourceLane === targetLane) {
            // Same lane: DO NOT reorder `items` physically mid-drag.
            // The SortableContext strategy already previews avoidance via CSS transforms;
            // mutating `items` here made dnd-kit flip `itemsHaveChanged` → disable
            // transforms + re-measure rects on every index crossing, so cards jumped
            // and slid back instead of gliding. Final order is resolved in
            // handleDragEnd from `over` (arrayMove semantics).
            return;
        }

        setLocalLanes(prev => {
            const activeItem = sourceLane.items.find(i => i.id === active.id);
            if (!activeItem) return prev;
            const newSourceItems = sourceLane.items.filter(i => i.id !== active.id);
            const newTargetItems = [...targetLane.items];
            const overIndex = over.id.toString().startsWith('lane-container-') ? newTargetItems.length : newTargetItems.findIndex(i => i.id === over.id);
            const finalIndex = overIndex >= 0 ? overIndex : newTargetItems.length;
            const newLanes = [...prev];
            const srcIdx = prev.indexOf(sourceLane);
            const tgtIdx = prev.indexOf(targetLane);
            if (srcIdx === -1 || tgtIdx === -1) return prev;
            newLanes[srcIdx] = { ...sourceLane, items: newSourceItems };
            const movedItem = { ...activeItem, parentId: targetLane.parentId };
            newTargetItems.splice(finalIndex, 0, movedItem);
            newLanes[tgtIdx] = { ...targetLane, items: newTargetItems };
            return newLanes;
        });
    }

    const handleDragEnd = (event) => {
        const { active, over } = event;
        setActiveDragId(null);
        setDragOverLaneIndex(null);
        setDropHint(null);
        // Released outside any droppable → undo any cross-lane splice from dragOver.
        if (!over) { setLocalLanes(lanes); return; }

        // P4-4: placement derivation extracted to utils/computePlacement.js
        // (unit-tested: same lane / lane background / cross lane / unresolvable).
        const placement = computeFinalPlacement(localLanes, active.id, over.id);
        if (!placement) return;
        onMoveItem(active.id, placement.parentId, placement.index);
    };

    // P4-3: Escape/cancel must clear the drag visuals too (dnd-kit fires
    // onDragCancel, NOT onDragEnd) and roll back any cross-lane splice.
    const handleDragCancel = () => {
        setActiveDragId(null);
        setDragOverLaneIndex(null);
        setDropHint(null);
        setLocalLanes(lanes);
    };

    const handleBlockClick = (id, opCode, parentId) => {
        onSetFocusedLane && onSetFocusedLane(parentId);
        if (pickingMode?.isActive) {
            onPickBlock && onPickBlock(id);
        } else {
            onSelect && onSelect(id);
            if (opCode === 'ARRAY_GROUP') {
                onNavigateGroup && onNavigateGroup(id);
            }
        }
    };

    const activeDragItem = activeDragId ? lanes.flatMap(l => l.items).find(i => i.id === activeDragId) : null;

    // Helper: Recursive Lane Renderer
    const RenderLaneNode = ({ lane }) => {
        const childLanes = lane.items.flatMap(item => localLanes.filter(l => l.parentId === item.id));

        const isFocus = activeDragId
            ? (dragOverLaneIndex === localLanes.indexOf(lane))
            : ((lane.parentId || null) === (focusedParentId || null));

        const index = localLanes.indexOf(lane);

        return (
            <div className="flex flex-col items-start mr-8">
                <div
                    id={`lane-${index}`}
                    className={`mb-4 transition-all duration-300 ${isFocus ? 'opacity-100' : 'opacity-60'} flex flex-col`}
                >
                    <div className="flex items-center gap-2 mb-1 pl-1">
                        <div className={`text-[10px] font-mono tracking-widest px-1 border transition-colors ${isFocus ? 'text-nier-light opacity-80 bg-nier-dark border-nier-light/20' : 'text-muted opacity-40 bg-transparent border-transparent'}`}>
                            {lane.parentName || `GROUP CONTENT`}
                        </div>
                        {!isFocus && !activeDragId && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onSetFocusedLane && onSetFocusedLane(lane.parentId);
                                }}
                                className="text-[9px] text-muted hover:text-nier-light underline cursor-pointer"
                            >
                                FOCUS
                            </button>
                        )}
                    </div>

                    <LaneContainer
                        lane={lane}
                        index={index}
                        isActiveLane={isFocus}
                        onNavigateGroup={onNavigateGroup}
                        onSetFocusedLane={onSetFocusedLane}
                    >
                        <SortableContext
                            id={`lane-context-${lane.depth}`}
                            items={lane.items}
                            strategy={horizontalListSortingStrategy}
                        >
                            {lane.items.map(item => (
                                <Block
                                    key={item.id}
                                    {...item}
                                    issue={issueMap.get(item.id) || null}
                                    isSelected={selectedId === item.id}
                                    isPickMode={pickingMode?.isActive}
                                    isPickRef={pickingMode?.currentRefs?.includes(item.id)}
                                    offsetMeta={offsets?.get?.(item.id) ?? null}
                                    // Clicking a block should focus THIS lane (the container), not the child lane
                                    onClick={() => handleBlockClick(item.id, item.op_code, lane.parentId)}
                                    isGroupActive={false}
                                />
                            ))}
                            {lane.items.length === 0 && (
                                <div className="text-zinc-500 text-xs italic w-32 text-center opacity-50">
                                    [EMPTY GROUP]
                                </div>
                            )}
                        </SortableContext>
                    </LaneContainer>
                </div>

                {childLanes.length > 0 && (
                    <div className="flex flex-row items-start pl-3 border-l border-nier-light/10 ml-4 gap-8">
                        {childLanes.map(child => (
                            <RenderLaneNode key={child.parentId} lane={child} />
                        ))}
                    </div>
                )}
            </div>
        );
    };

    const rootLanes = localLanes.filter(l => !l.parentId);

    // Drop targeting (fix: "released but didn't land where I aimed"):
    // The vanilla closestCenter let LANE CONTAINERS compete globally with
    // cards — a pointer in a card gap or near a lane edge could resolve to
    // "lane background" (→ jump to END) or a NEIGHBOR lane (→ accidental
    // cross-lane splice). Policy: a card under the pointer always wins; empty
    // space inside a lane resolves to that lane's nearest card; pointing
    // outside every lane (transiting gaps) stays in the ACTIVE card's lane.
    const isLaneContainerId = (id) => String(id).startsWith('lane-container-');
    const laneOwnerIndex = (cardId) => localLanes.findIndex(l => l.items.some(i => i.id === cardId));

    const detectCollision = (raw) => {
        const { droppables, pointer } = raw;
        // Keyboard / no pointer: keep the legacy behavior.
        if (!pointer) return closestCenter(raw);

        const within = pointerWithin(raw);
        const cardWithin = within.filter(c => !isLaneContainerId(c.id));
        if (cardWithin.length > 0) return cardWithin;

        // Pointer inside a lane rect but over empty space → nearest card OF THAT LANE.
        const laneHit = within.find(c => isLaneContainerId(c.id));
        if (laneHit) {
            const laneIdx = parseInt(String(laneHit.id).split('-')[2], 10);
            const cardsInLane = droppables.filter(d => !isLaneContainerId(d.id) && laneOwnerIndex(d.id) === laneIdx);
            if (cardsInLane.length > 0) return closestCenter({ ...raw, droppables: cardsInLane });
            return within.filter(c => c.id === laneHit.id); // empty lane → the lane itself (append)
        }

        // Pointer outside every lane: stay in the ACTIVE card's lane so
        // transiting between lanes never triggers a cross-lane jump.
        const activeLaneIdx = activeDragId != null ? laneOwnerIndex(activeDragId) : -1;
        if (activeLaneIdx !== -1) {
            const cardsInActiveLane = droppables.filter(d => !isLaneContainerId(d.id) && laneOwnerIndex(d.id) === activeLaneIdx);
            if (cardsInActiveLane.length > 0) return closestCenter({ ...raw, droppables: cardsInActiveLane });
        }
        return closestCenter(raw);
    };

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={detectCollision}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
        >
            <div
                ref={canvasRef}
                className="w-full h-full overflow-auto relative canvas-root bg-transparent cursor-grab"
                onPointerDown={handlePanPointerDown}
                onClickCapture={(e) => {
                    // A pan just ended → swallow its release click entirely.
                    // Capture runs before lane/card handlers, and stopping
                    // propagation here also skips this element's own deselect.
                    if (suppressClickRef.current) {
                        suppressClickRef.current = false;
                        e.stopPropagation();
                        e.preventDefault();
                    }
                }}
                onClick={() => {
                    // Background click reset/cancel
                    // We rely on child elements (Blocks/Lanes) calling e.stopPropagation()
                    if (pickingMode?.isActive) {
                        onCancelPick && onCancelPick();
                    } else {
                        onSelect && onSelect(null);
                    }
                }}
            >
                {/* Scrollable Content Wrapper */}
                <div
                    ref={contentRef}
                    className="min-w-[max(fit-content,calc(100%_+_160px))] min-h-[max(fit-content,calc(100%_+_160px))] p-3 relative flex flex-col items-start"
                >
                    {/* SVG OVERLAY — P4-3: 整层在拖拽期间隐藏（stale 连线会
                        误导落点），drop 后随 lanes 变化自然重算 */}
                    <svg className={`absolute top-0 left-0 w-full h-full pointer-events-none z-0 ${activeDragId ? 'opacity-0' : ''}`} style={{ overflow: 'visible' }}>
                        <defs>
                            <filter id="glow-line" x="-20%" y="-20%" width="140%" height="140%">
                                <feGaussianBlur stdDeviation="2" result="blur" />
                                <feComposite in="SourceGraphic" in2="blur" operator="over" />
                            </filter>
                            <marker id="arrowhead" markerWidth="6" markerHeight="4" refX="5" refY="2" orient="auto">
                                <polygon points="0 0, 6 2, 0 4" fill="currentColor" style={{ color: pickingMode?.isActive ? '#FFB74D' : 'var(--color-nier-light)' }} />
                            </marker>
                        </defs>
                        {hierarchyLines.map((line, idx) => (
                            <path key={idx} d={line.d} fill="none" stroke="var(--color-nier-light)" strokeWidth="1" strokeDasharray="2 2" className="opacity-50" />
                        ))}
                        {connectionPaths.map((conn) => (
                            <g key={conn.id}>
                                <path d={conn.d} fill="none" stroke="var(--color-nier-light)" strokeWidth="1" style={{ opacity: 0.3 }} />
                                <path d={conn.d} fill="none" stroke={pickingMode?.isActive ? "#FFB74D" : "var(--color-nier-highlight)"} strokeWidth="2" strokeDasharray="4 8" className="animate-dash-flow opacity-80" markerEnd="url(#arrowhead)" />
                            </g>
                        ))}
                    </svg>
                    {/* P4-3: amber insertion line (2px) on the target card edge */}
                    {dropHint && (
                        <div
                            className="absolute z-20 w-[2px] bg-[#E58D28] pointer-events-none"
                            style={{ left: dropHint.left - 1, top: dropHint.top, height: dropHint.height }}
                        />
                    )}

                    {rootLanes.map(lane => (
                        <RenderLaneNode key={lane.parentId || 'root'} lane={lane} />
                    ))}
                </div>

                <DragOverlay dropAnimation={null}>
                    {activeDragItem ? (
                        <div className="opacity-90 scale-105 rotate-2 cursor-grabbing pointer-events-none">
                            <Block
                                {...activeDragItem}
                                isSelected={false}
                                isGroupActive={false}
                                offsetMeta={offsets?.get?.(activeDragItem.id) ?? null}
                            />
                        </div>
                    ) : null}
                </DragOverlay>
            </div>
        </DndContext>
    );
}
