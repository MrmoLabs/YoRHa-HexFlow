import { API_BASE, handleResponse } from './client';

// P1 设备档案 /profiles：传输配置的命名快照（后端 device_profiles 表）。
// create 省略 config = 服务端快照当前生效配置；带 config 须为完整三段形态。
// activate 返回 ProfileResponse（其 config 字段 = 生效后的完整配置）。

export const getProfiles = async () => {
    const response = await fetch(`${API_BASE}/profiles`);
    return handleResponse(response);
};

export const createProfile = async (payload) => {
    const response = await fetch(`${API_BASE}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return handleResponse(response);
};

export const updateProfile = async (id, payload) => {
    const response = await fetch(`${API_BASE}/profiles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return handleResponse(response);
};

// R20（PLAN §8.50 ②-3）：整表顺序一次提交 —— `ids` 必须恰好覆盖全部活档案
// （重复 / 遗漏 / 混入回收站一律 400）。返回**新顺序**的档案列表（直接替换本地状态）。
export const reorderProfiles = async (ids) => {
    const response = await fetch(`${API_BASE}/profiles/order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
    });
    return handleResponse(response);
};

export const deleteProfile = async (id) => {
    const response = await fetch(`${API_BASE}/profiles/${id}`, {
        method: 'DELETE'
    });
    return handleResponse(response);
};

export const activateProfile = async (id) => {
    const response = await fetch(`${API_BASE}/profiles/${id}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    return handleResponse(response);
};
