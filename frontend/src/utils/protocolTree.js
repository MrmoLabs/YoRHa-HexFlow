// Pure tree helpers for the Protocol editor page.
// Extracted verbatim from pages/Protocol.jsx (logic unchanged).
// A+B 批：内联展开泳道 / 跨容器移动 / 偏移标尺适配 —— 对标指令页
// useInstructionLanes（buildLanes+expandedGroupIds+焦点自愈）与 moveField
// （splice 口径），全部纯函数、children 树上操作、不落库。

import { computeByteOffsets } from './byteOffsets';
import { isNestable } from '../config/blockTypes';
import { formatUnknown, calculateChecksum, formatToHex } from './formula';
// R27（§8.52 排期 · varint / COBS 出线 · §8.59）: 设计期字节真值与出线同口径 ——
// length 卡按 pc.encoding 出 varint 字节、cobs 组出 COBS+定界字节（只编码不解包）。
import { encodeCobsHex, encodeVarint, hexToBytes, normalizeEncoding } from './framing';
import { mapChecksumAlgo } from './normalizeInstruction';
import { sanitizeValueTable } from './bitMeta';
// R42（§8.74 · `byte_order` trim 归一）: 三处字节序谓词收敛到单点判据
// （卡面 length 分支 + checksum `isLittleOrder`），与 BE `byte_order_of` 同口径。
import { isLittleByteOrder } from './byteOrder';
import { v4 as uuidv4 } from 'uuid';

export const serializeProtocol = (protocol) => JSON.stringify({
    label: protocol?.label || '',
    type: protocol?.type || 'container',
    description: protocol?.description || null,
    children: protocol?.children || []
});

export const findNode = (root, id) => {
    if (!root || !id) return null;
    if (root.id === id) return root;
    if (!root.children) return null;

    for (const child of root.children) {
        const found = findNode(child, id);
        if (found) return found;
    }

    return null;
};

// children 树 → computeByteOffsets 的扁平适配：容器打 ARRAY_GROUP 标（仅适配
// 层，不落库）以复用已测的组尺寸与空组 size=0 语义（isGroupOp 分支——协议容器
// 无 op_code，不打标的话空容器会被当 byte_length=0 的叶子判成未知尺寸并污染
// 后续偏移）；叶子直传 byte_length（resolveSize 读 byte_len ?? byte_length）。
export const computeProtocolOffsets = (protocol) => {
    if (!protocol) return { byId: new Map(), total: 0, exact: true, variable: false };
    const fields = [];
    const cobsNodes = [];
    const walk = (nodes, parentId) => {
        (nodes || []).forEach((node, index) => {
            const kids = node.children || [];
            const isContainer = isNestable(node.type) || kids.length > 0;
            if (node.type === 'cobs') cobsNodes.push(node); // R27（§8.59）
            fields.push({
                ...node,
                ...(isContainer ? { op_code: node.op_code || 'ARRAY_GROUP' } : {}),
                parent_id: parentId,
                sequence: index
            });
            if (kids.length) walk(kids, node.id);
        });
    };
    walk(protocol.children, null);
    // R27 (§8.59) 两遍法 —— COBS 的出线宽取决于子树字节里的 0x00 分布与 254 满块，
    // 尺子只认尺寸、不编码，故：
    //   ① 第一遍按静态尺寸算（cobs 组先落Σ 子宽，只为给第二遍的严格 Σ 当输入）；
    //   ② 对每个 cobs **真编码**求出线宽（collectDeterministicBytes 含定界）；
    //   ③ 第二遍回灌精确尺寸 → 偏移尺、其后块起点、总长与 BE block_spans 同口径。
    // 子树里有槽（载荷期才定字节）/ 任一子块编不出 → 注入 null → 该块与下游落
    // ??（不谎报成 Σ 下界）。**无 cobs 节点 → 零改写零第二遍**（与后端
    // Orchestrator._apply_cobs 的零遍历同口径，存量协议字节/尺寸不变）。
    const base = computeByteOffsets({ fields });
    if (cobsNodes.length === 0) return base;
    const overrides = new Map();
    cobsNodes.forEach(node => {
        const bytes = collectDeterministicBytes(node, base.byId, protocol);
        overrides.set(node.id, bytes ? bytes.length : null);
    });
    return computeByteOffsets({ fields }, { sizeOverrides: overrides });
};

// useInstructionLanes.buildLanes 的 children 树版：只对 expandedIds 下钻，
// DFS 序推 lane —— Canvas.RenderLaneNode 按 parentId 挂子泳道、画层级连线。
export const buildProtocolLanes = (protocol, expandedIds) => {
    if (!protocol) return [];
    const lanes = [];
    const expanded = new Set(expandedIds || []);
    const walk = (nodes, parentId, parentName, depth) => {
        lanes.push({ depth, parentId, parentName, items: nodes || [] });
        (nodes || []).forEach(node => {
            if (isNestable(node.type) && expanded.has(node.id)) {
                walk(node.children || [], node.id, node.label || 'GROUP', depth + 1);
            }
        });
    };
    walk(protocol.children || [], null, protocol.label || 'ROOT SEQUENCE', 0);
    return lanes;
};

// moveField 的树版 + 环守卫：树模型下环 = findNode/buildLanes 栈溢出冻结
// （扁平 parent_id 模型只是块不可见），协议侧必须拒收。落点语义对齐
// computeFinalPlacement：newParentId null=根泳道、index=目标层显示序（先摘
// 后插 = arrayMove）。源缺失 / 目标是自身或子孙 / 目标非容器 → 原引用早退
// （调用方跳过持久化，同 moveField 口径）。
export const moveNode = (root, itemId, newParentId, index) => {
    if (!root) return root;
    const item = findNode(root, itemId);
    if (!item) return root;
    if (newParentId != null) {
        if (newParentId === itemId) return root;
        if (findNode(item, newParentId)) return root; // 目标在自己子树内 → 成环
        const target = findNode(root, newParentId);
        if (!target || !isNestable(target.type)) return root;
    }

    let moved = null;
    const detach = (nodes) => nodes
        .map(node => {
            if (node.id === itemId) { moved = node; return null; }
            if (node.children?.length) return { ...node, children: detach(node.children) };
            return node;
        })
        .filter(Boolean);
    const remaining = detach(root.children || []);
    if (!moved) return root;

    const insert = (nodes) => {
        const arr = [...nodes];
        const at = Math.max(0, Math.min(index ?? arr.length, arr.length));
        arr.splice(at, 0, moved);
        return arr;
    };
    if (newParentId == null) return { ...root, children: insert(remaining) };

    const rebuild = (nodes) => nodes.map(node => node.id === newParentId
        ? { ...node, children: insert(node.children || []) }
        : (node.children?.length ? { ...node, children: rebuild(node.children) } : node));
    return { ...root, children: rebuild(remaining) };
};

// 树剪枝 = 子树整体移除（对齐指令页 flat 模型手写级联删除的最终效果）。
// 批次一 P0-2 级联剥 refs：其他块 parameter_config.refs 指向被删 id（含容器
// 子孙）不清 → 后端 _validate_refs 400 "refs target not found"，前端只收到
// "协议保存失败" 无从定位且整树卡保存。先收集被删子树 id 集，再在剪枝后剥
// 剩余树中命中的引用；纯函数（仅命中节点复制，输入树零改写）。
export const removeNode = (root, id) => {
    if (!root) return root;
    const removed = new Set();
    const target = findNode(root, id);
    if (target) {
        const collect = (node) => {
            removed.add(node.id);
            (node.children || []).forEach(collect);
        };
        collect(target);
    }
    const strip = (nodes) => nodes
        .filter(node => node.id !== id)
        .map(node => {
            let next = node;
            if (node.children?.length) next = { ...next, children: strip(next.children) };
            const refs = next.parameter_config?.refs;
            if (Array.isArray(refs) && refs.some(refId => removed.has(refId))) {
                next = {
                    ...next,
                    parameter_config: {
                        ...next.parameter_config,
                        refs: refs.filter(refId => !removed.has(refId))
                    }
                };
            }
            return next;
        });
    return { ...root, children: strip(root.children || []) };
};

export const updateNode = (root, id, updates) => {
    if (!root) return root;
    const patch = (node) => node.id === id
        ? { ...node, ...updates }
        : (node.children?.length ? { ...node, children: node.children.map(patch) } : node);
    return patch(root);
};

// 切协议默认全展开（镜像 useInstructionLanes:50-53 的 groupIds 全量）。
export const collectContainerIds = (root) => {
    const ids = [];
    const walk = (nodes) => (nodes || []).forEach(node => {
        if (isNestable(node.type)) { ids.push(node.id); walk(node.children); }
    });
    walk(root?.children);
    return ids;
};

// 批次二: 校验清单点击定位用 —— 目标 id 的容器祖先链（预序 DFS 回溯，
// 仅容器入链）。定位时并入 expandedContainerIds 即可让深层块可见而不打扰
// 其余折叠状态（比 collectContainerIds 全展开温和）。目标不存在 → []。
export const findAncestors = (root, id) => {
    if (!root || !id) return [];
    const chain = [];
    const walk = (nodes) => {
        for (const node of nodes || []) {
            if (node.id === id) return true;
            if (walk(node.children)) {
                if (isNestable(node.type)) chain.push(node.id);
                return true;
            }
        }
        return false;
    };
    walk(root.children);
    return chain.reverse(); // 回溯入栈是内层先入 → 反转为外→内（可读性/稳定序）
};

// ─── 批次三 P1-1：复制（协议级唯一入口）────────────────────────────────────
// 协议级 = 整树重生 id + refs **全量重映射到副本**（自含：源 refs 按同树
// 契约全可解，镜像 cloneFieldsForNewInstruction 的 remap + 丢弃不可解口径，
// 防 POST/PUT 落库 400 "refs target not found"）。
// （批次三 P1-2 的块级 duplicateNode —— un-wired copy 口径 —— 已随人工验证
// 第 3 轮 #1「复制块」撤除按用户拍板连删，单测同步移除。）
// 两阶段发号：先预序全树建 idMap，再重建节点（引用一致性靠 Map 一次解决）。
const cloneTreeWithNewIds = (node, genId) => {
    const idMap = new Map();
    const assign = (n) => {
        if (!idMap.has(n.id)) idMap.set(n.id, genId());
        (n.children || []).forEach(assign);
    };
    assign(node);
    const build = (n) => {
        const copy = { ...n, id: idMap.get(n.id) };
        if (Array.isArray(n.children)) copy.children = n.children.map(build);
        const pc = n.parameter_config;
        if (pc && Array.isArray(pc.refs)) {
            // refs 重映射到副本新 id（同树不可解条目丢弃）+ 浅拷 pc 新数组，
            // 副本与源零别名（副本改引用不得回写源块）。
            copy.parameter_config = {
                ...pc,
                refs: pc.refs.filter(r => idMap.has(r)).map(r => idMap.get(r))
            };
        }
        return copy;
    };
    return { clone: build(node), idMap };
};

// 协议级复制负载（镜像 buildDuplicateInstructionPayload）：label 升序防撞
// （后端不校验 label 唯一，纯 UX 对齐指令页 `(副本)` 口径）+ 整树新 id +
// refs 自含重映射。返回可直接 POST 的 payload（id 客户端发号，后端
// payload.id or uuid4 契约）。
export const buildDuplicateProtocolPayload = (source, existingProtocols = [], genId = uuidv4) => {
    const labels = new Set(existingProtocols.map(p => String(p.label || '').trim()));
    let label = `${source.label} (副本)`;
    if (labels.has(label)) {
        let n = 2;
        while (labels.has(`${source.label} (副本${n})`)) n += 1;
        label = `${source.label} (副本${n})`;
    }
    const { clone } = cloneTreeWithNewIds(source, genId);
    return {
        id: clone.id,
        label,
        type: source.type || 'container',
        description: source.description || null,
        children: clone.children
    };
};

// ─── 批次四 P3-2: 协议 JSON 导入负载 ───────────────────────────────────────
// 与复制同源的两阶段重生 id + refs 自含重映射（丢悬空，防落库 400），差异：
// - label 仅**撞名**时升序「(导入)/(导入N)」—— 后端不校验 label 唯一，空闲
//   名保真原样（复制恒加 `(副本)` 是另一语义）；
// - 净化按后端 ProtocolNodeSchema 白名单重建节点（外来文件的编辑器私有键/
//   类型垃圾不落库），checksum 算法经 mapChecksumAlgo 归一（镜像指令页
//   B1 aliasChecksumAlgo：枚举外值两端回退口径不一 —— 前端 0 / 后端
//   crc16 —— 入库前统一到 ChecksumAlgo 三值）。
// 节点缺 id 已由 analyzeProtocolImport 前置拦截（克隆发号按 id 建 Map，
// 无 id 会整树共用一个新 id）。
// 批 4: 位域块位段白名单归一（导入路径）—— 非对象项 / 非法位偏移或位宽剔除，
// 缺省 default_val 补 0；口径与 toFrameBlocks.normalizeBitSegments 一致。
const sanitizeBits = (bits) => (Array.isArray(bits) ? bits : [])
    .filter(b => b && typeof b === 'object')
    .map(b => {
        // 优化批 2/3：元数据白名单（signed/value_table）—— 脏值表清洗，
        // 无 meta 不注入键（与批 4 白名单口径一致，存量负载形状不变）。
        const vt = sanitizeValueTable(b.value_table);
        return {
            bit_name: String(b.bit_name ?? ''),
            start_bit: Math.trunc(Number(b.start_bit)),
            bit_len: Math.trunc(Number(b.bit_len)),
            default_val: Math.trunc(Number(b.default_val) || 0),
            ...(b.signed === true ? { signed: true } : {}),
            ...(vt ? { value_table: vt } : {})
        };
    })
    .filter(b => Number.isFinite(b.start_bit) && Number.isFinite(b.bit_len) && b.bit_len >= 1 && b.start_bit >= 0);

const sanitizeImportedNode = (node) => {
    const kids = (node.children || []).map(sanitizeImportedNode);
    let pc = node.parameter_config && typeof node.parameter_config === 'object'
        ? { ...node.parameter_config }
        : null;
    if (!pc && (node.type === 'length' || node.type === 'checksum')) {
        pc = { type: node.type, refs: [] }; // 镜像 createBlock A1 初始化
    }
    if (pc && node.type === 'checksum' && pc.algorithm !== undefined) {
        pc.algorithm = mapChecksumAlgo(pc.algorithm);
    }
    const bl = Number(node.byte_length);
    const nodeType = String(node.type || (kids.length ? 'container' : 'fixed'));
    return {
        id: node.id,
        label: String(node.label ?? ''),
        type: nodeType,
        byte_length: Number.isFinite(bl) ? Math.max(0, Math.floor(bl)) : 0,
        hex_value: typeof node.hex_value === 'string' ? node.hex_value : null,
        config: node.config && typeof node.config === 'object' ? node.config : {},
        // 批 4: 位域位段仅对 bitfield 块透传（存量块不凭空注入空数组）
        ...(nodeType === 'bitfield' ? { bits: sanitizeBits(node.bits) } : {}),
        ...(pc ? { parameter_config: pc } : {}),
        children: kids
    };
};

export const buildImportedProtocolPayload = (source, existingProtocols = [], genId = uuidv4) => {
    const labels = new Set(existingProtocols.map(p => String(p.label || '').trim()));
    const { clone } = cloneTreeWithNewIds(source, genId);
    let label = String(source.label ?? '').trim() || '导入协议';
    if (labels.has(label)) {
        let candidate = `${label} (导入)`;
        if (labels.has(candidate)) {
            let n = 2;
            while (labels.has(`${label} (导入${n})`)) n += 1;
            candidate = `${label} (导入${n})`;
        }
        label = candidate;
    }
    return {
        id: clone.id,
        label,
        type: String(source.type || 'container'),
        description: typeof source.description === 'string' ? source.description : null,
        children: (clone.children || []).map(sanitizeImportedNode)
    };
};

// 块级复制 duplicateNode 已随人工验证第 3 轮 #1 连删（UI 入口撤除后纯函数 +
// 3 单测一并移除；协议级复制走 buildDuplicateProtocolPayload）。

// ─── 一期（A4/A5）+ ②：refs → 设计期 Σ 回显 ──────────────────────────────
// Σ = computeByteOffsets byId 尺寸之和（容器已按 Σ 子入表）；任一 ref 悬空/
// 尺寸 null → null（调用方不注入，Block.jsx:155 维持 "??"）；空 refs → null。
// ② slot 目标 → null（槽长定义期不可知 → 整卡维持 ??；发送期 blockMerge 填槽
// 把引用该槽的 refs 改写为注入块 id 后按真值 Σ）。root = 协议树，供 findNode
// 取目标 type —— byId 条目只有 {offset,size,isGroup} 不带 type，故以签名扩展
// 取型而非改共享 byteOffsets 契约（既有 toEqual 精确形状断言/指令页共用）。
// 纯函数：不触碰输入 block/lanes，注入结果为派生副本（存储树只经 PUT 落库）。
export const computeRefsSigma = (block, byId, root) => {
    const refs = block?.parameter_config?.refs;
    if (!Array.isArray(refs) || refs.length === 0) return null;
    let sum = 0;
    for (const refId of refs) {
        if (root && findNode(root, refId)?.type === 'slot') return null;
        const entry = byId.get(refId);
        if (!entry || entry.size == null) return null;
        sum += entry.size;
    }
    return sum;
};

// ─── 人工验证反馈 2（严格口径）：设计期"全确定"才直填真值 ────────────────────
// hasSlotInSubtree: 嵌套槽同样令 Σ/值到发送期才定（computeRefsSigma 只查
// 直接 slot，漏"容器包裹槽"——其设计期尺寸把槽算 0/占位，填充后会变）。
const hasSlotInSubtree = (node) => node.type === 'slot'
    || (node.children || []).some(hasSlotInSubtree);

// strictSigma: computeRefsSigma + 嵌套槽拒绝（root 必需；任一 ref 悬空/含槽/
// 尺寸未知 → null，调用方不注入，卡面维持等量 ??）。
const strictSigma = (owner, byId, root) => {
    const refs = owner?.parameter_config?.refs;
    if (!Array.isArray(refs) || refs.length === 0 || !root) return null;
    let sum = 0;
    for (const refId of refs) {
        const target = findNode(root, refId);
        if (!target || hasSlotInSubtree(target)) return null;
        const entry = byId.get(refId);
        if (!entry || entry.size == null) return null;
        sum += entry.size;
    }
    return sum;
};

const bytesToHex = (bytes) => bytes
    .map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

// ─── R34（§8.66 排期 · 校验和字节序）：checksum 卡字节序 —— **两个计算点同用
// 一份反转口径（改一必改二）**：① `collectDeterministicBytes`（容器内容 / 卡面
// 递归），② `injectRefsSigma`（checksum 卡中央值）。与后端
// `ChecksumHandler.apply_byte_order` 同口径：仅 `little` 反转，缺省 / `big` /
// 枚举外一律大端 fail-open（§0 缺省口径）。谓词形态沿用 R21 的 length 分支 ——
// 不另起一套。**R42（§8.74）起两者一起接到 `utils/byteOrder.js` 单点判据**
// （trim 归一，销掉 §8.66 留白的「不引入 trim 归一」：原写法不带 `.trim()`，
// 而 BE `byte_order_of` 一直是 `str(order).strip().lower()`）。
const isLittleOrder = (pc) => isLittleByteOrder(pc?.byte_order);

// 展示串（"4B 37"）按**字节对**反转。单字节串反转后与原串相同 —— 「1 字节不
// 反转」是反转的自然结果，不是特例（后端 apply_byte_order 同理）。
const reverseHexPairs = (hex) =>
    (hex.replace(/\s/g, '').match(/.{1,2}/g) || []).reverse().join(' ');

// collectDeterministicBytes: 严格可确定性 —— 引用内容全部为字面/可计算才出
// 字节数组，否则 null（卡维持等量 ??）。fixed = 字面 hex；length = Σ 值的大端
// 字节（超宽由 formatToHex 截低位，与编码器同口径；R27 配 varint → LEB128
// 字节）；checksum = 递归自身 refs 求值；容器 = 全子拼接；cobs = 全子拼接后
// COBS 编码 + 定界（R27 §8.59 出线真值）；slot/未配置字面/悬空 → null。
// checksum 分支经 collectRefsBytes 反向引用（模块内互递归，调用均发生在模块
// 初始化之后 → const TDZ 无虞）。
const collectDeterministicBytes = (node, byId, root) => {
    if (!node) return null;
    const kids = node.children || [];
    // R27（§8.59）: cobs —— 空子树也算组（出线 = 0x01 + 定界，不是字面 00），
    // 绝不能落到下文 hex_value 分支读建块默认占位 '00'。
    const isCobs = node.type === 'cobs';
    if (kids.length > 0 || isCobs) {
        const out = [];
        for (const kid of kids) {
            const b = collectDeterministicBytes(kid, byId, root);
            if (b == null) return null;
            out.push(...b);
        }
        if (isCobs) {
            const hex = encodeCobsHex(bytesToHex(out), node.parameter_config || {});
            return hex === null ? null : hexToBytes(hex);
        }
        return out;
    }
    if (node.type === 'slot') return null;
    if (node.type === 'length') {
        const sigma = strictSigma(node, byId, root);
        if (sigma == null) return null;
        // R27（varint 出线 · §8.59）: pc.encoding='varint' → LEB128 最小无符号，
        // **字节序中立**（不走下文 R21 little 反转，也不按 byte_length 定宽）；
        // 值域外 → null（出线期后端 ValueError 拒绝出帧，尺不发明形态）。
        if (normalizeEncoding(node.parameter_config) === 'varint') {
            const vb = encodeVarint(sigma);
            return vb.length ? vb : null;
        }
        // 注意：formatToHex 出的是**已加空格**的展示串（"00 06"），先去掉空格再
        // 按字节切 —— 否则空格被吃进切片（"00 06" → [00,0x0,06]，多出一个 0 字节），
        // ≥2 字节的真值一律显示错位（R21 前的存量缺陷：单字节看不出，2 字节 CRC/
        // 长度必错）。
        const bytes = (formatToHex(sigma, node.byte_length).replace(/\s/g, '').match(/.{1,2}/g) || [])
            .map(p => parseInt(p, 16));
        // R21（长度域 BE/LE）：pc.byte_order=little → 字节对反转，与后端
        // LengthHandler.apply_byte_order 同口径（设计期卡面与出线逐字节一致）；
        // 缺省 / 枚举外一律大端（fail-open，镜像两端算法枚举口径）。
        // R42（§8.74）: 谓词接到单点判据，首尾空白归一后判（与 checksum 侧
        // `isLittleOrder` / BE `byte_order_of` 同口径）—— 原就地写法不 trim。
        return isLittleByteOrder(node.parameter_config?.byte_order)
            ? bytes.slice().reverse()
            : bytes;
    }
    if (node.type === 'checksum') {
        const bytes = collectRefsBytes(node, byId, root);
        if (bytes == null) return null;
        const algo = mapChecksumAlgo(node.parameter_config?.algorithm || node.parameter_config?.algo);
        const out = (formatToHex(calculateChecksum(algo, bytes), node.byte_length).replace(/\s/g, '').match(/.{1,2}/g) || [])
            .map(p => parseInt(p, 16));
        // R34（校验和字节序）: 计算点 ① —— pc.byte_order=little → 字节对反转
        // （与 ② injectRefsSigma 同一份谓词，改一必改二）。
        return isLittleOrder(node.parameter_config) ? out.slice().reverse() : out;
    }
    const hexVal = String(node.hex_value || node.parameter_config?.hex || '').replace(/\s/g, '');
    if (hexVal && /^[\dA-Fa-f]+$/.test(hexVal)) {
        return (hexVal.match(/.{1,2}/g) || []).map(p => parseInt(p, 16));
    }
    return null;
};

// collectRefsBytes: 引用目标逐个取可确定字节（悬空/任一不可确定 → null）。
const collectRefsBytes = (owner, byId, root) => {
    const refs = owner?.parameter_config?.refs;
    if (!Array.isArray(refs) || refs.length === 0 || !root) return null;
    const out = [];
    for (const refId of refs) {
        const target = findNode(root, refId);
        if (!target) return null;
        const b = collectDeterministicBytes(target, byId, root);
        if (b == null) return null;
        out.push(...b);
    }
    return out;
};

const withComputedValue = (item, value) => ({
    ...item,
    parameter_config: { ...item.parameter_config, computedValue: value }
});

// 全泳道扫描注入（人工验证反馈 2 起为严格口径）：length → 设计期 Σ 回显（十进
// 制 `${sigma}B`，长度是"数量"不是字节内容，hex `04` 会被读成字节值；卡片宽度/
// 页脚另由 byte_length 与偏移标尺承担）；checksum → refs 全可确定时按算法算出
// 设计期真值直填（mapChecksumAlgo 缺省 CRC_16_MODBUS，与编码器同源），否则不
// 注入（维持等量 ??）。无 root 的纯函数直调（既有单测）长度仍走 computeRefsSigma。
export const injectRefsSigma = (lanes, byId, root) => (lanes || []).map(lane => ({
    ...lane,
    items: (lane.items || []).map(item => {
        if (item?.type === 'length') {
            const sigma = root ? strictSigma(item, byId, root) : computeRefsSigma(item, byId, root);
            if (sigma == null) return item;
            return withComputedValue(item, `${sigma}B`);
        }
        if (item?.type === 'checksum') {
            const bytes = collectRefsBytes(item, byId, root);
            if (bytes == null) return item;
            const algo = mapChecksumAlgo(item.parameter_config?.algorithm || item.parameter_config?.algo);
            const hex = formatToHex(calculateChecksum(algo, bytes), item.byte_length);
            // R34（校验和字节序）: 计算点 ② —— pc.byte_order=little → 字节对反转
            // （与 ① collectDeterministicBytes 同一份谓词，改一必改二）。
            return withComputedValue(item,
                isLittleOrder(item.parameter_config) ? reverseHexPairs(hex) : hex);
        }
        return item;
    })
}));

// ─── 容器内容注入：组/容器卡中央值 = 嵌套内容逐块拼接 ──────────────────────
// 口径（与指令页 useInstructionLanes.fieldContent 同源）：已知子块出字面 hex、
// 未知子块按 byte_length 出等量 ??（如 `AA 55 ?? ??`），页脚仍显示尺寸 `4B @00`。
// length/checksum/slot 的 hex_value '00' 是建块默认占位、非真值（Block 卡面也
// 不走 hex 分支）→ 一律按 byte_length 出等量 ??；空容器拼不出内容 → 不注入
// （Block 落尺寸分支显 0B）。递归嵌套、纯函数（仅命中容器时复制副本）。
// byId/root 可选（人工验证反馈 2）：给出时 length/checksum/slot 子块先走严格
// 可确定性（真值字节直出），不可确定/未给出 → 回落按字节等量 ??（既有
// injectContainerContent(lanes) 单测不带 byId/root → 行为不变）。
const nodeContent = (node, byId, root) => {
    const kids = node.children || [];
    const isContainer = isNestable(node.type) || kids.length > 0;
    if (isContainer) {
        if (kids.length === 0) return null;
        const parts = kids.map(k => nodeContent(k, byId, root)).filter(p => p != null);
        return parts.length ? parts.join(' ') : null;
    }
    if (node.type === 'length' || node.type === 'checksum' || node.type === 'slot') {
        if (byId && root) {
            const bytes = collectDeterministicBytes(node, byId, root);
            if (bytes != null) return bytesToHex(bytes);
        }
        return formatUnknown(node.byte_length);
    }
    const hexVal = String(node.hex_value || node.parameter_config?.hex || '').replace(/\s/g, '');
    // 卡面 = 存储值原样拼接（含全 0 默认占位——存储值即编码真值，与 Block
    // 卡面同步；人工验证第 3 轮 #2 撤「全 0 → ??」回退）；?? 只留无 hex /
    // 非法 hex 的卡。计算层 collectDeterministicBytes 不受显示口径影响。
    if (hexVal && /^[\dA-Fa-f]+$/.test(hexVal)) {
        return (hexVal.match(/.{1,2}/g) || []).join(' ').toUpperCase();
    }
    return formatUnknown(node.byte_length);
};

export const injectContainerContent = (lanes, byId, root) => (lanes || []).map(lane => ({
    ...lane,
    items: (lane.items || []).map(item => {
        if (!item) return item;
        const kids = item.children || [];
        if (!(isNestable(item.type) || kids.length > 0)) return item;
        const content = nodeContent(item, byId, root);
        if (content == null) return item;
        return {
            ...item,
            parameter_config: {
                ...item.parameter_config,
                computedValue: content
            }
        };
    })
}));
