// P3/P4 序列视图模型（纯函数 + 单测）：后端 backend/routers/sequence.py 与
// backend/core/sequence_plan.py 的前端对端——buildPlan 产出的计划键集必须与
// normalize_plan 的严格形态逐字一致（未知键会被 400 拒绝），算法/字节序映射
// 与 utils/formula.js ChecksumAlgo ↔ 后端 VALID_ALGOS 对齐。改一须核对另一端。

// 与 backend/core/response_match.py 的 VALID_ALGOS（sum/xor/crc16_modbus）对齐；
// formula.js 的 CRC_32 后端计划不支持 → 生成侧降级为冻结 + 警告。
export const PLAN_ALGO = Object.freeze({
    SUM_8: 'sum',
    XOR_8: 'xor',
    CRC_16_MODBUS: 'crc16_modbus'
});

// 缺省 config 与后端 _normalize_config 的服务端归一同形（显式传 null = 不设超时）。
export const EMPTY_CONFIG = Object.freeze({ stop_on_error: true, read_timeout_ms: null });

// ---------------------------------------------------------------------------
// byteMap 区间工具
// encodeInstruction 的 byteMap 条目只覆盖 LEAF（emitNode 仅在叶子 push），
// end 为开区间；refs 可能指向组 → 取子树全部叶子的并集（组整体重复时并集
// 恰为整组连续区间，与编码器 _encodeFieldBytes 展开组重复的取值范围一致）。
// ---------------------------------------------------------------------------

const childrenListOf = (field, kidsOf) => {
    const nested = field.fields || field.blocks || field.children;
    if (nested && nested.length > 0) return nested;
    return kidsOf.get(field.id) || [];
};

// 与 InstructionEncoder.encodeInstruction 的树构建同构（嵌套 fields 优先，
// 否则 parent_id 扁平链接；未被引用者为根）。
const buildIndex = (instruction) => {
    const rawFields = instruction?.fields || instruction?.blocks || [];
    const all = [];
    const walk = (list) => (list || []).forEach((f) => { all.push(f); walk(f.fields || f.blocks || f.children); });
    walk(rawFields);
    const idSet = new Set(all.map((f) => f.id));
    const kidsOf = new Map();
    all.forEach((f) => {
        const pid = (f.parent_id != null && idSet.has(f.parent_id)) ? f.parent_id : null;
        if (!kidsOf.has(pid)) kidsOf.set(pid, []);
        kidsOf.get(pid).push(f);
    });
    const referenced = new Set();
    kidsOf.forEach((list, pid) => { if (pid != null) list.forEach((k) => referenced.add(k.id)); });
    all.forEach((f) => (f.fields || f.blocks || f.children || []).forEach((c) => referenced.add(c.id)));
    const roots = all.filter((f) => !referenced.has(f.id));
    return { all, kidsOf, roots };
};

// 多份重复的同一 fieldId 合并为并集（min..max；组/重复的并集为连续整段）。
const buildSpans = (byteMap) => {
    const spans = new Map();
    (byteMap || []).forEach(({ start, end, fieldId }) => {
        const prev = spans.get(fieldId);
        if (!prev) spans.set(fieldId, { start, end });
        else {
            prev.start = Math.min(prev.start, start);
            prev.end = Math.max(prev.end, end);
        }
    });
    return spans;
};

const subtreeLeafIds = (root, kidsOf) => {
    const ids = [];
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        const kids = childrenListOf(node, kidsOf);
        if (kids.length === 0) ids.push(node.id);
        else kids.forEach((k) => stack.push(k));
    }
    return ids;
};

const spanUnionOf = (root, kidsOf, spans) => {
    let start = Infinity;
    let end = -Infinity;
    subtreeLeafIds(root, kidsOf).forEach((id) => {
        const s = spans.get(id);
        if (s) {
            start = Math.min(start, s.start);
            end = Math.max(end, s.end);
        }
    });
    return start === Infinity ? null : { start, end };
};

const overlapsChecksum = (region, fieldStart, fieldEnd) => region[0] < fieldEnd && region[1] > fieldStart;

/**
 * 步骤保存时的发送重算计划编译（P3 契约：payload/params 保存时定值，
 * TIME/COUNTER/checksum 发送时按 plan 重算）。
 *
 * 语义逐条镜像 InstructionEncoder：动态门槛 = op 原名 + params.type
 * ''/'number'（raw 指令才保有原 op；normalizeRunnerInstruction 会把
 * TIME_ACCUMULATOR 映射为 TIME_CUMULATIVE、AUTO_COUNTER 映射为 INPUT，
 * 故本函数与编码一律走 raw 指令）；COUNTER 的 Current 取 computed >
 * input > 静态 value > start_val（跨发送不自增，计划为冻结模板的确定性
 * 重算，状态机不在计划内）；checksum 只认 algorithm（与编码器同源，缺省
 * CRC_16_MODBUS）、refs 按数组顺序生成区间、找不到的 refs 跳过。
 *
 * @returns {{plan: object|null, warnings: string[]}}
 *   plan 为 null（全静态帧，后端原样发送）或严格形态 {dynamic, checksum}；
 *   一切后端会 400 的形态（自含重叠、CRC 非 2 字节、>4 字节、算法不支持、
 *   refs 无区间）在生成侧降级为「冻结 + warnings」，保存必过、代价是该
 *   字段不随发送重算。
 */
export function buildPlan(instruction, inputs, computedValues, byteMap) {
    const warnings = [];
    const dynamic = [];
    let checksum = null;

    if (!instruction || !Array.isArray(byteMap) || byteMap.length === 0) {
        return { plan: null, warnings };
    }

    const { all, kidsOf } = buildIndex(instruction);
    const spans = buildSpans(byteMap);

    all.forEach((field) => {
        const params = field.parameter_config || {};
        const typeGate = ['', 'number'].includes(String(params.type ?? '').toLowerCase());
        if (!typeGate) return; // 与编码器同门槛：矛盾 type 不走动态语义（静态冻结）
        const span = spanUnionOf(field, kidsOf, spans);
        if (!span) return; // 未入帧（repeat=0 等）
        const byteLen = span.end - span.start;

        if (field.op_code === 'TIME_ACCUMULATOR') {
            const base = params.base_time;
            if (!Number.isFinite(Date.parse(base ?? ''))) {
                warnings.push(`字段「${field.name || field.id}」base_time 缺失/非法，时间字节已冻结`);
                return;
            }
            dynamic.push({
                field_id: field.id,
                op: 'TIME_ACCUMULATOR',
                offset: span.start,
                byte_len: byteLen,
                base_time: base
            });
        } else if (field.op_code === 'AUTO_COUNTER') {
            const hasCur = params.value !== undefined && params.value !== null && params.value !== '';
            const rawCur = computedValues?.[field.id] !== undefined ? computedValues[field.id]
                : inputs?.[field.id] !== undefined ? inputs[field.id]
                    : (hasCur ? params.value : params.start_val);
            const entry = {
                field_id: field.id,
                op: 'AUTO_COUNTER',
                offset: span.start,
                byte_len: byteLen,
                // 无任何 Current 源 → 与编码器 floorNum(undefined)=0 同口径
                value: rawCur === undefined || rawCur === null ? 0 : rawCur
            };
            ['start_val', 'step', 'max'].forEach((key) => {
                const v = params[key];
                if (v !== undefined && v !== null && v !== '') entry[key] = v;
            });
            dynamic.push(entry);
        }
    });

    // --- checksum（单个；多校验字段仅首个入计划） ---
    const ckFields = all.filter(
        (f) => f.op_code === 'CHECKSUM_CRC' || (f.parameter_config || {}).type === 'checksum'
    );
    if (ckFields.length > 1) warnings.push('存在多个校验字段：仅首个纳入发送时重算计划');
    const ck = ckFields[0];
    if (ck) {
        const params = ck.parameter_config || {};
        const refs = Array.isArray(params.refs) ? params.refs : [];
        const span = spanUnionOf(ck, kidsOf, spans);
        // 编码器仅在 refs 非空时计算校验值 → 无 refs = 保存时已冻结，同口径不发计划
        if (span && refs.length > 0) {
            const fieldLen = span.end - span.start;
            const algoKey = params.algorithm || 'CRC_16_MODBUS'; // 与编码器缺省一致
            const algo = PLAN_ALGO[algoKey];
            if (!algo) {
                warnings.push(`校验算法 ${algoKey} 后端计划不支持，校验字段已冻结`);
            } else if (algo === 'crc16_modbus' && fieldLen !== 2) {
                warnings.push('crc16 校验字段须 2 字节，校验字段已冻结');
            } else if (fieldLen > 4) {
                warnings.push('校验字段超过 4 字节，校验字段已冻结');
            } else {
                const regions = [];
                let missing = 0;
                refs.forEach((refId) => {
                    const node = all.find((f) => f.id === refId);
                    const rs = node ? spanUnionOf(node, kidsOf, spans) : null;
                    if (!rs) { missing += 1; return; } // 与编码器同：悬空 refs 跳过
                    regions.push([rs.start, rs.end]);  // 列示顺序 = refs 数组顺序（crc16 按此序拼接）
                });
                if (regions.length === 0) {
                    warnings.push('校验 refs 无有效字节区间，校验字段已冻结');
                } else if (regions.some((r) => overlapsChecksum(r, span.start, span.end))) {
                    warnings.push('校验字段与 refs 区间重叠（后端拒绝自含反算），校验字段已冻结');
                } else {
                    checksum = {
                        offset: span.start,
                        byte_length: fieldLen,
                        algo,
                        byte_order: ck.endianness === 'LITTLE' ? 'little' : 'big',
                        regions
                    };
                    if (missing > 0) warnings.push(`${missing} 个校验 refs 无字节区间，已按可得区间生成计划`);
                }
            }
        }
    }

    if (dynamic.length === 0 && checksum === null) return { plan: null, warnings };
    return { plan: { dynamic, checksum }, warnings };
}

// ---------------------------------------------------------------------------
// 状态快照 / 步骤行展示（/sequences/status 轮询口径，见 schemas/sequence_api.py）
// ---------------------------------------------------------------------------

const RESULT_LABELS = Object.freeze({
    idle: '待机',
    running: '运行中',
    completed: '完成',
    failed: '失败',
    stopped: '已停止'
});

export function resultLabel(result) {
    return RESULT_LABELS[result] || String(result || '—');
}

// 徽标色调 token（拼进 className；中性回退，未知值不炸样式）。
export function resultTone(result) {
    switch (result) {
        case 'completed': return 'border-green-500/40 bg-green-500/10 text-green-300';
        case 'failed': return 'border-red-500/40 bg-red-500/10 text-red-300';
        case 'running': return 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300';
        case 'stopped': return 'border-orange-500/40 bg-orange-500/10 text-orange-300';
        default: return 'border-nier-light/30 bg-nier-dark/60 text-nier-light/70';
    }
}

export function stepTone(status) {
    switch (status) {
        case 'OK': return 'text-green-400';
        case 'ERROR': return 'text-red-400';
        case 'SKIPPED': return 'text-orange-300';
        default: return 'text-nier-light/50';
    }
}

// 进度文案：idle → '—'；运行中 → current/total；终态（current 已清）→ total/total。
export function progressText(snap) {
    if (!snap || !snap.total_steps) return '—';
    const current = snap.current_step ?? snap.total_steps;
    return `${current}/${snap.total_steps}`;
}

// 步骤计划摘要（列表/编辑器徽标）。
export function planSummary(plan) {
    if (!plan) return '静态帧';
    const parts = [];
    if (Array.isArray(plan.dynamic) && plan.dynamic.length > 0) parts.push(`动态×${plan.dynamic.length}`);
    if (plan.checksum) parts.push(`校验 ${plan.checksum.algo}`);
    return parts.length > 0 ? parts.join(' · ') : '静态帧';
}

// 紧凑 hex 帧的字节数（分隔符不计；空 → 0）。
export function payloadByteCount(payload) {
    const cleaned = String(payload || '').replace(/[\s,_-]/g, '');
    return Math.floor(cleaned.length / 2);
}

// 步骤数组位序调整（保存时经 PUT 整体回写，后端按数组序重编 step_order）。
export function reorder(items, from, to) {
    const list = [...(items || [])];
    if (from === to) return list;
    if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    return list;
}
