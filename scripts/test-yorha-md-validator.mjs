#!/usr/bin/env node
/**
 * R48（PLAN §8.80）· yorha-ui 校验器 **md 口径**的仓内红测 / 回归测试。
 *
 * 背景：校验器住在**仓外** `~/.agents/skills/yorha-ui`，本仓改不到它，也拿不到它的
 * 版本记录。这个脚本把 md 口径**钉成可复跑的断言**放回本仓 —— 仓外 skill 被改动或
 * 回滚时，本仓跑它就叫出来。
 *
 * md 口径（2026-10-07 question 工具回执拍板）：
 *   ① `.md` 纳入扫描，但**只扫围栏代码块**（``` 里、且语言标注在样式语言集内）；
 *   ② **散文、行内代码、无标注围栏、非样式语言围栏一律不看** —— 文档里的
 *      `box-shadow` / `p-6` 是史实记述（「当年改掉它」），不是活代码；
 *   ③ 违规要**给出 md 行号**，否则文档里没法定位。
 *
 * 用法：node scripts/test-yorha-md-validator.mjs
 * 退出码：0 全部通过；1 有断言失败；2 环境错误（skill 找不到 / node 起不来）。
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = process.env.YORHA_UI_VALIDATOR
  || 'C:/Users/Administrator/.agents/skills/yorha-ui/scripts/validate-yorha-ui.mjs';

/* 小工具：同步目录读（本脚本不想为遍历再引一层依赖） */
const readdirSafe = (d) => { try { return readdirSync(d); } catch { return []; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

if (!existsSync(VALIDATOR)) {
  console.error(`[环境错误] 找不到校验器：${VALIDATOR}`);
  console.error('（可用 YORHA_UI_VALIDATOR 环境变量指定路径）');
  process.exit(2);
}

// ── fixture：**故意违规的测试数据，放数据文件而不是内联进源码** ────────────────────
//    两层理由，都是事实：
//    ① fixture 内容必须含违规样式，否则测不到东西；而校验器对 `.mjs` 是**全文判**
//       （它连自己的源码都判出 8 条 —— 正则字面量里全是 `box-shadow` 这类词）。把
//       fixture 内联进本测试源码，这个文件自己就 9 条违规，「改动文件 0 违规」那条
//       验收当场不成立；
//    ② fixture 若写成仓内 `.md`，又会被「全仓 md → 0 违规」那条断言反过来咬住。
//    所以放 `scripts/fixtures/md-validator/*.fixture` —— `.fixture` 不在校验器扫描面内
//    （`SCANNED_EXTENSIONS` 里没有）。这是**刻意的放置不是掩盖**。
//    **R59（§8.91）起 `.txt` 已纳入扫描面**，这 6 份数据文件因此从 `.txt` 改名
//    `.fixture`：内容仍是故意违规的数据、断言其被抓，只是不能再借 `.txt` 躲在扫描面外
//    —— 放置口径一字未变，换的是扩展名。
//    运行时把它们复制成临时目录里的 `.md` / `.js`，再喂给校验器。
const FIXTURE_DIR = join(REPO, 'scripts', 'fixtures', 'md-validator');
const fixture = (name) => readFileSync(join(FIXTURE_DIR, `${name}.fixture`), 'utf8');

const dir = mkdtempSync(join(tmpdir(), 'yorha-r48-'));

const FIXTURES = {
  'css-block.md': fixture('css-block.md'),     // ① 样式围栏里的违规 → 该被抓
  'html-block.md': fixture('html-block.md'),   // ② 另一种语言标注 / 另一种规则族 → 该被抓
  'narrative.md': fixture('narrative.md'),     // ③ 散文 / 行内 / 无标注 / 非样式围栏 → 不判
                                                //    **红测主战场**：整文件口径在这里咬 6 条
  'clean.md': fixture('clean.md'),             // ④ 干净 md → 0（护栏）
  'ts-block.md': fixture('ts-block.md'),       // ⑤ 语言别名（实现后追加的护栏）
  'plain.js': fixture('plain.js'),             // ⑥ 回归：js 行为不变（护栏）
};

for (const [name, body] of Object.entries(FIXTURES)) writeFileSync(join(dir, name), body, 'utf8');

const run = (files) => {
  try {
    const out = execFileSync(process.execPath, [VALIDATOR, ...files], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (err) {
    return { code: typeof err.status === 'number' ? err.status : 2, out: String(err.stdout || '') + String(err.stderr || '') };
  }
};

const cases = [];
const check = (name, pass, detail) => cases.push({ name, pass, detail });

// 1 · md 里的 css 围栏违规必须被抓（缺特性红测）
{
  const r = run([join(dir, 'css-block.md')]);
  check('md 的 css 围栏违规 → 退出码 1',
    r.code === 1, `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 2 · md 的行号定位必须在输出里（缺特性红测）
{
  const r = run([join(dir, 'css-block.md')]);
  check('md 违规输出带行号（Line: N）',
    /Line:\s*\d+/.test(r.out), `code=${r.code} 无行号\n${r.out.slice(0, 400)}`);
}
// 3 · 第二种语言标注 / 第二种规则族（缺特性红测）
{
  const r = run([join(dir, 'html-block.md')]);
  check('md 的 html 围栏违规 → 退出码 1',
    r.code === 1, `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 4 · 散文 / 行内代码 / 无标注 / 非样式语言围栏一律不判（护栏：md 不扫时就绿）
{
  const r = run([join(dir, 'narrative.md')]);
  check('史实散文 + 行内代码 + 无标注 / bash / json 围栏 → 0 违规',
    r.code === 0, `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 5 · 干净 md → 0（护栏）
{
  const r = run([join(dir, 'clean.md')]);
  check('干净 md → 0 违规', r.code === 0, `code=${r.code}`);
}
// 5b · 语言别名（**实现后追加的护栏，如实单列 —— 不计入红测**）
{
  const r = run([join(dir, 'ts-block.md')]);
  check('md 的 typescript 别名围栏违规 → 退出码 1（实现后追加的护栏）',
    r.code === 1, `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 6 · 回归：js 文件行为不变（护栏）
{
  const r = run([join(dir, 'plain.js')]);
  check('js 文件的既有违规照旧 → 退出码 1（回归）',
    r.code === 1, `code=${r.code}\n${r.out.slice(0, 400)}`);
}
// 7 · 事实断言：本仓**全仓 md** 在该口径下 0 违规（进验收的那一项）
{
  const md = [];
  const walk = (d) => {
    for (const entry of readdirSafe(d)) {
      // venv / 第三方目录不进扫描面：那是本地环境与别人的 md，不是本仓文档
      if (entry.startsWith('.') || ['node_modules', 'dist', 'coverage', 'venv', '.venv', '__pycache__'].includes(entry)) continue;
      const full = join(d, entry);
      if (isDir(full)) walk(full);
      else if (extname(full).toLowerCase() === '.md') md.push(full);
    }
  };
  walk(REPO);
  const r = run(md);
  check(`本仓全仓 ${md.length} 份 md → 0 违规`,
    r.code === 0, `code=${r.code}\n${r.out.slice(0, 600)}`);
}

rmSync(dir, { recursive: true, force: true });

let failed = 0;
for (const c of cases) {
  if (c.pass) console.log(`  PASS  ${c.name}`);
  else { failed += 1; console.log(`  FAIL  ${c.name}\n        ${c.detail}`); }
}
console.log(`\nR48 md 口径：PASS ${cases.length - failed} / FAIL ${failed}（共 ${cases.length} 条）`);
process.exit(failed === 0 ? 0 : 1);
