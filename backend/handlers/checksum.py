from typing import Dict, List, Tuple
import binascii
from backend.handlers.base import LogicHandler
from backend.schemas.block import Block

class ChecksumHandler(LogicHandler):
    def calculate(self, block: Block, flattened_blocks: List[Tuple[str, Block]]) -> str:
        if not block.config:
            return "00" * block.byte_length
            
        algo = block.config.params.get("algorithm", "sum")
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
