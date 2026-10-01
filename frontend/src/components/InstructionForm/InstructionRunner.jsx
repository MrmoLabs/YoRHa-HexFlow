import React, { useState, useEffect } from 'react';
import { useInstructionForm } from '../../hooks/useInstructionForm';
import { api } from '../../api';
import { v4 as uuidv4 } from 'uuid';
import { normalizeRunnerInstruction } from './normalizeRunnerInstruction';
import RunnerFieldTree from './RunnerFieldTree';
import TransmissionLog from './TransmissionLog';
import TransactionPanel from './TransactionPanel';
import { triggerBlobDownload } from '../../utils/download';
import {
    collectSubtreeIds,
    matchByteRanges,
    buildHexSegments,
    formatByteRanges,
    findFieldLabel
} from '../../utils/byteHighlight';
import { advanceAutoCounter } from '../../config/runnerRenderRules';

// 第 4 批 #3：右栏分区标题（en 轨 + 中文 + 用途释义）——让 BYTE_STREAM /
// WRAP / TRANSMIT 各自的数据用途一眼可读。
const SectionTitle = ({ en, zh, hint }) => (
    <div>
        <div className="text-[10px] font-black font-mono text-nier-light/60 uppercase tracking-[0.3em]">
            :: {en} :: <span className="text-nier-light/90">{zh}</span>
        </div>
        {hint && (
            <div className="text-[9px] font-mono text-nier-light/40 mt-1.5 leading-relaxed">
                {hint}
            </div>
        )}
    </div>
);

export default function InstructionRunner({ instruction, onSend, onOpenDatePicker, wrapInfo }) {
    // 1. Normalize Instruction Object (Schema Mapping)
    const normalizedInstruction = React.useMemo(
        () => normalizeRunnerInstruction(instruction),
        [instruction]
    );

    const {
        inputs,
        handleInputChange,
        computedValues,
        hexPreview,
        byteMap, // 第 4 批 #2：{start,end,fieldId} 逐字段字节区间（此前丢弃未用）
        setInputs
    } = useInstructionForm(normalizedInstruction);

    const [logs, setLogs] = useState([]);
    const [isSending, setIsSending] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [exportMsg, setExportMsg] = useState('');

    // 第 4 批 #2：选中字段 → BYTE_STREAM_OUTPUT 高亮定位（换指令复位）
    const [selectedFieldId, setSelectedFieldId] = useState(null);
    useEffect(() => { setSelectedFieldId(null); }, [normalizedInstruction?.id]);

    // 选中 id → 叶/容器子树 id 集；命中 byteMap 条目；hex 渲染分段
    const selectedIds = React.useMemo(
        () => (normalizedInstruction && selectedFieldId
            ? collectSubtreeIds(normalizedInstruction.fields, selectedFieldId)
            : null),
        [normalizedInstruction, selectedFieldId]
    );
    const matchedRanges = React.useMemo(
        () => matchByteRanges(byteMap, selectedIds),
        [byteMap, selectedIds]
    );
    const segments = React.useMemo(
        () => buildHexSegments(hexPreview, byteMap, selectedIds),
        [hexPreview, byteMap, selectedIds]
    );
    const fieldLabelOf = React.useCallback(
        (id) => findFieldLabel(normalizedInstruction?.fields, id) || id,
        [normalizedInstruction]
    );

    // 批次一 (D4-A): 封装开关 —— 仅 wrap 状态机 ok 时可开；开 → TRANSMIT 与
    // TransactionPanel 同带 wrap（内核载荷出线、后端套壳），预览 300ms 防抖调
    // compileWrapped（与发送同参 → 同字节）。默认开（DESIGN_CorePipeline §7 批次一
    // 1c 口径：无绑定/拉取失败自动降级裸发，开关仅在 ok 态可手动关）。
    const wrap = wrapInfo?.status === 'ok' ? wrapInfo.wrap : null;
    const [wrapOn, setWrapOn] = useState(true);
    const [wrapPreview, setWrapPreview] = useState(null); // { hex, warnings } | null
    const [wrapPreviewErr, setWrapPreviewErr] = useState('');
    const [wrapPreviewing, setWrapPreviewing] = useState(false);
    const activeWrap = wrapOn && wrap ? wrap : null;

    // 换绑定/换指令 → 复位为默认开（新解析结果从默认态起步）与清预览
    const wrapKey = wrap ? `${wrap.protocol_id}|${wrap.slot_id || ''}|${wrap.slot_order}` : '';
    useEffect(() => { setWrapOn(true); }, [wrapKey]);

    // 封装预览：300ms 防抖调 POST /compile/wrapped；关开关/换指令即弃在途请求。
    useEffect(() => {
        if (!activeWrap) {
            setWrapPreview(null);
            setWrapPreviewErr('');
            return undefined;
        }
        const kernel = hexPreview.replace(/\s/g, '');
        if (!kernel) {
            setWrapPreview(null);
            return undefined;
        }
        let alive = true;
        const timer = setTimeout(async () => {
            setWrapPreviewing(true);
            try {
                const result = await api.compileWrapped({
                    protocolId: activeWrap.protocol_id,
                    payloads: [kernel],
                    slotIds: [activeWrap.slot_id || null],
                    startOrder: activeWrap.slot_order ?? 0
                });
                if (!alive) return;
                setWrapPreview({ hex: result.hex_string, warnings: result.warnings || [] });
                setWrapPreviewErr('');
            } catch (err) {
                if (!alive) return;
                setWrapPreview(null);
                setWrapPreviewErr(err?.message || 'WRAP COMPILE FAILED');
            } finally {
                if (alive) setWrapPreviewing(false);
            }
        }, 300);
        return () => { alive = false; clearTimeout(timer); };
    }, [activeWrap, hexPreview]);

    // Keyboard Shortcuts
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                handleSend();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [inputs, hexPreview, isSending, activeWrap]);

    const handleSend = async () => {
        if (!instruction || !normalizedInstruction || isSending) return;
        const payload = hexPreview.replace(/\s/g, '');
        if (!payload) {
            // Never transmit an empty frame (e.g. instruction with no fields yet).
            setLogs(prev => [{
                id: uuidv4(),
                time: new Date().toLocaleTimeString(),
                name: instruction.name || instruction.label || 'Unknown',
                payload: '--',
                status: 'FAILED',
                error: 'EMPTY FRAME — nothing to send'
            }, ...prev].slice(0, 50));
            return;
        }
        const entryId = uuidv4();
        const entry = {
            id: entryId,
            time: new Date().toLocaleTimeString(),
            name: instruction.name || instruction.label || 'Unknown',
            payload: hexPreview,
            status: 'SENDING'
        };
        setLogs(prev => [entry, ...prev].slice(0, 50)); // Keep last 50
        setIsSending(true);

        try {
            if (onSend) {
                await onSend(payload, activeWrap);
            }
            setLogs(prev => prev.map(l => l.id === entryId ? { ...l, status: 'SENT' } : l));
            // 第 15 单：CNT 自动推进 —— 发送成功后 Current=(Current+Step)%Max（与编码
            // 端 E1-6 / advanceAutoCounter 同口径），回写输入态；NEXT 语义 chip 与字节
            // 流预览随 inputs 实时刷新。事务面板（同 payload 多 attempt）不推进。
            setInputs(prev => {
                const next = { ...prev };
                let touched = false;
                const walk = (nodes) => (nodes || []).forEach(f => {
                    const advanced = advanceAutoCounter(f, prev[f.id]);
                    if (advanced !== null) { next[f.id] = advanced; touched = true; }
                    walk(f.fields);
                });
                walk(normalizedInstruction.fields);
                return touched ? next : prev;
            });
        } catch (err) {
            setLogs(prev => prev.map(l => l.id === entryId
                ? { ...l, status: 'FAILED', error: err?.message || 'UNKNOWN ERROR' }
                : l));
        } finally {
            setIsSending(false);
        }
    };

    const handleExport = async () => {
        if (!instruction || isExporting) return;
        setIsExporting(true);
        setExportMsg('');
        try {
            const hexString = hexPreview.replace(/\s/g, '');
            const safeName = (instruction.code || instruction.name || 'yorha-frame')
                .replace(/[^\w.\-]+/g, '_');
            const blob = await api.exportHexFile(hexString, `${safeName}.hex`);
            triggerBlobDownload(blob, `${safeName}.hex`);
            setExportMsg('EXPORT OK');
        } catch (err) {
            setExportMsg(`EXPORT FAILED: ${err?.message || 'UNKNOWN'}`);
        } finally {
            setIsExporting(false);
        }
    };

    if (!normalizedInstruction) {
        return (
            <div className="flex-1 items-center justify-center text-nier-light/50 font-mono animate-pulse">
                // WAITING FOR SELECTION...
            </div>
        );
    }

    // Polished Header Logic
    const deviceCode = normalizedInstruction.device_code || 'GENERIC-DEV';
    const instructionCode = normalizedInstruction.code || normalizedInstruction.id;
    const instructionName = normalizedInstruction.name || normalizedInstruction.label || 'Unnamed Protocol';

    // 批次一 (D4-A): 封装状态文案（状态机四态 + loading 瞬态，均落「降级裸发」）
    const wrapStatusText = !wrap
        ? (wrapInfo?.status === 'missing'
            ? 'PROTOCOL MISSING — 降级裸发'
            : wrapInfo?.status === 'failed'
                ? 'BINDING LOAD FAILED — 降级裸发'
                : wrapInfo?.status === 'loading'
                    ? 'RESOLVING BINDING...'
                    : 'NO DEFAULT BINDING — 裸发')
        : wrapOn
            ? `WRAP ACTIVE // ${wrap.protocol_id} · ${wrap.slot_id || 'DENSE'}`
            : 'WRAP READY // DEFAULT BINDING';

    return (
        <div className="flex-1 flex flex-col h-full bg-nier-bg p-5 gap-8 overflow-hidden">
            {/* Header */}
            <div className="border-b-4 border-nier-light/20 pb-5 flex justify-between items-end">
                <div>
                    <div className="text-[10px] font-black font-mono text-nier-light/40 mb-2 tracking-[0.3em] uppercase">:: Operational Protocol ::</div>
                    <h2 className="text-4xl font-black text-nier-light tracking-tighter leading-none mb-2">
                        {deviceCode} <span className="opacity-20">/</span> {instructionCode}
                    </h2>
                    <div className="text-base font-bold text-nier-light/80 font-mono flex items-center gap-3">
                        <span className="w-4 h-[2px] bg-nier-light/40"></span>
                        {instructionName}
                    </div>
                </div>
                <div className="text-right font-mono text-nier-light/50 font-bold leading-tight">
                    <div className="text-[10px] opacity-40 uppercase tracking-widest mb-1">Status: Ready</div>
                    <div className="text-xs uppercase">LEN: {hexPreview.replace(/\s/g, '').length / 2} BYTES</div>
                    <div className="text-[9px] opacity-30 mt-1 uppercase">ID: {normalizedInstruction.id}</div>
                </div>
            </div>

            <div className="flex-1 flex gap-8 overflow-hidden">
                {/* Left: Dynamic Form */}
                <div className="flex-[2] overflow-y-auto pr-5 custom-scrollbar">
                    <div className="mb-8 flex items-center gap-4">
                        <div className="h-[1px] flex-1 bg-nier-light/10"></div>
                        <span className="text-xs font-black font-mono text-nier-light/60 uppercase tracking-[0.4em] whitespace-nowrap">
                            Configuration / 系统配置
                        </span>
                        <div className="h-[1px] flex-1 bg-nier-light/10"></div>
                    </div>
                    <div className="space-y-1">
                        <RunnerFieldTree
                            fields={normalizedInstruction.fields}
                            inputs={inputs}
                            computedValues={computedValues}
                            onFieldChange={handleInputChange}
                            onOpenDatePicker={onOpenDatePicker}
                            selectedFieldId={selectedFieldId}
                            onSelectField={setSelectedFieldId}
                        />
                    </div>
                </div>

                {/* Right: Preview — 第 4 批 #3 分区 + 释义 + 选中读数 */}
                <div className="w-1/3 flex flex-col gap-6 border-l-2 border-nier-light/5 pl-5 overflow-y-auto custom-scrollbar">
                    {/* 分区 1：字节流预览（随左侧输入实时驱动，点击字段高亮定位） */}
                    <div className="flex flex-col gap-2">
                        <SectionTitle
                            en="BYTE STREAM"
                            zh="字节流预览"
                            hint="随左侧输入实时重算；点击字段 → 下方反白高亮其在指令码中的字节位置"
                        />
                        <div className="bg-[#4a4a4a] text-[#dad4bb] p-3 relative border border-[#5c5c5c]">
                            <div className="absolute top-0 right-0 bg-[#5c5c5c] text-[9px] px-2 py-0.5 font-bold tracking-widest">
                                BYTE_STREAM_OUTPUT
                            </div>
                            <div className="font-mono text-2xl break-all leading-tight tracking-[0.1em] mt-4 font-black transition-all duration-300">
                                {segments.length > 0 ? segments.map((s, i) => (
                                    <React.Fragment key={`${s.fieldId ?? 'raw'}-${s.start}-${i}`}>
                                        {i > 0 && ' '}
                                        <span
                                            data-byte-segment
                                            data-field-id={s.fieldId ?? ''}
                                            data-selected={s.selected || undefined}
                                            title={s.fieldId
                                                ? `${fieldLabelOf(s.fieldId)} @0x${s.start.toString(16).toUpperCase().padStart(2, '0')}`
                                                : undefined}
                                            className={s.selected ? 'bg-[#dad4bb] text-[#4a4a4a]' : undefined}
                                        >
                                            {s.text}
                                        </span>
                                    </React.Fragment>
                                )) : (hexPreview || '00')}
                            </div>
                        </div>
                        {/* 选中读数条：字段名 · 字节偏移区间 · 长度（与高亮联动） */}
                        <div data-testid="byte-readout" className="text-[9px] font-mono uppercase tracking-widest min-h-[14px]">
                            {selectedFieldId && matchedRanges.length > 0 ? (
                                <span className="text-[#E58D28]">
                                    SEL :: {fieldLabelOf(selectedFieldId)}
                                    {' · '}{formatByteRanges(matchedRanges)}
                                    {' · '}{matchedRanges.reduce((sum, e) => sum + (e.end - e.start), 0)}B
                                </span>
                            ) : (
                                <span className="text-nier-light/35">点击字段 → 在字节流中定位对应字节</span>
                            )}
                        </div>
                    </div>

                    {/* 分区 2：协议封装（默认绑定套外框，预览/发送/事务同轨） */}
                    <div className="flex flex-col gap-2">
                        <SectionTitle
                            en="PROTOCOL WRAP"
                            zh="协议封装"
                            hint="开启后按默认绑定协议给内核帧套外框；预览 / TRANSMIT / 事务三路同参同字节"
                        />
                        {/* 批次一 (D4-A): 封装开关 —— 状态机 ok 才可开；开 → 预览/TRANSMIT/事务同轨 */}
                        <div className="border border-nier-light/20 p-2 flex items-center justify-between gap-2">
                            <span className="text-[9px] font-mono text-nier-light/40 uppercase tracking-[0.2em] whitespace-nowrap">:: Wrap ::</span>
                            <button
                                type="button"
                                onClick={() => setWrapOn(on => !on)}
                                disabled={!wrap}
                                aria-pressed={Boolean(activeWrap)}
                                title={wrap ? '协议封装开关 (WRAP)' : '无可用默认绑定 — 仅裸发'}
                                className={`text-[9px] font-mono uppercase tracking-widest border px-2 py-1 transition-colors duration-100 ${activeWrap
                                    ? 'border-nier-light bg-nier-light text-nier-dark'
                                    : 'border-nier-light/20 text-nier-light/50 hover:border-nier-light/60 hover:text-nier-light'} disabled:opacity-40 disabled:cursor-not-allowed`}
                            >
                                {activeWrap ? 'WRAP ●' : 'WRAP ○'}
                            </button>
                        </div>
                        <div data-testid="wrap-status" className="text-[9px] font-mono text-nier-light/40 uppercase tracking-widest break-all">
                            {wrapStatusText}
                        </div>

                        {/* 封装预览：300ms 防抖 compileWrapped 结果（与发送同参 → 同字节） */}
                        {activeWrap && (
                            <div className="bg-[#4a4a4a] text-[#dad4bb] p-3 relative border border-[#5c5c5c]">
                                <div className="absolute top-0 right-0 bg-[#5c5c5c] text-[9px] px-2 py-0.5 font-bold tracking-widest">
                                    WRAPPED_STREAM
                                </div>
                                <div className="font-mono text-xl break-all leading-tight tracking-[0.1em] mt-4">
                                    {wrapPreviewErr
                                        ? <span className="text-red-400 text-[10px]">{wrapPreviewErr}</span>
                                        : (wrapPreview?.hex || (wrapPreviewing ? '···' : '--'))}
                                </div>
                                {wrapPreview?.warnings?.length > 0 && (
                                    <div className="mt-2 text-[9px] font-mono text-yellow-400 tracking-widest break-all">
                                        ⚠ {wrapPreview.warnings.join(' · ')}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* 分区 3：发送与导出 */}
                    <div className="flex flex-col gap-2">
                        <SectionTitle
                            en="TRANSMIT"
                            zh="发送与导出"
                            hint="TRANSMIT 走 dispatch 上线（CTRL+ENT 快捷）；EXPORT 落 .hex 文件"
                        />
                        <button
                            onClick={handleSend}
                            disabled={isSending}
                            className="bg-nier-light text-white py-4 px-5 font-black text-sm tracking-[0.2em] hover:bg-[#2a2a2a] transition-all active:scale-95 flex items-center justify-between group disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <span>{isSending ? 'TRANSMITTING...' : 'TRANSMIT_DATA'}</span>
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] font-mono opacity-50">CTRL+ENT</span>
                                <span className={`w-2 h-2 bg-white ${isSending ? 'animate-pulse' : ''}`}></span>
                            </div>
                        </button>

                        <button
                            onClick={handleExport}
                            disabled={isExporting}
                            className="border border-nier-light text-nier-light py-2 px-5 font-black text-xs tracking-[0.2em] hover:bg-nier-light hover:text-nier-dark transition-all flex items-center justify-between disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <span>{isExporting ? 'EXPORTING...' : 'EXPORT_HEX'}</span>
                            <span className="text-[10px] font-mono opacity-50">.HEX</span>
                        </button>
                        {exportMsg && (
                            <div className={`text-[10px] font-mono tracking-widest text-center ${exportMsg === 'EXPORT OK' ? 'text-green-400' : 'text-red-400'}`}>
                                {exportMsg}
                            </div>
                        )}
                    </div>

                    {/* P2 事务发送：规格编辑 + 超时重发/广播 + 逐次 attempt/RTT（wrap 开→同带协议外壳） */}
                    <TransactionPanel instruction={instruction} payload={hexPreview.replace(/\s/g, '')} wrap={activeWrap} />

                    <div className="min-h-[240px] flex flex-col">
                        <TransmissionLog logs={logs} />
                    </div>
                </div>
            </div>
        </div>
    );
}
