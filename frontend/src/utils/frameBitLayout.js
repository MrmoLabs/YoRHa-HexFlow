// R70（§8.102 二 · 设计层）帧级位布局 —— 含 sub-byte/bit 定义帧的自适应位视图真源。
//
// 纯字节真源 computeByteOffsets 零触碰（presence/varint/COBS/repeat 全套字节语义
// 与指令页共用，改一必炸）。本模块只服务 spec §三「含 sub-byte 帧自动切位视图」：
//   - 偏移尺 bit 粒度：每块 bitOffset = 帧起点起累计绝对 bit 偏移；
//   - 帧总长 = Σ bit_len（spec §二 设计层）；
//   - **紧凑打包**：sub-byte 块不逐块补零，4+4 = 8bit = 1 字节 —— 解 §8.101 十一
//     边界①「非字节对齐子字段不再须并入单一位域块手工重分组」；
//   - packedBytes = ceil(totalBits/8)，尾部不足整字节补零 = tailPadBits（画布灰标 PAD）。
//
// 自适应：hasSubByte（任一叶子声明 bit_len）= true → 画布切位视图；纯字节帧
// false → 沿 computeByteOffsets 字节视图零扰动。
//
// 口径：
//   叶子 bit 宽 = 声明 bit_len 优先（真实 bit 数，sub-byte 允许），否则 byte_length×8；
//   容器 bit 宽 = Σ 子（空 nestable 容器 = 0，与 computeByteOffsets 空组 size=0 同族）；
//   子块 bitOffset 亦为帧级绝对值（容器起点 + 组内相对）。

import { isNestable } from '../config/blockTypes';

// 宽松取正整数（脏库兜底：None/非数/负数/小数 → 0），与 Number() 口径同族。
const asPosInt = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : 0;
};

/**
 * 设计层位布局：给帧（children 树）每个块分配绝对 bit 偏移与 bit 宽。
 * @param {Array} nodes 帧顶层块列表（协议 children；节点含 children/bit_len/byte_length）
 * @returns {{blocks: Map<string,{bitOffset,bitWidth,isContainer}>, totalBits, hasSubByte, packedBytes, tailPadBits}}
 */
export function computeBitFrameLayout(nodes) {
    const blocks = new Map();
    let hasSubByte = false;

    // 叶子 bit 宽：bit_len（真实 bit）优先，否则 byte_length×8。
    const leafBitWidth = (node) => {
        const bitLen = asPosInt(node.bit_len);
        if (bitLen > 0) return bitLen;
        const byteLen = Number(node.byte_length ?? node.byte_len);
        return Number.isFinite(byteLen) && byteLen > 0 ? Math.floor(byteLen) * 8 : 0;
    };

    // 深度优先：返回该列表末尾的绝对 bit 游标（容器宽 = 末 − 起）。
    const walk = (list, absOffset) => {
        let cursor = absOffset;
        (list || []).forEach((node) => {
            const kids = node.children || [];
            const isContainer = isNestable(node.type) || kids.length > 0;
            if (isContainer) {
                const start = cursor;
                const end = walk(kids, cursor);
                blocks.set(node.id, { bitOffset: start, bitWidth: end - start, isContainer: true });
                cursor = end;
            } else {
                const width = leafBitWidth(node);
                if (asPosInt(node.bit_len) > 0) hasSubByte = true;
                blocks.set(node.id, { bitOffset: cursor, bitWidth: width, isContainer: false });
                cursor += width;
            }
        });
        return cursor;
    };

    const totalBits = walk(nodes, 0);
    const packedBytes = Math.ceil(totalBits / 8);
    const tailPadBits = packedBytes * 8 - totalBits;

    return { blocks, totalBits, hasSubByte, packedBytes, tailPadBits };
}
