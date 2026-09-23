import { API_BASE, handleResponse } from './client';

// P2 应答规格 + 事务发送（后端新表 response_specs + POST /dispatch/transaction）。
// getResponseSpec 404 = 该指令尚未配置规格 → 调用方降级本地 defaultSpec（error.response.status 可判）。

export const getResponseSpec = async (instructionId) => {
    const response = await fetch(`${API_BASE}/response-specs/${encodeURIComponent(instructionId)}`);
    return handleResponse(response);
};

export const saveResponseSpec = async (instructionId, spec) => {
    const response = await fetch(`${API_BASE}/response-specs/${encodeURIComponent(instructionId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec })
    });
    return handleResponse(response);
};

export const deleteResponseSpec = async (instructionId) => {
    const response = await fetch(`${API_BASE}/response-specs/${encodeURIComponent(instructionId)}`, {
        method: 'DELETE'
    });
    return handleResponse(response);
};

// 事务发送：超时/重试/间隔由 body 控制，响应恒为完整事务记录（含逐次 attempt 与统计）。
export const sendTransaction = async (payload) => {
    const response = await fetch(`${API_BASE}/dispatch/transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return handleResponse(response);
};
