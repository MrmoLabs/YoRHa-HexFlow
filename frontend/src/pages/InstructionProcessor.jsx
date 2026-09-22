import React, { useMemo, useState } from 'react';
import InstructionListSidebar from '../components/editor/InstructionListSidebar';
import InstructionRunner from '../components/InstructionForm/InstructionRunner';
import { useInstructionData } from '../hooks/useInstructionData';
import NieRDatePicker from '../components/ui/NieRDatePicker';
import { api } from '../api';

export default function InstructionProcessor({ instructions: initialInstructions, setInstructions: setSharedInstructions, reloadInstructions }) {
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

    // Send via backend /dispatch (transport abstraction: loopback default, TCP/serial via /transport/config).
    const handleSend = async (payload) => {
        const instructionName = currentInstruction?.name || currentInstruction?.label || null;
        const record = await api.dispatchPayload(payload, instructionName);
        console.log(`[Processor] Dispatched (LOOPBACK) id=${record.id} bytes=${record.byte_count}`);
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
