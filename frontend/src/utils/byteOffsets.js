// P1: byte-offset ruler for the instruction editor (see PLAN_InstructionManagement.md §3).
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
// (repeat_ref_id), value-driven sizes (computedValue fallback), or any unknown
// size — the UI then labels the header VAR (with "~" while still computable);
// otherwise it labels FIXED. Sizes always mirror the encoder's real output
// (E1-5: FIXED repeats expand N copies — a DYNAMIC repeat's count only exists
// at run time, so its group degrades to an unknown size instead of lying).

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

export function computeByteOffsets(instruction) {
    const fields = Array.isArray(instruction?.fields) ? instruction.fields : [];

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

    // Size resolution (memoized; cache-seed guards against parent cycles).
    const sizeCache = new Map();
    let dynamicSized = false; // any leaf sized from value-driven computedValue
    const resolveSize = (f) => {
        if (sizeCache.has(f.id)) return sizeCache.get(f.id);
        sizeCache.set(f.id, null);
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
            const n = Number(f.byte_len ?? f.byte_length);
            if (Number.isFinite(n) && n > 0) {
                size = n;
            } else {
                size = hexByteCount(f.parameter_config?.computedValue);
                if (size !== null) dynamicSized = true; // length derived from the current value
            }
        }
        sizeCache.set(f.id, size);
        return size;
    };

    const byId = new Map();
    let cursor = 0;   // null once an unknown-size block has been passed
    let hasUnknown = false;
    let dynamicRepeat = false; // DYNAMIC repeat / repeat_ref_id → count varies per run

    const walk = (list) => {
        list.forEach((f) => {
            const kids = kidsOf.get(f.id) || [];
            const size = resolveSize(f);
            const isGroup = kids.length > 0 || isGroupOp(f);
            byId.set(f.id, { offset: cursor, size, isGroup });
            if (hasDynamicRepeat(f)) dynamicRepeat = true;
            if (kids.length > 0) {
                const start = cursor;
                walk(kids); // children of copy #1 advance the cursor by Σ×1
                // E1-5: land the cursor on the group's true end (Σ×N) — the
                // children walk only covers the first copy.
                if (cursor !== null && start !== null && size !== null) cursor = start + size;
            } else if (size !== null && cursor !== null) {
                cursor += size;
            }
            if (size === null) {
                hasUnknown = true;
                cursor = null;
            }
        });
    };
    walk(kidsOf.get(null) || []);

    let total = 0;
    (kidsOf.get(null) || []).forEach((f) => {
        const s = resolveSize(f);
        if (s !== null) total += s;
    });

    // Fixed vs variable: a frame is FIXED only when every byte is statically
    // known. DYNAMIC repeat (count dictated by another field), value-driven
    // sizes (computedValue), or any unknown size make it VAR. Note the value
    // shown is always the encoder-aligned one (E1-5: FIXED repeats expand ×N;
    // a DYNAMIC count only exists at run time and degrades to unknown).
    const variable = hasUnknown || dynamicSized || dynamicRepeat;

    return { byId, total, exact: !hasUnknown, variable };
}

// Footer display: "@00" for plain blocks, "@00.." for groups (range marker),
// "··" when the start offset is unknowable (a preceding block has unknown size).
export function formatOffset(meta) {
    if (!meta || meta.offset === null || meta.offset === undefined) return '··';
    const hex = meta.offset.toString(16).toUpperCase().padStart(2, '0');
    return meta.isGroup ? `@${hex}..` : `@${hex}`;
}
