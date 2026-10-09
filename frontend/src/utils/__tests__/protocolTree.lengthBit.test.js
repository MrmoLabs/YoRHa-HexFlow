/**
 * R70（§8.102 ③ · 计算层）length 卡 bit 计数 · 红测 —— injectRefsSigma 对
 * parameter_config.unit='bit' 注真 Σ bit（bit 真值，非字节 sigma×8）。
 *
 * 口径：sub-byte 帧不能 ×8 缩放（envelope×8 高估真值：10bit 块 byte_length=2 →
 * ×8=16 ≠ 10）；逐块取 bit_len（容器递归 Σ 子、字节叶子 byte 尺寸×8）。unit 缺省
 * 'byte' → 注 `${sigma}B`（既有口径零扰动）。
 */

import { describe, it, expect } from 'vitest';
import * as protocolTree from '../protocolTree';

const lenValue = (out, id = 'len') => {
    const items = (out || []).flatMap(l => l.items || []);
    const it = items.find(x => x.id === id);
    return it?.parameter_config?.computedValue;
};

describe('length 卡 bit 计数（R70 unit=bit）', () => {
    const frame = (unit, hdrBitLen = 10) => ({
        children: [
            { id: 'hdr', type: 'bitfield', byte_length: Math.ceil(hdrBitLen / 8), bit_len: hdrBitLen },
            { id: 'len', type: 'length', byte_length: 1, parameter_config: { refs: ['hdr'], ...(unit ? { unit } : {}) } },
        ],
    });

    it('unit=bit → 注真 Σ bit（10bit 块 → "10b"，非字节 sigma×8=16）', () => {
        const p = frame('bit');
        const lanes = protocolTree.buildProtocolLanes(p, []);
        const byId = protocolTree.computeProtocolOffsets(p).byId;
        const out = protocolTree.injectRefsSigma(lanes, byId, p);
        expect(lenValue(out)).toBe('10b');
    });

    it('unit 缺省（byte）→ 注字节 `${sigma}B`（既有口径零扰动）', () => {
        const p = frame(undefined);
        const lanes = protocolTree.buildProtocolLanes(p, []);
        const byId = protocolTree.computeProtocolOffsets(p).byId;
        const out = protocolTree.injectRefsSigma(lanes, byId, p);
        expect(lenValue(out)).toBe('2B');
    });

    it('unit=bit 引用纯字节块 → byte 尺寸×8（3B → 24b）', () => {
        const p = { children: [
            { id: 'body', type: 'fixed', byte_length: 3 },
            { id: 'len', type: 'length', byte_length: 1, parameter_config: { refs: ['body'], unit: 'bit' } },
        ] };
        const lanes = protocolTree.buildProtocolLanes(p, []);
        const byId = protocolTree.computeProtocolOffsets(p).byId;
        const out = protocolTree.injectRefsSigma(lanes, byId, p);
        expect(lenValue(out)).toBe('24b');
    });

    it('unit=bit 引用容器 → 递归 Σ 子 bit（4+4=8）', () => {
        const p = { children: [
            { id: 'g', type: 'container', children: [
                { id: 'x', type: 'bitfield', byte_length: 1, bit_len: 4 },
                { id: 'y', type: 'bitfield', byte_length: 1, bit_len: 4 },
            ] },
            { id: 'len', type: 'length', byte_length: 1, parameter_config: { refs: ['g'], unit: 'bit' } },
        ] };
        const lanes = protocolTree.buildProtocolLanes(p, []);
        const byId = protocolTree.computeProtocolOffsets(p).byId;
        const out = protocolTree.injectRefsSigma(lanes, byId, p);
        expect(lenValue(out)).toBe('8b');
    });
});
