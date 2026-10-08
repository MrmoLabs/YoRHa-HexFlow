import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// R58（PLAN §8.90）死码护栏 —— `pages/Blueprint.jsx` 经用户拍板删除（R57 §8.89 已查明并钉死：
// 无路由、全仓无任何 import；给 Canvas 传 items / setItems 而形参是 lanes / onSelect / selectedId
// → 画布恒空 → selectedId 恒 null → 删除按钮真实渲染不可达）。本文件是**静态扫描护栏**，
// 防它以任何形式复活；扫描面 = 全仓 src（frontend/src）。
// 判据两条（本批拍板口径）：`pages/Blueprint` 路径字面、`from './Blueprint'` 一类 import 引用
// （静态 from / 裸 import / 动态 import() 三形）。
// **自身豁免按路径判**（本文件正文必然含上面两条判据的字面，先例 = 仓外校验器自指豁免
// R49 §8.81「按路径判、按名判不放过」）；换个名字复制一份进来照判。
// 性质：护栏 —— 实现前即绿，记账时单列、不冒充红测。
// eslint-disable-next-line no-undef -- vitest 提供 __dirname，eslint globals.browser 未声明
const SRC_ROOT = path.resolve(__dirname, '..');
const SELF_BASE = 'noDeadBlueprint.test.js';

const SCAN_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json']);

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
});

const rel = (f) => path.relative(SRC_ROOT, f).split(path.sep).join('/');
const allFiles = walk(SRC_ROOT);
const targets = allFiles.filter(
    (f) => SCAN_EXTS.has(path.extname(f).toLowerCase()) && path.basename(f) !== SELF_BASE,
);

// 判据 ①：路径字面 pages/Blueprint（正斜杠与反斜杠都认）
const PATH_LITERAL = /pages[\\/]blueprint/i;
// 判据 ②：import 引用（from '…' / import '…' / import('…')）指向 Blueprint 模块
const IMPORT_REF = /\b(?:from|import)\s*\(?\s*['"][^'"]*blueprint[^'"]*['"]/i;

const hitsFor = (re) => targets
    .filter((f) => re.test(fs.readFileSync(f, 'utf8')))
    .map(rel);

describe('R58 死码护栏：src 内不许出现 pages/Blueprint 引用', () => {
    it('扫描面非空（护栏自身不许空转）', () => {
        expect(targets.length).toBeGreaterThan(100);
    });

    it('src 内没有任何文件或目录以 Blueprint 命名（死码页复活即红）', () => {
        const named = allFiles
            .map(rel)
            .filter((r) => /blueprint/i.test(r) && path.basename(r) !== SELF_BASE);
        expect(named).toEqual([]);
    });

    it('src 内不出现 pages/Blueprint 路径字面', () => {
        expect(hitsFor(PATH_LITERAL)).toEqual([]);
    });

    it('src 内不出现 from ./Blueprint 一类 import 引用（静态、裸、动态三形）', () => {
        expect(hitsFor(IMPORT_REF)).toEqual([]);
    });
});
