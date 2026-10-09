/**
 * R70（§8.102）位真帧 · 全帧 bit 流打包器（纯函数层，设计层 SSOT = bit）。
 *
 * 为什么字符串按位、不走 packBits 的整数位运算：`bitGrid.packBits` 用 JS
 * `<< start`，start≥32 即回绕截断（32 位位运算上限）——全帧可达数十上百 bit，
 * 故帧级拼接一律走**字符串/数组按位**，>32bit 不截断（红测 40bit 用例锁定）。
 *
 * 双层模型（§8.102 二）：本层只做**设计层 bit 真值 → 打包字节**的过渡映射；
 * 线上层（dispatch/bundle）仍发打包后字节，字节 SSOT 保留。
 *
 * 位序约定（改一必改二）：
 *  - **文档序 = MSB-first**：byte0 在左、byte 内 bit7 在左（人读/卡面所见即所得）；
 *  - **段内 bit = LSB 起**：start_bit bit0 = 段内最低位（存储口径零触碰，
 *    与 bitGrid / InstructionEncoder / backend bitfield 同源）；
 *  - 块文档 bit 串 = 段按 start_bit 落位后，从高位（extent-1）到低位（0）排布。
 */

// 取低 n 位的 MSB-first 文档串（算术取位，不触 32 位位运算）。
// segmentBitsFromValue(10, 4) → '1010'（10 = 0b1010）。
export const segmentBitsFromValue = (value, bitLen) => {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    const w = Math.max(0, Math.floor(Number(bitLen) || 0));
    let out = '';
    for (let i = w - 1; i >= 0; i--) {
        out += (Math.floor(n / Math.pow(2, i)) % 2) ? '1' : '0';
    }
    return out;
};

// 非法/空 hex → null（调用方回落 byte_length×8 占位零位）。
const hexToBits = (h) => {
    const clean = String(h ?? '').replace(/\s/g, '').toUpperCase();
    if (!clean || /[^0-9A-F]/.test(clean)) return null;
    return clean.split('').map(d => parseInt(d, 16).toString(2).padStart(4, '0')).join('');
};

/**
 * 单块 → 文档 bit 串。返回 { bits, extent }（extent = bits.length）。
 *  - bitfield 块：段按 start_bit 落位到 extent 宽（declared bit_len 优先，
 *    否则 byte_length×8，否则按段所需 max(start+len)）；空隙/溢出裁剪为 0；
 *  - hex 家族（hex/fixed）：hex 值逐 nibble 展开（extent = hex 位数）；
 *  - 其余（length/checksum/slot 等计算块）：byte_length×8 占位零位（真值
 *    发射期由算法算，本层只认位宽参与拼接）。
 */
export const blockBitString = (block) => {
    if (!block || typeof block !== 'object') return { bits: '', extent: 0 };
    const type = String(block.type || '').toLowerCase();

    if (type === 'bitfield') {
        const segs = (Array.isArray(block.bits) ? block.bits : [])
            .filter(b => b && typeof b === 'object')
            .map(b => ({
                start: Number(b.start_bit),
                len: Math.max(1, Number(b.bit_len) || 1),
                val: Number.isFinite(Number(b.default_val)) ? Math.floor(Number(b.default_val)) : 0
            }))
            .filter(s => Number.isInteger(s.start) && s.start >= 0);
        const required = segs.reduce((acc, s) => Math.max(acc, s.start + s.len), 0);
        const declaredBits = Number(block.bit_len);
        const declaredBytes = Number(block.byte_length);
        const declared = Number.isInteger(declaredBits) && declaredBits > 0
            ? declaredBits
            : (Number.isFinite(declaredBytes) && declaredBytes > 0 ? Math.floor(declaredBytes) * 8 : 0);
        const extent = Math.max(declared, required);
        if (extent <= 0) return { bits: '', extent: 0 };
        const arr = new Array(extent).fill('0');
        segs.forEach(s => {
            for (let k = 0; k < s.len; k++) {
                const bitIdx = s.start + k; // 段内 LSB 起的绝对位号
                if (bitIdx < extent) {
                    const bitVal = Math.floor(s.val / Math.pow(2, k)) % 2;
                    arr[extent - 1 - bitIdx] = bitVal ? '1' : '0'; // LSB → 文档右端
                }
            }
        });
        return { bits: arr.join(''), extent };
    }

    // hex 家族：hex 值即文档 bit 串（每 nibble 4bit、MSB-first、byte0 在左）
    const bits = hexToBits(block.hex_value ?? block.parameter_config?.hex);
    if (bits !== null) return { bits, extent: bits.length };

    // 计算块 / 空值：byte_length×8 占位零位
    const bl = Number(block.byte_length ?? block.byte_len);
    const extent = Number.isFinite(bl) && bl > 0 ? Math.floor(bl) * 8 : 0;
    return { bits: '0'.repeat(extent), extent };
};

/**
 * 全帧 bit 流打包：各块文档 bit 串按序拼接 → ceil 字节，尾部补零标 PAD。
 * 返回 { bitLen（未补位真实 bit 数）, padBits, hex（大写无空格）, bytes }。
 * 空帧 → { bitLen:0, padBits:0, hex:'', bytes:0 }。
 */
export const packFrameBitStream = (blocks) => {
    const list = Array.isArray(blocks) ? blocks : [];
    let frame = '';
    list.forEach(b => { frame += blockBitString(b).bits; });
    const bitLen = frame.length;
    const padBits = (8 - (bitLen % 8)) % 8;
    const padded = frame + '0'.repeat(padBits);
    const byteArr = padded ? padded.match(/.{1,8}/g) : [];
    const hex = (byteArr || [])
        .map(b => parseInt(b, 2).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
    return { bitLen, padBits, hex, bytes: (byteArr || []).length };
};
