// Phase 3 (P3-2): JSON import of instructions — pure functions only.
// （导出功能已按人工反馈移除，2026-09-22：只需要导入能力。）
// - Accepts a bare array or an {instructions:[…]} wrapper（兼容外部包文件，
//   例如带 schemaVersion 的历史导出格式）。
// - Splits into
//     payloads  — valid & free (POST-ready)
//     conflicts — backend enforces unique name AND code (existing rows or
//                 earlier entries in the same file) → SKIPPED, never overwritten
//     errors    — structural problems from validateInstruction
//   Payloads get FRESH field ids: the backend keeps payload field ids as-is,
//   so reusing source ids would collide with the source rows' primary keys.
import { v4 as uuidv4 } from 'uuid';
import { validateInstruction } from './validateInstruction';
import { normalizeInstructionPayload } from './normalizeInstruction';
import { cloneFieldsForNewInstruction } from './duplicateInstruction';

const fmtIssue = (e) => `[${e.code}] ${e.message}`;

/**
 * @param {unknown} raw parsed JSON (array or {instructions: []})
 * @param {Array} existingInstructions loaded list for conflict detection
 * @param {() => string} genId id mint (injectable for tests)
 * @returns {{total:number, payloads:Array, conflicts:Array, errors:Array}}
 */
export function analyzeImport(raw, existingInstructions = [], genId = uuidv4) {
    const report = { total: 0, payloads: [], conflicts: [], errors: [] };
    const list = Array.isArray(raw)
        ? raw
        : (raw && Array.isArray(raw.instructions) ? raw.instructions : null);
    if (!list) {
        report.errors.push({ name: '(文件)', messages: ['结构无效：缺少 instructions 数组'] });
        return report;
    }
    report.total = list.length;

    const names = new Set(existingInstructions.map(i => String(i.name || '').trim()));
    const codes = new Set(existingInstructions.map(i => String(i.code || '').trim()));

    list.forEach((inst) => {
        const label = String(inst?.name || inst?.code || '(未命名)');
        if (!inst || typeof inst !== 'object' || !Array.isArray(inst.fields)) {
            report.errors.push({ name: label, messages: ['结构无效：缺少 fields 数组'] });
            return;
        }
        const name = String(inst.name ?? '').trim();
        const code = String(inst.code ?? '').trim();
        if (!name || !code) {
            report.conflicts.push({ name: label, code, reason: '名称或代号为空' });
            return;
        }
        if (names.has(name) || codes.has(code)) {
            report.conflicts.push({ name, code, reason: names.has(name) ? '名称重复' : '代号重复' });
            return;
        }

        const { errors } = validateInstruction(inst);
        if (errors.length > 0) {
            report.errors.push({ name, messages: errors.map(fmtIssue) });
            return;
        }

        const payload = normalizeInstructionPayload(inst);
        payload.fields = cloneFieldsForNewInstruction(payload.fields, genId);
        // consumed — a second occurrence inside the SAME file is a conflict too
        names.add(name);
        codes.add(code);
        report.payloads.push(payload);
    });

    return report;
}
