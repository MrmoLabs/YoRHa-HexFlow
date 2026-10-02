"""R6 软删除 / 回收站（PLAN §8.43）：回收站的**唯一读写入口**。

各业务路由只负责「删除 = 打标记、读 = `alive()` 过滤」，回收站的列条目 / 恢复 /
彻底删除全部收在这里，理由是拍板要的是「13 表统一」——

- 统一的**白名单** `KINDS`（不接受任意表名，杜绝把表名当路径参数拼进 SQL）；
- 统一的**回执形状**（`TrashItem` / `TrashOpResponse`），前端一个面板打全部类型；
- 统一的**级联语义**：恢复按「同父 + 同时间戳」捞回子行（见 db/soft_delete.py），
  彻底删除按外键清干净（不留孤儿行）。

**列表会隐藏「被父行连带入站」的子行**：删指令时它的绑定/应答规格跟着入站，
它们不该在回收站里单独占一行（恢复父行会一并回来）—— 判据 = 子行的宿主也在
回收站里。独立删掉的绑定/规格（宿主是活的）正常显示。

不进回收站的三张表（只加列、不改行为）：`dispatch_logs`（清空日志 = 追加型
审计数据，删除即不可恢复是既有口径）、`operator_templates`（种子数据无删除
入口）、`transport_settings`（单行配置无删除入口）。
"""
from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import (
    DeviceProfile,
    FrameRecipe,
    Instruction,
    ProtocolBinding,
    ProtocolTemplate,
    ResponseSpec,
    Sequence,
    SequenceStep,
)
from backend.db.soft_delete import is_trashed, purge_related, restore_related, trashed
from backend.schemas.trash_api import TrashItem, TrashList, TrashOpResponse

router = APIRouter(prefix="/trash", tags=["trash"])


def _clear_recipe_links(row, db: Session) -> None:
    """配方彻底删除前解除指令的默认配方指针。

    软删期已解除过一次（routers/recipe.delete_recipe 回执 `cleared_instructions`
    口径不变）；恢复后用户可能重新指定，再删一次才不会留脏行。
    """
    db.query(Instruction).filter(Instruction.default_recipe_id == row.id).update(
        {"default_recipe_id": None}, synchronize_session=False
    )


def _spec_label(row, db: Session) -> str:
    instruction = (
        db.query(Instruction).filter(Instruction.id == row.instruction_id).first()
    )
    if instruction:
        return f"{instruction.name or instruction.code} · 应答规格"
    return f"应答规格 {str(row.id)[:8]}"


@dataclass(frozen=True)
class _Kind:
    """一个可进回收站的类型：模型 + 展示名 + 级联子行 + 列表隐藏/彻底删除前钩子。"""

    model: type
    label: Callable[[object, Session], str]
    # (回执键, 子模型, 外键列) —— 恢复按同戳捞回、彻底删除按外键清掉
    children: Tuple[Tuple[str, type, object], ...] = ()
    # 列表隐藏：宿主已在回收站的子行不单独占一行
    hide: Optional[Callable[[object, dict], bool]] = None
    before_purge: Optional[Callable[[object, Session], None]] = None


#: 回收站支持的类型白名单（路径参数只认这些 key）
KINDS = {
    "protocol": _Kind(
        model=ProtocolTemplate,
        label=lambda row, db: row.label or row.id,
        children=(("bindings", ProtocolBinding, ProtocolBinding.protocol_id),),
    ),
    "instruction": _Kind(
        model=Instruction,
        label=lambda row, db: row.name or row.code or row.id,
        children=(
            ("bindings", ProtocolBinding, ProtocolBinding.instruction_id),
            ("response_specs", ResponseSpec, ResponseSpec.instruction_id),
        ),
    ),
    "binding": _Kind(
        model=ProtocolBinding,
        label=lambda row, db: row.label or row.id,
        hide=lambda row, dead: (
            row.instruction_id in dead["instruction"]
            or row.protocol_id in dead["protocol"]
        ),
    ),
    "recipe": _Kind(
        model=FrameRecipe,
        label=lambda row, db: row.name or row.id,
        before_purge=_clear_recipe_links,
    ),
    "sequence": _Kind(
        model=Sequence,
        label=lambda row, db: row.name or row.id,
        children=(("steps", SequenceStep, SequenceStep.sequence_id),),
    ),
    "profile": _Kind(
        model=DeviceProfile,
        label=lambda row, db: row.label or row.id,
    ),
    "response_spec": _Kind(
        model=ResponseSpec,
        label=_spec_label,
        hide=lambda row, dead: row.instruction_id in dead["instruction"],
    ),
}


def _spec(kind: str) -> _Kind:
    spec = KINDS.get(kind)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Unknown trash kind: {kind}")
    return spec


def _trashed_row(spec: _Kind, row_id: str, db: Session):
    row = (
        db.query(spec.model).filter(spec.model.id == row_id).first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Not Found")
    if not is_trashed(row):
        raise HTTPException(status_code=400, detail="该条目不在回收站")
    return row


@router.get("", response_model=TrashList)
def list_trash(db: Session = Depends(get_db)) -> TrashList:
    """回收站条目（倒序 = 最近删的在前），已隐藏「被父行连带入站」的子行。"""
    rows_by_kind = {
        # 注意：这里是 `trashed()`（IS NOT NULL），不是业务读侧的 `alive()`
        kind: trashed(db.query(spec.model), spec.model)
        .order_by(spec.model.deleted_at.desc())
        .all()
        for kind, spec in KINDS.items()
    }
    dead = {
        "instruction": {r.id for r in rows_by_kind["instruction"]},
        "protocol": {r.id for r in rows_by_kind["protocol"]},
    }

    items: List[TrashItem] = []
    for kind, rows in rows_by_kind.items():
        spec = KINDS[kind]
        for row in rows:
            if spec.hide is not None and spec.hide(row, dead):
                continue
            items.append(
                TrashItem(
                    kind=kind,
                    id=row.id,
                    label=spec.label(row, db),
                    deleted_at=row.deleted_at,
                )
            )
    items.sort(key=lambda it: (it.deleted_at, it.kind, it.id), reverse=True)
    return TrashList(items=items, count=len(items))


@router.post("/{kind}/{row_id}/restore", response_model=TrashOpResponse)
def restore_trash_item(
    kind: str, row_id: str, db: Session = Depends(get_db)
) -> TrashOpResponse:
    """恢复：清标记 + 按「同父 + 同时间戳」把级联子行一并捞回。"""
    spec = _spec(kind)
    row = _trashed_row(spec, row_id, db)
    ts = row.deleted_at
    related = {
        name: restore_related(db.query(child), child, [fk == row.id], ts)
        for name, child, fk in spec.children
    }
    row.deleted_at = None
    db.commit()
    db.refresh(row)
    return TrashOpResponse(status="restored", kind=kind, id=row_id, related=related)


@router.delete("/{kind}/{row_id}", response_model=TrashOpResponse)
def purge_trash_item(
    kind: str, row_id: str, db: Session = Depends(get_db)
) -> TrashOpResponse:
    """彻底删除：真删行 + 按外键清掉引用者（不看时间戳，不留孤儿行）。"""
    spec = _spec(kind)
    row = _trashed_row(spec, row_id, db)
    related = {
        name: purge_related(db.query(child), child, [fk == row.id])
        for name, child, fk in spec.children
    }
    if spec.before_purge is not None:
        spec.before_purge(row, db)
    db.delete(row)
    db.commit()
    return TrashOpResponse(status="purged", kind=kind, id=row_id, related=related)
