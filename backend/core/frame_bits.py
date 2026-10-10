# -*- coding: utf-8 -*-
"""R73（§8.105）发射期全帧 packBits 纯函数层 —— 镜像 frontend/src/utils/frameBitPack.js。

双端同构（改一必改二，位序约定与 frameBitPack.js 同注）：
 - 文档序 = **MSB-first**：byte0 在左、byte 内 bit7 在左（人读/卡面所见即所得）；
 - 段内 bit = **LSB 起**：start_bit bit0 = 段内最低位（存储口径零触碰，与
   bitGrid / InstructionEncoder / backend bitfield 打包同源）；
 - 块 → 文档 bit 串（bitfield 段按 start_bit 落位 / hex 家族逐 nibble 展开 /
   计算块按 byte_length×8 占位零位，真值发射期已由 handler 算定进 hex_value）；
 - 帧 = 各块文档 bit 串按序拼接 → ceil 字节，**尾部补零**（R73 拍板：尾补零 =
   高对齐，与设计层 frameBitPack / 画布逐位一致；wire 头补零旧口径 014A/0294 系
   废止）。
按字符串拼位（不走 32 位位运算）→ 40bit+ 帧不截断（JS 侧整数位运算 start≥32 即
回绕，故 FE 同样按串处理）。

与 FE blockBitString 的唯一口径差（§8.105 五 · 脏态登记）：段所需 required 超出
声明 extent 时 FE 取 max(declared, required) 放宽（设计层脏态展示），本层
declared>0 时**按 declared 截**（段不越 PAD + 线上 byte_length 宽度不变量，
wire 宽度 = 声明位宽不可漂）—— 合法协议 required ≤ declared（FE 保存闸
BIT_OVERFLOW / BE _validate_bits 容量闸），两端逐位一致；仅脏库/直调超界态分叉，
该态 FE 无法保存。
"""

import math
from typing import Any, Dict, List, Optional


def _number(value) -> float:
    """镜像 FE Number() 口径：宽松数值转换；不可转 → NaN（FE 同，非 0）。"""
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return 0.0  # Number('') === 0
        try:
            return float(s)
        except ValueError:
            return float("nan")  # Number('abc') = NaN
    return float("nan")  # Number(undefined / 对象) = NaN


def hex_to_bits(h) -> Optional[str]:
    """hex → MSB-first bit 串（去空白、大写）；空/非法 → None（调用方按宽度回落）。"""
    if h is None:
        return None
    clean = "".join(str(h).split()).upper()
    if not clean:
        return None
    if any(c not in "0123456789ABCDEF" for c in clean):
        return None
    return "".join(format(int(c, 16), "04b") for c in clean)


def block_bit_string(block: Dict[str, Any]) -> Dict[str, Any]:
    """单块 → 文档 bit 串。返回 {"bits": str, "extent": int}（镜像 blockBitString）。

    - bitfield 块：段按 start_bit 落位到 extent 宽（declared = 声明 bit_len，
      否则 byte_length×8；段/空隙/溢出位裁剪为 0）；
    - hex 家族（hex/fixed/length/checksum 真值/槽填充产物）：hex 值逐 nibble
      展开（extent = hex 位数）；
    - 其余（无值占位）：byte_length×8 占位零位。
    """
    if not isinstance(block, dict):
        return {"bits": "", "extent": 0}
    btype = str(block.get("type") or "").lower()

    if btype == "bitfield":
        segs = []
        raw = block.get("bits")
        if isinstance(raw, list):
            for b in raw:
                if not isinstance(b, dict):
                    continue
                start = _number(b.get("start_bit"))
                if not math.isfinite(start) or start != math.floor(start) or start < 0:
                    continue  # 镜像 Number.isInteger(start) && start >= 0
                length = _number(b.get("bit_len"))  # Number(b.bit_len) || 1
                if not math.isfinite(length) or length == 0:
                    length = 1.0
                length = max(1.0, length)
                val = _number(b.get("default_val"))  # isFinite ? floor : 0
                val = math.floor(val) if math.isfinite(val) else 0
                segs.append((int(start), int(length), int(val)))
        required = max((s + l for s, l, _ in segs), default=0)
        declared_bits = _number(block.get("bit_len"))
        declared_bytes = _number(block.get("byte_length"))
        if math.isfinite(declared_bits) and declared_bits == math.floor(declared_bits) \
                and declared_bits > 0:
            declared = int(declared_bits)
        elif math.isfinite(declared_bytes) and declared_bytes > 0:
            declared = int(math.floor(declared_bytes)) * 8
        else:
            declared = 0
        # R73 层口径（见模块注）：declared>0 → 按 declared 截；无声明 → 按段所需。
        # 合法态 required ≤ declared 时与 FE max(declared, required) 逐位一致。
        extent = declared if declared > 0 else required
        if extent <= 0:
            return {"bits": "", "extent": 0}
        arr = ["0"] * extent
        for start, length, val in segs:
            for k in range(length):
                bit_idx = start + k
                if bit_idx < extent:
                    arr[extent - 1 - bit_idx] = "1" if (val // (2 ** k)) % 2 else "0"
        return {"bits": "".join(arr), "extent": extent}

    # hex 家族：hex_value ?? parameter_config.hex（?? 只在 null/undefined 回落）
    hv = block.get("hex_value")
    if hv is None:
        pc = block.get("parameter_config")
        if isinstance(pc, dict):
            hv = pc.get("hex")
    bits = hex_to_bits(hv)
    if bits is not None:
        return {"bits": bits, "extent": len(bits)}

    # 无值占位：byte_length×8 零位
    bl = block.get("byte_length")
    if bl is None:
        bl = block.get("byte_len")
    n = _number(bl)
    n = int(math.floor(n)) if math.isfinite(n) and n > 0 else 0
    extent = n * 8
    return {"bits": "0" * extent, "extent": extent}


def pack_frame_bit_stream(blocks: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    """全帧 bit 流打包：各块文档 bit 串按序拼接 → ceil 字节，**尾部补零**。

    返回 {"bit_len": int, "pad_bits": int, "hex": str, "bytes": int}
    （镜像 packFrameBitStream；hex 为紧凑大写、无分组空格）。
    """
    frame = ""
    for b in blocks or []:
        frame += block_bit_string(b)["bits"]
    bit_len = len(frame)
    pad_bits = (8 - (bit_len % 8)) % 8
    padded = frame + "0" * pad_bits
    out = [
        format(int(padded[i:i + 8], 2), "02X")
        for i in range(0, len(padded), 8)
    ]
    return {
        "bit_len": bit_len,
        "pad_bits": pad_bits,
        "hex": "".join(out),
        "bytes": len(out),
    }
