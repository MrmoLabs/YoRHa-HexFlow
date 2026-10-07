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
// R43（§8.75）起返回值多一项 `trace`（逐条判定轨迹，见文件尾 describe 那组）——
// 下面两条 `toEqual` 的完整形状断言随之补 `trace: []`（**随新事实改写**，非放水：
// 原有 matched / headline / rows 逐字未动）。
import { describe, it, expect } from 'vitest';
import { describeDryRun, describeTrace } from '../routeResolve';

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
            trace: [],
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
            trace: [],
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

// ── R43（PLAN §8.75）逐条判定轨迹 ─────────────────────────────────────────
// 回执 `trace` 由后端给：**一行 = 一条规则 + 它为什么没成立**。FE 只做两件事 ——
// 把机器码翻成中文事实、按回执原样排成表；**不自己扫第二遍条件**
// （不造第二套判据 —— 比较 / 变量 / 类型的判定全在 `core/condition.py`）。
describe('routeResolve · describeDryRun（R43 逐条判定轨迹）', () => {
    const TRACE = [
        { id: 'r-1', name: 'meter 0001', condition: 'meter_id == 1', code: 'COND_FALSE', detail: '' },
        { id: 'r-2', name: '看别的键', condition: 'line == 1', code: 'VAR_UNDEFINED', detail: 'line' },
        { id: 'r-3', name: '类型不比', condition: 'meter_id == "1"', code: 'TYPE_INCOMPARABLE', detail: '数字 与 字符串' },
        { id: 'r-4', name: '停用', condition: 'meter_id == 1', code: 'DISABLED', detail: '' },
        { id: 'r-5', name: '坏条件', condition: 'meter_id', code: 'CONDITION_INVALID', detail: '缺少比较运算符' },
        { id: 'r-6', name: '悬空', condition: 'meter_id == 1', code: 'INSTRUCTION_MISSING', detail: '' },
        { id: 'r-7', name: '没轮到', condition: 'meter_id == 1', code: 'NOT_EVALUATED', detail: '' },
        { id: 'r-8', name: '命中', condition: 'meter_id == 1', code: 'MATCHED', detail: '' },
    ];

    it('轨迹码各出自己的中文事实，detail 只在有值时接在后面', () => {
        const out = describeDryRun({
            matched: false, rule: null, instruction_id: null, instruction: null,
            invalid: [], considered: 6, trace: TRACE,
        });
        expect(out.trace.map((row) => row.text)).toEqual([
            '比较不成立',
            '变量不在本次输入里：line',
            '类型不可比：数字 与 字符串',
            '已停用（不参与匹配）',
            '条件语法不成立：缺少比较运算符',
            '目标指令不在册',
            '未轮到 —— 前面已有命中，按 first-match-wins 不再看',
            '判真命中',
        ]);
        // 序号 = 回执行序（= 匹配顺序），规则名与条件原样带出
        expect(out.trace[1]).toEqual({
            index: 2, name: '看别的键', condition: 'line == 1',
            code: 'VAR_UNDEFINED', text: '变量不在本次输入里：line',
        });
    });

    it('回执没给 code 或给的是不认识的码 → 不渲染空行、也不谎称知道原因', () => {
        const bare = describeDryRun({
            matched: false, rule: null, instruction_id: null, instruction: null,
            invalid: [], considered: 1, trace: [{ id: 'r', name: '', condition: '', code: '', detail: '' }],
        });
        expect(bare.trace[0].name).toBe('（未命名）');
        expect(bare.trace[0].text).toBe('（回执未给原因）');

        const alien = describeDryRun({
            matched: false, rule: null, instruction_id: null, instruction: null,
            invalid: [], considered: 1, trace: [{ id: 'r', name: 'x', condition: 'a == 1', code: 'WHATEVER', detail: '' }],
        });
        expect(alien.trace[0].text).toBe('WHATEVER');
    });

    it('回执缺 trace / 不是数组 → 空轨迹（不抛、不硬造一行）', () => {
        expect(describeDryRun({}).trace).toEqual([]);
        expect(describeDryRun(undefined).trace).toEqual([]);
        expect(describeDryRun({ trace: 'nope' }).trace).toEqual([]);
    });

    it('invalid 里的机器码同表翻成中文（同一规则两处出现，措辞不许各走各的）', () => {
        const out = describeDryRun({
            matched: false, rule: null, instruction_id: null, instruction: null,
            invalid: [{ id: 'r-6', name: '悬空', condition: 'x == 1', reason: 'INSTRUCTION_MISSING' }],
            considered: 1,
        });
        expect(out.rows[3]).toEqual({
            label: '缺陷跳过',
            value: '1 条 —— 规则「悬空」：目标指令不在册',
        });
        // 不是码的（后端给的中文原文）原样透出，不改写
        const raw = describeDryRun({
            matched: false, rule: null, instruction_id: null, instruction: null,
            invalid: [{ id: 'r-5', name: '坏条件', condition: 'meter_id', reason: '缺少比较运算符' }],
            considered: 1,
        });
        expect(raw.rows[3].value).toBe('1 条 —— 规则「坏条件」：缺少比较运算符');
    });
});

// ── R45（PLAN §8.75 七 留白销项）：加工页也吃同一张轨迹表 ──────────────────
// `describeTrace` 从 describeDryRun 的私有函数提为导出 —— 同一份回执两处消费
// （规则页试解析 / 加工页真解析），轨迹必须走同一张表，不许各排各的。
describe('routeResolve · describeTrace（R45 两页共用轨迹表）', () => {
    const TRACE = [
        { id: 'r-1', name: 'meter 0001', condition: 'meter_id == 1', code: 'MATCHED', detail: '' },
        { id: 'r-2', name: '看别的键', condition: 'line == 1', code: 'VAR_UNDEFINED', detail: 'line' },
    ];

    it('describeDryRun 的 trace 与 describeTrace 逐字相等（不许两处分叉）', () => {
        expect(describeTrace(TRACE)).toEqual(describeDryRun({ trace: TRACE }).trace);
    });

    it('缺省 / 非数组 → []（加工页回执不带 trace 时不出块，也不抛）', () => {
        expect(describeTrace(undefined)).toEqual([]);
        expect(describeTrace(null)).toEqual([]);
        expect(describeTrace('nope')).toEqual([]);
        expect(describeTrace({})).toEqual([]);
    });

    it('序号从 1 起按回执行序，name / condition 缺值给占位（不渲染空引号）', () => {
        expect(describeTrace([
            { name: '', condition: '', code: 'COND_FALSE', detail: '' },
        ])).toEqual([{
            index: 1, name: '（未命名）', condition: '（无条件）',
            code: 'COND_FALSE', text: '比较不成立',
        }]);
    });
});
