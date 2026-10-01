import { describe, it, expect } from 'vitest';
import {
    buildBitGrid,
    rangeToSegment,
    defaultSegmentName,
    normalizeBits,
    packBits,
    unpackBits,
    writeBitSegment,
    clampBitValue,
    BIT_GRID_COLORS
} from '../bitGrid';
import { loadVectors } from '../../../../vectors/vectors.js';
import bitfieldVec from '../../../../vectors/bitfield.json';
import { parseValueTable, formatValueTable } from '../bitMeta';
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
    // CP2b (D11-①): 单一真相源 = vectors/bitfield.json · 表 pack —— 两端同读一份，新增向量只写一处。
    // 行形状 [segs, byteLen, expectHex]，segs = [start_bit, bit_len, default_val]（此处归一成 FE 键名）
    it('packBits 与编码器镜像 packBitfieldDefault 逐例 byte-equal（并同钉共享期望 hex）', () => {
        const vectors = loadVectors(bitfieldVec.pack)
            .map(([segs, byteLen, expectHex]) => [
                segs.map(([start_bit, bit_len, default_val]) => ({ start_bit, bit_len, default_val })),
                byteLen,
                expectHex.replace(/\s+/g, ''),
            ]);
        for (const [bits, byteLen, expected] of vectors) {
            expect(packBits(bits, byteLen)).toBe(expected);
            expect(packBitfieldDefault(bits, byteLen)).toBe(expected);
        }
    });
});

// 批 3：加工侧按子位录入。单一真源 = 字段整数输入值；子位行是派生视图，
// 改子位只重写本段位（间隙位/其余段原样保留），回写仍是同一个整数。
describe('unpackBits / writeBitSegment / clampBitValue（子位拆包与回写）', () => {
    const BITS = [
        { id: 'a', bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1 },
        { id: 'b', bit_name: 'EN', start_bit: 2, bit_len: 1, default_val: 1 }
    ];

    it('unpackBits：有输入时按位拆；无输入时回退 default_val', () => {
        expect(unpackBits(0x0F, BITS).map(s => [s.name, s.value, s.max]))
            .toEqual([['MODE', 3, 3], ['EN', 1, 1]]);
        expect(unpackBits(undefined, BITS).map(s => s.value)).toEqual([1, 1]);
    });

    it('unpackBits：只认合法位段；非法位段不出行（不静默塞 0 位行）', () => {
        const rows = unpackBits(0, [
            { id: 'x', bit_name: 'X', start_bit: NaN, bit_len: 0 },
            { id: 'y', bit_name: 'Y', start_bit: 3, bit_len: 5, default_val: 7 }
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ name: 'Y', value: 0, max: 31, start: 3, len: 5 });
    });

    it('writeBitSegment：只重写本段，其余位与无主位（间隙）原样保留', () => {
        // MODE(bit0..1) 改成 1：0x0F → 0x0D（高 5 位 0b01111 中的位 3..7 保留）
        expect(writeBitSegment(0x0F, BITS[0], 1, BITS)).toBe(0x0D);
        // EN(bit2) 改成 0：0x0F → 0x0B
        expect(writeBitSegment(0x0F, BITS[1], 0, BITS)).toBe(0x0B);
    });

    it('writeBitSegment：无输入态以 default_val 打包值为底（其余段不被清零）', () => {
        // 未录入时底值 = MODE=1|EN=1 = 0x05；改 EN=0 → 0x01
        expect(writeBitSegment(undefined, BITS[1], 0, BITS)).toBe(0x01);
        // 改 MODE=3 → 0x07
        expect(writeBitSegment(undefined, BITS[0], 3, BITS)).toBe(0x07);
    });

    it('writeBitSegment：越界值先钳制到本段域再回写（不溢出到邻段）', () => {
        expect(writeBitSegment(0x00, BITS[0], 9, BITS)).toBe(0x03); // 2 位段上限 3
        expect(writeBitSegment(0x00, BITS[0], -2, BITS)).toBe(0x00);
    });

    it('clampBitValue：非数 → 0；越界钳制', () => {
        expect(clampBitValue(5, 2)).toBe(3);
        expect(clampBitValue(-1, 2)).toBe(0);
        expect(clampBitValue('x', 2)).toBe(0);
        expect(clampBitValue(7, 3)).toBe(7);
    });

    it('跨 32 位段不丢高位（不用 JS 32 位位运算截断）', () => {
        const wide = [
            { id: 'lo', bit_name: 'LO', start_bit: 0, bit_len: 8, default_val: 0x11 },
            { id: 'hi', bit_name: 'HI', start_bit: 32, bit_len: 8, default_val: 0x22 }
        ];
        // 5 字节字段：HI 在 bit32..bit39（整值仍在安全整数内）
        const base = 0x2200000011;
        expect(unpackBits(base, wide).map(s => s.value)).toEqual([0x11, 0x22]);
        expect(writeBitSegment(base, wide[0], 0xAB, wide)).toBe(0x22000000AB);
        expect(writeBitSegment(base, wide[1], 0x33, wide)).toBe(0x3300000011);
    });
});

// 优化批 2/3（市场调研后 DBC 对齐）：位段有符号（DBC signed flag）与
// 值表（DBC VAL_）—— 打包口径不变（raw & mask 两补码天然覆盖），
// 变的是拆包解读 / 钳制域 / 回写与 UI 语义。
describe('优化批 2/3：位段有符号与值表', () => {
    it('normalizeBits 携带 signed/value_table（脏值表清洗：非数组丢弃、非法项过滤）', () => {
        const norm = normalizeBits([
            {
                start_bit: 0, bit_len: 4, default_val: -1, signed: true,
                value_table: [{ value: -1, label: '故障' }, { value: 'x', label: '坏' }, 'junk']
            },
            { start_bit: 4, bit_len: 4, value_table: 'garbage' },
            { start_bit: 8, bit_len: 4, signed: 'yes' }
        ]);
        expect(norm[0]).toMatchObject({ signed: true, value_table: [{ value: -1, label: '故障' }] });
        expect(norm[1].value_table).toBeUndefined();
        expect(norm[2].signed).toBe(false); // 非 true 一律按 false
    });

    it('unpackBits：signed 段按两补码解读（0xD8 → -40），unsigned 口径不变', () => {
        const seg = { id: 't', bit_name: 'TEMP', start_bit: 0, bit_len: 8, default_val: 0, signed: true };
        expect(unpackBits(0xD8, [seg])[0].value).toBe(-40);
        expect(unpackBits(40, [seg])[0].value).toBe(40); // 符号位未置位 → 原值
        expect(unpackBits(0xD8, [{ ...seg, signed: false }])[0].value).toBe(216);
        // 4 位有符号：0x0C → -4
        expect(unpackBits(0x0C, [{ ...seg, bit_len: 4 }])[0].value).toBe(-4);
        // 无输入态 default：已按有符号域存 → 原样；按位模式存（216）→ 解读为 -40
        expect(unpackBits(undefined, [{ ...seg, default_val: -40 }])[0].value).toBe(-40);
        expect(unpackBits(undefined, [{ ...seg, default_val: 216 }])[0].value).toBe(-40);
        // 行上带 signed/min/max（子位输入钳制域用）
        expect(unpackBits(0x80, [seg])[0]).toMatchObject({ value: -128, min: -128, max: 127, signed: true });
    });

    it('clampBitValue：signed 域 [-2^(n-1), 2^(n-1)-1]；unsigned 缺省口径不变', () => {
        expect(clampBitValue(200, 8, true)).toBe(127);
        expect(clampBitValue(-200, 8, true)).toBe(-128);
        expect(clampBitValue(5, 4, true)).toBe(5);
        expect(clampBitValue(7, 4, true)).toBe(7);
        expect(clampBitValue(8, 4, true)).toBe(7);
        expect(clampBitValue(-5, 4, true)).toBe(-5);
        // unsigned 缺省：0..2^n-1，负数钳 0
        expect(clampBitValue(5, 2)).toBe(3);
        expect(clampBitValue(-5, 8)).toBe(0);
    });

    it('writeBitSegment：signed 负值两补码回写，邻段与高位保留', () => {
        expect(writeBitSegment(0x00, { start_bit: 0, bit_len: 8, signed: true }, -40)).toBe(0xD8);
        expect(writeBitSegment(0x0F, { start_bit: 0, bit_len: 4, signed: true }, -4)).toBe(0x0C);
        expect(writeBitSegment(0x00, { start_bit: 4, bit_len: 4, signed: true }, -1)).toBe(0xF0);
        // 无 signed 标记 → 仍按 unsigned 钳制（存量口径不变）
        expect(writeBitSegment(0x00, { start_bit: 0, bit_len: 8 }, -40)).toBe(0);
    });

    it('packBits 负 default 与 packBitfieldDefault byte-equal（raw&mask 两补码镜像锁定）', () => {
        const vectors = [
            [[{ start_bit: 0, bit_len: 8, default_val: -40 }], 1],
            [[{ start_bit: 0, bit_len: 4, default_val: -1 }], 1],
            [[{ start_bit: 0, bit_len: 16, default_val: -2 }], 2],
            [[{ start_bit: 4, bit_len: 8, default_val: -16 }], 2]
        ];
        vectors.forEach(([bits, byteLen]) => {
            expect(packBits(bits, byteLen)).toBe(packBitfieldDefault(bits, byteLen));
        });
        expect(packBits([{ start_bit: 0, bit_len: 8, default_val: -40 }], 1)).toBe('D8');
    });
});

describe('优化批 2：值表文本解析/回显（BitFieldEditor 编辑格式）', () => {
    it('parseValueTable：0=关, 1:开 双分隔符容忍、非法行丢弃、负值允许', () => {
        expect(parseValueTable('0=关, 1:开')).toEqual([
            { value: 0, label: '关' }, { value: 1, label: '开' }
        ]);
        expect(parseValueTable('-1=故障,2=正常')).toEqual([
            { value: -1, label: '故障' }, { value: 2, label: '正常' }
        ]);
        expect(parseValueTable('')).toBeUndefined();
        expect(parseValueTable('坏行, x=1, =2')).toBeUndefined();
    });

    it('formatValueTable 往返：数组 → 0=关,1=开；非数组/空 → 空串', () => {
        expect(formatValueTable([{ value: 0, label: '关' }, { value: 1, label: '开' }]))
            .toBe('0=关,1=开');
        expect(formatValueTable(undefined)).toBe('');
        expect(formatValueTable([])).toBe('');
        expect(formatValueTable('garbage')).toBe('');
    });
});
