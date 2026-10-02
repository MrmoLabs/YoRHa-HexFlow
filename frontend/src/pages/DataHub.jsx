import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import NieRModal from '../components/ui/NieRModal';
import { PAGE_STATUS_BY_KEY } from '../config/pageRegistry';
import { triggerBlobDownload } from '../utils/download';

// C3 数据中心一期：环境状态面板 + 聚合导出 ZIP + 数据库备份/恢复。
// 端点见 backend/routers/datahub.py；恢复前会自动留 pre-restore 安全快照。

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

    const refresh = useCallback(async () => {
        try {
            setStatus(await api.getDatahubStatus());
            setLoadError('');
        } catch (err) {
            setLoadError(err?.message || '无法连接后端服务');
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
            setSysMsg(`导出完成：${formatBytes(blob.size)}（instructions.json + relations.json + manifest.json + frames/*.bin|hex）`);
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
                                    （绑定 + 应答规格，批次四 4a）与逐指令骨架帧
                                    <span className="font-mono"> .bin / .hex </span>
                                    （Orchestrator 编译，未实现编码语义以 0x00 占位）。
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
            </div>
        </div>
    );
}
