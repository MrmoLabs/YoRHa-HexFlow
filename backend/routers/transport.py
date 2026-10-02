"""E2-T4: transport config API + connection status (loopback/tcp/serial)."""

from typing import Any, Dict

from fastapi import APIRouter, Body, HTTPException

from backend.core import transport

router = APIRouter(prefix="/transport", tags=["transport"])


@router.get("/config")
def get_transport_config() -> Dict[str, Any]:
    return transport.get_config()


@router.post("/config")
def set_transport_config(patch: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """深合并 patch 到当前配置并整体校验；非法字段/取值 → 400。"""
    try:
        return transport.set_config(patch)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/config/revert")
def revert_transport_config() -> Dict[str, Any]:
    """一键回退到「上一配置」（R2，PLAN §8.37）→ `{config, historyDepth}`。

    没有可回退的历史 → 400（前端把 detail 显示在配置区，按钮由 status 的
    `configHistoryDepth` 决定是否置灰，所以正常走不到这条）。
    """
    try:
        return transport.revert_config()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/status")
def get_transport_status() -> Dict[str, Any]:
    return transport.get_status()
