from typing import Dict, List, Tuple
import binascii
from backend.handlers.base import LogicHandler
from backend.schemas.block import Block

class ChecksumHandler(LogicHandler):
    def calculate(self, block: Block, flattened_blocks: List[Tuple[str, Block]]) -> str:
        if not block.config:
            return "00" * block.byte_length

        algo = block.config.params.get("algorithm", "sum")
        refs = block.config.params.get("refs")
        if isinstance(refs, list):
            # 批次四 (R2 打通): refs 集合模式 —— frontend toFrameBlocks 出口把
            # parameter_config.refs 按数组序展开成叶子 id 列表写入 params.refs。
            # 与前端 PASS2「逐 ref 取字节、按 refs 序拼接」对齐；range 模式
            # （下方 target_start/end）只覆盖连续区间，非连续 refs 会把区间内
            # 无关块算进来，故集合语义必须走此分支。同一 id 在流中出现多次
            # （repeat 展开）→ 每次出现都计入（前端组 ref 同样按重复取字节）。
            # 空集/全不可用 → 全 0（前端 calculateChecksum 对空字节返回 0）。
            data_bytes = bytearray()
            for ref_id in refs:
                for _layer_id, b in flattened_blocks:
                    if b.id != ref_id:
                        continue
                    if b.id == block.id or not b.is_enabled or b.type == "slot":
                        continue
                    val = b.hex_value or ("00" * b.byte_length)
                    try:
                        data_bytes.extend(bytes.fromhex(val.replace(" ", "")))
                    except ValueError:
                        pass
            if not data_bytes:
                return "00" * block.byte_length
            result = 0
            if algo == "sum":
                result = sum(data_bytes) % (256 ** block.byte_length)
            elif algo == "xor":
                for b in data_bytes:
                    result ^= b
            elif algo == "crc16_modbus":
                result = self.crc16(data_bytes)
            return f"{result:0{block.byte_length * 2}X}"

        start_id = block.config.target_start_id
        end_id = block.config.target_end_id
        
        data_bytes = bytearray()
        in_range = False
        start_matched = False

        # Same range rules as LengthHandler: start = first match,
        # end only honored after start, missing end => end of stream.
        for layer_id, b in flattened_blocks:
            if not start_matched and b.id == start_id:
                start_matched = True
                in_range = True

            if in_range:
                if b.is_enabled and b.id != block.id and b.type != "slot":
                    val = b.hex_value or ("00" * b.byte_length)
                    try:
                        # Clean spaces
                        clean_val = val.replace(" ", "")
                        data_bytes.extend(bytes.fromhex(clean_val))
                    except ValueError:
                        pass

                if b.id == end_id:
                    in_range = False
                    break
                
        result = 0
        if algo == "sum":
            if len(data_bytes) > 0:
                result = sum(data_bytes) % (256 ** block.byte_length)
        elif algo == "xor":
             for b in data_bytes:
                result ^= b
        elif algo == "crc16_modbus":
             result = self.crc16(data_bytes)
        
        return f"{result:0{block.byte_length * 2}X}"

    def crc16(self, data: bytearray, poly=0xA001):
        crc = 0xFFFF
        for byte in data:
            crc ^= byte
            for _ in range(8):
                if (crc & 0x0001):
                    crc = (crc >> 1) ^ poly
                else:
                    crc >>= 1
        return crc
