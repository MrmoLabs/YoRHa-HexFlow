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

// 批次二 (D12/D14②): 删前引用计数 —— 镜像协议页 P0-1 的 GET 计数范式。
// 四表按数据性质分三类：活配置（protocol_bindings / response_specs）删时级联、
// 冻结快照（sequence_steps）留并标失效、日志（dispatch_logs）只读保留。
export const getInstructionReferences = async (id) => {
    const response = await fetch(`${API_BASE}/instructions/${id}/references`);
    return handleResponse(response);
};

export const deleteInstruction = async (id) => {
    const response = await fetch(`${API_BASE}/instructions/${id}`, {
        method: 'DELETE'
    });
    return handleResponse(response);
};
