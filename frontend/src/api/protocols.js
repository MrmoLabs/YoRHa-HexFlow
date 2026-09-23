import { API_BASE, handleResponse } from './client';

// Protocols
export const getProtocols = async () => {
    const response = await fetch(`${API_BASE}/protocols/`);
    return handleResponse(response);
};

// 批次五: version 乐观并发冲突处理用 —— 「强制覆盖/加载最新」按 id 拉当前
// 行（含最新 version），不必整列表回读。
export const getProtocol = async (id) => {
    const response = await fetch(`${API_BASE}/protocols/${id}`);
    return handleResponse(response);
};

export const createProtocol = async (data) => {
    const response = await fetch(`${API_BASE}/protocols/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return handleResponse(response);
};

export const updateProtocol = async (id, data) => {
    const response = await fetch(`${API_BASE}/protocols/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return handleResponse(response);
};

export const deleteProtocol = async (id) => {
    const response = await fetch(`${API_BASE}/protocols/${id}`, {
        method: 'DELETE'
    });
    return handleResponse(response);
};
