import { describe, it, expect } from 'vitest';
import { validateInstruction } from '../validateInstruction';

// ─── R31 (§8.63): presence **设计期效度**两码（红测先行） ────────────────────
// R29/R30 只把「为什么判不等」的原因摆在**加工页/步骤编辑器**的 hover 里 —— 那是
// 运行前的填写现场；**指令管理页（设计期）看不到**，等用户发现「配了却一个字节都
// 不发」已经晚了。设计期把「这条条件根本不可能成立」的形态点出来。
//
// 硬性质：**零行为变更** —— 全部落 warnings（保存只拦 errors）。
//
//   W PRESENCE_REF_NO_SOURCE      —— 引用字段拿不到可判定的值（只读常量、无静态值、
//                                    非输入型、无选项、非计算类）→ 编码恒 fail-open
//                                    判命中 = 等于没配
//   W PRESENCE_EXPECT_UNREACHABLE —— 引用字段的**全部可取值**（下拉选项 + 静态值）
//                                    与 expect **全都判不等**（含 R32 十六进制归一）
//                                    → 选哪一项都不成立 = 恒 0 字节
//
// R32 (§8.64) 起第三码 `PRESENCE_HEX_PAD` **退役**：判定归一后 `"01"` ≡ 1 判**命中**，
// 「恒未命中」的前提不复存在，再报就是假警 —— 补零差异改由加工页**命中侧**的
// 「按十六进制归一判等」注记说明。
//
// 判据一律「**宁可少判不误判**」：拿不准（可自由键入、非锁定、无候选全集）就不报。

const fld = (id, seq, pc = {}, op = 'INT_SIGNED') => ({
    id, name: id.toUpperCase(), op_code: op, byte_len: 1,
    sequence: seq, parent_id: null, parameter_config: { ...pc },
});
const instr = (fields) => ({ fields });
// 门字段（gate）+ 一条指定形态的引用字段
const withGate = (refField, expectVal) => instr([
    fld('gate', 0, { value: 1, presence: { ref_id: refField.id, expect: expectVal } }),
    refField,
]);
const codes = (r, level) => r[level].map(w => w.code).filter(c => c.startsWith('PRESENCE'));

// ─── ① 门拿不到值 → 恒 fail-open 命中（等于没配） ─────────────────────────────
describe('R31 W PRESENCE_REF_NO_SOURCE（引用字段拿不到可判定的值）', () => {
    it('引用字段是锁定常量（HEX_RAW 无静态值）→ warning，落在门字段上', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { hex: 'FF' }, 'HEX_RAW'), '1'));
        const w = r.warnings.find(x => x.code === 'PRESENCE_REF_NO_SOURCE');
        expect(w).not.toBeUndefined();
        expect(w.blockId).toBe('gate');
        expect(w.message).toContain('拿不到可判定的值');
        expect(w.message).toContain('fail-open');
        expect(w.message).toContain('等于没配');
        expect(r.errors).toEqual([]);          // 只提醒，不锁保存
    });

    it('引用字段有静态值 pc.value → 不报（拿得到值）', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { hex: 'FF', value: 7 }, 'HEX_RAW'), '1'));
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_REF_NO_SOURCE');
    });

    it('引用字段是输入型（INPUT，加工页会播种输入）→ 不报', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { type: 'number' }, 'INPUT'), '1'));
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_REF_NO_SOURCE');
    });

    it('引用字段带选项表（加工页可选）→ 不报', () => {
        const r = validateInstruction(withGate(
            fld('ref', 1, { options: { 开: '01', 关: '00' } }, 'MAPPING'), '01'));
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_REF_NO_SOURCE');
    });

    it('引用字段是计算类（formula auto / LENGTH_CALC）→ 不报（computedValues 有值）', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { formula: 'auto' }, 'CALCULATED'), '1'));
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_REF_NO_SOURCE');
    });

    it('引用字段**非锁定**（可编辑、暂无值源）→ 不报（拿不准一律少判）', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { type: 'number' }, 'BITFIELD'), '1'));
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_REF_NO_SOURCE');
    });

    it('ref 悬空（另码 REF_MISSING 覆盖）→ 不叠报效度码', () => {
        const r = validateInstruction(instr([
            fld('gate', 0, { value: 1, presence: { ref_id: 'ghost', expect: '1' } }),
        ]));
        expect(codes(r, 'warnings')).toContain('PRESENCE_REF_MISSING');
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_REF_NO_SOURCE');
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_EXPECT_UNREACHABLE');
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_HEX_PAD');
    });

    it('配置不完整（缺 expect，另码 INCOMPLETE 覆盖）→ 不叠报效度码', () => {
        const r = validateInstruction(instr([
            fld('gate', 0, { value: 1, presence: { ref_id: 'ref' } }),
            fld('ref', 1, { hex: 'FF' }, 'HEX_RAW'),
        ]));
        expect(codes(r, 'warnings')).toContain('PRESENCE_INCOMPLETE');
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_REF_NO_SOURCE');
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_EXPECT_UNREACHABLE');
    });
});

// ─── ② 全部可取值都判不等（含 R32 归一）→ 选哪项都不成立 ─────────────────────
describe('R31 W PRESENCE_EXPECT_UNREACHABLE（可取值穷尽无一命中）', () => {
    it('样本② **归一后可达**：下拉 {开:"01", 关:"00"} + expect "01" → 不报（R32 已判等）', () => {
        const r = validateInstruction(withGate(
            fld('ref', 1, { options: { 开: '01', 关: '00' } }, 'MAPPING'), '01'));
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_EXPECT_UNREACHABLE');
        expect(r.errors).toEqual([]);
    });

    it('候选穷尽且**归一后**仍判不等（选项 05/06 + expect "0A"）→ warning', () => {
        const r = validateInstruction(withGate(
            fld('ref', 1, { options: { 甲: '05', 乙: '06' } }, 'MAPPING'), '0A'));
        const w = r.warnings.find(x => x.code === 'PRESENCE_EXPECT_UNREACHABLE');
        expect(w).not.toBeUndefined();
        expect(w.blockId).toBe('gate');
        expect(w.message).toContain('可取值');
        expect(w.message).toContain('expect "0A"');
        expect(w.message).toContain('含十六进制归一');
        expect(w.message).toContain('恒未命中');
        expect(w.message).toContain('0 字节');
        expect(r.errors).toEqual([]);          // 只提醒，不锁保存
    });

    it('选项归一后存在命中值（expect "1" 对选项 01→1）→ 不报', () => {
        const r = validateInstruction(withGate(
            fld('ref', 1, { options: { 开: '01' } }, 'MAPPING'), '1'));
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_EXPECT_UNREACHABLE');
    });

    it('选项与 expect 真不同值（05 vs 07）→ 仍报（任一选项都选不中）', () => {
        const r = validateInstruction(withGate(
            fld('ref', 1, { options: { 只有一个: '05' } }, 'MAPPING'), '07'));
        expect(codes(r, 'warnings')).toContain('PRESENCE_EXPECT_UNREACHABLE');
    });

    it('静态值落在候选集里且相等（value "1" + expect "1"）→ 不报', () => {
        const r = validateInstruction(withGate(
            fld('ref', 1, { options: { A: '05' }, value: 1 }, 'MAPPING'), '1'));
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_EXPECT_UNREACHABLE');
    });

    it('无选项表（取值不封闭，判据不成立）→ 不报', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { value: 7 }, 'HEX_RAW'), '1'));
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_EXPECT_UNREACHABLE');
    });
});

// ─── ③ R31 的 W PRESENCE_HEX_PAD 已随 R32 判定归一**退役** ───────────────────
describe('R32 归一后 W PRESENCE_HEX_PAD 退役（「恒未命中」前提已不成立）', () => {
    it('静态值 1 + expect "01" → 归一判等（门命中）→ 不再报 HEX_PAD', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { value: 1 }), '01'));
        expect(r.warnings.some(w => w.code === 'PRESENCE_HEX_PAD')).toBe(false);
        expect(r.errors).toEqual([]);
    });

    it('带字母补零形态（值 10 + expect "0A"）→ 同样归一判等 → 不报', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { value: 10 }), '0A'));
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_HEX_PAD');
    });

    it('真·不同值（值 1 + expect "9"）/ 本来判等（值 1 + "1"）→ 都不报（码已下架）', () => {
        expect(codes(validateInstruction(withGate(fld('ref', 1, { value: 1 }), '9')), 'warnings'))
            .not.toContain('PRESENCE_HEX_PAD');
        expect(codes(validateInstruction(withGate(fld('ref', 1, { value: 1 }), '1')), 'warnings'))
            .not.toContain('PRESENCE_HEX_PAD');
    });

    it('补零形态 + 有值源 + 无选项 → ①②也不报：整条指令 PRESENCE 提醒为空', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { value: 1 }), '01'));
        expect(codes(r, 'warnings')).toEqual([]);
    });
});

// ─── 零行为变更总闸：提醒全在 warnings，绝不产生 error ────────────────────────
describe('R31/R32 零行为变更（不阻断保存）', () => {
    it('①②同时存在 + 一条归一命中的门 → 两条 warning、errors 仍为空', () => {
        const r = validateInstruction(instr([
            fld('gate', 0, { value: 1, presence: { ref_id: 'a', expect: '01' } }),
            fld('a', 1, { value: 1 }),                       // R32 归一命中 → 零提醒
            fld('gate2', 2, { value: 1, presence: { ref_id: 'b', expect: '1' } }),
            fld('b', 3, { hex: 'FF' }, 'HEX_RAW'),           // ①
            fld('gate3', 4, { value: 1, presence: { ref_id: 'c', expect: '0A' } }),
            fld('c', 5, { options: { 甲: '05', 乙: '06' } }, 'MAPPING'),  // ②
        ]));
        const w = codes(r, 'warnings');
        expect(w).toContain('PRESENCE_REF_NO_SOURCE');
        expect(w).toContain('PRESENCE_EXPECT_UNREACHABLE');
        expect(w.filter(c => c === 'PRESENCE_HEX_PAD')).toEqual([]);   // 退役码零回归
        expect(r.errors).toEqual([]);
    });

    it('存量无 presence 字段 → 两码全无（存量零回归）', () => {
        const r = validateInstruction(instr([fld('a', 0, { value: 1 }), fld('b', 1, { value: 2 })]));
        expect(codes(r, 'warnings')).toEqual([]);
        expect(codes(r, 'errors')).toEqual([]);
    });
});
