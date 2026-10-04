// 批次二 P0-4: structural validation of a protocol working copy —— mirror
// validateInstruction.js 形态（纯函数、{errors, warnings}、条目
// {blockId, code, message} 可点击定位）。跑点 = saveProtocol 唯一咽喉
// （防抖保存 / 切协议 flush / 横幅重试全覆盖），清单实时渲染在
// ProtocolPropertiesPanel 顶部（选中块时也不隐藏，边修边看）。
//
// Errors   → block the save（真实结构问题 / 落库即污染的形态）。
// Warnings → never block。
//
// Keep this tolerant: a false-positive error would lock users out of saving
// （协议页是防抖自动保存，误报 = 既成事实编辑无法落库）。When in doubt,
// warn. 依据：后端 _validate_refs 只拦 refs 四类，对 hex 垃圾零校验
// （fromhex 失败静默 → 错帧），故 hex 非法字符在前端升级为闸。

import { isNestable } from '../config/blockTypes';

const normalizeHex = (h) => String(h ?? '').replace(/\s/g, '');

// W4 (批次四): 算法值域 = formula.js ChecksumAlgo 六值（R22 §8.52 起含
// CRC_16_CCITT/CRC_32/LRC；CRC_32 原「无实现回落」已转正实现）。
const VALID_ALGOS = new Set(['SUM_8', 'XOR_8', 'CRC_16_MODBUS', 'CRC_16_CCITT', 'CRC_32', 'LRC']);
// R21（长度域 BE/LE）：length pc.byte_order 值域 —— 与后端 LengthHandler 的
// big/little、收侧 response_spec.length.byte_order 的 VALID_BYTE_ORDERS 同集。
const VALID_BYTE_ORDERS = new Set(['big', 'little']);
// R27（§8.52 排期 · varint / COBS 出线 · §8.59）: length pc.encoding 值域 ——
// 与后端 framing.LENGTH_ENCODINGS 同集（枚举外两端一致 fail-open 回 fixed）。
const VALID_LENGTH_ENCODINGS = new Set(['fixed', 'varint']);
// cobs pc.terminator 值域 —— 与后端 framing.TERMINATORS 同集（枚举外 fail-open
// 回缺省 '00' 追加 0x00）。
const VALID_TERMINATORS = new Set(['00', 'none']);

export function validateProtocol(protocol) {
    const errors = [];
    const warnings = [];
    if (!protocol) return { errors, warnings };

    // 全树预序收集（顺序即报告顺序）
    const nodes = [];
    const walk = (items) => (items || []).forEach(node => {
        nodes.push(node);
        walk(node.children);
    });
    walk(protocol.children);

    // --- E0: 重复 id（findNode/moveNode/refs 解析全按 id 唯一假设工作） ---
    const byId = new Map();
    nodes.forEach(node => {
        if (byId.has(node.id)) {
            errors.push({ blockId: node.id, code: 'ID_DUPLICATE', message: `块 id 重复（${node.id}）` });
        } else {
            byId.set(node.id, node);
        }
    });

    // --- W0: 同层标签重复（默认标签「固定块」加两个即中，后端不校验 → 不阻断）---
    // 每层独立 seen 集（递归作用域即天然分层，无需父 id 拼键）。
    const walkLayers = (items) => {
        const seen = new Set();
        (items || []).forEach(node => {
            const label = node.label || '';
            if (label && seen.has(label)) {
                warnings.push({ blockId: node.id, code: 'LABEL_DUPLICATE', message: `同层标签重复「${label}」` });
            }
            seen.add(label);
            walkLayers(node.children);
        });
    };
    walkLayers(protocol.children, null);

    // --- R27（§8.59）: COBS 编码区内部 id 集（镜像后端 _validate_refs 的 400 规则）---
    // refs 跨不过编码边界：cobs 子树出线后只剩 cobs 块自己的区间，其内部 id 不在
    // 主发射流里 → 后端按 0 计、前端 resolveDependencies 仍能查到 → 两端 Σ 分歧。
    // 引 COBS 区域请直接引 cobs 块本身（两端都按其出线字节数计）。
    const insideCobs = new Set();
    const markCobs = (items, under) => (items || []).forEach(node => {
        if (under) insideCobs.add(node.id);
        markCobs(node.children, under || node.type === 'cobs');
    });
    markCobs(protocol.children, false);

    nodes.forEach(node => {
        const label = node.label || node.id;
        const nestable = isNestable(node.type);

        // --- hex 家族（容器跳过：byte_length 0 + 占位 hex 是组语义，非数据） ---
        if (!nestable && node.hex_value != null) {
            const hex = normalizeHex(node.hex_value);
            if (hex.length > 0) {
                // --- E1: 非 hex 字符 / 位数奇（任何叶子：发射路径 fromhex 失败即静默错帧） ---
                if (!/^[0-9A-Fa-f]+$/.test(hex)) {
                    errors.push({ blockId: node.id, code: 'HEX_INVALID', message: `「${label}」HEX 含非十六进制字符（${normalizeHex(node.hex_value)}）` });
                } else if (node.type === 'fixed') {
                    // --- E2: fixed 的 hex 就是线上字节 → 长度必须严等 byte_length×2 ---
                    const expected = (Number(node.byte_length) || 0) * 2;
                    if (expected > 0 && hex.length !== expected) {
                        errors.push({ blockId: node.id, code: 'HEX_LENGTH', message: `「${label}」HEX 长度与字节长度不符（需 ${expected} 字符，实际 ${hex.length}）` });
                    } else if (expected === 0) {
                        warnings.push({ blockId: node.id, code: 'HEX_EMPTY', message: `「${label}」HEX 值为空` });
                    }
                } else {
                    // --- W1: length/checksum/slot 运行期重算/填槽 → 仅提醒对齐 ---
                    const expected = (Number(node.byte_length) || 0) * 2;
                    if (expected > 0 && hex.length !== expected) {
                        warnings.push({ blockId: node.id, code: 'HEX_LENGTH', message: `「${label}」HEX 与字节长度不一致（${hex.length}/${expected} 字符，运行期按算法重算/填槽）` });
                    }
                }
            } else if (node.type === 'fixed') {
                // --- W2: fixed 空 hex（后端有 00 兜底分支，提醒即可） ---
                warnings.push({ blockId: node.id, code: 'HEX_EMPTY', message: `「${label}」HEX 值为空` });
            }
        }

        // --- E3-E6: refs 四类（镜像后端 _validate_refs，前端先拦给中文可定位文案） ---
        const pc = node.parameter_config || {};
        if ('refs' in pc) {
            const refs = pc.refs;
            if (!Array.isArray(refs)) {
                errors.push({ blockId: node.id, code: 'REFS_NOT_ARRAY', message: `「${label}」结构引用必须是数组` });
            } else {
                refs.forEach(ref => {
                    if (typeof ref !== 'string') {
                        errors.push({ blockId: node.id, code: 'REFS_NOT_STRING', message: `「${label}」结构引用含非字符串项` });
                    } else if (ref === node.id) {
                        errors.push({ blockId: node.id, code: 'REFS_SELF', message: `「${label}」不能引用自身` });
                    } else if (!byId.has(ref)) {
                        errors.push({ blockId: node.id, code: 'REF_DANGLING', message: `「${label}」引用了不存在的块（${ref}）` });
                    } else if (insideCobs.has(ref)) {
                        errors.push({ blockId: node.id, code: 'REFS_INSIDE_COBS', message: `「${label}」引用了 COBS 编码区内部的块（${ref}），编码边界跨不过（请直接引用 COBS 块本身）` });
                    }
                });
            }
        }

        // --- 批 4: bitfield 位域闸（镜像后端 routers.protocol._validate_bits）---
        // 位段是结构化真值，坏位域会一路存到编译期才炸 → 前端先拦给中文可定位文案。
        // 位域块不参与上面的 hex 家族检查（取值来自位段打包，非 hex_value）。
        if (node.type === 'bitfield') {
            const bits = Array.isArray(node.bits) ? node.bits : [];
            const segs = bits
                .filter(b => b && typeof b === 'object')
                .map(b => ({
                    name: b.bit_name || '?',
                    start: Number(b.start_bit),
                    len: Math.max(1, Number(b.bit_len) || 1)
                }))
                .filter(s => Number.isFinite(s.start) && s.start >= 0);
            const sorted = [...segs].sort((a, b) => a.start - b.start);
            let prevEnd = -1;
            let overlap = null;
            let highest = 0;
            for (const s of sorted) {
                if (s.start < prevEnd && !overlap) overlap = s;
                prevEnd = Math.max(prevEnd, s.start + s.len);
                highest = Math.max(highest, s.start + s.len);
            }
            if (overlap) {
                errors.push({ blockId: node.id, code: 'BIT_OVERLAP', message: `「${label}」位域重叠（${overlap.name} 起始 ${overlap.start} < 上一块结束 ${overlap.start}）` });
            }
            const capacity = (Number(node.byte_length) || 0) * 8;
            if (capacity > 0 && highest > capacity) {
                errors.push({ blockId: node.id, code: 'BIT_OVERFLOW', message: `「${label}」位域超出容量（${node.byte_length}B = ${capacity} bits，最高位 ${highest}）` });
            }
        }

        // --- W3: checksum 未挂引用（无 config 算法路径下编码期按 0 输出） ---
        if (node.type === 'checksum' && (!Array.isArray(pc.refs) || pc.refs.length === 0)) {
            warnings.push({ blockId: node.id, code: 'CHECKSUM_NO_REFS', message: `「${label}」校验块未挂引用，编码期按 0 输出（SELECT FIELDS 挂引用后按算法求和）` });
        }

        // --- W4 (批次四): checksum 算法枚举外 —— 导入已 mapChecksumAlgo 净化、
        // UI 下拉只产枚举值 → 此处兜底手改库/其他写入方。枚举外值两端回退
        // 口径不一（前端 calculateChecksum default → 0、后端 crc16），不阻断
        // 保存但必须可见；重新下拉选择即归一。 ---
        if (node.type === 'checksum' && pc.algorithm !== undefined && !VALID_ALGOS.has(pc.algorithm)) {
            warnings.push({ blockId: node.id, code: 'ALGO_UNKNOWN', message: `「${label}」校验算法「${pc.algorithm}」不在枚举内（两端回退口径不一，请重新选择）` });
        }

        // --- R21 (§8.52 排期 · 长度域 BE/LE): W5 length 字节序枚举外 —— 镜像 W4
        // 口径：两端对枚举外值一致 fail-open 回大端（FE 卡面 / BE LengthHandler /
        // 应答规格生成同口径），不阻断保存但必须可见；重新下拉选择即归一。
        // 大小写归一后再判（两端都 lowercase 收），空串 = 未配置 → 不报。 ---
        if (node.type === 'length') {
            const order = String(pc.byte_order ?? '').trim().toLowerCase();
            if (order && !VALID_BYTE_ORDERS.has(order)) {
                warnings.push({ blockId: node.id, code: 'BYTE_ORDER_UNKNOWN', message: `「${label}」长度字节序「${pc.byte_order}」不在枚举内（两端回退大端，请重新选择）` });
            }
            // --- R27 (§8.52 排期 · varint / COBS 出线): W6 length 出线编码枚举外 ---
            // 镜像 W5 口径：两端对枚举外值一致 fail-open 回定宽 fixed（FE 编码器 /
            // BE LengthHandler / 卡面同口径），不阻断保存但必须可见；重新下拉即归一。
            const enc = String(pc.encoding ?? '').trim().toLowerCase();
            if (enc && !VALID_LENGTH_ENCODINGS.has(enc)) {
                warnings.push({ blockId: node.id, code: 'ENCODING_UNKNOWN', message: `「${label}」出线编码「${pc.encoding}」不在枚举内（两端回退定宽 fixed，请重新选择）` });
            }
        }

        // --- R27 (§8.59): W7 cobs 定界字节枚举外 —— 两端 fail-open 回缺省 '00'
        //（追加 0x00），静默会出意料之外的定界 → 提醒重新下拉选择。 ---
        if (node.type === 'cobs') {
            const term = String(pc.terminator ?? '').trim().toLowerCase();
            if (pc.terminator !== undefined && pc.terminator !== null && term !== '' && !VALID_TERMINATORS.has(term)) {
                warnings.push({ blockId: node.id, code: 'TERMINATOR_UNKNOWN', message: `「${label}」定界字节「${pc.terminator}」不在枚举内（两端回退 0x00 定界，请重新选择）` });
            }
        }
    });

    return { errors, warnings };
}
