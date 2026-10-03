// Maps frontend blocks to the backend FrameRequest block schema for
// POST /export/binary (Orchestrator compile).
// Extracted verbatim from pages/Orchestration.jsx (logic unchanged), extended
// in 批次四 (see buildLogicConfig below).
//
// Backend Block schema requires id/type/label/byte_length; frontend blocks
// carry byte_len/op_code/name, so map them explicitly before posting.

// 批次四: ChecksumAlgo（前端枚举，formula.js）→ 后端 ChecksumHandler 枚举。
// 缺省 CRC_16_MODBUS 与前端编码器 `params.algorithm || CRC_16_MODBUS` 同源
// （后端 handler 自身的 "sum" 缺省只服务旧 range 模式，refs 模式下算法恒由
// 此处显式给出）。
const BACKEND_ALGO = {
    SUM_8: 'sum', XOR_8: 'xor', CRC_16_MODBUS: 'crc16_modbus',
    // R22 (§8.52 排期): FE ChecksumAlgo → 后端 config.params.algorithm。
    // 与 backend/core/frame_builder.BACKEND_ALGO、utils/sequenceView.PLAN_ALGO
    // 同批成对改（出口翻译 → 出线计算 → 收侧判定三处对齐）。
    CRC_16_CCITT: 'crc16_ccitt', CRC_32: 'crc32', LRC: 'lrc'
};

// 批 4: bitfield 块的位段透传 —— 打包在后端 Orchestrator 发射期
// （backend/handlers/bitfield.py），此处只做形状归一 + 脏位段剔除
// （NaN/非整数起点、位宽 <1、负起点一律不进编码），与后端
// _build_bitfield_config 的过滤规则同形。
const normalizeBitSegments = (node) => (Array.isArray(node.bits) ? node.bits : [])
    .filter(b => b && typeof b === 'object')
    .map(b => ({
        bit_name: String(b.bit_name || ''),
        start_bit: Math.trunc(Number(b.start_bit)),
        bit_len: Math.trunc(Number(b.bit_len)),
        default_val: Math.trunc(Number(b.default_val) || 0)
    }))
    .filter(b => Number.isFinite(b.start_bit) && Number.isFinite(b.bit_len) && b.bit_len >= 1 && b.start_bit >= 0);

const buildBitfieldConfig = (node) => ({
    ...(node.config && typeof node.config === 'object' ? node.config : {}),
    params: { bits: normalizeBitSegments(node) }
});

// 批次四 (R2 打通): length/checksum 此前以死 config={} 直通 —— 后端
// LengthHandler/ChecksumHandler 的 range（target_start_id/target_end_id）
// 永不启动 → 恒输出 00。此处把前端 SSOT parameter_config 翻译进
// config.params，handlers 走新增的 **refs 集合模式**（range 模式仅作无
// refs 时的旧契约保留）：
// - params.refs = 按 **refs 数组序** 展开的叶子 id 列表（容器 ref 展开为其
//   子树叶子的文档序、悬空丢弃 —— 镜像前端 PASS2 逐 ref 取字节 / PASS1
//   组 ref 展开的口径；range 区间模型只认连续区间，非连续 refs 会把区间内
//   无关块算进来，故不采用 target_start/end）；
// - params.algorithm = 算法枚举映射（checksum 专属）；
// - params.offset = 显式数值才带（协议侧无此概念，缺省 0 同两端）；
// - params.byte_order = R21（长度域 BE/LE）：length pc.byte_order=little 才带
//   （缺省 / big / 枚举外不写键 → params 形状与存量逐字节一致，后端
//   LengthHandler 缺省回大端）。
// pc.refs 键缺失（存量行无 parameter_config）→ 维持既有 config 直通，
// 行为与批次四前逐字节一致（byte_order 仍生效，镜像后端 _build_logic_config）。
const withByteOrder = (config, pc, type) => {
    if (type !== 'length' || !pc) return config || null;
    if (String(pc.byte_order || '').toLowerCase() !== 'little') return config || null;
    const base = config && typeof config === 'object' ? config : {};
    return { ...base, params: { ...(base.params || {}), byte_order: 'little' } };
};

const buildLogicConfig = (node, type, byId) => {
    const pc = node.parameter_config;
    if (!pc || !Array.isArray(pc.refs)) return withByteOrder(node.config, pc, type);
    const leafIds = [];
    const expand = (id) => {
        const target = byId.get(id);
        if (!target) return; // 悬空 → 丢（前端 encoder find 失败同样跳过）
        const kids = target.children || [];
        if (kids.length > 0) kids.forEach(child => expand(child.id));
        else leafIds.push(id);
    };
    pc.refs.forEach(expand);
    const params = { refs: leafIds };
    if (type === 'checksum') {
        params.algorithm = BACKEND_ALGO[pc.algorithm] || 'crc16_modbus';
    }
    const offset = Number(pc.offset);
    if (type === 'length' && Number.isFinite(offset)) params.offset = offset;
    return withByteOrder({
        ...(node.config && typeof node.config === 'object' ? node.config : {}),
        params
    }, pc, type);
};

export const toFrameBlocks = (nodes) => {
    // 全林索引一次（refs 可跨兄弟子树解析）；递归映射共享同一份 byId。
    const byId = new Map();
    const index = (list) => (list || []).forEach(n => {
        if (n && typeof n === 'object' && n.id != null) {
            if (!byId.has(n.id)) byId.set(n.id, n);
            index(n.children);
        }
    });
    index(nodes);

    const mapNode = (node) => {
        const children = node.children?.length ? node.children.map(mapNode) : [];
        const opCode = String(node.op_code || '').toUpperCase();
        let type = node.type;
        if (!type) {
            if (opCode === 'LENGTH_CALC') type = 'length';
            else if (opCode === 'CHECKSUM_CRC') type = 'checksum';
            else if (opCode === 'ARRAY_GROUP' || children.length) type = 'container';
            else type = 'fixed';
        }
        const byteLength = Number.isFinite(node.byte_length)
            ? node.byte_length
            : (Number.isFinite(node.byte_len) ? node.byte_len : 0);

        const isLogic = type === 'length' || type === 'checksum';
        const isBitfield = type === 'bitfield';
        return {
            id: String(node.id),
            type: String(type),
            label: String(node.label || node.name || node.id),
            byte_length: byteLength,
            hex_value: node.hex_value || node.parameter_config?.hex || null,
            config: isLogic
                ? buildLogicConfig(node, type, byId)
                : (isBitfield ? buildBitfieldConfig(node) : (node.config || null)),
            children,
            is_container: Boolean(node.is_container) || children.length > 0,
            is_enabled: node.is_enabled !== false
        };
    };

    return (nodes || []).map(mapNode);
};
