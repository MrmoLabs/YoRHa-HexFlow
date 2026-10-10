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


def pack_protocol_bits(bits, byte_length: int, bit_len: int = 0) -> str:
    """位段列表 → 定宽大端 hex（R73 拍板：**尾补零 = 高对齐**）。

    - extent = 声明 `bit_len`（0 < 且 ≤ size×8）否则 size×8；段按 start_bit 落位
      到 extent，**超 extent 的位段被截**（低 extent 位保留 —— 与既有「低字节
      保留」同向；脏态同时守住 size 字节宽度不变量）；
    - 结果整窗高对齐补零到 size 字节：10bit 声明 → `5280`，与发射期位流 /
      设计层 frameBitPack 同位序（wire 头补零旧口径 `014A` 系废止）；
    - `bit_len` 缺省（0）→ extent = size×8 → 高对齐位移 0 → 与 R73 前**逐字节
      一致**（PACK_VECTORS / 指令侧 BITFIELD 零漂移护栏）。
    """
    size = max(1, _as_int(byte_length, 1))
    span = size * 8
    declared = _as_int(bit_len, 0)
    extent = declared if 0 < declared <= span else span
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
    packed &= (1 << extent) - 1
    return f"{packed << (span - extent):0{size * 2}X}"


class BitfieldHandler(LogicHandler):
    def calculate(self, block: Block, flattened_blocks: List[Tuple[str, Block]]) -> str:
        params = (block.config.params if block.config else None) or {}
        # R73（§8.105）：声明位宽随块透传 → extent 尾补零高对齐（与 wire 同口径；
        # 未声明 = size×8 → 与既有打包逐字节一致）。
        return pack_protocol_bits(
            params.get("bits"), block.byte_length, getattr(block, "bit_len", 0) or 0
        )
