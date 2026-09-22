import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// C7 指令页页面↔hook 契约显式化：静态锁 Instruction.jsx / InstructionProcessor.jsx
// 解构的每个键必须出现在 useInstructionData 的 return 契约里（反向由 JSDoc 保证）。
// 页面改名/删键或 hook 返回收窄时，这里先红。

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(resolve(here, '../..', p), 'utf8');

// 提取 `const { a, b, c } = useInstructionData(` 的解构键
const extractDestructuredKeys = (code) => {
    const match = code.match(/const\s*\{([\s\S]*?)\}\s*=\s*useInstructionData\(/);
    if (!match) throw new Error('未找到 useInstructionData 解构');
    return match[1]
        .replace(/\/\/[^\n]*/g, '') // 先剥行注释（可跨行粘连键）
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.split(':')[0].trim());
};

// 提取 hook 文件底部 return { ... } 的顶层键
const extractReturnKeys = (code) => {
    const match = code.match(/return\s*\{([\s\S]*?)\};?\s*\}\s*$/);
    if (!match) throw new Error('未找到 useInstructionData return 契约');
    return match[1]
        .replace(/\/\/[^\n]*/g, '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.split(':')[0].trim());
};

describe('页面 ↔ useInstructionData 返回契约', () => {
    const hookKeys = extractReturnKeys(src('hooks/useInstructionData.js'));

    it('hook return 契约非空且含核心键', () => {
        expect(hookKeys.length).toBeGreaterThan(20);
        expect(hookKeys).toContain('instructions');
        expect(hookKeys).toContain('saveChanges');
        expect(hookKeys).toContain('updateLocalInstruction');
    });

    it('Instruction.jsx 解构的键全部由 hook 提供', () => {
        const pageKeys = extractDestructuredKeys(src('pages/Instruction.jsx'));
        expect(pageKeys.length).toBeGreaterThan(15);
        const missing = pageKeys.filter((k) => !hookKeys.includes(k));
        expect(missing).toEqual([]);
    });

    it('InstructionProcessor.jsx 解构的键全部由 hook 提供', () => {
        const pageKeys = extractDestructuredKeys(src('pages/InstructionProcessor.jsx'));
        expect(pageKeys.length).toBeGreaterThan(0);
        const missing = pageKeys.filter((k) => !hookKeys.includes(k));
        expect(missing).toEqual([]);
    });
});
