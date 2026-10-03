import { describe, it, expect } from 'vitest';
import { BLOCK_TYPES, BLOCK_PROPERTY_FIELDS, createBlock, isNestable, getBlockFields } from '../blockTypes';

// 批 4：协议结构化位域（bitfield 块）—— SSOT 扩展。
// palette 自动出按钮 + 面板按 inputType 分流出位编辑器（零 JSX 分支重复）。

const mk = (n = 0) => `id-${n}`;

describe('blockTypes 位域块（批 4）', () => {
    it('BLOCK_TYPES 含 bitfield：非嵌套、1 字节、字段走 length + bits', () => {
        const t = BLOCK_TYPES.find(b => b.type === 'bitfield');
        expect(t).toBeTruthy();
        expect(t.nestable).toBe(false);
        expect(t.fields).toEqual(['length', 'bits']);
        expect(t.palette.mainLabel).toBeTruthy();
        expect(t.palette.subLabel).toBeTruthy();
    });

    it('bitfield 在固定块之后、长度块之前（palette 顺序可预期）', () => {
        const types = BLOCK_TYPES.map(t => t.type);
        expect(types.indexOf('bitfield')).toBe(types.indexOf('fixed') + 1);
    });

    it('bits 字段声明为 inputType=bits（面板专用分支标识，键不是点路径）', () => {
        expect(BLOCK_PROPERTY_FIELDS.bits.inputType).toBe('bits');
        // 面板专用字段不提供 parse（与 refs 一致：直接被专用分支消费）
        expect(BLOCK_PROPERTY_FIELDS.bits.parse).toBeUndefined();
        expect(getBlockFields('bitfield').map(f => f.id)).toEqual(['length', 'bits']);
    });

    it('createBlock("bitfield")：初始化 bits 空数组 + 1 字节（与 fixed 同样不带 children）', () => {
        const b = createBlock('bitfield', () => mk());
        expect(b).toMatchObject({ type: 'bitfield', byte_length: 1, hex_value: '00', bits: [] });
        expect(b.children).toBeUndefined();
        // 位域块不预置 parameter_config（无 refs/算法语义）
        expect(b.parameter_config).toBeUndefined();
    });

    it('isNestable(bitfield) = false（叶子块，参与长度/校验求和）', () => {
        expect(isNestable('bitfield')).toBe(false);
    });

    it('存量块型零影响：container/fixed/length/checksum/slot 结构不变', () => {
        expect(BLOCK_TYPES.map(t => t.type)).toEqual(
            expect.arrayContaining(['container', 'fixed', 'length', 'checksum', 'slot'])
        );
        expect(createBlock('fixed', () => mk())).toMatchObject({ type: 'fixed', byte_length: 1 });
    });
});

// 批次二 (D3/D14①): 插槽契约 —— 新建槽默认 reject（防错），存量槽不迁移；
// fit 走 inputType='fit' 专用分支（镜像 refs/algo 的面板分流约定）。
describe('blockTypes 插槽契约（批次二 D3/D14①）', () => {
    it('slot 字段 = length + fit（fit 声明 inputType=fit、无 parse）', () => {
        const t = BLOCK_TYPES.find(b => b.type === 'slot');
        expect(t.fields).toEqual(['length', 'fit']);
        expect(BLOCK_PROPERTY_FIELDS.fit.inputType).toBe('fit');
        expect(BLOCK_PROPERTY_FIELDS.fit.parse).toBeUndefined();
        expect(getBlockFields('slot').map(f => f.id)).toEqual(['length', 'fit']);
    });

    it('createBlock("slot") 默认 fit_policy = reject/reject（新建防错）', () => {
        const b = createBlock('slot', () => mk());
        expect(b.parameter_config).toEqual({
            fit_policy: { overflow: 'reject', underflow: 'reject' }
        });
    });

    it('非槽块不预置 fit_policy（存量形态零影响）', () => {
        expect(createBlock('fixed', () => mk()).parameter_config).toBeUndefined();
        expect(createBlock('bitfield', () => mk()).parameter_config).toBeUndefined();
        // length/checksum 仍只有 type + refs（不被 fit 分支污染）
        expect(createBlock('length', () => mk()).parameter_config).toEqual({ type: 'length', refs: [] });
        expect(createBlock('checksum', () => mk()).parameter_config).toEqual({ type: 'checksum', refs: [] });
    });
});

// R21（§8.52 排期 · 长度域 BE/LE）：length 卡加字节序下拉 —— 存点
// parameter_config.byte_order（big|little，缺省 big），与收侧
// response_spec.length.byte_order 同值域（能判也能发）；仅 length 列此字段。
describe('blockTypes 长度字节序（R21 长度域 BE/LE）', () => {
    it('length 字段 = length + refs + byte_order（select 分流 + 点路径存 pc）', () => {
        expect(BLOCK_TYPES.find(b => b.type === 'length').fields).toEqual(['length', 'refs', 'byte_order']);
        const f = BLOCK_PROPERTY_FIELDS.byte_order;
        expect(f.inputType).toBe('select');           // 面板通用 select 分支（零 JSX 改动）
        expect(f.key).toBe('parameter_config.byte_order');
        expect(f.default).toBe('big');
        expect(f.options.map(o => o.value)).toEqual(['big', 'little']);
        // 面板专用字段不提供 parse（同 refs/fit：直接被 inputType 分流消费）
        expect(f.parse).toBeUndefined();
        expect(getBlockFields('length').map(x => x.id)).toEqual(['length', 'refs', 'byte_order']);
    });

    it('checksum 不列 byte_order（R21 拍板范围 = 长度域）；其它块型字段不变', () => {
        expect(BLOCK_TYPES.find(b => b.type === 'checksum').fields).toEqual(['length', 'refs', 'algo']);
        expect(BLOCK_TYPES.find(b => b.type === 'fixed').fields).toEqual(['length', 'hex']);
        expect(BLOCK_TYPES.find(b => b.type === 'slot').fields).toEqual(['length', 'fit']);
    });
});
