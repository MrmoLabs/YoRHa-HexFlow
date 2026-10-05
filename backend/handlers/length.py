from typing import List, Tuple

from backend.core.framing import encode_varint
from backend.core.framing import normalize_encoding as _normalize_encoding
# R34（§8.66 · 校验和字节序）: `byte_order_of` / `apply_byte_order` 上移到
# `handlers.base` —— length 与 checksum 两个 handler **同用一个门面**（同判据，
# 不留第二套）。`byte_order_of` 在此为 re-export：既有
# `from backend.handlers.length import byte_order_of`（test_length_byte_order）
# 不破；`apply_byte_order` 仍是 format_total 的出线口。
from backend.handlers.base import LogicHandler, apply_byte_order, byte_order_of
from backend.schemas.block import Block


def encoding_of(block: Block) -> str:
    """R27（§8.52 排期 · varint 变长长度前缀）: config.params.encoding →
    'fixed' | 'varint'。

    存点是协议 length 卡的 `parameter_config.encoding`，由 frame_builder::
    _build_logic_config / toFrameBlocks buildLogicConfig 同形翻译进 params。
    缺失 / 枚举外的值一律 fail-open 回 'fixed'（镜像 `byte_order_of`）——
    不配 varint 就与本批之前逐字节一致（§0 硬约束）。
    """
    return _normalize_encoding(getattr(block.config, "params", None))


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
            return format_total(block, total)

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
        return format_total(block, total)


def format_total(block: Block, total: int) -> str:
    """长度值 → 出线 hex —— 定宽大端（R21 字节序）与 R27 varint 的**唯一分叉点**。

    - ``encoding == "varint"``：LEB128 最小长度无符号编码；**字节序无关** → 不走
      ``apply_byte_order``（同帧同时配 ``byte_order=little`` 也按 varint 出线）。
      出线宽度 ≠ 设计期 ``byte_length`` → 把实际字节数**回写**进
      ``block.byte_length``，使后续 refs Σ / checksum 对本块的计数取到真实宽度
      （与 FE ``resolveDependencies`` 的 ``fieldSizes`` 同源同口径，改一必改二）。
      负值 / 超安全整数域 → ``ValueError``（HTTP 侧走既有 ValueError→400）。
    - 缺省 ``fixed``（键缺失 / 非法值 fail-open）：与本批之前**逐字节一致**（§0）。
    """
    if encoding_of(block) == "varint":
        hex_str = encode_varint(total)
        block.byte_length = len(hex_str) // 2
        return hex_str
    return apply_byte_order(f"{total:0{block.byte_length * 2}X}", block)
