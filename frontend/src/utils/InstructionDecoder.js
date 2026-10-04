import { alignPadLen, padSpec, padToPadLen } from './padSpec';
import { unscrambleHex } from './scramble';
import { InstructionEncoder } from './InstructionEncoder';

// R9（PLAN §8.46 · §8.37 R9 行 · C-2 选 B 前半）：**bytes → fields 解码器**。
//
// 编码一直是单向的（全仓 decodeFields / decodeResponse 0 命中）：发「读电压」收到
// `4048F5C3 …`，页面只给 MATCH OK + raw hex，人要自己心算成 3.14。本模块是
// `InstructionEncoder` 的**对偶**：
//
//   · **布局共用** —— 树遍历直接用 `InstructionEncoder.buildLayout`（同 roots /
//     childrenOf），组 align / pad_to / repeat / presence 逐字镜像 `emitNode`；
//     叶字节长度用 `getFieldBytes` **量**（长度随 op/参数而定，编码器是唯一真相源），
//     值再从响应帧里**读**。改一必改二。
//   · **值解码分派与 `_encodeFieldBytes` 同序** —— STRING / float / HEX_RAW /
//     BITFIELD / INT_SIGNED(两补码) / BCD / FLOAT_IEEE(大端) / 缺省无符号 +
//     SCALED_DECIMAL 反定标；LITTLE 先整体还原（对偶 `getFieldBytes` 的 wrapper）。
//   · **presence / repeat / now 走同一份值链** —— 调用方给了 inputs 就与编码期完全
//     一致；没给（真机应答）走静态链，`_presenceHit` fail-open → 缺省照读，不吞字节。
//
// 拍板（§8.36 C-2 选 B）要求"拿 vectors/*.json 反向验证" —— 见
// `__tests__/InstructionDecoder.test.js` 的 encode(decode(x)) === x 不动点断言。
// 本批**只做展示**（零 DDL、零后端改动），入库回写 = R10。

const hexOf = (bytes) =>
    bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0').toUpperCase()).join('');

// 大端读数：≤6 字节走 Number（2^48 < 2^53，精确）；更宽走 BigInt 防精度丢失，
// 超过 Number.MAX_SAFE_INTEGER 时退回十进制字符串（只展示，不参与运算）。
const bigEndianNumber = (bytes) => {
    if (bytes.length <= 6) {
        let n = 0;
        for (const b of bytes) n = n * 256 + (b & 0xff);
        return n;
    }
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b & 0xff);
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString();
};

const isScaledNumeric = (params) =>
    ['', 'number'].includes(String(params.type ?? '').toLowerCase());

// 与编码器 SCALED_DECIMAL 同款解析（factor/offset 空缺非有限 → 1/0）。
const scaleParams = (params) => {
    const toNum = (x) => (typeof x === 'number' ? x : Number(String(x ?? '').trim()));
    const offRaw = (params.offset === undefined || params.offset === null || params.offset === '')
        ? NaN : toNum(params.offset);
    const facRaw = (params.factor === undefined || params.factor === null || params.factor === '')
        ? NaN : toNum(params.factor);
    return {
        off: Number.isFinite(offRaw) ? offRaw : 0,
        fac: Number.isFinite(facRaw) ? facRaw : 1
    };
};

/**
 * 展示层取值格式化：数字原样（`3.14` 而非 `"3.14"`）、文本带引号并剥掉定长补齐的
 * NUL / 尾空格（**解码值本身不剥** —— round-trip 要求补齐字节原样带回去）。
 * 补齐字符逐码元判断（不用控制字符正则，免踩 no-control-regex）。
 */
const stripPad = (text) => {
    let end = text.length;
    while (end > 0 && (text.charCodeAt(end - 1) === 0x00 || text.charCodeAt(end - 1) === 0x20)) end -= 1;
    return text.slice(0, end);
};

export const formatFieldValue = (value) => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'number') {
        const s = String(value);
        // float32 走一趟 double 会带出 3.1399998664855957 这类尾噪 —— 展示层按
        // 7 位有效数字收敛成 3.14（拍板举例就是 `voltage = 3.14 V`）；**解码值
        // 本身不动**，round-trip 仍以原值为准。只在真的变短时才换写法，
        // 且整数 / 超 1e10 的值不碰（免得 12345678901 被写成 12345680000）。
        if (!Number.isInteger(value) && Number.isFinite(value) && Math.abs(value) < 1e10) {
            const shaped = String(Number(value.toPrecision(7)));
            if (shaped.length < s.length) return shaped;
        }
        return s;
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'boolean') return String(value);
    const stripped = stripPad(String(value));
    return JSON.stringify(stripped);
};

/** 历史行预览用：`voltage = 3.14 · mode = "OK"`。空解码 → ''。 */
export const fieldsText = (decoded) =>
    (decoded?.fields || [])
        .map((f) => `${f.name} = ${formatFieldValue(f.value)}`)
        .join(' · ');

export const InstructionDecoder = {
    /**
     * 单叶解码：`bytes` = 帧里该叶的原始字节（长度已由布局量出）。
     * 分派顺序与 `InstructionEncoder._encodeFieldBytes` 一一对应，改一必改二。
     */
    decodeFieldBytes: function (field, bytes) {
        if (!bytes || bytes.length === 0) return null;
        const params = field.parameter_config || {};
        const op = field.op_code;

        // LITTLE 还原（对偶 getFieldBytes：组容器整体不逆序）
        let b = [...bytes];
        const isGroup = (field.fields && field.fields.length > 0)
            || (field.children && field.children.length > 0);
        if (!isGroup && b.length > 1 && String(field.endianness || '').toUpperCase() === 'LITTLE') {
            b.reverse();
        }

        // 0. 静态 hex（FIXED / HEADER / TAIL / HEX_RAW / 协议叶 hex_value）
        const staticHex = field.hex_value || params.hex;
        if (staticHex && (op === 'FIXED' || op === 'HEADER' || op === 'TAIL'
            || op === 'HEX_RAW' || !op)) {
            return hexOf(b);
        }

        // 0.5 R25 (§8.57): SCRAMBLE —— 线上是**加扰字节**，先反加扰再交回明文 hex：
        // XOR 自反、左旋的逆是右旋 → encode(decode(x)) 是不动点（定点断言对 SCRAMBLE
        // 仍成立）。不反变换就只能把密文当值显示，人看不出明文是什么。
        if (op === 'SCRAMBLE') return unscrambleHex(hexOf(b), params);

        // 1. 文本（对偶 STRING 分支：utf8 走 TextDecoder，否则逐字节 code unit）
        if (op === 'STRING' || params.type === 'string') {
            if (String(params.encoding ?? 'ascii').toLowerCase() === 'utf8') {
                return new TextDecoder('utf-8').decode(Uint8Array.from(b));
            }
            return b.map((c) => String.fromCharCode(c & 0xff)).join('');
        }

        // 2. 旧 float/decimal 路径（编码 = 平台小端 Float32 → 整体逆序出大端）
        if (params.type === 'float' || params.type === 'decimal') {
            const arr = Uint8Array.from([...b].reverse());
            return new Float32Array(arr.buffer, 0, 1)[0];
        }

        // 3. 纯 hex
        if (op === 'HEX_RAW' || params.type === 'hex') return hexOf(b);

        // 3.5 BITFIELD → 聚合整数（编码侧 Σ(default << start) 打包）
        if (op === 'BITFIELD') return bigEndianNumber(b);

        // 4. INT_SIGNED 两补码（与 encode 的 BigInt mask 对偶）
        if (op === 'INT_SIGNED') {
            const bits = BigInt(b.length * 8);
            let n = 0n;
            for (const x of b) n = (n << 8n) | BigInt(x & 0xff);
            if (n >= (1n << (bits - 1n))) n -= 1n << bits;
            return Number(n);
        }

        // 5. BCD packed BCD → 十进制数字
        if (op === 'BCD_CODE') {
            let digits = '';
            for (const x of b) {
                const hi = (x >> 4) & 0x0f;
                const lo = x & 0x0f;
                // 编码只产 0..9 nibble；出现 A..F = 非本编码器产物 → 原样 hex 诚实回报
                if (hi > 9 || lo > 9) return hexOf(b);
                digits += String(hi) + String(lo);
            }
            if (!digits) return 0;
            return digits.length <= 15 ? Number(digits) : digits;
        }

        // 6. FLOAT_IEEE 大端（网络序 → 平台小端数组）
        if (op === 'FLOAT_IEEE' && (b.length === 4 || b.length === 8) && isScaledNumeric(params)) {
            const arr = Uint8Array.from([...b].reverse());
            return b.length === 8
                ? new Float64Array(arr.buffer, 0, 1)[0]
                : new Float32Array(arr.buffer, 0, 1)[0];
        }

        // 7. 缺省无符号整数 → 再做 SCALED_DECIMAL **反定标**
        let n = bigEndianNumber(b);
        if (op === 'SCALED_DECIMAL' && isScaledNumeric(params)) {
            const { off, fac } = scaleParams(params);
            const raw = typeof n === 'number' ? n : Number(n);
            const unscaled = raw / fac - off;
            n = Number.isFinite(unscaled) ? unscaled : 0;
        }
        return n;
    },

    /**
     * 主入口：按 `instruction.fields` 的字段布局把一帧 hex 还原成 `字段 = 值`。
     *
     * opts 同编码器（`inputs` / `computedValues` / `now`）——给全则与编码期逐字一致；
     * 不给（真机应答）走静态链。返回 `{fields, consumed, total, residual, warnings}`：
     * `residual` = 帧尾未映射到任何字段的字节数，`warnings` 里说明短帧 / 多余字节，
     * 让"帧长与字段布局不一致"这件事**看得见**而不是静默出错值。
     */
    decodeInstruction: function (instruction, hex, opts) {
        const warnings = [];
        const empty = { fields: [], consumed: 0, total: 0, residual: 0, warnings };
        if (!instruction || !hex) return empty;

        const raw = String(hex).replace(/\s/g, '');
        if (!raw) return empty;
        if (!/^[0-9A-Fa-f]*$/.test(raw)) {
            return { ...empty, warnings: ['响应含非十六进制字符，无法解码'] };
        }
        if (raw.length % 2 !== 0) warnings.push('响应 hex 为奇数位，末半字节已丢弃');

        const bytes = InstructionEncoder.parseHexBytes(raw);
        const total = bytes.length;
        const inputs = opts?.inputs || {};
        const computed = opts?.computedValues || {};
        const now = Number.isFinite(opts?.now) ? opts.now : Date.now();

        const { allFields, roots, childrenOf } = InstructionEncoder.buildLayout(instruction);
        const fields = [];
        let cursor = 0;
        let short = false;

        // 逐字镜像 encodeInstruction 的 emitNode：presence 先于 repeat；组对齐补零
        // 在首副本前一次、pad_to 在末副本后一次；叶按 copies 逐份 align → 内容 → pad。
        const walk = (field, copies) => {
            if (copies <= 0) return;
            if (!InstructionEncoder._presenceHit(field, inputs, computed, allFields)) return;
            const kids = childrenOf(field);
            if (kids) {
                const n = InstructionEncoder._repeatCount(field, inputs, computed, allFields) * copies;
                if (n <= 0) return;
                const gspec = padSpec(field.parameter_config);
                cursor += alignPadLen(cursor, gspec.align);
                for (let c = 0; c < n; c++) kids.forEach((k) => walk(k, 1));
                cursor += padToPadLen(cursor, gspec.padTo);
                if (cursor > total) cursor = total;
                return;
            }

            // 叶：**长度向编码器要**（对偶的结构基准），**值从帧里读**。
            const probe = InstructionEncoder.getFieldBytes(field, inputs, computed, allFields, now);
            const byteLen = probe.length;
            if (byteLen <= 0) return;
            const lspec = padSpec(field.parameter_config);
            for (let c = 0; c < copies; c++) {
                cursor += alignPadLen(cursor, lspec.align);
                const take = Math.min(byteLen, Math.max(0, total - cursor));
                const slice = bytes.slice(cursor, cursor + take);
                if (take < byteLen) short = true;
                fields.push({
                    fieldId: field.id,
                    name: field.name || field.id,
                    opCode: field.op_code || '',
                    byteLen,
                    start: cursor,
                    end: cursor + take,
                    truncated: take < byteLen,
                    value: this.decodeFieldBytes(field, slice)
                });
                cursor += take;
                cursor += padToPadLen(cursor, lspec.padTo);
                if (cursor > total) cursor = total;
            }
        };

        roots.forEach((f) => walk(f, 1));

        const residual = Math.max(0, total - cursor);
        if (short) warnings.push(`响应比字段布局短：从第 ${cursor} 字节起不足，尾部字段未解出`);
        if (residual > 0) warnings.push(`响应尾部多出 ${residual} 字节未映射到任何字段`);

        return { fields, consumed: cursor, total, residual, warnings };
    }
};

export default InstructionDecoder;
