#!/usr/bin/env node
/**
 * R59（PLAN §8.91）· yorha-ui 校验器**口径扩展三项 + 行级抑制**的仓内红测 / 回归测试。
 *
 * 背景：校验器住在**仓外** `~/.agents/skills/yorha-ui`，本仓改不到它，也拿不到它的版本
 * 记录。R48 钉了 md 围栏口径（`scripts/test-yorha-md-validator.mjs`，8 条），R49 钉了
 * 自指豁免（`scripts/test-yorha-selfscan.mjs`，7 条）；本批再钉三件新事实：
 *
 *   ① **`~~~` 围栏与 ``` 等价**（带语言标注才判、语言归一与别名表复用、行号 = 围栏起始行
 *      + 块内偏移；四空格缩进代码块本批仍不判 —— 不在拍板范围，沿旧留档）；
 *   ② **`.txt` 进 `SCANNED_EXTENSIONS`** —— 随之 R48 那 6 份 fixture 从 `.txt` 改名
 *      `.fixture`（`.fixture` 不在校验器扫描面内，放置口径不变）；
 *   ③ **行级抑制注释**（本批新开的豁免口）：代码行 `// yorha-ui: allow <规则号> <中文理由>`、
 *      md 行 `<!-- yorha-ui: allow <规则号> <中文理由> -->`，**规则号与非空理由缺一不算数**，
 *      只抑制**所在行**的违规；报告与 `--json` 全量列点（文件 / 行 / 规则号 / 理由 + 汇总计数）。
 *
 * 为什么单开一个脚本而不并进 `test-yorha-md-validator.mjs`：R48 那 8 条断言与「8 条」这个
 * 计数被 §8.80 / §8.81 / §8.89 / §8.90 与 HANDOVER 条目 97–107 反复引用，往里加断言等于
 * 改写多处历史计数；本批测的是**另一个口径面**（扫描面扩展 + 抑制机制），单开一份，计数自持。
 *
 * 违规内容一律放 `scripts/fixtures/md-validator/*.fixture` 数据文件，**不内联进本源码** ——
 * 校验器对 `.mjs` 全文判（R48 踩过：内联则本文件自己 9 条违规，「改动文件 0 违规」不成立）。
 *
 * 用法：node scripts/test-yorha-validator-scope.mjs
 * 退出码：0 全部通过；1 有断言失败；2 环境错误（校验器找不到 / node 起不来）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = process.env.YORHA_UI_VALIDATOR
  || 'C:/Users/Administrator/.agents/skills/yorha-ui/scripts/validate-yorha-ui.mjs';

if (!existsSync(VALIDATOR)) {
  console.error(`[环境错误] 找不到校验器：${VALIDATOR}`);
  console.error('（可用 YORHA_UI_VALIDATOR 环境变量指定路径）');
  process.exit(2);
}

const FIXTURE_DIR = join(REPO, 'scripts', 'fixtures', 'md-validator');
const fixture = (name) => readFileSync(join(FIXTURE_DIR, name), 'utf8');

const dir = mkdtempSync(join(tmpdir(), 'yorha-r59-'));
const put = (name, body) => { const p = join(dir, name); writeFileSync(p, body, 'utf8'); return p; };

// ① `~~~` 围栏（新口径）
put('tilde-block.md', fixture('tilde-block.md.fixture'));
put('tilde-narrative.md', fixture('tilde-narrative.md.fixture'));
// ③ 行级抑制（代码行 `//`、md 行 `<!-- -->`）
put('suppress-ok.js', fixture('suppress-ok.js.fixture'));
put('suppress-ok.md', fixture('suppress-ok.md.fixture'));
put('suppress-norule.js', fixture('suppress-norule.js.fixture'));
put('suppress-noreason.js', fixture('suppress-noreason.js.fixture'));
put('suppress-noreason.md', fixture('suppress-noreason.md.fixture'));
put('suppress-mismatch.js', fixture('suppress-mismatch.js.fixture'));
put('suppress-elsewhere.js', fixture('suppress-elsewhere.js.fixture'));
// 规则链回归（没有任何抑制注释的普通违规）
put('plain.js', fixture('violating.js.fixture'));
// ② `.txt` 进扫描面：单独一个子目录，里面只有一份 `.txt`
const txtDir = join(dir, 'txtdir');
mkdirSync(txtDir);
writeFileSync(join(txtDir, 'sample.txt'), fixture('violating.js.fixture'), 'utf8');

const run = (args) => {
  try {
    const out = execFileSync(process.execPath, [VALIDATOR, ...args], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (err) {
    const out = String(err.stdout || '') + String(err.stderr || '');
    // 校验器自身崩了（语法错 / 模块加载失败）不是「发现违规」，别把 node 的退出码 1 当绿
    const crashed = /SyntaxError|Cannot find module|ERR_[A-Z_]+/.test(out);
    return { code: crashed ? 2 : (typeof err.status === 'number' ? err.status : 2), out };
  }
};

const cases = [];
const check = (name, pass, detail) => cases.push({ name, pass, detail });

// 1 · `~~~css` 围栏里的违规必须被抓（缺特性红测）
{
  const r = run([join(dir, 'tilde-block.md')]);
  check('~~~css 围栏违规 → 退出码 1', r.code === 1, `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 2 · 无标注 / 非样式的 `~~~` 围栏照旧不判（护栏：fail-open 口径没被本批关掉）
{
  const r = run([join(dir, 'tilde-narrative.md')]);
  check('无标注 + bash 的 ~~~ 围栏 → 0 违规（护栏）', r.code === 0,
    `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 3 · `.txt` 进了目录扫描面（缺特性红测：实现前该目录无任何可扫文件 → 退出码 2）
{
  const r = run([txtDir]);
  check('目录里的 .txt 违规 → 退出码 1', r.code === 1, `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 4 · 代码行合法抑制（规则号 + 理由 + 同行）→ 该生效（缺特性红测）
{
  const r = run([join(dir, 'suppress-ok.js')]);
  check('合法抑制（代码行 // ）→ 0 违规', r.code === 0, `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 5 · md 行合法抑制（HTML 注释 + 同行 = 报告所指行）→ 该生效（缺特性红测）
{
  const r = run([join(dir, 'suppress-ok.md')]);
  check('合法抑制（md 行 <!-- --> ）→ 0 违规', r.code === 0,
    `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 6 · 报告必须全量列点：文件:行 [规则号] 理由 + 状态 + 汇总计数（缺特性红测）
{
  const r = run([join(dir, 'suppress-ok.js'), join(dir, 'suppress-noreason.js')]);
  const need = [
    /Suppression markers \(2 total: 1 applied, 1 invalid, 0 unused\):/,
    /suppress-ok\.js:2 \[NO_BOX_SHADOW\] 历史示例保留（R59 用例） - applied \(1 violation suppressed\)/,
    /suppress-noreason\.js:2 \[NO_BOX_SHADOW\] \(none\) - invalid \(missing reason\)/,
  ];
  const missing = need.filter((re) => !re.test(r.out)).map(String);
  check('报告列出抑制（文件/行/规则号/理由 + 汇总计数）',
    missing.length === 0, `缺 ${missing.length} 处：\n${missing.join('\n')}\n${r.out.slice(0, 900)}`);
}
// 7 · `--json` 同样全量列点（缺特性红测：字段根本不存在）
{
  const r = run(['--json', join(dir, 'suppress-ok.js')]);
  let ok = false;
  let why = `code=${r.code}`;
  try {
    const j = JSON.parse(r.out);
    const s = j.files?.[0]?.suppressions ?? [];
    const t = j.totals?.suppressions ?? {};
    const e = s[0] ?? {};
    ok = s.length === 1
      && String(e.file || '').endsWith('suppress-ok.js')
      && e.line === 2 && e.rule === 'NO_BOX_SHADOW'
      && String(e.reason || '').includes('历史示例保留')
      && e.valid === true && e.applied === true && e.suppressed === 1
      && t.markers === 1 && t.applied === 1 && t.invalid === 0 && t.unused === 0;
    if (!ok) why = `json 形状不符：${JSON.stringify({ s, t }).slice(0, 600)}`;
  } catch (err) {
    why = `解析失败 ${err.message}\n${r.out.slice(0, 300)}`;
  }
  check('--json 列出抑制数组与汇总计数', ok, why);
}
// 8 · 失效态一：规则号位不是合法规则号 → 不许抑制成功（护栏：实现前也是 1）
{
  const r = run([join(dir, 'suppress-norule.js')]);
  check('抑制缺规则号 → 违规照报（护栏）', r.code === 1, `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 9 · 失效态二：有规则号没有理由 → 不许抑制成功（护栏：实现前也是 1）
{
  const r = run([join(dir, 'suppress-noreason.js')]);
  check('抑制缺理由 → 违规照报（护栏）', r.code === 1, `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 10 · 失效态三：规则号与本行违规不一致 → 不许抑制成功（护栏：实现前也是 1）
{
  const r = run([join(dir, 'suppress-mismatch.js')]);
  check('抑制规则号不匹配 → 违规照报（护栏）', r.code === 1,
    `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 11 · 只抑制所在行：注释在第 1 行、违规在第 2 行 → 第 2 行照报（护栏）
{
  const r = run([join(dir, 'suppress-elsewhere.js')]);
  check('抑制注释不在同一行 → 违规照报（护栏）', r.code === 1,
    `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 12 · md 侧失效态同样照报（护栏：md 的 HTML 注释不是「写上就算」）
{
  const r = run([join(dir, 'suppress-noreason.md')]);
  check('md 抑制缺理由 → 违规照报（护栏）', r.code === 1,
    `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 13 · 规则链回归：没有任何抑制注释的普通违规照旧被抓（护栏：抑制机制没把规则链改坏）
{
  const r = run([join(dir, 'plain.js')]);
  check('无抑制注释的普通违规 → 退出码 1（护栏）', r.code === 1,
    `code=${r.code}\n${r.out.slice(0, 400)}`);
}

rmSync(dir, { recursive: true, force: true });

let failed = 0;
for (const c of cases) {
  if (c.pass) console.log(`  PASS  ${c.name}`);
  else { failed += 1; console.log(`  FAIL  ${c.name}\n        ${c.detail}`); }
}
console.log(`\nR59 口径扩展：PASS ${cases.length - failed} / FAIL ${failed}（共 ${cases.length} 条）`);
process.exit(failed === 0 ? 0 : 1);
