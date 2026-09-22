from fastapi import APIRouter, HTTPException

from backend.core.orchestrator import Orchestrator
from backend.schemas.block import FrameRequest, CompileResponse

router = APIRouter(tags=["compile"])


@router.post("/compile", response_model=CompileResponse)
async def compile_frame(request: FrameRequest):
    try:
        # Phase 3: Recursive Orchestrator
        # request.blocks contains the root forest (Containers/Blocks)
        orchestrator = Orchestrator(request.blocks)
        result_hex = orchestrator.process()

        # Calculate total binary length (from spaces)
        byte_count = len(result_hex.replace(" ", "")) // 2

        debug_info = ["Compiled via Recursive Onion Engine"]

        return CompileResponse(
            hex_string=result_hex,
            total_length=byte_count,
            debug_info=debug_info
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
