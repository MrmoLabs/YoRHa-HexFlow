import { describe, it, expect } from 'vitest';
import { OP_CODES } from '../../constants';
import {
    KNOWN_OP_LIST,
    NEUTRAL_PARAM_KEYS,
    applyOpDefaults,
    planOpSwitch,
    switchableOps,
    describeOpSwitch,
} from '../opSwitch';

// 算子模板形状与 backend/routers/operator.py SEED_TEMPLATES 同步（BE 侧
// test_operator_templates 锁形状与覆盖，此处只取本测试要用的 op）。
const TEMPLATES = {
    HEX_RAW: { param_template: { hex: 'input' } },
    STRING: { param_template: { value: 'string', encoding: ['ascii', 'utf8'], pad_char: '00' } },
    INT_UNSIGNED: { param_template: { bits: [8, 16, 32, 64] } },
    FLOAT_IEEE: { param_template: { bits: [32, 64] } },
    SCALED_DECIMAL: { param_template: { factor: 'number', offset: 'number' } },
    BITFIELD: { param_template: { bit_layout: 'bit_editor' } },
    MAPPING: { param_template: { options: 'kv_pair_list' } },
    ARRAY_GROUP: { param_template: { max_count: 'number' } },
    LENGTH_CALC: { param_template: { refs: 'field_picker', formula: 'string' } },
    CHECKSUM_CRC: {
        param_template: {
            refs: 'field_picker',
            algo: ['CRC_16_MODBUS', 'CRC_16_CCITT', 'CRC_32', 'LRC', 'SUM_8', 'XOR_8'],
        },
    },
    TIME_ACCUMULATOR: { param_template: { base_time: '1980-01-01T00:00:00' } },
    AUTO_COUNTER: { param_template: { start_val: 0, step: 1, max: 65535 } },
    TIME_EPOCH: { param_template: { unit: ['s', 'ms'] } },
};

const leaf = (over = {}) => ({
    id: 'b1', name: '甲', sequence: 0, parent_id: null,
    op_code: 'INT_UNSIGNED', byte_len: 4,
    parameter_config: { bits: 32, value: 7 },
    ...over,
});

const plan = (block, to, opts = {}) => planOpSwitch(block, to, { templates: TEMPLATES, ...opts });

describe('R24 · 可切换算子清单（switchableOps）', () => {
    it('= 有模板的 OP_CODES（STRUCT 无模板不进），HEX_RAW 居首', () => {
        const ops = switchableOps(TEMPLATES, null);
        expect(ops).toContain(OP_CODES.HEX_RAW);
        expect(ops[0]).toBe(OP_CODES.HEX_RAW);
        // STRUCT 在 OP_CODES 里但没有算子模板 → 不提供（调色板同源）
        expect(ops).not.toContain(OP_CODES.STRUCT);
        // 本 fixture 比 OP_CODES 少 STRUCT + 4 个未列出的业务算子时，只断言「有模板的都在」
        Object.keys(TEMPLATES).forEach((op) => expect(ops).toContain(op));
    });

    it('当前算子（legacy 无模板）恒列第一 —— 存量字段渲染不出空下拉', () => {
        expect(switchableOps(TEMPLATES, 'INPUT')[0]).toBe('INPUT');
        expect(switchableOps(TEMPLATES, OP_CODES.STRUCT)[0]).toBe(OP_CODES.STRUCT);
    });

    it('已知算子全集 = 22 项（与 BE KNOWN_OPS / validateInstruction 同源）', () => {
        expect(KNOWN_OP_LIST).toHaveLength(22);
        expect(new Set(KNOWN_OP_LIST).has('INPUT')).toBe(true);
    });
});

describe('R24 · planOpSwitch 兼容校验', () => {
    it('未知算子 → 拒绝并给出算子名', () => {
        const r = plan(leaf(), 'WEIRD_OP');
        expect(r.ok).toBe(false);
        expect(r.code).toBe('OP_UNKNOWN');
        expect(r.message).toContain('WEIRD_OP');
    });

    it('同算子 → SAME_OP，不产生转换', () => {
        const b = leaf();
        const r = plan(b, OP_CODES.INT_UNSIGNED);
        expect(r.ok).toBe(true);
        expect(r.code).toBe('SAME_OP');
        expect(r.next).toBe(b);
    });

    it('容器切成叶算子且带子块 → 拦（子块会变孤儿）', () => {
        const g = leaf({ op_code: OP_CODES.ARRAY_GROUP, byte_len: 0, parameter_config: { max_count: 3 } });
        const r = plan(g, OP_CODES.INT_UNSIGNED, { childCount: 2 });
        expect(r.ok).toBe(false);
        expect(r.code).toBe('GROUP_HAS_CHILDREN');
        expect(r.message).toContain('2 个子块');
        expect(r.message).toContain('孤儿');
    });

    it('容器切成叶算子但子块已移出 → 放行', () => {
        const g = leaf({ op_code: OP_CODES.ARRAY_GROUP, byte_len: 0, parameter_config: { max_count: 3 } });
        const r = plan(g, OP_CODES.INT_UNSIGNED, { childCount: 0 });
        expect(r.ok).toBe(true);
        expect(r.next.op_code).toBe(OP_CODES.INT_UNSIGNED);
    });

    it('叶 → 容器：放行（空组），静态值摘除、byte_len 归 0、max_count 播种 1', () => {
        const r = plan(leaf({ parameter_config: { value: 9 } }), OP_CODES.ARRAY_GROUP);
        expect(r.ok).toBe(true);
        expect(r.next.byte_len).toBe(0);
        expect(r.next.parameter_config.max_count).toBe(1);
        expect(r.next.parameter_config.value).toBeUndefined();
    });

    it('组 → 组：max_count 保留', () => {
        const g = leaf({
            op_code: OP_CODES.ARRAY_GROUP, byte_len: 0,
            parameter_config: { max_count: 5 },
        });
        const r = plan(g, OP_CODES.STRUCT);
        expect(r.ok).toBe(true);
        expect(r.next.parameter_config.max_count).toBe(5);
    });
});

describe('R24 · 参数裁剪（中性键保留 / 算子专属键清除）', () => {
    it('中性键全数保留，源算子专属键清除且进 dropped', () => {
        const b = leaf({
            op_code: OP_CODES.TIME_ACCUMULATOR,
            parameter_config: {
                base_time: '2000-01-01T00:00:00',
                value: 9, refs: ['x1'], presence: { ref_id: 'p1', expect: 1 },
                align: 4, pad_to: 8, pad_byte: 'AA', endianness: 'LITTLE', input_base: 'dec',
            },
        });
        const r = plan(b, OP_CODES.AUTO_COUNTER);
        const pc = r.next.parameter_config;

        NEUTRAL_PARAM_KEYS.forEach((k) => expect(Object.keys(pc)).toContain(k));
        expect(pc.value).toBe(9);
        expect(pc.refs).toEqual(['x1']);
        expect(pc.base_time).toBeUndefined();          // 源算子专属 → 清除
        expect(r.dropped).toContain('base_time');
        // 目标算子默认态播种
        expect(pc.start_val).toBe(0);
        expect(pc.step).toBe(1);
        expect(pc.max).toBe(65535);
    });

    it('数组污染修复：unit / algo 落首元素标量（显示与编码同读一份）', () => {
        expect(plan(leaf(), OP_CODES.TIME_EPOCH).next.parameter_config.unit).toBe('s');
        const r = plan(leaf({ byte_len: 2, parameter_config: { bits: 16 } }), OP_CODES.CHECKSUM_CRC);
        expect(r.next.parameter_config.algo).toBe('CRC_16_MODBUS');
        expect(r.next.parameter_config.algorithm).toBe('CRC_16_MODBUS');
        expect(Array.isArray(r.next.parameter_config.algo)).toBe(false);
    });

    it('编辑器数组 _kvArray：切入 MAPPING 补空数组、切走摘掉且不进 dropped（派生键）', () => {
        const into = plan(leaf({ parameter_config: { options: { A: '00' }, _kvArray: [] } }), OP_CODES.MAPPING);
        expect(into.next.parameter_config._kvArray).toEqual([]);
        expect(into.next.parameter_config.options).toBeUndefined();
        expect(into.dropped).not.toContain('_kvArray');
        expect(into.dropped).toContain('options');
    });
});

describe('R24 · 位宽与默认态（applyOpDefaults 单源）', () => {
    it('位宽枚举能容纳原 byte_len 就保留（4B → bits 32，长度不断链）', () => {
        const r = plan(leaf({ byte_len: 4, parameter_config: { bits: 32 } }), OP_CODES.FLOAT_IEEE);
        expect(r.next.parameter_config.bits).toBe(32);
        expect(r.next.byte_len).toBe(4);
        expect(r.bitsDelta).toBe(null);
        expect(r.byteLen).toEqual([4, 4]);
    });

    it('容纳不下 → 回落模板首项并同步 byte_len（1B → FLOAT 32/4B），回执报位宽与长度', () => {
        const r = plan(leaf({ byte_len: 1, parameter_config: { bits: 8 } }), OP_CODES.FLOAT_IEEE);
        expect(r.next.parameter_config.bits).toBe(32);
        expect(r.next.byte_len).toBe(4);
        expect(r.bitsDelta).toBe('8 → 32');
        expect(r.byteLen).toEqual([1, 4]);
    });

    it('HEX_RAW：切入按 byte_len 播种等长 hex，切走摘掉 hex', () => {
        const r = plan(leaf({ byte_len: 2, parameter_config: { bits: 16, value: 5 } }), OP_CODES.HEX_RAW);
        expect(r.next.parameter_config.hex).toBe('0000');
        expect(r.next.parameter_config.value).toBe(5);

        const out = plan(
            leaf({ op_code: OP_CODES.HEX_RAW, byte_len: 2, parameter_config: { hex: 'ABCD' } }),
            OP_CODES.INT_UNSIGNED,
        );
        expect(out.next.parameter_config.hex).toBeUndefined();
        expect(out.dropped).toContain('hex');
    });

    it('STRING：切入保留原 byte_len、播种 type=string 与 encoding 标量', () => {
        const r = plan(leaf({ byte_len: 4, parameter_config: { value: 'HI' } }), OP_CODES.STRING);
        expect(r.next.byte_len).toBe(4);
        expect(r.next.parameter_config.type).toBe('string');
        expect(r.next.parameter_config.encoding).toBe('ascii');
        expect(r.next.parameter_config.value).toBe('HI');
    });

    it('BITFIELD：切入播种一段 8-bit 位图，切走摘掉 bits 并计入 dropped', () => {
        const r = plan(leaf({ byte_len: 1, parameter_config: {} }), OP_CODES.BITFIELD);
        expect(r.next.bits).toHaveLength(1);
        expect(r.next.bits[0].bit_len).toBe(8);
        expect(r.next.byte_len).toBe(1);

        const back = plan(
            leaf({ op_code: OP_CODES.BITFIELD, byte_len: 2, bits: [{ id: 's1' }] }),
            OP_CODES.INT_UNSIGNED,
        );
        expect(back.ok).toBe(true);
        expect(back.next.bits).toBeUndefined();   // 位段只属于 BITFIELD
        expect(back.dropped).toContain('bits');
    });

    it('新建语义（不传 preferByteLen）与 handleAddBlock 同口径', () => {
        const int = applyOpDefaults({ byte_len: 1, parameter_config: {} }, OP_CODES.INT_UNSIGNED, TEMPLATES.INT_UNSIGNED);
        expect(int.parameter_config.bits).toBe(8);
        expect(int.byte_len).toBe(1);

        const str = applyOpDefaults({ byte_len: 1, parameter_config: {} }, OP_CODES.STRING, TEMPLATES.STRING);
        expect(str.byte_len).toBe(8);
        expect(str.parameter_config.type).toBe('string');
        expect(str.parameter_config.encoding).toBe('ascii');
        expect(str.parameter_config.value).toBeUndefined(); // 'string' 是控件 keyword，不复制

        const hex = applyOpDefaults({ byte_len: 3, parameter_config: {} }, OP_CODES.HEX_RAW, TEMPLATES.HEX_RAW);
        expect(hex.parameter_config.hex).toBe('000000');

        const grp = applyOpDefaults({ byte_len: 1, parameter_config: {} }, OP_CODES.ARRAY_GROUP, TEMPLATES.ARRAY_GROUP);
        expect(grp.byte_len).toBe(0);
        expect(grp.parameter_config.max_count).toBe(1);

        const bits = applyOpDefaults({ byte_len: 1, parameter_config: {} }, OP_CODES.BITFIELD, TEMPLATES.BITFIELD);
        expect(bits.parameter_config.bit_layout).toBeUndefined(); // 'bit_editor' 是控件 keyword
        expect(bits.bits).toHaveLength(1);
    });
});

describe('R24 · 确认回执（describeOpSwitch）', () => {
    it('列出 to/from、保留项、清除项、位宽与字节长度变化、APPLY 提示', () => {
        const r = plan(
            leaf({ byte_len: 1, parameter_config: { bits: 8, value: 3, base_time: '2000-01-01T00:00:00' } }),
            OP_CODES.FLOAT_IEEE,
        );
        const msg = describeOpSwitch(r);
        expect(msg).toContain('切换算子：INT_UNSIGNED → FLOAT_IEEE');
        expect(msg).toContain('保留：value');
        expect(msg).toContain('清除：base_time');
        expect(msg).toContain('位宽：8 → 32');
        expect(msg).toContain('字节长度：1B → 4B');
        expect(msg).toContain('APPLY');
    });

    it('长度未变时不报字节长度行（避免噪声）', () => {
        const r = plan(leaf({ byte_len: 4 }), OP_CODES.INT_SIGNED);
        expect(describeOpSwitch(r)).not.toContain('字节长度');
    });
});
