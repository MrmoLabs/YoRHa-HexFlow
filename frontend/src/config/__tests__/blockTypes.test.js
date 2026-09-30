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
