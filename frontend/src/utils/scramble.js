// R25（PLAN §8.57 · §8.52 排期第 5 批 · BUSINESS_SCENARIOS 挂账 ②）：加扰 / 混淆字段。
//
// 语义：字段**明文**（`parameter_config.hex`，与 HEX_RAW 同源同规则）出线前按 mode 变换，
// 线上字节不是明文，设备端按同一算法还原 —— 由此把「手算异或常数、肉眼记旋转值」这类
// 易错劳动交给算子，字段语义照旧可读（而不是在 hex 框里存一个查不到来由的魔数）。
//
// 两种模式（本文件是**双端口径的中文档案**，BE `core/orchestrator.encode_scramble`
// 逐行同语义，改一必改二）：
//   · XOR_SEED  out[i] = plain[i] ^ seed[i % len(seed)]   —— 种子按字节**循环**，长度任意
//   · BIT_ROLL  out[i] = (plain[i] << n | plain[i] >> (8-n)) & 0xFF  —— 逐字节**左旋** n 位
//
// 契约外 fail-open（保存侧双端硬拦在先，这里只为「出线必有确定值」，不静默改语义）：
//   · mode 不在两值内 / seed 空·奇长·非 hex / roll 非有限数 → **恒等**（明文原样出线）；
//   · 明文为空或非 hex → 两端都回落 byte_len 补零（BE `hex_value or "00"*byte_length`、
//     FE 显式补零，逐字节相同）；
//   · 明文奇长 → **丢弃末尾半字节**（Python `bytes.fromhex` 拒绝奇长，两端同一取舍）。
//
// 反向 `unscrambleHex` 只给解码器用：XOR 自反、左旋的逆是右旋 → encode(decode(x)) 是
// 不动点（InstructionDecoder 的定点断言对 SCRAMBLE 仍然成立）。

/** 合法模式（顺序即算子模板下拉顺序）。 */
export const SCRAMBLE_MODES = ['XOR_SEED', 'BIT_ROLL'];

/** 缺省模式 = 算子模板首项（新建/切换播种同源）。 */
export const DEFAULT_SCRAMBLE_MODE = 'XOR_SEED';

const HEX_PAIR = /^[0-9A-Fa-f]+$/;
// 十进制字面量（**不接受 0x/0b/Infinity** —— JS Number('0x10')=16 而 Python
// float('0x10') 抛错，不加这道闸两端会各判各的）。
const NUMERIC = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/** 去掉 hex 文本里的所有空白（两端同口径）。 */
export const cleanHexText = (text) => String(text ?? '').replace(/\s/g, '');

/** 明文是否**非空且全 hex**（空/非 hex → 两端都回落补零，见文件头）。 */
export const isValidPlainHex = (text) => {
    const c = cleanHexText(text);
    return c !== '' && HEX_PAIR.test(c);
};

/** 明文 → 字节数组；空 / 非 hex → []（奇长丢末尾半字节）。 */
export const plainHexBytes = (text) => {
    const c = cleanHexText(text);
    if (c === '' || !HEX_PAIR.test(c)) return [];
    const s = c.length % 2 ? c.slice(0, -1) : c;
    const out = [];
    for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
    return out;
};

/** 字节数组 → 大写 hex（无空白）。 */
export const hexOfBytes = (bytes) => bytes
    .map((b) => (Number(b) & 0xFF).toString(16).toUpperCase().padStart(2, '0'))
    .join('');

/** 模式归一：trim + 大写；不在册 → null（校验报错、编码恒等）。 */
export const normalizeScrambleMode = (mode) => {
    const m = String(mode ?? DEFAULT_SCRAMBLE_MODE).trim().toUpperCase();
    return SCRAMBLE_MODES.includes(m) ? m : null;
};

/** XOR 种子 → 字节数组；空 / 奇长 / 非 hex → []（= 恒等）。 */
export const scrambleSeedBytes = (seed) => plainHexBytes(seed);

/** 位旋转位数 → 0..7（含负值双取模，与 BE `((n % 8) + 8) % 8` 同口径）；非有限 → 0。 */
export const scrambleRollBits = (roll) => {
    const s = typeof roll === 'string' ? roll.trim() : String(roll).trim();
    if (!NUMERIC.test(s)) return 0;
    const n = Number(s);
    if (!Number.isFinite(n)) return 0;
    const t = Math.trunc(n);
    return ((t % 8) + 8) % 8;
};

/** 加扰（出线方向）。 */
export const scrambleBytes = (bytes, params = {}) => {
    const src = Array.isArray(bytes) ? bytes : [];
    const mode = normalizeScrambleMode(params.mode);
    if (mode === null) return src.slice(); // 契约外 mode → 恒等（保存侧已硬拦）
    if (mode === 'BIT_ROLL') {
        const n = scrambleRollBits(params.roll);
        if (n === 0) return src.slice();
        return src.map((b) => (((b << n) | (b >>> (8 - n))) & 0xFF));
    }
    const seed = scrambleSeedBytes(params.seed);
    if (seed.length === 0) return src.slice(); // 种子空/非法 → 恒等（= seed 00）
    return src.map((b, i) => b ^ seed[i % seed.length]);
};

/** 反加扰（解码器方向）：XOR 自反、左旋的逆 = 右旋 (8-n)%8。 */
export const unscrambleBytes = (bytes, params = {}) => {
    const src = Array.isArray(bytes) ? bytes : [];
    const mode = normalizeScrambleMode(params.mode);
    if (mode === null) return src.slice();
    if (mode === 'BIT_ROLL') {
        const n = (8 - scrambleRollBits(params.roll)) % 8;
        if (n === 0) return src.slice();
        return src.map((b) => (((b << n) | (b >>> (8 - n))) & 0xFF));
    }
    const seed = scrambleSeedBytes(params.seed);
    if (seed.length === 0) return src.slice();
    return src.map((b, i) => b ^ seed[i % seed.length]);
};

/** 明文 hex → 加扰后 hex（大写无空白）。 */
export const scrambleHex = (plainHex, params = {}) => hexOfBytes(scrambleBytes(plainHexBytes(plainHex), params));

/** 线上 hex → 明文 hex（解码器用）。 */
export const unscrambleHex = (wireHex, params = {}) => hexOfBytes(unscrambleBytes(plainHexBytes(wireHex), params));

/**
 * 加扰参数校验（**与 BE `routers/instruction.py::_scramble_param_error` 同口径**，
 * 改一必改二）：返回错误文案（供面板 error 列表）或 null（通过）。
 *
 * 只判**当前生效模式**需要的参数：XOR_SEED 看 seed、BIT_ROLL 看 roll —— 另一个模式的
 * 参数留空是合法的（下拉切回来即生效）。
 */
export const scrambleParamError = (params = {}) => {
    const modeRaw = String(params.mode ?? DEFAULT_SCRAMBLE_MODE).trim().toUpperCase();
    if (!SCRAMBLE_MODES.includes(modeRaw)) {
        return `加扰模式无效（mode=${String(params.mode ?? '')}）：仅支持 ${SCRAMBLE_MODES.join(' / ')}`;
    }
    if (modeRaw === 'XOR_SEED') {
        const seed = cleanHexText(params.seed);
        if (!seed || !HEX_PAIR.test(seed) || seed.length % 2 !== 0) {
            return `XOR 种子无效（seed=${String(params.seed ?? '')}）：需非空、偶数位十六进制（如 A5 / 5AA5）`;
        }
        return null;
    }
    const rollRaw = String(params.roll ?? '').trim();
    if (!NUMERIC.test(rollRaw) || !Number.isFinite(Number(rollRaw))) {
        return `位旋转位数无效（roll=${String(params.roll ?? '')}）：需有限十进制整数（0..7，超出按 mod 8 归一）`;
    }
    return null;
};
