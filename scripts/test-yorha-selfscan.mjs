#!/usr/bin/env node
/**
 * R49（PLAN §8.81）· yorha-ui 校验器**自检收口**的仓内红测 / 回归测试。
 *
 * R48 留白里登记的「skill 自检 9 条既有违规」，2026-10-08 question 回执拍板两问：
 *   ① validator 自己那 8 条（规则正则字面量 + FIXES 文案里的禁词）→ **自指豁免**，
 *      且**报告里显式写明**（不静默）—— 它本来就 `stripComments`（注释里的禁词不判），
 *      字符串与正则是同一类「词表数据」；
 *   ② `components.md` 缩略骨架示例缺工业标记那 1 条（x2）→ **修示例补 header**，
 *      规则一个字不改。
 *
 * 这个脚本把两件事钉成可复跑断言放回本仓 —— 校验器住在**仓外**，本仓改不到它，
 * 也拿不到它的版本记录，靠它当防回滚护栏。
 *
 * 用法：node scripts/test-yorha-selfscan.mjs
 * 退出码：0 全部通过；1 有断言失败；2 环境错误。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = process.env.YORHA_UI_SKILL || 'C:/Users/Administrator/.agents/skills/yorha-ui';
const VALIDATOR = join(SKILL, 'scripts', 'validate-yorha-ui.mjs');
const SELF_SCAN_TARGET = SKILL;
const COMPONENTS_MD = join(SKILL, 'references', 'components.md');

if (!existsSync(VALIDATOR) || !existsSync(COMPONENTS_MD)) {
  console.error(`[环境错误] 找不到 skill：${SKILL}`);
  console.error('（可用 YORHA_UI_SKILL 环境变量指定目录）');
  process.exit(2);
}

const run = (files) => {
  try {
    const out = execFileSync(process.execPath, [VALIDATOR, ...files], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 2,
      out: String(err.stdout || '') + String(err.stderr || ''),
    };
  }
};

const cases = [];
const check = (name, pass, detail) => cases.push({ name, pass, detail });

const dir = mkdtempSync(join(tmpdir(), 'yorha-r49-'));
const copy = (from, to) => writeFileSync(join(dir, to), readFileSync(from, 'utf8'), 'utf8');

// ① 一个**外部**文件，内容含规则族会命中的 CSS 声明（复用 R48 的 fixture，
//    本脚本源码里因此不必出现任何禁词字面量 —— 否则这个测试文件自己就先违规）
copy(join(REPO, 'scripts', 'fixtures', 'md-validator', 'plain.js.fixture'), 'elsewhere.js');
// ② R48 的 md 围栏口径回归（豁免不许把 md 扫描面一起关掉）
copy(join(REPO, 'scripts', 'fixtures', 'md-validator', 'css-block.md.fixture'), 'fence.md');

// 1 · skill 自检 → 退出码 0（缺特性红测：自指豁免未落地前是 1）
{
  const r = run([SELF_SCAN_TARGET]);
  check('skill 自检 → 退出码 0', r.code === 0, `code=${r.code}\n${r.out.slice(-700)}`);
}
// 2 · 报告里必须写明豁免理由（缺特性红测：拍板要求「写明不静默」）
{
  const r = run([SELF_SCAN_TARGET]);
  check('skill 自检报告写明自指豁免', /exempt/i.test(r.out), `报告里没有豁免说明\n${r.out.slice(-500)}`);
}
// 3 · 那条文档示例违规不再出现（缺特性红测：示例未补 header 前是 1 条 x2）
{
  const r = run([SELF_SCAN_TARGET]);
  check('skill 自检不再报 MISSING_INDUSTRIAL_TAG', !/MISSING_INDUSTRIAL_TAG/.test(r.out),
    `仍有工业标记违规\n${r.out.slice(-700)}`);
}
// 4 · components.md 单独扫 → 0 违规（同上，缺特性红测）
{
  const r = run([COMPONENTS_MD]);
  check('components.md 单独扫 → 0 违规', r.code === 0, `code=${r.code}\n${r.out.slice(-500)}`);
}
// 5 · 护栏：**外部**文件的同样违规照旧被抓 —— 豁免只认 validator 自己，
//    一旦豁免面扩大（按目录 / 按扩展名 / 按内容），这条当场红（实现前即绿）
{
  const r = run([join(dir, 'elsewhere.js')]);
  check('外部文件的同样违规照旧 → 退出码 1（护栏：豁免不扩大）', r.code === 1,
    `code=${r.code}\n${r.out.slice(-500)}`);
}
// 6 · 护栏：R48 的 md 围栏口径没被这批改坏（实现前即绿）
{
  const r = run([join(dir, 'fence.md')]);
  check('md 围栏违规照旧 → 退出码 1（护栏：R48 回归）', r.code === 1, `code=${r.code}`);
}
// 7 · 护栏：本仓全仓 md 仍 0 违规（实现前即绿，R48 那条断言换个脚本再钉一次）
{
  const SKIP = new Set(['node_modules', 'dist', 'coverage', 'venv', '.venv', '__pycache__']);
  const mds = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.') || SKIP.has(entry)) continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extname(full).toLowerCase() === '.md') mds.push(full);
    }
  };
  walk(REPO);
  const r = run(mds);
  check(`本仓全仓 ${mds.length} 份 md → 0 违规（护栏）`, r.code === 0,
    `code=${r.code}\n${r.out.slice(-500)}`);
}

rmSync(dir, { recursive: true, force: true });

let failed = 0;
for (const c of cases) {
  if (c.pass) console.log(`  PASS  ${c.name}`);
  else { failed += 1; console.log(`  FAIL  ${c.name}\n        ${c.detail}`); }
}
console.log(`\nR49 自检收口：PASS ${cases.length - failed} / FAIL ${failed}（共 ${cases.length} 条）`);
process.exit(failed === 0 ? 0 : 1);
