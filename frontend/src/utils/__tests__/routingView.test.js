// R38（PLAN §8.70）：发前路由规则页的纯逻辑 —— 表单就地校验、排序草稿与
// 「只回写真变化的行」、后端 detail → 中文事实文案。
//
// 抽成纯函数即为钉口径：改任一文案 / 改任一排序算法必改本文件。
import { describe, expect, it } from 'vitest';
import {
    MAX_RULE_NAME,
    changedSortOrder,
    defaultSortOrder,
    describeRoutingSaveError,
    emptyRuleDraft,
    moveRule,
    renumber,
    validateRuleDraft,
} from '../routingView';

const row = (id, sort_order, name) => ({ id, sort_order, name });

describe('routingView · 空草稿与缺省排序', () => {
    it('emptyRuleDraft：字段名与后端 RoutingRuleCreate 逐字同名（少一层映射少一处错）', () => {
        expect(emptyRuleDraft()).toEqual({
            name: '',
            condition: '',
            instruction_id: '',
            sort_order: 0,
            enabled: 1,
            description: '',
        });
    });

    it('defaultSortOrder：新建落**末尾**（末位 sort_order + 1），空表 = 0', () => {
        expect(defaultSortOrder([])).toBe(0);
        // 从未重排过的存量可能全是 0 —— 仍要落到最后一位，不能跟别人撞 0 被排到前面
        expect(defaultSortOrder([row('a', 0), row('b', 0), row('c', 0)])).toBe(1);
        expect(defaultSortOrder([row('a', 0), row('b', 7), row('c', 2)])).toBe(8);
    });
});

describe('routingView · validateRuleDraft 就地校验（不送后端吃 400）', () => {
    const good = () => ({
        name: 'meter 0001',
        condition: 'meter_id == 0001',
        instruction_id: 'i-1',
        sort_order: 0,
        enabled: 1,
        description: '',
    });

    it('合法草稿 → ok=true、errors 空', () => {
        expect(validateRuleDraft(good())).toEqual({ ok: true, errors: {} });
    });

    it('名称空 → 报「名称不能为空」（trim 后判空，纯空格同样算空）', () => {
        expect(validateRuleDraft({ ...good(), name: '   ' }).errors.name).toContain('名称不能为空');
        expect(validateRuleDraft({ ...good(), name: '' }).ok).toBe(false);
    });

    it('名称超 MAX_RULE_NAME → 报长度上限（与后端 max_length 同一个数）', () => {
        const long = 'n'.repeat(MAX_RULE_NAME + 1);
        expect(validateRuleDraft({ ...good(), name: long }).errors.name).toContain(`${MAX_RULE_NAME}`);
        expect(validateRuleDraft({ ...good(), name: 'n'.repeat(MAX_RULE_NAME) }).ok).toBe(true);
    });

    it('名称撞已有规则 → 报占用（**含回收站里占名的行**：后端判重查全表，FE 一并拦）', () => {
        const res = validateRuleDraft(good(), { liveNames: ['meter 0001'] });
        expect(res.ok).toBe(false);
        expect(res.errors.name).toContain('已被');
        expect(res.errors.name).toContain('回收站');
    });

    it('目标指令未选 → 报必选（规则没有宿主等于什么都不做）', () => {
        const res = validateRuleDraft({ ...good(), instruction_id: '' });
        expect(res.ok).toBe(false);
        expect(res.errors.instruction_id).toContain('指令');
    });

    it('条件空 → 报必填', () => {
        const res = validateRuleDraft({ ...good(), condition: '  ' });
        expect(res.ok).toBe(false);
        expect(res.errors.condition).toContain('条件');
    });

    it('条件语法坏 → 报 checkCondition 的原文（与步骤编辑器同一套 SSOT，不另造文案）', () => {
        const res = validateRuleDraft({ ...good(), condition: 'meter_id' });
        expect(res.ok).toBe(false);
        expect(res.errors.condition).toBeTruthy();
        expect(res.errors.condition).toContain('比较');
    });

    it('多错并存 → 逐字段都报（不只报第一个）', () => {
        const res = validateRuleDraft({ name: '', condition: '', instruction_id: '' });
        expect(Object.keys(res.errors).sort()).toEqual(['condition', 'instruction_id', 'name']);
    });

    it('编辑中的行自身不算重名（excludeName 口径）', () => {
        const res = validateRuleDraft(good(), {
            liveNames: ['meter 0001', 'other'],
            excludeName: 'meter 0001',
        });
        expect(res.ok).toBe(true);
    });
});

describe('routingView · 排序草稿：只改展示序，保存才重编号', () => {
    it('moveRule 上移一位，首行上移 → 不动、moved=false', () => {
        const rows = [row('a', 0), row('b', 1), row('c', 2)];
        const up = moveRule(rows, 'b', -1);
        expect(up.moved).toBe(true);
        expect(up.rows.map((r) => r.id)).toEqual(['b', 'a', 'c']);
        expect(moveRule(rows, 'a', -1).moved).toBe(false);
    });

    it('moveRule 下移一位，末行下移 → 不动、moved=false', () => {
        const rows = [row('a', 0), row('b', 1)];
        const down = moveRule(rows, 'a', 1);
        expect(down.moved).toBe(true);
        expect(down.rows.map((r) => r.id)).toEqual(['b', 'a']);
        expect(moveRule(rows, 'b', 1).moved).toBe(false);
    });

    it('moveRule 找不到该行 → 原数组原样返回、moved=false（不猜）', () => {
        const rows = [row('a', 0)];
        const res = moveRule(rows, 'zzz', 1);
        expect(res.moved).toBe(false);
        expect(res.rows).toBe(rows);
    });

    it('renumber：按草稿顺序稠密重编 0..N-1（列表顺序 = 匹配顺序，不再靠 name 兜底）', () => {
        const rows = [row('b', 7), row('a', 2), row('c', 7)];
        expect(renumber(rows)).toEqual([
            { id: 'b', sort_order: 0 },
            { id: 'a', sort_order: 1 },
            { id: 'c', sort_order: 2 },
        ]);
        expect(renumber([])).toEqual([]);
    });

    it('changedSortOrder：只有 sort_order **真变化**的行才进 PUT 队列', () => {
        const before = [row('a', 0), row('b', 1), row('c', 2)];
        // b 与 c 换位 → a 不动，只回写 b / c
        const proposal = [{ id: 'a', sort_order: 0 }, { id: 'c', sort_order: 1 }, { id: 'b', sort_order: 2 }];
        expect(changedSortOrder(before, proposal)).toEqual([
            { id: 'b', sort_order: 2 },
            { id: 'c', sort_order: 1 },
        ]);
        // 没动过 → 一个都不发
        expect(changedSortOrder(before, renumber(before))).toEqual([]);
    });
});

describe('routingView · describeRoutingSaveError 后端 detail → 中文事实文案', () => {
    it('400 判重 → 说明名称已存在且指出去回收站释放', () => {
        const msg = describeRoutingSaveError({ message: 'Routing rule name already exists' });
        expect(msg).toContain('已存在');
        expect(msg).toContain('回收站');
    });

    it('404 指令不在 → 说明目标指令不在册', () => {
        const msg = describeRoutingSaveError({ message: 'Instruction not found' });
        expect(msg).toContain('指令');
        expect(msg).toContain('不在');
    });

    it('400 坏条件 → 原样带上后端语法诊断（不改写、不吞）', () => {
        const msg = describeRoutingSaveError({
            message: 'Invalid routing condition: 缺少比较运算符（支持 == != >= <= > < in）',
        });
        expect(msg).toContain('缺少比较运算符');
    });

    it('未归类的错误原文照抄（宁可长、不静默）', () => {
        expect(describeRoutingSaveError({ message: 'boom 500' })).toContain('boom 500');
    });

    it('没有 message / 不是对象 → 回落一句固定事实文案', () => {
        expect(describeRoutingSaveError(null)).toContain('保存失败');
        expect(describeRoutingSaveError({})).toContain('保存失败');
    });
});
