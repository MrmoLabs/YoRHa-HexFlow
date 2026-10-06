// R38（PLAN §8.70）：发前路由规则 API —— 与 `backend/routers/routing.py`
// 的 `prefix="/routing-rules"` 五方法逐字对齐。
//
// 本模块只做**线缆**：地址、动词、请求体原样送达，错误 detail 由
// `handleResponse` 原文抛出。规则的判定口径（first-match-wins / 停用与回收站
// 行不参与 / 坏条件记 invalid / 无命中不猜）全在后端 `core/routing.py`，
// FE 再兜第二套必然分叉 —— 所以这里连「哪些行参与匹配」都不重算。
//
// 无尾斜杠（FastAPI 对 `/routing-rules` 与 `/routing-rules/` 不等价，走前者）。
import { API_BASE, handleResponse } from './client';

const ROOT = `${API_BASE}/routing-rules`;

const one = (id) => `${ROOT}/${encodeURIComponent(id)}`;

// PUT 是**整体替换**（后端 RoutingRuleCreate 无部分更新语义）——
// 请求体恒为完整六字段，别改成只发改动项。
const jsonBody = (payload) => ({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
});

// GET /routing-rules → RoutingRuleResponse[]（已 alive 过，(sort_order, name, id) 定序）
export const listRoutingRules = async () => handleResponse(await fetch(ROOT));

// GET /routing-rules/{id}
export const getRoutingRule = async (id) => handleResponse(await fetch(one(id)));

// POST /routing-rules —— 新建。sort_order 由调用方给（缺省落末尾，见 routingView）
export const createRoutingRule = async (payload) =>
    handleResponse(await fetch(ROOT, { method: 'POST', ...jsonBody(payload) }));

// PUT /routing-rules/{id}
export const updateRoutingRule = async (id, payload) =>
    handleResponse(await fetch(one(id), { method: 'PUT', ...jsonBody(payload) }));

// DELETE /routing-rules/{id} —— 软删进回收站（kind = routing_rule），不带请求体
export const deleteRoutingRule = async (id) =>
    handleResponse(await fetch(one(id), { method: 'DELETE' }));
