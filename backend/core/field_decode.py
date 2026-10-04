"""R10（PLAN §8.48）：应答帧 → 「字段 = 值」的**逆向解码器**（BE 侧）。

`frontend/src/utils/InstructionDecoder.js`（R9 §8.47）的对偶，两侧分派逐条同序，
改一必改二。为什么后端也要一份：R9 只能**瞬时展示**，C-2 选 C（§8.36）要把值
**入库回写** —— `dispatch_logs.fields_json` 与 `/dispatch/history` 的 `fields` 都在
写日志那一刻产生，那一刻只有后端在场（尤其序列路跑在 daemon 线程里、回放路没有表单
输入），前端算得出也递不进来。

**布局不写第二套**（本模块最关键的一条取舍）：
- `core.field_blocks.fields_to_blocks` 是编译侧 SSOT（presence 门 / repeat ×N /
  endianness / align / pad_to / byte_length 全在里面），解码**直接复用**；
- `Orchestrator.flatten()` 抽成公开方法后，编码 `process()` 与解码**共用同一份
  扁平流**（`_PadMark` 容器补位标记 + 叶块），只是编码往 `final_hex` 里追加、
  解码按游标往 `data` 里切片。布局算法**只有一处**，改一必改二的前提不破。

**长度取值口径**与 `orchestrator.process()` 的 `val = hex_value or "00" * byte_length`
同源：有 `hex_value` 就按它量（＝真实出帧字节数），`byte_length` 只是占位尺寸；
但 `length` / `checksum` 两型例外 —— 编码期由 handler 按 `byte_length` 重算覆盖，
故这两型恒按 `byte_length` 量。两者同时非零却不相等 = 配置矛盾，按 hex 量（真实
出帧字节）并留一条 warning，让"帧长与字段布局对不上"**看得见**而不是静默出错值。

**已知不可逆**（与 R9 同三条，各有断言锚定）：f32 溢出位型、utf8 定长截断、
AUTO_COUNTER 状态机。非有限浮点（f32 溢出 → +Inf）**必须**在落库前折成字符串 ——
`json.dumps(float('inf'))` 产出 `Infinity` 字面量是非法 JSON，FastAPI 响应层会 500。
"""
import math
import re
import struct
from typing import Any, Dict, List, Optional, Sequence

from backend.core.field_blocks import fields_to_blocks
from backend.core.orchestrator import Orchestrator, _PadMark, unscramble_hex
from backend.core.pad import align_pad_len, normalize_align, normalize_pad_to, pad_to_pad_len
from backend.schemas.block import Block, BlockType

#: 空白折叠（space-separated hex 与换行混排均按此剥掉）
_WS = re.compile(r"\s+")


# --------------------------------------------------------------------------
# 值层：与 frontend/src/utils/InstructionDecoder.js 的 decodeFieldBytes 同序
# --------------------------------------------------------------------------

def _hex_of(raw: Sequence[int]) -> str:
    return "".join(f"{b & 0xFF:02X}" for b in raw)


def _big_endian_number(raw: Sequence[int]):
    """大端读数：≤6 字节恒精确（2^48 < 2^53）；更宽若超 JS 安全整数则退回十进制
    字符串 —— 与前端 `bigEndianNumber` 的 Number/BigInt→string 分层逐字一致。"""
    n = int.from_bytes(bytes(b & 0xFF for b in raw), "big")
    if len(raw) <= 6:
        return n
    return n if n <= (1 << 53) - 1 else str(n)


def _is_scaled_numeric(params: dict) -> bool:
    raw = params.get("type")
    return ("" if raw is None else str(raw)).lower() in ("", "number")


def _to_number(raw) -> float:
    """JS `Number(String(x ?? '').trim())` 的 Python 对偶（bool → String→Number=NaN）。"""
    if isinstance(raw, bool):
        return float("nan")
    if isinstance(raw, (int, float)):
        return float(raw)
    text = "" if raw is None else str(raw).strip()
    if text == "":
        return 0.0
    try:
        return float(text)
    except ValueError:
        return float("nan")


def scale_params(params: dict):
    """SCALED_DECIMAL 反定标参数（与编码器同款解析：空缺/非有限 → off=0、fac=1）。"""
    off_raw = params.get("offset")
    fac_raw = params.get("factor")
    off_raw = float("nan") if off_raw in (None, "") else _to_number(off_raw)
    fac_raw = float("nan") if fac_raw in (None, "") else _to_number(fac_raw)
    off = off_raw if math.isfinite(off_raw) else 0.0
    fac = fac_raw if math.isfinite(fac_raw) else 1.0
    return off, fac


def _jsonable(value):
    """非有限浮点 → 字符串（`"Infinity"` / `"-Infinity"` / `"NaN"`）。

    两重原因：① JSON 不能表示 Infinity/NaN，响应层会 500、SQLAlchemy JSON 会写
    出非法字面量；② 直接给 None 会把"这帧是溢出位型"这条信息悄悄吞掉。
    """
    if isinstance(value, float) and not math.isfinite(value):
        if math.isnan(value):
            return "NaN"
        return "Infinity" if value > 0 else "-Infinity"
    return value


def decode_field_bytes(field: dict, raw: Sequence[int]):
    """单叶解码：`raw` = 帧里该叶的原始字节（长度已由布局量出）。

    分派顺序与 `InstructionEncoder._encodeFieldBytes` / FE `decodeFieldBytes` 一一
    对应（静态 hex → 文本 → 旧 float/decimal → 纯 hex → BITFIELD → INT_SIGNED →
    BCD → FLOAT_IEEE → 缺省无符号 + SCALED_DECIMAL 反定标），LITTLE 先整体还原。
    """
    if not raw:
        return None
    params = field.get("parameter_config") or {}
    if not isinstance(params, dict):
        params = {}
    op = str(field.get("op_code") or "")

    buf = [b & 0xFF for b in raw]
    is_group = bool(field.get("fields")) or bool(field.get("children"))
    if not is_group and len(buf) > 1 and str(field.get("endianness") or "").upper() == "LITTLE":
        buf.reverse()

    # 0. 静态 hex（FIXED / HEADER / Tail / HEX_RAW / 协议叶 hex_value）
    static_hex = field.get("hex_value") or params.get("hex")
    if static_hex and (op in ("FIXED", "HEADER", "TAIL", "HEX_RAW") or op == ""):
        return _hex_of(buf)

    # 0.5 R25 (§8.57): SCRAMBLE —— 线上是**加扰字节**，先反加扰再交回明文 hex（与 FE
    # InstructionDecoder 的 SCRAMBLE 分支同位同口径）；XOR 自反、左旋的逆是右旋 →
    # 编码(解码(x)) 是不动点。不反变换就只能把密文当值显示。
    if op == "SCRAMBLE":
        return unscramble_hex(
            _hex_of(buf),
            params.get("mode"),
            params.get("seed"),
            params.get("roll"),
        )

    # 1. 文本（utf8 走 errors='replace'，与前端 TextDecoder 的替换语义同口径）
    if op == "STRING" or params.get("type") == "string":
        if str(params.get("encoding") or "ascii").lower() == "utf8":
            return bytes(buf).decode("utf-8", errors="replace")
        return "".join(chr(b & 0xFF) for b in buf)

    # 2. 旧 float/decimal 路径（编码 = 平台小端 Float32 → 整体逆序出大端，故此处
    #    把已还原的字节再逆回去按小端读；不足 4 字节走缺省整数，免 struct 抛异常）
    if params.get("type") in ("float", "decimal"):
        if len(buf) >= 4:
            return struct.unpack("<f", bytes(reversed(buf))[:4])[0]

    # 3. 纯 hex
    if op == "HEX_RAW" or params.get("type") == "hex":
        return _hex_of(buf)

    # 3.5 BITFIELD → 聚合整数（编码侧 Σ(default << start) 打包）
    if op == "BITFIELD":
        return _big_endian_number(buf)

    # 4. INT_SIGNED 两补码
    if op == "INT_SIGNED":
        bits = len(buf) * 8
        n = int.from_bytes(bytes(buf), "big")
        if bits and n >= (1 << (bits - 1)):
            n -= 1 << bits
        return n

    # 5. BCD packed BCD → 十进制数字
    if op == "BCD_CODE":
        digits = ""
        for b in buf:
            hi, lo = (b >> 4) & 0x0F, b & 0x0F
            if hi > 9 or lo > 9:
                return _hex_of(buf)  # 非本编码器产物 → 原样 hex 诚实回报
            digits += str(hi) + str(lo)
        if not digits:
            return 0
        return int(digits) if len(digits) <= 15 else digits

    # 6. FLOAT_IEEE 大端（f32/f64 按字节长度分水岭，与 encode_float_ieee 同）
    if op == "FLOAT_IEEE" and len(buf) in (4, 8) and _is_scaled_numeric(params):
        fmt = ">f" if len(buf) == 4 else ">d"
        return _jsonable(struct.unpack(fmt, bytes(buf))[0])

    # 7. 缺省无符号整数 → 再做 SCALED_DECIMAL 反定标
    n = _big_endian_number(buf)
    if op == "SCALED_DECIMAL" and _is_scaled_numeric(params):
        off, fac = scale_params(params)
        try:
            raw_num = float(n)
        except (TypeError, ValueError):
            raw_num = float("nan")
        unscaled = raw_num / fac - off
        n = unscaled if math.isfinite(unscaled) else 0.0
    return _jsonable(n)


# --------------------------------------------------------------------------
# 布局层：复用编译侧 SSOT + 与 orchestrator.process 逐字对偶的游标走查
# --------------------------------------------------------------------------

def field_index(fields) -> Dict[str, dict]:
    """block id → 字段 dict。id 口径与 `field_blocks.to_block` 逐字一致
    （`str(id or name or 'field')`），扁平 / 嵌套两种形态都收，先到先得。"""
    index: Dict[str, dict] = {}
    seen = set()

    def collect(f):
        if not isinstance(f, dict):
            return
        key = ("id", f["id"]) if f.get("id") is not None else ("obj", id(f))
        if key in seen:
            return
        seen.add(key)
        index.setdefault(str(f.get("id") or f.get("name") or "field"), f)
        for child in (f.get("children") or []):
            collect(child)

    for item in (fields or []):
        collect(item)
    return index


def _content_length(block: Block) -> tuple:
    """该叶在发射流里的字节宽度（返回 `(n, 违规说明 or None)`）。"""
    declared = int(block.byte_length or 0)
    kind = str(block.type or "")
    if kind in ("length", "checksum"):
        # handler 期按 byte_length 重算覆盖，cfg.hex 只是占位 → 恒按 byte_length 量
        return max(0, declared), None
    text = _WS.sub("", block.hex_value or "")
    n = len(text) // 2 if text else 0
    if n and declared and n != declared:
        return n, (
            f"字段 {block.label} 的 hex 宽度 {n}B 与 byte_len {declared}B 不一致，"
            f"按 hex（真实出帧字节）量长"
        )
    return (n if n else max(0, declared)), None


def decode_blocks(blocks, data: bytes, index: Optional[Dict[str, dict]] = None) -> Dict[str, Any]:
    """按编译出的块森林把 `data` 切成字段区间并取值（编解码共用同一份扁平流）。"""
    warnings: List[str] = []
    total = len(data)
    fields: List[dict] = []
    if not blocks:
        return {"fields": [], "consumed": 0, "total": total, "residual": 0, "warnings": warnings}

    index = index if index is not None else {}
    stream = Orchestrator([Block(**b) if isinstance(b, dict) else b for b in blocks]).flatten()
    cursor = 0
    short = False

    for item in stream:
        if not isinstance(item, Block):
            # 容器级补位标记：与 process() 发射期同式按绝对游标解析
            if not isinstance(item, _PadMark):
                continue
            if item.kind == "align":
                cursor += align_pad_len(cursor, item.n)
            else:
                cursor += pad_to_pad_len(cursor, item.n)
                if cursor > total:
                    cursor = total  # FE 组尾 clamp 同口径
            continue
        if not item.is_enabled or item.type == BlockType.SLOT:
            continue
        n, bad = _content_length(item)
        if bad:
            warnings.append(bad)
        if n <= 0:
            # presence 未命中 / 零长字段：FE 早退在 align **之前**，一并不补位
            continue
        cursor += align_pad_len(cursor, normalize_align(item.align))
        take = min(n, max(0, total - cursor))
        chunk = data[cursor:cursor + take]
        if take < n:
            short = True
        field = index.get(item.id)
        if field is None:
            warnings.append(f"字段 {item.label}（{item.id}）在指令定义里找不到，值未解出")
            value = None
        else:
            value = decode_field_bytes(field, chunk)
        fields.append({
            "fieldId": field.get("id") if field else None,
            "name": (field or {}).get("name") or (field or {}).get("id") or item.label,
            "opCode": str((field or {}).get("op_code") or ""),
            "byteLen": n,
            "start": cursor,
            "end": cursor + take,
            "truncated": take < n,
            "value": _jsonable(value),
        })
        cursor += take
        cursor += pad_to_pad_len(cursor, normalize_pad_to(item.pad_to))
        if cursor > total:
            cursor = total

    residual = max(0, total - cursor)
    if short:
        warnings.append(f"响应比字段布局短：从第 {cursor} 字节起不足，尾部字段未解出")
    if residual > 0:
        warnings.append(f"响应尾部多出 {residual} 字节未映射到任何字段")
    return {"fields": fields, "consumed": cursor, "total": total, "residual": residual, "warnings": warnings}


def decode_instruction(fields, data: bytes, now=None) -> Dict[str, Any]:
    """`fields`（指令字段定义）+ 响应字节 → `{fields, consumed, total, residual, warnings}`。

    空字段布局**不解码**：不出条目、也不出"尾部残字节"假警报 —— 三字节应答 +
    空布局会凭空造出一条 `residual` 警告（R9 在前端实测踩过一次，两处同口径）。
    """
    if not fields or not data:
        total = len(data or b"")
        return {"fields": [], "consumed": 0, "total": total, "residual": 0, "warnings": []}
    blocks = fields_to_blocks(fields, now=now)
    return decode_blocks(blocks, data, field_index(fields))


def decode_hex(fields, hex_text: str, now=None) -> Dict[str, Any]:
    """hex 文本（space-separated / compact 均可）入口 —— 非法字符 / 奇数位的告警
    与前端 `decodeInstruction` 同口径（不抛异常，把问题写进 warnings）。"""
    raw = _WS.sub("", str(hex_text or ""))
    if not raw:
        return {"fields": [], "consumed": 0, "total": 0, "residual": 0, "warnings": []}
    if not re.fullmatch(r"[0-9A-Fa-f]*", raw):
        return {"fields": [], "consumed": 0, "total": 0, "residual": 0,
                "warnings": ["响应含非十六进制字符，无法解码"]}
    warnings: List[str] = []
    if len(raw) % 2 != 0:
        warnings.append("响应 hex 为奇数位，末半字节已丢弃")
        raw = raw[:-1]
    result = decode_instruction(fields, bytes.fromhex(raw), now=now)
    result["warnings"] = warnings + list(result["warnings"])
    return result
