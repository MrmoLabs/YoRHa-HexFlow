"""E2 transport abstraction: loopback (default) / TCP (stdlib socket) / serial (pyserial).

- loopback：进程内环回，send 原样回显，/dispatch 口径不变（E2-T1）。
- tcp：socket 标准库，host/port/connect_timeout/read_timeout + 连接状态事件（E2-T2）。
- serial：pyserial，COM/波特率/校验/停止位/数据位（E2-T3）。

连接状态事件（connected/disconnected/error）保存在有界列表，由
``GET /transport/status`` 暴露；发送历史三类事件（raw/response/error）
由 /dispatch 路由在 send 结果上落库（E2-T4）。
"""

import socket
import threading
import time
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

VALID_MODES = ("loopback", "tcp", "serial")
VALID_PARITIES = ("N", "E", "O")
VALID_STOPBITS = (1, 1.5, 2)
VALID_BYTESIZES = (5, 6, 7, 8)
_TIMEOUT_MIN_MS = 1
_TIMEOUT_MAX_MS = 60000
_MAX_STATE_EVENTS = 50
# 收包节拍：每 25ms 轮询一次；数据到齐后静默 50ms 即视为响应结束，
# 避免每次都等满 read_timeout。
_POLL_S = 0.025
_QUIET_S = 0.05


class TransportError(Exception):
    """真实传输（TCP/串口）发送失败。"""


def default_config() -> Dict[str, Any]:
    return {
        "mode": "loopback",
        "tcp": {
            "host": "127.0.0.1",
            "port": 9000,
            "connect_timeout_ms": 3000,
            "read_timeout_ms": 2000,
        },
        "serial": {
            "port": "COM3",
            "baudrate": 9600,
            "bytesize": 8,
            "parity": "N",
            "stopbits": 1,
            "read_timeout_ms": 2000,
        },
    }


def _require_int(value: Any, name: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} 必须是整数")
    if not (lo <= value <= hi):
        raise ValueError(f"{name} 必须在 {lo}..{hi} 范围内")
    return value


def _require_timeout(value: Any, name: str) -> int:
    return _require_int(value, name, _TIMEOUT_MIN_MS, _TIMEOUT_MAX_MS)


def validate_config(config: Any) -> Dict[str, Any]:
    """校验并归一化完整传输配置；非法时抛 ValueError（路由层映射 400）。"""
    if not isinstance(config, dict):
        raise ValueError("传输配置必须是对象")
    unknown = set(config) - {"mode", "tcp", "serial"}
    if unknown:
        raise ValueError(f"未知配置字段: {', '.join(sorted(unknown))}")

    mode = config.get("mode")
    if mode not in VALID_MODES:
        raise ValueError(f"未知传输模式: {mode!r}（可选 loopback/tcp/serial）")

    tcp = config.get("tcp")
    if not isinstance(tcp, dict):
        raise ValueError("tcp 配置必须是对象")
    unknown_tcp = set(tcp) - {"host", "port", "connect_timeout_ms", "read_timeout_ms"}
    if unknown_tcp:
        raise ValueError(f"未知 tcp 配置字段: {', '.join(sorted(unknown_tcp))}")
    host = tcp.get("host")
    if not isinstance(host, str) or not host.strip():
        raise ValueError("tcp.host 不能为空")
    _require_int(tcp.get("port"), "tcp.port", 1, 65535)
    _require_timeout(tcp.get("connect_timeout_ms"), "tcp.connect_timeout_ms")
    _require_timeout(tcp.get("read_timeout_ms"), "tcp.read_timeout_ms")

    ser = config.get("serial")
    if not isinstance(ser, dict):
        raise ValueError("serial 配置必须是对象")
    unknown_ser = set(ser) - {"port", "baudrate", "bytesize", "parity", "stopbits", "read_timeout_ms"}
    if unknown_ser:
        raise ValueError(f"未知 serial 配置字段: {', '.join(sorted(unknown_ser))}")
    port = ser.get("port")
    if not isinstance(port, str) or not port.strip():
        raise ValueError("serial.port 不能为空")
    _require_int(ser.get("baudrate"), "serial.baudrate", 1, 4000000)
    _require_int(ser.get("bytesize"), "serial.bytesize", min(VALID_BYTESIZES), max(VALID_BYTESIZES))
    parity = ser.get("parity")
    if not isinstance(parity, str) or parity.upper() not in VALID_PARITIES:
        raise ValueError(f"serial.parity 必须是 {'/'.join(VALID_PARITIES)} 之一")
    stopbits = ser.get("stopbits")
    if stopbits not in VALID_STOPBITS:
        raise ValueError("serial.stopbits 必须是 1/1.5/2 之一")
    _require_timeout(ser.get("read_timeout_ms"), "serial.read_timeout_ms")

    normalized = deepcopy(config)
    normalized["serial"]["parity"] = parity.upper()
    # 1.0/2.0 浮点写法归一为 int，1.5 保持 float。
    if normalized["serial"]["stopbits"] == 1:
        normalized["serial"]["stopbits"] = 1
    elif normalized["serial"]["stopbits"] == 2:
        normalized["serial"]["stopbits"] = 2
    else:
        normalized["serial"]["stopbits"] = 1.5
    return normalized


def _deep_merge(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    out = deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = deepcopy(value)
    return out


_lock = threading.RLock()
_config: Dict[str, Any] = default_config()
_tcp_sock: Optional[socket.socket] = None
_serial_inst: Any = None
_state_events: List[Dict[str, Any]] = []
_last_error: Optional[str] = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _record_event(event: str, detail: Optional[str] = None) -> None:
    global _state_events
    _state_events.append({"ts": _now_iso(), "event": event, "detail": detail})
    if len(_state_events) > _MAX_STATE_EVENTS:
        _state_events = _state_events[-_MAX_STATE_EVENTS:]


def _fail(message: str) -> "TransportError":
    global _last_error
    _last_error = message
    _record_event("error", message)
    return TransportError(message)


def _close_tcp(detail: Optional[str]) -> None:
    global _tcp_sock
    sock = _tcp_sock
    _tcp_sock = None
    if sock is None:
        return
    try:
        sock.close()
    except OSError:
        pass
    if detail is not None:
        _record_event("disconnected", detail)


def _close_serial(detail: Optional[str]) -> None:
    global _serial_inst
    inst = _serial_inst
    _serial_inst = None
    if inst is None:
        return
    try:
        inst.close()
    except Exception:
        pass
    if detail is not None:
        _record_event("disconnected", detail)


def _close_all(detail: Optional[str]) -> None:
    _close_tcp(detail)
    _close_serial(detail)


def get_config() -> Dict[str, Any]:
    with _lock:
        return deepcopy(_config)


def set_config(patch: Dict[str, Any]) -> Dict[str, Any]:
    """把 patch 深合并到当前配置，整体校验后生效；生效时断开既有真实连接。"""
    global _config, _last_error
    if not isinstance(patch, dict):
        raise ValueError("传输配置必须是对象")
    normalized = validate_config(_deep_merge(_config, patch))
    with _lock:
        if normalized != _config:
            if _tcp_sock is not None or _serial_inst is not None:
                _close_all("配置变更")
            _config = normalized
            _last_error = None
    return get_config()


def get_status() -> Dict[str, Any]:
    """连接状态：loopback 恒为已连接；tcp/serial 反映真实句柄 + 有界状态事件。"""
    with _lock:
        if _config["mode"] == "loopback":
            connected = True
        elif _config["mode"] == "tcp":
            connected = _tcp_sock is not None
        else:
            connected = _serial_inst is not None and bool(getattr(_serial_inst, "is_open", False))
        return {
            "mode": _config["mode"],
            "connected": connected,
            "last_error": _last_error,
            "events": list(_state_events),
        }


def reset() -> None:
    """恢复默认 loopback 配置并清空连接与状态（测试/进程重置用）。"""
    global _config, _last_error, _state_events
    with _lock:
        _close_all(None)
        _config = default_config()
        _last_error = None
        _state_events = []


def send(data: bytes) -> bytes:
    """按当前模式发送并返回响应字节（loopback 为回显）。失败抛 TransportError。"""
    with _lock:
        mode = _config["mode"]
        if mode == "loopback":
            return data
        if mode == "tcp":
            return _tcp_send(data)
        return _serial_send(data)


def _tcp_connect(cfg: Dict[str, Any]) -> socket.socket:
    global _tcp_sock
    address = f"{cfg['host']}:{cfg['port']}"
    try:
        sock = socket.create_connection(
            (cfg["host"], cfg["port"]), timeout=cfg["connect_timeout_ms"] / 1000
        )
    except OSError as e:
        raise _fail(f"TCP 连接 {address} 失败: {e}") from e
    _tcp_sock = sock
    _record_event("connected", address)
    return sock


def _tcp_read(sock: socket.socket, timeout_ms: int) -> "tuple[bytes, bool]":
    """读到响应结束（静默 _QUIET_S 或到 read_timeout）；返回 (数据, 对端是否已关闭)。"""
    sock.settimeout(_POLL_S)
    deadline = time.monotonic() + timeout_ms / 1000
    buf = bytearray()
    got = False
    last = time.monotonic()
    while True:
        now = time.monotonic()
        if now >= deadline:
            break
        if got and now - last >= _QUIET_S:
            break
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            continue
        if not chunk:
            return bytes(buf), True
        buf += chunk
        got = True
        last = time.monotonic()
    return bytes(buf), False


def _tcp_send(data: bytes) -> bytes:
    cfg = _config["tcp"]
    sock = _tcp_sock
    if sock is None:
        sock = _tcp_connect(cfg)
    try:
        sock.sendall(data)
        response, peer_closed = _tcp_read(sock, cfg["read_timeout_ms"])
    except TransportError:
        raise
    except OSError as e:
        _close_tcp(None)
        raise _fail(f"TCP 收发失败: {e}") from e
    if peer_closed:
        _close_tcp("对端关闭")
    return response


def _serial_connect(cfg: Dict[str, Any]) -> Any:
    global _serial_inst
    try:
        import serial  # pyserial（E2-T3 解禁依赖）
    except ImportError as e:
        raise _fail("pyserial 未安装，串口模式不可用") from e
    try:
        inst = serial.Serial(
            port=cfg["port"],
            baudrate=cfg["baudrate"],
            bytesize=cfg["bytesize"],
            parity=cfg["parity"],
            stopbits=cfg["stopbits"],
            timeout=_POLL_S,
            write_timeout=cfg["read_timeout_ms"] / 1000,
        )
    except Exception as e:
        raise _fail(f"串口 {cfg['port']} 打开失败: {e}") from e
    _serial_inst = inst
    _record_event("connected", f"{cfg['port']}@{cfg['baudrate']}")
    return inst


def _serial_read(inst: Any, timeout_ms: int) -> bytes:
    """读到响应结束（静默 _QUIET_S 或到 read_timeout）。"""
    deadline = time.monotonic() + timeout_ms / 1000
    buf = bytearray()
    got = False
    last = time.monotonic()
    while True:
        now = time.monotonic()
        if now >= deadline:
            break
        if got and now - last >= _QUIET_S:
            break
        waiting = inst.in_waiting
        if waiting:
            buf += inst.read(waiting)
            got = True
            last = time.monotonic()
        else:
            time.sleep(_POLL_S)
    return bytes(buf)


def _serial_send(data: bytes) -> bytes:
    cfg = _config["serial"]
    inst = _serial_inst
    if inst is None or not inst.is_open:
        inst = _serial_connect(cfg)
    try:
        inst.reset_input_buffer()
        inst.write(data)
        return _serial_read(inst, cfg["read_timeout_ms"])
    except TransportError:
        raise
    except Exception as e:
        _close_serial(None)
        raise _fail(f"串口收发失败: {e}") from e
