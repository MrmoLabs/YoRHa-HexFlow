import React, { useState, useEffect } from 'react';
import { useInstructionForm } from '../../hooks/useInstructionForm';
import { api } from '../../api';
import { v4 as uuidv4 } from 'uuid';
import { normalizeRunnerInstruction } from './normalizeRunnerInstruction';
import RunnerFieldTree from './RunnerFieldTree';
import TransmissionLog from './TransmissionLog';
import TransactionPanel from './TransactionPanel';
import { triggerBlobDownload } from '../../utils/download';

export default function InstructionRunner({ instruction, onSend, onOpenDatePicker }) {
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
        setInputs
    } = useInstructionForm(normalizedInstruction);

    const [logs, setLogs] = useState([]);
    const [isSending, setIsSending] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [exportMsg, setExportMsg] = useState('');

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
    }, [inputs, hexPreview, isSending]);

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
                await onSend(payload);
            }
            setLogs(prev => prev.map(l => l.id === entryId ? { ...l, status: 'SENT' } : l));
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
                        />
                    </div>
                </div>

                {/* Right: Preview */}
                <div className="w-1/3 flex flex-col gap-6 border-l-2 border-nier-light/5 pl-5 overflow-y-auto custom-scrollbar">
                    <div className="bg-[#4a4a4a] text-[#dad4bb] p-3 relative border border-[#5c5c5c]">
                        <div className="absolute top-0 right-0 bg-[#5c5c5c] text-[9px] px-2 py-0.5 font-bold tracking-widest">
                            BYTE_STREAM_OUTPUT
                        </div>
                        <div className="font-mono text-2xl break-all leading-tight tracking-[0.1em] mt-4 font-black transition-all duration-300">
                            {hexPreview || '00'}
                        </div>
                    </div>

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

                    {/* P2 事务发送：规格编辑 + 超时重发/广播 + 逐次 attempt/RTT */}
                    <TransactionPanel instruction={instruction} payload={hexPreview.replace(/\s/g, '')} />

                    <div className="min-h-[240px] flex flex-col">
                        <TransmissionLog logs={logs} />
                    </div>
                </div>
            </div>
        </div>
    );
}
