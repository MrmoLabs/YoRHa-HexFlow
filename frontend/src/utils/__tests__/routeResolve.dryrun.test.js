// R40（PLAN §8.72）：规则页「试解析」回执 → 中文事实文案。
//
// 与 R39 的 `describeResolve` 是**同一份回执、不同的动作语境**：
//  · 加工页（R39）真会切指令 → 文案写「已切到指令…」；
//  · 规则页试解析**只回显，不改本页任何状态** → 文案必须断在「命中 / 无命中」，
//    把「已切到」搬过来就是谎称这页也切了。
//
// 四行结果表（命中规则 / 目标指令 / 参与扫描 / 缺陷跳过）是回执的原样转写：
// `considered` 与 `invalid` 由后端给，FE 不自己数、不自己扫第二遍
// （不造第二套判据 —— 本页连条件求值都不做）。
import { describe, it, expect } from 'vitest';
import { describeDryRun } from '../routeResolve';

describe('routeResolve · describeDryRun（试解析回执 → 结果表）', () => {
    it('命中：headline 写清是哪条规则、哪条指令，并写明只解析不发送', () => {
        const out = describeDryRun({
            matched: true,
            rule: { id: 'r-1', name: 'meter 0001' },
            instruction_id: 'i-1',
            instruction: { id: 'i-1', name: '执行 X' },
            invalid: [],
            considered: 2,
        });
        expect(out).toEqual({
            matched: true,
            headline: '命中 —— 规则「meter 0001」→ 指令「执行 X」（只解析，不发送）。',
            rows: [
                { label: '命中规则', value: 'meter 0001' },
                { label: '目标指令', value: '执行 X' },
                { label: '参与扫描', value: '2 条' },
                { label: '缺陷跳过', value: '0 条' },
            ],
        });
    });

    it('命中但回执没带指令全文 → 回退 code 再回退 id，都没有就明说没带回（不谎称）', () => {
        const byCode = describeDryRun({
            matched: true,
            rule: { name: 'r' },
            instruction_id: 'i-1',
            instruction: { id: 'i-1', code: 'CMD_X' },
            invalid: [],
            considered: 1,
        });
        expect(byCode.rows[1]).toEqual({ label: '目标指令', value: 'CMD_X' });

        const noInst = describeDryRun({
            matched: true,
            rule: { name: 'meter 0001' },
            instruction_id: null,
            instruction: null,
            invalid: [],
            considered: 1,
        });
        expect(noInst.matched).toBe(true);
        expect(noInst.headline).toBe('命中 —— 规则「meter 0001」，但回执未带回目标指令。');
        expect(noInst.rows[1]).toEqual({ label: '目标指令', value: '（回执未带回目标指令）' });
    });

    it('无命中（扫过规则）：写清扫了几条，两行结果写「（无命中）」', () => {
        const out = describeDryRun({
            matched: false,
            rule: null,
            instruction_id: null,
            instruction: null,
            invalid: [],
            considered: 3,
        });
        expect(out).toEqual({
            matched: false,
            headline: '无命中 —— 扫过 3 条规则都不成立。',
            rows: [
                { label: '命中规则', value: '（无命中）' },
                { label: '目标指令', value: '（无命中）' },
                { label: '参与扫描', value: '3 条' },
                { label: '缺陷跳过', value: '0 条' },
            ],
        });
    });

    it('无命中（一条都没参与）：归因写「无规则或全部停用」，不写「都判完了」', () => {
        const out = describeDryRun({
            matched: false, rule: null, instruction_id: null, instruction: null,
            invalid: [], considered: 0,
        });
        expect(out.headline).toBe('无命中 —— 没有任何规则参与（无规则或全部停用）。');
        expect(out.rows[2]).toEqual({ label: '参与扫描', value: '0 条 —— 无规则或全部停用' });
    });

    it('结构性缺陷照回执抄：有几条写几条，逐条带规则名与后端给的原因', () => {
        const out = describeDryRun({
            matched: false, rule: null, instruction_id: null, instruction: null,
            invalid: [
                { id: 'r-9', name: '坏规则', condition: 'meter_id', reason: '缺少比较运算符' },
                { id: 'r-8', name: '悬空规则', condition: 'x == 1', reason: '目标指令不在册' },
            ],
            considered: 4,
        });
        expect(out.rows[3]).toEqual({
            label: '缺陷跳过',
            value: '2 条 —— 规则「坏规则」：缺少比较运算符；规则「悬空规则」：目标指令不在册',
        });
        // 缺陷不进 headline（headline 只说命中与否），避免一句里塞两件事
        expect(out.headline).toBe('无命中 —— 扫过 4 条规则都不成立。');
    });

    it('空 / 缺省回执不抛：按「一条规则都没参与」出结果（后端不给 considered 也照渲染）', () => {
        expect(() => describeDryRun(undefined)).not.toThrow();
        const out = describeDryRun({});
        expect(out.matched).toBe(false);
        expect(out.rows).toHaveLength(4);
        expect(out.rows[3]).toEqual({ label: '缺陷跳过', value: '0 条' });
    });

    it('规则名 / 指令名缺失都给占位文案，不渲染成空引号', () => {
        const out = describeDryRun({
            matched: true, rule: null, instruction_id: 'i-1', instruction: null,
            invalid: [], considered: 1,
        });
        expect(out.rows[0]).toEqual({ label: '命中规则', value: '（规则未回带名称）' });
        expect(out.headline).toContain('（规则未回带名称）');
    });
});
