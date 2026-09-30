"""P3 后台序列 Runner：单槽运行态 + 与手动发送互斥。

- 单运行槽（模块级锁保护 claim/release）：一次只跑一个序列。手动发送
  （POST /dispatch、POST /dispatch/transaction）在运行期于入口查
  `is_running()` → 409 互斥（routers/dispatch.py）；Runner 自身直连
  transport.send，不经过被互斥的路由 → 无自锁。
- `claim()` 同步占用槽位（路由在返回前完成占位，防「两个 start 同时过检」
  的双启动竞态）；`execute(run)` 阻塞执行——路由丢 daemon 线程跑，测试
  直调（stdlib unittest 直测直调纪律，不引 TestClient、不起真线程）。
- 运行态与结果只存内存：轮询 GET /sequences/status 读取（P4 前端 1.5s）；
  完成后状态保留到下一次 claim 覆盖，前端轮询拿得到终态。
- 停止为协作式：delay 分片睡眠逐片查停止位；已发出的 transport.send 不
  打断（短超时内自然结束），停止后剩余步标 SKIPPED。
- 步执行：apply_plan（TIME/COUNTER 重算 + checksum 反算，见 sequence_plan）
  → N4 出线前转义（transport config `escape`，缺省关闭原样；记录/存档即线上
  字节，replay 不二次转义）→ transport.send（read_timeout_ms 取序列 config，
  None = 传输配置缺省）→ 记 OK/ERROR。stop_on_error=True（缺省）遇 ERROR
  中止 → result=failed；False 记错继续 → 跑完 result=completed。

快照字段是轮询契约（P4 序列页）：
running / result(idle|running|completed|failed|stopped) / sequence_id /
sequence_name / total_steps / current_step(1-based 进行中步) / started_at /
finished_at / stop_requested / error / steps[](逐步 n/step_id/label/
instruction_id/status(OK|ERROR|SKIPPED)/sent/received/rtt_ms/error)。

模块级可变状态均在锁内读写（CPython GIL 下 record 先整备后 append、
snapshot 持锁浅拷贝，逐条记录恒为完整对象）。
"""
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from backend.core import transport
from backend.core.escape import escape_bytes, table_from_config
from backend.core.sequence_plan import apply_plan


class SequenceBusy(Exception):
    """已有序列在运行（路由映射 409）。"""


class _Run:
    def __init__(self, sequence_id: str, sequence_name: str, steps: List[Dict[str, Any]], config: Dict[str, Any]):
        self.sequence_id = sequence_id
        self.sequence_name = sequence_name
        self.steps = steps
        self.config = config
        self.stop = False
        self.running = True
        self.result = "running"
        self.error: Optional[str] = None
        self.current_step: Optional[int] = None
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.finished_at: Optional[str] = None
        self.results: List[Dict[str, Any]] = []


_lock = threading.Lock()
_state: Optional[_Run] = None
# P5 通讯日志钩子（set_log_hook 注入；None = 未注入不落库，reset 一并清）
_log_hook = None


def _idle_snapshot() -> Dict[str, Any]:
    return {
        "running": False,
        "result": "idle",
        "sequence_id": None,
        "sequence_name": None,
        "total_steps": 0,
        "current_step": None,
        "started_at": None,
        "finished_at": None,
        "stop_requested": False,
        "error": None,
        "steps": [],
    }


def snapshot() -> Dict[str, Any]:
    """当前运行态（idle 默认形态）；完成后保留终态到下次 claim 覆盖。"""
    with _lock:
        run = _state
        if run is None:
            return _idle_snapshot()
        return {
            "running": run.running,
            "result": run.result,
            "sequence_id": run.sequence_id,
            "sequence_name": run.sequence_name,
            "total_steps": len(run.steps),
            "current_step": run.current_step,
            "started_at": run.started_at,
            "finished_at": run.finished_at,
            "stop_requested": run.stop,
            "error": run.error,
            "steps": list(run.results),
        }


def is_running() -> bool:
    with _lock:
        return _state is not None and _state.running


def claim(sequence_id: str, sequence_name: str, steps: List[Dict[str, Any]], config: Dict[str, Any]) -> _Run:
    """同步占用运行槽；已有运行 → SequenceBusy（路由 409）。"""
    global _state
    with _lock:
        if _state is not None and _state.running:
            raise SequenceBusy(f"序列运行中：{_state.sequence_name or _state.sequence_id}")
        run = _Run(sequence_id, sequence_name, steps, config)
        _state = run
        return run


def request_stop() -> None:
    """协作式停止：置停止位（idle 无操作，端点恒 200 幂等）。"""
    with _lock:
        if _state is not None and _state.running:
            _state.stop = True


def reset() -> None:
    """清运行态与日志钩子（测试 setUp/tearDown 与 transport.reset 同期调用，防用例间泄漏）。"""
    global _state, _log_hook
    with _lock:
        _state = None
        _log_hook = None


def set_log_hook(fn) -> None:
    """注入 P5 通讯日志写入回调（lifespan 传 log_store.log_hook(SessionLocal)；None = 不落库）。"""
    global _log_hook
    _log_hook = fn


def start(sequence_id: str, sequence_name: str, steps: List[Dict[str, Any]], config: Dict[str, Any]) -> Dict[str, Any]:
    """claim + daemon 线程执行；返回初始快照（SequenceBusy 抛给路由）。"""
    run = claim(sequence_id, sequence_name, steps, config)
    thread = threading.Thread(
        target=execute, args=(run,), daemon=True, name=f"seq-{sequence_id[:8]}"
    )
    thread.start()
    return snapshot()


def _sleep_interruptible(run: _Run, seconds: float) -> bool:
    """分片睡（50ms）；期间收到停止 → 置位并返回 True（调用方标 SKIPPED）。"""
    deadline = time.monotonic() + seconds
    while True:
        if run.stop:
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(0.05, remaining))


def _step_record(step: Dict[str, Any], n: int, status: str) -> Dict[str, Any]:
    return {
        "n": n,
        "step_id": step.get("id") or "",
        "label": step.get("label") or f"step-{n}",
        "instruction_id": step.get("instruction_id") or "",
        "status": status,
        "sent": None,
        "received": None,
        "rtt_ms": None,
        "error": None,
    }


def _skip_remaining(run: _Run, from_n: int) -> None:
    """把尚未执行的步补成 SKIPPED（n = from_n 起，1-based，已有的跳过）。"""
    for index in range(from_n - 1, len(run.steps)):
        if any(record["n"] == index + 1 for record in run.results):
            continue
        run.results.append(_step_record(run.steps[index], index + 1, "SKIPPED"))


def _log_step(step: Dict[str, Any], n: int, record: Dict[str, Any], run: _Run) -> None:
    """P5 通讯日志旁路写入：钩子未注入则跳过；写失败在 safe_log 内吞掉，不反噬执行。"""
    if _log_hook is None:
        return
    # SKIPPED 不经此路（_skip_remaining 直写 results，未发生通讯不落日志）；
    # PLAN 错误 record["sent"] 为空 → 落基础帧（保可回放）。
    payload = record.get("sent") or " ".join(
        f"{b:02X}" for b in (step.get("payload") or b"")
    )
    _log_hook(
        source="sequence",
        status="OK" if record["status"] == "OK" else "ERROR",
        channel=transport.get_config()["mode"].upper(),
        hex_string=payload,
        echo=record.get("received") or "",
        instruction_name=record.get("label") or f"step-{n}",
        instruction_id=record.get("instruction_id") or None,
        sequence_id=run.sequence_id,
        step_order=n,
        rtt_ms=record.get("rtt_ms"),
        error=record.get("error"),
    )


def execute(run: _Run) -> None:
    """阻塞执行 claim 到的槽；任何路径都 finalize（running=False）并留终态。"""
    stop_on_error = bool((run.config or {}).get("stop_on_error", True))
    read_timeout_ms = (run.config or {}).get("read_timeout_ms")
    try:
        for index, step in enumerate(run.steps):
            n = index + 1
            if run.stop:
                _skip_remaining(run, n)
                run.result = "stopped"
                return
            run.current_step = n
            delay_ms = int(step.get("delay_ms") or 0)
            if delay_ms > 0 and _sleep_interruptible(run, delay_ms / 1000):
                _skip_remaining(run, n)
                run.result = "stopped"
                return

            record = _step_record(step, n, "OK")
            started = time.perf_counter()
            try:
                data = apply_plan(step["payload"], step.get("plan"), time.time() * 1000)
                # N4 (G3): 出线前转义 —— 先转义再记 sent/存档（记录即线上字节）
                data = escape_bytes(data, table_from_config(transport.get_config()))
                record["sent"] = " ".join(f"{b:02X}" for b in data)
                response = transport.send(data, read_timeout_ms=read_timeout_ms)
            except ValueError as e:
                record["status"] = "ERROR"
                record["error"] = f"PLAN: {e}"
            except transport.TransportError as e:
                record["status"] = "ERROR"
                record["error"] = f"TRANSPORT: {e}"
            else:
                record["received"] = response.hex().upper()
                record["rtt_ms"] = round((time.perf_counter() - started) * 1000, 2)
            run.results.append(record)
            _log_step(step, n, record, run)

            if record["status"] != "OK" and stop_on_error:
                _skip_remaining(run, n + 1)
                run.result = "failed"
                run.error = record["error"]
                return
        run.result = "completed"
    except Exception as e:  # Runner 级兜底：异常不许静默吞，记入终态
        run.result = "failed"
        run.error = f"RUNNER: {e}"
    finally:
        run.current_step = None
        run.finished_at = datetime.now(timezone.utc).isoformat()
        with _lock:
            run.running = False
