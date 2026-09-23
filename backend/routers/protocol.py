import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

# 建表统一在 main.py lifespan（对齐 binding.py 先例：导入不写真实库，
# 测试导入 protocol 路由无副作用）。
from backend.db.database import get_db
from backend.db.models import ProtocolBinding, ProtocolTemplate
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
            # ② 锚 slot 放开：槽长定义期不可知（前端设计期 Σ 不注入维持 ??），
            # 发送期由前端 blockMerge 填槽改写为注入块 id 后按真值 Σ。


@router.get("/", response_model=List[ProtocolResponse])
def get_protocols(db: Session = Depends(get_db)):
    return db.query(ProtocolTemplate).order_by(ProtocolTemplate.label.asc()).all()


@router.get("/{protocol_id}", response_model=ProtocolResponse)
def get_protocol(protocol_id: str, db: Session = Depends(get_db)):
    protocol = db.query(ProtocolTemplate).filter(ProtocolTemplate.id == protocol_id).first()
    if not protocol:
        raise HTTPException(status_code=404, detail="Protocol not found")
    return protocol


@router.post("/", response_model=ProtocolResponse)
def create_protocol(payload: ProtocolCreate, db: Session = Depends(get_db)):
    _validate_refs(payload.children)
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
    return protocol


@router.put("/{protocol_id}", response_model=ProtocolResponse)
def update_protocol(protocol_id: str, payload: ProtocolUpdate, db: Session = Depends(get_db)):
    protocol = db.query(ProtocolTemplate).filter(ProtocolTemplate.id == protocol_id).first()
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
    protocol.label = payload.label
    protocol.type = payload.type
    protocol.description = payload.description
    protocol.children = [node.model_dump() for node in payload.children]
    # 任何成功写（含跳过比对的直通写）都 +1 —— 否则直通写会让持旧 version
    # 的其他客户端误判「仍一致」。
    protocol.version = (protocol.version or 0) + 1
    db.commit()
    db.refresh(protocol)
    return protocol


@router.delete("/{protocol_id}")
def delete_protocol(protocol_id: str, db: Session = Depends(get_db)):
    protocol = db.query(ProtocolTemplate).filter(ProtocolTemplate.id == protocol_id).first()
    if not protocol:
        raise HTTPException(status_code=404, detail="Protocol not found")

    # 批次一 P0-1：级联清理引用该协议的编排绑定 —— protocol_bindings 是
    # 逻辑外键（models 无 FK/ON DELETE），不清则编排页 protocols.find 落空、
    # DB 残留脏行。同事务一并删除，返回计数供前端提示"连带清理 N 条"。
    deleted_bindings = (
        db.query(ProtocolBinding)
        .filter(ProtocolBinding.protocol_id == protocol_id)
        .delete(synchronize_session=False)
    )
    db.delete(protocol)
    db.commit()
    return {"status": "deleted", "id": protocol_id, "deleted_bindings": deleted_bindings}
