import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// R55 测试自身 bug 先修：`import css from '../index.css?raw'` 在本仓 vitest 下拿到的是
// 空串（vitest `css` 缺省 false 会把 .css 导入打桩，?raw/?inline 一并为空，实测 LEN=0），
// 断言因此红在读取而不是色值。改用 node:fs 直读同一份文件，断言语义不变。
// （保留 __dirname：vitest 转换后 CJS 互操作确实提供它（全量 1517 绿已证）；
//   本仓 eslint 只挂 globals.browser，故这一行显式豁免 no-undef —— 豁免的是「环境没声明」，
//   不是豁免「断言本身」，色值断言一条不减。）
// eslint-disable-next-line no-undef -- vitest 提供 __dirname，eslint globals.browser 未声明
const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');

// R55（PLAN §8.86）：语义色 token 的对比度硬指标 —— 值先算后写，写死在 @theme 里。
// 断言两件事：
//   ① index.css 的 @theme 里 warn / hl / muted 三个 token 存在且为 6 位十六进制；
//   ② 三者在站内**全部浅底**上 >= 4.5:1（WCAG 正文线，实算不看估色）。
// 深底（bg-nier-light #4A4A4A）不列入本表：深红/深琥珀压深底必然不可读，
// 深底上的字另按「原色 >=5.6 保留 / 不达标换浅色档」口径判（见 PLAN §8.86 判档）。

const tokenHex = (name) => {
    const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
    return match ? match[1] : null;
};

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const linear = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
    const [r, g, b] = channels(hex).map(linear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const over = (fg, bg, alpha) => '#'
    + channels(fg)
        .map((c, i) => Math.round(c * alpha + channels(bg)[i] * (1 - alpha)))
        .map((c) => c.toString(16).padStart(2, '0'))
        .join('');
const contrast = (a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const SAND = '#dad4bb';
const WHITE = '#ffffff';
const CHARCOAL = '#4a4a4a';
const RED500 = '#ef4444';
const YELLOW500 = '#f0b100';

// 站内实际会出现的浅底：页面底 / 白底 / 状态徽标底 / 侧栏选中 / 输入框 / 红徽标 / 白叠加
const LIGHT_SURFACES = [
    ['body 沙色', SAND],
    ['bg-white', WHITE],
    ['沙 + bg-yellow-500/10', over(YELLOW500, SAND, 0.1)],
    ['沙 + bg-nier-light/10 选中行', over(CHARCOAL, SAND, 0.1)],
    ['沙 + bg-nier-light/5 输入', over(CHARCOAL, SAND, 0.05)],
    ['沙 + bg-red-500/10', over(RED500, SAND, 0.1)],
    ['沙 + bg-white/5', over(WHITE, SAND, 0.05)],
];

describe('R55 语义色 token（@theme）', () => {
    it('warn / hl / muted 三个 token 在 index.css 的 @theme 里定义', () => {
        expect(tokenHex('warn')).toMatch(/^#[0-9a-f]{6}$/i);
        expect(tokenHex('hl')).toMatch(/^#[0-9a-f]{6}$/i);
        expect(tokenHex('muted')).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it.each(['warn', 'hl', 'muted'])(
        '--color-%s 在站内全部浅底上 >= 4.5:1（正文线）',
        (name) => {
            const hex = tokenHex(name);
            expect(hex).not.toBeNull();
            for (const [label, bg] of LIGHT_SURFACES) {
                expect(
                    Number(contrast(hex, bg).toFixed(2)),
                    `${name} ${hex} vs ${label} ${bg}`,
                ).toBeGreaterThanOrEqual(4.5);
            }
        },
    );

    it('旧的浅字压浅底取值实测低于正文线（换色的理由留在证据里）', () => {
        expect(contrast('#fdc700', SAND)).toBeLessThan(4.5); // yellow-400
        expect(contrast('#ffdf20', SAND)).toBeLessThan(4.5); // yellow-300
        expect(contrast('#ffffff', SAND)).toBeLessThan(4.5); // 白字压沙底
        expect(contrast('#fca5a5', SAND)).toBeLessThan(4.5); // red-300
    });
});
