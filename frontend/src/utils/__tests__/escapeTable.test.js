import { describe, it, expect } from 'vitest';
import { escapeHex, escapeWarnings, toEscapeDraft } from '../escapeTable';
import { loadVectors } from '../../../../vectors/vectors.js';
import escapeVec from '../../../../vectors/escape.json';

// CP2b (D11-①): 单一真相源 = vectors/escape.json —— 两端同读一份，新增向量只写一处。
// 空表 / 关闭态不在此表 —— 直通语义（原样返回、不解析）由下方直通用例钉住。
const VECTORS = loadVectors(escapeVec);

describe('escapeTable（N4 · G3 传输层帧字节转义）', () => {
    it('共享向量（vectors/escape.json）与 BE 同字节', () => {
        for (const [pairs, src, want] of VECTORS) {
            expect(escapeHex(src, { enabled: true, pairs })).toBe(want);
        }
    });

    it('关闭态 / 空表直通（原样返回不改写，与 BE escape_hex 同口径）', () => {
        for (const [pairs, src] of VECTORS) {
            expect(escapeHex(src, { enabled: false, pairs })).toBe(src);
        }
        expect(escapeHex('01 7D 02', { enabled: true, pairs: [] })).toBe('01 7D 02');
    });

    it('非法 / 奇数长度 hex → null（面板显示占位）', () => {
        const cfg = { enabled: true, pairs: [['7D', '7D5D']] };
        expect(escapeHex('not hex', cfg)).toBeNull();
        expect(escapeHex('7D GG', cfg)).toBeNull();
        expect(escapeHex('ABC', cfg)).toBeNull();
        expect(escapeHex('', cfg)).toBe('');
    });

    it('escapeWarnings：自保护前缀零提醒', () => {
        expect(escapeWarnings({ enabled: true, pairs: [['7D', '7D5D']] })).toEqual([]);
        expect(escapeWarnings({ enabled: false, pairs: [] })).toEqual([]);
    });

    it('escapeWarnings：前缀未受保护 → 歧义提醒', () => {
        const warns = escapeWarnings({ enabled: true, pairs: [['11', '7D31']] });
        expect(warns).toHaveLength(1);
        expect(warns[0]).toMatch(/7D/);
        expect(warns[0]).toMatch(/未列入受保护字节/);
    });

    it('escapeWarnings：行级格式与重复原字节', () => {
        expect(escapeWarnings({ enabled: true, pairs: [['7', '7D5D'] ]})[0])
            .toMatch(/原字节/);
        expect(escapeWarnings({ enabled: true, pairs: [['7D', '7D5'] ]})[0])
            .toMatch(/替换序列/);
        expect(escapeWarnings(
            { enabled: true, pairs: [['7D', '7D5D'], ['7d', '7D31']] }
        ).join(' ')).toMatch(/重复/);
        expect(escapeWarnings({ enabled: true, pairs: [['7D', 'ZZ']] })[0])
            .toMatch(/替换序列/);
    });

    it('toEscapeDraft：缺段 / 脏段回落默认关闭', () => {
        expect(toEscapeDraft(undefined)).toEqual({ enabled: false, pairs: [] });
        expect(toEscapeDraft(null)).toEqual({ enabled: false, pairs: [] });
        expect(toEscapeDraft('junk')).toEqual({ enabled: false, pairs: [] });
        expect(toEscapeDraft({ enabled: 'yes', pairs: 'junk' }))
            .toEqual({ enabled: false, pairs: [] });
        expect(toEscapeDraft({ enabled: true, pairs: [['7d', '7d5d']] }))
            .toEqual({ enabled: true, pairs: [['7d', '7d5d']] });
    });
});
