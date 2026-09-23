import { API_BASE, handleResponse } from './client';

// Binding CRUD (E4: 编排绑定持久化，后端新表 protocol_bindings)。
// 绑定 = protocol_id + instruction_id + 插槽序（slot_order 由后端按 max+1 分配）。

export const getBindings = async () => {
    const response = await fetch(`${API_BASE}/bindings`);
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
