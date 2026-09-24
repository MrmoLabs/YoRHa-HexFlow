import { describe, it, expect } from 'vitest';
import { ChecksumAlgo, calculateChecksum, formatToHex } from '../formula';
import {
    findNode,
    computeProtocolOffsets,
    buildProtocolLanes,
    moveNode,
    removeNode,
    updateNode,
    collectContainerIds,
    findAncestors,
    duplicateNode,
    buildDuplicateProtocolPayload
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

    // 批次一 P0-2: 剪枝必须级联剥离其他块指向被删 id 的 refs，否则落库时
    // 后端 _validate_refs 400 "refs target not found"，整树卡保存无从定位。
    it('级联剥 refs：指向被删叶块的引用移除，无关引用保留，输入树零改写', () => {
        const len = (id, refs) => ({
            id, label: id, type: 'length', byte_length: 1, hex_value: '00',
            parameter_config: { type: 'length', refs }
        });
        const t = proto([leaf('a'), leaf('b'), len('L', ['a', 'b'])]);
        const next = removeNode(t, 'a');
        expect(findNode(next, 'a')).toBeNull();
        expect(findNode(next, 'L').parameter_config.refs).toEqual(['b']);
        expect(findNode(t, 'L').parameter_config.refs).toEqual(['a', 'b']);
    });

    it('级联剥 refs：删容器时对子孙的引用一并移除（悬空源头 = 整个子树）', () => {
        const len = (id, refs) => ({
            id, label: id, type: 'length', byte_length: 1, hex_value: '00',
            parameter_config: { type: 'length', refs }
        });
        const t = proto([
            leaf('x'),
            cont('g', [leaf('z')]),
            len('L', ['x', 'g', 'z']) // g 与子孙 z 同批失效
        ]);
        const next = removeNode(t, 'g');
        expect(findNode(next, 'L').parameter_config.refs).toEqual(['x']);
        expect(findNode(next, 'z')).toBeNull();
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

    // 批次二: 校验清单点击定位用 —— 只取目标的容器祖先链（外→内），
    // 定位时并入 expandedContainerIds 即让深层块可见而不打扰其余折叠态。
    it('findAncestors：返回目标的容器祖先链（外→内），叶块顶层 / 目标不存在 / null → 空', () => {
        expect(findAncestors(tree(), 'b')).toEqual(['g']); // g 内叶块
        expect(findAncestors(tree(), 'a')).toEqual([]);    // 顶层叶块（根泳道恒在场）
        expect(findAncestors(tree(), 'g')).toEqual([]);    // 容器自身：祖先仅根（不入链）
        expect(findAncestors(proto([cont('g1', [cont('g2', [leaf('x')])])]), 'x')).toEqual(['g1', 'g2']);
        expect(findAncestors(tree(), 'ghost')).toEqual([]); // 不存在
        expect(findAncestors(null, 'a')).toEqual([]);
    });
});

// ─── 批次三（P1-1/P1-2）：协议级 / 块级复制 ───────────────────────────────
// 双语义分野（镜像 duplicateInstruction.js）：协议级 refs 自含重映射 +
// 丢悬空（防 POST 400）；块级 refs 保持指原块（un-wired，文档化口径）。
describe('duplicateNode / buildDuplicateProtocolPayload（复制双语义）', () => {
    const counter = (prefix) => {
        let n = 0;
        return () => `${prefix}-${++n}`;
    };
    const len = (id, refs, label) => ({
        id, label: label || id, type: 'length', byte_length: 2, hex_value: '00',
        parameter_config: { type: 'length', refs }
    });

    it('duplicateNode：子树全新 id、插源块之后、根标签同层 _N 防撞、输入树零改写', () => {
        const t = proto([
            leaf('a', { label: '甲' }),
            cont('g', [leaf('b', { label: '乙' })], '组'),
            len('L', ['a'], 'L')
        ]);
        const gen = counter('n');
        const result = duplicateNode(t, 'g', gen);

        expect(result).not.toBeNull();
        // 顶层插源后：a, g, COPY, L
        expect(result.root.children.map(x => x.id)).toEqual(['a', 'g', result.copyId, 'L']);
        expect(result.copyId).toMatch(/^n-/);
        expect(result.copyId).not.toBe('g');
        // 根标签同层撞名（源占 '组'）→ '组_1'；副本子层另起、后代标签不动
        const copy = result.root.children[2];
        expect(copy.label).toBe('组_1');
        expect(copy.children).toHaveLength(1);
        expect(copy.children[0].id).toMatch(/^n-/);
        expect(copy.children[0].id).not.toBe('b');
        expect(copy.children[0].label).toBe('乙');
        // 输入树零改写（id 序列 / 源标签均原样）
        expect(t.children.map(x => x.id)).toEqual(['a', 'g', 'L']);
        expect(findNode(t, 'g').label).toBe('组');
    });

    it('duplicateNode：refs 保持指向原块（un-wired，含子树内条目）、pc 零别名', () => {
        const t = proto([
            leaf('a', { label: '甲' }),
            len('L', ['a'], 'L'),
            cont('g', [leaf('b', { label: '乙' }), len('L2', ['b'], 'L2')], '组')
        ]);
        // 复制 L：refs ['a'] 的目标不在拷贝子树内 → 若误走 remap-filter 会被丢成 []
        const r1 = duplicateNode(t, 'L', counter('m'));
        const copyL = r1.root.children.find(x => x.id === r1.copyId);
        expect(copyL.label).toBe('L_1');
        expect(copyL.parameter_config.refs).toEqual(['a']); // 仍指原块
        expect(copyL.parameter_config).not.toBe(findNode(t, 'L').parameter_config); // 零别名
        // 复制 g：子树内 L2 的 refs 同样指**原树**的 b（而非副本 b）
        const r2 = duplicateNode(t, 'g', counter('k'));
        const copyG = r2.root.children.find(x => x.id === r2.copyId);
        const copyL2 = copyG.children.find(x => x.type === 'length');
        expect(copyL2.parameter_config.refs).toEqual(['b']);
        expect(copyG.children.map(x => x.id)).not.toContain('b');
    });

    it('duplicateNode：源不存在 / 根自身 id → null（根复制走协议级入口）', () => {
        const t = proto([leaf('a')]);
        expect(duplicateNode(t, 'ghost', counter('x'))).toBeNull();
        expect(duplicateNode(t, 'root', counter('x'))).toBeNull();
        expect(duplicateNode(null, 'a', counter('x'))).toBeNull();
    });

    it('buildDuplicateProtocolPayload：label (副本) 升序防撞 + 整树新 id + refs 自含重映射', () => {
        const source = {
            id: 'root', label: '主协议', type: 'container', description: '外壳',
            children: [
                leaf('h', { label: '头', byte_length: 2, hex_value: 'FA FA' }),
                len('L', ['h', 'ghost'], '长度')
            ]
        };
        const existing = [{ label: '主协议 (副本)' }, { label: '主协议 (副本2)' }];
        const payload = buildDuplicateProtocolPayload(source, existing, counter('p'));

        expect(payload.id).toMatch(/^p-/);
        expect(payload.id).not.toBe('root');
        expect(payload.label).toBe('主协议 (副本3)'); // 1、2 已占 → 升序到 3
        expect(payload.type).toBe('container');
        expect(payload.description).toBe('外壳');
        // 整树新 id（含全部子孙 → 与源永不撞主键）
        payload.children.forEach(c => expect(c.id).toMatch(/^p-/));
        // refs 自含：h → 副本头新 id（存在于副本树内）；ghost 悬空条目丢弃
        const copyL = payload.children.find(c => c.type === 'length');
        expect(copyL.parameter_config.refs).toHaveLength(1);
        expect(copyL.parameter_config.refs[0]).not.toBe('h');
        expect(payload.children.some(c => c.id === copyL.parameter_config.refs[0])).toBe(true);
        // 输入零改写
        expect(source.children[1].parameter_config.refs).toEqual(['h', 'ghost']);
        // 首次复制无撞名 → 'X (副本)'
        const first = buildDuplicateProtocolPayload(
            { id: 'r2', label: 'A', type: 'container', children: [] }, [], counter('q')
        );
        expect(first.label).toBe('A (副本)');
        expect(first.id).toMatch(/^q-/);
    });
});

// ─── 一期（A4/A5）：refs → 设计期 Σ 回显 ─────────────────────────────────
// 口径：Σ = computeByteOffsets byId 尺寸之和（容器 = Σ 子）；任一 ref 悬空/
// 尺寸未知 → 不注入（Block.jsx displayValue 维持按字节等量 "??"）；checksum
// 卡设计期无真值 → 不注入；注入为十进制 `${sigma}B`；派生副本，输入 lanes/
// 协议树零改写（存储树只经 PUT 落库）。

describe('computeRefsSigma / injectRefsSigma（refs 设计期 Σ 纯函数）', () => {
    const lenCard = (id, refs, extra = {}) => ({
        id, label: id, type: 'length', byte_length: 1, hex_value: '00',
        parameter_config: { type: 'length', refs },
        ...extra
    });
    const lanesOf = (protocol) => buildProtocolLanes(protocol, ['g']);

    it('Σ 回显：叶子 + 容器 refs → 十进制注入（2+2=4B）', () => {
        const p = proto([
            leaf('h', { byte_length: 2 }),
            cont('g', [leaf('x'), leaf('y')]),
            lenCard('L', ['h', 'g'])
        ]);
        const byId = computeProtocolOffsets(p).byId;
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), byId);
        const card = lanes[0].items.find(i => i.id === 'L');
        expect(card.parameter_config.computedValue).toBe('4B');
    });

    it('十进制直出：Σ=3 → 3B（长度是数量；byte_length 不再参与值显示）', () => {
        const p = proto([
            leaf('h', { byte_length: 2 }),
            leaf('x'),
            lenCard('L', ['h', 'x'], { byte_length: 2 })
        ]);
        const byId = computeProtocolOffsets(p).byId;
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), byId);
        // 决策：长度值十进制 `${sigma}B` 直出（hex `00 03` 会被读成字节内容）。
        // 卡自身 byte_length 现只驱动卡片宽度/页脚（Block extentBytes/footer +
        // 偏移标尺），不再改写 computedValue 形状。
        expect(lanes[0].items.find(i => i.id === 'L').parameter_config.computedValue).toBe('3B');
    });

    it('嵌套容器内的 length 卡同样注入（全泳道覆盖）', () => {
        const p = proto([
            leaf('h'),
            cont('g', [leaf('x'), lenCard('L', ['x'])])
        ]);
        const byId = computeProtocolOffsets(p).byId;
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), byId);
        const card = lanes[1].items.find(i => i.id === 'L');
        expect(card.parameter_config.computedValue).toBe('1B');
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

    // 人工验证反馈 2（严格口径）：refs 全为可确定内容 → 设计期真值直填；
    // 含 slot / 未配置字面 / 悬空 → 维持等量 ??（不注入）。
    it('checksum 卡：refs 全为字面 fixed → 注入设计期真值（SUM_8 手算可验）', () => {
        const p = proto([
            leaf('h', { hex_value: 'AA 55', byte_length: 2 }),
            { id: 'C', label: 'C', type: 'checksum', byte_length: 1, hex_value: '00',
                parameter_config: { type: 'checksum', refs: ['h'], algorithm: 'SUM_8' } }
        ]);
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), computeProtocolOffsets(p).byId, p);
        // 0xAA + 0x55 = 0xFF → 1B "FF"（手算直钉）
        expect(lanes[0].items.find(i => i.id === 'C').parameter_config.computedValue).toBe('FF');
    });

    it('checksum 卡：缺省算法按 CRC_16_MODBUS（与编码器同源：calculateChecksum 同参）', () => {
        const p = proto([
            leaf('h', { hex_value: 'AA 55', byte_length: 2 }),
            { id: 'C', label: 'C', type: 'checksum', byte_length: 2, hex_value: '00',
                parameter_config: { type: 'checksum', refs: ['h'] } }
        ]);
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), computeProtocolOffsets(p).byId, p);
        const want = formatToHex(calculateChecksum(ChecksumAlgo.CRC_16_MODBUS, [0xAA, 0x55]), 2);
        expect(lanes[0].items.find(i => i.id === 'C').parameter_config.computedValue).toBe(want);
    });

    it('checksum 卡：refs 含 slot → 不注入（发送期内容不可知）', () => {
        const p = proto([
            leaf('h', { hex_value: 'AA', byte_length: 1 }),
            { id: 's', label: 's', type: 'slot', byte_length: 1, hex_value: '00' },
            { id: 'C', label: 'C', type: 'checksum', byte_length: 1, hex_value: '00',
                parameter_config: { type: 'checksum', refs: ['h', 's'], algorithm: 'SUM_8' } }
        ]);
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), computeProtocolOffsets(p).byId, p);
        expect(lanes[0].items.find(i => i.id === 'C').parameter_config.computedValue).toBeUndefined();
    });

    it('checksum 卡：refs 含未配置字面的 fixed（hex_value 空）→ 不注入', () => {
        const p = proto([
            leaf('h', { hex_value: 'AA', byte_length: 1 }),
            leaf('u', { hex_value: '' }),
            { id: 'C', label: 'C', type: 'checksum', byte_length: 1, hex_value: '00',
                parameter_config: { type: 'checksum', refs: ['h', 'u'], algorithm: 'SUM_8' } }
        ]);
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), computeProtocolOffsets(p).byId, p);
        expect(lanes[0].items.find(i => i.id === 'C').parameter_config.computedValue).toBeUndefined();
    });

    it('checksum 卡：refs 悬空 → 不注入（带 root 仍拒）', () => {
        const p = proto([
            leaf('h', { hex_value: 'AA', byte_length: 1 }),
            { id: 'C', label: 'C', type: 'checksum', byte_length: 1, hex_value: '00',
                parameter_config: { type: 'checksum', refs: ['ghost'], algorithm: 'SUM_8' } }
        ]);
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), computeProtocolOffsets(p).byId, p);
        expect(lanes[0].items.find(i => i.id === 'C').parameter_config.computedValue).toBeUndefined();
    });

    it('length 卡：refs 指向含 slot 的容器 → 不注入（嵌套槽令 Σ 发送期才定）', () => {
        const p = proto([
            cont('g', [
                leaf('x', { hex_value: 'AA', byte_length: 2 }),
                { id: 's', label: 's', type: 'slot', byte_length: 1, hex_value: '00', children: [] }
            ]),
            lenCard('L', ['g'])
        ]);
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), computeProtocolOffsets(p).byId, p);
        expect(lanes[0].items.find(i => i.id === 'L').parameter_config.computedValue).toBeUndefined();
    });

    it('容器卡中央值：可确定 checksum 子块出真值（injectContainerContent 带 byId/root）', () => {
        const p = proto([
            leaf('h', { hex_value: 'AA 55', byte_length: 2 }),
            cont('g', [
                leaf('k', { hex_value: 'EE', byte_length: 1 }),
                { id: 'C', label: 'C', type: 'checksum', byte_length: 1, hex_value: '00',
                    parameter_config: { type: 'checksum', refs: ['h'], algorithm: 'SUM_8' } }
            ]),
            leaf('tail', { hex_value: 'ED', byte_length: 1 })
        ]);
        const byId = computeProtocolOffsets(p).byId;
        const lanes = protocolTree.injectContainerContent(
            protocolTree.injectRefsSigma(lanesOf(p), byId, p), byId, p
        );
        expect(lanes[0].items.find(i => i.id === 'g').parameter_config.computedValue).toBe('EE FF');
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

    it('② slot 目标 → 整卡 Σ 不可知不注入（即便 slot 带 byte_length）', () => {
        const p = proto([
            leaf('h', { byte_length: 2 }),
            { id: 's', label: 's', type: 'slot', byte_length: 1, hex_value: '00' },
            lenCard('L', ['s']),
            lenCard('M', ['h', 's'])
        ]);
        const byId = computeProtocolOffsets(p).byId;
        const lanes = protocolTree.injectRefsSigma(lanesOf(p), byId, p);
        expect(lanes[0].items.find(i => i.id === 'L').parameter_config.computedValue).toBeUndefined();
        expect(lanes[0].items.find(i => i.id === 'M').parameter_config.computedValue).toBeUndefined();
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

// ─── 容器内容注入：组/容器卡中央值 = 嵌套内容逐块拼接 ───────────────────────
// 口径：已知子块出字面 hex、未知子块按 byte_length 出等量 ??（如 `AA 55 ?? ??`）；
// length/checksum/slot 的 hex_value '00' 是建块默认占位非真值 → 等量 ??；
// 空容器不产内容 → 不注入（Block 落尺寸分支显 0B）；叶块不注入；输入零改写。

describe('injectContainerContent（容器中央值 = 嵌套内容拼接）', () => {
    it('hex 子块出字面、无 hex 子块出等量 ??、length 默认占位不算已知；叶块不注入', () => {
        const p = proto([
            cont('g', [
                leaf('h', { hex_value: 'AA 55', byte_length: 2 }),
                leaf('x', { byte_length: 2, hex_value: null }), // 无字面 hex → 等量 ??
                {
                    id: 'L', label: 'L', type: 'length', byte_length: 1, hex_value: '00',
                    parameter_config: { type: 'length', refs: [] }
                }
            ]),
            cont('e', []), // 空容器
            leaf('z', { byte_length: 1, hex_value: 'FF' }) // 叶块
        ]);
        const lanes = protocolTree.injectContainerContent(buildProtocolLanes(p, ['g']));

        expect(lanes[0].items.find(i => i.id === 'g').parameter_config.computedValue)
            .toBe('AA 55 ?? ?? ??');
        expect(lanes[0].items.find(i => i.id === 'e').parameter_config?.computedValue).toBeUndefined();
        expect(lanes[0].items.find(i => i.id === 'z').parameter_config?.computedValue).toBeUndefined();
        // 输入零改写（注入为派生副本）
        expect(findNode(p, 'g').parameter_config).toBeUndefined();
    });

    it('嵌套容器递归拼接（外层吃内层内容）', () => {
        const p = proto([
            cont('g', [cont('inner', [leaf('i', { hex_value: 'CC', byte_length: 1 })])])
        ]);
        const lanes = protocolTree.injectContainerContent(buildProtocolLanes(p, ['g', 'inner']));
        expect(lanes[0].items.find(i => i.id === 'g').parameter_config.computedValue).toBe('CC');
        expect(lanes[1].items.find(i => i.id === 'inner').parameter_config.computedValue).toBe('CC');
    });
});
