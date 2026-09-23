import { API_BASE, handleResponse } from './client';

// Transport config & status (E2 backend: loopback default / tcp / serial).
export const getTransportConfig = async () => {
    const response = await fetch(`${API_BASE}/transport/config`);
    return handleResponse(response);
};

export const setTransportConfig = async (patch) => {
    const response = await fetch(`${API_BASE}/transport/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
    });
    return handleResponse(response);
};

export const getTransportStatus = async () => {
    const response = await fetch(`${API_BASE}/transport/status`);
    return handleResponse(response);
};
