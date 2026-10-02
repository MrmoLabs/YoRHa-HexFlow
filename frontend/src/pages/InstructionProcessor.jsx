import React, { useEffect, useMemo, useState } from 'react';
import InstructionListSidebar from '../components/editor/InstructionListSidebar';
import InstructionRunner from '../components/InstructionForm/InstructionRunner';
import { useInstructionData } from '../hooks/useInstructionData';
import NieRDatePicker from '../components/ui/NieRDatePicker';
import { api } from '../api';

// wrap 状态机（批次一 D4-A + CP3 3a 降级链三级）—— 换指令按第一个命中的级解析：
//   第 1 级  配方    GET /recipes?instruction_id= 有行且 stages 非空 → mode:'recipe'
//                    （加工页分层预览 / TRANSMIT / 事务三路同参同字节）
//   第 2 级  默认协议 GET /bindings?instruction_id= 取 is_default 行且协议在册
//   第 3 级  裸发     以下任一：无配方且无默认行 / 协议陈旧已删 / 拉取失败
//   ok      第 1 或第 2 级命中 → 可开封装
//   none    无默认行（或未选协议）→ 降级裸发
//   missing 默认行协议不在 protocols（陈旧/已删）→ 降级裸发
//   failed  绑定拉取失败 → 降级裸发（配方级拉取失败**不整机降级**，继续第 2 级）
// loading 为解析前瞬态（开关同 none 禁用），必然落到上述四态之一。
// 三级互斥（DESIGN_CorePipeline §9.3）：配方与默认协议是**或**关系，不叠加。
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

    // wrap 状态机（D4-A + CP3 3a）：换指令即复位重解析；protocols 恒引用（缺省
    // 模块常量），防「默认参数每渲染新数组 → effect 自旋」。
    const [wrapInfo, setWrapInfo] = useState({ status: 'loading', wrap: null });
    const protocolList = protocols || EMPTY_PROTOCOLS;
    useEffect(() => {
        let alive = true;
        // 拉取前把 wrap 区置回 loading（旧值残留会误导）——「异步结果驱动本地状态」
        // 的标准写法；改派生 state 要动 loading/success/error 三态的整套时序。
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setWrapInfo({ status: 'loading', wrap: null });
        if (!activeInstructionId) return () => { alive = false; };
        (async () => {
            // ---- 第 1 级：配方（按指令 default_recipe_id 反查，0 或 1 条）----
            let recipes = [];
            try {
                recipes = await api.getRecipes(activeInstructionId);
            } catch {
                // 配方级失败只降级到下一级，不把默认协议也一起废掉
                recipes = [];
            }
            if (!alive) return;
            const recipe = (recipes || [])[0];
            if (recipe && (recipe.stages || []).length) {
                setWrapInfo({
                    status: 'ok',
                    wrap: {
                        mode: 'recipe',
                        recipe_id: recipe.id,
                        name: recipe.name || '',
                        stages: recipe.stages
                    }
                });
                return;
            }

            // ---- 第 2 级：默认封装协议（失败 → failed 裸发，沿批次一 1c 口径）----
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
    // 配方态 wrap 原样下发（mode/name/stages 属显示字段，WrapSpec 只取 recipe_id，
    // Pydantic 多余键忽略）—— 与 /compile/wrapped 预览同一 recipe_id → 同字节。
    const handleSend = async (payload, wrap = null) => {
        const instructionName = currentInstruction?.name || currentInstruction?.label || null;
        const record = await api.dispatchPayload(payload, instructionName, wrap);
        const wrapLabel = !wrap ? 'none' : (wrap.mode === 'recipe' ? `recipe:${wrap.recipe_id}` : wrap.protocol_id);
        console.log(`[Processor] Dispatched (LOOPBACK) id=${record.id} bytes=${record.byte_count} wrap=${wrapLabel}`);
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
