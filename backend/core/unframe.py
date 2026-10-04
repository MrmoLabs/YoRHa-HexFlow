# -*- coding: utf-8 -*-
"""R28（§8.52 排期 · §8.60 定案）：应答**收侧解包**入口 —— 与 `framing.py` 对偶。

R27 的纪律「生产模块不得出现解码入口」按批次演进为**编码模块仍无解码符号**：
`framing.py` 本批一行不改，`test_framing.test_encode_only_module` 继续钉死它没有
`decode*`；解码入口收敛在本模块，出线永远走 `framing`（只解不编、零 I/O、纯函数）。

为什么收侧必须解码（R27 只出线、不解包的另一半）：设备回帧里的长度域可能是
LEB128 变长、或整段被 COBS 定界包住，`response_match` 得先按**线上字节**把这两层
剥开，才轮得到逐层五要素判定（`stages` 逆向解包）。两条都与编码严格互逆：

1. `decode_varint` —— LEB128 最小无符号的逆向：低 7 位数据、最高位续位。返回
   ``(value, width)``，宽度供收侧回算 `offset_val`（变长字段的设计期宽 ≠ 出线宽，
   见 `_length_reasons` 的 `-(width - byte_length)` 修正项）。**字节序无关** ——
   与 `encode_varint` 不走 `apply_byte_order` 同口径，R21 的 `byte_order` 配了也
   不参与 varint 判读。非最小编码（如 ``80 00`` 表示 0）**接受**：编码侧只会出最
   小形态，收侧放宽判读不产生歧义，而拒绝会把「设备补零」误判成坏帧。
   值域上界与编码侧同一常量 ``framing.VARINT_MAX``（2^53-1，FE 丢精度边界）。

2. `cobs_decode` —— 标准 COBS 的逆向：码字节 = 1 + 字面量数，``0x00`` 由码字节
   本身表示；**码 0xFF（满块 254 字面量）与末块之后不补隐式 0x00**，其余码字节
   若其后还有块则补回一个 ``0x00``。输入必须是**纯码字节区**（不含定界）—— 分层
   规格里定界字节由 `unpack.trailer` 收进尾部先剥掉，故区内出现 0x00 直接判非法，
   这也正是「定界漏配」最容易现形的地方。
"""

from typing import Tuple

from backend.core.framing import VARINT_MAX

# LEB128 单次读取的字节上限：2^53-1 恰需 8 字节（ceil(53/7)），第 9 字节起必是
# 越界或畸形 —— 早停，避免无收束字节的输入把一个无上限的循环跑穿。
MAX_VARINT_BYTES = 8


def decode_varint(data: bytes, offset: int = 0) -> Tuple[int, int]:
    """``(data, offset)`` → ``(值, 字节数)``；畸形 / 越界 / 超值域 → ``ValueError``。

    起点必须落在区内（``offset == len(data)`` 也算越界 —— 一个字节都没有，谈不上
    判读）；续位悬空（读到区尾仍带续位）与超过 ``MAX_VARINT_BYTES`` 都按畸形报，
    不猜长度。
    """
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("decode_varint 只接受字节串")
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise ValueError(f"varint 起点非法：{offset!r}")
    data = bytes(data)
    if offset >= len(data):
        raise ValueError(f"varint 起点越界：offset={offset} 区长={len(data)}")
    value = 0
    for i in range(MAX_VARINT_BYTES):
        pos = offset + i
        if pos >= len(data):
            raise ValueError(f"varint 缺少收束字节：偏移 {offset} 起仅剩 {i} 字节")
        byte = data[pos]
        value |= (byte & 0x7F) << (7 * i)
        if not byte & 0x80:
            if value > VARINT_MAX:
                raise ValueError(f"varint 长度值超出安全整数域：{value}")
            return value, i + 1
    raise ValueError(f"varint 超过最大字节数 {MAX_VARINT_BYTES}（续位未收束）")


def cobs_decode(data: bytes) -> bytes:
    """COBS **码字节区**（**不含**定界）→ 解出的字节；畸形 → ``ValueError``。

    与 `framing.cobs_encode` 严格互逆（往返由向量 vectors/framing.json · 表 cobs
    逆向消费钉死）：码 ``0xFF`` 与末块之后不补隐式 ``0x00``，其余码字节其后仍有
    块时补一个 —— 这条规则与 R27 的「满块闭合不写收束码」配对即无歧义。

    区内出现 ``0x00``：COBS 编码保证正文无裸 0x00，故它只可能是**没被剥掉的定界
    字节** —— 报非法而不是静默当数据吃掉，让「unpack.trailer 少算了定界」当场现形。
    """
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("cobs_decode 只接受字节串")
    data = bytes(data)
    if not data:
        raise ValueError("COBS 区为空")
    if b"\x00" in data:
        raise ValueError("COBS 区含 0x00（定界字节应由 unpack.trailer 先剥除）")
    out = bytearray()
    i = 0
    while i < len(data):
        code = data[i]
        i += 1
        count = code - 1
        if i + count > len(data):
            raise ValueError(
                f"COBS 码 {code:02X} 需要 {count} 字节，区尾仅剩 {len(data) - i} 字节"
            )
        out += data[i : i + count]
        i += count
        if code != 0xFF and i < len(data):
            out.append(0)
    return bytes(out)
