import { lazy } from 'react';

/**
 * R35 路由级拆包：每页一个动态 import → 独立 chunk。
 *
 * 改之前 8 个页面在 App.jsx 里全是静态 import，vite build 把它们连同首屏外壳
 * 揉成一个 ~750kB 的 index.js（每次 build 都越 500kB 警告线），而用户一次只会
 * 打开一页。这里把「页面模块从哪来」收敛到单一表，App 只按 pageKey 取组件。
 *
 * 约定：
 *  - `ROUTE_LOADERS` 是普通可写对象，测试可替换成计数桩验证幂等；
 *  - `routeComponent` 必须缓存 React.lazy 实例，否则每次渲染新建组件 → 整页重挂载；
 *  - `prefetchRoute` 复用同一份 pending Promise，hover 多少次只发一次请求，且失败不抛。
 */
export const ROUTE_LOADERS = {
    protocol: () => import('../pages/Protocol'),
    instruction: () => import('../pages/Instruction'),
    processing: () => import('../pages/InstructionProcessor'),
    orchestration: () => import('../pages/Orchestration'),
    terminal: () => import('../pages/Terminal'),
    datahub: () => import('../pages/DataHub'),
    sequences: () => import('../pages/Sequences'),
    // R38（§8.70）：第 9 页 —— 发前路由规则的管理面（解析 / 自动选指令归 R39）
    routing: () => import('../pages/RoutingRules'),
    trash: () => import('../pages/Trash'),
};

export const ROUTE_KEYS = Object.keys(ROUTE_LOADERS);

const pending = new Map();
const components = new Map();

export function hasRoute(pageKey) {
    return typeof ROUTE_LOADERS[pageKey] === 'function';
}

function loadRoute(pageKey) {
    if (!pending.has(pageKey)) {
        pending.set(pageKey, ROUTE_LOADERS[pageKey]());
    }
    return pending.get(pageKey);
}

/** 未知 pageKey 返回 null，由调用方回落默认跳转（不猜页面）。 */
export function routeComponent(pageKey) {
    if (!hasRoute(pageKey)) return null;
    if (!components.has(pageKey)) {
        components.set(pageKey, lazy(() => loadRoute(pageKey)));
    }
    return components.get(pageKey);
}

/** hover / focus 预取。成功返回 pageKey，失败返回 null（不打断导航）。 */
export function prefetchRoute(pageKey) {
    if (!hasRoute(pageKey)) return null;
    return loadRoute(pageKey).then(() => pageKey).catch(() => null);
}

/** 仅供测试隔离模块级缓存。 */
export function __resetRouteCaches() {
    pending.clear();
    components.clear();
}
