import React, { useState, useEffect, useRef } from 'react';
import {
    DndContext,
    closestCenter,
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
import { useCanvasConnections } from '../../hooks/useCanvasConnections';

// Lane Component to handle Droppable logic cleanly
function LaneContainer({ lane, index, children, isActiveLane, onNavigateGroup, onSetFocusedLane }) {
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
    onMoveItem, // (itemId, newParentId, newIndex) => void
    selectedId,
    onSelect,
    isReadOnly,
    pickingMode,
    onPickBlock,
    onCancelPick,
    onNavigateGroup, // Toggle Expand/Collapse
    focusedParentId = null,
    onSetFocusedLane,
    isModalOpen = false
}) {

    const [activeDragId, setActiveDragId] = useState(null);
    const [dragOverLaneIndex, setDragOverLaneIndex] = useState(null); // Track which lane is hovered (by index for local DnD)

    // Refs
    const canvasRef = useRef(null);
    const contentRef = useRef(null);

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
        // Released outside any droppable → undo any cross-lane splice from dragOver.
        if (!over) { setLocalLanes(lanes); return; }

        const activeLaneIdx = localLanes.findIndex(l => l.items.some(i => i.id === active.id));
        if (activeLaneIdx === -1) return;
        const activeLane = localLanes[activeLaneIdx];

        // Which lane does `over` point at? (-1 = unresolvable)
        let overLaneIdx = -1;
        const overStr = String(over.id);
        if (overStr.startsWith('lane-container-')) {
            const idx = parseInt(overStr.split('-')[2], 10);
            overLaneIdx = Number.isNaN(idx) ? -1 : idx;
        } else {
            overLaneIdx = localLanes.findIndex(l => l.items.some(i => i.id === over.id));
        }

        let finalIndex;
        if (overLaneIdx === activeLaneIdx) {
            // Same lane (or post cross-lane splice, where `over` is in the lane the
            // item now physically sits): derive the target from `over` with
            // arrayMove semantics — insert-after-remove at `overIdx` reproduces
            // exactly what the strategy preview shows on screen.
            if (overStr.startsWith('lane-container-')) {
                finalIndex = activeLane.items.length - 1; // dropped on lane background → end
            } else {
                finalIndex = activeLane.items.findIndex(i => i.id === over.id);
            }
        } else {
            // Transient/unresolvable `over` (e.g. released mid-gap between lanes):
            // trust the current physical position — a no-op move keeps order stable.
            finalIndex = activeLane.items.findIndex(i => i.id === active.id);
        }

        if (finalIndex < 0) return;
        onMoveItem(active.id, activeLane.parentId, finalIndex);
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
                        <div className={`text-[10px] font-mono tracking-widest px-1 border transition-colors ${isFocus ? 'text-nier-light opacity-80 bg-nier-dark border-nier-light/20' : 'text-nier-light/50 opacity-40 bg-transparent border-transparent'}`}>
                            {lane.parentName || `GROUP CONTENT`}
                        </div>
                        {!isFocus && !activeDragId && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onSetFocusedLane && onSetFocusedLane(lane.parentId);
                                }}
                                className="text-[9px] text-nier-light/40 hover:text-nier-light underline cursor-pointer"
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
                                    isSelected={selectedId === item.id}
                                    isPickMode={pickingMode?.isActive}
                                    isPickRef={pickingMode?.currentRefs?.includes(item.id)}
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
                    <div className="flex flex-row items-start pl-8 border-l border-nier-light/10 ml-4 gap-8">
                        {childLanes.map(child => (
                            <RenderLaneNode key={child.parentId} lane={child} />
                        ))}
                    </div>
                )}
            </div>
        );
    };

    const rootLanes = localLanes.filter(l => !l.parentId);

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
        >
            <div
                ref={canvasRef}
                className="w-full h-full overflow-auto relative canvas-root bg-transparent"
                onClick={(e) => {
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
                    className="min-w-fit min-h-fit p-10 relative flex flex-col items-start"
                >
                    {/* SVG OVERLAY */}
                    <svg className="absolute top-0 left-0 w-full h-full pointer-events-none z-0" style={{ overflow: 'visible' }}>
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
                            />
                        </div>
                    ) : null}
                </DragOverlay>
            </div>
        </DndContext>
    );
}
