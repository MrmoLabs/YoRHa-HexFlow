import { describe, it, expect } from 'vitest';
import {
    getFieldEpoch,
    packBitfieldDefault,
    classifyRunnerField,
    formatEnumOptions,
    formatTimeDisplay,
    resolveFieldDisplay,
    collectSemanticItems
} from '../runnerRenderRules';

// C6 加工页参数渲染下沉：渲染规则抽为可测试配置后的回归锁。
// 口径与 InstructionEncoder/normalizeRunnerInstruction 保持一致。

const leaf = (over = {}) => ({
    id: 'f1',
    name: '测试字段',
    op_code: 'INPUT',
    byte_len: 1,
    parameter_config: {},
    ...over
});

describe('classifyRunnerField（字段分类）', () => {
    it('计算类：CALCULATED / LENGTH_CALC / CHECKSUM_CRC / formula=auto / type=length|checksum', () => {
        expect(classifyRunnerField(leaf({ op_code: 'CALCULATED' })).isCalculated).toBe(true);
        expect(classifyRunnerField(leaf({ op_code: 'LENGTH_CALC' })).isCalculated).toBe(true);
        expect(classifyRunnerField(leaf({ op_code: 'CHECKSUM_CRC' })).isCalculated).toBe(true);
        expect(classifyRunnerField(leaf({ parameter_config: { formula: 'auto' } })).isCalculated).toBe(true);
        expect(classifyRunnerField(leaf({ parameter_config: { type: 'length' } })).isCalculated).toBe(true);
        expect(classifyRunnerField(leaf({ parameter_config: { type: 'checksum' } })).isCalculated).toBe(true);
        expect(classifyRunnerField(leaf()).isCalculated).toBe(false);
    });

    it('时间累计：op_code 或 original_op_code（TIME_ACCUMULATOR）或 type 命中', () => {
        expect(classifyRunnerField(leaf({ op_code: 'TIME_CUMULATIVE' })).isTimeCumulative).toBe(true);
        expect(classifyRunnerField(leaf({ original_op_code: 'TIME_ACCUMULATOR' })).isTimeCumulative).toBe(true);
        expect(classifyRunnerField(leaf({ parameter_config: { type: 'time_cumulative' } })).isTimeCumulative).toBe(true);
        expect(classifyRunnerField(leaf()).isTimeCumulative).toBe(false);
    });

    it('固定类：FIXED / HEX_RAW（含 original_op_code 回退）/ readOnly；时间累计优先于固定', () => {
        expect(classifyRunnerField(leaf({ op_code: 'FIXED' })).isFixed).toBe(true);
        expect(classifyRunnerField(leaf({ original_op_code: 'HEX_RAW' })).isFixed).toBe(true);
        expect(classifyRunnerField(leaf({ parameter_config: { readOnly: true } })).isFixed).toBe(true);
        // normalizeRunnerInstruction 把 op_code 改写成 INPUT 但保留 original_op_code
        expect(classifyRunnerField(leaf({ op_code: 'INPUT', original_op_code: 'FIXED' })).isFixed).toBe(true);
        // 时间累计字段即使带 readOnly 也走时间渲染（handleTimeClick）
        expect(classifyRunnerField(leaf({
            op_code: 'TIME_CUMULATIVE',
            parameter_config: { readOnly: true }
        })).isFixed).toBe(false);
        expect(classifyRunnerField(leaf()).isFixed).toBe(false);
    });

    it('枚举类：非空 options（数组/对象）或 op_code=MAPPING', () => {
        expect(classifyRunnerField(leaf({ parameter_config: { options: [{ label: 'A', value: 1 }] } })).isEnum).toBe(true);
        expect(classifyRunnerField(leaf({ parameter_config: { options: { A: 1 } } })).isEnum).toBe(true);
        expect(classifyRunnerField(leaf({ op_code: 'MAPPING' })).isEnum).toBe(true);
        expect(classifyRunnerField(leaf({ parameter_config: { options: [] } })).isEnum).toBe(false);
        expect(classifyRunnerField(leaf({ parameter_config: { options: {} } })).isEnum).toBe(false);
    });

    it('可编辑 = 非计算且非固定', () => {
        expect(classifyRunnerField(leaf()).isEditable).toBe(true);
        expect(classifyRunnerField(leaf({ op_code: 'CALCULATED' })).isEditable).toBe(false);
        expect(classifyRunnerField(leaf({ op_code: 'FIXED' })).isEditable).toBe(false);
    });
});

describe('formatEnumOptions（选项归一）', () => {
    it('对象数组保留结构并把十六进制字符串值转数字', () => {
        expect(formatEnumOptions([
            { label: 'ON', value: '0A' },
            { label: 'OFF', value: 0 }
        ])).toEqual([
            { label: 'ON', value: 10 },
            { label: 'OFF', value: 0 }
        ]);
    });

    it('原始值数组转 {label,value}；对象映射取键为 label', () => {
        expect(formatEnumOptions(['A', 5])).toEqual([
            { label: 'A', value: 10 }, // 'A' 是十六进制字符串 -> parseInt('A',16)=10
            { label: '5', value: 5 }
        ]);
        expect(formatEnumOptions({ MODE_A: 1, MODE_B: 'B' })).toEqual([
            { label: 'MODE_A', value: 1 },
            { label: 'MODE_B', value: 11 }
        ]);
    });

    it('空/缺失返回空数组', () => {
        expect(formatEnumOptions(undefined)).toEqual([]);
        expect(formatEnumOptions([])).toEqual([]);
        expect(formatEnumOptions({})).toEqual([]);
    });
});

describe('formatTimeDisplay / getFieldEpoch（时间累计显示）', () => {
    it('默认基准 2000-01-01，秒偏移格式化为 YYYY-MM-DD HH:mm:ss', () => {
        expect(formatTimeDisplay({}, 90)).toBe('2000-01-01 00:01:30');
    });

    it('支持空格分隔的 base_time，并跨日进位', () => {
        expect(formatTimeDisplay({ base_time: '2000-06-15 10:30:00' }, 90 * 60))
            .toBe('2000-06-15 12:00:00');
    });

    it('允许负秒（基准时间之前）', () => {
        expect(formatTimeDisplay({}, -1)).toBe('1999-12-31 23:59:59');
    });

    it('getFieldEpoch 同时接受 T 分隔与空格分隔', () => {
        expect(getFieldEpoch({}).getFullYear()).toBe(2000);
        expect(getFieldEpoch({ base_time: '2010-05-05T08:00:00' }).getFullYear()).toBe(2010);
        expect(getFieldEpoch({ base_time: '2010-05-05 08:00:00' }).getHours()).toBe(8);
    });
});

describe('packBitfieldDefault（BITFIELD 默认值打包，镜像编码器）', () => {
    it('按 start_bit/bit_len/default_val 打包并按字节数补零', () => {
        expect(packBitfieldDefault([
            { start_bit: 0, bit_len: 4, default_val: 5 },
            { start_bit: 4, bit_len: 4, default_val: 10 }
        ], 1)).toBe('A5');
        expect(packBitfieldDefault([{ start_bit: 0, bit_len: 8, default_val: 0xAB }], 1)).toBe('AB');
        expect(packBitfieldDefault([], 2)).toBe('0000');
        expect(packBitfieldDefault(undefined, 1)).toBe('00');
    });
});

describe('resolveFieldDisplay（显示值解析）', () => {
    it('固定字段：显示大写 HEX/value，只读文本类型', () => {
        const r = resolveFieldDisplay(leaf({
            op_code: 'FIXED',
            parameter_config: { hex: 'aabb' }
        }));
        expect(r).toMatchObject({ displayValue: 'AABB', inputType: 'text', placeholder: '' });
    });

    it('HEX_RAW 缺值按字节数补零；完全无数据给 NO DATA 占位', () => {
        expect(resolveFieldDisplay(leaf({
            original_op_code: 'HEX_RAW',
            byte_len: 2,
            parameter_config: {}
        })).displayValue).toBe('0000');

        expect(resolveFieldDisplay(leaf({
            op_code: 'FIXED',
            parameter_config: {}
        })).placeholder).toBe('NO DATA');
    });

    it('时间累计：格式化文本 + 只读 text 类型', () => {
        const r = resolveFieldDisplay(
            leaf({ id: 't1', op_code: 'TIME_CUMULATIVE', parameter_config: {} }),
            { inputs: { t1: 90 } }
        );
        expect(r).toMatchObject({ displayValue: '2000-01-01 00:01:30', inputType: 'text' });
    });

    it('计算字段：computedValues 优先，按 byte_len 补零为大写 hex；byte_len=0 显示空', () => {
        expect(resolveFieldDisplay(
            leaf({ op_code: 'LENGTH_CALC', byte_len: 2, parameter_config: {} }),
            { computedValues: { f1: 255 } }
        ).displayValue).toBe('00FF');

        expect(resolveFieldDisplay(
            leaf({ op_code: 'LENGTH_CALC', byte_len: 0, parameter_config: {} }),
            { computedValues: { f1: 7 } }
        ).displayValue).toBe('');

        // 无 byte_len 时保持原始数值
        expect(resolveFieldDisplay(
            leaf({ op_code: 'CALCULATED', byte_len: undefined, parameter_config: {} }),
            { computedValues: { f1: 255 } }
        ).displayValue).toBe(255);

        // computedValues 缺省回退 0（byte_len=1 -> '00'）
        expect(resolveFieldDisplay(
            leaf({ op_code: 'LENGTH_CALC', byte_len: 1, parameter_config: {} }),
            {}
        ).displayValue).toBe('00');
    });

    it('枚举字段：inputs 优先、select 类型、computedValues 兜底', () => {
        const field = leaf({ parameter_config: { options: [{ label: 'ON', value: 1 }] } });
        expect(resolveFieldDisplay(field, { inputs: { f1: 1 } }))
            .toMatchObject({ displayValue: 1, inputType: 'select' });
        expect(resolveFieldDisplay(field, { computedValues: { f1: 7 } }).displayValue).toBe(7);
        expect(resolveFieldDisplay(field, {}).displayValue).toBe(0);
    });

    it('普通可编辑字段（定长）：hex 类型 + 大写补零 + 零占位符', () => {
        const r = resolveFieldDisplay(
            leaf({ byte_len: 2, parameter_config: { type: 'number' } }),
            { inputs: { f1: 10 } }
        );
        expect(r).toMatchObject({
            displayValue: '000A',
            placeholder: '0000',
            inputType: 'hex'
        });
    });

    it('非 hex 语义 type（decimal/text）不转 hex，透传原值', () => {
        const r = resolveFieldDisplay(
            leaf({ byte_len: 2, parameter_config: { type: 'decimal' } }),
            { inputs: { f1: 10 } }
        );
        expect(r).toMatchObject({ displayValue: 10, inputType: 'decimal' });
    });

    it('无 byte_len 的可变字段：?? [VAR] 占位', () => {
        const r = resolveFieldDisplay(
            leaf({ byte_len: 0, parameter_config: {} }),
            {}
        );
        expect(r.placeholder).toBe('?? [VAR]');
        expect(r.displayValue).toBeUndefined();
    });

    it('BITFIELD 无输入时显示打包后的默认值 hex（镜像编码器）', () => {
        const r = resolveFieldDisplay(
            leaf({
                op_code: 'BITFIELD',
                byte_len: 1,
                parameter_config: {},
                bits: [
                    { start_bit: 0, bit_len: 4, default_val: 5 },
                    { start_bit: 4, bit_len: 4, default_val: 10 }
                ]
            }),
            {}
        );
        expect(r).toMatchObject({ displayValue: 'A5', inputType: 'hex', placeholder: '00' });
    });
});

describe('collectSemanticItems（A6 语义参数标签）', () => {
    it('factor/offset 输出标签（B4 已解 · E1-3 定标落地，不再挂限制引用）', () => {
        expect(collectSemanticItems(leaf({
            parameter_config: { factor: 2, offset: 100 }
        }))).toEqual([
            { text: 'FACTOR=2', ref: null },
            { text: 'OFFSET=100', ref: null }
        ]);
    });

    it('COUNTER 的 step/max 语义参数（B8 已解 · E1-6 落地，不再挂限制引用）', () => {
        expect(collectSemanticItems(leaf({
            op_code: 'COUNTER_UP',
            parameter_config: { step: 1, max: 10 }
        }))).toEqual([
            { text: 'STEP=1', ref: null },
            { text: 'MAX=10', ref: null }
        ]);
        expect(collectSemanticItems(leaf({
            parameter_config: { step: 1 }
        }))[0].ref).toBeNull();
    });

    it('max_count 输出标签（B7 已解 · E1-5 展开落地，不再挂限制引用）', () => {
        expect(collectSemanticItems(leaf({
            parameter_config: { max_count: 3 }
        }))).toEqual([{ text: 'MAX LOOP=3', ref: null }]);
    });

    it('checksum algo 归一显示；algorithm 键优先于 algo', () => {
        expect(collectSemanticItems(leaf({
            parameter_config: { algorithm: 'CRC_16_MODBUS' }
        }))).toEqual([{ text: 'ALGO=CRC_16_MODBUS', ref: null }]);

        // algo 别名归一（ADD_SUM -> SUM_8），未知值回退 CRC_16_MODBUS
        expect(collectSemanticItems(leaf({
            parameter_config: { algo: 'ADD_SUM' }
        }))[0].text).toBe('ALGO=SUM_8');
        expect(collectSemanticItems(leaf({
            parameter_config: { algo: 'CRC32' }
        }))[0].text).toBe('ALGO=CRC_16_MODBUS');

        // algorithm 已存在时 algo 键被跳过（不重复输出）
        expect(collectSemanticItems(leaf({
            parameter_config: { algorithm: 'XOR_8', algo: 'ADD_SUM' }
        }))).toEqual([{ text: 'ALGO=XOR_8', ref: null }]);
    });

    it('空值/未登记键不输出', () => {
        expect(collectSemanticItems(leaf({ parameter_config: { factor: '' } }))).toEqual([]);
        expect(collectSemanticItems(leaf({ parameter_config: { factor: null } }))).toEqual([]);
        expect(collectSemanticItems(leaf({ parameter_config: { factor: undefined } }))).toEqual([]);
        expect(collectSemanticItems(leaf({ parameter_config: { foo: 1 } }))).toEqual([]);
        expect(collectSemanticItems(leaf())).toEqual([]);
    });
});
