// R42（§8.74 · `byte_order` trim 归一）：FE 侧**唯一**的字节序取值判据。
// 单一真相源 = `utils/byteOrder.js`，与后端 `handlers/base.py::byte_order_of`
// 逐字对齐（`str(order).strip().lower()` → 枚举外 fail-open 回大端）。
//
// 红测先行有据：实现前本文件**整体加载即红**（被测模块尚不存在），
// 红因 = 缺特性本身，无一条属「测试自身 bug」。
import { describe, it, expect } from 'vitest';
import { normalizeByteOrder, isLittleByteOrder } from '../byteOrder';

describe('R42 byte_order trim 归一（FE 单点判据）', () => {
    it('首尾空白 + 大小写混排 → 归一后判 little', () => {
        expect(normalizeByteOrder(' LITTLE ')).toBe('little');
        expect(normalizeByteOrder('\tlittle\t')).toBe('little');
        expect(isLittleByteOrder(' LITTLE ')).toBe(true);
        expect(isLittleByteOrder('  little  ')).toBe(true);
        expect(isLittleByteOrder('Big ')).toBe(false);
    });

    it('缺失 / 空串 / 枚举外 → 不是 little（fail-open 大端，镜像 byte_order_of）', () => {
        for (const raw of [undefined, null, '', '   ', 'middle', ' LITTLE-ish ']) {
            expect(isLittleByteOrder(raw), `raw=${JSON.stringify(raw)}`).toBe(false);
        }
        expect(normalizeByteOrder(undefined)).toBe('');
        expect(normalizeByteOrder(' Big ')).toBe('big');
        // 归一 ≠ 放行：枚举判定仍归调用方（W5 的「在枚举内才不报」）。
        expect(normalizeByteOrder(' middle ')).toBe('middle');
    });

    it('干净值行为不变（§0 缺省口径逐字节不变）', () => {
        expect(isLittleByteOrder('little')).toBe(true);
        expect(isLittleByteOrder('LITTLE')).toBe(true);
        expect(isLittleByteOrder('big')).toBe(false);
        expect(isLittleByteOrder(undefined)).toBe(false);
        expect(normalizeByteOrder('big')).toBe('big');
    });
});
