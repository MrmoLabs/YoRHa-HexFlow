import { API_BASE, handleResponse } from './client';

// Instructions
export const getInstructions = async (search = '') => {
    const response = await fetch(`${API_BASE}/instructions/?search=${encodeURIComponent(search)}`);
    return handleResponse(response);
};

export const getInstruction = async (id) => {
    const response = await fetch(`${API_BASE}/instructions/${id}`);
    return handleResponse(response);
};

export const createInstruction = async (data) => {
    const response = await fetch(`${API_BASE}/instructions/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return handleResponse(response);
};

export const updateInstruction = async (id, data) => {
    const response = await fetch(`${API_BASE}/instructions/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return handleResponse(response);
};

export const deleteInstruction = async (id) => {
    const response = await fetch(`${API_BASE}/instructions/${id}`, {
        method: 'DELETE'
    });
    return handleResponse(response);
};
