from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.core.frame_builder import build_wrapped
from backend.core.orchestrator import Orchestrator
from backend.core.recipe_compile import compile_recipe
from backend.db.database import get_db
from backend.db.models import ProtocolTemplate
from backend.schemas.block import (
    FrameRequest,
    CompileResponse,
    WrappedCompileRequest,
    WrappedCompileResponse,
    WrappedStage,
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
    build_wrapped 语义错误（插槽不存在/不是插槽/重复、非法 hex、fit_policy=reject）
    → 400。

    CP3 3a (D13): 增 `recipe_id` 分支 —— 配方**串行编译**（第 n 层输出喂第
    n+1 层），`hex_string`/`total_length` 仍为**最终帧**、`stages[]` 分层回显
    （含每层 hash 失效标记）。`protocol_id` 与 `recipe_id` **互斥**，都不给 →
    400；单协议路径（旧调用方）逐字段逐字节不变。
    """
    if request.recipe_id and request.protocol_id:
        raise HTTPException(
            status_code=400, detail="protocol_id 与 recipe_id 互斥，只能指定一个"
        )

    if request.recipe_id:
        try:
            result = compile_recipe(
                db,
                request.recipe_id,
                request.payloads,
                start_order=request.start_order,
            )
        except ValueError as e:
            # 逐层 build_wrapped 的语义错误（detail 已带「第 N 层（协议）」前缀）
            raise HTTPException(status_code=400, detail=str(e))
        return WrappedCompileResponse(
            hex_string=result["hex"],
            total_length=result["total_length"],
            warnings=result["warnings"],
            recipe_id=request.recipe_id,
            stages=[WrappedStage(**stage) for stage in result["stages"]],
        )

    if not request.protocol_id:
        raise HTTPException(
            status_code=400, detail="protocol_id 与 recipe_id 必须指定其一"
        )

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
