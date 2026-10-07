// R38（PLAN §8.70）：发前路由规则页 —— 「进入序列之前先按输入条件挑指令」
// 的规则表，纯管理面（解析与加工页自动选指令的接线归 R39）。
//
// 三条页面级口径：
//  ① **列表顺序 = 匹配顺序**。后端按 `(sort_order, name, id)` 定序，前端照单渲染
//     不重排 —— first-match-wins 之下「看得见的顺序」就是「谁先判真」，不能让它
//     有第二种解释；
//  ② **排序只改草稿**。上移 / 下移零请求，点「保存顺序」才按草稿稠密重编并
//     **只 PUT sort_order 真变化的行**（后端无批量排序端点，少发一行是一行）；
//  ③ **判定口径不重算**。条件语法由 utils/condition.checkCondition 就地拦（与
//     序列步骤、BE 同一份 SSOT），其余（停用行不参与 / 坏条件记 invalid /
//     无命中不猜）全在后端 —— FE 只显示，不改判。
//  ④ **试解析只回显**（R40 · §8.72）：给一组输入调 `POST /dispatch/routed` 看
//     会命中哪条，**一行状态都不改**（不选中规则、不动表单与顺序）；后端只看得见
//     已落库的行，故面板常驻写明「按已保存的规则计算」，顺序有草稿时当场点破。
//  ⑤ **逐条轨迹只排版**（R43 · §8.75）：回执 `trace` 一条规则一行
//     （`code` 机器码 + `detail` 后端事实载荷），中文由 `traceReasonText` 出；
//     FE **不扫第二遍条件** —— 比较 / 变量 / 类型的判定全在后端 condition.py。
//
// 本仓未装 @testing-library/jest-dom → 组件里不依赖 matchers 扩展。
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { PAGE_STATUS_BY_KEY } from '../config/pageRegistry';
import NieRModal from '../components/ui/NieRModal';
import RouteInputTable from '../components/RouteInputTable';
import {
    MAX_RULE_NAME,
    changedSortOrder,
    defaultSortOrder,
    describeRoutingSaveError,
    emptyRuleDraft,
    moveRule,
    renumber,
    validateRuleDraft,
} from '../utils/routingView';
import {
    addRouteInput,
    describeDryRun,
    describeResolveError,
    emptyRouteInputs,
    filledInputCount,
    toInputsMap,
} from '../utils/routeResolve';

const PanelTitle = ({ children, hint }) => (
    <div className="flex items-baseline justify-between border-b border-nier-light/30 px-4 py-2 bg-nier-light/5">
        <span className="text-[11px] font-bold tracking-[0.3em] text-nier-light">{children}</span>
        {hint && <span className="text-[10px] font-mono opacity-50">{hint}</span>}
    </div>
);

const ActionButton = ({ onClick, disabled = false, busy = false, danger = false, children }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled || busy}
        className={[
            'px-3 py-1.5 border text-[11px] font-bold tracking-[0.2em] transition-colors duration-150 disabled:opacity-40',
            danger
                ? 'border-red-500/60 text-red-400 enabled:hover:bg-red-500 enabled:hover:text-nier-dark'
                : 'border-nier-light/70 text-nier-light enabled:hover:bg-nier-light enabled:hover:text-nier-dark'
        ].join(' ')}
    >
        {busy ? '…' : children}
    </button>
);

const RowButton = ({ label, onClick, disabled = false, danger = false, children }) => (
    <button
        type="button"
        aria-label={label}
        title={label}
        onClick={onClick}
        disabled={disabled}
        className={[
            'border px-2 py-1 text-[10px] font-mono tracking-[0.15em] transition-colors duration-150 disabled:opacity-30',
            danger
                ? 'border-red-500/50 text-red-400 enabled:hover:bg-red-500 enabled:hover:text-nier-dark'
                : 'border-nier-light/40 text-nier-light/80 enabled:hover:border-nier-light enabled:hover:bg-nier-light enabled:hover:text-nier-dark'
        ].join(' ')}
    >
        {children}
    </button>
);

// 读出体 → PUT 载荷：**恒为完整六字段**（后端 RoutingRuleCreate 无部分更新语义），
// 字段名与 utils/routingView.emptyRuleDraft 逐字同名。
const toPayload = (row, patch = {}) => ({
    name: row.name,
    condition: row.condition,
    instruction_id: row.instruction_id,
    sort_order: Number(row.sort_order) || 0,
    enabled: row.enabled ? 1 : 0,
    description: row.description ?? null,
    ...patch,
});

const draftToPayload = (draft) => toPayload(
    {
        name: String(draft.name ?? '').trim(),
        condition: String(draft.condition ?? '').trim(),
        instruction_id: draft.instruction_id,
        sort_order: draft.sort_order,
        enabled: draft.enabled,
        description: (draft.description ?? '').trim() || null,
    },
    {}
);

export default function RoutingRules({ instructions = [] }) {
    const page = PAGE_STATUS_BY_KEY.routing;
    const [rows, setRows] = useState([]);          // 展示序（= 草稿序）
    const [baseline, setBaseline] = useState([]);  // 上次落库的 sort_order（脏判据）
    const [loadError, setLoadError] = useState('');
    const [sysMsg, setSysMsg] = useState('');
    const [errMsg, setErrMsg] = useState('');
    const [busy, setBusy] = useState('');          // 'load' | 'order' | 'save' | toggle:<id> | delete:<id>

    const [draft, setDraft] = useState(null);      // null = 右栏不出表单
    const [editingId, setEditingId] = useState(null);
    const [errors, setErrors] = useState({});
    const [touched, setTouched] = useState(false);// 提交过一次才出字段红字
    const [deleteTarget, setDeleteTarget] = useState(null);

    // ── R40（§8.72）试解析 ────────────────────────────────────────────────
    // 输入表与加工页同一份实现（utils/routeResolve + 共用组件 RouteInputTable），
    // 回执怎么翻译归 describeDryRun —— 这里只回显，不改本页任何状态。
    const [dryRows, setDryRows] = useState(emptyRouteInputs);
    const [dryBusy, setDryBusy] = useState(false);
    const [dry, setDry] = useState(null);   // { kind: 'ok'|'miss'|'err', headline, rows, trace }

    const instructionName = useCallback((id) => {
        const hit = (instructions || []).find((item) => item.id === id);
        if (hit) return hit.name || hit.code || id;
        return id ? `（指令 ${id} 不在册）` : '（未指定）';
    }, [instructions]);

    const loadRules = useCallback(async () => {
        setBusy('load');
        try {
            const data = await api.listRoutingRules();
            const list = Array.isArray(data) ? data : [];
            setRows(list);
            setBaseline(list);
            setLoadError('');
            setErrMsg('');
        } catch (err) {
            setLoadError(err?.message || '无法连接后端服务');
        } finally {
            setBusy('');
        }
    }, []);

    useEffect(() => {
        loadRules();
    }, [loadRules]);

    // 排序脏判据：把当前草稿序稠密重编，与上次落库值逐行比 —— 只看 sort_order，
    // 不看名字（改名不算顺序改动）。
    const orderPlan = useMemo(
        () => changedSortOrder(baseline, renumber(rows)),
        [baseline, rows]
    );
    const orderDirty = orderPlan.length > 0;
    const planById = useMemo(() => new Map(orderPlan.map((p) => [p.id, p.sort_order])), [orderPlan]);

    // ── 表单 ──────────────────────────────────────────────────────────────
    const startCreate = () => {
        setDraft({ ...emptyRuleDraft(), sort_order: defaultSortOrder(rows) });
        setEditingId(null);
        setErrors({});
        setTouched(false);
        setErrMsg('');
    };

    const startEdit = (rule) => {
        setDraft({
            name: rule.name,
            condition: rule.condition,
            instruction_id: rule.instruction_id,
            sort_order: rule.sort_order,
            enabled: rule.enabled ? 1 : 0,
            description: rule.description ?? '',
        });
        setEditingId(rule.id);
        setErrors({});
        setTouched(false);
        setErrMsg('');
    };

    const closeDraft = () => {
        setDraft(null);
        setEditingId(null);
        setErrors({});
        setTouched(false);
    };

    const patchDraft = (patch) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

    const saveRule = async () => {
        if (!draft) return;
        setTouched(true);
        const liveNames = rows.map((r) => r.name);
        const res = validateRuleDraft(draft, {
            liveNames,
            excludeName: editingId
                ? (rows.find((r) => r.id === editingId)?.name ?? null)
                : null,
        });
        setErrors(res.errors);
        if (!res.ok) return;   // 就地红字，**一个请求都不发**

        const payload = draftToPayload(draft);
        setBusy('save');
        setErrMsg('');
        setSysMsg('');
        try {
            if (editingId) {
                await api.updateRoutingRule(editingId, payload);
            } else {
                await api.createRoutingRule(payload);
            }
            await loadRules();
            closeDraft();
            setSysMsg(`已${editingId ? '更新' : '保存'}规则「${payload.name}」。`);
        } catch (err) {
            // 后端 400/404 的兜底（回收站占名、目标指令刚被删）—— 原文透出不改写
            setErrMsg(describeRoutingSaveError(err));
        } finally {
            setBusy('');
        }
    };

    // ── 行内动作 ──────────────────────────────────────────────────────────
    const toggleEnabled = async (rule) => {
        const next = rule.enabled ? 0 : 1;
        setBusy(`toggle:${rule.id}`);
        setErrMsg('');
        try {
            await api.updateRoutingRule(rule.id, toPayload(rule, { enabled: next }));
            setRows((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: next } : r)));
            setBaseline((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: next } : r)));
            setSysMsg(`规则「${rule.name}」已${next ? '启用' : '停用'} —— ${next ? '参与匹配' : '不再参与匹配'}。`);
        } catch (err) {
            setErrMsg(describeRoutingSaveError(err));
        } finally {
            setBusy('');
        }
    };

    const requestDelete = (rule) => setDeleteTarget(rule);

    const confirmDelete = async () => {
        const rule = deleteTarget;
        if (!rule) return;
        setDeleteTarget(null);
        setBusy(`delete:${rule.id}`);
        setErrMsg('');
        try {
            await api.deleteRoutingRule(rule.id);
            if (editingId === rule.id) closeDraft();
            await loadRules();
            setSysMsg(`已删除规则「${rule.name}」（软删，可到回收站找回）。`);
        } catch (err) {
            setErrMsg(describeRoutingSaveError(err));
        } finally {
            setBusy('');
        }
    };

    // ── 顺序：只改草稿 ────────────────────────────────────────────────────
    const nudge = (rule, delta) => {
        const res = moveRule(rows, rule.id, delta);
        if (res.moved) {
            setRows(res.rows);
            setErrMsg('');
        }
    };

    const saveOrder = async () => {
        if (!orderDirty) return;
        setBusy('order');
        setErrMsg('');
        setSysMsg('');
        const fails = [];
        for (const change of orderPlan) {
            const row = rows.find((r) => r.id === change.id);
            if (!row) continue;
            try {
                await api.updateRoutingRule(change.id, toPayload(row, { sort_order: change.sort_order }));
            } catch (err) {
                fails.push(`「${row.name}」：${err?.message || '未知错误'}`);
            }
        }
        // 无论成败都把「已知值」推到 baseline —— 成功的行脏标清掉，
        // 失败的行下次 GET 会把真值带回来（不静默装作写成功了）。
        const applied = new Map(orderPlan.map((p) => [p.id, p.sort_order]));
        const nextBaseline = baseline.map((r) => (
            applied.has(r.id) && !fails.length
                ? { ...r, sort_order: applied.get(r.id) }
                : r
        ));
        setBaseline(nextBaseline);
        setRows((prev) => prev.map((r) => (
            applied.has(r.id) && !fails.length ? { ...r, sort_order: applied.get(r.id) } : r
        )));
        setBusy('');
        const head = fails.length
            ? `顺序保存未完成：更新 ${orderPlan.length - fails.length} / ${orderPlan.length} 条`
            : `顺序已保存（更新 ${orderPlan.length} 条 · 未变 0 条）`;
        setErrMsg(fails.length ? `保存失败：${head}\n${fails.join('\n')}` : '');
        if (!fails.length) setSysMsg(head);
    };

    const revertOrder = () => {
        setRows(baseline);
        setErrMsg('');
        setSysMsg('已放弃顺序改动（未发任何请求）。');
    };

    // ── R40（§8.72）试解析：只读调用，回执原样转写 ──────────────────────────
    // R43（§8.75）多带一项 trace（逐条判定轨迹），同样只回显不改判。
    const runDry = async () => {
        setDryBusy(true);
        setDry(null);
        try {
            const res = await api.resolveRoute(toInputsMap(dryRows));
            const out = describeDryRun(res);
            setDry({
                kind: out.matched ? 'ok' : 'miss',
                headline: out.headline,
                rows: out.rows,
                trace: out.trace,
            });
        } catch (err) {
            setDry({ kind: 'err', headline: describeResolveError(err), rows: [], trace: [] });
        } finally {
            setDryBusy(false);
        }
    };

    const dirtyErrors = touched ? errors : {};
    return (
        <div className="flex-1 overflow-auto bg-[radial-gradient(circle_at_top,_rgba(218,212,187,0.12),_transparent_45%),linear-gradient(180deg,_rgba(212,206,178,0.04),_rgba(10,10,10,0))] text-nier-light">
            <NieRModal
                isOpen={Boolean(deleteTarget)}
                message={deleteTarget
                    ? `删除路由规则「${deleteTarget.name}」？\n\n· 软删进回收站，可恢复\n· 删除后不再参与发前匹配（解析时按「没有这条规则」处理）\n· 若它只是想暂时停用，应改点行上的 ON/OFF\n· 若它的目标指令要连带删，会走指令删除的同戳级联，不必分开删`
                    : ''}
                onConfirm={confirmDelete}
                onCancel={() => setDeleteTarget(null)}
            />

            <div className="px-5 py-5 flex flex-col gap-6">
                {/* Header */}
                <section className="border border-nier-light/30 bg-nier-dark/70 p-3">
                    <div className="text-[11px] font-mono tracking-[0.35em] opacity-50">{`PAGE ${page?.shortcut} // ROUTING`}</div>
                    <h1 className="mt-2 text-4xl font-black tracking-tight leading-none">{page?.titleZh}</h1>
                    <p className="mt-2 text-sm uppercase tracking-[0.25em] opacity-60">{page?.titleEn}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                        <span className="text-xs font-mono tracking-[0.2em]">
                            {`发前路由规则 (ROUTING RULES) · ${rows.length} 条`}
                        </span>
                        <ActionButton onClick={startCreate} busy={busy === 'save'}>新建 NEW</ActionButton>
                    </div>
                    <div className="mt-3 inline-flex items-center gap-2 border border-yellow-500/40 bg-yellow-500/10 px-3 py-1 text-[11px] font-mono tracking-[0.2em] text-yellow-300">
                        <span className="h-2 w-2 bg-yellow-300 animate-pulse" />
                        {page?.status}
                    </div>
                </section>

                {/* Sys / Err line */}
                {(errMsg || sysMsg) && (
                    <div className="border border-nier-light/40 bg-nier-dark/70 px-4 py-2 text-xs font-mono whitespace-pre-line">
                        {errMsg
                            ? <span className="text-red-400">ERR: {errMsg}</span>
                            : <span>SYS: {sysMsg}</span>}
                    </div>
                )}

                {/* 口径说明 —— 只陈述后端已定的事实，FE 不改判 */}
                <section className="border border-nier-light/30 bg-nier-dark/60">
                    <PanelTitle hint="PLAN §8.68 / §8.70">口径 (GROUND RULES)</PanelTitle>
                    <ul className="p-4 space-y-1.5 text-[11px] font-mono leading-relaxed opacity-80">
                        <li>· 匹配顺序 = 本列表顺序（后端按 sort_order, name, id 定序）；first-match-wins，排在前面的先判真。</li>
                        <li>· 停用行与已软删行不参与匹配（列表本来就只出活行）。</li>
                        <li>· 条件语法坏掉记进 invalid 并继续往下扫；变量不在本次输入里 = 普通不命中，不记 invalid。</li>
                        <li>· 试解析还出「逐条判定轨迹」：一条规则一行「为什么」（比较不成立 / 变量不在本次输入里 / 类型不可比 / 已停用 / 未轮到），由后端回执给出，本页只排版不改判。</li>
                        <li>· 全无命中 = matched false，不猜：调用方维持人工选指令。</li>
                        <li>· 名称在本页只拦得到活行；软删行仍占用名称，撞名由后端 400 兜底、detail 原样透出。</li>
                    </ul>
                </section>

                <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-6 items-start">
                    {/* ── 左：顺序列表（就是匹配顺序） ── */}
                    <section className="border border-nier-light/30 bg-nier-dark/60">
                        <PanelTitle hint="GET /routing-rules">规则顺序 (MATCH ORDER)</PanelTitle>

                        {orderDirty && (
                            <div className="flex flex-wrap items-center gap-2 border-b border-nier-light/20 px-4 py-2">
                                <span className="text-[11px] font-mono text-yellow-300">
                                    {`● ${orderPlan.length} 条顺序待保存`}
                                </span>
                                <ActionButton onClick={saveOrder} busy={busy === 'order'}>保存顺序 SAVE ORDER</ActionButton>
                                <ActionButton onClick={revertOrder}>放弃 REVERT</ActionButton>
                            </div>
                        )}

                        {loadError ? (
                            <div className="p-5 text-center text-xs font-mono text-red-400">
                                {`ERR: 读取规则列表失败 —— ${loadError}`}
                                <div className="mt-3">
                                    <ActionButton onClick={loadRules} busy={busy === 'load'}>重试 RETRY</ActionButton>
                                </div>
                            </div>
                        ) : rows.length === 0 ? (
                            <div className="p-5 text-center">
                                <div className="text-xs font-bold tracking-[0.3em] opacity-70">暂无发前路由规则 (NO RULES)</div>
                                <p className="mt-2 text-[11px] font-mono opacity-50">
                                    输入条件 → 命中即选中指令。先建一条，加工页才有自动选指令的依据。
                                </p>
                            </div>
                        ) : (
                            <ul>
                                {rows.map((rule, index) => (
                                    <li key={rule.id} className="border-b border-nier-light/15 last:border-b-0">
                                        <div className="flex items-start gap-3 px-4 py-2.5">
                                            <span className="mt-0.5 font-mono text-[11px] text-nier-light/60 shrink-0">
                                                {`#${index + 1}`}
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex flex-wrap items-baseline gap-2">
                                                    <span className="text-sm font-bold tracking-wide">{rule.name}</span>
                                                    <span className="text-[10px] font-mono tracking-[0.15em] opacity-50">
                                                        {`sort ${Number(rule.sort_order) || 0}`}
                                                    </span>
                                                    {planById.has(rule.id) && (
                                                        <span className="text-[10px] font-mono tracking-[0.15em] text-yellow-300">
                                                            {`→ ${planById.get(rule.id)}`}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="mt-0.5 text-[11px] font-mono opacity-70 break-all">
                                                    {`COND :: ${rule.condition}`}
                                                </div>
                                                <div className="mt-0.5 text-[10px] font-mono opacity-60">
                                                    <span className="opacity-70">{'→ '}</span>
                                                    <span>{instructionName(rule.instruction_id)}</span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1.5 shrink-0">
                                                <RowButton
                                                    label={`切换启停 ${rule.name}`}
                                                    onClick={() => toggleEnabled(rule)}
                                                    disabled={busy === `toggle:${rule.id}`}
                                                >
                                                    {rule.enabled ? '● ON' : '○ OFF'}
                                                </RowButton>
                                                <RowButton
                                                    label={`上移 ${rule.name}`}
                                                    onClick={() => nudge(rule, -1)}
                                                    disabled={index === 0}
                                                >
                                                    ↑
                                                </RowButton>
                                                <RowButton
                                                    label={`下移 ${rule.name}`}
                                                    onClick={() => nudge(rule, 1)}
                                                    disabled={index === rows.length - 1}
                                                >
                                                    ↓
                                                </RowButton>
                                                <RowButton label={`编辑 ${rule.name}`} onClick={() => startEdit(rule)}>
                                                    编辑
                                                </RowButton>
                                                <RowButton
                                                    label={`删除 ${rule.name}`}
                                                    onClick={() => requestDelete(rule)}
                                                    disabled={busy === `delete:${rule.id}`}
                                                    danger
                                                >
                                                    删除
                                                </RowButton>
                                            </div>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    {/* ── 右：表单 ── */}
                    <section className="border border-nier-light/30 bg-nier-dark/60">
                        <PanelTitle hint={editingId ? 'PUT /routing-rules/{id}' : 'POST /routing-rules'}>
                            {draft
                                ? (editingId ? '编辑规则 (EDIT RULE)' : '新建规则 (NEW RULE)')
                                : '规则表单 (RULE FORM)'}
                        </PanelTitle>

                        {!draft ? (
                            <div className="p-5 text-center">
                                <div className="text-xs font-bold tracking-[0.3em] opacity-70">未选中规则 (NO SELECTION)</div>
                                <p className="mt-2 text-[11px] font-mono opacity-50">
                                    点左侧任一行的「编辑」改一条，或点上方「新建 NEW」建一条。
                                </p>
                            </div>
                        ) : (
                            <div className="p-4 flex flex-col gap-4">
                                <div>
                                    <label htmlFor="rule-name" className="block text-[10px] font-mono tracking-[0.2em] opacity-70">
                                        规则名称 NAME
                                    </label>
                                    <input
                                        id="rule-name"
                                        type="text"
                                        maxLength={MAX_RULE_NAME}
                                        value={draft.name}
                                        onChange={(e) => patchDraft({ name: e.target.value })}
                                        className="mt-1 w-full border border-nier-light/40 bg-nier-dark px-2 py-1.5 text-sm font-mono text-nier-light focus:border-nier-light"
                                    />
                                    {dirtyErrors.name && (
                                        <div className="mt-1 text-[11px] font-mono text-red-400">{dirtyErrors.name}</div>
                                    )}
                                </div>

                                <div>
                                    <label htmlFor="rule-target" className="block text-[10px] font-mono tracking-[0.2em] opacity-70">
                                        目标指令 TARGET
                                    </label>
                                    <select
                                        id="rule-target"
                                        value={draft.instruction_id}
                                        onChange={(e) => patchDraft({ instruction_id: e.target.value })}
                                        className="mt-1 w-full border border-nier-light/40 bg-nier-dark px-2 py-1.5 text-sm font-mono text-nier-light focus:border-nier-light"
                                    >
                                        <option value="">（未选择）</option>
                                        {(instructions || []).map((inst) => (
                                            <option key={inst.id} value={inst.id}>
                                                {inst.name || inst.code || inst.id}
                                            </option>
                                        ))}
                                        {draft.instruction_id
                                            && !(instructions || []).some((i) => i.id === draft.instruction_id) && (
                                            <option value={draft.instruction_id}>
                                                {instructionName(draft.instruction_id)}
                                            </option>
                                        )}
                                    </select>
                                    {dirtyErrors.instruction_id && (
                                        <div className="mt-1 text-[11px] font-mono text-red-400">{dirtyErrors.instruction_id}</div>
                                    )}
                                </div>

                                <div>
                                    <label htmlFor="rule-condition" className="block text-[10px] font-mono tracking-[0.2em] opacity-70">
                                        命中条件 CONDITION
                                    </label>
                                    <input
                                        id="rule-condition"
                                        type="text"
                                        maxLength={200}
                                        value={draft.condition}
                                        onChange={(e) => patchDraft({ condition: e.target.value })}
                                        placeholder="meter_id == 0001"
                                        className="mt-1 w-full border border-nier-light/40 bg-nier-dark px-2 py-1.5 text-sm font-mono text-nier-light focus:border-nier-light"
                                    />
                                    <div className="mt-1 text-[10px] font-mono opacity-50">
                                        受限表达式一次比较：== != &gt;= &lt;= &gt; &lt; 与 in；无算术、无括号、无布尔连接。
                                    </div>
                                    {dirtyErrors.condition && (
                                        <div className="mt-1 text-[11px] font-mono text-red-400">{dirtyErrors.condition}</div>
                                    )}
                                </div>

                                <div>
                                    <label htmlFor="rule-desc" className="block text-[10px] font-mono tracking-[0.2em] opacity-70">
                                        说明 DESCRIPTION
                                    </label>
                                    <textarea
                                        id="rule-desc"
                                        rows={2}
                                        value={draft.description}
                                        onChange={(e) => patchDraft({ description: e.target.value })}
                                        className="mt-1 w-full border border-nier-light/40 bg-nier-dark px-2 py-1.5 text-sm font-mono text-nier-light focus:border-nier-light"
                                    />
                                </div>

                                <div className="border-t border-nier-light/20 pt-3 flex flex-wrap items-center gap-2">
                                    <ActionButton onClick={saveRule} busy={busy === 'save'}>保存 SAVE</ActionButton>
                                    <ActionButton onClick={closeDraft}>放弃 CANCEL</ActionButton>
                                    <span className="text-[10px] font-mono opacity-50">
                                        {editingId ? 'PUT 整体替换（六字段全量）' : 'POST · sort_order 落当前末位'}
                                    </span>
                                </div>
                            </div>
                        )}
                    </section>
                </div>

                {/* ── R40（§8.72）试解析：给一组输入，看会命中哪条（只回显） ── */}
                <section className="border border-nier-light/30 bg-nier-dark/60">
                    <PanelTitle hint="POST /dispatch/routed · 只解析不发送">试解析 (DRY RUN)</PanelTitle>
                    <div className="p-4 flex flex-col gap-3">
                        <div className="text-[11px] font-mono leading-relaxed opacity-70">
                            {`按已保存的规则计算（表单与顺序的未保存改动不参与）· ${filledInputCount(dryRows)} 项有效 · 值按 JSON 标量解析（0001 → 数字，"0001" → 字符串），空键不发`}
                        </div>

                        {/* 顺序草稿会让人对着旧顺序的结果推新顺序 —— 有草稿就当场点破 */}
                        {orderDirty && (
                            <div className="border border-yellow-500/40 bg-yellow-500/10 px-3 py-1.5 text-[11px] font-mono text-yellow-300">
                                {`${orderPlan.length} 条顺序待保存 —— 试解析按已落库顺序计算。`}
                            </div>
                        )}

                        <div className="flex flex-col gap-1.5">
                            <RouteInputTable
                                rows={dryRows}
                                onChange={setDryRows}
                                idPrefix="dry"
                                labels={{ key: '试解析键', value: '试解析值', remove: '删除试解析输入' }}
                            />
                            <div className="pt-1">
                                <ActionButton onClick={() => setDryRows((prev) => addRouteInput(prev))}>
                                    + 添加 ADD
                                </ActionButton>
                            </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                            <ActionButton onClick={runDry} busy={dryBusy}>试解析 DRY RUN</ActionButton>
                            <span className="text-[10px] font-mono opacity-50">
                                只回显结果 —— 不选中规则、不改表单与顺序
                            </span>
                        </div>

                        {dry && (
                            <div className="border-t border-nier-light/20 pt-3 flex flex-col gap-2">
                                <div className={[
                                    'text-[11px] font-mono whitespace-pre-line',
                                    dry.kind === 'err' ? 'text-red-400'
                                        : dry.kind === 'miss' ? 'text-yellow-300'
                                            : 'text-nier-light',
                                ].join(' ')}>
                                    {dry.kind === 'err' ? 'ERR: ' : 'SYS: '}
                                    {dry.headline}
                                </div>

                                {/* 四行结果表 = 回执原样转写；失败时回执就没有内容可转写 */}
                                {dry.kind !== 'err' && (
                                    <dl className="border border-nier-light/20">
                                        {dry.rows.map((row, index) => (
                                            <div
                                                key={`dry-row-${index}`}
                                                className="flex items-baseline gap-3 border-b border-nier-light/10 px-3 py-1.5 last:border-b-0"
                                            >
                                                <dt className="w-24 shrink-0 text-[10px] font-mono tracking-[0.15em] text-nier-light/60">
                                                    {row.label}
                                                </dt>
                                                <dd
                                                    data-testid={`dry-result-${index}`}
                                                    className="min-w-0 flex-1 text-[11px] font-mono break-all"
                                                >
                                                    {row.value}
                                                </dd>
                                            </div>
                                        ))}
                                    </dl>
                                )}

                                {/* R43（§8.75）逐条判定轨迹 —— 后端给的机器码 + 事实载荷，
                                    这里只排版；FE 不扫第二遍条件（判据在后端 condition.py）。
                                    回执没给 trace（旧后端）→ describeDryRun 出 [] → 不出块。 */}
                                {dry.kind !== 'err' && dry.trace.length > 0 && (
                                    <div className="flex flex-col gap-1.5">
                                        <div className="text-[10px] font-mono tracking-[0.2em] opacity-60">
                                            {`逐条判定轨迹 (TRACE) · ${dry.trace.length} 条`}
                                        </div>
                                        <ol className="border border-nier-light/20">
                                            {dry.trace.map((row) => (
                                                <li
                                                    key={`dry-trace-${row.index}`}
                                                    data-testid={`dry-trace-${row.index - 1}`}
                                                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-nier-light/10 px-3 py-1.5 last:border-b-0 text-[11px] font-mono"
                                                >
                                                    <span className="shrink-0 text-nier-light/50">
                                                        {`#${row.index}`}
                                                    </span>
                                                    <span className={row.code === 'MATCHED'
                                                        ? 'shrink-0 text-yellow-300'
                                                        : 'shrink-0'}>
                                                        {row.name}
                                                    </span>
                                                    <span className="min-w-0 break-all opacity-60">
                                                        {row.condition}
                                                    </span>
                                                    <span className={row.code === 'MATCHED'
                                                        ? 'min-w-0 text-yellow-300'
                                                        : 'min-w-0'}>
                                                        {row.text}
                                                    </span>
                                                </li>
                                            ))}
                                        </ol>
                                    </div>
                                )}

                                {dry.kind === 'miss' && (
                                    <div className="text-[10px] font-mono leading-relaxed opacity-50">
                                        为什么没命中 —— 比较不成立 / 变量不在本次输入里 / 类型不可比，
                                        三者都是普通不命中、不记缺陷；
                                        是哪一条、哪一类见上方轨迹；条件原文见左列表 COND 行。
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </section>
            </div>
        </div>
    );
}
