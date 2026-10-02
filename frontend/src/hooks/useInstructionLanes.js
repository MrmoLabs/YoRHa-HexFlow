import { useState, useMemo, useEffect } from 'react';
import { evaluateFormula, formatToHex, formatUnknown, calculateChecksum } from '../utils/formula';
import { mapChecksumAlgo } from '../utils/normalizeInstruction';
import { computeByteOffsets, presenceStaticState } from '../utils/byteOffsets';

export function useInstructionLanes(currentInstruction, activeInstructionId) {
    // expandedGroupIds: Array of IDs that are currently expanded.
    const [expandedGroupIds, setExpandedGroupIds] = useState([]);
    // focusedParentId: The 'parentId' of the lane currently in focus. null = Root.
    const [focusedParentId, setFocusedParentId] = useState(null);
    // `|| []` 每次渲染都是新数组字面量 —— 4 处 useMemo 若直接把它当 dep 会「每次
    // 渲染都失效」。正解是把这份空数组收成模块级常量或 useMemo 固定引用；R3 只清欠
    // 账不改行为（§8.40），故此处定点放行，改法留到真正动这些 memo 的批次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // 切指令 → 展开状态与焦点归位，是「外部 id 驱动本地 UI 状态」的标准同步：
        // 这一次重建必须紧跟 activeInstructionId，不能跟着 groupIds 的每次变化走。
        setExpandedGroupIds(groupIds);
        setFocusedParentId(null);
        // 不列 groupIds：本 effect 只想在「切指令」时跑一次；列出 groupIds 会让每次
        // 字段增删都把展开状态冲回全开。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeInstructionId]); // Reset only when switching instruction

    // Self-heal: clear focus once the focused group disappears (deleted) or the
    // focused id turns out to be a non-group block, so newly added fields never
    // receive a dead parent_id (which would make them invisible orphans).
    useEffect(() => {
        if (!focusedParentId) return;
        const parent = fieldById.get(focusedParentId);
        if (!parent || parent.op_code !== 'ARRAY_GROUP') {
            // 自愈：焦点指向的组没了/不是组 → 收回焦点，否则新字段会挂上死 parent_id。
            // 这是「派生数据变化 → 修本地指针」的补偿同步，去掉会让字段变成隐形孤儿。
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
            // N3 (G1): presence 门控叶的公式参与尺寸随静态判定（未命中 0B、
            // 静态判不了 ??、无门/不完整 fail-open → meta.size == byte_len 同值）。
            const gated = f.parameter_config?.presence
                && typeof f.parameter_config.presence === 'object'
                && !Array.isArray(f.parameter_config.presence);
            if (f.op_code === 'ARRAY_GROUP' || gated) {
                const meta = offsets.byId.get(f.id);
                nameToValueMap[f.name || f.label] = (meta && typeof meta.size === 'number') ? meta.size : "??";
            } else {
                nameToValueMap[f.name || f.label] = f.byte_len || 0;
            }
        });

        // 组卡中央值 = 嵌套内容逐块拼接（决策口径：已知子块出字面 hex、未知出
        // 等量 ??，如 `AA 55 ?? ??`）。hex-ish 子块（HEX_RAW/hex/fixed）pretty 化，
        // 其余（INT/MAPPING/LENGTH_CALC…）按 byte_len 出等量 ??；空组不产内容
        // （回退尺寸分支落 0B /未知落 ??）。子块取原始字段序（childrenByParentId
        // 已按 sequence 排好）；泳道是 DFS 序、组自身先于子孙泳道处理 → 读到的
        // 恒为原始字段，不受本轮派生 computedValue 影响。
        const fieldContent = (field) => {
            if (field.op_code === 'ARRAY_GROUP') {
                const kids = childrenByParentId.get(field.id) || [];
                if (kids.length === 0) return null;
                const parts = kids.map(fieldContent).filter(p => p != null);
                return parts.length ? parts.join(' ') : null;
            }
            if (field.op_code === 'HEX_RAW' || field.type === 'hex' || field.type === 'fixed') {
                const hexVal = String(field.hex_value || field.parameter_config?.hex || '').replace(/\s/g, '');
                if (hexVal && /^[\dA-Fa-f]+$/.test(hexVal)) {
                    return (hexVal.match(/.{1,2}/g) || []).join(' ').toUpperCase();
                }
            }
            return formatUnknown(field.byte_len);
        };

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
                        return { ...f, parameter_config: { ...f.parameter_config, computedValue: formatUnknown(f.byte_len || 1) } };
                    }
                    try {
                        const involvedVars = formula.match(/\[([^\]]+)\]/g)?.map(m => m.slice(1, -1)) || [];
                        const hasUnknown = involvedVars.some(v => !(v in nameToValueMap) || nameToValueMap[v] === "??");
                        if (hasUnknown) return { ...f, parameter_config: { ...f.parameter_config, computedValue: formatUnknown(f.byte_len || 1) } };

                        const result = evaluateFormula(formula, nameToValueMap);
                        // 长度是"数量"不是字节内容 → 十进制直出 `${result}B`（hex `05`
                        // 会被读成字节值）。卡片宽度/页脚另由 byte_len 与偏移标尺承担。
                        return { ...f, parameter_config: { ...f.parameter_config, computedValue: `${result}B` } };
                    } catch {
                        return { ...f, parameter_config: { ...f.parameter_config, computedValue: formatUnknown(f.byte_len || 1) } };
                    }
                }
                // 2. Time Accumulation
                if (f.op_code === 'TIME_ACCUMULATOR') {
                    const baseStr = f.parameter_config?.base_time;
                    // 无基准 → 差值不可知：按字节数出等量 ??（原样返回会让 Block
                    // 落到误导性的 00 占位）。BASE 小字行由 Block.jsx 统一渲染。
                    if (!baseStr) {
                        return { ...f, parameter_config: { ...f.parameter_config, computedValue: formatUnknown(f.byte_len || 4) } };
                    }
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
                        return { ...f, parameter_config: { ...f.parameter_config, computedValue: formatUnknown(f.byte_len || 1) } };
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
                // Dynamic Group Sizing — 中央值 = 嵌套内容逐块拼接（fieldContent
                // 递归；无字面 hex 的子块出等量 ??）。byteOffsets 的组分支只走 Σ 子、
                // 从不读 computedValue → 不会反馈进尺寸解析；尺寸仅在拼不出内容时
                // 兜底（空组 0B /未知 ??），页脚仍显 Σ 尺寸。
                if (f.op_code === 'ARRAY_GROUP') {
                    const meta = offsets.byId.get(f.id);
                    const known = meta && typeof meta.size === 'number';
                    // N3 (G1): 静态判未命中的组不产内容（子树 0 字节）—— 中央落
                    // 0B/空容器口径，页脚 0B；命中/无门组照常出嵌套内容。
                    const missed = presenceStaticState(f, fieldById) === 'miss';
                    const content = missed ? null : fieldContent(f);
                    return {
                        ...f,
                        byte_len: 0,
                        parameter_config: {
                            ...f.parameter_config,
                            computedValue: content != null ? content : (known ? `${meta.size}B` : '??')
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
