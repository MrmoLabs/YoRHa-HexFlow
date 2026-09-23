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
        fields: ['length', 'refs']
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
        // 槽（UI 写入）。后端导出仍走死 config={}（R2 记档的既存边界，不修）。
        ...(type === 'length' || type === 'checksum'
            ? { parameter_config: { type, refs: [] } }
            : {})
    };
};
