/**
 * R70（§8.102 二 · 设计层）帧级位布局 · 红测 —— computeBitFrameLayout。
 *
 * 纯字节真源 computeByteOffsets 零触碰；本函数只服务「含 sub-byte/bit 定义帧」的
 * 自适应位视图（spec §三）：偏移尺 bit 粒度、帧总长 = Σ bit_len、**紧凑打包**
 * （4+4 = 8bit = 1 字节，不逐块补零 —— 解 §8.101 十一 边界①「不再须并入单一位
 * 域块手工重分组」）。纯字节帧 hasSubByte=false → 画布沿字节视图零扰动。
 *
 * 口径：
 *  - 叶子 bit 宽 = 声明 bit_len 优先，否则 byte_length×8；
 *  - 容器 bit 宽 = Σ 子（空 nestable 容器 = 0）；
 *  - 每块 bitOffset = 帧起点起累计绝对 bit 偏移（容器内子块亦绝对）；
 *  - totalBits = Σ 顶层宽；packedBytes = ceil(totalBits/8)；tailPad = packed×8 - total；
 *  - hasSubByte = 任一叶子声明 bit_len（用户定义 bit → 切位视图）。
 */

import { describe, it, expect } from 'vitest';
import { computeBitFrameLayout } from '../frameBitLayout';

describe('computeBitFrameLayout（R70 设计层 · bit 偏移/总长/自适应）', () => {
    it('纯字节帧：bit 宽 = byte_length×8，总长 ×8，hasSubByte=false', () => {
        const r = computeBitFrameLayout([
            { id: 'a', byte_length: 2 },
            { id: 'b', byte_length: 1 },
        ]);
        expect(r.blocks.get('a')).toMatchObject({ bitOffset: 0, bitWidth: 16 });
        expect(r.blocks.get('b')).toMatchObject({ bitOffset: 16, bitWidth: 8 });
        expect(r.totalBits).toBe(24);
        expect(r.hasSubByte).toBe(false);
        expect(r.packedBytes).toBe(3);
        expect(r.tailPadBits).toBe(0);
    });

    it('sub-byte 紧凑打包：4+4 = 8bit = 1 字节（不逐块补零），hasSubByte=true', () => {
        const r = computeBitFrameLayout([
            { id: 'v', bit_len: 4 },
            { id: 'f', bit_len: 4 },
        ]);
        expect(r.blocks.get('v')).toMatchObject({ bitOffset: 0, bitWidth: 4 });
        expect(r.blocks.get('f')).toMatchObject({ bitOffset: 4, bitWidth: 4 });
        expect(r.totalBits).toBe(8);
        expect(r.hasSubByte).toBe(true);
        expect(r.packedBytes).toBe(1);
        expect(r.tailPadBits).toBe(0);
    });

    it('10bit 头 + 字节块：总 18bit → 3 字节、尾 PAD 6', () => {
        const r = computeBitFrameLayout([
            { id: 'hdr', bit_len: 10 },
            { id: 'body', byte_length: 1 },
        ]);
        expect(r.blocks.get('hdr')).toMatchObject({ bitOffset: 0, bitWidth: 10 });
        expect(r.blocks.get('body')).toMatchObject({ bitOffset: 10, bitWidth: 8 });
        expect(r.totalBits).toBe(18);
        expect(r.hasSubByte).toBe(true);
        expect(r.packedBytes).toBe(3);
        expect(r.tailPadBits).toBe(6);
    });

    it('嵌套容器：组宽 = Σ 子，子/后继均绝对 bit 偏移', () => {
        const r = computeBitFrameLayout([
            {
                id: 'g', type: 'container', children: [
                    { id: 'x', bit_len: 4 },
                    { id: 'y', bit_len: 4 },
                ],
            },
            { id: 'z', byte_length: 1 },
        ]);
        expect(r.blocks.get('g')).toMatchObject({ bitOffset: 0, bitWidth: 8, isContainer: true });
        expect(r.blocks.get('x')).toMatchObject({ bitOffset: 0, bitWidth: 4 });
        expect(r.blocks.get('y')).toMatchObject({ bitOffset: 4, bitWidth: 4 });
        expect(r.blocks.get('z')).toMatchObject({ bitOffset: 8, bitWidth: 8 });
        expect(r.totalBits).toBe(16);
        expect(r.hasSubByte).toBe(true);
    });

    it('空帧 / 空容器：总 0、packed 0、hasSubByte=false', () => {
        const empty = computeBitFrameLayout([]);
        expect(empty.totalBits).toBe(0);
        expect(empty.packedBytes).toBe(0);
        expect(empty.tailPadBits).toBe(0);
        expect(empty.hasSubByte).toBe(false);
        const grp = computeBitFrameLayout([{ id: 'g', type: 'container', children: [] }]);
        expect(grp.blocks.get('g')).toMatchObject({ bitOffset: 0, bitWidth: 0, isContainer: true });
        expect(grp.totalBits).toBe(0);
    });
});
