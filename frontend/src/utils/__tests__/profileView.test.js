import { describe, it, expect } from 'vitest';
import { profileSummary, profileOptionLabel, profileBadges } from '../profileView';

const LOOPBACK = {
    mode: 'loopback',
    tcp: { host: '127.0.0.1', port: 9000 },
    serial: { port: 'COM3', baudrate: 9600 }
};
const TCP = { ...LOOPBACK, mode: 'tcp', tcp: { host: '192.168.0.9', port: 502 } };
const SERIAL = { ...LOOPBACK, mode: 'serial', serial: { port: 'COM7', baudrate: 115200 } };

describe('profileView（P1 档案视图模型）', () => {
    it('profileSummary：三模式摘要', () => {
        expect(profileSummary(LOOPBACK)).toBe('LOOPBACK');
        expect(profileSummary(TCP)).toBe('TCP 192.168.0.9:502');
        expect(profileSummary(SERIAL)).toBe('SERIAL COM7@115200');
    });

    it('profileSummary：缺省/空配置回落 LOOPBACK、缺字段打问号', () => {
        expect(profileSummary(null)).toBe('LOOPBACK');
        expect(profileSummary({})).toBe('LOOPBACK');
        expect(profileSummary({ mode: 'tcp' })).toBe('TCP ?:?');
    });

    it('profileOptionLabel：名称 · 摘要，激活加 ★', () => {
        expect(profileOptionLabel({ label: '环回', config: LOOPBACK, is_active: false }))
            .toBe('环回 · LOOPBACK');
        expect(profileOptionLabel({ label: 'PLC', config: TCP, is_active: true }))
            .toBe('PLC · TCP 192.168.0.9:502 ★');
    });

    it('profileOptionLabel：空档案回落占位', () => {
        expect(profileOptionLabel(null)).toBe('— · LOOPBACK');
    });

    it('profileBadges：默认无徽标', () => {
        expect(profileBadges({ is_active: false, modified: false })).toEqual([]);
        expect(profileBadges(undefined)).toEqual([]);
    });

    it('profileBadges：激活=已激活；激活且被改=两枚；modified 不单独出现（后端口径）', () => {
        expect(profileBadges({ is_active: true, modified: false }).map((b) => b.text))
            .toEqual(['已激活']);
        expect(profileBadges({ is_active: true, modified: true }).map((b) => b.text))
            .toEqual(['已激活', '已修改']);
        expect(profileBadges({ is_active: false, modified: true }).map((b) => b.text))
            .toEqual([]);
    });
});
