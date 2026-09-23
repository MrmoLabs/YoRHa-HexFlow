import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import NieRModal from '../components/ui/NieRModal';
import { PAGE_STATUS_BY_KEY } from '../config/pageRegistry';
import {
    errorMessageOf,
    hexDump,
    hexInputInfo,
    historyRows,
    rawHexOf,
    responseHexOf
} from '../utils/terminalPanes';

// E3 通讯调试页：传输配置模型 UI（发送模式/目标地址/串口参数，接 E2
// /transport/config|status）+ 三面板 —— 发送历史 / 原始报文 / 响应与错误
// 日志（数据源 /dispatch 有界历史，raw/response/error 三类事件）。
// 状态与历史为手动刷新；报文视图纯函数在 utils/terminalPanes.js。

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

const inputClass = 'bg-nier-light/5 border border-nier-light/30 text-[10px] p-1 text-nier-light outline-none focus:border-nier-light font-mono placeholder:text-nier-light/30';
const labelClass = 'flex flex-col gap-1 text-[10px] tracking-[0.15em] opacity-60';

const MODES = [
    { value: 'loopback', label: '环回 LOOPBACK' },
    { value: 'tcp', label: '网络 TCP' },
    { value: 'serial', label: '串口 SERIAL' }
];

// 配置 ⇄ 表单草稿：全部字段以字符串入 input，提交时数值字段再转数字，
// 空串原样交给后端校验（400 detail 为 SSOT）。
const toDraft = (config) => ({
    mode: config?.mode || 'loopback',
    tcp: {
        host: String(config?.tcp?.host ?? ''),
        port: String(config?.tcp?.port ?? ''),
        connect_timeout_ms: String(config?.tcp?.connect_timeout_ms ?? ''),
        read_timeout_ms: String(config?.tcp?.read_timeout_ms ?? '')
    },
    serial: {
        port: String(config?.serial?.port ?? ''),
        baudrate: String(config?.serial?.baudrate ?? ''),
        bytesize: String(config?.serial?.bytesize ?? 8),
        parity: config?.serial?.parity || 'N',
        stopbits: String(config?.serial?.stopbits ?? 1),
        read_timeout_ms: String(config?.serial?.read_timeout_ms ?? '')
    }
});

const num = (value) => (value === '' ? value : Number(value));

const toPatch = (draft) => ({
    mode: draft.mode,
    tcp: {
        host: draft.tcp.host,
        port: num(draft.tcp.port),
        connect_timeout_ms: num(draft.tcp.connect_timeout_ms),
        read_timeout_ms: num(draft.tcp.read_timeout_ms)
    },
    serial: {
        port: draft.serial.port,
        baudrate: num(draft.serial.baudrate),
        bytesize: num(draft.serial.bytesize),
        parity: draft.serial.parity,
        stopbits: num(draft.serial.stopbits),
        read_timeout_ms: num(draft.serial.read_timeout_ms)
    }
});

export default function Terminal() {
    const page = PAGE_STATUS_BY_KEY.terminal;
    const [config, setConfig] = useState(null);
    const [draft, setDraft] = useState(null);
    const [status, setStatus] = useState(null);
    const [history, setHistory] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [sysMsg, setSysMsg] = useState('');
    const [configError, setConfigError] = useState('');
    const [statusError, setStatusError] = useState('');
    const [historyError, setHistoryError] = useState('');
    const [sendHex, setSendHex] = useState('');
    const [busy, setBusy] = useState(''); // 'config' | 'send' | 'clear'
    const [confirmClear, setConfirmClear] = useState(false);

    const refreshConfig = useCallback(async () => {
        try {
            const next = await api.getTransportConfig();
            setConfig(next);
            setDraft(toDraft(next));
            setConfigError('');
        } catch (err) {
            setConfigError(err?.message || '无法连接后端服务');
        }
    }, []);

    const refreshStatus = useCallback(async () => {
        try {
            setStatus(await api.getTransportStatus());
            setStatusError('');
        } catch (err) {
            setStatusError(err?.message || '无法连接后端服务');
        }
    }, []);

    const refreshHistory = useCallback(async () => {
        try {
            setHistory(await api.getDispatchHistory(50));
            setHistoryError('');
        } catch (err) {
            setHistoryError(err?.message || '无法连接后端服务');
        }
    }, []);

    useEffect(() => {
        refreshConfig();
        refreshStatus();
        refreshHistory();
    }, [refreshConfig, refreshStatus, refreshHistory]);

    const handleApplyConfig = async () => {
        setBusy('config');
        setSysMsg('');
        try {
            const effective = await api.setTransportConfig(toPatch(draft));
            setConfig(effective);
            setDraft(toDraft(effective));
            setConfigError('');
            setSysMsg(`配置已生效：模式 ${String(effective.mode).toUpperCase()}`);
            await refreshStatus(); // 配置变更会断开既有真实连接，状态随之重置
        } catch (err) {
            setConfigError(err?.message || '配置应用失败');
        } finally {
            setBusy('');
        }
    };

    const handleSend = async () => {
        const info = hexInputInfo(sendHex);
        if (!info.valid) return;
        setBusy('send');
        setSysMsg('');
        try {
            const record = await api.dispatchPayload(sendHex.trim(), null);
            setSelectedId(record.id);
            setSysMsg(`SENT id=${record.id} · ${record.channel} · ${record.byte_count} 字节`);
            await Promise.all([refreshHistory(), refreshStatus()]);
        } catch (err) {
            setSysMsg(`发送失败：${err?.message || '未知错误'}`);
            await Promise.all([refreshHistory(), refreshStatus()]); // ERROR 记录也入历史
        } finally {
            setBusy('');
        }
    };

    const handleClearConfirm = async () => {
        setConfirmClear(false);
        setBusy('clear');
        try {
            await api.clearDispatchHistory();
            setSelectedId(null);
            setSysMsg('发送历史已清空');
            await refreshHistory();
        } catch (err) {
            setSysMsg(`清空失败：${err?.message || '未知错误'}`);
        } finally {
            setBusy('');
        }
    };

    const rows = historyRows(history);
    const selected = history.find((record) => record.id === selectedId) || history[0] || null;
    const errorRecords = history.filter((record) => record.status === 'ERROR');
    const sendInfo = hexInputInfo(sendHex);
    const rawLines = selected ? hexDump(rawHexOf(selected)) : [];
    const responseLines = selected && selected.status !== 'ERROR' ? hexDump(responseHexOf(selected)) : [];
    const selectedError = selected ? errorMessageOf(selected) : null;
    const connected = Boolean(status?.connected);

    return (
        <div className="flex-1 overflow-auto bg-[radial-gradient(circle_at_top,_rgba(218,212,187,0.12),_transparent_45%),linear-gradient(180deg,_rgba(212,206,178,0.04),_rgba(10,10,10,0))] text-nier-light">
            <NieRModal
                isOpen={confirmClear}
                message={`确认清空发送历史？\n\n· 当前 ${history.length} 条记录（有界 100 条）\n· 仅内存历史，清空不可恢复`}
                onConfirm={handleClearConfirm}
                onCancel={() => setConfirmClear(false)}
            />

            <div className="px-5 py-5 flex flex-col gap-6">
                {/* Header */}
                <section className="border border-nier-light/30 bg-nier-dark/70 p-3">
                    <div className="text-[11px] font-mono tracking-[0.35em] opacity-50">{`PAGE ${page.shortcut} // TERMINAL`}</div>
                    <h1 className="mt-2 text-4xl font-black tracking-tight leading-none">{page.titleZh}</h1>
                    <p className="mt-2 text-sm uppercase tracking-[0.25em] opacity-60">{page.titleEn}</p>
                    <div className="mt-3 inline-flex items-center gap-2 border border-yellow-500/40 bg-yellow-500/10 px-3 py-1 text-[11px] font-mono tracking-[0.2em] text-yellow-300">
                        <span className="h-2 w-2 bg-yellow-300 animate-pulse" />
                        {page.status}
                    </div>
                </section>

                {/* Sys line */}
                {sysMsg && (
                    <div className="border border-nier-light/40 bg-nier-dark/70 px-4 py-2 text-xs font-mono">
                        {sysMsg.startsWith('发送失败') || sysMsg.startsWith('清空失败')
                            ? <span className="text-red-300">ERR: {sysMsg}</span>
                            : <span>SYS: {sysMsg}</span>}
                    </div>
                )}

                {/* 配置 + 状态 */}
                <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                    <section className="border border-nier-light/30 bg-nier-dark/60">
                        <PanelTitle hint="POST /transport/config">通讯配置 (TRANSPORT CONFIG)</PanelTitle>
                        <div className="p-4 space-y-4 text-xs font-mono">
                            {!draft ? (
                                <div className="opacity-60">{configError ? '配置不可用' : '加载中…'}</div>
                            ) : (
                                <>
                                    <div className="flex flex-wrap gap-2">
                                        {MODES.map((mode) => (
                                            <button
                                                key={mode.value}
                                                type="button"
                                                onClick={() => setDraft({ ...draft, mode: mode.value })}
                                                className={`px-3 py-1 border text-[10px] font-bold tracking-[0.2em] transition-colors duration-150 ${draft.mode === mode.value
                                                    ? 'border-nier-light bg-nier-light text-nier-dark'
                                                    : 'border-nier-light/40 text-nier-light/70 hover:border-nier-light'}`}
                                            >
                                                {mode.label}
                                            </button>
                                        ))}
                                    </div>

                                    {draft.mode === 'tcp' && (
                                        <div className="grid grid-cols-2 gap-3">
                                            <label className={`${labelClass} col-span-2`}>
                                                目标地址 HOST
                                                <input type="text" value={draft.tcp.host} placeholder="127.0.0.1"
                                                    onChange={(e) => setDraft({ ...draft, tcp: { ...draft.tcp, host: e.target.value } })}
                                                    className={inputClass} />
                                            </label>
                                            <label className={labelClass}>
                                                端口 PORT
                                                <input type="number" value={draft.tcp.port} placeholder="9000"
                                                    onChange={(e) => setDraft({ ...draft, tcp: { ...draft.tcp, port: e.target.value } })}
                                                    className={inputClass} />
                                            </label>
                                            <label className={labelClass}>
                                                连接超时 CONNECT MS
                                                <input type="number" value={draft.tcp.connect_timeout_ms} placeholder="3000"
                                                    onChange={(e) => setDraft({ ...draft, tcp: { ...draft.tcp, connect_timeout_ms: e.target.value } })}
                                                    className={inputClass} />
                                            </label>
                                            <label className={labelClass}>
                                                读取超时 READ MS
                                                <input type="number" value={draft.tcp.read_timeout_ms} placeholder="2000"
                                                    onChange={(e) => setDraft({ ...draft, tcp: { ...draft.tcp, read_timeout_ms: e.target.value } })}
                                                    className={inputClass} />
                                            </label>
                                        </div>
                                    )}

                                    {draft.mode === 'serial' && (
                                        <div className="grid grid-cols-2 gap-3">
                                            <label className={labelClass}>
                                                串口 PORT
                                                <input type="text" value={draft.serial.port} placeholder="COM3"
                                                    onChange={(e) => setDraft({ ...draft, serial: { ...draft.serial, port: e.target.value } })}
                                                    className={inputClass} />
                                            </label>
                                            <label className={labelClass}>
                                                波特率 BAUDRATE
                                                <input type="number" value={draft.serial.baudrate} placeholder="9600"
                                                    onChange={(e) => setDraft({ ...draft, serial: { ...draft.serial, baudrate: e.target.value } })}
                                                    className={inputClass} />
                                            </label>
                                            <label className={labelClass}>
                                                数据位 BYTESIZE
                                                <select value={draft.serial.bytesize}
                                                    onChange={(e) => setDraft({ ...draft, serial: { ...draft.serial, bytesize: e.target.value } })}
                                                    className={inputClass}>
                                                    {[5, 6, 7, 8].map((size) => <option key={size} value={size}>{size}</option>)}
                                                </select>
                                            </label>
                                            <label className={labelClass}>
                                                校验位 PARITY
                                                <select value={draft.serial.parity}
                                                    onChange={(e) => setDraft({ ...draft, serial: { ...draft.serial, parity: e.target.value } })}
                                                    className={inputClass}>
                                                    {['N', 'E', 'O'].map((parity) => <option key={parity} value={parity}>{parity}</option>)}
                                                </select>
                                            </label>
                                            <label className={labelClass}>
                                                停止位 STOPBITS
                                                <select value={draft.serial.stopbits}
                                                    onChange={(e) => setDraft({ ...draft, serial: { ...draft.serial, stopbits: e.target.value } })}
                                                    className={inputClass}>
                                                    {['1', '1.5', '2'].map((bits) => <option key={bits} value={bits}>{bits}</option>)}
                                                </select>
                                            </label>
                                            <label className={labelClass}>
                                                读取超时 READ MS
                                                <input type="number" value={draft.serial.read_timeout_ms} placeholder="2000"
                                                    onChange={(e) => setDraft({ ...draft, serial: { ...draft.serial, read_timeout_ms: e.target.value } })}
                                                    className={inputClass} />
                                            </label>
                                        </div>
                                    )}

                                    {draft.mode === 'loopback' && (
                                        <p className="text-[11px] leading-5 opacity-60">
                                            进程内环回通道，无需目标参数；/dispatch 口径与存量一致。
                                        </p>
                                    )}

                                    {configError && <div className="text-red-300 text-[11px]">ERR: {configError}</div>}

                                    <div className="flex items-center gap-3">
                                        <ActionButton onClick={handleApplyConfig} busy={busy === 'config'}>
                                            应用配置 (APPLY)
                                        </ActionButton>
                                        <span className="text-[10px] opacity-50">生效时断开既有真实连接</span>
                                    </div>
                                </>
                            )}
                        </div>
                    </section>

                    <section className="border border-nier-light/30 bg-nier-dark/60">
                        <PanelTitle hint="GET /transport/status">连接状态 (CONNECTION)</PanelTitle>
                        <div className="p-4 space-y-3 text-xs font-mono">
                            {status ? (
                                <>
                                    <div className="flex justify-between gap-4">
                                        <span className="opacity-60">模式 MODE</span>
                                        <span>{String(status.mode || '—').toUpperCase()}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                        <span className="opacity-60">连接 LINK</span>
                                        {connected ? (
                                            <span className="border border-yellow-500/40 bg-yellow-500/10 px-2 text-yellow-300 text-[10px] tracking-[0.2em]">已连接 CONNECTED</span>
                                        ) : (
                                            <span className="border border-nier-light/40 px-2 opacity-60 text-[10px] tracking-[0.2em]">未连接 DISCONNECTED</span>
                                        )}
                                    </div>
                                    <div className="flex justify-between gap-4">
                                        <span className="opacity-60">最后错误 LAST ERR</span>
                                        <span className={status.last_error ? 'text-red-300 truncate max-w-[60%]' : 'opacity-60'}
                                            title={status.last_error || ''}>
                                            {status.last_error || '—'}
                                        </span>
                                    </div>
                                    <div className="border-t border-nier-light/20 pt-3">
                                        <div className="text-[10px] tracking-[0.2em] opacity-60 mb-2">状态事件 EVENTS（最近 8 条）</div>
                                        {(status.events || []).length === 0 ? (
                                            <div className="text-[11px] opacity-50">暂无状态事件。</div>
                                        ) : (
                                            <div className="space-y-1 text-[11px]">
                                                {(status.events || []).slice(-8).reverse().map((event, index) => (
                                                    <div key={`${event.ts}-${index}`} className="flex gap-2 border-b border-nier-light/10 pb-1">
                                                        <span className="opacity-50 shrink-0">{String(event.ts || '').replace('T', ' ').slice(11, 19)}</span>
                                                        <span className={event.event === 'error' ? 'text-red-300 shrink-0' : 'text-yellow-300 shrink-0'}>
                                                            {String(event.event || '').toUpperCase()}
                                                        </span>
                                                        <span className="truncate opacity-70" title={event.detail || ''}>{event.detail || ''}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    {statusError && <div className="text-red-300 text-[11px]">ERR: {statusError}</div>}
                                    <div className="pt-1">
                                        <ActionButton onClick={refreshStatus}>刷新 (REFRESH)</ActionButton>
                                    </div>
                                </>
                            ) : (
                                <div className="opacity-60">{statusError ? '状态不可用' : '加载中…'}</div>
                            )}
                        </div>
                    </section>
                </div>

                {/* 三面板 */}
                <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                    {/* 1 发送历史 */}
                    <section className="border border-nier-light/30 bg-nier-dark/60">
                        <PanelTitle hint="/dispatch · history（有界 100 条）">发送历史 (SEND HISTORY)</PanelTitle>
                        <div className="p-4 space-y-3 text-xs font-mono">
                            <div className="flex items-center gap-2">
                                <input
                                    type="text"
                                    placeholder="HEX 输入，如 AA 55 01…"
                                    value={sendHex}
                                    onChange={(e) => setSendHex(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && sendInfo.valid && busy !== 'send' && handleSend()}
                                    className={`${inputClass} flex-1`}
                                />
                                <ActionButton onClick={handleSend} disabled={!sendInfo.valid} busy={busy === 'send'}>
                                    发送 (SEND)
                                </ActionButton>
                                <span className="text-[10px] opacity-50 shrink-0">{sendInfo.valid ? `${sendInfo.byteCount} B` : '—'}</span>
                            </div>

                            {historyError && <div className="text-red-300 text-[11px]">ERR: {historyError}</div>}

                            {rows.length === 0 ? (
                                <div className="opacity-50">暂无发送记录 — 在上方输入十六进制帧发送，或到「指令加工」页试发。</div>
                            ) : (
                                <table className="w-full text-[11px] font-mono">
                                    <thead>
                                        <tr className="text-[10px] tracking-[0.15em] opacity-60 border-b border-nier-light/20">
                                            <th className="text-left py-1 font-bold">时间 TIME</th>
                                            <th className="text-left py-1 font-bold">通道 CH</th>
                                            <th className="text-left py-1 font-bold">状态 ST</th>
                                            <th className="text-right py-1 font-bold">字节 B</th>
                                            <th className="text-left py-1 font-bold">报文 HEX</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((row) => (
                                            <tr
                                                key={row.id}
                                                onClick={() => setSelectedId(row.id)}
                                                className={`border-b border-nier-light/10 cursor-pointer transition-colors duration-150 ${selected?.id === row.id ? 'bg-nier-light/10' : 'hover:bg-nier-light/5'}`}
                                            >
                                                <td className="py-1 whitespace-nowrap opacity-70">{row.time}</td>
                                                <td className="py-1">{row.channel}</td>
                                                <td className={`py-1 ${row.isError ? 'text-red-300' : 'text-yellow-300'}`}>{row.status}</td>
                                                <td className="py-1 text-right">{row.byteCount}</td>
                                                <td className="py-1 truncate max-w-[10rem]" title={row.hexPreview}>{row.hexPreview}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}

                            <div className="flex items-center gap-3 border-t border-nier-light/20 pt-3">
                                <ActionButton onClick={refreshHistory}>刷新 (REFRESH)</ActionButton>
                                <ActionButton onClick={() => setConfirmClear(true)} disabled={rows.length === 0} busy={busy === 'clear'}>
                                    清空 (CLEAR)
                                </ActionButton>
                                <span className="text-[10px] opacity-50">{rows.length} 条 · 点击行查看报文</span>
                            </div>
                        </div>
                    </section>

                    <div className="flex flex-col gap-6">
                        {/* 2 原始报文 */}
                        <section className="border border-nier-light/30 bg-nier-dark/60">
                            <PanelTitle hint="raw 事件 · 8 字节/行">原始报文 (RAW FRAME)</PanelTitle>
                            <div className="p-4 text-xs font-mono">
                                {!selected ? (
                                    <div className="opacity-50">未选择记录 — 点击左侧历史行。</div>
                                ) : (
                                    <>
                                        <div className="flex justify-between gap-4 text-[10px] tracking-[0.15em] opacity-60 mb-2">
                                            <span>ID {selected.id}</span>
                                            <span>{selected.channel} · {selected.byte_count} BYTES · {String(selected.status)}</span>
                                        </div>
                                        <pre className="border border-nier-light/20 bg-nier-dark/80 p-3 leading-6 whitespace-pre-wrap break-all text-yellow-100">
                                            {rawLines.length ? rawLines.join('\n') : '（空帧）'}
                                        </pre>
                                    </>
                                )}
                            </div>
                        </section>

                        {/* 3 响应与错误日志 */}
                        <section className="border border-nier-light/30 bg-nier-dark/60">
                            <PanelTitle hint="response / error 事件">响应与错误日志 (RESPONSE · ERROR)</PanelTitle>
                            <div className="p-4 space-y-3 text-xs font-mono">
                                {!selected ? (
                                    errorRecords.length === 0
                                        ? <div className="opacity-50">未选择记录，且暂无错误日志。</div>
                                        : null
                                ) : (
                                    <>
                                        <div className="text-[10px] tracking-[0.15em] opacity-60">响应 RESPONSE</div>
                                        {selected.status === 'ERROR' ? (
                                            <div className="text-red-300 text-[11px]">无响应（发送失败，见下方错误日志）</div>
                                        ) : responseLines.length ? (
                                            <pre className="border border-nier-light/20 bg-nier-dark/80 p-3 leading-6 whitespace-pre-wrap break-all text-yellow-100">
                                                {responseLines.join('\n')}
                                            </pre>
                                        ) : (
                                            <div className="text-[11px] opacity-60">空响应（超时内未收到数据）</div>
                                        )}
                                        {selectedError && (
                                            <div className="border border-red-400/40 bg-red-400/5 px-3 py-2 text-[11px] text-red-300 break-all">
                                                {selectedError}
                                            </div>
                                        )}
                                    </>
                                )}

                                <div className="border-t border-nier-light/20 pt-3">
                                    <div className="text-[10px] tracking-[0.15em] opacity-60 mb-2">错误日志 ERROR LOG（全量 {errorRecords.length} 条）</div>
                                    {errorRecords.length === 0 ? (
                                        <div className="text-[11px] opacity-50">暂无错误记录。</div>
                                    ) : (
                                        <div className="space-y-1 text-[11px]">
                                            {errorRecords.map((record) => (
                                                <div key={record.id} className="flex gap-2 border-b border-nier-light/10 pb-1">
                                                    <span className="opacity-50 shrink-0">{historyRows([record])[0].time}</span>
                                                    <span className="text-red-300 shrink-0">{record.channel}</span>
                                                    <span className="truncate opacity-70" title={errorMessageOf(record) || ''}>
                                                        {errorMessageOf(record) || '（无错误详情）'}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </section>
                    </div>
                </div>
            </div>
        </div>
    );
}
