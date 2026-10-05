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
from backend.core.framing import DEFAULT_LENGTH_ENCODING, normalize_encoding, terminator_of
from backend.core.frame_builder import BACKEND_ALGO, build_wrapped
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


def _is_cobs(node: Any) -> bool:
    """R28（§8.60）：组帧元素 `cobs` 判定（镜像 frame_builder._to_blocks 的类型推断
    —— cobs 恒有显式 type，op_code 兜底轮不到它）。"""
    return isinstance(node, dict) and _leaf_type(node) == "cobs"


def _subtree_has_slot(node: Dict[str, Any]) -> bool:
    """子树里是否有**启用**的插槽（含槽 → 该层剥层要走 `unpack.mode=cobs`）。"""
    for child in node.get("children") or []:
        if not isinstance(child, dict) or child.get("is_enabled") is False:
            continue
        if _leaf_type(child) == "slot" or _subtree_has_slot(child):
            return True
    return False


def _slot_path(children: Any) -> Optional[List[Dict[str, Any]]]:
    """文档序**首个**插槽的祖先链（含自身）；无插槽 → None。口径镜像 `_flatten_leaves`。

    用对象身份记链（协议 dict 节点无须有 id），供「插槽是否被 COBS 包住 / 嵌套几层」
    的判定用 —— 这决定 `unpack` 走 slice 还是 cobs、以及几何可不可静态表达。
    """
    for node in children or []:
        if not isinstance(node, dict) or node.get("is_enabled") is False:
            continue
        if _leaf_type(node) == "slot":
            return [node]
        kids = node.get("children")
        if kids:
            hit = _slot_path(kids)
            if hit:
                return [node] + hit
    return None


def _deep_walk(nodes: Any, visit) -> None:
    """深度优先访问子树每个启用节点（含容器内、嵌套 cobs 内）。"""
    for node in nodes or []:
        if not isinstance(node, dict) or node.get("is_enabled") is False:
            continue
        visit(node)
        _deep_walk(node.get("children"), visit)


def _cobs_wire(node: Dict[str, Any]) -> Optional[int]:
    """slot-free COBS 子树的**出线**字节数（含定界字节）；静态不可解析 → None。

    走 `build_wrapped` 同一编译口而不复刻发射规则（码字节 / 满块 / 定界都在里面，
    改一必改二的前提不破）。两条会让宽度变成假数的前置拦截：
    - 子树内 length/checksum 的 refs 越出本子树（典型：引用插槽）→ 值依赖组外字节，
      空载荷下编出来的宽度是错的 → None（宁可不生成也不误判）；
    - refs 缺失 / 区间模式 → 值本身不可静态解析 → None。
    编译抛错（非法 hex 等）同样归 None，由调用方降级。
    """
    inner_ids: set = set()
    logic_nodes: List[Dict[str, Any]] = []
    _deep_walk([node], lambda n: (inner_ids.add(n.get("id")), logic_nodes.append(n)))
    for n in logic_nodes:
        if _leaf_type(n) not in ("length", "checksum"):
            continue
        pc = n.get("parameter_config")
        pc = pc if isinstance(pc, dict) else {}
        refs = pc.get("refs")
        if not isinstance(refs, list):
            return None
        by_id: Dict[Any, Dict[str, Any]] = {}
        _index_nodes([node], by_id)
        for ref in refs:
            target = by_id.get(ref)
            if target is None or target.get("id") not in inner_ids:
                return None       # 引用越出本子树 → 值依赖组外字节
            if _leaf_type(target) == "slot":
                return None
    try:
        return int(build_wrapped([node], [])["total_length"])
    except Exception:  # noqa: BLE001 —— 静态不可知一律降级，别把生成口炸成 500
        return None


def _node_width(node: Dict[str, Any]) -> Optional[int]:
    """叶子在帧内的字节数；COBS 单元按**出线**字节量（码字节 + 定界不在逻辑和里）。

    None = 出线宽度不可静态解析（见 `_cobs_wire`），调用方必须当「未知」而不是 0。
    """
    if _is_cobs(node):
        return _cobs_wire(node)
    return _emit_len(node)


def _total(values) -> Optional[int]:
    """逐叶求和；任一项未知 → None（不拿 0 冒充，0 会算出一个看起来合理的错几何）。"""
    total = 0
    for value in values:
        if value is None:
            return None
        total += value
    return total


def _flatten_leaves(children: Any, out: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """协议树 → 文档序叶子（容器原地展开、禁用块跳过、slot 恒为叶子）。

    口径对齐 frame_builder._to_blocks：`children` 空/缺 → 该节点是叶子；
    禁用块（is_enabled is False）不发射字节 → 不参与几何计算。

    R28（§8.60）：`cobs` 节点**不展开**（它是出线编码单元，区内叶子没有各自的出线
    位置）—— 无槽时整段作一个几何单元（`_node_width` 给出线宽）；含槽时才展开，
    槽前后的区内字节由 `unpack.inner_head/inner_trailer` 表达。
    """
    if out is None:
        out = []
    for node in children or []:
        if not isinstance(node, dict) or node.get("is_enabled") is False:
            continue
        if _leaf_type(node) == "slot":
            out.append(node)
            continue
        if _is_cobs(node) and not _subtree_has_slot(node):
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
        if _is_cobs(target):
            # R27/R28: refs 引 cobs **不下钻**（编码边界跨不过）—— 按该单元的出线
            # 字节数整体计，镜像 frame_builder._build_logic_config 的 expand。
            out.append(ref)
            return
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
    """本层帧几何：叶子序、插槽位、head/trailer、逐叶子绝对位置。

    R28（§8.60）三种形态，前一种是存量（无 cobs → 逐值不变，test_response_baseline
    金标准看守）：
    1. **无 cobs**：与之前完全相同；
    2. **cobs 不含槽**：cobs 作一个几何单元，宽度取**出线字节**（码字节 + 定界），
       head/trailer/positions/refs Σ 全按这个量 —— 否则 COBS 的开销会算进「逻辑和」，
       剥层头尾就是错的；
    3. **cobs 含槽**（且只嵌一层）：head/trailer 量到 COBS 区**外**，trailer 还要
       收进定界字节；区内槽前后另记 `inner_head`/`inner_trailer`（解码后才剥）。
       此时 `declared` 与 `len(帧)` 不再是线性关系（码字节与 0x00 分布随载荷变）
       → length/checksum 一律不生成（`layer_stage_spec` 记 warning），只有剥层几何
       仍然成立。
    4. **嵌套两层 cobs 包槽 / 出线宽不可知** → `degraded=True`、`unpack=None`：
       单层还能退化成「只判不剥」，多层由 `build_spec` 拒绝生成（宁可 400 也不静默
       给一个会剥错的几何）。
    """
    path = _slot_path(children)
    cobs_chain = [n for n in (path or [])[:-1] if _is_cobs(n)]
    nested = len(cobs_chain) >= 2
    boundary = cobs_chain[0] if (cobs_chain and not nested) else None

    leaves = _flatten_leaves(children)
    bls = [_node_width(n) for n in leaves]
    degraded = nested or any(b is None for b in bls)

    slot_idx = next(
        (i for i, n in enumerate(leaves) if _leaf_type(n) == "slot"), None
    )

    # COBS 区在 leaves 里的下标范围 [a, b)（含槽时槽必落在其中）
    a = b = None
    if boundary is not None:
        inside = {id(n) for n in _flatten_leaves(boundary.get("children"))}
        idxs = [i for i, n in enumerate(leaves) if id(n) in inside]
        if idxs:
            a, b = idxs[0], idxs[-1] + 1

    if boundary is not None and a is not None and slot_idx is not None:
        # 区外前缀 / 区外后缀 + 定界；区内槽前后单独记（解码后才是这个坐标）
        head = _total(bls[:a])
        trailer = _total(bls[b:])
        inner_head = _total(bls[a:slot_idx])
        inner_trailer = _total(bls[slot_idx + 1 : b])
        if trailer is not None:
            trailer += len(terminator_of(boundary.get("parameter_config")))
        degraded = degraded or None in (head, trailer, inner_head, inner_trailer)
    elif slot_idx is None:
        head, trailer = _total(bls), 0
        inner_head = inner_trailer = None
    else:
        head = _total(bls[:slot_idx])
        trailer = _total(bls[slot_idx + 1 :])
        inner_head = inner_trailer = None

    # 兜底：认得出 COBS 区却量不出区内几何（下标没对上 / 宽度未知）→ 整层降级，
    # 宁可 `unpack=None` 由 build_spec 拒绝，也不给一个会剥错的几何。
    if boundary is not None and (a is None or None in (inner_head, inner_trailer)):
        degraded = True

    positions: List[Optional[int]] = []
    running = 0
    known = True
    for i, node in enumerate(leaves):
        positions.append(running if known else None)
        if _leaf_type(node) == "slot":
            known = False  # 插槽后偏移取决于载荷长度 → 静态不可知
        elif known:
            if bls[i] is None:
                known = False  # 出线宽不可知 → 其后位置一律未知（不报假偏移）
            else:
                running += bls[i]

    # 回显头只数**线上最前的连续 fixed 字节**：COBS 区（含区内首叶）不是帧头。
    echo_limit = a if (a is not None and boundary is not None) else len(leaves)
    echo_header = 0
    for node in leaves[:echo_limit]:
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
        "inner_head": inner_head,
        "inner_trailer": inner_trailer,
        "boundary": boundary,
        "degraded": degraded,
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
    geo["length_node"] = node  # R28: 选中哪张卡供 varint 降级判定用（见 _downgrade_varint）
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
            width = _node_width(target)
            if width is None:
                # refs 引了出线宽不可静态解析的 COBS 单元 → declared 算不出来，
                # 与其生成一个必然失配的 offset_val，不如降级。
                warnings.append(f"{where} length refs 引用的 COBS 出线宽度不可解析 → 未生成 length")
                return None
            payload_sum += width
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
    # R28（§8.60）：出线长度域是 varint 时把 `encoding` 一并声明给收侧 —— 只写
    # 非缺省值（缺省 fixed = 缺失键），且走 framing.normalize_encoding 的 fail-open
    # （枚举外按 fixed，与发射期口径一致，不让非法配置生成一份收侧必 400 的规格）。
    encoding = normalize_encoding(pc)
    if encoding != DEFAULT_LENGTH_ENCODING:
        out["encoding"] = encoding
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
    # R28: 记下这两项的**几何依赖**，供 _downgrade_varint 判定 varint 卡是否把它算错。
    geo["checksum_node"] = node
    geo["checksum_idx"] = idx
    geo["checksum_pos_abs"] = "offset" in position  # True = 绝对起点（插槽前的静态位）
    if slot_id is not None and ref_set == {slot_id}:
        # refs 只圈载荷 → span = [head, 帧尾 - trailer)（span 末端用 pad 表达）
        span_start, span_end, pad = geo["head"], None, geo["trailer"]
        geo["checksum_span_payload"] = True
    elif all_ids - {node.get("id")} and ref_set == all_ids - {node.get("id")}:
        # refs 恰为本层全部叶子（除自身）→ 整帧反算（_checksum_span 恒排除字段自身）
        span_start, span_end, pad = 0, None, 0
        geo["checksum_span_payload"] = False
    else:
        warnings.append(f"{where} checksum refs 既非「只圈载荷」也非「整层全部」→ 未生成 checksum")
        return None
    out = {
        "algo": algo,
        "field_byte_length": bl,
        "span_start": span_start,
        "span_end": span_end,
        # R34（校验和字节序）：出线 checksum 卡设了小端时，生成的比对规则必须
        # 跟着用小端 —— 否则「出线反转、收侧按大端比」必然不匹配。镜像上方
        # _length_element 的 R21 同款（收侧 response_match 的 _CHECKSUM_KEYS 本就
        # 含 byte_order，此处只是把声明补上）。枚举外 → 回大端。
        "byte_order": "little"
        if str(pc.get("byte_order") or "").strip().lower() == "little"
        else "big",
        "span_end_pad": pad,
    }
    # position 用的是统一键名 offset / offset_from_end，落表改字段名。
    if "offset_from_end" in position:
        out["field_offset_from_end"] = position["offset_from_end"]
    else:
        out["field_offset"] = position["offset"]
    return out


def _warn_hidden_logic(
    children: Any, geo: Dict[str, Any], warnings: List[str], where: str
) -> None:
    """COBS 区（**不含槽**）里的 length/checksum 卡不在文档序叶子中 → 位置不可静态定位。

    它们被 `_flatten_leaves` 收进 cobs 单元后就没有自己的出线坐标了 —— 与其静默
    少一要素，按既定「宁可少判也不误判 + 降级看得见」的口径记 warning。
    """
    hidden: set = set()
    for node in children or []:
        if not isinstance(node, dict) or node.get("is_enabled") is False:
            continue
        if _is_cobs(node) and not _subtree_has_slot(node):
            _deep_walk(node.get("children"), lambda n: hidden.add(_leaf_type(n)))
    for kind in ("length", "checksum"):
        if kind in hidden and not any(_leaf_type(n) == kind for n in geo["leaves"]):
            warnings.append(f"{where} {kind} 卡在 COBS 区内，出线位置静态不可知 → 未生成 {kind}")


def _varint_indices(geo: Dict[str, Any]) -> List[int]:
    """文档序叶子里 varint length 卡的下标（空 = 本层出线宽全静态）。

    隐藏在**无槽 COBS 单元**里的 varint 卡不算：那个单元的宽度由 `build_wrapped`
    按实际值量出（`_cobs_wire` 已拦住 refs 越出子树）→ 宽度本来就对，无须降级。
    """
    out: List[int] = []
    for i, node in enumerate(geo["leaves"]):
        if _leaf_type(node) != "length":
            continue
        pc = node.get("parameter_config")
        pc = pc if isinstance(pc, dict) else {}
        if normalize_encoding(pc) != DEFAULT_LENGTH_ENCODING:
            out.append(i)
    return out


def _downgrade_varint(
    geo: Dict[str, Any],
    length: Optional[Dict[str, Any]],
    checksum: Optional[Dict[str, Any]],
    varint: List[int],
    warnings: List[str],
    where: str,
) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """varint 卡让**设计期几何**与线上字节差 (实际宽 - 设计期宽) → 逐要素降级。

    唯一能自洽的是 length 自身：`len(帧)` 里多出的 (w - bl) 正好被收侧
    `_length_reasons` 的 `-(width - byte_length)` 扣回（改一必改二），所以**恰有
    一张 varint 卡且就是选中那张**时 length 仍可生成。其余字节计数型输出 ——
    checksum 的 `span_start=head` / `span_end_pad=trailer`、绝对 `field_offset` ——
    都要先知道实际出线宽，静态算不出 → 少判一条要素（+ warning），绝不生成一个
    必然失配的值。
    """
    leaves = geo["leaves"]
    if length is not None and not (
        len(varint) == 1 and geo.get("length_node") is leaves[varint[0]]
    ):
        length = None
        warnings.append(
            f"{where} 存在非选中项的 varint length 卡（出线宽随值变，设计期几何算不准）"
            " → 未生成 length"
        )
    if checksum is not None:
        checksum_idx = geo.get("checksum_idx")
        abs_bad = bool(geo.get("checksum_pos_abs")) and any(
            i < checksum_idx for i in varint
        )
        span_bad = bool(geo.get("checksum_span_payload"))
        if abs_bad or span_bad:
            checksum = None
            what = "span 起止与绝对字段偏移" if abs_bad else "span 起止（head/trailer）"
            warnings.append(
                f"{where} 存在 varint length 卡，{what} 随载荷出线宽变化 → 未生成 checksum"
            )
    return length, checksum


def _unpack_of(geo: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """该层剥层几何；`None` = 静态不可表达（单层用不上，多层由 build_spec 拒绝）。"""
    if geo["degraded"]:
        return None
    if geo["boundary"] is not None:
        return {
            "head": geo["head"],
            "trailer": geo["trailer"],
            "mode": "cobs",
            "inner_head": geo["inner_head"],
            "inner_trailer": geo["inner_trailer"],
        }
    return {"head": geo["head"], "trailer": geo["trailer"]}


def layer_stage_spec(children: Any, *, where: str = "", warnings: Optional[List[str]] = None) -> Dict[str, Any]:
    """**按层**执行一次 D5 映射（协议 children → 该层五要素 + unpack）。纯函数、无 IO。

    R28（§8.60）三处降级，都只**少生成要素 / 少给几何**、不改已有口径：
    - 插槽在 COBS 区内 → length/checksum 不生成（declared / span 随载荷与 0x00 分布
      变化，静态不可表达），只有 `unpack.mode=cobs` 的剥层几何仍然成立；
    - COBS 出线宽不可解析（含槽 refs 越出子树 / 嵌套两层 cobs 包槽）→ 同样不生成
      要素，且 `unpack=None`；
    - 存在 varint length 卡 → 见 `_downgrade_varint`（仅「选中那张」的 length 能靠
      收侧回算自洽），并把 `unpack` 置 None（head/trailer 是字节计数，静态算不准）。
    """
    warnings = warnings if warnings is not None else []
    geo = _geometry(children)
    boundary = geo["boundary"] is not None

    length = checksum = None
    if boundary or geo["degraded"]:
        reason = (
            "插槽在 COBS 区内，该要素的出线宽度与位置随载荷（0x00 分布）变化"
            if boundary
            else "COBS 出线宽度不可静态解析"
        )
        for kind in ("length", "checksum"):
            if any(_leaf_type(n) == kind for n in geo["leaves"]):
                warnings.append(f"{where} {reason} → 未生成 {kind}")
    else:
        length = _length_element(geo, warnings, where)
        checksum = _checksum_element(geo, warnings, where)
    varint = _varint_indices(geo)
    if varint:
        length, checksum = _downgrade_varint(geo, length, checksum, varint, warnings, where)
        # head/trailer 是**字节计数**，varint 卡的出线宽随值变 → 无论选中与否都算不准
        geo["degraded"] = True
    _warn_hidden_logic(children, geo, warnings, where)

    return {
        "echo_header_bytes": geo["echo_header"],
        "length": length,
        "checksum": checksum,
        "unpack": _unpack_of(geo),
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

    labels = [
        f"[层{i} {layer.get('label') or layer.get('protocol_id')}]"
        for i, layer in enumerate(layers)
    ]
    stage_specs = [
        layer_stage_spec(layer["children"], where=where, warnings=warnings)
        for layer, where in zip(layers, labels)
    ]
    if len(stage_specs) == 1:
        only = stage_specs[0]
        # 单层退化：不写 stages 键 → response_match 走存量单帧路径（存量零改），
        # unpack 也不需要（没有内层可剥，几何不可解析也只影响要素，已由 warning 记）。
        return (
            {
                "mode": "rules",
                "echo_header_bytes": only["echo_header_bytes"],
                "length": only["length"],
                "checksum": only["checksum"],
            },
            warnings,
        )
    missing = [where for where, s in zip(labels, stage_specs) if not s["unpack"]]
    if missing:
        # 多层时 unpack 是**结构必需**（剥不出内层就没法逐层判），几何算不出就不是
        # 「少判」而是「误判」→ fail-closed 400，文案指名道姓，让人去手工写规格。
        raise ValueError(
            f"{missing[0]} 协议含无法静态表达的 COBS/变长几何"
            "（槽嵌套 COBS、COBS 出线宽随载荷变，或层内另有 varint 长度域）"
            "，据此生成给不出分层剥壳几何 → 请手工编写应答规格"
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
