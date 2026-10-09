/**
 * R70（§8.102）位真容量闸 · 红测 —— 位域块声明 `bit_len`（真实 bit 数）后，
 * 容量判定从「byte_length×8」升级为「声明 bit_len 优先」。既有批 4 契约
 * （validateProtocol.test.js）保持回归守卫，此处只增位真三闸：
 *   - BIT_LEN_INVALID  ：bit_len 负/小数/非数（0 = 未设置，跳过）；
 *   - BIT_LEN_ENVELOPE ：声明 bit_len > byte_length×8（真值超出字节包络，矛盾）；
 *   - BIT_OVERFLOW     ：段最高位 > 容量（容量 = 有效 bit_len，否则 byte_length×8）。
 */

import { describe, it, expect } from 'vitest';
import { validateProtocol } from '../validateProtocol';

const proto = (children) => ({ id: 'root', label: 'P', type: 'container', children });
const codes = (list) => list.map(x => x.code);
const bfb = (bits, extra = {}) => ({ id: 'b', label: 'b', type: 'bitfield', bits, ...extra });

describe('validateProtocol 位真容量（R70 bit_len）', () => {
    it('bit_len 收紧容量 → 段越 bit_len 报 BIT_OVERFLOW（今日按 byte_length×8 放行 = RED）', () => {
        // bit_len=10 声明真值，byte_length=2（16 包络），段伸到 bit12 → 越 10
        const r = validateProtocol(proto([bfb(
            [{ id: '1', bit_name: 'W', start_bit: 0, bit_len: 12, default_val: 0 }],
            { byte_length: 2, bit_len: 10 }
        )]));
        expect(codes(r.errors)).toEqual(['BIT_OVERFLOW']);
        expect(r.errors[0].message).toContain('超出容量');
    });

    it('bit_len > 字节包络 → BIT_LEN_ENVELOPE', () => {
        const r = validateProtocol(proto([bfb(
            [{ id: '1', bit_name: 'W', start_bit: 0, bit_len: 16, default_val: 0 }],
            { byte_length: 2, bit_len: 20 }
        )]));
        expect(codes(r.errors)).toEqual(['BIT_LEN_ENVELOPE']);
    });

    it('bit_len 非法（负 / 小数）→ BIT_LEN_INVALID；0 = 未设置不报', () => {
        expect(codes(validateProtocol(proto([bfb([], { byte_length: 1, bit_len: -1 })])).errors))
            .toEqual(['BIT_LEN_INVALID']);
        expect(codes(validateProtocol(proto([bfb([], { byte_length: 1, bit_len: 2.5 })])).errors))
            .toEqual(['BIT_LEN_INVALID']);
        expect(validateProtocol(proto([bfb([], { byte_length: 1, bit_len: 0 })])).errors)
            .toEqual([]);
    });

    it('sub-byte 位真块（bit_len=10, byte_length=2）段恰占满 10 位 → 0 错', () => {
        expect(validateProtocol(proto([bfb(
            [{ id: '1', bit_name: 'A', start_bit: 0, bit_len: 10, default_val: 0 }],
            { byte_length: 2, bit_len: 10 }
        )]))).toEqual({ errors: [], warnings: [] });
    });

    it('回归：无 bit_len 仍按 byte_length×8（9 位/2B 合法、17 位/2B 报错）', () => {
        expect(validateProtocol(proto([bfb(
            [{ id: '1', bit_name: 'W', start_bit: 0, bit_len: 9, default_val: 0 }],
            { byte_length: 2 }
        )]))).toEqual({ errors: [], warnings: [] });
        expect(codes(validateProtocol(proto([bfb(
            [{ id: '1', bit_name: 'W', start_bit: 0, bit_len: 17, default_val: 0 }],
            { byte_length: 2 }
        )])).errors)).toEqual(['BIT_OVERFLOW']);
    });
});
