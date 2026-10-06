// R38（PLAN §8.70）：发前路由规则页的**纯逻辑** —— 表单就地校验、排序草稿
// 与「只回写真变化的行」、后端 detail → 中文事实文案。
//
// 抽成纯函数即为钉口径：三条原则 ——
//  ① **不造第二套判据**：条件语法一律委托 `utils/condition.checkCondition`
//     （与序列步骤条件、BE `core/condition.py` 同一份 SSOT，错误文案逐字同源）；
//  ② **只陈述事实**：错误文案说明「发生了什么、下一步去哪」，不替用户下结论；
//  ③ **排序不猜**：草稿序只影响展示，落库必须显式点「保存顺序」，且只 PUT
//     `sort_order` 真变化的行（后端没有批量排序端点，少发一行是一行）。
import { checkCondition } from './condition';

// 与后端 `RoutingRuleCreate.name` 的 max_length 同一个数 —— 改一边必改另一边
export const MAX_RULE_NAME = 128;

/**
 * 空草稿。**字段名与后端 `RoutingRuleCreate` 逐字同名**（`instruction_id` /
 * `sort_order` 而不是 instructionId / sortOrder）—— 少一层映射就少一处错，
 * 保存时直接 `JSON.stringify(draft)` 即为合法请求体。
 */
export function emptyRuleDraft() {
    return {
        name: '',
        condition: '',
        instruction_id: '',
        sort_order: 0,
        enabled: 1,
        description: '',
    };
}

/**
 * 新建规则的缺省 `sort_order` = 末位 + 1（**落到最后**，不插队到最前面）。
 *
 * 从未重排过的存量可能全是 0 —— 那时给 1 也是末位（同 sort_order 才轮到
 * `(name, id)` 兜底，1 > 0 恒排后面）。空表 = 0。
 */
export function defaultSortOrder(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    let max = -Infinity;
    for (const row of rows) {
        const n = Number(row?.sort_order);
        if (Number.isFinite(n) && n > max) max = n;
    }
    return (Number.isFinite(max) ? max : 0) + 1;
}

/**
 * 保存前就地校验 —— 拦下**能提前知道**的错，不送后端吃 400。
 *
 * 拦不到的只剩两类，交给后端 400 + `describeRoutingSaveError` 兜底：
 *  · 回收站里占名的软删行（FE 的 `liveNames` 只有活行，后端判重查**全表**）；
 *  · 目标指令在提交与落笔之间刚被别人删掉（404 Instruction not found）。
 *
 * @param {object} draft
 * @param {{liveNames?: string[], excludeName?: string|null}} [opts]
 *   `excludeName` = 编辑中那一行自己的原名（自身不算重名）
 * @returns {{ok: boolean, errors: Record<string, string>}}
 */
export function validateRuleDraft(draft, { liveNames = [], excludeName = null } = {}) {
    const errors = {};

    const name = String(draft?.name ?? '').trim();
    if (!name) {
        errors.name = '规则名称不能为空。';
    } else if (Array.from(name).length > MAX_RULE_NAME) {
        errors.name = `规则名称最长 ${MAX_RULE_NAME} 字符，当前 ${Array.from(name).length} 字符。`;
    } else {
        const mine = String(excludeName ?? '').trim();
        const taken = (liveNames || []).some((n) => String(n ?? '').trim() === name);
        if (taken && name !== mine) {
            errors.name =
                '规则名称已被占用 —— 同名行（含回收站里占名的软删行）继续占用唯一键，' +
                '请改名，或到回收站彻底删除释放后重试。';
        }
    }

    const condition = String(draft?.condition ?? '');
    if (!condition.trim()) {
        errors.condition = '命中条件不能为空 —— 规则靠它判真。';
    } else {
        // 同一谓词：这里报的与序列步骤编辑器、BE 保存侧逐字同源
        const msg = checkCondition(condition);
        if (msg) errors.condition = msg;
    }

    if (!draft?.instruction_id) {
        errors.instruction_id = '请选择该规则命中时要发的指令。';
    }

    return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * 上移 / 下移一位。**只改草稿，不发请求**；边界 / 找不到行 → 原数组原样返回
 * （`rows` 是同一引用，调用方连 setState 都不必触发）。
 *
 * @returns {{rows: object[], moved: boolean}}
 */
export function moveRule(rows, id, delta) {
    const from = (rows || []).findIndex((r) => r.id === id);
    if (from < 0) return { rows, moved: false };
    const to = from + Number(delta || 0);
    if (to < 0 || to >= rows.length) return { rows, moved: false };

    const next = rows.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return { rows: next, moved: true };
}

/**
 * 按**当前草稿顺序**稠密重编 → `[{id, sort_order}]`（0..N-1）。
 *
 * 稠密重编的意义：后端列表按 `(sort_order, name, id)` 定序，sort_order 一旦
 * 全体互不相同，`(name, id)` 兜底就永不生效 —— **看到的顺序 = 匹配的顺序**，
 * 不存在「看起来一样、其实按名字排」的暗坑。
 */
export function renumber(rows) {
    return (rows || []).map((row, i) => ({ id: row.id, sort_order: i }));
}

/**
 * 只挑 `sort_order` **真变化**的行进 PUT 队列（后端无批量排序端点，逐行提交）。
 *
 * @param {object[]} beforeRows 服务器原序（带原 sort_order）
 * @param {Array<{id: string, sort_order: number}>} proposal renumber 的结果
 * @returns {Array<{id: string, sort_order: number}>} 按 beforeRows 顺序返回
 */
export function changedSortOrder(beforeRows, proposal) {
    const want = new Map((proposal || []).map((p) => [p.id, p.sort_order]));
    const before = beforeRows || [];
    const beforeIds = new Set(before.map((r) => r.id));

    const changed = before
        .filter((r) => want.has(r.id) && want.get(r.id) !== r.sort_order)
        .map((r) => ({ id: r.id, sort_order: want.get(r.id) }));

    // 草稿里出现、服务器列表里没有的行（理论上不会发生，但不静默丢）
    const added = (proposal || [])
        .filter((p) => !beforeIds.has(p.id))
        .map((p) => ({ id: p.id, sort_order: p.sort_order }));

    return [...changed, ...added];
}

/**
 * 后端 `detail` → 中文事实文案。**只陈述事实与下一步，不替用户下结论**
 * （不写「你删错了」之类），未归类的一律 `保存失败：<原文>` 透出。
 */
export function describeRoutingSaveError(error) {
    const raw = error && typeof error.message === 'string' ? error.message : '';
    if (!raw) return '保存失败：后端未给出原因，请重试，或查看后端日志。';

    if (raw.includes('name already exists')) {
        return (
            '保存失败：规则名称已存在 —— 同名行（含回收站里占名的软删行）继续占用唯一键，' +
            `请改名，或到回收站彻底删除释放后重试。后端原文：${raw}`
        );
    }
    if (raw.includes('Instruction not found')) {
        return (
            '保存失败：目标指令不在册（已进回收站或不存在）—— 先到回收站恢复它，' +
            `或改选一条在册活指令。后端原文：${raw}`
        );
    }
    if (raw.includes('Invalid routing condition')) {
        return `保存失败：命中条件不合法 —— ${raw}`;
    }
    return `保存失败：${raw}`;
}
