import { API_BASE, handleResponse, formatApiErrorDetail } from './client';

// Data Hub (C3 数据中心一期): 环境状态 / 聚合导出 / 数据库备份恢复
export const getDatahubStatus = async () => {
    const response = await fetch(`${API_BASE}/datahub/status`);
    return handleResponse(response);
};

export const createDbBackup = async () => {
    const response = await fetch(`${API_BASE}/datahub/backup`, { method: 'POST' });
    return handleResponse(response);
};

export const restoreDbBackup = async (name) => {
    const response = await fetch(`${API_BASE}/datahub/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    return handleResponse(response);
};

// 聚合导出 ZIP（R7 · PLAN §8.45：**8 域** —— instructions / relations / recipes /
// sequences / transport / profiles / templates + manifest.json + frames/*）→ Blob
export const exportDataBundle = async () => {
    const response = await fetch(`${API_BASE}/datahub/export/bundle`);
    if (!response.ok) {
        const data = await response.json().catch(() => ({ detail: 'Export failed' }));
        throw new Error(formatApiErrorDetail(data.detail));
    }
    return response.blob();
};

// 批次四 4a：relations.json 回灌 —— 按 id upsert、逐行报告（部分成功不整批回滚）。
// 入参 = ZIP 内 relations.json 的原文；返回 {bindings, responseSpecs, warnings}。
export const importRelations = async (relations) => {
    const response = await fetch(`${API_BASE}/datahub/import/relations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(relations)
    });
    return handleResponse(response);
};

// R8（PLAN §8.46）：按域导入 —— R7 出线的 5 个新域回灌，与 importRelations 同形
// （原文回灌、逐行 upsert、逐行报告、部分成功不整批回滚），导入前后端自动留快照。
// `domain` 由调用方按文件形态识别后传入；**FE 不兜白名单第二层** ——
// 认不出的域名由后端 404 detail 原样透出，避免前后端两处口径分叉。
export const importDomain = async (domain, payload) => {
    const response = await fetch(`${API_BASE}/datahub/import/${domain}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return handleResponse(response);
};
