"""E2-T4: transport config API + connection status (loopback/tcp/serial)."""

import re
from typing import Any, Dict

from fastapi import APIRouter, Body, HTTPException

from backend.core import transport

router = APIRouter(prefix="/transport", tags=["transport"])


def _port_sort_key(port: Any) -> list:
    """COM1 / COM3 / COM10 **自然序** —— 纯字典序会把 COM10 排到 COM3 前面。

    每段打类型标记 `(0, str)` / `(1, int)`：任意设备名之间都不会拿 int 去比 str，
    形状再怪也不会 TypeError。
    """
    parts = re.split(r"(\d+)", port.device or "")
    return [(1, int(part)) if part.isdigit() else (0, part.lower()) for part in parts]


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


@router.get("/ports")
def list_transport_ports() -> Dict[str, Any]:
    """本机串口端口枚举（R14，PLAN §8.49）→ `{ports, source, error?}`。

    **只读、不碰配置** —— 非串口模式也照答（前端只在 SERIAL 段显示，点芯片即填表单）。
    **绝不 500**：枚举只是锦上添花，pyserial 缺失或枚举炸了都降级成
    `{ports: [], source: "unavailable", error: "<原因>"}` 让配置页照常用（前端把
    `error` 原文显示出来，不静默吞）。
    """
    try:
        from serial.tools import list_ports  # pyserial（E2-T3 解禁依赖）
    except Exception as e:  # noqa: BLE001 —— 依赖缺失 = 降级，不是故障
        return {"ports": [], "source": "unavailable", "error": f"pyserial 未安装：{e}"}
    try:
        found = sorted(list_ports.comports(), key=_port_sort_key)
    except Exception as e:  # noqa: BLE001 —— 权限 / 驱动异常同样降级
        return {"ports": [], "source": "unavailable", "error": f"端口枚举失败：{e}"}
    return {
        "ports": [
            {"device": p.device or "", "description": (p.description or "").strip()}
            for p in found
        ],
        "source": "pyserial",
    }


@router.get("/status")
def get_transport_status() -> Dict[str, Any]:
    return transport.get_status()
