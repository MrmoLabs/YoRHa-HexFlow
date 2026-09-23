import { describe, it, expect } from 'vitest';
import {
    findNode,
    computeProtocolOffsets,
    buildProtocolLanes,
    moveNode,
    removeNode,
    updateNode,
    collectContainerIds
} from '../protocolTree';

// 构造器：children 树的最小持久化形状（A+B 批协议页内联展开的纯函数层）
const leaf = (id, extra = {}) => ({ id, label: id, type: 'fixed', byte_length: 1, hex_value: '00', ...extra });
const cont = (id, children = [], label) => ({ id, label: label || id, type: 'container', byte_length: 0, children });
const proto = (children, label = 'P') => ({ id: 'root', label, type: 'container', children });
const tree = () => proto([
    leaf('a'),
    cont('g', [leaf('b'), leaf('c')]),
    leaf('d')
]);

describe('buildProtocolLanes（useInstructionLanes.buildLanes 的树版）', () => {
    it('null 协议 → []; 无展开 → 仅根泳道（DFS 序）', () => {
        expect(buildProtocolLanes(null, [])).toEqual([]);
        const lanes = buildProtocolLanes(proto([leaf('a'), cont('g', [leaf('b')])]), []);
        expect(lanes).toHaveLength(1);
        expect(lanes[0]).toMatchObject({ depth: 0, parentId: null, parentName: 'P' });
        expect(lanes[0].items.map(i => i.id)).toEqual(['a', 'g']);
    });

    it('展开容器 → 子泳道（parentId/parentName/depth），嵌套逐层，未展开不出孙泳道', () => {
        const deep = proto([cont('g1', [leaf('b1'), cont('g2', [leaf('b2')])], '外组')]);
        const lanes = buildProtocolLanes(deep, ['g1', 'g2']);
        expect(lanes.map(l => `${l.depth}:${l.parentId}`)).toEqual(['0:null', '1:g1', '2:g2']);
        expect(lanes[1].parentName).toBe('外组');
        expect(buildProtocolLanes(deep, ['g1'])).toHaveLength(2);
    });

    it('缺 label 回退 ROOT SEQUENCE / GROUP', () => {
        const noLabel = { id: 'root', type: 'container', children: [{ id: 'g', type: 'container', children: [] }] };
        const lanes = buildProtocolLanes(noLabel, ['g']);
        expect(lanes[0].parentName).toBe('ROOT SEQUENCE');
        expect(lanes[1].parentName).toBe('GROUP');
    });
});

describe('computeProtocolOffsets（children 树 → computeByteOffsets 适配）', () => {
    it('叶子按数组序给偏移与尺寸，total 精确', () => {
        const { byId, total, exact } = computeProtocolOffsets(proto([
            leaf('a', { byte_length: 2 }),
            leaf('b', { byte_length: 1 })
        ]));
        expect(byId.get('a')).toEqual({ offset: 0, size: 2, isGroup: false });
        expect(byId.get('b')).toEqual({ offset: 2, size: 1, isGroup: false });
        expect(total).toBe(3);
        expect(exact).toBe(true);
    });

    it('容器判组：Σ 子尺寸 + isGroup，子偏移从容器起点展开', () => {
        const { byId, total } = computeProtocolOffsets(proto([
            cont('g', [leaf('x', { byte_length: 2 }), leaf('y', { byte_length: 1 })]),
            leaf('z', { byte_length: 1 })
        ]));
        expect(byId.get('g')).toEqual({ offset: 0, size: 3, isGroup: true });
        expect(byId.get('x')).toEqual({ offset: 0, size: 2, isGroup: false });
        expect(byId.get('y').offset).toBe(2);
        expect(byId.get('z')).toEqual({ offset: 3, size: 1, isGroup: false });
        expect(total).toBe(4);
    });

    it('空容器 = 已知 0B 组，不污染后续偏移（z 紧贴起点）', () => {
        const { byId, total, exact } = computeProtocolOffsets(proto([
            cont('g', []),
            leaf('z', { byte_length: 1 })
        ]));
        expect(byId.get('g')).toEqual({ offset: 0, size: 0, isGroup: true });
        expect(byId.get('z')).toEqual({ offset: 0, size: 1, isGroup: false });
        expect(total).toBe(1);
        expect(exact).toBe(true);
    });

    it('字节数非法叶子 → 未知尺寸（组链降级 null、exact=false）', () => {
        const { byId, exact } = computeProtocolOffsets(proto([
            cont('g', [leaf('bad', { byte_length: 0 })])
        ]));
        expect(byId.get('bad').size).toBeNull();
        expect(byId.get('g').size).toBeNull();
        expect(exact).toBe(false);
    });

    it('null 协议 → 空结果不抛', () => {
        expect(computeProtocolOffsets(null).byId.size).toBe(0);
    });
});

describe('moveNode（moveField 树版 + 环守卫）', () => {
    it('同层重排（先摘后插 = arrayMove）', () => {
        const next = moveNode(tree(), 'a', null, 2);
        expect(next.children.map(n => n.id)).toEqual(['g', 'd', 'a']);
    });

    it('跨层移入容器（目标层显示序），源层同步收缩', () => {
        const next = moveNode(tree(), 'a', 'g', 1);
        expect(findNode(next, 'g').children.map(n => n.id)).toEqual(['b', 'a', 'c']);
        expect(next.children.map(n => n.id)).toEqual(['g', 'd']);
    });

    it('从容器移回根', () => {
        const next = moveNode(tree(), 'b', null, 0);
        expect(next.children.map(n => n.id)).toEqual(['b', 'a', 'g', 'd']);
        expect(findNode(next, 'g').children.map(n => n.id)).toEqual(['c']);
    });

    it('index 越界收敛（负数置 0、超长置末尾）', () => {
        expect(moveNode(tree(), 'a', null, -5).children[0].id).toBe('a');
        expect(moveNode(tree(), 'a', null, 99).children.map(n => n.id)).toEqual(['g', 'd', 'a']);
    });

    it('环守卫：目标是自身或子孙 → 原引用（树成环 = 栈溢出冻结，必须拒收）', () => {
        const t = tree();
        expect(moveNode(t, 'g', 'g', 0)).toBe(t);
        expect(moveNode(t, 'g', 'b', 0)).toBe(t);
    });

    it('源缺失 / 目标缺失 / 目标非容器 → 原引用早退', () => {
        const t = tree();
        expect(moveNode(t, 'nope', null, 0)).toBe(t);
        expect(moveNode(t, 'a', 'nope', 0)).toBe(t);
        expect(moveNode(t, 'a', 'b', 0)).toBe(t);
    });

    it('纯函数：输入树不被改写', () => {
        const t = tree();
        moveNode(t, 'a', 'g', 0);
        expect(t.children.map(n => n.id)).toEqual(['a', 'g', 'd']);
        expect(findNode(t, 'g').children.map(n => n.id)).toEqual(['b', 'c']);
    });
});

describe('removeNode / updateNode / collectContainerIds', () => {
    it('删容器 = 子树整体剪除（对齐指令页级联删除效果）', () => {
        const next = removeNode(tree(), 'g');
        expect(next.children.map(n => n.id)).toEqual(['a', 'd']);
        expect(findNode(next, 'b')).toBeNull();
        // 输入未动
        expect(tree().children.map(n => n.id)).toEqual(['a', 'g', 'd']);
    });

    it('深层按 id 打补丁，原树不受影响', () => {
        const next = updateNode(tree(), 'c', { label: 'C2' });
        expect(findNode(next, 'c').label).toBe('C2');
        expect(findNode(tree(), 'c').label).toBe('c');
    });

    it('collectContainerIds：嵌套容器全量预序收集（切协议默认全展开用）', () => {
        expect(collectContainerIds(tree())).toEqual(['g']);
        expect(collectContainerIds(proto([cont('g1', [cont('g2', [])])]))).toEqual(['g1', 'g2']);
        expect(collectContainerIds(null)).toEqual([]);
    });
});
