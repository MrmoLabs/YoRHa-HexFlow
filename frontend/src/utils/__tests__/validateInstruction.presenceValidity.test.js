import { describe, it, expect } from 'vitest';
import { validateInstruction } from '../validateInstruction';

// ─── R31 (§8.63): presence **设计期效度**三码（红测先行） ────────────────────
// R29/R30 只把「为什么判不等」的原因摆在**加工页/步骤编辑器**的 hover 里 —— 那是
// 运行前的填写现场；**指令管理页（设计期）看不到**，等用户发现「配了却一个字节都
// 不发」已经晚了。三码在设计期就把三种「这条条件根本不可能成立」的形态点出来。
//
// 硬性质：**零行为变更** —— 三码全部落 warnings（保存只拦 errors），判定 / 编码 /
// 校验四码一行未动 → 出线字节逐字不变。
//
//   W PRESENCE_REF_NO_SOURCE      —— 引用字段拿不到可判定的值（只读常量、无静态值、
//                                    非输入型、无选项、非计算类）→ 编码恒 fail-open
//                                    判命中 = 等于没配
//   W PRESENCE_EXPECT_UNREACHABLE —— 引用字段的**全部可取值**（下拉选项 + 静态值）
//                                    都与 expect 不相等 → 选哪一项都不成立 = 恒 0 字节
//   W PRESENCE_HEX_PAD            —— 静态值与 expect 十六进制解析相等却 String 判不
//                                    等（补零/进制差异，样本②同款）→ 恒未命中
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
        expect(w).toBeTruthy();
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

// ─── ② 全部可取值都不相等 → 选哪项都不成立（样本② 的设计期可见版） ────────────
describe('R31 W PRESENCE_EXPECT_UNREACHABLE（可取值穷尽无一命中）', () => {
    it('样本②：下拉 {开:"01", 关:"00"} + expect "01" → warning（选哪个都不成立）', () => {
        const r = validateInstruction(withGate(
            fld('ref', 1, { options: { 开: '01', 关: '00' } }, 'MAPPING'), '01'));
        const w = r.warnings.find(x => x.code === 'PRESENCE_EXPECT_UNREACHABLE');
        expect(w).toBeTruthy();
        expect(w.blockId).toBe('gate');
        expect(w.message).toContain('可取值');
        expect(w.message).toContain('expect "01"');
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

// ─── ③ 静态值补零 / 进制假阴性 → 恒未命中（与 R30 hover 归因同源） ─────────────
describe('R31 W PRESENCE_HEX_PAD（静态值补零/进制假阴性）', () => {
    it('静态值 1 + expect "01" → warning，文案点明十六进制解析相等', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { value: 1 }), '01'));
        const w = r.warnings.find(x => x.code === 'PRESENCE_HEX_PAD');
        expect(w).toBeTruthy();
        expect(w.blockId).toBe('gate');
        expect(w.message).toContain('十六进制解析');
        expect(w.message).toContain('补零/进制差异');
        expect(w.message).toContain('恒按未命中处理');
        expect(w.message).toContain('0 字节');
        expect(r.errors).toEqual([]);          // 只提醒，不锁保存
    });

    it('带字母的补零形态（值 10 + expect "0A"）→ 同样报', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { value: 10 }), '0A'));
        expect(codes(r, 'warnings')).toContain('PRESENCE_HEX_PAD');
    });

    it('真·不同值（值 1 + expect "9"）→ 不报（宁可少判，不断言用户意图）', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { value: 1 }), '9'));
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_HEX_PAD');
    });

    it('本来判等（值 1 + expect "1"）→ 不报（没有「判不等」这回事）', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { value: 1 }), '1'));
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_HEX_PAD');
    });

    it('可自由键入（STRING / type string）→ 不报（键入相符值即命中，非恒）', () => {
        const r = validateInstruction(withGate(fld('ref', 1, { value: '01', type: 'string' }, 'STRING'), '1'));
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_HEX_PAD');
    });

    it('带选项表时归 ②（不叠报 HEX_PAD）', () => {
        const r = validateInstruction(withGate(
            fld('ref', 1, { options: { 开: '01', 关: '00' } }, 'MAPPING'), '01'));
        expect(codes(r, 'warnings')).toContain('PRESENCE_EXPECT_UNREACHABLE');
        expect(codes(r, 'warnings')).not.toContain('PRESENCE_HEX_PAD');
    });
});

// ─── 零行为变更总闸：三码全在 warnings，绝不产生 error ────────────────────────
describe('R31 三码零行为变更（不阻断保存）', () => {
    it('三种形态同时存在 → 三条 warning、errors 仍为空', () => {
        const r = validateInstruction(instr([
            fld('gate', 0, { value: 1, presence: { ref_id: 'a', expect: '01' } }),
            fld('a', 1, { value: 1 }),                       // ③
            fld('gate2', 2, { value: 1, presence: { ref_id: 'b', expect: '1' } }),
            fld('b', 3, { hex: 'FF' }, 'HEX_RAW'),           // ①
            fld('gate3', 4, { value: 1, presence: { ref_id: 'c', expect: '01' } }),
            fld('c', 5, { options: { 开: '01', 关: '00' } }, 'MAPPING'),  // ②
        ]));
        const w = codes(r, 'warnings');
        expect(w).toContain('PRESENCE_HEX_PAD');
        expect(w).toContain('PRESENCE_REF_NO_SOURCE');
        expect(w).toContain('PRESENCE_EXPECT_UNREACHABLE');
        expect(r.errors).toEqual([]);
    });

    it('存量无 presence 字段 → 三码全无（存量零回归）', () => {
        const r = validateInstruction(instr([fld('a', 0, { value: 1 }), fld('b', 1, { value: 2 })]));
        expect(codes(r, 'warnings')).toEqual([]);
        expect(codes(r, 'errors')).toEqual([]);
    });
});
