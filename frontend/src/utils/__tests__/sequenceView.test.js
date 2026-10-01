import { describe, it, expect } from 'vitest';
import {
    buildPlan,
    resultLabel,
    resultTone,
    stepTone,
    progressText,
    planSummary,
    payloadByteCount,
    reorder,
    shellSummary,
    PLAN_ALGO,
    EMPTY_CONFIG
} from '../sequenceView';

// ---- fixtures（raw 指令形状：API 返回扁平 fields + parent_id；byteMap 由
// encodeInstruction 产出，只覆盖叶子、end 开区间）----------------------------

const timeField = (extra = {}) => ({
    id: 't1', name: 'ELAPSED', sequence: 0,
    op_code: 'TIME_ACCUMULATOR', byte_len: 2, endianness: 'BIG',
    parameter_config: { base_time: '2000-01-01T00:00:00Z', ...extra }
});

const counterField = (pc = {}) => ({
    id: 'c1', name: 'SEQ', sequence: 1,
    op_code: 'AUTO_COUNTER', byte_len: 2, endianness: 'BIG',
    parameter_config: { value: 5, step: 1, max: 10, ...pc }
});

const ckField = (refs, pc = {}) => ({
    id: 'ck', name: 'CK', sequence: 9,
    op_code: 'CHECKSUM_CRC', byte_len: 2, endianness: 'BIG',
    parameter_config: { refs, algorithm: 'CRC_16_MODBUS', ...pc }
});

const instr = (fields) => ({ id: 'i1', fields });

const run = (fields, byteMap, inputs = {}, computed = {}) =>
    buildPlan(instr(fields), inputs, computed, byteMap);

describe('sequenceView.buildPlan', () => {
    it('returns null plan for empty byteMap / fully static frame', () => {
        expect(buildPlan(null, {}, {}, [])).toEqual({ plan: null, warnings: [] });
        // 静态字段（FIXED）无动态条目也无校验 → 后端原样发送
        const plain = { id: 'f', op_code: 'FIXED', byte_len: 2, parameter_config: { hex: 'A555' } };
        const out = run([plain], [{ start: 0, end: 2, fieldId: 'f' }]);
        expect(out.plan).toBeNull();
    });

    it('emits TIME entry with strict plan key set (unknown keys would 400)', () => {
        const out = run([timeField()], [{ start: 1, end: 3, fieldId: 't1' }]);
        expect(out.plan).not.toBeNull();
        expect(Object.keys(out.plan).sort()).toEqual(['checksum', 'dynamic']);
        expect(out.plan.dynamic).toEqual([{
            field_id: 't1',
            op: 'TIME_ACCUMULATOR',
            offset: 1,
            byte_len: 2,
            base_time: '2000-01-01T00:00:00Z'
        }]);
        expect(out.plan.checksum).toBeNull();
        expect(out.warnings).toEqual([]);
    });

    it('freezes TIME with warning when base_time invalid (encoder falls back too)', () => {
        const out = run([timeField({ base_time: 'not-a-date' })], [{ start: 0, end: 2, fieldId: 't1' }]);
        expect(out.plan).toBeNull();
        expect(out.warnings.some((w) => w.includes('base_time'))).toBe(true);
    });

    it('skips TIME when params.type breaks the encoder gate (no warning — static by design)', () => {
        const out = run([timeField({ type: 'string' })], [{ start: 0, end: 2, fieldId: 't1' }]);
        expect(out.plan).toBeNull();
        expect(out.warnings).toEqual([]);
    });

    it('counter value precedence mirrors encoder Current: computed > input > params.value > start_val', () => {
        const bm = [{ start: 0, end: 2, fieldId: 'c1' }];
        const field = counterField();
        // computed 最高
        expect(run([field], bm, { c1: 99 }, { c1: 7 }).plan.dynamic[0].value).toBe(7);
        // input 次之
        expect(run([field], bm, { c1: 99 }).plan.dynamic[0].value).toBe(99);
        // 静态 value 再次
        expect(run([field], bm).plan.dynamic[0].value).toBe(5);
        // 无 value → start_val
        const fromStart = counterField({ value: undefined, start_val: 3 });
        expect(run([fromStart], bm).plan.dynamic[0].value).toBe(3);
        // 全无 → 0（编码器 floorNum(undefined)=0 同口径）
        const bare = counterField({ value: undefined });
        const out = run([bare], bm);
        expect(out.plan.dynamic[0].value).toBe(0);
        expect(out.plan.dynamic[0].step).toBe(1);
        expect(out.plan.dynamic[0].max).toBe(10);
    });

    it('omits empty template scalars and keeps numeric strings', () => {
        const field = counterField({ value: '7', start_val: '', step: 2, max: undefined });
        const out = run([field], [{ start: 0, end: 2, fieldId: 'c1' }]);
        const entry = out.plan.dynamic[0];
        expect(entry.value).toBe('7');
        expect(entry.step).toBe(2);
        expect('start_val' in entry).toBe(false);
        expect('max' in entry).toBe(false);
    });

    it('builds checksum regions in refs order (crc16 concat order anchor)', () => {
        const fields = [
            { id: 'a', op_code: 'FIXED', byte_len: 2, parameter_config: {} },
            { id: 'b', op_code: 'FIXED', byte_len: 3, parameter_config: {} },
            ckField(['b', 'a'])  // 列示顺序 b 先
        ];
        const bm = [
            { start: 0, end: 2, fieldId: 'a' },
            { start: 2, end: 5, fieldId: 'b' },
            { start: 5, end: 7, fieldId: 'ck' }
        ];
        const out = run(fields, bm);
        expect(out.plan.checksum).toEqual({
            offset: 5, byte_length: 2,
            algo: 'crc16_modbus', byte_order: 'big',
            regions: [[2, 5], [0, 2]]
        });
    });

    it('maps algorithms and default to crc16 when algorithm missing (encoder parity)', () => {
        const bm = [
            { start: 0, end: 4, fieldId: 'a' },
            { start: 4, end: 6, fieldId: 'ck' }
        ];
        const a = [{ id: 'a', op_code: 'FIXED', byte_len: 4, parameter_config: {} }, ckField(['a'], { algorithm: 'SUM_8' })];
        expect(run(a, bm).plan.checksum.algo).toBe('sum');
        const x = [{ id: 'a', op_code: 'FIXED', byte_len: 4, parameter_config: {} }, ckField(['a'], { algorithm: 'XOR_8' })];
        expect(run(x, bm).plan.checksum.algo).toBe('xor');
        // 缺省 CRC_16_MODBUS → crc16_modbus
        const d = [{ id: 'a', op_code: 'FIXED', byte_len: 4, parameter_config: {} }, ckField(['a'], { algorithm: undefined })];
        expect(run(d, bm).plan.checksum.algo).toBe('crc16_modbus');
        expect(PLAN_ALGO.CRC_16_MODBUS).toBe('crc16_modbus');
    });

    it('degrades unsupported CRC_32 to frozen with warning', () => {
        const fields = [
            { id: 'a', op_code: 'FIXED', byte_len: 4, parameter_config: {} },
            ckField(['a'], { algorithm: 'CRC_32' })
        ];
        const bm = [{ start: 0, end: 4, fieldId: 'a' }, { start: 4, end: 6, fieldId: 'ck' }];
        const out = run(fields, bm);
        expect(out.plan).toBeNull(); // 动态为空 + 校验冻结 → 整体无计划
        expect(out.warnings.some((w) => w.includes('CRC_32'))).toBe(true);
    });

    it('honours LITTLE endianness → byte_order little', () => {
        const fields = [
            { id: 'a', op_code: 'FIXED', byte_len: 4, parameter_config: {} },
            { id: 'ck', op_code: 'CHECKSUM_CRC', byte_len: 2, endianness: 'LITTLE', parameter_config: { refs: ['a'], algorithm: 'CRC_16_MODBUS' } }
        ];
        const bm = [{ start: 0, end: 4, fieldId: 'a' }, { start: 4, end: 6, fieldId: 'ck' }];
        expect(run(fields, bm).plan.checksum.byte_order).toBe('little');
    });

    it('spans a group ref across all descendant leaves (union)', () => {
        const group = { id: 'g', op_code: 'GROUP', parameter_config: {}, parent_id: null };
        const fields = [
            group,
            { id: 'l1', op_code: 'FIXED', byte_len: 2, parent_id: 'g', parameter_config: {} },
            { id: 'l2', op_code: 'FIXED', byte_len: 3, parent_id: 'g', parameter_config: {} },
            ckField(['g'])
        ];
        const bm = [
            { start: 0, end: 2, fieldId: 'l1' },
            { start: 2, end: 5, fieldId: 'l2' },
            { start: 5, end: 7, fieldId: 'ck' }
        ];
        const out = run(fields, bm);
        expect(out.plan.checksum.regions).toEqual([[0, 5]]);
    });

    it('merges repeated leaf copies into one contiguous region', () => {
        // 同一叶子重复两份（emitNode per copy）→ 并集 [0,4)
        const bm = [
            { start: 0, end: 2, fieldId: 'r' },
            { start: 2, end: 4, fieldId: 'r' },
            { start: 4, end: 6, fieldId: 'ck' }
        ];
        const fields = [
            { id: 'r', op_code: 'FIXED', byte_len: 2, parameter_config: {} },
            ckField(['r'])
        ];
        expect(run(fields, bm).plan.checksum.regions).toEqual([[0, 4]]);
    });

    it('skips dangling refs (encoder parity) and warns when some missing', () => {
        const fields = [
            { id: 'a', op_code: 'FIXED', byte_len: 4, parameter_config: {} },
            ckField(['a', 'ghost'])
        ];
        const bm = [{ start: 0, end: 4, fieldId: 'a' }, { start: 4, end: 6, fieldId: 'ck' }];
        const out = run(fields, bm);
        expect(out.plan.checksum.regions).toEqual([[0, 4]]);
        expect(out.warnings.some((w) => w.includes('ghost') || w.includes('1 个'))).toBe(true);
    });

    it('freezes checksum when all refs unresolved or refs empty (backend needs non-empty regions)', () => {
        const noRefs = [
            { id: 'a', op_code: 'FIXED', byte_len: 4, parameter_config: {} },
            ckField([])
        ];
        const bm = [{ start: 0, end: 4, fieldId: 'a' }, { start: 4, end: 6, fieldId: 'ck' }];
        // refs 空 → 编码器同口径不计算校验 → 无任何计划项 → plan 整体为 null
        expect(run(noRefs, bm).plan).toBeNull();

        const ghostOnly = [
            { id: 'a', op_code: 'FIXED', byte_len: 4, parameter_config: {} },
            ckField(['ghost'])
        ];
        const out = run(ghostOnly, bm);
        expect(out.plan).toBeNull();
        expect(out.warnings.some((w) => w.includes('无有效字节区间'))).toBe(true);
    });

    it('rejects self-referential checksum regions (backend 400) with frozen fallback', () => {
        const fields = [
            ckField(['ck'])  // refs 指向自身
        ];
        const bm = [{ start: 0, end: 2, fieldId: 'ck' }];
        const out = run(fields, bm);
        expect(out.plan).toBeNull();
        expect(out.warnings.some((w) => w.includes('重叠'))).toBe(true);
    });

    it('freezes crc16 when checksum field width != 2 and width > 4 generally', () => {
        const wide = [
            { id: 'a', op_code: 'FIXED', byte_len: 4, parameter_config: {} },
            { id: 'ck', op_code: 'CHECKSUM_CRC', byte_len: 6, parameter_config: { refs: ['a'], algorithm: 'SUM_8' } }
        ];
        const bm = [{ start: 0, end: 4, fieldId: 'a' }, { start: 4, end: 10, fieldId: 'ck' }];
        const out = run(wide, bm);
        expect(out.plan).toBeNull();
        expect(out.warnings.some((w) => w.includes('4 字节'))).toBe(true);

        const narrowCrc = [
            { id: 'a', op_code: 'FIXED', byte_len: 4, parameter_config: {} },
            { id: 'ck', op_code: 'CHECKSUM_CRC', byte_len: 1, parameter_config: { refs: ['a'], algorithm: 'CRC_16_MODBUS' } }
        ];
        const bm1 = [{ start: 0, end: 4, fieldId: 'a' }, { start: 4, end: 5, fieldId: 'ck' }];
        const out1 = run(narrowCrc, bm1);
        expect(out1.plan).toBeNull();
        expect(out1.warnings.some((w) => w.includes('2 字节'))).toBe(true);
    });

    it('combines dynamic and checksum in one plan', () => {
        const fields = [
            timeField(),
            { id: 'a', op_code: 'FIXED', byte_len: 2, parameter_config: {} },
            ckField(['a'])
        ];
        const bm = [
            { start: 0, end: 2, fieldId: 't1' },
            { start: 2, end: 4, fieldId: 'a' },
            { start: 4, end: 6, fieldId: 'ck' }
        ];
        const out = run(fields, bm);
        expect(out.plan.dynamic).toHaveLength(1);
        expect(out.plan.checksum.regions).toEqual([[2, 4]]);
    });
});

describe('sequenceView status helpers', () => {
    it('resultLabel maps known results and passes through unknown/empty', () => {
        expect(resultLabel('completed')).toBe('完成');
        expect(resultLabel('failed')).toBe('失败');
        expect(resultLabel('stopped')).toBe('已停止');
        expect(resultLabel('running')).toBe('运行中');
        expect(resultLabel('idle')).toBe('待机');
        expect(resultLabel('mystery')).toBe('mystery');
        expect(resultLabel(null)).toBe('—');
    });

    it('tones are non-empty tokens per status', () => {
        expect(resultTone('completed')).toContain('green');
        expect(resultTone('failed')).toContain('red');
        expect(resultTone('running')).toContain('yellow');
        expect(resultTone('stopped')).toContain('orange');
        expect(resultTone(undefined)).toContain('nier');
        expect(stepTone('OK')).toContain('green');
        expect(stepTone('ERROR')).toContain('red');
        expect(stepTone('SKIPPED')).toContain('orange');
        expect(stepTone(undefined)).toContain('nier');
    });

    it('progressText: idle/empty dash, running current/total, terminal total/total', () => {
        expect(progressText(null)).toBe('—');
        expect(progressText({ total_steps: 0 })).toBe('—');
        expect(progressText({ total_steps: 5, current_step: 2 })).toBe('2/5');
        expect(progressText({ total_steps: 3, current_step: null })).toBe('3/3');
    });

    it('planSummary degrades gracefully', () => {
        expect(planSummary(null)).toBe('静态帧');
        expect(planSummary({ dynamic: [], checksum: null })).toBe('静态帧');
        expect(planSummary({
            dynamic: [{ op: 'TIME_ACCUMULATOR' }, { op: 'AUTO_COUNTER' }],
            checksum: { algo: 'sum' }
        })).toBe('动态×2 · 校验 sum');
    });

    it('payloadByteCount ignores separators and floors odd digits', () => {
        expect(payloadByteCount('A5 01-0B')).toBe(3);
        expect(payloadByteCount('')).toBe(0);
        expect(payloadByteCount(null)).toBe(0);
        expect(payloadByteCount('ABC')).toBe(1);
    });

    it('reorder moves items and is defensive on bad indices / input untouched', () => {
        const src = ['a', 'b', 'c'];
        expect(reorder(src, 0, 2)).toEqual(['b', 'c', 'a']);
        expect(reorder(src, 2, 0)).toEqual(['c', 'a', 'b']);
        expect(reorder(src, 1, 1)).toEqual(['a', 'b', 'c']);
        expect(reorder(src, 9, 0)).toEqual(['a', 'b', 'c']);
        expect(reorder(src, -1, 1)).toEqual(['a', 'b', 'c']);
        expect(reorder(null, 0, 1)).toEqual([]);
        expect(src).toEqual(['a', 'b', 'c']);  // 不改原数组
    });

    it('EMPTY_CONFIG mirrors server-normalized defaults', () => {
        expect(EMPTY_CONFIG).toEqual({ stop_on_error: true, read_timeout_ms: null });
    });
});

describe('sequenceView shell summary (CP3 3c D6-B)', () => {
    it('buildPlan never emits a shell key — shell is backend-injected SSOT', () => {
        const fields = [
            timeField(),
            { id: 'a', op_code: 'FIXED', byte_len: 2, parameter_config: {} },
            ckField(['a'])
        ];
        const bm = [
            { start: 0, end: 2, fieldId: 't1' },
            { start: 2, end: 4, fieldId: 'a' },
            { start: 4, end: 6, fieldId: 'ck' }
        ];
        const out = run(fields, bm);
        expect(out.plan).not.toBeNull();
        // 输出键集严格 {dynamic, checksum} —— shell 由后端保存期注入（前端只透传）
        expect(Object.keys(out.plan).sort()).toEqual(['checksum', 'dynamic']);
        expect('shell' in out.plan).toBe(false);
        // 展示函数只读不改（调用后键集不变）
        shellSummary(out.plan);
        expect(Object.keys(out.plan).sort()).toEqual(['checksum', 'dynamic']);
    });

    it('shellSummary renders layer span + per-layer LEN/CRC offsets, empty without shell', () => {
        expect(shellSummary(null)).toBe('');
        expect(shellSummary({ dynamic: [], checksum: null })).toBe('');
        expect(shellSummary({ dynamic: [], checksum: null, shell: null })).toBe('');
        expect(shellSummary({ shell: { layers: [] } })).toBe('');

        // 几何对齐 backend/core/recipe_compile.shell_plan：16 字节帧 3 层，
        // 由内到外 offset 递减、最外层 0（坐标 = 最终帧绝对字节）
        const plan = {
            dynamic: [], checksum: null,
            shell: {
                recipe_id: 'rec-1',
                definition_hash: 'sha256:deadbeef',
                kernel: { offset: 6, length: 4 },
                layers: [
                    { index: 0, offset: 5, size: 7,
                        length: [{ offset: 5, byte_length: 1 }], checksum: [{ offset: 10, byte_length: 2 }] },
                    { index: 1, offset: 3, size: 11,
                        length: [{ offset: 3, byte_length: 2 }], checksum: [{ offset: 12, byte_length: 2 }] },
                    { index: 2, offset: 0, size: 16,
                        length: [{ offset: 0, byte_length: 2 }], checksum: [{ offset: 14, byte_length: 2 }] }
                ]
            }
        };
        expect(shellSummary(plan)).toBe(
            'SHELL L1..L3 · L1 LEN@5 CRC@10 · L2 LEN@3 CRC@12 · L3 LEN@0 CRC@14'
        );
        // 层无 LEN/CRC 字段时仍列层号（层数信息不丢）；单层不写 L1..L1
        expect(shellSummary({
            shell: { layers: [{ index: 0, offset: 0, size: 4, length: [], checksum: [] }] }
        })).toBe('SHELL L1 · L1');
    });
});
