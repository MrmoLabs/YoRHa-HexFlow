// R27（§8.52 排期 · varint / COBS 出线 · §8.59）: 变长长度前缀与定界编码 ——
// **只编码、不解包**（收侧 stages 逆向解包 + 应答匹配属 R28，本批一行不碰）。
//
// 语义与 backend/core/framing.py 同口径（编码侧 SSOT 在后端；FE 按同一规范落
// 一份字节级实现，画布预览/组帧发射直接出字节，不回后端）：
//
//  1. varint —— length 卡 pc.encoding ∈ {fixed, varint}，**缺省 fixed = 缺失键**
//     （不选 varint 就与本批之前逐字节一致，§0）。编码 = LEB128 最小长度无符号，
//     每字节低 7 位数据、最高位续位；**字节序中立**（不参与 LITTLE 逆序）。
//  2. COBS —— 协议树组帧元素 type:'cobs'，子树字节 → 标准 COBS（码 0xFF = 满块
//     254 字面量）→ 按 pc.terminator 追加定界（'00' 缺省 → 0x00；'none' → 不追加）。
//
// 失败口径：域外/脏输入返回空数组或 null（调用方按「不发明形态」处理）；保存侧
// validateProtocol 先拦非法 encoding/terminator，出帧期后端同值 ValueError → 400。
//
// 双端向量纪律：本文件的向量锚定 __tests__/framing.test.js ↔
// backend/tests/test_framing.py ↔ vectors/framing.json，改一必改二。

export const LENGTH_ENCODINGS = ['fixed', 'varint'];
export const DEFAULT_LENGTH_ENCODING = 'fixed';

// JS 安全整数上限 —— 超过 2^53-1 位移开始丢精度，两端不再保证同字节（BE
// VARINT_MAX 同值）。帧内长度（refs Σ + offset）到不了这个量级，仅作契约边界。
export const VARINT_MAX = 9007199254740991;

export const COBS_MAX_BLOCK = 254;
export const COBS_EMPTY = '01';
const DEFAULT_TERMINATOR = '00';

/** 非负安全整数 → LEB128 字节数组；域外（非整数 / 负 / 超 2^53-1）→ []. */
export function encodeVarint(value) {
    if (!Number.isInteger(value) || value < 0 || value > VARINT_MAX) {
        return [];
    }
    if (value === 0) {
        return [0];
    }
    const out = [];
    let v = value;
    for (;;) {
        const low = v % 128; // 128 = 2^7 → 安全整数内取模/整除精确无舍入
        v = Math.floor(v / 128);
        out.push(v ? (low | 0x80) : low);
        if (!v) {
            break;
        }
    }
    return out;
}

/** encodeVarint 的出线字节数（域外 → null，调用方回落设计期宽度）。 */
export function varintWidth(value) {
    const bytes = encodeVarint(value);
    return bytes.length ? bytes.length : null;
}

/** params.encoding → 'fixed' | 'varint'；缺失/非法一律 fail-open 'fixed'（镜像 BE normalize_encoding）。 */
export function normalizeEncoding(params) {
    if (!params || typeof params !== 'object') {
        return DEFAULT_LENGTH_ENCODING;
    }
    const raw = params.encoding;
    if (raw === undefined || raw === null) {
        return DEFAULT_LENGTH_ENCODING;
    }
    const text = String(raw).trim().toLowerCase();
    return LENGTH_ENCODINGS.includes(text) ? text : DEFAULT_LENGTH_ENCODING;
}

/** params.terminator → 追加字节数组（'00' 缺省 / 'none' 不追加；非法值按缺省，同 BE）。 */
export function terminatorBytes(params) {
    if (!params || typeof params !== 'object') {
        return [0x00];
    }
    const raw = params.terminator;
    if (raw === undefined || raw === null) {
        return [0x00];
    }
    return String(raw).trim().toLowerCase() === 'none' ? [] : [0x00];
}

/** 字节串 → 标准 COBS 编码（**不含**定界字节），与 BE cobs_encode 逐字节同形。 */
export function cobsEncode(data) {
    const out = [0]; // 首个码字节占位
    let codeIdx = 0;
    let reason = 'keep'; // keep=起手占位 / zero=刚吞掉一个 0x00 / fill=满块闭合
    for (const byte of data) {
        if (byte === 0) {
            out[codeIdx] = out.length - codeIdx;
            codeIdx = out.length;
            out.push(0);
            reason = 'zero';
            continue;
        }
        out.push(byte);
        if (out.length - codeIdx - 1 >= COBS_MAX_BLOCK) {
            out[codeIdx] = out.length - codeIdx;
            codeIdx = out.length;
            out.push(0);
            reason = 'fill';
        }
    }
    if (reason === 'fill' && out.length - codeIdx === 1) {
        // 满块闭合后输入正好结束 → 预留码字节后面没有字面量、也没有要表示的
        // 0x00，是多余的收束码，删掉才是规范编码（254 字面量唯一形态 = FF 块）。
        out.splice(codeIdx, 1);
    } else {
        out[codeIdx] = out.length - codeIdx;
    }
    return out;
}

/** hex（可带空白）→ 字节数组；空 → []；奇长 / 非法字符 → null（同 BE ValueError 口径）。 */
export function hexToBytes(hexStr) {
    const compact = String(hexStr ?? '').replace(/\s/g, '');
    if (compact === '') {
        return [];
    }
    if (compact.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(compact)) {
        return null;
    }
    const out = [];
    for (let i = 0; i < compact.length; i += 2) {
        out.push(parseInt(compact.substr(i, 2), 16));
    }
    return out;
}

/** bytes → 紧凑大写 hex。 */
export function bytesToHex(bytes) {
    return (bytes || [])
        .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
        .join('');
}

/** 子树发射 hex → COBS 编码 + 定界后的出线 hex；非法 hex → null。 */
export function encodeCobsHex(hexStr, params) {
    const bytes = hexToBytes(hexStr);
    if (!bytes) {
        return null;
    }
    return bytesToHex(cobsEncode(bytes).concat(terminatorBytes(params)));
}
