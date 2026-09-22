// P0-2: structural validation of an instruction working copy.
// Pure function — runs before save (blocking on errors) and renders the issue
// list in the properties panel (errors/warnings both locate to a block).
//
// Errors   → block the save (real structural problems).
// Warnings → never block (encoder-limit notices B2–B8, soft inconsistencies).
//
// Keep this tolerant: a false-positive error would lock users out of saving.
// When in doubt, make it a warning.

import { getBlockLimitRefs, ENCODER_LIMITS } from './encoderLimits';

const normalizeHex = (h) => String(h || '').replace(/\s/g, '');
const refList = (r) => (r === undefined || r === null ? [] : (Array.isArray(r) ? r : [r]));
const fieldLabel = (f) => f.name || f.label || '';
const isChecksumOp = (op) => String(op || '').toUpperCase().includes('CHECKSUM');

// Detect directed cycles among formula [Label] references (E5).
// - Tokens matching the field's OWN name are skipped (LHS declaration pattern
//   like "[Len] = ..." must NOT count as self-reference).
// - Unresolvable tokens are reported as warnings, not errors.
function findFormulaCycles(fields, nameToId, warnings) {
    const adj = new Map();
    fields.forEach((f) => {
        const formula = f.parameter_config?.formula;
        if (typeof formula !== 'string' || !formula.includes('[')) return;
        const targets = [];
        const names = [...formula.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
        names.forEach((n) => {
            const targetId = nameToId.get(n);
            if (targetId === undefined) {
                warnings.push({
                    blockId: f.id,
                    code: 'FORMULA_UNRESOLVED',
                    message: `公式中的 [${n}] 未匹配到任何字段（${fieldLabel(f) || f.id}）`,
                });
            } else if (targetId !== f.id) {
                targets.push(targetId);
            }
        });
        if (targets.length > 0) adj.set(f.id, targets);
    });

    // Iterative DFS with in-stack tracking.
    const IN_STACK = 1;
    const DONE = 2;
    const state = new Map();
    const errors = [];
    const reported = new Set();
    for (const start of adj.keys()) {
        if (state.get(start) === DONE) continue;
        const path = [];
        const onPath = new Set();
        const stack = [{ id: start, next: 0 }];
        state.set(start, IN_STACK);
        path.push(start);
        onPath.add(start);
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const neighbors = adj.get(frame.id) || [];
            if (frame.next >= neighbors.length) {
                stack.pop();
                state.set(frame.id, DONE);
                onPath.delete(frame.id);
                path.pop();
                continue;
            }
            const nxt = neighbors[frame.next++];
            if (onPath.has(nxt)) {
                const cycle = path.slice(path.indexOf(nxt)).concat(nxt);
                const key = [...cycle].sort().join('>');
                if (!reported.has(key)) {
                    reported.add(key);
                    const names = cycle.map((id) => {
                        const f = fields.find((x) => x.id === id);
                        return (f && fieldLabel(f)) || id;
                    });
                    errors.push({
                        blockId: nxt,
                        code: 'FORMULA_CYCLE',
                        message: `公式循环依赖：${names.join(' → ')}`,
                    });
                }
                continue;
            }
            if (state.get(nxt) === DONE) continue;
            state.set(nxt, IN_STACK);
            path.push(nxt);
            onPath.add(nxt);
            stack.push({ id: nxt, next: 0 });
        }
    }
    return errors;
}

export function validateInstruction(instruction) {
    const errors = [];
    const warnings = [];
    const fields = Array.isArray(instruction?.fields) ? instruction.fields : [];
    const byId = new Map(fields.map((f) => [f.id, f]));

    const nameToId = new Map();
    const seenNames = new Set();
    const seenSeq = new Map();

    fields.forEach((f) => {
        const label = fieldLabel(f);
        const params = f.parameter_config || {};
        const byteLen = Number(f.byte_len);

        // --- W0: encoder limits (B2–B8), display-only configs ---
        getBlockLimitRefs(f).forEach((ref) => {
            warnings.push({
                blockId: f.id,
                code: ref,
                message: `「${label || f.id}」${ref}: ${ENCODER_LIMITS[ref]}`,
            });
        });

        // --- W1: byte_len never set (groups are dynamic — skip) ---
        if (f.op_code !== 'ARRAY_GROUP' && f.op_code !== 'STRUCT'
            && (f.byte_len === undefined || f.byte_len === null)) {
            warnings.push({ blockId: f.id, code: 'BYTE_LEN_MISSING', message: `「${label || f.id}」字节长度未设置` });
        }

        // --- E1: HEX_RAW value must match byte_len exactly ---
        if (f.op_code === 'HEX_RAW') {
            const hex = normalizeHex(params.hex);
            if (hex && (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== (Number.isFinite(byteLen) ? byteLen : 1) * 2)) {
                errors.push({
                    blockId: f.id,
                    code: 'HEX_LENGTH',
                    message: `「${label || f.id}」HEX 长度与字节长度不符（需 ${(Number.isFinite(byteLen) ? byteLen : 1) * 2} 字符，实际 ${hex.length}）`,
                });
            } else if (!hex) {
                warnings.push({ blockId: f.id, code: 'HEX_EMPTY', message: `「${label || f.id}」HEX 值为空` });
            }
        }

        // --- E2: refs must point at existing fields ---
        refList(params.refs).forEach((rid) => {
            if (!byId.has(rid)) {
                errors.push({ blockId: f.id, code: 'REF_DANGLING', message: `「${label || f.id}」引用了不存在的字段 (${rid})` });
            }
        });

        // --- W3: LENGTH_CALC refs without formula (preview infers sum-of-refs) ---
        if (f.op_code === 'LENGTH_CALC'
            && (typeof params.formula !== 'string' || !params.formula.trim())
            && refList(params.refs).length > 0) {
            warnings.push({
                blockId: f.id,
                code: 'LENGTH_NO_FORMULA',
                message: `「${label || f.id}」未配置公式，预览按引用块求和显示；建议补全公式以明确计算方式`,
            });
        }

        // --- E3: field labels must be unique (formula [Label] resolution is global) ---
        if (label) {
            if (seenNames.has(label)) {
                errors.push({ blockId: f.id, code: 'LABEL_DUPLICATE', message: `字段标签重复「${label}」` });
            }
            seenNames.add(label);
            if (!nameToId.has(label)) nameToId.set(label, f.id);
        }

        // --- E4: BITFIELD overlap / capacity ---
        if (f.op_code === 'BITFIELD' && Array.isArray(f.bits) && f.bits.length > 0) {
            const totalBits = (Number.isFinite(byteLen) ? byteLen : 0) * 8;
            const sorted = f.bits
                .map((b) => ({
                    s: Number.isFinite(Number(b.start_bit)) ? Number(b.start_bit) : 0,
                    l: Math.max(1, Number.isFinite(Number(b.bit_len)) ? Number(b.bit_len) : 1),
                    n: b.name || '',
                }))
                .sort((a, b) => a.s - b.s);
            let prevEnd = -1;
            let overflow = false;
            sorted.forEach((b) => {
                if (b.s < prevEnd) {
                    errors.push({ blockId: f.id, code: 'BIT_OVERLAP', message: `「${label || f.id}」位域重叠（${b.n ? `${b.n} ` : ''}起始 ${b.s} < 上一块结束 ${prevEnd}）` });
                }
                prevEnd = Math.max(prevEnd, b.s + b.l);
                if (totalBits > 0 && b.s + b.l > totalBits) overflow = true;
            });
            if (overflow) {
                errors.push({ blockId: f.id, code: 'BIT_OVERFLOW', message: `「${label || f.id}」位域超出容量（${byteLen}B = ${totalBits} bits）` });
            }
        }

        // --- W2: duplicate sequence within the same parent ---
        const seqKey = `${f.parent_id ?? null}#${f.sequence}`;
        if (seenSeq.has(seqKey)) {
            warnings.push({ blockId: f.id, code: 'SEQ_DUPLICATE', message: `「${label || f.id}」同层序号重复 (${f.sequence})` });
        } else {
            seenSeq.set(seqKey, true);
        }
    });

    // --- E5: formula cycles (+ unresolved refs as warnings) ---
    errors.push(...findFormulaCycles(fields, nameToId, warnings));

    // --- E6: a root-lane checksum in first position covers zero bytes ---
    const rootFields = fields
        .filter((f) => (f.parent_id ?? null) === null)
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    if (rootFields.length > 0 && isChecksumOp(rootFields[0].op_code)) {
        errors.push({
            blockId: rootFields[0].id,
            code: 'CHECKSUM_EMPTY_COVERAGE',
            message: `校验块位于指令首位（${fieldLabel(rootFields[0]) || rootFields[0].id}），覆盖区为空`,
        });
    }

    return { errors, warnings };
}
