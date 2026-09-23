import { describe, expect, it } from 'vitest';
import {
    attemptLabel,
    defaultSpec,
    formatIgnoreRanges,
    parseIgnoreRanges,
    rttText,
    specSourceLabel,
    summaryLine
} from '../transactionView';

describe('transactionView（P2 事务发送视图模型）', () => {
    it('defaultSpec：与后端 default_spec 同形，且每次调用返回独立的 ignore_ranges', () => {
        const a = defaultSpec();
        expect(a).toEqual({
            mode: 'echo',
            prefix: '',
            suffix: '',
            echo_header_bytes: 0,
            length: null,
            checksum: null,
            ignore_ranges: []
        });
        const b = defaultSpec();
        a.ignore_ranges.push([0, 2]);
        expect(b.ignore_ranges).toEqual([]); // 互不共享可变数组
    });

    it('attemptLabel：四态已知 + 未知/缺省兜底', () => {
        expect(attemptLabel('OK')).toBe('OK');
        expect(attemptLabel('NO_RESPONSE')).toBe('NO_RESPONSE');
        expect(attemptLabel('MATCH_FAILED')).toBe('MATCH_FAILED');
        expect(attemptLabel('TRANSPORT_ERROR')).toBe('TRANSPORT_ERROR');
        expect(attemptLabel('WEIRD')).toBe('WEIRD');
        expect(attemptLabel(undefined)).toBe('UNKNOWN');
    });

    it('rttText：数值保留 1 位；null/undefined/NaN → 破折号', () => {
        expect(rttText(12.34)).toBe('12.3 ms');
        expect(rttText(0)).toBe('0.0 ms');
        expect(rttText(null)).toBe('—');
        expect(rttText(undefined)).toBe('—');
        expect(rttText('nope')).toBe('—');
    });

    it('summaryLine：OK 单次不加 S / FAILED 多次带 RTT / 广播态', () => {
        const okOne = {
            status: 'OK', broadcast: false,
            stats: { attempts: 1, rtt_ms_last: 5.2, rtt_ms_avg: 5.2, rtt_ms_max: 5.2 }
        };
        expect(summaryLine(okOne)).toBe('TXN_OK · 1 ATTEMPT · RTT 5.2 ms');

        const failed = { status: 'FAILED', broadcast: false, stats: { attempts: 3, rtt_ms_last: null } };
        expect(summaryLine(failed)).toBe('TXN_FAILED · 3 ATTEMPTS · RTT —');

        const broadcast = { status: 'OK', broadcast: true, stats: { attempts: 1, rtt_ms_last: 0.2 } };
        expect(summaryLine(broadcast)).toBe('TXN_OK · 1 ATTEMPT · BROADCAST');

        expect(summaryLine(null)).toBe('');
    });

    it('specSourceLabel：inline/instruction/none/其他 → DEFAULT', () => {
        expect(specSourceLabel('inline')).toBe('INLINE');
        expect(specSourceLabel('instruction')).toBe('SAVED');
        expect(specSourceLabel('none')).toBe('BROADCAST');
        expect(specSourceLabel('default')).toBe('DEFAULT');
        expect(specSourceLabel(undefined)).toBe('DEFAULT');
    });

    it('parseIgnoreRanges：合法区间（自动排序）与空串', () => {
        expect(parseIgnoreRanges('')).toEqual([]);
        expect(parseIgnoreRanges('  ')).toEqual([]);
        expect(parseIgnoreRanges('4-6,10-12')).toEqual([[4, 6], [10, 12]]);
        expect(parseIgnoreRanges('10 - 12, 4-6')).toEqual([[4, 6], [10, 12]]);
        expect(parseIgnoreRanges('0-8192')).toEqual([[0, 8192]]);
    });

    it('parseIgnoreRanges：非法形态一律 null（单点/反向/重叠/越界/非数字/杂散逗号）', () => {
        expect(parseIgnoreRanges('5')).toBeNull();
        expect(parseIgnoreRanges('6-4')).toBeNull();
        expect(parseIgnoreRanges('4-4')).toBeNull();
        expect(parseIgnoreRanges('4-6,5-9')).toBeNull();     // 重叠
        expect(parseIgnoreRanges('4-6,')).toBeNull();         // 尾逗号
        expect(parseIgnoreRanges('0-9000')).toBeNull();       // > 8192
        expect(parseIgnoreRanges('a-b')).toBeNull();
        expect(parseIgnoreRanges(undefined)).toEqual([]);     // 缺省等同空
    });

    it('formatIgnoreRanges：数组 → 文本；非数组 → 空串', () => {
        expect(formatIgnoreRanges([[4, 6], [10, 12]])).toBe('4-6,10-12');
        expect(formatIgnoreRanges([])).toBe('');
        expect(formatIgnoreRanges(null)).toBe('');
    });
});
