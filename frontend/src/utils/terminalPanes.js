// E3 通讯调试页的纯函数视图模型：把 /dispatch 记录（raw/response/error 三类
// 事件）拆给三面板，并提供 hex 格式化与发送输入校验。
// 后端口径见 backend/routers/dispatch.py；改一须核对另一端。
// R9（PLAN §8.46 · §8.37 R9 行）：响应帧按指令字段布局**逆向解码**成
// 「字段 = 值」（C-2 选 B 前半 · 展示层）。
// R10（PLAN §8.48 · §8.37 R10 行 · C-2 选 C 后半）：**入库回写** —— 后端在写
// 日志那一刻已把同一份解码结果挂在 `record.fields`（与 `dispatch_logs.fields_json`
// 同源），本文件**优先消费它**；拿不到（存量行 / 后端解不出）才回落 R9 客户端解码。

import { InstructionDecoder, fieldsText } from './InstructionDecoder';

const splitBytes = (hexString) => String(hexString || '').trim().split(/\s+/).filter(Boolean);

export const findEvent = (record, type) =>
    (record?.events || []).find((event) => event.type === type) || null;

// 原始报文：优先 raw 事件，缺 events 时回落记录级 hex_string（兼容旧记录）。
export const rawHexOf = (record) =>
    findEvent(record, 'raw')?.hex_string ?? record?.hex_string ?? '';

// 响应：仅成功记录带 response 事件；无则空串（错误记录由 errorMessageOf 解释）。
export const responseHexOf = (record) => findEvent(record, 'response')?.hex_string ?? '';

export const errorMessageOf = (record) => findEvent(record, 'error')?.message ?? null;

// 8 字节一行的 hex dump（行数组，便于断言与渲染）。
export const hexDump = (hexString) => {
    const bytes = splitBytes(hexString);
    const lines = [];
    for (let i = 0; i < bytes.length; i += 8) {
        lines.push(bytes.slice(i, i + 8).join(' '));
    }
    return lines;
};

// 表格预览：超过 maxBytes 字节截断并标注剩余数量。
export const hexPreview = (hexString, maxBytes = 10) => {
    const bytes = splitBytes(hexString);
    if (bytes.length <= maxBytes) return bytes.join(' ');
    return `${bytes.slice(0, maxBytes).join(' ')} …+${bytes.length - maxBytes}`;
};

// 发送历史表格行视图。时间戳取 UTC ISO 的前 19 位（秒精度）。
//
// R9：给了 `ctx.instructionsByName`（`instruction_name` → 指令，含 fields）就把
// **响应帧**按该指令的字段布局解成 `字段 = 值`。解不出（无指令名 / 指令已删 /
// 无响应 / 布局解出 0 字段）→ **不加键**，行形状对不传 ctx 的旧调用逐字不变。
// 解码只吃「响应」而非「发送帧」—— 值在应答里，raw hex 列仍显示发送帧。
//
// R10：**先吃 `record.fields`** —— 后端 `db/log_store.resolve_log_fields` 在写日志
// 那一刻解好、与 `dispatch_logs.fields_json` 是同一次解码。它比客户端解码强在两处：
//   ① 指令后来被删/改也解得出（值随日志留痕，不依赖当前 /instructions 还在不在）；
//   ② 序列路跑在 daemon 线程里，客户端那时没有那条上下文。
// 空壳（0 字段且 0 警告 = 后端也没解出来）→ 当它不存在，继续走 R9 客户端解码。
export const decodeHistoryRow = (record, instructionsByName) => {
    const served = record?.fields;
    if (served && ((served.fields?.length || 0) || (served.warnings?.length || 0))) {
        return served;
    }
    if (!instructionsByName || !record?.instruction_name) return null;
    const instruction = instructionsByName[record.instruction_name];
    // 无字段布局 → 没东西可解（空布局只会生出「尾部残字节」假警报，不出）
    if (!instruction || !Array.isArray(instruction.fields) || instruction.fields.length === 0) return null;
    const hex = responseHexOf(record);
    if (!hex) return null;
    const decoded = InstructionDecoder.decodeInstruction(instruction, hex, {});
    return decoded.fields.length || decoded.warnings.length ? decoded : null;
};

export const historyRows = (records = [], ctx = {}) => (records || []).map((record) => {
    const decoded = decodeHistoryRow(record, ctx.instructionsByName);
    return {
        id: record.id,
        time: String(record.timestamp || '').replace('T', ' ').slice(0, 19) || '—',
        channel: record.channel || '—',
        status: record.status || '—',
        byteCount: record.byte_count ?? 0,
        hexPreview: hexPreview(record.hex_string),
        name: record.instruction_name || '—',
        isError: record.status === 'ERROR',
        ...(decoded ? { decoded, fieldsText: fieldsText(decoded) } : {})
    };
});

// 发送输入校验：与后端 hex_to_bytes 同款清洗（空格/下划线/逗号/连字符），
// 非 hex 或奇数位 → invalid（发送按钮禁用）。
export const hexInputInfo = (text) => {
    const cleaned = String(text || '').replace(/[\s,_-]/g, '');
    if (!cleaned) return { valid: false, byteCount: 0, cleaned: '' };
    if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
        return { valid: false, byteCount: 0, cleaned };
    }
    return { valid: true, byteCount: cleaned.length / 2, cleaned };
};
