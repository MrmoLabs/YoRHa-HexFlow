import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import NieRModal from '../components/ui/NieRModal';
import { PAGE_STATUS_BY_KEY } from '../config/pageRegistry';

// R6-2（PLAN §8.44）：回收站页 —— 后端 8 类可回收对象的统一落点。
//
// 语义对齐 backend/routers/trash.py：
//   · 列表 = `GET /trash`，**最近删的在前**；被父行连带入站的子行不单列
//     （宿主恢复时一并回来），所以这里条目数 ≤ 实际打标行数；
//   · 恢复 = `POST /trash/{kind}/{id}/restore`（回执 `related` = 级联恢复条数）；
//   · 彻底删除 = `DELETE /trash/{kind}/{id}`（真删行 + 按外键清引用者，不可逆）。
//
// 已知取舍（§8.43 四，UI 必须如实告诉用户）：
//   ① 软删行**继续占用唯一键** → 站内同名新建/改名 400，彻底删除才释放；
//   ② 配方/档案的指针（默认配方 / 激活指针）在删除期已解除、恢复不回填。
//
// R37（§8.69）：第 8 类 `routing_rule`（发前路由规则）。它**不走**「宿主在站就
// 隐藏」的代理过滤 —— 独立入站的规则与宿主入站时间戳不同，宿主恢复带不回它，
// 一旦被隐藏就再也看不见；所以它始终自己占一行。

const KIND_LABELS = {
    protocol: '协议',
    instruction: '指令',
    binding: '绑定',
    recipe: '配方',
    sequence: '序列',
    profile: '档案',
    response_spec: '应答规格',
    routing_rule: '路由规则'
};

const kindLabel = (kind) => KIND_LABELS[kind] || kind;

// R13（PLAN §8.49）：筛选 chips 的固定次序（= KIND_LABELS 字面量同序）。不按出现
// 频次重排 —— 排序随数据抖动会让人以为列表本身变了。
const KIND_ORDER = Object.keys(KIND_LABELS);

// R13：批量选择的键 = `kind:id`（类型 + 行 id 一起钉，跨类型不会撞）。恢复 / 清空 /
// 切筛选都只比字符串、不回读服务端；刷新时按现存条目剪枝（见 refresh），不留幽灵勾。
const itemKey = (item) => `${item.kind}:${item.id}`;

// `deleted_at` = UTC ISO（微秒精度，如 2026-10-02T09:15:00.123456+00:00）。
// 只做展示，不参与比较 —— 排序由后端（最近删的在前）说了算。
const formatDeletedAt = (iso) => {
    if (!iso) return '—';
    const at = iso.indexOf('T');
    if (at < 0) return iso;
    // 秒级截断（微秒与偏移不进表格列，避免撑宽第三列）
    const stamp = `${iso.slice(0, at)} ${iso.slice(at + 1, at + 9)}`;
    return /(\+00:00|Z)$/.test(iso) ? `${stamp} UTC` : stamp;
};

// 级联回执 `{bindings: 1, response_specs: 1}` → `（级联 2 条）`；全 0 时不啰嗦。
const relatedText = (related) => {
    const total = Object.values(related || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
    return total > 0 ? `（级联 ${total} 条）` : '';
};

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
                ? 'border-red-500/60 text-warn enabled:hover:bg-red-500 enabled:hover:text-nier-dark'
                : 'border-nier-light/70 text-nier-light enabled:hover:bg-nier-light enabled:hover:text-nier-dark'
        ].join(' ')}
    >
        {busy ? '…' : children}
    </button>
);

export default function Trash() {
    const page = PAGE_STATUS_BY_KEY.trash;
    const [items, setItems] = useState([]);
    const [loadError, setLoadError] = useState('');
    const [sysMsg, setSysMsg] = useState('');
    // 'restore:<id>' | 'purge:<id>' —— 单行级忙态，只禁用该行按钮；
    // 'bulk-restore' | 'bulk-purge' —— R13 批量忙态（禁全部行 + 顶部批量按钮）
    const [busy, setBusy] = useState('');
    // 待确认的彻底删除目标：单条 {kind,id,label} / 批量 {bulk,items}；null = 弹窗关闭
    const [purgeTarget, setPurgeTarget] = useState(null);
    // R13：'all' | kind —— 只切「可见行」，不改 items（行序仍由后端「最近删的在前」定）
    const [filter, setFilter] = useState('all');
    const [checked, setChecked] = useState(() => new Set()); // R13：选中条目的 itemKey

    const refresh = useCallback(async () => {
        try {
            const data = await api.listTrash();
            const list = Array.isArray(data?.items) ? data.items : [];
            setItems(list);
            setLoadError('');
            // R13：选择只保留仍存在的条目（已恢复 / 已清空 / 后端换了一批 → 不留幽灵勾）
            const alive = new Set(list.map(itemKey));
            setChecked((prev) => {
                const next = new Set([...prev].filter((key) => alive.has(key)));
                return next.size === prev.size ? prev : next;
            });
        } catch (err) {
            setLoadError(err?.message || '无法连接后端服务');
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    // ── R13 · 类型筛选 + 批量选择（PLAN §8.49）──────────────────────────────
    // 计数与可见集都从 `items` 派生：筛选是**行的子集**，子集内行序照旧（后端
    // 「最近删的在前」说了算），前端不重排。
    const kindCounts = useMemo(() => {
        const map = new Map();
        items.forEach((item) => map.set(item.kind, (map.get(item.kind) || 0) + 1));
        return map;
    }, [items]);

    const visibleItems = filter === 'all' ? items : items.filter((item) => item.kind === filter);
    const selectedItems = items.filter((item) => checked.has(itemKey(item)));
    const visibleChecked = visibleItems.filter((item) => checked.has(itemKey(item))).length;
    const allVisibleChecked = visibleItems.length > 0 && visibleChecked === visibleItems.length;
    const bulkBusy = busy === 'bulk-restore' || busy === 'bulk-purge';
    const rowBusyOf = (item) => bulkBusy || busy === `restore:${item.id}` || busy === `purge:${item.id}`;

    const toggleChecked = (item, on) => setChecked((prev) => {
        const next = new Set(prev);
        const key = itemKey(item);
        if (on) next.add(key); else next.delete(key);
        return next;
    });

    // 表头全选只动「当前筛选可见」的行；已选但被筛掉的行不清（批量作用于已选全集）
    const toggleAllVisible = (on) => setChecked((prev) => {
        const next = new Set(prev);
        visibleItems.forEach((item) => {
            const key = itemKey(item);
            if (on) next.add(key); else next.delete(key);
        });
        return next;
    });

    // R13 批量：**逐条执行、逐条回报** —— 后端本就是单条接口（无批量端点），不做整批
    // 事务：半成也如实报「成功 N / M + 失败明细逐条列出」，绝不静默吞错，也不整批回滚。
    const runBulk = async (mode, targets) => {
        if (bulkBusy || targets.length === 0) return;
        setBusy(mode === 'restore' ? 'bulk-restore' : 'bulk-purge');
        const fails = [];
        for (const item of targets) {
            try {
                if (mode === 'restore') await api.restoreTrashItem(item.kind, item.id);
                else await api.purgeTrashItem(item.kind, item.id);
            } catch (err) {
                fails.push(`${kindLabel(item.kind)}「${item.label}」：${err?.message || '未知错误'}`);
            }
        }
        setChecked(new Set());
        await refresh();
        setBusy('');
        const head = mode === 'restore'
            ? `批量恢复：成功 ${targets.length - fails.length} / ${targets.length} 条`
            : `批量彻底删除：成功 ${targets.length - fails.length} / ${targets.length} 条（不可恢复）`;
        setSysMsg(fails.length ? `${head}\n${fails.join('\n')}` : head);
    };

    const handleRestore = async (item) => {
        setBusy(`restore:${item.id}`);
        try {
            const result = await api.restoreTrashItem(item.kind, item.id);
            setSysMsg(`已恢复${kindLabel(item.kind)}「${item.label}」${relatedText(result?.related)}，列表与相关页面已可再次看到它。`);
            await refresh();
        } catch (err) {
            setSysMsg(`恢复失败：${err?.message || '未知错误'}`);
        } finally {
            setBusy('');
        }
    };

    // 彻底删除必须过弹窗（不可逆）：先取目标，确认才 DELETE。
    const handlePurgeConfirm = async () => {
        const target = purgeTarget;
        setPurgeTarget(null);
        if (!target) return;
        // R13 批量：同一弹窗、同一确认门槛，执行改走「逐条回报」的 runBulk
        if (target.bulk) {
            await runBulk('purge', target.items);
            return;
        }
        setBusy(`purge:${target.id}`);
        try {
            const result = await api.purgeTrashItem(target.kind, target.id);
            setSysMsg(`已彻底删除${kindLabel(target.kind)}「${target.label}」${relatedText(result?.related)}；行与引用者均已从库中移除，不可恢复。`);
            await refresh();
        } catch (err) {
            setSysMsg(`彻底删除失败：${err?.message || '未知错误'}`);
        } finally {
            setBusy('');
        }
    };

    return (
        <div className="flex-1 overflow-auto bg-[radial-gradient(circle_at_top,_rgba(218,212,187,0.12),_transparent_45%),linear-gradient(180deg,_rgba(212,206,178,0.04),_rgba(10,10,10,0))] text-nier-light">
            <NieRModal
                isOpen={Boolean(purgeTarget)}
                message={purgeTarget
                    ? (purgeTarget.bulk
                        // R13 批量：先把名单摆出来（前 8 条，超出折叠），再讲清半成口径
                        ? `确认彻底删除所选 ${purgeTarget.items.length} 条？\n\n· ${purgeTarget.items.slice(0, 8).map((item) => `${kindLabel(item.kind)}「${item.label}」`).join('\n· ')}${purgeTarget.items.length > 8 ? `\n· …另 ${purgeTarget.items.length - 8} 条` : ''}\n\n· 逐条真删行 + 按外键清引用者，不可逆（回收站内也不会再有它们）\n· 半成如实回报：成功几条、失败哪几条（不静默吞错）\n· 同名序列/档案在此之前一直占用名称（彻底删除才释放）\n· 若只是想找回，应改点「恢复」`
                        : `确认彻底删除${kindLabel(purgeTarget.kind)}「${purgeTarget.label}」？\n\n· 该行与其引用者（级联子行）将从数据库中移除\n· 此操作不可恢复，回收站内也不会再有它\n· 同名序列/档案在此之前一直占用名称（新建同名会被拒）\n· 若只是想找回，应改点「恢复」`)
                    : ''}
                onConfirm={handlePurgeConfirm}
                onCancel={() => setPurgeTarget(null)}
            />

            <div className="px-5 py-5 flex flex-col gap-6">
                {/* Header */}
                <section className="border border-nier-light/30 bg-nier-dark/70 p-3">
                    <div className="text-[11px] font-mono tracking-[0.35em] opacity-50">{`PAGE ${page.shortcut} // TRASH`}</div>
                    <h1 className="mt-2 text-4xl font-black tracking-tight leading-none">{page.titleZh}</h1>
                    <p className="mt-2 text-sm uppercase tracking-[0.25em] opacity-60">{page.titleEn}</p>
                    <div className="mt-3 inline-flex items-center gap-2 border border-yellow-500/40 bg-yellow-500/10 px-3 py-1 text-[11px] font-mono tracking-[0.2em] text-hl">
                        <span className="h-2 w-2 bg-yellow-300 animate-pulse" />
                        {page.status}
                    </div>
                </section>

                {/* Sys line */}
                {(sysMsg || loadError) && (
                    <div className="border border-nier-light/40 bg-nier-dark/70 px-4 py-2 text-xs font-mono whitespace-pre-line">
                        {loadError ? <span className="text-warn">ERR: {loadError}</span> : <span>SYS: {sysMsg}</span>}
                    </div>
                )}

                {/* 口径说明（把 §8.43 的已知取舍如实讲给操作员） */}
                <section className="border border-nier-light/30 bg-nier-dark/60">
                    <PanelTitle hint="PLAN §8.43 四">口径 (GROUND RULES)</PanelTitle>
                    <ul className="p-4 space-y-1.5 text-[11px] font-mono leading-relaxed opacity-80">
                        <li>· 删除 = 移入回收站（行仍在库，读侧不可见）；恢复 = 清标记，并把同一时间戳的级联子行一并捞回。</li>
                        <li>· 回收站内的条目【仍占用名称】：同名序列 / 档案的新建与改名会被 400 拒绝，彻底删除后释放。</li>
                        <li>· 配方与设备档案的指针（默认配方 / 激活档案）在删除期已解除，恢复后需重新指定、重新激活。</li>
                        <li>· 序列步骤等冻结快照随宿主隐藏但不单独入站；通讯日志清空仍是硬删，不进本页。</li>
                    </ul>
                </section>

                {/* 列表 */}
                <section className="border border-nier-light/30 bg-nier-dark/60">
                    <PanelTitle hint="GET /trash">{`回收站条目 (TRASH ITEMS) · ${items.length}`}</PanelTitle>

                    {/* R13 · 类型筛选 chips + 批量动作条（有条目才出，空态不占位） */}
                    {!loadError && items.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 border-b border-nier-light/20 px-4 py-2">
                            {[
                                { key: 'all', label: '全部', n: items.length },
                                ...KIND_ORDER.filter((kind) => kindCounts.has(kind))
                                    .map((kind) => ({ key: kind, label: kindLabel(kind), n: kindCounts.get(kind) }))
                            ].map((chip) => {
                                const on = filter === chip.key;
                                return (
                                    <button
                                        key={chip.key}
                                        type="button"
                                        aria-pressed={on}
                                        onClick={() => setFilter(chip.key)}
                                        className={`border px-2 py-1 text-[10px] font-mono tracking-[0.15em] transition-colors duration-150 ${on
                                            ? 'border-nier-light bg-nier-light text-nier-dark'
                                            : 'border-nier-light/40 text-muted hover:border-nier-light/70'}`}
                                    >
                                        {`${chip.label} ${chip.n}`}
                                    </button>
                                );
                            })}
                            <span className="flex-1" />
                            <span className="text-[10px] font-mono opacity-60">已选 {selectedItems.length} 条</span>
                            <ActionButton
                                onClick={() => runBulk('restore', selectedItems)}
                                disabled={selectedItems.length === 0}
                                busy={busy === 'bulk-restore'}
                            >
                                {`批量恢复 (${selectedItems.length})`}
                            </ActionButton>
                            <ActionButton
                                danger
                                onClick={() => setPurgeTarget({ bulk: true, items: selectedItems })}
                                disabled={selectedItems.length === 0}
                                busy={busy === 'bulk-purge'}
                            >
                                {`批量彻底删除 (${selectedItems.length})`}
                            </ActionButton>
                            {selectedItems.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setChecked(new Set())}
                                    className="border border-nier-light/40 px-2 py-1 text-[10px] font-mono hover:border-nier-light"
                                >
                                    清除选择
                                </button>
                            )}
                        </div>
                    )}

                    {loadError ? (
                        <div className="p-5 text-center text-xs font-mono text-warn">
                            读取失败：{loadError}
                            <div className="mt-3">
                                <ActionButton onClick={refresh}>重试 (RETRY)</ActionButton>
                            </div>
                        </div>
                    ) : items.length === 0 ? (
                        <div className="p-5 text-center">
                            <div className="text-xs font-bold tracking-[0.3em] opacity-70">回收站为空 (TRASH EMPTY)</div>
                            <p className="mt-2 text-[11px] font-mono opacity-50">
                                所有删除操作都会先落到这里 —— 误删时可在此找回。
                            </p>
                        </div>
                    ) : visibleItems.length === 0 ? (
                        // R13：有条目但当前筛选没命中 —— 不冒充「回收站为空」，并给回全集的出口
                        <div className="p-5 text-center">
                            <div className="text-xs font-bold tracking-[0.3em] opacity-70">该类型下没有条目 (NO ITEMS OF THIS KIND)</div>
                            <p className="mt-2 text-[11px] font-mono opacity-50">
                                {`筛选只切可见行 —— 切回「全部」可看到其余 ${items.length} 条。`}
                            </p>
                            <div className="mt-3">
                                <ActionButton onClick={() => setFilter('all')}>清除筛选 (SHOW ALL)</ActionButton>
                            </div>
                        </div>
                    ) : (
                        <div>
                            <div className="grid grid-cols-[24px_110px_1fr_190px_auto] items-center gap-4 border-b border-nier-light/20 px-4 py-2 text-[10px] font-mono tracking-[0.2em] opacity-50">
                                <input
                                    type="checkbox"
                                    aria-label="全选当前筛选"
                                    checked={allVisibleChecked}
                                    onChange={(e) => toggleAllVisible(e.target.checked)}
                                    disabled={bulkBusy}
                                    className="w-3.5 h-3.5"
                                />
                                <span>类型 KIND</span>
                                <span>名称 LABEL</span>
                                <span>删除时间 DELETED AT</span>
                                <span className="text-right">操作 ACTION</span>
                            </div>
                            {visibleItems.map((item) => {
                                const rowBusy = rowBusyOf(item);
                                const key = itemKey(item);
                                return (
                                    <div
                                        key={key}
                                        className="grid grid-cols-[24px_110px_1fr_190px_auto] items-center gap-4 border-b border-nier-light/10 px-4 py-2.5 hover:bg-nier-light/5 transition-colors duration-150"
                                    >
                                        <input
                                            type="checkbox"
                                            aria-label={`选择 ${kindLabel(item.kind)}「${item.label}」`}
                                            checked={checked.has(key)}
                                            onChange={(e) => toggleChecked(item, e.target.checked)}
                                            disabled={Boolean(busy)}
                                            className="w-3.5 h-3.5"
                                        />
                                        <span className="border border-nier-light/40 px-2 py-0.5 text-center text-[10px] font-bold tracking-[0.15em]">
                                            {kindLabel(item.kind)}
                                        </span>
                                        <span className="truncate text-xs font-mono" title={item.label}>{item.label}</span>
                                        <span className="text-[11px] font-mono opacity-60">{formatDeletedAt(item.deleted_at)}</span>
                                        <span className="flex justify-end gap-2">
                                            <ActionButton
                                                onClick={() => handleRestore(item)}
                                                busy={busy === `restore:${item.id}`}
                                                disabled={rowBusy}
                                            >
                                                恢复 RESTORE
                                            </ActionButton>
                                            <ActionButton
                                                danger
                                                onClick={() => setPurgeTarget(item)}
                                                busy={busy === `purge:${item.id}`}
                                                disabled={rowBusy}
                                            >
                                                彻底删除 PURGE
                                            </ActionButton>
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </section>

                {/* 底部动作 */}
                <div className="flex justify-end">
                    <ActionButton onClick={refresh} busy={Boolean(busy)}>刷新 (REFRESH)</ActionButton>
                </div>
            </div>
        </div>
    );
}
