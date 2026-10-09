import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// R62（PLAN §8.94 · 2026-10-09）：测试质量线护栏 —— 销 R53 起挂账的历史候选
// 「测试质量线收尾」第 1/2 批的两件硬指标：
//
//   ① `.toBeDefined()` 全仓 FE 测试文件零残留（本批已按判档口径改写为 `.not.toBeNull()`
//      —— null 从过变红才是检测力；实现前实测 221 处在场，本文件实现前跑 = 红）；
//   ② 同文件重复测试标题零残留（本批实测 1 真：InstructionEncoder.test.js:135 与 :319
//      两个不同意图复制未改名，已改名区分 int / float；另 3 处为标题提取器伪报）。
//
// R63（PLAN §8.95 · 2026-10-09）：第 2/2 批（裸 called 收敛）新增第 4 条硬指标：
//
//   ③ 正形态裸 called 零残留 —— 正形态裸断言 17 处全部收敛为**带实参**形态
//      （实现前实测 17 处在场，本文件实现前跑 = 红）；
//      判据天然不碰阴性 not 前缀（阴性 104 处 = 精确非弱，一行不改）与
//      With / Times 带参形态（字面要求
//      toHaveBeenCalled 紧跟空括号，With / Times 形态天然被排除在外）。
//      判不准者按「文件:行」登记进 BARE_CALLED_EXEMPT 显式豁免（预期 0 条；
//      豁免项必须实测在场，否则判 stale 一并翻红）。
//
// **自身豁免按路径判**（本文件正文必然含上面两条判据的字面，先例 R58 死码护栏
//  §8.90「按路径判、按名判不放过」）；换个名字复制一份进来照判。
// 标题提取按 it( / test( 的**第一个实参源码**整体取（含引号、模板字面量 ${} 原样），
// 不做「第一个引号串」的截断提取 —— 那正是 3 处伪报的成因（createBlock( / expect ）。
// eslint-disable-next-line no-undef -- vitest 提供 __dirname，eslint globals.browser 未声明
const FE_ROOT = path.resolve(__dirname, '..', '..');
const SELF_BASE = 'weakAssertions.test.js';

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
        return ['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)
            ? []
            : walk(full);
    }
    return [full];
});

const rel = (f) => path.relative(FE_ROOT, f).split(path.sep).join('/');

const testFiles = walk(FE_ROOT)
    .filter((f) => /\.test\.jsx?$/.test(f) && path.basename(f) !== SELF_BASE)
    .sort();

// 判据 ①：断言形态字面（拼接而成，避免本文件自身的字面命中之外的意外扩散）
const WEAK = new RegExp(['.', 'toBeDefined', '(', ')'].join(''), 'g');

const weakHits = [];
for (const f of testFiles) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(WEAK)) {
        const line = text.slice(0, m.index).split('\n').length;
        weakHits.push(`${rel(f)}:${line}`);
    }
}

// 判据 ②：it( / test( 行首调用 → 第一个实参源码整体（到顶层逗号或右括号为止）
const HEAD = /^[ \t]*(?:it|test)(?:\.(?:skip|only|todo|failing|each|concurrent))?\(/gm;

const firstArg = (text, open) => {
    let depth = 0;
    let quote = null;
    for (let i = open + 1; i < text.length; i += 1) {
        const c = text[i];
        if (quote) {
            if (c === '\\') { i += 1; } else if (c === quote) { quote = null; }
            continue;
        }
        if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') { depth += 1; continue; }
        if (c === ')' && depth === 0) { return text.slice(open + 1, i).trim(); }
        if (c === ',' && depth === 0) { return text.slice(open + 1, i).trim(); }
        if (c === ')' || c === ']' || c === '}') { depth -= 1; }
    }
    return text.slice(open + 1).trim();
};

const dupTitles = [];
for (const f of testFiles) {
    const text = fs.readFileSync(f, 'utf8');
    const seen = new Map();
    for (const m of text.matchAll(HEAD)) {
        const title = firstArg(text, m.index + m[0].length - 1);
        const line = text.slice(0, m.index).split('\n').length;
        if (!seen.has(title)) seen.set(title, []);
        seen.get(title).push(line);
    }
    for (const [title, lines] of seen) {
        if (lines.length > 1) {
            dupTitles.push(`${rel(f)} 行${lines.join('、')} 标题 ${title.slice(0, 70)}`);
        }
    }
}

// 判据 ③（R63 · PLAN §8.95）：正形态裸 called —— 字面要求 toHaveBeenCalled 紧跟空
// 括号，故 With / Times 带参形态天然不在面内；
// 断言前缀（去尾部空白）落在 not 上 = 阴性精确非弱（not 前缀的裸 called），
// 一行不改、剔除（104 处）。判不准者按「文件:行」显式豁免，理由须 §8.95 逐条点名。
const CALLED_BARE = /\.toHaveBeenCalled\(\)/g;
const BARE_CALLED_EXEMPT = new Map([
    // ['frontend/src/pages/__tests__/Example.test.jsx:90', '判不准理由（须 PLAN §8.95 点名）'],
]);

const bareCalledAll = [];
for (const f of testFiles) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(CALLED_BARE)) {
        const prefix = text.slice(0, m.index).replace(/\s+$/, '');
        bareCalledAll.push({
            key: `${rel(f)}:${text.slice(0, m.index).split('\n').length}`,
            negative: /(?:^|[^\w])not$/.test(prefix),
        });
    }
}
const bareCalledHits = bareCalledAll
    .filter((h) => !h.negative && !BARE_CALLED_EXEMPT.has(h.key))
    .map((h) => h.key);
const staleExempts = [...BARE_CALLED_EXEMPT.keys()]
    .filter((k) => !bareCalledAll.some((h) => h.key === k && !h.negative));

describe('R62 弱断言护栏：FE 测试文件零 toBeDefined 残留 + 同文件零重复标题', () => {
    it('扫描面非空（护栏自身不许空转）', () => {
        expect(testFiles.length).toBeGreaterThan(90);
    });

    it('FE 测试文件内不出现 toBeDefined 断言形态（实现前 221 处在场 → 红）', () => {
        expect(weakHits).toEqual([]);
    });

    it('同文件内 it/test 标题不重复（实现前 1 真重复 → 红）', () => {
        expect(dupTitles).toEqual([]);
    });

    it('正形态裸 toHaveBeenCalled 收敛为 toHaveBeenCalledWith（实现前 17 处在场 → 红）', () => {
        expect(bareCalledHits).toEqual([]);
        expect(staleExempts).toEqual([]);
    });
});
