// Pure merge/lane helpers for the Orchestration page.
// Extracted verbatim from pages/Orchestration.jsx (logic unchanged).

// 批次一: 编排页试发改线复用 —— 逐指令编码内核 hex（→ compileWrapped）走的
// 就是合并注入同一归一化口径（blocks 优先 / fields 建树 / sequence 排序）。
export const normalizeInstructionBlocks = (instruction) => {
    const blocks = instruction?.blocks;
    if (blocks?.length) return blocks;

    const fields = instruction?.fields || [];
    const fieldMap = new Map(fields.map(field => [field.id, { ...field, label: field.label || field.name, children: [] }]));
    const roots = [];

    fieldMap.forEach(field => {
        if (field.parent_id && fieldMap.has(field.parent_id)) {
            fieldMap.get(field.parent_id).children.push(field);
        } else {
            roots.push(field);
        }
    });

    return roots.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
};

// Deep Clone to avoid mutating original AND Prefix IDs to avoid collisions
const cloneBlocks = (blocks, prefix) => {
    return blocks.map(b => {
        const newBlock = { ...b, id: `${prefix}-${b.id}` };
        // A8: refs 锚定同树 id —— 合并树 id 前缀化后 refs 必须同步，否则
        // encoder 查无目标（length Σ 恒 0 / checksum 空字节）。协议侧 refs → p-、
        // 指令侧 refs → i-（跨树引用为契约外，PUT 侧拦悬空；② 锚 slot 放开 ——
        // 定义期维持 ??，填槽时经改写表换成注入块 id）。
        if (Array.isArray(newBlock.parameter_config?.refs)) {
            newBlock.parameter_config = {
                ...newBlock.parameter_config,
                refs: newBlock.parameter_config.refs.map(r => `${prefix}-${r}`)
            };
        }
        if (newBlock.children) {
            newBlock.children = cloneBlocks(newBlock.children, prefix);
        }
        return newBlock;
    });
};

// MERGE LOGIC: Combine Protocol + Instruction(s)
// 洞序 = 协议树 DFS（一期稠密位次语义：指令数组序 i → 第 i 个 slot，洞号即
// 同协议绑定按 slot_order 升序的位次）；洞未填保留 slot（发射归零）；指令多
// 于洞 → 溢出 append 根末尾（沿用单指令 fallback）。单指令对象 / undefined /
// [] 向后兼容（包成数组走同一路径，E4 单绑定语义不变）。
export const mergeProtocolInstruction = (protocol, instruction) => {
    if (!protocol) return [];

    // Deep Clone to avoid mutating original AND Prefix IDs to avoid collisions
    const mergedRoot = { ...protocol };
    if (mergedRoot.children) {
        mergedRoot.children = cloneBlocks(mergedRoot.children, 'p');
    }

    const list = Array.isArray(instruction)
        ? instruction
        : (instruction ? [instruction] : []);

    if (list.length && mergedRoot.children) {
        // 每条指令 → 一组已克隆（i- 前缀）+ isInjected 标记的根块
        const payloads = list.map(ins => cloneBlocks(normalizeInstructionBlocks(ins), 'i')
            .map(b => ({ ...b, isInjected: true })));

        let cursor = 0;
        // ② refs→槽 改写表：填槽时记 被填槽 id → 注入块 ids。收尾统一把引用该槽
        // 的 refs 换成注入块 id —— 编码器 PASS1 Σ fieldSizes[refId] 由此直接算出
        // 含载荷的真长度（空槽未改写时 fieldSizes=0 自然不计，双向一致）。
        const rewrite = new Map();
        const fill = (nodes) => {
            for (let i = 0; i < nodes.length && cursor < payloads.length; i++) {
                if (nodes[i].type === 'slot') {
                    const injected = payloads[cursor++];
                    rewrite.set(nodes[i].id, injected.map(b => b.id));
                    nodes.splice(i, 1, ...injected);
                    i += injected.length - 1; // 跳过已注入块，继续向后枚举洞
                } else if (nodes[i].children) {
                    fill(nodes[i].children); // DFS：嵌套容器内 slot 同参与洞序
                }
            }
        };
        fill(mergedRoot.children);

        // 溢出：洞不够 → 剩余指令追加到根末尾（append fallback）。
        // payloads 每项本身是块数组 → slice 后须 flat 摊平，否则推入子数组。
        if (cursor < payloads.length) {
            mergedRoot.children.push(...payloads.slice(cursor).flat());
        }

        // ② 收尾改写：全树扫描，refs 命中改写表的槽 id 展开为注入块 ids。
        // 指令侧 refs 已是 i- 前缀、改写表 key 是 p- 前缀 → 天然不撞；
        // 带 refs 的克隆节点均持有自有的 parameter_config 对象（cloneBlocks
        // 见 refs 即换新对象），此处覆写不回染输入协议。
        if (rewrite.size) {
            const applyRewrites = (nodes) => (nodes || []).forEach(n => {
                if (Array.isArray(n.parameter_config?.refs)) {
                    n.parameter_config = {
                        ...n.parameter_config,
                        refs: n.parameter_config.refs.flatMap(r => rewrite.get(r) || [r])
                    };
                }
                if (n.children?.length) applyRewrites(n.children);
            });
            applyRewrites(mergedRoot.children);
        }
    }

    return mergedRoot.children || [];
};

export const buildLanes = (nodes, parentId = null, parentName = 'ROOT SEQUENCE', depth = 0) => {
    const lanes = [{
        depth,
        parentId,
        parentName,
        items: nodes || []
    }];

    (nodes || []).forEach(node => {
        if (node.children?.length) {
            lanes.push(...buildLanes(node.children, node.id, node.label || node.name || 'GROUP CONTENT', depth + 1));
        }
    });

    return lanes;
};

// R1/B3: 洞数统计（DFS，嵌套容器内 slot 同计）—— 编排页「洞位不足 / 空洞」
// 警告与侧栏重排共用的纯函数口径（稠密位次：洞号 = 同协议绑定位次）。
export const countSlots = (blocks) => {
    if (!blocks?.length) return 0;
    let n = 0;
    blocks.forEach(b => {
        if (b.type === 'slot') n += 1;
        if (b.children?.length) n += countSlots(b.children);
    });
    return n;
};

export const getTotalBytes = (blocks) => {
    let total = 0;
    blocks.forEach(b => {
        // R1: slot 占位归零 —— 发射跳过（orchestrator.py:76 不吐字节），即便
        // 携带 byte_length 也不计入显示总长（与编码期 fieldSizes=0 同尺）。
        if (b.type === 'slot') return;
        // Leaf = node without child nodes. `children: []` (which
        // normalizeInstructionBlocks attaches to every field) is NOT a
        // container — counting it as one recursed into nothing and dropped
        // the whole payload from the displayed total.
        if (b.children?.length) {
            // E1-5 (B7): a repeating group contributes Σ children × N copies
            // (FIXED). DYNAMIC counts are runtime-dependent — this page has no
            // unknown/`+` display mode, so keep ×1 as a lower bound.
            let reps = 1;
            if (String(b.repeat_type || '').toUpperCase() === 'FIXED') {
                const c = b.repeat_count;
                reps = (typeof c === 'number' && Number.isFinite(c)) ? Math.max(0, Math.floor(c)) : 1;
            }
            total += getTotalBytes(b.children) * reps;
        }
        else total += (b.byte_length || 0);
    });
    return total;
};
