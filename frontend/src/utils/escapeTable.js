// N4 (G3): 传输层帧字节转义 —— 配置面板的纯函数视图模型。
//
// 语义与 backend/core/escape.py 同口径（出线转义的 SSOT 在后端，FE 只做配置
// 归一、行级提醒与样例预览）：空表 / 关闭 → 原样返回、不解析；启用且有规则 →
// 单趟映射（命中 pairs 的 from → 输出 to 序列），非法 hex → null（面板显示占位）。
//
// 双端向量纪律：本文件的向量锚定 __tests__/escapeTable.test.js ↔
// backend/tests/test_escape.py VECTORS，改一必改二。

const HEX_CLEANER = /[\s,_-]/g;
const HEX2 = /^[0-9A-Fa-f]{2}$/;
const HEX_STRICT = /^[0-9A-Fa-f]+$/;

/** 传输配置的 escape 段 → 面板草稿（缺段 / 脏段一律回落默认关闭）。 */
export function toEscapeDraft(config) {
    if (!config || typeof config !== 'object') {
        return { enabled: false, pairs: [] };
    }
    if (typeof config.enabled !== 'boolean' || !Array.isArray(config.pairs)) {
        return { enabled: false, pairs: [] };
    }
    const clean = config.pairs.every((pair) => Array.isArray(pair)
        && pair.length === 2
        && typeof pair[0] === 'string'
        && typeof pair[1] === 'string');
    if (!clean) {
        return { enabled: false, pairs: [] };
    }
    return { enabled: config.enabled, pairs: config.pairs.map(([src, dst]) => [src, dst]) };
}

// 启用态有效表：任一行脏 → null（该配置还没过 BE 校验，面板不给预览）
function activeTable(pairs) {
    const table = new Map();
    for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length !== 2) {
            return null;
        }
        const [src, dst] = pair;
        if (typeof src !== 'string' || !HEX2.test(src)) {
            return null;
        }
        if (typeof dst !== 'string' || !dst || dst.length % 2 !== 0
            || !HEX_STRICT.test(dst)) {
            return null;
        }
        table.set(parseInt(src, 16), dst.toUpperCase());
    }
    return table;
}

/** hex（可带分隔符）→ 转义结果（紧凑大写）；关闭/无规则 → 原样；脏表/非法 → null。 */
export function escapeHex(hexStr, escapeCfg) {
    if (!escapeCfg || escapeCfg.enabled !== true) {
        return hexStr; // 与 BE escape_hex 同口径：关闭态原样直通、不解析
    }
    const pairs = Array.isArray(escapeCfg.pairs) ? escapeCfg.pairs : [];
    if (pairs.length === 0) {
        return hexStr;
    }
    const table = activeTable(pairs);
    if (!table) {
        return null;
    }
    const cleaned = String(hexStr ?? '').replace(HEX_CLEANER, '');
    if (cleaned === '') {
        return '';
    }
    if (cleaned.length % 2 !== 0 || !HEX_STRICT.test(cleaned)) {
        return null;
    }
    let out = '';
    for (let i = 0; i < cleaned.length; i += 2) {
        const byte = parseInt(cleaned.substr(i, 2), 16);
        out += table.get(byte) ?? byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
}

/** 面板提醒（非阻断）：行级格式 → 重复原字节 → 转义前缀未受保护的歧义。 */
export function escapeWarnings(escapeCfg) {
    const warnings = [];
    const pairs = Array.isArray(escapeCfg?.pairs) ? escapeCfg.pairs : [];

    const protectedBytes = new Set();
    const seen = new Set();
    const ambiguous = new Set();

    pairs.forEach((pair, i) => {
        const row = i + 1;
        if (!Array.isArray(pair) || pair.length !== 2) {
            warnings.push(`第 ${row} 行必须是 [原字节, 替换序列] 两项`);
            return;
        }
        const [rawSrc, rawDst] = pair;
        const src = typeof rawSrc === 'string' ? rawSrc.trim() : '';
        const dst = typeof rawDst === 'string' ? rawDst.trim() : '';

        let srcOk = HEX2.test(src);
        if (!srcOk) {
            warnings.push(`第 ${row} 行原字节必须是 2 位 hex`);
        }
        let dstOk = dst.length >= 2 && dst.length % 2 === 0 && HEX_STRICT.test(dst);
        if (!dstOk) {
            warnings.push(`第 ${row} 行替换序列必须是 ≥2 位偶数长度 hex`);
        }
        if (!srcOk || !dstOk) {
            return;
        }

        const srcKey = src.toUpperCase();
        if (seen.has(srcKey)) {
            warnings.push(`第 ${row} 行原字节 ${srcKey} 重复`);
        }
        seen.add(srcKey);
        protectedBytes.add(srcKey);

        const prefix = dst.substring(0, 2).toUpperCase();
        if (!protectedBytes.has(prefix)) {
            ambiguous.add(prefix);
        }
    });

    // 歧义只看最终受保护集合（前缀可能在后面行才被列为受保护字节）
    if (ambiguous.size) {
        for (const prefix of ambiguous) {
            if (protectedBytes.has(prefix)) {
                continue;
            }
            warnings.push(
                `转义前缀 ${prefix} 未列入受保护字节，载荷中出现将与转义序列混淆`
            );
        }
    }
    return warnings;
}
