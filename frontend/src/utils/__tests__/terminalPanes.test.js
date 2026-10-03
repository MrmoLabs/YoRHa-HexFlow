import { describe, it, expect } from 'vitest';
import {
    decodeHistoryRow,
    errorMessageOf,
    findEvent,
    frameLines,
    framePreview,
    hexDump,
    hexInputInfo,
    hexPreview,
    historyRows,
    rawHexOf,
    responseHexOf
} from '../terminalPanes';

const SENT_RECORD = {
    id: 1790107408505,
    timestamp: '2026-09-23T01:00:00.123456+00:00',
    channel: 'LOOPBACK',
    status: 'SENT',
    byte_count: 2,
    hex_string: 'AA 55',
    instruction_name: 'probe',
    echo: 'AA55',
    events: [
        { type: 'raw', hex_string: 'AA 55', message: null },
        { type: 'response', hex_string: 'AA 55', message: null }
    ]
};

const ERROR_RECORD = {
    id: 1790107408565,
    timestamp: '2026-09-23T01:00:00.565000+00:00',
    channel: 'TCP',
    status: 'ERROR',
    byte_count: 2,
    hex_string: 'AA 55',
    instruction_name: null,
    echo: '',
    events: [
        { type: 'raw', hex_string: 'AA 55', message: null },
        { type: 'error', hex_string: null, message: 'TCP 连接 127.0.0.1:18899 失败' }
    ]
};

describe('terminalPanes — 事件拆分', () => {
    it('findEvent 定位三类事件', () => {
        expect(findEvent(SENT_RECORD, 'response').hex_string).toBe('AA 55');
        expect(findEvent(ERROR_RECORD, 'error').message).toContain('TCP 连接');
        expect(findEvent(SENT_RECORD, 'error')).toBeNull();
        expect(findEvent(null, 'raw')).toBeNull();
    });

    it('rawHexOf 优先 raw 事件，缺 events 回落记录级 hex_string', () => {
        expect(rawHexOf(SENT_RECORD)).toBe('AA 55');
        expect(rawHexOf({ hex_string: 'DE AD', events: [] })).toBe('DE AD');
        expect(rawHexOf(null)).toBe('');
    });

    it('responseHexOf：成功记录取响应，错误记录为空串', () => {
        expect(responseHexOf(SENT_RECORD)).toBe('AA 55');
        expect(responseHexOf(ERROR_RECORD)).toBe('');
        expect(responseHexOf(null)).toBe('');
    });

    it('errorMessageOf：错误记录取消息，成功记录为 null', () => {
        expect(errorMessageOf(ERROR_RECORD)).toBe('TCP 连接 127.0.0.1:18899 失败');
        expect(errorMessageOf(SENT_RECORD)).toBeNull();
    });
});

describe('terminalPanes — hex 格式化', () => {
    it('hexDump 每 8 字节一行并规整空白', () => {
        expect(hexDump('')).toEqual([]);
        expect(hexDump(null)).toEqual([]);
        expect(hexDump('AA 55')).toEqual(['AA 55']);
        expect(hexDump('01 02 03 04 05 06 07 08 09 0A')).toEqual([
            '01 02 03 04 05 06 07 08',
            '09 0A'
        ]);
        expect(hexDump('AA  55')).toEqual(['AA 55']); // 多空格归一
    });

    it('hexPreview 超限截断并标注剩余字节数', () => {
        expect(hexPreview('')).toBe('');
        expect(hexPreview('AA 55', 10)).toBe('AA 55');
        const long = Array.from({ length: 16 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        expect(hexPreview(long, 10)).toBe('00 01 02 03 04 05 06 07 08 09 …+6');
    });
});

// ── R16（PLAN §8.49）：三面板共用的报文显示口径 ─────────────────────────────────
describe('terminalPanes — frameLines / framePreview（R16 显示口径）', () => {
    const LONG = '01 02 03 04 05 06 07 08 09 0A';

    it('hex 口径与 hexDump / hexPreview 逐字相同，缺省也是 hex（切回来零变化）', () => {
        expect(frameLines(LONG)).toEqual(hexDump(LONG));
        expect(frameLines(LONG, 'hex')).toEqual(hexDump(LONG));
        expect(frameLines(LONG, 'weird')).toEqual(hexDump(LONG)); // 未知口径回落 hex
        expect(frameLines('')).toEqual([]);
        expect(frameLines(null, 'ascii')).toEqual([]);
        expect(framePreview(LONG)).toBe(hexPreview(LONG));
        expect(framePreview(LONG, 'hex')).toBe('01 02 03 04 05 06 07 08 09 0A'); // 10 字节不截断
        expect(framePreview(`${LONG} 0B`, 'hex')).toBe('01 02 03 04 05 06 07 08 09 0A …+1');
    });

    it('ascii 口径：每字节 1 字符、8 字节/行；可打印原样、控制符与高位显 .', () => {
        // 0x41='A' 可打印 / 0x0A 控制符 → '.' / 0x20 是空格 / 0xAA 高位 → '.'
        expect(frameLines('41 0A 20 AA', 'ascii')).toEqual(['A. .']);
        expect(frameLines('41 42 43 44 45 46 47 48 49', 'ascii')).toEqual(['ABCDEFGH', 'I']);
        expect(framePreview('41 42 43', 'ascii')).toBe('ABC');
        // 非 hex token 不静默装成 00 —— 显 '?'（输入只可能来自后端，属防御）
        expect(frameLines('ZZ 41', 'ascii')).toEqual(['?A']);
        // 12 个可打印字节（0x41..0x4C）→ 预览只留 10 个 + …+2
        const long = Array.from({ length: 12 }, (_, i) => (0x41 + i).toString(16).padStart(2, '0')).join(' ');
        expect(framePreview(long, 'ascii', 10)).toBe('ABCDEFGHIJ …+2');
    });

    it('bits 口径：每字节 8 位补零、4 字节/行；预览超限标 …+N', () => {
        expect(frameLines('01 FF', 'bits')).toEqual(['00000001 11111111']);
        expect(frameLines('01 02 03 04 05', 'bits')).toEqual([
            '00000001 00000010 00000011 00000100',
            '00000101'
        ]);
        expect(framePreview('AA 55', 'bits')).toBe('10101010 01010101');
        const long = Array.from({ length: 12 }, () => '00').join(' ');
        expect(framePreview(long, 'bits', 4)).toBe('00000000 00000000 00000000 00000000 …+8');
    });

    it('historyRows 的 ctx.frameFormat 只换预览列；不传 = hex 逐字不变', () => {
        const [plain] = historyRows([SENT_RECORD]);
        expect(plain.hexPreview).toBe('AA 55');
        const [ascii] = historyRows([SENT_RECORD], { frameFormat: 'ascii' });
        expect(ascii.hexPreview).toBe('.U'); // 0xAA 不可打印 → '.'，0x55 = 'U'
        const [bits] = historyRows([SENT_RECORD], { frameFormat: 'bits' });
        expect(bits.hexPreview).toBe('10101010 01010101');
        // 其余列（时间 / 通道 / 字节 / 字段解码）不受显示口径影响
        expect(ascii.time).toBe(plain.time);
        expect(ascii.byteCount).toBe(plain.byteCount);
        expect(ascii.decoded).toEqual(plain.decoded);
    });
});

describe('terminalPanes — historyRows', () => {
    it('映射表格行并截断时间戳到秒', () => {
        const [row] = historyRows([SENT_RECORD]);
        expect(row).toEqual({
            id: SENT_RECORD.id,
            time: '2026-09-23 01:00:00',
            channel: 'LOOPBACK',
            status: 'SENT',
            byteCount: 2,
            hexPreview: 'AA 55',
            name: 'probe',
            isError: false
        });
    });

    it('缺省字段回落占位符，ERROR 行打标', () => {
        const [, errRow] = historyRows([SENT_RECORD, ERROR_RECORD]);
        expect(errRow.isError).toBe(true);
        expect(errRow.name).toBe('—');

        const [blank] = historyRows([{ id: 9 }]);
        expect(blank.time).toBe('—');
        expect(blank.channel).toBe('—');
        expect(blank.status).toBe('—');
        expect(blank.byteCount).toBe(0);
        expect(blank.hexPreview).toBe('');
    });

    it('空数组与非数组输入', () => {
        expect(historyRows([])).toEqual([]);
        expect(historyRows(undefined)).toEqual([]);
    });
});

// ─── R9（PLAN §8.46 · C-2 选 B 前半）: 发送历史显示「字段 = 值」 ───────────
describe('terminalPanes — R9 发送历史逆向解码', () => {
    const READ_VOLTAGE = {
        id: 'i1',
        name: 'read_voltage',
        fields: [
            {
                id: 'h', name: 'HEADER', op_code: 'FIXED', byte_len: 2, sequence: 0,
                parameter_config: { hex: 'AA55' }
            },
            {
                id: 'v', name: 'VOLTAGE', op_code: 'FLOAT_IEEE', byte_len: 4, sequence: 1,
                parameter_config: {}
            }
        ]
    };
    const INSTRUCTIONS = { read_voltage: READ_VOLTAGE };
    const HIT_RECORD = {
        ...SENT_RECORD,
        id: 4242,
        byte_count: 6,
        hex_string: 'AA 55 40 48 F5 C3',
        instruction_name: 'read_voltage',
        events: [
            { type: 'raw', hex_string: 'AA 55 40 48 F5 C3', message: null },
            { type: 'response', hex_string: 'AA 55 40 48 F5 C3', message: null }
        ]
    };

    it('给了指令映射 → 响应帧解成「字段 = 值」（4048F5C3 → 3.14）', () => {
        const [row] = historyRows([HIT_RECORD], { instructionsByName: INSTRUCTIONS });
        expect(row.decoded.fields).toHaveLength(2);
        expect(row.decoded.residual).toBe(0);
        expect(row.fieldsText).toBe('HEADER = "AA55" · VOLTAGE = 3.14');
    });

    it('不给 ctx / 指令名对不上 / 无响应 → 不加解码键（行形状逐字不变）', () => {
        const [noCtx] = historyRows([HIT_RECORD]);
        expect('fieldsText' in noCtx).toBe(false);
        expect('decoded' in noCtx).toBe(false);

        const [noMatch] = historyRows([HIT_RECORD], { instructionsByName: { other: READ_VOLTAGE } });
        expect('fieldsText' in noMatch).toBe(false);

        const [noResponse] = historyRows(
            [{ ...HIT_RECORD, events: [{ type: 'raw', hex_string: 'AA 55', message: null }] }],
            { instructionsByName: INSTRUCTIONS });
        expect('fieldsText' in noResponse).toBe(false);

        const [errRow] = historyRows([ERROR_RECORD], { instructionsByName: INSTRUCTIONS });
        expect('fieldsText' in errRow).toBe(false);
    });

    it('短帧 → 标 truncated + 警告进 row.decoded（看得见，不是静默错值）', () => {
        const short = { ...HIT_RECORD, events: [{ type: 'response', hex_string: 'AA 55', message: null }] };
        const [row] = historyRows([short], { instructionsByName: INSTRUCTIONS });
        expect(row.decoded.fields[1].truncated).toBe(true);
        expect(row.decoded.warnings.join(' ')).toContain('比字段布局短');
    });

    it('decodeHistoryRow 直接入口：空入参 → null（不抛）', () => {
        expect(decodeHistoryRow(null, INSTRUCTIONS)).toBeNull();
        expect(decodeHistoryRow(HIT_RECORD, null)).toBeNull();
        expect(decodeHistoryRow(SENT_RECORD, INSTRUCTIONS)).toBeNull(); // 指令名 'probe' 不在映射里
    });
});

// ─── R10（PLAN §8.48 · §8.37 R10 行 · C-2 选 C 后半）: 入库回写优先消费 ───────
// SERVED 是后端 `core/field_decode` 的**真实输出形状**（逐键同
// `backend/tests/test_field_decode.py` 断言的 payload）—— 两端不同言，靠这组
// 契约锚钉死「后端解出的那包东西 FE 直接喂 DecodedFields 就能渲染」。
describe('terminalPanes — R10 服务端解码回填', () => {
    const SERVED = {
        fields: [
            {
                fieldId: 'h', name: 'HEADER', opCode: 'FIXED', byteLen: 2,
                start: 0, end: 2, truncated: false, value: 'AA55'
            },
            {
                fieldId: 'v', name: 'VOLTAGE', opCode: 'FLOAT_IEEE', byteLen: 4,
                start: 2, end: 6, truncated: false, value: 3.14
            }
        ],
        consumed: 6, total: 6, residual: 0, warnings: []
    };

    it('有 record.fields → 原样直用，**不给 ctx 也解得出**（指令删了照样看值）', () => {
        const record = { ...SENT_RECORD, fields: SERVED };
        const [row] = historyRows([record]);
        expect(row.decoded).toBe(SERVED);
        expect(row.fieldsText).toBe('HEADER = "AA55" · VOLTAGE = 3.14');
        // 指令映射为 null（/instructions 里已无此指令）→ 仍靠留痕的 fields 显示
        expect(decodeHistoryRow(record, null)).toBe(SERVED);
        expect(decodeHistoryRow({ ...record, instruction_name: null }, null)).toBe(SERVED);
    });

    it('服务端解不出（fields = null / 空壳）→ 回落 R9 客户端解码，形状不变', () => {
        // 存量行：R10 之前写下的记录没有这一键 → 行形状与 R9 逐字不变
        const [legacy] = historyRows([SENT_RECORD]);
        expect('fieldsText' in legacy).toBe(false);
        expect('decoded' in legacy).toBe(false);

        // 空壳 = 后端也没解出来 → 当它不存在，客户端解码接管
        const shell = { fields: [], consumed: 0, total: 0, residual: 0, warnings: [] };
        expect(decodeHistoryRow({ ...SENT_RECORD, fields: shell }, null)).toBeNull();

        const HIT_RECORD = {
            ...SENT_RECORD,
            byte_count: 6,
            hex_string: 'AA 55 40 48 F5 C3',
            instruction_name: 'read_voltage',
            fields: null,
            events: [
                { type: 'raw', hex_string: 'AA 55 40 48 F5 C3', message: null },
                { type: 'response', hex_string: 'AA 55 40 48 F5 C3', message: null }
            ]
        };
        const [row] = historyRows([HIT_RECORD], {
            instructionsByName: {
                read_voltage: {
                    id: 'i1', name: 'read_voltage',
                    fields: [
                        {
                            id: 'h', name: 'HEADER', op_code: 'FIXED', byte_len: 2, sequence: 0,
                            parameter_config: { hex: 'AA55' }
                        },
                        {
                            id: 'v', name: 'VOLTAGE', op_code: 'FLOAT_IEEE', byte_len: 4, sequence: 1,
                            parameter_config: {}
                        }
                    ]
                }
            }
        });
        expect(row.decoded.fields).toHaveLength(2);
        expect(row.decoded.residual).toBe(0);
    });

    it('服务端只回警告也照吃 —— 「解不出」看得见原因，不是静默空值', () => {
        const served = {
            fields: [], consumed: 0, total: 3, residual: 3,
            warnings: ['字段解码失败: boom']
        };
        const [row] = historyRows([{ ...SENT_RECORD, fields: served }]);
        expect(row.decoded).toBe(served);
        expect(row.decoded.warnings).toEqual(['字段解码失败: boom']);
        expect(row.fieldsText).toBe(''); // 预览列只列字段，原因在解码面板里看
    });
});

describe('terminalPanes — hexInputInfo', () => {
    it('接受与后端同款分隔符（空格/下划线/逗号/连字符）', () => {
        expect(hexInputInfo('AA 55')).toEqual({ valid: true, byteCount: 2, cleaned: 'AA55' });
        expect(hexInputInfo('AA_55')).toEqual({ valid: true, byteCount: 2, cleaned: 'AA55' });
        expect(hexInputInfo('AA,55')).toEqual({ valid: true, byteCount: 2, cleaned: 'AA55' });
        expect(hexInputInfo('aa-55')).toEqual({ valid: true, byteCount: 2, cleaned: 'aa55' });
        expect(hexInputInfo('  0102  ')).toEqual({ valid: true, byteCount: 2, cleaned: '0102' });
    });

    it('空输入 / 奇数位 / 非 hex 一律 invalid', () => {
        expect(hexInputInfo('')).toEqual({ valid: false, byteCount: 0, cleaned: '' });
        expect(hexInputInfo('   ')).toEqual({ valid: false, byteCount: 0, cleaned: '' });
        expect(hexInputInfo('ABC')).toEqual({ valid: false, byteCount: 0, cleaned: 'ABC' });
        expect(hexInputInfo('GG')).toEqual({ valid: false, byteCount: 0, cleaned: 'GG' });
        expect(hexInputInfo(null)).toEqual({ valid: false, byteCount: 0, cleaned: '' });
    });
});
