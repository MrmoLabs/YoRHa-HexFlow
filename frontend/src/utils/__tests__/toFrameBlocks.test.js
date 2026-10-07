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
        // R22: 三个新算法的出口翻译（FE ChecksumAlgo → 后端 params.algorithm）
        expect(paramsOf('CRC_16_CCITT').algorithm).toBe('crc16_ccitt');
        expect(paramsOf('CRC_32').algorithm).toBe('crc32');
        expect(paramsOf('LRC').algorithm).toBe('lrc');
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

// R21（§8.52 排期 · 长度域 BE/LE）：length 字节序出口翻译 —— 镜像后端
// frame_builder._with_byte_order（两处同形，改一必改二）。只在值为 little 时写键，
// 缺省 / big / 枚举外不写 → params 形状与存量逐字节一致（§0 缺省口径）。
describe('toFrameBlocks（R21: length 字节序出口翻译）', () => {
    const lengthParamsOf = (byte_order) => toFrameBlocks([
        leaf('a', { type: 'fixed' }),
        leaf('L', {
            type: 'length',
            parameter_config: {
                type: 'length', refs: ['a'],
                ...(byte_order !== undefined ? { byte_order } : {})
            }
        })
    ])[1].config.params;

    it('little → params.byte_order = little（后端 LengthHandler 据此反转字节对）', () => {
        expect(lengthParamsOf('little')).toEqual({ refs: ['a'], byte_order: 'little' });
    });

    it('big / 缺省 / 枚举外 → 不写键（params 形状与存量逐字节一致）', () => {
        expect(lengthParamsOf('big')).toEqual({ refs: ['a'] });
        expect(lengthParamsOf(undefined)).toEqual({ refs: ['a'] });
        expect(lengthParamsOf('middle')).toEqual({ refs: ['a'] });
    });

    it('R42 trim 归一：带首尾空白的 little 照样写键；big / 枚举外仍不写', () => {
        // 后端 `frame_builder._with_byte_order` 与 `byte_order_of` 一直带
        // `.strip()`，FE 这道出口翻译此前不 trim —— 同一个值会让**出口翻译**不写键
        // 而**后端按 pc 直读**写键。归一后两端同判（R34 §8.66 留白已销项）。
        expect(lengthParamsOf(' LITTLE ')).toEqual({ refs: ['a'], byte_order: 'little' });
        expect(lengthParamsOf(' little ')).toEqual({ refs: ['a'], byte_order: 'little' });
        expect(lengthParamsOf(' big ')).toEqual({ refs: ['a'] });
        expect(lengthParamsOf(' middle ')).toEqual({ refs: ['a'] });
    });

    it('存量行（无 refs 键的直通路径）同样带上字节序', () => {
        const [b] = toFrameBlocks([
            leaf('L', { type: 'length', config: { legacy: 1 }, parameter_config: { byte_order: 'little' } })
        ]);
        expect(b.config).toEqual({ legacy: 1, params: { byte_order: 'little' } });
    });

    it('R34 翻面：闸门只开 length / checksum 两卡 —— 第三类块型仍不吃 byte_order', () => {
        // R21 期本用例断言「非 length 一律不写（checksum 也在外）」；R34 把
        // checksum 收进闸门（§8.66 成对缺口「另开」）后，剩下的真命题是
        // **第三类块型仍不吃** —— 闸门没有整体放开。
        const byType = (type) => toFrameBlocks([
            leaf('a', { type: 'fixed' }),
            leaf('X', { type, parameter_config: { byte_order: 'little' } })
        ])[1];
        expect(byType('fixed').config).toBeNull();
        expect(byType('slot').config).toBeNull();
        expect(byType('cobs').config).toBeNull();
        // 对照：两卡在闸门内（checksum 的算法枚举照常并存）
        expect(toFrameBlocks([
            leaf('a', { type: 'fixed' }),
            leaf('C', {
                type: 'checksum',
                parameter_config: { type: 'checksum', refs: ['a'], byte_order: 'little' }
            })
        ])[1].config.params).toEqual({ refs: ['a'], algorithm: 'crc16_modbus', byte_order: 'little' });
    });
});

// R34（§8.66 排期 · 校验和字节序）：checksum 卡字节序出口翻译 —— 镜像后端
// frame_builder._with_byte_order（两处同形，改一必改二）。**R21 的成对缺口**：
// 当年拍板「仅 length 卡」，checksum 的 byte_order 留到本批「另开」。同样只在
// 值为 little 时写键，缺省 / big / 枚举外不写 → params 形状与存量逐字节一致（§0）。
// encoding（R27 varint）仍是 length 专属 —— checksum 卡无此字段，闸门不放开。
describe('toFrameBlocks（R34: checksum 字节序出口翻译）', () => {
    const checksumParamsOf = (pc) => toFrameBlocks([
        leaf('a', { type: 'fixed' }),
        leaf('C', {
            type: 'checksum',
            parameter_config: { type: 'checksum', refs: ['a'], ...pc }
        })
    ])[1].config.params;

    it('little → params.byte_order = little（后端 ChecksumHandler 据此反转字节对）', () => {
        expect(checksumParamsOf({ byte_order: 'little' }))
            .toEqual({ refs: ['a'], algorithm: 'crc16_modbus', byte_order: 'little' });
    });

    it('big / 缺省 / 枚举外 / 大小写非 little → 不写键（形状与存量逐字节一致）', () => {
        for (const byte_order of ['big', undefined, 'middle', '']) {
            expect(checksumParamsOf(byte_order === undefined ? {} : { byte_order }))
                .toEqual({ refs: ['a'], algorithm: 'crc16_modbus' });
        }
    });

    it('算法枚举照常翻译（字节序不是算法的替代，两者并存）', () => {
        expect(checksumParamsOf({ algorithm: 'CRC_32', byte_order: 'little' }))
            .toEqual({ refs: ['a'], algorithm: 'crc32', byte_order: 'little' });
    });

    it('checksum 不吃 length 专属的 varint 出线编码（闸门只对 byte_order 放开）', () => {
        expect(checksumParamsOf({ encoding: 'varint' }))
            .toEqual({ refs: ['a'], algorithm: 'crc16_modbus' });
    });

    it('无 refs 的直通路径同样带上字节序（镜像 length 直通）', () => {
        const [b] = toFrameBlocks([
            leaf('C', { type: 'checksum', config: { legacy: 1 }, parameter_config: { byte_order: 'little' } })
        ]);
        expect(b.config).toEqual({ legacy: 1, params: { byte_order: 'little' } });
    });
});


// R27 (§8.52 排期 · varint / COBS 出线 · §8.59): 出口翻译三则 ——
//   pc.encoding / pc.terminator 只在非缺省时写键（params 形状与存量逐字节一致）；
//   refs 展开遇 cobs 停钻（编码边界跨不过，镜像后端 frame_builder.expand）。
describe('toFrameBlocks varint / COBS 出线（R27 §8.59）', () => {
    const lengthOf = (pc) => toFrameBlocks([
        leaf('a', { type: 'fixed' }),
        leaf('L', { type: 'length', parameter_config: { type: 'length', refs: ['a'], ...pc } })
    ])[1];

    it('pc.encoding=varint → params.encoding=varint；缺省/fixed/枚举外不写键', () => {
        expect(lengthOf({ encoding: 'varint' }).config.params).toEqual({ refs: ['a'], encoding: 'varint' });
        expect(lengthOf({ encoding: 'fixed' }).config.params).toEqual({ refs: ['a'] });
        expect(lengthOf({ encoding: 'leb' }).config.params).toEqual({ refs: ['a'] });
        expect(lengthOf({}).config.params).toEqual({ refs: ['a'] });
    });

    it('varint 叠 little 两键并存（端有关丟互不相干）', () => {
        expect(lengthOf({ encoding: 'varint', byte_order: 'little' }).config.params)
            .toEqual({ refs: ['a'], byte_order: 'little', encoding: 'varint' });
    });

    it('cobs：pc.terminator=none → params.terminator=none；缺省/00/枚举外不写键', () => {
        const cobsOf = (terminator) => toFrameBlocks([{
            id: 'c', label: 'c', type: 'cobs', byte_length: 0,
            children: [leaf('x', { type: 'fixed' })],
            ...(terminator !== undefined ? { parameter_config: { type: 'cobs', terminator } } : {})
        }])[0];
        expect(cobsOf('none').config).toEqual({ params: { terminator: 'none' } });
        expect(cobsOf('00').config).toBeNull();
        expect(cobsOf('NONE').config).toEqual({ params: { terminator: 'none' } }); // 两端 lowercase 收
        expect(cobsOf('junk').config).toBeNull();
        expect(cobsOf(undefined).config).toBeNull();
        // 类型/子树原样透传（后端 _rewrite_cobs 用子树编码、两侧都保留供 LEN/CRC 卡面回显）
        expect(cobsOf('none').type).toBe('cobs');
        expect(cobsOf('none').is_container).toBe(true);
        expect(cobsOf('none').children.map(c => c.id)).toEqual(['x']);
    });

    it('refs 展开遇 cobs 停钻：只计 cobs 块自身 id，其子叶不入 refs', () => {
        const blocks = toFrameBlocks([
            {
                id: 'wrap', label: 'w', type: 'container', byte_length: 0,
                children: [{
                    id: 'c', label: 'c', type: 'cobs', byte_length: 0,
                    children: [leaf('inner', { type: 'fixed' })]
                }]
            },
            leaf('L', { type: 'length', parameter_config: { type: 'length', refs: ['wrap', 'c'] } })
        ]);
        expect(blocks[1].config.params.refs).toEqual(['c', 'c']); // 容器 ref 撞 cobs 停钻 + 直引 cobs
        expect(blocks[1].config.params.refs).not.toContain('inner');
    });
});
