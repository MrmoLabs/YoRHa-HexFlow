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
    // 批 4: 结构化位域 —— 键是数组（不是点路径），面板按 inputType='bits'
    // 走专用分支复用 BitFieldEditor（与 refs 同款分流约定）。
    bits: {
        key: 'bits',
        label: '位域布局 (Bits)',
        inputType: 'bits'
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
    },
    // 批次二 (D3/D14①): 插槽溢出/欠载策略 —— 存点 parameter_config.fit_policy
    // {overflow: append|reject, underflow: zero_fill|reject}（零 DDL，§3 表）。
    // 后端 frame_builder 执行（reject → 400），保存期 protocol.py 校验取值。
    // key 点路径 + inputType 'fit' → 面板专用分支（两个下拉 + 缺省口径注记），
    // 同 refs/algo 的「inputType 分流」约定。
    fit: {
        key: 'parameter_config.fit_policy',
        label: '装填策略 (Fit Policy)',
        inputType: 'fit'
    },
    // R21（§8.52 排期 · 长度域 BE/LE）: 长度块字节序 —— 存点
    // parameter_config.byte_order（big | little，缺省 big），与**收侧**回显规则
    // response_spec.length.byte_order **同值域**（能判也能发）；出线由后端
    // LengthHandler 按此反转字节对（toFrameBlocks / frame_builder._build_logic_config
    // 同形翻译进 config.params），设计期卡面同口径（protocolTree）。仅 length 卡
    // 列此字段（校验块 byte_order 不在 R21 范围）。
    byte_order: {
        key: 'parameter_config.byte_order',
        label: '长度字节序 (Byte Order)',
        inputType: 'select',
        default: 'big',
        options: [
            { value: 'big', label: '大端 (BIG)' },
            { value: 'little', label: '小端 (LITTLE)' }
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
        // 批 4: 位域块 —— 结构化 bits[] 定义，编码期（后端 Orchestrator
        // 发射期）按 default_val 打包成定宽大端字节。静态语义：发送期不改值。
        type: 'bitfield',
        defaultLabel: '位域块',
        defaultByteLength: 1,
        nestable: false,
        palette: { title: '添加位域 (Bitfield)', mainLabel: '位域', subLabel: 'BIT', dashed: false },
        fields: ['length', 'bits']
    },
    {
        type: 'length',
        defaultLabel: 'LENGTH',
        defaultByteLength: 1,
        nestable: false,
        palette: { title: '添加长度 (Length)', mainLabel: '长度', subLabel: 'LEN', dashed: false },
        // A2: length 卡加 refs 结构引用（选同协议块 → 设计期 Σ 回显 / 编码期
        // PASS1 求和）。
        // R21: + byte_order 长度字节序下拉（parameter_config.byte_order，出线
        // 大端/小端；缺省 big = 现状逐字节不变）。
        fields: ['length', 'refs', 'byte_order']
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
        // 批次二 (D3): + fit 装填策略下拉（溢出/欠载），存 parameter_config
        fields: ['length', 'fit']
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
        // 批 4: 位域块预置 bits 空数组（面板位编辑器直接绑定；后端 schema
        // 缺省亦为 []，双端一致）。
        ...(type === 'bitfield' ? { bits: [] } : {}),
        // A1: length/checksum 卡初始化 parameter_config —— type 使编码器
        // PASS1（:419 对称闸）/ PASS2（:453 checksum 兜底）命中，refs 为拾取
        // 槽（UI 写入）、algorithm 为算法槽（批次四下拉写入）。
        // 批次四（R2 打通）: 后端导出所需的 config 不在此持久 —— 出口由
        // toFrameBlocks 从 parameter_config 翻译（refs 叶子展开 + 算法枚举
        // 映射），单一 SSOT 不双写。
        ...(type === 'length' || type === 'checksum'
            ? { parameter_config: { type, refs: [] } }
            : {}),
        // 批次二 (D14①): 新建槽默认 fit_policy=reject（防错；存量槽不迁移、保持
        // 缺省 append/zero_fill，属性面板 fit 下拉可改回）。
        ...(type === 'slot'
            ? { parameter_config: { fit_policy: { overflow: 'reject', underflow: 'reject' } } }
            : {})
    };
};
