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
from backend.core.response_match import ALGO_FIELD_WIDTH, VALID_ALGOS, VALID_BYTE_ORDERS, checksum_value

_MAX_PAYLOAD_BYTES = 4096
_DYNAMIC_OPS = ("TIME_ACCUMULATOR", "AUTO_COUNTER")
_HEX_CLEANUP = " \t\r\n,_-"
_SCALAR = (int, float, str, type(None))  # 计数模板值：JSON 标量（bool/对象/数组拒绝）

_TIME_KEYS = {"field_id", "op", "offset", "byte_len", "base_time"}
_COUNTER_KEYS = {"field_id", "op", "offset", "byte_len", "value", "start_val", "step", "max"}
_CHECKSUM_KEYS = {"offset", "byte_length", "algo", "byte_order", "regions"}
# CP3 3c (D6-B): 序列封装帧 —— 冻结完整帧里外壳的逐层区间（同上严格键集，
# 未知键一律 ValueError → 400；前端不产此键、由路由保存期注入，见
# recipe_compile.shell_plan）。
_PLAN_KEYS = {"dynamic", "checksum", "shell"}
_SHELL_KEYS = {"recipe_id", "definition_hash", "kernel", "layers"}
_SHELL_KERNEL_KEYS = {"offset", "length"}
_SHELL_LAYER_KEYS = {"index", "offset", "size", "length", "checksum"}
_SHELL_FIELD_KEYS = {"offset", "byte_length"}
_MAX_SHELL_LAYERS = 4


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
    # R22 (§8.52 排期): 固定宽算法下限 —— 缺了会在 checksum_value 的
    # to_bytes(field_byte_length) 上抛 OverflowError → 500，故收口为 400。
    required = ALGO_FIELD_WIDTH.get(algo)
    if required is not None and checksum["byte_length"] < required:
        raise ValueError(f"{algo} 的校验字段须 ≥ {required} 字节（实为 {checksum['byte_length']}）")
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


def _normalize_shell(payload_len: int, raw: Any) -> Optional[Dict[str, Any]]:
    """`plan.shell` 归一：冻结完整帧里外壳的逐层区间（D6-B）。

    坐标口径 = **最终帧绝对字节**（`recipe_compile.shell_plan` 产出），故越界
    校验与 `payload_len` 同一把尺。嵌套不变量：层序 0..n-1 连续、offset 严格
    递减、最外层恒 0、内核必须落在第 0 层区间内 —— 任一不成立即认为冻结帧与
    配方不同步（防止拿旧区间去切新帧）。
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("plan.shell 必须是对象或 null")
    unknown = set(raw) - _SHELL_KEYS
    if unknown:
        raise ValueError(f"plan.shell 未知字段: {', '.join(sorted(unknown))}")

    recipe_id = raw.get("recipe_id")
    if not isinstance(recipe_id, str) or not (1 <= len(recipe_id) <= 64):
        raise ValueError("plan.shell.recipe_id 必须是 1..64 字符")

    kernel_raw = raw.get("kernel")
    if not isinstance(kernel_raw, dict):
        raise ValueError("plan.shell.kernel 必须是对象")
    unknown = set(kernel_raw) - _SHELL_KERNEL_KEYS
    if unknown:
        raise ValueError(f"plan.shell.kernel 未知字段: {', '.join(sorted(unknown))}")
    kernel = {
        "offset": _require_int(kernel_raw.get("offset"), "plan.shell.kernel.offset", 0, payload_len),
        "length": _require_int(kernel_raw.get("length"), "plan.shell.kernel.length", 1, payload_len),
    }
    if kernel["offset"] + kernel["length"] > payload_len:
        raise ValueError("plan.shell.kernel 超出 payload 范围")

    layers_raw = raw.get("layers")
    if not isinstance(layers_raw, list) or not layers_raw:
        raise ValueError("plan.shell.layers 必须是非空数组")
    if len(layers_raw) > _MAX_SHELL_LAYERS:
        raise ValueError(f"plan.shell.layers 最多 {_MAX_SHELL_LAYERS} 层")

    layers: List[Dict[str, Any]] = []
    prev_start: Optional[int] = None
    for i, item in enumerate(layers_raw):
        where = f"plan.shell.layers[{i}]"
        if not isinstance(item, dict):
            raise ValueError(f"{where} 必须是对象")
        unknown = set(item) - _SHELL_LAYER_KEYS
        if unknown:
            raise ValueError(f"{where} 未知字段: {', '.join(sorted(unknown))}")
        index = _require_int(item.get("index"), f"{where}.index", 0, _MAX_SHELL_LAYERS - 1)
        if index != i:
            raise ValueError(f"{where}.index 必须按层序连续（期望 {i}，得到 {index}）")
        start = _require_int(item.get("offset"), f"{where}.offset", 0, payload_len)
        size = _require_int(item.get("size"), f"{where}.size", 1, payload_len)
        if start + size > payload_len:
            raise ValueError(f"{where} 超出 payload 范围")
        if prev_start is not None and start >= prev_start:
            raise ValueError(f"{where}.offset 必须小于外层（外壳由外向内逐层嵌套）")
        for kind in ("length", "checksum"):
            rows_raw = item.get(kind)
            if rows_raw is None:
                rows_raw = []
            if not isinstance(rows_raw, list):
                raise ValueError(f"{where}.{kind} 必须是数组")
            rows: List[Dict[str, int]] = []
            for j, row in enumerate(rows_raw):
                row_where = f"{where}.{kind}[{j}]"
                if not isinstance(row, dict):
                    raise ValueError(f"{row_where} 必须是对象")
                unknown = set(row) - _SHELL_FIELD_KEYS
                if unknown:
                    raise ValueError(f"{row_where} 未知字段: {', '.join(sorted(unknown))}")
                field_offset = _require_int(
                    row.get("offset"), f"{row_where}.offset", 0, payload_len
                )
                byte_length = _require_int(
                    row.get("byte_length"), f"{row_where}.byte_length", 1, 8
                )
                if field_offset < start or field_offset + byte_length > start + size:
                    raise ValueError(f"{row_where} 超出该层区间")
                rows.append({"offset": field_offset, "byte_length": byte_length})
            item = {**item, kind: rows}
        layers.append(item)
        prev_start = start

    if layers[-1]["offset"] != 0:
        raise ValueError("plan.shell.layers 最外层 offset 必须为 0（= 冻结帧起点）")
    first = layers[0]
    if not (
        first["offset"] <= kernel["offset"]
        and kernel["offset"] + kernel["length"] <= first["offset"] + first["size"]
    ):
        raise ValueError("plan.shell.kernel 必须落在第 1 层区间内")

    shell: Dict[str, Any] = {"recipe_id": recipe_id, "kernel": kernel, "layers": layers}
    definition_hash = raw.get("definition_hash")
    if definition_hash is not None:
        if not isinstance(definition_hash, str) or not definition_hash:
            raise ValueError("plan.shell.definition_hash 必须是字符串")
        shell["definition_hash"] = definition_hash
    return shell


def normalize_plan(payload_hex: Any, plan: Any) -> Tuple[bytes, Optional[Dict[str, Any]]]:
    """校验并归一化 (payload, plan) → (帧字节, 归一化计划)；非法抛 ValueError。

    plan 为 None → (帧, None)（原样发送）。归一化计划为严格形态：
    {"dynamic": [...], "checksum": {...} | None}——未知键一律拒绝（同 P2
    normalize_spec 的严格纪律，防前端字段名漂移静默失效）。

    CP3 3c (D6-B)：plan 带 `shell`（序列封装帧的逐层外壳区间）时**才**多出
    第三个键 `shell`；存量步骤的归一化形状逐字不变（零回归锚）。
    """
    data = _clean_payload(payload_hex)
    if plan is None:
        return data, None
    if not isinstance(plan, dict):
        raise ValueError("plan 必须是对象或 null")
    unknown = set(plan) - _PLAN_KEYS
    if unknown:
        raise ValueError(f"未知 plan 字段: {', '.join(sorted(unknown))}")
    normalized: Dict[str, Any] = {
        "dynamic": _normalize_dynamic(len(data), plan.get("dynamic")),
        "checksum": _normalize_checksum(len(data), plan.get("checksum")),
    }
    if "shell" in plan:
        shell = _normalize_shell(len(data), plan.get("shell"))
        if shell is not None:
            normalized["shell"] = shell
    return data, normalized


def core_plan(plan: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """D6-B：拆出**内核侧**补丁（dynamic/checksum），供套壳前先打内核补丁。

    内核侧区间相对内核帧（与前端 buildPlan 同一坐标），故须先切内核再补丁；
    `shell` 只是外壳几何，不参与补丁。
    """
    if not plan:
        return None
    if "shell" not in plan:
        return plan
    return {"dynamic": plan.get("dynamic"), "checksum": plan.get("checksum")}


def kernel_slice(data: bytes, plan: Optional[Dict[str, Any]]) -> bytes:
    """D6-B：冻结完整帧 → 内核帧（无 shell → 原样；越界 → ValueError）。"""
    shell = (plan or {}).get("shell")
    if not shell:
        return bytes(data)
    kernel = shell.get("kernel") or {}
    start = int(kernel.get("offset", -1))
    length = int(kernel.get("length", 0))
    if start < 0 or length <= 0 or start + length > len(data):
        raise ValueError("plan.shell.kernel 超出冻结帧")
    return bytes(data[start:start + length])


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
