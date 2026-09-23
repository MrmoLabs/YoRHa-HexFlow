// P1 设备档案区的纯函数视图模型（Terminal 页用）。
// 档案数据来自 GET /profiles（后端算 is_active / modified），此处只管展示派生。

// 一句话摘要当前/档案配置：LOOPBACK / TCP host:port / SERIAL COM@baud。
export const profileSummary = (config) => {
    const mode = String(config?.mode || 'loopback');
    if (mode === 'tcp') {
        return `TCP ${config?.tcp?.host ?? '?'}:${config?.tcp?.port ?? '?'}`;
    }
    if (mode === 'serial') {
        return `SERIAL ${config?.serial?.port ?? '?'}@${config?.serial?.baudrate ?? '?'}`;
    }
    return 'LOOPBACK';
};

// 下拉项文案：`名称 · 摘要`，激活档案加 ★（纯文本，便于测试断言）。
export const profileOptionLabel = (profile) =>
    `${profile?.label ?? '—'} · ${profileSummary(profile?.config)}${profile?.is_active ? ' ★' : ''}`;

// 徽标（激活=琥珀状态标记，激活后被改过=中性描边）；modified ⊆ is_active（后端保证）。
export const profileBadges = (profile) => {
    const badges = [];
    if (profile?.is_active) {
        badges.push({ text: '已激活', className: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300' });
    }
    // modified ⊆ is_active（后端口径）：未激活的「已改」无意义，防御性忽略
    if (profile?.is_active && profile?.modified) {
        badges.push({ text: '已修改', className: 'border-nier-light/40 text-nier-light/70' });
    }
    return badges;
};
