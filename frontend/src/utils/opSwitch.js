// R24（§8.52 排期 · 原挂账 ③）：创建后切换算子 —— 兼容校验 + 参数裁剪 + 默认态播种。
//
// 现状（BUSINESS_SCENARIOS 挂账 ③）：属性面板的 op_code 是只读 span，改算子只能删了
// 重建重录。本模块把「切算子」做成一次**带确认回执的受控转换**：
//   1) 组（ARRAY_GROUP/STRUCT）切成叶算子且下面还挂着子块 → 拦（会留下孤儿子块）；
//   2) 中性键保留（值/引用/存在条件/对齐填充/字节序/录入进制），算子专属键清空；
//   3) 剩余状态按**目标算子的新建默认态**播种 —— 因此切换后 ≡ 新建该算子的字段。
//
// `applyOpDefaults` 从 `pages/Instruction.jsx` 的 handleAddBlock 原样抽出（单源）：
// 新建与切换共用同一份默认态规则，避免「新建是 8B、切换是 1B」之类的双份分叉。
import { v4 as uuidv4 } from 'uuid';
import { OP_CODES, OP_PRIORITY } from '../constants';

// param_template 里的**控件类型提示**（'input' = 文本框、'number' = 数字、
// 'kv_pair_list' = 枚举编辑器…），它们是给面板看的**类型**不是值，不写进 parameter_config。
export const OP_KEYWORD_HINTS = [
    'datetime', 'number', 'string', 'field_picker', 'kv_pair_list', 'input', 'bit_editor',
];

// 编码器已知算子全集 = OP_CODES 16 项 + encoder legacy 5 项 = 21 项（与
// validateInstruction.KNOWN_OPS / BE KNOWN_OPS 同源，改一必改二）。
export const KNOWN_OP_LIST = [
    ...Object.values(OP_CODES),
    'INPUT', 'FIXED', 'HEADER', 'TAIL', 'CALCULATED',
];
const KNOWN_OP_SET = new Set(KNOWN_OP_LIST);

export const GROUP_OPS = [OP_CODES.ARRAY_GROUP, OP_CODES.STRUCT];
export const isGroupOp = (op) => GROUP_OPS.includes(String(op || '').toUpperCase());

// 跨算子**中性键**：语义与具体算子无关（值、被引用、存在条件、对齐/填充、字节序、
// 录入进制），切算子时保留 —— 这样「换算子」不会把用户的手工录入一并清掉。
export const NEUTRAL_PARAM_KEYS = [
    'value', 'refs', 'presence', 'align', 'pad_to', 'pad_byte', 'endianness', 'input_base',
];

/**
 * 目标算子的默认态播种（新建与切换共用，单源）。
 *
 * @param {object} draft     待播种的字段草稿（原地修改）
 * @param {string} opCode    目标算子
 * @param {object} template  该算子的算子模板（{ param_template }），可空
 * @param {object} [opts]
 * @param {number} [opts.preferByteLen] 切换时**保留**的字节长度：位宽枚举能容纳它就用它
 *   （1B → bits 8、4B → bits 32），容纳不下才回落模板首项；新建时不传 → 恒用模板首项。
 * @returns {object} draft
 */
export function applyOpDefaults(draft, opCode, template, { preferByteLen } = {}) {
    const params = draft.parameter_config || (draft.parameter_config = {});
    const tpl = (template && template.param_template) || {};

    // 1) 模板默认值：跳过控件类型提示；**数组 = 枚举选项** → 落首个标量。
    //    A1 数组污染先例：bits/encoding/unit/algo 存成数组后，下拉显示取 [0] 而编码器
    //    走 default 分支 —— 显示与线上各走各的（R23 的 unit 就踩过）。
    Object.entries(tpl).forEach(([key, val]) => {
        if (typeof val === 'string' && OP_KEYWORD_HINTS.includes(val)) return;
        params[key] = Array.isArray(val) ? (val[0] ?? '') : val;
    });

    // 2) 组 / 位域的结构性默认（与 handleAddBlock 原逻辑逐条等价）。
    if (opCode === 'BITFIELD') {
        // 播种一个 8-bit 段，位图编辑器立刻有东西可看；切换时若已带位段则不覆盖。
        draft.byte_len = 1;
        if (!Array.isArray(draft.bits) || draft.bits.length === 0) {
            draft.bits = [{
                id: uuidv4(), sequence: 0, bit_name: 'VALUE',
                start_bit: 0, bit_len: 8, default_val: 0,
            }];
        }
    } else if (opCode === 'ARRAY_GROUP') {
        draft.byte_len = 0;
        if (!params.max_count) params.max_count = 1;
    }

    // 3) 位宽模板（INT*/FLOAT 的 bits）：数组是**选项**，按 preferByteLen 就近取值。
    if (tpl.bits) {
        const choices = (Array.isArray(tpl.bits) ? tpl.bits : [tpl.bits])
            .map(Number).filter(n => Number.isFinite(n) && n > 0);
        const keep = Number(preferByteLen);
        const fit = Number.isFinite(keep) && keep > 0 && choices.includes(keep * 8);
        const chosen = fit ? keep * 8 : choices[0];
        if (Number.isFinite(chosen) && chosen > 0) {
            params.bits = chosen;
            // 只有「回落模板首项」才改字节长度；能容纳原长度就原样保留（refs/长度域不断链）。
            if (!fit) draft.byte_len = Math.ceil(chosen / 8);
        }
    }

    // 4) HEX_RAW：hex 必须与 byte_len 等长（APPLY 与 BE 保存侧都按这个判）。
    if (opCode === 'HEX_RAW') {
        const byteLen = draft.byte_len || 1;
        const currentHex = String(params.hex || '').replace(/\s/g, '');
        if (currentHex.length !== byteLen * 2) params.hex = '00'.repeat(byteLen);
    }

    // 5) N2 (G2) 文本字段：pc.type='string' 是编码/显示/校验链的触发键（模板里的
    //    keyword 不会复制进 pc，必须特判设置）；创建缺省 8B，切换保留原长度。
    if (opCode === 'STRING') {
        if (!Number.isFinite(Number(preferByteLen))) draft.byte_len = 8;
        params.type = 'string';
        if (Array.isArray(params.encoding)) params.encoding = params.encoding[0] ?? 'ascii';
    }

    // 6) B1 校验算法：algorithm 是编码器真正读的键（aliasChecksumAlgo 只在缺省时补）。
    if (params.algo !== undefined) params.algorithm = params.algo;

    // 7) MAPPING 枚举编辑器读 _kvArray（数组态由面板同步 effect 维护）。切换不重跑
    //    选块 effect，这里补空数组，避免切换后编辑器读到上一个算子残留的数组。
    if (tpl.options === 'kv_pair_list' && !Array.isArray(params._kvArray)) params._kvArray = [];

    return draft;
}

/**
 * 切算子的兼容校验 + 转换计划（纯函数 → 可单测）。
 *
 * @param {object} block    当前字段草稿（不被修改）
 * @param {string} nextOp   目标算子
 * @param {object} [opts]
 * @param {number} [opts.childCount] 该字段下挂的子块数（组 → 叶时非 0 即拦）
 * @param {object} [opts.templates]  算子模板表（key = op_code）
 * @returns {{ok:true,code:'SAME_OP'|'OK',...}|{ok:false,code:string,message:string}}
 */
export function planOpSwitch(block, nextOp, { childCount = 0, templates = {} } = {}) {
    const from = String(block?.op_code ?? '');
    const to = String(nextOp || '');

    if (!KNOWN_OP_SET.has(to)) {
        return {
            ok: false,
            code: 'OP_UNKNOWN',
            message: `未知算子（${to || '空'}）：不在已知算子全集（OP_CODES + encoder legacy）。`,
        };
    }
    if (to === from) return { ok: true, code: 'SAME_OP', from, to, next: block, kept: [], dropped: [] };

    const groupFrom = isGroupOp(from);
    const groupTo = isGroupOp(to);

    // 拦 1：容器切成叶算子 → 子块会变成没有父的孤儿（BE 保存侧同位 400，改一必改二）。
    if (groupFrom && !groupTo && childCount > 0) {
        return {
            ok: false,
            code: 'GROUP_HAS_CHILDREN',
            message:
                `「${block.name || block.id}」是容器（${from}）且下挂 ${childCount} 个子块，`
                + `切成叶算子 ${to} 会留下孤儿子块 —— 请先移出或删除子块再切换。`,
        };
    }

    const pc = block.parameter_config || {};

    // 中性键保留（组 → 组额外保留 max_count：两个容器共用的循环上限）。
    const kept = {};
    NEUTRAL_PARAM_KEYS.forEach((k) => { if (pc[k] !== undefined) kept[k] = pc[k]; });
    if (groupFrom && groupTo && pc.max_count !== undefined) kept.max_count = pc.max_count;
    // 进组即摘 value：组不吃静态值，留着会被 hasFixedValue 判成 FIXED 卡面。
    if (groupTo) delete kept.value;

    const next = { ...block, op_code: to, parameter_config: kept };
    // 位段只属于 BITFIELD：切入带过来、切走摘干净（_validate_bitfields 只判 BITFIELD）。
    if (to === OP_CODES.BITFIELD) next.bits = Array.isArray(block.bits) ? block.bits.slice() : [];
    else delete next.bits;

    const byteLenBefore = block.byte_len ?? null;
    applyOpDefaults(next, to, templates?.[to], { preferByteLen: Number(byteLenBefore) || undefined });

    const nowParams = next.parameter_config;
    const dropped = Object.keys(pc)
        .filter(k => k !== '_kvArray' && !Object.prototype.hasOwnProperty.call(nowParams, k));
    if (Array.isArray(block.bits) && block.bits.length > 0 && !Array.isArray(next.bits)) dropped.push('bits');

    const bitsDelta = (pc.bits !== undefined && nowParams.bits !== undefined && pc.bits !== nowParams.bits)
        ? `${pc.bits} → ${nowParams.bits}` : null;

    return {
        ok: true,
        code: 'OK',
        from,
        to,
        next,
        kept: NEUTRAL_PARAM_KEYS.filter(k => Object.prototype.hasOwnProperty.call(nowParams, k)),
        dropped,
        byteLen: [byteLenBefore, next.byte_len ?? null],
        bitsDelta,
    };
}

/**
 * 可切换的算子清单 = 有算子模板的 OP_CODES（与调色板同源：STRUCT / encoder legacy
 * 五项没有模板 → 不提供，但**当前算子恒列第一**，存量字段切得动、不会渲染成空下拉）。
 */
export function switchableOps(templates, currentOp) {
    const opSet = new Set(Object.values(OP_CODES));
    const list = Object.keys(templates || {})
        .filter(op => opSet.has(op))
        .sort((a, b) => {
            if (a === OP_CODES.HEX_RAW) return -1;
            if (b === OP_CODES.HEX_RAW) return 1;
            const ia = OP_PRIORITY.indexOf(a);
            const ib = OP_PRIORITY.indexOf(b);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
    return currentOp && !list.includes(currentOp) ? [currentOp, ...list] : list;
}

/** 确认回执文案（纯函数 → 可单测；面板 openConfirm 直接吃这串）。 */
export function describeOpSwitch(plan) {
    const lines = [`切换算子：${plan.from} → ${plan.to}`];
    if (plan.kept?.length) lines.push(`保留：${plan.kept.join('、')}`);
    if (plan.dropped?.length) lines.push(`清除：${plan.dropped.join('、')}`);
    if (plan.bitsDelta) lines.push(`位宽：${plan.bitsDelta}`);
    if (plan.byteLen && plan.byteLen[0] !== plan.byteLen[1]) {
        lines.push(`字节长度：${plan.byteLen[0] ?? '—'}B → ${plan.byteLen[1] ?? '—'}B`);
    }
    lines.push('仅影响本字段；确认后写入草稿，仍需 APPLY 保存。');
    return lines.join('\n');
}
