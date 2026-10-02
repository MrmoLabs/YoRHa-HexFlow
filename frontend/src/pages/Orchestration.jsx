import React, { useState, useEffect, useMemo, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import Canvas from '../components/editor/Canvas';
import RecipeEditor from '../components/editor/RecipeEditor';
import NieRModal from '../components/ui/NieRModal';
import { api } from '../api';
import { mergeProtocolInstruction, buildLanes, getTotalBytes, countSlots, normalizeInstructionBlocks } from '../utils/blockMerge';
import { InstructionEncoder } from '../utils/InstructionEncoder';
import { toFrameBlocks } from '../utils/toFrameBlocks';
import { triggerBlobDownload } from '../utils/download';

// E4 编排绑定持久化：绑定列表接后端 /bindings CRUD（新表 protocol_bindings）。
// 行为口径（反馈 #4 改手动）：挂载 GET 对账 → 空表种默认绑定（服务端也 POST
// 一份）→ 加/删/星标即时写；属性编辑（label/协议/指令/洞位）只进本地草稿并
// 标脏，「保存更改 (SAVE)」逐行 PUT（原 400ms 防抖 + 卸载冲刷退役，改
// beforeunload 拦截）；加载失败降级纯本地编辑（提示条，不写后端）。props
// 到位后回填缺失 id 并补写。

// 本地态 ⇄ API 载荷（snake_case 出线，字段与 backend/schemas/binding_api.py 对齐）
const toServer = (binding) => ({
    id: binding.id,
    protocol_id: binding.protocolId || '',
    instruction_id: binding.instructionId || '',
    label: binding.label || '',
    // B2: 组内稠密位次出线（本地缺省按 0，服务端列默认 0 对齐）
    slot_order: binding.slotOrder ?? 0,
    // 批次一 (D1 一行两用): 显式槽 id（null=按位次）/ 指令默认封装星标 / 优先级
    slot_id: binding.slotId || null,
    is_default: Boolean(binding.isDefault),
    priority: binding.priority ?? 0
});

const toLocal = (row) => ({
    id: row.id,
    label: row.label,
    protocolId: row.protocol_id,
    instructionId: row.instruction_id,
    slotOrder: row.slot_order,
    slotId: row.slot_id ?? null,
    isDefault: Boolean(row.is_default),
    priority: row.priority ?? 0,
    // CP3 3d (D7-A): 失效徽标 —— true = 协议链在绑定落库后已变（出徽标），
    // false = 仍匹配 / null = 无出处（手工·存量）→ 均不出徽标。
    stale: row.stale ?? null
});

const syncErrorText = (prefix, err) => `${prefix}：${err?.message || '后端不可用'}`;

// CP3 3b (D13): 配方本地态 ⇄ 服务端行。stages 深拷贝（改草稿不污染已加载行，
// 放弃时可安全重取）；`definition_hash` 由**服务端**算并回写（§9.5-1），草稿里
// 只随行保留，出线时剥除（客户端传了也会被忽略，不发更干净）。
const cloneStages = (stages) => (stages || []).map(stage => ({
    protocol_id: stage.protocol_id,
    ...(stage.slot_ids && stage.slot_ids.length ? { slot_ids: [...stage.slot_ids] } : {}),
    ...(stage.definition_hash ? { definition_hash: stage.definition_hash } : {})
}));

const cloneRecipe = (row) => ({
    id: row.id,
    name: row.name || '',
    description: row.description ?? null,
    stages: cloneStages(row.stages),
    // 加工页降级链第 1 级要按它反查（instructions.default_recipe_id）
    instructionId: row.instruction_id || '',
    version: row.version ?? 1
});

const stagesToServer = (stages) => (stages || []).map(stage => ({
    protocol_id: stage.protocol_id,
    ...(stage.slot_ids && stage.slot_ids.length ? { slot_ids: stage.slot_ids } : {})
}));

export default function Orchestration({ protocols, instructions }) {
    // State for Bindings (Mappings)
    const [bindings, setBindings] = useState([]);
    const [activeBindingId, setActiveBindingId] = useState(null);
    const [isExporting, setIsExporting] = useState(false);
    const [exportMsg, setExportMsg] = useState('');
    // C1 封装试发：发送中闸 + 回显（SENT: hex / SEND FAILED: detail 含 409）
    const [isSending, setIsSending] = useState(false);
    const [sendMsg, setSendMsg] = useState('');
    // 批次二 (D3): 封装期溢出/欠载告警（append/zero_fill 路径不阻断，但不得静默）
    // —— 从 sendMsg 文本里拆出来，独立琥珀徽标渲染。
    const [sendWarnings, setSendWarnings] = useState([]);
    // 人工验证反馈 1: 星标设默认须经点击确认环节 → 待确认的绑定 id（null = 无）
    const [starConfirmId, setStarConfirmId] = useState(null);
    const [loaded, setLoaded] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    const [syncMsg, setSyncMsg] = useState('');

    // CP3 3b (D13): 编排页配方编辑器 —— 列表挂载拉取 + 单份本地草稿 + 手动保存
    // （沿本页 SAVE 范式）。脏时禁切换/禁新建（单份草稿无处驻留，防静默丢稿）。
    const [recipes, setRecipes] = useState([]);
    const [activeRecipeId, setActiveRecipeId] = useState('');
    const [recipeDraft, setRecipeDraft] = useState(null);
    const [recipeDirty, setRecipeDirty] = useState(false);
    const [recipeSaving, setRecipeSaving] = useState(false);
    const [recipeLoaded, setRecipeLoaded] = useState(false);
    const [recipeMsg, setRecipeMsg] = useState(null);      // {text, ok} | null
    const [recipeDeleteId, setRecipeDeleteId] = useState(null);
    const recipeDirtyRef = useRef(false);
    recipeDirtyRef.current = recipeDirty;

    // 反馈 #4 手动保存：脏行 id 集合（属性编辑草稿）—— SAVE 逐行落库；
    // 星标/增删等即时写成功也会出队同行（PUT 即落库）。
    const [dirtyIds, setDirtyIds] = useState(() => new Set());
    const hasUnsavedChanges = dirtyIds.size > 0;
    const dirtyRef = useRef(false);
    dirtyRef.current = hasUnsavedChanges;
    // 行内容实时镜像：PUT 成功回调比对「已发载荷 vs 当前行」，保存期间又编辑
    // 的行不误出队（留脏待再存）；行已删则清脏 id。
    const bindingsRef = useRef(bindings);
    bindingsRef.current = bindings;

    const clearDirty = (id, sentPayload) => {
        const row = bindingsRef.current.find(b => b.id === id);
        const unchanged = row && JSON.stringify(toServer(row)) === JSON.stringify(sentPayload);
        if (!row || unchanged) {
            setDirtyIds(prev => {
                if (!prev.has(id)) return prev;
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    const putBinding = (payload) =>
        api.updateBinding(payload.id, payload)
            .then(() => clearDirty(payload.id, payload))
            .catch((err) => setSyncMsg(syncErrorText('更新失败', err)));

    // 1) 挂载拉取服务端绑定；失败降级本地编辑并提示
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const rows = await api.getBindings();
                if (!alive) return;
                setBindings(rows.map(toLocal));
                if (rows.length) setActiveBindingId(rows[0].id);
                setSyncMsg('');
            } catch (err) {
                if (!alive) return;
                setLoadFailed(true);
                setSyncMsg(syncErrorText('加载失败', err) + '（本地编辑不持久化）');
            } finally {
                if (alive) setLoaded(true);
            }
        })();
        return () => { alive = false; };
    }, []);

    // 1b) CP3 3b: 挂载拉取配方列表（GET /recipes 全量）—— 失败只提示，不阻断
    // 绑定编辑与组协议试发（未建配方时试发仍走现状组协议路径，逐字节不变）。
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const rows = await api.getRecipes();
                if (!alive) return;
                setRecipes(Array.isArray(rows) ? rows : []);
            } catch (err) {
                if (!alive) return;
                setRecipeMsg({ text: syncErrorText('配方加载失败', err) + '（新建/保存可能不可用）', ok: false });
            } finally {
                if (alive) setRecipeLoaded(true);
            }
        })();
        return () => { alive = false; };
    }, []);

    // 2) 加载完成后空表种默认绑定：服务端空则同步 POST 落库；加载失败仅本地
    useEffect(() => {
        if (!loaded || bindings.length) return;
        const initial = {
            id: uuidv4(),
            label: '默认绑定 (DEFAULT)',
            protocolId: protocols[0]?.id || '',
            instructionId: instructions[0]?.id || '',
            slotOrder: 0
        };
        setBindings([initial]);
        setActiveBindingId(initial.id);
        if (!loadFailed) {
            api.createBinding(toServer(initial))
                .catch((err) => setSyncMsg(syncErrorText('创建失败', err)));
        }
    }, [loaded, loadFailed, bindings.length, protocols, instructions]);

    // 3) props 到位后回填缺失的 protocol/instruction id，并补写服务端
    useEffect(() => {
        if (!loaded || !bindings.length) return;
        const changed = [];
        const next = bindings.map((binding) => {
            const protocolId = binding.protocolId || protocols[0]?.id || '';
            const instructionId = binding.instructionId || instructions[0]?.id || '';
            if (protocolId === binding.protocolId && instructionId === binding.instructionId) {
                return binding;
            }
            const merged = { ...binding, protocolId, instructionId };
            changed.push(merged);
            return merged;
        });
        if (!changed.length) return;
        setBindings(next);
        if (!loadFailed) {
            changed.forEach((binding) => {
                api.updateBinding(binding.id, toServer(binding))
                    .catch((err) => setSyncMsg(syncErrorText('更新失败', err)));
            });
        }
    }, [loaded, loadFailed, instructions, protocols, bindings]);

    // 反馈 #4：未保存属性编辑的刷新拦截（事件时读 ref）。卸载不再自动冲刷 ——
    // 手动保存语义，脏行草稿跨选中驻留本地（切换绑定行不丢），刷新即弃（由
    // 本拦截兜底提示）。CP3 3b: 配方草稿同口径纳入拦截（离开即弃）。
    useEffect(() => {
        const onBeforeUnload = (e) => {
            if (dirtyRef.current || recipeDirtyRef.current) {
                e.preventDefault();
                e.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, []);

    const currentBinding = bindings.find(b => b.id === activeBindingId) || bindings[0];

    // B3 稠密位次：组内成员变更（加/删/换洞）→ 重编号 0..n-1，仅回写真变化行；
    // 挂载不调用（零回写零钳制，服务端行原样显示）。
    const renumberGroup = (base, protocolId) => {
        const group = base
            .filter(b => b.protocolId === protocolId)
            .slice()
            .sort((a, b) => (a.slotOrder ?? 0) - (b.slotOrder ?? 0));
        const numbered = group.map((b, i) => ({ ...b, slotOrder: i }));
        const byId = new Map(numbered.map(b => [b.id, b]));
        const next = base.map(b => byId.get(b.id) || b);
        const changed = numbered.filter((b, i) => (group[i].slotOrder ?? 0) !== i);
        return { next, changed };
    };

    // CRUD Handlers（本地态即时反馈，服务端写入按上方口径）
    const handleAddBinding = () => {
        const protocolId = protocols[0]?.id || '';
        const newBinding = {
            id: uuidv4(),
            label: '新绑定 (NEW)',
            protocolId,
            instructionId: instructions[0]?.id || '',
            // 组内追加：先占组尾洞号，renumberGroup 再落稠密位次
            slotOrder: bindings.filter(b => b.protocolId === protocolId).length
        };
        const base = [...bindings, newBinding];
        const { next, changed } = renumberGroup(base, protocolId);
        const posted = next.find(b => b.id === newBinding.id) || newBinding;
        setBindings(next);
        setActiveBindingId(newBinding.id);
        if (loadFailed) return;
        api.createBinding(toServer(posted))
            .catch((err) => setSyncMsg(syncErrorText('创建失败', err)));
        // 组内老行位次被挤动 → 补写（新行随 createBinding 出线，不重复 PUT）
        changed
            .filter(b => b.id !== newBinding.id)
            .forEach(b => putBinding(toServer(b)));
    };

    const handleDeleteBinding = (e, id) => {
        e.stopPropagation();
        if (bindings.length <= 1) return;
        const target = bindings.find(b => b.id === id);
        const base = bindings.filter(b => b.id !== id);
        const { next, changed } = target
            ? renumberGroup(base, target.protocolId)
            : { next: base, changed: [] };
        setBindings(next);
        if (activeBindingId === id) setActiveBindingId(next[0].id);
        if (loadFailed) return;
        api.deleteBinding(id)
            .catch((err) => setSyncMsg(syncErrorText('删除失败', err)));
        changed.forEach(b => putBinding(toServer(b)));
    };

    // 批次一 (D1 一行两用): 星标 = 指令默认封装绑定（is_default 出线，加工页
    // wrap 状态机读它）。服务端 PUT 同事务清同指令旧默认（部分唯一索引兜底）
    // → 本地同步清星、被清行不再回写（DB 已是 0）。
    // 人工验证反馈 1: 设默认 = 改变绑定关系语义 → 点击先开确认弹窗（确认才
    // 落库）；取消默认是低风险逆操作 → 直执行不弹。
    const handleToggleDefault = (e, id) => {
        e.stopPropagation();
        const target = bindings.find(b => b.id === id);
        if (!target) return;
        if (!target.isDefault) {
            setStarConfirmId(id);
            return;
        }
        applyStarConfirm(id);
    };

    // 确认弹窗「确认」回调：执行星标翻转（设默认/取消默认同一落库路径）。
    const applyStarConfirm = (id) => {
        setStarConfirmId(null);
        const target = bindings.find(b => b.id === id);
        if (!target) return;
        const makeDefault = !target.isDefault;
        const next = bindings.map(b => {
            if (b.id === id) return { ...b, isDefault: makeDefault };
            if (makeDefault && b.isDefault && b.instructionId === target.instructionId) {
                return { ...b, isDefault: false };
            }
            return b;
        });
        setBindings(next);
        if (loadFailed) return;
        const starred = next.find(b => b.id === id);
        putBinding(toServer(starred));
    };

    // B3 洞位下拉：组内换位（目标位次钳在 0..组内余数）→ 稠密重编号 → 回写变化行
    const handleSlotOrderChange = (targetIndex) => {
        if (!currentBinding) return;
        const group = bindings
            .filter(b => b.protocolId === currentBinding.protocolId)
            .slice()
            .sort((a, b) => (a.slotOrder ?? 0) - (b.slotOrder ?? 0));
        const without = group.filter(b => b.id !== currentBinding.id);
        const at = Math.max(0, Math.min(Number(targetIndex), without.length));
        const reordered = [...without.slice(0, at), currentBinding, ...without.slice(at)]
            .map((b, i) => ({ ...b, slotOrder: i }));
        const byId = new Map(reordered.map(b => [b.id, b]));
        setBindings(prev => prev.map(b => byId.get(b.id) || b));
        if (loadFailed) return;
        // 反馈 #4：换洞 = 组内多行草稿 —— 标脏不即时 PUT，SAVE 逐行落库
        setDirtyIds((prev) => {
            const next = new Set(prev);
            reordered.forEach((b) => {
                const before = bindings.find(x => x.id === b.id);
                if ((before?.slotOrder ?? 0) !== b.slotOrder) next.add(b.id);
            });
            return next;
        });
    };

    // ── CP3 3b (D13): 配方编辑器回调 ──────────────────────────────────────
    // 选择配方：服务端行拷成草稿（深拷贝 → 放弃不污染已加载行）。脏时组件已禁
    // 选择器，此处再兜底一次，防键盘/直达路径丢稿。
    const handleSelectRecipe = (id) => {
        if (recipeDirty) return;
        const row = recipes.find(r => r.id === id);
        if (!row) {
            setActiveRecipeId('');
            setRecipeDraft(null);
            setRecipeDirty(false);
            return;
        }
        setActiveRecipeId(row.id);
        setRecipeDraft(cloneRecipe(row));
        setRecipeDirty(false);
        setRecipeMsg(null);
    };

    // 新建：沿本页「空表种默认绑定」先例 —— 立即 POST 落库（不是本地草稿），
    // 之后编辑一律 PUT + version 乐观并发；id 前端 uuid（protocol.py 先例）。
    const handleCreateRecipe = async () => {
        if (!recipeLoaded || recipeDirty || recipeSaving || !protocols.length) return;
        setRecipeSaving(true);
        setRecipeMsg(null);
        try {
            const row = await api.createRecipe({
                id: uuidv4(),
                name: `新配方 (NEW) ${recipes.length + 1}`,
                stages: [{ protocol_id: protocols[0].id }]
            });
            setRecipes(prev => [...prev, row]);
            setActiveRecipeId(row.id);
            setRecipeDraft(cloneRecipe(row));
            setRecipeDirty(false);
            setRecipeMsg({ text: `已新建 (CREATED) v${row.version}`, ok: true });
        } catch (err) {
            setRecipeMsg({ text: syncErrorText('新建失败', err), ok: false });
        } finally {
            setRecipeSaving(false);
        }
    };

    const handleRecipeStagesChange = (stages) => {
        setRecipeDraft(prev => (prev ? { ...prev, stages } : prev));
        setRecipeDirty(true);
    };

    const handleRecipeNameChange = (name) => {
        setRecipeDraft(prev => (prev ? { ...prev, name } : prev));
        setRecipeDirty(true);
    };

    // 关联指令 = 加工页降级链第 1 级的读入口（GET /recipes?instruction_id=）。
    // 只进草稿，随 SAVE 落库（None 不改 / "" 解除，服务端同口径）。
    const handleRecipeLinkChange = (instructionId) => {
        setRecipeDraft(prev => (prev ? { ...prev, instructionId } : prev));
        setRecipeDirty(true);
    };

    // 手动保存：PUT 走 version 乐观并发（不符 409 透出）。
    // 换绑须**先清旧指针再设新指针** —— _link_instruction 只写目标指令行、不回清
    // 旧指针，直接设新会让旧指令继续指向本配方（RecipeResponse「0 或 1 条」破）。
    const handleSaveRecipe = async () => {
        if (!recipeDraft || !recipeDirty || recipeSaving) return;
        setRecipeSaving(true);
        const serverRow = recipes.find(r => r.id === recipeDraft.id);
        const base = {
            name: recipeDraft.name,
            description: recipeDraft.description ?? null,
            stages: stagesToServer(recipeDraft.stages)
        };
        const oldLink = serverRow?.instruction_id || '';
        const newLink = recipeDraft.instructionId || '';
        try {
            let row;
            if (oldLink && newLink && oldLink !== newLink) {
                const cleared = await api.updateRecipe(recipeDraft.id, { instruction_id: '' });
                setRecipes(prev => prev.map(r => (r.id === cleared.id ? cleared : r)));
                row = await api.updateRecipe(recipeDraft.id, {
                    ...base, instruction_id: newLink, version: cleared.version
                });
            } else {
                row = await api.updateRecipe(recipeDraft.id, {
                    ...base,
                    ...(oldLink !== newLink ? { instruction_id: newLink } : {}),
                    version: serverRow?.version
                });
            }
            setRecipes(prev => prev.map(r => (r.id === row.id ? row : r)));
            setRecipeDraft(cloneRecipe(row));
            setRecipeDirty(false);
            setRecipeMsg({ text: `已保存 (SAVED) v${row.version}`, ok: true });
        } catch (err) {
            setRecipeMsg({ text: syncErrorText('配方保存失败', err), ok: false });
        } finally {
            setRecipeSaving(false);
        }
    };

    // 删除：服务端同事务解除指向本配方的指令关联（回执 cleared_instructions）
    const handleDeleteRecipe = async (id) => {
        setRecipeDeleteId(null);
        if (recipeSaving) return;
        try {
            const res = await api.deleteRecipe(id);
            setRecipes(prev => prev.filter(r => r.id !== id));
            if (activeRecipeId === id) {
                setActiveRecipeId('');
                setRecipeDraft(null);
                setRecipeDirty(false);
            }
            setRecipeMsg({
                text: res?.cleared_instructions
                    ? `已删除 · 解除 ${res.cleared_instructions} 条指令关联`
                    : '已删除 (DELETED)',
                ok: true
            });
        } catch (err) {
            setRecipeMsg({ text: syncErrorText('删除失败', err), ok: false });
        }
    };

    // 当前生效配方（未选 = null → 试发走组协议现状路径）；显示名优先取草稿
    // （改名未保存时头部指示要即时跟随，否则指示与实际出线对不上）
    const activeRecipe = recipes.find(r => r.id === activeRecipeId) || null;
    const wrapRecipeName = recipeDraft ? recipeDraft.name : (activeRecipe?.name || '');

    // C1 封装试发（批次一 D4 改线 → 批次二 D14③ 再改线）：逐指令前端编码内核
    // hex（normalizeInstructionBlocks → getInitialValues → resolveDependencies →
    // encodeInstruction，与加工页同链路）→ **带 wrap 直接 POST /dispatch**，
    // 后端逐条转义内核 → 再套壳（与单条 wrap 同层位）。
    // 此前是先 POST /compile/wrapped 套完壳再裸发整帧，escape 开启时会把整帧当
    // 内核转义，与带 wrap 的「只转内核」语义不同（两路径出字节不同）。
    // record.hex_string = 实际出线帧；record.warnings = 溢出/欠载告警（琥珀徽标）。
    const handleTrialSend = async () => {
        // 配方有未保存更改 → 禁发：后端只认已落库配方，带脏稿试发会出「预想与
        // 出线不一致」的静默错帧（本批正是为防这个）
        if (!mergedBlocks.length || isSending || recipeDirty) return;
        setIsSending(true);
        setSendMsg('');
        setSendWarnings([]);
        try {
            const group = groupBindings
                .map(b => ({ binding: b, instruction: instructions.find(i => i.id === b.instructionId) }))
                .filter(g => g.instruction);
            const payloads = group.map(({ instruction }) => {
                const source = { blocks: normalizeInstructionBlocks(instruction) };
                const inputs = InstructionEncoder.getInitialValues(source);
                const computed = InstructionEncoder.resolveDependencies(source, inputs);
                const { hexString } = InstructionEncoder.encodeInstruction(source, inputs, computed);
                return hexString.replace(/\s/g, '');
            });
            const instructionName = selectedInstruction?.label || selectedInstruction?.name || null;
            const record = await api.dispatchWrappedGroup(
                activeRecipe
                    // CP3 3b (D13): 选中配方 → 试发走配方，后端逐层串行套壳，与
                    // 加工页预览/TRANSMIT 同一份 core/recipe_compile → 同字节。
                    // 槽位与层序归配方阶段所有，**不下发 slot_ids/start_order**。
                    ? { recipeId: activeRecipe.id, payloads, instructionName }
                    // 未选配方 → 组协议现状路径（批次二 D14③ 层位口径，逐字节不变）
                    : {
                        protocolId: currentBinding.protocolId,
                        payloads,
                        slotIds: group.map(({ binding }) => binding.slotId || null),
                        startOrder: 0,
                        instructionName
                    }
            );
            setSendMsg(`SENT: ${record.hex_string}`);
            setSendWarnings(record.warnings || []);
        } catch (err) {
            setSendMsg(`SEND FAILED: ${err?.message || 'UNKNOWN'}`);
        } finally {
            setIsSending(false);
        }
    };

    // 反馈 #4 手动保存：属性编辑（label/协议/指令）只进本地并标脏 —— 去 400ms
    // 防抖与即时 PUT，「保存更改 (SAVE)」handleSaveBindings 统一落库。
    // 草稿按行驻留：切换选中绑定不丢（无需切行确认）。
    const handleUpdateBinding = (id, updates) => {
        setBindings(prev => prev.map(b => b.id === id ? { ...b, ...updates } : b));
        if (loadFailed) return; // 降级模式：本地编辑不持久化（提示条已说明）
        setDirtyIds(prev => new Set(prev).add(id));
    };

    // 反馈 #4：SAVE 按钮落库 —— 逐行 PUT 当前脏行（幂等），成功行出队
    // （putBinding 回调比对载荷防误清），失败留队 + 顶部错误提示可重试。
    const handleSaveBindings = () => {
        if (!dirtyIds.size || loadFailed) return;
        bindings
            .filter(b => dirtyIds.has(b.id))
            .forEach((b) => putBinding(toServer(b)));
    };

    // B2 组作用域合并：组 = 同 protocolId 的绑定按 slot_order（洞号）升序 →
    // 指令数组依洞序填洞；指令缺失的行跳过（filter(Boolean)）。单绑定退化为
    // E4 原语义（数组长度 1 走同一路径）。
    const groupBindings = useMemo(() => {
        if (!currentBinding) return [];
        return bindings
            .filter(b => b.protocolId === currentBinding.protocolId)
            .slice()
            .sort((a, b) => (a.slotOrder ?? 0) - (b.slotOrder ?? 0));
    }, [bindings, currentBinding]);

    const mergedBlocks = useMemo(() => {
        if (!currentBinding) return [];
        const protocol = protocols.find(p => p.id === currentBinding.protocolId);
        const groupInstructions = groupBindings
            .map(b => instructions.find(i => i.id === b.instructionId))
            .filter(Boolean);
        return mergeProtocolInstruction(protocol, groupInstructions);
    }, [currentBinding, groupBindings, instructions, protocols]);

    // B3 洞位/对账：洞号 = 当前绑定在组内的稠密位次；洞数 = 协议树 DFS slot 计数。
    const holeRank = Math.max(0, groupBindings.findIndex(b => b.id === currentBinding?.id));
    const holeCount = useMemo(() => {
        const protocol = protocols.find(p => p.id === currentBinding?.protocolId);
        return countSlots(protocol?.children || []);
    }, [protocols, currentBinding?.protocolId]);
    const holeWarning = !currentBinding
        ? ''
        : holeCount === 0
            ? '无 SLOT：指令将追加末尾'
            : groupBindings.length > holeCount
                ? `洞位不足：${groupBindings.length} 条绑定 > ${holeCount} 个洞（溢出追加末尾）`
                : groupBindings.length < holeCount
                    ? `空洞：${holeCount - groupBindings.length} 个洞未被绑定填充`
                    : '';

    // 侧栏按（协议序, 洞号）重排：协议序 = protocols 数组序；服务端 GET /bindings
    // 仍全局 slot_order 排，前端不按全局洞号穿插跨协议绑定。
    const sortedBindings = useMemo(() => {
        const protoIndex = (b) => {
            const i = protocols.findIndex(p => p.id === b.protocolId);
            return i === -1 ? protocols.length : i;
        };
        return [...bindings].sort((a, b) => protoIndex(a) - protoIndex(b)
            || ((a.slotOrder ?? 0) - (b.slotOrder ?? 0)));
    }, [bindings, protocols]);

    const mergedLanes = useMemo(() => buildLanes(mergedBlocks), [mergedBlocks]);

    const totalBytes = getTotalBytes(mergedBlocks);
    const selectedInstruction = instructions.find(i => i.id === currentBinding?.instructionId);

    // Export merged blocks as .bin (server-side compile via Orchestrator)
    const handleExportBinary = async () => {
        if (!mergedBlocks.length || isExporting) return;
        setIsExporting(true);
        setExportMsg('');
        try {
            const bindingLabel = (currentBinding?.label || 'binding').replace(/[^\w.-]+/g, '_');
            const blob = await api.exportBinaryFromBlocks(toFrameBlocks(mergedBlocks), `${bindingLabel}.bin`);
            triggerBlobDownload(blob, `${bindingLabel}.bin`);
            setExportMsg('EXPORT OK');
        } catch (err) {
            setExportMsg(`EXPORT FAILED: ${err?.message || 'UNKNOWN'}`);
        } finally {
            setIsExporting(false);
        }
    };

    return (
        <div className="flex-1 flex overflow-hidden">
            {/* Binding List Sidebar */}
            <aside className="w-48 border-r border-nier-light/30 bg-nier-dark/50 flex flex-col">
                <div className="p-4 border-b border-nier-light/30 flex justify-between items-center">
                    <span className="text-xs font-bold tracking-widest">绑定列表 (Bindings)</span>
                    <button onClick={handleAddBinding} className="hover:text-white text-lg leading-none">+</button>
                </div>
                {syncMsg && (
                    <div className="px-3 py-2 border-b border-nier-light/20 text-[10px] font-mono text-red-300 break-all">
                        {syncMsg}
                    </div>
                )}
                <div className="flex-1 overflow-y-auto">
                    {sortedBindings.map(b => (
                        <div
                            key={b.id}
                            onClick={() => setActiveBindingId(b.id)}
                            className={`p-3 border-b border-nier-light/10 cursor-pointer hover:bg-white/5 flex justify-between group ${b.id === activeBindingId ? 'bg-nier-light/10 text-white font-bold' : 'text-nier-light/70'}`}
                        >
                            <div className="truncate text-xs">
                                {/* 人工验证 #6①: 脏行琥珀点（title 供定位/无障碍）；放 label
                                    文本节点之前——RTL getByText 只取直接文本节点，脏行 label 仍可查 */}
                                {dirtyIds.has(b.id) && (
                                    <span title="有未保存更改" className="text-[#E58D28] mr-1">●</span>
                                )}
                                {b.label}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                                {/* CP3 3d (D7-A): 绑定失效徽标 —— 仅 stale === true 渲染
                                    （false/null/未回执 = 不出）；span 在删除钮之前但非 button，
                                    不影响行内「首个 button = 删除」的既有取法 */}
                                {b.stale === true && (
                                    <span
                                        data-testid="binding-stale"
                                        title="协议链已变更 — 绑定定义可能已失效 (STALE)"
                                        className="border border-[#E58D28]/60 px-1 py-0.5 text-[8px] font-mono tracking-widest text-[#FFB74D] whitespace-nowrap leading-none"
                                    >
                                        绑定已失效 STALE
                                    </span>
                                )}
                                <button onClick={(e) => handleDeleteBinding(e, b.id)} className="opacity-0 group-hover:opacity-100 hover:text-red-400">×</button>
                                {/* 批次一 (D1): 星标 = 指令默认封装绑定（is_default）——放删除之后 */}
                                <button
                                    type="button"
                                    onClick={(e) => handleToggleDefault(e, b.id)}
                                    title={b.isDefault ? '取消默认封装 (UNSTAR)' : '设为指令默认封装 (STAR)'}
                                    aria-pressed={Boolean(b.isDefault)}
                                    className={b.isDefault
                                        ? 'text-yellow-400 leading-none'
                                        : 'opacity-0 group-hover:opacity-100 text-nier-light/50 hover:text-yellow-400 leading-none'}
                                >
                                    {b.isDefault ? '★' : '☆'}
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
                <div className="p-2 border-t border-nier-light/20 text-[9px] font-mono opacity-40 tracking-widest text-center">
                    PERSIST // /bindings CRUD
                </div>
            </aside>

            {/* Main Area */}
            {/* 人工验证第 3 轮 #5: 中心区可收缩——flex item 的 min-width:auto
                仅在 overflow:visible 时取内容最小尺寸，补 overflow-hidden +
                min-w-0 后分栏不再把右栏挤出视口（对齐协议/指令页 section）。 */}
            <section className="flex-1 min-w-0 overflow-hidden flex flex-col bg-[url('/grid.png')] relative">
                {/* Configuration Header — #6②: 结构选择（协议外壳/指令内核）
                    下沉到右侧属性面板「结构选择」分区；头部只留 总长度 + 导出/试发。 */}
                <div className="h-16 border-b border-nier-light/50 bg-nier-dark/90 flex items-center px-4 gap-8 z-20">
                    {currentBinding && (
                        <>
                            <div className="ml-auto flex flex-col items-end">
                                <label className="text-[10px] opacity-70 uppercase tracking-widest">总长度 (Total Size)</label>
                                <div className="text-xl font-bold font-mono">{totalBytes} <span className="text-sm font-normal opacity-50">Bytes</span></div>
                                <div className="flex gap-2 mt-1 items-center">
                                    {/* CP3 3b (D13): 试发 wrap 来源指示 —— 有配方走配方
                                        （逐层串行套壳），否则走组协议现状路径 */}
                                    <span
                                        data-testid="trial-wrap-source"
                                        title={activeRecipe
                                            ? `配方 ${wrapRecipeName} · ${activeRecipe.stages?.length || 0} 层（后端逐层套壳）`
                                            : '组协议（当前绑定的协议外壳）'}
                                        className={`text-[9px] font-mono tracking-widest min-w-0 max-w-[10rem] truncate ${activeRecipe ? 'text-[#E58D28]' : 'opacity-60'}`}
                                    >
                                        WRAP :: {activeRecipe ? `配方 ${wrapRecipeName}` : '组协议'}
                                    </span>
                                    <button
                                        onClick={handleExportBinary}
                                        disabled={!mergedBlocks.length || isExporting}
                                        className="border border-nier-light/60 text-nier-light text-[10px] font-mono tracking-widest px-3 py-1 hover:bg-nier-light hover:text-nier-dark transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {isExporting ? 'EXPORTING...' : 'EXPORT .BIN'}
                                    </button>
                                    {/* C1 封装试发：同合并树前端编码 → 带 wrap POST /dispatch
                                        （批次二 D14③：后端先转义内核再套壳）；CP3 3b 起有
                                        配方时改带 recipe_id，配方脏稿则禁发 */}
                                    <button
                                        onClick={handleTrialSend}
                                        disabled={!mergedBlocks.length || isSending || recipeDirty}
                                        title={recipeDirty
                                            ? '配方有未保存更改 — 先保存 (SAVE) 再试发'
                                            : (activeRecipe ? `试发走配方：${wrapRecipeName}` : '试发走组协议')}
                                        className="border border-nier-light/60 text-nier-light text-[10px] font-mono tracking-widest px-3 py-1 hover:bg-nier-light hover:text-nier-dark transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {isSending ? 'SENDING...' : '封装试发 (TRIAL SEND)'}
                                    </button>
                                </div>
                                {exportMsg && (
                                    <div className={`text-[9px] font-mono mt-0.5 ${exportMsg === 'EXPORT OK' ? 'text-green-400' : 'text-red-400'}`}>
                                        {exportMsg}
                                    </div>
                                )}
                                {sendMsg && (
                                    <div className={`text-[9px] font-mono mt-0.5 break-all ${sendMsg.startsWith('SENT') ? 'text-green-400' : 'text-red-400'}`}>
                                        {sendMsg}
                                    </div>
                                )}
                                {/* 批次二 (D3): 封装告警琥珀徽标 —— append/zero_fill
                                    路径不阻断但不静默；reject 走 SEND FAILED 红字 */}
                                {sendWarnings.length > 0 && (
                                    <div className="mt-1 flex flex-col gap-0.5" data-testid="trial-send-warnings">
                                        {sendWarnings.map((w, i) => (
                                            <span
                                                key={`send-warn-${i}`}
                                                className="border border-yellow-500/50 text-yellow-400 text-[9px] font-mono tracking-widest px-1.5 py-0.5 break-all"
                                            >
                                                ⚠ {w}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Visual Preview */}
                <div className="flex-1 overflow-hidden relative flex flex-col">
                    <div className="absolute top-4 left-6 text-xs font-mono opacity-50 tracking-widest">
                        ASSEMBLY PREVIEW //
                        {protocols.find(p => p.id === currentBinding?.protocolId)?.label} ::
                        {selectedInstruction?.label || selectedInstruction?.name}
                    </div>

                    <Canvas
                        lanes={mergedLanes}
                        onMoveItem={() => { }}
                        selectedId={null}
                        onSelect={() => { }}
                        isReadOnly={true}
                        focusedParentId={null}
                        onSetFocusedLane={() => { }}
                    />
                </div>

                {/* Footer / Hex Dump Preview */}
                <div className="h-32 border-t border-nier-light/50 bg-nier-dark/95 p-4 font-mono text-xs overflow-y-auto">
                    <div className="opacity-50 mb-2 tracking-widest uppercase">Hex Stream Simulation</div>
                    <div className="break-all leading-relaxed opacity-80">
                        {/* Mock Hex Stream based on structure */}
                        {mergedBlocks.map((b, i) => (
                            <span key={i} className={`mr-2 ${b.isInjected ? 'text-yellow-400 font-bold' : ''}`}>
                                {b.children?.length ? `[${b.label}]` : (b.hex_value || '00'.repeat(b.byte_length || 0)).toUpperCase()}
                            </span>
                        ))}
                    </div>
                    <div className="mt-2 text-[10px] text-yellow-400 opacity-70">* Yellow indicates injected Payload</div>
                </div>
            </section>

            {/* Right Panel (Details - Binding Info) */}
            {/* 人工验证 #5: 属性栏 shrink-0 不被中心区挤压；overflow-y-auto 保证
                面板加高（四分区 + 底部动作区）后 SAVE 仍可滚动可达。 */}
            <aside className="w-80 shrink-0 overflow-y-auto border-l border-nier-light bg-nier-dark/95 p-4 flex flex-col z-20 shadow-[-5px_0_15px_rgba(0,0,0,0.1)]">
                <h2 className="text-lg border-b-2 border-nier-light mb-6 pb-1 font-bold tracking-wider">绑定属性 (BINDING)</h2>

                {currentBinding && (
                    <div className="space-y-6 text-sm">
                        {/* 分区 1/5 绑定标识 —— label 输入草稿 */}
                        <div>
                            <div className="text-[9px] opacity-50 border-b border-white/10 pb-1 mb-2">绑定标识 (IDENTITY)</div>
                            <div className="flex flex-col gap-1">
                                <label className="text-xs opacity-70 uppercase tracking-widest">绑定名称 (Label)</label>
                                <input
                                    type="text"
                                    value={currentBinding.label}
                                    onChange={(e) => handleUpdateBinding(currentBinding.id, { label: e.target.value })}
                                    className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide"
                                />
                            </div>
                        </div>

                        {/* 分区 2/5 结构选择 —— 协议外壳/指令内核从头部下沉（#6②）；
                            DOM 序 = 协议外壳 → 指令内核（select[0] 断言锚点不破） */}
                        <div>
                            <div className="text-[9px] opacity-50 border-b border-white/10 pb-1 mb-2">结构选择 (STRUCTURE)</div>
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] opacity-70 uppercase tracking-widest">协议外壳 (Protocol Shell)</label>
                                <select
                                    value={currentBinding.protocolId}
                                    onChange={(e) => handleUpdateBinding(currentBinding.id, { protocolId: e.target.value })}
                                    className="bg-transparent border-b border-nier-light/50 text-sm focus:outline-none focus:border-nier-light py-1 font-mono"
                                >
                                    {protocols.map(p => <option key={p.id} value={p.id} className="bg-nier-dark text-white">{p.label}</option>)}
                                </select>
                            </div>
                            <div className="flex flex-col gap-1 mt-4">
                                <label className="text-[10px] opacity-70 uppercase tracking-widest">指令内核 (Instruction Kernel)</label>
                                <select
                                    value={currentBinding.instructionId}
                                    onChange={(e) => handleUpdateBinding(currentBinding.id, { instructionId: e.target.value })}
                                    className="bg-transparent border-b border-nier-light/50 text-sm focus:outline-none focus:border-nier-light py-1 font-mono"
                                >
                                    {instructions.map(i => <option key={i.id} value={i.id} className="bg-nier-dark text-white">{i.label || i.name}</option>)}
                                </select>
                            </div>
                        </div>

                        {/* 分区 3/5 洞位 —— B3 洞位下拉（holeRank 标脏）+ 装配规则说明 */}
                        <div>
                            <div className="text-[9px] opacity-50 border-b border-white/10 pb-1 mb-2">洞位 (HOLE)</div>
                            <div className="flex flex-col gap-1">
                                <label htmlFor="hole-rank" className="text-xs opacity-70 uppercase tracking-widest">
                                    洞位 (HOLE) · #{holeRank} / {Math.max(groupBindings.length - 1, 0)}
                                </label>
                                <select
                                    id="hole-rank"
                                    value={holeRank}
                                    onChange={(e) => handleSlotOrderChange(Number(e.target.value))}
                                    className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono"
                                >
                                    {groupBindings.map((b, i) => (
                                        <option key={b.id} value={i} className="bg-nier-dark text-white">
                                            {i}{b.id === currentBinding.id ? ` · 本绑定` : ` · ${b.label}`}
                                        </option>
                                    ))}
                                </select>
                                {holeWarning && (
                                    <div data-testid="hole-warning" className="text-[10px] font-mono text-yellow-400 tracking-widest">
                                        ⚠ {holeWarning}
                                    </div>
                                )}
                            </div>

                            <div className="mt-4 p-4 border border-dashed border-nier-light/30 bg-nier-light/5 text-xs leading-5">
                                <h3 className="font-bold mb-2">AUTO-ASSEMBLY RULE</h3>
                                <p className="opacity-70">
                                    同协议的 {groupBindings.length} 条绑定按洞号（slot_order 升序）依次填入协议的 {holeCount} 个 SLOT。
                                </p>
                                <p className="mt-2 opacity-70">
                                    绑定多于洞时溢出部分追加末尾；洞多于绑定时空洞保留（发射期归零）。
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                {/* 分区 4/5 封装配方 —— CP3 3b (D13)：与绑定无关，恒渲染（未建
                    配方时试发仍走组协议现状路径）。编辑器只上报 stages 意图，落库、
                    version 乐观并发与换绑两步都在 handleSaveRecipe。 */}
                <div className="mt-6 text-sm">
                    <RecipeEditor
                        protocols={protocols}
                        recipes={recipes}
                        activeRecipeId={activeRecipeId}
                        draft={recipeDraft}
                        dirty={recipeDirty}
                        saving={recipeSaving}
                        loaded={recipeLoaded}
                        message={recipeMsg}
                        instructions={instructions}
                        onSelect={handleSelectRecipe}
                        onCreate={handleCreateRecipe}
                        onDelete={(id) => setRecipeDeleteId(id)}
                        onNameChange={handleRecipeNameChange}
                        onLinkChange={handleRecipeLinkChange}
                        onStagesChange={handleRecipeStagesChange}
                        onSave={handleSaveRecipe}
                    />
                </div>

                {/* 分区 5/5 操作 —— #4/#6③: 底部常驻保存区（计数行 + 脏时可用
                    SAVE；mt-auto 贴面板底，镜像指令页动作区）。 */}
                <div className="pt-4 border-t border-nier-light/20 mt-auto space-y-3">
                    <div className="text-[9px] opacity-50 border-b border-white/10 pb-1 mb-2">操作 (ACTIONS)</div>
                    <div className="flex items-center gap-1.5 text-[10px] font-mono tracking-widest">
                        <span aria-hidden="true" className={dirtyIds.size > 0 ? 'text-[#E58D28]' : 'opacity-40'}>●</span>
                        <span className={dirtyIds.size > 0 ? 'text-[#E58D28] font-bold' : 'opacity-40'}>{dirtyIds.size} 条未保存</span>
                    </div>
                    <button
                        onClick={handleSaveBindings}
                        disabled={!hasUnsavedChanges || loadFailed}
                        className="w-full bg-nier-light/10 border border-nier-light text-nier-light hover:bg-nier-light hover:text-black py-2 px-4 uppercase text-xs tracking-widest transition-colors font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        保存更改 (SAVE)
                    </button>
                </div>
            </aside>

            {/* 人工验证反馈 1: 星标设默认确认环节（仅设默认弹；取消默认直执行） */}
            {starConfirmId && (
                <NieRModal
                    isOpen={Boolean(starConfirmId)}
                    message={`确认将「${bindings.find(b => b.id === starConfirmId)?.label || ''}」设为该指令的默认封装绑定？\n\n· 加工页封装发送将使用此绑定的协议外壳\n· 同指令其他绑定的默认标记将被清除（服务端同事务）`}
                    onConfirm={() => applyStarConfirm(starConfirmId)}
                    onCancel={() => setStarConfirmId(null)}
                />
            )}

            {/* CP3 3b: 删配方确认 —— 服务端会同事务解除指向本配方的指令关联
                （回执 cleared_instructions），属改变封装关系语义 → 弹确认 */}
            {recipeDeleteId && (
                <NieRModal
                    isOpen={Boolean(recipeDeleteId)}
                    message={`确认删除配方「${recipes.find(r => r.id === recipeDeleteId)?.name || ''}」？\n\n· 指向该配方的指令关联将被解除（加工页回落到默认协议或裸发）\n· 该操作不可撤销，须重新新建配方`}
                    onConfirm={() => handleDeleteRecipe(recipeDeleteId)}
                    onCancel={() => setRecipeDeleteId(null)}
                />
            )}
        </div>
    );
}
