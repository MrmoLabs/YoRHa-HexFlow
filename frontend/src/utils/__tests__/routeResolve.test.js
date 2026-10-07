// R39（PLAN §8.71）：加工页「按输入自动选指令」的纯逻辑层。
//
// 三条口径（与后端 resolve_route 逐字对齐，FE 只呈现不改判）：
//  ① **输入表是扁平键值**，与后端 evaluate_condition 的变量表同形 —— 键值去两端
//     空白、空键行不发送（用户多敲一个空格不该让整条规则静默不命中）；
//  ② **回执怎么说就怎么显示**：matched 由后端给，无命中 = 不猜、维持现状，
//     FE 不许自己挑一条「看起来差不多」的指令；
//  ③ **命中才切、切前留痕**：目标指令若回执里没带回，就不切、文案也不说切了。
import { describe, it, expect } from 'vitest';
import {
    addRouteInput,
    describeInputType,
    describeResolve,
    describeResolveError,
    emptyRouteInputs,
    filledInputCount,
    mergeResolvedInstruction,
    parseInputValue,
    patchRouteInput,
    removeRouteInput,
    resolveInstructionId,
    toInputsMap,
} from '../routeResolve';

const rows = (list) => list.map(([key, value]) => ({ key, value }));

describe('routeResolve · 输入表的行编辑（纯函数，不碰数组入参）', () => {
    it('emptyRouteInputs → 一条空行（面板一进来就有可输入处）', () => {
        expect(emptyRouteInputs()).toEqual([{ key: '', value: '' }]);
    });

    it('addRouteInput 追加空行，且不改原数组', () => {
        const base = emptyRouteInputs();
        const next = addRouteInput(base);
        expect(next).toHaveLength(2);
        expect(next[1]).toEqual({ key: '', value: '' });
        expect(base).toHaveLength(1);
        expect(base).not.toBe(next);
    });

    it('removeRouteInput 按下标删；越界下标是 no-op（不报错、返回等价内容）', () => {
        const base = rows([['a', '1'], ['b', '2'], ['c', '3']]);
        expect(removeRouteInput(base, 1)).toEqual([['a', '1'], ['c', '3']].map(([key, value]) => ({ key, value })));
        expect(removeRouteInput(base, 9)).toHaveLength(3);
        expect(base).toHaveLength(3);
    });

    it('patchRouteInput 只改命中下标那一行，其余行引用不变', () => {
        const base = rows([['a', '1'], ['b', '2']]);
        const next = patchRouteInput(base, 1, { value: 'X' });
        expect(next[1]).toEqual({ key: 'b', value: 'X' });
        expect(next[0]).toBe(base[0]);
        expect(base[1].value).toBe('2');
    });
});

describe('routeResolve · 值的类型解析（文本框 → JSON 标量）', () => {
    it('纯数字按数字发（0001 → 1，与条件里的数字字面量同型）', () => {
        expect(parseInputValue(' 0001 ')).toBe(1);
        expect(parseInputValue('12')).toBe(12);
        expect(parseInputValue('-2.5')).toBe(-2.5);
        expect(parseInputValue('1e3')).toBe(1000);
    });

    it('显式加引号按字符串发（前导零串的唯一出口）', () => {
        expect(parseInputValue('"0001"')).toBe('0001');
        expect(parseInputValue(' "abc" ')).toBe('abc');
        expect(parseInputValue('""')).toBe('');
    });

    it('其余按字符串原文发（引号不配对 / 非 JSON 记号都不报错）', () => {
        expect(parseInputValue('abc')).toBe('abc');
        expect(parseInputValue('V1.2')).toBe('V1.2');
        expect(parseInputValue('0x10')).toBe('0x10');
        expect(parseInputValue('"unterminated')).toBe('"unterminated');
        expect(parseInputValue(undefined)).toBe('');
        expect(parseInputValue(null)).toBe('');
    });

    it('describeInputType 是给面板徽标用的：当场看见会按什么发', () => {
        expect(describeInputType('')).toBe('空');
        expect(describeInputType('   ')).toBe('空');
        expect(describeInputType('0001')).toBe('数字');
        expect(describeInputType('"0001"')).toBe('字符串');
        expect(describeInputType('V1.2')).toBe('字符串');
    });
});

describe('routeResolve · 行表 → 后端 inputs（扁平键值 + JSON 标量值）', () => {
    it('键去两端空白，值按 JSON 标量解析', () => {
        expect(toInputsMap(rows([['  meter_id ', ' 0001  ']]))).toEqual({ meter_id: 1 });
        expect(toInputsMap(rows([['line', ' A ']]))).toEqual({ line: 'A' });
        expect(toInputsMap(rows([['sn', '"0001"']]))).toEqual({ sn: '0001' });
    });

    it('空键行（去空白后）整行不发送', () => {
        expect(toInputsMap(rows([['   ', '0001'], ['line', 'A']]))).toEqual({ line: 'A' });
    });

    it('全空表 → {}（照发不误：空输入也是「本次输入」）', () => {
        expect(toInputsMap([])).toEqual({});
        expect(toInputsMap(emptyRouteInputs())).toEqual({});
    });

    it('键重复时后写的赢（面板按行编辑，后一行是用户最后确认的）', () => {
        expect(toInputsMap(rows([['meter_id', '0001'], ['meter_id', '0002']])))
            .toEqual({ meter_id: 2 });
        expect(toInputsMap(rows([['sn', 'A'], ['sn', 'B']])))
            .toEqual({ sn: 'B' });
    });

    it('filledInputCount 只数去空白后有键的行', () => {
        expect(filledInputCount(rows([[' ', ''], ['a', '1'], ['b', '2']]))).toBe(2);
        expect(filledInputCount(emptyRouteInputs())).toBe(0);
    });
});

describe('routeResolve · 回执 → 该切哪条指令', () => {
    it('优先取顶层 instruction_id（后端命中即给）', () => {
        expect(resolveInstructionId({ instruction_id: 'i-1', instruction: { id: 'i-2' } })).toBe('i-1');
    });

    it('顶层缺失时退回 instruction.id（回执只带指令全文也能切）', () => {
        expect(resolveInstructionId({ instruction_id: null, instruction: { id: 'i-2' } })).toBe('i-2');
    });

    it('两者皆无 → null（调用方据此不切，不硬凑）', () => {
        expect(resolveInstructionId({ instruction_id: null, instruction: null })).toBeNull();
        expect(resolveInstructionId(null)).toBeNull();
    });

    it('目标指令不在册 → 补进列表尾部（R36 给全量指令正是为此，省一次 /instructions）', () => {
        const list = [{ id: 'i-1', name: '开门指令' }];
        const res = { instruction_id: 'i-2', instruction: { id: 'i-2', name: '关门指令' } };
        const next = mergeResolvedInstruction(list, res);
        expect(next.map(i => i.id)).toEqual(['i-1', 'i-2']);
        expect(list).toHaveLength(1);   // 原数组不动
    });

    it('目标指令已在册 → 原样返回同一引用（不制造无意义的重渲染）', () => {
        const list = [{ id: 'i-1', name: '开门指令' }];
        const res = { instruction_id: 'i-1', instruction: { id: 'i-1', name: '开门指令' } };
        expect(mergeResolvedInstruction(list, res)).toBe(list);
    });

    it('回执没带指令全文 → 返回原列表（只切不补）', () => {
        const list = [{ id: 'i-1', name: '开门指令' }];
        expect(mergeResolvedInstruction(list, { instruction_id: 'i-9', instruction: null })).toBe(list);
    });
});

describe('routeResolve · 回执 → 中文事实文案（只陈述事实，不断言用户意图）', () => {
    it('命中：规则名 + 目标指令名一并写出', () => {
        const out = describeResolve({
            matched: true,
            rule: { name: 'meter 0001' },
            instruction_id: 'i-1',
            instruction: { name: '关门指令' },
            invalid: [],
            considered: 3,
        });
        expect(out).toEqual({
            matched: true,
            text: '命中规则「meter 0001」→ 已切到指令「关门指令」。',
        });
    });

    it('命中但回执未带回目标指令 → 文案不谎称切了', () => {
        const out = describeResolve({
            matched: true,
            rule: { name: 'meter 0001' },
            instruction_id: null,
            instruction: null,
            invalid: [],
            considered: 3,
        });
        expect(out.matched).toBe(true);
        expect(out.text).toBe('命中规则「meter 0001」→ 但回执未带回目标指令，未切换。');
    });

    it('无命中（扫过规则）：写清扫了几条 + 维持当前指令 + 不猜', () => {
        const out = describeResolve(
            { matched: false, rule: null, instruction_id: null, instruction: null, invalid: [], considered: 3 },
            { previousName: '开门指令' }
        );
        expect(out).toEqual({
            matched: false,
            text: '无命中 —— 扫过 3 条规则都不成立，维持当前指令「开门指令」不猜。',
        });
    });

    it('无命中（一条规则都没参与）：写清是没规则或全停用，不写「都判完了」', () => {
        const out = describeResolve(
            { matched: false, rule: null, instruction_id: null, instruction: null, invalid: [], considered: 0 },
            { previousName: '开门指令' }
        );
        expect(out.text).toBe('无命中 —— 没有任何规则参与（无规则或全部停用），维持当前指令「开门指令」不猜。');
    });

    it('无命中且当前本就没选指令：写「当前未选中状态」，不硬造一个指令名', () => {
        const out = describeResolve(
            { matched: false, rule: null, instruction_id: null, instruction: null, invalid: [], considered: 1 },
            { previousName: null }
        );
        expect(out.text).toContain('维持当前未选中状态不猜。');
        expect(out.text).not.toContain('「」');
    });

    it('结构性缺陷（坏条件 / 目标指令不在册）有几条写几条，命中与无命中都附', () => {
        const hit = describeResolve({
            matched: true, rule: { name: 'r' }, instruction_id: 'i', instruction: { name: 'x' },
            invalid: [{ reason: 'bad' }, { reason: 'gone' }], considered: 5,
        });
        expect(hit.text).toBe('命中规则「r」→ 已切到指令「x」。另有 2 条结构性缺陷已跳过（条件语法坏掉 / 目标指令不在册）。');

        const miss = describeResolve({
            matched: false, rule: null, instruction_id: null, instruction: null,
            invalid: [{ reason: 'bad' }], considered: 1,
        }, { previousName: '开门指令' });
        expect(miss.text).toContain('另有 1 条结构性缺陷已跳过');
    });

    it('规则名缺失时写「（规则未回带名称）」，不渲染成空引号', () => {
        const out = describeResolve({
            matched: true, rule: null, instruction_id: 'i', instruction: { name: 'x' },
            invalid: [], considered: 1,
        });
        expect(out.text).toContain('命中规则「（规则未回带名称）」');
    });

    it('describeResolveError：失败给事实 + 后端原文，后端没给才落兜底', () => {
        expect(describeResolveError(new Error('backend down'))).toBe('解析失败 —— backend down');
        expect(describeResolveError(undefined)).toBe('解析失败 —— 无法连接后端服务');
        expect(describeResolveError({})).toBe('解析失败 —— 无法连接后端服务');
    });
});
