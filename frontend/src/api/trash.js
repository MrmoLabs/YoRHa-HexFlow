import { API_BASE, handleResponse } from './client';

// R6（PLAN §8.43）：软删除 / 回收站 —— 后端 7 类可回收对象删除后**不是没了**，
// 而是打 `deleted_at` 标记进回收站。本模块是 FE 侧唯一入口（列条目 / 恢复 /
// 彻底删除）。
//
// `kind` 是后端白名单（路径参数不接受任意表名）：
//   protocol | instruction | binding | recipe | sequence | profile | response_spec
// 传白名单外的值后端回 404（_spec 未命中），FE 不额外兜一层以免口径分叉。
//
// 级联语义（后端 mark_related / restore_related，同一时间戳为判据）：
//   · 删除协议/指令 → 其绑定与应答规格**一并入站**，`GET /trash` 不单列它们
//     （宿主回来会一起恢复）；
//   · `restore` / `purge` 的回执 `related` = 级联恢复/清除的条数。
const encode = (kind, id) =>
    `${API_BASE}/trash/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;

// GET /trash → { items: [{kind, id, label, deleted_at}], count }（最近删的在前）
export const listTrash = async () => {
    const response = await fetch(`${API_BASE}/trash`);
    return handleResponse(response);
};

// POST /trash/{kind}/{id}/restore → { status, kind, id, related }
export const restoreTrashItem = async (kind, id) => {
    const response = await fetch(`${encode(kind, id)}/restore`, { method: 'POST' });
    return handleResponse(response);
};

// DELETE /trash/{kind}/{id} → { status, kind, id, related }（真删行 + 按外键清引用者）
export const purgeTrashItem = async (kind, id) => {
    const response = await fetch(encode(kind, id), { method: 'DELETE' });
    return handleResponse(response);
};
