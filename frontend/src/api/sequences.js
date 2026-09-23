import { API_BASE, handleResponse } from './client';

// P3/P4 序列编排（后端新表 sequences/sequence_steps + 单槽后台 Runner）。
// 形状契约见 backend/schemas/sequence_api.py；/status 与 /stop 注册在
// /{sequence_id} 之前；start 失败码 404 缺失 / 400 无步骤或脏数据 / 409 忙；
// 序列运行期 /dispatch、/dispatch/transaction 也会 409（互斥，routers/dispatch.py）。

export const listSequences = async () => {
    const response = await fetch(`${API_BASE}/sequences`);
    return handleResponse(response);
};

export const getSequence = async (id) => {
    const response = await fetch(`${API_BASE}/sequences/${encodeURIComponent(id)}`);
    return handleResponse(response);
};

// body = { name, description, config, steps }；config/步骤校验失败 → 400（detail 含 steps[i] 定位）。
export const createSequence = async (body) => {
    const response = await fetch(`${API_BASE}/sequences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return handleResponse(response);
};

// PUT 整体替换（后端按数组序重编 step_order，旧步骤行删净）。
export const updateSequence = async (id, body) => {
    const response = await fetch(`${API_BASE}/sequences/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return handleResponse(response);
};

// DELETE 成功 = 204 无响应体（handleResponse 会因空体 json 解析失败 → 先判状态码）；
// 二次删除 404 抛错由调用方兜。
export const deleteSequence = async (id) => {
    const response = await fetch(`${API_BASE}/sequences/${encodeURIComponent(id)}`, {
        method: 'DELETE'
    });
    if (response.status === 204) return null;
    return handleResponse(response);
};

export const startSequence = async (id) => {
    const response = await fetch(`${API_BASE}/sequences/${encodeURIComponent(id)}/start`, {
        method: 'POST'
    });
    return handleResponse(response);
};

// 恒 200 幂等（idle 无操作；运行中协作式置停止位，终态经 /status 轮询到）。
export const stopSequence = async () => {
    const response = await fetch(`${API_BASE}/sequences/stop`, { method: 'POST' });
    return handleResponse(response);
};

// 轮询口（P4 序列页 1.5s）：running/result/progress/steps[] 快照。
export const getSequenceStatus = async () => {
    const response = await fetch(`${API_BASE}/sequences/status`);
    return handleResponse(response);
};
