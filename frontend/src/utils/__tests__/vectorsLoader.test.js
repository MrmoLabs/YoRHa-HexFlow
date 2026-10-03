// CP2b 验收（前端侧半张单）：共享向量加载器的 $v 约定 + 全量表可读 + 表清单自检。
//
// 与 backend/tests/test_vectors_manifest.py 各测一半、互不重复扫仓：
//   后端那份负责「消费矩阵 / 引用可解析 / $v 拒错 / 入库卫生」（扫两侧文件）；
//   本文件负责「FE 加载器与 BE load_vectors.py 同口径」+「vectors/*.json 在 FE 侧
//   真的能读」+「本清单与 vectors/ 目录同集（新增表忘登记 → 红）」。
// 约定见 vectors/README.md §1（$v 包装对象）与 §6（验收方式）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { loadVectors } from '../../../../vectors/vectors.js';
import alignVec from '../../../../vectors/align.json';
import bcdScaledVec from '../../../../vectors/bcd_scaled.json';
import bitfieldVec from '../../../../vectors/bitfield.json';
import escapeVec from '../../../../vectors/escape.json';
import floatIeeeVec from '../../../../vectors/float_ieee.json';
import intSignedVec from '../../../../vectors/int_signed.json';
import lengthOrderVec from '../../../../vectors/length_order.json';
import littleEndianVec from '../../../../vectors/little_endian.json';
import presenceVec from '../../../../vectors/presence.json';
import repeatVec from '../../../../vectors/repeat.json';
import stringVec from '../../../../vectors/string.json';
import timeCounterVec from '../../../../vectors/time_counter.json';
import wrapVec from '../../../../vectors/wrap.json';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const VECTOR_FILES = fs
    .readdirSync(path.join(REPO_ROOT, 'vectors'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();

const TABLES = {
    align: alignVec,
    bcd_scaled: bcdScaledVec,
    bitfield: bitfieldVec,
    escape: escapeVec,
    float_ieee: floatIeeeVec,
    int_signed: intSignedVec,
    length_order: lengthOrderVec,
    little_endian: littleEndianVec,
    presence: presenceVec,
    repeat: repeatVec,
    string: stringVec,
    time_counter: timeCounterVec,
    wrap: wrapVec,
};

describe('共享向量加载器 vectors/vectors.js（$v 跨语言约定）', () => {
    it('$v 三态映射为特殊浮点，与 BE load_vectors.py 同口径', () => {
        expect(loadVectors({ $v: 'Infinity' })).toBe(Infinity);
        expect(loadVectors({ $v: '-Infinity' })).toBe(-Infinity);
        expect(Number.isNaN(loadVectors({ $v: 'NaN' }))).toBe(true);
        expect(loadVectors({ nested: { $v: '-Infinity' } }).nested).toBe(-Infinity);
    });

    it('非法 $v 拒收（混键 / 未知值）—— 不 fail-open', () => {
        expect(() => loadVectors({ $v: 'Infinity', extra: 1 })).toThrow(/非法 \$v/);
        expect(() => loadVectors({ $v: 'Bogus' })).toThrow(/非法 \$v/);
    });

    it('标量按 JSON 原型天然分型（"1e3"/"" 不被当数值）', () => {
        expect(loadVectors([1, '1e3', '', null, true])).toEqual([1, '1e3', '', null, true]);
    });

    it('表清单与 vectors/ 目录同集（新增 JSON 必须同步登记，改名/删除同理）', () => {
        expect(Object.keys(TABLES).sort()).toEqual(VECTOR_FILES);
    });

    it('全部向量表在 FE 侧可读且非空', () => {
        for (const [name, node] of Object.entries(TABLES)) {
            const decoded = loadVectors(node);
            const empty = Array.isArray(decoded)
                ? decoded.length === 0
                : Object.keys(decoded).length === 0;
            expect(empty, `${name}.json 为空或不可读`).toBe(false);
        }
    });
});
