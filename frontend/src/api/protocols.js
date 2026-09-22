import { API_BASE, handleResponse } from './client';

// Protocols
export const getProtocols = async () => {
    const response = await fetch(`${API_BASE}/protocols/`);
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
