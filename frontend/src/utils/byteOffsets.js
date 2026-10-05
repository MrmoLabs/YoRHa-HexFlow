// P1: byte-offset ruler for the instruction editor (see PLAN_InstructionManagement.md §3).
import { alignPadLen, padSpec, padToPadLen } from './padSpec';
// R27（§8.52 排期 · varint / COBS 出线 · §8.59）: length 卡出线编码与
// LEB128 宽度 —— 尺必须跟编码器同宽，否则其后所有偏移错 1..n 字节。
import { normalizeEncoding, varintWidth } from './framing';
// R32 (§8.64): presence 比较谓词 —— 与 InstructionEncoder._presenceHit / 后端
// field_blocks._presence_hit 同一个（"01" ≡ 1 十六进制归一），改一必改二。
// 若此处不跟归一，会出现「编码期命中、卡面却按 0 字节排偏移」的两端矛盾。
import { presenceEqual } from './presenceSemantics';
// Pure function — walks fields by parent_id/sequence and computes each block's
// start offset plus the instruction's total byte length.
//
// Dynamic-length display口径 (design finalized in Phase 1, plan research point #5):
//   1. A block's size = numeric byte_len (> 0) when present;
//   2. otherwise, if parameter_config.computedValue holds a plain hex string
//      (not "??"), its byte count is used — this is the "dynamic length uses
//      current computedValue" rule from the plan;
//   3. otherwise the size is UNKNOWN (null).
//   A group's size = Σ children; if any child is unknown the group is unknown.
// Unknown sizes poison only what FOLLOWS them: the block itself keeps its start
// offset, later blocks show "··", and total length becomes a lower bound
// (exact=false → UI renders the "+" suffix).
//
// Fixed vs variable: `variable=true` when the frame contains DYNAMIC repeat
// (repeat_ref_id), value-driven sizes (computedValue fallback), any unknown
// size, or a complete presence gate — the UI then labels the header VAR (with
// "~" while still computable); otherwise it labels FIXED. Sizes always mirror
// the encoder's real output (E1-5: FIXED repeats expand N copies — a DYNAMIC
// repeat's count only exists at run time, so its group degrades to an unknown
// size instead of lying).
//
// Presence gating (N3 / G1): a field with parameter_config.presence may be
// omitted at run time. The static preview judges it by pc.value (the static
// chain of DYNAMIC repeat's resolve): miss → 0B and the gate fires BEFORE the
// repeat expansion (a missed FIXED×3 group is 0, not Σ×3; a DYNAMIC one is 0,
// not "??"); ref present but without a static value → unknown ("??", sizes
// always mirror the encoder, which decides at run time); incomplete config or
// a dangling ref → fail-open (the encoder always emits → no gate, normal
// size). A missed group zeroes its whole subtree (its children emit nothing),
// and any complete gate makes the frame VAR (emission follows the run-time
// value of the ref field).
//
// R27 (§8.52 排期 · varint / COBS 出线 · §8.59): 出线宽度口径 ——
//   · length 卡配 pc.encoding='varint' → size = varintWidth(值)，值 = refs Σ +
//     pc.offset（与 InstructionEncoder PASS1 / 后端 LengthHandler 同式；任一 ref
//     尺寸未知或值域外 → 未知，下游沿既有 ?? 链）；
//   · cobs 组的 COBS 出线宽取决于子树字节（0x00 分布、254 满块），本模块只认
//     尺寸不编码 → 由 protocolTree.computeProtocolOffsets 两遍法经
//     opts.sizeOverrides 回灌精确值（编不出 → 注入 null = 未知，不谎报成 Σ 下界）。

const bySequence = (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0);

const isGroupOp = (f) => {
    const op = String(f.op_code || '').toUpperCase();
    return op.includes('ARRAY_GROUP') || op.includes('STRUCT');
};

const hasDynamicRepeat = (f) => String(f.repeat_type || '').toUpperCase() === 'DYNAMIC'
    || f.repeat_ref_id != null;

const hexByteCount = (cv) => {
    if (typeof cv !== 'string') return null;
    const clean = cv.replace(/\s/g, '');
    if (!clean || !/^[0-9A-Fa-f]+$/.test(clean)) return null; // rejects "??" and ""
    return clean.length % 2 === 0 ? clean.length / 2 : null;
};

/**
 * N3 (G1): 设计期 presence 静态判定（computeByteOffsets 与 useInstructionLanes 共用）。
 * 返回：
 *   null      —— 无门：未配置 / 配置不完整（fail-open）/ ref 悬空（编码恒发射）；
 *   'hit'/'miss' —— 按静态值链 pc.value 判出（DYNAMIC repeat 静态 resolve 同链，
 *                   presenceEqual：String 归一 + R32 十六进制归一 `"01"` ≡ 1）；
 *   'unknown' —— ref 在场但无静态值（运行输入才决定 → 尺寸落 ??）。
 * @param {object} field 字段/组
 * @param {Map} fieldsById id → field 查表（缺失即悬空）
 */
export function presenceStaticState(field, fieldsById) {
    const pres = field?.parameter_config?.presence;
    if (!pres || typeof pres !== 'object' || Array.isArray(pres)) return null;
    if (pres.ref_id === undefined || pres.ref_id === null || pres.ref_id === '') return null;
    if (pres.expect === undefined || pres.expect === null || pres.expect === '') return null;
    const ref = fieldsById?.get ? fieldsById.get(pres.ref_id) : null;
    if (!ref) return null; // 悬空 ref → 编码 fail-open 恒发射 → 无门
    const refVal = ref.parameter_config ? ref.parameter_config.value : undefined;
    if (refVal === undefined || refVal === null) return 'unknown'; // 运行输入才有
    // R32 (§8.64): 与 InstructionEncoder._presenceHit 同谓词（设计期静态链只判 pc.value）
    return presenceEqual(pres.expect, refVal) ? 'hit' : 'miss';
}

export function computeByteOffsets(instruction, opts) {
    const fields = Array.isArray(instruction?.fields) ? instruction.fields : [];

    // R27 (§8.59): sizeOverrides —— 调用方注入的**精确出线尺寸**（protocolTree
    // 两遍法：COBS 区的实际宽度取决于子树字节里的 0x00 分布，本模块只认尺寸不
    // 编码 → 由 collectDeterministicBytes 算定后回灌）。Map<id, size|null>，
    // 命中即用；值 null = 该块出线宽不可知（下游沿既有 ?? 链落未知）。
    const sizeOverrides = (opts && opts.sizeOverrides instanceof Map) ? opts.sizeOverrides : null;

    // Build sibling lists per parent (orphan parent_id → root, matching the
    // normalizeInstructionBlocks convention in blockMerge.js).
    const kidsOf = new Map();
    fields.forEach((f) => {
        const parent = (f.parent_id != null && fields.some((p) => p.id === f.parent_id))
            ? f.parent_id
            : null;
        if (!kidsOf.has(parent)) kidsOf.set(parent, []);
        kidsOf.get(parent).push(f);
    });
    kidsOf.forEach((list) => list.sort(bySequence));

    // N3 (G1): presence 查表 + 父链（组未命中 → 整棵子树 0）。
    const fieldsById = new Map(fields.map((f) => [f.id, f]));
    const parentOf = new Map();
    fields.forEach((f) => {
        if (f.parent_id != null && fieldsById.has(f.parent_id)) parentOf.set(f.id, fieldsById.get(f.parent_id));
    });

    // Size resolution (memoized; cache-seed guards against parent cycles).
    const sizeCache = new Map();
    let dynamicSized = false; // any leaf sized from value-driven computedValue
    let presenceGated = false; // any complete presence gate → emission follows run-time ref value
    const ancestorMissed = (f) => {
        let p = parentOf.get(f.id);
        let guard = 0;
        while (p && guard++ < 1000) {
            if (presenceStaticState(p, fieldsById) === 'miss') { presenceGated = true; return true; }
            p = parentOf.get(p.id);
        }
        return false;
    };
    const resolveSize = (f) => {
        if (sizeCache.has(f.id)) return sizeCache.get(f.id);
        sizeCache.set(f.id, null);
        // N3 (G1): 祖先 presence 静态未命中 → 子树 0（组未命中整棵子树不发射）。
        if (ancestorMissed(f)) { sizeCache.set(f.id, 0); return 0; }
        // N3 (G1): 自身 presence 静态预判 —— 未命中 → 0（判定先于 repeat：组连
        // ×N 都不展开，DYNAMIC 也不落 ??）；静态判不了 → null（??）；
        // 命中/无门 → 走原尺寸链。
        const pState = presenceStaticState(f, fieldsById);
        if (pState !== null) presenceGated = true; // 完整门 → 发射随运行值变 → VAR
        if (pState === 'miss') { sizeCache.set(f.id, 0); return 0; }
        if (pState === 'unknown') { sizeCache.set(f.id, null); return null; }
        // R27 (§8.59): 调用方注入的精确出线尺寸优先（COBS 区宽度要真编码才知道；
        // protocolTree.computeProtocolOffsets 两遍法在第二遍回灌）。
        if (sizeOverrides && sizeOverrides.has(f.id)) {
            const forced = sizeOverrides.get(f.id);
            sizeCache.set(f.id, forced);
            return forced;
        }
        const kids = kidsOf.get(f.id) || [];
        let size;
        if (kids.length > 0 || isGroupOp(f)) {
            if (hasDynamicRepeat(f)) {
                // E1-5 (B7): DYNAMIC repeat counts resolve at run time — the exact
                // size (and everything that follows) is unknowable now. Degrade to
                // unknown: VAR label, "··" offsets, "+" lower-bound total. Showing
                // one copy would contradict the encoder, which expands N times.
                size = null;
            } else {
                // Group = Σ children × N (FIXED repeat; NONE → 1). An EMPTY group
                // is a known 0 bytes — it emits nothing, so it must not poison
                // downstream offsets like seed rows with byte_len=0.
                let reps = 1;
                if (String(f.repeat_type || '').toUpperCase() === 'FIXED') {
                    const c = f.repeat_count;
                    reps = (typeof c === 'number' && Number.isFinite(c)) ? Math.max(0, Math.floor(c)) : 1;
                }
                let sum = 0;
                size = 0;
                for (const k of kids) {
                    const ks = resolveSize(k);
                    if (ks === null) { size = null; break; }
                    sum += ks;
                }
                if (size !== null) size = sum * reps;
            }
        } else {
            // R27 (§8.52 排期 · varint / COBS 出线 · §8.59): length 卡配
            // pc.encoding='varint' → 出线宽度 = varintWidth(值)，值 = refs Σ +
            // pc.offset（镜像 InstructionEncoder PASS1 与后端 LengthHandler 的
            // count+offset）。设计期值随 refs 尺寸静态可定 → 精确；任一 ref 尺寸
            // 未知 → 未知（下游沿既有 ?? 链落 ??）。值域外（varintWidth → null）
            // 同样落未知 —— 出线期后端 ValueError 拒绝出帧，尺不发明形态。
            // 悬空 ref 计 0（与 PASS1 `fieldSizes[refId] || 0` 同口径）。
            if (f.type === 'length' && normalizeEncoding(f.parameter_config) === 'varint') {
                const refs = Array.isArray(f.parameter_config?.refs) ? f.parameter_config.refs : [];
                let value = 0;
                let known = true;
                for (const refId of refs) {
                    const target = fieldsById.get(refId);
                    const refSize = target ? resolveSize(target) : 0;
                    if (refSize === null) { known = false; break; }
                    value += refSize;
                }
                const off = Number(f.parameter_config?.offset);
                if (Number.isFinite(off)) value += off;
                size = known ? varintWidth(value) : null;
            } else {
                const n = Number(f.byte_len ?? f.byte_length);
                if (Number.isFinite(n) && n > 0) {
                    size = n;
                } else {
                    size = hexByteCount(f.parameter_config?.computedValue);
                    if (size !== null) dynamicSized = true; // length derived from the current value
                }
            }
        }
        sizeCache.set(f.id, size);
        return size;
    };

    const byId = new Map();
    let cursor = 0;   // null once an unknown-size block has been passed
    let hasUnknown = false;
    let dynamicRepeat = false; // DYNAMIC repeat / repeat_ref_id → count varies per run
    let total = 0;   // N5 (G4): 线上总长 = 游标驱动（含 pad），未知根回退内容尺寸

    // N5 (G4): FIXED 副本数（与 resolveSize 的组口径同源；NONE → 1）。
    const fixedRepsOf = (f) => {
        if (String(f.repeat_type || '').toUpperCase() !== 'FIXED') return 1;
        const c = f.repeat_count;
        return (typeof c === 'number' && Number.isFinite(c)) ? Math.max(0, Math.floor(c)) : 1;
    };

    const walk = (list, isTop) => {
        let prevId = null; // 同列表上一兄弟：align 前置 pad 的归属者
        list.forEach((f) => {
            const kids = kidsOf.get(f.id) || [];
            const size = resolveSize(f);
            const isGroup = kids.length > 0 || isGroupOp(f);
            const rootStart = isTop ? cursor : null;
            // N5 (G4): presence 静态未命中 → 与发射同口径不补 pad（0 字节）。
            const missed = ancestorMissed(f) || presenceStaticState(f, fieldsById) === 'miss';
            const spec = padSpec(f.parameter_config);
            const firstVisit = !byId.has(f.id); // 重复副本只留副本 #1 的位置记录
            // 组 repeat 0 → 不发字节也不补 pad（emitNode n<=0 早退同口径）。
            const reps = (kids.length > 0 && size !== null && cursor !== null)
                ? fixedRepsOf(f) : 1;
            const emits = !missed && (kids.length === 0 || reps > 0);

            // N5 (G4) align 前置 pad：内容起点补到 N 边界；pad 归入前一兄弟的
            // span（同列表首项 / 重复副本同 id → 不另归属，组 span 走游标算术
            // 覆盖）。size 未知时不补（游标口径与既有 ?? 链一致）。
            if (emits && size !== null && cursor !== null && spec.align) {
                const p = alignPadLen(cursor, spec.align);
                if (p > 0) {
                    if (prevId !== null && prevId !== f.id) {
                        const prev = byId.get(prevId);
                        if (prev) prev.pad = (prev.pad || 0) + p;
                    }
                    cursor += p;
                }
            }
            const contentStart = cursor;
            if (firstVisit) byId.set(f.id, { offset: contentStart, size, isGroup });
            prevId = f.id;
            if (hasDynamicRepeat(f)) dynamicRepeat = true;

            if (kids.length > 0) {
                if (reps <= 0) {
                    // repeat 0：仅记录副本 #1 位置，游标不动（不发字节）。
                    const saved = cursor;
                    walk(kids, false);
                    cursor = saved;
                } else {
                    // 逐副本模拟：pad 按各副本的绝对偏移算（非 Σ×reps 常数）；
                    // 游标未知时只走一遍（副本 #1 记录，与既有口径一致）。
                    for (let c = 0; c < reps; c++) {
                        walk(kids, false);
                        if (cursor === null) break;
                    }
                }
            } else if (size !== null && cursor !== null) {
                cursor += size;
            }

            // R27 (§8.59): 组出线宽被注入覆盖（COBS 区 =Σ 子宽 + 码字节 + 定界，比
            // 子宽**大**）→ 游标按组自身 size 收口，其后块起点与总长才与出线同宽。
            // 普通组 size 恒 = Σ 子（或含 pad 时 Σ 子 + pad ≥ size），条件不成立 →
            // 既有口径零影响；只在 override 让 size 大于子行进量时生效。
            if (kids.length > 0 && size !== null && cursor !== null
                && contentStart !== null && cursor - contentStart < size) {
                cursor = contentStart + size;
            }

            // N5 (G4) pad_to 后置 pad：内容末尾（组 = 末副本后）补到 N 边界。
            let ownPad = 0;
            if (emits && size !== null && cursor !== null && spec.padTo) {
                const p = padToPadLen(cursor, spec.padTo);
                if (p > 0) { cursor += p; ownPad = p; }
            }

            if (isGroup) {
                // 组 span 的 pad = 游标算术（各副本子字段 pad + 自身 pad_to）；
                // 子字段的 pad 留在子记录上供所在行布局，不上卷（避免与游标
                // 重复计数）。
                if (firstVisit && reps > 0 && contentStart !== null
                    && cursor !== null && size !== null) {
                    const extra = (cursor - contentStart) - size;
                    if (extra > 0) {
                        const rec = byId.get(f.id);
                        if (rec) rec.pad = (rec.pad || 0) + extra;
                    }
                }
            } else if (ownPad > 0 && firstVisit) {
                const rec = byId.get(f.id);
                if (rec) rec.pad = (rec.pad || 0) + ownPad;
            }

            if (size === null) {
                hasUnknown = true;
                cursor = null;
            }

            // N5 (G4) 顶层根累计线上总长：游标驱动（含 pad）；游标未知回退
            // 内容尺寸 —— 与既有 Σ resolveSize 的下界口径一致。
            if (isTop) {
                if (rootStart !== null && cursor !== null) {
                    total += cursor - rootStart;
                } else {
                    const s = resolveSize(f);
                    if (s !== null) total += s;
                }
            }
        });
    };
    walk(kidsOf.get(null) || [], true);

    // Fixed vs variable: a frame is FIXED only when every byte is statically
    // known. DYNAMIC repeat (count dictated by another field), value-driven
    // sizes (computedValue), any unknown size, or a complete presence gate
    // (emission decided by the ref field's run-time value) make it VAR. Note
    // the value shown is always the encoder-aligned one (E1-5: FIXED repeats
    // expand ×N; a DYNAMIC count only exists at run time and degrades to
    // unknown).
    const variable = hasUnknown || dynamicSized || dynamicRepeat || presenceGated;

    return { byId, total, exact: !hasUnknown, variable };
}

// Footer display: "@00" for plain blocks, "@00.." for groups (range marker),
// "··" when the start offset is unknowable (a preceding block has unknown size).
export function formatOffset(meta) {
    if (!meta || meta.offset === null || meta.offset === undefined) return '··';
    const hex = meta.offset.toString(16).toUpperCase().padStart(2, '0');
    return meta.isGroup ? `@${hex}..` : `@${hex}`;
}
