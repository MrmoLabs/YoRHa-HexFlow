// R27 硬前置（§8.52 排期 · varint / COBS **出线**）：**无变长编码时逐字节不变**。
//
// 与后端 backend/tests/test_framing_baseline.py 成对 —— 两侧都是**先于 R27 改动**
// 从当前代码抓取的出线金标准。R27 的两条能力（length 卡 `parameter_config.encoding
// = "varint"` / 组帧元素 `cobs`）都必须**显式配置**才生效，故本文件的断言在落码后
// 必须依旧全绿：任何一条变红 = 变长编码漏进了缺省路径（§0 硬约束被破坏）。
import { describe, it, expect } from 'vitest';
import { InstructionEncoder } from '../InstructionEncoder';
import { mergeProtocolInstruction } from '../blockMerge';
import wrapVec from '../../../../vectors/wrap.json';

// 形状对齐 config/blockTypes.js createBlock 产物（同 InstructionEncoder.test.js
// 「R1 协议节点编码」harness）：type / hex_value / byte_length / children。
const pf = (id, hex, byte_length = 1) => ({ id, label: id, type: 'fixed', byte_length, hex_value: hex, children: undefined });
const pc = (id, children) => ({ id, label: id, type: 'container', byte_length: 0, children });
const ps = (id) => ({ id, label: id, type: 'slot', byte_length: 1, hex_value: '00' });
const pl = (id, refs, byte_length = 1, extra = {}) => ({
    id, label: id, type: 'length', byte_length, hex_value: '00',
    parameter_config: { type: 'length', refs, ...extra },
});
const pk = (id, refs, byte_length = 1, extra = {}) => ({
    id, label: id, type: 'checksum', byte_length, hex_value: '00',
    parameter_config: { type: 'checksum', refs, ...extra },
});

const run = (blocks, opts) => {
    const tree = { blocks };
    const inputs = InstructionEncoder.getInitialValues(tree);
    const computed = InstructionEncoder.resolveDependencies(tree, inputs);
    return InstructionEncoder.encodeInstruction(tree, inputs, computed, opts).hexString.replace(/\s/g, '');
};

describe('R27 硬前置：FE 出线字节基线（无 varint / 无 cobs）', () => {
    it('fixed + 空容器：容器 0 字节、禁用语义不涉（FE 无 is_enabled 分支）', () => {
        expect(run([pf('a1', 'FA FA', 2), pf('a3', 'AA')])).toBe('FAFAAA');
    });

    it('length refs Σ（大端缺省）+ checksum refs：FE 现状金标准', () => {
        // 注：checksum byte_length=2 + SUM_8 —— FE 8 位折返（formula.js reduce
        // `(a+b)&0xFF`）→ 00F7，BE 全和定宽 → 01F7，**存量双端差异**（非 R27 范围，
        // 两侧基线各钉各的现值；byte_length=1 时两侧同为 F7 不显现）。
        const hex = run([
            pf('h', 'FA FA', 2),
            pf('p', '01 02', 2),
            pl('l', ['h', 'p'], 1),
            pk('c', ['h', 'p'], 2, { algorithm: 'SUM_8' }),
        ]);
        expect(hex).toBe('FAFA01020400F7');
    });

    it('slot 归零 + 容器递归：与 BE 直发口径同字节', () => {
        expect(run([pf('h', 'A0'), ps('s')])).toBe('A0');
        expect(run([pc('g', [pf('g1', '11')]), pf('le', '01 02', 2)])).toBe('110102');
    });

    it('resolveDependencies 不改块宽（varint 的宽度回写只在显式 encoding 时发生）', () => {
        const blocks = [
            pf('h', 'FA FA', 2),
            pf('p', '01 02', 2),
            pl('l', ['h', 'p'], 1),
            pc('g', [pf('g1', '11')]),
        ];
        const before = blocks.map((b) => [b.id, b.byte_length, (b.children || []).length]);
        const tree = { blocks };
        const inputs = InstructionEncoder.getInitialValues(tree);
        InstructionEncoder.resolveDependencies(tree, inputs);
        InstructionEncoder.encodeInstruction(tree, inputs, {}, {});
        const after = blocks.map((b) => [b.id, b.byte_length, (b.children || []).length]);
        expect(after).toEqual(before);
    });

    it('共享向量 vectors/wrap.json · main：merge + encode 与后端同字节', () => {
        const protocol = { id: 'p1', label: '向量协议', type: 'container', children: wrapVec.main.children };
        const instruction = {
            id: 'i1', name: '指令',
            fields: wrapVec.main.payloads.map((hex, i) => ({
                id: `f${i + 1}`, parent_id: null, sequence: i, name: '载荷',
                byte_length: hex.length / 2, op_code: 'HEX_RAW', parameter_config: { hex },
            })),
        };
        const merged = mergeProtocolInstruction(protocol, instruction);
        expect(run(merged)).toBe('FAFA020102ED');
    });
});
