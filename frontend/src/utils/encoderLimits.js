// P0-1: Single source of truth for encoder limitations (historical B2–B8).
// B2–B8 were ALL resolved by the E1 batch — every semantic below now lives in
// BOTH encoders with byte-equal tests (改一必改二):
// - B5 (INT_SIGNED two's complement) → E1-1: InstructionEncoder.js /
//   orchestrator.encode_int_signed.
// - B6 (endianness=LITTLE reversal) → E1-2: getFieldBytes wrapper /
//   orchestrator._reverse_hex_pairs.
// - B3 (BCD) / B4 (SCALED factor/offset) → E1-3: BCD_CODE / SCALED_DECIMAL
//   branches + encode_bcd / encode_scaled.
// - B2 (FLOAT_IEEE float32) → E1-4: FLOAT_IEEE branch + encode_float_ieee
//   (bits=64 and contradictory types stay out of contract).
// - B7 (ARRAY_GROUP repeat ×N) → E1-5: encodeInstruction tree emit /
//   _repeatCount + datahub.to_block resolve + orchestrator._flatten_recursive.
// - B8 (TIME_ACCUMULATOR / AUTO_COUNTER) → E1-6: TIME_ACCUMULATOR →
//   floor((now − base_time)/1000) 墙钟秒数、AUTO_COUNTER → (Current+Step)%Max,
//   in InstructionEncoder.js branches + orchestrator.encode_time_accumulator /
//   encode_auto_counter; now 可注入（FE opts.now ↔ BE fields_to_blocks(now=…)）。
// - R23 (TIME_EPOCH 绝对时间戳, §8.52 挂账 ①) → 走同一条 now 注入通道：
//   unit=s|ms（缺省 s）→ floor → 通用整数路径定宽截高位，与 BE
//   encode_time_epoch 的 `& mask` byte-equal。位宽不够截低位不计新限制
//   （4 字节秒值覆盖到 2106、毫秒需 ≥5 字节）。
// See PROJECT_HANDOVER.md §7. This module stays the SSOT for any FUTURE
// encoder limitation: an entry + ref-mapping here flows to the panel banner,
// ⚠ badges and save-time validation. Display-only metadata: annotating limits
// here must never be interpreted as changing encoding behavior.

export const ENCODER_LIMITS = {};

// Block-level limits (op_code / block properties) — drives the panel banner
// and the validation warnings. Empty while every known limit is resolved;
// future entries go here (e.g. `if (op === 'X') refs.push('B9')`).
export function getBlockLimitRefs(block) {
    if (!block) return [];
    return [];
}

// Param-key level limits (per op_code) — drives the ⚠ badges next to labels
// in ParamConfigForm / RunnerFieldTree. Empty while every known limit is
// resolved; future entries go here (e.g. `if (key === 'k' && op === 'X') return 'B9'`).
// 占位签名：未来按 (key, opCode) 返回限值，现在恒返 null；参数故意留在签名上，调用方已按两个实参在用。
// eslint-disable-next-line no-unused-vars
export function getParamKeyLimitRef(key, opCode) {
    return null;
}
