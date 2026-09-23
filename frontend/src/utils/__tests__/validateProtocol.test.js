import { describe, it, expect } from 'vitest';
import { validateProtocol } from '../validateProtocol';

// 批次二 P0-4 向量表：errors 阻断 / warnings 不阻断的分界、后端
// _validate_refs 四类的前端中文镜像、fixed 严等 vs 运算块仅提醒。
// 容器跳过 hex 检查（组语义）是防误报关键：误报 = 防抖自动保存被永久卡死。

const leaf = (id, extra = {}) => ({
    id, label: id, type: 'fixed', byte_length: 1, hex_value: '00', ...extra
});
const cont = (id, children = [], label) => ({
    id, label: label || id, type: 'container', byte_length: 0, children
});
const proto = (children) => ({ id: 'root', label: 'P', type: 'container', children });
const codes = (list) => list.map(x => x.code);

describe('validateProtocol（协议工作副本结构校验）', () => {
    it('空协议 / null → 双空不抛', () => {
        expect(validateProtocol(proto([]))).toEqual({ errors: [], warnings: [] });
        expect(validateProtocol(null)).toEqual({ errors: [], warnings: [] });
    });

    it('合法协议（含嵌套容器、HEX 对齐、refs 同树）→ 0 错 0 警', () => {
        const p = proto([
            leaf('h', { hex_value: 'FA FA', byte_length: 2 }),
            cont('g', [
                { id: 'L', label: 'L', type: 'length', byte_length: 2, hex_value: '00 00',
                    parameter_config: { type: 'length', refs: ['h'] } },
                { id: 'C', label: 'C', type: 'checksum', byte_length: 1, hex_value: '00',
                    parameter_config: { type: 'checksum', refs: ['h', 'L'] } }
            ]),
            leaf('t', { hex_value: 'ED' })
        ]);
        expect(validateProtocol(p)).toEqual({ errors: [], warnings: [] });
    });

    it('E1 HEX 非法字符 / 奇数位 → error（fixed 与运算块同拦）', () => {
        const badChars = validateProtocol(proto([leaf('a', { hex_value: 'GG' })]));
        expect(codes(badChars.errors)).toEqual(['HEX_INVALID']);
        // 奇数位且含非法字符（'ABZ' 的 Z）→ 同命中 E1；纯合法奇 hex（如
        // 'ABC'）属长度分支（E2/HEX_LENGTH，见下组）
        const odd = validateProtocol(proto([leaf('a', { hex_value: 'ABZ' })]));
        expect(codes(odd.errors)).toEqual(['HEX_INVALID']);
        // 非 fixed 叶子的非法字符同样 error（slot 填充走 fromhex）
        const slot = validateProtocol(proto([leaf('a', { type: 'slot', hex_value: 'ZZ' })]));
        expect(codes(slot.errors)).toEqual(['HEX_INVALID']);
    });

    it('E2 fixed 长度严等：不符 → error；length 类不符 → 仅 warning', () => {
        const fixed = validateProtocol(proto([leaf('a', { byte_length: 2, hex_value: 'FF' })]));
        expect(codes(fixed.errors)).toEqual(['HEX_LENGTH']);
        const len = validateProtocol(proto([
            leaf('a', { type: 'length', byte_length: 2, hex_value: '00' })
        ]));
        expect(len.errors).toEqual([]);
        expect(codes(len.warnings)).toEqual(['HEX_LENGTH']);
    });

    it('fixed 空 hex → warning；空/缺 hex 的 length/slot → 无问题（运行期重算）', () => {
        const emptyFixed = validateProtocol(proto([leaf('a', { hex_value: '' })]));
        expect(emptyFixed.errors).toEqual([]);
        expect(codes(emptyFixed.warnings)).toEqual(['HEX_EMPTY']);
        const runtimeless = validateProtocol(proto([
            { id: 'L', label: 'L', type: 'length', byte_length: 1 }, // 无 hex_value（种子形态）
            { id: 'S', label: 'S', type: 'slot', byte_length: 0, hex_value: '00' } // 槽长定义期不可知
        ]));
        expect(runtimeless.errors).toEqual([]);
        expect(runtimeless.warnings).toEqual([]);
    });

    it('容器跳过 hex 检查（组语义，防误报闸）：占位 hex/byte0 不报警', () => {
        const p = proto([
            { id: 'g', label: 'g', type: 'container', byte_length: 0, hex_value: '00', children: [] }
        ]);
        expect(validateProtocol(p)).toEqual({ errors: [], warnings: [] });
    });

    it('refs 四类镜像后端：非数组 / 非字符串 / 自引用 / 悬空 → error', () => {
        expect(codes(validateProtocol(proto([
            leaf('a', { type: 'length', parameter_config: { type: 'length', refs: 'a' } })
        ])).errors)).toEqual(['REFS_NOT_ARRAY']);
        expect(codes(validateProtocol(proto([
            leaf('a', { type: 'length', parameter_config: { type: 'length', refs: [1] } })
        ])).errors)).toEqual(['REFS_NOT_STRING']);
        expect(codes(validateProtocol(proto([
            leaf('a', { type: 'length', parameter_config: { type: 'length', refs: ['a'] } })
        ])).errors)).toEqual(['REFS_SELF']);
        expect(codes(validateProtocol(proto([
            leaf('a', { type: 'length', parameter_config: { type: 'length', refs: ['ghost'] } })
        ])).errors)).toEqual(['REF_DANGLING']);
        // 跨层同树引用合法（悬空判定按全树 byId，不看层级）
        const cross = validateProtocol(proto([
            leaf('h'),
            cont('g', [leaf('a', { type: 'length', parameter_config: { type: 'length', refs: ['h'] } })])
        ]));
        expect(cross.errors).toEqual([]);
    });

    it('E0 重复 id → error；W0 同层标签重复 → warning（跨层同名不报）', () => {
        const dupId = validateProtocol(proto([leaf('a'), leaf('a')]));
        expect(codes(dupId.errors)).toEqual(['ID_DUPLICATE']);
        const dupLabel = validateProtocol(proto([
            leaf('a', { label: '固定块' }), leaf('b', { label: '固定块' })
        ]));
        expect(dupLabel.errors).toEqual([]);
        expect(codes(dupLabel.warnings)).toEqual(['LABEL_DUPLICATE']);
        const crossLayer = validateProtocol(proto([
            leaf('a', { label: 'X' }), cont('g', [leaf('b', { label: 'X' })], 'G')
        ]));
        expect(crossLayer.warnings).toEqual([]);
    });

    it('W3 checksum 未挂引用 → warning；挂了引用不报', () => {
        const bare = validateProtocol(proto([
            leaf('a', { type: 'checksum', parameter_config: { type: 'checksum', refs: [] } })
        ]));
        expect(bare.errors).toEqual([]);
        expect(codes(bare.warnings)).toEqual(['CHECKSUM_NO_REFS']);
        const wired = validateProtocol(proto([
            leaf('h'),
            leaf('a', { type: 'checksum', parameter_config: { type: 'checksum', refs: ['h'] } })
        ]));
        expect(wired.warnings).toEqual([]);
    });

    // 批次四 W4: 算法枚举外只提醒不阻断（两端回退口径不一必须可见）
    it('W4 (批次四) checksum 算法枚举外 → ALGO_UNKNOWN warning；枚举值/缺失不报', () => {
        const withAlgo = (algorithm) => validateProtocol(proto([
            leaf('h'),
            leaf('a', { type: 'checksum', parameter_config: { type: 'checksum', refs: ['h'], ...(algorithm !== undefined ? { algorithm } : {}) } })
        ]));
        const junk = withAlgo('CRC32');
        expect(junk.errors).toEqual([]);
        expect(codes(junk.warnings)).toEqual(['ALGO_UNKNOWN']);
        expect(junk.warnings[0].message).toContain('CRC32');
        expect(withAlgo('SUM_8').warnings).toEqual([]);
        expect(withAlgo('XOR_8').warnings).toEqual([]);
        expect(withAlgo('CRC_16_MODBUS').warnings).toEqual([]);
        expect(withAlgo(undefined).warnings).toEqual([]);
    });

    it('条目带 blockId 可定位；种子协议形态零问题', () => {
        // backend/db/seed.py SAMPLE_PROTOCOLS 的形状（FA FA / ED / 无 hex 的 len·slot）
        const seedLike = proto([
            leaf('protocol-header', { label: '帧头 (HEADER)', byte_length: 2, hex_value: 'FA FA' }),
            cont('protocol-packaging', [
                { id: 'protocol-len', label: '长度 (LEN)', type: 'length', byte_length: 1 },
                { id: 'protocol-slot', label: '载荷插槽 (SLOT)', type: 'slot', byte_length: 0 }
            ], '包装层 (PACKAGING)'),
            leaf('protocol-tail', { label: '帧尾 (TAIL)', hex_value: 'ED' })
        ]);
        expect(validateProtocol(seedLike)).toEqual({ errors: [], warnings: [] });

        const bad = validateProtocol(proto([leaf('block-x', { hex_value: 'ZZ' })]));
        expect(bad.errors[0]).toMatchObject({ blockId: 'block-x', code: 'HEX_INVALID' });
        expect(bad.errors[0].message).toContain('ZZ');
    });
});
