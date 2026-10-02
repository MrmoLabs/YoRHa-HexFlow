import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { PAGE_STATUS_BY_KEY } from '../config/pageRegistry';
import NieRModal from '../components/ui/NieRModal';
import RunnerFieldTree from '../components/InstructionForm/RunnerFieldTree';
import { normalizeRunnerInstruction } from '../components/InstructionForm/normalizeRunnerInstruction';
import { useInstructionForm } from '../hooks/useInstructionForm';
import { InstructionEncoder } from '../utils/InstructionEncoder';
import { rttText } from '../utils/transactionView';
import {
    buildPlan,
    EMPTY_CONFIG,
    payloadByteCount,
    planSummary,
    progressText,
    reorder,
    resultLabel,
    resultTone,
    shellSummary,
    stepTone
} from '../utils/sequenceView';

// P4 序列编排页（pageStatus 第 7 项 / 快捷键 F）。后端契约见
// backend/routers/sequence.py：定义 CRUD（PUT 整体替换，服务端按数组序重编
// step_order）、启动 404/400/409、停止恒 200 幂等、/status 每 1.5s 轮询；
// 序列运行期定义编辑/删除/启动入口前端禁用（Runner 持内存副本，编辑本不
// 打断运行，禁用是 UX 收敛）。
// 双轨指令处理：表单渲染走 normalized 树（render 语义），编码与计划走 raw
// op_code——normalizeRunnerInstruction 会把 TIME_ACCUMULATOR 映成
// TIME_CUMULATIVE、AUTO_COUNTER 映成 INPUT，只有 raw 才与后端发送时重算
// byte-equal（计划键集严格同形，改一须核对 utils/sequenceView.js）。
// CP3 3c (D6-B) 序列封装帧：步骤可选封装配方（编辑器 RECIPE 选择器）——选中
// 即落草稿步骤 wrap.recipe_id，随 APPLY/保存提交；请求形只收 {recipe_id}
// （definition_hash/stale 属响应形，透传会被 400 未知字段）。有 wrap 的步骤
// payload = 冻结完整封装帧、plan.shell 由后端保存期注入，前端只透传 + 展示
// （shellSummary），不自算外壳；选回「无封装」发 wrap:null，后端自动切回内核。

const toDraft = (row) => ({
    name: row.name || '',
    description: row.description || '',
    stopOnError: row.config?.stop_on_error !== false,
    timeout: row.config?.read_timeout_ms == null ? '' : String(row.config.read_timeout_ms),
    // CP3 3c (D6-B): 步骤 wrap 响应形 {recipe_id, definition_hash, stale} 直落
    // 草稿；null 不落键 —— 键缺席 = 从未封装，保存时不带 wrap（裸帧请求形与
    // 改前逐字节一致，见 saveBody）。
    steps: (row.steps || []).map((s) => {
        const step = { ...s };
        if (!step.wrap) delete step.wrap;
        return step;
    })
});

const saveBody = (draft) => ({
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    config: {
        stop_on_error: draft.stopOnError,
        read_timeout_ms: draft.timeout.trim() === '' ? null : Number(draft.timeout)
    },
    // 服务端字段（id/step_order）剥离：PUT 后后端重建步骤行并重排 step_order
    steps: draft.steps.map((s) => {
        const step = {
            instruction_id: s.instruction_id,
            label: s.label || null,
            delay_ms: Math.min(60000, Math.max(0, Math.trunc(Number(s.delay_ms) || 0))),
            params: s.params ?? null,
            payload: s.payload,
            plan: s.plan ?? null
        };
        // CP3 3c (D6-B): wrap 请求形只收 {recipe_id}（definition_hash/stale 透传
        // 会被 _wrap_spec 400 未知字段）；选回「无封装」→ 显式 null（后端按旧
        // 区间切回内核、剥 plan.shell）；键缺席 = 从未封装 → 不带该键，裸帧
        // 路径请求形与改前逐字节一致。
        if ('wrap' in s) step.wrap = s.wrap ? { recipe_id: s.wrap.recipe_id } : null;
        return step;
    })
});

export default function Sequences() {
    const page = PAGE_STATUS_BY_KEY.sequences;

    const [sequences, setSequences] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [draft, setDraft] = useState(null);
    const [instructions, setInstructions] = useState([]);
    const [recipes, setRecipes] = useState([]); // CP3 3c (D6-B): 步骤 RECIPE 选择器选项
    const [status, setStatus] = useState(null);
    const [loadError, setLoadError] = useState('');
    const [msg, setMsg] = useState('');
    const [busy, setBusy] = useState(''); // create|save|delete|start|stop
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [editorIndex, setEditorIndex] = useState(null);
    const [formInstruction, setFormInstruction] = useState(null);
    const [stepInstructionId, setStepInstructionId] = useState('');
    const [stepLabel, setStepLabel] = useState('');
    const [stepDelay, setStepDelay] = useState('0');

    // raw 编码（hexPreview/byteMap/computedValues 与保存产物同源）+ normalized 渲染
    const renderFields = useMemo(
        () => (formInstruction ? normalizeRunnerInstruction(formInstruction) : null),
        [formInstruction]
    );
    const form = useInstructionForm(formInstruction);

    const fail = (err) => {
        setMsg('');
        setLoadError(err?.message || '请求失败');
    };
    const ok = (text) => {
        setLoadError('');
        setMsg(text);
    };

    const refresh = useCallback(async () => {
        try {
            const rows = await api.listSequences();
            setSequences(rows);
            setLoadError((prev) => (prev.startsWith('GET /sequences') ? '' : prev));
            return rows;
        } catch (err) {
            setLoadError(err?.message || '无法连接后端服务');
            return [];
        }
    }, []);

    // 挂载：列表 + 指令库 + /status 立即拉一拍，此后 1.5s 轮询（卸载清定时器）
    useEffect(() => {
        refresh();
        api.getInstructions()
            .then(setInstructions)
            .catch(() => setInstructions([])); // 取不到指令库 → 步骤编辑禁用（提示可见）
        // CP3 3c (D6-B): 挂载拉一次配方列表（GET /recipes 全量，Orchestration
        // 同款）——失败静默降级空数组：选择器只剩「无封装」，已封装步骤回显
        // id 截断名 + 缺失占位项，不阻断编排。
        api.getRecipes()
            .then(setRecipes)
            .catch(() => setRecipes([]));
        let alive = true;
        const tick = async () => {
            try {
                const snap = await api.getSequenceStatus();
                if (alive) setStatus(snap);
            } catch {
                // 轮询瞬断静默，下一拍重试（列表/操作错误另有横幅）
            }
        };
        tick();
        const timer = setInterval(tick, 1500);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [refresh]);

    // 列表刷新后回挂选中（被删则取首条），draft 每次从服务端行重建；
    // 手动选中时 handler 同步 setDraft，本 effect 不依赖 selectedId 防循环。
    useEffect(() => {
        if (sequences.length === 0) {
            setSelectedId(null);
            setDraft(null);
            return;
        }
        const row = sequences.find((r) => r.id === selectedId) || sequences[0];
        setSelectedId(row.id);
        setDraft(toDraft(row));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sequences]);

    // 选中步骤回填：换指令/换步后把冻结 params 灌回表单（hook 的默认值 effect
    // 先跑、本 effect 后跑 → params 覆盖默认；params 属旧指令时跳过）
    useEffect(() => {
        if (!formInstruction || editorIndex === null || !draft) return;
        const step = draft.steps[editorIndex];
        if (!step || step.instruction_id !== formInstruction.id) return;
        if (step.params) {
            form.setInputs({ ...InstructionEncoder.getInitialValues(formInstruction), ...step.params });
        }
        setStepLabel(step.label || '');
        setStepDelay(String(step.delay_ms ?? 0));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [formInstruction?.id, editorIndex]);

    // 实时编译预览（未「应用」也可见 payload、计划摘要与生成侧降级警告）
    const live = useMemo(() => {
        if (!formInstruction || !form.hexPreview.trim()) return null;
        return {
            payload: form.hexPreview.replace(/\s/g, '').toUpperCase(),
            ...buildPlan(formInstruction, form.inputs, form.computedValues, form.byteMap)
        };
    }, [formInstruction, form.inputs, form.computedValues, form.byteMap, form.hexPreview]);

    const running = status?.running === true;
    const timeoutOk = !draft
        || draft.timeout.trim() === ''
        || (/^\d+$/.test(draft.timeout.trim()) && Number(draft.timeout) >= 1 && Number(draft.timeout) <= 60000);
    // 保存允许 0 步（后端接受空步骤序列；空序列仅启动被 400 拦）；已存在的
    // 步骤必须全部编译过（instruction_id + payload 非空）才能整体 PUT。
    const canSave = !!draft
        && !running
        && !!draft.name.trim()
        && timeoutOk
        && draft.steps.every((s) => s.instruction_id && s.payload);
    const canStart = !!selectedId && !running && !!draft && draft.steps.length > 0;

    const applyDraftSteps = (steps) => setDraft((d) => (d ? { ...d, steps } : d));
    const closeEditor = () => {
        setEditorIndex(null);
        setFormInstruction(null);
        setStepInstructionId('');
    };

    const handleCreate = async () => {
        if (running || busy) return;
        setBusy('create');
        try {
            const created = await api.createSequence({
                name: `序列 ${sequences.length + 1}`,
                description: null,
                config: { ...EMPTY_CONFIG },
                steps: []
            });
            await refresh();
            setSelectedId(created.id);
            setDraft(toDraft(created));
            closeEditor();
            ok(`已新建：${created.name}（添加步骤 → 选指令填参 → 应用 → 保存）`);
        } catch (err) {
            fail(err);
        } finally {
            setBusy('');
        }
    };

    const handleSave = async () => {
        if (!canSave || busy) return;
        setBusy('save');
        try {
            await api.updateSequence(selectedId, saveBody(draft));
            await refresh(); // effect 从服务端行重建 draft（含新步骤 id / step_order）
            ok('已保存（PUT 整体替换）');
        } catch (err) {
            fail(err); // 400 detail 含 steps[i] 定位，直接展示
        } finally {
            setBusy('');
        }
    };

    const handleDeleteConfirm = async () => {
        setConfirmDelete(false);
        if (busy) return;
        setBusy('delete');
        try {
            await api.deleteSequence(selectedId);
            closeEditor();
            setSelectedId(null);
            setDraft(null);
            await refresh();
            ok('已删除');
        } catch (err) {
            fail(err);
            refresh(); // 404（别处已删）→ 同步列表
        } finally {
            setBusy('');
        }
    };

    const handleStart = async () => {
        if (!canStart || busy) return;
        setBusy('start');
        try {
            setStatus(await api.startSequence(selectedId));
            ok('已启动（状态经 1.5s 轮询刷新）');
        } catch (err) {
            fail(err); // 409 = 忙 / 400 = 无步骤 / 404 = 缺失
        } finally {
            setBusy('');
        }
    };

    const handleStop = async () => {
        if (busy) return;
        setBusy('stop');
        try {
            setStatus(await api.stopSequence());
            ok('停止请求已受理（恒 200 幂等，余步将标记 SKIPPED）');
        } catch (err) {
            fail(err);
        } finally {
            setBusy('');
        }
    };

    const handleSelect = (row) => {
        setSelectedId(row.id);
        setDraft(toDraft(row));
        closeEditor();
        setLoadError('');
        setMsg('');
    };

    const addStep = () => {
        if (running || !draft || instructions.length === 0) return;
        const idx = draft.steps.length;
        applyDraftSteps([
            ...draft.steps,
            { instruction_id: instructions[0].id, label: null, delay_ms: 0, params: null, payload: '', plan: null }
        ]);
        setEditorIndex(idx);
        setFormInstruction(instructions[0]);
        setStepInstructionId(instructions[0].id);
        setStepLabel('');
        setStepDelay('0');
    };

    const handleSelectStep = (i) => {
        const step = draft?.steps[i];
        if (!step) return;
        setEditorIndex(i);
        const instr = instructions.find((x) => x.id === step.instruction_id) || null;
        setFormInstruction(instr);
        setStepInstructionId(step.instruction_id);
        setStepLabel(step.label || '');
        setStepDelay(String(step.delay_ms ?? 0));
    };

    const handleStepInstructionChange = (id) => {
        setStepInstructionId(id);
        setFormInstruction(instructions.find((x) => x.id === id) || null);
        // hook 重置新指令默认值；回填 effect 因 instruction_id 不匹配而跳过
    };

    // CP3 3c (D6-B): 配方选择器 → 草稿步骤 wrap 字段（随 APPLY / 保存一起提交）。
    // 选回「无封装」：原本封装过的显式置 null（后端切回内核、剥 plan.shell）；
    // 从未封装的保持键缺席 —— 裸帧请求形逐字节不变（见 saveBody 的 'wrap' in s）。
    const handleStepWrapChange = (recipeId) => {
        if (running || editorIndex === null || !draft) return;
        applyDraftSteps(draft.steps.map((s, i) => {
            if (i !== editorIndex) return s;
            if (!recipeId) return 'wrap' in s ? { ...s, wrap: null } : s;
            return { ...s, wrap: { recipe_id: recipeId } };
        }));
    };

    const removeStep = (i) => {
        if (running || !draft) return;
        applyDraftSteps(draft.steps.filter((_, x) => x !== i));
        if (editorIndex === i) closeEditor();
        else if (editorIndex > i) setEditorIndex(editorIndex - 1);
    };

    const moveStep = (i, dir) => {
        if (running || !draft) return;
        const to = i + dir;
        if (to < 0 || to >= draft.steps.length) return;
        applyDraftSteps(reorder(draft.steps, i, to));
        if (editorIndex === i) setEditorIndex(to);
        else if (editorIndex === to) setEditorIndex(i);
    };

    const handleApplyStep = () => {
        if (running || !draft || editorIndex === null || !formInstruction || !live?.payload) return;
        const delay = Math.min(60000, Math.max(0, Math.trunc(Number(stepDelay) || 0)));
        applyDraftSteps(draft.steps.map((s, i) => (i === editorIndex ? {
            instruction_id: formInstruction.id,
            label: stepLabel.trim() || null,
            delay_ms: delay,
            params: { ...form.inputs },
            payload: live.payload,
            plan: live.plan,
            // CP3 3c (D6-B): 封装配方随 APPLY 一并落步（键缺席 = 从未封装）。
            // APPLY 后 payload = 内核帧、plan 无 shell → 后端按 wrap 重新套壳；
            // 未「应用」时则透传 GET 回来的完整帧 + 带 shell 的 plan，幂等重冻。
            ...('wrap' in s ? { wrap: s.wrap } : {})
        } : s)));
        setMsg(`步骤 ${editorIndex + 1} 已应用（${payloadByteCount(live.payload)} 字节）`);
        setLoadError('');
    };

    const instrName = (id) => {
        const instr = instructions.find((x) => x.id === id);
        if (instr) return `${instr.code || ''} ${instr.name || instr.label || ''}`.trim();
        return id ? `${String(id).slice(0, 8)}…（指令缺失）` : '未选指令';
    };

    // CP3 3c (D6-B): 配方显示名（WRAP :: 指示 / 选择器占位项用）。配方列表
    // 未加载或已被删 → id 截断回退，与 instrName 同口径（不阻断回显）。
    const recipeName = (id) => {
        const rec = recipes.find((x) => x.id === id);
        if (rec) return rec.name || id;
        return `${String(id).slice(0, 8)}…（配方缺失）`;
    };

    // 批次二 (D14②): 步骤宿主悬空 → 失效徽标。判据两层：后端 instruction_missing
    // （读时批量比对 instruction_id，零 DDL）+ 本地兜底（列表刚被外部删指令、
    // draft 尚未刷新时也点得出来）。冻结快照仍可运行 —— 只是编辑入口降只读。
    const stepHostMissing = (s) => Boolean(
        s.instruction_missing
        || (s.instruction_id && !instructions.some((x) => x.id === s.instruction_id))
    );

    const step = editorIndex !== null && draft ? draft.steps[editorIndex] : null;
    const formReady = !!step && !!formInstruction;
    // CP3 3c (D6-B): 冻结步骤计划的外壳逐层区间摘要（plan.shell 由后端保存期
    // 注入，buildPlan/live 不产出）——回显在既有计划摘要面板。
    const frozenShell = shellSummary(step?.plan);

    return (
        <div className="flex-1 overflow-auto bg-[radial-gradient(circle_at_top,_rgba(218,212,187,0.12),_transparent_45%),linear-gradient(180deg,_rgba(212,206,178,0.04),_rgba(10,10,10,0))] text-nier-light">
            <div className="p-5 flex flex-col gap-4">
                {/* Header（registry 驱动，DataHub 同款） */}
                <section className="border border-nier-light/30 bg-nier-dark/70 p-3">
                    <div className="text-[11px] font-mono tracking-[0.35em] opacity-50">{`PAGE ${page.shortcut} // SEQUENCE ORCHESTRATION`}</div>
                    <h1 className="mt-2 text-4xl font-black tracking-tight leading-none">{page.titleZh}</h1>
                    <p className="mt-2 text-sm uppercase tracking-[0.25em] opacity-60">{page.titleEn}</p>
                    <div className="mt-3 inline-flex items-center gap-2 border border-yellow-500/40 bg-yellow-500/10 px-3 py-1 text-[11px] font-mono tracking-[0.2em] text-yellow-300">
                        <span className="h-2 w-2 bg-yellow-300 animate-pulse" />
                        {page.status}
                    </div>
                </section>

                {(loadError || msg) && (
                    <div className="border border-nier-light/40 bg-nier-dark/70 px-4 py-2 text-xs font-mono">
                        {loadError
                            ? <span className="text-red-400 break-all">ERR: {loadError}</span>
                            : <span>SYS: {msg}</span>}
                    </div>
                )}

                <div className="flex gap-4 items-start">
                    {/* 左：定义列表 */}
                    <section className="w-64 shrink-0 border border-nier-light/30 bg-nier-dark/60 p-3 flex flex-col gap-3">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] font-mono tracking-[0.3em] opacity-60">定义列表</span>
                            <button
                                type="button"
                                onClick={() => { refresh(); }}
                                className="border border-nier-light/30 px-2 py-1 text-[10px] font-mono hover:bg-nier-light/10 transition-all"
                                title="重新拉取 /sequences"
                            >
                                刷新
                            </button>
                        </div>
                        <div className="flex flex-col gap-1">
                            {sequences.length === 0 && (
                                <div className="text-[10px] font-mono opacity-40 py-2">— 无序列，点下方新建 —</div>
                            )}
                            {sequences.map((row) => (
                                <button
                                    key={row.id}
                                    type="button"
                                    onClick={() => handleSelect(row)}
                                    className={`text-left border px-2 py-1 text-[11px] font-mono transition-all ${selectedId === row.id
                                        ? 'border-nier-light/60 bg-nier-light/10'
                                        : 'border-nier-light/15 hover:border-nier-light/40'}`}
                                >
                                    <div className="truncate font-bold">{row.name}</div>
                                    <div className="opacity-50">{(row.steps || []).length} 步 · {planSummary(row.steps?.[0]?.plan) === '静态帧' ? '定义' : '含计划'}</div>
                                </button>
                            ))}
                        </div>
                        <button
                            type="button"
                            onClick={handleCreate}
                            disabled={running || busy === 'create'}
                            className="border border-nier-light text-nier-light py-2 font-black text-xs tracking-[0.2em] hover:bg-nier-light hover:text-nier-dark transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {busy === 'create' ? '创建中…' : '+ 新建序列'}
                        </button>
                        <button
                            type="button"
                            onClick={() => setConfirmDelete(true)}
                            disabled={!selectedId || running || !!busy}
                            className="border border-red-500/40 text-red-300 py-1 text-[11px] font-mono tracking-[0.2em] hover:bg-red-500/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            删除所选
                        </button>
                    </section>

                    {/* 中：定义与步骤编辑 */}
                    <section className="flex-1 min-w-0 border border-nier-light/30 bg-nier-dark/60 p-3 flex flex-col gap-3">
                        {!draft ? (
                            <div className="py-4 text-center text-nier-light/40 font-mono tracking-widest animate-pulse">
                                SELECT OR CREATE A SEQUENCE
                            </div>
                        ) : (
                            <>
                                <div className="flex gap-3 items-end flex-wrap">
                                    <label className="flex flex-col gap-1 text-[10px] font-mono opacity-60">
                                        名称 *
                                        <input
                                            type="text"
                                            maxLength={128}
                                            value={draft.name}
                                            disabled={running}
                                            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                                            className="w-56 bg-nier-dark border border-nier-light/30 px-2 py-1 text-xs font-mono text-nier-light disabled:opacity-50"
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1 text-[10px] font-mono opacity-60">
                                        描述
                                        <input
                                            type="text"
                                            value={draft.description}
                                            disabled={running}
                                            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                                            className="w-64 bg-nier-dark border border-nier-light/30 px-2 py-1 text-xs font-mono text-nier-light disabled:opacity-50"
                                        />
                                    </label>
                                    <label className="flex items-center gap-2 text-[11px] font-mono pb-1">
                                        <input
                                            type="checkbox"
                                            checked={draft.stopOnError}
                                            disabled={running}
                                            onChange={(e) => setDraft({ ...draft, stopOnError: e.target.checked })}
                                        />
                                        出错即停
                                    </label>
                                    <label className="flex items-center gap-2 text-[11px] font-mono pb-1">
                                        读超时ms
                                        <input
                                            type="number"
                                            min={1}
                                            max={60000}
                                            placeholder="不设"
                                            value={draft.timeout}
                                            disabled={running}
                                            onChange={(e) => setDraft({ ...draft, timeout: e.target.value })}
                                            className="w-24 bg-nier-dark border border-nier-light/30 px-2 py-1 text-xs font-mono text-nier-light disabled:opacity-50"
                                        />
                                    </label>
                                </div>

                                <div className="flex items-center justify-between border-t border-nier-light/15 pt-2">
                                    <span className="text-[11px] font-mono tracking-[0.3em] opacity-60">
                                        步骤（{draft.steps.length} / 200）
                                    </span>
                                    <button
                                        type="button"
                                        onClick={addStep}
                                        disabled={running || instructions.length === 0}
                                        className="border border-nier-light/40 px-2 py-1 text-[10px] font-mono hover:bg-nier-light/10 transition-all disabled:opacity-40"
                                        title={instructions.length === 0 ? '指令库为空或未加载' : '追加一步（默认首条指令）'}
                                    >
                                        + 添加步骤
                                    </button>
                                </div>

                                <div className="flex flex-col gap-1">
                                    {draft.steps.length === 0 && (
                                        <div className="text-[10px] font-mono opacity-40 py-1">
                                            — 无步骤：添加 → 选指令填参 → 应用编译帧 → 保存（空序列不可启动） —
                                        </div>
                                    )}
                                    {draft.steps.map((s, i) => (
                                        <div
                                            key={s.id || `draft-${i}`}
                                            className={`flex items-center gap-2 border px-2 py-1 text-[11px] font-mono ${editorIndex === i
                                                ? 'border-nier-light/50 bg-nier-light/5'
                                                : 'border-nier-light/15'}`}
                                        >
                                            <button
                                                type="button"
                                                onClick={() => handleSelectStep(i)}
                                                className="flex-1 min-w-0 flex items-center gap-2 text-left"
                                                title="编辑该步骤"
                                            >
                                                <span className="opacity-40 w-6">{String(i + 1).padStart(2, '0')}</span>
                                                <span className="truncate w-28">{s.label || `step-${i + 1}`}</span>
                                                <span className="truncate opacity-60 flex-1">{instrName(s.instruction_id)}</span>
                                                {/* CP3 3c (D6-B): 已封装步骤 → WRAP 来源指示 + 配方
                                                    失效徽标（wrap.stale，协议定义已变更 —— 不阻断） */}
                                                {s.wrap?.recipe_id && (
                                                    <span
                                                        data-testid={`step-wrap-${i}`}
                                                        className="text-[#E58D28] shrink-0 max-w-[9rem] truncate text-[9px] tracking-widest"
                                                        title={`封装配方：${recipeName(s.wrap.recipe_id)}（发送期由后端按配方重算外壳）`}
                                                    >
                                                        {`WRAP :: ${recipeName(s.wrap.recipe_id)}`}
                                                    </span>
                                                )}
                                                {s.wrap?.stale && (
                                                    <span
                                                        data-testid={`step-wrap-stale-${i}`}
                                                        className="border border-yellow-500/50 text-yellow-400 px-1 shrink-0 text-[9px] tracking-widest"
                                                        title="封装配方已失效：协议定义已变更（步骤冻结帧不受影响，不阻断保存/运行）"
                                                    >
                                                        失效
                                                    </span>
                                                )}
                                                {/* 批次二 (D14②): 宿主已删 → 失效徽标
                                                    （帧已冻结仍可运行，仅编辑入口只读） */}
                                                {stepHostMissing(s) && (
                                                    <span
                                                        className="border border-yellow-500/50 text-yellow-400 px-1 shrink-0 text-[9px] tracking-widest"
                                                        title="宿主指令已删除：步骤帧已冻结、可继续运行；编辑入口已降为只读"
                                                    >
                                                        失效
                                                    </span>
                                                )}
                                                <span className="opacity-50">{Number(s.delay_ms) > 0 ? `${s.delay_ms}ms` : '直发'}</span>
                                                <span className={s.payload ? 'text-[#E58D28]' : 'text-red-400'}>
                                                    {s.payload ? `${payloadByteCount(s.payload)}B` : '未编译'}
                                                </span>
                                                <span className="opacity-50 hidden lg:inline">{planSummary(s.plan)}</span>
                                            </button>
                                            <span className="flex gap-1 shrink-0">
                                                <button
                                                    type="button"
                                                    onClick={() => moveStep(i, -1)}
                                                    disabled={running || i === 0}
                                                    className="border border-nier-light/25 px-1 hover:bg-nier-light/10 transition-all disabled:opacity-25"
                                                    title="上移"
                                                >
                                                    ↑
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => moveStep(i, 1)}
                                                    disabled={running || i === draft.steps.length - 1}
                                                    className="border border-nier-light/25 px-1 hover:bg-nier-light/10 transition-all disabled:opacity-25"
                                                    title="下移"
                                                >
                                                    ↓
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => removeStep(i)}
                                                    disabled={running}
                                                    className="border border-red-500/30 px-1 text-red-300 hover:bg-red-500/10 transition-all disabled:opacity-25"
                                                    title="移除步骤"
                                                >
                                                    ×
                                                </button>
                                            </span>
                                        </div>
                                    ))}
                                </div>

                                {/* 步骤编辑器（选中某步时展开） */}
                                {step && (
                                    <div className="border border-nier-light/40 bg-nier-dark/70 p-3 flex flex-col gap-3">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-[11px] font-mono tracking-[0.3em] opacity-60">
                                                STEP {String(editorIndex + 1).padStart(2, '0')} // 编辑器
                                            </span>
                                            <div className="flex items-center gap-2 min-w-0">
                                                {/* CP3 3c (D6-B): 编辑器头部回显封装来源 + 配方失效
                                                    徽标（wrap.stale 点亮、不阻断） */}
                                                {step.wrap?.recipe_id && (
                                                    <span
                                                        data-testid="step-editor-wrap"
                                                        className="font-mono text-[9px] tracking-widest text-[#E58D28] min-w-0 truncate"
                                                        title={`封装配方：${recipeName(step.wrap.recipe_id)}（保存期后端按配方冻结完整封装帧）`}
                                                    >
                                                        {`WRAP :: ${recipeName(step.wrap.recipe_id)}`}
                                                    </span>
                                                )}
                                                {step.wrap?.stale && (
                                                    <span
                                                        data-testid="step-editor-wrap-stale"
                                                        className="border border-yellow-500/50 text-yellow-400 px-1 shrink-0 font-mono text-[9px] tracking-widest"
                                                        title="封装配方已失效：协议定义已变更（步骤冻结帧不受影响，不阻断保存/运行）"
                                                    >
                                                        失效
                                                    </span>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={closeEditor}
                                                    className="border border-nier-light/25 px-2 py-1 text-[10px] font-mono hover:bg-nier-light/10 transition-all shrink-0"
                                                >
                                                    关闭 ×
                                                </button>
                                            </div>
                                        </div>

                                        <div className="flex gap-3 items-end flex-wrap text-[11px] font-mono">
                                            <label className="flex flex-col gap-1 opacity-60">
                                                指令
                                                <select
                                                    value={stepInstructionId}
                                                    disabled={running || stepHostMissing(step)}
                                                    onChange={(e) => handleStepInstructionChange(e.target.value)}
                                                    className="bg-nier-dark border border-nier-light/30 px-2 py-1 text-xs font-mono text-nier-light disabled:opacity-50"
                                                >
                                                    {instructions.length === 0 && <option value="">（指令库为空）</option>}
                                                    {stepHostMissing(step) && !instructions.some((x) => x.id === stepInstructionId) && (
                                                        <option value={stepInstructionId}>（宿主指令已删除）</option>
                                                    )}
                                                    {instructions.map((x) => (
                                                        <option key={x.id} value={x.id}>
                                                            {`${x.code || ''} ${x.name || x.label || x.id}`.trim()}
                                                        </option>
                                                    ))}
                                                </select>
                                            </label>
                                            <label className="flex flex-col gap-1 opacity-60">
                                                标签（≤128）
                                                <input
                                                    type="text"
                                                    maxLength={128}
                                                    value={stepLabel}
                                                    disabled={running || stepHostMissing(step)}
                                                    onChange={(e) => setStepLabel(e.target.value)}
                                                    className="w-40 bg-nier-dark border border-nier-light/30 px-2 py-1 text-xs font-mono text-nier-light disabled:opacity-50"
                                                />
                                            </label>
                                            <label className="flex flex-col gap-1 opacity-60">
                                                延时ms（0..60000）
                                                <input
                                                    type="number"
                                                    min={0}
                                                    max={60000}
                                                    value={stepDelay}
                                                    disabled={running || stepHostMissing(step)}
                                                    onChange={(e) => setStepDelay(e.target.value)}
                                                    className="w-28 bg-nier-dark border border-nier-light/30 px-2 py-1 text-xs font-mono text-nier-light disabled:opacity-50"
                                                />
                                            </label>
                                            {/* CP3 3c (D6-B): 封装配方选择器（可选）—— 选中即落
                                                草稿步骤 wrap.recipe_id，随 APPLY / 保存提交；
                                                「无封装」= 从未封装则键缺席、原本封装过则发 null。 */}
                                            <label className="flex flex-col gap-1 opacity-60">
                                                配方 RECIPE（可选）
                                                <select
                                                    data-testid="step-wrap-recipe"
                                                    value={step.wrap?.recipe_id || ''}
                                                    disabled={running || stepHostMissing(step)}
                                                    title={step.wrap?.recipe_id
                                                        ? `已封装：${recipeName(step.wrap.recipe_id)}（选回「无封装」= 取消套壳）`
                                                        : '无封装（裸帧路径，请求形不变）'}
                                                    onChange={(e) => handleStepWrapChange(e.target.value)}
                                                    className="bg-nier-dark border border-nier-light/30 px-2 py-1 text-xs font-mono text-nier-light disabled:opacity-50"
                                                >
                                                    <option value="">无封装</option>
                                                    {step.wrap?.recipe_id && !recipes.some((x) => x.id === step.wrap.recipe_id) && (
                                                        <option value={step.wrap.recipe_id}>
                                                            {`（配方缺失：${step.wrap.recipe_id}）`}
                                                        </option>
                                                    )}
                                                    {recipes.map((x) => (
                                                        <option key={x.id} value={x.id}>
                                                            {x.name || x.id}
                                                        </option>
                                                    ))}
                                                </select>
                                            </label>
                                        </div>

                                        {!formReady ? (
                                            <div className="border border-yellow-500/40 bg-yellow-500/10 px-2 py-1 text-[11px] font-mono text-yellow-300">
                                                宿主指令已删除：步骤帧是冻结快照、仍可继续运行（D14② 失效不阻断）；
                                                本步骤编辑已降只读，要改请移除后重新添加。
                                            </div>
                                        ) : (
                                            <>
                                                <div className="max-h-64 overflow-y-auto custom-scrollbar pr-1">
                                                    <RunnerFieldTree
                                                        fields={renderFields.fields}
                                                        inputs={form.inputs}
                                                        computedValues={form.computedValues}
                                                        onFieldChange={form.handleInputChange}
                                                    />
                                                </div>

                                                <div className="border border-[#5c5c5c] bg-[#4a4a4a] text-[#dad4bb] p-2 font-mono text-sm break-all relative">
                                                    <span className="absolute top-0 right-0 bg-[#5c5c5c] text-[9px] px-2 py-0.5 tracking-widest">
                                                        FRAME {live ? payloadByteCount(live.payload) : 0}B
                                                    </span>
                                                    <span className="mt-3 block">{live?.payload || '—'}</span>
                                                </div>

                                                {/* CP3 3c (D6-B): 计划摘要面板 —— live 计划（发送期
                                                    重算）+ 冻结步骤的 shell 逐层区间（SHELL L1..Ln /
                                                    每层 LEN@·CRC@ 绝对字节位） */}
                                                {(live?.plan || frozenShell) && (
                                                    <div
                                                        data-testid="step-plan-summary"
                                                        className="border border-nier-light/25 px-2 py-1 text-[10px] font-mono text-[#E58D28] break-all"
                                                    >
                                                        PLAN: {planSummary(live.plan)}
                                                        {frozenShell ? ` · ${frozenShell}` : ''}
                                                    </div>
                                                )}
                                                {(live?.warnings || []).map((w) => (
                                                    <div key={w} className="border border-orange-500/30 bg-orange-500/10 px-2 py-1 text-[10px] font-mono text-orange-300">
                                                        ⚠ {w}
                                                    </div>
                                                ))}

                                                <button
                                                    type="button"
                                                    onClick={handleApplyStep}
                                                    disabled={running || !live?.payload}
                                                    className="bg-nier-light text-white py-2 px-4 font-black text-xs tracking-[0.2em] hover:bg-[#2a2a2a] transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                                                >
                                                    应用到步骤（APPLY → payload + params + plan）
                                                </button>
                                            </>
                                        )}
                                    </div>
                                )}

                                <div className="flex items-center gap-3 border-t border-nier-light/15 pt-2">
                                    <button
                                        type="button"
                                        onClick={handleSave}
                                        disabled={!canSave || busy === 'save'}
                                        className="bg-nier-light text-white py-2 px-4 font-black text-xs tracking-[0.2em] hover:bg-[#2a2a2a] transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {busy === 'save' ? '保存中…' : '保存定义 (PUT)'}
                                    </button>
                                    {running && (
                                        <span className="text-[10px] font-mono text-orange-300">序列运行中 — 定义编辑已禁用</span>
                                    )}
                                    {!running && !canSave && (
                                        <span className="text-[10px] font-mono text-orange-300">
                                            保存需：非空名称 · 步骤全部已编译（空序列可存、不可启动） · 读超时 1..60000 或留空
                                        </span>
                                    )}
                                </div>
                            </>
                        )}
                    </section>

                    {/* 右：运行控制与状态（1.5s 轮询） */}
                    <section className="w-[420px] shrink-0 border border-nier-light/30 bg-nier-dark/60 p-3 flex flex-col gap-3">
                        <span className="text-[11px] font-mono tracking-[0.3em] opacity-60">运行状态 // POLL 1.5s</span>

                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={handleStart}
                                disabled={!canStart || busy === 'start'}
                                className="flex-1 bg-nier-light text-white py-2 font-black text-xs tracking-[0.2em] hover:bg-[#2a2a2a] transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                                title={running ? '已有序列在运行' : (!draft || draft.steps.length === 0 ? '当前定义无步骤' : '启动所选序列')}
                            >
                                {busy === 'start' ? '启动中…' : '启动序列'}
                            </button>
                            <button
                                type="button"
                                onClick={handleStop}
                                disabled={busy === 'stop'}
                                className="border border-nier-light text-nier-light py-2 px-4 font-black text-xs tracking-[0.2em] hover:bg-nier-light hover:text-nier-dark transition-all active:scale-95 disabled:opacity-40"
                                title="恒 200 幂等；余步将标记 SKIPPED"
                            >
                                {busy === 'stop' ? '停止中…' : '停止'}
                            </button>
                        </div>

                        <div className="flex items-center justify-between">
                            <div className={`inline-flex items-center gap-2 border px-3 py-1 text-[11px] font-mono tracking-[0.2em] ${resultTone(status?.result ?? 'idle')}`}>
                                <span className={`h-2 w-2 bg-current ${status?.running ? 'animate-pulse' : ''}`} />
                                {resultLabel(status?.result ?? 'idle')}
                            </div>
                            <span className="text-[11px] font-mono opacity-70">PROGRESS {progressText(status)}</span>
                        </div>

                        {status?.sequence_name && (
                            <div className="text-[11px] font-mono opacity-70 truncate">
                                SEQ: {status.sequence_name}
                            </div>
                        )}
                        {status?.started_at && (
                            <div className="text-[10px] font-mono opacity-50">
                                START {new Date(status.started_at).toLocaleTimeString()}
                                {status.finished_at ? ` → ${new Date(status.finished_at).toLocaleTimeString()}` : ''}
                            </div>
                        )}
                        {status?.stop_requested && (
                            <div className="border border-orange-500/40 bg-orange-500/10 px-2 py-1 text-[10px] font-mono text-orange-300">
                                STOP 已请求 — 等待当前分片退出…
                            </div>
                        )}
                        {status?.error && (
                            <div className="border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] font-mono text-red-300 break-all">
                                ERR: {status.error}
                            </div>
                        )}

                        <div className="border border-nier-light/20 bg-nier-dark/70">
                            <div className="grid grid-cols-[2rem_1fr_5rem_5rem] gap-1 px-2 py-1 text-[10px] font-mono opacity-50 border-b border-nier-light/20">
                                <span>#</span>
                                <span>STEP</span>
                                <span>STATUS</span>
                                <span>RTT</span>
                            </div>
                            {(status?.steps || []).map((s) => (
                                <div
                                    key={`${s.n}-${s.step_id}`}
                                    className="grid grid-cols-[2rem_1fr_5rem_5rem] gap-1 px-2 py-1 text-[11px] font-mono border-b border-nier-light/10"
                                    title={`sent: ${s.sent || '—'}\nreceived: ${s.received || '—'}${s.error ? `\nerror: ${s.error}` : ''}`}
                                >
                                    <span className="opacity-60">{s.n}</span>
                                    <span className="truncate">{s.label || (s.step_id ? `${s.step_id.slice(0, 8)}…` : '—')}</span>
                                    <span className={stepTone(s.status)}>{s.status}</span>
                                    <span className="opacity-70">{rttText(s.rtt_ms)}</span>
                                </div>
                            ))}
                            {(status?.steps || []).length === 0 && (
                                <div className="px-2 py-2 text-[10px] font-mono opacity-40">
                                    — 尚无执行记录（终态保留至下次启动覆盖） —
                                </div>
                            )}
                        </div>

                        <div className="text-[10px] font-mono opacity-40 leading-relaxed">
                            互斥：序列运行中，加工页 /dispatch 与事务发送将返回 409；
                            启动前定义须已保存（未保存的草稿改动不参与本次运行——Runner 持步骤副本）。
                        </div>
                    </section>
                </div>
            </div>

            <NieRModal
                isOpen={confirmDelete}
                message={`删除序列「${draft?.name || ''}」？\n\n· 序列与其步骤行一并移入回收站\n· 可在「回收站」页恢复（步骤随序列一并回来）\n· 彻底删除后才不可恢复`}
                onConfirm={handleDeleteConfirm}
                onCancel={() => setConfirmDelete(false)}
            />
        </div>
    );
}
