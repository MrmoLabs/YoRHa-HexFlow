// R23（§8.52 排期 · 挂账 ①）：TIME_EPOCH 绝对时间戳 —— 双端同源。
//
// 共享向量单一真相源 = vectors/time_epoch.json（本文件与
// backend/tests/test_time_epoch.py 同读一份，新增向量只写一处）。表内 unit
// （s/ms/MS）× now_ms × byte_len，期望值 = 规范式
//   unit == 'ms' -> floor(now_ms)，其余（缺省 's'）-> floor(now_ms / 1000)
//   out = abs(raw) & ((1 << (8 * byte_len)) - 1)     // 定宽大端、高位截断
// FE 侧的「abs + 定宽截高位」由 InstructionEncoder 通用整数路径
// （Math.abs(Math.floor(v)).toString(16).padStart().slice(-2n)）实现，与 BE
// encode_time_epoch 的 `& mask` byte-equal。
import { describe, it, expect } from 'vitest';
import { OP_CODES } from '../../constants';
import { InstructionEncoder } from '../InstructionEncoder';
import {
    classifyRunnerField,
    collectSemanticItems,
    resolveRunnerKind,
} from '../../config/runnerRenderRules';
import { buildPlan } from '../sequenceView';
import { normalizeRunnerInstruction } from '../../components/InstructionForm/normalizeRunnerInstruction';
import { loadVectors } from '../../../../vectors/vectors.js';
import timeEpochVec from '../../../../vectors/time_epoch.json';

const VECTORS = loadVectors(timeEpochVec);

const strip = (r) => r.hexString.replace(/\s/g, '').toUpperCase();

const epochInstr = (unit, byteLen = 4) => ({
    id: 'i1',
    name: 'I',
    fields: [{
        id: 'e',
        name: 'E',
        op_code: 'TIME_EPOCH',
        byte_len: byteLen,
        sequence: 0,
        parent_id: null,
        parameter_config: (unit === undefined ? {} : { unit }),
    }],
});

const frame = (unit, byteLen, now) => strip(
    InstructionEncoder.encodeInstruction(epochInstr(unit, byteLen), {}, {}, { now })
);

describe('R23 TIME_EPOCH（共享向量 vectors/time_epoch.json · 双端同读）', () => {
    it('11 行向量逐行：编码器出帧与 BE 期望 byte-equal', () => {
        expect(VECTORS).toHaveLength(11);
        for (const row of VECTORS) {
            expect(
                frame(row.unit, row.byte_len, row.now_ms),
                `unit=${row.unit} now=${row.now_ms} bl=${row.byte_len}`
            ).toBe(row.expected);
        }
    });

    it('表覆盖 s/ms 两种口径与 1/2/4/8 字节宽度', () => {
        const units = [...new Set(VECTORS.map((r) => r.unit.toLowerCase()))].sort();
        expect(units).toEqual(['ms', 's']);
        expect(new Set(VECTORS.map((r) => r.byte_len))).toEqual(new Set([1, 2, 4, 8]));
    });

    it('缺省 unit = 秒；大小写不敏感（MS 与 ms 等价）', () => {
        expect(frame(undefined, 4, 1700000000000)).toBe('6553F100');
        expect(frame('s', 4, 1700000000000)).toBe('6553F100');
        expect(frame('MS', 8, 1700000000123)).toBe(frame('ms', 8, 1700000000123));
        expect(frame('MS', 8, 1700000000123)).toBe('0000018BCFE5687B');
    });

    it('位宽不够截低位、位宽富余左侧零填（不抛错，同通用整数路径）', () => {
        expect(frame('s', 1, 1700000000000)).toBe('00');
        expect(frame('s', 2, 1700000000000)).toBe('F100');
        expect(frame('s', 8, 1700000000000)).toBe('000000006553F100');
        expect(frame('s', 4, 0)).toBe('00000000');
    });

    it('inputs/value 不参与：墙钟语义压过静态值', () => {
        const instr = epochInstr('s', 4);
        instr.fields[0].value = 7;
        const r = InstructionEncoder.encodeInstruction(
            instr, { e: 4242 }, {}, { now: 1700000000000 }
        );
        expect(strip(r)).toBe('6553F100');
    });

    it('opts.now 缺省 → Date.now()（区间夹逼，同 TIME 先例）', () => {
        const t0 = Date.now();
        const r = InstructionEncoder.encodeInstruction(epochInstr('s', 4), {}, {});
        const t1 = Date.now();
        const n = parseInt(strip(r), 16);
        expect(n).toBeGreaterThanOrEqual(Math.floor(t0 / 1000));
        expect(n).toBeLessThanOrEqual(Math.floor(t1 / 1000));
    });
});

describe('R23 TIME_EPOCH 身份与渲染（normalize / 分类 / 章 / 计划）', () => {
    it('OP_CODES 含 TIME_EPOCH（KNOWN_OPS 经 Object.values 自动收录）', () => {
        expect(OP_CODES.TIME_EPOCH).toBe('TIME_EPOCH');
    });

    it('normalize 保身份：不摊平成 INPUT/TIME_CUMULATIVE', () => {
        const [norm] = normalizeRunnerInstruction(epochInstr('s', 4)).fields;
        expect(norm.op_code).toBe('TIME_EPOCH');
        expect(norm.original_op_code).toBe('TIME_EPOCH');
        // TIME_ACCUMULATOR 仍走既定映射（回归不动）
        const [acc] = normalizeRunnerInstruction({
            ...epochInstr(undefined, 4),
            fields: [{ ...epochInstr().fields[0], op_code: 'TIME_ACCUMULATOR' }],
        }).fields;
        expect(acc.op_code).toBe('TIME_CUMULATIVE');
    });

    it('分类走计算类（isCalculated），不走 TIME_CUMULATIVE（无 base 可选）', () => {
        const cls = classifyRunnerField(epochInstr('s', 4).fields[0]);
        expect(cls.isEpoch).toBe(true);
        expect(cls.isCalculated).toBe(true);
        expect(cls.isTimeCumulative).toBe(false);
        expect(cls.isEditable).toBe(false); // 只读：敲值不改出帧 = 欺骗
        expect(resolveRunnerKind(epochInstr('s', 4).fields[0]).key).toBe('EPOCH');
        // 累计时间不受影响（回归不动）
        const acc = classifyRunnerField({
            ...epochInstr().fields[0],
            op_code: 'TIME_CUMULATIVE',
        });
        expect(acc.isTimeCumulative).toBe(true);
        expect(acc.isEpoch).toBe(false);
    });

    it('语义行亮出 unit（s/ms）', () => {
        const texts = collectSemanticItems(epochInstr('ms', 4).fields[0])
            .map((i) => i.text);
        expect(texts).toContain('UNIT=ms');
        expect(collectSemanticItems(epochInstr(undefined, 4).fields[0]).map((i) => i.text))
            .toContain('UNIT=s');
    });

    it('计划条目：op/offset/byte_len/unit 归一小写，缺省 s', () => {
        const run = (unit, spanStart = 1) => buildPlan(
            epochInstr(unit, 4),
            {}, {},
            [{ start: spanStart, end: spanStart + 4, fieldId: 'e' }]
        );
        expect(run('MS').plan.dynamic).toEqual([{
            field_id: 'e',
            op: 'TIME_EPOCH',
            offset: 1,
            byte_len: 4,
            unit: 'ms',
        }]);
        expect(run(undefined).plan.dynamic[0].unit).toBe('s');
        expect(run('s').warnings).toEqual([]);
    });

    it('回归：TIME_ACCUMULATOR 计划条目仍带 base_time（键集不同）', () => {
        const instr = {
            id: 'i1',
            fields: [{
                ...epochInstr().fields[0],
                op_code: 'TIME_ACCUMULATOR',
                parameter_config: { base_time: '2000-01-01T00:00:00Z' },
            }],
        };
        const { plan } = buildPlan(instr, {}, {}, [{ start: 1, end: 5, fieldId: 'e' }]);
        expect(plan.dynamic[0]).toEqual({
            field_id: 'e',
            op: 'TIME_ACCUMULATOR',
            offset: 1,
            byte_len: 4,
            base_time: '2000-01-01T00:00:00Z',
        });
    });
});
