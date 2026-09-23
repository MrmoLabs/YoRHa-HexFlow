// Phase 3 (P3-2): JSON import of instructions — pure functions only.
// （导出功能已按人工反馈移除，2026-09-22：只需要导入能力。）
// 批次四: 追加 analyzeProtocolImport（协议侧对称，report 无 conflicts ——
// 后端不校验协议 label 唯一，撞名在 buildImportedProtocolPayload 内升序
// 「(导入)」承接，永不覆盖：全部 POST 落新行）。
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
import { validateProtocol } from './validateProtocol';
import { normalizeInstructionPayload } from './normalizeInstruction';
import { cloneFieldsForNewInstruction } from './duplicateInstruction';
import { buildImportedProtocolPayload } from './protocolTree';

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

/**
 * 批次四 P3-2: 协议 JSON 导入分流（镜像 analyzeImport 的 report 形态，
 * 无 conflicts —— 协议 label 不唯一，撞名由负载构造器升序承接）。
 * - 接受裸数组 / {protocols:[…]} 包装（与导出 {schemaVersion, protocols} 对称）；
 * - 结构门槛：children 数组 + 逐节点 id（克隆发号按 id 建 Map）；
 * - validateProtocol errors → 拒（warnings 不拦，与保存闸同口径）；
 * - 通过者 → buildImportedProtocolPayload（全树新 id + refs 自含重映射 +
 *   白名单净化 + 撞名「(导入)」升序；同文件后续条目经 [...existing, ...payloads]
 *   参与撞名，文件内重名同样升序）。
 *
 * @param {unknown} raw parsed JSON (array or {protocols: []})
 * @param {Array} existingProtocols loaded list for label disambiguation
 * @param {() => string} genId id mint (injectable for tests)
 * @returns {{total:number, payloads:Array, errors:Array}}
 */
export function analyzeProtocolImport(raw, existingProtocols = [], genId = uuidv4) {
    const report = { total: 0, payloads: [], errors: [] };
    const list = Array.isArray(raw)
        ? raw
        : (raw && Array.isArray(raw.protocols) ? raw.protocols : null);
    if (!list) {
        report.errors.push({ name: '(文件)', messages: ['结构无效：缺少 protocols 数组'] });
        return report;
    }
    report.total = list.length;

    const collect = (nodes, out) => {
        (nodes || []).forEach(n => {
            if (n && typeof n === 'object') out.push(n);
            collect(n?.children, out);
        });
    };

    list.forEach((proto) => {
        const label = String(proto?.label || '(未命名)');
        if (!proto || typeof proto !== 'object' || !Array.isArray(proto.children)) {
            report.errors.push({ name: label, messages: ['结构无效：缺少 children 数组'] });
            return;
        }
        const nodes = [];
        collect(proto.children, nodes);
        if (nodes.some(n => typeof n.id !== 'string' || !n.id)) {
            report.errors.push({ name: label, messages: ['结构无效：节点缺少 id'] });
            return;
        }
        const { errors } = validateProtocol(proto);
        if (errors.length > 0) {
            report.errors.push({ name: label, messages: errors.map(fmtIssue) });
            return;
        }
        report.payloads.push(
            buildImportedProtocolPayload(proto, [...existingProtocols, ...report.payloads], genId)
        );
    });

    return report;
}
