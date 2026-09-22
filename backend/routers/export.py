import re

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field
from typing import Optional

from backend.core.orchestrator import Orchestrator
from backend.schemas.block import FrameRequest

router = APIRouter(prefix="/export", tags=["export"])

_HEX_CLEANER = re.compile(r"[\s,_-]")


def hex_to_bytes(hex_string: str) -> bytes:
    """Convert a hex string (with optional spaces/underscores) to raw bytes."""
    cleaned = _HEX_CLEANER.sub("", hex_string or "")
    if not cleaned:
        raise ValueError("hex_string is empty")
    if len(cleaned) % 2 != 0:
        raise ValueError("hex_string has an odd number of hex digits")
    try:
        return bytes.fromhex(cleaned)
    except ValueError as e:
        raise ValueError(f"invalid hex string: {e}")


def _binary_response(data: bytes, filename: str) -> Response:
    safe_name = re.sub(r"[^\w.\-]+", "_", filename or "yorha-frame.bin").strip("_") or "yorha-frame.bin"
    if not safe_name.lower().endswith((".bin", ".hex")):
        safe_name = f"{safe_name}.bin"
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
    )


class HexExportRequest(BaseModel):
    hex_string: str = Field(..., description="Pre-assembled hex stream")
    filename: Optional[str] = Field(None, description="Output file name")


@router.post("/binary")
def export_binary_from_blocks(request: FrameRequest, filename: Optional[str] = None):
    """Compile a block forest server-side and return the assembled .bin file."""
    try:
        result_hex = Orchestrator(request.blocks).process()
        data = hex_to_bytes(result_hex)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return _binary_response(data, filename or "yorha-frame.bin")


@router.post("/hex")
def export_hex_file(request: HexExportRequest):
    """Download the hex stream as a human-readable .hex text file."""
    try:
        data = hex_to_bytes(request.hex_string)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    spaced = " ".join(data[i:i + 1].hex().upper() for i in range(len(data)))
    payload = f"{spaced}\n".encode("ascii")
    resp = _binary_response(payload, request.filename or "yorha-frame.hex")
    resp.headers["Content-Type"] = "text/plain; charset=utf-8"
    return resp
