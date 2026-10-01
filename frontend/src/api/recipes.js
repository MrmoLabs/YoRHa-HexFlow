import { API_BASE, handleResponse } from './client';

// CP3 3a (D13): 配方 CRUD —— `frame_recipes`（有序 stages: [{protocol_id,
// slot_ids, definition_hash}]）。definition_hash 由**服务端**算并回写，前端只读
// （hash 只在后端算，§9.5-1）；stages 由服务端解析校验（层数 ≤4、槽存在、协议 404）。

// 降级链取配方走 ?instruction_id=（镜像 getBindings 先例）：按指令的
// default_recipe_id 反查 → 0 或 1 条；无关联即空数组（不是 404）。
export const getRecipes = async (instructionId = null) => {
    const url = instructionId
        ? `${API_BASE}/recipes?instruction_id=${encodeURIComponent(instructionId)}`
        : `${API_BASE}/recipes`;
    const response = await fetch(url);
    return handleResponse(response);
};

export const getRecipe = async (id) => {
    const response = await fetch(`${API_BASE}/recipes/${encodeURIComponent(id)}`);
    return handleResponse(response);
};

export const createRecipe = async (payload) => {
    const response = await fetch(`${API_BASE}/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return handleResponse(response);
};

export const updateRecipe = async (id, payload) => {
    const response = await fetch(`${API_BASE}/recipes/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return handleResponse(response);
};

export const deleteRecipe = async (id) => {
    const response = await fetch(`${API_BASE}/recipes/${encodeURIComponent(id)}`, {
        method: 'DELETE'
    });
    return handleResponse(response);
};
