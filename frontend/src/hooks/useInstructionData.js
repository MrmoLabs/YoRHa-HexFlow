import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../api';
import { normalizeFieldPayload, normalizeInstructionPayload } from '../utils/normalizeInstruction';

// Normalization helpers moved to utils/normalizeInstruction.js (logic unchanged);
// re-exported here so existing consumers keep working.
export { normalizeFieldPayload, normalizeInstructionPayload };

export function useInstructionData(options = {}) {
    const normalizedOptions = typeof options === 'function'
        ? { onWebUpdate: options }
        : (options || {});
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
    const [operatorTemplates, setOperatorTemplates] = useState({});
    const [operatorTemplatesError, setOperatorTemplatesError] = useState('');
    const isMountedRef = useRef(true);
    const instructionsRef = useRef([]);
    const activeInstructionIdRef = useRef(null);
    const statusTimerRef = useRef(null);
    const instructionRequestIdRef = useRef(0);
    const operatorTemplatesRequestIdRef = useRef(0);
    const instructions = externalInstructions ?? internalInstructions;

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

    useEffect(() => {
        instructionsRef.current = instructions;
    }, [instructions]);

    useEffect(() => {
        if (!externalInstructions) return;
        instructionsRef.current = externalInstructions;
    }, [externalInstructions]);

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
    }, [fetchInstructions, onWebUpdate, reconcileActiveInstruction, setExternalInstructions, setInstructionsState, showStatus]);

    const updateLocalInstruction = useCallback((updatedInst) => {
        setInstructionsState(prev => prev.map(i => i.id === updatedInst.id ? updatedInst : i));
        setHasUnsavedChanges(true);
    }, [setInstructionsState]);

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

    const deleteInstruction = async (id, openConfirmCallback) => {
        const doDelete = async () => {
            try {
                await api.deleteInstruction(id);
                if (!isMountedRef.current) return;
                const rem = instructionsRef.current.filter(i => i.id !== id);
                setInstructionsState(rem);
                reconcileActiveInstruction(rem, activeInstructionIdRef.current === id ? null : activeInstructionIdRef.current);
                setHasUnsavedChanges(false);
                showStatus('已删除指令', 1000);
            } catch (e) {
                showStatus(`删除失败：${e?.response?.data?.detail || e?.message || '未知错误'}`);
            }
        };

        if (openConfirmCallback) {
            return openConfirmCallback("警告：确认永久删除此指令？", doDelete);
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

        try {
            showStatus('保存中...');
            await api.updateInstruction(currentInstruction.id, payload);
            showStatus('已保存', 1000);
            setHasUnsavedChanges(false);
            if (!setExternalInstructions && onWebUpdate) onWebUpdate(instructions);
        } catch (e) {
            console.error(e);
            if (e.response && (e.response.status === 400 || e.response.status === 422) && openConfirmCallback) {
                showStatus(e.message);
                openConfirmCallback(`保存失败：\n${e.message}`, () => { });
            } else {
                showStatus('保存失败');
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
        addInstruction,
        deleteInstruction,
        saveChanges,
        revertChanges
    };
}
