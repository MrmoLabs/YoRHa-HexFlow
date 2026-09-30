"""批 4: bitfield 块发射期打包（协议结构化位域）。

与指令侧 BITFIELD 同口径（frontend/src/utils/bitGrid.js packBits /
InstructionEncoder.js BITFIELD 分支）：
  - start_bit = 整块位偏移，bit 0 = LSB；
  - 每个位段取 (default_val & 掩码) << start_bit 求和；
  - 结果按 block.byte_length 定宽、**大端** hex 输出（无位段 → 00 填充）。

放在 Orchestrator 发射期（而非 frame_builder 翻译期）的原因：封装
（/compile/wrapped、/dispatch wrap）与二进制导出（/export/binary 直传
前端 toFrameBlocks 结果）两条路径都汇聚到 Orchestrator —— 打包单点实现，
两端一改俱改。协议位域是**静态默认值**语义，发送期不可改值。
"""

from typing import List, Tuple

from backend.handlers.base import LogicHandler
from backend.schemas.block import Block


def _as_int(value, default=0) -> int:
    """宽松取整（脏库兜底：None/非数/负数 → default），与前端 Number() 口径同族。"""
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value == value and abs(value) != float("inf") else default
    if isinstance(value, str):
        try:
            return int(value.strip() or default)
        except ValueError:
            return default
    return default


def pack_protocol_bits(bits, byte_length: int) -> str:
    """位段列表 → 定宽大端 hex。超块长部分被自然截掉（低字节保留）。"""
    size = max(1, _as_int(byte_length, 1))
    packed = 0
    for b in bits or []:
        if not isinstance(b, dict):
            continue
        start = _as_int(b.get("start_bit"), 0)
        length = _as_int(b.get("bit_len"), 1)
        if length < 1 or start < 0:
            continue
        mask = (1 << length) - 1
        packed |= (_as_int(b.get("default_val"), 0) & mask) << start
    packed &= (1 << (size * 8)) - 1
    return f"{packed:0{size * 2}X}"


class BitfieldHandler(LogicHandler):
    def calculate(self, block: Block, flattened_blocks: List[Tuple[str, Block]]) -> str:
        params = (block.config.params if block.config else None) or {}
        return pack_protocol_bits(params.get("bits"), block.byte_length)
