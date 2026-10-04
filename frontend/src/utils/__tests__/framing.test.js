// R27（§8.52 排期 · varint / COBS 出线 · §8.59）: 变长长度前缀与定界编码 ——
// **只编码、不解包**（收侧 stages 逆向解包 + 应答匹配属 R28，本批一行不碰）。
//
// 共享向量单一真相源 = vectors/framing.json（varint 14 · cobs 16 · frame 5），
// 与 backend/tests/test_framing.py 同读一份（改一必改二）。cobs 期望值另由本文件
// 自带的**规范解码器**（与 framing.cobsEncode 零共享代码）往返复核，防「期望值 =
// 实现自证」——解码不进生产代码，正是「只做编码不碰解包」的字面执行。

import { describe, it, expect } from 'vitest';
import framingVec from '../../../../vectors/framing.json';
import { loadVectors } from '../../../../vectors/vectors.js';
import {
    VARINT_MAX, bytesToHex, encodeCobsHex, encodeVarint,
    hexToBytes, normalizeEncoding, terminatorBytes, varintWidth
} from '../framing';
import { InstructionEncoder } from '../InstructionEncoder';
import { computeProtocolOffsets } from '../protocolTree';

const VEC = loadVectors(framingVec);

const compact = (hex) => String(hex || '').replace(/\s/g, '');

// 测试内局部解码器（与实现零共享代码，纯复核用）：码 - 1 = 字面量数；非末块
// 且码 != 0xFF → 补回一个 0x00（满块闭合的 FF 块后面没有被替换的零）。
const cobsDecodeRef = (data) => {
    if (!data.length) throw new Error('empty stream');
    const out = [];
    let i = 0;
    while (i < data.length) {
        const code = data[i];
        if (code === 0) throw new Error('code byte is zero');
        i += 1;
        const take = code - 1;
        if (i + take > data.length) throw new Error('truncated');
        for (let k = 0; k < take; k += 1) out.push(data[i + k]);
        i += take;
        if (code !== 0xff && i < data.length) out.push(0);
    }
    return out;
};

// —— FE block 形状（对齐 config/blockTypes.js createBlock 产物，编码器直读） ——
const fixed = (id, hex) => ({
    id, label: id, type: 'fixed',
    byte_length: compact(hex).length / 2, hex_value: hex, children: []
});
// extra → parameter_config（encoding/offset 等），blockExtra → 卡自身（byte_length 定宽）
const len = (id, refs, extra = {}, blockExtra = {}) => ({
    id, label: id, type: 'length', byte_length: 1, hex_value: '00',
    parameter_config: { type: 'length', refs, ...extra }, children: [], ...blockExtra
});
const cobsNode = (id, kids, extra = {}) => ({
    id, label: id, type: 'cobs', byte_length: 0, hex_value: null,
    parameter_config: { type: 'cobs', terminator: '00', ...extra }, children: kids
});

// 与页面同序：先 resolveDependencies（PASS0→1→1.5→2）再 encodeInstruction。
const encodeBlocks = (blocks) => {
    const computed = InstructionEncoder.resolveDependencies({ blocks }, {});
    const out = InstructionEncoder.encodeInstruction({ blocks }, {}, computed);
    return { hex: compact(out.hexString), byteMap: out.byteMap, computed };
};

describe('framing（R27 · 编码 SSOT，与 backend/core/framing.py 同形）', () => {
    it('共享向量 varint：LEB128 最小无符号与 BE 同字节，宽度同源', () => {
        VEC.varint.forEach((row) => {
            expect(bytesToHex(encodeVarint(row.v))).toBe(row.hex);
            expect(varintWidth(row.v)).toBe(row.hex.length / 2);
        });
    });

    it('varint 值域：负 / 超 2^53-1 / 非整数 → 空字节 + null 宽度（后端同值 ValueError → 400）', () => {
        expect(encodeVarint(-1)).toEqual([]);
        expect(encodeVarint(VARINT_MAX + 1)).toEqual([]);
        expect(encodeVarint(1.5)).toEqual([]);
        expect(encodeVarint('12')).toEqual([]);
        expect(varintWidth(-1)).toBeNull();
        expect(varintWidth(VARINT_MAX + 1)).toBeNull();
    });

    it('normalizeEncoding fail-open：缺失 / 空 / 枚举外 → fixed（镜像 BE）', () => {
        expect(normalizeEncoding(undefined)).toBe('fixed');
        expect(normalizeEncoding(null)).toBe('fixed');
        expect(normalizeEncoding({})).toBe('fixed');
        expect(normalizeEncoding({ encoding: 'VARINT' })).toBe('varint');
        expect(normalizeEncoding({ encoding: ' leb ' })).toBe('fixed');
        expect(normalizeEncoding({ encoding: 7 })).toBe('fixed');
    });

    it('共享向量 cobs：标准 COBS + 定界与 BE 同字节（含 254 满块边界行）', () => {
        VEC.cobs.forEach((row) => {
            expect(encodeCobsHex(row.in, { terminator: row.term })).toBe(row.out);
        });
    });

    it('cobs 往返：本文件规范解码器可还原全部向量（解码不进生产代码）', () => {
        VEC.cobs.forEach((row) => {
            const enc = hexToBytes(encodeCobsHex(row.in, { terminator: 'none' }));
            expect(cobsDecodeRef(enc)).toEqual(hexToBytes(row.in));
        });
    });

    it('cobs 出线正文不含 0x00（定界字节除外）—— 定界编码的存在理由', () => {
        VEC.cobs.forEach((row) => {
            const body = row.term === '00' ? row.out.slice(0, -2) : row.out;
            expect(body).not.toContain('00');
        });
    });

    it('terminator fail-open：缺失 / 非法 → 追加 0x00；none → 不追加', () => {
        expect(terminatorBytes(undefined)).toEqual([0x00]);
        expect(terminatorBytes({})).toEqual([0x00]);
        expect(terminatorBytes({ terminator: '00' })).toEqual([0x00]);
        expect(terminatorBytes({ terminator: 'none' })).toEqual([]);
        expect(terminatorBytes({ terminator: 'junk' })).toEqual([0x00]);
    });
});

describe('InstructionEncoder（R27 · 出线方向：varint / COBS 组帧）', () => {
    it('共享向量 frame：端到端与后端 build_wrapped 同帧（唯一承载 payload 的行由 blockMerge 发送期负责，此处跳过）', () => {
        const skipped = VEC.frame.filter(row => (row.payloads || []).length > 0).map(row => row.name);
        expect(skipped).toEqual(['cobs_payload_slot']);

        VEC.frame.forEach((row) => {
            if ((row.payloads || []).length > 0) return;
            const { hex } = encodeBlocks(row.children);
            expect(hex).toBe(row.expect_hex);
            expect(hex.length / 2).toBe(row.expect_length);
            // 尺与编码器同宽（偏移尺 / 出线一个宽），总长两处一致
            expect(computeProtocolOffsets({ children: row.children }).total).toBe(row.expect_length);
        });
    });

    it('varint 出线宽度回写：引用 varint 块的 LEN 按真实宽度计（镜像 BE byte_length 回写）', () => {
        const p = fixed('p', 'AA'.repeat(128));       // Σ = 128 → varint 2 字节（设计期 1）
        const l1 = len('l1', ['p'], { encoding: 'varint' });
        const l2 = len('l2', ['l1'], {}, { byte_length: 2 }); // 定宽 2B 承接回写后的宽度
        const { hex } = encodeBlocks([p, l1, l2]);
        expect(hex.endsWith('8001' + '0002')).toBe(true); // 未回写会是 80010001
        expect(hex.length / 2).toBe(128 + 2 + 2);
    });

    it('refs 引 cobs 块本身 → 按出线字节数计（PASS1.5 尺寸回填 + 再跑一遍 Σ）', () => {
        // 内层 00AA → COBS 0102AA + 定界 00 = 4 字节
        const c = cobsNode('c', [fixed('x', '00'), fixed('y', 'AA')]);
        const { hex } = encodeBlocks([c, len('l', ['c'])]);
        expect(hex).toBe('0102AA0004');
    });

    it('cobs 子树三态：嵌套由内向外 / 空子树 01+定界 / terminator=none 不追加', () => {
        const inner = cobsNode('ci', [fixed('x', '00')]);
        expect(encodeBlocks([cobsNode('co', [fixed('y', 'AA'), inner])]).hex)
            .toBe('04AA01010100');
        expect(encodeBlocks([cobsNode('c', [])]).hex).toBe('0100');
        const tree = [cobsNode('c', [
            fixed('ih', 'FA FA'), len('il', ['ip']), fixed('ip', '07')
        ], { terminator: 'none' })];
        expect(encodeBlocks(tree).hex).toBe('05FAFA0107');
    });

    it('byteMap 只记 cobs 块自身出线区间（子块区间落在编码区内无意义，镜像 BE block_spans）', () => {
        const { byteMap } = encodeBlocks([cobsNode('c', [
            fixed('ih', 'FA FA'), len('il', ['ip']), fixed('ip', '07')
        ])]);
        expect(byteMap).toHaveLength(1);
        expect(byteMap[0]).toMatchObject({ fieldId: 'c', start: 0, end: 6 });
    });

    it('无 cobs 节点的存量树：编码与既有输出逐字节一致（PASS1.5 零改写）', () => {
        const blocks = [fixed('h', 'FA FA'), len('l', ['p']), fixed('p', '07')];
        expect(encodeBlocks(blocks).hex).toBe('FAFA0107');
    });
});

describe('computeProtocolOffsets（R27 · 出线宽度进偏移尺）', () => {
    it('varint 长度块按出线宽算，其后块起点与总长随之右移', () => {
        const protocol = {
            children: [
                fixed('h', 'FA FA'),
                len('l', ['p'], { encoding: 'varint' }),
                fixed('p', 'AA'.repeat(128))
            ]
        };
        const off = computeProtocolOffsets(protocol);
        expect(off.byId.get('l').size).toBe(2);   // 设计期 1 → 出线 2
        expect(off.byId.get('p').offset).toBe(4);
        expect(off.total).toBe(132);
        expect(off.exact).toBe(true);
        expect(off.variable).toBe(false);
    });

    it('cobs 组两遍法回灌精确出线宽（其后起点 / 总长与 BE block_spans 同口径）', () => {
        const protocol = {
            children: [
                cobsNode('c', [fixed('ih', 'FA FA'), len('il', ['ip']), fixed('ip', '07')]),
                fixed('t', '55')
            ]
        };
        const off = computeProtocolOffsets(protocol);
        expect(off.byId.get('c').size).toBe(6);   // 05FAFA010700
        expect(off.byId.get('t').offset).toBe(6);
        expect(off.total).toBe(7); // cobs 出线 6 + t 1
        expect(off.exact).toBe(true);
    });

    it('子树含槽（载荷期才定字节）→ cobs 尺寸落未知，不谎报成 Σ 下界', () => {
        const slot = { id: 's', label: 's', type: 'slot', byte_length: 1, hex_value: null, children: [] };
        const protocol = {
            children: [cobsNode('c', [fixed('h', 'FA FA'), slot]), fixed('t', '55')]
        };
        const off = computeProtocolOffsets(protocol);
        expect(off.byId.get('c').size).toBeNull();
        expect(off.byId.get('t').offset).toBeNull();
        expect(off.exact).toBe(false);
    });

    it('无 cobs 节点的存量协议：单遍口径不变（不跑第二遍，尺寸/总长与既有逐值一致）', () => {
        const protocol = { children: [fixed('h', 'FA FA'), len('l', ['p']), fixed('p', '07')] };
        const off = computeProtocolOffsets(protocol);
        expect(off.byId.get('l').size).toBe(1);
        expect(off.total).toBe(4);
        expect(off.exact).toBe(true);
        expect(off.variable).toBe(false);
    });
});
