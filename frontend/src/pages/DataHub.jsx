import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import NieRModal from '../components/ui/NieRModal';
import { PAGE_STATUS_BY_KEY } from '../config/pageRegistry';
import { buildBindingMatrix, protocolCellText, slotCellText } from '../utils/bindingMatrix';
import { triggerBlobDownload } from '../utils/download';

// C3 数据中心一期：环境状态面板 + 聚合导出 ZIP + 数据库备份/恢复。
// R7（PLAN §8.45）：聚合导出 3 域 → 8 域（补 recipes / sequences / transport /
// profiles / templates），manifest 加 domainVersion 域清单。
// R8（PLAN §8.46）：按域导入 —— R7 出线的 5 个新域补回灌（本批把 R7 的「不碰导入」
// 收口），入参是 ZIP 里解出来的任一域文件，形态自动识别域名。
// 端点见 backend/routers/datahub.py；恢复前会自动留 pre-restore 安全快照，按域导入前留 pre-import。

const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const COUNT_LABELS = [
    ['instructions', '指令 INSTRUCTIONS'],
    ['instructionFields', '字段 FIELDS'],
    ['bitFields', '位域 BITFIELDS'],
    ['protocols', '协议 PROTOCOLS'],
    ['operatorTemplates', '算子 OPERATORS'],
    // 批次四 4a: relations.json 随包导出的两张关系表
    ['protocolBindings', '绑定 BINDINGS'],
    ['responseSpecs', '应答规格 SPECS']
];

// R8（PLAN §8.46）：按域导入 —— 一个选择器吃 5 个域文件，**按顶层数组键识别域名**
// （键名与后端 `/datahub/import/<domain>` 的 path 一一对应，transport 用 settings 键）。
const DOMAIN_KEYS = [
    ['recipes', 'recipes'],
    ['sequences', 'sequences'],
    ['settings', 'transport'],
    ['profiles', 'profiles'],
    ['templates', 'templates']
];

const DOMAIN_LABELS = {
    recipes: '配方',
    sequences: '序列',
    transport: '传输配置',
    profiles: '设备档案',
    templates: '算子模板'
};

const PanelTitle = ({ children, hint }) => (
    <div className="flex items-baseline justify-between border-b border-nier-light/30 px-4 py-2 bg-nier-light/5">
        <span className="text-[11px] font-bold tracking-[0.3em] text-nier-light">{children}</span>
        {hint && <span className="text-[10px] font-mono opacity-50">{hint}</span>}
    </div>
);

const ActionButton = ({ onClick, disabled = false, busy = false, children }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled || busy}
        className="px-4 py-2 border border-nier-light/70 text-nier-light text-xs font-bold tracking-[0.2em] bg-nier-dark enabled:hover:bg-nier-light enabled:hover:text-nier-dark transition-colors duration-150 disabled:opacity-40"
    >
        {busy ? '处理中…' : children}
    </button>
);

export default function DataHub() {
    const page = PAGE_STATUS_BY_KEY.datahub;
    const [status, setStatus] = useState(null);
    const [loadError, setLoadError] = useState('');
    const [sysMsg, setSysMsg] = useState('');
    const [busy, setBusy] = useState(''); // 'export' | 'backup' | 'restore' | 'import'
    const [restoreTarget, setRestoreTarget] = useState(null);
    // 批次四 4a: 已解析待确认的关系数据包（{name, payload}）；确认才 POST。
    const [importTarget, setImportTarget] = useState(null);
    const importInputRef = React.useRef(null);
    // R8（PLAN §8.46）：按域导入 —— 5 个新域文件共用一个选择器，形态自动识别域名
    const [domainTarget, setDomainTarget] = useState(null);
    const domainInputRef = React.useRef(null);
    // 批次四 4b：绑定矩阵（指令 → 默认协议 → 槽位），utils/bindingMatrix 纯函数产出
    const [matrix, setMatrix] = useState({ rows: [], summary: null, loading: true, error: '' });

    const refresh = useCallback(async () => {
        try {
            setStatus(await api.getDatahubStatus());
            setLoadError('');
        } catch (err) {
            setLoadError(err?.message || '无法连接后端服务');
        }
        // 批次四 4b：绑定矩阵三读（指令 / 绑定 / 协议）与状态面板同拍刷新，
        // 单读失败不拖垮状态面板（各自 try）。
        try {
            const [instructions, bindings, protocols] = await Promise.all([
                api.getInstructions(),
                api.getBindings(),
                api.getProtocols()
            ]);
            setMatrix({
                ...buildBindingMatrix(instructions, bindings, protocols),
                loading: false,
                error: ''
            });
        } catch (err) {
            setMatrix((prev) => ({ ...prev, loading: false, error: err?.message || '无法加载绑定数据' }));
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const handleExport = async () => {
        setBusy('export');
        try {
            const blob = await api.exportDataBundle();
            const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
            triggerBlobDownload(blob, `yorha-datahub-${stamp}.zip`);
            setSysMsg(`导出完成：${formatBytes(blob.size)}（8 域：instructions.json + relations.json + recipes.json + sequences.json + transport.json + profiles.json + templates.json + frames/*.bin|hex，清单见 manifest.json）`);
        } catch (err) {
            setSysMsg(`导出失败：${err?.message || '未知错误'}`);
        } finally {
            setBusy('');
        }
    };

    const handleBackup = async () => {
        setBusy('backup');
        try {
            const { created } = await api.createDbBackup();
            setSysMsg(`备份完成：${created.name}（${formatBytes(created.sizeBytes)}）`);
            await refresh();
        } catch (err) {
            setSysMsg(`备份失败：${err?.message || '未知错误'}`);
        } finally {
            setBusy('');
        }
    };

    const handleRestoreConfirm = async () => {
        const name = restoreTarget?.name;
        setRestoreTarget(null);
        if (!name) return;
        setBusy('restore');
        try {
            const result = await api.restoreDbBackup(name);
            setSysMsg(`已从 ${result.restored} 恢复；安全快照：${result.safetySnapshot || '无'}。建议刷新页面重新加载数据。`);
            await refresh();
        } catch (err) {
            setSysMsg(`恢复失败：${err?.message || '未知错误'}`);
        } finally {
            setBusy('');
        }
    };

    // 批次四 4a：关系数据导入 —— 选文件 → 解析 → 弹确认 → POST /datahub/import/relations。
    // 解析失败 / 非对象 / 缺 bindings|responseSpecs 键一律不出弹窗，直接走 sysMsg 报错。
    const handleImportFile = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = ''; // 同一文件可重复选（change 不重发）
        if (!file) return;
        let payload;
        try {
            payload = JSON.parse(await file.text());
        } catch (err) {
            setSysMsg(`导入失败：文件不是合法 JSON（${err?.message || '解析错误'}）`);
            return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            setSysMsg('导入失败：relations.json 必须是 JSON 对象');
            return;
        }
        const bindings = Array.isArray(payload.bindings) ? payload.bindings.length : 0;
        const specs = Array.isArray(payload.responseSpecs) ? payload.responseSpecs.length : 0;
        if (!Array.isArray(payload.bindings) && !Array.isArray(payload.responseSpecs)) {
            setSysMsg('导入失败：缺 bindings / responseSpecs 数组（不是 relations.json）');
            return;
        }
        setImportTarget({ name: file.name, payload, bindings, specs });
    };

    const handleImportConfirm = async () => {
        const target = importTarget;
        setImportTarget(null);
        if (!target) return;
        setBusy('import');
        try {
            const report = await api.importRelations(target.payload);
            const b = report.bindings || {};
            const s = report.responseSpecs || {};
            const warns = (report.warnings || []).length;
            setSysMsg(
                `导入完成（${target.name}）：绑定 新增 ${b.imported ?? 0} / 更新 ${b.updated ?? 0} / 跳过 ${(b.skipped || []).length}；`
                + `应答规格 新增 ${s.imported ?? 0} / 更新 ${s.updated ?? 0} / 跳过 ${(s.skipped || []).length}；警告 ${warns} 条。`
                + ((b.skipped || []).length || (s.skipped || []).length ? ` 跳过明细见后端返回 skipped 字段。` : '')
            );
            await refresh();
        } catch (err) {
            setSysMsg(`导入失败：${err?.message || '未知错误'}`);
        } finally {
            setBusy('');
        }
    };

    // R8（PLAN §8.46）：按域导入 —— 选文件 → 按顶层数组键识别域名 → 弹确认 →
    // POST /datahub/import/<domain>。识别不出域 / 不是对象 / 非法 JSON 一律不出弹窗，
    // 直接走 sysMsg 报错（同 4a 关系导入的失败口径）。
    const handleDomainFile = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = ''; // 同一文件可重复选（change 不重发）
        if (!file) return;
        let payload;
        try {
            payload = JSON.parse(await file.text());
        } catch (err) {
            setSysMsg(`导入失败：文件不是合法 JSON（${err?.message || '解析错误'}）`);
            return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            setSysMsg('导入失败：域文件必须是 JSON 对象');
            return;
        }
        const hit = DOMAIN_KEYS.find(([key]) => Array.isArray(payload[key]));
        if (!hit) {
            setSysMsg('导入失败：识别不出域（缺 recipes / sequences / settings / profiles / templates 数组）');
            return;
        }
        setDomainTarget({
            name: file.name,
            domain: hit[1],
            payload,
            count: payload[hit[0]].length
        });
    };

    const handleDomainConfirm = async () => {
        const target = domainTarget;
        setDomainTarget(null);
        if (!target) return;
        setBusy('domain');
        try {
            const report = await api.importDomain(target.domain, target.payload);
            const skipped = (report.skipped || []).length;
            const warns = (report.warnings || []).length;
            const steps = report.steps ? ` · 写入步骤 ${report.steps.written ?? 0} 步` : '';
            setSysMsg(
                `导入完成（${target.name} · ${DOMAIN_LABELS[target.domain] || target.domain}）：`
                + `新增 ${report.imported ?? 0} / 更新 ${report.updated ?? 0} / 跳过 ${skipped}；`
                + `警告 ${warns} 条${steps}。`
                + (skipped ? ' 跳过明细见后端返回 skipped 字段。' : '')
            );
            await refresh();
        } catch (err) {
            setSysMsg(`导入失败：${err?.message || '未知错误'}`);
        } finally {
            setBusy('');
        }
    };

    return (
        <div className="flex-1 overflow-auto bg-[radial-gradient(circle_at_top,_rgba(218,212,187,0.12),_transparent_45%),linear-gradient(180deg,_rgba(212,206,178,0.04),_rgba(10,10,10,0))] text-nier-light">
            <NieRModal
                isOpen={Boolean(restoreTarget)}
                message={`确认从备份恢复数据库？\n\n源文件：${restoreTarget?.name || ''}\n\n· 恢复前会自动为当前库留安全快照\n· 恢复期间请勿进行其它写操作\n· 恢复完成后建议刷新页面`}
                onConfirm={handleRestoreConfirm}
                onCancel={() => setRestoreTarget(null)}
            />
            <NieRModal
                isOpen={Boolean(importTarget)}
                message={`确认导入关系数据？\n\n源文件：${importTarget?.name || ''}\n\n· 绑定 ${importTarget?.bindings ?? 0} 条 · 应答规格 ${importTarget?.specs ?? 0} 条\n· 按 id upsert（同 id 覆盖，出处指纹原样回填）\n· 父指令/协议缺失的行跳过并回报，部分成功即部分落库`}
                onConfirm={handleImportConfirm}
                onCancel={() => setImportTarget(null)}
            />
            <NieRModal
                isOpen={Boolean(domainTarget)}
                message={`确认导入${DOMAIN_LABELS[domainTarget?.domain] || domainTarget?.domain}？\n\n源文件：${domainTarget?.name || ''}\n\n· 条目 ${domainTarget?.count ?? 0} 条\n· 按 id upsert（同 id 覆盖，逐行报告）\n· 父宿主缺失 / 该行在回收站里的，跳过并回报原因\n· 导入前自动留 pre-import-* 安全快照，部分成功即部分落库`}
                onConfirm={handleDomainConfirm}
                onCancel={() => setDomainTarget(null)}
            />

            <div className="px-8 py-8 flex flex-col gap-6">
                {/* Header */}
                <section className="border border-nier-light/30 bg-nier-dark/70 p-3">
                    <div className="text-[11px] font-mono tracking-[0.35em] opacity-50">{`PAGE ${page.shortcut} // DATA HUB`}</div>
                    <h1 className="mt-2 text-4xl font-black tracking-tight leading-none">{page.titleZh}</h1>
                    <p className="mt-2 text-sm uppercase tracking-[0.25em] opacity-60">{page.titleEn}</p>
                    <div className="mt-3 inline-flex items-center gap-2 border border-yellow-500/40 bg-yellow-500/10 px-3 py-1 text-[11px] font-mono tracking-[0.2em] text-yellow-300">
                        <span className="h-2 w-2 bg-yellow-300 animate-pulse" />
                        {page.status}
                    </div>
                </section>

                {/* Sys line */}
                {(sysMsg || loadError) && (
                    <div className="border border-nier-light/40 bg-nier-dark/70 px-4 py-2 text-xs font-mono">
                        {loadError ? <span className="text-red-400">ERR: {loadError}</span> : <span>SYS: {sysMsg}</span>}
                    </div>
                )}

                <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                    {/* D3 环境状态面板 */}
                    <section className="border border-nier-light/30 bg-nier-dark/60">
                        <PanelTitle hint="GET /datahub/status">环境状态 (ENVIRONMENT)</PanelTitle>
                        <div className="p-4 space-y-3 text-xs font-mono">
                            {status ? (
                                <>
                                    <div className="flex justify-between gap-4">
                                        <span className="opacity-60">后端版本 VERSION</span>
                                        <span>{status.appVersion}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                        <span className="opacity-60">数据库 DB</span>
                                        <span className="truncate" title={status.dbPath}>{status.dbPath}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                        <span className="opacity-60">大小 SIZE</span>
                                        <span>{formatBytes(status.dbSizeBytes)} · {status.dbModifiedAt || '—'}</span>
                                    </div>
                                    <div className="border-t border-nier-light/20 pt-3 space-y-2">
                                        {COUNT_LABELS.map(([key, label]) => (
                                            <div key={key} className="flex justify-between gap-4">
                                                <span className="opacity-60">{label}</span>
                                                <span className="text-yellow-300">{status.counts?.[key] ?? '—'}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="border-t border-nier-light/20 pt-3 flex justify-between gap-4">
                                        <span className="opacity-60">备份 BACKUPS</span>
                                        <span>{(status.backups || []).length} 个</span>
                                    </div>
                                </>
                            ) : (
                                <div className="opacity-60">{loadError ? '状态不可用' : '加载中…'}</div>
                            )}
                            <div className="pt-2">
                                <ActionButton onClick={refresh}>刷新 (REFRESH)</ActionButton>
                            </div>
                        </div>
                    </section>

                    <div className="flex flex-col gap-6">
                        {/* D1 聚合导出 */}
                        <section className="border border-nier-light/30 bg-nier-dark/60">
                            <PanelTitle hint="GET /datahub/export/bundle">聚合导出 (BUNDLE EXPORT)</PanelTitle>
                            <div className="p-4 flex flex-col gap-3">
                                <p className="text-xs leading-6 opacity-80">
                                    打包下载全量指令 JSON（与指令管理页「导入」格式对称）、关系数据
                                    <span className="font-mono"> relations.json </span>
                                    （绑定 + 应答规格，批次四 4a）、逐指令骨架帧
                                    <span className="font-mono"> .bin / .hex </span>
                                    （Orchestrator 编译，未实现编码语义以 0x00 占位），
                                    以及 R7 补进来的 5 个域
                                    <span className="font-mono"> recipes / sequences / transport / profiles / templates </span>
                                    （配方、序列含步骤、传输配置、设备档案、算子模板）。
                                    <span className="font-mono"> manifest.json </span>
                                    给出 8 域清单（<span className="font-mono">domainVersion</span>
                                    与逐域行数），回收站里的行不进包。
                                </p>
                                <div>
                                    <ActionButton onClick={handleExport} busy={busy === 'export'}>
                                        下载 ZIP (EXPORT)
                                    </ActionButton>
                                </div>
                            </div>
                        </section>

                        {/* 批次四 4a：relations.json 回灌 */}
                        <section className="border border-nier-light/30 bg-nier-dark/60">
                            <PanelTitle hint="POST /datahub/import/relations">关系数据 (RELATIONS IMPORT)</PanelTitle>
                            <div className="p-4 flex flex-col gap-3">
                                <p className="text-xs leading-6 opacity-80">
                                    回灌 ZIP 内的 <span className="font-mono">relations.json</span>
                                    （绑定 + 应答规格）：按 <span className="font-mono">id </span>
                                    upsert，父指令/协议缺失的行跳过并回报，部分成功即部分落库、不整批回滚。
                                </p>
                                <input
                                    ref={importInputRef}
                                    type="file"
                                    accept=".json,application/json"
                                    className="hidden"
                                    data-testid="relations-import-input"
                                    onChange={handleImportFile}
                                />
                                <div>
                                    <ActionButton onClick={() => importInputRef.current?.click()} busy={busy === 'import'}>
                                        导入 JSON (IMPORT)
                                    </ActionButton>
                                </div>
                            </div>
                        </section>

                        {/* R8（PLAN §8.46）：按域导入 —— R7 出线的 5 个新域回灌 */}
                        <section className="border border-nier-light/30 bg-nier-dark/60">
                            <PanelTitle hint="POST /datahub/import/{recipes|sequences|transport|profiles|templates}">按域导入 (DOMAIN IMPORT)</PanelTitle>
                            <div className="p-4 flex flex-col gap-3">
                                <p className="text-xs leading-6 opacity-80">
                                    从 ZIP 里解出 R7 导出的任一域文件
                                    <span className="font-mono"> recipes / sequences / transport / profiles / templates </span>
                                    选入：按顶层数组键自动识别域名，按
                                    <span className="font-mono"> id </span>
                                    upsert、逐行报告；父宿主缺失（协议 / 指令不在）或该行正在回收站里的，
                                    跳过并回报原因，不写半条数据。导入前后端自动留
                                    <span className="font-mono"> pre-import-* </span>
                                    安全快照，部分成功即部分落库、不整批回滚。
                                </p>
                                <input
                                    ref={domainInputRef}
                                    type="file"
                                    accept=".json,application/json"
                                    className="hidden"
                                    data-testid="domain-import-input"
                                    onChange={handleDomainFile}
                                />
                                <div>
                                    <ActionButton onClick={() => domainInputRef.current?.click()} busy={busy === 'domain'}>
                                        导入域文件 (IMPORT)
                                    </ActionButton>
                                </div>
                            </div>
                        </section>

                        {/* D2 备份 / 恢复 */}
                        <section className="border border-nier-light/30 bg-nier-dark/60">
                            <PanelTitle hint="POST /datahub/backup · restore">备份 / 恢复 (BACKUP · RESTORE)</PanelTitle>
                            <div className="p-4 flex flex-col gap-3">
                                <div className="flex items-center gap-3">
                                    <ActionButton onClick={handleBackup} busy={busy === 'backup'}>
                                        新建备份 (BACKUP)
                                    </ActionButton>
                                    <span className="text-[11px] font-mono opacity-50">复制 yorha.db → backend/db/backups/</span>
                                </div>
                                <div className="border-t border-nier-light/20 pt-3">
                                    {(status?.backups || []).length === 0 ? (
                                        <div className="text-xs opacity-50">暂无备份。</div>
                                    ) : (
                                        <table className="w-full text-xs font-mono">
                                            <thead>
                                                <tr className="text-[10px] tracking-[0.2em] opacity-60 border-b border-nier-light/20">
                                                    <th className="text-left py-1 font-bold">文件 FILE</th>
                                                    <th className="text-right py-1 font-bold">大小 SIZE</th>
                                                    <th className="text-right py-1 font-bold">时间 MODIFIED</th>
                                                    <th className="text-right py-1 font-bold">操作 OPS</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {(status.backups || []).map((backup) => (
                                                    <tr key={backup.name} className="border-b border-nier-light/10">
                                                        <td className="py-1 truncate max-w-[14rem]" title={backup.name}>
                                                            {backup.name}
                                                            {backup.isSafetySnapshot && (
                                                                <span className="ml-2 text-yellow-300">[快照]</span>
                                                            )}
                                                        </td>
                                                        <td className="text-right py-1">{formatBytes(backup.sizeBytes)}</td>
                                                        <td className="text-right py-1 opacity-70">{backup.modifiedAt}</td>
                                                        <td className="text-right py-1">
                                                            <button
                                                                type="button"
                                                                disabled={busy === 'restore'}
                                                                onClick={() => setRestoreTarget(backup)}
                                                                className="px-2 py-1 border border-red-400/60 text-red-300 text-[10px] tracking-[0.15em] enabled:hover:bg-red-400/10 transition-colors duration-150 disabled:opacity-40"
                                                            >
                                                                恢复 (RESTORE)
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    )}
                                </div>
                                <p className="text-[11px] leading-5 opacity-60 border-t border-nier-light/20 pt-3">
                                    恢复会释放连接池并替换数据库文件（自动清理 WAL/SHM 残留），恢复期间请勿进行其它写操作。
                                </p>
                            </div>
                        </section>
                    </div>
                </div>

                {/* 批次四 4b（DESIGN_CorePipeline §7 批次四 ②）：绑定矩阵
                    只读总览（指令 → 默认协议 → 槽位）。孤儿关系不静默抹平：
                    协议/槽已删与 definition_hash 失效一律琥珀标出。 */}
                <section className="border border-nier-light/30 bg-nier-dark/60 mt-6" data-testid="binding-matrix">
                    <PanelTitle hint="GET /bindings · /instructions/ · /protocols/">绑定矩阵 (BINDING MATRIX)</PanelTitle>
                    <div className="p-4 flex flex-col gap-3">
                        <p className="text-xs leading-6 opacity-80">
                            只读总览：每行一条指令，看它落在哪条<span className="font-mono"> 默认协议 </span>的哪个
                            <span className="font-mono"> 槽位 </span>（无显式槽按
                            <span className="font-mono"> slot_order </span>位次）。
                            协议或槽已删的关系不静默抹平，标<span className="font-mono"> 悬空 </span>/
                            <span className="font-mono">（协议已删）</span>；绑定出处失效标
                            <span className="font-mono"> [失效]</span>。
                        </p>

                        {matrix.summary && (
                            <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] font-mono opacity-70" data-testid="matrix-summary">
                                <span>指令 {matrix.summary.instructions}</span>
                                <span>有默认协议 {matrix.summary.withDefault}</span>
                                <span>无绑定 {matrix.summary.unbound}</span>
                                <span>绑定 {matrix.summary.bindings}</span>
                                <span className={matrix.summary.danglingSlots ? 'text-yellow-300' : ''}>
                                    悬空槽 {matrix.summary.danglingSlots}
                                </span>
                                <span className={matrix.summary.missingProtocols ? 'text-yellow-300' : ''}>
                                    协议已删 {matrix.summary.missingProtocols}
                                </span>
                                <span className={matrix.summary.staleBindings ? 'text-yellow-300' : ''}>
                                    失效绑定 {matrix.summary.staleBindings}
                                </span>
                                {matrix.summary.extraDefaults > 0 && (
                                    <span className="text-yellow-300">重复默认 {matrix.summary.extraDefaults}</span>
                                )}
                            </div>
                        )}

                        {matrix.loading ? (
                            <div className="text-xs opacity-60">加载中…</div>
                        ) : matrix.error ? (
                            <div className="text-xs text-yellow-300">矩阵不可用：{matrix.error}</div>
                        ) : matrix.rows.length === 0 ? (
                            <div className="text-xs opacity-50">暂无指令。</div>
                        ) : (
                            <div className="overflow-x-auto border-t border-nier-light/20 pt-3">
                                <table className="w-full text-xs font-mono">
                                    <thead>
                                        <tr className="text-[10px] tracking-[0.2em] opacity-60 border-b border-nier-light/20">
                                            <th className="text-left py-1 font-bold">指令 CODE</th>
                                            <th className="text-left py-1 font-bold">名称 NAME</th>
                                            <th className="text-left py-1 font-bold">设备 DEVICE</th>
                                            <th className="text-left py-1 font-bold">默认协议 DEFAULT</th>
                                            <th className="text-left py-1 font-bold">槽位 SLOT</th>
                                            <th className="text-left py-1 font-bold">其它绑定 OTHER</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {matrix.rows.map((row) => (
                                            <tr key={row.id} className="border-b border-nier-light/10 align-top">
                                                <td className="py-1 pr-3 truncate max-w-[10rem]" title={row.id}>{row.code}</td>
                                                <td className="py-1 pr-3 truncate max-w-[14rem]" title={row.name}>{row.name}</td>
                                                <td className="py-1 pr-3 opacity-70">{row.deviceCode || '—'}</td>
                                                <td className="py-1 pr-3">
                                                    {row.defaultBinding ? (
                                                        <>
                                                            <span
                                                                className={row.defaultBinding.protocolMissing ? 'text-yellow-300' : ''}
                                                                title={row.defaultBinding.id}
                                                            >
                                                                {protocolCellText(row.defaultBinding)}
                                                            </span>
                                                            {row.defaultBinding.stale && (
                                                                <span className="ml-2 text-yellow-300">[失效]</span>
                                                            )}
                                                            {row.extraDefaults > 0 && (
                                                                <span className="ml-2 text-yellow-300">[默认×{row.extraDefaults + 1}]</span>
                                                            )}
                                                        </>
                                                    ) : (
                                                        <span className="opacity-40">—</span>
                                                    )}
                                                </td>
                                                <td className="py-1 pr-3">
                                                    {row.defaultBinding ? (
                                                        <span
                                                            className={row.defaultBinding.slotMissing ? 'text-yellow-300' : ''}
                                                            title={row.defaultBinding.slotId || ''}
                                                        >
                                                            {slotCellText(row.defaultBinding)}
                                                        </span>
                                                    ) : (
                                                        <span className="opacity-40">—</span>
                                                    )}
                                                </td>
                                                <td className="py-1">
                                                    {row.others.length === 0 ? (
                                                        <span className="opacity-40">—</span>
                                                    ) : (
                                                        <span className="flex flex-wrap gap-x-3 gap-y-1">
                                                            {row.others.map((cell) => (
                                                                <span
                                                                    key={cell.id}
                                                                    title={cell.id}
                                                                    className={cell.protocolMissing || cell.slotMissing ? 'text-yellow-300' : ''}
                                                                >
                                                                    {protocolCellText(cell)} · {slotCellText(cell)}
                                                                    {cell.stale && '[失效]'}
                                                                </span>
                                                            ))}
                                                        </span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        {matrix.summary && matrix.summary.unbound > 0 && (
                            <p className="text-[11px] leading-5 opacity-60">
                                {matrix.summary.unbound} 条指令尚未指定默认协议 —— 到「编排绑定」页补齐。
                            </p>
                        )}
                    </div>
                </section>
            </div>
        </div>
    );
}
