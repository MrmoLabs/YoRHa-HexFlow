"""N5 (G4 · PLAN §8.16): 字段级 align / pad_to 填充对齐 —— 归一与补位长度。

口径与 frontend/src/utils/padSpec.js 同源（两端各自钉同一套规则，改一必改二）：
    - align / pad_to：正整数 1..PAD_MAX（int/float/严格数值串 → floor；bool / 非数 /
      ≤0 / 超上限 → 0 即关闭，fail-open 不阻断出帧）；
    - pad_byte：≤2 位 hex 严格解析 → 字节值，否则 0x00（N2 pad_char 先例）。

口径（拍板：字段级 align + pad_to，骑 parameter_config 零 DDL）：
    align   = N → 该字段**内容起点**绝对偏移补位到 ≡0 (mod N)；
    pad_to  = N → 该字段**内容末尾**绝对偏移补位到 ≡0 (mod N)；
    均已对齐 → 0 字节；pad 进发射流（与前端 byte-equal），不进长度/校验 handler
    （指令链 config=None → 0x00，现状零改动）。
"""

import math
import re

PAD_MAX = 4096

_NUM_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")
_HEX_RE = re.compile(r"^[0-9A-Fa-f]+$")


def _floor_int(raw):
    """数值归一为 floor 整数；非法（bool/非数/非有限）→ 0。"""
    if isinstance(raw, bool) or raw is None:
        return 0
    if isinstance(raw, (int, float)):
        if not math.isfinite(raw):
            return 0
        return math.floor(raw)
    if isinstance(raw, str):
        s = raw.strip()
        if not _NUM_RE.match(s):
            return 0
        try:
            v = float(s)
        except ValueError:
            return 0
        return math.floor(v) if math.isfinite(v) else 0
    return 0


def normalize_align(raw):
    """align 归一：1..PAD_MAX 的整数，否则 0（0 = 关闭）。"""
    n = _floor_int(raw)
    return n if 1 <= n <= PAD_MAX else 0


def normalize_pad_to(raw):
    """pad_to 归一：1..PAD_MAX 的整数，否则 0（0 = 关闭）。"""
    return normalize_align(raw)


def normalize_pad_byte(raw):
    """pad_byte 归一：≤2 位 hex → 字节值，否则 0x00（N2 pad_char 严格解析先例）。"""
    if raw is None:
        return 0
    s = str(raw)
    if 0 < len(s) <= 2 and _HEX_RE.match(s):
        return int(s, 16)
    return 0


def pad_spec(cfg):
    """parameter_config → (align, pad_to, pad_byte)；非法键归 0 / 0x00。"""
    cfg = cfg if isinstance(cfg, dict) else {}
    return (
        normalize_align(cfg.get("align")),
        normalize_pad_to(cfg.get("pad_to")),
        normalize_pad_byte(cfg.get("pad_byte")),
    )


def align_pad_len(cursor, align):
    """align 补位长度：内容起点绝对偏移补到 N 边界（已对齐 / 关闭 → 0）。"""
    if not align or cursor is None:
        return 0
    return (align - (cursor % align)) % align


def pad_to_pad_len(end, pad_to):
    """pad_to 补位长度：内容末尾绝对偏移补到 N 边界（已对齐 / 关闭 → 0）。"""
    if not pad_to or end is None:
        return 0
    return (pad_to - (end % pad_to)) % pad_to


def pad_hex(count, byte):
    """填充字节串（大写 hex 对，与发射流同格式）。"""
    if not count or count <= 0:
        return ""
    return ("%02X" % (byte & 0xFF)) * count
