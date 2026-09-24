import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Canvas from '../components/editor/Canvas';
import ProtocolListSidebar from '../components/editor/ProtocolListSidebar';
import ProtocolPropertiesPanel from '../components/editor/ProtocolPropertiesPanel';
import NieRModal from '../components/ui/NieRModal';
import { v4 as uuidv4 } from 'uuid';
import { api } from '../api';
import { serializeProtocol, findNode, buildProtocolLanes, computeProtocolOffsets, moveNode, removeNode, updateNode, collectContainerIds, findAncestors, injectRefsSigma, injectContainerContent, buildDuplicateProtocolPayload, duplicateNode } from '../utils/protocolTree';
import { validateProtocol } from '../utils/validateProtocol';
import { analyzeProtocolImport } from '../utils/importExport';
import { triggerBlobDownload } from '../utils/download';
import { BLOCK_TYPES, createBlock, isNestable } from '../config/blockTypes';
import { useHistory } from '../hooks/useHistory';

export default function Protocol({ protocols, setProtocols }) {
    const [activeProtocolId, setActiveProtocolId] = useState(protocols[0]?.id || null);
    const [statusMsg, setStatusMsg] = useState('');
    // 批次一 P0-3: 保存失败横幅（镜像指令页 P4-2 saveError）——透传后端
    // detail（400 "refs target not found" 这类英文原文比固定文案可定位），
    // 脏负载归还 pendingSaveRef 后横幅「重试」与离开拦截都重新武装。
    const [saveError, setSaveError] = useState('');
    // 批次五: version 乐观并发冲突态 —— 与文案分开存：saveError 只管横幅文字，
    // 冲突态决定按钮组（强制覆盖/加载最新 双动作）；非冲突失败仍是「重试」。
    const [saveConflict, setSaveConflict] = useState(false);
    const [selectedId, setSelectedId] = useState(null);
    const saveTimerRef = useRef(null);
    const statusTimerRef = useRef(null);
    // 批次四 P3-2: 导入文件选择器（镜像指令页 importInputRef）+ 预览弹窗态
    const importInputRef = useRef(null);
    const [importPreview, setImportPreview] = useState(null); // { report, summary }
    const lastPersistedSignatureRef = useRef('');
    // Debounced-save bookkeeping: remember the pending payload so protocol
    // switches / unmount can FLUSH it instead of dropping it. Otherwise the
    // switch effect rewrites lastPersistedSignatureRef with the IN-MEMORY
    // (dirty) state, the pending save then sees matching signatures and
    // silently skips persisting the edits (lost on reload).
    const pendingSaveRef = useRef(null);
    const flushPendingSave = () => {
        if (!pendingSaveRef.current) return;
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        // saveProtocol is declared later in the component but this helper only
        // ever runs from effects after render; failures surface via showStatus.
        saveProtocol(pending).catch(() => { /* surfaced below in saveProtocol */ });
    };

    useEffect(() => {
        if (!activeProtocolId && protocols.length > 0) {
            setActiveProtocolId(protocols[0].id);
        } else if (!protocols.find(p => p.id === activeProtocolId) && protocols.length > 0) {
            setActiveProtocolId(protocols[0].id);
        }
    }, [protocols, activeProtocolId]);

    useEffect(() => {
        return () => {
            // Persist pending edits instead of dropping them on unmount
            flushPendingSave();
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }
            if (statusTimerRef.current) {
                clearTimeout(statusTimerRef.current);
            }
        };
    }, []);

    // P0-3: a debounced save inside the 350ms window must not be lost to a
    // refresh — block unload while one is pending (refs read at event time).
    useEffect(() => {
        const onBeforeUnload = (e) => {
            if (pendingSaveRef.current || saveTimerRef.current) {
                e.preventDefault();
                e.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, []);

    const showStatus = useCallback((message, durationMs = 0) => {
        if (statusTimerRef.current) {
            clearTimeout(statusTimerRef.current);
            statusTimerRef.current = null;
        }

        setStatusMsg(message);

        if (durationMs > 0) {
            statusTimerRef.current = setTimeout(() => {
                setStatusMsg('');
            }, durationMs);
        }
    }, []);

    const currentProtocol = protocols.find(p => p.id === activeProtocolId) || protocols[0] || null;

    // 批次二 P1-5: 撤销/重做（镜像 useInstructionData P4-1 —— 栈上限 50、
    // 新编辑作废 redo 分支）。声明在 switch effect 之前（依赖数组求值需在位）。
    // 与指令页的差异：协议页是防抖**自动保存** → 撤销也走 commit 链自动落库，
    // 因此**保存不清史**（否则防抖 350ms 落库瞬间历史即被清空，撤销窗口归零）；
    // 仅切协议清史（镜像指令页 activeId 效果）。
    const { push: pushHistory, undo: popUndo, redo: popRedo, clear: clearHistory, canUndo, canRedo } = useHistory(50);
    // A+B：内联展开 + 泳道焦点（对标 useInstructionLanes 的
    // expandedGroupIds/focusedParentId；下钻 pathIds/面包屑退役）
    const [expandedContainerIds, setExpandedContainerIds] = useState([]);
    const [focusedParentId, setFocusedParentId] = useState(null);

    useEffect(() => {
        // Flush first: the dirty payload of the protocol we are leaving must be
        // persisted BEFORE lastPersistedSignatureRef is overwritten below.
        flushPendingSave();

        if (!currentProtocol) {
            setExpandedContainerIds([]);
            setFocusedParentId(null);
            setSelectedId(null);
            lastPersistedSignatureRef.current = '';
            return;
        }

        // 切协议默认全展开 + 焦点回根（镜像 useInstructionLanes:50-53）
        setExpandedContainerIds(collectContainerIds(currentProtocol));
        setFocusedParentId(null);
        setSelectedId(null);
        clearHistory(); // 批次二: 切协议 = 新基线（历史条目按协议 id 存，跨协议不可回）
        lastPersistedSignatureRef.current = serializeProtocol(currentProtocol);
    }, [activeProtocolId, currentProtocol?.id, clearHistory]);

    const currentLanes = useMemo(
        () => buildProtocolLanes(currentProtocol, expandedContainerIds),
        [currentProtocol, expandedContainerIds]
    );
    // 偏移标尺：容器经适配层判组 → 中心 Σ/??、页脚 @范围（指令页同款效果）
    const protocolOffsets = useMemo(
        () => computeProtocolOffsets(currentProtocol),
        [currentProtocol]
    );
    // A4 设计期 Σ 回显 + 容器内容拼接：纯派生注入 computedValue（不落库）——
    // length 卡吃十进制 `${sigma}B`（checksum 不注入）、容器卡吃嵌套内容串
    // （hex 子块字面、未知出等量 ??、空容器不注入）→ 画布 Block.jsx 原样显示。
    // ② 第三参 root = currentProtocol：computeRefsSigma 经 findNode 取目标 type 判槽。
    const displayLanes = useMemo(
        () => injectContainerContent(
            injectRefsSigma(currentLanes, protocolOffsets.byId, currentProtocol),
            protocolOffsets.byId,
            currentProtocol
        ),
        [currentLanes, protocolOffsets, currentProtocol]
    );

    // 焦点自愈（镜像 useInstructionLanes:58-64）：指向已删/非容器 → 清根
    useEffect(() => {
        if (!focusedParentId) return;
        const node = findNode(currentProtocol, focusedParentId);
        if (!node || !isNestable(node.type)) setFocusedParentId(null);
    }, [focusedParentId, currentProtocol]);

    // 选中块从树上消失（结构删除）→ 清选
    useEffect(() => {
        if (selectedId && !findNode(currentProtocol, selectedId)) {
            setSelectedId(null);
        }
    }, [currentProtocol, selectedId]);

    const applyProtocolUpdate = useCallback((nextProtocol) => {
        setProtocols(prev => prev.map(protocol => protocol.id === nextProtocol.id ? nextProtocol : protocol));
    }, [setProtocols]);

    const saveProtocol = useCallback(async (nextProtocol, { forceVersion } = {}) => {
        const nextSignature = serializeProtocol(nextProtocol);

        if (lastPersistedSignatureRef.current === nextSignature) {
            // 已是持久化态：清掉指向它的 pending（失败恢复归还的负载若已由
            // 另一次保存落库，离开拦截不该继续武装）+ 清历史失败横幅。
            if (pendingSaveRef.current === nextProtocol) pendingSaveRef.current = null;
            setSaveError('');
            setSaveConflict(false);
            return nextProtocol;
        }

        // 批次二 P0-4: 结构校验唯一咽喉（防抖保存 / 切协议 flush / 横幅重试
        // 全走这里）——errors 阻断 PUT（后端对 hex 垃圾零校验，fromhex 失败
        // 静默 → 落库即污染错帧），pending 保留（离开拦截武装，beforeunload
        // 继续拦），清单经属性面板常驻 + 点击定位；改好后下一次防抖自然放行
        // （清单同步消失）。warnings 不阻断，保存成功时并入状态栏。
        const { errors, warnings } = validateProtocol(nextProtocol);
        if (errors.length > 0) {
            if (!pendingSaveRef.current) pendingSaveRef.current = nextProtocol;
            showStatus(`保存被阻止：${errors.length} 个结构错误`, 2500);
            return nextProtocol;
        }

        try {
            showStatus('保存中...');
            const saved = await api.updateProtocol(nextProtocol.id, {
                label: nextProtocol.label,
                type: nextProtocol.type,
                description: nextProtocol.description || null,
                children: nextProtocol.children || [],
                // 批次五: 乐观并发 —— 带本地最后见到的 version，后端不符 409。
                // forceVersion = 冲突「强制覆盖」传入的最新值（覆盖本地读取值）；
                // undefined（旧夹具无 version 字段）→ JSON 丢键 → 后端跳过比对。
                version: forceVersion !== undefined ? forceVersion : nextProtocol.version
            });
            lastPersistedSignatureRef.current = serializeProtocol(saved);
            applyProtocolUpdate(saved);
            // 仅当 pending 仍是本次负载才清 —— 防抖窗口内用户继续编辑产生的
            // 更新 payload 不被误清（pending 恒 = 最新未保存负载）。
            if (pendingSaveRef.current === nextProtocol) pendingSaveRef.current = null;
            setSaveError('');
            setSaveConflict(false);
            showStatus(warnings.length > 0
                ? `协议已保存 · ${warnings.length} 提醒`
                : '协议已保存', 1200);
            return saved;
        } catch (error) {
            // 批次一 P0-3 失败恢复：PUT 失败不清脏态 —— 负载归还 pending
            // （flushPendingSave / beforeunload 重新武装），横幅区分
            // 「服务端拒绝」与「网络/服务错误」并透传 detail（handleResponse
            // 已把后端 detail 格式化进 error.message），可重试。
            console.error('Failed to save protocol', error);
            if (!pendingSaveRef.current) pendingSaveRef.current = nextProtocol;
            const status = error?.response?.status;
            // 批次五: 409 单独归类为版本冲突（三分类: 冲突/服务端拒绝/网络），
            // 冲突态挂双动作按钮（原样重试必再 409 = 死路，故不走「重试」）。
            setSaveConflict(status === 409);
            setSaveError(status === 409
                ? `版本冲突（409）：${error.message}`
                : (status === 400 || status === 422)
                    ? `服务端拒绝（${status}）：${error.message}`
                    : `网络/服务错误：${error.message}`);
            showStatus('协议保存失败', 1500);
            throw error;
        }
    }, [applyProtocolUpdate, showStatus]);

    const scheduleProtocolSave = useCallback((nextProtocol) => {
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
        }
        pendingSaveRef.current = nextProtocol; // dirty payload, flushed on switch/unmount

        showStatus('待保存...');
        saveTimerRef.current = setTimeout(() => {
            // 不在触发时清 pending —— 保存 in-flight 期间保留负载（覆盖网络
            // 窗口的刷新拦截），落定后由 saveProtocol 成功/失败分支处置。
            saveTimerRef.current = null;
            saveProtocol(nextProtocol).catch(() => { /* surfaced via saveError banner */ });
        }, 350);
    }, [saveProtocol, showStatus]);

    // ─── 批次五: version 冲突双动作 ────────────────────────────────────────
    // 「强制覆盖」= GET 最新 version 后带本地脏负载重发（saveProtocol 的
    // forceVersion 覆盖本地读取值）；「加载最新」= 放弃本地脏负载、用服务端
    // 版本替换工作副本（签名/历史重置 → 防抖与离开拦截随之解除）。
    // 两个入口都先收横幅：按钮即刻不可点（防双击并发重发），失败由各自
    // 分类重新拉起横幅。
    const handleConflictOverwrite = () => {
        const dirty = pendingSaveRef.current;
        if (!dirty) return;
        setSaveError('');
        setSaveConflict(false);
        showStatus('正在解决冲突...');
        (async () => {
            try {
                const latest = await api.getProtocol(dirty.id);
                await saveProtocol(dirty, { forceVersion: latest.version });
            } catch (error) {
                // PUT 失败 → saveProtocol 内部已分类落横幅（再 409 重新进冲突
                // 态）；只有 GET 阶段的网络失败落到这里手动补横幅。
                if (!error?.response?.status) {
                    setSaveError(`网络/服务错误：${error.message}`);
                    showStatus('冲突处理失败', 1500);
                }
            }
        })();
    };

    const handleConflictLoadLatest = () => {
        const targetId = pendingSaveRef.current?.id || currentProtocol?.id;
        if (!targetId) return;
        setSaveError('');
        setSaveConflict(false);
        showStatus('正在加载最新版本...');
        (async () => {
            try {
                const latest = await api.getProtocol(targetId);
                // 放弃本地：清脏负载 + 撤防抖定时器 → 离开拦截自然解除
                pendingSaveRef.current = null;
                if (saveTimerRef.current) {
                    clearTimeout(saveTimerRef.current);
                    saveTimerRef.current = null;
                }
                lastPersistedSignatureRef.current = serializeProtocol(latest);
                clearHistory(); // 旧历史基于已失效内容，不可回
                applyProtocolUpdate(latest);
                // id 未变 → 泳道切换 effect 不触发（展开/焦点保留），指向已删
                // 节点的选中/焦点由既有自愈 effect 清理。
                showStatus('已加载最新版本', 1500);
            } catch (error) {
                setSaveError(`网络/服务错误：${error.message}`);
                showStatus('加载失败', 1500);
            }
        })();
    };

    const handleAddProtocol = async () => {
        const newProto = {
            id: uuidv4(),
            label: '新协议 (NEW)',
            type: 'container',
            children: []
        };
        try {
            showStatus('创建协议...');
            const created = await api.createProtocol(newProto);
            setProtocols(prev => [...prev, created]);
            setActiveProtocolId(created.id);
            showStatus('协议已创建', 1200);
        } catch (error) {
            console.error('Failed to create protocol', error);
            showStatus(`协议创建失败：${error.message}`, 2500);
        }
    };

    // 批次三 P1-1: 复制协议 —— 镜像 duplicateInstruction（useInstructionData:316）
    // 的流程：payload 纯函数构造（整树新 id + refs 自含重映射 + label `(副本)`
    // 防撞）→ POST 直建 → 追加列表并切到副本。无需 dirty 确认（指令页那问
    // 「放弃未保存？」是因为手动保存语义；协议页防抖自动保存，切协议即 flush
    // pending，没有「放弃」可言）。
    const handleDuplicateProtocol = async (id) => {
        const source = protocols.find(p => p.id === id);
        if (!source) {
            showStatus('复制失败：源协议不存在', 2000);
            return;
        }
        try {
            showStatus('复制协议...');
            const payload = buildDuplicateProtocolPayload(source, protocols, uuidv4);
            const created = await api.createProtocol(payload);
            setProtocols(prev => [...prev, created]);
            setActiveProtocolId(created.id);
            showStatus('协议已复制', 1200);
        } catch (error) {
            console.error('Failed to duplicate protocol', error);
            showStatus(`协议复制失败：${error.message}`, 2500);
        }
    };

    // ===== 批次四 P3-2: 协议 JSON 导出/导入（镜像指令页 importInputRef +
    // 预览确认范式；指令页导出已按反馈移除，协议侧本批保留 —— 备份/迁移
    // 需要）=====
    // 导出 = 当前工作副本原样下盘（含未落库编辑 —— 导出即所见，切协议即
    // flush 已有既有链路兜底落库）。文件形态 {schemaVersion, protocols:[…]}
    // 与 analyzeProtocolImport 的包装入口对称。
    const handleExportProtocol = () => {
        if (!currentProtocol) return;
        // 文件名只剔除路径破坏字符（保留中文 —— [^\w] 口径会把中文标签洗成空）
        const fileLabel = String(currentProtocol.label || '')
            .replace(/[\\/:*?"<>|]+/g, '_').trim() || 'protocol';
        triggerBlobDownload(
            new Blob(
                [JSON.stringify({ schemaVersion: 1, protocols: [currentProtocol] }, null, 2)],
                { type: 'application/json' }
            ),
            `${fileLabel}.protocol.json`
        );
        showStatus('协议已导出', 1500);
    };
    // 导入：parse → analyzeProtocolImport（结构校验 + 全树重生 id + refs
    // 自含重映射 + 撞名「(导入)」升序）→ 预览弹窗 → 顺序 POST → 追加并切
    // 到首个成功项。永不覆盖（全部落新行）。
    const handleImportFileChosen = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = ''; // 允许重复选择同一文件
        if (!file) return;

        let raw;
        try {
            raw = JSON.parse(await file.text());
        } catch (err) {
            showStatus(`文件解析失败：${err?.message || '无效内容'}`, 2500);
            return;
        }

        const report = analyzeProtocolImport(raw, protocols, uuidv4);
        const head = [
            `导入预览：共 ${report.total} 个`,
            `新增 ${report.payloads.length} ／ 校验错误 ${report.errors.length}`,
        ];
        const errorLines = report.errors.slice(0, 5)
            .map(x => `  错误「${x.name}」: ${x.messages[0]}${x.messages.length > 1 ? ` 等 ${x.messages.length} 项` : ''}`);
        if (report.errors.length > 5) errorLines.push(`  …另有 ${report.errors.length - 5} 条错误`);
        setImportPreview({ report, summary: [...head, ...errorLines].join('\n') });
    };

    const handleImportConfirm = async () => {
        const preview = importPreview;
        setImportPreview(null);
        const payloads = preview?.report?.payloads || [];
        if (payloads.length === 0) {
            showStatus('没有可导入的协议', 2500);
            return;
        }
        let firstId = null;
        let ok = 0;
        const failures = [];
        for (const payload of payloads) {
            try {
                const created = await api.createProtocol(payload);
                setProtocols(prev => [...prev, created]);
                if (!firstId) firstId = created.id;
                ok += 1;
            } catch (error) {
                console.error('Failed to import protocol', error);
                failures.push(`「${payload.label}」${error?.message || '未知错误'}`);
            }
        }
        if (firstId) setActiveProtocolId(firstId);
        showStatus(failures.length
            ? `导入完成：成功 ${ok} · 失败 ${failures[0]}`
            : `导入完成：${ok} 个协议`, 2500);
    };

    // 批次一 P0-1: 删除协议前检查编排绑定引用 —— protocol_bindings 是逻辑
    // 外键（无 FK 级联），有引用时弹窗警示"连带清理"，确认后由后端 DELETE
    // 同事务级联删除并返回计数（检查失败降级直接删：后端级联兜底一致性，
    // 仅少一条预警）。
    const [deleteTarget, setDeleteTarget] = useState(null); // { id, label, bindingCount }

    const performDeleteProtocol = async (id) => {
        try {
            showStatus('删除协议...');
            const result = await api.deleteProtocol(id);
            const remaining = protocols.filter(p => p.id !== id);
            setProtocols(prev => prev.filter(protocol => protocol.id !== id));
            if (activeProtocolId === id) setActiveProtocolId(remaining[0]?.id || null);
            const cascade = result?.deleted_bindings > 0
                ? `（连带清理 ${result.deleted_bindings} 条绑定）`
                : '';
            showStatus(`协议已删除${cascade}`, 1500);
        } catch (error) {
            console.error('Failed to delete protocol', error);
            showStatus(`协议删除失败：${error.message}`, 2500);
        }
    };

    const handleDeleteProtocol = async (e, id) => {
        e.stopPropagation();
        if (protocols.length <= 1) {
            showStatus('至少保留一个协议', 1500);
            return;
        }
        let bindingCount = 0;
        try {
            const bindings = await api.getBindings();
            bindingCount = bindings.filter(b => b.protocol_id === id).length;
        } catch (error) {
            console.error('Failed to check protocol bindings', error);
        }
        if (bindingCount > 0) {
            const target = protocols.find(p => p.id === id);
            setDeleteTarget({ id, label: target?.label || id, bindingCount });
            return;
        }
        await performDeleteProtocol(id);
    };

    // ===== 批次二 P1-5: 撤销/重做（自动保存页语义：撤销 = 回旧快照 + 重新
    // 入防抖保存链 → 350ms 后撤销本身也落库；保存**不清**历史，否则防抖
    // 落库瞬间撤销窗口即归零） =====
    const handleUndo = useCallback(() => {
        if (!currentProtocol) return;
        // 当前活快照交 hook 停上 redo 栈，换回最近一个旧快照。
        const prev = popUndo({ id: currentProtocol.id, protocol: currentProtocol });
        if (!prev || prev.id !== currentProtocol.id) return; // 切协议已清史，异协议条目防御性忽略
        applyProtocolUpdate(prev.protocol);
        scheduleProtocolSave(prev.protocol);
        showStatus('已撤销', 800);
    }, [currentProtocol, popUndo, applyProtocolUpdate, scheduleProtocolSave, showStatus]);

    const handleRedo = useCallback(() => {
        if (!currentProtocol) return;
        const next = popRedo({ id: currentProtocol.id, protocol: currentProtocol });
        if (!next || next.id !== currentProtocol.id) return;
        applyProtocolUpdate(next.protocol);
        scheduleProtocolSave(next.protocol);
        showStatus('已重做', 800);
    }, [currentProtocol, popRedo, applyProtocolUpdate, scheduleProtocolSave, showStatus]);

    // Ctrl+Z / Ctrl+Shift+Z —— 输入控件聚焦时或删除弹窗打开时不响应（不劫持
    // 正常文本撤销）。镜像 Instruction.jsx:125-138，modalConfig → deleteTarget。
    useEffect(() => {
        const onHistoryKey = (e) => {
            const t = e.target;
            const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
            if (typing || deleteTarget) return;
            if (!(e.ctrlKey || e.metaKey)) return;
            if (e.key === 'z' || e.key === 'Z') {
                e.preventDefault();
                if (e.shiftKey) handleRedo(); else handleUndo();
            }
        };
        window.addEventListener('keydown', onHistoryKey);
        return () => window.removeEventListener('keydown', onHistoryKey);
    }, [handleUndo, handleRedo, deleteTarget]);

    // ===== 树操作（protocolTree.js 纯函数；commit = 历史入栈 + 乐观更新 + 防抖持久化） =====
    // 批次二 P1-5: 每次用户编辑先把「编辑前」全量快照压入 undo 栈（镜像
    // useInstructionData:254 —— 入旧态，undo 才能回到它）；新编辑由 hook
    // 作废 redo 分支。撤销/重做本身不走此入口（它们已在 hook 内完成栈交换，
    // 再 push 会自噬），只做 apply + schedule —— 自动保存下撤销也即时落库。
    const commitTree = (newRoot) => {
        if (currentProtocol) {
            pushHistory({ id: currentProtocol.id, protocol: currentProtocol });
        }
        applyProtocolUpdate(newRoot);
        scheduleProtocolSave(newRoot);
    };

    const handleAddBlock = (type) => {
        if (!currentProtocol) return;
        // 落点 = 焦点泳道（focusedParentId ?? 根），镜像指令页加块进焦点组
        const parent = focusedParentId ? findNode(currentProtocol, focusedParentId) : currentProtocol;
        if (!parent) return;
        const block = createBlock(type, uuidv4);
        commitTree(updateNode(currentProtocol, parent.id, {
            children: [...(parent.children || []), block]
        }));
        // 新容器立即展开 + 聚焦（镜像 Instruction.jsx:266-271：否则用户往看不见的
        // 折叠泳道里加子块）
        if (isNestable(type)) {
            setExpandedContainerIds(prev => (prev.includes(block.id) ? prev : [...prev, block.id]));
            setFocusedParentId(block.id);
        }
    };

    const handleDeleteBlock = (id) => {
        if (!currentProtocol) return;
        // 树剪枝 = 子树整体移除（对齐指令页 flat 模型手写级联的最终效果）
        commitTree(removeNode(currentProtocol, id));
        if (selectedId === id) setSelectedId(null);
    };

    // 批次三 P1-2: 复制块 —— 镜像 Instruction.handleDuplicateBlock:379-385：
    // 深拷贝插源块之后（子树全新 id、refs 保持指原块 = un-wired 副本），
    // 副本立即选中可编辑；副本是容器则顺手展开（镜像 handleAddBlock 新容器
    // 口径，否则副本是个看不见内容的折叠卡）。
    const handleDuplicateBlock = (id) => {
        if (!currentProtocol) return;
        const result = duplicateNode(currentProtocol, id, uuidv4);
        if (!result) return;
        commitTree(result.root);
        const copy = findNode(result.root, result.copyId);
        if (copy && isNestable(copy.type)) {
            setExpandedContainerIds(prev => Array.from(new Set([...prev, copy.id])));
        }
        setSelectedId(result.copyId);
        showStatus('块已复制', 1000);
    };

    const handleUpdateBlock = (id, updates) => {
        if (!currentProtocol) return;
        commitTree(updateNode(currentProtocol, id, updates));
    };

    // 跨泳道拖拽落点（computeFinalPlacement 已算好 parentId/index）；环/非法
    // 目标 moveNode 原引用早退 → 不持久化（同 moveField 缺源早退口径）
    const handleMoveItem = (itemId, newParentId, newIndex) => {
        if (!currentProtocol) return;
        const next = moveNode(currentProtocol, itemId, newParentId, newIndex);
        if (next !== currentProtocol) commitTree(next);
    };

    // 画布点卡 = 选中 + 容器 toggle 展开。共享 Canvas 对组的双发（select +
    // onNavigateGroup）以 op_code==='ARRAY_GROUP' 为闸，协议容器无 op_code →
    // 在页面层接，零动共享组件。焦点时序对齐指令页：收起时 Canvas 先经
    // onSetFocusedLane 落父泳道（Canvas.jsx:292），展开时这里覆焦到新泳道。
    const handleCanvasSelect = (id) => {
        setSelectedId(id);
        if (!id || !currentProtocol) return;
        const node = findNode(currentProtocol, id);
        if (!node || !isNestable(node.type)) return;
        setExpandedContainerIds(prev => {
            if (prev.includes(id)) return prev.filter(x => x !== id);
            setFocusedParentId(id); // 镜像 handleNavigateGroup:236（updater 内覆焦，幂等）
            return [...prev, id];
        });
    };

    // ENTER = 确保展开 + 聚焦（原"下钻进入"的内联化，属性面板入口保留）
    const handleEnterContainer = (block) => {
        if (!block || !isNestable(block.type)) return;
        setExpandedContainerIds(prev => (prev.includes(block.id) ? prev : [...prev, block.id]));
        setFocusedParentId(block.id);
    };

    // A3 refs 拾取：锚 = 发起 refs 分支的卡（length/checksum）。② 范围修订：
    // slot 可锚（槽长定义期不可知 → 设计期 Σ 不注入维持 ??，发送期
    // blockMerge 填槽改写 refs 为注入块 id 后按真值）；自引用仍拒（面板发起
    // 即锚定当前卡，点锚自身拒绝并给状态栏提示）。toggle 经 onUpdateRefs
    // 回写 parameter_config.refs（handleUpdateBlock → 防抖落库）；
    // 镜像 useSelectionSystem 的中止语义。
    const [pickingMode, setPickingMode] = useState({
        isActive: false, fieldKey: null, anchorId: null, currentRefs: [], onUpdateRefs: null
    });
    const handleStartPicking = (fieldKey, currentRefs, onUpdateRefs) => {
        setPickingMode({ isActive: true, fieldKey, anchorId: selectedId, currentRefs: currentRefs || [], onUpdateRefs });
    };
    const handleStopPicking = () => {
        setPickingMode({ isActive: false, fieldKey: null, anchorId: null, currentRefs: [], onUpdateRefs: null });
    };
    const handlePickBlock = (targetId) => {
        if (!pickingMode.isActive || !currentProtocol) return;
        const target = findNode(currentProtocol, targetId);
        if (!target) return;
        if (targetId === pickingMode.anchorId) {
            showStatus('不能引用自身', 1200);
            return;
        }
        const current = pickingMode.currentRefs || [];
        const next = current.includes(targetId)
            ? current.filter(x => x !== targetId)
            : [...current, targetId];
        setPickingMode(prev => ({ ...prev, currentRefs: next }));
        pickingMode.onUpdateRefs?.(next);
    };
    // 中止闸（镜像 Instruction.jsx:104-112）：切协议 / 改选中 → 取消拾取
    useEffect(() => {
        setPickingMode(prev => (prev.isActive
            ? { isActive: false, fieldKey: null, anchorId: null, currentRefs: [], onUpdateRefs: null }
            : prev));
    }, [activeProtocolId, selectedId]);
    // ESC 不接（焦点在输入时不拦截）：面板 STOP 按钮 + 画布背景点击 onCancelPick 兜底

    const selectedBlock = selectedId ? findNode(currentProtocol, selectedId) : null;

    // 批次二 P0-4: 每次渲染随工作副本全树走一遍（O(n) 小树可忽略）——
    // 清单**实时**反映编辑态：改坏即刻出条目、改好即刻消失，与防抖闸
    // （saveProtocol 内同函数）同源不漂移。镜像 Instruction.jsx:79-82。
    const validation = useMemo(
        () => validateProtocol(currentProtocol),
        [currentProtocol]
    );

    if (!currentProtocol) {
        return (
            <div className="flex-1 flex items-center justify-center text-nier-light/40 font-mono tracking-widest">
                LOADING PROTOCOLS...
            </div>
        );
    }

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            {/* 批次一 P0-3: 保存失败横幅（镜像 Instruction.jsx:549-568）——
                脏态保留、× 只关横幅不清脏态；重试 = flushPendingSave（失败
                时 pendingSaveRef 已归还失败负载，无 pending 则无操作）。
                批次五: 409 版本冲突态换双动作 —— 强制覆盖（GET 最新 version
                重发）/ 加载最新（放弃本地），不给原样重试（必再 409）。 */}
            {saveError && (
                <div className="border-b border-[#E58D28]/60 bg-nier-dark flex items-center gap-3 px-4 py-1.5 text-[11px] font-mono text-[#FFB74D]">
                    <span className="font-bold whitespace-nowrap">保存失败 SAVE FAILED</span>
                    <span className="flex-1 truncate" title={saveError}>{saveError}</span>
                    <span className="opacity-70 whitespace-nowrap">本地更改保留</span>
                    {saveConflict ? (
                        <>
                            <button
                                onClick={handleConflictOverwrite}
                                title="拉取最新版本号后，用本地内容覆盖"
                                className="border border-[#FFB74D]/60 px-1.5 leading-none hover:bg-[#FFB74D] hover:text-black transition-colors"
                            >
                                强制覆盖
                            </button>
                            <button
                                onClick={handleConflictLoadLatest}
                                title="放弃本地更改，加载服务器上的最新版本"
                                className="border border-[#FFB74D]/60 px-1.5 leading-none hover:bg-[#FFB74D] hover:text-black transition-colors"
                            >
                                加载最新
                            </button>
                        </>
                    ) : (
                        <button
                            onClick={flushPendingSave}
                            className="border border-[#FFB74D]/60 px-1.5 leading-none hover:bg-[#FFB74D] hover:text-black transition-colors"
                        >
                            重试
                        </button>
                    )}
                    <button
                        onClick={() => { setSaveError(''); setSaveConflict(false); }}
                        title="关闭横幅（本地更改仍保留）"
                        className="border border-[#FFB74D]/60 px-1.5 leading-none hover:bg-[#FFB74D] hover:text-black transition-colors"
                    >
                        ×
                    </button>
                </div>
            )}

            {/* 批次四 P3-2: 导入文件选择器（镜像 Instruction.jsx:569-575 位置口径） */}
            <input
                ref={importInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleImportFileChosen}
            />

            <div className="flex flex-1 overflow-hidden">
                {statusMsg && (
                    <div className="absolute top-2 right-2 z-50 text-[10px] font-mono bg-nier-dark border border-nier-light px-2 text-nier-light animate-pulse">
                        SYS: {statusMsg}
                    </div>
                )}

                {/* Protocols List Sidebar */}
                <ProtocolListSidebar
                    protocols={protocols}
                    activeProtocolId={activeProtocolId}
                    onSelect={setActiveProtocolId}
                    onAdd={handleAddProtocol}
                    onDuplicate={handleDuplicateProtocol}
                    onDelete={handleDeleteProtocol}
                />

                {/* Palette Sidebar */}
                <aside className="w-14 border-r border-nier-light flex flex-col items-center py-4 gap-4 z-10 bg-nier-dark select-none">
                    {BLOCK_TYPES.map((blockType, index) => (
                        <React.Fragment key={blockType.type}>
                            {index === 1 && <div className="w-8 h-[1px] bg-nier-light/30 my-2"></div>}
                            <button
                                onClick={() => handleAddBlock(blockType.type)}
                                className={`w-10 h-10 border border-nier-light flex flex-col items-center justify-center text-xs hover:bg-nier-light hover:text-nier-dark active:bg-white active:text-black cursor-pointer leading-3${blockType.palette.dashed ? ' border-dashed' : ''}`}
                                title={blockType.palette.title}
                            >
                                {blockType.palette.mainLabel}
                                <span className="scale-[0.6]">{blockType.palette.subLabel}</span>
                            </button>
                        </React.Fragment>
                    ))}
                </aside>

                {/* Canvas Area — A+B: 层级由内联泳道标签/连线表达（指令页同款），
                    面包屑下钻条退役；偏移标尺、焦点泳道、跨容器落点全量接线。
                    批次二 P1-5: 顶栏镜像指令页 h-10 条（左标题点击清选中 +
                    右侧撤销/重做，按钮 disabled 联动 canUndo/canRedo） */}
                <section className="flex-1 relative bg-[url('/grid.png')] bg-repeat opacity-90 overflow-hidden flex flex-col">
                    <div className="h-10 border-b border-nier-light bg-nier-dark/90 flex items-center justify-between px-4 gap-2 text-xs font-mono opacity-50">
                        <div className="flex items-center gap-2 cursor-pointer hover:text-nier-light" onClick={() => setSelectedId(null)}>
                            <span>PROTOCOL EDITOR // {currentProtocol?.label}</span>
                        </div>
                        <div className="flex gap-2 items-center">
                            <button
                                onClick={handleUndo}
                                disabled={!canUndo}
                                title="撤销上一步编辑 (CTRL+Z)"
                                className="border border-nier-light/40 px-1.5 leading-none hover:bg-nier-light hover:text-black disabled:opacity-30 disabled:pointer-events-none transition-colors"
                            >
                                撤销
                            </button>
                            <button
                                onClick={handleRedo}
                                disabled={!canRedo}
                                title="重做 (CTRL+SHIFT+Z)"
                                className="border border-nier-light/40 px-1.5 leading-none hover:bg-nier-light hover:text-black disabled:opacity-30 disabled:pointer-events-none transition-colors"
                            >
                                重做
                            </button>
                            {/* 批次四 P3-2: 导出/导入（镜像指令页顶栏导入按钮位） */}
                            <button
                                onClick={handleExportProtocol}
                                title="导出当前协议为 JSON (EXPORT)"
                                className="border border-nier-light/40 px-1.5 leading-none hover:bg-nier-light hover:text-black transition-colors"
                            >
                                导出
                            </button>
                            <button
                                onClick={() => importInputRef.current && importInputRef.current.click()}
                                title="从 JSON 文件导入协议 (IMPORT)"
                                className="border border-nier-light/40 px-1.5 leading-none hover:bg-nier-light hover:text-black transition-colors"
                            >
                                导入
                            </button>
                        </div>
                    </div>
                    <Canvas
                        lanes={displayLanes}
                        offsets={protocolOffsets.byId}
                        onMoveItem={handleMoveItem}
                        selectedId={selectedId}
                        onSelect={handleCanvasSelect}
                        focusedParentId={focusedParentId}
                        onSetFocusedLane={setFocusedParentId}
                        pickingMode={pickingMode}
                        onPickBlock={handlePickBlock}
                        onCancelPick={handleStopPicking}
                    />
                </section>

                {/* Right Panel (Details) */}
                <ProtocolPropertiesPanel
                    showProtocolLevel={Boolean(activeProtocolId && currentProtocol && !selectedId)}
                    currentProtocol={currentProtocol}
                    selectedBlock={selectedBlock}
                    onProtocolMetaChange={(updatedProto) => {
                        // 批次二: 协议改名/描述同入口入历史（commitTree = 入栈 + 更新 + 防抖）
                        commitTree(updatedProto);
                    }}
                    onEnterContainer={handleEnterContainer}
                    onUpdateBlock={handleUpdateBlock}
                    onDeleteBlock={handleDeleteBlock}
                    onDuplicateBlock={handleDuplicateBlock}
                    pickingMode={pickingMode}
                    onStartPicking={handleStartPicking}
                    onStopPicking={handleStopPicking}
                    validationIssues={validation}
                    onLocateBlock={(id) => {
                        if (!id || !findNode(currentProtocol, id)) return;
                        // 定位 = 只展开目标的容器祖先链（深层块可见，其余折叠态不打扰）+ 选中
                        setExpandedContainerIds(prev => Array.from(new Set([
                            ...prev,
                            ...findAncestors(currentProtocol, id)
                        ])));
                        setSelectedId(id);
                    }}
                />
            </div>

            {/* 批次一 P0-1: 删协议引用警示（仅被绑定引用时打开；确认 → 后端
                DELETE 同事务级联清绑定并返回计数，成功状态栏回显"连带清理 N"） */}
            <NieRModal
                isOpen={Boolean(deleteTarget)}
                message={deleteTarget
                    ? `协议「${deleteTarget.label}」被 ${deleteTarget.bindingCount} 条编排绑定引用，删除将连带清理这些绑定。`
                    : ''}
                onConfirm={async () => {
                    const target = deleteTarget;
                    setDeleteTarget(null);
                    if (target) await performDeleteProtocol(target.id);
                }}
                onCancel={() => setDeleteTarget(null)}
            />

            {/* 批次四 P3-2: 导入预览弹窗（镜像指令页 openConfirm 摘要口径；
                确认 = 顺序 POST，取消 = 丢弃不落库） */}
            <NieRModal
                isOpen={Boolean(importPreview)}
                message={importPreview
                    ? `${importPreview.summary}\n\n确认导入？（不覆盖任何现有协议）`
                    : ''}
                onConfirm={handleImportConfirm}
                onCancel={() => setImportPreview(null)}
            />
        </div>
    );
}
