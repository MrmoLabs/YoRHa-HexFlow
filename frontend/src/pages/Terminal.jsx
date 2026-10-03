import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import NieRModal from '../components/ui/NieRModal';
import DecodedFields from '../components/InstructionForm/DecodedFields';
import { PAGE_STATUS_BY_KEY } from '../config/pageRegistry';
import {
    decodeHistoryRow,
    errorMessageOf,
    FRAME_FORMATS,
    frameLines,
    hexInputInfo,
    historyRows,
    rawHexOf,
    responseHexOf
} from '../utils/terminalPanes';
import { profileBadges, profileOptionLabel, profileSummary } from '../utils/profileView';
import { escapeHex, escapeWarnings, toEscapeDraft } from '../utils/escapeTable';

// E3 通讯调试页：传输配置模型 UI（发送模式/目标地址/串口参数，接 E2
// /transport/config|status）+ 三面板 —— 发送历史 / 原始报文 / 响应与错误
// 日志（数据源 /dispatch 有界历史，raw/response/error 三类事件）。
// P1 设备档案区（/profiles 命名快照 + 激活切换）：传输配置经 lifespan 钩子
// 落库（transport_settings），重启恢复；档案视图模型在 utils/profileView.js。
// R9（PLAN §8.46）：发送历史新增「字段 FIELDS」列 + 详情面板解码展示 ——
// 响应帧按指令字段布局逆向还原成「字段 = 值」（C-2 选 B，只展示不入库）。
// 状态与历史除手动刷新外，R15（PLAN §8.49）加**自动轮询**：默认开、5s 一次、仅标签页
// 可见时拉；同批补**档案重命名**入口（后端 PUT /profiles/{id} 早支持 label，前端缺入口）。
// 报文视图纯函数在 utils/terminalPanes.js。
// R16（PLAN §8.49）：三面板共用「显示格式」开关（hex / ascii / bin）—— 只换显示口径，
// 帧内容与发送 / 入库 / 校验逐字节不变。

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

// R14（PLAN §8.49）：波特率预设档 —— 点一下填进输入框，**输入仍可任意键入**（预设
// 只是省事，不构成取值白名单；落库口径仍由后端校验说了算）。
const BAUD_PRESETS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];

// R15（PLAN §8.49）：状态 + 发送历史的自动轮询周期。5s —— 够跟上 dispatch 事件，又不会
// 把 /transport/status 与 /dispatch/history 压成热路径；标签页切后台即停（见下方 effect）。
const POLL_MS = 5000;

// 配置 ⇄ 表单草稿：全部字段以字符串入 input，提交时数值字段再转数字，
// 空串原样交给后端校验（400 detail 为 SSOT）。escape 段见 utils/escapeTable.js。
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
    },
    escape: toEscapeDraft(config?.escape)
});

const num = (value) => (value === '' ? value : Number(value));

// 紧凑 hex → 面板显示口径（两字符一对空格分隔）
const spacedHex = (compact) => (compact.match(/.{1,2}/g) || []).join(' ');

// escape 段与 mode/tcp/serial 同为「整段全量提交」：pairs 是列表，后端
// _deep_merge 只递归对象 → 列表整体替换（删行才生效）。
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
    },
    escape: {
        enabled: !!draft.escape?.enabled,
        pairs: (draft.escape?.pairs || []).map(([src, dst]) => [
            String(src ?? ''), String(dst ?? '')
        ])
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
    // R9: 指令名 → 指令 映射（发历史行的响应帧解码用），取不到则退化不出解码
    const [instructionsByName, setInstructionsByName] = useState({});
    const [sendHex, setSendHex] = useState('');
    const [busy, setBusy] = useState(''); // 'config' | 'revert' | 'send' | 'clear' | 'profile'
    const [confirmClear, setConfirmClear] = useState(false);
    // P1 设备档案：列表 / 选中 / 新档名 / 区内错误 / 删除确认
    const [profiles, setProfiles] = useState([]);
    const [selectedProfileId, setSelectedProfileId] = useState('');
    const [profileName, setProfileName] = useState('');
    const [profileError, setProfileError] = useState('');
    const [confirmDeleteProfile, setConfirmDeleteProfile] = useState(false);
    // R14（PLAN §8.49）：本机串口端口枚举 —— 只读、不碰配置；ports=null = 尚未拉过，
    // 降级原因（缺 pyserial / 枚举炸）进 portsError 原文显示，不静默吞。
    const [ports, setPorts] = useState(null);
    const [portsError, setPortsError] = useState('');
    // R15（PLAN §8.49）：自动轮询开关（默认开）+ 档案改名行（renaming = 是否展开改名输入）
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [renaming, setRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState('');
    // R16（PLAN §8.49）：三面板共用的报文显示口径 —— 只换怎么摆、不换字节（缺省 hex 逐字不变）
    const [frameFormat, setFrameFormat] = useState('hex');

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

    const refreshProfiles = useCallback(async () => {
        try {
            const list = await api.getProfiles();
            setProfiles(Array.isArray(list) ? list : []);
            setProfileError('');
        } catch (err) {
            setProfileError(err?.message || '无法连接后端服务');
        }
    }, []);

    // R9: 指令名 → 指令（含 fields）映射，供发送历史把响应帧逆向解成「字段 = 值」。
    // 解码是展示增强、不参与收发主链路 —— 取不到就退化成不出解码列（不新增错误条）。
    const refreshInstructions = useCallback(async () => {
        try {
            const list = await api.getInstructions();
            const map = {};
            (Array.isArray(list) ? list : []).forEach((inst) => {
                if (inst && inst.name) map[inst.name] = inst;
            });
            setInstructionsByName(map);
        } catch {
            // 取指令失败 → 退化（解码列不出值），不打断收发主链路、不新增错误条
            setInstructionsByName({});
        }
    }, []);

    // R14（PLAN §8.49）：串口端口枚举。只读一次，接插后可点「刷新」重拉；
    // 后端缺 pyserial 或枚举炸了会降级成 source='unavailable' + error 原文（仍 200）。
    const refreshPorts = useCallback(async () => {
        try {
            const data = await api.getTransportPorts();
            setPorts(Array.isArray(data?.ports) ? data.ports : []);
            setPortsError(data?.source === 'unavailable' ? (data.error || '串口枚举不可用') : '');
        } catch (err) {
            setPorts([]);
            setPortsError(err?.message || '串口枚举失败');
        }
    }, []);

    useEffect(() => {
        refreshConfig();
        refreshStatus();
        refreshHistory();
        refreshProfiles();
        refreshInstructions();
        refreshPorts();
    }, [refreshConfig, refreshStatus, refreshHistory, refreshProfiles, refreshInstructions, refreshPorts]);

    // R15（PLAN §8.49）：状态 + 发送历史自动轮询。默认开、每 POLL_MS 拉一次，**只在标签页
    // 可见时拉** —— 切后台（visibilitychange）立刻清定时器，不烧无用请求；关掉开关 effect
    // 重跑即停。轮询失败各走自己 refresh* 的 catch（只写错误条、不打断下一轮）。
    useEffect(() => {
        if (!autoRefresh) return undefined;
        let timer = null;
        const start = () => {
            if (timer !== null) return;
            timer = window.setInterval(() => {
                refreshStatus();
                refreshHistory();
            }, POLL_MS);
        };
        const stop = () => {
            if (timer === null) return;
            window.clearInterval(timer);
            timer = null;
        };
        const onVisibility = () => {
            if (document.hidden) stop();
            else start();
        };
        if (!document.hidden) start();
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            stop();
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [autoRefresh, refreshStatus, refreshHistory]);

    const handleApplyConfig = async () => {
        setBusy('config');
        setSysMsg('');
        try {
            const effective = await api.setTransportConfig(toPatch(draft));
            setConfig(effective);
            setDraft(toDraft(effective));
            setConfigError('');
            setSysMsg(`配置已生效：模式 ${String(effective.mode).toUpperCase()}`);
            await Promise.all([refreshStatus(), refreshProfiles()]); // 手工改配置会清激活指针
        } catch (err) {
            setConfigError(err?.message || '配置应用失败');
        } finally {
            setBusy('');
        }
    };

    // R2（PLAN §8.37）：一键回退到「上一配置」。后端弹栈 → 这里直接拿生效配置回填
    // 表单（同 APPLY 的回填口径），并刷新状态与档案 —— 配置变更会清激活指针。
    const handleRevertConfig = async () => {
        setBusy('revert');
        setSysMsg('');
        try {
            const result = await api.revertTransportConfig();
            setConfig(result.config);
            setDraft(toDraft(result.config));
            setConfigError('');
            setSysMsg(`已回退到上一配置：模式 ${String(result.config.mode).toUpperCase()}`
                + ` · 还可回退 ${result.historyDepth} 版`);
            await Promise.all([refreshStatus(), refreshProfiles()]);
        } catch (err) {
            setConfigError(err?.message || '回退失败');
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

    // ---- P1 设备档案 ----
    const handleProfileCreate = async () => {
        const label = profileName.trim();
        if (!label) return;
        setBusy('profile');
        setProfileError('');
        try {
            // 省略 config → 服务端快照当前生效配置
            const created = await api.createProfile({ label });
            setProfileName('');
            setSelectedProfileId(created.id);
            setSysMsg(`档案已保存：${created.label}`);
            await refreshProfiles();
        } catch (err) {
            setProfileError(err?.message || '保存档案失败');
        } finally {
            setBusy('');
        }
    };

    const handleProfileActivate = async () => {
        const target = profiles.find((profile) => profile.id === selectedProfileId);
        if (!target) return;
        setBusy('profile');
        setProfileError('');
        try {
            const active = await api.activateProfile(target.id);
            setConfig(active.config);
            setDraft(toDraft(active.config));
            setSysMsg(`档案已应用：${active.label} · 模式 ${String(active.config.mode).toUpperCase()}`);
            await Promise.all([refreshStatus(), refreshProfiles()]); // 生效会断开既有真实连接
        } catch (err) {
            setProfileError(err?.message || '应用档案失败');
        } finally {
            setBusy('');
        }
    };

    const handleProfileUpdate = async () => {
        const target = profiles.find((profile) => profile.id === selectedProfileId);
        if (!target || !config) return;
        setBusy('profile');
        setProfileError('');
        try {
            await api.updateProfile(target.id, { config }); // 当前生效配置写入所选档案
            setSysMsg(`档案已更新：${target.label} ← 当前生效配置`);
            await refreshProfiles();
        } catch (err) {
            setProfileError(err?.message || '更新档案失败');
        } finally {
            setBusy('');
        }
    };

    // R15（PLAN §8.49）：档案重命名 —— 后端 PUT /profiles/{id} 早就支持只送 label（过
    // _checked_label：空名 400、同名 400，且**不过滤回收站** —— 软删档案占的名要先释放），
    // 前端一直没入口。**只送 label、不带 config**（改名不该动快照内容），撞名 detail 原文
    // 透出、不改写不静默。
    const handleProfileRename = async () => {
        const target = profiles.find((profile) => profile.id === selectedProfileId);
        const label = renameValue.trim();
        if (!target || !label || label === target.label) return;
        setBusy('profile');
        setProfileError('');
        try {
            await api.updateProfile(target.id, { label });
            setRenaming(false);
            setSysMsg(`档案已重命名：${target.label} → ${label}`);
            await refreshProfiles();
        } catch (err) {
            setProfileError(err?.message || '重命名失败');
        } finally {
            setBusy('');
        }
    };

    const handleProfileDelete = async () => {
        setConfirmDeleteProfile(false);
        const target = profiles.find((profile) => profile.id === selectedProfileId);
        if (!target) return;
        setBusy('profile');
        setProfileError('');
        try {
            await api.deleteProfile(target.id);
            if (selectedProfileId === target.id) setSelectedProfileId('');
            setSysMsg(`档案已删除：${target.label}`);
            await refreshProfiles();
        } catch (err) {
            setProfileError(err?.message || '删除档案失败');
        } finally {
            setBusy('');
        }
    };

    const rows = historyRows(history, { instructionsByName, frameFormat });
    const selected = history.find((record) => record.id === selectedId) || history[0] || null;
    // R9: 选中行的响应帧解码（与行内 FIELDS 列同一口径，详情面板出完整字段表）
    const selectedDecoded = selected ? decodeHistoryRow(selected, instructionsByName) : null;
    const errorRecords = history.filter((record) => record.status === 'ERROR');
    const sendInfo = hexInputInfo(sendHex);
    // R16：原始/响应两面板跟随同一个显示口径开关（帧内容不变，只换渲染）
    const rawLines = selected ? frameLines(rawHexOf(selected), frameFormat) : [];
    const responseLines = selected && selected.status !== 'ERROR' ? frameLines(responseHexOf(selected), frameFormat) : [];
    const selectedError = selected ? errorMessageOf(selected) : null;
    const connected = Boolean(status?.connected);
    const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) || null;
    const formatHint = FRAME_FORMATS.find((item) => item.key === frameFormat)?.hint || FRAME_FORMATS[0].hint;

    // N4 (G3): 转义表草稿操作 + 样例预览（转义算法 SSOT 在 BE，样例同口径）
    const escapePairs = draft?.escape?.pairs || [];
    const setEscape = (escape) => setDraft({ ...draft, escape });
    const updatePair = (index, slot, value) => setEscape({
        enabled: !!draft?.escape?.enabled,
        pairs: escapePairs.map((pair, i) => (
            i === index
                ? (slot === 0 ? [value, String(pair?.[1] ?? '')]
                    : [String(pair?.[0] ?? ''), value])
                : pair
        ))
    });
    const addPair = () => setEscape({
        enabled: !!draft?.escape?.enabled,
        pairs: [...escapePairs, ['', '']]
    });
    const removePair = (index) => setEscape({
        enabled: !!draft?.escape?.enabled,
        pairs: escapePairs.filter((_, i) => i !== index)
    });

    const sampleFroms = escapePairs
        .map((pair) => String(pair?.[0] ?? '').trim().toUpperCase())
        .filter((value) => value !== '');
    const escapeSample = sampleFroms.length ? `AA ${sampleFroms.join(' ')} BB` : '';
    const escapedSample = escapeSample ? escapeHex(escapeSample, draft?.escape) : null;
    const escapePreview = !escapeSample
        ? null
        : `${escapeSample} → ${!draft?.escape?.enabled
            ? escapeSample
            : (escapedSample === null ? '—' : spacedHex(escapedSample))}`;

    return (
        <div className="flex-1 overflow-auto bg-[radial-gradient(circle_at_top,_rgba(218,212,187,0.12),_transparent_45%),linear-gradient(180deg,_rgba(212,206,178,0.04),_rgba(10,10,10,0))] text-nier-light">
            <NieRModal
                isOpen={confirmClear}
                message={`确认清空发送历史？\n\n· 当前 ${history.length} 条记录（有界 100 条）\n· 仅内存历史，清空不可恢复`}
                onConfirm={handleClearConfirm}
                onCancel={() => setConfirmClear(false)}
            />
            <NieRModal
                isOpen={confirmDeleteProfile}
                message={`确认删除档案「${selectedProfile?.label || '—'}」？\n\n· 仅删除档案快照，移入回收站可恢复\n· 当前生效传输配置不受影响\n· 恢复后需重新激活该档案（激活指针不回填）`}
                onConfirm={handleProfileDelete}
                onCancel={() => setConfirmDeleteProfile(false)}
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
                                            {/* R14（PLAN §8.49）：波特率预设 + 本机串口枚举 —— 只改草稿、不自动 APPLY，
                                                与其余配置字段同一节奏（点 APPLY 才落库生效） */}
                                            <div className="col-span-2 flex flex-col gap-2 border-t border-nier-light/20 pt-2">
                                                <div className="flex flex-wrap items-center gap-1.5">
                                                    <span className="text-[10px] tracking-[0.15em] opacity-60">波特率预设</span>
                                                    {BAUD_PRESETS.map((baud) => {
                                                        const on = String(draft.serial.baudrate).trim() === String(baud);
                                                        return (
                                                            <button
                                                                key={baud}
                                                                type="button"
                                                                aria-pressed={on}
                                                                onClick={() => setDraft({ ...draft, serial: { ...draft.serial, baudrate: String(baud) } })}
                                                                className={`border px-1.5 py-0.5 text-[10px] font-mono transition-colors duration-150 ${on
                                                                    ? 'border-nier-light bg-nier-light text-nier-dark'
                                                                    : 'border-nier-light/40 text-nier-light/70 hover:border-nier-light'}`}
                                                            >
                                                                {baud}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                                <div className="flex flex-wrap items-center gap-1.5" data-testid="serial-port-enum">
                                                    <span className="text-[10px] tracking-[0.15em] opacity-60">端口枚举</span>
                                                    {portsError ? (
                                                        <span className="text-[10px] font-mono text-red-400">{`枚举降级：${portsError}`}</span>
                                                    ) : ports === null ? (
                                                        <span className="text-[10px] font-mono opacity-50">拉取中…</span>
                                                    ) : ports.length === 0 ? (
                                                        <span className="text-[10px] font-mono opacity-50">本机未检测到串口（可手输 COMn，接插后点刷新）</span>
                                                    ) : ports.map((port) => {
                                                        const on = String(draft.serial.port).trim().toUpperCase() === String(port.device || '').toUpperCase();
                                                        return (
                                                            <button
                                                                key={port.device}
                                                                type="button"
                                                                aria-pressed={on}
                                                                title={port.description || port.device}
                                                                onClick={() => setDraft({ ...draft, serial: { ...draft.serial, port: port.device } })}
                                                                className={`border px-1.5 py-0.5 text-[10px] font-mono transition-colors duration-150 ${on
                                                                    ? 'border-nier-light bg-nier-light text-nier-dark'
                                                                    : 'border-nier-light/40 text-nier-light/70 hover:border-nier-light'}`}
                                                            >
                                                                {port.device}
                                                            </button>
                                                        );
                                                    })}
                                                    <button
                                                        type="button"
                                                        onClick={refreshPorts}
                                                        className="border border-nier-light/40 px-1.5 py-0.5 text-[10px] font-mono hover:border-nier-light"
                                                    >
                                                        刷新端口 REFRESH
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {draft.mode === 'loopback' && (
                                        <p className="text-[11px] leading-5 opacity-60">
                                            进程内环回通道，无需目标参数；/dispatch 口径与存量一致。
                                        </p>
                                    )}

                                    {/* N4 (G3): 帧字节转义 —— 出线前对内核字节转义，
                                        套壳外壳字面不转；缺省关闭，逐字节与存量一致 */}
                                    <div className="space-y-2 border-t border-nier-light/20 pt-3">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] tracking-[0.15em] opacity-60">帧字节转义 ESCAPE</span>
                                            <span className="text-[10px] font-bold">
                                                {draft.escape.enabled ? '已启用 ENABLED' : '关闭 DISABLED'}
                                            </span>
                                        </div>

                                        <div className="flex gap-2">
                                            {[['关闭 OFF', false], ['启用 ON', true]].map(([label, on]) => (
                                                <button
                                                    key={label}
                                                    type="button"
                                                    onClick={() => setEscape({ ...draft.escape, enabled: on })}
                                                    className={`px-3 py-1 border text-[10px] font-bold tracking-[0.2em] transition-colors duration-150 ${draft.escape.enabled === on
                                                        ? 'border-nier-light bg-nier-light text-nier-dark'
                                                        : 'border-nier-light/40 text-nier-light/70 hover:border-nier-light'}`}
                                                >
                                                    {label}
                                                </button>
                                            ))}
                                        </div>

                                        {escapePairs.map((pair, index) => (
                                            <div key={`escape-${index}`} className="flex items-end gap-2">
                                                <label className={labelClass}>
                                                    原字节
                                                    <input type="text" value={String(pair?.[0] ?? '')} placeholder="7D"
                                                        onChange={(e) => updatePair(index, 0, e.target.value)}
                                                        className={inputClass} />
                                                </label>
                                                <span className="pb-1 text-[10px] opacity-50">→</span>
                                                <label className={labelClass}>
                                                    替换序列
                                                    <input type="text" value={String(pair?.[1] ?? '')} placeholder="7D5D"
                                                        onChange={(e) => updatePair(index, 1, e.target.value)}
                                                        className={inputClass} />
                                                </label>
                                                <button
                                                    type="button"
                                                    onClick={() => removePair(index)}
                                                    className="px-2 py-1 border border-nier-light/40 text-[10px] text-nier-light/70 hover:border-nier-light transition-colors duration-150"
                                                >
                                                    删除
                                                </button>
                                            </div>
                                        ))}

                                        <button
                                            type="button"
                                            onClick={addPair}
                                            className="px-3 py-1 border border-nier-light/40 text-[10px] font-bold tracking-[0.2em] text-nier-light/70 hover:border-nier-light transition-colors duration-150"
                                        >
                                            + 添加规则
                                        </button>

                                        {escapePreview && (
                                            <div className="flex gap-2 text-[10px]">
                                                <span className="opacity-60">样例 SAMPLE</span>
                                                <span>{escapePreview}</span>
                                            </div>
                                        )}

                                        {escapeWarnings(draft.escape).map((warn, i) => (
                                            <div key={`escape-warn-${i}`} className="text-[10px] text-amber-300/90">⚠ {warn}</div>
                                        ))}

                                        <p className="text-[10px] leading-4 opacity-50">
                                            出线前转义内核字节（套壳外壳字面不转）；画布与编译预览仍是逻辑帧，线上字节以发送历史为准。
                                        </p>
                                    </div>

                                    {configError && <div className="text-red-300 text-[11px]">ERR: {configError}</div>}

                                    <div className="flex items-center gap-3">
                                        <ActionButton onClick={handleApplyConfig} busy={busy === 'config'}>
                                            应用配置 (APPLY)
                                        </ActionButton>
                                        {/* R2：depth 由 GET /transport/status 给出，0 → 置灰
                                            （否则点了必 400，白等一次往返） */}
                                        <ActionButton
                                            onClick={handleRevertConfig}
                                            busy={busy === 'revert'}
                                            disabled={!status?.configHistoryDepth}
                                        >
                                            回退上一配置 (REVERT)
                                        </ActionButton>
                                        <span className="text-[10px] opacity-50">生效时断开既有真实连接</span>
                                        <span className="text-[10px] opacity-50">
                                            {status?.configHistoryDepth
                                                ? `可回退 ${status.configHistoryDepth} 版`
                                                : '暂无可回退配置'}
                                        </span>
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
                                    <div className="pt-1 flex flex-wrap items-center gap-2">
                                        <ActionButton onClick={refreshStatus}>刷新 (REFRESH)</ActionButton>
                                        {/* R15（PLAN §8.49）：自动轮询开关 —— 状态 + 发送历史
                                            一起拉，只在标签页可见时走；关掉即停，手动刷新照旧可用 */}
                                        <button
                                            type="button"
                                            aria-pressed={autoRefresh}
                                            onClick={() => setAutoRefresh((value) => !value)}
                                            className={`border px-3 py-1.5 text-[11px] font-bold tracking-[0.2em] transition-colors duration-150 ${autoRefresh
                                                ? 'border-nier-light bg-nier-light text-nier-dark'
                                                : 'border-nier-light/50 text-nier-light/70 hover:border-nier-light'}`}
                                        >
                                            {autoRefresh ? `自动刷新 AUTO · ${POLL_MS / 1000}s` : '自动刷新停 AUTO OFF'}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <div className="opacity-60">{statusError ? '状态不可用' : '加载中…'}</div>
                            )}
                        </div>
                    </section>
                </div>

                {/* P1 设备档案：命名快照 + 激活切换（重启不丢） */}
                <section className="border border-nier-light/30 bg-nier-dark/60">
                    <PanelTitle hint="/profiles · 重启后仍在">设备档案 (DEVICE PROFILES)</PanelTitle>
                    <div className="p-4 space-y-3 text-xs font-mono">
                        <div className="flex flex-wrap items-end gap-4">
                            <label className={labelClass}>
                                档案 PROFILE
                                <select
                                    value={selectedProfileId}
                                    onChange={(event) => setSelectedProfileId(event.target.value)}
                                    className={inputClass}
                                >
                                    <option value="">— 未选择 —</option>
                                    {profiles.map((profile) => (
                                        <option key={profile.id} value={profile.id}>
                                            {profileOptionLabel(profile)}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <div className="flex items-center gap-2 pb-1">
                                <span className="text-[10px] opacity-50">当前生效 {profileSummary(config)}</span>
                                {selectedProfile && profileBadges(selectedProfile).map((badge) => (
                                    <span
                                        key={badge.text}
                                        className={`border px-2 py-0.5 text-[10px] tracking-[0.2em] ${badge.className}`}
                                    >
                                        {badge.text}
                                    </span>
                                ))}
                            </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-3 border-t border-nier-light/20 pt-3">
                            <ActionButton onClick={handleProfileActivate} disabled={!selectedProfileId} busy={busy === 'profile'}>
                                应用档案 (ACTIVATE)
                            </ActionButton>
                            <ActionButton onClick={handleProfileUpdate} disabled={!selectedProfileId || !config} busy={busy === 'profile'}>
                                更新 (UPDATE)
                            </ActionButton>
                            {/* R15（PLAN §8.49）：改名单独入口 —— 展开下面的改名行，
                                不与「更新（写入配置快照）」混在一起 */}
                            <ActionButton
                                onClick={() => {
                                    setProfileError('');
                                    setRenameValue(selectedProfile?.label || '');
                                    setRenaming(true);
                                }}
                                disabled={!selectedProfileId}
                                busy={busy === 'profile'}
                            >
                                重命名 (RENAME)
                            </ActionButton>
                            <ActionButton onClick={() => setConfirmDeleteProfile(true)} disabled={!selectedProfileId} busy={busy === 'profile'}>
                                删除档案 (DELETE)
                            </ActionButton>
                            <ActionButton onClick={refreshProfiles}>刷新列表 (RELOAD)</ActionButton>
                            <span className="text-[10px] opacity-50">应用 = 档案配置生效；更新 = 当前生效配置写入所选档案</span>
                        </div>

                        {/* R15（PLAN §8.49）：改名行 —— 预填当前名，确认才 PUT；名字没改
                            就不放行（后端能吃同名请求，但那是一次白跑的往返） */}
                        {renaming && (
                            <div className="flex flex-wrap items-center gap-3 border-t border-nier-light/20 pt-3">
                                <input
                                    type="text"
                                    placeholder="档案新名称"
                                    value={renameValue}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && renameValue.trim() && busy !== 'profile' && handleProfileRename()}
                                    className={`${inputClass} flex-1`}
                                />
                                <ActionButton
                                    onClick={handleProfileRename}
                                    disabled={!renameValue.trim() || renameValue.trim() === (selectedProfile?.label || '')}
                                    busy={busy === 'profile'}
                                >
                                    确认改名 (CONFIRM)
                                </ActionButton>
                                <ActionButton onClick={() => { setRenaming(false); setProfileError(''); }}>
                                    放弃 (CANCEL)
                                </ActionButton>
                                <span className="text-[10px] opacity-50">
                                    {'改名 = PUT /profiles/{id} 只送 label（不动配置快照）；同名 —— 含回收站里占名的软删档案 —— 会被服务端 400 拒'}
                                </span>
                            </div>
                        )}

                        <div className="flex flex-wrap items-center gap-3 border-t border-nier-light/20 pt-3">
                            <input
                                type="text"
                                placeholder="新档案名称，如「产线网关」"
                                value={profileName}
                                onChange={(e) => setProfileName(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && profileName.trim() && busy !== 'profile' && handleProfileCreate()}
                                className={`${inputClass} flex-1`}
                            />
                            <ActionButton onClick={handleProfileCreate} disabled={!profileName.trim()} busy={busy === 'profile'}>
                                存为档案 (SAVE)
                            </ActionButton>
                            <span className="text-[10px] opacity-50">存为当前生效配置的快照（服务端落库）</span>
                        </div>

                        {profileError && <div className="text-red-300 text-[11px]">ERR: {profileError}</div>}
                    </div>
                </section>

                {/* R16（PLAN §8.49）：三面板共用的报文显示口径 —— 只换「怎么摆」，不换字节
                    （发送 / 入库 / 校验口径一律不碰；切回 HEX 与存量逐字相同） */}
                <div className="flex flex-wrap items-center gap-2 border border-nier-light/30 bg-nier-dark/60 px-4 py-2">
                    <span className="text-[10px] font-mono tracking-[0.2em] opacity-60">显示格式 FORMAT</span>
                    {FRAME_FORMATS.map((item) => {
                        const on = frameFormat === item.key;
                        return (
                            <button
                                key={item.key}
                                type="button"
                                aria-pressed={on}
                                title={item.hint}
                                onClick={() => setFrameFormat(item.key)}
                                className={`border px-2 py-1 text-[10px] font-bold tracking-[0.15em] transition-colors duration-150 ${on
                                    ? 'border-nier-light bg-nier-light text-nier-dark'
                                    : 'border-nier-light/40 text-nier-light/70 hover:border-nier-light/70'}`}
                            >
                                {item.label}
                            </button>
                        );
                    })}
                    <span className="text-[10px] opacity-50">
                        {`同作用于发送历史预览 / 原始报文 / 响应三处 · ${formatHint}`}
                    </span>
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
                                            <th className="text-left py-1 font-bold">字段 FIELDS</th>
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
                                                {/* R9: 命中应答解出来的「字段 = 值」；无指令名/无响应 → — */}
                                                <td
                                                    className="py-1 truncate max-w-[14rem] text-nier-light/70"
                                                    title={row.fieldsText || ''}
                                                >
                                                    {row.fieldsText || '—'}
                                                </td>
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
                            <PanelTitle hint={`raw 事件 · ${formatHint}`}>原始报文 (RAW FRAME)</PanelTitle>
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
                            <PanelTitle hint={`response / error 事件 · ${formatHint}`}>响应与错误日志 (RESPONSE · ERROR)</PanelTitle>
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
                                        {/* R9: 命中应答 → 字段 = 值（无指令可对 / 解不出则不出） */}
                                        {selectedDecoded && (
                                            <DecodedFields decoded={selectedDecoded} title="字段解码 (RESPONSE FIELDS)" />
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
