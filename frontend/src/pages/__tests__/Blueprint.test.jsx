import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Blueprint from '../Blueprint';

// R57（PLAN §8.89）Blueprint 红字收尾 —— 本批经拍板解锁该文件的「不碰」硬约束，只改字色。
//
// 处境实查（2026-10-08）：
//   ① 死码：全仓 grep `Blueprint` 只命中本文件定义 + 文档留档（README / PROJECT_HANDOVER
//      的「有意保留的未接线遗留代码」清单），无路由、无任何 import、无既有测试；
//   ② 接线断口：Blueprint 给 Canvas 传 `items` / `setItems`，而 Canvas 形参是
//      lanes / onSelect / selectedId …，`items` 不在签名里 → 画布恒空、块点不中 →
//      selectedId 恒 null → 右侧属性面板（含删除按钮）**真实渲染不可达**。
// 故字色断言走源码静态断言（仓内先例：__tests__/semanticTokens.test.js 同样 fs 直读断言），
// 另挂一条最小渲染冒烟当载体，把 ① ② 钉成事实。

// eslint-disable-next-line no-undef -- vitest 提供 __dirname，eslint globals.browser 未声明
const SOURCE = fs.readFileSync(path.resolve(__dirname, '../Blueprint.jsx'), 'utf8');
const deleteButtonClass = SOURCE.split('\n').find((line) => line.includes('hover:bg-red-500'));

describe('R57 Blueprint 删除按钮字色（源码静态断言）', () => {
    it('静态字色 = text-warn（压沙底实算 6.38；原 text-red-400 实算 1.94）', () => {
        expect(deleteButtonClass).toBeTruthy();
        expect(deleteButtonClass).toContain('text-warn');
    });

    it('hover 字色 = hover:text-black（压 red-500 实算 #fb2c36 / 5.52；原 hover:text-white 3.81）', () => {
        expect(deleteButtonClass).toContain('hover:text-black');
    });

    it('低对比字色类清零：不带 text-red-400 与 hover:text-white', () => {
        expect(deleteButtonClass).not.toContain('text-red-400');
        expect(deleteButtonClass).not.toContain('hover:text-white');
    });
});

describe('R57 Blueprint 最小渲染冒烟（死码页载体）', () => {
    it('挂载出三区骨架；画布因 items 未接线而恒空（块列表不可达的事实）', () => {
        render(<Blueprint />);
        expect(screen.getByText('ROOT PROTOCOL')).toBeTruthy();
        expect(screen.getByText('选择模块以编辑')).toBeTruthy();
        expect(screen.queryByText('帧头 (HEADER)')).toBeNull();
    });
});
