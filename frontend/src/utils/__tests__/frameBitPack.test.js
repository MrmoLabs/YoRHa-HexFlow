/**
 * R70（§8.102）位真帧 · 红测第 1 轮 —— 全帧 bit 流打包器（纯函数层）。
 *
 * 契约（用户 10bit 帧样例驱动）：
 *  - 文档序 = MSB-first（高位在左，byte0 在左、byte 内 bit7 在左）；
 *  - 段内 bit 仍 LSB 起（start_bit bit0 = LSB，存储口径零触碰）；
 *  - 帧 = 各块文档 bit 串按序拼接 → 打包成 ceil 字节，尾部补零标 PAD；
 *  - 字符串按位打包（不走 JS 32 位位运算）→ 40bit+ 帧不截断。
 */

import { describe, it, expect } from 'vitest';
import bitTrueVec from '../../../../vectors/bit_true_frame.json';
import {
    packFrameBitStream,
    blockBitString,
    segmentBitsFromValue
} from '../frameBitPack';

describe('frameBitPack（R70 位真帧打包器）', () => {
    it('segmentBitsFromValue：取低 n 位、MSB-first 文档序', () => {
        expect(segmentBitsFromValue(10, 4)).toBe('1010'); // 10 = 0b1010
        expect(segmentBitsFromValue(1, 1)).toBe('1');
        expect(segmentBitsFromValue(0, 6)).toBe('000000');
        expect(segmentBitsFromValue(0b010101, 6)).toBe('010101');
    });

    it('bitfield 块：段按 start_bit 落位 → 文档 bit 串（MSB-first）', () => {
        // 4bit 版本字段（bit0..3，值 10=0b1010）单独成块 bit_len=4
        const blk = {
            type: 'bitfield',
            bit_len: 4,
            bits: [{ bit_name: 'VER', start_bit: 0, bit_len: 4, default_val: 10 }]
        };
        const { bits, extent } = blockBitString(blk);
        expect(extent).toBe(4);
        expect(bits).toBe('1010');
    });

    it('bitfield 块：段跨 start_bit 落位正确（LSB 存储 → MSB 文档序）', () => {
        // 一个 8bit 块：低 4bit = 标志 0b1010，高 4bit = 版本 0b0011
        const blk = {
            type: 'bitfield',
            byte_length: 1,
            bits: [
                { bit_name: 'FLAG', start_bit: 0, bit_len: 4, default_val: 0b1010 },
                { bit_name: 'VER', start_bit: 4, bit_len: 4, default_val: 0b0011 }
            ]
        };
        const { bits, extent } = blockBitString(blk);
        expect(extent).toBe(8);
        expect(bits).toBe('00111010'); // 高4=VER 0011, 低4=FLAG 1010
    });

    it('hex 块：hex 值 → 文档 bit 串（每 nibble 4bit、MSB-first）', () => {
        const { bits, extent } = blockBitString({ type: 'hex', hex_value: 'A5' });
        expect(extent).toBe(8);
        expect(bits).toBe('10100101');
    });

    it('10bit 帧：4bit VER(10) + 6bit FLAG(0b010101) → 打包 2 字节 + 尾部 PAD', () => {
        const frame = packFrameBitStream([
            { type: 'bitfield', bit_len: 4, bits: [{ bit_name: 'VER', start_bit: 0, bit_len: 4, default_val: 10 }] },
            { type: 'bitfield', bit_len: 6, bits: [{ bit_name: 'FLAG', start_bit: 0, bit_len: 6, default_val: 0b010101 }] }
        ]);
        // 文档串 = '1010' + '010101' = '1010010101'（10bit）→ 尾补 6 零 = '1010010101000000'
        expect(frame.bitLen).toBe(10);
        expect(frame.padBits).toBe(6);
        expect(frame.hex).toBe('A540'); // '10100101'=A5, '01000000'=40
        expect(frame.bytes).toBe(2);
    });

    it('字节对齐帧：padBits = 0（hex 块拼接不补）', () => {
        const frame = packFrameBitStream([
            { type: 'hex', hex_value: '12' },
            { type: 'hex', hex_value: '34' }
        ]);
        expect(frame.bitLen).toBe(16);
        expect(frame.padBits).toBe(0);
        expect(frame.hex).toBe('1234');
    });

    it('>32bit 帧：字符串按位打包不截断（5 字节 40bit）', () => {
        const frame = packFrameBitStream([
            { type: 'hex', hex_value: '12' },
            { type: 'hex', hex_value: '34' },
            { type: 'hex', hex_value: '56' },
            { type: 'hex', hex_value: '78' },
            { type: 'hex', hex_value: '9A' }
        ]);
        expect(frame.bitLen).toBe(40);
        expect(frame.padBits).toBe(0);
        expect(frame.hex).toBe('123456789A'); // JS 32 位位运算会截断，字符串不截
    });

    it('空帧：bitLen 0、hex 空串不炸', () => {
        const frame = packFrameBitStream([]);
        expect(frame.bitLen).toBe(0);
        expect(frame.padBits).toBe(0);
        expect(frame.hex).toBe('');
    });
});

// R73（§8.105）双端位真帧向量：BE core/frame_bits.py 同读
// vectors/bit_true_frame.json —— 发射期出线与设计层 packFrameBitStream 逐位一致
// （尾补零 = 高对齐拍板；消费矩阵由 test_vectors_manifest.py 强制，改一必改二）。
describe('双端位真帧向量（R73 · 同读 vectors/bit_true_frame.json）', () => {
    it('packFrameBitStream 逐例 byte-equal（含 10bit 头 / 多 sub-byte 紧凑 / 跨字节 / 字节帧与 40bit 护栏）', () => {
        bitTrueVec.forEach((c) => {
            const frame = packFrameBitStream(c.blocks);
            expect(frame.bitLen, `${c.name}.bitLen`).toBe(c.expect.bitLen);
            expect(frame.padBits, `${c.name}.padBits`).toBe(c.expect.padBits);
            expect(frame.hex, `${c.name}.hex`).toBe(c.expect.hex);
            expect(frame.bytes, `${c.name}.bytes`).toBe(c.expect.bytes);
        });
    });
});
