from typing import List, Tuple
from backend.handlers.base import LogicHandler
from backend.schemas.block import Block


def byte_order_of(block: Block) -> str:
    """R21（§8.52 排期 · 长度域 BE/LE）: config.params.byte_order → 'big' | 'little'。

    存点是协议 length 卡的 `parameter_config.byte_order`，由 frame_builder::
    _build_logic_config / toFrameBlocks buildLogicConfig 同形翻译进 params。
    缺失 / 非 big-little 的值一律 fail-open 回 'big'（镜像 ChecksumHandler 算法
    枚举外回 crc16_modbus 的口径）—— 缺省路径与本批之前逐字节一致（§0）。
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
    """
    if byte_order_of(block) != "little":
        return hex_str
    if len(hex_str) % 2:
        return hex_str
    return "".join(hex_str[i:i + 2] for i in range(len(hex_str) - 2, -1, -2))


class LengthHandler(LogicHandler):
    def calculate(self, block: Block, flattened_blocks: List[Tuple[str, Block]]) -> str:
        if not block.config:
            return "00" * block.byte_length

        refs = block.config.params.get("refs")
        offset = int(block.config.params.get("offset", 0))
        if isinstance(refs, list):
            # 批次四 (R2 打通): refs 集合模式 —— 语义同 ChecksumHandler：
            # 恰好累加 refs 列出的叶子块（跳过自身/禁用/slot，repeat 出现几次
            # 算几次），非连续 refs 不引入区间内无关块；空集 → offset。
            count = 0
            for ref_id in refs:
                for _layer_id, b in flattened_blocks:
                    if b.id == ref_id and b.id != block.id and b.is_enabled and b.type != "slot":
                        count += b.byte_length
            total = count + offset
            return apply_byte_order(f"{total:0{block.byte_length * 2}X}", block)

        start_id = block.config.target_start_id
        end_id = block.config.target_end_id

        # Range matching rules:
        # 1. Start block: first match begins the range.
        # 2. End block: only scanned AFTER the start has matched, so an end_id that
        #    happens to appear earlier in the stream cannot terminate the scan prematurely.
        # 3. If no end block is found, the range extends to the end of the stream.
        count = 0
        in_range = False
        start_matched = False

        for layer_id, b in flattened_blocks:
            if not start_matched and b.id == start_id:
                start_matched = True
                in_range = True

            if in_range:
                if b.is_enabled and b.id != block.id and b.type != "slot":
                    # Don't count the length block itself unless needed (rare)
                    # Don't count "slots" (placeholders), only their contents (which are separate blocks in the stream)
                    count += b.byte_length

                if b.id == end_id:
                    # End is only honored once the range has actually started
                    in_range = False
                    break
                
        total = count + offset
        hex_str = f"{total:0{block.byte_length * 2}X}"
        return apply_byte_order(hex_str, block)
