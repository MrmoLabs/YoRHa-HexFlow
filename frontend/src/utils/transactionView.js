// P2 事务发送视图模型（纯函数 + 单测）：attempt/统计文案、忽略区间文本互转、缺省规格。
// defaultSpec 与 backend/core/response_match.py 的 default_spec() 输出保持同形。

export const DEFAULT_SPEC = Object.freeze({
    mode: 'echo',
    prefix: '',
    suffix: '',
    echo_header_bytes: 0,
    length: null,
    checksum: null,
    ignore_ranges: []
});

export function defaultSpec() {
    return { ...DEFAULT_SPEC, ignore_ranges: [] };
}

const ATTEMPT_LABELS = {
    OK: 'OK',
    NO_RESPONSE: 'NO_RESPONSE',
    MATCH_FAILED: 'MATCH_FAILED',
    TRANSPORT_ERROR: 'TRANSPORT_ERROR'
};

export function attemptLabel(status) {
    return ATTEMPT_LABELS[status] || String(status || 'UNKNOWN');
}

export function rttText(ms) {
    if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '—';
    return `${Number(ms).toFixed(1)} ms`;
}

export function summaryLine(record) {
    if (!record) return '';
    const attempts = record.stats?.attempts ?? record.attempts?.length ?? 0;
    const head = record.status === 'OK' ? 'TXN_OK' : 'TXN_FAILED';
    const tail = record.broadcast
        ? 'BROADCAST'
        : `RTT ${rttText(record.stats?.rtt_ms_last)}`;
    return `${head} · ${attempts} ATTEMPT${attempts === 1 ? '' : 'S'} · ${tail}`;
}

export function specSourceLabel(source) {
    if (source === 'inline') return 'INLINE';
    if (source === 'instruction') return 'SAVED';
    if (source === 'none') return 'BROADCAST';
    return 'DEFAULT';
}

// "4-6,10-12" → [[4,6],[10,12]]；空串 → []；非法（非两元素区间/重叠/越界）→ null。
// null 表示调用方应保留旧 spec 并提示格式（不落库半截状态）。
export function parseIgnoreRanges(text) {
    const cleaned = String(text ?? '').trim();
    if (!cleaned) return [];
    const ranges = [];
    for (const part of cleaned.split(',')) {
        const piece = part.trim();
        if (!piece) return null;
        const match = piece.match(/^(\d+)\s*-\s*(\d+)$/);
        if (!match) return null;
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
        if (start >= end || end > 8192) return null;
        ranges.push([start, end]);
    }
    if (ranges.length > 32) return null;
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) {
        if (ranges[i][0] < ranges[i - 1][1]) return null;
    }
    return ranges;
}

export function formatIgnoreRanges(ranges) {
    if (!Array.isArray(ranges)) return '';
    return ranges.map(([start, end]) => `${start}-${end}`).join(',');
}
