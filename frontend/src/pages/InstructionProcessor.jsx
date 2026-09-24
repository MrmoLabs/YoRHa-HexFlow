import React, { useEffect, useMemo, useState } from 'react';
import InstructionListSidebar from '../components/editor/InstructionListSidebar';
import InstructionRunner from '../components/InstructionForm/InstructionRunner';
import { useInstructionData } from '../hooks/useInstructionData';
import NieRDatePicker from '../components/ui/NieRDatePicker';
import { api } from '../api';

// 批次一 (D4-A): wrap 状态机 —— 换指令按 ?instruction_id= 拉绑定、取 is_default
// 行解析默认封装协议：
//   ok      默认行有效且协议在册 → 可开封装（预览 / TRANSMIT / 事务三路联动）
//   none    无默认行（或未选协议）→ 降级裸发
//   missing 默认行协议不在 protocols（陈旧/已删）→ 降级裸发
//   failed  绑定拉取失败 → 降级裸发
// loading 为解析前瞬态（开关同 none 禁用），必然落到上述四态之一。
const EMPTY_PROTOCOLS = [];

export default function InstructionProcessor({
    instructions: initialInstructions,
    setInstructions: setSharedInstructions,
    reloadInstructions,
    protocols = EMPTY_PROTOCOLS
}) {
    const {
        instructions,
        activeInstructionId,
        setActiveInstructionId,
        currentInstruction,
        loadInstructions
    } = useInstructionData({
        instructions: initialInstructions,
        setInstructions: setSharedInstructions,
        fetchInstructions: reloadInstructions,
        disableInitialLoad: true
    });

    const [searchTerm, setSearchTerm] = useState('');
    const [datePickerState, setDatePickerState] = useState({ isOpen: false, value: null, onConfirmCallback: null });
    const visibleInstructions = useMemo(() => {
        const keyword = searchTerm.trim().toLowerCase();
        if (!keyword) return instructions;

        return instructions.filter(instruction => (
            `${instruction.name || instruction.label || ''} ${instruction.code || ''} ${instruction.device_code || ''}`
                .toLowerCase()
                .includes(keyword)
        ));
    }, [instructions, searchTerm]);

    // wrap 状态机（D4-A）：换指令即复位重解析；protocols 恒引用（缺省模块常量），
    // 防「默认参数每渲染新数组 → effect 自旋」。
    const [wrapInfo, setWrapInfo] = useState({ status: 'loading', wrap: null });
    const protocolList = protocols || EMPTY_PROTOCOLS;
    useEffect(() => {
        let alive = true;
        setWrapInfo({ status: 'loading', wrap: null });
        if (!activeInstructionId) return () => { alive = false; };
        (async () => {
            try {
                const rows = await api.getBindings(activeInstructionId);
                if (!alive) return;
                const row = (rows || []).find(r => r.is_default);
                if (!row || !row.protocol_id) {
                    setWrapInfo({ status: 'none', wrap: null });
                    return;
                }
                if (!protocolList.some(p => p.id === row.protocol_id)) {
                    setWrapInfo({ status: 'missing', wrap: null });
                    return;
                }
                setWrapInfo({
                    status: 'ok',
                    wrap: {
                        protocol_id: row.protocol_id,
                        slot_id: row.slot_id || null,
                        slot_order: row.slot_order ?? 0
                    }
                });
            } catch {
                if (alive) setWrapInfo({ status: 'failed', wrap: null });
            }
        })();
        return () => { alive = false; };
    }, [activeInstructionId, protocolList]);

    // Send via backend /dispatch（transport abstraction: loopback default, TCP/serial
    // via /transport/config）。wrap 存在 → 后端套协议外壳；null → 裸帧逐字节不变。
    const handleSend = async (payload, wrap = null) => {
        const instructionName = currentInstruction?.name || currentInstruction?.label || null;
        const record = await api.dispatchPayload(payload, instructionName, wrap);
        console.log(`[Processor] Dispatched (LOOPBACK) id=${record.id} bytes=${record.byte_count} wrap=${wrap ? wrap.protocol_id : 'none'}`);
        return record;
    };

    return (
        <div className="flex-1 flex overflow-hidden relative">
            <InstructionListSidebar
                instructions={visibleInstructions}
                activeInstructionId={activeInstructionId}
                searchTerm={searchTerm}
                setSearchTerm={setSearchTerm}
                onSearch={searchTerm.trim() ? null : loadInstructions}
                onSelect={setActiveInstructionId}
                // Read-only here: passing null hides the Add/Delete buttons entirely.
                onAdd={null}
                onDelete={null}
                hasUnsavedChanges={false}
            />

            <section className="flex-1 relative bg-nier-bg flex flex-col overflow-hidden">
                {activeInstructionId ? (
                    <InstructionRunner
                        instruction={currentInstruction}
                        wrapInfo={wrapInfo}
                        onSend={handleSend}
                        onOpenDatePicker={(val, cb) => setDatePickerState({ isOpen: true, value: val, onConfirmCallback: cb })}
                    />
                ) : (
                    <div className="flex-1 flex items-center justify-center text-nier-dark/30 font-mono tracking-widest animate-pulse">
                        SELECT A PROTOCOL FROM KNOWLEDGE BASE
                    </div>
                )}
            </section>

            <NieRDatePicker
                isOpen={datePickerState.isOpen}
                initialValue={datePickerState.value}
                onConfirm={(iso) => { datePickerState.onConfirmCallback && datePickerState.onConfirmCallback(iso); setDatePickerState(prev => ({ ...prev, isOpen: false })); }}
                onCancel={() => setDatePickerState(prev => ({ ...prev, isOpen: false }))}
            />
        </div>
    );
}
