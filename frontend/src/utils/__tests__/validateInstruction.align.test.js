import { describe, it, expect } from 'vitest';
import { validateInstruction } from '../validateInstruction';

// ─── N5 (G4 · PLAN §8.16): align/pad_to 校验提醒（红测先行） ─────────────────
// 非法 align/pad_to（≤0 / 非数 / >4096）→ 编码期 fail-open 忽略（不阻断出帧）
// → 校验出 warning 提醒修正；pad_byte 非法 → 静默回落 0x00（N2 pad_char 先例，
// 不出提醒）。任何 pad 配置都不得产生 error（绝不锁死保存）。

const inst = (fields) => ({ id: 'i1', name: 'TEST', code: 'T1', device_code: 'D1', fields });

const fld = (id, pc) => ({
    id, name: id.toUpperCase(), op_code: 'HEX_RAW', byte_len: 1, sequence: 0,
    parent_id: null, parameter_config: { hex: 'AA', ...pc },
});

const warnCodes = (fields) => validateInstruction(inst(fields)).warnings.map(w => w.code);

describe('N5 validateInstruction align/pad_to 提醒', () => {
    it('align 非法（≤0 / 非数 / 超上限）→ ALIGN_INVALID warning，零 error', () => {
        expect(warnCodes([fld('a', { align: 0 })])).toContain('ALIGN_INVALID');
        expect(warnCodes([fld('a', { align: -1 })])).toContain('ALIGN_INVALID');
        expect(warnCodes([fld('a', { align: 'x' })])).toContain('ALIGN_INVALID');
        expect(warnCodes([fld('a', { align: 4097 })])).toContain('ALIGN_INVALID');
        expect(validateInstruction(inst([fld('a', { align: 0 })])).errors).toEqual([]);
    });

    it('align 合法（含上限 4096、数值串）→ 不出 ALIGN_INVALID', () => {
        expect(warnCodes([fld('a', { align: 4 })])).not.toContain('ALIGN_INVALID');
        expect(warnCodes([fld('a', { align: 4096 })])).not.toContain('ALIGN_INVALID');
        expect(warnCodes([fld('a', { align: '4' })])).not.toContain('ALIGN_INVALID');
    });

    it('pad_to 非法 → PAD_TO_INVALID warning（与 align 分码，便于定位）', () => {
        expect(warnCodes([fld('a', { pad_to: -1 })])).toContain('PAD_TO_INVALID');
        expect(warnCodes([fld('a', { pad_to: 0 })])).toContain('PAD_TO_INVALID');
        expect(warnCodes([fld('a', { pad_to: 8 })])).not.toContain('PAD_TO_INVALID');
    });

    it('pad_byte 非法 → 静默回落 0x00（N2 pad_char 先例，不出提醒）', () => {
        const codes = warnCodes([fld('a', { align: 2, pad_byte: 'Z' })]);
        expect(codes).not.toContain('PAD_BYTE_INVALID');
        expect(codes).not.toContain('ALIGN_INVALID');
    });
});
