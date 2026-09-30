import { describe, it, expect } from 'vitest';
import {
    normalizeFieldPayload,
    normalizeInstructionPayload,
    mergeFieldBitMeta
} from '../normalizeInstruction';

// 优化批（调研后优化 1-4）：位段元数据 signed/value_table 的零 DDL 存储。
// bit_fields 表无 JSON 列（零 DDL 硬约束）→ 元数据骑在 parameter_config.bit_meta
// （既有 JSON 列）：保存/导入负载在 normalizeFieldPayload 单点拆分，
// 读取路径按 bit id 幂等合并回 bits。
// 协议侧不走此路（块 bits 存 children JSON，Pydantic 透传 —— 见协议侧测试）。

const bit = (id, over = {}) => ({
    id,
    sequence: 0,
    bit_name: 'MODE',
    start_bit: 0,
    bit_len: 2,
    default_val: 1,
    ...over
});

const withBits = (bits, pc = {}) => ({
    id: 'f1',
    name: '位域',
    op_code: 'BITFIELD',
    byte_len: 1,
    parameter_config: pc,
    bits
});

describe('normalizeFieldPayload：位段元数据拆分（signed/value_table → pc.bit_meta）', () => {
    it('元数据从 bits 剥离并落 parameter_config.bit_meta[bitId]', () => {
        const payload = normalizeFieldPayload(withBits([
            bit('b1', { signed: true, value_table: [{ value: 0, label: '关' }, { value: 1, label: '开' }] }),
            bit('b2')
        ], { input_base: 'dec' }));

        expect(payload.bits[0]).toEqual({
            id: 'b1', sequence: 0, bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1
        });
        expect(payload.parameter_config.bit_meta).toEqual({
            b1: { signed: true, value_table: [{ value: 0, label: '关' }, { value: 1, label: '开' }] }
        });
        expect(payload.parameter_config.bit_meta.b2).toBeUndefined();
        // 既有 pc 键原样保留
        expect(payload.parameter_config.input_base).toBe('dec');
    });

    it('无任何元数据 → 不注入 bit_meta 键（存量负载逐字段不变）', () => {
        const payload = normalizeFieldPayload(withBits([bit('b1')]));
        expect('bit_meta' in payload.parameter_config).toBe(false);
        expect(payload.bits[0]).toEqual({
            id: 'b1', sequence: 0, bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1
        });
    });

    it('空值表 / signed:false 视为无元数据（不落冗余键）', () => {
        const payload = normalizeFieldPayload(withBits([bit('b1', { signed: false, value_table: [] })]));
        expect('bit_meta' in payload.parameter_config).toBe(false);
    });

    it('无 id 的位段不入 meta（不产生悬空键）', () => {
        const payload = normalizeFieldPayload(withBits([{
            sequence: 0, bit_name: 'X', start_bit: 0, bit_len: 1, default_val: 0, signed: true
        }]));
        expect('bit_meta' in payload.parameter_config).toBe(false);
    });

    it('整指令负载（保存与导入共用）：bits 干净、meta 只进 pc', () => {
        const payload = normalizeInstructionPayload({
            device_code: 'DEV', code: 'CMD', name: '指令', type: 'STATIC',
            fields: [withBits([bit('b1', { signed: true })])]
        });
        expect(payload.fields[0].bits[0].signed).toBeUndefined();
        expect(payload.fields[0].parameter_config.bit_meta).toEqual({ b1: { signed: true } });
    });
});

describe('mergeFieldBitMeta：读取路径按 bit id 幂等合并回 bits', () => {
    it('pc.bit_meta 合并进对应位段', () => {
        const merged = mergeFieldBitMeta(withBits([bit('b1'), bit('b2')], {
            bit_meta: { b1: { signed: true, value_table: [{ value: 0, label: '零' }] } }
        }));
        expect(merged.bits[0]).toMatchObject({ signed: true, value_table: [{ value: 0, label: '零' }] });
        expect(merged.bits[1].signed).toBeUndefined();
    });

    it('幂等：已合并的位段再次合并结果不变', () => {
        const once = mergeFieldBitMeta(withBits([bit('b1', { signed: true })], {
            bit_meta: { b1: { signed: true } }
        }));
        const twice = mergeFieldBitMeta(once);
        expect(twice.bits[0]).toEqual(once.bits[0]);
    });

    it('无 meta / 空 bits / id 未命中 → 原样不报错', () => {
        const f = withBits([bit('b1')]);
        expect(mergeFieldBitMeta(f)).toEqual(f);
        expect(mergeFieldBitMeta(withBits([]))).toEqual(withBits([]));
        const orphan = mergeFieldBitMeta(withBits([bit('bX')], { bit_meta: { b1: { signed: true } } }));
        expect(orphan.bits[0].signed).toBeUndefined();
    });
});
