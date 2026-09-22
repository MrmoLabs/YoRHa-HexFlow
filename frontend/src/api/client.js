// Shared fetch helpers for all API modules.
// Configurable via VITE_API_BASE (see frontend/.env), falls back to local dev.
export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000';

export const formatApiErrorDetail = (detail) => {
    if (Array.isArray(detail)) {
        return detail.map(item => {
            const path = Array.isArray(item?.loc) ? item.loc.join('.') : 'body';
            const message = item?.msg || 'Invalid value';
            return `${path}: ${message}`;
        }).join('\n');
    }

    if (typeof detail === 'string') {
        return detail;
    }

    if (detail && typeof detail === 'object') {
        return JSON.stringify(detail);
    }

    return 'API request failed';
};

export const handleResponse = async (response) => {
    const data = await response.json();
    if (!response.ok) {
        const error = new Error(formatApiErrorDetail(data.detail));
        error.response = {
            status: response.status,
            data: data
        };
        throw error;
    }
    return data;
};
