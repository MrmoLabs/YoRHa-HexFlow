import { describe, it, expect } from 'vitest';
import {
    getFieldEpoch,
    packBitfieldDefault,
    classifyRunnerField,
    formatEnumOptions,
    formatTimeDisplay,
    resolveFieldDisplay,
    collectSemanticItems,
    computeFieldInputLimits,
    resolveRunnerKind,
    computeStringUsage,
    parseBcdInput,
    parseFloatInput,
    advanceAutoCounter
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

    // 批 1：字段级录入进制（parameter_config.input_base='dec'）——
    // 定长整数字段从 hex 通道切到十进制通道，显示十进制原值（不补零），
    // 值存储恒数值 → InstructionEncoder / 后端口径不变。
    it('input_base=dec：定长整数字段走十进制通道（十进制原值，不补零）', () => {
        const field = leaf({ byte_len: 2, parameter_config: { type: 'number', input_base: 'dec' } });
        expect(resolveFieldDisplay(field, { inputs: { f1: 255 } }))
            .toMatchObject({ displayValue: 255, inputType: 'decimal' });
        // 无输入态：原值 undefined（不塞 0），placeholder 给字段数值域 0..65535（第 14 单：占位即域）
        expect(resolveFieldDisplay(field, {}))
            .toMatchObject({ displayValue: undefined, inputType: 'decimal', placeholder: '0..65535' });
    });

    it('input_base=dec：仅影响 hex 语义 type；string/text/decimal/float 通道原样透传', () => {
        const dec = (t) => leaf({ byte_len: 1, parameter_config: { type: t, input_base: 'dec' } });
        expect(resolveFieldDisplay(dec('string'), { inputs: { f1: 'A' } }))
            .toMatchObject({ displayValue: 'A', inputType: 'string' });
        expect(resolveFieldDisplay(dec('text'), { inputs: { f1: 'B' } }))
            .toMatchObject({ displayValue: 'B', inputType: 'text' });
        expect(resolveFieldDisplay(dec('decimal'), { inputs: { f1: 10 } }))
            .toMatchObject({ displayValue: 10, inputType: 'decimal' });
        expect(resolveFieldDisplay(dec('float'), { inputs: { f1: 1.5 } }))
            .toMatchObject({ displayValue: 1.5, inputType: 'float' });
    });

    it('input_base=dec：BITFIELD 同步走十进制通道（默认值仍是打包整数，非 hex 串）', () => {
        const r = resolveFieldDisplay(leaf({
            op_code: 'BITFIELD',
            byte_len: 1,
            parameter_config: { input_base: 'dec' },
            bits: [{ start_bit: 0, bit_len: 4, default_val: 5 }, { start_bit: 4, bit_len: 4, default_val: 10 }]
        }), {});
        // 打包默认 0xA5 = 165 → 十进制原值
        expect(r).toMatchObject({ displayValue: 165, inputType: 'decimal' });
    });

    it('input_base 大小写不敏感；缺省/真非法值 → 保持 hex 通道（存量零影响）', () => {
        // 手改 JSON 写成 'DEC' 不应被静默降级成 hex
        expect(resolveFieldDisplay(leaf({ byte_len: 2, parameter_config: { input_base: 'DEC' } }), { inputs: { f1: 16 } }))
            .toMatchObject({ displayValue: 16, inputType: 'decimal' });
        // 缺省
        expect(resolveFieldDisplay(leaf({ byte_len: 2, parameter_config: {} }), { inputs: { f1: 16 } }))
            .toMatchObject({ displayValue: '0010', inputType: 'hex' });
        // 真非法值（未来进制 / 脏数据）→ 回退 hex（'bin' 已升为真实通道，见优化批）
        expect(resolveFieldDisplay(leaf({ byte_len: 2, parameter_config: { input_base: 'oct' } }), { inputs: { f1: 16 } }))
            .toMatchObject({ displayValue: '0010', inputType: 'hex' });
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

describe('computeFieldInputLimits（定长字段输入限制，第 4 批 #4）', () => {
    it('可编辑 hex 通道：maxLength = 字节数×2 + 数值域 0..2^(8n)-1', () => {
        expect(computeFieldInputLimits(leaf({ byte_len: 1 })))
            .toEqual({ byteLen: 1, maxLength: 2, min: 0, max: 255 });
        expect(computeFieldInputLimits(leaf({ byte_len: 4 })))
            .toEqual({ byteLen: 4, maxLength: 8, min: 0, max: 4294967295 });
    });

    it('超大位宽封顶 MAX_SAFE_INTEGER（2^64-1 超出安全整数）', () => {
        expect(computeFieldInputLimits(leaf({ byte_len: 8 })).max)
            .toBe(Number.MAX_SAFE_INTEGER);
    });

    it('INT_SIGNED：有符号域（1B -128..127、4B -2^31..2^31-1）', () => {
        expect(computeFieldInputLimits(leaf({ op_code: 'INT_SIGNED', byte_len: 1 })))
            .toEqual({ byteLen: 1, maxLength: 2, min: -128, max: 127 });
        expect(computeFieldInputLimits(leaf({ op_code: 'INT_SIGNED', byte_len: 4 })))
            .toEqual({ byteLen: 4, maxLength: 8, min: -2147483648, max: 2147483647 });
    });

    it('SCALED_DECIMAL：按 factor/offset 反算输入域（factor=2 → 0..127）；factor=0 恒等 0 → 不设域', () => {
        expect(computeFieldInputLimits(leaf({
            op_code: 'SCALED_DECIMAL', byte_len: 1, parameter_config: { factor: 2 }
        }))).toEqual({ byteLen: 1, maxLength: 2, min: 0, max: 127 });
        expect(computeFieldInputLimits(leaf({
            op_code: 'SCALED_DECIMAL', byte_len: 1, parameter_config: { factor: 0, offset: 10 }
        }))).toEqual({ byteLen: 1, maxLength: 2 });
    });

    it('非 hex 通道（如 type boolean）：有数值域、无 maxLength', () => {
        expect(computeFieldInputLimits(leaf({
            byte_len: 1, parameter_config: { type: 'boolean' }
        }))).toEqual({ byteLen: 1, min: 0, max: 255 });
    });

    // 批 1：十进制通道下不得回吐 hex 字符数上限（maxLength 仅 hex 通道消费），
    // 数值域照用 —— 与 resolveFieldDisplay 的 input_base 分支同判据。
    it('input_base=dec：有数值域、无 maxLength（hex 字符上限对十进制无效）', () => {
        expect(computeFieldInputLimits(leaf({ byte_len: 1, parameter_config: { input_base: 'dec' } })))
            .toEqual({ byteLen: 1, min: 0, max: 255 });
        expect(computeFieldInputLimits(leaf({ byte_len: 4, parameter_config: { input_base: 'dec' } })))
            .toEqual({ byteLen: 4, min: 0, max: 4294967295 });
        // 有符号域照用
        expect(computeFieldInputLimits(leaf({ op_code: 'INT_SIGNED', byte_len: 1, parameter_config: { input_base: 'dec' } })))
            .toEqual({ byteLen: 1, min: -128, max: 127 });
        // SCALED_DECIMAL 反算域照用
        expect(computeFieldInputLimits(leaf({ op_code: 'SCALED_DECIMAL', byte_len: 1, parameter_config: { factor: 2, input_base: 'dec' } })))
            .toEqual({ byteLen: 1, min: 0, max: 127 });
    });

    it('input_base 大小写不敏感；缺省/非法值 → 维持既有 maxLength（存量零影响）', () => {
        expect(computeFieldInputLimits(leaf({ byte_len: 1, parameter_config: { input_base: 'DEC' } })))
            .toEqual({ byteLen: 1, min: 0, max: 255 });
        expect(computeFieldInputLimits(leaf({ byte_len: 1, parameter_config: { input_base: 'oct' } })))
            .toEqual({ byteLen: 1, maxLength: 2, min: 0, max: 255 });
    });

    it('不设限：string/decimal/float 类型、枚举、只读/计算/时间字段、无 byte_len', () => {
        expect(computeFieldInputLimits(leaf({ parameter_config: { type: 'string' } }))).toBeNull();
        expect(computeFieldInputLimits(leaf({ parameter_config: { type: 'decimal' } }))).toBeNull();
        expect(computeFieldInputLimits(leaf({ parameter_config: { type: 'float' } }))).toBeNull();
        expect(computeFieldInputLimits(leaf({ parameter_config: { options: ['A', 'B'] } }))).toBeNull();
        expect(computeFieldInputLimits(leaf({ op_code: 'FIXED', parameter_config: { hex: '01' } }))).toBeNull();
        expect(computeFieldInputLimits(leaf({ op_code: 'LENGTH_CALC' }))).toBeNull();
        expect(computeFieldInputLimits(leaf({ op_code: 'TIME_CUMULATIVE' }))).toBeNull();
        expect(computeFieldInputLimits(leaf({ byte_len: undefined }))).toBeNull();
    });
});

// 优化批 1（市场调研后优化）：input_base='bin' 第三态 —— 位模式回显。
// 与 hex/dec 同口径：只换 UI 解析/回显层，值存储恒数值 → encoder/后端不变。
describe('优化批 1：BIN 二进制通道（input_base=bin）', () => {
    it('定长整数字段走二进制通道：位模式定宽回显 + inputType=binary', () => {
        expect(resolveFieldDisplay(leaf({ parameter_config: { input_base: 'bin' } }), { inputs: { f1: 10 } }))
            .toMatchObject({ displayValue: '00001010', inputType: 'binary', placeholder: '00000000' });
        expect(resolveFieldDisplay(leaf({ byte_len: 2, parameter_config: { input_base: 'BIN' } }), { inputs: { f1: 0x0102 } }))
            .toMatchObject({ displayValue: '0000000100000010', inputType: 'binary' });
        // 无输入态：原值 undefined（不塞 0），placeholder 按位宽
        expect(resolveFieldDisplay(leaf({ parameter_config: { input_base: 'bin' } }), {}))
            .toMatchObject({ displayValue: undefined, inputType: 'binary', placeholder: '00000000' });
    });

    it('BITFIELD 无输入态：打包默认 hex 串 → 二进制位模式', () => {
        const r = resolveFieldDisplay(leaf({
            op_code: 'BITFIELD',
            byte_len: 1,
            parameter_config: { input_base: 'bin' },
            bits: [{ start_bit: 0, bit_len: 4, default_val: 5 }, { start_bit: 4, bit_len: 4, default_val: 10 }]
        }), {});
        // 打包默认 0xA5 → 10100101
        expect(r).toMatchObject({ displayValue: '10100101', inputType: 'binary' });
    });

    it('仅影响 hex 语义 type：string/text/float 通道原样透传', () => {
        const binOf = (t) => leaf({ byte_len: 1, parameter_config: { type: t, input_base: 'bin' } });
        expect(resolveFieldDisplay(binOf('string'), { inputs: { f1: 'A' } }))
            .toMatchObject({ displayValue: 'A', inputType: 'string' });
        expect(resolveFieldDisplay(binOf('text'), { inputs: { f1: 'B' } }))
            .toMatchObject({ displayValue: 'B', inputType: 'text' });
        expect(resolveFieldDisplay(binOf('float'), { inputs: { f1: 1.5 } }))
            .toMatchObject({ displayValue: 1.5, inputType: 'float' });
    });

    it('computeFieldInputLimits：maxLength=位宽、无数值域（位模式语义，域交给 dec 通道）', () => {
        expect(computeFieldInputLimits(leaf({ parameter_config: { input_base: 'bin' } })))
            .toEqual({ byteLen: 1, maxLength: 8 });
        expect(computeFieldInputLimits(leaf({ byte_len: 2, parameter_config: { input_base: 'bin' } })))
            .toEqual({ byteLen: 2, maxLength: 16 });
        // 有符号字段按位模式（负数无法用二进制位串直输）
        expect(computeFieldInputLimits(leaf({ op_code: 'INT_SIGNED', parameter_config: { input_base: 'bin' } })))
            .toEqual({ byteLen: 1, maxLength: 8 });
        // 枚举/非整数类型仍不设限
        expect(computeFieldInputLimits(leaf({ parameter_config: { options: ['A'], input_base: 'bin' } }))).toBeNull();
    });
});

// ===== 第 14 单（加工页字段种类感知 · 红测先行）=====
// 种类章的 lane 判定必须与 resolveFieldDisplay 同源 —— 章说的种类就是输入
// 实际走的通道，杜绝「章 F32、输入却是 hex 通道」的错位。

describe('第 14 单：resolveRunnerKind 种类章', () => {
    const kindOf = (f) => resolveRunnerKind(f);

    it('只读/固定 → FIX；时间 → TIME；计算族按算子细分 LEN/CKSUM/CALC', () => {
        expect(kindOf(leaf({ op_code: 'HEX_RAW', byte_len: 1, parameter_config: {} })))
            .toMatchObject({ key: 'FIX', label: 'FIX' });
        expect(kindOf(leaf({ op_code: 'TIME_CUMULATIVE', byte_len: undefined, parameter_config: {} })))
            .toMatchObject({ key: 'TIME', label: 'TIME' });
        expect(kindOf(leaf({ op_code: 'LENGTH_CALC', byte_len: undefined, parameter_config: {} })))
            .toMatchObject({ key: 'LEN', label: 'LEN' });
        expect(kindOf(leaf({ op_code: 'CHECKSUM_CRC', byte_len: undefined, parameter_config: {} })))
            .toMatchObject({ key: 'CKSUM', label: 'CKSUM' });
        expect(kindOf(leaf({ op_code: 'INPUT', parameter_config: { formula: 'auto' } })))
            .toMatchObject({ key: 'CALC', label: 'CALC' });
    });

    it('数值/编码族：F32 / BCD / SCALE / TEXT / SINT / UINT', () => {
        expect(kindOf(leaf({ op_code: 'FLOAT_IEEE', byte_len: 4, parameter_config: {} }))).toMatchObject({ key: 'F32' });
        expect(kindOf(leaf({ op_code: 'BCD_CODE', byte_len: 2, parameter_config: {} }))).toMatchObject({ key: 'BCD' });
        expect(kindOf(leaf({ op_code: 'SCALED_DECIMAL', byte_len: 4, parameter_config: { factor: 2 } }))).toMatchObject({ key: 'SCALE' });
        expect(kindOf(leaf({ op_code: 'STRING', byte_len: 8, parameter_config: { type: 'string' } }))).toMatchObject({ key: 'TEXT' });
        // 存量 INPUT + type=string 同样按文本种类出章
        expect(kindOf(leaf({ byte_len: 8, parameter_config: { type: 'string' } }))).toMatchObject({ key: 'TEXT' });
        expect(kindOf(leaf({ op_code: 'INT_SIGNED', byte_len: 1, parameter_config: {} }))).toMatchObject({ key: 'SINT' });
        expect(kindOf(leaf({ op_code: 'INT_UNSIGNED', byte_len: 1, parameter_config: {} }))).toMatchObject({ key: 'UINT' });
    });

    // R5（§8.42）：byte_len=8 真出 float64 → 章标 F64；4 / 未设宽度维持 F32。
    it('R5 FLOAT_IEEE 位宽出章：8 → F64，4 / 缺省 → F32', () => {
        expect(kindOf(leaf({ op_code: 'FLOAT_IEEE', byte_len: 8, parameter_config: {} })))
            .toMatchObject({ key: 'F64', label: 'F64' });
        expect(kindOf(leaf({ op_code: 'FLOAT_IEEE', byte_len: 8, parameter_config: {} })).title)
            .toMatch(/float64/);
        expect(kindOf(leaf({ op_code: 'FLOAT_IEEE', byte_len: 4, parameter_config: {} })))
            .toMatchObject({ key: 'F32', label: 'F32' });
        expect(kindOf(leaf({ op_code: 'FLOAT_IEEE', parameter_config: {} })))
            .toMatchObject({ key: 'F32' });
    });

    it('枚举 → MAP；位域 → BIT；计数 → CNT；组 → STRUCT/ARRAY；旧算子/兜底 → IN/HDR/VAR', () => {
        expect(kindOf(leaf({ op_code: 'MAPPING', parameter_config: { options: { A: 1 } } }))).toMatchObject({ key: 'MAP' });
        expect(kindOf(leaf({ op_code: 'INPUT', parameter_config: { options: [1, 2] } }))).toMatchObject({ key: 'MAP' });
        expect(kindOf(leaf({ op_code: 'BITFIELD', byte_len: 1, parameter_config: {} }))).toMatchObject({ key: 'BIT' });
        expect(kindOf(leaf({ op_code: 'AUTO_COUNTER', byte_len: 1, parameter_config: {} }))).toMatchObject({ key: 'CNT' });
        expect(kindOf(leaf({ op_code: 'STRUCT', byte_len: 0, parameter_config: {} }))).toMatchObject({ key: 'STRUCT' });
        expect(kindOf(leaf({ op_code: 'ARRAY_GROUP', byte_len: 0, parameter_config: {} }))).toMatchObject({ key: 'ARRAY' });
        expect(kindOf(leaf({ op_code: 'INPUT', byte_len: 2, parameter_config: {} }))).toMatchObject({ key: 'IN' });
        expect(kindOf(leaf({ op_code: 'HEADER', byte_len: 2, parameter_config: {} }))).toMatchObject({ key: 'HDR' });
        expect(kindOf(leaf({ op_code: 'WEIRD_OP', byte_len: 2, parameter_config: {} }))).toMatchObject({ key: 'VAR' });
    });

    it('title 全部非空（tooltip 说明编码特性）', () => {
        ['HEX_RAW', 'FLOAT_IEEE', 'BCD_CODE', 'STRING', 'INT_SIGNED'].forEach((op) => {
            const k = kindOf(leaf({
                op_code: op, byte_len: 2,
                parameter_config: op === 'STRING' ? { type: 'string' } : {}
            }));
            expect(typeof k.title).toBe('string');
            expect(k.title.length).toBeGreaterThan(0);
        });
    });
});

describe('第 14 单：FLOAT_IEEE / BCD_CODE 通道贴合（修复 hex 通道错位）', () => {
    it('FLOAT_IEEE（type 缺省/number）强制十进制小数通道，input_base 覆盖无效', () => {
        expect(resolveFieldDisplay(
            leaf({ op_code: 'FLOAT_IEEE', byte_len: 4, parameter_config: {} }),
            { inputs: { f1: 1.5 } }
        )).toMatchObject({ displayValue: 1.5, inputType: 'float', placeholder: '0.0' });

        // 定义侧 input_base=hex 也不切通道 —— 编码端 float32 分支只认数值/十进制小数串
        expect(resolveFieldDisplay(
            leaf({ op_code: 'FLOAT_IEEE', byte_len: 4, parameter_config: { input_base: 'hex' } }),
            { inputs: { f1: 2.25 } }
        )).toMatchObject({ displayValue: 2.25, inputType: 'float' });

        // 无输入态：undefined + 小数占位（不塞 0、不 hex 补零）
        expect(resolveFieldDisplay(
            leaf({ op_code: 'FLOAT_IEEE', byte_len: 4, parameter_config: {} }), {}
        )).toMatchObject({ displayValue: undefined, inputType: 'float', placeholder: '0.0' });
    });

    it('BCD_CODE 强制十进制数字通道：十进制回显（非 hex）+ 数字域占位', () => {
        expect(resolveFieldDisplay(
            leaf({ op_code: 'BCD_CODE', byte_len: 2, parameter_config: {} }),
            { inputs: { f1: 1234 } }
        )).toMatchObject({ displayValue: 1234, inputType: 'bcd', placeholder: '0..9999' });

        // 定义侧静态值存成纯数字串 → 按十进制解读（BCD 语义），不误走 hex
        expect(resolveFieldDisplay(
            leaf({ op_code: 'BCD_CODE', byte_len: 2, parameter_config: {} }),
            { inputs: { f1: '1234' } }
        )).toMatchObject({ displayValue: 1234, inputType: 'bcd' });

        expect(resolveFieldDisplay(
            leaf({ op_code: 'BCD_CODE', byte_len: 1, parameter_config: {} }), {}
        )).toMatchObject({ displayValue: undefined, inputType: 'bcd', placeholder: '0..99' });
    });
});

describe('第 14 单：dec 通道占位即域', () => {
    it('无符号/有符号字段占位显示数值域', () => {
        expect(resolveFieldDisplay(
            leaf({ byte_len: 2, parameter_config: { type: 'number', input_base: 'dec' } }), {}
        )).toMatchObject({ inputType: 'decimal', placeholder: '0..65535' });
        expect(resolveFieldDisplay(
            leaf({ op_code: 'INT_SIGNED', byte_len: 1, parameter_config: { input_base: 'dec' } }), {}
        )).toMatchObject({ inputType: 'decimal', placeholder: '-128..127' });
    });
});

describe('第 14 单：computeFieldInputLimits 种类域', () => {
    it('FLOAT_IEEE 不设限（f32 小数；NaN/溢出由编码端兜底 → 0 / IEEE 溢出）', () => {
        expect(computeFieldInputLimits(leaf({ op_code: 'FLOAT_IEEE', byte_len: 4, parameter_config: {} }))).toBeNull();
        expect(computeFieldInputLimits(leaf({ op_code: 'FLOAT_IEEE', byte_len: 4, parameter_config: { input_base: 'dec' } }))).toBeNull();
    });

    it('BCD 数字域：nibble 数定上限（每位 0..9）+ 字符数上限', () => {
        expect(computeFieldInputLimits(leaf({ op_code: 'BCD_CODE', byte_len: 2, parameter_config: {} })))
            .toMatchObject({ byteLen: 2, maxLength: 4, min: 0, max: 9999 });
        expect(computeFieldInputLimits(leaf({ op_code: 'BCD_CODE', byte_len: 1, parameter_config: {} })))
            .toMatchObject({ maxLength: 2, min: 0, max: 99 });
    });
});

describe('第 14 单：computeStringUsage 文本用量徽标', () => {
    it('ascii：字符数即字节数；超定长 → over（截断警示）', () => {
        const f = leaf({ op_code: 'STRING', byte_len: 8, parameter_config: { type: 'string', encoding: 'ascii' } });
        expect(computeStringUsage(f, 'HELLO')).toEqual({ used: 5, total: 8, unit: 'CHARS', over: false });
        expect(computeStringUsage(f, 'HELLO_123456')).toEqual({ used: 12, total: 8, unit: 'CHARS', over: true });
    });

    it('utf8：TextEncoder 字节数 + BYTES 单位', () => {
        const f = leaf({ op_code: 'STRING', byte_len: 8, parameter_config: { type: 'string', encoding: 'utf8' } });
        expect(computeStringUsage(f, '中A')).toEqual({ used: 4, total: 8, unit: 'BYTES', over: false });
    });

    it('无有效 byte_len → null（徽标退回通用形态）', () => {
        expect(computeStringUsage(leaf({ op_code: 'STRING', byte_len: 0, parameter_config: { type: 'string' } }), 'A')).toBeNull();
        expect(computeStringUsage(leaf({ op_code: 'STRING', byte_len: undefined, parameter_config: { type: 'string' } }), 'A')).toBeNull();
    });
});

describe('第 14 单：SmartInput 解析助手（纯函数，组件只接线）', () => {
    it('parseBcdInput：仅数字入缓冲 + 按 nibble 数限宽', () => {
        expect(parseBcdInput('12a34', 4)).toEqual({ text: '1234', value: 1234 });
        expect(parseBcdInput('999999', 4)).toEqual({ text: '9999', value: 9999 });
        expect(parseBcdInput('', 4)).toEqual({ text: '', value: null });
        expect(parseBcdInput('77', null)).toEqual({ text: '77', value: 77 });
    });

    it('parseFloatInput：严格十进制小数语法（与编码端 float32 分支同口径，指数不吞）', () => {
        expect(parseFloatInput('3.14')).toEqual({ text: '3.14', value: 3.14 });
        expect(parseFloatInput('1.')).toEqual({ text: '1.', value: 1 });
        expect(parseFloatInput('.5')).toEqual({ text: '.5', value: 0.5 });
        expect(parseFloatInput('-2.5')).toEqual({ text: '-2.5', value: -2.5 });
        expect(parseFloatInput('-').value).toBeNull();
        expect(parseFloatInput('').value).toBeNull();
        expect(parseFloatInput('abc').value).toBeNull();
        // 指数形式在 FLOAT_IEEE 编码分支会被静默置 0 —— 宁可不发值
        expect(parseFloatInput('1e5').value).toBeNull();
    });
});

// ===== 第 15 单（加工页全种类控件矩阵 · 红测先行）=====
// 矩阵缺口①：MAPPING 被 normalize 摊平成 INPUT 后，无选项的存量字段丢掉枚举
// 身份（章掉 IN、无提示）。控件矩阵口径：身份判定用 isEnum（含 original_op），
// 控件判定用 hasOptions —— 有选项出下拉，无选项走普通通道（字节钳制保留）+
// MAP 身份 + 琥珀 NO OPTIONS 提示。

describe('第 15 单：无选项 MAPPING —— 枚举身份不因摊平丢失', () => {
    const optless = leaf({
        op_code: 'INPUT', original_op_code: 'MAPPING',
        byte_len: 1, parameter_config: {}
    });

    it('classify：original MAPPING → isEnum=true / hasOptions=false', () => {
        const c = classifyRunnerField(optless);
        expect(c.isEnum).toBe(true);
        expect(c.hasOptions).toBe(false);
        // 有选项：两者同真（既有行为回归）
        const withOpts = classifyRunnerField(leaf({
            op_code: 'INPUT', original_op_code: 'MAPPING',
            parameter_config: { options: { A: '01' } }
        }));
        expect(withOpts.isEnum).toBe(true);
        expect(withOpts.hasOptions).toBe(true);
    });

    it('种类章 MAP 不掉 IN；无选项 title 讲明「未配置选项」', () => {
        const k = resolveRunnerKind(optless);
        expect(k).toMatchObject({ key: 'MAP', label: 'MAP' });
        expect(k.title).toContain('未配置');
        // 有选项 → MAP 照旧，不带「未配置」字样
        const withOpts = resolveRunnerKind(leaf({
            op_code: 'INPUT', original_op_code: 'MAPPING',
            parameter_config: { options: { A: '01' } }
        }));
        expect(withOpts).toMatchObject({ key: 'MAP' });
        expect(withOpts.title).not.toContain('未配置');
    });

    it('控件走通道（不出 select）：hex 回显 + inputs 源 + 字节占位；有选项仍 select', () => {
        const d = resolveFieldDisplay(optless, { inputs: { f1: 7 } });
        expect(d.inputType).not.toBe('select');
        expect(d.inputType).toBe('hex');
        expect(d.displayValue).toBe('07');
        expect(d.placeholder).toBe('00');
        // 有选项 → 回归 select
        expect(resolveFieldDisplay(leaf({
            op_code: 'INPUT', original_op_code: 'MAPPING',
            parameter_config: { options: { A: '01' } }
        }), { inputs: { f1: 1 } }).inputType).toBe('select');
    });

    it('定长钳制不因枚举身份丢失；有选项仍不设限（选项即约束）', () => {
        expect(computeFieldInputLimits(optless)).toEqual({ byteLen: 1, maxLength: 2, min: 0, max: 255 });
        expect(computeFieldInputLimits(leaf({
            op_code: 'INPUT', parameter_config: { options: { A: '01' } }
        }))).toBeNull();
    });

    it('语义行出琥珀 NO OPTIONS 提示（warn + title 指引），有选项不出', () => {
        const warn = collectSemanticItems(optless).find(i => i.warn);
        expect(warn).toBeDefined();
        expect(warn.text).toContain('NO OPTIONS');
        expect(String(warn.title || '').length).toBeGreaterThan(0);
        expect(collectSemanticItems(leaf({
            op_code: 'INPUT', parameter_config: { options: { A: '01' } }
        })).some(i => i.warn)).toBe(false);
    });
});

describe('第 15 单：HEADER/TAIL 只读加固 + HDR 身份（矩阵缺口③）', () => {
    it('original/字面 HEADER·TAIL 判固定只读 —— 编码端直读 params.hex，可编辑即欺骗', () => {
        ['HEADER', 'TAIL'].forEach((op) => {
            const byOriginal = classifyRunnerField(leaf({
                op_code: 'INPUT', original_op_code: op, parameter_config: {}
            }));
            expect(byOriginal.isFixed).toBe(true);
            expect(byOriginal.isEditable).toBe(false);
            expect(classifyRunnerField(leaf({ op_code: op, parameter_config: {} })).isFixed).toBe(true);
        });
        // 时间优先于固定的既有次序不回退
        expect(classifyRunnerField(leaf({
            op_code: 'TIME_CUMULATIVE', parameter_config: {}
        })).isFixed).toBe(false);
    });

    it('normalize 后（INPUT/FIXED + original HEADER·TAIL）种类章出 HDR 身份', () => {
        expect(resolveRunnerKind(leaf({
            op_code: 'INPUT', original_op_code: 'HEADER', byte_len: 2, parameter_config: {}
        }))).toMatchObject({ key: 'HDR', label: 'HDR' });
        expect(resolveRunnerKind(leaf({
            op_code: 'INPUT', original_op_code: 'TAIL', byte_len: 1, parameter_config: {}
        }))).toMatchObject({ key: 'HDR' });
        expect(resolveRunnerKind(leaf({
            op_code: 'FIXED', original_op_code: 'HEADER', byte_len: 2, parameter_config: { hex: 'AA55' }
        }))).toMatchObject({ key: 'HDR' });
        // 回归：无 original 的 FIXED → FIX
        expect(resolveRunnerKind(leaf({ op_code: 'FIXED', parameter_config: {} }))).toMatchObject({ key: 'FIX' });
    });

    it('无 hex 的存量 header：回显 = 编码端 0 填充字节（只读，非 NO DATA）', () => {
        expect(resolveFieldDisplay(leaf({
            op_code: 'INPUT', original_op_code: 'HEADER', byte_len: 2, parameter_config: {}
        }))).toMatchObject({ displayValue: '0000' });
    });
});

describe('第 15 单：advanceAutoCounter —— CNT 发送成功后自动推进（镜像编码端 E1-6）', () => {
    const cnt = (pc, over = {}) => leaf({ op_code: 'AUTO_COUNTER', byte_len: 1, parameter_config: pc, ...over });

    it('推进 = floor(Current) + floor(step)，max 双重取模（负步长也落 0..max-1）', () => {
        expect(advanceAutoCounter(cnt({ start_val: 1, step: 2, max: 10 }), 5)).toBe(7);
        expect(advanceAutoCounter(cnt({ step: 2, max: 10 }), 9)).toBe(1);
        expect(advanceAutoCounter(cnt({ step: -3, max: 10 }), 2)).toBe(9);
        // max 缺省/非法/≤0 → 不回绕（同编码端）
        expect(advanceAutoCounter(cnt({ step: 2 }), 9)).toBe(11);
        expect(advanceAutoCounter(cnt({ step: 2, max: 0 }), 9)).toBe(11);
        expect(advanceAutoCounter(cnt({ step: 2, max: 'x' }), 9)).toBe(11);
    });

    it('Current 缺省口径与编码端 rawCur 同源：input > 静态 value > start_val；floor 口径', () => {
        const withValue = cnt({ start_val: 3, step: 1, max: 100, value: 7 });
        expect(advanceAutoCounter(withValue, 5)).toBe(6);        // 输入优先
        expect(advanceAutoCounter(withValue, undefined)).toBe(8); // 静态 value 次之
        const startOnly = cnt({ start_val: 3, step: 1, max: 100 });
        expect(advanceAutoCounter(startOnly, undefined)).toBe(4); // start_val 兜底
        expect(advanceAutoCounter(startOnly, '7')).toBe(8);       // 数字串 floor
        expect(advanceAutoCounter(startOnly, 5.9)).toBe(6);       // 小数 floor
        expect(advanceAutoCounter(startOnly, '')).toBe(1);        // ''是已定义输入 → floor 0
    });

    it('type 闸与编码端同款；非计数字段返回 null（不误推进）', () => {
        expect(advanceAutoCounter(cnt({ step: 1, max: 10, type: 'string' }), 5)).toBeNull();
        expect(advanceAutoCounter(leaf({ op_code: 'INT_UNSIGNED', parameter_config: { step: 1 } }), 5)).toBeNull();
        expect(advanceAutoCounter(leaf({ op_code: 'MAPPING', parameter_config: {} }), 5)).toBeNull();
        // original AUTO_COUNTER 身份（摊平变化也认）
        expect(advanceAutoCounter(
            leaf({ op_code: 'INPUT', original_op_code: 'AUTO_COUNTER', parameter_config: { step: 1, max: 10 } }),
            4
        )).toBe(5);
    });
});

describe('第 15 单：AUTO_COUNTER NEXT 预览 chip（语义行亮出下帧编码值）', () => {
    it('出 NEXT=；输入优先、回绕同口径；非计数字段不出', () => {
        const f = leaf({ op_code: 'AUTO_COUNTER', byte_len: 1, parameter_config: { start_val: 1, step: 2, max: 10 } });
        expect(collectSemanticItems(f).find(i => i.text.startsWith('NEXT=')))
            .toMatchObject({ text: 'NEXT=3' }); // 无输入 → start_val 1 + step 2
        expect(collectSemanticItems(f, { inputs: { f1: 5 } }).find(i => i.text.startsWith('NEXT=')))
            .toMatchObject({ text: 'NEXT=7' }); // 输入 5 + step 2
        expect(collectSemanticItems(
            leaf({ op_code: 'AUTO_COUNTER', byte_len: 1, parameter_config: { step: 2, max: 10 } }),
            { inputs: { f1: 9 } }
        ).find(i => i.text.startsWith('NEXT='))).toMatchObject({ text: 'NEXT=1' }); // (9+2)%10 回绕
        expect(collectSemanticItems(leaf({ parameter_config: { step: 1 } }))
            .some(i => i.text.startsWith('NEXT='))).toBe(false);
    });
});
