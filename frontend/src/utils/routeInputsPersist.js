// R47（PLAN §8.79）：路由输入表的本机持久化 —— 加工页「路由输入」（R39）与规则页
// 「试解析」（R40）共用的那一份草稿。
//
// 2026-10-07 question 回执拍板三条口径：
//  ① **整表原样存（含空行）**：存什么读什么 —— 行序、空行、只填了键没填值的半行
//     都原样回；本层不补行、不推断、不筛掉任何一行；
//  ② **两页共用一份**：单点 key（`ROUTE_INPUTS_KEY`），两页读写同一个槽，规则页
//     写下的行切到加工页接着用；
//  ③ **localStorage + 显式清空入口**：读 / 写 / 清三个函数，**按钮归各页** —— 与
//     RouteInputTable「不加按钮」同一条边界（两页按钮视觉语言不同）。
//
// 另有一条比拍板更硬的工程口径：**存储不可用时一律当「本机没存过」，本层不抛** ——
// 隐私模式读不到 localStorage、配额满写不进、本机那份被人改坏了，输入表照常打开。
// 表打不开比表是空的严重得多，所以这里只降级、不报错、不打断输入。
//
// 本层只管数据进出：不碰 React、不碰请求、不碰类型解析（键去空白 / 空键不发 /
// 值按 JSON 标量仍是 `routeResolve.js` 那一份，一行未动）。
export const ROUTE_INPUTS_KEY = 'yorha.routeInputs.v1';

// 整表原样的形状 = 行序无关，只要每行都是 { key: string, value: string }。
// 形状不合法一律当「本机没存过」——读到半张表比读不到危险。
const isRows = (value) => Array.isArray(value) && value.every((row) => (
    row !== null
    && typeof row === 'object'
    && typeof row.key === 'string'
    && typeof row.value === 'string'
));

// 读：本机那份原样；没存过 / 读不到 / 存坏了 → null，默认那一行空行由调用方给
// （本层不臆造行 —— 「存什么读什么」与「默认一行」是两件事，别在数据层混起来）。
export const loadRouteInputs = () => {
    try {
        const raw = window.localStorage.getItem(ROUTE_INPUTS_KEY);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        return isRows(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

// 写：整表原样落盘（键入即写）；写不进去就算了 —— 存储故障不该挡住正在打的字
export const saveRouteInputs = (rows) => {
    try {
        if (!isRows(rows)) return;
        window.localStorage.setItem(ROUTE_INPUTS_KEY, JSON.stringify(rows));
    } catch {
        // 配额满 / 存储不可用：降级，本批口径不报错
    }
};

// 清：本机那份直接删（清空入口用）；默认那一行空行由调用方重给
export const clearRouteInputs = () => {
    try {
        window.localStorage.removeItem(ROUTE_INPUTS_KEY);
    } catch {
        // 存储不可用：降级，本批口径不报错
    }
};
