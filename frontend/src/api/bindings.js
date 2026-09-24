import { API_BASE, handleResponse } from './client';

// Binding CRUD (E4: 编排绑定持久化，后端新表 protocol_bindings)。
// 绑定 = protocol_id + instruction_id + 插槽序（slot_order 由后端按 max+1 分配）。

// 批次一 1a (D1 一行两用): 可选 instruction_id 过滤 —— 加工页取指令默认封装
// 绑定走 GET /bindings?instruction_id=（缺省仍拉全量，编排页口径不变）。
export const getBindings = async (instructionId = null) => {
    const url = instructionId
        ? `${API_BASE}/bindings?instruction_id=${encodeURIComponent(instructionId)}`
        : `${API_BASE}/bindings`;
    const response = await fetch(url);
    return handleResponse(response);
};

export const createBinding = async (payload) => {
    const response = await fetch(`${API_BASE}/bindings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return handleResponse(response);
};

export const updateBinding = async (id, payload) => {
    const response = await fetch(`${API_BASE}/bindings/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return handleResponse(response);
};

export const deleteBinding = async (id) => {
    const response = await fetch(`${API_BASE}/bindings/${id}`, {
        method: 'DELETE'
    });
    return handleResponse(response);
};
