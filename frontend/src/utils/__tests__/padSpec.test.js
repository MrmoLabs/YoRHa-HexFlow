import { describe, it, expect } from 'vitest';
import { PAD_MAX, alignPadLen, padHex, padSpec, padToPadLen } from '../padSpec';

// ─── N5 (G4 · PLAN §8.16): 字段级 align/pad_to 归一（红测先行） ──────────────
// 与 backend/core/pad.py pad_spec 同口径（两端各自钉同一套规则，改一必改二）：
// align/pad_to 正整数 1..PAD_MAX（Number + floor，非法 → 0 = 关闭）；
// pad_byte ≤2 位 hex 严格解析，否则 0x00（N2 pad_char 先例）。

describe('N5 padSpec 归一（与 backend/core/pad.py pad_spec 同步）', () => {
    it('align/pad_to 正整数 1..4096 归一（数值串与 floor 同口径）', () => {
        expect(padSpec({ align: 4, pad_to: 8 })).toEqual({ align: 4, padTo: 8, padByte: 0 });
        expect(padSpec({ align: '4' }).align).toBe(4);
        expect(padSpec({ align: '8.7' }).align).toBe(8);
        expect(padSpec({ align: 4096 }).align).toBe(4096);
        expect(padSpec({ pad_to: 2 }).padTo).toBe(2);
    });

    it('非法 align/pad_to → 0（fail-open 不阻断出帧）', () => {
        expect(padSpec({ align: 0 }).align).toBe(0);
        expect(padSpec({ align: -1 }).align).toBe(0);
        expect(padSpec({ align: PAD_MAX + 1 }).align).toBe(0);
        expect(padSpec({ align: 'x' }).align).toBe(0);
        expect(padSpec({ pad_to: -3 }).padTo).toBe(0);
        expect(padSpec(null).align).toBe(0);
        expect(padSpec(undefined).padTo).toBe(0);
        expect(PAD_MAX).toBe(4096);
    });

    it('pad_byte ≤2 位 hex 严格解析，否则 0x00（N2 pad_char 同口径）', () => {
        expect(padSpec({ pad_byte: 'FF' }).padByte).toBe(255);
        expect(padSpec({ pad_byte: 'f' }).padByte).toBe(15);
        expect(padSpec({ pad_byte: 'Z' }).padByte).toBe(0);
        expect(padSpec({ pad_byte: 'FFF' }).padByte).toBe(0);
        expect(padSpec({ pad_byte: '' }).padByte).toBe(0);
        expect(padSpec({}).padByte).toBe(0);
    });

    it('补位长度：已对齐 / 关闭态恒 0', () => {
        expect(alignPadLen(1, 4)).toBe(3);
        expect(alignPadLen(4, 4)).toBe(0);
        expect(alignPadLen(0, 4)).toBe(0);
        expect(alignPadLen(1, 0)).toBe(0);
        expect(padToPadLen(6, 8)).toBe(2);
        expect(padToPadLen(8, 8)).toBe(0);
        expect(padToPadLen(6, 0)).toBe(0);
        expect(padHex(3, 0xff)).toBe('FFFFFF');
        expect(padHex(0, 0)).toBe('');
    });
});
