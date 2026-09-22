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
        fields: ['length']
    },
    {
        type: 'checksum',
        defaultLabel: 'CHECKSUM',
        defaultByteLength: 1,
        nestable: false,
        palette: { title: '添加校验 (Checksum)', mainLabel: '校验', subLabel: 'CRC', dashed: false },
        fields: ['length']
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
        config: {}
    };
};
