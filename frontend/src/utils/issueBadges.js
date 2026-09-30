// 验证反馈批次：属性面板的提醒清单 → 画布卡片标色映射（纯函数）。
//
// 输入 = validateProtocol / validateInstruction 的输出 { errors, warnings }
// （每条带 blockId / code / message），输出 = Map<blockId, { level, messages }>：
//  - level = 'error' | 'warning'（同卡 **错误优先**，提醒不降级）
//  - messages = 该卡全部消息聚合（角标 title 悬停直读，与面板清单同文）
//  - 无 blockId 的条目跳过（页面级问题无卡可标，仍留在面板清单里）
//  - null / 空清单 → 空 Map（蓝图/编排页不传该 prop 的口径）。
export const buildIssueMap = (validation) => {
    const map = new Map();
    if (!validation || typeof validation !== 'object') return map;

    const add = (items, level) => {
        if (!Array.isArray(items)) return;
        for (const it of items) {
            if (!it || it.blockId == null) continue;
            const cur = map.get(it.blockId);
            if (!cur) {
                map.set(it.blockId, { level, messages: [it.message] });
                continue;
            }
            // 已有条目：消息一律聚合；level 只升不降（warning 撞上 error 保持 error）
            if (level === 'error') cur.level = 'error';
            cur.messages.push(it.message);
        }
    };

    // 固定序：warnings 先入、errors 后入 → 错误必达最高级
    add(validation.warnings, 'warning');
    add(validation.errors, 'error');
    return map;
};
