// R22（§8.52 排期 · CRC 多算法）：CRC16-CCITT / CRC32 / LRC 三算法三端同源。
//
// 共享向量单一真相源 = vectors/checksum_algo.json（本文件与
// backend/tests/test_checksum_algorithms.py 同读一份，新增向量只写一处）。
// 表内 6 算法 × 5 输入 = 30 行，期望值由独立来源生成（zlib.crc32、
// binascii.crc_hqx、三枚已发布 CRC check 值自校验），不来自本仓实现 —— 因此
// 这些行对 FE/BE 双方都是**外部真值**，不是「照实现抄一份」。
//
// 三处实现（改一必改三）：formula.js calculateChecksum（FE 编码器/设计期卡面）、
// backend handlers/checksum.py（出线）、backend response_match.checksum_value（收侧）。
import { describe, it, expect } from 'vitest';
import { ChecksumAlgo, calculateChecksum, formatToHex } from '../formula';
import { mapChecksumAlgo } from '../normalizeInstruction';
import { BLOCK_PROPERTY_FIELDS } from '../../config/blockTypes';
import { PLAN_ALGO, PLAN_ALGO_FIELD_WIDTH } from '../sequenceView';
import { loadVectors } from '../../../../vectors/vectors.js';
import checksumAlgoVec from '../../../../vectors/checksum_algo.json';

const VECTORS = loadVectors(checksumAlgoVec);

const FE_ALGOS = ['SUM_8', 'XOR_8', 'CRC_16_MODBUS', 'CRC_16_CCITT', 'CRC_32', 'LRC'];
const BE_ALGOS = ['sum', 'xor', 'crc16_modbus', 'crc16_ccitt', 'crc32', 'lrc'];

const bytesOf = (hex) => (hex.match(/.{1,2}/g) || []).map((b) => parseInt(b, 16));

describe('R22 CRC 多算法（共享向量 vectors/checksum_algo.json · 双端同读）', () => {
    it('30 行向量逐行：calculateChecksum → formatToHex 同串', () => {
        expect(VECTORS).toHaveLength(30);
        for (const row of VECTORS) {
            const got = formatToHex(
                calculateChecksum(row.algo, bytesOf(row.data)), row.width
            ).replace(/\s/g, '');
            expect(got, `${row.algo}(data=${row.data})`).toBe(row.expected);
        }
    });

    it('表覆盖六算法 × 5 输入，宽度与算法约定一致', () => {
        const counts = {};
        for (const row of VECTORS) counts[row.algo] = (counts[row.algo] || 0) + 1;
        expect(Object.keys(counts).sort()).toEqual([...FE_ALGOS].sort());
        expect(new Set(Object.values(counts))).toEqual(new Set([5]));
        for (const row of VECTORS) {
            const want = { SUM_8: 1, XOR_8: 1, LRC: 1, CRC_16_MODBUS: 2, CRC_16_CCITT: 2, CRC_32: 4 }[row.algo];
            expect(row.width, row.algo).toBe(want);
        }
    });

    it('空输入两侧同为 0（短路口径；空区间在出线/收侧另有已知分歧，不在本表内）', () => {
        expect(calculateChecksum(ChecksumAlgo.CRC_32, [])).toBe(0);
        expect(calculateChecksum(ChecksumAlgo.CRC_16_CCITT, [])).toBe(0);
        expect(calculateChecksum(ChecksumAlgo.LRC, [])).toBe(0);
    });
});

describe('R22 值域 / 映射（改一须核对另一端）', () => {
    it('ChecksumAlgo = 六值，且与序列计划映射同域', () => {
        expect(Object.values(ChecksumAlgo)).toEqual(FE_ALGOS);
        expect(Object.keys(PLAN_ALGO)).toEqual(FE_ALGOS);
        expect(Object.values(PLAN_ALGO)).toEqual(BE_ALGOS);
    });

    it('PLAN_ALGO_FIELD_WIDTH 键 = 后端值域、值 = 各算法最窄字段宽', () => {
        expect(PLAN_ALGO_FIELD_WIDTH).toEqual({
            crc16_modbus: 2, crc16_ccitt: 2, crc32: 4, lrc: 1
        });
        // 只含固定宽算法（sum/xor 任意宽度，不入表）
        expect(Object.keys(PLAN_ALGO_FIELD_WIDTH).every((k) => BE_ALGOS.includes(k))).toBe(true);
    });

    it('mapChecksumAlgo：六个规范值原样放行', () => {
        for (const algo of FE_ALGOS) expect(mapChecksumAlgo(algo)).toBe(algo);
    });

    it('mapChecksumAlgo：裸名/别名/未知仍回退 CRC_16_MODBUS（存量草稿字节不变）', () => {
        // 关键：R22 转正的是规范值 `CRC_32`；裸名 `CRC32` 继续回落，故
        // importExport 既有归一用例（CRC32 → CRC_16_MODBUS）不因本批改变。
        expect(mapChecksumAlgo('CRC32')).toBe('CRC_16_MODBUS');
        expect(mapChecksumAlgo('CRC16_CCITT')).toBe('CRC_16_MODBUS');
        expect(mapChecksumAlgo('CRC_64')).toBe('CRC_16_MODBUS');
        expect(mapChecksumAlgo('')).toBe('CRC_16_MODBUS');
        expect(mapChecksumAlgo(undefined)).toBe('CRC_16_MODBUS');
        expect(mapChecksumAlgo('XOR_SUM')).toBe('XOR_8');
        expect(mapChecksumAlgo('ADD_SUM')).toBe('SUM_8');
    });

    it('blockTypes algo 下拉 = 六值，缺省 CRC_16_MODBUS 不变', () => {
        const f = BLOCK_PROPERTY_FIELDS.algo;
        expect(f.key).toBe('parameter_config.algorithm');
        expect(f.options.map((o) => o.value)).toEqual(FE_ALGOS);
        expect(f.default).toBe('CRC_16_MODBUS');
    });
});
