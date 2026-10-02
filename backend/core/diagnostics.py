"""关键链路统一诊断（PLAN §8.32）——「失败在哪一层 / 对应哪个字段或步骤 / 是否实际发送了数据」。

四条链路（**组帧 → 发送 → 应答匹配 → 序列执行**）此前各自散落一句 string `detail`：
硬件联调时只看到「Invalid payload: …」，既不知道卡在哪一层，也不知道字节有没有真的
出去。本模块给这些错误补一份**结构化诊断**，与 `detail` 并存、互不替代：

    {"detail": "<原有字符串，逐字不变>", "diagnostic": {stage, code, message, ...}}

**只做加法**（§0 硬约束的诊断侧对偶）：
- `detail` 恒为字符串（`client.js` 与既有测试都按字符串消费），文案一个字不改；
- 非 `DiagHTTPException` 的 `HTTPException` 走 FastAPI 默认 handler，形状不变；
- 成功路径零改动。

诊断字段（值为 None 的键**不输出**，避免空键噪声）：

====== ========= ==========================================================
stage  失败层    plan / encode / escape / wrap / transport / match / spec /
                sequence / param
code   稳定机器码 可检索可断言（如 WRAP_LAYER_REJECT、TRANSPORT_ERROR）
message 人话     与 detail 同文（诊断里也留一份，单看日志即可复现）
target 定位      字段 / 配方 id / 协议 id / 步骤 id / 参数名
layer  封装层    1-based，与「第 N 层」文案与配方 stage 序号一致：1 = stage 0
step   序列步骤  1-based
data_sent 是否已发 完整交给传输层才算 True；被 plan/encode/escape/wrap/spec/
                sequence 拦下 → False；传输抛错 → False（可能已部分写入，
                见 message）；应答匹配失败 → True（帧确实出线了）
byte_count 字节数 尝试发送 / 涉及的帧长
====== ========= ==========================================================

使用方式：
- 路由里直接 `raise http(400, "…", "wrap", "WRAP_REJECTED", data_sent=False)`；
- 领域层抛 `DiagError`（是 **ValueError 子类** → 既有 `except ValueError` 与
  detail 文案完全不变），路由用 `http_from(e, …)` 透出它携带的诊断（含层号）；
- `main.py` 启动时 `diagnostics.install(app)` 注册响应形状。
"""
from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional

from fastapi import HTTPException
from fastapi.responses import JSONResponse

STAGES = (
    "plan",       # 序列计划 / 帧数据准备
    "encode",     # 内核编码、hex 解析
    "escape",     # 转义层
    "wrap",       # 协议/配方封装（含逐层）
    "transport",  # 传输层（连接/写/读）
    "match",      # 应答匹配
    "spec",       # 应答规格解析
    "sequence",   # 序列执行 / 互斥
    "param",      # 请求参数校验
)


@dataclass(frozen=True)
class Diagnostic:
    stage: str
    code: str
    message: str
    target: Optional[str] = None
    layer: Optional[int] = None
    step: Optional[int] = None
    data_sent: Optional[bool] = None
    byte_count: Optional[int] = None

    def __post_init__(self):
        if self.stage not in STAGES:
            raise ValueError(f"未知诊断 stage: {self.stage!r}（可选 {STAGES}）")

    def to_dict(self) -> Dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}


class DiagError(ValueError):
    """带诊断的 ValueError。

    关键点：**继承 ValueError** —— 既有 `except ValueError` 分支、`detail=str(e)`
    文案一概不变；只有关心层号/字段的路由用 `http_from` 把诊断接着往上传。
    """

    def __init__(self, message: str, diagnostic: Diagnostic):
        super().__init__(message)
        self.diag = diagnostic

    @property
    def diagnostic(self) -> Dict[str, Any]:
        return self.diag.to_dict()


class DiagHTTPException(HTTPException):
    """HTTPException 子类：响应体 = 原有 `detail` + 结构化 `diagnostic`。"""

    def __init__(self, status_code: int, detail: str, diagnostic: Diagnostic):
        super().__init__(status_code=status_code, detail=detail)
        self.diagnostic = diagnostic.to_dict()


def http(
    status_code: int,
    detail: str,
    stage: str,
    code: str,
    *,
    target: Optional[str] = None,
    layer: Optional[int] = None,
    step: Optional[int] = None,
    data_sent: Optional[bool] = None,
    byte_count: Optional[int] = None,
) -> DiagHTTPException:
    """路由侧最短写法：message 直接取 detail，保证两份文案同源。"""
    return DiagHTTPException(
        status_code,
        detail,
        Diagnostic(
            stage=stage,
            code=code,
            message=detail,
            target=target,
            layer=layer,
            step=step,
            data_sent=data_sent,
            byte_count=byte_count,
        ),
    )


def http_from(
    exc: BaseException,
    status_code: int,
    detail: str,
    stage: str,
    code: str,
    *,
    target: Optional[str] = None,
    layer: Optional[int] = None,
    step: Optional[int] = None,
    data_sent: Optional[bool] = None,
    byte_count: Optional[int] = None,
) -> DiagHTTPException:
    """把 `except ValueError` 到的异常转成带诊断的 4xx。

    `DiagError`（如逐层封装 reject）**保留自己的诊断**（含层号与定位），
    `detail` 仍是调用方给的原文；普通 ValueError 用调用方给的 stage/code 兜底。
    """
    if isinstance(exc, DiagError):
        return DiagHTTPException(status_code, detail, exc.diag)
    return http(
        status_code,
        detail,
        stage,
        code,
        target=target,
        layer=layer,
        step=step,
        data_sent=data_sent,
        byte_count=byte_count,
    )


def diagnostic_of(exc: BaseException) -> Optional[Dict[str, Any]]:
    """取异常携带的诊断 dict（`DiagError` / `DiagHTTPException` / 已是 dict）。"""
    if isinstance(exc, DiagError):
        return exc.diagnostic
    if isinstance(exc, DiagHTTPException):
        return exc.diagnostic
    diag = getattr(exc, "diagnostic", None)
    if isinstance(diag, dict):
        return diag
    return None


def with_detail(
    exc: BaseException,
    status_code: int,
    detail: str,
    *,
    stage: str = "wrap",
    code: str = "WRAP_REJECTED",
    target: Optional[str] = None,
    step: Optional[int] = None,
    data_sent: Optional[bool] = None,
) -> DiagHTTPException:
    """重写 detail 文案、**保留来源诊断**（层号/协议定位不丢）。

    典型场景：`sequence.py::_freeze_wrap` 把内层 400 包成 `steps[i]: <原文>`，
    层号仍要跟着往上传，否则多层封装下前端只知道「第几步」不知道「哪一层」。
    """
    payload = dict(diagnostic_of(exc) or {})
    payload.setdefault("stage", stage)
    payload.setdefault("code", code)
    payload.setdefault("message", detail)
    payload["message"] = detail
    if target is not None:
        payload.setdefault("target", target)
    if step is not None:
        payload.setdefault("step", step)
    if data_sent is not None:
        payload.setdefault("data_sent", data_sent)
    return DiagHTTPException(status_code, detail, Diagnostic(**payload))


def _handler(_request, exc: DiagHTTPException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "diagnostic": exc.diagnostic},
    )


def install(app) -> None:
    """注册诊断响应形状（只接管 DiagHTTPException，其余 HTTPException 不动）。"""
    app.add_exception_handler(DiagHTTPException, _handler)
