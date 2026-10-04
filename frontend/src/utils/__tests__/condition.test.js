// R26（PLAN §8.58 · §8.52 排期第 6 批）：序列步骤条件 —— 受限表达式求值器（FE 侧）。
//
// 与 BE `backend/core/condition.py` **逐行同语义**，共享向量单一真相源
// `vectors/condition.json`（58 行：`expected` = 求值结果、`error` = 预期错误文案
// **逐字相同**）—— 任一端语义漂移立刻红。一条条件 = 一次比较：
//
//     左操作数  运算符（== != >= <= > < in）  右操作数
//
// 无 eval / 无 Function / 无属性反射：没有算术、没有括号、没有布尔连接、没有函数调用。
// 变量名是**一整个裸词**，查表 = 整串精确匹配（`step.1.status` 是一个键，不下钻）。
// FE 侧职责：步骤编辑器**保存前就地校验**（checkCondition → 红字）+ 与 BE 同口径。
import { describe, it, expect } from 'vitest';
import conditionVec from '../../../../vectors/condition.json';
import {
    ConditionError,
    MAX_ARRAY_ITEMS,
    MAX_CONDITION_LEN,
    MAX_TOKENS,
    OPS,
    checkCondition,
    evaluateCondition,
    parseCondition,
} from '../condition';

const VECTORS = conditionVec;

describe('共享向量 vectors/condition.json（58 行，与 BE 同读一份）', () => {
    it('表非空（新增向量只写一处）', () => {
        expect(VECTORS.length).toBeGreaterThanOrEqual(50);
    });

    it('逐行求值 / 逐行错误文案', () => {
        VECTORS.forEach((row, i) => {
            const vars = row.vars || {};
            if ('error' in row) {
                let caught = null;
                try {
                    evaluateCondition(row.expr, vars);
                } catch (e) {
                    caught = e;
                }
                expect(caught, `#${i} ${row.expr}`).toBeInstanceOf(ConditionError);
                expect(caught.message, `#${i} ${row.expr}`).toBe(row.error);
            } else {
                expect(evaluateCondition(row.expr, vars), `#${i} ${row.expr}`)
                    .toBe(row.expected);
            }
        });
    });

    it('求值失败绝不静默当 false（否则步骤会被悄悄跳过）', () => {
        expect(() => evaluateCondition('nope == 1', {})).toThrow(ConditionError);
        expect(checkCondition('nope == 1')).toBeNull(); // 只查语法：变量到运行期才存在
    });
});

describe('语法面（保存前就地校验用 checkCondition）', () => {
    it('只查语法、不查变量', () => {
        const [, op, right] = parseCondition('任何变量 >= 1');
        expect(op).toBe('>=');
        expect(right).toEqual(['num', 1]);
        expect(checkCondition('任何变量 >= 1')).toBeNull();
    });

    it('运算符白名单 = 拍板 5 项 + 补齐的 >= / <=', () => {
        expect(OPS).toEqual(['==', '!=', '>=', '<=', '>', '<']);
    });

    it('无算术 / 无括号 / 无布尔连接 / 无函数调用', () => {
        ['a + 1 == 2', '(a) >= 1', 'a >= 1 && b >= 1', 'a >= 1 || b >= 1',
            'len(a) == 1', 'a * 2 == 1'].forEach((expr) => {
            expect(() => parseCondition(expr), expr).toThrow(ConditionError);
        });
    });

    it('三条上限都拦（长度 / 记号 / 数组元素）', () => {
        const long = `a >= ${'1'.repeat(MAX_CONDITION_LEN + 10)}`;
        expect(() => parseCondition(long)).toThrow(String(MAX_CONDITION_LEN));
        expect(() => parseCondition('[1] == [1] '.repeat(10))).toThrow(String(MAX_TOKENS));
        const big = `[${Array.from({ length: MAX_ARRAY_ITEMS + 3 }, (_, i) => i % 10).join(',')}] == 1`;
        expect(() => parseCondition(big)).toThrow(ConditionError);
    });

    it('空输入三态同 BE 文案', () => {
        [null, undefined, '', '   '].forEach((bad) => {
            expect(() => parseCondition(bad)).toThrow('条件为空');
            expect(checkCondition(bad)).toBe('条件为空');
        });
    });

    it('尾部多余记号 → 报错（不静默截断）', () => {
        expect(() => parseCondition('a == 1 == 2')).toThrow('多余的记号');
    });
});

describe('语义要点', () => {
    it('查表是整串精确匹配，不做点号下钻', () => {
        const vars = { status: 'X', 'step.1.status': 'OK', step: { 1: { status: 'Y' } } };
        expect(evaluateCondition('step.1.status == "OK"', vars)).toBe(true);
        expect(evaluateCondition('status == "X"', vars)).toBe(true);
        // 表里真有嵌套对象也只当「一个值」：不可下钻 → 类型比较报错
        expect(() => evaluateCondition('step == 1', vars)).toThrow('类型无法比较');
    });

    it('null 只与 null 相等；比大小 → 类型错', () => {
        expect(evaluateCondition('v == null', { v: null })).toBe(true);
        expect(evaluateCondition('v == 0', { v: null })).toBe(false);
        expect(evaluateCondition('v != 0', { v: null })).toBe(true);
        expect(() => evaluateCondition('v > 0', { v: null })).toThrow('类型无法比较');
    });

    it('in = 子串 或 数组成员', () => {
        expect(evaluateCondition('"A5" in v', { v: 'A501' })).toBe(true);
        expect(evaluateCondition('v in ["A501", "B0B1"]', { v: 'A501' })).toBe(true);
        expect(evaluateCondition('v in ["B0B1"]', { v: 'A501' })).toBe(false);
        expect(evaluateCondition('v in []', { v: 'A501' })).toBe(false);
    });

    it('整数与小数同比（JSON 里两者都是 number）', () => {
        expect(evaluateCondition('v == 4608.0', { v: 4608 })).toBe(true);
        expect(evaluateCondition('v >= 4608', { v: 4608.0 })).toBe(true);
        expect(evaluateCondition('v == 0x1200', { v: 4608 })).toBe(true);
    });

    it('布尔永远不是数字', () => {
        ['v == 1', 'v > 0', 'v < 1'].forEach((expr) => {
            expect(() => evaluateCondition(expr, { v: true }), expr).toThrow('类型无法比较');
        });
    });
});
