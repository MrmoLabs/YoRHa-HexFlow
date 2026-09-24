from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.core.frame_builder import build_wrapped
from backend.core.orchestrator import Orchestrator
from backend.db.database import get_db
from backend.db.models import ProtocolTemplate
from backend.schemas.block import (
    FrameRequest,
    CompileResponse,
    WrappedCompileRequest,
    WrappedCompileResponse,
)

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


@router.post("/compile/wrapped", response_model=WrappedCompileResponse)
def compile_wrapped_frame(
    request: WrappedCompileRequest,
    db: Session = Depends(get_db),
):
    """批次一 1b (D4-A): 协议 + 已编码内核 hex 载荷 → 封装帧。

    404 协议不存在（对齐 protocol.py "Protocol not found" 先例）；
    build_wrapped 语义错误（插槽不存在/不是插槽/重复、非法 hex）→ 400。
    """
    protocol = db.query(ProtocolTemplate) \
        .filter(ProtocolTemplate.id == request.protocol_id).first()
    if protocol is None:
        raise HTTPException(status_code=404, detail="Protocol not found")
    try:
        result = build_wrapped(
            protocol.children or [],
            request.payloads,
            slot_ids=request.slot_ids,
            start_order=request.start_order,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return WrappedCompileResponse(
        hex_string=result["hex"],
        total_length=result["total_length"],
        warnings=result["warnings"],
    )
