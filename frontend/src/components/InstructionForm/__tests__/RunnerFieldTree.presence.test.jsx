import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import RunnerFieldTree from '../RunnerFieldTree';

// R29 (§8.61): 加工页字段树的「条件存在 (PRESENCE)」展示层（红测先行）。
// 锁三件事：① 不传 presenceStates → 零渲染（Sequences 步骤编辑器零改动）；
// ② 命中/未命中两种形态（IF 角标 + [SKIP 0B] + 行降透明）；③ 组级同权、
// SKIP 结论优先于 READ_ONLY（「这行根本不出线」比「这行能不能改」更要紧）。

const baseProps = {
    inputs: {},
    computedValues: {},
    onFieldChange: () => {},
    onOpenDatePicker: () => {},
};

const cmd = {
    id: 'cmd', name: '命令字', op_code: 'INPUT', byte_len: 1,
    parameter_config: { type: 'number' }
};
const gated = {
    id: 'gated', name: '原始Hex', op_code: 'HEX_RAW', byte_len: 1,
    parameter_config: { hex: 'FF' }
};
const branchGroup = {
    id: 'grp', name: '分支A', op_code: 'NONE',
    parameter_config: {},
    fields: [{ id: 'inner', name: '内层', op_code: 'HEX_RAW', byte_len: 1, parameter_config: { hex: 'AA' } }]
};

const HIT = { hit: true, title: '条件字段：[cmd] == 1 · 命中 → 发射本字段' };
const MISS = { hit: false, title: '条件字段：[cmd] == 1 · 未命中 → 0 字节（本帧不发）' };

const chips = (root) => root.querySelectorAll('[data-runner-presence-chip]');
const skips = (root) => root.querySelectorAll('[data-runner-presence-skip]');

describe('RunnerFieldTree · 未传 presenceStates（Sequences 兼容）', () => {
    it('叶 + 组都不渲染 IF / SKIP 任何章', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, { ...gated }, branchGroup]} {...baseProps} />
        );
        expect(chips(container).length).toBe(0);
        expect(skips(container).length).toBe(0);
        expect(container.querySelector('.opacity-50')).toBeNull();
    });

    it('presenceStates 里没有本字段 → 同样不渲染（未配置 ≠ 命中）', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[cmd, gated]}
                {...baseProps}
                presenceStates={{ unrelated: HIT }}
            />
        );
        expect(chips(container).length).toBe(0);
        expect(skips(container).length).toBe(0);
    });
});

describe('RunnerFieldTree · 叶字段命中态', () => {
    it('渲染 IF 角标（hit）+ title 判定式，且不出现 SKIP、不降透明', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[cmd, gated]}
                {...baseProps}
                presenceStates={{ gated: HIT }}
            />
        );
        const chip = container.querySelector('[data-runner-presence-chip]');
        expect(chip).toBeTruthy();
        expect(chip.getAttribute('data-runner-presence-chip')).toBe('hit');
        expect(chip.textContent).toBe('IF');
        expect(chip.getAttribute('title')).toContain('条件字段：[cmd] == 1');
        expect(chip.getAttribute('title')).toContain('命中 → 发射本字段');
        // R56（PLAN §8.88）：命中角标 = 深琥珀语义类 text-hl（原 text-[#E58D28] 沙底 1.73:1）
        expect(chip.className).toContain('text-hl');

        expect(skips(container).length).toBe(0);
        expect(container.querySelector('.opacity-50')).toBeNull();
    });
});

describe('RunnerFieldTree · 叶字段未命中态（0 字节）', () => {
    it('IF 角标标 miss + 右侧 [SKIP 0B] + 行降透明', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[cmd, gated]}
                {...baseProps}
                presenceStates={{ gated: MISS }}
            />
        );
        const chip = container.querySelector('[data-runner-presence-chip]');
        expect(chip.getAttribute('data-runner-presence-chip')).toBe('miss');
        expect(chip.getAttribute('title')).toContain('未命中 → 0 字节（本帧不发）');

        const skip = container.querySelector('[data-runner-presence-skip]');
        expect(skip).toBeTruthy();
        expect(skip.textContent).toBe('[SKIP 0B]');
        expect(skip.getAttribute('title')).toContain('未命中 → 0 字节');
        // R56（PLAN §8.88）：[SKIP 0B] 是**徽标**不是故障（既非 ERR/失效/脏）→ 深琥珀
        // text-hl（原 text-[#E58D28] 沙底 1.73:1）；组级 miss 角标 R55 已 text-muted
        expect(skip.className).toContain('text-hl');
        expect(chip.className).toContain('text-muted');

        const row = container.querySelector('.opacity-50');
        expect(row).toBeTruthy();
        expect(row.textContent).toContain('[SKIP 0B]'); // 降透明的正是那条被门掉的行
    });

    it('SKIP 结论优先于 READ_ONLY（只读章被顶掉，不出两个徽标打架）', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[gated]}
                {...baseProps}
                presenceStates={{ gated: MISS }}
            />
        );
        expect(container.textContent).toContain('[SKIP 0B]');
        expect(container.textContent).not.toContain('[READ_ONLY]');
    });

    it('ref 自己（命中支）不受影响：只有配了 presence 的字段出章', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[cmd, gated]}
                {...baseProps}
                presenceStates={{ gated: MISS }}
            />
        );
        expect(chips(container).length).toBe(1);
        expect(skips(container).length).toBe(1);
    });
});

describe('RunnerFieldTree · 组级 presence（同权）', () => {
    it('组命中：组头出 IF(hit)，子树不降透明', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[branchGroup]}
                {...baseProps}
                presenceStates={{ grp: HIT }}
            />
        );
        const chip = container.querySelector('[data-runner-presence-chip]');
        expect(chip).toBeTruthy();
        expect(chip.getAttribute('data-runner-presence-chip')).toBe('hit');
        expect(skips(container).length).toBe(0);
        expect(container.querySelector('.opacity-50')).toBeNull();
    });

    it('组未命中：组头出 IF(miss) + [SKIP 0B]，整棵子树降透明', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[branchGroup]}
                {...baseProps}
                presenceStates={{ grp: MISS }}
            />
        );
        expect(container.querySelector('[data-runner-presence-chip]')
            .getAttribute('data-runner-presence-chip')).toBe('miss');
        expect(container.querySelector('[data-runner-presence-skip]').textContent).toBe('[SKIP 0B]');
        expect(container.querySelector('.opacity-50')).toBeTruthy();
    });

    it('组命中但子字段未命中 → 子字段自己的 SKIP 仍出（父命中不豁免子）', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[branchGroup]}
                {...baseProps}
                presenceStates={{ grp: HIT, inner: MISS }}
            />
        );
        expect(chips(container).length).toBe(2);   // 组头 + 子字段
        expect(skips(container).length).toBe(1);   // 只有子字段 SKIP
    });
});

// ─── R30 (§8.62): 未接线消费方**自动自算** ──────────────────────────────────
// R29 把 presenceStates 定为「缺省 null = 零渲染」，是**为把范围钉在加工页**
// 而做的范围限定 —— 代价是同一组件的另一个消费方（Sequences 步骤编辑器）出现
// 「配了条件却一个章都不出」的自相矛盾。R30 收口：未显式传表时**用组件自己
// 手上的 fields / inputs / computedValues 自算**（与显式传表**同一个 helper**，
// 不是第二套判据），两条消费路径从此同源，新增页面默认就有。
describe('RunnerFieldTree · R30 未传 presenceStates 时自动自算', () => {
    const gatedWithPresence = {
        id: 'gated', name: '原始Hex', op_code: 'HEX_RAW', byte_len: 1,
        parameter_config: { hex: 'FF', presence: { ref_id: 'cmd', expect: '1' } }
    };

    it('不传表 + 字段配了 presence → 自算出 IF(miss) + [SKIP 0B]', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, gatedWithPresence]} {...baseProps} inputs={{ cmd: 2 }} />
        );
        const chip = container.querySelector('[data-runner-presence-chip]');
        expect(chip).toBeTruthy();
        expect(chip.getAttribute('data-runner-presence-chip')).toBe('miss');
        expect(chip.getAttribute('title')).toContain('条件字段：[cmd] == 1');
        expect(container.querySelector('[data-runner-presence-skip]').textContent).toBe('[SKIP 0B]');
        expect(container.querySelector('.opacity-50')).toBeTruthy();
    });

    it('不传表 + inputs 让条件成立 → 自算出 IF(hit)、无 SKIP、不降透明', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, gatedWithPresence]} {...baseProps} inputs={{ cmd: 1 }} />
        );
        expect(container.querySelector('[data-runner-presence-chip]')
            .getAttribute('data-runner-presence-chip')).toBe('hit');
        expect(container.querySelector('[data-runner-presence-skip]')).toBeNull();
        expect(container.querySelector('.opacity-50')).toBeNull();
    });

    it('不传表 + 组配 presence → 组头同样自算出章', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[cmd, {
                    id: 'grp', name: '分支A', op_code: 'NONE',
                    parameter_config: { presence: { ref_id: 'cmd', expect: '1' } },
                    fields: [gatedWithPresence]
                }]}
                {...baseProps}
                inputs={{ cmd: 2 }}
            />
        );
        expect(chips(container).length).toBe(2);   // 组头 + 叶
        expect(container.querySelector('.opacity-50')).toBeTruthy();
    });

    it('显式传表优先于自算（不被重算覆盖）', () => {
        // 该字段配了 presence、inputs 使其**自算必然 miss**，但显式表说 hit →
        // 出现 hit 形态即证明「显式表胜出」（若被自算覆盖就会出 [SKIP 0B]）。
        const { container } = render(
            <RunnerFieldTree
                fields={[cmd, gatedWithPresence]}
                {...baseProps}
                inputs={{ cmd: 2 }}
                presenceStates={{ gated: { hit: true, title: '手工表' } }}
            />
        );
        expect(container.querySelector('[data-runner-presence-chip]')
            .getAttribute('data-runner-presence-chip')).toBe('hit');
        expect(container.querySelector('[data-runner-presence-skip]')).toBeNull();
        expect(container.querySelector('.opacity-50')).toBeNull();
    });

    it('显式传 null → 仍可完全关闭（保留 R29 的显式逃生口）', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, gatedWithPresence]} {...baseProps}
                inputs={{ cmd: 2 }} presenceStates={null} />
        );
        expect(chips(container).length).toBe(0);
        expect(skips(container).length).toBe(0);
    });
});

// ─── R33 (§8.65): 加工页「未命中 → 纯隐藏」 ─────────────────────────────────
// 用户拍板两条：① **纯隐藏**（完全不渲染，不留占位、不留展开入口）；
// ② **仅指令加工业页面** —— 步骤编辑器（Sequences）维持现状（降透明 + [SKIP 0B]）。
// 故开关是 opt-in prop `hidePresenceMissed`，**缺省 false = 现状逐像素不变**，
// 加工页由 InstructionRunner 显式接线，Sequences 不接即零改动。
// 纯展示层：未命中的字段本就不发射字节（byteOffsets 已按 0 算），隐藏只动 DOM，
// 偏移尺 / LEN / BYTE_STREAM 一行不改。
describe('RunnerFieldTree · R33 hidePresenceMissed（加工页纯隐藏）', () => {
    const gatedWithPresence = {
        id: 'gated', name: '原始Hex', op_code: 'HEX_RAW', byte_len: 1,
        parameter_config: { hex: 'FF', presence: { ref_id: 'cmd', expect: '1' } }
    };
    const nestedGroup = {
        id: 'grp', name: '分支A', op_code: 'NONE',
        parameter_config: { presence: { ref_id: 'cmd', expect: '1' } },
        fields: [{
            id: 'inner', name: '内层', op_code: 'HEX_RAW', byte_len: 1,
            parameter_config: { hex: 'AA', presence: { ref_id: 'cmd', expect: '1' } }
        }]
    };

    it('缺省不传 → 行为不变（未命中仍降透明 + [SKIP 0B]，Sequences 现状）', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, gatedWithPresence]} {...baseProps}
                inputs={{ cmd: 2 }} />
        );
        expect(container.querySelector('[data-runner-presence-skip]')).toBeTruthy();
        expect(container.querySelector('.opacity-50')).toBeTruthy();
        expect(container.textContent).toContain('原始Hex');
    });

    it('hidePresenceMissed + 叶未命中 → 整行完全不渲染（无章、无降透明、无 label）', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, gatedWithPresence]} {...baseProps}
                inputs={{ cmd: 2 }} hidePresenceMissed />
        );
        expect(chips(container).length).toBe(0);
        expect(skips(container).length).toBe(0);
        expect(container.querySelector('.opacity-50')).toBeNull();
        expect(container.textContent).not.toContain('原始Hex');
        expect(container.textContent).toContain('命令字');   // 未配 presence 的 ref 照常在
    });

    it('hidePresenceMissed + 叶命中 → 照常渲染（开关只收未命中侧）', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, gatedWithPresence]} {...baseProps}
                inputs={{ cmd: 1 }} hidePresenceMissed />
        );
        expect(container.textContent).toContain('原始Hex');
        expect(container.querySelector('[data-runner-presence-chip]')
            .getAttribute('data-runner-presence-chip')).toBe('hit');
        expect(container.querySelector('.opacity-50')).toBeNull();
    });

    it('hidePresenceMissed + 组未命中 → 组头与整棵子树一起消失', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, nestedGroup]} {...baseProps}
                inputs={{ cmd: 2 }} hidePresenceMissed />
        );
        expect(container.textContent).not.toContain('分支A');
        expect(container.textContent).not.toContain('内层');
        expect(chips(container).length).toBe(0);
    });

    it('hidePresenceMissed + 组命中但内层未命中 → 组头在、内层不在（父命中不豁免子）', () => {
        const { container } = render(
            <RunnerFieldTree
                fields={[{
                    id: 'grp', name: '分支A', op_code: 'NONE', parameter_config: {},
                    fields: [gatedWithPresence]
                }]}
                {...baseProps}
                presenceStates={{ grp: HIT, gated: MISS }}
                hidePresenceMissed
            />
        );
        expect(container.textContent).toContain('分支A');
        expect(container.textContent).not.toContain('原始Hex');
        expect(skips(container).length).toBe(0);
    });

    it('hidePresenceMissed + 未配置 presence 的字段不受影响（不是全表隐藏）', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, gatedWithPresence]} {...baseProps}
                inputs={{ cmd: 2 }} hidePresenceMissed />
        );
        expect(container.textContent).toContain('命令字');
        expect(container.querySelector('input')).toBeTruthy();
    });

    it('hidePresenceMissed + 不传表（自算路径）→ 同一个 helper 判定、同样隐藏', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, gatedWithPresence]} {...baseProps}
                inputs={{ cmd: 2 }} hidePresenceMissed />
        );
        // 自算 = resolvePresenceStates（与显式表同一 helper），故结论与显式表一致
        expect(container.textContent).not.toContain('原始Hex');
    });

    it('hidePresenceMissed + presenceStates=null（判定显式关闭）→ 无判定即不隐藏', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, gatedWithPresence]} {...baseProps}
                inputs={{ cmd: 2 }} presenceStates={null} hidePresenceMissed />
        );
        expect(container.textContent).toContain('原始Hex');
    });

    it('递归传递：深层组里的未命中字段同样隐藏', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, nestedGroup]} {...baseProps}
                inputs={{ cmd: 2 }} hidePresenceMissed />
        );
        expect(container.textContent).not.toContain('内层');
    });

    it('全部字段都被隐藏 → 出兜底事实行（防「页面像坏了」；无占位、无展开入口）', () => {
        const { container } = render(
            <RunnerFieldTree fields={[gatedWithPresence]} {...baseProps}
                inputs={{ cmd: 2 }} hidePresenceMissed />
        );
        expect(container.textContent).not.toContain('原始Hex');
        const empty = container.querySelector('[data-runner-tree-empty]');
        expect(empty).toBeTruthy();
        expect(empty.textContent).toContain('无可填字段');
        expect(empty.querySelector('button')).toBeNull();   // 纯隐藏：不留展开入口
    });

    it('有可见字段时不出兜底行', () => {
        const { container } = render(
            <RunnerFieldTree fields={[cmd, gatedWithPresence]} {...baseProps}
                inputs={{ cmd: 2 }} hidePresenceMissed />
        );
        expect(container.querySelector('[data-runner-tree-empty]')).toBeNull();
    });
});
