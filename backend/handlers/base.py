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
