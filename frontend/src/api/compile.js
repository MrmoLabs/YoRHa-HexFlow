import { API_BASE, handleResponse } from './client';

// 批次一 1c (D4-A): POST /compile/wrapped —— 协议 + 已编码内核 hex 载荷走后端
// 唯一封装入口 build_wrapped（协议查库 / 洞位分配 / length·checksum refs 真值
// 重算），回 { hex_string, total_length, warnings }。
// 404 协议缺失、400 载荷/槽语义错误经 handleResponse 抛出（detail 中文透出）。
export const compileWrapped = async ({ protocolId, payloads, slotIds = null, startOrder = 0 }) => {
    const body = {
        protocol_id: protocolId,
        payloads,
        start_order: startOrder
    };
    if (slotIds) body.slot_ids = slotIds;
    const response = await fetch(`${API_BASE}/compile/wrapped`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return handleResponse(response);
};
