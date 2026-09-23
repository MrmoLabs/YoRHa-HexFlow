import { describe, it, expect } from 'vitest';
import {
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
