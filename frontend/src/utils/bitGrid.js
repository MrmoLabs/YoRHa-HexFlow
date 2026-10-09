/**
 * 批 2：位域布局的位网格模型（纯函数层，供 BitFieldEditor 可视化消费）。
 *
 * 存储约定（与指令侧 BITFIELD / backend bit_fields 一致）：
 *   start_bit 以「整字段位偏移」计，bit 0 = 最低有效位（LSB）。
 * 网格显示约定：每字节 8 格，**bit0 在最右**（MSB 在左）——
 *   第 r 行第 c 列（c = 0..7）的绝对位号 = r*8 + (7-c)。
 *
 * 编码语义不在此：编辑器的打包预览与 InstructionEncoder 同口径
 * （见 packBits 与 packBitfieldDefault 的镜像测试，改一必改二）。
 */

import { sanitizeValueTable } from './bitMeta';

// 段配色（沙色/炭黑体系内的高辨识色，按段序稳定取用）
export const BIT_GRID_COLORS = [
    '#E58D28', // 琥珀（主段）
    '#7E8B4F', // 苔绿
    '#4A7C8C', // 钢青
    '#8C5A5A', // 铁锈
    '#6B5B8C', // 紫灰
    '#A08C3F'  // 沙金
];

const isPosInt = (n) => Number.isInteger(n) && n >= 1;
const isNonNegInt = (n) => Number.isInteger(n) && n >= 0;

// 位段归一：非法位段（start/bit_len 非整数、bit_len < 1）直接剔除，
// 既不占格也不参与重叠判定 —— 与 BitFieldEditor 的输入钳制同口径。
// 优化批 2/3：携带元数据 signed（非 true 一律 false）与 value_table（清洗）。
export const normalizeBits = (bits) => (Array.isArray(bits) ? bits : [])
    .map((b, idx) => {
        const start = Number(b?.start_bit);
        const len = Number(b?.bit_len);
        return {
            index: idx,
            id: b?.id,
            name: b?.bit_name || `BIT_${isNonNegInt(start) ? start : idx}`,
            start: isNonNegInt(start) ? start : null,
            len: isPosInt(len) ? len : null,
            defaultVal: Number(b?.default_val),
            signed: b?.signed === true,
            value_table: sanitizeValueTable(b?.value_table)
        };
    })
    .filter(b => b.start !== null && b.len !== null);

/**
 * 构建位网格。byteCount = max(byte_len, 所需字节) —— 溢出位段照常渲染，
 * 免得「看不见超限的段」（容量告警另由 requiredBytes/overflow 表达）。
 * 返回 { bytes, requiredBytes, overflow, conflictBits }，
 * cell = { bitIndex, owner, name, color, conflict }（owner: 段索引或 -1）。
 */
export const buildBitGrid = (bits, byteLen = 1) => {
    const norm = normalizeBits(bits);
    const requiredBytes = norm.reduce((acc, b) => Math.max(acc, Math.ceil((b.start + b.len) / 8)), 0);
    const declared = Number(byteLen);
    const byteCount = Math.max(
        Number.isFinite(declared) && declared > 0 ? Math.ceil(declared) : 1,
        requiredBytes
    );

    // 位号 → 占用它的段索引集合（多占 = 冲突）
    const ownersOf = new Map();
    norm.forEach(b => {
        for (let i = b.start; i < b.start + b.len; i++) {
            if (!ownersOf.has(i)) ownersOf.set(i, []);
            ownersOf.get(i).push(b.index);
        }
    });
    const conflictBits = [...ownersOf.entries()]
        .filter(([, owners]) => owners.length > 1)
        .map(([bit]) => bit)
        .sort((a, b) => a - b);
    const conflictSet = new Set(conflictBits);

    const bytes = [];
    for (let r = 0; r < byteCount; r++) {
        const row = [];
        for (let c = 0; c < 8; c++) {
            const bitIndex = r * 8 + (7 - c);
            const owners = ownersOf.get(bitIndex) || [];
            const ownerIdx = owners.length > 0 ? owners[0] : -1;
            const owner = ownerIdx >= 0 ? norm.find(b => b.index === ownerIdx) : null;
            row.push({
                bitIndex,
                owner: ownerIdx,
                name: owner ? owner.name : '',
                color: owner ? BIT_GRID_COLORS[ownerIdx % BIT_GRID_COLORS.length] : null,
                conflict: conflictSet.has(bitIndex)
            });
        }
        bytes.push(row);
    }

    return { bytes, requiredBytes, byteCount, overflow: requiredBytes > (Number(byteLen) || 0), conflictBits };
};

/**
 * R68：连续位带拼图条的纯布局层 —— 存储口径（start_bit LSB）不变，只做
 * 「一条连续带 + 单位切分 + 字节边界」的展示映射。
 *  - 容量/溢出/conflictBits 一律沿 buildBitGrid（同一真源，改一必改二禁触发）；
 *  - 视角：msb = 文档阅读序（高位在左），lsb = 存储序（bit0 在左）；
 *  - 单位：视角序上连续同主的位并成一块 —— 段 = 拼图块（带名/色/段级冲突），
 *    间隙 = 逐位缺块；段标红按段级传播（被首 owner 压住的重叠段不漏标）。
 * 网格视图照旧走 buildBitGrid，两视图共享存储与打包口径。
 */
export const buildStripLayout = (bits, byteLen = 1, view = 'msb') => {
    const g = buildBitGrid(bits, byteLen);
    const capacity = g.byteCount * 8;
    const norm = normalizeBits(bits);
    const conflictSet = new Set(g.conflictBits);

    // 逐位归属（与网格同口径：首 owner 优先）
    const ownerByBit = new Map();
    norm.forEach((b, idx) => {
        for (let i = b.start; i < b.start + b.len; i++) {
            if (!ownerByBit.has(i)) ownerByBit.set(i, idx);
        }
    });
    // 段级冲突：段占任一冲突位即红（与表格 findOverlaps 同语义）
    const segConflict = new Set();
    norm.forEach((b, idx) => {
        for (let i = b.start; i < b.start + b.len; i++) {
            if (conflictSet.has(i)) segConflict.add(idx);
        }
    });

    // 视角顺序（标尺与单位排布同源）
    const ruler = Array.from({ length: capacity }, (_, i) =>
        (view === 'lsb' ? i : capacity - 1 - i));

    // 单位切分
    const units = [];
    ruler.forEach((bit) => {
        const owner = ownerByBit.has(bit) ? ownerByBit.get(bit) : -1;
        const last = units.length ? units[units.length - 1] : null;
        if (last && last.owner === owner) {
            last.bits.push(bit);
            if (owner >= 0) last.conflict = segConflict.has(owner);
            return;
        }
        units.push(owner < 0
            ? { kind: 'gap', owner: -1, bits: [bit] }
            : {
                kind: 'seg',
                owner,
                name: norm[owner].name,
                color: BIT_GRID_COLORS[owner % BIT_GRID_COLORS.length],
                conflict: segConflict.has(owner),
                bits: [bit]
            });
    });

    // 字节边界竖线：x% = 视角序中界线左侧的位数占比（msb/lsb 镜像）
    const boundaries = [];
    for (let k = 8; k < capacity; k += 8) {
        boundaries.push({
            bit: k,
            xPct: (view === 'lsb' ? k : capacity - k) / capacity * 100
        });
    }

    return {
        capacity,
        byteCount: g.byteCount,
        requiredBytes: g.requiredBytes,
        overflow: g.overflow,
        conflictBits: g.conflictBits,
        units,
        ruler,
        boundaries
    };
};

/**
 * 点击式设段：两格的绝对位号 → { start_bit, bit_len }（方向无关）。
 * 非法输入 → null（调用方不提交位段）。
 */
export const rangeToSegment = (startBit, endBit) => {
    if (!isNonNegInt(startBit) || !isNonNegInt(endBit)) return null;
    const lo = Math.min(startBit, endBit);
    const hi = Math.max(startBit, endBit);
    return { start_bit: lo, bit_len: hi - lo + 1 };
};

// 新位段默认名（按起始位，表格里可改名）
export const defaultSegmentName = (startBit) => `BIT_${startBit}`;

/**
 * 按 default_val 打包成定宽 hex（与 InstructionEncoder 的 BITFIELD 分支、
 * runnerRenderRules.packBitfieldDefault 同口径 —— 镜像测试锁定）。
 */
export const packBits = (bits, byteLen = 1) => {
    let packed = 0;
    normalizeBits(bits).forEach(b => {
        const mask = b.len >= 32 ? 0xFFFFFFFF : ((1 << b.len) - 1);
        const raw = Number.isFinite(b.defaultVal) ? b.defaultVal : 0;
        packed |= (raw & mask) << b.start;
    });
    packed = packed >>> 0;
    const target = Math.max(1, byteLen || 1) * 2;
    return packed.toString(16).toUpperCase().padStart(target, '0').slice(-target);
};

// ───────────────────────── 批 3：加工侧子位录入（拆包 / 回写） ─────────────────────────
// 单一真源 = 字段整数输入值；子位行是派生视图。改子位只重写本段位，
// 间隙位（无主位）与其它段原样保留 → onFieldChange 仍只发一个整数，
// InstructionEncoder 的 BITFIELD 分支零改动。
// 拆包/回写一律走「除模/乘幂」算术而非 JS 32 位位运算：>32 位段不被截断。

const toInt = (v) => (Number.isFinite(v) ? Math.floor(v) : null);

// 本段取值：floor(v / 2^start) % 2^len（start/len 非法 → null）
const segmentValue = (packed, start, len) => {
    if (packed === null) return null;
    return Math.floor(packed / Math.pow(2, start)) % Math.pow(2, len);
};

/** 子位值钳制到本段域；非数 → 0。
 *  优化批 3（DBC signed）：signed 位段按两补码域 [-2^(n-1), 2^(n-1)-1]，
 *  缺省（unsigned）口径不变：0..2^n-1。 */
export const clampBitValue = (v, len, signed = false) => {
    const width = Math.max(1, len || 1);
    const n = toInt(Number(v));
    if (n === null) return 0;
    if (signed) {
        const half = Math.pow(2, width - 1);
        return Math.max(-half, Math.min(half - 1, n));
    }
    const max = Math.pow(2, width) - 1;
    return Math.max(0, Math.min(max, n));
};

// 两补码解读：高位已置位的无符号值 → 负值（仅 signed 调用）。
const toSigned = (v, len) => (
    v >= Math.pow(2, Math.max(1, len) - 1) ? v - Math.pow(2, len) : v
);

// default 的语义解读：已按有符号域存 → 原样；按位模式存（超有符号域）→
// 先钳无符号域再两补码（脏数据/导入的 216 → -40）。unsigned → 旧口径。
const interpretDefault = (raw, len, signed) => {
    const n = Number.isFinite(Number(raw)) ? Math.floor(Number(raw)) : 0;
    if (!signed) return clampBitValue(n, len);
    const half = Math.pow(2, Math.max(1, len - 1));
    if (n >= -half && n <= half - 1) return n;
    return toSigned(clampBitValue(n, len), len);
};

/**
 * 拆包子位行。packed 为 undefined/null → 逐段回退 default_val（与
 * resolveFieldDisplay 的 packBitfieldDefault 同源口径）。
 * 返回 [{ id, name, start, len, signed, min, max, value_table, value, defaultVal }]，
 * 仅含合法位段。优化批 3：signed 段 value/default 按两补码解读，
 * min/max = 有符号域（子位输入钳制直接消费）。
 */
export const unpackBits = (packed, bits) => normalizeBits(bits).map(b => {
    const width = b.len;
    const signed = b.signed === true;
    const half = Math.pow(2, Math.max(1, width - 1));
    const max = signed
        ? half - 1
        : (width >= 32 ? Number.MAX_SAFE_INTEGER : Math.pow(2, width) - 1);
    const min = signed ? -half : 0;
    const fromValue = segmentValue(toInt(packed), b.start, width);
    const fallback = interpretDefault(b.defaultVal, width, signed);
    return {
        id: b.id,
        name: b.name,
        start: b.start,
        len: width,
        signed,
        min,
        max,
        value_table: b.value_table,
        defaultVal: fallback,
        value: fromValue === null
            ? fallback
            : (signed ? toSigned(fromValue, width) : fromValue)
    };
});

/**
 * 回写单个位段：底值 = packed（未录入时取**全部**位段 default_val 的打包值），
 * 先扣掉本段旧值再并入新值 → 其余位/间隙位逐位保持。
 * allBits = 该字段的完整 bits（无输入态的底值靠它，未传则退化为仅本段）。
 * 优化批 3：signed 段的负值先钳有符号域、再转两补码位模式并入。
 */
export const writeBitSegment = (packed, segment, newValue, allBits) => {
    const seg = normalizeBits([segment])[0];
    const base = toInt(packed);
    if (!seg) return base ?? 0;
    const value = clampBitValue(newValue, seg.len, seg.signed === true);
    const unsigned = value < 0 ? value + Math.pow(2, seg.len) : value;
    const place = Math.pow(2, seg.start);
    const source = base === null
        ? parseInt(packBits(Array.isArray(allBits) && allBits.length > 0 ? allBits : [segment],
            Math.ceil((seg.start + seg.len) / 8)), 16) >>> 0
        : base;
    const cleared = source - (segmentValue(source, seg.start, seg.len) || 0) * place;
    return cleared + unsigned * place;
};
