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

/** 子位值钳制到本段域；非数 → 0（0..2^n-1）。 */
export const clampBitValue = (v, len) => {
    const width = Math.max(1, len || 1);
    const n = toInt(Number(v));
    if (n === null) return 0;
    const max = Math.pow(2, width) - 1;
    return Math.max(0, Math.min(max, n));
};

/**
 * 拆包子位行。packed 为 undefined/null → 逐段回退 default_val（与
 * resolveFieldDisplay 的 packBitfieldDefault 同源口径）。
 * 返回 [{ id, name, start, len, value, defaultVal }]，仅含合法位段。
 */
export const unpackBits = (packed, bits) => normalizeBits(bits).map(b => {
    const fromValue = segmentValue(toInt(packed), b.start, b.len);
    const fallback = clampBitValue(b.defaultVal, b.len);
    return {
        id: b.id,
        name: b.name,
        start: b.start,
        len: b.len,
        defaultVal: fallback,
        value: fromValue === null ? fallback : fromValue
    };
});

/**
 * 回写单个位段：底值 = packed（未录入时取**全部**位段 default_val 的打包值），
 * 先扣掉本段旧值再并入新值 → 其余位/间隙位逐位保持。
 * allBits = 该字段的完整 bits（无输入态的底值靠它，未传则退化为仅本段）。
 */
export const writeBitSegment = (packed, segment, newValue, allBits) => {
    const seg = normalizeBits([segment])[0];
    const base = toInt(packed);
    if (!seg) return base ?? 0;
    const value = clampBitValue(newValue, seg.len);
    const place = Math.pow(2, seg.start);
    const source = base === null
        ? parseInt(packBits(Array.isArray(allBits) && allBits.length > 0 ? allBits : [segment],
            Math.ceil((seg.start + seg.len) / 8)), 16) >>> 0
        : base;
    const cleared = source - (segmentValue(source, seg.start, seg.len) || 0) * place;
    return cleared + value * place;
};
