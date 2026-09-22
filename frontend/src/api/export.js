import { API_BASE, formatApiErrorDetail } from './client';

// Export (binary / hex file download)
export const exportHexFile = async (hexString, filename = 'yorha-frame.hex') => {
    const response = await fetch(`${API_BASE}/export/hex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hex_string: hexString, filename })
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({ detail: 'Export failed' }));
        throw new Error(formatApiErrorDetail(data.detail));
    }
    return response.blob();
};

export const exportBinaryFromBlocks = async (blocks, filename = 'yorha-frame.bin') => {
    const response = await fetch(`${API_BASE}/export/binary?filename=${encodeURIComponent(filename)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks })
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({ detail: 'Export failed' }));
        throw new Error(formatApiErrorDetail(data.detail));
    }
    return response.blob();
};
