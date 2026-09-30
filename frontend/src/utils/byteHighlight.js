// 字段 ↔ 字节流定位（指令加工编辑反馈 第 4 批 #2）：点击字段 →
// BYTE_STREAM_OUTPUT 高亮对应字节。纯函数层（InstructionRunner 只做状态接线）。
// byteMap 契约来自 InstructionEncoder.encodeInstruction：
// { start, end, fieldId }（字节下标、end 开区间、同字段多次出现多条目）。

// 指令树子节点：嵌套 fields（normalizeRunnerInstruction 建树）或协议式 children。
const childrenOf = (node) => (node?.fields?.length ? node.fields
    : node?.children?.length ? node.children : null);

// 目标 id + 其子树全部节点 id（容器选中 → 命中子孙字节）；未命中 → 空集。
export const collectSubtreeIds = (roots, targetId) => {
    const ids = new Set();
    if (!roots || !targetId) return ids;
    const walk = (nodes) => {
        for (const node of nodes || []) {
            if (node.id === targetId) {
                const collect = (n) => {
                    ids.add(n.id);
                    (childrenOf(n) || []).forEach(collect);
                };
                collect(node);
                return true;
            }
            if (walk(childrenOf(node))) return true;
        }
        return false;
    };
    walk(roots);
    return ids;
};

// byteMap 条目按 id 集过滤（保 byteMap 序）；空集 / 无 map → []。
export const matchByteRanges = (byteMap, ids) =>
    (Array.isArray(byteMap) && ids && ids.size > 0)
        ? byteMap.filter(e => ids.has(e.fieldId))
        : [];

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

// 读数文案：'0x02-0x05'；多条目 '0x00-0x01, 0x06-0x06'；空 → ''。
export const formatByteRanges = (entries) => (entries || [])
    .map(e => `0x${hex2(e.start)}-0x${hex2(e.end - 1)}`)
    .join(', ');

// hex 分段：按 byteMap 区间把 pretty 串切成渲染段，段内逐字节 `XX XX`
// 空格分隔（与整帧 pretty 格式一致、不连写），零长段丢弃；selectedIds
// 命中段打标。byteMap 空 → 整串单段回落（fieldId null）。
// N5 (G4 · 对齐/填充)：byteMap 只记内容字节 → 区间中缝/首尾的填充字节
// （align 前置 / pad_to 后置）不在任何条目内 —— 以无主段（fieldId null、
// 不参与高亮）补齐，保证渲染串 = hexPreview 全字节（与 LEN: N BYTES 同口径，
// 否则预览会吞掉线上真实发出的填充字节）。
const spaced = (raw) => (raw.match(/.{1,2}/g) || []).join(' ');

export const buildHexSegments = (hexPreview, byteMap, selectedIds) => {
    if (!hexPreview) return [];
    const raw = hexPreview.replace(/\s/g, '');
    const total = raw.length / 2;
    if (!Array.isArray(byteMap) || byteMap.length === 0) {
        return [{ text: spaced(raw), fieldId: null, start: 0, end: total, selected: false }];
    }
    const segs = [];
    let covered = 0; // 已渲染到的字节下标（区间按发射序递增，重叠/回退条目截断不重复渲染）
    byteMap.forEach((e) => {
        if (typeof e.start !== 'number' || typeof e.end !== 'number') return;
        const start = Math.min(Math.max(e.start, covered), total);
        const end = Math.min(Math.max(e.end, start), total);
        if (start > covered) {
            segs.push({
                text: spaced(raw.slice(covered * 2, start * 2)),
                fieldId: null, start: covered, end: start, selected: false
            });
        }
        if (end > start) {
            segs.push({
                text: spaced(raw.slice(start * 2, end * 2)),
                fieldId: e.fieldId, start, end,
                selected: Boolean(selectedIds && selectedIds.has(e.fieldId))
            });
        }
        covered = Math.max(covered, end);
    });
    if (covered < total) {
        segs.push({
            text: spaced(raw.slice(covered * 2)),
            fieldId: null, start: covered, end: total, selected: false
        });
    }
    return segs.filter(s => s.text.length > 0);
};

// 字段名回查（name 优先、label 回退）；未命中 null。
export const findFieldLabel = (roots, id) => {
    if (!roots || !id) return null;
    let found = null;
    const walk = (nodes) => {
        for (const node of nodes || []) {
            if (node.id === id) {
                found = node.name || node.label || null;
                return true;
            }
            if (walk(childrenOf(node))) return true;
        }
        return false;
    };
    walk(roots);
    return found;
};
