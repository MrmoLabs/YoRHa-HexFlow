// R25（§8.52 排期 · 挂账 ② · §8.57）：SCRAMBLE 加扰 / 混淆字段 —— 双端同源。
//
// 共享向量单一真相源 = vectors/scramble.json（本文件与 backend/tests/test_scramble.py
// 同读一份，新增向量只写一处）。表内 plain × mode × seed × roll → expected（加扰后 hex）：
//   XOR_SEED  out[i] = plain[i] ^ seed[i % len(seed)]
//   BIT_ROLL  out[i] = (plain[i] << n | plain[i] >> (8-n)) & 0xFF   n = roll % 8
// 口径档案在 utils/scramble.js，BE core/orchestrator.encode_scramble 逐行同语义。
import { describe, it, expect } from 'vitest';
import { OP_CODES } from '../../constants';
import { InstructionEncoder } from '../InstructionEncoder';
import { InstructionDecoder } from '../InstructionDecoder';
import { validateInstruction } from '../validateInstruction';
import { applyOpDefaults, planOpSwitch, switchableOps, KNOWN_OP_LIST } from '../opSwitch';
import {
    DEFAULT_SCRAMBLE_MODE,
    SCRAMBLE_MODES,
    isValidPlainHex,
    normalizeScrambleMode,
    scrambleHex,
    scrambleParamError,
    scrambleRollBits,
    unscrambleHex,
} from '../scramble';
import {
    classifyRunnerField,
    collectSemanticItems,
    resolveFieldDisplay,
    resolveRunnerKind,
} from '../../config/runnerRenderRules';
import { normalizeRunnerInstruction } from '../../components/InstructionForm/normalizeRunnerInstruction';
import { loadVectors } from '../../../../vectors/vectors.js';
import scrambleVec from '../../../../vectors/scramble.json';

const VECTORS = loadVectors(scrambleVec);
const strip = (r) => r.hexString.replace(/\s/g, '').toUpperCase();

const clean = (text) => String(text ?? '').replace(/\s/g, '');
// 明文规范化（双端同口径，同 BE plain_of）：去空白 + 大写 + 奇长丢末尾半字节
const plainOf = (text) => {
    const c = clean(text);
    return (c.length % 2 ? c.slice(0, -1) : c).toUpperCase();
};
const byteLenOf = (text) => Math.max(1, Math.ceil(clean(text).length / 2));

const instr = (row, byteLen) => ({
    id: 'i1',
    name: 'I',
    fields: [{
        id: 's',
        name: 'S',
        op_code: 'SCRAMBLE',
        sequence: 0,
        parent_id: null,
        byte_len: byteLen ?? byteLenOf(row.plain),
        parameter_config: (() => {
            const pc = { hex: row.plain };
            ['mode', 'seed', 'roll'].forEach((k) => { if (k in row) pc[k] = row[k]; });
            return pc;
        })(),
    }],
});

const leafOf = (row) => instr(row).fields[0];

describe('R25 SCRAMBLE（共享向量 vectors/scramble.json · 双端同读）', () => {
    it('14 行向量逐行：加扰纯函数与 BE 期望 byte-equal', () => {
        expect(VECTORS).toHaveLength(14);
        for (const row of VECTORS) {
            expect(
                scrambleHex(row.plain, row),
                `plain=${row.plain} mode=${row.mode} seed=${row.seed} roll=${row.roll}`
            ).toBe(row.expected);
        }
    });

    it('14 行向量逐行：出帧与纯函数同字节（编码器链路）', () => {
        for (const row of VECTORS) {
            expect(strip(InstructionEncoder.encodeInstruction(instr(row), {}, {}))).toBe(row.expected);
        }
    });

    it('14 行向量逐行：解码是编码的逆（decode(encode(x)) == x）', () => {
        for (const row of VECTORS) {
            const wire = row.expected;
            const bytes = (wire.match(/.{1,2}/g) || []).map((p) => parseInt(p, 16));
            expect(unscrambleHex(wire, row), `wire=${wire}`).toBe(plainOf(row.plain));
            expect(InstructionDecoder.decodeFieldBytes(leafOf(row), bytes))
                .toBe(plainOf(row.plain));
        }
    });

    it('表覆盖两模式 + 恒等 fail-open 行', () => {
        const modes = new Set(VECTORS.map((r) => String(r.mode ?? 'XOR_SEED').toUpperCase()));
        expect([...modes].sort()).toEqual(['BIT_ROLL', 'FOO', 'XOR_SEED']);
        const identity = VECTORS.filter((r) => r.expected === plainOf(r.plain));
        expect(identity.length).toBeGreaterThanOrEqual(4);
    });
});

describe('R25 SCRAMBLE 编码口径（明文源 / 补零回落 / inputs 不参与）', () => {
    it('明文空 / 非 hex / 非字符串 → byte_len 补零（与 BE hex_value=None 同字节）', () => {
        const cases = [
            { plain: '', bl: 2, want: '0000' },
            { plain: 'ZZ', bl: 2, want: '0000' },
            { plain: '0102', bl: 2, want: 'A4A7' }, // seed A5 基准
        ];
        cases.forEach(({ plain, bl, want }) => {
            const f = {
                id: 's', name: 'S', op_code: 'SCRAMBLE', byte_len: bl, sequence: 0,
                parent_id: null, parameter_config: { hex: plain, seed: 'A5' },
            };
            expect(strip(InstructionEncoder.encodeInstruction({ id: 'i', fields: [f] }, {}, {})), `hex=${plain}`)
                .toBe(want);
        });
        // 数字型 hex（直连 API）→ 同 BE `isinstance(hex, str)` 判死
        const f = {
            id: 's', name: 'S', op_code: 'SCRAMBLE', byte_len: 1, sequence: 0,
            parent_id: null, parameter_config: { hex: 1234, seed: 'A5' },
        };
        expect(strip(InstructionEncoder.encodeInstruction({ id: 'i', fields: [f] }, {}, {}))).toBe('00');
    });

    it('byte_len=0 的空明文两端同为 0 字节', () => {
        const f = {
            id: 's', name: 'S', op_code: 'SCRAMBLE', byte_len: 0, sequence: 0,
            parent_id: null, parameter_config: { seed: 'A5' },
        };
        expect(strip(InstructionEncoder.encodeInstruction({ id: 'i', fields: [f] }, {}, {}))).toBe('');
    });

    it('inputs / computedValues 压不过明文（加工页只读 → 没有可压的入口）', () => {
        const row = { plain: '01020304', seed: 'A5' };
        const want = strip(InstructionEncoder.encodeInstruction(instr(row), {}, {}));
        expect(strip(InstructionEncoder.encodeInstruction(
            instr(row), { s: 4660 }, { s: 'BEEF' }
        ))).toBe(want);
        expect(want).toBe('A4A7A6A1');
    });

    it('契约外参数 → 恒等（与 BE 同式：非法种子 / 非法 roll / 非法 mode）', () => {
        expect(scrambleHex('0102', { mode: 'XOR_SEED', seed: '0' })).toBe('0102');
        expect(scrambleHex('0102', { mode: 'XOR_SEED', seed: 'GG' })).toBe('0102');
        expect(scrambleHex('0102', { mode: 'XOR_SEED' })).toBe('0102');
        expect(scrambleHex('0102', { mode: 'BIT_ROLL', roll: 'abc' })).toBe('0102');
        expect(scrambleHex('0102', { mode: 'BIT_ROLL' })).toBe('0102');
        expect(scrambleHex('0102', { mode: 'FOO', seed: 'A5' })).toBe('0102');
    });

    it('roll 归一 mod 8（负数 / 超 8 / 小数 / 数字串同口径，含 JS 负 % 修正）', () => {
        expect(scrambleRollBits(-1)).toBe(7);
        expect(scrambleRollBits(-7)).toBe(1);
        expect(scrambleRollBits(9)).toBe(1);
        expect(scrambleRollBits(1.9)).toBe(1);
        expect(scrambleRollBits('3')).toBe(3);
        expect(scrambleRollBits('abc')).toBe(0);
        expect(scrambleHex('81', { mode: 'BIT_ROLL', roll: -7 }))
            .toBe(scrambleHex('81', { mode: 'BIT_ROLL', roll: 1 }));
        expect(scrambleHex('81', { mode: 'BIT_ROLL', roll: 9 }))
            .toBe(scrambleHex('81', { mode: 'BIT_ROLL', roll: 1 }));
    });

    it('模式归一（trim + 大写；缺省 XOR_SEED；不在册 → null）', () => {
        expect(DEFAULT_SCRAMBLE_MODE).toBe('XOR_SEED');
        expect(SCRAMBLE_MODES).toEqual(['XOR_SEED', 'BIT_ROLL']);
        expect(normalizeScrambleMode(undefined)).toBe('XOR_SEED');
        expect(normalizeScrambleMode(' xor_seed ')).toBe('XOR_SEED');
        expect(normalizeScrambleMode('FOO')).toBeNull();
        expect(isValidPlainHex('A1B2')).toBe(true);
        expect(isValidPlainHex('')).toBe(false);
        expect(isValidPlainHex('GG')).toBe(false);
    });
});

describe('R25 SCRAMBLE 保存侧校验（E1 扩 + SCRAMBLE_PARAM，与 BE _validate_scrambles 同口径）', () => {
    const blk = (pc, byteLen = 2, id = 'f1', name = '加扰', sequence = 0) => ({
        id, name, op_code: 'SCRAMBLE', byte_len: byteLen, sequence,
        parent_id: null, parameter_config: pc,
    });
    const instOf = (fields) => ({ id: 'i1', name: 'I', code: 'C1', device_code: 'D1', fields });

    it('合法参数 + 等长明文 → 无错', () => {
        const { errors, warnings } = validateInstruction(instOf([
            blk({ hex: 'AABB', seed: 'A5' }, 2, 'f1', '加扰A', 0),
            blk({ hex: 'AABB', mode: 'BIT_ROLL', roll: 3 }, 2, 'f2', '加扰B', 1),
        ]));
        expect(errors).toEqual([]);
        expect(warnings).toEqual([]);
    });

    it('E1 扩到 SCRAMBLE：明文长度 ≠ byte_len×2 → HEX_LENGTH（error）', () => {
        const { errors } = validateInstruction(instOf([blk({ hex: 'AA', seed: 'A5' })]));
        const e = errors.find((x) => x.code === 'HEX_LENGTH');
        expect(e).toBeTruthy();
        expect(e.message).toMatch(/HEX 长度与字节长度不符/);
    });

    it('E1 扩到 SCRAMBLE：明文为空 → 只提醒 HEX_EMPTY（与 HEX_RAW 同口径，不拦）', () => {
        const { errors, warnings } = validateInstruction(instOf([blk({ seed: 'A5' })]));
        expect(errors).toEqual([]);
        expect(warnings.some((x) => x.code === 'HEX_EMPTY')).toBe(true);
    });

    it('SCRAMBLE_PARAM：非法 mode / 空·奇长·非 hex 种子 / 不可解析 roll → error', () => {
        [
            { hex: 'AABB', mode: 'FOO', seed: 'A5' },
            { hex: 'AABB' },
            { hex: 'AABB', seed: 'A' },
            { hex: 'AABB', seed: 'GG' },
            { hex: 'AABB', mode: 'BIT_ROLL', roll: 'abc' },
        ].forEach((pc) => {
            const { errors } = validateInstruction(instOf([blk(pc)]));
            const e = errors.find((x) => x.code === 'SCRAMBLE_PARAM');
            expect(e, JSON.stringify(pc)).toBeTruthy();
            expect(e.message).toMatch(/加扰模式无效|XOR 种子无效|位旋转位数无效/);
        });
    });

    it('另一模式的参数留空合法（只判生效模式）', () => {
        expect(scrambleParamError({ hex: 'AABB', mode: 'BIT_ROLL', roll: 1 })).toBeNull();
        expect(scrambleParamError({ hex: 'AABB', mode: 'XOR_SEED', seed: '5AA5' })).toBeNull();
        expect(scrambleParamError({ mode: 'XOR_SEED' })).toMatch(/XOR 种子无效/);
        expect(scrambleParamError({ mode: 'BIT_ROLL' })).toMatch(/位旋转位数无效/);
        expect(scrambleParamError({ mode: 'FOO', seed: 'A5' })).toMatch(/加扰模式无效/);
    });

    it('已知全集收下 SCRAMBLE（无 OP_UNKNOWN）', () => {
        const { errors } = validateInstruction(instOf([blk({ hex: 'AABB' })]));
        expect(errors.some((x) => x.code === 'OP_UNKNOWN')).toBe(false);
        expect(KNOWN_OP_LIST).toHaveLength(22);
    });
});

describe('R25 SCRAMBLE 归一化身份（保 op、判只读 —— R23「摊平即失效」教训）', () => {
    const raw = (extra = {}) => ({
        id: 'i1', name: 'I', code: 'C1', device_code: 'D1',
        fields: [{
            id: 's', name: 'S', op_code: 'SCRAMBLE', byte_len: 2, sequence: 0,
            parent_id: null, parameter_config: { hex: '0102', seed: 'A5', ...extra },
        }],
    });

    it('保 op_code 与 original_op_code；不建输入、非 variable（只读由 isFixed 判定）', () => {
        const out = normalizeRunnerInstruction(raw());
        const f = out.fields[0];
        expect(f.op_code).toBe('SCRAMBLE');
        expect(f.original_op_code).toBe('SCRAMBLE');
        expect(f.parameter_config.variable).toBe(false);
        expect(classifyRunnerField(f).isFixed).toBe(true);
        expect(classifyRunnerField(f).isEditable).toBe(false);
    });

    it('幂等（再归一一次仍 SCRAMBLE）', () => {
        const once = normalizeRunnerInstruction(raw());
        const twice = normalizeRunnerInstruction(once);
        expect(twice.fields[0].op_code).toBe('SCRAMBLE');
        expect(twice.fields[0].parameter_config.hex).toBe('0102');
    });

    it('显空明文同样判只读（否则落进 INPUT、键入无处生效）', () => {
        const out = normalizeRunnerInstruction(raw({ hex: '' }));
        expect(out.fields[0].op_code).toBe('SCRAMBLE');
        expect(out.fields[0].parameter_config.variable).toBe(false);
    });
});

describe('R25 SCRAMBLE 加工页渲染（只读 / 明文回显 / 线上字节）', () => {
    const field = {
        id: 's', name: 'S', op_code: 'SCRAMBLE', byte_len: 2, sequence: 0,
        parent_id: null, parameter_config: { hex: '0102', seed: 'A5' },
    };

    it('classify isFixed（两认身份）+ resolveFieldDisplay 回显明文（只读 text 通道）', () => {
        expect(classifyRunnerField(field).isFixed).toBe(true);
        expect(classifyRunnerField({ ...field, op_code: 'FIXED', original_op_code: 'SCRAMBLE' }).isFixed).toBe(true);
        const disp = resolveFieldDisplay(field);
        expect(disp.inputType).toBe('text');
        expect(disp.displayValue).toBe('0102');
        // 明文缺失 → 与 HEX_RAW 同口径按 byte_len 补零占位（不显 ??）
        const empty = resolveFieldDisplay({ ...field, parameter_config: { seed: 'A5' } });
        expect(empty.displayValue).toBe('0000');
    });

    it('kind 芯片是 SCR（明文 ≠ 线上字节，不掉进 FIX）', () => {
        expect(resolveRunnerKind(field)).toMatchObject({ key: 'SCR', label: 'SCR' });
    });

    it('语义行亮出 MODE + 生效模式的参数（SEED / ROLL 二选一）', () => {
        const xor = collectSemanticItems(field).map((i) => i.text);
        expect(xor).toContain('MODE=XOR_SEED');
        expect(xor).toContain('SEED=A5');
        expect(xor).not.toContain('ROLL=1');

        const roll = collectSemanticItems({ ...field, parameter_config: { hex: '0102', mode: 'BIT_ROLL', roll: 3 } })
            .map((i) => i.text);
        expect(roll).toContain('MODE=BIT_ROLL');
        expect(roll).toContain('ROLL=3');
        expect(roll.some((t) => t.startsWith('SEED='))).toBe(false);
    });
});

describe('R25 SCRAMBLE 创建 / 切算子（模板播种 + 白名单同批 21 → 22）', () => {
    const TEMPLATES = {
        SCRAMBLE: {
            op_code: 'SCRAMBLE', category: 'ENCODING',
            param_template: { mode: ['XOR_SEED', 'BIT_ROLL'], seed: 'A5', roll: 1 },
        },
        HEX_RAW: { op_code: 'HEX_RAW', category: 'BASE', param_template: { hex: 'input' } },
        INT_UNSIGNED: { op_code: 'INT_UNSIGNED', category: 'NUMERIC', param_template: { bits: [8, 16] } },
    };

    it('applyOpDefaults 播种明文等长 hex + 缺省参数（模式取首项、种子/旋转为字面值）', () => {
        const seeded = applyOpDefaults({ byte_len: 3, parameter_config: {} },
            OP_CODES.SCRAMBLE, TEMPLATES.SCRAMBLE);
        expect(seeded.parameter_config.hex).toBe('000000');
        expect(seeded.parameter_config.mode).toBe('XOR_SEED');
        expect(seeded.parameter_config.seed).toBe('A5');
        expect(seeded.parameter_config.roll).toBe(1);
        // 明文长度与 byte_len 不等 → 重播；等长 → 原样保留（不覆盖已有明文）
        expect(applyOpDefaults({ byte_len: 3, parameter_config: { hex: 'AA' } },
            OP_CODES.SCRAMBLE, TEMPLATES.SCRAMBLE).parameter_config.hex).toBe('000000');
        expect(applyOpDefaults({ byte_len: 2, parameter_config: { hex: 'A1B2' } },
            OP_CODES.SCRAMBLE, TEMPLATES.SCRAMBLE).parameter_config.hex).toBe('A1B2');
    });

    it('planOpSwitch 切入 SCRAMBLE：中性键保留 + 按目标算子播等长明文与合法参数', () => {
        const plan = planOpSwitch({
            op_code: OP_CODES.HEX_RAW, byte_len: 4,
            parameter_config: { hex: 'AABBCCDD', endianness: 'BIG' },
        }, OP_CODES.SCRAMBLE, { templates: TEMPLATES });
        expect(plan.ok).toBe(true);
        expect(plan.next.op_code).toBe(OP_CODES.SCRAMBLE);
        // hex 不是中性键（切算子 ≡ 新建目标算子，R24 拍板）→ 播成 byte_len 等长明文
        expect(plan.next.parameter_config.hex).toBe('00000000');
        expect(plan.next.parameter_config.mode).toBe('XOR_SEED');
        expect(plan.next.parameter_config.seed).toBe('A5');
        expect(plan.next.parameter_config.roll).toBe(1);
        expect(plan.next.parameter_config.endianness).toBe('BIG');
        expect(scrambleParamError(plan.next.parameter_config)).toBeNull();
        expect(plan.kept).toContain('endianness');
        // hex 不在 kept（非中性键）→ 老明文不会串到新算子的其它键上
        expect(plan.kept).not.toContain('hex');
    });

    it('切出 SCRAMBLE：mode/seed/roll 是算子专属键 → 清干净（中性键 value 保留）', () => {
        const plan = planOpSwitch({
            op_code: OP_CODES.SCRAMBLE, byte_len: 2,
            parameter_config: { hex: '0102', mode: 'BIT_ROLL', roll: 3, seed: 'A5', value: 7 },
        }, OP_CODES.INT_UNSIGNED, { templates: TEMPLATES });
        expect(plan.ok).toBe(true);
        ['hex', 'mode', 'seed', 'roll'].forEach((k) => {
            expect(plan.next.parameter_config[k], k).toBeUndefined();
        });
        expect(plan.next.parameter_config.value).toBe(7);
        expect(plan.dropped).toContain('seed');
    });

    it('切算子下拉含 SCRAMBLE（模板集 = 可切换集，与 BE SEED_TEMPLATES 同源）', () => {
        expect(switchableOps(TEMPLATES, OP_CODES.HEX_RAW)).toContain(OP_CODES.SCRAMBLE);
        expect(KNOWN_OP_LIST).toContain(OP_CODES.SCRAMBLE);
    });
});
