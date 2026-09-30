/**
 * 优化批（市场调研后优化 2/3）：位段元数据 signed / value_table 的共享纯函数。
 *
 * 语义对齐 DBC：
 *  - signed   —— 有符号位段（两补码解读，打包口径不变：raw & mask 天然覆盖）
 *  - value_table —— 值表（DBC VAL_），[{ value: int, label: string }]，
 *                   把 0/1/2 解码成「关 / 开 / 故障」等名称。
 *
 * 存储口径（零 DDL 硬约束）：
 *  - 指令侧：bit_fields 表无 JSON 列 → 元数据骑 parameter_config.bit_meta
 *    （既有 JSON 列）。保存/导入在 normalizeFieldPayload 单点按 bits **重建**，
 *    读取路径按 bit id 幂等合并回 bits（编辑视图单源）。
 *  - 协议侧：块 bits 存 children JSON → 元数据直接挂在位段键上
 *    （BitFieldSchema Pydantic 透传）。
 */

// 值表清洗：数组 → 过滤非法项（非对象 / value 非有限数），label 缺省空串。
// 空/非数组 → undefined（调用方据此不注入键，与批 4 白名单口径一致）。
export const sanitizeValueTable = (raw) => {
    if (!Array.isArray(raw)) return undefined;
    const out = raw
        .filter(e => e && typeof e === 'object' && Number.isFinite(Number(e.value)))
        .map(e => ({ value: Number(e.value), label: String(e.label ?? '') }));
    return out.length > 0 ? out : undefined;
};

// 保存/导入：从位段数组提取元数据 → { [bitId]: { signed?, value_table? } }，
// 无可存 → null（调用方删键，存量负载不变）。无 id 的位段不入（防悬空键）。
export const extractBitMeta = (bits) => {
    if (!Array.isArray(bits)) return null;
    const meta = {};
    bits.forEach(b => {
        if (!b || !b.id) return;
        const entry = {};
        if (b.signed === true) entry.signed = true;
        const vt = sanitizeValueTable(b.value_table);
        if (vt) entry.value_table = vt;
        if (Object.keys(entry).length > 0) meta[b.id] = entry;
    });
    return Object.keys(meta).length > 0 ? meta : null;
};

// 读取：pc.bit_meta 按 bit id 合并回位段。**位段自身键优先** —— bits 是编辑
// 真源（用户改过值表/有符号后，陈旧 pc.bit_meta 不得覆盖），meta 只补缺省键；
// 幂等（已合并态再合并结果不变）；meta 缺失/未命中 → 原样返回。
export const mergeBitMeta = (bits, parameterConfig) => {
    if (!Array.isArray(bits)) return [];
    const meta = parameterConfig && typeof parameterConfig === 'object'
        ? parameterConfig.bit_meta
        : null;
    if (!meta || typeof meta !== 'object') return bits;
    return bits.map(b => (b && b.id && meta[b.id] && typeof meta[b.id] === 'object')
        ? { ...meta[b.id], ...b }
        : b);
};

export const mergeFieldBitMeta = (field = {}) => ({
    ...field,
    bits: mergeBitMeta(field.bits, field.parameter_config)
});

// 值表文本编辑格式（BitFieldEditor 单行输入）：'0=关,1:开'（':' 同容忍，
// 中文逗号容忍）。全部非法 → undefined（= 清空值表）。
export const parseValueTable = (raw) => {
    const text = String(raw ?? '').replace(/，/g, ',');
    if (!text.trim()) return undefined;
    const out = [];
    text.split(',').forEach(part => {
        const m = part.trim().match(/^(-?\d+)\s*[:=]\s*(.*)$/);
        if (!m) return;
        out.push({ value: Number(m[1]), label: m[2].trim() });
    });
    return out.length > 0 ? out : undefined;
};

// 反向回显：[{0,'关'}] → '0=关,1=开'；非数组/空 → ''（编辑框 placeholder 兜底）
export const formatValueTable = (entries) => {
    const vt = sanitizeValueTable(entries);
    if (!vt) return '';
    return vt.map(e => `${e.value}=${e.label}`).join(',');
};
