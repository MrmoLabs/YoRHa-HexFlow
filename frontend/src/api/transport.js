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

// R14（PLAN §8.49）：本机串口端口枚举 → {ports:[{device,description}], source, error?}。
// **只读、不碰配置**；后端缺 pyserial 或枚举炸了会降级成 source='unavailable' + error 原文
// （仍 200），这里原样透出，让配置页照常用、绝不静默。
export const getTransportPorts = async () => {
    const response = await fetch(`${API_BASE}/transport/ports`);
    return handleResponse(response);
};

// R2（PLAN §8.37）：一键回退到上一配置 → {config, historyDepth}；无历史 → 400。
export const revertTransportConfig = async () => {
    const response = await fetch(`${API_BASE}/transport/config/revert`, {
        method: 'POST'
    });
    return handleResponse(response);
};
