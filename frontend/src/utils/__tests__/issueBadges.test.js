import { describe, it, expect } from 'vitest';
import { buildIssueMap } from '../issueBadges';

// 验证反馈批次：属性面板的提醒清单（validateProtocol/validateInstruction 输出
// {errors, warnings}，均带 blockId/code/message）→ 卡片标色映射。
describe('buildIssueMap（校验清单 → 卡片标色映射）', () => {
    it('errors/warnings 按 blockId 入 Map，level 分级', () => {
        const map = buildIssueMap({
            errors: [{ blockId: 'a', code: 'HEX_LENGTH', message: 'E1' }],
            warnings: [{ blockId: 'b', code: 'HEX_EMPTY', message: 'W1' }],
        });
        expect(map.get('a')).toEqual({ level: 'error', messages: ['E1'] });
        expect(map.get('b')).toEqual({ level: 'warning', messages: ['W1'] });
        expect(map.size).toBe(2);
    });

    it('同卡 error 优先：不被 warning 降级，消息全量聚合', () => {
        const map = buildIssueMap({
            errors: [{ blockId: 'x', code: 'E', message: '坏' }],
            warnings: [{ blockId: 'x', code: 'W', message: '提醒' }],
        });
        expect(map.get('x').level).toBe('error');
        expect(map.get('x').messages).toEqual(expect.arrayContaining(['坏', '提醒']));
    });

    it('同卡多条 warning → 消息聚合、level 保持 warning', () => {
        const map = buildIssueMap({
            errors: [],
            warnings: [
                { blockId: 'y', code: 'W1', message: '甲' },
                { blockId: 'y', code: 'W2', message: '乙' },
            ],
        });
        expect(map.get('y')).toEqual({ level: 'warning', messages: ['甲', '乙'] });
    });

    it('同卡先有 warning 后有 error → 升级为 error 且两条消息都在', () => {
        // 输入顺序：warnings 先 add、errors 后 add（实现固定序），升级路径覆盖。
        const map = buildIssueMap({
            errors: [{ blockId: 'z', code: 'E', message: '错误' }],
            warnings: [{ blockId: 'z', code: 'W', message: '警告' }],
        });
        expect(map.get('z').level).toBe('error');
        expect(map.get('z').messages).toEqual(expect.arrayContaining(['警告', '错误']));
    });

    it('无 blockId 的条目跳过（页面级问题无卡可标）', () => {
        const map = buildIssueMap({
            errors: [{ code: 'X', message: '无块' }],
            warnings: [{ blockId: null, code: 'Y', message: '空块' }],
        });
        expect(map.size).toBe(0);
    });

    it('空/缺省输入 → 空 Map（蓝图/编排页不传口径）', () => {
        expect(buildIssueMap(null).size).toBe(0);
        expect(buildIssueMap(undefined).size).toBe(0);
        expect(buildIssueMap({ errors: [], warnings: [] }).size).toBe(0);
    });
});
