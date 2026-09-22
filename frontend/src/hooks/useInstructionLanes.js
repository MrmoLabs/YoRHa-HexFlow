import { useState, useMemo, useEffect } from 'react';
import { evaluateFormula, formatToHex, calculateChecksum } from '../utils/formula';
import { mapChecksumAlgo } from '../utils/normalizeInstruction';
import { computeByteOffsets } from '../utils/byteOffsets';

export function useInstructionLanes(currentInstruction, activeInstructionId) {
    // expandedGroupIds: Array of IDs that are currently expanded.
    const [expandedGroupIds, setExpandedGroupIds] = useState([]);
    // focusedParentId: The 'parentId' of the lane currently in focus. null = Root.
    const [focusedParentId, setFocusedParentId] = useState(null);
    const allFields = currentInstruction?.fields || [];

    const fieldById = useMemo(() => {
        const map = new Map();
        allFields.forEach(field => {
            map.set(field.id, field);
        });
        return map;
    }, [allFields]);

    const childrenByParentId = useMemo(() => {
        const map = new Map();

        allFields.forEach(field => {
            const parentId = field.parent_id || null;
            // Self-heal: buildLanes only descends into expanded ARRAY_GROUP nodes.
            // A parent_id pointing at a missing field (deleted group) or a
            // non-group field would never be reached, leaving those fields
            // INVISIBLE on the canvas. Re-attach such orphans to the root lane.
            const parent = parentId ? fieldById.get(parentId) : null;
            const effectiveParentId = parent && parent.op_code === 'ARRAY_GROUP' ? parentId : null;
            const siblings = map.get(effectiveParentId) || [];
            siblings.push(field);
            map.set(effectiveParentId, siblings);
        });

        for (const siblings of map.values()) {
            siblings.sort((a, b) => a.sequence - b.sequence);
        }

        return map;
    }, [allFields, fieldById]);

    const groupIds = useMemo(
        () => allFields.filter(f => f.op_code === 'ARRAY_GROUP').map(f => f.id),
        [allFields]
    );

    // Reset Group Path when switching instructions & Default Expand All
    useEffect(() => {
        setExpandedGroupIds(groupIds);
        setFocusedParentId(null);
    }, [activeInstructionId]); // Reset only when switching instruction

    // Self-heal: clear focus once the focused group disappears (deleted) or the
    // focused id turns out to be a non-group block, so newly added fields never
    // receive a dead parent_id (which would make them invisible orphans).
    useEffect(() => {
        if (!focusedParentId) return;
        const parent = fieldById.get(focusedParentId);
        if (!parent || parent.op_code !== 'ARRAY_GROUP') {
            setFocusedParentId(null);
        }
    }, [focusedParentId, fieldById]);

    // Compute Lanes for Canvas (Recursive Tree)
    const uiLanes = useMemo(() => {
        if (allFields.length === 0) return [];

        const lanes = [];

        // Recursive helper to build lanes in DFS order
        const buildLanes = (parentId, depth) => {
            const items = childrenByParentId.get(parentId) || [];

            // 2. Find Parent Name for display
            let parentName = "ROOT SEQUENCE";
            if (parentId) {
                const parentBlock = fieldById.get(parentId);
                parentName = parentBlock ? (parentBlock.name || parentBlock.label) : "UNKNOWN GROUP";
            }

            // 3. Add this lane
            lanes.push({
                depth,
                parentId,
                parentName,
                items
            });

            // 4. Find expands within this lane
            items.forEach(item => {
                if (item.op_code === 'ARRAY_GROUP' && expandedGroupIds.includes(item.id)) {
                    buildLanes(item.id, depth + 1);
                }
            });
        };

        buildLanes(null, 0); // Start at Root
        return lanes;

    }, [allFields.length, childrenByParentId, expandedGroupIds, fieldById]);

    // LIVE FORMULA EVALUATION
    const processedLanes = useMemo(() => {
        // LENGTH_CALC formulas evaluate over BYTE COUNTS (leaves map to byte_len).
        // Phase 1: groups now resolve to Σ children via byteOffsets, so formulas
        // like "[状态块] + [帧尾]" compute a real value instead of short-circuiting
        // on the legacy hard-coded "??" group placeholder. "??" remains only when
        // the group total is genuinely undeterminable (a child byte_len missing).
        const offsets = computeByteOffsets({ fields: allFields });
        const nameToValueMap = {};
        allFields.forEach(f => {
            if (f.op_code === 'ARRAY_GROUP') {
                const meta = offsets.byId.get(f.id);
                nameToValueMap[f.name || f.label] = (meta && typeof meta.size === 'number') ? meta.size : "??";
            } else {
                nameToValueMap[f.name || f.label] = f.byte_len || 0;
            }
        });

        // Map lanes to process formula blocks
        return uiLanes.map(lane => ({
            ...lane,
            items: lane.items.map(f => {
                // 1. Length Calculation
                if (f.op_code === 'LENGTH_CALC') {
                    let formula = f.parameter_config?.formula;
                    if (typeof formula === 'string') formula = formula.trim();
                    // Legacy/imported data can carry `refs` with no formula (the
                    // model's source of truth is the formula; refs mirror its
                    // variables — seed pattern: refs:[组,帧尾] ↔ "[状态块] + [帧尾]").
                    // Infer the seed's sum-of-refs for PREVIEW so the card isn't a
                    // silent "??"; a real formula always wins over the inference.
                    if (!formula && Array.isArray(f.parameter_config?.refs) && f.parameter_config.refs.length > 0) {
                        formula = [...new Set(f.parameter_config.refs)].map((rid) => {
                            const target = fieldById.get(rid);
                            return `[${target ? (target.name || target.label || rid) : rid}]`;
                        }).join(' + ');
                    }
                    if (!formula) {
                        return { ...f, parameter_config: { ...f.parameter_config, computedValue: "??" } };
                    }
                    try {
                        const involvedVars = formula.match(/\[([^\]]+)\]/g)?.map(m => m.slice(1, -1)) || [];
                        const hasUnknown = involvedVars.some(v => !(v in nameToValueMap) || nameToValueMap[v] === "??");
                        if (hasUnknown) return { ...f, parameter_config: { ...f.parameter_config, computedValue: "??" } };

                        const result = evaluateFormula(formula, nameToValueMap);
                        const hex = formatToHex(result, f.byte_len || 1);
                        return { ...f, parameter_config: { ...f.parameter_config, computedValue: hex } };
                    } catch (e) {
                        return { ...f, parameter_config: { ...f.parameter_config, computedValue: "??" } };
                    }
                }
                // 2. Time Accumulation
                if (f.op_code === 'TIME_ACCUMULATOR') {
                    const baseStr = f.parameter_config?.base_time;
                    if (!baseStr) return f;
                    const baseDate = new Date(baseStr);
                    const now = new Date();
                    const diffSec = Math.floor((now.getTime() - baseDate.getTime()) / 1000);
                    const hex = formatToHex(diffSec, f.byte_len || 4);
                    return { ...f, parameter_config: { ...f.parameter_config, computedValue: hex } };
                }
                // 3. Auto Counter
                if (f.op_code === 'AUTO_COUNTER') {
                    const startVal = f.parameter_config?.start_val || 0;
                    const hex = formatToHex(startVal, f.byte_len || 1);
                    return { ...f, parameter_config: { ...f.parameter_config, computedValue: hex } };
                }
                // 3.5 Checksum preview (A5): structural estimate over referenced
                // fields — HEX_RAW contributes its literal bytes, everything else
                // contributes 00 placeholders (no runtime inputs on this page).
                if (f.op_code === 'CHECKSUM_CRC') {
                    const refs = f.parameter_config?.refs || [];
                    if (refs.length === 0) {
                        return { ...f, parameter_config: { ...f.parameter_config, computedValue: '??' } };
                    }
                    const collectLeaves = (groupId, acc = []) => {
                        (childrenByParentId.get(groupId) || []).forEach(child => {
                            if (child.op_code === 'ARRAY_GROUP') collectLeaves(child.id, acc);
                            else acc.push(child);
                        });
                        return acc;
                    };
                    const bytes = [];
                    refs.forEach(refId => {
                        const ref = fieldById.get(refId);
                        if (!ref) return;
                        const leaves = ref.op_code === 'ARRAY_GROUP' ? collectLeaves(ref.id) : [ref];
                        leaves.forEach(leaf => {
                            const hexVal = String(leaf.parameter_config?.hex || leaf.hex_value || '').replace(/\s/g, '');
                            if (hexVal && /^[\dA-Fa-f]+$/.test(hexVal)) {
                                (hexVal.match(/.{1,2}/g) || []).forEach(pair => bytes.push(parseInt(pair, 16)));
                            } else {
                                const zeroLen = Math.max(1, leaf.byte_len || 1);
                                for (let i = 0; i < zeroLen; i++) bytes.push(0);
                            }
                        });
                    });
                    const algo = mapChecksumAlgo(f.parameter_config?.algorithm || f.parameter_config?.algo);
                    const result = calculateChecksum(algo, bytes);
                    return { ...f, parameter_config: { ...f.parameter_config, computedValue: formatToHex(result, f.byte_len || 1) } };
                }
                // Dynamic Group Sizing — inject the Σ extent as computedValue so
                // the group card can show "4B" even where the offset ruler prop
                // isn't wired. byteOffsets' group branch is Σ-of-children only and
                // never reads computedValue, so this cannot feed back into size
                // resolution (and "??" stays when the total is unknowable).
                if (f.op_code === 'ARRAY_GROUP') {
                    const meta = offsets.byId.get(f.id);
                    const known = meta && typeof meta.size === 'number';
                    return {
                        ...f,
                        byte_len: 0,
                        parameter_config: {
                            ...f.parameter_config,
                            computedValue: known ? `${meta.size}B` : '??'
                        }
                    };
                }
                return f;
            })
        }));
    }, [allFields, uiLanes, childrenByParentId, fieldById]);

    const handleNavigateGroup = (groupId) => {
        setExpandedGroupIds(prev => {
            const next = [...prev];
            const idx = next.indexOf(groupId);
            if (idx !== -1) {
                next.splice(idx, 1);
            } else {
                next.push(groupId);
                setFocusedParentId(groupId);
            }
            return next;
        });
    };

    return {
        expandedGroupIds,
        setExpandedGroupIds,
        focusedParentId,
        setFocusedParentId,
        processedLanes,
        handleNavigateGroup
    };
}
