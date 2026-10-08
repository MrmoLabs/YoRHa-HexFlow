import React, { useEffect, useMemo, useState } from 'react';
import InstructionListSidebar from '../components/editor/InstructionListSidebar';
import InstructionRunner from '../components/InstructionForm/InstructionRunner';
import { useInstructionData } from '../hooks/useInstructionData';
import NieRDatePicker from '../components/ui/NieRDatePicker';
import RouteInputTable from '../components/RouteInputTable';
import { api } from '../api';
import {
    addRouteInput,
    describeResolve,
    describeResolveError,
    describeTrace,
    emptyRouteInputs,
    filledInputCount,
    mergeResolvedInstruction,
    resolveInstructionId,
    toInputsMap,
} from '../utils/routeResolve';
import {
    clearRouteInputs,
    loadRouteInputs,
    saveRouteInputs,
} from '../utils/routeInputsPersist';

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

// R39 路由输入条上的小按钮（与规则页同视觉语言：1px 硬边、无圆角、无阴影）。
const RouteButton = ({ onClick, disabled = false, busy = false, children }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled || busy}
        className="border border-nier-light/60 px-2.5 py-1 text-[10px] font-mono font-bold tracking-[0.2em] text-nier-light transition-colors duration-150 enabled:hover:bg-nier-light enabled:hover:text-nier-dark disabled:opacity-40"
    >
        {busy ? '…' : children}
    </button>
);

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
        loadInstructions,
        setInstructions: setInstructionsState
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

    // ── R39（PLAN §8.71）发前路由：按输入自动选指令 ───────────────────────
    // 输入表是扁平键值（与 evaluate_condition 的变量表同形）；命中 / 无命中 /
    // 结构性缺陷全由后端 resolve_route 说了算，FE 只把回执翻译成人话、不改判。
    // R47（PLAN §8.79 输入表持久化）：本机那份**原样读回** —— 存过就用存的那张表
    // （行序、空行、只填了键没填值的半行一并不动），没存过才给默认一行空行；与规则页
    // 「试解析」共用同一个槽，规则页写下的行切到本页接着用。
    const [routeRows, setRouteRows] = useState(() => loadRouteInputs() ?? emptyRouteInputs());
    const [routeExpanded, setRouteExpanded] = useState(true);
    const [routeBusy, setRouteBusy] = useState(false);
    const [routeMsg, setRouteMsg] = useState(null);   // { kind: 'ok'|'miss'|'sys'|'err', text }
    const [routeUndo, setRouteUndo] = useState(null); // 切换前那条 { id, name }
    // R45（§8.75 七 留白销项）：最近一次**成功**回执的逐条判定轨迹，只回显不改判 ——
    // 一次解析开始就清、失败也清（不残留上一次）；「回到上一条」只改状态条、不动它
    // （轨迹是那次解析的事实记录，规则与条件没变）。
    const [routeTrace, setRouteTrace] = useState([]);

    const instructionLabel = (inst) => inst?.name || inst?.code || inst?.id || null;

    const runResolve = async () => {
        setRouteBusy(true);
        setRouteMsg(null);
        setRouteTrace([]);   // 本次回执说了算，不残留上一次的轨迹
        try {
            const res = await api.resolveRoute(toInputsMap(routeRows));
            const targetId = resolveInstructionId(res);
            if (targetId) {
                // 切之前留痕 —— 只在真的会切时记，「回到上一条」才有意义
                setRouteUndo(currentInstruction
                    ? { id: currentInstruction.id, name: instructionLabel(currentInstruction) }
                    : null);
                setInstructionsState((prev) => mergeResolvedInstruction(prev, res));
                setActiveInstructionId(targetId);
            }
            // R45：同一份回执的 trace，与规则页试解析共用 describeTrace 一张表
            setRouteTrace(describeTrace(res?.trace));
            setRouteMsg({
                kind: res?.matched ? 'ok' : 'miss',
                text: describeResolve(res, { previousName: instructionLabel(currentInstruction) }).text,
            });
        } catch (err) {
            setRouteUndo(null);
            setRouteTrace([]);
            setRouteMsg({ kind: 'err', text: describeResolveError(err) });
        } finally {
            setRouteBusy(false);
        }
    };

    const runUndo = () => {
        if (!routeUndo) return;
        setActiveInstructionId(routeUndo.id);
        setRouteMsg({ kind: 'sys', text: `已回到指令「${routeUndo.name}」。` });
        setRouteUndo(null);
    };

    // R47（§8.79）：行一变就写回本机那份（键入即写）—— 改键值、加行、删行三条路都走
    // 这一个口，否则「改的存了、加的没存」会读回一张对不上的表
    const handleRouteRows = (next) => {
        setRouteRows(next);
        saveRouteInputs(next);
    };

    // R47（§8.79）：显式清空入口 —— 删本机那份 + 屏上回默认一行空行。清的只是输入行：
    // 解析状态条、逐条判定轨迹、UNDO、选中指令都与输入无关，一并不动；也不做二次
    // 确认（清的是本机草稿，不删任何后端数据，删完 ADD 还能再加回来）。
    const handleClearRouteInputs = () => {
        clearRouteInputs();
        setRouteRows(emptyRouteInputs());
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
                {/* R39 发前路由：路由输入 + 解析（常驻，可收起让出执行区高度） */}
                <div className="shrink-0 border-b border-nier-light/30 bg-nier-dark/70">
                    <div className="flex flex-wrap items-center gap-3 px-4 py-2">
                        <span className="text-[11px] font-bold tracking-[0.3em] text-nier-light">
                            路由输入 (ROUTE INPUTS)
                        </span>
                        <span className="text-[10px] font-mono opacity-50">
                            {`POST /dispatch/routed · ${filledInputCount(routeRows)} 项有效 · 值按 JSON 标量解析（0001 → 数字，"0001" → 字符串），空键不发`}
                        </span>
                        <div className="ml-auto flex flex-wrap items-center gap-2">
                            <RouteButton onClick={runResolve} busy={routeBusy}>解析 RESOLVE</RouteButton>
                            {routeUndo && <RouteButton onClick={runUndo}>回到上一条 (UNDO)</RouteButton>}
                            <RouteButton onClick={() => setRouteExpanded((prev) => !prev)}>
                                {routeExpanded ? '收起 COLLAPSE' : '展开 EXPAND'}
                            </RouteButton>
                        </div>
                    </div>

                    {routeMsg && (
                        <div className={[
                            'border-t border-nier-light/20 px-4 py-1.5 text-[11px] font-mono whitespace-pre-line',
                            routeMsg.kind === 'err' ? 'text-warn'
                                : routeMsg.kind === 'miss' ? 'text-hl'
                                    : routeMsg.kind === 'sys' ? 'text-muted'
                                        : 'text-nier-light',
                        ].join(' ')}>
                            {routeMsg.kind === 'err' ? 'ERR: ' : 'SYS: '}
                            {routeMsg.text}
                        </div>
                    )}

                    {/* R45（§8.75 七 留白销项）逐条判定轨迹 —— 与规则页「试解析」共用
                        describeTrace 同一张表，这里只排版不改判；判据（比较 / 变量 / 类型）
                        全在后端 condition.py，FE 不自己扫第二遍条件。回执没带 trace（旧后端）
                        → describeTrace 出 [] → 不出块，状态条照旧写事实。 */}
                    {routeTrace.length > 0 && (
                        <div className="border-t border-nier-light/20 px-4 py-2 flex flex-col gap-1.5">
                            <div className="text-[10px] font-mono tracking-[0.2em] opacity-60">
                                {`逐条判定轨迹 (TRACE) · ${routeTrace.length} 条`}
                            </div>
                            <ol className="border border-nier-light/20">
                                {routeTrace.map((row) => (
                                    <li
                                        key={`route-trace-${row.index}`}
                                        data-testid={`route-trace-${row.index - 1}`}
                                        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-nier-light/10 px-3 py-1.5 last:border-b-0 text-[11px] font-mono"
                                    >
                                        <span className="shrink-0 text-muted">
                                            {`#${row.index}`}
                                        </span>
                                        <span className={row.code === 'MATCHED'
                                            ? 'shrink-0 text-hl'
                                            : 'shrink-0'}>
                                            {row.name}
                                        </span>
                                        <span className="min-w-0 break-all opacity-60">
                                            {row.condition}
                                        </span>
                                        <span className={row.code === 'MATCHED'
                                            ? 'min-w-0 text-hl'
                                            : 'min-w-0'}>
                                            {row.text}
                                        </span>
                                    </li>
                                ))}
                            </ol>
                        </div>
                    )}

                    {routeExpanded && (
                        <div className="border-t border-nier-light/20 px-4 py-2 flex flex-col gap-1.5">
                            {/* 行表本体与规则页「试解析」共用（R40 抽出），按钮与回执仍归本页。
                                R47（§8.79）：行变更即写回本机那份（两页共用一个槽），故「加行」
                                与「清空」都走 handleRouteRows / handleClearRouteInputs ——
                                共用组件不加按钮那条边界不变，两个按钮仍归本页。 */}
                            <RouteInputTable rows={routeRows} onChange={handleRouteRows} />
                            <div className="pt-1 flex flex-wrap items-center gap-2">
                                <RouteButton onClick={() => handleRouteRows(addRouteInput(routeRows))}>
                                    + 添加 ADD
                                </RouteButton>
                                <RouteButton onClick={handleClearRouteInputs}>
                                    清空输入 (CLEAR)
                                </RouteButton>
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                    {currentInstruction ? (
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
                </div>
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
