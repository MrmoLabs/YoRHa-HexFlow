import { describe, it, expect, vi } from 'vitest';
import {
    INSTRUCTION_DATA_OPTION_KEYS,
    normalizeInstructionDataOptions
} from '../instructionDataOptions';

// C7 指令页页面↔hook 契约显式化：选项校验为纯函数，非法输入降级 + 警告，
// 合法输入原样透传（行为不变）。

const normalize = (raw) => {
    const warn = vi.fn();
    return { options: normalizeInstructionDataOptions(raw, warn), warn };
};

describe('normalizeInstructionDataOptions', () => {
    it('已知键清单与文档一致（页面可依赖的完整契约）', () => {
        expect(INSTRUCTION_DATA_OPTION_KEYS).toEqual([
            'instructions',
            'setInstructions',
            'onWebUpdate',
            'fetchInstructions',
            'disableInitialLoad'
        ]);
    });

    it('合法完整对象原样透传（全键返回，值不变）', () => {
        const arr = [{ id: 'i1' }];
        const setInstructions = vi.fn();
        const onWebUpdate = vi.fn();
        const fetchInstructions = vi.fn();

        const { options, warn } = normalize({
            instructions: arr,
            setInstructions,
            onWebUpdate,
            fetchInstructions,
            disableInitialLoad: true
        });

        expect(options).toEqual({
            instructions: arr,
            setInstructions,
            onWebUpdate,
            fetchInstructions,
            disableInitialLoad: true
        });
        expect(warn).not.toHaveBeenCalled();
    });

    it('省略 / null / undefined 归一为全键默认值（自管模式 + 首挂加载）', () => {
        for (const raw of [undefined, null, {}]) {
            const { options, warn } = normalize(raw);
            expect(options).toEqual({
                instructions: null,
                setInstructions: null,
                onWebUpdate: null,
                fetchInstructions: null,
                disableInitialLoad: false
            });
            expect(warn).not.toHaveBeenCalled();
        }
    });

    it('函数式旧参归一为 { onWebUpdate }（legacy 调用形状）', () => {
        const cb = vi.fn();
        const { options, warn } = normalize(cb);

        expect(options.onWebUpdate).toBe(cb);
        expect(options.setInstructions).toBeNull(); // 自管模式
        expect(options.disableInitialLoad).toBe(false); // 首挂仍加载
        expect(warn).not.toHaveBeenCalled();
    });

    it('instructions 非数组 → 丢弃 + 警告（回退内部状态）', () => {
        const { options, warn } = normalize({ instructions: 'not-an-array' });

        expect(options.instructions).toBeNull();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('instructions'));
    });

    it('setInstructions 非函数 → 丢弃 + 警告（回退自管模式，避免后续调用崩溃）', () => {
        const { options, warn } = normalize({ setInstructions: true });

        expect(options.setInstructions).toBeNull();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('setInstructions'));
    });

    it('onWebUpdate / fetchInstructions 非函数 → 丢弃 + 警告', () => {
        const a = normalize({ onWebUpdate: 'cb' });
        expect(a.options.onWebUpdate).toBeNull();
        expect(a.warn).toHaveBeenCalledWith(expect.stringContaining('onWebUpdate'));

        const b = normalize({ fetchInstructions: 42 });
        expect(b.options.fetchInstructions).toBeNull();
        expect(b.warn).toHaveBeenCalledWith(expect.stringContaining('fetchInstructions'));
    });

    it('disableInitialLoad 按真值强转为布尔（truthy 即生效，与原行为一致）', () => {
        expect(normalize({ disableInitialLoad: 1 }).options.disableInitialLoad).toBe(true);
        expect(normalize({ disableInitialLoad: 'yes' }).options.disableInitialLoad).toBe(true);
        expect(normalize({ disableInitialLoad: 0 }).options.disableInitialLoad).toBe(false);
        expect(normalize({ disableInitialLoad: '' }).warn).not.toHaveBeenCalled();
    });

    it('未知键 → 忽略 + 警告（列出已知键）', () => {
        const { options, warn } = normalize({ fetchdata: vi.fn(), disableInitialLoad: true });

        expect(options).not.toHaveProperty('fetchdata');
        expect(options.disableInitialLoad).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('未知选项 "fetchdata"'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('fetchInstructions'));
    });

    it('非对象原始值（字符串/数组）→ 忽略 + 警告，返回默认值', () => {
        const str = normalize('nonsense');
        expect(str.options.disableInitialLoad).toBe(false);
        expect(str.warn).toHaveBeenCalledWith(expect.stringContaining('非对象选项'));

        const arr = normalize([1, 2]);
        expect(arr.options.instructions).toBeNull();
        expect(arr.warn).toHaveBeenCalledWith(expect.stringContaining('非对象选项'));
    });
});
