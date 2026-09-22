from typing import List, Tuple, Dict
from backend.schemas.block import Block, BlockType
from backend.schemas.template import Layer
from backend.core.graph import GraphEngine
from backend.handlers.length import LengthHandler
from backend.handlers.checksum import ChecksumHandler
# from backend.handlers.escape import EscapeHandler (To be implemented)

class Orchestrator:
    def __init__(self, root_blocks: List[Block]):
        """
        root_blocks: A forest of block trees (containers with children).
        """
        self.root_blocks = root_blocks
        self.handlers = {
            "length": LengthHandler(),
            "checksum": ChecksumHandler()
        }
        # Flat stream for final global addressing
        self.flattened_stream: List[Block] = []

    def process(self) -> str:
        # 1. Deep pass (post-order placeholder): children are structural units,
        #    containers emit no bytes of their own.
        for block in self.root_blocks:
            self._process_recursive(block)

        # 2. Flatten the forest into a linear stream.
        self.flattened_stream = []
        for block in self.root_blocks:
            self._flatten_recursive(block)

        # 3. Range-dependent logic (length / checksum) runs on the flattened
        #    stream, because these blocks reference start/end IDs of siblings
        #    and descendants. Children's hex values are already final here.
        flat_tuples: List[Tuple[str, Block]] = [("global", b) for b in self.flattened_stream]

        for block in self.flattened_stream:
            if block.type in [BlockType.LENGTH, BlockType.CHECKSUM]:
                handler_key = block.type
                if isinstance(block.type, BlockType):
                    handler_key = block.type.value

                handler = self.handlers.get(handler_key)
                if handler:
                    block.hex_value = handler.calculate(block, flat_tuples)

        # 4. Emit final hex (slots are placeholders and emit nothing).
        final_hex = []
        for b in self.flattened_stream:
            if b.is_enabled and b.type != BlockType.SLOT:
                val = b.hex_value or ("00" * b.byte_length)
                # ESCAPING LOGIC (Placeholder): val = self.escape_handler.process(val)
                final_hex.append(val)

        return " ".join(final_hex)

    def _process_recursive(self, block: Block):
        # Containers are wrappers: recurse into children, no self-logic needed
        # (fixed blocks already carry hex_value).
        if block.children:
            for child in block.children:
                self._process_recursive(child)

    def _flatten_recursive(self, block: Block):
        # Containers are groupings and emit no bytes; only atomic (leaf) blocks
        # join the stream, in document order:
        #   Container(HeaderBlock, LengthBlock, PayloadContainer(...), CRCBlock)
        if block.is_container:
            for child in block.children:
                self._flatten_recursive(child)
        else:
            self.flattened_stream.append(block)
