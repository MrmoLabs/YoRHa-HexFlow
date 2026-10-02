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
import { padSpec } from './padSpec';
import { OP_CODES } from '../constants';

// N1 护栏批（PLAN §8.16 · G5）：编码器已知算子全集 = OP_CODES 15 项（含 N2 的
// STRING）+ encoder legacy 5 项（INPUT/FIXED/HEADER/TAIL/CALCULATED——encoder
// 各分支仍认识、存量数据可能携带）。全集外的 op_code 落 getFieldBytes 默认整数
// 路径静默出错。
// G5 收口（双端硬拦拍板 2026-09-30）：W5 从 warnings 升 errors —— 保存阻断，
// 与 BE 保存侧 400（routers/instruction.py KNOWN_OPS）同口径逐行同步，改一必改二。
const KNOWN_OPS = new Set([
    ...Object.values(OP_CODES),
    'INPUT', 'FIXED', 'HEADER', 'TAIL', 'CALCULATED',
]);

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

        // --- W4 (G7 收口 · R5): FLOAT_IEEE 位宽闸 —— 4=float32 / 8=float64 双端
        // 已支持（§8.42），其余宽度仍落「FE 走整数路径、BE 保持 zeros」的两端不一致，
        // 配出即提醒。模板默认仍是 32（test_operator_templates 钉死），陷阱入口是手改
        // byte_len —— R5 之前 8 也报（FLOAT64_UNSUPPORTED），现改成只报真不支持的宽度。 ---
        if (f.op_code === 'FLOAT_IEEE'
            && f.byte_len !== undefined && f.byte_len !== null
            && Number.isFinite(Number(f.byte_len))
            && ![4, 8].includes(Number(f.byte_len))) {
            warnings.push({
                blockId: f.id,
                code: 'FLOAT_IEEE_WIDTH_UNSUPPORTED',
                message: `「${label || f.id}」FLOAT_IEEE 位宽 ${f.byte_len}B 不在支持范围（4=float32 / 8=float64）：前端按整数路径输出、后端保持 zeros（两端不一致）——请改 4/8 位或 HEX_RAW`,
            });
        }

        // --- W5→E (G5 收口 · 双端硬拦拍板 2026-09-30): 未知算子——编码落默认
        // 整数路径静默出错（错码）。FE 保存阻断 + BE 保存侧 400 同口径；大小写
        // 不匹配同样拦（小写 op 在 FE 编码即落错路径），空 op fail-open 不拦。 ---
        if (f.op_code && !KNOWN_OPS.has(String(f.op_code))) {
            errors.push({
                blockId: f.id,
                code: 'OP_UNKNOWN',
                message: `「${label || f.id}」未知算子（${f.op_code}）：不在已知算子全集（OP_CODES + encoder legacy）——编码将按默认整数路径静默输出，保存已阻止：请核对算子模板或清洗导入数据`,
            });
        }

        // --- W6 (N2·G2): 文本字段静态值含 >0xFF 字符且 encoding≠utf8 → ascii
        // 模式按 code point &0xFF 截断出脏字节（乱码），utf8 模式才是正解。 ---
        if ((String(f.op_code) === 'STRING' || String(params.type) === 'string')
            && String(params.encoding ?? 'ascii').toLowerCase() !== 'utf8') {
            const text = [params.value, params.default]
                .filter((v) => typeof v === 'string').join('');
            // 非 Latin-1（含 NUL）→ 越界告警。正则里 \u0000 是**故意**写的控制字符，
            // 换成等价写法反而不直观，故定点放行本行。
            // eslint-disable-next-line no-control-regex
            if (/[^\u0000-\u00FF]/.test(text)) {
                warnings.push({
                    blockId: f.id,
                    code: 'STRING_NON_ASCII',
                    message: `「${label || f.id}」文本字段含非 ASCII 字符（>0xFF）且未启用 utf8 编码：编码期将截断出乱码字节——请切换 encoding=utf8 或改用纯 ASCII 文本`,
                });
            }
        }

        // --- W8/W9 (N5·G4): align/pad_to 非法 → 编码期 fail-open 忽略（不阻断
        // 出帧）→ 提醒修正。判定与 utils/padSpec.js padSpec 同口径：present 且
        // 归一后为 0 才提醒（空串视为未配置）；pad_byte 非法静默回落 0x00
        // （N2 pad_char 先例，不提醒）。任何 pad 配置都不产生 error。
        const padNorm = padSpec(params);
        if (params.align !== undefined && params.align !== null
            && String(params.align).trim() !== '' && padNorm.align === 0) {
            warnings.push({
                blockId: f.id,
                code: 'ALIGN_INVALID',
                message: `「${label || f.id}」对齐值无效（align=${params.align}）：编码期将忽略不补位——请填 1..4096 的整数字节数`,
            });
        }
        if (params.pad_to !== undefined && params.pad_to !== null
            && String(params.pad_to).trim() !== '' && padNorm.padTo === 0) {
            warnings.push({
                blockId: f.id,
                code: 'PAD_TO_INVALID',
                message: `「${label || f.id}」补位值无效（pad_to=${params.pad_to}）：编码期将忽略不补位——请填 1..4096 的整数字节数`,
            });
        }

        // --- W7 (N3·G1): presence 条件存在 —— E 自引用 / W 悬空 / W 不完整 ---
        // fail-open 语义（配置不完整/悬空时编码按命中处理，不吞字节）→ 只提醒
        // 不阻断；自引用是明确配置错误（判定链对自身无意义形态）→ error。
        const pres = params.presence;
        if (pres !== undefined && pres !== null) {
            const isObj = typeof pres === 'object' && !Array.isArray(pres);
            const hasRef = isObj && pres.ref_id !== undefined && pres.ref_id !== null && String(pres.ref_id) !== '';
            const hasExpect = isObj && pres.expect !== undefined && pres.expect !== null && String(pres.expect) !== '';
            if (!isObj || !hasRef || !hasExpect) {
                warnings.push({
                    blockId: f.id,
                    code: 'PRESENCE_INCOMPLETE',
                    message: `「${label || f.id}」条件存在（presence）配置不完整（${!isObj ? '非对象' : !hasRef ? '缺 ref_id' : '缺 expect'}）：编码将按命中处理（fail-open）——请补全或清除`,
                });
            }
            if (hasRef && String(pres.ref_id) === String(f.id)) {
                errors.push({ blockId: f.id, code: 'PRESENCE_SELF', message: `「${label || f.id}」条件存在引用了自身（presence 自引用）` });
            } else if (hasRef && !byId.has(pres.ref_id)) {
                warnings.push({ blockId: f.id, code: 'PRESENCE_REF_MISSING', message: `「${label || f.id}」条件存在引用了不存在的字段 (${pres.ref_id})：编码将按命中处理（fail-open）——请核对引用` });
            }
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

    // --- W8 (N3·G1): 同 ref 同 expect 的多支并存（条件完全相同 → 建议合并） ---
    const seenPresence = new Map(); // `${ref}#${expect}` → 首见字段标签
    fields.forEach((f) => {
        const pres = f.parameter_config?.presence;
        if (!pres || typeof pres !== 'object' || Array.isArray(pres)) return;
        const ref = pres.ref_id;
        const exp = pres.expect;
        if (ref === undefined || ref === null || String(ref) === '') return;
        if (exp === undefined || exp === null || String(exp) === '') return;
        const key = `${ref}#${String(exp)}`;
        const first = seenPresence.get(key);
        if (first !== undefined) {
            warnings.push({
                blockId: f.id,
                code: 'PRESENCE_OVERLAP',
                message: `「${fieldLabel(f) || f.id}」与「${first}」条件相同（[${ref}] == ${exp} 多支并存）：完全相同的分支建议合并或删除`,
            });
        } else {
            seenPresence.set(key, fieldLabel(f) || f.id);
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
