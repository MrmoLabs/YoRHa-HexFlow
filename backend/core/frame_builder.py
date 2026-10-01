"""批次一 1b (D4-A): 后端唯一封装入口 build_wrapped。

语义移植自前端 blockMerge.js（mergeProtocolInstruction）+ toFrameBlocks.js：
- 载荷是**已编码内核 hex**（指令编码仍在前端，D4/D11 分批收敛 —— 偏离设计稿
  签名，1d 注明）；注入为单 fixed 块，外壳 length/checksum 交由 handlers
  refs 集合模式真值重算。
- 洞序 = 协议树 DFS（镜像 FE fill：遇 slot 不下钻）；显式 slot_ids（存原始
  id）优先，其余按 start_order 起的稠密位次；洞未填保留 slot（发射归零）；
  溢出 append 根末尾。
- **批次二 (D3/D14①)：溢出/欠载按槽 `fit_policy` 执行** —— `reject` →
  ValueError（HTTP 侧 400）含槽 id 与实际/允许字节数；`append`/`zero_fill`
  （**存量缺省口径**，存量槽不迁移）保留原行为并给 warning；`max_bytes` 超限
  逐槽判定同溢出策略。混合策略下**任一槽 overflow=reject 即阻断追加帧末尾**
  （追加会破坏该协议的结构假设 —— 实施注，D14① 未定，2026-10-01 记）。
- 双端向量纪律：FA FA / 02 / 01 02 / ED 主向量与
  frontend/src/utils/__tests__/blockMerge.test.js 钉同一字节序列，改一必改二。
"""

import math
import re
from typing import Dict, List

from backend.core.orchestrator import Orchestrator
from backend.schemas.block import Block

# 镜像 toFrameBlocks.js BACKEND_ALGO：ChecksumAlgo（前端枚举）→ 后端
# ChecksumHandler 枚举；缺省 CRC_16_MODBUS 与前端编码器同源。
BACKEND_ALGO = {"SUM_8": "sum", "XOR_8": "xor", "CRC_16_MODBUS": "crc16_modbus"}


def _normalize_payload(raw) -> str:
    """payload 规范化：去空白 → 空即空载荷；验偶长 hex → upper。

    "01 02" → "0102"；"" → ""（空载荷：消耗槽位 0 字节、refs 收缩为空）；
    "ABC"（奇数长）/ "GG"（非 hex）→ ValueError（HTTP 侧 → 400）。
    """
    compact = re.sub(r"\s+", "", raw if isinstance(raw, str) else str(raw))
    if compact == "":
        return ""
    if len(compact) % 2 != 0 or not re.fullmatch(r"[0-9A-Fa-f]+", compact):
        raise ValueError(f"非法 hex 载荷：{raw!r}")
    return compact.upper()


def _pretty(compact: str) -> str:
    """compact hex → FE pretty 口径（match(/.{1,2}/g).join(' ')）。"""
    return " ".join(compact[i:i + 2] for i in range(0, len(compact), 2))


def _clone_nodes(nodes, prefix="p-", by_orig=None) -> list:
    """深克隆 + 前缀化 id（镜像 FE cloneBlocks）。

    refs 同步前缀（否则 handlers 查无目标 → length Σ 恒 0）；空 children
    列表也新建以避免回染输入（FE `if (children)` 对 [] 亦克隆 —— Python 须
    `is not None` 判空）；带 refs 的节点换新 parameter_config 对象；config
    共享引用但全程只读（出口处 dict(...) 复制）。by_orig 记原始 id → 克隆
    节点（显式 slot_id 存原始 id，需映射回克隆树）。
    """
    out = []
    for b in nodes or []:
        if not isinstance(b, dict):
            continue
        orig_id = b.get("id")
        nb = dict(b)
        nb["id"] = f"{prefix}{orig_id}"
        if by_orig is not None and orig_id is not None:
            by_orig.setdefault(orig_id, nb)
        pc = b.get("parameter_config")
        if isinstance(pc, dict) and isinstance(pc.get("refs"), list):
            nb["parameter_config"] = {
                **pc,
                "refs": [f"{prefix}{r}" for r in pc["refs"]],
            }
        if b.get("children") is not None:
            nb["children"] = _clone_nodes(b["children"], prefix, by_orig)
        out.append(nb)
    return out


def _collect_slots(nodes, out: list) -> None:
    """DFS 收集插槽（镜像 FE fill：遇 slot 不下钻）。"""
    for n in nodes or []:
        if n.get("type") == "slot":
            out.append(n)
            continue
        kids = n.get("children")
        if kids:
            _collect_slots(kids, out)


def _injected_block(index: int, compact: str) -> dict:
    """注入块：已编码内核 hex 载荷 → 单 fixed 块（pretty 对、对数为字节长）。"""
    return {
        "id": f"i-payload-{index}",
        "label": f"payload-{index}",
        "type": "fixed",
        "byte_length": len(compact) // 2,
        "hex_value": _pretty(compact),
        "config": {},
        "children": [],
    }


def _js_number(value) -> float:
    """JS Number(value) 口径：null→0、bool→1/0、数字→原值、''→0、
    数字串→数值、其余→NaN（missing 由调用方用键存在性先拦）。"""
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if s == "":
            return 0.0
        try:
            return float(s)
        except ValueError:
            return float("nan")
    return float("nan")


def _js_config(value):
    """JS `x || null` 口径（config 出口）：对象恒 truthy（{} 也保留 —— Python
    `{} or None` 会误吞），None/''/0/False → None。"""
    if isinstance(value, (dict, list)):
        return value
    if value is None or value is False or value == 0 or value == "":
        return None
    return value


def _finite_int(value):
    """JS Number.isFinite 口径的 byte_length 提取（仅数字类型、bool 除外）。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    return int(f) if math.isfinite(f) else None


def _index_nodes(nodes, by_id: dict) -> None:
    """全林索引（pre-order、首见胜出）—— 镜像 toFrameBlocks index()：
    节点带 id 才入表并下钻（FE 同口径）。"""
    for n in nodes or []:
        if isinstance(n, dict) and n.get("id") is not None:
            if n["id"] not in by_id:
                by_id[n["id"]] = n
            _index_nodes(n.get("children"), by_id)


def _build_logic_config(node, ntype: str, by_id: dict):
    """镜像 toFrameBlocks buildLogicConfig：pc.refs → params.refs 叶子展开
    （容器 ref 展开为其子树叶子、悬空丢弃）；checksum 算法枚举映射；length
    offset 仅键存在且为有限数值才带。pc.refs 键缺失 → config 直通。"""
    pc = node.get("parameter_config")
    if not isinstance(pc, dict) or not isinstance(pc.get("refs"), list):
        return _js_config(node.get("config"))

    leaf_ids: List[str] = []

    def expand(ref):
        target = by_id.get(ref)
        if not isinstance(target, dict):
            return  # 悬空 → 丢（前端 encoder find 失败同样跳过）
        kids = target.get("children") or []
        if kids:
            for child in kids:
                expand(child.get("id"))
        else:
            leaf_ids.append(ref)

    for ref in pc["refs"]:
        expand(ref)

    params: Dict[str, object] = {"refs": leaf_ids}
    if ntype == "checksum":
        params["algorithm"] = BACKEND_ALGO.get(pc.get("algorithm"), "crc16_modbus")
    if ntype == "length" and "offset" in pc:
        offset = _js_number(pc.get("offset"))
        if math.isfinite(offset):
            params["offset"] = int(offset) if float(offset).is_integer() else offset

    base = node.get("config")
    merged = dict(base) if isinstance(base, dict) else {}
    merged["params"] = params
    return merged


def _build_bitfield_config(node):
    """批 4: bitfield 块的位段透传 —— 打包发生在 Orchestrator 发射期
    （backend/handlers/bitfield.py），此处只把结构化位域搬进 config.params.bits，
    与前端 toFrameBlocks 的 bitfield 分支同形。脏数据（非 dict 项 / 非法
    start|len）在此剔除，不进编码。
    """
    segments = []
    for b in node.get("bits") or []:
        if not isinstance(b, dict):
            continue
        start = _js_number(b.get("start_bit"))
        length = _js_number(b.get("bit_len"))
        if not math.isfinite(start) or not math.isfinite(length) or length < 1 or start < 0:
            continue
        default_val = _js_number(b.get("default_val"))
        segments.append({
            "bit_name": str(b.get("bit_name") or ""),
            "start_bit": int(start),
            "bit_len": int(length),
            "default_val": int(default_val) if math.isfinite(default_val) else 0,
        })

    base = node.get("config")
    merged = dict(base) if isinstance(base, dict) else {}
    merged["params"] = {"bits": segments}
    return merged


def _to_blocks(nodes, by_id: dict) -> List[Block]:
    """镜像 toFrameBlocks mapNode：协议 dict 树 → 后端 Block 森林。

    不映射 endianness/repeat_count（FE 同样不映射）：协议侧无此概念，载荷
    已在前端编码期完成字节序/重复展开 → 缺省 BIG/1 即正确（payload 不可
    再被发射期反转）。
    """
    out: List[Block] = []
    for node in nodes or []:
        raw_kids = node.get("children")
        kids = _to_blocks(raw_kids, by_id) if raw_kids else []
        op_code = str(node.get("op_code") or "").upper()
        ntype = node.get("type")
        if not ntype:
            if op_code == "LENGTH_CALC":
                ntype = "length"
            elif op_code == "CHECKSUM_CRC":
                ntype = "checksum"
            elif op_code == "ARRAY_GROUP" or kids:
                ntype = "container"
            else:
                ntype = "fixed"
        bl = _finite_int(node.get("byte_length"))
        if bl is None:
            bl = _finite_int(node.get("byte_len"))
        if bl is None:
            bl = 0
        pc = node.get("parameter_config")
        hex_value = node.get("hex_value") \
            or (pc.get("hex") if isinstance(pc, dict) else None) \
            or None
        is_logic = ntype in ("length", "checksum")
        if is_logic:
            config = _build_logic_config(node, ntype, by_id)
        elif ntype == "bitfield":
            config = _build_bitfield_config(node)
        else:
            config = _js_config(node.get("config"))
        out.append(Block(
            id=str(node.get("id")),
            type=str(ntype),
            label=str(node.get("label") or node.get("name") or node.get("id")),
            byte_length=bl,
            hex_value=hex_value,
            config=config,
            children=kids,
            is_container=bool(node.get("is_container")) or len(kids) > 0,
            is_enabled=node.get("is_enabled") is not False,
        ))
    return out


# 批次二 (D3)：槽契约读侧口径 —— 合法值集合与 §3 表一致；存量槽无
# parameter_config / 无 fit_policy → 缺省 = 现状口径（append/zero_fill）。
_OVERFLOW_DEFAULT, _UNDERFLOW_DEFAULT = "append", "zero_fill"
_OVERFLOW_ALLOWED = ("append", "reject")
_UNDERFLOW_ALLOWED = ("zero_fill", "reject")


def _fit_policy(node) -> tuple:
    """槽的 (overflow, underflow) 策略。

    非法值在协议保存期已被 `protocol.py::_validate_slot_contracts` 拒绝；此处
    fail-open 回缺省（读侧不重复报错，与 refs 悬空丢弃同口径）。
    """
    pc = node.get("parameter_config")
    fp = pc.get("fit_policy") if isinstance(pc, dict) else None
    overflow, underflow = _OVERFLOW_DEFAULT, _UNDERFLOW_DEFAULT
    if isinstance(fp, dict):
        if fp.get("overflow") in _OVERFLOW_ALLOWED:
            overflow = fp["overflow"]
        if fp.get("underflow") in _UNDERFLOW_ALLOWED:
            underflow = fp["underflow"]
    return overflow, underflow


def _max_bytes(node):
    """槽的 `max_bytes`（注入载荷字节数上限）；未设/非法 → None（不限）。"""
    pc = node.get("parameter_config")
    value = _finite_int(pc.get("max_bytes")) if isinstance(pc, dict) else None
    return value if value is not None and value >= 0 else None


def build_wrapped(protocol_children, payloads, slot_ids=None, start_order=0) -> dict:
    """协议 children + 已编码内核 hex 载荷 → 封装帧（唯一封装入口）。

    返回 {"hex": pretty, "total_length": 字节数, "warnings": [...]}。
    语义错误（插槽不存在 / 不是插槽 / 重复分配、非法 hex、**fit_policy=reject
    触发的溢出/欠载**）→ ValueError（HTTP 侧 → 400）；warnings 顺序：overflow
    先、underflow 后。
    """
    normalized = [_normalize_payload(p) for p in (payloads or [])]
    explicit = list(slot_ids or [])

    by_orig: Dict[str, dict] = {}
    roots = _clone_nodes(protocol_children, "p-", by_orig)

    slots: List[dict] = []
    _collect_slots(roots, slots)

    # ---- 两趟分配：显式 slot_ids 优先，其余按 start_order 起稠密位次 ----
    claimed: Dict[str, int] = {}      # 克隆槽 id → payload 位次
    payload_slot: Dict[int, dict] = {}  # payload 位次 → 克隆槽节点
    for i in range(len(normalized)):
        if i >= len(explicit):
            break
        sid = explicit[i]
        if not sid:
            continue
        node = by_orig.get(sid)
        if node is None:
            raise ValueError(f"插槽不存在于所选协议：{sid}")
        if node.get("type") != "slot":
            raise ValueError(f"目标块不是插槽：{sid}")
        if node["id"] in claimed:
            raise ValueError(f"插槽重复分配：{sid}")
        claimed[node["id"]] = i
        payload_slot[i] = node

    cursor = max(0, int(start_order or 0))
    for i in range(len(normalized)):
        if i in payload_slot:
            continue
        while cursor < len(slots) and slots[cursor]["id"] in claimed:
            cursor += 1
        if cursor >= len(slots):
            break  # cursor 只增不减 → 余下全部溢出
        node = slots[cursor]
        claimed[node["id"]] = i
        payload_slot[i] = node
        cursor += 1

    # ---- splice：注入载荷（空载荷删槽）、未填槽保留；同时记 refs 改写表 ----
    rewrite: Dict[str, List[str]] = {}

    def splice(nodes) -> list:
        new_list = []
        for n in nodes or []:
            if n.get("type") == "slot":
                pi = claimed.get(n["id"])
                if pi is None:
                    new_list.append(n)  # 欠载：保留 slot（发射归零）
                    continue
                compact = normalized[pi]
                if compact == "":
                    rewrite[n["id"]] = []  # 空载荷：删槽、refs 收缩为空
                else:
                    inj = _injected_block(pi, compact)
                    rewrite[n["id"]] = [inj["id"]]
                    new_list.append(inj)
                continue
            kids = n.get("children")
            if kids is not None:
                n["children"] = splice(kids)  # 克隆树自有列表，可安全重建
            new_list.append(n)
        return new_list

    roots = splice(roots)

    # ---- 溢出：无槽可用的载荷追加根末尾（空载荷不产生字节，仍计 warning）----
    overflow = 0
    for i in range(len(normalized)):
        if i in payload_slot:
            continue
        overflow += 1
        if normalized[i]:
            roots.append(_injected_block(i, normalized[i]))

    # ---- rewrite 后置 pass：全树 refs 命中改写表 → 展开 ----
    # `rewrite.get(r, [r])`：空列表须生效（JS `rewrite.get(r) || [r]` 中 [] 为
    # truthy；Python 若写 `or` 会把空列表误回退成原 id —— 勿改）。
    if rewrite:
        def apply_rewrites(nodes) -> None:
            for n in nodes or []:
                pc = n.get("parameter_config")
                if isinstance(pc, dict) and isinstance(pc.get("refs"), list):
                    n["parameter_config"] = {
                        **pc,
                        "refs": [x for r in pc["refs"] for x in rewrite.get(r, [r])],
                    }
                kids = n.get("children")
                if kids:
                    apply_rewrites(kids)

        apply_rewrites(roots)

    # ---- 批次二 (D3/D14①)：fit_policy 执行 —— reject → ValueError（HTTP 400）----
    # 缺省（append/zero_fill，存量槽不迁移）保持原 warning 文案与原行为。
    warnings: List[str] = []
    errors: List[str] = []

    # 溢出 ①（条数）：载荷无槽可用 → 追加帧末尾；任一槽 overflow=reject 即阻断
    if overflow:
        if any(_fit_policy(s)[0] == "reject" for s in slots):
            errors.append(
                f"洞位不足：{overflow} 条载荷无可用插槽（协议存在 overflow=reject 的插槽，"
                f"禁止追加帧末尾；可用插槽 {len(slots)} 个 / 载荷 {len(normalized)} 条）"
            )
        else:
            warnings.append(f"洞位不足：{overflow} 条载荷无可用插槽，已追加帧末尾")

    # 溢出 ②（字节数）：载荷超槽 max_bytes → 逐槽按该槽 overflow 策略（§3：报错
    # 带槽 id 与实际/允许字节数）
    for pi in sorted(payload_slot):
        node = payload_slot[pi]
        allowed = _max_bytes(node)
        actual = len(normalized[pi]) // 2
        if allowed is None or actual <= allowed:
            continue
        where = f"插槽 {node.get('id')}"
        if _fit_policy(node)[0] == "reject":
            errors.append(
                f"{where} 溢出：载荷 {actual} 字节 > 允许 {allowed} 字节（overflow=reject）"
            )
        else:
            warnings.append(
                f"{where} 溢出：载荷 {actual} 字节 > 允许 {allowed} 字节，已按 append 保留"
            )

    # 欠载：逐槽按该槽 underflow 策略（reject 的槽逐个报，未 reject 才汇总 warning）
    unfilled = [s for s in slots if s["id"] not in claimed]
    underflow_rejected = 0
    for s in unfilled:
        if _fit_policy(s)[1] != "reject":
            continue
        underflow_rejected += 1
        allowed = _finite_int(s.get("byte_length"))
        allowed_text = "不限" if allowed is None else f"{allowed} 字节"
        errors.append(
            f"插槽 {s.get('id')} 欠载：实际 0 字节 / 允许 {allowed_text}（underflow=reject）"
        )
    if unfilled and not underflow_rejected:
        warnings.append(f"空洞：{len(unfilled)} 个洞未被载荷填充")

    if errors:
        raise ValueError("；".join(errors))

    # ---- 转 Block → Orchestrator 发射 → 空白折叠按对重排 pretty ----
    by_id: Dict[str, dict] = {}
    _index_nodes(roots, by_id)
    blocks = _to_blocks(roots, by_id)
    raw_hex = Orchestrator(blocks).process()
    compact = re.sub(r"\s+", "", raw_hex)
    return {
        "hex": _pretty(compact),
        "total_length": len(compact) // 2,
        "warnings": warnings,
    }
