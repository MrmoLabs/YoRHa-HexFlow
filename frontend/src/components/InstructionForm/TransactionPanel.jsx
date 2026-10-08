import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import DecodedFields from './DecodedFields';
import { InstructionDecoder } from '../../utils/InstructionDecoder';
import {
    attemptLabel,
    defaultSpec,
    formatIgnoreRanges,
    parseIgnoreRanges,
    rttText,
    specSourceLabel,
    summaryLine
} from '../../utils/transactionView';

// P2 事务发送面板：应答规格编辑（按指令持久化 → /response-specs）+ 事务发送
//（POST /dispatch/transaction：超时/重发/间隔、广播无应答、逐次 attempt + RTT 统计）。
// 自包含直连 api（同 InstructionRunner 直连 export 的先例）；props 只吃 instruction + 当前帧。
// R9（PLAN §8.46）：命中应答按指令字段布局**逆向解码**成「字段 = 值」（C-2 选 B），
// 展示用、不入库（入库回写 = R10）。

const DEFAULT_SETTINGS = { timeoutMs: '500', retries: '2', intervalMs: '50', broadcast: false };

const inputClass =
    'bg-nier-dark/40 border border-nier-light/20 px-2 py-1 font-mono text-[10px] text-nier-light '
    + 'focus:outline-none focus:border-nier-light/60 transition-colors duration-100 disabled:opacity-40';
const labelClass = 'block text-[9px] font-mono text-nier-light/40 uppercase tracking-[0.2em] mb-1';

// 数字输入回填：非法/清空 → 下限（UI 不拦输入过程，落库与发送由后端 400 兜底 SSOT）
const clampInt = (raw, lo, hi) => {
    const n = Number(raw);
    if (!Number.isInteger(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
};

const toIntOr = (raw, fallback) => {
    const n = Number(raw);
    return Number.isInteger(n) ? n : fallback;
};

const toggleButtonClass = (on) => (
    on
        ? 'border-nier-light bg-nier-light text-nier-dark'
        : 'border-nier-light/20 text-nier-light/50 hover:border-nier-light/60 hover:text-nier-light'
);

export default function TransactionPanel({ instruction, payload, wrap = null }) {
    const instructionId = instruction?.id || null;
    const [spec, setSpec] = useState(defaultSpec());
    const [rangesText, setRangesText] = useState('');
    const [specDirty, setSpecDirty] = useState(false);
    const [specOpen, setSpecOpen] = useState(false);
    // CP3 3d (D7-A): 规格失效徽标 —— GET 回执的 stale（true = 生成后协议链已变）。
    // 三态：true 出徽标 / false 仍匹配不出 / null 无出处（手工规格）不出；
    // 存 null 而非布尔，缺省与降级路径天然「不出徽标」。
    const [specStale, setSpecStale] = useState(null);
    const [settings, setSettings] = useState(DEFAULT_SETTINGS);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState(null);
    const [message, setMessage] = useState(null); // { kind: 'ok' | 'err', text }

    // R52（PLAN §8.84）：本地编辑世代号 —— 本地每改一次 +1。回包落地时比对：
    // 号已前进 = 这份回包**过期**（发出之后用户又改过）→ 本地优先，不得覆盖。
    // 缺这个判据时：GET 整份冲掉编辑、PUT 把新编辑判成已保存（下次发送走
    // response_spec: null，编辑被静默丢弃）—— 两条同根，改一必改二。
    const specRevRef = useRef(0);
    const touchSpec = () => { specRevRef.current += 1; };

    // 切换指令 → 拉取按指令持久化的规格；404 = 未配置（常态，本地缺省）；
    // 其他错误降级本地默认并挂错误条（同编排页加载失败降级先例）。
    useEffect(() => {
        let alive = true;
        const rev0 = specRevRef.current; // 本次拉取开始时的世代
        if (!instructionId) {
            setSpec(defaultSpec());
            setRangesText('');
            setSpecDirty(false);
            setSpecStale(null);
            return () => { alive = false; };
        }
        (async () => {
            try {
                const row = await api.getResponseSpec(instructionId);
                if (!alive) return;
                if (specRevRef.current !== rev0) return; // R52：拉取期间本地改过 → 本地优先
                setSpec(row.spec);
                setRangesText(formatIgnoreRanges(row.spec.ignore_ranges));
                setSpecDirty(false);
                // D7-A: 只认严格 true（false/null/undefined 一律归 null = 不出徽标）
                setSpecStale(row.stale === true ? true : null);
                setMessage(null);
            } catch (err) {
                if (!alive) return;
                // R52：降级同样本地优先（拉取期间敲的编辑不被 default 冲掉）；
                // 错误条照旧挂 —— 它陈述的是「拉取失败」这个事实，与本地改动无关。
                if (specRevRef.current === rev0) {
                    setSpec(defaultSpec());
                    setRangesText('');
                    setSpecDirty(false);
                    setSpecStale(null); // 未取得行 → 无出处可比，不出徽标
                }
                if (err?.response?.status === 404) {
                    setMessage(null);
                } else {
                    setMessage({
                        kind: 'err',
                        text: `SPEC LOAD FAILED: ${err?.message || 'UNKNOWN'} — 使用本地默认`
                    });
                }
            }
        })();
        return () => { alive = false; };
    }, [instructionId]);

    const rangesInvalid = useMemo(() => parseIgnoreRanges(rangesText) === null, [rangesText]);

    // R9: 命中应答（status === 'OK' 的最后一次成功 attempt 的 received）按指令
    // 字段布局逆向解码。无指令 / 无命中 / 未成功 → null（不出面板，不是错误）。
    // 不给 inputs：真机应答的取值不在本页手上，走静态链 + presence fail-open，
    // 布局仍由编码器同一份 `buildLayout` 决定（改一必改二）。
    const decoded = useMemo(() => {
        // 无字段布局（旧指令 / 只有 frames 没展开成 fields）→ 没东西可解，
        // 不出面板也不出「尾部残字节」警告（那是空布局的假警报，不是应答的问题）。
        if (!result || !instruction?.fields?.length || !Array.isArray(result.attempts)) return null;
        const hit = [...result.attempts].reverse().find(a => a.status === 'OK' && a.received);
        if (!hit) return null;
        const r = InstructionDecoder.decodeInstruction(instruction, hit.received, {});
        return r.fields.length || r.warnings.length ? r : null;
    }, [result, instruction]);

    const patchSpec = (patch) => {
        setSpec(prev => ({ ...prev, ...patch }));
        setSpecDirty(true);
        touchSpec();
    };

    const patchNested = (key, patch) => {
        setSpec(prev => ({ ...prev, [key]: { ...(prev[key] || {}), ...patch } }));
        setSpecDirty(true);
        touchSpec();
    };

    const toggleLength = (enabled) => patchSpec({
        length: enabled
            ? { offset: 0, byte_length: 1, offset_val: 0, byte_order: 'big' }
            : null
    });

    // R28（§8.60 定案）：length.encoding —— **只写非缺省值**（fixed = 删键）。后端
    // normalize_spec 把「缺失键」读作 fixed，故改回 fixed 必须把键删掉，否则存量规格
    // 会多出一个新键（Phase 0 金标准 responseBaseline.test.jsx 即钉这一条）。
    // BYTE_LEN 不因 varint 禁用：它是**设计期宽度**，收侧用 (实际出线宽 - BYTE_LEN)
    // 回算 offset_val（与 response_generate 求 offset_val 的口径同源，改一必改二）。
    const patchLengthEncoding = (encoding) => {
        setSpec(prev => {
            const length = { ...(prev.length || {}) };
            if (encoding === 'varint') length.encoding = 'varint';
            else delete length.encoding;
            return { ...prev, length };
        });
        setSpecDirty(true);
        touchSpec();
    };

    const toggleChecksum = (enabled) => patchSpec({
        checksum: enabled
            ? { algo: 'sum', field_offset: 0, field_byte_length: 1, span_start: 0, span_end: null, byte_order: 'big' }
            : null
    });

    const handleSaveSpec = async () => {
        if (!instructionId || rangesInvalid) return;
        setMessage(null);
        const rev0 = specRevRef.current; // 发出保存时的世代
        try {
            const saved = await api.saveResponseSpec(instructionId, spec);
            // R52：回包落地时本地又改过 → 新编辑仍是脏的，不能判成已保存
            setSpecDirty(specRevRef.current !== rev0);
            // D7-A: PUT 回执与 GET 同形（含 stale）——出处指纹在手工编辑时保留 →
            // 比对仍有效；新建行无出处 → stale null → 徽标自然消失，不会崩。
            // 回执缺 stale（旧夹具）→ null 同样不出徽标。
            setSpecStale(saved?.stale === true ? true : null);
            setMessage({ kind: 'ok', text: 'SPEC SAVED' });
        } catch (err) {
            setMessage({ kind: 'err', text: `SPEC SAVE FAILED: ${err?.message || 'UNKNOWN'}` });
        }
    };

    const handleRun = async () => {
        if (!payload || running) return;
        setRunning(true);
        setResult(null);
        setMessage(null);
        try {
            const record = await api.sendTransaction({
                hex_string: payload,
                instruction_name: instruction?.name || instruction?.label || null,
                instruction_id: instructionId,
                // 规格解析：本地已改（脏）→ 内联；干净 → 让后端按 instruction_id 解析
                response_spec: specDirty ? spec : null,
                // 批次一 (D4-A): 开关联动 —— 封装开 → 内核载荷 + wrap 由后端套壳
                ...(wrap ? { wrap } : {}),
                timeout_ms: toIntOr(settings.timeoutMs, 500),
                retries: toIntOr(settings.retries, 2),
                interval_ms: toIntOr(settings.intervalMs, 50),
                broadcast: Boolean(settings.broadcast)
            });
            setResult(record);
        } catch (err) {
            setMessage({ kind: 'err', text: `TXN ERROR: ${err?.message || 'UNKNOWN'}` });
        } finally {
            setRunning(false);
        }
    };

    const setNum = (key, lo, hi) => (e) => setSettings(prev => ({
        ...prev, [key]: String(clampInt(e.target.value, lo, hi))
    }));

    return (
        <div className="border-t-2 border-nier-light/10 pt-4 space-y-3">
            <div className="flex items-center justify-between">
                <span className="text-xs font-black text-nier-light/40 uppercase tracking-[0.2em]">
                    :: Transaction ::
                </span>
                <button
                    type="button"
                    onClick={() => setSpecOpen(open => !open)}
                    aria-expanded={specOpen}
                    className="text-[9px] font-mono text-nier-light/50 border border-nier-light/20 px-2 py-1 uppercase tracking-widest hover:border-nier-light/60 hover:text-nier-light transition-colors duration-100"
                >
                    {specOpen ? 'SPEC ▾' : 'SPEC ▸'}{specDirty ? ' *' : ''}
                </button>
            </div>

            {/* 批次一 (D4-A): 封装联动指示 —— wrap 开时事务发送同带协议外壳。
                CP3 3a: 配方态（降级链第 1 级）指示配方名与层数；单协议态形态不变。 */}
            {wrap && (
                <div className="text-[9px] font-mono text-nier-light/40 uppercase tracking-widest">
                    {wrap.mode === 'recipe'
                        ? <>WRAP ● RECIPE {wrap.name || wrap.recipe_id} · {(wrap.stages || []).length} 层</>
                        : <>WRAP ● {wrap.protocol_id} · {wrap.slot_id || `SLOT ORDER ${wrap.slot_order ?? 0}`}</>}
                </div>
            )}

            {/* 事务参数：超时 / 重发 / 间隔 + 广播开关 */}
            <div className="grid grid-cols-3 gap-2">
                <label>
                    <span className={labelClass}>TIMEOUT_MS</span>
                    <input
                        type="number" min="1" max="60000" value={settings.timeoutMs}
                        onChange={setNum('timeoutMs', 1, 60000)}
                        className={`${inputClass} w-full`}
                    />
                </label>
                <label>
                    <span className={labelClass}>RETRIES</span>
                    <input
                        type="number" min="0" max="10" value={settings.retries}
                        onChange={setNum('retries', 0, 10)}
                        className={`${inputClass} w-full`}
                    />
                </label>
                <label>
                    <span className={labelClass}>INTERVAL_MS</span>
                    <input
                        type="number" min="0" max="60000" value={settings.intervalMs}
                        onChange={setNum('intervalMs', 0, 60000)}
                        className={`${inputClass} w-full`}
                    />
                </label>
            </div>

            <div className="flex items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={() => setSettings(prev => ({ ...prev, broadcast: !prev.broadcast }))}
                    aria-pressed={settings.broadcast}
                    className={`text-[9px] font-mono uppercase tracking-widest border px-2 py-1 transition-colors duration-100 ${toggleButtonClass(settings.broadcast)}`}
                >
                    {settings.broadcast ? 'BROADCAST 无应答 ●' : 'BROADCAST 无应答 ○'}
                </button>
                <span className="text-[9px] font-mono text-nier-light/30">
                    ATTEMPTS ×{toIntOr(settings.retries, 2) + 1}
                </span>
            </div>

            <button
                type="button"
                onClick={handleRun}
                disabled={!payload || running}
                className="w-full border border-nier-light text-nier-light py-2 px-5 font-black text-xs tracking-[0.2em] hover:bg-nier-light hover:text-nier-dark transition-all duration-100 flex items-center justify-between disabled:opacity-40 disabled:cursor-not-allowed"
            >
                <span>{running ? 'TXN RUNNING...' : 'SEND_TRANSACTION'}</span>
                <span className="text-[9px] font-mono opacity-50">CTRL 状态见日志</span>
            </button>

            {message && (
                <div className={`text-[10px] font-mono tracking-wide ${message.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
                    {message.text}
                </div>
            )}

            {/* 事务结果：汇总 + 逐次 attempt（状态 / RTT / 失配原因） */}
            {result && (
                <div className="border border-nier-light/20 p-3 font-mono text-[10px] space-y-1">
                    <div className={`flex justify-between font-bold ${result.status === 'OK' ? 'text-green-400' : 'text-red-400'}`}>
                        <span>{summaryLine(result)}</span>
                        <span className="text-nier-light/40">{specSourceLabel(result.spec_source)}</span>
                    </div>
                    {result.attempts.map(attempt => (
                        <div key={attempt.n} className="flex items-baseline gap-2 border-b border-nier-light/5 pb-1 last:border-b-0">
                            <span className="text-nier-light/40">#{attempt.n}</span>
                            <span className={
                                attempt.status === 'OK' ? 'text-green-400'
                                    : attempt.status === 'TRANSPORT_ERROR' ? 'text-red-400'
                                        : 'text-yellow-400'
                            }>
                                {attemptLabel(attempt.status)}
                            </span>
                            <span className="text-nier-light/50">{rttText(attempt.rtt_ms)}</span>
                            <span
                                className="flex-1 truncate text-right text-nier-light/60"
                                title={attempt.error || attempt.reasons?.join(', ') || attempt.received}
                            >
                                {attempt.error || (attempt.reasons?.length ? attempt.reasons.join(', ') : attempt.received)}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {/* R9 解码展示：命中应答按字段布局逆向还原成「字段 = 值」（与编码器对偶） */}
            {decoded && <DecodedFields decoded={decoded} />}

            {/* 应答规格编辑器（折叠）：五要素 = 帧头回显 / 长度自洽 / 校验反算 / 掩码忽略 / 前缀后缀 */}
            {specOpen && (
                <div className="border border-nier-light/20 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-nier-light/40">
                            RESPONSE_SPEC
                        </span>
                        <div className="flex items-center gap-2">
                            {/* CP3 3d (D7-A): 仅 stale === true 出徽标（false/null 不渲染） */}
                            {specStale === true && (
                                <span
                                    data-testid="response-spec-stale"
                                    title="生成后协议链已变更，请重新生成（REGENERATE）"
                                    className="text-[9px] font-mono uppercase tracking-widest border border-[#E58D28]/60 px-2 py-1 text-[#FFB74D]"
                                >
                                    规格已失效 STALE
                                </span>
                            )}
                            <button
                                type="button"
                                onClick={handleSaveSpec}
                                disabled={!instructionId || rangesInvalid}
                                className="text-[9px] font-mono uppercase tracking-widest border border-nier-light/20 px-2 py-1 text-nier-light/70 hover:border-nier-light hover:text-nier-light transition-colors duration-100 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {specDirty ? 'SAVE *' : 'SAVE'}
                            </button>
                        </div>
                    </div>

                    {!instructionId && (
                        <div className="text-[9px] font-mono text-nier-light/40">// NO INSTRUCTION — 仅可内联发送</div>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                        <label>
                            <span className={labelClass}>MODE</span>
                            <select
                                value={spec.mode}
                                onChange={e => patchSpec({ mode: e.target.value })}
                                className={`${inputClass} w-full`}
                            >
                                <option value="echo">echo · 回显比对</option>
                                <option value="rules">rules · 结构校验</option>
                                <option value="any">any · 任意应答</option>
                            </select>
                        </label>
                        <label>
                            <span className={labelClass}>ECHO_HEADER_B</span>
                            <input
                                type="number" min="0" max="1024" value={spec.echo_header_bytes}
                                onChange={e => patchSpec({ echo_header_bytes: clampInt(e.target.value, 0, 1024) })}
                                className={`${inputClass} w-full`}
                            />
                        </label>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <label>
                            <span className={labelClass}>PREFIX (HEX)</span>
                            <input
                                value={spec.prefix} placeholder="AA55"
                                onChange={e => patchSpec({ prefix: e.target.value })}
                                className={`${inputClass} w-full`}
                            />
                        </label>
                        <label>
                            <span className={labelClass}>SUFFIX (HEX)</span>
                            <input
                                value={spec.suffix} placeholder="0D0A"
                                onChange={e => patchSpec({ suffix: e.target.value })}
                                className={`${inputClass} w-full`}
                            />
                        </label>
                    </div>

                    {/* 长度字段自洽：声明值 == 实际帧长 + offset_val */}
                    <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={() => toggleLength(!spec.length)}
                                aria-pressed={Boolean(spec.length)}
                                className={`text-[9px] font-mono uppercase tracking-widest border px-2 py-1 transition-colors duration-100 ${toggleButtonClass(Boolean(spec.length))}`}
                            >
                                LENGTH {spec.length ? 'ON' : 'OFF'}
                            </button>
                            {spec.length && (
                                <label className="flex items-center gap-1">
                                    <span className="text-[9px] font-mono text-nier-light/40 uppercase tracking-[0.2em]">ENCODING</span>
                                    <select
                                        value={spec.length.encoding || 'fixed'}
                                        onChange={e => patchLengthEncoding(e.target.value)}
                                        aria-label="length encoding"
                                        className={inputClass}
                                    >
                                        <option value="fixed">fixed · 定宽</option>
                                        <option value="varint">varint · LEB128</option>
                                    </select>
                                </label>
                            )}
                        </div>
                        {spec.length && spec.length.encoding === 'varint' && (
                            <p className="text-[9px] font-mono text-nier-light/40">
                                varint 按 LEB128 判读（字节序无关，ORDER 不参与）；BYTE_LEN = 设计期宽度，收侧按实际出线宽回算 offset_val。
                            </p>
                        )}
                        {spec.length && (
                            <div className="grid grid-cols-4 gap-2">
                                <label>
                                    <span className={labelClass}>OFFSET</span>
                                    <input
                                        type="number" min="0" max="4095" value={spec.length.offset}
                                        onChange={e => patchNested('length', { offset: clampInt(e.target.value, 0, 4095) })}
                                        className={`${inputClass} w-full`}
                                    />
                                </label>
                                <label>
                                    <span className={labelClass}>BYTE_LEN</span>
                                    <input
                                        type="number" min="1" max="4" value={spec.length.byte_length}
                                        onChange={e => patchNested('length', { byte_length: clampInt(e.target.value, 1, 4) })}
                                        className={`${inputClass} w-full`}
                                    />
                                </label>
                                <label>
                                    <span className={labelClass}>OFFSET_VAL</span>
                                    <input
                                        type="number" min="-4096" max="4096" value={spec.length.offset_val}
                                        onChange={e => patchNested('length', { offset_val: clampInt(e.target.value, -4096, 4096) })}
                                        className={`${inputClass} w-full`}
                                    />
                                </label>
                                <label>
                                    <span className={labelClass}>ORDER</span>
                                    <select
                                        value={spec.length.byte_order}
                                        onChange={e => patchNested('length', { byte_order: e.target.value })}
                                        className={`${inputClass} w-full`}
                                    >
                                        <option value="big">big</option>
                                        <option value="little">little</option>
                                    </select>
                                </label>
                            </div>
                        )}
                    </div>

                    {/* 校验字段反算：span 区间按算法计算后与字段比对（恒排除字段自身） */}
                    <div className="space-y-2">
                        <button
                            type="button"
                            onClick={() => toggleChecksum(!spec.checksum)}
                            aria-pressed={Boolean(spec.checksum)}
                            className={`text-[9px] font-mono uppercase tracking-widest border px-2 py-1 transition-colors duration-100 ${toggleButtonClass(Boolean(spec.checksum))}`}
                        >
                            CHECKSUM {spec.checksum ? 'ON' : 'OFF'}
                        </button>
                        {spec.checksum && (
                            <div className="grid grid-cols-3 gap-2">
                                <label>
                                    <span className={labelClass}>ALGO</span>
                                    <select
                                        value={spec.checksum.algo}
                                        onChange={e => {
                                            const algo = e.target.value;
                                            patchNested('checksum', {
                                                algo,
                                                // crc16 恒 2 字节，切算法时同步字段宽避免 400
                                                field_byte_length: algo === 'crc32' ? 4 : (algo === 'crc16_modbus' || algo === 'crc16_ccitt') ? 2 : 1  // R22: 随算法切默认字段宽（镜像后端 ALGO_FIELD_WIDTH）
                                            });
                                        }}
                                        className={`${inputClass} w-full`}
                                    >
                                        <option value="sum">sum</option>
                                        <option value="xor">xor</option>
                                        <option value="crc16_modbus">crc16_modbus</option>
                                        <option value="crc16_ccitt">crc16_ccitt</option>
                                        <option value="crc32">crc32</option>
                                        <option value="lrc">lrc</option>
                                    </select>
                                </label>
                                <label>
                                    <span className={labelClass}>FIELD_OFFSET</span>
                                    <input
                                        type="number" min="0" max="4095" value={spec.checksum.field_offset}
                                        onChange={e => patchNested('checksum', { field_offset: clampInt(e.target.value, 0, 4095) })}
                                        className={`${inputClass} w-full`}
                                    />
                                </label>
                                <label>
                                    <span className={labelClass}>FIELD_LEN</span>
                                    <input
                                        type="number" min="1" max="4" value={spec.checksum.field_byte_length}
                                        onChange={e => patchNested('checksum', { field_byte_length: clampInt(e.target.value, 1, 4) })}
                                        className={`${inputClass} w-full`}
                                    />
                                </label>
                                <label>
                                    <span className={labelClass}>SPAN_START</span>
                                    <input
                                        type="number" min="0" max="4095" value={spec.checksum.span_start}
                                        onChange={e => patchNested('checksum', { span_start: clampInt(e.target.value, 0, 4095) })}
                                        className={`${inputClass} w-full`}
                                    />
                                </label>
                                <label>
                                    <span className={labelClass}>SPAN_END</span>
                                    <input
                                        type="number" min="1" max="8192" placeholder="帧尾"
                                        value={spec.checksum.span_end ?? ''}
                                        onChange={e => patchNested('checksum', {
                                            span_end: e.target.value === '' ? null : clampInt(e.target.value, 1, 8192)
                                        })}
                                        className={`${inputClass} w-full`}
                                    />
                                </label>
                                <label>
                                    <span className={labelClass}>ORDER</span>
                                    <select
                                        value={spec.checksum.byte_order}
                                        onChange={e => patchNested('checksum', { byte_order: e.target.value })}
                                        className={`${inputClass} w-full`}
                                    >
                                        <option value="big">big</option>
                                        <option value="little">little</option>
                                    </select>
                                </label>
                            </div>
                        )}
                    </div>

                    {/* 掩码忽略区间（echo 比对跳过；文本互转纯函数在 utils/transactionView.js） */}
                    <label className="block">
                        <span className={labelClass}>IGNORE_RANGES · 起-止,起-止</span>
                        <input
                            value={rangesText} placeholder="4-6,10-12"
                            onChange={e => {
                                const text = e.target.value;
                                setRangesText(text);
                                touchSpec(); // 含非法文本：它也是一次本地敲击（合法时 patchSpec 会再记一次，计数只增无害）
                                const parsed = parseIgnoreRanges(text);
                                if (parsed !== null) patchSpec({ ignore_ranges: parsed });
                            }}
                            className={`${inputClass} w-full`}
                        />
                    </label>
                    {rangesInvalid && (
                        <div className="text-[9px] font-mono text-red-400">
                            格式非法：半开区间「起-止」逗号分隔、不重叠、≤8192
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
