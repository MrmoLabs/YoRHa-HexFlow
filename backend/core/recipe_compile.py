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

from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.core.definition_hash import protocol_definition_hash
from backend.core.frame_builder import build_wrapped
from backend.db.models import FrameRecipe, ProtocolTemplate


def load_recipe(db: Session, recipe_id: str) -> FrameRecipe:
    """按 id 取配方，缺失 404（对齐 protocol.py "Protocol not found" 先例）。"""
    recipe = db.query(FrameRecipe).filter(FrameRecipe.id == recipe_id).first()
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return recipe


def kernel_length(payloads: Optional[List[str]]) -> int:
    """内核组字节数（分层预览的 Δ 基准，§9.4「相对上层的字节差」）。"""
    total = 0
    for payload in payloads or []:
        total += len(str(payload).replace(" ", "")) // 2
    return total


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
        raise HTTPException(status_code=400, detail="配方没有可编译的阶段")

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
            raise HTTPException(status_code=404, detail="Protocol not found")

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
            # 层号 + 协议 label 前缀：多层下 400 detail 直接指到出错层
            raise ValueError(f"第 {index + 1} 层（{protocol.label}）：{exc}")

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
            }
        )
        prev_total = total

    return {
        "hex": frame,
        "total_length": prev_total,
        "warnings": warnings,
        "stages": echo,
    }
