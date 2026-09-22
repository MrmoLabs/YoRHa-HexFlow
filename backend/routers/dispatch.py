import time
from collections import deque
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.routers.export import hex_to_bytes

router = APIRouter(prefix="/dispatch", tags=["dispatch"])

# In-memory loopback channel: the project has no serial/TCP transport yet,
# so dispatched frames are acknowledged and kept in a bounded history.
_MAX_HISTORY = 100
_history: deque = deque(maxlen=_MAX_HISTORY)


class DispatchRequest(BaseModel):
    hex_string: str = Field(..., description="Assembled hex stream to send")
    instruction_name: Optional[str] = Field(None, description="Source instruction label")


class DispatchRecord(BaseModel):
    id: int
    timestamp: str
    channel: str
    status: str
    byte_count: int
    hex_string: str
    instruction_name: Optional[str] = None
    echo: str


@router.post("/", response_model=DispatchRecord)
def dispatch_frame(request: DispatchRequest):
    try:
        data = hex_to_bytes(request.hex_string)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid payload: {e}")

    record = DispatchRecord(
        id=int(time.time() * 1000),
        timestamp=datetime.now(timezone.utc).isoformat(),
        channel="LOOPBACK",
        status="SENT",
        byte_count=len(data),
        hex_string=" ".join(data[i:i + 1].hex().upper() for i in range(len(data))),
        instruction_name=request.instruction_name,
        echo=data.hex().upper(),
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
