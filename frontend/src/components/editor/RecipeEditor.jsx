import React from 'react';

// CP3 3b (D13): 编排页「封装配方」编辑器 —— 有序 stage 列表（加层 / 上移 / 下移 /
// 删层 + 选协议 + 选槽）、`/recipes` 手动保存（沿本页 SAVE 底置范式）、试发改走配方。
//
// 归属依据（DESIGN_CorePipeline §9.4）：编排页本就是「壳 + 核组合」页；D9 划界
// 协议页只管线帧格式，配方的多层堆叠放这里最贴近操作心智。
//
// 口径：
//   · 层数 1..MAX_RECIPE_STAGES（与后端 recipe_api.MAX_RECIPE_STAGES 同值，§9.5-3）
//   · `slot_ids` 归配方阶段所有（§9.1）—— 选槽是**成员关系 + 选择顺序**，位次
//     badge `#n` 即第 n 条载荷（「位置对应 payloads」）；清空 = 稠密位次
//   · 换层协议 → 槽位作废置空（槽属于那棵协议树，留着就是脏引用 → 服务端 400）
//   · `definition_hash` **只在后端算**（§9.5-1），本组件不碰，保存后服务端回写
//   · 组件只报「想要哪些 stages」，落库时机与 version 乐观并发归页面（onSave）
export const MAX_RECIPE_STAGES = 4;

// 协议树 DFS 收槽（镜像后端 frame_builder 的 slot 收集顺序 —— 树序 = 稠密位次）
const collectSlots = (children = [], out = []) => {
    for (const node of children) {
        if (node.type === 'slot') out.push({ id: node.id, label: node.label || node.id });
        if (node.children?.length) collectSlots(node.children, out);
    }
    return out;
};

const btnClass = 'text-[9px] font-mono uppercase tracking-widest border px-1.5 py-1 transition-colors duration-100';
const btnIdle = 'border-nier-light/30 text-nier-light/50 hover:border-nier-light/70 hover:text-nier-light';
const btnOn = 'border-nier-light bg-nier-light text-nier-dark';

export default function RecipeEditor({
    protocols = [],
    recipes = [],
    instructions = [],
    activeRecipeId = '',
    draft = null,
    dirty = false,
    saving = false,
    loaded = false,
    message = null,
    onSelect = () => { },
    onCreate = () => { },
    onDelete = () => { },
    onNameChange = () => { },
    onLinkChange = () => { },
    onStagesChange = () => { },
    onSave = () => { }
}) {
    const stages = draft ? draft.stages : [];

    // ---- stage 列表操作：全部收敛成「换一份 stages 数组」上报（onStagesChange）----
    const replaceAt = (index, nextStage) =>
        onStagesChange(stages.map((s, i) => (i === index ? nextStage : s)));

    const moveStage = (index, delta) => {
        const target = index + delta;
        if (target < 0 || target >= stages.length) return;
        const next = [...stages];
        [next[index], next[target]] = [next[target], next[index]];
        onStagesChange(next);
    };

    const removeStage = (index) => {
        if (stages.length <= 1) return;   // 至少 1 层（服务端同口径 400）
        onStagesChange(stages.filter((_, i) => i !== index));
    };

    const addStage = () => {
        if (stages.length >= MAX_RECIPE_STAGES) return;
        const prev = stages[stages.length - 1];
        // 新层缺省沿用上一层协议（最常见：同一外壳再套一层）；首层用首个协议
        const protocolId = prev?.protocol_id || protocols[0]?.id || '';
        onStagesChange([...stages, { protocol_id: protocolId }]);
    };

    const changeProtocol = (index, protocolId) => {
        // 换协议 → 旧槽位全部作废（属另一棵树），置空 = 回稠密位次
        replaceAt(index, { ...stages[index], protocol_id: protocolId, slot_ids: [] });
    };

    const toggleSlot = (index, slotId) => {
        const current = [...(stages[index].slot_ids || [])];
        const at = current.indexOf(slotId);
        if (at >= 0) current.splice(at, 1);   // 取消：中间位次自动前移
        else current.push(slotId);            // 选择顺序 = 位次（追加到末尾）
        replaceAt(index, { ...stages[index], slot_ids: current });
    };

    return (
        <div>
            <div className="text-[9px] opacity-50 border-b border-white/10 pb-1 mb-2">封装配方 (RECIPE)</div>

            {!draft ? (
                <div className="flex flex-col gap-2">
                    <p className="text-[10px] leading-4 opacity-60">
                        配方 = 有序多层外壳（内核 → 第 1 层 → …）。未建配方时「封装试发」仍走组协议（现状不变）。
                    </p>
                    {/* 已有配方但未选中：给选择入口（否则只能新建，存量配方够不着） */}
                    {recipes.length > 0 && (
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] opacity-70 uppercase tracking-widest">配方 (RECIPE)</label>
                            <select
                                data-testid="recipe-select"
                                value=""
                                onChange={(e) => { if (e.target.value) onSelect(e.target.value); }}
                                className="bg-transparent border-b border-nier-light/50 text-sm focus:outline-none focus:border-nier-light py-1 font-mono"
                            >
                                <option value="" className="bg-nier-dark text-white">— 选择配方 (SELECT) —</option>
                                {recipes.map(r => (
                                    <option key={r.id} value={r.id} className="bg-nier-dark text-white">{r.name}</option>
                                ))}
                            </select>
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={onCreate}
                        disabled={!loaded || !protocols.length || saving}
                        data-testid="recipe-new"
                        title={protocols.length ? '新建配方（含第 1 层）' : '无可用协议'}
                        className={`${btnClass} ${btnOn} disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                        + 新建配方 (NEW)
                    </button>
                    {message && (
                        <div data-testid="recipe-msg" className={`text-[10px] font-mono break-all ${message.ok ? 'text-green-400' : 'text-red-400'}`}>
                            {message.text}
                        </div>
                    )}
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    {/* 配方选择 + 名称 —— 脏时禁切换（防静默丢草稿，与本页手动保存语义一致） */}
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] opacity-70 uppercase tracking-widest">配方 (RECIPE)</label>
                        <select
                            data-testid="recipe-select"
                            value={activeRecipeId}
                            disabled={dirty || saving}
                            title={dirty ? '有未保存更改 — 先保存 (SAVE) 再切换' : '切换配方'}
                            onChange={(e) => onSelect(e.target.value)}
                            className="bg-transparent border-b border-nier-light/50 text-sm focus:outline-none focus:border-nier-light py-1 font-mono disabled:opacity-50"
                        >
                            {recipes.map(r => (
                                <option key={r.id} value={r.id} className="bg-nier-dark text-white">{r.name}</option>
                            ))}
                        </select>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] opacity-70 uppercase tracking-widest">配方名称 (Name)</label>
                        <input
                            type="text"
                            data-testid="recipe-name"
                            value={draft.name}
                            onChange={(e) => onNameChange(e.target.value)}
                            disabled={saving}
                            className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide disabled:opacity-50"
                        />
                    </div>

                    {/* 关联指令 = 加工页降级链第 1 级的读入口（instructions.
                        default_recipe_id 单列）；不关联则加工页落回默认协议级 */}
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] opacity-70 uppercase tracking-widest">关联指令 (LINK)</label>
                        <select
                            data-testid="recipe-link"
                            value={draft.instructionId || ''}
                            onChange={(e) => onLinkChange(e.target.value)}
                            disabled={saving}
                            title="加工页封装将按此指令取本配方（降级链第 1 级）；换绑在保存时先清旧指针再设新指针"
                            className="bg-transparent border-b border-nier-light/50 text-sm focus:outline-none focus:border-nier-light py-1 font-mono disabled:opacity-50"
                        >
                            <option value="" className="bg-nier-dark text-white">— 不关联（加工页走默认协议）—</option>
                            {instructions.map(ins => (
                                <option key={ins.id} value={ins.id} className="bg-nier-dark text-white">
                                    {ins.label || ins.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* 层数 + 加层（上限 4，§9.5-3） */}
                    <div className="flex items-center justify-between gap-2">
                        <span data-testid="recipe-stage-count" className="text-[10px] font-mono tracking-widest opacity-70">
                            层数 {stages.length} / {MAX_RECIPE_STAGES}
                        </span>
                        <button
                            type="button"
                            onClick={addStage}
                            disabled={stages.length >= MAX_RECIPE_STAGES || saving}
                            data-testid="recipe-add-stage"
                            title={stages.length >= MAX_RECIPE_STAGES ? '已达层数上限 4' : '在最外侧加一层'}
                            className={`${btnClass} ${btnIdle} disabled:opacity-40 disabled:cursor-not-allowed`}
                        >
                            + 加层 (ADD)
                        </button>
                    </div>

                    {/* 有序 stage 列表：index 0 = 最内层（直接包内核） */}
                    <div className="flex flex-col gap-2">
                        {stages.map((stage, index) => {
                            const protocol = protocols.find(p => p.id === stage.protocol_id);
                            const slots = collectSlots(protocol?.children || []);
                            const selected = stage.slot_ids || [];
                            const missing = Boolean(stage.protocol_id) && !protocol;
                            return (
                                <div key={`stage-${index}`} data-testid={`recipe-stage-${index}`} className="border border-nier-light/20 p-2">
                                    <div className="flex items-center justify-between gap-2 mb-2">
                                        <span className={`text-[10px] font-mono tracking-widest ${missing ? 'text-[#E58D28]' : 'text-nier-light/70'}`}>
                                            L{index + 1}{missing ? ' · 协议缺失' : ''}
                                        </span>
                                        <div className="flex gap-1">
                                            <button
                                                type="button"
                                                onClick={() => moveStage(index, -1)}
                                                disabled={index === 0 || saving}
                                                title="上移 (MOVE UP)"
                                                aria-label={`第 ${index + 1} 层上移`}
                                                className={`${btnClass} ${btnIdle} disabled:opacity-30 disabled:cursor-not-allowed px-1.5`}
                                            >↑</button>
                                            <button
                                                type="button"
                                                onClick={() => moveStage(index, 1)}
                                                disabled={index === stages.length - 1 || saving}
                                                title="下移 (MOVE DOWN)"
                                                aria-label={`第 ${index + 1} 层下移`}
                                                className={`${btnClass} ${btnIdle} disabled:opacity-30 disabled:cursor-not-allowed px-1.5`}
                                            >↓</button>
                                            <button
                                                type="button"
                                                onClick={() => removeStage(index)}
                                                disabled={stages.length <= 1 || saving}
                                                title="删层 (REMOVE LAYER)"
                                                aria-label={`删除第 ${index + 1} 层`}
                                                className={`${btnClass} ${btnIdle} disabled:opacity-30 disabled:cursor-not-allowed px-1.5 hover:!border-red-400 hover:!text-red-400`}
                                            >×</button>
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] opacity-70 uppercase tracking-widest">协议外壳 (Protocol)</label>
                                        <select
                                            value={stage.protocol_id}
                                            onChange={(e) => changeProtocol(index, e.target.value)}
                                            disabled={saving}
                                            data-testid={`recipe-protocol-${index}`}
                                            className="bg-transparent border-b border-nier-light/50 text-sm focus:outline-none focus:border-nier-light py-1 font-mono disabled:opacity-50"
                                        >
                                            {missing && (
                                                <option value={stage.protocol_id} className="bg-nier-dark text-red-400">
                                                    {stage.protocol_id}（已删除）
                                                </option>
                                            )}
                                            {protocols.map(p => (
                                                <option key={p.id} value={p.id} className="bg-nier-dark text-white">{p.label}</option>
                                            ))}
                                        </select>
                                    </div>

                                    {/* 选槽：成员关系 + 选择顺序（#n = 第 n 条载荷）；无槽协议不出芯片 */}
                                    {slots.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-2" data-testid={`recipe-slots-${index}`}>
                                            {slots.map(slot => {
                                                const position = selected.indexOf(slot.id);
                                                const on = position >= 0;
                                                return (
                                                    <button
                                                        key={slot.id}
                                                        type="button"
                                                        onClick={() => toggleSlot(index, slot.id)}
                                                        aria-pressed={on}
                                                        title={on
                                                            ? `位次 #${position + 1} — 对应第 ${position + 1} 条载荷`
                                                            : '未选（该槽按稠密位次填充）'}
                                                        className={`${btnClass} ${on ? btnOn : btnIdle}`}
                                                    >
                                                        {on ? `#${position + 1} ` : ''}{slot.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                    {selected.length > 0 && (
                                        <div className="text-[9px] font-mono opacity-50 mt-1 tracking-widest">
                                            槽序 = 载荷序（位置对应 payloads）
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* 手动保存（沿本页 SAVE 底置范式：脏点 + 计数 + 底部按钮） */}
                    <div className="flex items-center gap-1.5 text-[10px] font-mono tracking-widest">
                        <span aria-hidden="true" className={dirty ? 'text-[#E58D28]' : 'opacity-40'}>●</span>
                        <span data-testid="recipe-dirty" className={dirty ? 'text-[#E58D28] font-bold' : 'opacity-40'}>
                            {dirty ? '配方未保存' : '配方已同步'}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={onSave}
                        disabled={!dirty || saving}
                        data-testid="recipe-save"
                        className="w-full bg-nier-light/10 border border-nier-light text-nier-light hover:bg-nier-light hover:text-black py-2 px-4 uppercase text-xs tracking-widest transition-colors font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {saving ? 'SAVING...' : '保存配方 (SAVE RECIPE)'}
                    </button>
                    <button
                        type="button"
                        onClick={() => onDelete(activeRecipeId)}
                        disabled={saving}
                        data-testid="recipe-delete"
                        title="删除配方（服务端同事务解除关联该配方的指令）"
                        className={`${btnClass} w-full border-red-400/50 text-red-300 hover:bg-red-400 hover:text-nier-dark disabled:opacity-40`}
                    >
                        删除配方 (DELETE)
                    </button>
                    {message && (
                        <div data-testid="recipe-msg" className={`text-[10px] font-mono break-all ${message.ok ? 'text-green-400' : 'text-red-400'}`}>
                            {message.text}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
