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

// CP3 3d (D5-A): 协议页「据此生成」—— 候选指令清单 + 按分层链生成并落库。
// getResponseSpecTargets 的 protocol_id 可省（= 全量可解析指令，uses_protocol 恒 false）；
// generateResponseSpec 成功回 {id, spec, stage, definition_hash, stale, layers, warnings}
// （warnings 是降级说明不是错误，规格已保存）；400 = 无默认配方且无默认协议。
export const getResponseSpecTargets = async (protocolId) => {
    const url = protocolId
        ? `${API_BASE}/response-specs/targets?protocol_id=${encodeURIComponent(protocolId)}`
        : `${API_BASE}/response-specs/targets`;
    const response = await fetch(url);
    return handleResponse(response);
};

export const generateResponseSpec = async (instructionId) => {
    const response = await fetch(`${API_BASE}/response-specs/${encodeURIComponent(instructionId)}/generate`, {
        method: 'POST'
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
