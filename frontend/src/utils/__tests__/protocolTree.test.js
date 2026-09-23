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
// 命名空间二段导入：injectRefsSigma/computeRefsSigma 系一期新增导出（红测期不拖垮同文件其余断言）
import * as protocolTree from '../protocolTree';

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

// ─── 一期（A4/A5）：refs → 设计期 Σ 回显 ─────────────────────────────────
// 口径：Σ = computeByteOffsets byId 尺寸之和（容器 = Σ 子）；任一 ref 悬空/
// 尺寸未知 → 不注入（Block.jsx:155 维持 "??"）；checksum 卡设计期无真值 →
// 不注入；派生副本，输入 lanes/协议树零改写（存储树只经 PUT 落库）。

describe('computeRefsSigma / injectRefsSigma（refs 设计期 Σ 纯函数）', () => {
    const lenCard = (id, refs, extra = {}) => ({
        id, label: id, type: 'length', byte_length: 1, hex_value: '00',
        parameter_config: { type: 'length', refs },
        ...extra
    });
    const lanesOf = (protocol) => buildProtocolLanes(protocol, ['g']);

    it('Σ 回显：叶子 + 容器 refs → 定宽 hex 注入（2+2=04）', () => {
        const p = proto([
            leaf('h', { byte_length: 2 }),
            cont('g', [leaf('x'), leaf('y')]),
            lenCard('L', ['h', 'g'])
        ]);
        const byId = computeProtocolOffsets(p).byId;
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), byId);
        const card = lanes[0].items.find(i => i.id === 'L');
        expect(card.parameter_config.computedValue).toBe('04');
    });

    it('宽度取卡自身 byte_length（Σ=3 @2B → 0003）', () => {
        const p = proto([
            leaf('h', { byte_length: 2 }),
            leaf('x'),
            lenCard('L', ['h', 'x'], { byte_length: 2 })
        ]);
        const byId = computeProtocolOffsets(p).byId;
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), byId);
        // formatToHex 直出 pretty 口径（决策原文 + 指令页 useInstructionLanes:150
        // 先例：useInstructionLanes.test:82 期望 '00 00 1C 20' 带空格），与
        // Block.jsx:140 原样显示一致；断言核心锚 = 宽度取卡自身 byte_length（2B）。
        expect(lanes[0].items.find(i => i.id === 'L').parameter_config.computedValue).toBe('00 03');
    });

    it('嵌套容器内的 length 卡同样注入（全泳道覆盖）', () => {
        const p = proto([
            leaf('h'),
            cont('g', [leaf('x'), lenCard('L', ['x'])])
        ]);
        const byId = computeProtocolOffsets(p).byId;
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), byId);
        const card = lanes[1].items.find(i => i.id === 'L');
        expect(card.parameter_config.computedValue).toBe('01');
    });

    it('悬空 ref → 不注入（卡维持 "??"，无 computedValue 键）', () => {
        const p = proto([leaf('h'), lenCard('L', ['ghost'])]);
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), computeProtocolOffsets(p).byId);
        expect(lanes[0].items.find(i => i.id === 'L').parameter_config.computedValue).toBeUndefined();
    });

    it('尺寸未知（byte_length 非法 → size null）→ 不注入', () => {
        const p = proto([leaf('bad', { byte_length: 0 }), lenCard('L', ['bad'])]);
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), computeProtocolOffsets(p).byId);
        expect(lanes[0].items.find(i => i.id === 'L').parameter_config.computedValue).toBeUndefined();
    });

    it('空 refs → 不注入', () => {
        const p = proto([leaf('h'), lenCard('L', [])]);
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), computeProtocolOffsets(p).byId);
        expect(lanes[0].items.find(i => i.id === 'L').parameter_config.computedValue).toBeUndefined();
    });

    it('checksum 卡不注入（设计期无真值，维持 "??"）', () => {
        const p = proto([
            leaf('h'),
            { id: 'C', label: 'C', type: 'checksum', byte_length: 1, hex_value: '00',
                parameter_config: { type: 'checksum', refs: ['h'] } }
        ]);
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), computeProtocolOffsets(p).byId);
        expect(lanes[0].items.find(i => i.id === 'C').parameter_config.computedValue).toBeUndefined();
    });

    it('纯函数：输入 lanes 与协议树零改写，注入结果为副本', () => {
        const p = proto([leaf('h', { byte_length: 2 }), lenCard('L', ['h'])]);
        const byId = computeProtocolOffsets(p).byId;
        const lanes = lanesOf(p);
        const before = JSON.stringify(lanes);
        const out = protocolTree.injectRefsSigma(lanes, byId);

        expect(JSON.stringify(lanes)).toBe(before);
        const src = lanes[0].items.find(i => i.id === 'L');
        const dst = out[0].items.find(i => i.id === 'L');
        expect(dst).not.toBe(src);
        expect(src.parameter_config.computedValue).toBeUndefined();
        expect(findNode(p, 'L').parameter_config.computedValue).toBeUndefined();
    });

    it('computeRefsSigma 直调：数值 / null（悬空 + 空 + 无配置）', () => {
        const p = proto([leaf('h', { byte_length: 2 }), cont('g', [leaf('x'), leaf('y')])]);
        const byId = computeProtocolOffsets(p).byId;
        expect(protocolTree.computeRefsSigma({ parameter_config: { refs: ['h', 'g'] } }, byId)).toBe(4);
        expect(protocolTree.computeRefsSigma({ parameter_config: { refs: [] } }, byId)).toBeNull();
        expect(protocolTree.computeRefsSigma({ parameter_config: { refs: ['ghost'] } }, byId)).toBeNull();
        expect(protocolTree.computeRefsSigma({}, byId)).toBeNull();
    });
});
