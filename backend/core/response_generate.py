"""CP3 3d (D5-A × D15-A): 协议 → response_spec「据此生成」。

设计依据（DESIGN_Decisions D5 + D15 实施注 / DESIGN_CorePipeline §7 批次三 3d）：
D5 拍板「协议页据此生成 response_spec」，映射 `fixed→echo_header / length→length /
checksum→checksum`，手工规则保留为增量覆盖（生成后仍可改，改完落库）。
**按 D15-A 实施**：**按配方每层各执行一次**产出 `stages[0..n-1]`（index 0 =
最内层，与 frame_recipes.stages / plan.shell.layers 同序），`response_match` 按
`stages` **逆序解包**逐层跑五要素；**无配方 = 单层退化**（不写 `stages` 键，走
存量单帧路径，存量零改）。**不得按 D5 原字面的单层生成实现**。

单层五要素映射（生成口径）：
- `echo_header_bytes` = 文档序最前的**连续 fixed 叶子**字节数 —— 帧头回显；
- `length`（首个 length 叶子，须位于插槽前，否则无法静态定位）：
  `offset` = 叶子在本层帧内的绝对位置、`byte_length` = 叶子字节数、
  `offset_val` = A - head - trailer（A = pc.offset + 非插槽 refs 字节和；
  refs 含插槽时 `declared = 载荷 + A`，而 `len(帧) = head + 载荷 + trailer`，
  故差值为常数）—— refs 只圈非插槽块且协议**有**插槽时载荷长度不参与，无法
  表成常数 → 跳过并记 warning（D5「手工规则保留为增量覆盖」）；
- `checksum`（首个 checksum 叶子，须位于插槽前）：`algo` 走 frame_builder 同
  一张 BACKEND_ALGO 映射；span 两种可静态表达的口径 —— refs 只圈插槽 →
  `span_start=head` + `span_end_pad=trailer`（载荷区），refs 恰为全部叶子
  （除自身）→ 整帧；其余口径跳过 + warning；
- `unpack = {head, trailer}`：`head` = 插槽前字节和、`trailer` = 插槽后字节和
  （仅分层时需要，单层退化不写）。

所有「跳过 + warning」都是**降级而非失败**：生成结果仍是一份合法可存的规格，
只是少了那一要素 —— 协议结构五花八门，宁可少判也不误判（D5-A：不阻断）。

出处指纹（D7-A）：生成期按各层 `protocol_definition_hash` 复合记进
`response_specs.definition_hash`（`recipe_compile.stages_fingerprint` 口径，
只在后端算），读侧重算比对 → 「应答规格已失效」徽标**不阻断**。
"""

from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from backend.core.definition_hash import protocol_definition_hash
from backend.core.frame_builder import BACKEND_ALGO
from backend.core.recipe_compile import stages_fingerprint
from backend.core.response_match import ALGO_FIELD_WIDTH, normalize_spec
from backend.db.models import FrameRecipe, Instruction, ProtocolBinding, ProtocolTemplate

# 与 recipe_api.MAX_RECIPE_STAGES 同值（镜像 response_match.MAX_STAGES）。
MAX_STAGES = 4

# 无法静态解析时统一走这两类降级（文案给 UI 的「生成结果」面板用）。
_SKIP_RANGE = "length/checksum 用了 target_start_id/target_end_id 区间模式，静态无法解析"


class _Dangling(Exception):
    """refs 悬空（找不到目标节点）。"""


def _emit_len(node: Dict[str, Any]) -> int:
    """叶子在帧内的字节数；容器（无子的 container / ARRAY_GROUP）不发射 → 0。"""
    if _leaf_type(node) == "container":
        return 0
    bl = node.get("byte_length")
    if not isinstance(bl, (int, float)) or isinstance(bl, bool):
        bl = node.get("byte_len")
    if not isinstance(bl, (int, float)) or isinstance(bl, bool):
        return 0
    return int(bl) if bl == bl else 0  # NaN self-unequal


def _leaf_type(node: Dict[str, Any]) -> str:
    """镜像 frame_builder._to_blocks 的类型推断（op_code 兜底）。"""
    ntype = node.get("type")
    if ntype:
        return ntype
    op = str(node.get("op_code") or "").upper()
    if op == "LENGTH_CALC":
        return "length"
    if op == "CHECKSUM_CRC":
        return "checksum"
    if op == "ARRAY_GROUP":
        return "container"
    return "fixed"


def _flatten_leaves(children: Any, out: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """协议树 → 文档序叶子（容器原地展开、禁用块跳过、slot 恒为叶子）。

    口径对齐 frame_builder._to_blocks：`children` 空/缺 → 该节点是叶子；
    禁用块（is_enabled is False）不发射字节 → 不参与几何计算。
    """
    if out is None:
        out = []
    for node in children or []:
        if not isinstance(node, dict) or node.get("is_enabled") is False:
            continue
        if node.get("type") == "slot":
            out.append(node)
            continue
        kids = node.get("children")
        if kids:
            _flatten_leaves(kids, out)
        else:
            out.append(node)
    return out


def _index_nodes(nodes: Any, by_id: Dict[Any, Dict[str, Any]]) -> None:
    """全林索引（pre-order、首见胜出）—— 镜像 frame_builder._index_nodes。"""
    for n in nodes or []:
        if isinstance(n, dict) and n.get("id") is not None and n["id"] not in by_id:
            by_id[n["id"]] = n
        if isinstance(n, dict):
            _index_nodes(n.get("children"), by_id)


def _ref_leaf_ids(refs: List[Any], by_id: Dict[Any, Dict[str, Any]]) -> Optional[List[str]]:
    """pc.refs（可含容器）→ 叶子 id 列表；任一悬空 → None（降级跳过）。

    镜像 frame_builder._build_logic_config 的 expand：容器 ref 展开为其子树叶子、
    悬空丢弃 —— 此处悬空**不静默丢**而返回 None，因为生成期丢一个引用会让
    offset_val 算错（比少生成一要素更糟）。
    """
    out: List[str] = []

    def walk(ref: Any, depth: int) -> None:
        if depth > 16:
            raise _Dangling
        target = by_id.get(ref)
        if target is None:
            raise _Dangling
        kids = target.get("children") or []
        if kids:
            for child in kids:
                walk(child.get("id"), depth + 1)
        else:
            out.append(ref)

    try:
        for ref in refs:
            walk(ref, 0)
    except _Dangling:
        return None
    return out


def _pc_int(pc: Dict[str, Any], key: str) -> int:
    """pc 数值键 → int（缺失/非有限值 → 0，镜像 LengthHandler 的 offset 口径）。"""
    value = pc.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value) if float(value) == float(value) else 0


def _geometry(children: Any) -> Dict[str, Any]:
    """本层帧几何：叶子序、插槽位、head/trailer、逐叶子绝对位置。"""
    leaves = _flatten_leaves(children)
    slot_idx = next(
        (i for i, n in enumerate(leaves) if _leaf_type(n) == "slot"), None
    )
    bls = [_emit_len(n) for n in leaves]
    if slot_idx is None:
        # 无插槽（协议不承载内层）：整帧即「头」，没有可剥的内层。
        head, trailer = sum(bls), 0
    else:
        head = sum(bls[:slot_idx])
        trailer = sum(bls[slot_idx + 1 :])

    positions: List[Optional[int]] = []
    running = 0
    known = True
    for i, node in enumerate(leaves):
        positions.append(running if known else None)
        if _leaf_type(node) == "slot":
            known = False  # 插槽后偏移取决于载荷长度 → 静态不可知
        elif known:
            running += bls[i]

    echo_header = 0
    for node in leaves:
        if _leaf_type(node) == "fixed":
            echo_header += _emit_len(node)
        else:
            break

    by_id: Dict[Any, Dict[str, Any]] = {}
    _index_nodes(children, by_id)
    return {
        "leaves": leaves,
        "bls": bls,
        "slot_idx": slot_idx,
        "head": head,
        "trailer": trailer,
        "positions": positions,
        "echo_header": echo_header,
        "by_id": by_id,
    }


def _length_element(geo: Dict[str, Any], warnings: List[str], where: str) -> Optional[Dict[str, Any]]:
    leaves = geo["leaves"]
    idx = next((i for i, n in enumerate(leaves) if _leaf_type(n) == "length"), None)
    if idx is None:
        return None
    node = leaves[idx]
    bl = _emit_len(node)
    if not 1 <= bl <= 4:
        warnings.append(f"{where} length 块字节数 {bl} 超出 1..4 → 未生成 length")
        return None
    position = _field_position(geo, idx, "length", warnings, where)
    if position is None:
        return None
    pc = node.get("parameter_config")
    pc = pc if isinstance(pc, dict) else {}
    refs = pc.get("refs")
    if not isinstance(refs, list):
        warnings.append(f"{where} {_SKIP_RANGE}（length refs 缺失）→ 未生成 length")
        return None
    leaf_ids = _ref_leaf_ids(refs, geo["by_id"])
    if leaf_ids is None:
        warnings.append(f"{where} length refs 悬空 → 未生成 length")
        return None
    base = _pc_int(pc, "offset")
    slot_in_refs = False
    payload_sum = 0
    for leaf_id in leaf_ids:
        target = geo["by_id"].get(leaf_id)
        if target is None or target.get("is_enabled") is False:
            continue
        if _leaf_type(target) == "slot":
            slot_in_refs = True
        else:
            payload_sum += _emit_len(target)
    if not slot_in_refs and geo["slot_idx"] is not None:
        warnings.append(
            f"{where} length refs 不含插槽，声明值不含载荷而帧长含载荷 → offset_val 非常数，未生成 length"
        )
        return None
    # declared = k*载荷 + (refs 非插槽和 + pc.offset)；len(帧) = head + k*载荷 + trailer
    # → offset_val = 基准 - head - trailer（k=0 且无插槽时载荷为 0，同式成立）。
    offset_val = (base + payload_sum) - geo["head"] - geo["trailer"]
    if not -4096 <= offset_val <= 4096:
        warnings.append(f"{where} length offset_val={offset_val} 超出 ±4096 → 未生成 length")
        return None
    # R21（长度域 BE/LE）：出线 length 卡设了小端时，生成的回显规则必须跟着用
    # 小端 —— 否则「出线反转、收侧按大端比」必然不匹配（收侧 _normalize_length
    # 的 VALID_BYTE_ORDERS 本就支持两值，此处只是把声明补上）。枚举外 → 回大端。
    order = str(pc.get("byte_order") or "").strip().lower()
    out = {
        "byte_length": bl,
        "offset_val": offset_val,
        "byte_order": "little" if order == "little" else "big",
    }
    out.update(position)
    return out


def _field_position(
    geo: Dict[str, Any], idx: int, kind: str, warnings: List[str], where: str
) -> Optional[Dict[str, int]]:
    """字段起点的静态定位：插槽前 → 绝对 offset；插槽后 → 距帧尾字节数。

    插槽**之后**才可能出现 from_end（绝对偏移取决于载荷长度），且其后不得再有
    第二个插槽（否则距帧尾的差里又混进一个变长）—— 都不可定位就降级跳过 + warning。
    """
    offset = geo["positions"][idx]
    if offset is not None:
        return {"offset": offset}
    if any(_leaf_type(n) == "slot" for n in geo["leaves"][idx + 1 :]):
        warnings.append(f"{where} {kind} 块之后仍有插槽，位置无法静态定位 → 未生成 {kind}")
        return None
    # len(帧) - 字段起点 = 从该字段起（含自身）到帧尾的静态字节数。
    return {"offset_from_end": sum(geo["bls"][idx:])}


def _checksum_element(geo: Dict[str, Any], warnings: List[str], where: str) -> Optional[Dict[str, Any]]:
    leaves = geo["leaves"]
    idx = next((i for i, n in enumerate(leaves) if _leaf_type(n) == "checksum"), None)
    if idx is None:
        return None
    node = leaves[idx]
    bl = _emit_len(node)
    if not 1 <= bl <= 4:
        warnings.append(f"{where} checksum 块字节数 {bl} 超出 1..4 → 未生成 checksum")
        return None
    position = _field_position(geo, idx, "checksum", warnings, where)
    if position is None:
        return None
    pc = node.get("parameter_config")
    pc = pc if isinstance(pc, dict) else {}
    algo = BACKEND_ALGO.get(pc.get("algorithm"), "crc16_modbus")
    if algo == "crc16_modbus" and bl != 2:
        warnings.append(f"{where} crc16_modbus 校验字段须 2 字节（实为 {bl}）→ 未生成 checksum")
        return None
    # R22 (§8.52 排期 · CRC 多算法): 固定宽算法（crc16_ccitt=2 / crc32=4 / lrc=1）
    # 宽度不足 → 出线值放不进字段（帧会变长），生成出来也判不了，与 crc16_modbus
    # 同口径弃生成 + 警告；宽度更宽（零填充）则放行，出线与收侧同形。
    required = ALGO_FIELD_WIDTH.get(algo)
    if required is not None and bl < required:
        warnings.append(f"{where} {algo} 校验字段须 ≥ {required} 字节（实为 {bl}）→ 未生成 checksum")
        return None
    if _pc_int(pc, "offset") != 0:
        warnings.append(f"{where} checksum 带非零 offset，规格无法表达 → 未生成 checksum")
        return None
    refs = pc.get("refs")
    if not isinstance(refs, list):
        warnings.append(f"{where} {_SKIP_RANGE}（checksum refs 缺失）→ 未生成 checksum")
        return None
    leaf_ids = _ref_leaf_ids(refs, geo["by_id"])
    if leaf_ids is None:
        warnings.append(f"{where} checksum refs 悬空 → 未生成 checksum")
        return None
    slot = (
        leaves[geo["slot_idx"]] if geo["slot_idx"] is not None else None
    )
    slot_id = slot.get("id") if slot is not None else None
    all_ids = {n.get("id") for n in leaves if n.get("id") is not None}
    ref_set = set(leaf_ids)
    if slot_id is not None and ref_set == {slot_id}:
        # refs 只圈载荷 → span = [head, 帧尾 - trailer)（span 末端用 pad 表达）
        span_start, span_end, pad = geo["head"], None, geo["trailer"]
    elif all_ids - {node.get("id")} and ref_set == all_ids - {node.get("id")}:
        # refs 恰为本层全部叶子（除自身）→ 整帧反算（_checksum_span 恒排除字段自身）
        span_start, span_end, pad = 0, None, 0
    else:
        warnings.append(f"{where} checksum refs 既非「只圈载荷」也非「整层全部」→ 未生成 checksum")
        return None
    out = {
        "algo": algo,
        "field_byte_length": bl,
        "span_start": span_start,
        "span_end": span_end,
        "byte_order": "big",
        "span_end_pad": pad,
    }
    # position 用的是统一键名 offset / offset_from_end，落表改字段名。
    if "offset_from_end" in position:
        out["field_offset_from_end"] = position["offset_from_end"]
    else:
        out["field_offset"] = position["offset"]
    return out


def layer_stage_spec(children: Any, *, where: str = "", warnings: Optional[List[str]] = None) -> Dict[str, Any]:
    """**按层**执行一次 D5 映射（协议 children → 该层五要素 + unpack）。纯函数、无 IO。"""
    warnings = warnings if warnings is not None else []
    geo = _geometry(children)
    return {
        "echo_header_bytes": geo["echo_header"],
        "length": _length_element(geo, warnings, where),
        "checksum": _checksum_element(geo, warnings, where),
        "unpack": {"head": geo["head"], "trailer": geo["trailer"]},
    }


def build_spec(layers: List[Dict[str, Any]]) -> Tuple[Dict[str, Any], List[str]]:
    """层链 → 完整规格。`layers[0]` = 最内层；**1 层 = 单层退化**（不写 stages 键）。

    返回 (spec, warnings)：spec 已按 normalize_spec 的键集成形（调用方再归一化）。
    """
    warnings: List[str] = []
    if not layers:
        raise ValueError("无可生成的层（指令无默认协议且无默认配方）")
    if len(layers) > MAX_STAGES:
        raise ValueError(f"层链最多 {MAX_STAGES} 层")

    stage_specs = [
        layer_stage_spec(
            layer["children"],
            where=f"[层{i} {layer.get('label') or layer.get('protocol_id')}]",
            warnings=warnings,
        )
        for i, layer in enumerate(layers)
    ]
    if len(stage_specs) == 1:
        only = stage_specs[0]
        # 单层退化：不写 stages 键 → response_match 走存量单帧路径（存量零改），
        # unpack 也不需要（没有内层可剥）。
        return (
            {
                "mode": "rules",
                "echo_header_bytes": only["echo_header_bytes"],
                "length": only["length"],
                "checksum": only["checksum"],
            },
            warnings,
        )
    return (
        {
            "mode": "rules",
            "stages": [
                {
                    "prefix": "",
                    "suffix": "",
                    "echo_header_bytes": s["echo_header_bytes"],
                    "length": s["length"],
                    "checksum": s["checksum"],
                    "unpack": s["unpack"],
                }
                for s in stage_specs
            ],
        },
        warnings,
    )


# ---- 层链解析（DB 读侧）----


def _protocol_children(db: Session, protocol_id: Any, where: str) -> Dict[str, Any]:
    protocol = (
        db.query(ProtocolTemplate).filter(ProtocolTemplate.id == protocol_id).first()
        if protocol_id
        else None
    )
    if protocol is None:
        raise ValueError(f"{where} 引用的协议不存在或已被删除")
    return {
        "protocol_id": protocol.id,
        "label": protocol.label,
        "children": protocol.children or [],
    }


def resolve_layers(db: Session, instruction_id: str) -> List[Dict[str, Any]]:
    """指令的分层链：**默认配方 → 每层各一**（index 0 = 最内层）；无配方 → 默认协议单层。

    镜像加工页降级链（默认配方 / 默认协议 / 裸发）—— 裸发没有协议可映射，故
    两无则报错（生成动作本身必须有协议作输入）。
    """
    instruction = (
        db.query(Instruction).filter(Instruction.id == instruction_id).first()
    )
    if instruction is None:
        raise LookupError("指令不存在")
    if instruction.default_recipe_id:
        recipe = (
            db.query(FrameRecipe)
            .filter(FrameRecipe.id == instruction.default_recipe_id)
            .first()
        )
        if recipe is None:
            raise ValueError("该指令的默认封装配方已被删除，请先换配方或清空默认配方")
        stages = list(recipe.stages or [])
        if not stages:
            raise ValueError("默认封装配方没有任何阶段")
        if len(stages) > MAX_STAGES:
            raise ValueError(f"默认封装配方超过 {MAX_STAGES} 层")
        layers = []
        for i, stage in enumerate(stages):
            if not isinstance(stage, dict):
                raise ValueError(f"配方第 {i} 层结构非法")
            layers.append(
                _protocol_children(
                    db, stage.get("protocol_id"), f"配方第 {i} 层"
                )
            )
        return layers

    binding = (
        db.query(ProtocolBinding)
        .filter(
            ProtocolBinding.instruction_id == instruction_id,
            ProtocolBinding.is_default == 1,
        )
        .first()
    )
    if binding is None:
        raise ValueError("该指令既无默认封装配方也无默认协议，无法据此生成")
    return [_protocol_children(db, binding.protocol_id, "默认协议绑定")]


def chain_fingerprint(db: Session, instruction_id: str) -> Optional[str]:
    """当前分层链的复合出处指纹（D7-A 比对基准）；链无法解析 → None。"""
    try:
        layers = resolve_layers(db, instruction_id)
    except (LookupError, ValueError):
        return None
    return stages_fingerprint(
        [protocol_definition_hash(layer["children"]) for layer in layers]
    )


def generate(db: Session, instruction_id: str) -> Dict[str, Any]:
    """执行「据此生成」：解析层链 → 按层映射 → 归一化 + 记出处指纹。

    返回 {spec, layers, warnings, definition_hash}；spec 已 normalize_spec 归一
    （路由层映射 400）。layers 供 UI 回显「本指令几层、每层生成了什么」。
    """
    layers = resolve_layers(db, instruction_id)
    raw_spec, warnings = build_spec(layers)
    # 归一化即校验（非法 → ValueError → 路由 400）；同时保证入库形态与
    # dispatch 读侧 normalize 同口径（SSOT 同一入口，P2 纪律）。
    spec = normalize_spec(raw_spec)
    fingerprint = stages_fingerprint(
        [protocol_definition_hash(layer["children"]) for layer in layers]
    )
    return {
        "spec": spec,
        "layers": layers,
        "warnings": warnings,
        "definition_hash": fingerprint,
    }
