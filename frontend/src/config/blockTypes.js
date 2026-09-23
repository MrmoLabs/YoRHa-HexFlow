// Single source of truth for Protocol editor block types.
// Consumed by:
//   - pages/Protocol.jsx               (palette buttons + block factory)
//   - components/editor/ProtocolPropertiesPanel.jsx (property fields per type)
// Adding a new block type here automatically adds its palette button and
// property fields; no JSX branches need to change.

// Field definitions keyed by field id. `parse` converts the raw input event
// value into the stored block property value.
export const BLOCK_PROPERTY_FIELDS = {
    length: {
        key: 'byte_length',
        label: '字节长度 (Length)',
        inputType: 'number',
        min: 1,
        parse: (value) => parseInt(value, 10) || 1
    },
    hex: {
        key: 'hex_value',
        label: '十六进制值 (Hex)',
        inputType: 'text',
        parse: (value) => value
    },
    // A2 refs 引用（一期）：length/checksum 卡选同协议块 —— inputType 引导
    // ProtocolPropertiesPanel 走专用拾取分支（计数 + 芯片 + SELECT FIELDS），
    // key 为点路径，通用 input 不直接读（面板按 inputType 分流）。
    refs: {
        key: 'parameter_config.refs',
        label: '结构引用 (Refs)',
        inputType: 'refs'
    },
    // 批次四: checksum 算法配置 —— 存点 parameter_config.algorithm（镜像
    // 指令页 B1 aliasChecksumAlgo 的前端编码器存点，PASS2 同源直读），
    // 出口由 toFrameBlocks 翻成后端 config.params.algorithm（sum/xor/
    // crc16_modbus）。值域 = formula.js ChecksumAlgo 三值（CRC_32 无实现，
    // 不列入）。key 点路径 + inputType select → 面板专用分支（同 refs 口径）。
    algo: {
        key: 'parameter_config.algorithm',
        label: '校验算法 (Algorithm)',
        inputType: 'select',
        default: 'CRC_16_MODBUS',
        options: [
            { value: 'SUM_8', label: 'SUM8' },
            { value: 'XOR_8', label: 'XOR8' },
            { value: 'CRC_16_MODBUS', label: 'CRC16-MODBUS' }
        ]
    }
};

// Order in BLOCK_TYPES drives the palette order (container first, divider
// after the first entry — see Protocol.jsx palette rendering).
export const BLOCK_TYPES = [
    {
        type: 'container',
        defaultLabel: '新容器',
        defaultByteLength: 0,
        nestable: true,
        palette: { title: '新建容器', mainLabel: 'PKG', subLabel: 'PKG', dashed: false },
        fields: []
    },
    {
        type: 'fixed',
        defaultLabel: '固定块',
        defaultByteLength: 1,
        nestable: false,
        palette: { title: '添加固定块 (Fixed)', mainLabel: '固定', subLabel: 'FIX', dashed: false },
        fields: ['length', 'hex']
    },
    {
        type: 'length',
        defaultLabel: 'LENGTH',
        defaultByteLength: 1,
        nestable: false,
        palette: { title: '添加长度 (Length)', mainLabel: '长度', subLabel: 'LEN', dashed: false },
        // A2: length 卡加 refs 结构引用（选同协议块 → 设计期 Σ 回显 / 编码期
        // PASS1 求和）。
        fields: ['length', 'refs']
    },
    {
        type: 'checksum',
        defaultLabel: 'CHECKSUM',
        defaultByteLength: 1,
        nestable: false,
        palette: { title: '添加校验 (Checksum)', mainLabel: '校验', subLabel: 'CRC', dashed: false },
        // A2: checksum 卡加 refs（编码期 PASS2 按算法吃 refs 字节）。
        // 批次四: + algo 算法下拉（存 parameter_config.algorithm）。
        fields: ['length', 'refs', 'algo']
    },
    {
        type: 'slot',
        defaultLabel: 'SLOT',
        defaultByteLength: 1,
        nestable: false,
        palette: { title: '添加插槽 (Slot)', mainLabel: '插槽', subLabel: 'SLOT', dashed: true },
        fields: ['length']
    }
];

export const getBlockType = (type) => BLOCK_TYPES.find((t) => t.type === type) || null;

export const isNestable = (type) => Boolean(getBlockType(type)?.nestable);

// Fully-resolved field definitions (id merged in) for the properties panel.
export const getBlockFields = (type) =>
    (getBlockType(type)?.fields || []).map((id) => ({ id, ...BLOCK_PROPERTY_FIELDS[id] }));

// Block factory: mirrors the historical inline defaults in Protocol.jsx.
export const createBlock = (type, makeId) => {
    const def = getBlockType(type) || {};
    return {
        id: makeId(),
        label: def.defaultLabel || type.toUpperCase(),
        type,
        byte_length: def.defaultByteLength ?? 1,
        hex_value: '00',
        children: def.nestable ? [] : undefined,
        config: {},
        // A1: length/checksum 卡初始化 parameter_config —— type 使编码器
        // PASS1（:419 对称闸）/ PASS2（:453 checksum 兜底）命中，refs 为拾取
        // 槽（UI 写入）、algorithm 为算法槽（批次四下拉写入）。
        // 批次四（R2 打通）: 后端导出所需的 config 不在此持久 —— 出口由
        // toFrameBlocks 从 parameter_config 翻译（refs 叶子展开 + 算法枚举
        // 映射），单一 SSOT 不双写。
        ...(type === 'length' || type === 'checksum'
            ? { parameter_config: { type, refs: [] } }
            : {})
    };
};
