"""P3 序列步骤的发送时重算计划：归一校验（保存时）+ 帧补丁（发送时）。

背景（P3 契约定案，沿用户批复「序列步骤参数 = 保存时定值，TIME/COUNTER
发送时重算」）：P4 前端在保存步骤时用 encodeInstruction 产出完整帧 hex 存入
`sequence_steps.payload`（表单值冻结在 `params`），此后改指令定义不影响已
存序列。发送时仅按 plan 补两类字节：

- plan.dynamic：TIME_ACCUMULATOR / AUTO_COUNTER 字段按发送时刻重算
  （offset/byte_len 来自前端 `encodeInstruction.byteMap`；编码走 E1-6 双端
  byte-equal 锚定的 `encode_time_accumulator` / `encode_auto_counter`）。
  字段定宽 → 补丁等长替换、帧长不变；长度字段（LENGTH_CALC）按字节数计、
  与值无关 → 冻结帧内的长度字节恒有效，无需重算。
- plan.checksum：校验字段按 regions（前端 checksum refs 各字段在帧内的字节
  区间，按 refs 数组顺序拼接——sum/xor 序无关、crc16 按此序）跨区间反算后
  写回字段，按 byte_order 落地。数值与区间语义复用
  `response_match.checksum_value` / 排除字段自含的约定（写入与应答反算同源；
  crc16 与 handlers/checksum.py、formula.js calculateChecksum 同一套）。

`normalize_plan(payload_hex, plan)`：保存与启动共用的形态 SSOT——非法抛
ValueError（路由映射 400；POST /{id}/start 再走一次，防库内脏数据）。
`apply_plan(data, plan, now_ms)`：执行补丁返回 bytes；无计划 = 原帧。

纯函数，stdlib unittest 直测（backend/tests/test_sequence_plan.py）。
"""
from typing import Any, Dict, List, Optional, Tuple

from backend.core.orchestrator import _iso_ms, encode_auto_counter, encode_time_accumulator
from backend.core.response_match import VALID_ALGOS, VALID_BYTE_ORDERS, checksum_value

_MAX_PAYLOAD_BYTES = 4096
_DYNAMIC_OPS = ("TIME_ACCUMULATOR", "AUTO_COUNTER")
_HEX_CLEANUP = " \t\r\n,_-"
_SCALAR = (int, float, str, type(None))  # 计数模板值：JSON 标量（bool/对象/数组拒绝）

_TIME_KEYS = {"field_id", "op", "offset", "byte_len", "base_time"}
_COUNTER_KEYS = {"field_id", "op", "offset", "byte_len", "value", "start_val", "step", "max"}
_CHECKSUM_KEYS = {"offset", "byte_length", "algo", "byte_order", "regions"}
_PLAN_KEYS = {"dynamic", "checksum"}


def _require_int(value: Any, name: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} 必须是整数")
    if not (lo <= value <= hi):
        raise ValueError(f"{name} 必须在 {lo}..{hi} 范围内")
    return value


def _clean_payload(payload: Any) -> bytes:
    """帧 hex 归一：清洗分隔符 → 偶数位 → 合法 → 长度上限。"""
    if not isinstance(payload, str):
        raise ValueError("payload 必须是字符串")
    cleaned = payload
    for ch in _HEX_CLEANUP:
        cleaned = cleaned.replace(ch, "")
    if not cleaned:
        raise ValueError("payload 不能为空")
    if len(cleaned) % 2 != 0:
        raise ValueError("payload 必须是偶数位十六进制")
    try:
        data = bytes.fromhex(cleaned)
    except ValueError as e:
        raise ValueError(f"payload 含非法十六进制字符: {e}") from e
    if len(data) > _MAX_PAYLOAD_BYTES:
        raise ValueError(f"payload 超长（最多 {_MAX_PAYLOAD_BYTES} 字节）")
    return data


def _encode_dynamic(entry: Dict[str, Any], now_ms: float) -> Optional[str]:
    """单条动态补丁编码（定宽大端 hex）；TIME 按注入墙钟、COUNTER 按模板公式。"""
    byte_len = entry["byte_len"]
    if entry["op"] == "TIME_ACCUMULATOR":
        return encode_time_accumulator(entry["base_time"], now_ms, byte_len)
    return encode_auto_counter(
        entry.get("value"), entry.get("start_val"),
        entry.get("step"), entry.get("max"), byte_len,
    )


def _normalize_dynamic(payload_len: int, raw: Any) -> List[Dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("plan.dynamic 必须是数组")
    if len(raw) > 32:
        raise ValueError("plan.dynamic 最多 32 项")
    entries: List[Dict[str, Any]] = []
    for i, item in enumerate(raw):
        where = f"plan.dynamic[{i}]"
        if not isinstance(item, dict):
            raise ValueError(f"{where} 必须是对象")
        op = item.get("op")
        if op not in _DYNAMIC_OPS:
            raise ValueError(f"{where}.op 必须是 {'/'.join(_DYNAMIC_OPS)} 之一")
        allowed = _TIME_KEYS if op == "TIME_ACCUMULATOR" else _COUNTER_KEYS
        unknown = set(item) - allowed
        if unknown:
            raise ValueError(f"{where} 未知字段: {', '.join(sorted(unknown))}")
        entry: Dict[str, Any] = {
            "op": op,
            "offset": _require_int(item.get("offset"), f"{where}.offset", 0, _MAX_PAYLOAD_BYTES - 1),
            "byte_len": _require_int(item.get("byte_len"), f"{where}.byte_len", 1, 64),
        }
        if entry["offset"] + entry["byte_len"] > payload_len:
            raise ValueError(f"{where} 超出 payload 范围")
        if item.get("field_id") is not None:
            entry["field_id"] = str(item["field_id"])
        if op == "TIME_ACCUMULATOR":
            base = item.get("base_time")
            if not isinstance(base, str) or not base:
                raise ValueError(f"{where}.base_time 必填（ISO 时间串）")
            if _iso_ms(base) is None:
                raise ValueError(f"{where}.base_time 非法: {base!r}")
            entry["base_time"] = base
            probe_now = _iso_ms(base) + 1000  # 固定探针时点（保存时验证定宽）
        else:
            probe_now = 0.0  # COUNTER 与墙钟无关
            for key in ("value", "start_val", "step", "max"):
                if key in item:
                    value = item[key]
                    if isinstance(value, bool) or not isinstance(value, _SCALAR):
                        raise ValueError(f"{where}.{key} 必须是数值或数字字符串")
                    entry[key] = value
        # 保存时试算：编码产物必须定宽 = byte_len（否则发送时无法等长替换）
        probe = _encode_dynamic(entry, probe_now)
        if probe is None:
            raise ValueError(f"{where} 编码失败（检查模板参数）")
        if len(probe.replace(" ", "")) != entry["byte_len"] * 2:
            raise ValueError(
                f"{where} 编码宽度 {len(probe.replace(' ', '')) // 2} ≠ byte_len {entry['byte_len']}"
            )
        entries.append(entry)
    return entries


def _normalize_checksum(payload_len: int, raw: Any) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("plan.checksum 必须是对象或 null")
    unknown = set(raw) - _CHECKSUM_KEYS
    if unknown:
        raise ValueError(f"plan.checksum 未知字段: {', '.join(sorted(unknown))}")
    algo = raw.get("algo", "sum")
    if algo not in VALID_ALGOS:
        raise ValueError(f"plan.checksum.algo 必须是 {'/'.join(VALID_ALGOS)} 之一")
    byte_order = raw.get("byte_order", "big")
    if byte_order not in VALID_BYTE_ORDERS:
        raise ValueError(f"plan.checksum.byte_order 必须是 {'/'.join(VALID_BYTE_ORDERS)} 之一")
    checksum: Dict[str, Any] = {
        "offset": _require_int(raw.get("offset"), "plan.checksum.offset", 0, _MAX_PAYLOAD_BYTES - 1),
        "byte_length": _require_int(raw.get("byte_length"), "plan.checksum.byte_length", 1, 4),
        "algo": algo,
        "byte_order": byte_order,
    }
    if algo == "crc16_modbus" and checksum["byte_length"] != 2:
        raise ValueError("crc16_modbus 的校验字段必须是 2 字节")
    if checksum["offset"] + checksum["byte_length"] > payload_len:
        raise ValueError("plan.checksum 超出 payload 范围")

    regions_raw = raw.get("regions")
    if not isinstance(regions_raw, list) or not regions_raw:
        raise ValueError("plan.checksum.regions 必须是非空数组")
    regions: List[List[int]] = []
    field_off = checksum["offset"]
    field_end = field_off + checksum["byte_length"]
    for j, region in enumerate(regions_raw):
        if not isinstance(region, (list, tuple)) or len(region) != 2:
            raise ValueError(f"regions[{j}] 必须是 [start, end] 两元素数组")
        start = _require_int(region[0], f"regions[{j}].start", 0, _MAX_PAYLOAD_BYTES)
        end = _require_int(region[1], f"regions[{j}].end", 1, _MAX_PAYLOAD_BYTES)
        if start >= end:
            raise ValueError(f"regions[{j}] 区间非法: [{start}, {end}) 需 start < end")
        if end > payload_len:
            raise ValueError(f"regions[{j}] 超出 payload 范围")
        if start < field_end and end > field_off:
            raise ValueError("regions 不得与校验字段自身重叠（反算不自含）")
        regions.append([start, end])
    checksum["regions"] = regions
    return checksum


def normalize_plan(payload_hex: Any, plan: Any) -> Tuple[bytes, Optional[Dict[str, Any]]]:
    """校验并归一化 (payload, plan) → (帧字节, 归一化计划)；非法抛 ValueError。

    plan 为 None → (帧, None)（原样发送）。归一化计划为严格形态：
    {"dynamic": [...], "checksum": {...} | None}——未知键一律拒绝（同 P2
    normalize_spec 的严格纪律，防前端字段名漂移静默失效）。
    """
    data = _clean_payload(payload_hex)
    if plan is None:
        return data, None
    if not isinstance(plan, dict):
        raise ValueError("plan 必须是对象或 null")
    unknown = set(plan) - _PLAN_KEYS
    if unknown:
        raise ValueError(f"未知 plan 字段: {', '.join(sorted(unknown))}")
    return data, {
        "dynamic": _normalize_dynamic(len(data), plan.get("dynamic")),
        "checksum": _normalize_checksum(len(data), plan.get("checksum")),
    }


def apply_plan(data: bytes, plan: Optional[Dict[str, Any]], now_ms: float) -> bytes:
    """执行发送时补丁：动态字段等长重算 + 校验字段跨区间反算写回。

    data 为帧字节（路由在启动时已 normalize_plan 归一；传 hex 字符串 →
    ValueError 记步 ERROR，不落到 Runner 级兜底）。plan None/空 → 原帧。
    now_ms = 发送时刻墙钟（epoch ms，测试可注入）。
    计划形态非法（库内脏数据）→ ValueError（Runner 记步 ERROR，不发送）。
    """
    if isinstance(data, str):
        raise ValueError("apply_plan 需要帧字节 bytes（路由在启动时已归一为 bytes）")
    if not plan:
        return bytes(data)
    frame = bytearray(data)
    for entry in plan.get("dynamic") or []:
        hex_val = _encode_dynamic(entry, now_ms)
        if hex_val is None:
            raise ValueError(f"{entry.get('op')} 编码失败（base_time 非法？）")
        compact = hex_val.replace(" ", "")
        expected = entry["byte_len"] * 2
        if len(compact) != expected:
            raise ValueError(f"{entry.get('op')} 编码宽度 {len(compact) // 2} ≠ byte_len {entry['byte_len']}")
        if entry["offset"] + entry["byte_len"] > len(frame):
            raise ValueError(f"{entry.get('op')} 补丁超出帧范围")
        frame[entry["offset"] : entry["offset"] + entry["byte_len"]] = bytes.fromhex(compact)
    checksum = plan.get("checksum")
    if checksum:
        regions = checksum.get("regions") or []
        if not regions:
            raise ValueError("plan.checksum.regions 为空")
        span = b"".join(bytes(frame[start:end]) for start, end in regions)
        field_bl = checksum["byte_length"]
        value = checksum_value(checksum["algo"], span, field_bl)
        offset = checksum["offset"]
        if offset + field_bl > len(frame):
            raise ValueError("plan.checksum 字段超出帧范围")
        frame[offset : offset + field_bl] = value.to_bytes(field_bl, checksum["byte_order"])
    return bytes(frame)
