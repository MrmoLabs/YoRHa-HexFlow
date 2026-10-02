// Shared fetch helpers for all API modules.
// Configurable via VITE_API_BASE (see frontend/.env), falls back to local dev.

// 关键链路统一诊断（PLAN §8.32）：后端在错误响应里多给一份结构化 `diagnostic`
// （stage 失败层 / code 稳定机器码 / target 定位 / layer 封装层 / step 序列步 /
// data_sent 字节是否已发出）。`detail` 仍是原文，本模块只做**加法**：
// 挂到 `error.diagnostic` 供上层按需取用，并在消息前压一行摘要 —— 操作员在
// 任何显示 detail 的地方都能一眼看到「哪一层、第几步、发没发出去」。
const STAGE_LABELS = {
    plan: '序列计划',
    encode: '编码',
    escape: '转义',
    wrap: '封装',
    transport: '传输',
    match: '应答匹配',
    spec: '应答规格',
    sequence: '序列',
    param: '请求参数',
};

export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000';

export const formatApiErrorDetail = (detail) => {
    if (Array.isArray(detail)) {
        return detail.map(item => {
            const path = Array.isArray(item?.loc) ? item.loc.join('.') : 'body';
            const message = item?.msg || 'Invalid value';
            return `${path}: ${message}`;
        }).join('\n');
    }

    if (typeof detail === 'string') {
        return detail;
    }

    if (detail && typeof detail === 'object') {
        return JSON.stringify(detail);
    }

    return 'API request failed';
};

// diagnostic → 一行摘要（如「封装 · 第 2 层 · 未发送」）。缺字段就跳过，不硬凑。
export const formatDiagnostic = (diagnostic) => {
    if (!diagnostic || typeof diagnostic !== 'object') return '';
    const parts = [];
    if (diagnostic.stage) parts.push(STAGE_LABELS[diagnostic.stage] || diagnostic.stage);
    if (diagnostic.layer != null) parts.push(`第 ${diagnostic.layer} 层`);
    if (diagnostic.step != null) parts.push(`第 ${diagnostic.step} 步`);
    if (diagnostic.target) parts.push(`定位 ${diagnostic.target}`);
    if (diagnostic.data_sent != null) parts.push(diagnostic.data_sent ? '已发送' : '未发送');
    if (diagnostic.code) parts.push(diagnostic.code);
    return parts.join(' · ');
};

export const handleResponse = async (response) => {
    const data = await response.json();
    if (!response.ok) {
        const error = new Error(formatApiErrorDetail(data.detail));
        error.response = {
            status: response.status,
            data: data
        };
        if (data.diagnostic) {
            error.diagnostic = data.diagnostic;
            const summary = formatDiagnostic(data.diagnostic);
            if (summary) error.message = `[${summary}] ${error.message}`;
        }
        throw error;
    }
    return data;
};
