"""CP3 3a (D13 拍板 A): 配方串行编译 —— 第 n 层输出直接喂第 n+1 层 payloads。

核心取巧点（DESIGN_CorePipeline §9 头注）：`build_wrapped` 收与出**都是 hex 字符串**，
第 n 层的输出直接喂第 n+1 层的 `payloads` → `frame_builder.py` 的封装语义零改；
配方是有序数组，**环在结构上不可能存在**，故无需拓扑求值、无需放开 refs 跨树。

阶段载荷口径（§9.2 取甲案）：
- stage 0 的 `payloads` = 内核载荷组（编排页组填洞语义，可多条）；
- stage n≥1 的 `payloads` = 仅 `[前层输出]`，占该层承载槽；
- `start_order` 只作用于 stage 0（请求参数），其后每层从 0 起；
- stage 的 `slot_ids` 归配方所有，**请求的 slot_ids 在配方路径不参与**。

防错（§9.5）：
1. `fit_policy` 缺省 `reject`（`strict_fit=True`，**主动偏离 D3**「默认取现状
   零回归」—— 配方零存量，多层下 append 的溢出字节会被下一层当正常载荷收下）；
2. 每层编译前按当前协议 children 重算 `definition_hash` 与配方记录比对，不符
   → 「配方已失效」warning **不阻断**（D7-A 口径，hash 只在后端算）；
3. 协议缺失 404、`build_wrapped` 语义错误 400（带层号与协议 label）。

消费方：`routers/compile.py::compile_wrapped_frame`（预览）与
`routers/dispatch.py::_apply_wrap`（发送）—— 同一份实现，预览与出线同字节。
"""
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from backend.core import diagnostics as diag
from backend.core.definition_hash import protocol_definition_hash
from backend.core.frame_builder import build_wrapped
from backend.db.models import FrameRecipe, ProtocolTemplate


def load_recipe(db: Session, recipe_id: str) -> FrameRecipe:
    """按 id 取配方，缺失 404（对齐 protocol.py "Protocol not found" 先例）。"""
    recipe = db.query(FrameRecipe).filter(FrameRecipe.id == recipe_id).first()
    if recipe is None:
        raise diag.http(
            404, "Recipe not found",
            "wrap", "RECIPE_NOT_FOUND", target=str(recipe_id), data_sent=False,
        )
    return recipe


def kernel_length(payloads: Optional[List[str]]) -> int:
    """内核组字节数（分层预览的 Δ 基准，§9.4「相对上层的字节差」）。"""
    total = 0
    for payload in payloads or []:
        total += len(str(payload).replace(" ", "")) // 2
    return total


def _compact(hex_text) -> str:
    """hex 归一（去空格/逗号/换行/下划线）——长度与切片计算前统一口径。"""
    text = str(hex_text)
    for ch in (" ", ",", "\n", "\r", "\t", "_"):
        text = text.replace(ch, "")
    return text


def compile_recipe(
    db: Session,
    recipe_id: str,
    payloads: List[str],
    start_order: int = 0,
) -> Dict[str, object]:
    """配方 → 逐层 `build_wrapped` 串行编译（§9.3 编译算法）。

    返回 {hex, total_length, warnings, stages}：`hex`/`total_length` 恒为**最终
    帧**（与单协议路径同形，旧调用方零改）；`stages` 为分层回显
    （index / 协议 / 该层 hex 与总长 / 相对上层 Δ / 该层 warnings /
    当前 definition_hash 与 stale 标记 / LEN·CRC 卡面值）。
    warnings 聚合时带「第 N 层：」前缀，便于操作员定位层。
    """
    recipe = load_recipe(db, recipe_id)
    stages = list(recipe.stages or [])
    if not stages:
        raise diag.http(
            400, "配方没有可编译的阶段",
            "wrap", "RECIPE_EMPTY", target=str(recipe_id), data_sent=False,
        )

    warnings: List[str] = []
    echo: List[Dict[str, object]] = []
    prev_total = kernel_length(payloads)   # Δ 基准：stage 0 之前 = 内核字节数
    frame = ""                             # 上一层输出（stage 0 尚无）

    for index, stage in enumerate(stages):
        protocol = (
            db.query(ProtocolTemplate)
            .filter(ProtocolTemplate.id == stage.get("protocol_id"))
            .first()
        )
        if protocol is None:
            # 层号一并给出：多层配方里「哪层协议被删了」比一句 404 更有用
            raise diag.http(
                404, "Protocol not found",
                "wrap", "WRAP_PROTOCOL_NOT_FOUND",
                target=str(stage.get("protocol_id") or ""),
                layer=index + 1, data_sent=False,
            )

        # ---- hash 比对（D7-A：不符出 warning 不阻断，不回写 DB —— 回写会让
        # 比对失去意义；「回写」发生在 /recipes 保存期）----
        current_hash = protocol_definition_hash(protocol.children)
        recorded = stage.get("definition_hash")
        stale = bool(recorded) and recorded != current_hash

        layer_payloads = payloads if index == 0 else [frame]
        layer_start = start_order if index == 0 else 0
        try:
            out = build_wrapped(
                protocol.children or [],
                layer_payloads,
                slot_ids=stage.get("slot_ids"),
                start_order=layer_start,
                strict_fit=True,   # 配方路径缺省 reject（§9.5-2，主动偏离 D3）
            )
        except ValueError as exc:
            # 层号 + 协议 label 前缀：多层下 400 detail 直接指到出错层（文案不变）
            # DiagError 是 ValueError 子类 → 调用方既有 except ValueError 照常接住，
            # 关心层号的路由用 diag.http_from 把 layer/target 继续往上传。
            message = f"第 {index + 1} 层（{protocol.label}）：{exc}"
            raise diag.DiagError(
                message,
                diag.Diagnostic(
                    stage="wrap",
                    code="WRAP_LAYER_REJECT",
                    message=message,
                    target=str(protocol.id),
                    layer=index + 1,
                    data_sent=False,
                ),
            ) from exc

        layer_warnings: List[str] = list(out.get("warnings") or [])
        if stale:
            layer_warnings.insert(
                0,
                f"配方已失效：{protocol.label} 定义已变更，请重新保存配方",
            )

        warnings.extend([f"第 {index + 1} 层：{w}" for w in layer_warnings])
        frame = out["hex"]
        total = out["total_length"]
        echo.append(
            {
                "index": index,
                "protocol_id": protocol.id,
                "protocol_label": protocol.label,
                "hex": frame,
                "total_length": total,
                "delta_bytes": total - prev_total,
                "warnings": layer_warnings,
                "definition_hash": current_hash,
                "stale": stale,
                "logic": out.get("logic", []),
                # CP3 3c (D6-B): 该层外壳的绝对字节位置（本层帧坐标）
                "shell": out.get("shell") or {"payload_offset": None,
                                              "length": [], "checksum": []},
            }
        )
        prev_total = total

    return {
        "hex": frame,
        "total_length": prev_total,
        "warnings": warnings,
        "stages": echo,
    }


def shell_plan(
    result: Dict[str, object],
    kernel_hex: str,
    recipe_id: str,
    definition_hash: Optional[str] = None,
) -> Dict[str, object]:
    """CP3 3c (D6-B): 编译产物 → `plan.shell`（**最终帧绝对坐标**的逐层区间）。

    几何关系（层 0 = 内核层，最后 = 最外层）：

    - 层 i 的帧 = `head_i` + 内层输出 + `tail_i` → 层 i 在最终帧中的起点
      `S_i = Σ_{j>i} head_j`，最外层 `S_{n-1} = 0`；
    - 内核起点 = `S_0 + head_0 = Σ head_j`（内核整体连续嵌在最内层里）；
    - `layers[i] = {index, offset=S_i, size=该层帧字节数, length[], checksum[]}`
      —— `length`/`checksum` 的 offset 已平移到最终帧，可直接叠在冻结帧上显示。

    单一载荷是前提（序列步骤 = 一条内核帧）：多载荷下第 1 层不连续，
    `i-payload-0` 只能定位第 1 条 → 由路由侧先拒绝。
    """
    stages = list(result.get("stages") or [])
    if not stages:
        raise diag.DiagError(
            "配方没有可编译的阶段",
            diag.Diagnostic(
                stage="wrap", code="RECIPE_EMPTY",
                message="配方没有可编译的阶段", data_sent=False,
            ),
        )

    heads: List[int] = []
    for stage in stages:
        offset = (stage.get("shell") or {}).get("payload_offset")
        if offset is None:
            idx = int(stage.get("index", 0))
            message = f"第 {idx + 1} 层无可用插槽，无法定位内核"
            raise diag.DiagError(
                message,
                diag.Diagnostic(
                    stage="wrap", code="WRAP_SHELL_MISSING",
                    message=message, layer=idx + 1, data_sent=False,
                ),
            )
        heads.append(int(offset))

    starts = [0] * len(stages)
    for i in range(len(stages) - 2, -1, -1):
        starts[i] = starts[i + 1] + heads[i + 1]

    kernel = {
        "offset": starts[0] + heads[0],
        "length": len(_compact(kernel_hex)) // 2,
    }
    layers: List[Dict[str, object]] = []
    for i, stage in enumerate(stages):
        base = starts[i]
        shell = stage.get("shell") or {}
        layers.append({
            "index": i,
            "offset": base,
            "size": int(stage["total_length"]),
            "length": [
                {"offset": base + int(f["offset"]), "byte_length": int(f["byte_length"])}
                for f in shell.get("length") or []
            ],
            "checksum": [
                {"offset": base + int(f["offset"]), "byte_length": int(f["byte_length"])}
                for f in shell.get("checksum") or []
            ],
        })

    out: Dict[str, object] = {"recipe_id": str(recipe_id), "kernel": kernel, "layers": layers}
    if definition_hash:
        out["definition_hash"] = definition_hash
    return out


def stages_fingerprint(stage_hashes) -> Optional[str]:
    """CP3 3c (D15 关联项 2): 配方各层 `definition_hash` 的**复合指纹**。

    序列步骤冻结期把该指纹存进 `sequence_steps.wrap.definition_hash`；读侧
    `current_fingerprint` 按当前协议定义重算比对 → 协议结构变了才亮徽标
    （D7-A：不阻断，冻结帧仍可发）。分隔符取 U+001F 防拼接歧义。
    """
    parts = [str(h) for h in (stage_hashes or []) if h]
    if not parts:
        return None
    import hashlib

    return "sha256:" + hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


def current_fingerprint(db: Session, recipe) -> Optional[str]:
    """按**当前**协议定义重算配方复合指纹（读侧 stale 比对；不编译帧）。

    任一层协议已删除 → None（无法比对，调用方按「已失效」处理）。
    """
    parts: List[str] = []
    for stage in list(recipe.stages or []):
        protocol = (
            db.query(ProtocolTemplate)
            .filter(ProtocolTemplate.id == stage.get("protocol_id"))
            .first()
        )
        if protocol is None:
            return None
        parts.append(protocol_definition_hash(protocol.children))
    return stages_fingerprint(parts)
