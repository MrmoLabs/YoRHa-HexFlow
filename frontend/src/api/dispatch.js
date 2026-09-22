import { API_BASE, handleResponse } from './client';

// Dispatch via backend transport abstraction (loopback default / tcp / serial; bounded send history).
export const dispatchPayload = async (hexString, instructionName = null) => {
    const response = await fetch(`${API_BASE}/dispatch/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hex_string: hexString, instruction_name: instructionName })
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
