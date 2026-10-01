"""CP3 3a (D7-A 提前 + D13): 协议结构指纹 `definition_hash` —— **只在后端算**。

设计依据（DESIGN_CorePipeline §9.5 第 1 条 / DESIGN_Decisions D7 · D13）：
配方是**跨协议依赖**，子协议一改、下层帧静默变。故配方保存与编译时由后端按该层
协议的结构算指纹并比对，不符 → 「配方已失效」**warning 不阻断**（D7-A 口径）。
hash 只在后端算（`frame_builder` 权威、加工页预览也走后端），前端只比对字符串
—— 免去 D7 原担心的「双端同构」成本。

指纹口径（实施注，2026-10-01）：
- **输入 = 协议 `children` 子树**（决定出帧字节的全部结构：块类型 / 定长 hex /
  refs / fit_policy / 位段 / repeat 等）；`label`、`description` 属展示字段，
  改名不该触发失效徽标。
- **规范化 JSON**：`sort_keys=True` + 紧凑分隔符 + `ensure_ascii=False` → 同一
  结构在任何写入顺序下都得同一串（JSON 列的键序不参与）。
- 形如 `sha256:<64 hex>`（§9.1 示例形态）。
"""
import hashlib
import json
from typing import Any


def protocol_definition_hash(children: Any) -> str:
    """协议 `children`（children JSON 列）→ `sha256:<hex>` 结构指纹。

    纯函数、无 IO —— 单测直测。非 JSON 原生值（协议列不该有）走 `default=str`
    兜底，避免把一次脏数据放大成 500。
    """
    canonical = json.dumps(
        children if children is not None else [],
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"
