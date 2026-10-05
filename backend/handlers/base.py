from abc import ABC, abstractmethod
from typing import List, Tuple
from backend.schemas.block import Block

class LogicHandler(ABC):
    @abstractmethod
    def calculate(self, block: Block, flattened_blocks: List[Tuple[str, Block]]) -> str:
        """
        Calculates the hex value for this block based on its config and dependencies.
        flattened_blocks: List of (LayerID, Block) in sequence order.
        """
        pass


# ─── 字节序门面（R21 长度域 · R34 校验和 —— 同一个谓词，改一必改二）────────────
# 上移到 base 是因为 R34 起 **length 与 checksum 两个 handler 同用**：抽出单点
# 避免出现第二套判据（与 FE `protocolTree` 两处反转同理）。`handlers.length` 仍
# re-export 这两个名字（`test_length_byte_order` 等既有 import 不破）。


def byte_order_of(block: Block) -> str:
    """`config.params.byte_order` → `'big'` | `'little'`（fail-open 回 `'big'`）。

    存点是协议 length / checksum 卡的 `parameter_config.byte_order`，由
    frame_builder::_build_logic_config / toFrameBlocks buildLogicConfig 同形
    翻译进 params（两卡同一存点、同一值域、同一字段定义）。

    缺失 / 非 big-little 的值一律 fail-open 回 `'big'`（镜像 ChecksumHandler 算法
    枚举外回 crc16_modbus 的口径）—— 缺省路径与本批之前逐字节一致（§0）。
    大小写 + 首尾空白不敏感（与 FE `String(pc.byte_order).trim().toLowerCase()` 同口径）。
    """
    params = getattr(block.config, "params", None)
    order = (params or {}).get("byte_order")
    if order is None:
        return "big"
    order = str(order).strip().lower()
    return order if order in ("big", "little") else "big"


def apply_byte_order(hex_str: str, block: Block) -> str:
    """大端格式化结果 → 按 block 的 byte_order 出线（little = 字节对反转）。

    big（缺省）逐字节原样；**奇数长度不反转** —— 那是值超出 byte_length 的畸形
    输出（大端路径同样输出奇数位），此处不发明语义，保持既有形态。
    单字节串反转后与原串相同 → 「1 字节不反转」是反转的自然结果，不是特例。
    """
    if byte_order_of(block) != "little":
        return hex_str
    if len(hex_str) % 2:
        return hex_str
    return "".join(hex_str[i:i + 2] for i in range(len(hex_str) - 2, -1, -2))
