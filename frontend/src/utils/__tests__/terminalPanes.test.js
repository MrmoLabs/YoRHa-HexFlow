import { describe, it, expect } from 'vitest';
import {
    decodeHistoryRow,
    errorMessageOf,
    findEvent,
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
