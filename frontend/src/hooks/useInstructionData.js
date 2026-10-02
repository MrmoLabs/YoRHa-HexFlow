import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../api';
import { normalizeFieldPayload, normalizeInstructionPayload, mergeFieldBitMeta } from '../utils/normalizeInstruction';
import { validateInstruction } from '../utils/validateInstruction';
import { buildDuplicateInstructionPayload } from '../utils/duplicateInstruction';
import { normalizeInstructionDataOptions } from './instructionDataOptions';
import { useHistory } from './useHistory';

// Normalization helpers moved to utils/normalizeInstruction.js (logic unchanged);
// re-exported here so existing consumers keep working.
export { normalizeFieldPayload, normalizeInstructionPayload };

// 批次二 (D12/D14②): 删除确认与回执文案 —— 四表按数据性质三分：
// 活配置（protocol_bindings / response_specs）随删一并移入回收站、冻结快照
// （sequence_steps）保留并标失效、日志（dispatch_logs）只读保留。
// R6-2（PLAN §8.44）: 文案口径由「删了就没了」改为「移入回收站、可恢复」——
// 不可逆的警告只保留在回收站页的「彻底删除」确认里。导出便于单测钉口径。
export const describeReferences = (refs) => {
    const head = '警告：确认将此指令移入回收站？';
    if (!refs || !refs.total) {
        return `${head}\n\n无引用：绑定 / 应答规格 / 序列步骤 / 通讯日志均未指向本指令。`;
    }
    const lines = [head, '', `本指令被 ${refs.total} 处引用：`];
    if (refs.bindings) lines.push(`· 协议绑定 ${refs.bindings} 条 → 随删入站（活配置，随指令恢复）`);
    if (refs.response_specs) lines.push(`· 应答规格 ${refs.response_specs} 条 → 随删入站（活配置，随指令恢复）`);
    if (refs.sequence_steps) lines.push(`· 序列步骤 ${refs.sequence_steps} 条 → 保留（帧已冻结可继续运行，编辑入口标失效）`);
    if (refs.dispatch_logs) lines.push(`· 通讯日志 ${refs.dispatch_logs} 条 → 只读保留`);
    lines.push('', '删除后移入回收站，可在「回收站」页恢复；彻底删除才不可恢复。确认继续？');
    return lines.join('\n');
};

export const describeDeletion = (result) => {
    if (!result) return '已移入回收站（指令）';
    const parts = ['已移入回收站（指令）'];
    if (result.deleted_bindings) parts.push(`绑定 ${result.deleted_bindings} 条级联`);
    if (result.deleted_response_specs) parts.push(`应答规格 ${result.deleted_response_specs} 条级联`);
    if (result.orphaned_sequence_steps) parts.push(`序列步骤 ${result.orphaned_sequence_steps} 条留失效`);
    return parts.join(' · ');
};

/**
 * useInstructionData — data layer for the Instruction (指令) and
 * InstructionProcessor (加工) pages.
 *
 * OPTIONS (page -> hook; validated by hooks/instructionDataOptions.js):
 * @param {Function|Object} [options] — legacy function form == `{ onWebUpdate }`.
 * @param {Array|null} [options.instructions]      External list (SHARED mode).
 * @param {Function} [options.setInstructions]     Parent setter; supplying it
 *   switches the hook to SHARED (受管) mode: writes go through the setter and
 *   onWebUpdate is never fired (prevents feeding the same state back).
 * @param {Function} [options.onWebUpdate]         SELF (自管) mode callback:
 *   called with the fresh list after load/reload/save.
 * @param {Function} [options.fetchInstructions]   (search?: string) =>
 *   Promise<Array> — overrides api.getInstructions everywhere.
 * @param {boolean} [options.disableInitialLoad]   Skip the mount-time load;
 *   SHARED pages pass true and reload explicitly.
 *
 * IMPLICIT CONVENTIONS MADE EXPLICIT (behavior unchanged):
 *   - Shared ownership suppresses onWebUpdate (`!setExternalInstructions && …`).
 *   - fetchInstructions, when present, replaces the default API for both the
 *     initial load and loadInstructions(search).
 *   - disableInitialLoad only guards the mount effect; operator templates
 *     still load on mount.
 *   - Invalid option keys are dropped with a console warning instead of
 *     being silently ignored (normalizeInstructionDataOptions).
 *
 * @returns {{
 *   instructions: Array, activeInstructionId: string|null,
 *   setActiveInstructionId: Function, currentInstruction: Object|null,
 *   operatorTemplates: Object, isOperatorTemplatesLoading: boolean,
 *   operatorTemplatesError: string, isLoading: boolean, statusMsg: string,
 *   setStatusMsg: Function, hasUnsavedChanges: boolean,
 *   setHasUnsavedChanges: Function, setInstructions: Function,
 *   loadData: Function, loadInstructions: Function,
 *   loadOperatorTemplates: Function, updateLocalInstruction: Function,
 *   undo: Function, redo: Function, canUndo: boolean, canRedo: boolean,
 *   saveError: string, setSaveError: Function, addInstruction: Function,
 *   duplicateInstruction: Function, deleteInstruction: Function,
 *   saveChanges: Function, revertChanges: Function
 * }} the page <-> hook return contract (Instruction.jsx destructures these).
 */
export function useInstructionData(options = {}) {
    const normalizedOptions = normalizeInstructionDataOptions(options);
    const {
        instructions: externalInstructions,
        setInstructions: setExternalInstructions,
        onWebUpdate,
        fetchInstructions,
        disableInitialLoad = false
    } = normalizedOptions;
    const [internalInstructions, setInternalInstructions] = useState(externalInstructions || []);
    const [activeInstructionId, setActiveInstructionId] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isOperatorTemplatesLoading, setIsOperatorTemplatesLoading] = useState(false);
    const [statusMsg, setStatusMsg] = useState('');
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
    // 反馈 #2 草稿隔离：活动指令的未保存工作副本只存在于 hook 内 —— 不写
    // 共享 instructions（加工页/编排页读共享态，只见已保存数据）。
    const [draftInstruction, setDraftInstruction] = useState(null);
    const [operatorTemplates, setOperatorTemplates] = useState({});
    const [operatorTemplatesError, setOperatorTemplatesError] = useState('');
    // P4-1: undo/redo stacks for the working copy (cap 50) — destructured as
    // stable callbacks so effects can depend on `clearHistory` alone.
    const { push: pushHistory, undo: popUndo, redo: popRedo, clear: clearHistory, canUndo, canRedo } = useHistory(50);
    // P4-2: PUT failure banner (persistent, retryable) — P0-2 validation
    // failures never set this (校验失败 ≠ 网络失败，文案分开).
    const [saveError, setSaveError] = useState('');
    const isMountedRef = useRef(true);
    const instructionsRef = useRef([]);
    const activeInstructionIdRef = useRef(null);
    const statusTimerRef = useRef(null);
    const instructionRequestIdRef = useRef(0);
    const operatorTemplatesRequestIdRef = useRef(0);
    const baseInstructions = externalInstructions ?? internalInstructions;
    // 反馈 #2：脏态时活动指令用 hook 内草稿 overlay 呈现（管理页所见即草稿），
    // 共享基准保持已保存版本；干净态直接镜像。useMemo 保引用稳定（下方 effect/
    // ref 依赖 instructions）。
    const instructions = useMemo(() => {
        const list = (!hasUnsavedChanges || !draftInstruction)
            ? baseInstructions
            : baseInstructions.map(i => (i.id === draftInstruction.id ? draftInstruction : i));
        // 优化批（零 DDL）：读取视图把 pc.bit_meta 按位段 id 合并回 bits ——
        // 编辑/加工两页共用单源（meta 直接挂在 bit 对象上），幂等、纯视图层，
        // 不回写共享态；保存时由 normalizeFieldPayload 按 bits 重建拆分。
        return list.map(instr => ({
            ...instr,
            fields: Array.isArray(instr.fields)
                ? instr.fields.map(mergeFieldBitMeta)
                : instr.fields
        }));
    }, [baseInstructions, hasUnsavedChanges, draftInstruction]);

    const setInstructionsState = useCallback((nextValue) => {
        if (setExternalInstructions) {
            setExternalInstructions(nextValue);
            return;
        }
        setInternalInstructions(nextValue);
    }, [setExternalInstructions]);

    // Computed property for easy access
    const currentInstruction = useMemo(
        () => instructions.find(i => i.id === activeInstructionId) || null,
        [instructions, activeInstructionId]
    );

    useEffect(() => {
        activeInstructionIdRef.current = activeInstructionId;
    }, [activeInstructionId]);

    // P4-1: history is scoped to the ACTIVE instruction — switching resets both
    // stacks (clearHistory is stable, so activeId is the only real trigger).
    useEffect(() => {
        clearHistory();
    }, [activeInstructionId, clearHistory]);

    useEffect(() => {
        instructionsRef.current = instructions;
    }, [instructions]);
    // 反馈 #2：原「外部变更直写裸 external」效果已删 —— 它会绕过草稿 overlay，
    // 让 pushHistory/删除漏斗读到陈旧共享版本；ref 统一跟随 overlay 后的值。

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            if (statusTimerRef.current) {
                clearTimeout(statusTimerRef.current);
            }
        };
    }, []);

    const showStatus = useCallback((message, durationMs = 0) => {
        if (!isMountedRef.current) return;

        if (statusTimerRef.current) {
            clearTimeout(statusTimerRef.current);
            statusTimerRef.current = null;
        }

        setStatusMsg(message);

        if (durationMs > 0) {
            statusTimerRef.current = setTimeout(() => {
                if (isMountedRef.current) {
                    setStatusMsg('');
                }
            }, durationMs);
        }
    }, []);

    const reconcileActiveInstruction = useCallback((nextInstructions, preferredId = activeInstructionIdRef.current) => {
        const nextActiveId = nextInstructions.some(i => i.id === preferredId)
            ? preferredId
            : (nextInstructions[0]?.id ?? null);
        setActiveInstructionId(nextActiveId);
        return nextActiveId;
    }, []);

    useEffect(() => {
        if (instructions.length === 0) {
            if (activeInstructionIdRef.current !== null) {
                setActiveInstructionId(null);
            }
            return;
        }

        if (!instructions.some(i => i.id === activeInstructionIdRef.current)) {
            reconcileActiveInstruction(instructions);
        }
    }, [instructions, reconcileActiveInstruction]);

    const loadOperatorTemplates = useCallback(async () => {
        const requestId = ++operatorTemplatesRequestIdRef.current;
        setIsOperatorTemplatesLoading(true);
        setOperatorTemplatesError('');
        try {
            const opData = await api.getOperatorTemplates();
            if (!isMountedRef.current || requestId !== operatorTemplatesRequestIdRef.current) return;

            const opMap = {};
            opData.forEach(op => {
                opMap[op.op_code] = op;
            });

            setOperatorTemplates(opMap);
        } catch (err) {
            console.error('Failed to load operator templates', err);
            if (!isMountedRef.current || requestId !== operatorTemplatesRequestIdRef.current) return;
            setOperatorTemplates({});
            setOperatorTemplatesError('模块模板加载失败');
        } finally {
            if (isMountedRef.current && requestId === operatorTemplatesRequestIdRef.current) {
                setIsOperatorTemplatesLoading(false);
            }
        }
    }, []);

    const loadData = useCallback(async () => {
        const requestId = ++instructionRequestIdRef.current;
        setIsLoading(true);
        try {
            const instData = await (fetchInstructions ? fetchInstructions() : api.getInstructions());
            if (!isMountedRef.current || requestId !== instructionRequestIdRef.current) return;
            setInstructionsState(instData);
            reconcileActiveInstruction(instData);
            setHasUnsavedChanges(false); // 反馈 #2：重载 = 服务器接管，草稿/脏标
            setDraftInstruction(null); //           一并复位（挂载期为 no-op）
            if (!setExternalInstructions && onWebUpdate) onWebUpdate(instData);
        } catch (err) {
            console.error('Failed to load instructions', err);
            if (!isMountedRef.current || requestId !== instructionRequestIdRef.current) return;
            showStatus('离线模式 / 指令数据错误');
        } finally {
            if (isMountedRef.current && requestId === instructionRequestIdRef.current) {
                setIsLoading(false);
            }
        }
    }, [fetchInstructions, onWebUpdate, reconcileActiveInstruction, setExternalInstructions, setInstructionsState, showStatus]);

    // Load Initial Data
    useEffect(() => {
        if (disableInitialLoad) return;
        loadData();
    }, [disableInitialLoad, loadData]);

    useEffect(() => {
        loadOperatorTemplates();
    }, [loadOperatorTemplates]);

    const loadInstructions = useCallback(async (search = '') => {
        const requestId = ++instructionRequestIdRef.current;
        setIsLoading(true);
        try {
            const data = await (fetchInstructions ? fetchInstructions(search) : api.getInstructions(search));
            if (!isMountedRef.current || requestId !== instructionRequestIdRef.current) return;
            setInstructionsState(data);
            reconcileActiveInstruction(data);
            setHasUnsavedChanges(false);
            setDraftInstruction(null); // 反馈 #2：服务器版本接管，丢弃本地草稿
            clearHistory(); // P4-1: reload = new baseline
            setSaveError(''); // P4-2: server state supersedes a failed PUT
            if (!setExternalInstructions && onWebUpdate) onWebUpdate(data);
        } catch (err) {
            if (!isMountedRef.current || requestId !== instructionRequestIdRef.current) return;
            console.error(err);
            showStatus('指令列表加载失败');
        } finally {
            if (isMountedRef.current && requestId === instructionRequestIdRef.current) {
                setIsLoading(false);
            }
        }
        // 不列 clearHistory：它在本 hook 内部定义且身份随编辑变化，列入会让这个刷新
        // 回调每次编辑都换身份 → 上游 memo 连锁失效。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fetchInstructions, onWebUpdate, reconcileActiveInstruction, setExternalInstructions, setInstructionsState, showStatus]);

    // P4-1: every working-copy edit funnels through here → snapshot the
    // PREVIOUS version before applying (identical-content calls — e.g. a
    // released no-op drag — don't pollute the undo stack). Undo/redo restore
    // snapshots via undo()/redo() below and keep dirty semantics.
    const updateLocalInstruction = useCallback((updatedInst) => {
        const prevInst = instructionsRef.current.find(i => i.id === updatedInst.id);
        if (prevInst && JSON.stringify(prevInst) !== JSON.stringify(updatedInst)) {
            pushHistory({ id: prevInst.id, inst: prevInst });
        }
        // 反馈 #2：工作副本只进 hook 内草稿（overlay），不再写共享态 ——
        // 加工页/编排页读的共享列表只由 load*/saveChanges/CRUD 成功路径写。
        setDraftInstruction(updatedInst);
        setHasUnsavedChanges(true);
    }, [pushHistory]);

    // P4-1: undo/redo apply the stored snapshot for the ACTIVE instruction and
    // keep dirty semantics (the restored copy still needs saving).
    const undo = useCallback(() => {
        const current = instructionsRef.current.find(i => i.id === activeInstructionIdRef.current);
        if (!current) return;
        const prev = popUndo({ id: current.id, inst: current });
        if (!prev || prev.id !== current.id) return;
        // 反馈 #2：撤销只回写 hook 内草稿（保存前历史仍是本地语义）。
        setDraftInstruction(prev.inst);
        setHasUnsavedChanges(true);
    }, [popUndo]);

    const redo = useCallback(() => {
        const current = instructionsRef.current.find(i => i.id === activeInstructionIdRef.current);
        if (!current) return;
        const next = popRedo({ id: current.id, inst: current });
        if (!next || next.id !== current.id) return;
        // 反馈 #2：重做同撤销，只回写 hook 内草稿。
        setDraftInstruction(next.inst);
        setHasUnsavedChanges(true);
    }, [popRedo]);

    // CRUD ACTIONS
    const addInstruction = async (openConfirmCallback) => {
        const doAdd = async () => {
            const newInstPayload = {
                device_code: 'DEV-001',
                name: `New Instruction ${Math.floor(Math.random() * 1000)}`,
                code: `CMD - ${Math.floor(Math.random() * 1000)} `,
                type: 'STATIC',
                fields: []
            };
            try {
                const created = await api.createInstruction(newInstPayload);
                if (!isMountedRef.current) return;
                setInstructionsState(prev => [...prev, created]);
                setActiveInstructionId(created.id);
                setHasUnsavedChanges(false);
                setDraftInstruction(null); // 反馈 #2：切到新指令 = 丢弃旧草稿
                showStatus('已新增指令', 1000);
            } catch (e) {
                if (e.response && e.response.status === 400) {
                    showStatus(e.response.data.detail);
                } else {
                    showStatus(`新增指令失败：${e?.response?.data?.detail || e?.message || '未知错误'}`);
                }
            }
        };

        if (hasUnsavedChanges && openConfirmCallback) {
            return openConfirmCallback("检测到未保存的更改。\n是否覆盖？", doAdd);
        } else {
            return doAdd();
        }
    };

    // P2-1: duplicate an existing instruction as a brand-new one — fresh
    // field ids + self-contained refs (backend mints the instruction id and
    // enforces unique name/code, both derived with escalating suffixes here).
    const duplicateInstruction = async (sourceId, openConfirmCallback) => {
        const doDuplicate = async () => {
            const source = instructionsRef.current.find(i => i.id === sourceId);
            if (!source) {
                showStatus('复制失败：源指令不存在');
                return;
            }
            try {
                const payload = buildDuplicateInstructionPayload(source, instructionsRef.current);
                const created = await api.createInstruction(payload);
                if (!isMountedRef.current) return;
                setInstructionsState(prev => [...prev, created]);
                setActiveInstructionId(created.id);
                setHasUnsavedChanges(false);
                setDraftInstruction(null); // 反馈 #2：切到副本 = 丢弃旧草稿
                showStatus('已复制指令', 1000);
            } catch (e) {
                if (e.response && e.response.status === 400) {
                    showStatus(e.response.data.detail);
                } else {
                    showStatus(`复制指令失败：${e?.response?.data?.detail || e?.message || '未知错误'}`);
                }
            }
        };

        if (hasUnsavedChanges && openConfirmCallback) {
            return openConfirmCallback("检测到未保存的更改。\n是否覆盖？", doDuplicate);
        } else {
            return doDuplicate();
        }
    };

    const deleteInstruction = async (id, openConfirmCallback) => {
        const doDelete = async () => {
            try {
                const result = await api.deleteInstruction(id);
                if (!isMountedRef.current) return;
                const rem = instructionsRef.current.filter(i => i.id !== id);
                setInstructionsState(rem);
                reconcileActiveInstruction(rem, activeInstructionIdRef.current === id ? null : activeInstructionIdRef.current);
                setHasUnsavedChanges(false);
                setDraftInstruction(null); // 反馈 #2：删除后无活动草稿
                showStatus(describeDeletion(result), 2500);
            } catch (e) {
                showStatus(`删除失败：${e?.response?.data?.detail || e?.message || '未知错误'}`);
            }
        };

        // 批次二 (D12/D14②): 删前 GET 引用计数 → 弹窗列出受影响项与处置
        // （镜像协议页 P0-1 的 GET 计数 + 确认范式）。计数接口失败不拦删除，
        // 降级回原文案（后端仍是同事务级联兜底）。
        if (openConfirmCallback) {
            let refs = null;
            try {
                refs = await api.getInstructionReferences(id);
            } catch {
                refs = null;
            }
            return openConfirmCallback(describeReferences(refs), doDelete);
        } else {
            return doDelete();
        }
    };

    const saveChanges = async (openConfirmCallback) => {
        if (!currentInstruction) return;
        const payload = normalizeInstructionPayload(currentInstruction);

        if (!payload.device_code || !payload.code || !payload.name) {
            showStatus('保存失败：设备前缀、指令代号、指令名称不能为空');
            return;
        }

        // P0-2: structural validation gates the save — errors block the PUT so
        // broken structures (bit overlap, dangling refs, duplicate labels,
        // formula cycles, empty checksum coverage) never reach the API.
        // Warnings (B2–B8 encoder limits, soft inconsistencies) do not block.
        const { errors } = validateInstruction(currentInstruction);
        if (errors.length > 0) {
            const lines = errors.slice(0, 8).map(e => `· ${e.message}`).join('\n');
            const more = errors.length > 8 ? `\n… 共 ${errors.length} 个错误` : '';
            showStatus(`保存被阻止：${errors.length} 个结构错误`);
            if (openConfirmCallback) {
                openConfirmCallback(`保存被阻止，存在 ${errors.length} 个结构错误：\n${lines}${more}`, () => { });
            }
            return;
        }

        try {
            showStatus('保存中...');
            await api.updateInstruction(currentInstruction.id, payload);
            showStatus('已保存', 1000);
            // 反馈 #2：保存成功 = 草稿毕业 —— 写穿共享态（加工页随即可见已保存
            // 版本），再清本地草稿与脏标。
            const saved = currentInstruction;
            setInstructionsState(prev => prev.map(i => i.id === saved.id ? saved : i));
            setDraftInstruction(null);
            setHasUnsavedChanges(false);
            clearHistory(); // P4-1: save = new baseline
            setSaveError(''); // P4-2: success clears any previous failure banner
            if (!setExternalInstructions && onWebUpdate) onWebUpdate(instructions);
        } catch (e) {
            // P4-2: PUT failure — dirty state is KEPT (no silent rollback); a
            // persistent top-bar banner offers retry, RESET stays available.
            // Distinct from P0-2 validation, which never reaches this catch.
            console.error(e);
            const status = e?.response?.status;
            const rawDetail = e?.response?.data?.detail;
            const detail = typeof rawDetail === 'string' ? rawDetail : (e?.message || '未知错误');
            setSaveError((status === 400 || status === 422)
                ? `服务端拒绝（${status}）：${detail}`
                : `网络/服务错误：${detail}`);
            showStatus('保存失败');
            if ((status === 400 || status === 422) && openConfirmCallback) {
                openConfirmCallback(`保存失败：\n${detail}`, () => { });
            }
        }
    };

    const revertChanges = (openConfirmCallback) => {
        if (openConfirmCallback) {
            openConfirmCallback("放弃所有更改并重新加载？", () => loadInstructions());
        } else {
            loadInstructions();
        }
    };

    return {
        instructions,
        activeInstructionId,
        setActiveInstructionId,
        currentInstruction,
        operatorTemplates,
        isOperatorTemplatesLoading,
        operatorTemplatesError,
        isLoading,
        statusMsg,
        setStatusMsg,
        hasUnsavedChanges,
        setHasUnsavedChanges,
        setInstructions: setInstructionsState, // For functional updates like block deletion
        loadData,
        loadInstructions,
        loadOperatorTemplates,
        updateLocalInstruction,
        undo, // P4-1
        redo, // P4-1
        canUndo, // P4-1（栈空禁用按钮）
        canRedo, // P4-1
        saveError, // P4-2 保存失败横幅
        setSaveError, // P4-2 关闭横幅
        addInstruction,
        duplicateInstruction,
        deleteInstruction,
        saveChanges,
        revertChanges
    };
}
