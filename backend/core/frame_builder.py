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
- **CP3 3a (D13×D3)：`strict_fit=True` 配方路径缺省 `reject`/`reject`** ——
  主动偏离 D3「默认取现状零回归」（配方零存量）；显式 `fit_policy` 仍照槽上
  写的生效，缺省 False → 存量与存量路径逐字节不变（§0 硬约束）。返回同时增
  `logic` = 本层 length/checksum 真值回显（配方分层预览 LEN/CRC 卡面用）。
- 向量纪律（CP2b / D11-①）：FA FA / 02 / 01 02 / ED 主向量单一真相源 =
  `vectors/wrap.json` 表 `main`（test_frame_builder / test_wrap_api /
  blockMerge.test.js 三处同读一份）；CP3 3a 三层配方帧主向量 = 同文件表
  `three`（三处同读，改一必改三）。
"""

import math
import re
from typing import Dict, List, Tuple

from backend.core.orchestrator import Orchestrator
from backend.schemas.block import Block

# 镜像 toFrameBlocks.js BACKEND_ALGO：ChecksumAlgo（前端枚举）→ 后端
# ChecksumHandler 枚举；缺省 CRC_16_MODBUS 与前端编码器同源。
BACKEND_ALGO = {
    "SUM_8": "sum",
    "XOR_8": "xor",
    "CRC_16_MODBUS": "crc16_modbus",
    # R22 (§8.52 排期 · CRC 多算法): FE ChecksumAlgo → params.algorithm 映射。
    # 三处必须同批成对改：本表、toFrameBlocks.js BACKEND_ALGO、sequenceView.js
    # PLAN_ALGO；值域 = response_match.VALID_ALGOS。
    "CRC_16_CCITT": "crc16_ccitt",
    "CRC_32": "crc32",
    "LRC": "lrc",
}


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


def _with_byte_order(config, pc, ntype: str):
    """R21（长度域 BE/LE）+ R34（校验和字节序）：length / checksum 卡
    `parameter_config.byte_order=little` → `config.params.byte_order`
    （镜像 toFrameBlocks buildLogicConfig 同名分支）。

    只在值为 little 时写键 —— 缺省 / big / 枚举外的值一律不写，params 形状与
    本批之前逐字节一致（§0 缺省口径）；refs 缺失的直通路径同样生效（存量树
    可只设字节序）。**仅此二卡**：`encoding`（R27 varint）仍是 length 专属 ——
    `_with_encoding` 的闸门一行未动，校验块没有「出线编码」这个概念。
    """
    if ntype not in ("length", "checksum") or not isinstance(pc, dict):
        return config
    order = str(pc.get("byte_order") or "").strip().lower()
    if order != "little":
        return config
    base = config if isinstance(config, dict) else {}
    params = dict(base.get("params") or {})
    params["byte_order"] = "little"
    merged = dict(base)
    merged["params"] = params
    return merged


def _with_encoding(config, pc, ntype: str):
    """R27（varint 变长长度前缀）：length 卡 `parameter_config.encoding=varint`
    → `config.params.encoding`（镜像 toFrameBlocks buildLogicConfig 同名分支）。

    只在值为 varint 时写键 —— 缺省 / fixed / 枚举外的值一律不写，请求形与
    本批之前逐字节一致（§0 缺省口径，同 R21 `_with_byte_order` 的纪律）。
    """
    if ntype != "length" or not isinstance(pc, dict):
        return config
    enc = str(pc.get("encoding") or "").strip().lower()
    if enc != "varint":
        return config
    base = config if isinstance(config, dict) else {}
    params = dict(base.get("params") or {})
    params["encoding"] = "varint"
    merged = dict(base)
    merged["params"] = params
    return merged


def _with_terminator(config, pc, ntype: str):
    """R27（COBS 定界编码）：cobs 块 `parameter_config.terminator` →
    `config.params.terminator`（镜像 toFrameBlocks 同名分支）。

    只在值为 none 时写键 —— 缺省 / `00` / 枚举外的值一律不写（→ 后端 fail-open
    取缺省 `00` 追加 `0x00`），params 形状与「不配定界」时逐字节一致。
    """
    if ntype != "cobs" or not isinstance(pc, dict):
        return config
    term = str(pc.get("terminator") or "").strip().lower()
    if term != "none":
        return config
    base = config if isinstance(config, dict) else {}
    params = dict(base.get("params") or {})
    params["terminator"] = "none"
    merged = dict(base)
    merged["params"] = params
    return merged


def _build_logic_config(node, ntype: str, by_id: dict):
    """镜像 toFrameBlocks buildLogicConfig：pc.refs → params.refs 叶子展开
    （容器 ref 展开为其子树叶子、悬空丢弃）；checksum 算法枚举映射；length
    offset 仅键存在且为有限数值才带；length pc.byte_order → params.byte_order
    （R21）。pc.refs 键缺失 → config 直通（byte_order 仍生效）。"""
    pc = node.get("parameter_config")
    if not isinstance(pc, dict) or not isinstance(pc.get("refs"), list):
        return _with_encoding(
            _with_byte_order(_js_config(node.get("config")), pc, ntype), pc, ntype
        )

    leaf_ids: List[str] = []

    def expand(ref):
        target = by_id.get(ref)
        if not isinstance(target, dict):
            return  # 悬空 → 丢（前端 encoder find 失败同样跳过）
        # R27: refs 不下钻 `cobs` 子树 —— 编码边界跨不过（同 slot「不下钻」先例）：
        # 引用 cobs 块本身 → 计其出线字节数（产物 fixed 叶的 byte_length）；
        # 引用其内部叶子 → 后端发射流里根本不存在该 id（计 0），保存侧由
        # _validate_refs_cobs 拒掉，避免两端 Σ 口径不一致。
        if str(target.get("type")) == "cobs":
            leaf_ids.append(ref)
            return
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
    return _with_encoding(_with_byte_order(merged, pc, ntype), pc, ntype)


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
        elif ntype == "cobs":
            # R27: 定界选项随 config.params 出线（缺省不写键 → 后端 fail-open 追加 0x00）
            config = _with_terminator(_js_config(node.get("config")), pc, "cobs")
        else:
            config = _js_config(node.get("config"))
        out.append(Block(
            id=str(node.get("id")),
            type=str(ntype),
            label=str(node.get("label") or node.get("name") or node.get("id")),
            byte_length=bl,
            # R73（§8.105）：声明位宽透传 → 发射期位流 extent（sub-byte 块
            # wire 收口的前提；None/0 = byte_length×8 旧口径）。
            bit_len=_finite_int(node.get("bit_len")),
            hex_value=hex_value,
            config=config,
            children=kids,
            is_container=bool(node.get("is_container")) or len(kids) > 0,
            is_enabled=node.get("is_enabled") is not False,
        ))
    return out


def _collect_logic(nodes) -> List[dict]:
    """发射后遍历 Block 森林，取 length/checksum 块的**真值**（Orchestrator
    在发射前已把 block.hex_value 算定）→ 配方分层预览的 LEN/CRC 卡面回显
    （§9.4「该层 LEN/CRC 卡面回显」，复用协议页卡面「真值」口径）。

    文档序前序遍历；`_to_blocks` 恒写 `type=str(ntype)`，故直接比字符串。
    """
    out: List[dict] = []
    for node in nodes or []:
        if not isinstance(node, Block):
            continue
        ntype = str(node.type)
        if ntype in ("length", "checksum"):
            out.append(
                {
                    "label": node.label,
                    "type": ntype,
                    "value": re.sub(r"\s+", "", node.hex_value or ""),
                }
            )
        if node.children:
            out.extend(_collect_logic(node.children))
    return out


def _collect_shell(nodes, spans: Dict[str, List[Tuple[int, int]]]) -> dict:
    """CP3 3c (D6-B): 发射期求**本层**外壳在本层帧内的绝对字节位置。

    - `payload_offset`：注入载荷（id 恒 `i-payload-0`）的起点 = 本层外壳头部
      字节数（找不到时 None —— 空载荷删槽 / 无槽追加根末尾）；
    - `length` / `checksum`：本层 length·checksum 字段的 `{offset, byte_length}`
      区间（内容口径：align 前置 pad 归前块、pad_to 后置 pad 归后块）。
    均相对**本层帧**；配方把层 i 的区间平移到最终帧（见 recipe_compile.shell_plan）。
    仅多一个键，既有消费方逐键取值 → 零影响。
    """
    out: dict = {"payload_offset": None, "length": [], "checksum": []}
    # R73（§8.105）：`block_spans` 已 bit 化（发射期位游标）——此处统一换算回
    # 字节区间：offset = floor(bit/8)（字段首含字节）、width = ceil(bit/8)
    # （覆盖字节）。纯字节帧逐位等价旧值（起点恒字节对齐、宽恒 8 倍数）→
    # 载荷注入点 / LEN·CRC 字段位置 / recipe 平移口径零漂移；sub-byte 帧的
    # 跨字节 LEN/CRC 字段按覆盖字节上报（该态配方不支持，§8.105 留白登记）。
    hits = spans.get("i-payload-0")
    if hits:
        out["payload_offset"] = int(hits[0][0]) // 8

    def walk(node_list) -> None:
        for node in node_list or []:
            if not isinstance(node, Block):
                continue
            ntype = str(node.type)
            if ntype in ("length", "checksum"):
                for start, end in spans.get(str(node.id)) or []:
                    start, end = int(start), int(end)
                    out[ntype].append(
                        {"offset": start // 8, "byte_length": (end - start + 7) // 8}
                    )
            if node.children:
                walk(node.children)

    walk(nodes)
    return out


# 批次二 (D3)：槽契约读侧口径 —— 合法值集合与 §3 表一致；存量槽无
# parameter_config / 无 fit_policy → 缺省 = 现状口径（append/zero_fill）。
_OVERFLOW_DEFAULT, _UNDERFLOW_DEFAULT = "append", "zero_fill"
_OVERFLOW_ALLOWED = ("append", "reject")
_UNDERFLOW_ALLOWED = ("zero_fill", "reject")
_REJECT = "reject"


def _fit_policy(node, strict: bool = False) -> tuple:
    """槽的 (overflow, underflow) 策略。

    非法值在协议保存期已被 `protocol.py::_validate_slot_contracts` 拒绝；此处
    fail-open 回缺省（读侧不重复报错，与 refs 悬空丢弃同口径）。

    CP3 3a (D13×D3)：`strict=True`（**配方路径**）时未显式配置的槽缺省改为
    `reject`/`reject` —— 主动偏离 D3「默认取现状零回归」（配方零存量；多层下
    溢出 append 的字节会被下一层当正常载荷收下，错误被放大）。显式配置的
    `fit_policy` 两侧都**照槽上写的生效**，strict 只换缺省值。
    """
    if strict:
        overflow_default, underflow_default = _REJECT, _REJECT
    else:
        overflow_default, underflow_default = _OVERFLOW_DEFAULT, _UNDERFLOW_DEFAULT
    pc = node.get("parameter_config")
    fp = pc.get("fit_policy") if isinstance(pc, dict) else None
    overflow, underflow = overflow_default, underflow_default
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


def build_wrapped(
    protocol_children,
    payloads,
    slot_ids=None,
    start_order=0,
    strict_fit: bool = False,
) -> dict:
    """协议 children + 已编码内核 hex 载荷 → 封装帧（唯一封装入口）。

    返回 {"hex": pretty, "total_length": 字节数, "warnings": [...],
    "logic": [{label, type, value}]} —— `logic` 是本层 length/checksum 块的
    **真值回显**（发射后 block.hex_value 已定值），供配方分层预览的 LEN/CRC
    卡面直读；仅多一个键，既有消费方逐键取值 → 零影响。

    语义错误（插槽不存在 / 不是插槽 / 重复分配、非法 hex、**fit_policy=reject
    触发的溢出/欠载**）→ ValueError（HTTP 侧 → 400）；warnings 顺序：overflow
    先、underflow 后。

    `strict_fit=True`（CP3 3a 配方路径，§9.5-2）：未显式配置 fit_policy 的槽
    缺省改为 reject/reject —— **主动偏离 D3 缺省口径**；缺省 False → 存量与
    存量路径逐字节不变（§0 硬约束）。
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
        if any(_fit_policy(s, strict_fit)[0] == _REJECT for s in slots):
            # 报错归因要说清 reject 从哪来：槽上显式配置 vs 配方路径缺省（strict）
            reason = (
                "协议存在 overflow=reject 的插槽"
                if any(_fit_policy(s, False)[0] == _REJECT for s in slots)
                else "配方路径缺省 overflow=reject"
            )
            errors.append(
                f"洞位不足：{overflow} 条载荷无可用插槽（{reason}，"
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
        if _fit_policy(node, strict_fit)[0] == _REJECT:
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
        if _fit_policy(s, strict_fit)[1] != _REJECT:
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
    orchestrator = Orchestrator(blocks)
    raw_hex = orchestrator.process()
    compact = re.sub(r"\s+", "", raw_hex)
    spans = getattr(orchestrator, "block_spans", {}) or {}
    return {
        "hex": _pretty(compact),
        "total_length": len(compact) // 2,
        "warnings": warnings,
        # CP3 3a: length/checksum 真值回显（分层预览卡面用；仅多一个键）
        "logic": _collect_logic(blocks),
        # CP3 3c (D6-B): 发射期绝对字节区间（载荷注入点 + LEN/CRC 字段位置；
        # 仅多一个键 → 预览/出线/配方三路既有消费方零影响）
        "shell": _collect_shell(blocks, spans),
    }
