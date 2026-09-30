// N5 (G4 · PLAN §8.16): 字段级 align / pad_to 填充对齐 —— 归一与补位长度计算。
// 口径与 backend/core/pad.py 同源（两端各自钉同一套规则，改一必改二）：
//   - align / pad_to：正整数 1..PAD_MAX（Number + floor；bool / 非数 / ≤0 / 超上限
//     → 0 即关闭，fail-open 不阻断出帧）；
//   - pad_byte：≤2 位 hex 严格解析 → 字节值，否则 0x00（N2 pad_char 先例）。
//
// 口径（拍板：字段级 align + pad_to，骑 parameter_config 零 DDL）：
//   align   = N → 该字段**内容起点**绝对偏移补位到 ≡0 (mod N)；
//   pad_to  = N → 该字段**内容末尾**绝对偏移补位到 ≡0 (mod N)；
//   均已对齐 → 0 字节；pad 进发射流 / 偏移尺 / 总长，不进长度公式与校验参与区
//   （内容口径，见 byteOffsets 与 validateInstruction 的注释）。

export const PAD_MAX = 4096;

const toBound = (raw) => {
    if (typeof raw === 'boolean' || raw === null || raw === undefined) return 0;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    const i = Math.floor(n);
    return i >= 1 && i <= PAD_MAX ? i : 0;
};

const toByte = (raw) => {
    if (raw === null || raw === undefined) return 0;
    const s = String(raw);
    if (s.length > 0 && s.length <= 2 && /^[0-9A-Fa-f]+$/.test(s)) return parseInt(s, 16);
    return 0;
};

/** parameter_config → { align, padTo, padByte }；非法键归 0 / 0x00（fail-open）。 */
export function padSpec(pc) {
    const p = (pc && typeof pc === 'object' && !Array.isArray(pc)) ? pc : {};
    return {
        align: toBound(p.align),
        padTo: toBound(p.pad_to),
        padByte: toByte(p.pad_byte),
    };
}

/** align：内容起点绝对偏移补到 N 边界（已对齐 / 关闭 → 0 字节）。 */
export function alignPadLen(cursor, align) {
    if (!align || !Number.isFinite(cursor)) return 0;
    return (align - (cursor % align)) % align;
}

/** pad_to：内容末尾绝对偏移补到 N 边界（已对齐 / 关闭 → 0 字节）。 */
export function padToPadLen(end, padTo) {
    if (!padTo || !Number.isFinite(end)) return 0;
    return (padTo - (end % padTo)) % padTo;
}

/** 填充字节串（大写 hex 对，与编码器字节串同格式）。 */
export function padHex(count, byte) {
    if (!count || count <= 0) return '';
    return (byte & 0xFF).toString(16).padStart(2, '0').toUpperCase().repeat(count);
}
