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
// CP3 3b (D13): 可走配方 —— recipeId 优先出 `wrap.recipe_id`（后端逐层串行套壳）；
// 配方路径**不下发 slot_ids/start_order**（槽位与层序归配方阶段所有，§9.1/recipe_compile）。
export const dispatchWrappedGroup = async ({ recipeId = null, protocolId, payloads, slotIds = null, startOrder = 0, instructionName = null }) => {
    const response = await fetch(`${API_BASE}/dispatch/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            instruction_name: instructionName,
            // 不给 hex_string：与 wrap.payloads 二选一（后端缺省 None → 400 兜底）
            wrap: recipeId
                ? { recipe_id: recipeId, payloads }
                : {
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

// R39（PLAN §8.71）：发前路由解析 —— **只解析不发送**。
// POST /dispatch/routed 与缺省 /dispatch/ 是两个端点：前者回执 RouteResolveResponse
// （matched / rule / instruction / invalid / considered），**没有** status / attempts /
// hex_string，也不产生任何 DispatchRecord（§0 硬约束：/dispatch 缺省口径逐字节不变）。
// inputs 是**扁平字符串键值表**，与 evaluate_condition 的变量表同形。
export const resolveRoute = async (inputs = {}) => {
    const response = await fetch(`${API_BASE}/dispatch/routed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs })
    });
    return handleResponse(response);
};
