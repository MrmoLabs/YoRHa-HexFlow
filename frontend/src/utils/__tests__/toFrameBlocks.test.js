import { describe, it, expect } from 'vitest';
import { toFrameBlocks } from '../toFrameBlocks';

// 批次四 (R2 打通) 向量表: parameter_config → config.params 出口翻译 ——
// 后端 LengthHandler/ChecksumHandler 据 params.refs 走集合模式，此前死
// config={} 恒输出 00。非 logic 块 / 无 refs 键的存量行直通，行为不变。

const leaf = (id, extra = {}) => ({ id, label: id, byte_length: 1, hex_value: '00', ...extra });

// 批 4：bitfield 块位段透传（后端 Orchestrator 发射期打包用）
describe('toFrameBlocks（批 4: bitfield 位段透传）', () => {
    it('位段搬进 config.params.bits（类型/位偏移/位宽/默认值），type=bitfield', () => {
        const [b] = toFrameBlocks([leaf('bf', {
            type: 'bitfield',
            bits: [
                { id: '1', bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1 },
                { id: '2', bit_name: 'EN', start_bit: 2, bit_len: 1, default_val: 1 }
            ]
        })]);
        expect(b.type).toBe('bitfield');
        expect(b.config.params.bits).toEqual([
            { bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1 },
            { bit_name: 'EN', start_bit: 2, bit_len: 1, default_val: 1 }
        ]);
    });

    it('非法位段在出口剔除（非整数 / 位宽 <1 / 负起点），不把脏数据送后端', () => {
        const [b] = toFrameBlocks([leaf('bf', {
            type: 'bitfield',
            bits: [
                { bit_name: 'OK', start_bit: 0, bit_len: 4, default_val: 3 },
                { bit_name: 'BAD', start_bit: NaN, bit_len: 4, default_val: 0 },
                { bit_name: 'BAD2', start_bit: 4, bit_len: 0, default_val: 0 },
                { bit_name: 'BAD3', start_bit: -1, bit_len: 2, default_val: 0 }
            ]
        })]);
        expect(b.config.params.bits).toEqual([{ bit_name: 'OK', start_bit: 0, bit_len: 4, default_val: 3 }]);
    });

    it('无位段的 bitfield → params.bits 空数组（后端 00 填充），非 fixed 回落', () => {
        const [b] = toFrameBlocks([leaf('bf', { type: 'bitfield', bits: [] })]);
        expect(b.type).toBe('bitfield');
        expect(b.config.params.bits).toEqual([]);
    });

    it('存量 fixed 块出口逐字不变（不因批 4 改形）', () => {
        const [b] = toFrameBlocks([leaf('a', { type: 'fixed', hex_value: 'FA FA', byte_length: 2 })]);
        expect(b).toEqual({
            id: 'a', type: 'fixed', label: 'a', byte_length: 2, hex_value: 'FA FA',
            config: null, children: [], is_container: false, is_enabled: true
        });
    });
});

describe('toFrameBlocks（批次四: logic 块 config.params 翻译）', () => {
    it('length: refs 叶子直传；无 refs 键的存量行 config 直通不变', () => {
        const blocks = toFrameBlocks([
            leaf('a', { type: 'fixed' }),
            leaf('L', { type: 'length', parameter_config: { type: 'length', refs: ['a'] } }),
            leaf('old', { type: 'length', config: { legacy: 1 } }) // 存量行无 pc → 直通
        ]);
        expect(blocks[1].config.params).toEqual({ refs: ['a'] });
        expect(blocks[1].config.params.algorithm).toBeUndefined(); // length 不带算法
        expect(blocks[2].config).toEqual({ legacy: 1 });
        expect(blocks[0].config).toBeNull(); // fixed 无 config
    });

    it('checksum: 算法枚举映射到后端小写枚举，缺省 CRC_16_MODBUS（前端编码器同源）', () => {
        const paramsOf = (algorithm) => toFrameBlocks([
            leaf('a', { type: 'fixed' }),
            leaf('C', {
                type: 'checksum',
                parameter_config: { type: 'checksum', refs: ['a'], ...(algorithm !== undefined ? { algorithm } : {}) }
            })
        ])[1].config.params;
        expect(paramsOf('SUM_8').algorithm).toBe('sum');
        expect(paramsOf('XOR_8').algorithm).toBe('xor');
        expect(paramsOf('CRC_16_MODBUS').algorithm).toBe('crc16_modbus');
        expect(paramsOf(undefined).algorithm).toBe('crc16_modbus');
        expect(paramsOf(undefined).refs).toEqual(['a']);
    });

    it('refs 保数组序；容器 ref 展开子树叶子文档序；悬空丢弃', () => {
        const out = toFrameBlocks([
            leaf('x', { type: 'fixed' }),
            { id: 'g', label: 'g', type: 'container', byte_length: 0, children: [leaf('g1'), leaf('g2')] },
            leaf('y', { type: 'fixed' }),
            leaf('L', { type: 'length', parameter_config: { type: 'length', refs: ['y', 'g', 'ghost', 'x'] } })
        ]);
        // y 在前（数组序）→ 容器 g → [g1, g2]（文档序展开）→ ghost 丢 → x
        expect(out[3].config.params.refs).toEqual(['y', 'g1', 'g2', 'x']);
    });

    it('嵌套容器递归展开；op_code 推断型（指令侧 LENGTH_CALC + pc.refs）同样翻译', () => {
        const out = toFrameBlocks([
            {
                id: 'g', label: 'g',
                children: [{ id: 'gg', label: 'gg', children: [leaf('deep')] }]
            },
            { id: 'f2', label: '长度', op_code: 'LENGTH_CALC', byte_len: 2, parameter_config: { refs: ['g'] } }
        ]);
        expect(out[0].type).toBe('container'); // 无显式 type → children 推断
        expect(out[1].type).toBe('length'); // op_code 推断
        expect(out[1].byte_length).toBe(2);
        expect(out[1].config.params.refs).toEqual(['deep']); // 嵌套容器 → 递归到叶子
    });

    it('非 logic 块 config 直通（container/fixed 不受翻译影响）', () => {
        const out = toFrameBlocks([
            { id: 'g', label: 'g', config: { keep: 1 }, children: [leaf('k')] },
            leaf('a', { config: { x: 2 } })
        ]);
        expect(out[0].config).toEqual({ keep: 1 });
        expect(out[1].config).toEqual({ x: 2 });
    });
});
