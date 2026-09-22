// P0-1: Single source of truth for encoder limitations B2–B8.
// See PROJECT_HANDOVER.md §7. These configs are stored and SHOWN in the UI but
// NOT consumed by InstructionEncoder.js / orchestrator.py (do-not-edit scope).
// This module is display-only metadata: annotating limits here must never be
// interpreted as changing encoding behavior.

export const ENCODER_LIMITS = {
    B2: 'FLOAT_IEEE 按普通整数编码（编码器浮点分支需 type=float，算子模板从不设置）',
    B3: 'BCD_CODE 无 BCD 分支（25 → 0x19 而非 0x25）',
    B4: 'factor/offset 不参与编码，字节按裸整数输出',
    B5: 'INT_SIGNED 负数按 Math.abs 编码（-1 → 01），非补码',
    B6: 'endianness=LITTLE 仅存储，编码恒按大端',
    B7: 'repeat 只展开一次（FIXED×N 只编 1 份）',
    B8: '计数器 step/max 不自动递增；时间按输入秒数直接编码',
};

// Block-level limits (op_code / block properties) — drives the panel banner
// and the validation warnings.
export function getBlockLimitRefs(block) {
    if (!block) return [];
    const op = String(block.op_code || '').toUpperCase();
    const refs = [];
    if (op.includes('FLOAT')) refs.push('B2');
    if (op.includes('BCD')) refs.push('B3');
    if (op.includes('SCALED')) refs.push('B4');
    if (op.includes('INT_SIGNED')) refs.push('B5');
    if (String(block.endianness || '').toUpperCase() === 'LITTLE') refs.push('B6');
    if ((op.includes('ARRAY_GROUP') || op.includes('STRUCT'))
        && block.repeat_type && block.repeat_type !== 'NONE') {
        refs.push('B7');
    }
    if (op.includes('COUNTER') || op.includes('TIME')) refs.push('B8');
    return refs;
}

// Param-key level limits (per op_code) — drives the ⚠ badges next to labels
// in ParamConfigForm / RunnerFieldTree.
export function getParamKeyLimitRef(key, opCode) {
    const op = String(opCode || '').toUpperCase();
    if (key === 'factor' || key === 'offset') return 'B4';
    if (key === 'max_count') return 'B7';
    if ((key === 'step' || key === 'max') && op.includes('COUNTER')) return 'B8';
    return null;
}
