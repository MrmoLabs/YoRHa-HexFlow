import time
from collections import deque
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.core import transport
from backend.routers.export import hex_to_bytes

router = APIRouter(prefix="/dispatch", tags=["dispatch"])

# Send history (bounded): frames are dispatched through the E2 transport
# abstraction (loopback default / tcp / serial) and recorded with three
# kinds of events — raw / response / error (E2-T4).
_MAX_HISTORY = 100
_history: deque = deque(maxlen=_MAX_HISTORY)


class DispatchRequest(BaseModel):
    hex_string: str = Field(..., description="Assembled hex stream to send")
    instruction_name: Optional[str] = Field(None, description="Source instruction label")


class DispatchEvent(BaseModel):
    """One send-history event: raw frame, response bytes, or error (E2-T4)."""

    type: str  # "raw" | "response" | "error"
    hex_string: Optional[str] = None  # raw/response payload, space-separated uppercase
    message: Optional[str] = None  # error reason


class DispatchRecord(BaseModel):
    id: int
    timestamp: str
    channel: str  # LOOPBACK / TCP / SERIAL (transport mode, default LOOPBACK)
    status: str  # SENT / ERROR
    byte_count: int
    hex_string: str
    instruction_name: Optional[str] = None
    echo: str  # response bytes, compact uppercase hex (loopback = payload echo)
    events: List[DispatchEvent] = Field(default_factory=list)


def _spaced(data: bytes) -> str:
    return " ".join(f"{b:02X}" for b in data)


@router.post("/", response_model=DispatchRecord)
def dispatch_frame(request: DispatchRequest):
    try:
        data = hex_to_bytes(request.hex_string)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid payload: {e}")

    channel = transport.get_config()["mode"].upper()
    payload_spaced = _spaced(data)
    base = dict(
        id=int(time.time() * 1000),
        timestamp=datetime.now(timezone.utc).isoformat(),
        channel=channel,
        byte_count=len(data),
        hex_string=payload_spaced,
        instruction_name=request.instruction_name,
    )

    try:
        response = transport.send(data)
    except transport.TransportError as e:
        # Error event: the raw frame we attempted to send + failure reason.
        _history.appendleft(DispatchRecord(
            status="ERROR",
            echo="",
            events=[
                DispatchEvent(type="raw", hex_string=payload_spaced),
                DispatchEvent(type="error", message=str(e)),
            ],
            **base,
        ))
        raise HTTPException(status_code=502, detail=f"Transport error: {e}")

    record = DispatchRecord(
        status="SENT",
        echo=response.hex().upper(),
        events=[
            DispatchEvent(type="raw", hex_string=payload_spaced),
            DispatchEvent(type="response", hex_string=_spaced(response)),
        ],
        **base,
    )
    _history.appendleft(record)
    return record


@router.get("/history", response_model=List[DispatchRecord])
def dispatch_history(limit: int = 50):
    limit = max(1, min(limit, _MAX_HISTORY))
    return list(_history)[:limit]


@router.delete("/history")
def clear_history():
    _history.clear()
    return {"status": "cleared", "remaining": len(_history)}
