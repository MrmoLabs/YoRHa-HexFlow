/**
 * Simple formula evaluator for protocol fields.
 * Resolves [FieldName] to byte_len and evaluates math.
 */
export function evaluateFormula(formula, symbolTable) {
    if (!formula || typeof formula !== 'string') return 0;

    try {
        // 1. Resolve [Name] to value
        let processed = formula.replace(/\[([^\]]+)\]/g, (match, name) => {
            const val = symbolTable[name];
            return val !== undefined ? val : 0;
        });

        // 2. Sanitize: only allow numbers, math operators, spaces, parentheses, decimals
        if (/[^0-9+\-*/().\s]/.test(processed)) {
            console.warn("Invalid characters in formula:", processed);
            return 0;
        }

        // 3. Evaluate
        const result = new Function(`return (${processed})`)();

        return typeof result === 'number' && !isNaN(result) ? Math.floor(result) : 0;
    } catch (err) {
        console.error("Formula Eval Error:", err);
        return 0;
    }
}

/**
 * Formats a number to HEX string with specified byte length.
 * e.g. (12, 2) -> "00 0C"
 */
export function formatToHex(value, byteLen) {
    // Standard integer hex formatting
    const hex = Math.abs(Math.floor(value)).toString(16).toUpperCase();
    const targetLen = byteLen * 2;
    const padded = hex.padStart(targetLen, '0').slice(-targetLen);
    return padded.match(/.{1,2}/g)?.join(' ') || padded;
}

/**
 * 设计期未知占位：按字节数出等量 "??"（1B → "??"、2B → "?? ??"、
 * 4B → "?? ?? ?? ??"），替代固定单个 "??"——占位宽度与字段真实
 * 占据的字节数一致，读卡时一眼能看出该字段有几字节未知。
 * byteLen 缺失/非法/小于1 → 按 1 字节出 "??"。
 */
export function formatUnknown(byteLen) {
    const n = Math.floor(Number(byteLen));
    const count = Number.isFinite(n) && n >= 1 ? n : 1;
    return Array(count).fill('??').join(' ');
}

/**
 * IEEE 754 Floating Point to Hex
 * byteLen=4 → Float32（8 hex）、byteLen=8 → Float64（16 hex），缺省 4（存量调用
 * 逐字符不变）；其余长度一律按 f32。
 *
 * 注意口径：这里是**裸位型转换**（value 非有限就写出 ±Inf/NaN 位型），与
 * 指令编码器 InstructionEncoder 的 FLOAT_IEEE 分支**不同** —— 那边先走统一解析
 * 口径、非有限一律归 0（BE `_float_number` 同款）。改口径请一并改两端与
 * vectors/float_ieee.json。
 */
export function formatFloatToHex(value, byteLen = 4) {
    const farr = byteLen === 8 ? new Float64Array(1) : new Float32Array(1);
    farr[0] = value;
    const barr = new Uint8Array(farr.buffer);
    // Standardizing on Big Endian (Network order). Barr is usually Little Endian on x86.
    return Array.from(barr).reverse()
        .map(b => b.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
}

// --- CHECKSUM ALGORITHMS ---

export const ChecksumAlgo = {
    SUM_8: 'SUM_8',
    XOR_8: 'XOR_8',
    CRC_16_MODBUS: 'CRC_16_MODBUS',
    // R22 (§8.52 排期 · CRC 多算法): CRC_32 由「声明未实现」转正，CRC_16_CCITT /
    // LRC 新增。值域 = 后端 response_match.VALID_ALGOS 的 FE 编码，六值必须与
    // blockTypes.algo.options / validateProtocol.VALID_ALGOS / toFrameBlocks.
    // BACKEND_ALGO / sequenceView.PLAN_ALGO 同批成对改（**顺序也须一致**）。
    CRC_16_CCITT: 'CRC_16_CCITT',
    CRC_32: 'CRC_32',
    LRC: 'LRC'
};

export function calculateChecksum(algo, dataBytes) {
    if (!dataBytes || dataBytes.length === 0) return 0;

    switch (algo) {
        case ChecksumAlgo.SUM_8:
            return dataBytes.reduce((a, b) => (a + b) & 0xFF, 0);

        case ChecksumAlgo.XOR_8:
            return dataBytes.reduce((a, b) => a ^ b, 0);

        case ChecksumAlgo.CRC_16_MODBUS: {
            let crc = 0xFFFF;
            for (let i = 0; i < dataBytes.length; i++) {
                crc ^= dataBytes[i];
                for (let j = 0; j < 8; j++) {
                    if ((crc & 1) !== 0) {
                        crc = (crc >> 1) ^ 0xA001;
                    } else {
                        crc = crc >> 1;
                    }
                }
            }
            return crc;
        }

        case ChecksumAlgo.CRC_16_CCITT: {
            // R22 (§8.52 排期): CCITT-FALSE —— poly 0x1021 / init 0xFFFF / 非反射
            // (refin=refout=false) / xorout 0；check "123456789" → 0x29B1。
            // 与后端 checksum.crc16_ccitt、response_match.crc16_ccitt 逐位同源。
            let crc = 0xFFFF;
            for (let i = 0; i < dataBytes.length; i++) {
                crc ^= dataBytes[i] << 8;
                for (let j = 0; j < 8; j++) {
                    crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
                }
            }
            return crc;
        }
        case ChecksumAlgo.CRC_32: {
            // R22: CRC-32/ISO-HDLC —— 反射 poly 0xEDB88320 / init=xorout
            // 0xFFFFFFFF；check "123456789" → 0xCBF43926。三端同源。
            let crc = 0xFFFFFFFF;
            for (let i = 0; i < dataBytes.length; i++) {
                crc ^= dataBytes[i];
                for (let j = 0; j < 8; j++) {
                    crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xEDB88320) >>> 0 : crc >>> 1;
                }
            }
            return (crc ^ 0xFFFFFFFF) >>> 0;
        }
        case ChecksumAlgo.LRC:
            // R22: 8 位和的二进制补码，恒单字节值；check "123456789" → 0x23。
            return (-dataBytes.reduce((a, b) => (a + b) & 0xFF, 0)) & 0xFF;

        // Add more as needed
        default:
            console.warn(`Unknown Checksum Algo: ${algo}, returning 0`);
            return 0;
    }
}
