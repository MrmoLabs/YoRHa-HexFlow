import { API_BASE, handleResponse } from './client';

// Dispatch via backend transport abstraction (loopback default / tcp / serial; bounded send history).
// 批次一 1c: 可选 wrap —— hexString 视作已编码内核载荷（单条），后端套协议外壳；
// wrap 缺省 → 裸帧路径与既有行为逐字节一致（§0 硬约束）。
export const dispatchPayload = async (hexString, instructionName = null, wrap = null) => {
    const response = await fetch(`${API_BASE}/dispatch/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            hex_string: hexString,
            instruction_name: instructionName,
            ...(wrap ? { wrap } : {})
        })
    });
    return handleResponse(response);
};

export const getDispatchHistory = async (limit = 50) => {
    const response = await fetch(`${API_BASE}/dispatch/history?limit=${limit}`);
    return handleResponse(response);
};

export const clearDispatchHistory = async () => {
    const response = await fetch(`${API_BASE}/dispatch/history`, { method: 'DELETE' });
    return handleResponse(response);
};
