import { API_BASE, handleResponse } from './client';

// 批次一 1c (D4-A): POST /compile/wrapped —— 协议 + 已编码内核 hex 载荷走后端
// 唯一封装入口 build_wrapped（协议查库 / 洞位分配 / length·checksum refs 真值
// 重算），回 { hex_string, total_length, warnings }。
// 404 协议缺失、400 载荷/槽语义错误经 handleResponse 抛出（detail 中文透出）。
//
// CP3 3a (D13): 增 `recipeId` 分支 —— 配方**串行编译**（第 n 层输出喂第 n+1 层），
// 响应多 `recipe_id` 与 `stages[]` 分层回显（每层 hex / Δ / 该层 LEN·CRC 真值 /
// definition_hash 失效标记）。protocolId 与 recipeId **互斥**（后端 400），
// 单协议调用形态与字段逐字不变。
export const compileWrapped = async ({
    protocolId = null,
    recipeId = null,
    payloads,
    slotIds = null,
    startOrder = 0
}) => {
    const body = {
        payloads,
        start_order: startOrder
    };
    if (recipeId) {
        body.recipe_id = recipeId;   // 槽位归配方阶段所有 → 不带 slot_ids
    } else {
        body.protocol_id = protocolId;
        if (slotIds) body.slot_ids = slotIds;
    }
    const response = await fetch(`${API_BASE}/compile/wrapped`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return handleResponse(response);
};
