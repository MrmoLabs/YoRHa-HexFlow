import { describe, it, expect } from 'vitest';
import { buildBindingMatrix, findSlotNode, protocolCellText, slotCellText } from '../bindingMatrix';

// 批次四 4b：绑定矩阵纯函数 —— 指令 → 默认协议 → 槽位。
// 锁形点：排序、默认/其它分栏、孤儿关系（协议已删 / 槽悬空）不静默、
// stale 只认 true、summary 计数（含重复默认）、两格文案。

const PROTOCOLS = [
    {
        id: 'p-shell',
        label: '协议外壳',
        children: [
            { id: 'head', label: '帧头', type: 'fixed', byte_length: 2 },
            { id: 'slot-a', label: '外壳槽 A', type: 'slot' },
            {
                id: 'grp', label: '容器', type: 'container',
                children: [{ id: 'slot-b', label: '内层槽 B', type: 'slot' }]
            }
        ]
    },
    { id: 'p-empty', label: '空协议', children: [] }
];

const INSTRUCTIONS = [
    { id: 'i-b', code: 'DEMO-002', name: '状态包', device_code: 'DEMO-DEV' },
    { id: 'i-a', code: 'DEMO-001', name: '心跳帧', device_code: 'DEMO-DEV' },
    { id: 'i-z', code: 'ZZZ-001', name: '别的设备', device_code: 'Z-DEV' }
];

describe('findSlotNode', () => {
    it('递归找 type=slot 节点，非 slot 同 id 不认', () => {
        expect(findSlotNode(PROTOCOLS[0].children, 'slot-a').label).toBe('外壳槽 A');
        expect(findSlotNode(PROTOCOLS[0].children, 'slot-b').label).toBe('内层槽 B'); // 容器内
        expect(findSlotNode(PROTOCOLS[0].children, 'head')).toBeNull();              // fixed 不算
        expect(findSlotNode(PROTOCOLS[0].children, 'nope')).toBeNull();
        expect(findSlotNode(null, 'slot-a')).toBeNull();
        expect(findSlotNode(PROTOCOLS[0].children, null)).toBeNull();
    });
});

describe('buildBindingMatrix', () => {
    it('按 device_code → code 排序，每行一条指令（含零绑定）', () => {
        const { rows, summary } = buildBindingMatrix(INSTRUCTIONS, [], PROTOCOLS);
        expect(rows.map((r) => r.id)).toEqual(['i-a', 'i-b', 'i-z']); // DEMO-DEV 两行在前
        expect(summary).toMatchObject({ instructions: 3, bindings: 0, withDefault: 0, unbound: 3 });
    });

    it('默认格与其它格分栏（is_default 布尔/0/1 都认），槽位取节点标签', () => {
        const bindings = [
            { id: 'b1', protocol_id: 'p-shell', instruction_id: 'i-a', label: '主',
                slot_order: 0, slot_id: 'slot-a', is_default: 1, stale: null },
            { id: 'b2', protocol_id: 'p-shell', instruction_id: 'i-a', label: '副',
                slot_order: 2, slot_id: 'grp', is_default: 0, stale: false },
            { id: 'b0', protocol_id: 'p-shell', instruction_id: 'i-a', label: '早',
                slot_order: 1, slot_id: null, is_default: false, stale: true }
        ];
        const { rows } = buildBindingMatrix(INSTRUCTIONS, bindings, PROTOCOLS);
        const row = rows.find((r) => r.id === 'i-a');

        expect(row.defaultBinding.id).toBe('b1');
        expect(row.defaultBinding.slotLabel).toBe('外壳槽 A');
        expect(row.defaultBinding.stale).toBe(false); // null 不亮
        expect(row.others.map((c) => c.id)).toEqual(['b0', 'b2']); // 按 slot_order 排
        expect(row.others[0].slotOrder).toBe(1);                   // 无显式槽 → 位次
        expect(row.others[1].slotMissing).toBe(true);              // 'grp' 非 slot 节点
        expect(row.others[0].stale).toBe(true);                    // true 才亮
    });

    it('孤儿关系不静默：协议已删 → protocolMissing；槽悬空 → slotMissing', () => {
        const bindings = [
            { id: 'b-orphan', protocol_id: 'p-gone', instruction_id: 'i-z', label: 'x',
                slot_order: 0, slot_id: 'slot-a', is_default: true, stale: null },
            { id: 'b-noslot', protocol_id: 'p-empty', instruction_id: 'i-z', label: 'y',
                slot_order: 1, slot_id: 'slot-a', is_default: false, stale: null }
        ];
        const { rows, summary } = buildBindingMatrix(INSTRUCTIONS, bindings, PROTOCOLS);
        const row = rows.find((r) => r.id === 'i-z');

        expect(row.defaultBinding.protocolMissing).toBe(true);
        expect(row.defaultBinding.slotMissing).toBe(true);   // 协议都没了 → 槽必然找不到
        expect(row.others[0].protocolMissing).toBe(false);   // p-empty 存在
        expect(row.others[0].slotMissing).toBe(true);        // 空协议无此槽
        expect(summary.missingProtocols).toBe(1);
        expect(summary.danglingSlots).toBe(2);
        expect(summary.bindings).toBe(2);
        expect(summary.withDefault).toBe(1);
    });

    it('重复默认标出 extraDefaults（脏数据不吞）', () => {
        const bindings = [
            { id: 'd1', protocol_id: 'p-shell', instruction_id: 'i-a', label: 'a',
                slot_order: 0, is_default: true },
            { id: 'd2', protocol_id: 'p-empty', instruction_id: 'i-a', label: 'b',
                slot_order: 1, is_default: 1 }
        ];
        const { rows, summary } = buildBindingMatrix(INSTRUCTIONS, bindings, PROTOCOLS);
        const row = rows.find((r) => r.id === 'i-a');
        expect(row.extraDefaults).toBe(1);           // 取排序最后一条作代表格
        expect(row.defaultBinding.id).toBe('d2');
        expect(summary.extraDefaults).toBe(1);
    });

    it('空入参不炸（三读失败/空库降级）', () => {
        const { rows, summary } = buildBindingMatrix(undefined, undefined, undefined);
        expect(rows).toEqual([]);
        expect(summary.instructions).toBe(0);
    });
});

describe('格文案', () => {
    it('槽位格：显式槽 → 标签 / 悬空 id；无显式槽 → 按序位次；无绑定 → —', () => {
        expect(slotCellText(null)).toBe('—');
        expect(slotCellText({ slotId: 's', slotLabel: '外壳槽 A', slotMissing: false, slotOrder: 0 }))
            .toBe('外壳槽 A');
        expect(slotCellText({ slotId: 's', slotLabel: null, slotMissing: true, slotOrder: 0 }))
            .toBe('悬空 s');
        expect(slotCellText({ slotId: null, slotOrder: 3 })).toBe('按序 3');
    });

    it('协议格：存在 → 标签；已删 →（协议已删）+ id；无绑定 → —', () => {
        expect(protocolCellText(null)).toBe('—');
        expect(protocolCellText({ protocolMissing: false, protocolLabel: '协议外壳', protocolId: 'p' }))
            .toBe('协议外壳');
        expect(protocolCellText({ protocolMissing: true, protocolLabel: null, protocolId: 'p-gone' }))
            .toBe('（协议已删）p-gone');
    });
});
