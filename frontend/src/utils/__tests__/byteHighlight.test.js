import { describe, it, expect } from 'vitest';
import {
    collectSubtreeIds,
    matchByteRanges,
    buildHexSegments,
    formatByteRanges,
    findFieldLabel
} from '../byteHighlight';

// 指令加工编辑反馈（第 4 批 #2）：点击字段 → BYTE_STREAM_OUTPUT 高亮定位。
// 纯函数层先行锁形（id 集收集 / 字节区间过滤 / hex 分段 / 读数文案 / 字段名回查），
// InstructionRunner 只做状态接线与渲染。

const tree = () => [
    {
        id: 'g', name: '外组', fields: [
            { id: 'a', name: '头' },
            { id: 'b', name: '尾', fields: [{ id: 'b1', name: '内叶' }] }
        ]
    },
    { id: 't', name: '运行秒数' }
];

// 7 字节帧：a=[0,2) t=[2,6) b1=[6,7)
const BYTE_MAP = () => [
    { start: 0, end: 2, fieldId: 'a' },
    { start: 2, end: 6, fieldId: 't' },
    { start: 6, end: 7, fieldId: 'b1' }
];

const PRETTY = '00 AA BB CC DD EE FF';

describe('byteHighlight（字段 ↔ 字节流定位，第 4 批 #2）', () => {
    it('collectSubtreeIds：叶命中 = 自身；容器命中 = 容器 + 全部子孙（深嵌套）；未命中 / 空树 → 空集', () => {
        expect([...collectSubtreeIds(tree(), 't')]).toEqual(['t']);
        expect([...collectSubtreeIds(tree(), 'b')].sort()).toEqual(['b', 'b1']);
        expect([...collectSubtreeIds(tree(), 'g')].sort()).toEqual(['a', 'b', 'b1', 'g']);
        expect(collectSubtreeIds(tree(), 'ghost').size).toBe(0);
        expect(collectSubtreeIds(null, 't').size).toBe(0);
        expect(collectSubtreeIds([], 't').size).toBe(0);
    });

    it('matchByteRanges：按 id 集过滤（容器选中 → 命中子孙字节，保 byteMap 序）', () => {
        expect(matchByteRanges(BYTE_MAP(), collectSubtreeIds(tree(), 't')).map(e => e.fieldId))
            .toEqual(['t']);
        expect(matchByteRanges(BYTE_MAP(), collectSubtreeIds(tree(), 'b')).map(e => e.fieldId))
            .toEqual(['b1']);
        expect(matchByteRanges(BYTE_MAP(), collectSubtreeIds(tree(), 'g')).map(e => e.fieldId))
            .toEqual(['a', 'b1']);
        expect(matchByteRanges(BYTE_MAP(), new Set())).toEqual([]);
        expect(matchByteRanges(null, new Set(['t']))).toEqual([]);
    });

    it('buildHexSegments：按 byteMap 区间切段，段内逐字节 XX XX 空格分隔 + selected 标记，零长段丢弃', () => {
        const segs = buildHexSegments(PRETTY, BYTE_MAP(), collectSubtreeIds(tree(), 't'));
        expect(segs.map(s => s.text)).toEqual(['00 AA', 'BB CC DD EE', 'FF']);
        expect(segs.map(s => s.selected)).toEqual([false, true, false]);
        expect(segs[1]).toMatchObject({ fieldId: 't', start: 2, end: 6 });

        // 零长条目（repeat 0 / slot 占位）不出空段
        const withZero = buildHexSegments(PRETTY, [
            { start: 0, end: 2, fieldId: 'a' },
            { start: 2, end: 2, fieldId: 'z' },
            { start: 2, end: 7, fieldId: 't' }
        ], null);
        expect(withZero.map(s => s.text)).toEqual(['00 AA', 'BB CC DD EE FF']);
    });

    it('buildHexSegments：无选中全不标记；空 preview → []；byteMap 空 → 整串单段回落', () => {
        expect(buildHexSegments(PRETTY, BYTE_MAP(), null).every(s => !s.selected)).toBe(true);
        expect(buildHexSegments('', BYTE_MAP(), null)).toEqual([]);

        const fallback = buildHexSegments(PRETTY, [], null);
        expect(fallback).toHaveLength(1);
        expect(fallback[0]).toMatchObject({ text: '00 AA BB CC DD EE FF', fieldId: null, selected: false });
    });

    it('formatByteRanges：单区间 0x02-0x05；大写两位十六进制；多区间逗号连接；空 → 空串', () => {
        expect(formatByteRanges(matchByteRanges(BYTE_MAP(), collectSubtreeIds(tree(), 't'))))
            .toBe('0x02-0x05');
        expect(formatByteRanges(matchByteRanges(BYTE_MAP(), collectSubtreeIds(tree(), 'g'))))
            .toBe('0x00-0x01, 0x06-0x06');
        expect(formatByteRanges([{ start: 10, end: 12, fieldId: 'x' }])).toBe('0x0A-0x0B');
        expect(formatByteRanges([])).toBe('');
    });

    it('findFieldLabel：深层字段回 name（缺省回落 label）；未命中 / 空树 → null', () => {
        expect(findFieldLabel(tree(), 'b1')).toBe('内叶');
        expect(findFieldLabel(tree(), 'g')).toBe('外组');
        expect(findFieldLabel(tree(), 't')).toBe('运行秒数');
        expect(findFieldLabel([{ id: 'x', label: 'LAB' }], 'x')).toBe('LAB');
        expect(findFieldLabel(tree(), 'ghost')).toBeNull();
        expect(findFieldLabel(null, 't')).toBeNull();
    });
});
