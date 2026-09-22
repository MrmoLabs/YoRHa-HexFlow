from typing import Dict, List, Tuple
from backend.handlers.base import LogicHandler
from backend.schemas.block import Block

class LengthHandler(LogicHandler):
    def calculate(self, block: Block, flattened_blocks: List[Tuple[str, Block]]) -> str:
        if not block.config:
            return "00" * block.byte_length
            
        start_id = block.config.target_start_id
        end_id = block.config.target_end_id
        offset = int(block.config.params.get("offset", 0))

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
        return hex_str
