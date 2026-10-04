import { describe, it, expect } from 'vitest';
import { resolvePresenceStates } from '../runnerRenderRules';
import { InstructionEncoder } from '../../utils/InstructionEncoder';

// R29 (§8.61): 条件存在 (PRESENCE) —— 加工页展示层状态表。
//
// 两组锁：① helper 自身口径（未配置不进表 / String 归一 / fail-open 四支
// 归因）；② **角标结论 == 真实字节**恒等式 —— 判定只委托
// InstructionEncoder._presenceHit，故 IF/SKIP 说 SKIP 时 byteMap 里就真的
// 没有那段（否则显示层会骗人，这正是本批要修的病）。

const leaf = (id, over = {}) => ({
    id, name: id, op_code: 'INPUT', byte_len: 1, parameter_config: {}, ...over
});

// 一条 INPUT ref + 一条 HEX_RAW 被门叶（两支都在指令里，值驱动选支）
const gatedInstr = (presence) => ({
    id: 'inst-presence',
    fields: [
        leaf('cmd', { op_code: 'INPUT', byte_len: 1, parameter_config: { type: 'number' } }),
        leaf('gated', {
            name: '原始Hex', op_code: 'HEX_RAW', byte_len: 1,
            parameter_config: { hex: 'FF', presence }
        }),
    ],
});

describe('resolvePresenceStates · 进表口径', () => {
    it('未配置 presence → 空表（渲染层不点角标，与 R29 之前逐像素一致）', () => {
        expect(resolvePresenceStates([leaf('a')], {}, {})).toEqual({});
    });

    it('presence 非对象（数组 / 字符串）→ 不进表', () => {
        expect(resolvePresenceStates([leaf('a', { parameter_config: { presence: [] } })], {}, {})).toEqual({});
        expect(resolvePresenceStates([leaf('a', { parameter_config: { presence: 'x' } })], {}, {})).toEqual({});
    });

    it('未配置 / 已配置混合 → 只有配了的进表', () => {
        const st = resolvePresenceStates([
            leaf('a'),
            leaf('b', { parameter_config: { presence: { ref_id: 'a', expect: '1' } } }),
        ], {}, {});
        expect(Object.keys(st)).toEqual(['b']);
    });

    it('组字段同样进表（组级与字段级同权）', () => {
        const st = resolvePresenceStates([
            leaf('a', { parameter_config: { value: '1' } }),
            {
                id: 'grp', name: '分支A', op_code: 'NONE',
                parameter_config: { presence: { ref_id: 'a', expect: '1' } },
                fields: [leaf('inner', { op_code: 'HEX_RAW', parameter_config: { hex: 'AA' } })]
            },
        ], {}, {});
        expect(st.grp).toBeTruthy();
        expect(st.grp.hit).toBe(true);
    });
});

describe('resolvePresenceStates · 判定口径（委托 _presenceHit）', () => {
    it('静态链命中 / 未命中，title 写判定式与结论', () => {
        const ins = gatedInstr({ ref_id: 'cmd', expect: '9' });
        const hit = resolvePresenceStates(ins.fields, { cmd: 9 }, {});
        expect(hit.gated.hit).toBe(true);
        expect(hit.gated.title).toContain('条件字段：[cmd] == 9');
        expect(hit.gated.title).toContain('命中 → 发射本字段');

        const miss = resolvePresenceStates(ins.fields, { cmd: 1 }, {});
        expect(miss.gated.hit).toBe(false);
        expect(miss.gated.title).toContain('条件字段：[cmd] == 9');
        expect(miss.gated.title).toContain('未命中 → 0 字节（本帧不发）');
    });

    it('String 归一：数值 1 命中 "1"（与编码端 byte-equal 同口径）', () => {
        const ins = gatedInstr({ ref_id: 'cmd', expect: '1' });
        expect(resolvePresenceStates(ins.fields, { cmd: 1 }, {}).gated.hit).toBe(true);
        expect(resolvePresenceStates(ins.fields, { cmd: '1' }, {}).gated.hit).toBe(true);
        expect(resolvePresenceStates(ins.fields, { cmd: '01' }, {}).gated.hit).toBe(false);
    });

    it('computedValues 优先于 inputs（与 _refValue 取值链同序）', () => {
        const ins = gatedInstr({ ref_id: 'cmd', expect: '7' });
        expect(resolvePresenceStates(ins.fields, { cmd: 1 }, { cmd: 7 }).gated.hit).toBe(true);
        expect(resolvePresenceStates(ins.fields, { cmd: 7 }, { cmd: 1 }).gated.hit).toBe(false);
    });

    it('fail-open 四支恒命中，且 title 各写其归因（不吞字节的可见化）', () => {
        // ① 缺 ref_id
        const noRef = resolvePresenceStates(
            [leaf('a', { parameter_config: { presence: { expect: '1' } } })], {}, {});
        expect(noRef.a.hit).toBe(true);
        expect(noRef.a.title).toContain('缺 ref_id → fail-open 按命中');
        expect(noRef.a.title).toContain('[?] == 1');

        // ② 缺 expect
        const noExpect = resolvePresenceStates(
            [leaf('a', { parameter_config: { presence: { ref_id: 'b' } } })],
            {}, {});
        expect(noExpect.a.hit).toBe(true);
        expect(noExpect.a.title).toContain('缺 expect → fail-open 按命中');

        // ③ ref 悬空
        const dangling = resolvePresenceStates(
            [leaf('a', { parameter_config: { presence: { ref_id: 'nope', expect: '1' } } })], {}, {});
        expect(dangling.a.hit).toBe(true);
        expect(dangling.a.title).toContain('ref 悬空 → fail-open 按命中');

        // ④ ref 无值链（ref 在场但既无 inputs/computed 也无 pc.value）
        const noChain = resolvePresenceStates([
            leaf('b'),
            leaf('a', { parameter_config: { presence: { ref_id: 'b', expect: '1' } } }),
        ], {}, {});
        expect(noChain.a.hit).toBe(true);
        expect(noChain.a.title).toContain('ref 无值链 → fail-open 按命中');
    });

    it('inputs 一给上，无值链 fail-open 立刻翻成真比对（运行期可翻转）', () => {
        const ins = gatedInstr({ ref_id: 'cmd', expect: '1' });
        expect(resolvePresenceStates(ins.fields, {}, {}).gated.hit).toBe(true);   // fail-open
        expect(resolvePresenceStates(ins.fields, { cmd: 1 }, {}).gated.hit).toBe(true);
        expect(resolvePresenceStates(ins.fields, { cmd: 2 }, {}).gated.hit).toBe(false);
    });
});

describe('resolvePresenceStates · 角标结论 == 真实字节（恒等式）', () => {
    const encode = (ins, inputs) => {
        const computed = InstructionEncoder.resolveDependencies(ins, inputs);
        return InstructionEncoder.encodeInstruction(ins, inputs, computed);
    };

    it('叶字段：byteMap 是否含该字段，恒等于 states.hit', () => {
        const ins = gatedInstr({ ref_id: 'cmd', expect: '1' });
        [{}, { cmd: 1 }, { cmd: '1' }, { cmd: 2 }].forEach((inputs) => {
            const st = resolvePresenceStates(ins.fields, inputs, InstructionEncoder.resolveDependencies(ins, inputs));
            const { byteMap } = encode(ins, inputs);
            expect(byteMap.some(e => e.fieldId === 'gated')).toBe(st.gated.hit);
        });
    });

    it('叶字段：未命中 → 出线字节数真的少那一段', () => {
        const ins = gatedInstr({ ref_id: 'cmd', expect: '1' });
        const strip = (hex) => hex.replace(/\s/g, '');
        const missHex = strip(encode(ins, { cmd: 2 }).hexString);
        const hitHex = strip(encode(ins, { cmd: 1 }).hexString);
        expect(missHex.length).toBe(2);            // 只有 ref 自己 1 字节
        expect(hitHex.length).toBe(4);             // + gated 1 字节
        expect(resolvePresenceStates(ins.fields, { cmd: 2 }, {}).gated.hit).toBe(false);
        expect(resolvePresenceStates(ins.fields, { cmd: 1 }, {}).gated.hit).toBe(true);
    });

    it('组字段：整棵子树命中/未命中与出线字节同步', () => {
        const ins = {
            id: 'inst-grp',
            fields: [
                leaf('cmd', { op_code: 'INPUT', byte_len: 1, parameter_config: { type: 'number' } }),
                {
                    id: 'grp', name: '分支A', op_code: 'NONE',
                    parameter_config: { presence: { ref_id: 'cmd', expect: '1' } },
                    fields: [leaf('inner', { op_code: 'HEX_RAW', byte_len: 1, parameter_config: { hex: 'AA' } })]
                },
            ],
        };
        const strip = (hex) => hex.replace(/\s/g, '');
        const hitSt = resolvePresenceStates(ins.fields, { cmd: 1 }, {});
        const missSt = resolvePresenceStates(ins.fields, { cmd: 2 }, {});
        expect(hitSt.grp.hit).toBe(true);
        expect(missSt.grp.hit).toBe(false);
        expect(strip(encode(ins, { cmd: 1 }).hexString).length).toBe(4); // cmd + AA
        expect(strip(encode(ins, { cmd: 2 }).hexString).length).toBe(2); // 只剩 cmd
    });
});
