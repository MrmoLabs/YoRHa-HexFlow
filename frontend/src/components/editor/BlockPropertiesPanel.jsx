import React, { useState, useEffect } from 'react';
import ParamConfigForm from './ParamConfigForm';
import BitFieldEditor from './BitFieldEditor';
import { v4 as uuidv4 } from 'uuid';
import { mapChecksumAlgo } from '../../utils/normalizeInstruction';
import { getBlockLimitRefs, ENCODER_LIMITS } from '../../utils/encoderLimits';
import { padSpec } from '../../utils/padSpec';
import { planOpSwitch, switchableOps, describeOpSwitch } from '../../utils/opSwitch';
import { scrambleParamError } from '../../utils/scramble';

const controlledValue = (value, fallback = '') => (value ?? fallback);

export default function BlockPropertiesPanel({
    selectedBlock,
    currentInstruction, // { id, name, code, device_code, fields }
    operatorTemplates,
    hasUnsavedChanges,
    onUpdateInstruction, // (updatedInst) => void
    onSaveInstruction, // () => void
    onDeleteInstruction, // (e, id) => void
    onDeleteBlock, // (id) => void
    onSaveBlock, // (updatedBlock) => Promise<void> (Handles Auto-Save)
    openConfirm, // (msg, action) => void
    onOpenDatePicker, // (key, val) => void
    // Picking Props
    pickingMode,
    setPickingMode,
    onTempChange, // (tempBlockConfig | null) => void — live canvas preview
    validationIssues, // { errors, warnings } — P0-2 structure validation (page-level)
    onLocateBlock // (blockId) => void — select the offending block on the canvas
}) {
    // Local Edit State
    const [tempBlockConfig, setTempBlockConfig] = useState(null);
    const [hexInputMode, setHexInputMode] = useState('HEX');
    const [showWarnings, setShowWarnings] = useState(false);

    // Live preview: push temp edits upward so the page can mirror them on the
    // selected card in real time (display only — APPLY/SAVE still persists).
    useEffect(() => {
        onTempChange?.(tempBlockConfig);
        // 不列 onTempChange：它是父组件每次渲染重建的回调，列入后 effect 每次渲染都
        // 触发 → 画布预览反复推送；真正需要的触发条件只有 tempBlockConfig 本身。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tempBlockConfig]);

    // Semantic signature of the selected block: detects EXTERNAL changes
    // (cascade ref-scrub after deleting another block, revert/reset, rename
    // formula sync) so the temp editor is rebuilt instead of silently
    // overwriting them on APPLY. Structural fields (sequence/parent_id) are
    // excluded: drags change them but must not discard un-applied edits —
    // handleSaveBlock takes structure from the saved state instead.
    const selectedBlockSignature = selectedBlock
        ? JSON.stringify((({ sequence, parent_id, updatedAt, ...semantic }) => semantic)(selectedBlock))
        : null;

    // Sync with Selection
    useEffect(() => {
        // Abort active ref-picking when the selection changes: the stale
        // onUpdateRefs closure would otherwise write refs into the newly
        // selected block's config (cross-block contamination).
        setPickingMode?.(prev => (prev?.isActive
            ? { isActive: false, fieldKey: null, currentRefs: [], onUpdateRefs: null }
            : prev));
        if (selectedBlock) {
            const initialParams = { ...selectedBlock.parameter_config };
            const opTemplate = operatorTemplates[selectedBlock.op_code];

            // Convert kv_pair_list object to array for stable editing
            if (opTemplate?.param_template?.options === 'kv_pair_list') {
                const pairs = initialParams.options || {};
                const byteLen = selectedBlock.byte_len || 1;

                // STORAGE FORMAT: { "LABEL": "HEX_VAL" }
                // Convert to Array for Editor
                initialParams._kvArray = Object.entries(pairs).map(([k, v]) => {
                    let hexUnpadded = v;
                    if (typeof v === 'number') {
                        hexUnpadded = v.toString(16).toUpperCase();
                    } else if (typeof v === 'string') {
                        hexUnpadded = v.trim();
                    }
                    const padded = (hexUnpadded || "").padStart(byteLen * 2, '0').toUpperCase();
                    return {
                        id: uuidv4(),
                        val: padded, // Value
                        label: k     // Label (Key)
                    };
                });
            }

            // B1: normalize checksum algo to the encoder enum on read, so the
            // select shows a real working value and apply persists the alias.
            if (initialParams.algo !== undefined) {
                initialParams.algo = mapChecksumAlgo(initialParams.algo);
                initialParams.algorithm = initialParams.algo;
            }

            // 选块 → 本地草稿的**单向同步**（属性面板的编辑基准）：草稿必须在
            // 「外部选块变化」这一时机重建，早一步会盖掉正在改的值，晚一步 APPLY 会写穿。
            setTempBlockConfig({
                ...selectedBlock,
                parameter_config: initialParams
            });
        } else {
            setTempBlockConfig(null);
        }
        // deps 只认「外部内容变化」这一件事（语义签名已含 operatorTemplates 变化），
        // 补全 selectedBlock 会让用户每次键入都把未保存的草稿冲掉。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedBlock?.id, selectedBlockSignature]); // Semantic signature: rebuild on EXTERNAL content changes so APPLY cannot overwrite them with a stale copy; structural drags keep dirty edits alive.

    const handleTempUpdate = (updates) => {
        setTempBlockConfig(prev => ({ ...prev, ...updates }));
    };

    // 批 1：录入进制读态（缺省 hex；非法值同样回退 hex —— 与 runnerRenderRules
    // isDecimalEntry 判据镜像）
    // 批 1 + 优化批 1：录入进制三态（hex 缺省 / dec / bin），大小写不敏感、非法回退 hex
    const rawInputBase = String(tempBlockConfig?.parameter_config?.input_base || '').toLowerCase();
    const inputBase = rawInputBase === 'dec' ? 'DEC' : rawInputBase === 'bin' ? 'BIN' : 'HEX';
    const INPUT_BASES = { HEX: 'hex', DEC: 'dec', BIN: 'bin' };
    const INPUT_BASE_TITLES = {
        HEX: '十六进制录入（默认）',
        DEC: '十进制录入',
        BIN: '二进制录入（位模式）'
    };

    const handleTempParamUpdate = (key, val) => {
        setTempBlockConfig(prev => {
            const parameter_config = { ...prev.parameter_config, [key]: val };

            // A1/A2: bit-width params drive byte_len (INT*/FLOAT bits, BCD bytes) —
            // otherwise picking 16/32/64 in the select changes nothing on the wire.
            if (key === 'bits') {
                const bitsNum = Number(val);
                if (Number.isFinite(bitsNum) && bitsNum > 0) {
                    return { ...prev, parameter_config, byte_len: Math.ceil(bitsNum / 8) };
                }
                return { ...prev, parameter_config };
            }
            if (key === 'bytes') {
                const byteNum = Number(val);
                if (Number.isFinite(byteNum) && byteNum > 0) {
                    return { ...prev, parameter_config, byte_len: byteNum };
                }
                return { ...prev, parameter_config };
            }
            // B1: keep parameter_config.algorithm (the key the encoder reads) in sync.
            if (key === 'algo') {
                parameter_config.algorithm = mapChecksumAlgo(val);
            }
            return { ...prev, parameter_config };
        });
    };

    const handleStartPicking = (key, currentRefs) => {
        setPickingMode({
            isActive: true,
            fieldKey: key,
            currentRefs: currentRefs || [],
            onUpdateRefs: (newRefs) => {
                setTempBlockConfig(prev => {
                    if (!prev) return null; // Safety check
                    return {
                        ...prev,
                        parameter_config: { ...prev.parameter_config, [key]: newRefs }
                    };
                });
            }
        });
    };

    const handleStopPicking = () => {
        setPickingMode({
            isActive: false,
            fieldKey: null,
            currentRefs: [],
            onUpdateRefs: null
        });
    };

    // ── N5 (G4): 对齐 / 填充 (ALIGN · PAD_TO) —— 三输入 + 清除 ───────────────
    // 键原样存串（编码期 padSpec 归一，非法 fail-open + 校验 ALIGN_INVALID /
    // PAD_TO_INVALID 提醒）；两支卡片（叶子/组）都可编辑。
    const padRaw = tempBlockConfig?.parameter_config || {};
    const padView = padSpec(padRaw);
    const padKeyed = ['align', 'pad_to', 'pad_byte'].some(
        (k) => padRaw[k] !== undefined && padRaw[k] !== null && String(padRaw[k]).trim() !== ''
    );
    const applyPad = (mutate) => {
        setTempBlockConfig(prev => {
            if (!prev) return null;
            const pc = { ...prev.parameter_config };
            mutate(pc);
            return { ...prev, parameter_config: pc };
        });
    };
    const clearPad = () => applyPad(pc => {
        delete pc.align;
        delete pc.pad_to;
        delete pc.pad_byte;
    });
    const padPart = (raw, n, okText) => {
        if (n) return okText(n);
        if (raw === undefined || raw === null || String(raw).trim() === '') return null;
        return `${raw}（无效→忽略）`;
    };
    const padSummary = !padKeyed
        ? '未配置 → 不补位（线上字节 = 内容字节）'
        : [
            padPart(padRaw.align, padView.align, (n) => `起始偏移对齐 ${n} 字节边界`),
            padPart(padRaw.pad_to, padView.padTo, (n) => `内容末尾补到 ${n} 字节边界`),
            (padRaw.pad_byte !== undefined && padRaw.pad_byte !== null && String(padRaw.pad_byte).trim() !== '')
                ? `填充字节 ${String(padRaw.pad_byte).trim().toUpperCase()}` : null,
        ].filter(Boolean).join(' · ');

    // ── N3 (G1): 条件存在 (PRESENCE) —— 单 ref 拾取 + expect + 清除 ────────
    const presenceCfg = tempBlockConfig?.parameter_config?.presence;
    const presencePicking = pickingMode?.isActive && pickingMode?.fieldKey === 'presence_ref';

    // presence 合并写入：cur 被 mutate 后，ref 与 expect 双空 → 摘键
    // （半成品配置保留：fail-open 编码 + W PRESENCE_INCOMPLETE 提醒核对）。
    const applyPresence = (mutate) => {
        setTempBlockConfig(prev => {
            if (!prev) return null;
            const pc = { ...prev.parameter_config };
            const cur = (pc.presence && typeof pc.presence === 'object' && !Array.isArray(pc.presence))
                ? { ...pc.presence } : {};
            mutate(cur);
            const noRef = cur.ref_id === undefined || cur.ref_id === null || String(cur.ref_id) === '';
            const noExpect = cur.expect === undefined || cur.expect === null || String(cur.expect) === '';
            if (noRef && noExpect) delete pc.presence;
            else pc.presence = cur;
            return { ...prev, parameter_config: pc };
        });
    };

    const handleTempPresenceUpdate = (updates) => applyPresence(cur => Object.assign(cur, updates));

    const handleStartPresencePicking = () => {
        const curRef = presenceCfg && typeof presenceCfg === 'object' ? presenceCfg.ref_id : null;
        setPickingMode({
            isActive: true,
            fieldKey: 'presence_ref',
            currentRefs: curRef ? [curRef] : [],
            onUpdateRefs: (newRefs) => {
                // 单值语义：追加列表的最后一项成为唯一 ref（空 = 摘除）——
                // handlePickBlock 的 toggle 追加语义在此归一为单 ref。
                const chosen = Array.isArray(newRefs) && newRefs.length > 0
                    ? newRefs[newRefs.length - 1] : null;
                applyPresence(cur => {
                    if (chosen) cur.ref_id = chosen;
                    else delete cur.ref_id;
                });
                // 单 ref 不变量：currentRefs 收敛为 [chosen]（防第二块残留）
                setPickingMode(prev => (prev && prev.fieldKey === 'presence_ref'
                    ? { ...prev, currentRefs: chosen ? [chosen] : [] } : prev));
            }
        });
    };

    const handleClearPresence = () => {
        setTempBlockConfig(prev => {
            if (!prev) return null;
            const pc = { ...prev.parameter_config };
            delete pc.presence;
            return { ...prev, parameter_config: pc };
        });
        if (presencePicking) handleStopPicking();
    };

    // ── R24 (§8.52 挂账 ③): 创建后切换算子 —— 兼容校验 + 确认回执 ───────────
    // 属性面板的 op_code 原本是只读 span（改算子只能删建重录）。现在是下拉：
    // ① 受控下拉**先回弹**（新对象 → 必定重渲染 → value 归位），确认后才真正切换 ——
    //    取消 = 草稿一字未动，不会出现「下拉显示新算子、草稿还是旧算子」的假态；
    // ② 组 → 叶且带子块直接拦（BE 保存侧同位 400，改一必改二）；
    // ③ 回执列出保留 / 清除 / 位宽 / 字节长度，先看后按。
    const opOptions = switchableOps(operatorTemplates, tempBlockConfig?.op_code);

    const handleOpChange = (e) => {
        const nextOp = e.target.value;
        const fields = currentInstruction?.fields || [];
        const childCount = fields.filter(f => (f.parent_id || null) === selectedBlock.id).length;
        const plan = planOpSwitch(tempBlockConfig, nextOp, { childCount, templates: operatorTemplates });

        setTempBlockConfig(prev => (prev ? { ...prev } : prev)); // ① 先回弹受控下拉
        if (!plan.ok) {
            openConfirm(`无法切换算子：\n${plan.message}`, () => {});
            return;
        }
        if (plan.code === 'SAME_OP') return;
        openConfirm(describeOpSwitch(plan), () => setTempBlockConfig(plan.next));
    };

    const handleApply = () => {
        if (!tempBlockConfig) return;
        const opTemplate = operatorTemplates[tempBlockConfig.op_code];

        // 0. R25 (§8.57): SCRAMBLE 加扰参数 —— 生效模式的参数非法会让出线落进「恒等」
        //    fail-open（发成功但没加扰 = 静默错码）→ 拒绝 APPLY（页面级 error 列表同源
        //    一并拦保存，这里是就近反馈）。
        if (tempBlockConfig.op_code === 'SCRAMBLE') {
            const reason = scrambleParamError(tempBlockConfig.parameter_config || {});
            if (reason) {
                openConfirm(`校验错误：\n${reason}`, () => { });
                return;
            }
        }

        // 1. HEX_RAW Validation（R25 起 SCRAMBLE 明文同规则：长度 = byte_len×2）
        if (['HEX_RAW', 'SCRAMBLE'].includes(tempBlockConfig.op_code)) {
            const byteLen = tempBlockConfig.byte_len || 1;
            const hexVal = (tempBlockConfig.parameter_config?.hex || "").replace(/\s/g, '');
            if (hexVal.length !== byteLen * 2) {
                openConfirm(`校验错误：\n需要 ${byteLen} 字节 (${byteLen * 2} 字符)。\n当前 ${hexVal.length} 字符。`, () => { });
                return;
            }
            const updatedBlock = {
                ...tempBlockConfig,
                parameter_config: { ...tempBlockConfig.parameter_config, hex: hexVal }
            };
            onSaveBlock(updatedBlock);
        }
        // 2. Enum Mapping Validation
        else if (opTemplate?.param_template?.options === 'kv_pair_list') {
            const kvArray = tempBlockConfig.parameter_config?._kvArray || [];
            const byteLen = tempBlockConfig.byte_len || 1;
            const newOptions = {};

            for (const item of kvArray) {
                if (!item.label || !item.label.trim()) continue;
                const label = item.label.trim();
                if (newOptions[label]) {
                    openConfirm(`校验错误：\n重复标签 "${label}"。标签必须唯一。`, () => { });
                    return;
                }
                if (!item.val) {
                    openConfirm(`校验错误：\n标签 "${label}" 没有值。`, () => { });
                    return;
                }
                const hexStr = item.val.trim();
                // Strict Hex Check
                if (!/^[0-9A-Fa-f]+$/.test(hexStr)) {
                    openConfirm(`校验错误：\n值 "${item.val}" 必须是有效的十六进制字符串。`, () => { });
                    return;
                }
                if (hexStr.length !== byteLen * 2) {
                    openConfirm(`校验错误：\n值 "${hexStr}" 有 ${hexStr.length} 字符。\n需要 ${byteLen * 2} 字符。`, () => { });
                    return;
                }
                newOptions[label] = hexStr.toUpperCase();
            }

            const finalParams = { ...tempBlockConfig.parameter_config, options: newOptions };
            delete finalParams._kvArray;

            const updatedBlock = {
                ...tempBlockConfig,
                parameter_config: finalParams
            };
            onSaveBlock(updatedBlock);
        }
        // 3. Default
        else {
            onSaveBlock(tempBlockConfig);
        }
    };


    const blockLimitRefs = tempBlockConfig ? getBlockLimitRefs(tempBlockConfig) : [];

    return (
        <aside className="w-80 shrink-0 border-l border-nier-light bg-nier-dark/95 p-4 flex flex-col z-20 shadow-[-5px_0_15px_rgba(0,0,0,0.5)] overflow-y-auto">
            <h2 className="text-lg border-b-2 border-nier-light mb-6 pb-1 font-bold tracking-wider">属性配置 (PROPERTIES)</h2>

            {currentInstruction && !selectedBlock && (
                <div className="space-y-6 text-sm">
                    {/* P0-2: structural validation issue list — placed FIRST so a
                        blocked save is visible without scrolling. Errors use a red
                        container + solid chips; body text stays bright (high contrast). */}
                    {validationIssues && (validationIssues.errors.length > 0 || validationIssues.warnings.length > 0) && (
                        <div className={`p-2 space-y-1 border ${validationIssues.errors.length > 0 ? 'border-[#D94834] bg-[#D94834]/15' : 'border-[#E58D28] bg-[#E58D28]/10'}`}>
                            <div className="flex flex-wrap gap-2 items-baseline mb-1">
                                {validationIssues.errors.length > 0 && (
                                    <span className="bg-[#D94834] text-nier-light font-bold uppercase tracking-widest px-1 py-0.5 text-[10px]">
                                        ⛔ {validationIssues.errors.length} 结构错误
                                    </span>
                                )}
                                <span className="bg-[#E58D28] text-nier-dark font-bold uppercase tracking-widest px-1 py-0.5 text-[10px]">
                                    ⚠ {validationIssues.warnings.length} 提醒
                                </span>
                                {validationIssues.errors.length === 0 && (
                                    <span className="text-[10px] text-muted">（不阻断保存）</span>
                                )}
                            </div>
                            {validationIssues.errors.slice(0, 8).map((err, i) => (
                                <button
                                    key={`err-${i}`}
                                    type="button"
                                    onClick={() => err.blockId && onLocateBlock?.(err.blockId)}
                                    className="block w-full text-left text-[11px] font-bold text-nier-light hover:text-warn hover:underline truncate"
                                >
                                    ⛔ {err.message}
                                </button>
                            ))}
                            {validationIssues.warnings.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setShowWarnings(v => !v)}
                                    className="text-[10px] font-bold text-warn underline"
                                >
                                    {showWarnings ? '收起提醒' : `展开提醒 (${validationIssues.warnings.length})`}
                                </button>
                            )}
                            {showWarnings && validationIssues.warnings.slice(0, 20).map((warn, i) => (
                                <button
                                    key={`warn-${i}`}
                                    type="button"
                                    onClick={() => warn.blockId && onLocateBlock?.(warn.blockId)}
                                    className="block w-full text-left text-[10px] text-nier-light hover:text-warn truncate"
                                >
                                    ⚠ {warn.message}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Instruction Meta */}
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">设备前缀 (Device)</label>
                        <input type="text" value={currentInstruction.device_code || ''} onChange={(e) => onUpdateInstruction({ ...currentInstruction, device_code: e.target.value })} className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide" />
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">指令代号 (Code)</label>
                        <input type="text" value={currentInstruction.code || ''} onChange={(e) => onUpdateInstruction({ ...currentInstruction, code: e.target.value })} className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide" />
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">指令名称 (Name)</label>
                        <input type="text" value={controlledValue(currentInstruction.name ?? currentInstruction.label, '')} onChange={(e) => onUpdateInstruction({ ...currentInstruction, name: e.target.value })} className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide" />
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">指令类型 (Type)</label>
                        <select
                            value={currentInstruction.type || 'STATIC'}
                            onChange={(e) => onUpdateInstruction({ ...currentInstruction, type: e.target.value })}
                            className="bg-nier-dark border border-nier-light/50 text-nier-light text-xs p-1 focus:outline-none"
                        >
                            <option value="STATIC" className="bg-nier-dark text-nier-light">静态 (STATIC)</option>
                            <option value="DYNAMIC" className="bg-nier-dark text-nier-light">动态 (DYNAMIC)</option>
                        </select>
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">说明 (Description)</label>
                        <textarea
                            rows={2}
                            value={currentInstruction.description || ''}
                            onChange={(e) => onUpdateInstruction({ ...currentInstruction, description: e.target.value })}
                            className="bg-transparent border border-nier-light/30 focus:border-nier-light focus:outline-none p-1 font-mono text-xs tracking-wide resize-none"
                        />
                    </div>

                    {/* Instruction Actions */}
                    <div className="pt-4 flex flex-col gap-3 border-t border-nier-light/20">
                        {hasUnsavedChanges && (
                            <button onClick={onSaveInstruction} className="w-full bg-nier-light/10 border border-nier-light text-nier-light hover:bg-nier-light hover:text-black py-2 px-4 uppercase text-xs tracking-widest transition-colors font-bold">
                                保存更改 (SAVE)
                            </button>
                        )}
                        <button onClick={(e) => onDeleteInstruction(e, currentInstruction.id)} className="w-full border border-red-500/50 text-warn hover:bg-red-500 hover:text-black py-2 px-4 uppercase text-xs tracking-widest transition-colors">
                            删除指令 (DELETE)
                        </button>
                    </div>
                </div>
            )}

            {selectedBlock && tempBlockConfig && (
                <div className="space-y-5 text-sm animate-in fade-in slide-in-from-right-4 duration-300">
                    <div className="text-[10px] opacity-40 font-mono flex justify-between">
                        <span>{selectedBlock.id}</span>
                        <span className="text-nier-light">{tempBlockConfig.op_code}</span>
                    </div>

                    {/* R24 (§8.52 挂账 ③): 算子下拉（原只读 span）—— 切换走 handleOpChange
                        的兼容校验 + 确认回执；选项 = 有算子模板的 OP_CODES（与调色板同源，
                        当前算子恒列第一，存量字段不会渲染成空下拉）。 */}
                    <div className="flex flex-col gap-1">
                        <label htmlFor="block-op-switch" className="text-xs opacity-70 uppercase tracking-widest">算子 (Operator)</label>
                        <select
                            id="block-op-switch"
                            value={tempBlockConfig.op_code}
                            onChange={handleOpChange}
                            className="bg-nier-dark border border-nier-light/30 text-xs p-1 text-nier-light focus:border-nier-light focus:outline-none"
                        >
                            {opOptions.map(op => (
                                <option key={op} value={op} className="bg-nier-dark text-nier-light">{op}</option>
                            ))}
                        </select>
                    </div>

                    {/* P0-1: block-level encoder-limit banner (B2–B8, display-only configs) */}
                    {blockLimitRefs.length > 0 && (
                        <div className="border border-[#E58D28] bg-[#E58D28]/10 p-2 text-[10px] leading-relaxed">
                            <div className="inline-block bg-[#E58D28] text-nier-dark font-bold uppercase tracking-widest px-1 mb-1">⚠ 编码器限制（仅记录配置，不参与编码）</div>
                            {blockLimitRefs.map(ref => (
                                <div key={ref} className="text-nier-light"><span className="font-bold text-hl">[{ref}]</span> {ENCODER_LIMITS[ref]}</div>
                            ))}
                        </div>
                    )}

                    {/* P0-2: compact error strip while a block is selected */}
                    {validationIssues?.errors.length > 0 && (
                        <div className="border border-[#D94834] bg-[#D94834]/15 p-2 text-[11px] font-bold text-nier-light">
                            ⛔ {validationIssues.errors.length} 个结构错误 — 点击画布空白处查看清单
                        </div>
                    )}

                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">字段标签 (Label)</label>
                        <input type="text" value={controlledValue(tempBlockConfig.name ?? tempBlockConfig.label, '')} onChange={(e) => handleTempUpdate({ name: e.target.value })} className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide" />
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">字节长度 (Length)</label>
                        <input type="number" min="0" value={controlledValue(tempBlockConfig.byte_len ?? tempBlockConfig.byte_length, 0)} onChange={e => handleTempUpdate({ byte_len: parseInt(e.target.value) || 0 })} className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono" />
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-xs opacity-70 uppercase tracking-widest">字节序 (Endian)</label>
                        <select
                            value={controlledValue(tempBlockConfig.endianness, 'BIG')}
                            onChange={e => handleTempUpdate({ endianness: e.target.value })}
                            className="bg-nier-dark border border-nier-light/50 text-nier-light text-xs p-1 focus:outline-none"
                        >
                            <option value="BIG" className="bg-nier-dark text-nier-light">大端 (BIG)</option>
                            <option value="LITTLE" className="bg-nier-dark text-nier-light">小端 (LITTLE)</option>
                        </select>
                    </div>

                    {/* Dynamic Params */}
                    <div className="p-3 border border-white/10 bg-white/5 space-y-3">
                        <div className="text-[9px] opacity-50 border-b border-white/10 pb-1 mb-2">配置参数 (CONFIG)</div>
                        {/* 批 1：录入进制（字段级）—— 存 parameter_config.input_base。
                            加工页据此把定长整数字段切到十进制通道；纯 UI 层，编码端口径不变。
                            HEX_RAW（固定值）/SCRAMBLE（明文同为固定值，只读回显）/
                            BITFIELD（打包值）不适用 → 不渲染。 */}
                        {selectedBlock.op_code !== 'HEX_RAW' && selectedBlock.op_code !== 'SCRAMBLE' && selectedBlock.op_code !== 'BITFIELD' && (
                            <div className="flex flex-col gap-1">
                                <label
                                    className="text-[10px] opacity-70 uppercase tracking-widest"
                                    title="INPUT_BASE // 加工页录入与回显进制；值存储恒为数值，编码端按定长字节输出十六进制"
                                >
                                    录入进制 (INPUT BASE)
                                </label>
                                <div className="flex text-[10px] gap-1 border border-nier-light/30 p-0.5 bg-black w-fit">
                                    {['HEX', 'DEC', 'BIN'].map(m => (
                                        <button
                                            key={m}
                                            type="button"
                                            title={INPUT_BASE_TITLES[m]}
                                            onClick={() => handleTempParamUpdate('input_base', INPUT_BASES[m])}
                                            className={`px-2 py-0.5 transition-all font-bold ${inputBase === m ? 'bg-nier-light text-black' : 'text-nier-light hover:bg-nier-light/20'}`}
                                        >
                                            {m}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        {selectedBlock.op_code !== 'HEX_RAW' && selectedBlock.op_code !== 'BITFIELD' && (
                            <ParamConfigForm
                                blockState={tempBlockConfig}
                                instructionFields={currentInstruction.fields}
                                operatorTemplates={operatorTemplates}
                                onUpdateParam={handleTempParamUpdate}
                                hexInputMode={hexInputMode}
                                setHexInputMode={setHexInputMode}
                                onOpenDatePicker={onOpenDatePicker}
                                onStartPicking={handleStartPicking}
                                onStopPicking={handleStopPicking}
                                pickingMode={pickingMode}
                            />
                        )}

                        {/* BITFIELD: Dedicated bit layout editor */}
                        {selectedBlock.op_code === 'BITFIELD' && (
                            <BitFieldEditor
                                bits={tempBlockConfig.bits || []}
                                byteLen={tempBlockConfig.byte_len || 0}
                                onUpdateBits={(nextBits) => handleTempUpdate({ bits: nextBits })}
                            />
                        )}

                        {/* HEX_RAW / R25 SCRAMBLE 明文 Input (Manual) - Multi Format
                            SCRAMBLE 的框内是**明文**（出线前经 mode 加扰，线上字节看卡面） */}
                        {['HEX_RAW', 'SCRAMBLE'].includes(selectedBlock.op_code) && (
                            <div className="flex flex-col gap-2">
                                <div className="flex justify-between items-end">
                                    <label className="text-[10px] opacity-70 uppercase tracking-widest">{selectedBlock.op_code === 'SCRAMBLE' ? 'PLAINTEXT' : 'VALUE'} ({hexInputMode})</label>
                                    <div className="flex text-[10px] gap-1 border border-nier-light/30 p-0.5 bg-black">
                                        {['HEX', 'DEC', 'BIN'].map(m => (
                                            <button
                                                key={m}
                                                onClick={() => setHexInputMode(m)}
                                                className={`px-2 py-0.5 transition-all ${hexInputMode === m ? 'bg-nier-light text-black font-bold' : 'text-nier-light hover:bg-nier-light/20'}`}
                                            >
                                                {m}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <input
                                    type="text"
                                    value={(() => {
                                        const rawHex = tempBlockConfig.parameter_config?.hex || "00";
                                        if (!rawHex) return "";
                                        const val = parseInt(rawHex, 16);
                                        if (isNaN(val)) return rawHex;
                                        if (hexInputMode === 'DEC') return val.toString(10);
                                        if (hexInputMode === 'BIN') return val.toString(2).padStart(rawHex.length * 4, '0');
                                        return rawHex.toUpperCase();
                                    })()}
                                    onChange={(e) => {
                                        const input = e.target.value;
                                        let newHex = "";
                                        try {
                                            if (input === "") newHex = "";
                                            else if (hexInputMode === 'DEC') {
                                                const d = parseInt(input, 10);
                                                if (!isNaN(d)) newHex = d.toString(16).toUpperCase();
                                            } else if (hexInputMode === 'BIN') {
                                                const b = parseInt(input, 2);
                                                if (!isNaN(b)) newHex = b.toString(16).toUpperCase();
                                            } else {
                                                newHex = input.toUpperCase().replace(/[^0-9A-F]/g, '');
                                            }
                                            handleTempUpdate({ parameter_config: { ...tempBlockConfig.parameter_config, hex: newHex } });
                                        } catch { /* 非法 hex → 忽略，输入框保持原值 */ }
                                    }}
                                    className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide"
                                />
                                <div className="text-[9px] opacity-30 text-right">
                                    STORED: {tempBlockConfig.parameter_config?.hex || "00"}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Repeat Strategy */}
                    {(selectedBlock.op_code === 'ARRAY_GROUP' || selectedBlock.op_code === 'STRUCT') && (
                        <div className="p-3 border border-dashed border-nier-light/50 space-y-3">
                            <div className="text-[9px] opacity-100 font-bold text-nier-light flex items-center gap-2">
                                重复策略 (REPEAT)
                            </div>
                            <select
                                value={controlledValue(tempBlockConfig.repeat_type, 'NONE')}
                                onChange={e => handleTempUpdate({ repeat_type: e.target.value })}
                                className="w-full bg-nier-dark border border-nier-light/50 text-nier-light text-xs p-1 focus:outline-none"
                            >
                                <option value="NONE" className="bg-nier-dark text-nier-light">无重复 (Single)</option>
                                <option value="FIXED" className="bg-nier-dark text-nier-light">固定次数 (Fixed)</option>
                                <option value="DYNAMIC" className="bg-nier-dark text-nier-light">动态引用 (Dynamic Ref)</option>
                            </select>

                            {tempBlockConfig.repeat_type === 'FIXED' && (
                                <div className="flex flex-col gap-1">
                                    <label className="text-[9px]">次数 (COUNT)</label>
                                    <input type="number" value={controlledValue(tempBlockConfig.repeat_count, 1)} onChange={e => handleTempUpdate({ repeat_count: parseInt(e.target.value) })} className="bg-transparent border-b border-white/30 text-xs" />
                                </div>
                            )}
                            {tempBlockConfig.repeat_type === 'DYNAMIC' && (
                                <div className="flex flex-col gap-1">
                                    <label className="text-[9px]">关联字段 (REF ID)</label>
                                    <select
                                        value={tempBlockConfig.repeat_ref_id || ''}
                                        onChange={e => handleTempUpdate({ repeat_ref_id: e.target.value })}
                                        className="w-full bg-nier-dark border border-nier-light/50 text-nier-light text-xs p-1 focus:outline-none"
                                    >
                                        <option value="" className="bg-nier-dark text-nier-light">-- SELECT REF --</option>
                                        {currentInstruction.fields.filter(b => b.id !== selectedBlock.id).map(b => (
                                            <option key={b.id} value={b.id} className="bg-nier-dark text-nier-light">{b.name} ({b.sequence})</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>
                    )}

                    {/* N5 (G4): 对齐 / 填充 (ALIGN · PAD_TO) —— 独立区：align /
                        pad_to / pad_byte 三输入 + 清除；APPLY 往返落块配置。
                        归一/非法判定由 padSpec + 校验提醒承担（fail-open 不阻断）。 */}
                    <div className="p-3 border border-dashed border-nier-light/50 space-y-3" data-testid="align-section">
                        <div className="text-[9px] opacity-100 font-bold text-nier-light flex items-center gap-2">
                            对齐 / 填充 (ALIGN · PAD_TO)
                        </div>
                        <div className="text-[9px] opacity-60 leading-relaxed" data-testid="align-summary">
                            {padSummary}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                            <label className="text-[9px] opacity-70 space-y-1">
                                <div>起始对齐 (align)</div>
                                <input
                                    data-testid="align-input"
                                    type="text"
                                    value={controlledValue(padRaw.align)}
                                    placeholder="8"
                                    onChange={(e) => applyPad(pc => { pc.align = e.target.value; })}
                                    className="w-full bg-transparent border border-nier-light/50 px-1 py-1 text-[10px] font-mono text-nier-light focus:border-nier-accent focus:outline-none"
                                />
                            </label>
                            <label className="text-[9px] opacity-70 space-y-1">
                                <div>结束补位 (pad_to)</div>
                                <input
                                    data-testid="padto-input"
                                    type="text"
                                    value={controlledValue(padRaw.pad_to)}
                                    placeholder="8"
                                    onChange={(e) => applyPad(pc => { pc.pad_to = e.target.value; })}
                                    className="w-full bg-transparent border border-nier-light/50 px-1 py-1 text-[10px] font-mono text-nier-light focus:border-nier-accent focus:outline-none"
                                />
                            </label>
                            <label className="text-[9px] opacity-70 space-y-1">
                                <div>填充字节 (pad_byte)</div>
                                <input
                                    data-testid="padbyte-input"
                                    type="text"
                                    value={controlledValue(padRaw.pad_byte)}
                                    placeholder="00"
                                    onChange={(e) => applyPad(pc => { pc.pad_byte = e.target.value; })}
                                    className="w-full bg-transparent border border-nier-light/50 px-1 py-1 text-[10px] font-mono text-nier-light focus:border-nier-accent focus:outline-none"
                                />
                            </label>
                        </div>
                        <button
                            data-testid="align-clear"
                            onClick={clearPad}
                            className="w-full border border-nier-light/40 text-[9px] py-1 uppercase tracking-widest opacity-70 hover:opacity-100 transition-opacity"
                        >
                            清除对齐/填充 (CLEAR)
                        </button>
                    </div>

                    {/* N3 (G1): 条件存在 (PRESENCE) —— 尾部独立区：ref 拾取 +
                        expect 文本 + 清除（编码 fail-open，两支卡片都可编辑） */}
                    <div className="p-3 border border-dashed border-nier-light/50 space-y-3" data-testid="presence-section">
                        <div className="text-[9px] opacity-100 font-bold text-nier-light flex items-center gap-2">
                            条件存在 (PRESENCE)
                        </div>
                        <div className="text-[9px] opacity-60 leading-relaxed" data-testid="presence-summary">
                            {(presenceCfg && typeof presenceCfg === 'object' && !Array.isArray(presenceCfg) && presenceCfg.ref_id)
                                ? <>仅当 <span className="font-mono">[{String(presenceCfg.ref_id)}]</span> == <span className="font-mono">{presenceCfg.expect !== undefined && presenceCfg.expect !== null ? String(presenceCfg.expect) : '?'}</span> 时发射本块（含子树）</>
                                : '未配置 → 始终发射（fail-open：不完整配置同样发射）'}
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[9px]">条件字段 (REF)</label>
                            <button
                                type="button"
                                data-testid="presence-pick"
                                onClick={presencePicking ? handleStopPicking : handleStartPresencePicking}
                                className={`text-[9px] py-1 px-2 border transition-colors ${presencePicking
                                    ? 'bg-[#E58D28] text-black border-[#E58D28]'
                                    : 'border-nier-light/50 text-nier-light hover:bg-nier-light hover:text-black'}`}
                            >
                                {presencePicking ? '停止拾取 (STOP)' : '拾取条件字段 (PICK)'}
                            </button>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[9px]">期望值 (EXPECT)</label>
                            <input
                                type="text"
                                data-testid="presence-expect"
                                value={presenceCfg && presenceCfg.expect !== undefined && presenceCfg.expect !== null ? String(presenceCfg.expect) : ''}
                                onChange={e => handleTempPresenceUpdate({ expect: e.target.value })}
                                placeholder="命中时发射（如 1 / A）"
                                className="bg-transparent border-b border-white/30 text-xs"
                            />
                        </div>
                        <button
                            type="button"
                            data-testid="presence-clear"
                            onClick={handleClearPresence}
                            className="w-full border border-red-500/40 text-warn/90 hover:bg-red-500 hover:text-black py-1 text-[9px] uppercase tracking-widest transition-colors"
                        >
                            清除条件 (CLEAR)
                        </button>
                    </div>

                    <div className="pt-4 border-t border-nier-light/20 flex flex-col gap-3">
                        <button onClick={handleApply} className="w-full bg-nier-light/20 border border-nier-light text-nier-light hover:bg-nier-light hover:text-black py-2 px-4 uppercase text-xs tracking-widest transition-colors font-bold">
                            应用配置 (APPLY)
                        </button>
                        <button onClick={() => onDeleteBlock(selectedBlock.id)} className="w-full border border-red-500/50 text-warn hover:bg-red-500 hover:text-black py-2 px-4 uppercase text-xs tracking-widest transition-colors">
                            删除 (DELETE)
                        </button>
                    </div>
                </div>
            )}
        </aside>
    );
}
