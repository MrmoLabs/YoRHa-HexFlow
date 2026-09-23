// E3 通讯调试页的纯函数视图模型：把 /dispatch 记录（raw/response/error 三类
// 事件）拆给三面板，并提供 hex 格式化与发送输入校验。
// 后端口径见 backend/routers/dispatch.py；改一须核对另一端。

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
export const historyRows = (records = []) => (records || []).map((record) => ({
    id: record.id,
    time: String(record.timestamp || '').replace('T', ' ').slice(0, 19) || '—',
    channel: record.channel || '—',
    status: record.status || '—',
    byteCount: record.byte_count ?? 0,
    hexPreview: hexPreview(record.hex_string),
    name: record.instruction_name || '—',
    isError: record.status === 'ERROR'
}));

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
