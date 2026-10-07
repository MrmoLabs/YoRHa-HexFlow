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
    buildDuplicateProtocolPayload
} from '../protocolTree';
// 命名空间二段导入：injectRefsSigma/computeRefsSigma 系一期新增导出（红测期不拖垮同文件其余断言）
import * as protocolTree from '../protocolTree';
// 批 4 用：位域块在导入路径的白名单归一
const { buildImportedProtocolPayload } = protocolTree;
// R21（§8.52 排期 · 长度域 BE/LE）：长度字节序共享向量 —— 单一真相源 =
// vectors/length_order.json，与 backend/tests/test_length_byte_order.py 同读一份。
import { loadVectors } from '../../../../vectors/vectors.js';
import lengthOrderVec from '../../../../vectors/length_order.json';
// R34（§8.66 排期 · 校验和字节序）：checksum 字节序共享向量 —— 单一真相源 =
// vectors/checksum_order.json，与 backend/tests/test_checksum_byte_order.py 同读一份。
import checksumOrderVec from '../../../../vectors/checksum_order.json';

const LENGTH_ORDER_VECTORS = loadVectors(lengthOrderVec);
const CHECKSUM_ORDER_VECTORS = loadVectors(checksumOrderVec);

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

// ─── 批次三（P1-1）：协议级复制 ────────────────────────────────────────────
// refs 自含重映射 + 丢悬空（防 POST 400，镜像 duplicateInstruction.js 口径）。
// 块级 duplicateNode（un-wired copy）已随人工验证第 3 轮 #1 连删。
describe('批 4：协议位域块在复制/导入路径不丢位段', () => {
    const counter = (prefix) => {
        let n = 0;
        return () => `${prefix}-${++n}`;
    };
    const bitNode = () => ({
        id: 'bf', label: '控制', type: 'bitfield', byte_length: 1, hex_value: null,
        bits: [
            { id: 'b1', bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1 },
            { id: 'b2', bit_name: 'EN', start_bit: 2, bit_len: 1, default_val: 1 }
        ]
    });

    it('复制：位段随整树克隆保留（id 重发不波及位段语义）', () => {
        const source = { id: 'root', label: 'P', type: 'container', children: [bitNode()] };
        const payload = buildDuplicateProtocolPayload(source, [], counter('p'));
        const bf = payload.children[0];
        expect(bf.type).toBe('bitfield');
        expect(bf.bits).toHaveLength(2);
        expect(bf.bits[0]).toMatchObject({ bit_name: 'MODE', start_bit: 0, bit_len: 2, default_val: 1 });
    });

    it('导入：白名单重建保留并归一位段（脏位段剔除，缺省值补 0）', () => {
        const source = {
            id: 'root', label: 'P', type: 'container',
            children: [{
                ...bitNode(),
                bits: [
                    { bit_name: 'OK', start_bit: 0, bit_len: 4, default_val: 3 },
                    { bit_name: 'BAD', start_bit: 'x', bit_len: 4 },
                    { bit_name: 'BAD2', start_bit: 4, bit_len: 0 },
                    'junk'
                ]
            }]
        };
        const payload = buildImportedProtocolPayload(source, [], counter('q'));
        expect(payload.children[0].bits).toEqual([
            { bit_name: 'OK', start_bit: 0, bit_len: 4, default_val: 3 }
        ]);
    });

    it('导入：非位域块不带 bits 键（不凭空注入空数组污染存量协议）', () => {
        const source = {
            id: 'root', label: 'P', type: 'container',
            children: [{ id: 'f', label: '固', type: 'fixed', byte_length: 1, hex_value: 'AA' }]
        };
        const payload = buildImportedProtocolPayload(source, [], counter('q'));
        expect('bits' in payload.children[0]).toBe(false);
    });

    it('导入：位段元数据 signed/value_table 白名单保留（脏值表清洗，无 meta 不注入键）', () => {
        const source = {
            id: 'root', label: 'P', type: 'container',
            children: [{
                ...bitNode(),
                bits: [
                    {
                        bit_name: 'CMD', start_bit: 0, bit_len: 4, default_val: -1, signed: true,
                        value_table: [{ value: -1, label: '故障' }, { value: 'x', label: '坏' }, 'junk']
                    },
                    { bit_name: 'OK', start_bit: 4, bit_len: 4, default_val: 1, value_table: 'garbage' }
                ]
            }]
        };
        const payload = buildImportedProtocolPayload(source, [], counter('m'));
        const bits = payload.children[0].bits;
        expect(bits[0]).toMatchObject({ bit_name: 'CMD', default_val: -1, signed: true });
        expect(bits[0].value_table).toEqual([{ value: -1, label: '故障' }]);
        // 非数组值表 → 丢弃；无 meta 的位段不注入键（与批 4 白名单口径一致）
        expect(bits[1].value_table).toBeUndefined();
        expect(bits[1].signed).toBeUndefined();
    });
});

describe('buildDuplicateProtocolPayload（协议级复制）', () => {
    const counter = (prefix) => {
        let n = 0;
        return () => `${prefix}-${++n}`;
    };
    const len = (id, refs, label) => ({
        id, label: label || id, type: 'length', byte_length: 2, hex_value: '00',
        parameter_config: { type: 'length', refs }
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

describe('人工验证第 3 轮 #2 — 容器拼接：?? 仅限无法确定内容的卡，未配置 fixed 子块显存储值', () => {
    it('fixed 子块 hex_value 全 0（0000/00）→ 显示存储值；非全 0 真值照常拼接', () => {
        const p = proto([
            cont('c', [
                leaf('z1', { hex_value: '0000', byte_length: 2 }),
                leaf('z2', { hex_value: '00', byte_length: 1 }),
                leaf('a', { hex_value: 'AA55', byte_length: 2 }),
            ]),
        ]);
        const lanes = protocolTree.injectContainerContent(buildProtocolLanes(p, ['c']));
        expect(lanes[0].items.find(i => i.id === 'c').parameter_config.computedValue)
            .toBe('00 00 00 AA 55');
    });

    it('计算层不受显示口径影响：Σ/checksum 仍将全 0 字面计为编码真值字节', () => {
        // fixed '0000'(2B) + fixed 'AA55'(2B) 的容器被 length 引用 → Σ = 4B；
        // 编码器确实会发出 00 00（存储值即真值），计算不因卡面显示口径而缩水。
        const z = leaf('z', { hex_value: '0000', byte_length: 2 });
        const a = leaf('a', { hex_value: 'AA55', byte_length: 2 });
        const p = proto([
            cont('c', [z, a]),
            { id: 'L', label: 'L', type: 'length', byte_length: 1, hex_value: '00', parameter_config: { type: 'length', refs: ['c'] } },
        ]);
        const lanes = protocolTree.injectRefsSigma(buildProtocolLanes(p, ['c']), computeProtocolOffsets(p).byId, p);
        expect(lanes[0].items.find(i => i.id === 'L').parameter_config.computedValue).toBe('4B');
    });
});

// ─── R21（§8.52 排期 · 长度域 BE/LE）：length 字节序双端同读向量 ─────────────
// 单一真相源 = vectors/length_order.json（本文件 + backend/tests/
// test_length_byte_order.py 同读一份，新增向量只写一处）。卡面口径 =
// collectDeterministicBytes 的 length 分支（little = 字节对反转，与后端
// LengthHandler.apply_byte_order 同口径）；取值路径 = 容器中央值注入
// （injectContainerContent → nodeContent → collectDeterministicBytes）。
describe('R21 长度域字节序（共享向量 vectors/length_order.json · 双端同读）', () => {
    const lenTree = (row) => proto([
        // refs 目标 = row.total 字节的字面块 → Σ = total（与后端 refs 求和同值）
        leaf('h', { hex_value: 'AA'.repeat(row.total), byte_length: row.total }),
        cont('g', [{
            id: 'L', label: 'L', type: 'length', byte_length: row.byte_length, hex_value: '00',
            parameter_config: { type: 'length', refs: ['h'], byte_order: row.byte_order }
        }])
    ]);
    const containerValue = (p, byId) => protocolTree.injectContainerContent(
        buildProtocolLanes(p, ['g']), byId, p
    )[0].items.find(i => i.id === 'g').parameter_config.computedValue;

    it('向量逐行：容器中央值的 length 字段按 byte_order 出线（little = 字节对反转）', () => {
        for (const row of LENGTH_ORDER_VECTORS) {
            const p = lenTree(row);
            expect(containerValue(p, computeProtocolOffsets(p).byId),
                `${row.byte_order}/${row.byte_length}B Σ=${row.total}`)
                .toBe(row.expected.match(/.{1,2}/g).join(' '));
        }
    });

    it('缺省 / 枚举外 → 按大端出线（fail-open，与后端 byte_order_of 同口径）', () => {
        const valueOf = (byte_order) => {
            const p = lenTree({ byte_length: 2, total: 6, byte_order });
            return containerValue(p, computeProtocolOffsets(p).byId);
        };
        expect(valueOf(undefined)).toBe('00 06');
        expect(valueOf('big')).toBe('00 06');
        expect(valueOf('middle')).toBe('00 06');
        expect(valueOf('')).toBe('00 06');
        expect(valueOf('LITTLE')).toBe('06 00'); // 大小写不敏感（两端同口径）
    });

    it('R42 trim 归一：length 卡带首尾空白的 little 同样按小端出线（两端同口径）', () => {
        // R34 §8.66 留白「不引入 trim 归一」已由本批销项：BE `byte_order_of`
        // 早就是 `str(order).strip().lower()`，FE 这条 length 分支此前不 trim ——
        // 同一个值可能在**卡面**判大端、在**出线**判小端。归一后两端同判。
        const valueOf = (byte_order) => {
            const p = lenTree({ byte_length: 2, total: 6, byte_order });
            return containerValue(p, computeProtocolOffsets(p).byId);
        };
        expect(valueOf(' LITTLE ')).toBe('06 00');
        expect(valueOf('\tlittle\t')).toBe('06 00');
        expect(valueOf(' big ')).toBe('00 06');      // 归一后是 big → 大端
        expect(valueOf(' middle ')).toBe('00 06');   // 归一后不在枚举 → fail-open 大端
    });

    it('Σ 回显口径不受字节序影响：设计期卡面仍是十进制字节数', () => {
        // 字节序只改「出线字节的排法」，长度字段的**值**（= 引用尺寸之和）不变。
        const p = lenTree({ byte_order: 'little', byte_length: 2, total: 6 });
        const lanes = protocolTree.injectRefsSigma(
            buildProtocolLanes(p, ['g']), computeProtocolOffsets(p).byId, p
        );
        expect(lanes[1].items.find(i => i.id === 'L').parameter_config.computedValue).toBe('6B');
    });

    it('回归（R21 顺带修）：≥2 字节设计期真值不被空格切坏（formatToHex 出的是展示串）', () => {
        // formatToHex(6, 2) → "00 06"：直接 .match(/.{1,2}/g) 会把空格吃进切片
        // → [00,0x0,06] 多一个 0 字节。单字节值（既有用例）看不出，2 字节 CRC /
        // 长度必错 —— 两个分支同步去空格（改一必改二）。
        const p = proto([
            leaf('h', { hex_value: 'AA 55', byte_length: 2 }),
            cont('g', [{
                id: 'C', label: 'C', type: 'checksum', byte_length: 2, hex_value: '00',
                parameter_config: { type: 'checksum', refs: ['h'], algorithm: 'CRC_16_MODBUS' }
            }])
        ]);
        const want = formatToHex(calculateChecksum(ChecksumAlgo.CRC_16_MODBUS, [0xAA, 0x55]), 2);
        expect(want).toContain(' '); // 两字节必然带空格 → 正是切坏的触发条件
        expect(protocolTree.injectContainerContent(
            buildProtocolLanes(p, ['g']), computeProtocolOffsets(p).byId, p
        )[0].items.find(i => i.id === 'g').parameter_config.computedValue).toBe(want);
    });
});

// ─── R34（§8.66 排期 · 校验和字节序）：checksum 字节序双端同读向量 ────────────
// 单一真相源 = vectors/checksum_order.json（本文件 + backend/tests/
// test_checksum_byte_order.py 同读一份，新增向量只写一处）。真值链不自证：
// expected_big 逐字取自 R22 vectors/checksum_algo.json 的外部真值，expected_little
// = 字节反转（little 的定义）。
// **两个计算点同用一份反转口径（改一必改二）**：
//   ① injectRefsSigma —— checksum 卡中央值；
//   ② injectContainerContent → collectDeterministicBytes —— 容器内内容。
// 与后端 ChecksumHandler.apply_byte_order 同口径（缺省 / 枚举外一律大端 fail-open）。
describe('R34 校验和字节序（共享向量 vectors/checksum_order.json · 双端同读）', () => {
    const lanesOf = (protocol) => buildProtocolLanes(protocol, []);
    const ckTree = (row, over = {}) => proto([
        leaf('h', { hex_value: row.data, byte_length: row.data.length / 2 }),
        {
            id: 'C', label: 'C', type: 'checksum', byte_length: row.byte_length, hex_value: '00',
            parameter_config: {
                type: 'checksum', refs: ['h'], algorithm: row.algo, byte_order: row.byte_order, ...over
            }
        }
    ]);
    const cardValue = (p) => protocolTree.injectRefsSigma(
        lanesOf(p), computeProtocolOffsets(p).byId, p
    )[0].items.find(i => i.id === 'C').parameter_config.computedValue;

    it('向量逐行：checksum 卡中央值按 byte_order 出线（little = 字节对反转）', () => {
        for (const row of CHECKSUM_ORDER_VECTORS) {
            expect(cardValue(ckTree(row)),
                `${row.algo}/${row.byte_order}/${row.byte_length}B`)
                .toBe(row.expected.match(/.{1,2}/g).join(' '));
        }
    });

    it('缺省 / big / 枚举外 → 按大端出线（fail-open，与后端 byte_order_of 同口径）', () => {
        const big = '4B 37';   // CRC_16_MODBUS("123456789") = 4B37（已发布 check 值）
        for (const byte_order of [undefined, 'big', 'middle', '']) {
            expect(cardValue(ckTree(
                { data: '313233343536373839', algo: 'CRC_16_MODBUS', byte_length: 2, byte_order }
            ))).toBe(big);
        }
        // 大小写不敏感（与 R21 length 分支 / 后端 byte_order_of 同口径）；
        // R42（§8.74）起首尾空白一并归一 —— 见下条「带首尾空白的 little」用例。
        expect(cardValue(ckTree(
            { data: '313233343536373839', algo: 'CRC_16_MODBUS', byte_length: 2, byte_order: 'LITTLE' }
        ))).toBe('37 4B');
    });

    it('R42 trim 归一：checksum 卡带首尾空白的 little 同样按小端出线（两个计算点同口径）', () => {
        // 计算点 ① collectDeterministicBytes（容器内容）+ ② injectRefsSigma（卡中央值）
        // 共用 `isLittleOrder`，本条同时锁两处 —— trim 归一后不许再出现「一处判
        // 大端、一处判小端」。R34 §8.66 留白的「不引入 trim 归一」已由本批销项。
        const row = { data: '313233343536373839', algo: 'CRC_16_MODBUS', byte_length: 2 };
        for (const byte_order of [' little ', ' LITTLE ']) {
            expect(cardValue(ckTree({ ...row, byte_order })), byte_order).toBe('37 4B');
        }
        expect(cardValue(ckTree({ ...row, byte_order: ' big ' }))).toBe('4B 37');
        expect(cardValue(ckTree({ ...row, byte_order: ' middle ' }))).toBe('4B 37');

        const inside = (byte_order) => {
            const p = proto([
                leaf('h', { hex_value: row.data, byte_length: row.data.length / 2 }),
                cont('g', [{
                    id: 'C', label: 'C', type: 'checksum', byte_length: 2, hex_value: '00',
                    parameter_config: {
                        type: 'checksum', refs: ['h'], algorithm: row.algo,
                        ...(byte_order !== undefined ? { byte_order } : {})
                    }
                }])
            ]);
            return protocolTree.injectContainerContent(
                lanesOf(p), computeProtocolOffsets(p).byId, p
            )[0].items.find(i => i.id === 'g').parameter_config.computedValue;
        };
        expect(inside(' little ')).toBe('37 4B');
        expect(inside(' middle ')).toBe('4B 37');
    });

    it('改一必改二：容器内容路径（collectDeterministicBytes）同口径反转', () => {
        const row = { data: '313233343536373839', algo: 'CRC_16_MODBUS', byte_length: 2 };
        const inside = (byte_order) => {
            const p = proto([
                leaf('h', { hex_value: row.data, byte_length: row.data.length / 2 }),
                cont('g', [{
                    id: 'C', label: 'C', type: 'checksum', byte_length: 2, hex_value: '00',
                    parameter_config: {
                        type: 'checksum', refs: ['h'], algorithm: row.algo, ...(byte_order !== undefined ? { byte_order } : {})
                    }
                }])
            ]);
            return protocolTree.injectContainerContent(
                lanesOf(p), computeProtocolOffsets(p).byId, p
            )[0].items.find(i => i.id === 'g').parameter_config.computedValue;
        };
        expect(inside('little')).toBe('37 4B');
        expect(inside('big')).toBe('4B 37');
        expect(inside(undefined)).toBe('4B 37');
        expect(inside('middle')).toBe('4B 37');
    });

    it('字节序只改排法、不改算法：1 字节算法（SUM_8）两侧同串', () => {
        for (const byte_order of ['big', 'little']) {
            expect(cardValue(ckTree(
                { data: '313233343536373839', algo: 'SUM_8', byte_length: 1, byte_order }
            ))).toBe('DD');   // sum("123456789") = 477 → 477 % 256 = 221 = 0xDD
        }
    });

    it('Σ 回显口径不受字节序影响：设计期卡面仍是十进制字节数（length 分支不受牵连）', () => {
        const p = proto([
            leaf('h', { hex_value: 'AA'.repeat(6), byte_length: 6 }),
            cont('g', [{
                id: 'L', label: 'L', type: 'length', byte_length: 2, hex_value: '00',
                parameter_config: { type: 'length', refs: ['h'], byte_order: 'little' }
            }])
        ]);
        expect(protocolTree.injectRefsSigma(
            buildProtocolLanes(p, ['g']), computeProtocolOffsets(p).byId, p
        )[1].items.find(i => i.id === 'L').parameter_config.computedValue).toBe('6B');
    });
});
