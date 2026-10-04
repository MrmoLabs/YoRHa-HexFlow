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
- CP3 3c (D6-B) 序列封装帧：步骤带 `plan.shell` 时**发送按配方重算** ——
  冻结完整帧切内核 → 打内核补丁 → 内核先转义 → `run.compile_wrap(recipe_id,
  kernel)` 按当前协议定义重算外壳（`compile_wrap` 由路由注入，自开会话）。
  失败记步 `WRAP: {原因}`（与 `PLAN:` / `TRANSPORT:` 三分），不抛到 Runner 级。
  无 shell 的步骤路径**逐字节不变**。
- R26（§8.58）序列级分支：步骤可带 `condition`（受限表达式，见 core/condition.py，
  **无 eval**）→ 求值为假记步 `SKIPPED + error="COND: 条件不成立"`，**判定排在
  delay 之前**（不延时、不建帧、不发、不落日志）；条件非法 / 变量未定义 / 类型
  不可比记步 `ERROR + "COND: {原因}"`（与 `PLAN:` / `WRAP:` / `TRANSPORT:` **四分**，
  诊断 `data_sent=False`），`stop_on_error` 照常生效。求值变量表由**同一序列已执行的
  步**累积（`step.<n>.*` + 应答解码字段的平铺键，见 `_remember`），注入的
  `decode_vars` 只在**存在带条件的步骤**时才被调用 → 无条件序列零解码、
  路径与 R26 之前逐字节相同。

快照字段是轮询契约（P4 序列页）：
running / result(idle|running|completed|failed|stopped) / sequence_id /
sequence_name / total_steps / current_step(1-based 进行中步) / started_at /
finished_at / stop_requested / error / steps[](逐步 n/step_id/label/
instruction_id/status(OK|ERROR|SKIPPED)/sent/received/rtt_ms/error；
ERROR 步额外带 `diagnostic` = {stage, code, message, step, target, data_sent,
[layer], [byte_count]} —— 失败在哪一层、哪一步、字节是否已发出，§8.32)。

模块级可变状态均在锁内读写（CPython GIL 下 record 先整备后 append、
snapshot 持锁浅拷贝，逐条记录恒为完整对象）。
"""
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from backend.core import diagnostics as diag
from backend.core import transport
from backend.core.condition import ConditionError, evaluate_condition
from backend.core.escape import escape_bytes, table_from_config
from backend.core.sequence_plan import apply_plan, core_plan, kernel_slice


class SequenceBusy(Exception):
    """已有序列在运行（路由映射 409）。"""


class WrapError(Exception):
    """CP3 3c (D6-B): 序列封装步出线重算失败（配方/协议缺失、语义错误）。
    独立异常类型 → 记步 `WRAP: {原因}`，与 `PLAN:`（补丁/计划脏数据）、
    `TRANSPORT:`（链路）三分，便于操作员定位层。

    §8.32：可携带来源异常的结构化诊断（配方 reject 的层号/协议定位），
    由 `diag.diagnostic_of` 取用并落到步记录 `diagnostic`。"""

    def __init__(self, message: str, diagnostic: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        if diagnostic:
            self.diagnostic = diagnostic


class _Run:
    def __init__(
        self,
        sequence_id: str,
        sequence_name: str,
        steps: List[Dict[str, Any]],
        config: Dict[str, Any],
        compile_wrap=None,
        decode_vars=None,
    ):
        self.sequence_id = sequence_id
        self.sequence_name = sequence_name
        self.steps = steps
        self.config = config
        # D6-B 发送期「按配方重算外壳」入口（routers/sequence 注入，自开会话；
        # None = 无封装步可用，遇到封装步记步 WRAP 错误）
        self.compile_wrap = compile_wrap
        # R26 条件求值的「应答解码」入口（routers/sequence 注入，自开会话）：
        # (instruction_id, received_hex) -> {字段名: 值}；None = 不解码（无条件
        # 序列恒为这种，见 execute 的 with_context 分支）
        self.decode_vars = decode_vars
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


def claim(
    sequence_id: str,
    sequence_name: str,
    steps: List[Dict[str, Any]],
    config: Dict[str, Any],
    compile_wrap=None,
    decode_vars=None,
) -> _Run:
    """同步占用运行槽；已有运行 → SequenceBusy（路由 409）。"""
    global _state
    with _lock:
        if _state is not None and _state.running:
            raise SequenceBusy(f"序列运行中：{_state.sequence_name or _state.sequence_id}")
        run = _Run(sequence_id, sequence_name, steps, config, compile_wrap, decode_vars)
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


def start(
    sequence_id: str,
    sequence_name: str,
    steps: List[Dict[str, Any]],
    config: Dict[str, Any],
    compile_wrap=None,
    decode_vars=None,
) -> Dict[str, Any]:
    """claim + daemon 线程执行；返回初始快照（SequenceBusy 抛给路由）。"""
    run = claim(sequence_id, sequence_name, steps, config, compile_wrap, decode_vars)
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


def _step_diagnostic(
    exc: BaseException,
    *,
    stage: str,
    code: str,
    n: int,
    step: Dict[str, Any],
    data_sent: bool,
    byte_count: Optional[int] = None,
) -> Dict[str, Any]:
    """错误步 → 结构化诊断（PLAN §8.32：失败在哪一步 / 哪一层 / 字节出没出去）。

    来源异常自带诊断（`DiagError` 层号、`WrapError` 透传的配方定位）就保留，
    否则用调用方给的 stage/code 兜底；`step`（1-based 步号）与 `data_sent`
    恒由本函数补上 —— 任何一条 ERROR 步都必须能回答「第几步、哪层、发了没」。
    """
    base = diag.diagnostic_of(exc)
    payload: Dict[str, Any] = dict(base) if base else {}
    payload.setdefault("stage", stage)
    payload.setdefault("code", code)
    payload.setdefault("message", str(exc))
    payload["step"] = n
    # 定位：来源诊断的具体目标（配方/协议 id）优先，否则落到步 id/标签
    if not payload.get("target"):
        step_target = step.get("id") or step.get("label")
        if step_target:
            payload["target"] = str(step_target)
    payload["data_sent"] = data_sent
    if byte_count is not None:
        payload["byte_count"] = byte_count
    return payload


def _condition_gate(
    condition: str, context: Dict[str, Any], step: Dict[str, Any], n: int
) -> Optional[Dict[str, Any]]:
    """R26: 求一步的执行条件 → `None`（放行）或一条已成形的记录。

    - **求值为真** → None，走原路径（不延时、不建帧、不发 —— 判定在 delay 之前，
      条件不成立的步不白等）；
    - **求值为假** → `SKIPPED` + `COND: 条件不成立`（与「停止后补跳过」的
      `SKIPPED + error 为空` 可区分：操作员看得出是条件挡下的）；
    - **条件本身非法**（语法 / 变量未定义 / 类型不可比，直连改库绕过保存口也拦得住）
      → `ERROR` + `COND: {原因}` + 结构化诊断（`data_sent=False`：字节没出去）——
      与 `PLAN:` / `WRAP:` / `TRANSPORT:` 四分，`stop_on_error` 照常生效。

    **绝不**把异常吞成 False —— 否则配置写错会让步骤被静默跳过。
    """
    try:
        take = evaluate_condition(condition, context)
    except ConditionError as exc:
        record = _step_record(step, n, "ERROR")
        record["error"] = f"COND: {exc}"
        record["diagnostic"] = _step_diagnostic(
            exc, stage="condition", code="CONDITION_REJECTED",
            n=n, step=step, data_sent=False,
        )
        return record
    if take:
        return None
    record = _step_record(step, n, "SKIPPED")
    record["error"] = "COND: 条件不成立"
    return record


def _remember(
    context: Dict[str, Any],
    step: Dict[str, Any],
    n: int,
    record: Dict[str, Any],
    decode_vars=None,
) -> None:
    """R26: 把这一步的结果写进条件变量表（**只在带条件的序列里被调用**）。

    变量键全是**整串精确匹配**的扁平键（`core.condition` 不做点号下钻）：

    - `step.<n>.status`（OK|ERROR|SKIPPED）、`step.<n>.sent` / `.received`
      （去空格大写 hex）、`step.<n>.rtt_ms` —— 没值就不写键（引用到即
      「变量未定义」，比拿到 null 更早暴露条件写错）；
    - 本步应答按宿主指令布局解码出的字段：**平铺键 `<字段名>`（最近一次出现者胜）**
      与**定点键 `step.<n>.<字段名>`** 并存 —— 跨步同名字段既能看最新值、
      也能回看第几步（例 A 的 `fw_version >= 0x1200` 就走平铺键）。

    解码失败 / 无布局 / 注入的回调炸了 → 什么都不加：**条件上下文绝不反噬执行**。
    """
    prefix = f"step.{n}."
    context[prefix + "status"] = record["status"]
    if record.get("sent") is not None:
        context[prefix + "sent"] = str(record["sent"]).replace(" ", "")
    if record.get("received") is not None:
        context[prefix + "received"] = str(record["received"]).replace(" ", "")
    if record.get("rtt_ms") is not None:
        context[prefix + "rtt_ms"] = record["rtt_ms"]
    if decode_vars is None or record["status"] != "OK":
        return
    received = record.get("received")
    instruction_id = step.get("instruction_id")
    if not received or not instruction_id:
        return
    try:
        flat = decode_vars(str(instruction_id), str(received)) or {}
    except Exception:  # noqa: BLE001 —— 解码失败不得反噬执行
        return
    for name, value in dict(flat).items():
        key = str(name)
        if not key:
            continue
        context[key] = value
        context[prefix + key] = value


def _skip_remaining(run: _Run, from_n: int) -> None:
    """把尚未执行的步补成 SKIPPED（n = from_n 起，1-based，已有的跳过）。

    停止位 / `stop_on_error` 中止产生的 SKIPPED **error 为空** —— 与 R26 条件挡下的
    `SKIPPED + "COND: 条件不成立"` 可区分（前端 tooltip 直接看 error）。
    """
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


def _frame_for_send(step: Dict[str, Any], run: _Run, now_ms: float) -> bytes:
    """步帧发送前重算 → **线上字节**（转义口径与记录一致，replay 不二次转义）。

    - 无 `plan.shell`（存量与未选配方步骤）：`apply_plan` → 整帧转义，**逐字节
      与 3c 之前一致**（§0 硬约束的序列侧对偶）。
    - 有 `plan.shell`（D6-B 序列封装帧）：冻结完整帧切出内核 → 打内核补丁
      （TIME/COUNTER/CRC 相对内核坐标）→ **内核先转义** → `compile_wrap` 按配方
      现算外壳（LEN/CRC 由编排器按**当前协议定义**重算）。层位与 dispatch 的
      「先转内核再套壳」（N4/D13）逐字一致；壳内 length/checksum 因此按线上字节计。
    """
    plan = step.get("plan")
    payload = step["payload"]
    if not (plan or {}).get("shell"):
        data = apply_plan(payload, plan, now_ms)
        return escape_bytes(data, table_from_config(transport.get_config()))

    shell = plan["shell"]
    table = table_from_config(transport.get_config())
    kernel = apply_plan(kernel_slice(payload, plan), core_plan(plan), now_ms)
    kernel = escape_bytes(kernel, table)
    if run.compile_wrap is None:
        raise WrapError("未提供配方编译入口（无法重算外壳）")
    recipe_id = str(shell.get("recipe_id") or "")
    try:
        full = run.compile_wrap(recipe_id, kernel.hex().upper())
    except Exception as e:  # 配方/协议被删、fit reject、无插槽 …
        # §8.32: 来源异常若带诊断（层号/协议定位），跟着 WrapError 一起往上传
        raise WrapError(
            str(getattr(e, "detail", None) or e), diag.diagnostic_of(e)
        ) from e
    try:
        return bytes.fromhex(str(full).replace(" ", "").replace("\n", ""))
    except ValueError as e:
        raise WrapError(f"配方产物不是合法 hex：{e}") from e


def execute(run: _Run) -> None:
    """阻塞执行 claim 到的槽；任何路径都 finalize（running=False）并留终态。"""
    stop_on_error = bool((run.config or {}).get("stop_on_error", True))
    read_timeout_ms = (run.config or {}).get("read_timeout_ms")
    # R26（§8.58）条件上下文：**只有带条件的序列才建这张表** —— 无条件序列
    # （存量全部）零解码、零额外状态，执行路径与 R26 之前逐字节相同。
    context: Dict[str, Any] = {}
    with_context = any(
        str(step.get("condition") or "").strip() for step in run.steps
    )
    try:
        for index, step in enumerate(run.steps):
            n = index + 1
            if run.stop:
                _skip_remaining(run, n)
                run.result = "stopped"
                return
            run.current_step = n

            # R26 序列级分支：条件判定排在 delay 之前 —— 被条件挡下的步不延时、
            # 不建帧、不发、不落日志；条件本身非法则记步 COND: 错误（四分之一）。
            condition = str(step.get("condition") or "").strip()
            if condition:
                gate = _condition_gate(condition, context, step, n)
                if gate is not None:
                    run.results.append(gate)
                    _remember(context, step, n, gate, run.decode_vars)
                    if gate["status"] == "ERROR":
                        _log_step(step, n, gate, run)
                        if stop_on_error:
                            _skip_remaining(run, n + 1)
                            run.result = "failed"
                            run.error = gate["error"]
                            return
                    continue

            delay_ms = int(step.get("delay_ms") or 0)
            if delay_ms > 0 and _sleep_interruptible(run, delay_ms / 1000):
                _skip_remaining(run, n)
                run.result = "stopped"
                return

            record = _step_record(step, n, "OK")
            started = time.perf_counter()
            try:
                # D6-B: 无 shell = 现状（补丁 → 整帧转义）；有 shell = 切内核 →
                # 打内核补丁 → 内核先转义 → 按配方套外壳（见 _frame_for_send）
                data = _frame_for_send(step, run, time.time() * 1000)
                # N4 (G3): 出线前转义 —— 先转义再记 sent/存档（记录即线上字节）
                record["sent"] = " ".join(f"{b:02X}" for b in data)
                response = transport.send(data, read_timeout_ms=read_timeout_ms)
            except ValueError as e:
                record["status"] = "ERROR"
                record["error"] = f"PLAN: {e}"
                record["diagnostic"] = _step_diagnostic(
                    e, stage="plan", code="PLAN_REJECTED",
                    n=n, step=step, data_sent=False,
                )
            except WrapError as e:
                record["status"] = "ERROR"
                record["error"] = f"WRAP: {e}"
                record["diagnostic"] = _step_diagnostic(
                    e, stage="wrap", code="WRAP_REJECTED",
                    n=n, step=step, data_sent=False,
                )
            except transport.TransportError as e:
                record["status"] = "ERROR"
                record["error"] = f"TRANSPORT: {e}"
                record["diagnostic"] = _step_diagnostic(
                    e, stage="transport", code="TRANSPORT_ERROR",
                    n=n, step=step, data_sent=False, byte_count=len(data),
                )
            else:
                record["received"] = response.hex().upper()
                record["rtt_ms"] = round((time.perf_counter() - started) * 1000, 2)
            run.results.append(record)
            _log_step(step, n, record, run)
            if with_context:
                _remember(context, step, n, record, run.decode_vars)

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
