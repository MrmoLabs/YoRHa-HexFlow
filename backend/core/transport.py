"""E2 transport abstraction: loopback (default) / TCP (stdlib socket) / serial (pyserial).

- loopback：进程内环回，send 原样回显，/dispatch 口径不变（E2-T1）。
- tcp：socket 标准库，host/port/connect_timeout/read_timeout + 连接状态事件（E2-T2）。
- serial：pyserial，COM/波特率/校验/停止位/数据位（E2-T3）。

连接状态事件（connected/disconnected/error）保存在有界列表，由
``GET /transport/status`` 暴露；发送历史三类事件（raw/response/error）
由 /dispatch 路由在 send 结果上落库（E2-T4）。

R2（PLAN §8.37）：配置每次真的变更都把被替换的旧版本压进**进程内**有界回退栈，
``POST /transport/config/revert`` 可一键退回（可连退多版，回退本身不入栈）；
启动恢复属「装载」不入栈。零 DDL → 栈重启即空，跨重启回退需新增列（归 R6 那档）。
"""

import socket
import threading
import time
from collections import deque
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from backend.core.escape import normalize_escape as _normalize_escape

VALID_MODES = ("loopback", "tcp", "serial")
VALID_PARITIES = ("N", "E", "O")
VALID_STOPBITS = (1, 1.5, 2)
VALID_BYTESIZES = (5, 6, 7, 8)
_TIMEOUT_MIN_MS = 1
_TIMEOUT_MAX_MS = 60000
_MAX_STATE_EVENTS = 50
# R2（§8.37）「上一配置」回退栈深度。**进程内**有界栈 —— 零 DDL 口径：不给
# transport_settings 加列，所以重启即空；跨重启回退需新增列，归 R6 那档 DDL 批。
_MAX_CONFIG_HISTORY = 20
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
        # N4 (G3): 传输层帧字节转义 —— 缺省关闭；骑在 JSON 配置上（零 DDL），
        # 语义/归一见 backend/core/escape.py（出线前对内核字节转义）。
        "escape": {"enabled": False, "pairs": []},
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
    unknown = set(config) - {"mode", "tcp", "serial", "escape"}
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

    # N4 (G3): 转义段归一 —— 缺段（旧库存量）→ 默认关闭；非法 → ValueError → 400
    escape_norm = _normalize_escape(config.get("escape"))

    normalized = deepcopy(config)
    normalized["serial"]["parity"] = parity.upper()
    normalized["escape"] = escape_norm
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
# R2：被 set_config 替换掉的**上一版**配置（右端 = 最近一次，回退即弹栈）。
# 有界 deque，超长自动丢最老一版 —— 手改配置十几次不会把内存撑住。
_config_history: deque = deque(maxlen=_MAX_CONFIG_HISTORY)
# P1 连接持久化：配置变更钩子（main.py lifespan 注册后，每次 set_config 生效且
# 有变化时回调新配置；测试不挂钩 → 零落库，test_transport 行为不变）。
_persist_hook: Optional[Any] = None


def set_persist_hook(hook) -> None:
    """注册 / 注销（None）配置变更持久化钩子。"""
    global _persist_hook
    _persist_hook = hook


def get_persist_hook():
    """取当前钩子 —— 供「恢复期临时摘钩再交回」用（见 datahub.restore 与 transport_store 启动纪律）。"""
    return _persist_hook


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _record_event(event: str, detail: Optional[str] = None) -> None:
    global _state_events
    _state_events.append({"ts": _now_iso(), "event": event, "detail": detail})
    if len(_state_events) > _MAX_STATE_EVENTS:
        _state_events = _state_events[-_MAX_STATE_EVENTS:]


def _persist_best_effort(config: Dict[str, Any]) -> None:
    """配置生效后的持久化：尽力而为 + **失败留痕**（§8.33）。

    钩子失败**不回滚**已生效的配置（下次变更重试落库），但必须留痕 —— 否则用户以为
    存了、重启后配置悄悄回默认，排查时完全无从下手；记进有界状态事件，
    `GET /transport/status` 可见。`set_config` / `revert_config` 共用（R2 抽出，
    否则回退路径会把这段 try/except 再抄一遍，将来改留痕文案就漏一处）。
    """
    if _persist_hook is None:
        return
    try:
        _persist_hook(deepcopy(config))
    except Exception as exc:
        _record_event("error", f"配置持久化失败（重启后可能回默认）：{exc}")


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


def set_config(patch: Dict[str, Any], record_history: bool = True) -> Dict[str, Any]:
    """把 patch 深合并到当前配置，整体校验后生效；生效时断开既有真实连接。

    P1：配置有变化时触发持久化钩子（lifespan 注册；测试不挂钩行为不变）。
    R2（§8.37）：`record_history` 缺省 True —— 配置**真的变了**时把被替换掉的上一版
    压进回退栈，供 `revert_config()` 一键退回。启动恢复 / DB 恢复那类「装载」传
    False，否则一开机栈里就躺一份默认配置，用户什么都没改点回退会莫名被重置。
    """
    global _config, _last_error
    if not isinstance(patch, dict):
        raise ValueError("传输配置必须是对象")
    normalized = validate_config(_deep_merge(_config, patch))
    changed = False
    with _lock:
        if normalized != _config:
            if record_history:
                _config_history.append(deepcopy(_config))
            if _tcp_sock is not None or _serial_inst is not None:
                _close_all("配置变更")
            _config = normalized
            _last_error = None
            changed = True
    if changed:
        _persist_best_effort(normalized)
    return get_config()


def get_config_history_depth() -> int:
    """可回退的「上一配置」条数（R2）—— 进程内栈，重启即空。"""
    with _lock:
        return len(_config_history)


def revert_config() -> Dict[str, Any]:
    """一键回退到最近一次变更**之前**的配置（R2，§8.37）。

    弹栈语义：`set_config` 每次**真的生效**就把被替换的旧配置压入（有界
    `_MAX_CONFIG_HISTORY`），回退 = 弹出并应用 —— 因此可连续回退多版 A→B→C 回
    B 再回 A。**回退本身不入栈**：否则退完一步立刻又能「回退回退」地振荡回去，
    栈也永远退不到空。无历史 → `ValueError`（路由转 400）。

    生效语义与 APPLY 完全一致：断开既有真实连接 + 走持久化钩子 + 留一条状态事件。
    返回 `{"config": 生效配置, "historyDepth": 剩余可回退条数}`。
    """
    global _config, _last_error
    with _lock:
        if not _config_history:
            raise ValueError("没有可回退的上一配置")
        target = validate_config(_config_history.pop())
        changed = target != _config
        if changed:
            if _tcp_sock is not None or _serial_inst is not None:
                _close_all("回退配置")
            _config = target
            _last_error = None
    if changed:
        _persist_best_effort(target)
        # 留痕（§8.33）：配置动了却没人知道是最难查的一类问题。
        _record_event("config", "已回退到上一配置")
    return {"config": get_config(), "historyDepth": get_config_history_depth()}


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
            # R2：前端据此决定「回退上一配置」按钮是否可用（0 → 置灰）。
            "configHistoryDepth": len(_config_history),
        }


def reset() -> None:
    """恢复默认 loopback 配置并清空连接与状态（测试/进程重置用）；持久化钩子一并清空。

    R2：回退栈同样清 —— 否则上一轮测试/上一个进程留下的「上一配置」会让 reset 后
    依然回得去，等于状态没真清干净。
    """
    global _config, _last_error, _state_events, _persist_hook
    with _lock:
        _close_all(None)
        _config = default_config()
        _last_error = None
        _state_events = []
        _config_history.clear()
        _persist_hook = None


def send(data: bytes, read_timeout_ms: Optional[int] = None) -> bytes:
    """按当前模式发送并返回响应字节（loopback 为回显）。失败抛 TransportError。

    P2 事务引擎：read_timeout_ms 覆盖本次读超时（不落配置、不断连接）——
    事务逐次 attempt 的 deadline 与配置项解耦；None = 用配置值（既有口径不变）。
    """
    if read_timeout_ms is not None:
        _require_timeout(read_timeout_ms, "read_timeout_ms")
    with _lock:
        mode = _config["mode"]
        if mode == "loopback":
            return data
        if mode == "tcp":
            return _tcp_send(data, read_timeout_ms)
        return _serial_send(data, read_timeout_ms)


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


def _tcp_send(data: bytes, read_timeout_ms: Optional[int] = None) -> bytes:
    cfg = _config["tcp"]
    # P2：事务逐次 attempt 用调用方读超时覆盖配置值（send 入口已校验）
    timeout_ms = cfg["read_timeout_ms"] if read_timeout_ms is None else read_timeout_ms
    sock = _tcp_sock
    if sock is None:
        sock = _tcp_connect(cfg)
    try:
        sock.sendall(data)
        response, peer_closed = _tcp_read(sock, timeout_ms)
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


def _serial_send(data: bytes, read_timeout_ms: Optional[int] = None) -> bytes:
    cfg = _config["serial"]
    # P2：事务逐次 attempt 用调用方读超时覆盖配置值（send 入口已校验）
    timeout_ms = cfg["read_timeout_ms"] if read_timeout_ms is None else read_timeout_ms
    inst = _serial_inst
    if inst is None or not inst.is_open:
        inst = _serial_connect(cfg)
    try:
        inst.reset_input_buffer()
        inst.write(data)
        return _serial_read(inst, timeout_ms)
    except TransportError:
        raise
    except Exception as e:
        _close_serial(None)
        raise _fail(f"串口收发失败: {e}") from e
