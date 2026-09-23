"""P2 应答匹配规格：纯函数校验 + 匹配判定（事务化发送引擎的判定核心）。

- normalize_spec(spec)：校验并归一化规格——SSOT，非法抛 ValueError（路由层映射
  400）；存储（response_specs.spec）与传输（POST /dispatch/transaction 内联
  response_spec）走同一入口，保证库里和线上判定口径一致。
- match_response(spec, sent, received)：按归一化规格判定一次应答，返回
  (ok, reasons)；reasons 供 UI 展示失配原因（事务逐次 attempt 记录）。

规格五要素（对齐 P2 计划：帧头 / 长度 / CRC 反算 / 掩码忽略区间 / 前缀后缀）：
- prefix / suffix：字面前缀后缀（hex，允许空格/下划线/短横分隔）。
- echo_header_bytes：帧头回显——应答前 N 字节必须等于请求前 N 字节。
- length：应答自带长度字段自洽——声明值 == 实际帧长 + offset_val（语义对齐
  backend/handlers/length.py 的 offset；byte_order 默认 big）。
- checksum：校验字段反算比对——span 区间（默认整帧、恒排除校验字段自身）
  按 sum/xor/crc16_modbus 计算后与字段字节比对；算法与
  backend/handlers/checksum.py、frontend formula.js calculateChecksum 同一套
  （反射多项式 0xA001、初值 0xFFFF），crc16_modbus 线上小端由 byte_order 表达。
- ignore_ranges：掩码忽略区间（mode=echo 逐字节比对时跳过；半开区间 [start, end)）。

mode：echo（默认，结构校验 + 逐字节回显比对）/ rules（仅结构校验）/
any（接受任何非空应答）。结构校验（prefix/suffix/echo_header/length/checksum）
在 echo/rules 两模式下都执行；any 模式不查任何规则。
"""

from typing import Any, Dict, List, Optional, Tuple

VALID_MODES = ("echo", "rules", "any")
VALID_ALGOS = ("sum", "xor", "crc16_modbus")
VALID_BYTE_ORDERS = ("big", "little")

_SPEC_KEYS = {"mode", "prefix", "suffix", "echo_header_bytes", "length", "checksum", "ignore_ranges"}
_LENGTH_KEYS = {"offset", "byte_length", "offset_val", "byte_order"}
_CHECKSUM_KEYS = {"algo", "field_offset", "field_byte_length", "span_start", "span_end", "byte_order"}

_HEX_CLEANUP = " _-,"


def _require_int(value: Any, name: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} 必须是整数")
    if not (lo <= value <= hi):
        raise ValueError(f"{name} 必须在 {lo}..{hi} 范围内")
    return value


def _normalize_hex(value: Any, name: str) -> str:
    """hex 字面量归一：清洗分隔符 → 校验偶数位 → 大写紧凑；空串合法（= 未启用）。"""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{name} 必须是字符串")
    cleaned = value
    for ch in _HEX_CLEANUP:
        cleaned = cleaned.replace(ch, "")
    if not cleaned:
        return ""
    if len(cleaned) % 2 != 0:
        raise ValueError(f"{name} 必须是偶数位十六进制")
    try:
        bytes.fromhex(cleaned)
    except ValueError as e:
        raise ValueError(f"{name} 含非法十六进制字符: {e}") from e
    return cleaned.upper()


def _normalize_length(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("length 必须是对象或 null")
    unknown = set(value) - _LENGTH_KEYS
    if unknown:
        raise ValueError(f"未知 length 字段: {', '.join(sorted(unknown))}")
    byte_order = value.get("byte_order", "big")
    if byte_order not in VALID_BYTE_ORDERS:
        raise ValueError(f"length.byte_order 必须是 {'/'.join(VALID_BYTE_ORDERS)} 之一")
    return {
        "offset": _require_int(value.get("offset", 0), "length.offset", 0, 4095),
        "byte_length": _require_int(value.get("byte_length", 1), "length.byte_length", 1, 4),
        "offset_val": _require_int(value.get("offset_val", 0), "length.offset_val", -4096, 4096),
        "byte_order": byte_order,
    }


def _normalize_checksum(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("checksum 必须是对象或 null")
    unknown = set(value) - _CHECKSUM_KEYS
    if unknown:
        raise ValueError(f"未知 checksum 字段: {', '.join(sorted(unknown))}")
    algo = value.get("algo", "sum")
    if algo not in VALID_ALGOS:
        raise ValueError(f"checksum.algo 必须是 {'/'.join(VALID_ALGOS)} 之一")
    byte_order = value.get("byte_order", "big")
    if byte_order not in VALID_BYTE_ORDERS:
        raise ValueError(f"checksum.byte_order 必须是 {'/'.join(VALID_BYTE_ORDERS)} 之一")
    default_field_bl = 2 if algo == "crc16_modbus" else 1  # crc16 缺省 2 字节（sum/xor 缺省 1）
    field_byte_length = _require_int(
        value.get("field_byte_length", default_field_bl), "checksum.field_byte_length", 1, 4
    )
    if algo == "crc16_modbus" and field_byte_length != 2:
        raise ValueError("crc16_modbus 的校验字段必须是 2 字节")
    span_start = _require_int(value.get("span_start", 0), "checksum.span_start", 0, 4095)
    span_end = value.get("span_end", None)
    if span_end is not None:
        span_end = _require_int(span_end, "checksum.span_end", 1, 8192)
        if span_end <= span_start:
            raise ValueError("checksum.span_end 必须大于 span_start")
    return {
        "algo": algo,
        "field_offset": _require_int(value.get("field_offset", 0), "checksum.field_offset", 0, 4095),
        "field_byte_length": field_byte_length,
        "span_start": span_start,
        "span_end": span_end,
        "byte_order": byte_order,
    }


def _normalize_ignore_ranges(value: Any) -> List[List[int]]:
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise ValueError("ignore_ranges 必须是数组")
    if len(value) > 32:
        raise ValueError("ignore_ranges 最多 32 段")
    ranges: List[List[int]] = []
    for item in value:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise ValueError("ignore_ranges 每段必须是 [start, end] 两元素数组")
        start = _require_int(item[0], "ignore_ranges.start", 0, 8192)
        end = _require_int(item[1], "ignore_ranges.end", 1, 8192)
        if start >= end:
            raise ValueError(f"ignore_ranges 区间非法: [{start}, {end}) 需 start < end")
        ranges.append([start, end])
    ranges.sort(key=lambda pair: pair[0])
    for prev, curr in zip(ranges, ranges[1:]):
        if curr[0] < prev[1]:
            raise ValueError(f"ignore_ranges 区间重叠: [{prev[0]}, {prev[1]}) 与 [{curr[0]}, {curr[1]})")
    return ranges


def normalize_spec(spec: Any) -> Dict[str, Any]:
    """校验并归一化应答规格；非法时抛 ValueError（路由层映射 400）。"""
    if not isinstance(spec, dict):
        raise ValueError("应答规格必须是对象")
    unknown = set(spec) - _SPEC_KEYS
    if unknown:
        raise ValueError(f"未知规格字段: {', '.join(sorted(unknown))}")
    mode = spec.get("mode", "echo")
    if mode not in VALID_MODES:
        raise ValueError(f"未知匹配模式: {mode!r}（可选 echo/rules/any）")
    return {
        "mode": mode,
        "prefix": _normalize_hex(spec.get("prefix"), "prefix"),
        "suffix": _normalize_hex(spec.get("suffix"), "suffix"),
        "echo_header_bytes": _require_int(
            spec.get("echo_header_bytes", 0), "echo_header_bytes", 0, 1024
        ),
        "length": _normalize_length(spec.get("length")),
        "checksum": _normalize_checksum(spec.get("checksum")),
        "ignore_ranges": _normalize_ignore_ranges(spec.get("ignore_ranges")),
    }


def default_spec() -> Dict[str, Any]:
    """缺省规格 = 纯回显比对（loopback 下天然通过；真实设备按指令另配）。"""
    return normalize_spec({"mode": "echo"})


def crc16(data: bytes, poly: int = 0xA001) -> int:
    """反射 MODBUS CRC16——与 backend/handlers/checksum.py、formula.js 同一套。"""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x0001:
                crc = (crc >> 1) ^ poly
            else:
                crc >>= 1
    return crc


def _in_ranges(index: int, ranges: List[List[int]]) -> bool:
    return any(start <= index < end for start, end in ranges)


def _checksum_reasons(cs: Dict[str, Any], frame: bytes) -> List[str]:
    field_off = cs["field_offset"]
    field_bl = cs["field_byte_length"]
    if field_off + field_bl > len(frame):
        return ["CHECKSUM_OUT_OF_RANGE"]

    # span 默认整帧；无论显式与否都排除校验字段自身（反算不自含）。
    span_end = len(frame) if cs["span_end"] is None else min(cs["span_end"], len(frame))
    span_start = min(cs["span_start"], len(frame))
    span_bytes = bytes(
        b
        for i, b in enumerate(frame)
        if span_start <= i < span_end and not (field_off <= i < field_off + field_bl)
    )

    algo = cs["algo"]
    if algo == "sum":
        value = sum(span_bytes) % (256 ** field_bl)
    elif algo == "xor":
        value = 0
        for b in span_bytes:
            value ^= b
    else:
        value = crc16(span_bytes)

    encoded = value.to_bytes(field_bl, cs["byte_order"])
    actual = frame[field_off : field_off + field_bl]
    if encoded != actual:
        return [f"CHECKSUM_MISMATCH(exp={encoded.hex().upper()},got={actual.hex().upper()})"]
    return []


def match_response(spec: Dict[str, Any], sent: bytes, received: bytes) -> Tuple[bool, List[str]]:
    """按归一化规格判定一次应答；返回 (ok, reasons)。

    空应答恒判失败（EMPTY_RESPONSE）——事务引擎的「超时无应答」与「失配」是两类
    失败，分别对应 attempt 状态 NO_RESPONSE / MATCH_FAILED。
    """
    if not received:
        return False, ["EMPTY_RESPONSE"]
    mode = spec.get("mode", "echo")
    if mode == "any":
        return True, []

    reasons: List[str] = []

    # 前缀 / 后缀（字面量）
    prefix = bytes.fromhex(spec.get("prefix") or "")
    if prefix and not received.startswith(prefix):
        reasons.append("PREFIX_MISMATCH")
    suffix = bytes.fromhex(spec.get("suffix") or "")
    if suffix and not received.endswith(suffix):
        reasons.append("SUFFIX_MISMATCH")

    # 帧头回显
    n = spec.get("echo_header_bytes", 0)
    if n > 0:
        if len(received) < n or len(sent) < n:
            reasons.append("ECHO_HEADER_TOO_SHORT")
        elif received[:n] != sent[:n]:
            reasons.append("ECHO_HEADER_MISMATCH")

    # 长度字段自洽
    length = spec.get("length")
    if length:
        off = length["offset"]
        bl = length["byte_length"]
        if off + bl > len(received):
            reasons.append("LENGTH_OUT_OF_RANGE")
        else:
            declared = int.from_bytes(received[off : off + bl], length["byte_order"])
            expected = len(received) + length["offset_val"]
            if declared != expected:
                reasons.append(f"LENGTH_MISMATCH({declared}!={expected})")

    # 校验字段反算
    checksum = spec.get("checksum")
    if checksum:
        reasons.extend(_checksum_reasons(checksum, received))

    # 回显逐字节比对（掩码忽略区间跳过）
    if mode == "echo":
        if len(received) != len(sent):
            reasons.append("ECHO_LENGTH_MISMATCH")
        else:
            ignore = spec.get("ignore_ranges") or []
            for i, (rx, tx) in enumerate(zip(received, sent)):
                if _in_ranges(i, ignore):
                    continue
                if rx != tx:
                    reasons.append(f"ECHO_MISMATCH@{i}")
                    break

    return len(reasons) == 0, reasons
