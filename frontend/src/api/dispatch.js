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

// 批次二 (D14③ 转义层位统一): 编排页「封装试发」多载荷组 —— 一组 N 条内核
// hex 直接带 wrap 下发，后端**逐条转义内核 → 再套壳**（与单条 wrap 同层位）。
// 此前是先 /compile/wrapped 套完壳再裸发，escape 开启时会把整帧当内核转义。
// 返回 DispatchRecord：hex_string = 实际出线帧，warnings = 溢出/欠载告警。
export const dispatchWrappedGroup = async ({ protocolId, payloads, slotIds = null, startOrder = 0, instructionName = null }) => {
    const response = await fetch(`${API_BASE}/dispatch/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            instruction_name: instructionName,
            // 不给 hex_string：与 wrap.payloads 二选一（后端缺省 None → 400 兜底）
            wrap: {
                protocol_id: protocolId,
                payloads,
                ...(slotIds ? { slot_ids: slotIds } : {}),
                start_order: startOrder
            }
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
