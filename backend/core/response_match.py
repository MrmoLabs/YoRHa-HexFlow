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

CP3 3d (D5-A × D15-A)：**分层规格 `stages`** —— 形态丙下设备应答是链路壳帧，
要先解链路壳、再解应用壳才轮得到内核帧的五要素，故「据此生成」按配方每层各
执行一次，产出 `stages[0..n-1]`（**index 0 = 最内层**，与 frame_recipes.stages /
plan.shell.layers 同序）。匹配时按 `stages` **逆序**（n-1 → 0）逐层跑五要素，
每检完一层用该层 `unpack`（head/trailer 字节数）把内层块剥出来再喂下一层：
- 无 `stages` 键 = 单层（存量手工规格 / 无配方指令的「据此生成」）→ 走原单帧
  路径，**逐字节不变**（存量零改）；
- 多层时顶层五要素退化为「整帧 framing」：只保留 mode / prefix / suffix /
  ignore_ranges，echo_header_bytes / length / checksum 必须按层写进 stages[..]
  （否则 400），mode 不得为 echo（逐层结构校验用 rules）；
- 每层 `unpack.head` = 该层帧头字节数、`unpack.trailer` = 帧尾字节数，
  两者不可同时为 0（否则层与层不可区分）。请求侧 `sent` 按同一几何同步剥层，
  使逐层 `echo_header_bytes` 比的是**同层**帧头。
"""

from typing import Any, Dict, List, Optional, Tuple

VALID_MODES = ("echo", "rules", "any")
VALID_ALGOS = ("sum", "xor", "crc16_modbus")
VALID_BYTE_ORDERS = ("big", "little")

# 与 backend/schemas/recipe_api.MAX_RECIPE_STAGES 同值（配方层数上限），镜像
# recipe_compile 的「核心结构不 import schemas」纪律，此处独立声明免循环引用。
MAX_STAGES = 4

_SPEC_KEYS = {"mode", "prefix", "suffix", "echo_header_bytes", "length", "checksum", "ignore_ranges", "stages"}
_STAGE_KEYS = {"prefix", "suffix", "echo_header_bytes", "length", "checksum", "unpack"}
_UNPACK_KEYS = {"head", "trailer"}
_LENGTH_KEYS = {"offset", "byte_length", "offset_val", "byte_order", "offset_from_end"}
_CHECKSUM_KEYS = {"algo", "field_offset", "field_byte_length", "span_start", "span_end", "byte_order", "span_end_pad", "field_offset_from_end"}

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
    offset = _require_int(value.get("offset", 0), "length.offset", 0, 4095)
    # CP3 3d (D15-A): 插槽之后的 length 块，帧内绝对位置取决于载荷长度，静态
    # 不可知 → 用「字段起点到帧尾的字节数」表达（offset_from_end）。与 offset 互斥。
    offset_from_end = value.get("offset_from_end", None)
    if offset_from_end is not None:
        offset_from_end = _require_int(offset_from_end, "length.offset_from_end", 0, 4095)
        if offset != 0:
            raise ValueError("length.offset 与 length.offset_from_end 只能给其一")
    return {
        "offset": offset,
        "byte_length": _require_int(value.get("byte_length", 1), "length.byte_length", 1, 4),
        "offset_val": _require_int(value.get("offset_val", 0), "length.offset_val", -4096, 4096),
        "byte_order": byte_order,
        "offset_from_end": offset_from_end,
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
    # CP3 3d (D15-A): span 末端 = (span_end ?? len(frame)) - span_end_pad —— 生成
    # 「refs 只圈载荷」的层规格时，载荷区末尾在帧尾前 trailer 字节，而匹配期帧长
    # 未知，故用 pad 表达「离帧尾差几个字节」。缺省 0 = 到 span_end/帧尾，存量零改。
    span_end_pad = _require_int(value.get("span_end_pad", 0), "checksum.span_end_pad", 0, 8192)
    field_offset = _require_int(value.get("field_offset", 0), "checksum.field_offset", 0, 4095)
    # 同 offset_from_end：插槽之后的校验块绝对位置不可静态定位 → 距帧尾字节数表达。
    field_offset_from_end = value.get("field_offset_from_end", None)
    if field_offset_from_end is not None:
        field_offset_from_end = _require_int(
            field_offset_from_end, "checksum.field_offset_from_end", 0, 4095
        )
        if field_offset != 0:
            raise ValueError("checksum.field_offset 与 field_offset_from_end 只能给其一")
    return {
        "algo": algo,
        "field_offset": field_offset,
        "field_byte_length": field_byte_length,
        "span_start": span_start,
        "span_end": span_end,
        "byte_order": byte_order,
        "span_end_pad": span_end_pad,
        "field_offset_from_end": field_offset_from_end,
    }


def _normalize_unpack(value: Any) -> Dict[str, int]:
    """层解包几何（D15-A 逆序解包）：该层帧 = head(头字节) + 内层块 + trailer(尾字节)。"""
    if not isinstance(value, dict):
        raise ValueError("unpack 必须是对象")
    unknown = set(value) - _UNPACK_KEYS
    if unknown:
        raise ValueError(f"未知 unpack 字段: {', '.join(sorted(unknown))}")
    head = _require_int(value.get("head", 0), "unpack.head", 0, 4095)
    trailer = _require_int(value.get("trailer", 0), "unpack.trailer", 0, 4095)
    if head + trailer < 1:
        raise ValueError("unpack.head 与 unpack.trailer 不能同时为 0（层与层不可区分）")
    return {"head": head, "trailer": trailer}


def _normalize_stage(value: Any, index: int) -> Dict[str, Any]:
    """单层五要素 + unpack 归一化；错误统一挂层号前缀便于定位（D15-A）。"""
    if not isinstance(value, dict):
        raise ValueError(f"stages[{index}] 必须是对象")
    unknown = set(value) - _STAGE_KEYS
    if unknown:
        raise ValueError(f"stages[{index}] 未知字段: {', '.join(sorted(unknown))}")
    if "unpack" not in value:
        raise ValueError(f"stages[{index}] 缺少 unpack（多层逐层解包必需）")
    try:
        return {
            "prefix": _normalize_hex(value.get("prefix"), "prefix"),
            "suffix": _normalize_hex(value.get("suffix"), "suffix"),
            "echo_header_bytes": _require_int(
                value.get("echo_header_bytes", 0), "echo_header_bytes", 0, 1024
            ),
            "length": _normalize_length(value.get("length")),
            "checksum": _normalize_checksum(value.get("checksum")),
            "unpack": _normalize_unpack(value.get("unpack")),
        }
    except ValueError as exc:
        raise ValueError(f"stages[{index}]: {exc}") from exc


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
    stages = spec.get("stages")
    out: Dict[str, Any] = {
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
    if stages is not None:
        # 组合不变量放顶层字段归一之后 —— 顶层类型错先报顶层，五要素按层错报层号。
        _validate_stages_shape(spec, mode, stages)
        out["stages"] = [_normalize_stage(item, i) for i, item in enumerate(stages)]
    # stages 只在**入参显式带**时落库 —— 单层（存量）规格形态逐字节不变。
    return out


def _validate_stages_shape(spec: Dict[str, Any], mode: str, stages: Any) -> None:
    """分层规格的组合不变量（D15-A）：五要素按层各归其位，顶层只留 framing。

    与单层互斥的检查放在这里 —— 错误先于任何归一化产出，不会出现半归一结果。
    """
    if not isinstance(stages, (list, tuple)):
        raise ValueError("stages 必须是数组")
    if not stages:
        raise ValueError("stages 不能为空（单层规格不要写 stages 键）")
    if len(stages) > MAX_STAGES:
        raise ValueError(f"stages 最多 {MAX_STAGES} 层")
    if mode == "echo":
        raise ValueError("多层规格 mode 不得为 echo（逐层结构校验用 rules / any）")
    if spec.get("echo_header_bytes", 0):
        raise ValueError("多层规格的 echo_header_bytes 须按层写进 stages[..]（顶层只留 framing）")
    if spec.get("length") is not None:
        raise ValueError("多层规格的 length 须按层写进 stages[..]（顶层只留 framing）")
    if spec.get("checksum") is not None:
        raise ValueError("多层规格的 checksum 须按层写进 stages[..]（顶层只留 framing）")


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


def _length_offset(length: Dict[str, Any], frame_len: int) -> Optional[int]:
    """length 字段在本帧内的起点（绝对 / 距帧尾两种表达统一到这里）。越界 → None。"""
    offset = frame_len - length["offset_from_end"] if length.get("offset_from_end") is not None \
        else length["offset"]
    if offset < 0 or offset + length["byte_length"] > frame_len:
        return None
    return offset


def _checksum_offset(cs: Dict[str, Any], frame_len: int) -> Optional[int]:
    """校验字段在本帧内的起点（绝对 / 距帧尾两种表达统一到这里）。越界 → None。"""
    offset = frame_len - cs["field_offset_from_end"] if cs.get("field_offset_from_end") is not None \
        else cs["field_offset"]
    if offset < 0 or offset + cs["field_byte_length"] > frame_len:
        return None
    return offset


def _checksum_span(frame: bytes, cs: Dict[str, Any]) -> Optional[bytes]:
    """span 默认整帧；无论显式与否都排除校验字段自身（反算不自含）。

    越界 → None（调用方映射 CHECKSUM_OUT_OF_RANGE）。P3 序列补丁的「发送时
    写入」侧复用本区间语义（core/sequence_plan.py），写入与反算同源。

    `span_end_pad`（CP3 3d）：末端 = (span_end ?? len(frame)) - pad，用于生成
    「refs 只圈载荷」的层规格（载荷区末尾在帧尾前 trailer 字节）。缺省 0。
    """
    field_off = _checksum_offset(cs, len(frame))
    if field_off is None:
        return None
    field_bl = cs["field_byte_length"]
    span_end = len(frame) if cs["span_end"] is None else min(cs["span_end"], len(frame))
    span_end -= cs.get("span_end_pad", 0)
    span_start = min(cs["span_start"], len(frame))
    return bytes(
        b
        for i, b in enumerate(frame)
        if span_start <= i < span_end and not (field_off <= i < field_off + field_bl)
    )


def checksum_value(algo: str, data: bytes, field_byte_length: int) -> int:
    """按字段宽度计算 sum/xor/crc16_modbus 校验值（算法 SSOT 的公共入口）。

    - sum：模 256^宽度（与 backend/handlers/checksum.py 同宽语义）；
    - xor：逐字节异或（恒单字节值，宽度补零两侧一致）；
    - crc16_modbus：反射 0xA001 / 初值 0xFFFF（与 checksum.py、
      formula.js calculateChecksum 同一套）。
    formula.js 的 SUM_8/XOR_8 按 8 位定义，字段 ≥2 字节的 sum 属契约外——
    沿 E1-3/E1-4「各自现状锚」先例，此处保持 handler 宽度语义（应答反算与
    P3 序列补丁写入共用本函数 → 自洽）。
    """
    if algo == "sum":
        return sum(data) % (256 ** field_byte_length)
    if algo == "xor":
        value = 0
        for b in data:
            value ^= b
        return value
    return crc16(data)


def _checksum_reasons(cs: Dict[str, Any], frame: bytes) -> List[str]:
    span = _checksum_span(frame, cs)
    if span is None:
        return ["CHECKSUM_OUT_OF_RANGE"]
    field_bl = cs["field_byte_length"]
    encoded = checksum_value(cs["algo"], span, field_bl).to_bytes(field_bl, cs["byte_order"])
    field_off = _checksum_offset(cs, len(frame))
    actual = frame[field_off : field_off + field_bl]
    if encoded != actual:
        return [f"CHECKSUM_MISMATCH(exp={encoded.hex().upper()},got={actual.hex().upper()})"]
    return []


def match_response(
    spec: Dict[str, Any],
    sent: bytes,
    received: bytes,
    *,
    unescape=None,
) -> Tuple[bool, List[str]]:
    """按归一化规格判定一次应答；返回 (ok, reasons)。

    空应答恒判失败（EMPTY_RESPONSE）——事务引擎的「超时无应答」与「失配」是两类
    失败，分别对应 attempt 状态 NO_RESPONSE / MATCH_FAILED。

    **双口径（§8.35，销 §9.7 ④「应答是否带转义字节」）**：
    1. 先按**线上字节**判一次（`sent`/`received` 原样 —— 覆盖 DL/T 645 型：
       变换后算 L/CS，应答自带长度与校验覆盖线上字节）；
    2. 未通过且调用方给了 `unescape`（= 转义表非空时的 `escape.unescape_bytes`）
       且表**确实能改变任一侧字节**时，把 `sent`/`received` 一并还原为逻辑字节
       再判第二次（覆盖 RFC 1662 型 / 本仓内核口径：先算 LEN/CS 再转义），
       第二次通过即视为命中、`reasons` 清空；
    3. 两次都未过 → 返回**第 1 次（线上口径）**的 reasons —— 诊断以线上字节为准。
    `escape` 缺省关闭 → 调用方传 `unescape=None` → 单口径，与存量逐字节一致
    （§0 硬约束：判定路径零改动）。
    """
    ok, reasons = _match_frame(spec, sent, received)
    if ok or unescape is None or not received:
        return ok, reasons
    tx2 = unescape(sent)
    rx2 = unescape(received)
    if tx2 == sent and rx2 == received:
        return ok, reasons  # 表对两侧都无作用 → 第二次与第一次等价，不白跑
    ok2, _ = _match_frame(spec, tx2, rx2)
    if ok2:
        return True, []
    return ok, reasons


def _match_frame(spec: Dict[str, Any], sent: bytes, received: bytes) -> Tuple[bool, List[str]]:
    """单口径判定（线上字节原样）—— `match_response` 第 1 次与第 2 次共用。"""
    if not received:
        return False, ["EMPTY_RESPONSE"]
    mode = spec.get("mode", "echo")
    if mode == "any":
        return True, []

    stages = spec.get("stages")
    reasons: List[str] = []

    # 前缀 / 后缀（字面量）—— 分层规格下这是**整帧 framing**（外层壳之外的字节），
    # 单层语义不变；两种形态都先于结构校验报错（保持原顺序）。
    prefix = bytes.fromhex(spec.get("prefix") or "")
    if prefix and not received.startswith(prefix):
        reasons.append("PREFIX_MISMATCH")
    suffix = bytes.fromhex(spec.get("suffix") or "")
    if suffix and not received.endswith(suffix):
        reasons.append("SUFFIX_MISMATCH")

    if stages:
        # CP3 3d (D15-A): 多层 → 逆序解包逐层跑五要素；无 stages 键走下方单帧原路径。
        return _match_stages(stages, sent, received, reasons)

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
        off = _length_offset(length, len(received))
        bl = length["byte_length"]
        if off is None:
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


def _stage_reasons(
    stage: Dict[str, Any], sent_layer: bytes, rx_layer: bytes, index: int
) -> List[str]:
    """单层五要素判定（分层复用；reasons 统一挂 `STAGE[i].` 层号前缀便于定位）。"""
    tag = f"STAGE[{index}]."
    reasons: List[str] = []

    prefix = bytes.fromhex(stage.get("prefix") or "")
    if prefix and not rx_layer.startswith(prefix):
        reasons.append(tag + "PREFIX_MISMATCH")
    suffix = bytes.fromhex(stage.get("suffix") or "")
    if suffix and not rx_layer.endswith(suffix):
        reasons.append(tag + "SUFFIX_MISMATCH")

    n = stage.get("echo_header_bytes", 0)
    if n > 0:
        if len(rx_layer) < n or len(sent_layer) < n:
            reasons.append(tag + "ECHO_HEADER_TOO_SHORT")
        elif rx_layer[:n] != sent_layer[:n]:
            reasons.append(tag + "ECHO_HEADER_MISMATCH")

    length = stage.get("length")
    if length:
        off = _length_offset(length, len(rx_layer))
        bl = length["byte_length"]
        if off is None:
            reasons.append(tag + "LENGTH_OUT_OF_RANGE")
        else:
            declared = int.from_bytes(rx_layer[off : off + bl], length["byte_order"])
            expected = len(rx_layer) + length["offset_val"]
            if declared != expected:
                reasons.append(f"{tag}LENGTH_MISMATCH({declared}!={expected})")

    checksum = stage.get("checksum")
    if checksum:
        reasons.extend(tag + reason for reason in _checksum_reasons(checksum, rx_layer))
    return reasons


def _match_stages(
    stages: List[Dict[str, Any]], sent: bytes, received: bytes, reasons: List[str]
) -> Tuple[bool, List[str]]:
    """CP3 3d (D15-A): 按 `stages` **逆序**解包，逐层跑五要素。

    stages[0] = 最内层（与 frame_recipes.stages / plan.shell.layers 同序），故从
    n-1（最外层壳）起检：每检完一层用该层 `unpack` 把内层块剥出来喂下一层；
    i==0 是最内层，再往里就是内核载荷，不再剥。请求侧 `tx` 按同一几何同步剥层 ——
    逐层 `echo_header_bytes` 比的是**同层**帧头（出方向套壳、入方向剥壳完全对称）。
    解包失败（帧比 head+trailer 还短 / 剥出空）即止，再往里的层无从判定。
    """
    rx = received
    tx = sent
    for i in range(len(stages) - 1, -1, -1):
        stage = stages[i]
        reasons.extend(_stage_reasons(stage, tx, rx, i))
        if i == 0:
            break
        head = stage["unpack"]["head"]
        trailer = stage["unpack"]["trailer"]
        if len(rx) <= head + trailer:
            reasons.append(f"STAGE[{i}].UNPACK_TOO_SHORT({len(rx)}<={head + trailer})")
            break
        if len(tx) > head + trailer:
            tx = tx[head : len(tx) - trailer]
        else:
            tx = b""  # 请求侧剥不动 → 后续层 ECHO_HEADER_TOO_SHORT
        rx = rx[head : len(rx) - trailer]
        if not rx:
            reasons.append(f"STAGE[{i}].EMPTY_INNER")
            break
    return len(reasons) == 0, reasons
