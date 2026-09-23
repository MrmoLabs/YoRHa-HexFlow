import { describe, it, expect } from 'vitest';
import { mergeProtocolInstruction, buildLanes, getTotalBytes } from '../blockMerge';
// 命名空间二段导入：countSlots 系一期新增导出 —— 红测期不以命名缺失拖垮同文件其余断言
import * as blockMerge from '../blockMerge';
import { InstructionEncoder } from '../InstructionEncoder';

// C5 编排回归：总长度 / 插槽缺失 / 边界结构。
// 口径来自 utils/blockMerge.js 实测：
//  - 注入字段由 normalizeInstructionBlocks 统一挂 `children: []`（叶子，不递归）
//  - 协议块 id 加前缀 p-、指令块 id 加前缀 i-，避免撞 id
//  - 只填第一个 slot；无 slot 时追加到末尾

const shell = (children) => ({ id: 'p1', label: '外壳', type: 'container', children });
const instruction = (fields) => ({ id: 'i1', name: '指令', fields });
const field = (id, name, sequence, byte_length, parent_id = null) => (
    { id, name, sequence, parent_id, byte_length }
);

describe('mergeProtocolInstruction', () => {
    it('应把指令字段注入第一个插槽并标记 isInjected', () => {
        const merged = mergeProtocolInstruction(
            shell([
                { id: 'h', label: '帧头', type: 'fixed', byte_length: 1 },
                { id: 's', label: '槽', type: 'slot', byte_length: 0 },
                { id: 't', label: '帧尾', type: 'fixed', byte_length: 1 }
            ]),
            instruction([field('f1', '命令字', 0, 2)])
        );

        expect(merged.map(b => b.label)).toEqual(['帧头', '命令字', '帧尾']);
        expect(merged[1].isInjected).toBe(true);
        expect(merged[1].children).toEqual([]);
    });

    it('插槽缺失时应把指令字段追加到末尾（fallback），原块顺序不变', () => {
        const merged = mergeProtocolInstruction(
            shell([
                { id: 'h', label: '帧头', type: 'fixed', byte_length: 1 },
                { id: 't', label: '帧尾', type: 'fixed', byte_length: 1 }
            ]),
            instruction([field('f1', '命令字', 0, 2)])
        );

        expect(merged.map(b => b.label)).toEqual(['帧头', '帧尾', '命令字']);
        expect(merged[2].isInjected).toBe(true);
    });

    it('嵌套容器内的插槽也应被识别并注入', () => {
        const merged = mergeProtocolInstruction(
            shell([
                {
                    id: 'grp', label: '组', type: 'container',
                    children: [{ id: 's', label: '内槽', type: 'slot', byte_length: 0 }]
                }
            ]),
            instruction([field('f1', '命令字', 0, 2)])
        );

        expect(merged).toHaveLength(1);
        expect(merged[0].children.map(c => c.label)).toEqual(['命令字']);
    });

    it('多个插槽只填第一个', () => {
        const merged = mergeProtocolInstruction(
            shell([
                { id: 's1', label: '槽1', type: 'slot', byte_length: 0 },
                { id: 's2', label: '槽2', type: 'slot', byte_length: 0 }
            ]),
            instruction([field('f1', '命令字', 0, 2)])
        );

        expect(merged.map(b => b.label)).toEqual(['命令字', '槽2']);
    });

    it('协议/指令任一缺失时应退化为安全 no-op', () => {
        expect(mergeProtocolInstruction(undefined, instruction([field('f1', 'a', 0, 1)]))).toEqual([]);
        expect(mergeProtocolInstruction(shell([{ id: 'h', label: '帧头', type: 'fixed' }]), undefined))
            .toEqual([expect.objectContaining({ id: 'p-h' })]);
    });

    it('协议块与字段撞 id 时应加前缀区分', () => {
        const merged = mergeProtocolInstruction(
            shell([{ id: 'f1', label: '协议块', type: 'fixed', byte_length: 1 }]),
            instruction([field('f1', '同名字段', 0, 2)])
        );

        expect(merged.map(b => b.id)).toEqual(['p-f1', 'i-f1']);
    });

    it('父字段结构应保留 parent_id 归属（子字段挂父下）', () => {
        const merged = mergeProtocolInstruction(
            shell([{ id: 's', label: '槽', type: 'slot', byte_length: 0 }]),
            instruction([
                field('f1', '父字段', 0, 1),
                field('f2', '子字段', 1, 2, 'f1')
            ])
        );

        expect(merged.map(b => b.label)).toEqual(['父字段']);
        expect(merged[0].children.map(c => c.label)).toEqual(['子字段']);
    });

    it('空协议 + 空指令应返回空数组', () => {
        expect(mergeProtocolInstruction(shell([]), instruction([]))).toEqual([]);
    });
});

describe('getTotalBytes（C5 总长度回归）', () => {
    it('叶子字节直接累加；注入字段的 children:[] 是叶子不得递归', () => {
        // 回归锁：历史实现把 children:[] 当容器递归，载荷计 0
        const merged = mergeProtocolInstruction(
            shell([
                { id: 'h', label: '帧头', type: 'fixed', byte_length: 2 },
                { id: 's', label: '槽', type: 'slot', byte_length: 0 },
                { id: 't', label: '帧尾', type: 'fixed', byte_length: 1 }
            ]),
            instruction([
                field('f1', '命令字', 0, 4),
                field('f2', '参数', 1, 8)
            ])
        );

        expect(getTotalBytes(merged)).toBe(2 + 4 + 8 + 1);
    });

    it('容器按子块求和，容器自身 byte_length 不重复计入', () => {
        const total = getTotalBytes([
            {
                id: 'c', label: '容器', byte_length: 99,
                children: [
                    { id: 'a', byte_length: 3 },
                    { id: 'b', byte_length: 5 }
                ]
            }
        ]);

        expect(total).toBe(8);
    });

    it('缺 byte_length 的块按 0 计，不得崩溃', () => {
        expect(getTotalBytes([{ id: 'x', label: '无长度' }])).toBe(0);
        expect(getTotalBytes([{ id: 'y', byte_length: undefined }])).toBe(0);
        expect(getTotalBytes([])).toBe(0);
    });

    it('嵌套容器逐层求和', () => {
        const total = getTotalBytes([
            {
                id: 'outer', children: [
                    { id: 'inner', children: [{ id: 'deep', byte_length: 7 }] },
                    { id: 'sib', byte_length: 2 }
                ]
            }
        ]);

        expect(total).toBe(9);
    });

    it('E1-5: repeat 组 — FIXED 按 Σ×N 计入，DYNAMIC 按 ×1 下限', () => {
        const group = (repeat_type, repeat_count) => ({
            id: 'g', byte_length: 0, repeat_type, repeat_count,
            children: [{ id: 'a', byte_length: 2 }, { id: 'b', byte_length: 1 }],
        });
        expect(getTotalBytes([group('FIXED', 3)])).toBe(9);   // (2+1)×3
        expect(getTotalBytes([group('FIXED', 1)])).toBe(3);   // 现状回归
        expect(getTotalBytes([group('FIXED', 0)])).toBe(0);   // 0 份
        expect(getTotalBytes([group('FIXED', 'x')])).toBe(3); // 防御 → ×1
        expect(getTotalBytes([group('DYNAMIC', null)])).toBe(3); // 运行时未知 → ×1 下限
        expect(getTotalBytes([group('NONE', 1)])).toBe(3);
    });
});

describe('buildLanes（边界结构）', () => {
    it('空结构应产出单条根泳道', () => {
        const lanes = buildLanes([]);

        expect(lanes).toHaveLength(1);
        expect(lanes[0].parentName).toBe('ROOT SEQUENCE');
        expect(lanes[0].items).toEqual([]);
    });

    it('有子块的容器应展开为子泳道并带 parentId/depth', () => {
        const lanes = buildLanes([
            { id: 'grp', label: '组', children: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }] },
            { id: 'flat', label: '平铺块' }
        ]);

        expect(lanes.map(l => `${l.parentName}:${l.items.length}`)).toEqual([
            'ROOT SEQUENCE:2',
            '组:2'
        ]);
        expect(lanes[1].parentId).toBe('grp');
        expect(lanes[1].depth).toBe(1);
    });

    it('children 为空数组的叶子不得展开子泳道', () => {
        const lanes = buildLanes([{ id: 'f', label: '字段', children: [] }]);

        expect(lanes).toHaveLength(1);
    });
});

// ─── 一期（R1/B1/A8）：refs 引用 + 帧级合并 ───────────────────────────────
// 语义基线：洞号 = 同协议绑定按 slot_order 升序的位次（稠密位次）——
// 指令数组序即洞序；洞未填保留 slot（发射归零）；洞不够 append 末尾。

describe('B1 数组合并（同协议多洞 · 稠密位次指令序）', () => {
    it('两条指令按洞序填两个 slot', () => {
        const merged = mergeProtocolInstruction(
            shell([
                { id: 's1', label: '槽1', type: 'slot', byte_length: 0 },
                { id: 's2', label: '槽2', type: 'slot', byte_length: 0 }
            ]),
            [
                instruction([field('f1', '甲', 0, 2)]),
                instruction([field('f2', '乙', 1, 4)])
            ]
        );

        expect(merged.map(b => b.label)).toEqual(['甲', '乙']);
        expect(merged.every(b => b.isInjected)).toBe(true);
    });

    it('嵌套容器内的 slot 参与 DFS 洞序（跨层枚举）', () => {
        const merged = mergeProtocolInstruction(
            shell([
                { id: 's1', label: '槽1', type: 'slot', byte_length: 0 },
                {
                    id: 'grp', label: '组', type: 'container',
                    children: [{ id: 's2', label: '槽2', type: 'slot', byte_length: 0 }]
                }
            ]),
            [
                instruction([field('f1', '甲', 0, 2)]),
                instruction([field('f2', '乙', 1, 4)])
            ]
        );

        expect(merged.map(b => b.label)).toEqual(['甲', '组']);
        expect(merged[1].children.map(c => c.label)).toEqual(['乙']);
    });

    it('指令多于洞：溢出追加到末尾（沿用 append fallback）', () => {
        const merged = mergeProtocolInstruction(
            shell([
                { id: 's1', label: '槽1', type: 'slot', byte_length: 0 },
                { id: 't', label: '帧尾', type: 'fixed', byte_length: 1 }
            ]),
            [
                instruction([field('f1', '甲', 0, 2)]),
                instruction([field('f2', '乙', 1, 4)])
            ]
        );

        expect(merged.map(b => b.label)).toEqual(['甲', '帧尾', '乙']);
    });

    it('指令少于洞：未填 slot 保留（type=slot，发射层归零）', () => {
        const merged = mergeProtocolInstruction(
            shell([
                { id: 's1', label: '槽1', type: 'slot', byte_length: 0 },
                { id: 's2', label: '槽2', type: 'slot', byte_length: 1 }
            ]),
            [instruction([field('f1', '甲', 0, 2)])]
        );

        expect(merged.map(b => b.label)).toEqual(['甲', '槽2']);
        expect(merged[1].type).toBe('slot');
    });

    it('空数组 = 未传指令（协议克隆原样返回）', () => {
        expect(mergeProtocolInstruction(shell([{ id: 'h', label: '帧头', type: 'fixed' }]), []))
            .toEqual([expect.objectContaining({ id: 'p-h' })]);
    });
});

describe('A8 cloneBlocks refs 前缀化（合并树 id 失配修复）', () => {
    it('协议块 parameter_config.refs 加 p- 前缀', () => {
        const merged = mergeProtocolInstruction(
            shell([
                { id: 'h', label: '帧头', type: 'fixed', byte_length: 1 },
                {
                    id: 'len', label: 'LEN', type: 'length', byte_length: 2,
                    parameter_config: { type: 'length', refs: ['h'] }
                }
            ]),
            instruction([field('f1', '命令字', 0, 2)])
        );

        const len = merged.find(b => b.id === 'p-len');
        expect(len.parameter_config.refs).toEqual(['p-h']);
    });

    it('指令字段 parameter_config.refs 加 i- 前缀（注入侧同规则）', () => {
        const merged = mergeProtocolInstruction(
            shell([{ id: 's', label: '槽', type: 'slot', byte_length: 0 }]),
            {
                id: 'i1', name: '指令',
                fields: [
                    field('f1', '命令字', 0, 2),
                    { ...field('f2', '校验', 1, 1), parameter_config: { type: 'checksum', refs: ['f1'] } }
                ]
            }
        );

        const ck = merged.find(b => b.label === '校验');
        expect(ck.parameter_config.refs).toEqual(['i-f1']);
    });

    it('前缀化 refs 命中合并树 id：length Σ 经 resolveDependencies 解出', () => {
        const merged = mergeProtocolInstruction(
            shell([
                { id: 'h', label: '帧头', type: 'fixed', byte_length: 1 },
                { id: 's', label: '槽', type: 'slot', byte_length: 0 },
                {
                    id: 'len', label: 'LEN', type: 'length', byte_length: 1,
                    parameter_config: { type: 'length', refs: ['h'] }
                }
            ]),
            instruction([field('f1', '命令字', 0, 3)])
        );

        const computed = InstructionEncoder.resolveDependencies({ blocks: merged }, {});
        expect(computed['p-len']).toBe(1); // p-h = 1B；无前缀化时查无 p-h → 0
    });
});

describe('countSlots（洞数统计 · 供 B3 洞位不足/空洞警告）', () => {
    it('DFS 统计嵌套 slot', () => {
        expect(blockMerge.countSlots([
            { id: 's1', type: 'slot' },
            {
                id: 'grp', type: 'container',
                children: [{ id: 's2', type: 'slot' }, { id: 'x', type: 'fixed' }]
            },
            { id: 'y', type: 'fixed' }
        ])).toBe(2);
    });

    it('空/无 slot/缺入参 → 0', () => {
        expect(blockMerge.countSlots([])).toBe(0);
        expect(blockMerge.countSlots([{ id: 'x', type: 'fixed', children: [] }])).toBe(0);
        expect(blockMerge.countSlots(undefined)).toBe(0);
    });
});

describe('getTotalBytes slot 归零（发射层同口径）', () => {
    it('未填 slot 不计字节（即便带 byte_length）', () => {
        expect(getTotalBytes([
            { id: 'h', byte_length: 1 },
            { id: 's', type: 'slot', byte_length: 1 },
            { id: 't', byte_length: 1 }
        ])).toBe(2);
    });
});
