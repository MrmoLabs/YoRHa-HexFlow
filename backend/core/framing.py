# -*- coding: utf-8 -*-
"""R27（§8.52 排期 · varint / COBS **出线**）：变长长度前缀与定界编码 —— **只编码、不解包**。

定位与 `backend/core/escape.py` 同款分工：本模块是**编码侧 SSOT**（纯函数、零 I/O），
只出字节、不解字节 —— 收侧（应答 `stages` 逆向解包 + 应答匹配）属 R28，本批一行不碰。

两种能力、两个天然层位（§8.36 C-5 ③ 原建议「先出线、解包另批」的落法）：

1. **varint 变长长度前缀** —— `length` 卡新选项
   ``parameter_config.encoding ∈ {fixed, varint}``（**缺省 fixed = 缺失键**，与本批
   之前逐字节一致，§0）。编码 = **LEB128 最小长度无符号**：每字节低 7 位数据、
   最高位续位（1 = 后随字节）；``0 → "00"``、``127 → "7F"``、``128 → "8001"``、
   ``300 → "AC02"``。**字节序无关** → varint 分支不走 ``apply_byte_order``（R21 的
   ``byte_order`` 与 ``encoding`` 互不相干，同时配了也按 varint 出线）。出线宽度
   **不是**设计期 ``byte_length``，故 LengthHandler 出线后把实际字节数回写回
   ``block.byte_length``，使后续 refs Σ / checksum 计数同源（同一帧内的一致性口径）。

2. **COBS 定界编码** —— 协议树新组帧元素 ``type: "cobs"``（可嵌套包住整段子树）。
   编码 = 标准 COBS（Consistent Overhead Byte Stuffing）：每块首字节为码字节
   （= 1 + 本块字面量数），``0x00`` 由码字节本身表示；**码 ``0xFF`` = 满块 254 字面量**
   （此时块因写满而闭合，后面**没有** 0x00 要补），其余码字节若非末块则解码时补回一个
   ``0x00`` —— 该规则与本编码器配对即无歧义（满块闭合与零终止在本编码器里不会撞成
   同一个码值）。随后按 ``parameter_config.terminator`` 追加定界字节（``"00"`` 缺省
   → 追加 ``0x00``；``"none"`` → 不追加）。

   解码（收侧）**不在本批**：`cobs_decode` 属 R28，测试内的往返校验用测试文件自带的
   局部解码器，不进生产代码 —— 这是「只做编码，不碰解包」的字面执行。
"""

from typing import Dict

# ---------------------------------------------------------------------------
# ① varint：变长长度前缀
# ---------------------------------------------------------------------------

LENGTH_ENCODINGS = ("fixed", "varint")
DEFAULT_LENGTH_ENCODING = "fixed"

# JS 安全整数上限 —— FE `encodeVarint` 按位移逐字节取，超过 2^53-1 就开始丢精度，
# 两端不再保证同字节。帧内长度（refs Σ + offset）到不了这个量级，仅作契约边界。
VARINT_MAX = (1 << 53) - 1


def encode_varint(value: int) -> str:
    """非负整数 → LEB128 最小长度无符号编码（紧凑大写 hex，无空白）。

    与 `int.to_bytes` / protobuf varint 同型；负值 / 超 ``VARINT_MAX`` →
    ``ValueError``（HTTP 侧走既有 ValueError→400 通道 —— 与其在帧里发出畸形长度，
    不如拒绝出帧；fixed 路径的负值形态本就未定义，不在此发明语义）。
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"varint 只接受整数：{value!r}")
    if value < 0:
        raise ValueError(f"varint 长度值为负：{value}")
    if value > VARINT_MAX:
        raise ValueError(f"varint 长度值超出安全整数域：{value}")
    if value == 0:
        return "00"
    out = bytearray()
    while True:
        low = value & 0x7F
        value >>= 7
        if value:
            out.append(low | 0x80)
        else:
            out.append(low)
            break
    return bytes(out).hex().upper()


def varint_width(value: int) -> int:
    """``encode_varint(value)`` 的出线字节数（FE 偏移尺 / fieldSizes 同源口径）。

    与编码同一次第：0 → 1；1..127 → 1；128..16383 → 2 …；越界口径同
    ``encode_varint``（抛错），调用方（FE 尺）先自行判域再落 null（未知）。
    """
    return max(1, (value.bit_length() + 6) // 7)


def normalize_encoding(params) -> str:
    """``config.params.encoding`` → ``"fixed" | "varint"``；缺失/非法一律 fail-open
    回 ``"fixed"``（镜像 `byte_order_of` 的口径 —— 缺省路径与本批之前逐字节一致，§0）。

    取 params 而非 block：与 `terminator_of` 同为纯函数层（本模块不依赖 schema）；
    取 Block 的门面 `length.encoding_of(block)` 同 R21 `byte_order_of(block)` 形制。
    """
    if not isinstance(params, dict):
        return DEFAULT_LENGTH_ENCODING
    raw = params.get("encoding")
    if raw is None:
        return DEFAULT_LENGTH_ENCODING
    text = str(raw).strip().lower()
    return text if text in LENGTH_ENCODINGS else DEFAULT_LENGTH_ENCODING


# ---------------------------------------------------------------------------
# ② COBS：定界编码
# ---------------------------------------------------------------------------

COBS_MAX_BLOCK = 254          # 单块字面量上限（码字节 0xFF = 1 + 254）
COBS_EMPTY = "01"             # 空输入 → 单个码字节 0x01
COBS_TERMINATOR_KEY = "terminator"
DEFAULT_TERMINATOR = "00"
#: terminator 存值 → 追加字节（fail-open：未知值按缺省 `00`，与 toFrameBlocks /
#: _to_blocks 的翻译层「非法归缺省」同口径；保存侧由 FE validateProtocol 拦）。
TERMINATORS: Dict[str, bytes] = {"00": b"\x00", "none": b""}


def cobs_encode(data: bytes) -> bytes:
    """字节串 → COBS 编码（**不含**定界字节，定界由 ``terminator_of`` 决定）。

    单趟、码字节占位后回填（与公开参考实现同构）：
      - 遇 ``0x00`` → 关当前块（码 = 块长含码字节）、为下一块预留码字节；
        该 ``0x00`` 由「预留出的空块」表示 —— 若已是输入末尾，末尾那个空块就是
        收束用的 ``0x01``；
      - 写满 254 字面量 → 关块并预留（**不消耗输入**），保证码 ``0xFF`` 恒表示
        「满块、后面没有 0x00 要补」，与零终止块永不撞值；
      - 收尾回填最后一块的码字节。

    已知向量：``b"" → 01``、``00 → 0101``、``00 00 → 010101``、``AA BB → 03AABB``、
    ``AA 00 BB → 02AA02BB``、``AA 00 BB 00 → 02AA02BB01``（与公开资料一致，
    另有测试内往返解码器钉死）。
    """
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("cobs_encode 只接受字节串")
    out = bytearray([0])   # 首个码字节占位
    code_idx = 0
    reason = "keep"        # keep=起手占位 / zero=刚吞掉一个 0x00 / fill=满块闭合
    for byte in bytes(data):
        if byte == 0:
            out[code_idx] = len(out) - code_idx
            code_idx = len(out)
            out.append(0)
            reason = "zero"
            continue
        out.append(byte)
        if len(out) - code_idx - 1 >= COBS_MAX_BLOCK:
            out[code_idx] = len(out) - code_idx
            code_idx = len(out)
            out.append(0)
            reason = "fill"
    if reason == "fill" and len(out) - code_idx == 1:
        # 满块闭合后输入正好结束：那个预留码字节**后面没有字面量、也没有要表示
        # 的 0x00** → 是多余的收束码（254 字面量的标准形态就到 FF 块为止，255
        # 字节），删掉才是规范编码（规范编码唯一，否则 254 字面量有两态）。
        del out[code_idx]
    else:
        out[code_idx] = len(out) - code_idx
    return bytes(out)


def terminator_of(params) -> bytes:
    """``config.params.terminator`` → 追加字节（``b"\\x00"`` 缺省 / ``b""`` = 不追加）。"""
    if not isinstance(params, dict):
        return TERMINATORS[DEFAULT_TERMINATOR]
    raw = params.get(COBS_TERMINATOR_KEY)
    if raw is None:
        return TERMINATORS[DEFAULT_TERMINATOR]
    text = str(raw).strip().lower()
    return TERMINATORS.get(text, TERMINATORS[DEFAULT_TERMINATOR])


def hex_to_bytes(hex_str) -> bytes:
    """发射期 hex（可带空白）→ 字节；空/奇长 → ValueError（出线必须是整字节）。"""
    compact = "".join(str(hex_str or "").split())
    if not compact:
        return b""
    if len(compact) % 2 or any(c not in "0123456789abcdefABCDEF" for c in compact):
        raise ValueError(f"COBS 目标不是合法 hex：{hex_str!r}")
    return bytes.fromhex(compact)


def encode_cobs_hex(hex_str, params=None) -> str:
    """子树发射 hex → COBS 编码 + 定界后的出线 hex（紧凑大端大写）。

    空子树也走真编码：``b"" → 01``（+ 定界 ``00`` → ``0100``），不短路成 0 字节 ——
    「定界帧的空帧」本身也是帧。
    """
    return (cobs_encode(hex_to_bytes(hex_str)) + terminator_of(params)).hex().upper()
