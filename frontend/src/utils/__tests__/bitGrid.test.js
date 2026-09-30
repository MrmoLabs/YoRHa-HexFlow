import { describe, it, expect } from 'vitest';
import {
    buildBitGrid,
    rangeToSegment,
    defaultSegmentName,
    packBits,
    BIT_GRID_COLORS
} from '../bitGrid';
import { packBitfieldDefault } from '../../config/runnerRenderRules';

// 批 2：BitFieldEditor 可视化位图的纯函数层。
// 存储约定（与指令侧 BITFIELD 一致）：start_bit 以整字段位偏移计，bit 0 = LSB。
// 网格显示约定：每字节 8 格，**bit0 在最右**（MSB 在左），即第 r 行第 c 列
// (c=0..7) 的绝对位号 = r*8 + (7-c)。

describe('buildBitGrid（位网格：段归属 / 冲突 / 容量）', () => {
    it('字节数取 max(byte_len, 所需字节)；bit0 在最右（MSB 在左）', () => {
        const g = buildBitGrid([], 2);
        expect(g.bytes).toHaveLength(2);
        expect(g.bytes[0].map(c => c.bitIndex)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
        expect(g.bytes[1].map(c => c.bitIndex)).toEqual([15, 14, 13, 12, 11, 10, 9, 8]);
    });

    it('段归属：格子带 owner 索引 / 名称 / 颜色；未覆盖格 owner=-1', () => {
        const bits = [
            { id: 'a', bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1 },
            { id: 'b', bit_name: 'EN', start_bit: 2, bit_len: 1, default_val: 1 }
        ];
        const g = buildBitGrid(bits, 1);
        // bit0/bit1 → a（右下两格）；bit2 → b；其余 -1
        expect(g.bytes[0][7].owner).toBe(0);
        expect(g.bytes[0][6].owner).toBe(0);
        expect(g.bytes[0][5].owner).toBe(1);
        expect(g.bytes[0][7].name).toBe('MODE');
        expect(g.bytes[0][7].color).toBe(BIT_GRID_COLORS[0]);
        expect(g.bytes[0][0].owner).toBe(-1);
    });

    it('位段重叠：重叠位在所有占用段上标 conflict（不静默取一个）', () => {
        const bits = [
            { id: 'a', bit_name: 'A', start_bit: 0, bit_len: 4 },
            { id: 'b', bit_name: 'B', start_bit: 2, bit_len: 4 }
        ];
        const g = buildBitGrid(bits, 1);
        const at = (bit) => g.bytes[0].find(c => c.bitIndex === bit);
        // 2/3 位被双占 → 两侧都标冲突
        expect(at(2).conflict).toBe(true);
        expect(at(3).conflict).toBe(true);
        expect(at(1).conflict).toBe(false);
        expect(g.conflictBits).toEqual([2, 3]);
    });

    it('所需字节随位段上界扩张（超出 byte_len 时 byteCount 跟随，仍标超限）', () => {
        const bits = [{ id: 'a', bit_name: 'W', start_bit: 8, bit_len: 8 }];
        const g = buildBitGrid(bits, 1);
        expect(g.requiredBytes).toBe(2);
        expect(g.bytes).toHaveLength(2); // 网格不裁剪，避免「看不见溢出段」
        expect(g.overflow).toBe(true); // 2 > byte_len=1
    });

    it('非法位段（start/bit_len 非数或 <1）不占格、不炸；owner = 原数组行号', () => {
        const g = buildBitGrid([
            { id: 'x', bit_name: 'X', start_bit: NaN, bit_len: 0 },
            { id: 'y', bit_name: 'Y', start_bit: 0, bit_len: 1 }
        ], 1);
        // 仅 y 占 bit0，且 owner 报的是**原数组行号**（表格行下标，编辑器联动用）
        expect(g.bytes[0][7].owner).toBe(1);
        expect(g.bytes[0][7].name).toBe('Y');
        expect(g.conflictBits).toEqual([]);
    });
});

describe('rangeToSegment（点击式设段：两格 → 段）', () => {
    it('从起点格到终点格 → { start_bit, bit_len }（与点选方向无关）', () => {
        expect(rangeToSegment(2, 4)).toEqual({ start_bit: 2, bit_len: 3 });
        expect(rangeToSegment(4, 2)).toEqual({ start_bit: 2, bit_len: 3 });
        expect(rangeToSegment(0, 15)).toEqual({ start_bit: 0, bit_len: 16 });
    });

    it('同格 = 1 位段；非法输入 → null（调用方不提交）', () => {
        expect(rangeToSegment(3, 3)).toEqual({ start_bit: 3, bit_len: 1 });
        expect(rangeToSegment(null, 3)).toBeNull();
        expect(rangeToSegment(3, undefined)).toBeNull();
    });
});

describe('defaultSegmentName / packBits', () => {
    it('默认名按起始位（BIT_0 / BIT_8）', () => {
        expect(defaultSegmentName(0)).toBe('BIT_0');
        expect(defaultSegmentName(8)).toBe('BIT_8');
    });

    // 改一必改二：位图预览打包必须与编码器同口径（runnerRenderRules.packBitfieldDefault）
    it('packBits 与编码器镜像 packBitfieldDefault 逐例 byte-equal', () => {
        const vectors = [
            [[{ start_bit: 0, bit_len: 4, default_val: 5 }, { start_bit: 4, bit_len: 4, default_val: 10 }], 1],
            [[{ start_bit: 0, bit_len: 8, default_val: 0xFF }], 1],
            [[{ start_bit: 8, bit_len: 8, default_val: 0x12 }], 2],
            [[{ start_bit: 0, bit_len: 16, default_val: 0x1234 }], 2],
            [[{ start_bit: 4, bit_len: 12, default_val: 0xABC }], 2],
            [[], 1],
            [[{ start_bit: 0, bit_len: 40, default_val: 1 }], 8]
        ];
        for (const [bits, byteLen] of vectors) {
            expect(packBits(bits, byteLen)).toBe(packBitfieldDefault(bits, byteLen));
        }
    });
});
