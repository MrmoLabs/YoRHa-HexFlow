import { describe, it, expect } from 'vitest';
import { normalizeRunnerInstruction } from '../normalizeRunnerInstruction';

// 第 14 单（加工页字段种类感知）：normalize 的 value→FIXED 判定对 TEXT 种类的
// 口径。N2 契约（pageStatus 文本字段算子行）：「加工页初始值 = 静态 value
// 可继续键入」—— value 在 STRING 字段上是「初值」不是「静态载荷」，不得因此
// 整行判死。其余算子的 value→FIXED 维持原状（存量固定块契约）。

const norm = (fields) => normalizeRunnerInstruction({ id: 'i1', name: 'T', code: 'T1', device_code: 'DEV', fields });

describe('normalizeRunnerInstruction：STRING 静态 value ≠ 固定块（N2 契约）', () => {
    it('STRING + 静态 value → 仍为可编辑 INPUT（original 保留 STRING、variable=true、初值不丢）', () => {
        const [f] = norm([{
            id: 'f1', name: 'LABEL', op_code: 'STRING', byte_len: 8,
            parameter_config: { type: 'string', encoding: 'ascii', value: 'HI' }
        }]).fields;
        expect(f.op_code).toBe('INPUT');
        expect(f.original_op_code).toBe('STRING');
        expect(f.parameter_config.variable).toBe(true);
        expect(f.parameter_config.value).toBe('HI');
        expect(f.parameter_config.readOnly).toBeUndefined();
    });

    it('STRING 无静态 value → 仍是可编辑 INPUT（存量行为不回退）', () => {
        const [f] = norm([{
            id: 'f1', name: 'LABEL', op_code: 'STRING', byte_len: 8,
            parameter_config: { type: 'string', encoding: 'ascii' }
        }]).fields;
        expect(f.op_code).toBe('INPUT');
        expect(f.parameter_config.variable).toBe(true);
    });

    it('回归：非文本算子带静态 value → 仍判 FIXED（存量固定块契约不动）', () => {
        const [num] = norm([{
            id: 'f1', name: 'N', op_code: 'INPUT', byte_len: 2,
            parameter_config: { type: 'number', value: 5 }
        }]).fields;
        expect(num.op_code).toBe('FIXED');
        expect(num.parameter_config.variable).toBe(false);

        const [hexRaw] = norm([{
            id: 'f2', name: 'H', op_code: 'HEX_RAW', byte_len: 2,
            parameter_config: { hex: 'AABB' }
        }]).fields;
        // HEX_RAW 在 line 61 白名单中保留原算子（classify 同判 isFixed，只读口径一致）
        expect(hexRaw.op_code).toBe('HEX_RAW');
        expect(hexRaw.parameter_config.variable).toBe(false);
    });

    it('回归：value + variable=true → INPUT（既有豁免不回退）', () => {
        const [f] = norm([{
            id: 'f1', name: 'V', op_code: 'INPUT', byte_len: 1,
            parameter_config: { type: 'number', value: 7, variable: true }
        }]).fields;
        expect(f.op_code).toBe('INPUT');
    });
});

// 第 14 单：种类算子身份保留 —— encode 的 f32/打包 BCD/两补码/定标/计数分支
// 全部按 op 门控（InstructionEncoder 行 173/205/302/318/340）。摊平成 INPUT 会让
// 这些分支在加工页预览/下发全部死亡（真机实锤：FLOAT 3.14 → 00 00 00 03、
// BCD 1234 → 04 D2），与种类章 tooltip 承诺的字节语义直接矛盾。
describe('第 14 单：种类算子身份保留（可编辑时 op 原样进编码器）', () => {
    it('FLOAT/BCD/INT_SIGNED/SCALED/AUTO_COUNTER 可编辑 → op 保留 + variable=true', () => {
        ['FLOAT_IEEE', 'BCD_CODE', 'INT_SIGNED', 'SCALED_DECIMAL', 'AUTO_COUNTER'].forEach((op) => {
            const [f] = norm([{
                id: 'f1', name: 'K', op_code: op, byte_len: 4,
                parameter_config: { type: 'number' }
            }]).fields;
            expect(f.op_code).toBe(op);
            expect(f.original_op_code).toBe(op);
            expect(f.parameter_config.variable).toBe(true);
        });
    });

    it('带静态 value 的种类算子仍判 FIXED（静态载荷契约不动，与摊平时行为一致）', () => {
        const [f] = norm([{
            id: 'f1', name: 'K', op_code: 'FLOAT_IEEE', byte_len: 4,
            parameter_config: { type: 'number', value: 1.5 }
        }]).fields;
        expect(f.op_code).toBe('FIXED');
    });

    it('回归：MAPPING / INT_UNSIGNED 仍摊平 INPUT（编码字节等价，不扩面）', () => {
        const [m] = norm([{
            id: 'f1', name: 'M', op_code: 'MAPPING', byte_len: 1,
            parameter_config: { options: [1, 2] }
        }]).fields;
        expect(m.op_code).toBe('INPUT');
        const [u] = norm([{
            id: 'f1', name: 'U', op_code: 'INT_UNSIGNED', byte_len: 1,
            parameter_config: {}
        }]).fields;
        expect(u.op_code).toBe('INPUT');
    });

    it('回归：TIME_ACCUMULATOR → TIME_CUMULATIVE（加工页手动选时刻的既定覆盖语义）', () => {
        const [t] = norm([{
            id: 'f1', name: 'T', op_code: 'TIME_ACCUMULATOR', byte_len: 4,
            parameter_config: {}
        }]).fields;
        expect(t.op_code).toBe('TIME_CUMULATIVE');
    });
});
