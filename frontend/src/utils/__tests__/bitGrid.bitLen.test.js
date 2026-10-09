/**
 * R70（§8.102）位带布局层 bit_len 支持 · 红测 —— buildBitGrid / buildStripLayout
 * 的容量从「byteLen×8」升级为「声明 bit_len 优先」。既有 R68/R69 契约（bitGrid.test.js）
 * 作回归守卫（无 bitLen 走旧口径），此处只增位真容量：
 *  - strip：容量 = bit_len（10bit 头画 10 格非 16，所见即所得）；
 *  - grid：byteCount = ceil(bit_len/8)，bit ≥ bit_len 的格标 pad。
 */

import { describe, it, expect } from 'vitest';
import { buildBitGrid, buildStripLayout } from '../bitGrid';

describe('bitGrid 位真容量（R70 bit_len）', () => {
    it('strip 容量 = bit_len（10bit 头画 10 格非 16），段填满 10 位', () => {
        const l = buildStripLayout([
            { id: 'v', bit_name: 'VER', start_bit: 6, bit_len: 4, default_val: 10 },
            { id: 'f', bit_name: 'FLAG', start_bit: 0, bit_len: 6, default_val: 0b010101 }
        ], 2, 'msb', 10);
        expect(l.capacity).toBe(10);
        expect(l.ruler).toHaveLength(10);
        // VER(4) + FLAG(6) 恰填满 10 位：Σ units bits = 10、无 gap
        expect(l.units.reduce((a, u) => a + u.bits.length, 0)).toBe(10);
        expect(l.units.every(u => u.kind === 'seg')).toBe(true);
    });

    it('grid byteCount = ceil(bit_len/8)，bit ≥ bit_len 标 pad', () => {
        const g = buildBitGrid([], 2, 10);
        expect(g.byteCount).toBe(2);
        const padBits = g.bytes.flat().filter(c => c.pad).map(c => c.bitIndex).sort((a, b) => a - b);
        expect(padBits).toEqual([10, 11, 12, 13, 14, 15]);
    });

    it('strip 段值/色/名不受 bit_len 影响（R68 语义回归）', () => {
        const l = buildStripLayout([
            { id: 'a', bit_name: 'MODE', start_bit: 0, bit_len: 10, default_val: 5 }
        ], 2, 'msb', 10);
        expect(l.units).toHaveLength(1);
        expect(l.units[0]).toMatchObject({ kind: 'seg', name: 'MODE', bits: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0] });
    });

    it('回归：无 bit_len → 容量仍 byteLen×8（R68 口径不变）', () => {
        expect(buildStripLayout([], 2, 'msb').capacity).toBe(16);
        expect(buildBitGrid([], 2).byteCount).toBe(2);
        expect(buildBitGrid([], 1).byteCount).toBe(1);
    });
});
