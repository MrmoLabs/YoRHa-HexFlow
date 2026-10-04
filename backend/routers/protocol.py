import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

# 建表统一在 main.py lifespan（对齐 binding.py 先例：导入不写真实库，
# 测试导入 protocol 路由无副作用）。
from backend.db.database import get_db
from backend.db.models import ProtocolBinding, ProtocolTemplate
from backend.db.soft_delete import alive, mark_deleted, mark_related, now_iso
from backend.schemas.protocol_api import ProtocolCreate, ProtocolResponse, ProtocolUpdate

router = APIRouter(
    prefix="/protocols",
    tags=["protocols"]
)


def _validate_refs(children) -> None:
    """A7: refs 400 校验（children JSON 列零 DDL，校验先于落库）。

    非数组 / 非字符串 / 自引用 / 悬空 —— detail 英文对齐
    "Protocol not found" 先例。refs 为纯 id 数组、同树约束（跨树引用契约外）。
    ② 锚 slot 放开：槽长定义期不可知（前端设计期 Σ 不注入维持 ??），发送期由
    前端 blockMerge 填槽改写 refs 为注入块 id 后按真值 Σ —— 后端只管落库，
    不替发送期语义设闸。
    """
    nodes = {}

    def walk(items):
        for item in items or []:
            nodes[item.id] = item
            walk(item.children)

    walk(children)

    # R27（§8.59）: refs 不得指向 `cobs` 子树**内部** —— 编码边界跨不过（同
    # slot「不下钻」先例）。COBS 出线后这些 id 不在主发射流里：后端按 0 计、
    # 前端 resolveDependencies 仍能查到 → 两端 Σ 分歧。引用 COBS 区域本身请
    # 直接引 `cobs` 块（后端按其出线字节数计）。
    inside_cobs = set()

    def mark_cobs(items, under=False):
        for item in items or []:
            if under:
                inside_cobs.add(item.id)
            mark_cobs(item.children, under or str(item.type) == "cobs")

    mark_cobs(children)

    for node_id, node in nodes.items():
        pc = node.parameter_config or {}
        if "refs" not in pc:
            continue
        refs = pc["refs"]
        if not isinstance(refs, list):
            raise HTTPException(status_code=400, detail="refs must be an array")
        for ref in refs:
            if not isinstance(ref, str):
                raise HTTPException(status_code=400, detail="refs entries must be strings")
            if ref == node_id:
                raise HTTPException(status_code=400, detail="refs cannot reference the block itself")
            if nodes.get(ref) is None:
                raise HTTPException(status_code=400, detail="refs target not found")
            if ref in inside_cobs:
                raise HTTPException(
                    status_code=400,
                    detail="refs cannot reference blocks inside a COBS subtree",
                )
            # ② 锚 slot 放开：槽长定义期不可知（前端设计期 Σ 不注入维持 ??），
            # 发送期由前端 blockMerge 填槽改写为注入块 id 后按真值 Σ。


def _validate_bits(children) -> None:
    """批 4: bitfield 块入库强校验（镜像 routers.instruction._validate_bitfields 口径）。

    协议 children 此前零类型校验（type 是自由 str），坏位域会一路存到编译期
    才炸（甚至静默出 0 字节）。这里在落库前拦两类：位域重叠 / 超出块容量。
    走 children JSON 列 → 零 DDL。
    """
    def walk(items):
        for item in items or []:
            if str(getattr(item, "type", "")) == "bitfield":
                _validate_node_bits(item)
            walk(getattr(item, "children", None))

    walk(children)


def _validate_node_bits(node) -> None:
    bits = list(getattr(node, "bits", None) or [])
    if not bits:
        return
    label = getattr(node, "label", None) or "UNNAMED"

    def start_of(b):
        try:
            return int(getattr(b, "start_bit", 0) or 0)
        except (TypeError, ValueError):
            return 0

    def len_of(b):
        try:
            return max(1, int(getattr(b, "bit_len", 1) or 1))
        except (TypeError, ValueError):
            return 1

    prev_end = -1
    for b in sorted(bits, key=start_of):
        start = start_of(b)
        if start < prev_end:
            raise HTTPException(
                status_code=400,
                detail=f"「{label}」位域重叠（{getattr(b, 'bit_name', '?')} 起始 {start} < 上一块结束 {prev_end}）",
            )
        prev_end = max(prev_end, start + len_of(b))

    byte_len = getattr(node, "byte_length", 0) or 0
    highest = max((start_of(b) + len_of(b)) for b in bits)
    if byte_len > 0 and highest > byte_len * 8:
        raise HTTPException(
            status_code=400,
            detail=f"「{label}」位域超出容量（{byte_len}B = {byte_len * 8} bits，最高位 {highest}）",
        )


# 批次二 (D3/D14①)：槽契约字段合法值 —— 存脏值会被读侧 fail-open 静默成
# append/zero_fill（正是 D14① 要消灭的「静默错帧」），故保存期拒绝。
# 只校验新字段 `fit_policy`（存量槽无此字段 → 零存量影响、不迁移）；
# `max_bytes` / `accepts` 的语义比较属设计期 warning（validateProtocol），不拦。
_SLOT_OVERFLOW = ("append", "reject")
_SLOT_UNDERFLOW = ("zero_fill", "reject")


def _iter_nodes(children):
    for node in children or []:
        yield node
        yield from _iter_nodes(node.children)


def _validate_slot_contracts(children) -> None:
    """批次二 (D3): 插槽 `fit_policy` 结构与取值 400 校验（保存期）。

    形态（`DESIGN_CorePipeline.md` §3 表）：`{overflow: append|reject,
    underflow: zero_fill|reject}`，两键均可选；未知键 / 非法取值 / 非对象
    一律 400 —— 否则读侧 fail-open 会让 reject 静默降级回 append，防错失效。
    """
    for node in _iter_nodes(children):
        if node.type != "slot":
            continue
        pc = node.parameter_config
        if pc is None:
            continue
        if not isinstance(pc, dict):
            raise HTTPException(status_code=400, detail="插槽 parameter_config 必须是对象")
        fp = pc.get("fit_policy")
        if fp is None:
            continue
        label = node.label or node.id
        if not isinstance(fp, dict):
            raise HTTPException(
                status_code=400,
                detail=f"「{label}」fit_policy 必须是对象（{{overflow, underflow}}）",
            )
        unknown = sorted(set(fp) - {"overflow", "underflow"})
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=f"「{label}」fit_policy 含未知键：{', '.join(unknown)}",
            )
        overflow, underflow = fp.get("overflow"), fp.get("underflow")
        if overflow is not None and overflow not in _SLOT_OVERFLOW:
            raise HTTPException(
                status_code=400,
                detail=f"「{label}」fit_policy.overflow 非法：{overflow!r}（须为 append | reject）",
            )
        if underflow is not None and underflow not in _SLOT_UNDERFLOW:
            raise HTTPException(
                status_code=400,
                detail=f"「{label}」fit_policy.underflow 非法：{underflow!r}（须为 zero_fill | reject）",
            )


@router.get("/", response_model=List[ProtocolResponse])
def get_protocols(db: Session = Depends(get_db)):
    # R6: 回收站行不进列表（alive = deleted_at IS NULL）
    return (
        alive(db.query(ProtocolTemplate), ProtocolTemplate)
        .order_by(ProtocolTemplate.label.asc())
        .all()
    )


@router.get("/{protocol_id}", response_model=ProtocolResponse)
def get_protocol(protocol_id: str, db: Session = Depends(get_db)):
    protocol = (
        alive(db.query(ProtocolTemplate), ProtocolTemplate)
        .filter(ProtocolTemplate.id == protocol_id)
        .first()
    )
    if not protocol:
        raise HTTPException(status_code=404, detail="Protocol not found")
    return protocol


@router.post("/", response_model=ProtocolResponse)
def create_protocol(payload: ProtocolCreate, db: Session = Depends(get_db)):
    _validate_refs(payload.children)
    _validate_bits(payload.children)
    _validate_slot_contracts(payload.children)
    protocol_id = payload.id or str(uuid.uuid4())

    protocol = ProtocolTemplate(
        id=protocol_id,
        label=payload.label,
        type=payload.type,
        description=payload.description,
        children=[node.model_dump() for node in payload.children],
    )
    db.add(protocol)
    db.commit()
    db.refresh(protocol)
    # 非映射属性（不入库）：新建协议必然无悬空槽引用，回 0 让两端同一响应形。
    protocol.dangling_slots_cleared = 0
    return protocol


@router.put("/{protocol_id}", response_model=ProtocolResponse)
def update_protocol(protocol_id: str, payload: ProtocolUpdate, db: Session = Depends(get_db)):
    protocol = (
        alive(db.query(ProtocolTemplate), ProtocolTemplate)
        .filter(ProtocolTemplate.id == protocol_id)
        .first()
    )
    if not protocol:
        raise HTTPException(status_code=404, detail="Protocol not found")

    # 批次五: version 乐观并发 —— 带 version 必须与当前行一致，不符 409；
    # 先于 refs 校验（陈旧前置条件先拒，对将被拒的负载做内容校验无意义）。
    # 缺省 None（旧客户端/curl 直调）→ 跳过比对直接覆盖。
    if payload.version is not None and payload.version != (protocol.version or 1):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Protocol version conflict: expected {payload.version}, "
                f"current {protocol.version or 1}"
            ),
        )

    _validate_refs(payload.children)
    _validate_bits(payload.children)
    _validate_slot_contracts(payload.children)
    protocol.label = payload.label
    protocol.type = payload.type
    protocol.description = payload.description
    protocol.children = [node.model_dump() for node in payload.children]

    # 批次二 (D12 §6.2「槽节点」行)：协议内删块 → 绑定 slot_id 悬空 → 置 NULL
    # 并回执计数（不静默：回执带 N）。逻辑外键无 FK，悬空会让编排页按 slot_id
    # 找槽落空、后续绑定校验再也无法自证 —— 保存期是删块的唯一入口，就地收口。
    # 在 version +1 与 commit 之前做，同一事务一并落库。
    slot_ids = {n.id for n in _iter_nodes(payload.children) if n.type == "slot"}
    query = (
        db.query(ProtocolBinding)
        .filter(ProtocolBinding.protocol_id == protocol_id)
        .filter(ProtocolBinding.slot_id.isnot(None))
    )
    if slot_ids:
        query = query.filter(ProtocolBinding.slot_id.notin_(slot_ids))
    dangling = query.all()
    for binding in dangling:
        binding.slot_id = None
    cleared = len(dangling)

    # 任何成功写（含跳过比对的直通写）都 +1 —— 否则直通写会让持旧 version
    # 的其他客户端误判「仍一致」。
    protocol.version = (protocol.version or 0) + 1
    db.commit()
    db.refresh(protocol)
    # 非映射属性（不入库）：回执本次保存清掉的悬空 slot_id 条数。
    protocol.dangling_slots_cleared = cleared
    return protocol


@router.delete("/{protocol_id}")
def delete_protocol(protocol_id: str, db: Session = Depends(get_db)):
    # R6（§8.43）：删除 = 打标记进回收站（读侧 alive 过滤，二次删 404 不变）
    protocol = (
        alive(db.query(ProtocolTemplate), ProtocolTemplate)
        .filter(ProtocolTemplate.id == protocol_id)
        .first()
    )
    if not protocol:
        raise HTTPException(status_code=404, detail="Protocol not found")

    # 批次一 P0-1：级联清理引用该协议的编排绑定 —— protocol_bindings 是
    # 逻辑外键（models 无 FK/ON DELETE），不清则编排页 protocols.find 落空、
    # DB 残留脏行。R6 起改为**级联软删**：绑定与协议**共用同一时间戳**，恢复
    # 时按同戳把绑定一并捞回（db/soft_delete.py）；回执计数口径不变，前端
    # "连带清理 N 条" 提示照旧。
    ts = now_iso()
    deleted_bindings = mark_related(
        db.query(ProtocolBinding),
        ProtocolBinding,
        [ProtocolBinding.protocol_id == protocol_id],
        ts,
    )
    mark_deleted(protocol, ts)
    db.commit()
    return {"status": "deleted", "id": protocol_id, "deleted_bindings": deleted_bindings}
