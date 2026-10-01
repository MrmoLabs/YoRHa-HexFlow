import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.core.definition_hash import protocol_definition_hash
from backend.db.database import get_db
from backend.db.models import FrameRecipe, Instruction, ProtocolTemplate
# 槽定位复用 binding.py 的纯函数（同树深搜 dict 树）—— 不重复实现同一段遍历。
from backend.routers.binding import find_slot_node
from backend.schemas.recipe_api import (
    MAX_RECIPE_NAME,
    MAX_RECIPE_STAGES,
    RecipeCreate,
    RecipeResponse,
    RecipeStage,
    RecipeUpdate,
)

# CP3 3a (D13 拍板 A「封装配方 + 串行编译」): /recipes CRUD。
# 不做模块级 create_all —— 建表统一在 main.py lifespan（避免导入即写真实库），
# 后端单测用临时库文件直调本模块函数（不走 TestClient），镜像 binding.py 先例。
#
# 保存期校验 = DESIGN_CorePipeline §9.5-3「配方期（组合）」行，本批补：
#   stage 协议存在 404 / 槽存在且为 slot / 插槽重复 / 层数 1..4 / hash 回写。
# `definition_hash` 只在后端算（core/definition_hash.py），客户端传入忽略。

router = APIRouter(prefix="/recipes", tags=["recipes"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _check_name(raw: Optional[str]) -> str:
    name = (raw or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="配方名不能为空")
    if len(name) > MAX_RECIPE_NAME:
        raise HTTPException(status_code=400, detail=f"配方名最长 {MAX_RECIPE_NAME} 字")
    return name


def resolve_stages(db: Session, stages: List[RecipeStage]) -> List[dict]:
    """保存期阶段校验 + `definition_hash` 回写（§9.1 单项形态 / §9.5-3）。

    返回**落库形态**（dict 数组，hash 已按当前协议 children 算好）；任何越界
    走 HTTPException —— 协议缺失 404（同 protocol.py "Protocol not found"），
    其余 400 + 中文 detail（操作员直读）。纯读不 commit。
    """
    if not stages:
        raise HTTPException(status_code=400, detail="配方至少 1 层")
    if len(stages) > MAX_RECIPE_STAGES:
        raise HTTPException(
            status_code=400,
            detail=f"配方最多 {MAX_RECIPE_STAGES} 层（当前 {len(stages)} 层）",
        )

    out: List[dict] = []
    for index, stage in enumerate(stages):
        where = f"第 {index + 1} 层"
        protocol = (
            db.query(ProtocolTemplate)
            .filter(ProtocolTemplate.id == stage.protocol_id)
            .first()
        )
        if protocol is None:
            raise HTTPException(status_code=404, detail="Protocol not found")

        slot_ids = list(stage.slot_ids) if stage.slot_ids is not None else None
        if slot_ids:
            seen = set()
            for sid in slot_ids:
                if not sid:
                    continue  # null 位次 = 稠密（镜像 build_wrapped 口径）
                if sid in seen:
                    raise HTTPException(
                        status_code=400, detail=f"{where}：插槽重复分配：{sid}"
                    )
                seen.add(sid)
                node = find_slot_node(protocol.children, sid)
                if node is None:
                    raise HTTPException(
                        status_code=400,
                        detail=f"{where}：插槽不存在于所选协议：{sid}",
                    )
                if node.get("type") != "slot":
                    raise HTTPException(
                        status_code=400, detail=f"{where}：目标块不是插槽：{sid}"
                    )

        out.append(
            {
                "protocol_id": stage.protocol_id,
                "slot_ids": slot_ids,
                "definition_hash": protocol_definition_hash(protocol.children),
            }
        )
    return out


def _link_instruction(db: Session, recipe_id: str, instruction_id: str) -> None:
    """把指令的默认配方指到本配方（写 `instructions.default_recipe_id`）。

    单列 = 结构上天然唯一：新关联自动顶掉该指令的旧配方，无需清同事务。
    指令不存在 404。直调不 commit（与 binding.enforce_single_default 同口径）。
    """
    instruction = (
        db.query(Instruction).filter(Instruction.id == instruction_id).first()
    )
    if instruction is None:
        raise HTTPException(status_code=404, detail="Instruction not found")
    instruction.default_recipe_id = recipe_id


def _instruction_of(db: Session, recipe_id: str) -> Optional[str]:
    """反查当前指向本配方的指令 id（0 或 1 条）。"""
    row = (
        db.query(Instruction.id)
        .filter(Instruction.default_recipe_id == recipe_id)
        .first()
    )
    return row[0] if row else None


def _to_out(db: Session, row: FrameRecipe) -> RecipeResponse:
    return RecipeResponse(
        id=row.id,
        name=row.name,
        description=row.description,
        stages=[RecipeStage(**s) for s in (row.stages or [])],
        version=row.version or 1,
        instruction_id=_instruction_of(db, row.id),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("", response_model=List[RecipeResponse])
def get_recipes(db: Session = Depends(get_db), instruction_id: Optional[str] = None):
    # 降级链取配方走 ?instruction_id=（镜像 /bindings 先例）：按指令的
    # default_recipe_id 反查 → 0 或 1 条；无关联即空数组（不是 404）。
    if instruction_id is not None:
        instruction = (
            db.query(Instruction).filter(Instruction.id == instruction_id).first()
        )
        recipe_id = instruction.default_recipe_id if instruction else None
        if not recipe_id:
            return []
        row = db.query(FrameRecipe).filter(FrameRecipe.id == recipe_id).first()
        return [_to_out(db, row)] if row else []
    rows = db.query(FrameRecipe).order_by(
        FrameRecipe.created_at.asc(), FrameRecipe.id.asc()
    ).all()
    return [_to_out(db, row) for row in rows]


@router.post("", response_model=RecipeResponse)
def create_recipe(payload: RecipeCreate, db: Session = Depends(get_db)):
    stages = resolve_stages(db, payload.stages)
    name = _check_name(payload.name)

    recipe = FrameRecipe(
        id=payload.id or str(uuid.uuid4()),
        name=name,
        description=payload.description,
        stages=stages,
        version=1,
        created_at=_now(),
        updated_at=_now(),
    )
    db.add(recipe)
    if payload.instruction_id:
        _link_instruction(db, recipe.id, payload.instruction_id)
    db.commit()
    db.refresh(recipe)
    return _to_out(db, recipe)


@router.get("/{recipe_id}", response_model=RecipeResponse)
def get_recipe(recipe_id: str, db: Session = Depends(get_db)):
    recipe = db.query(FrameRecipe).filter(FrameRecipe.id == recipe_id).first()
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return _to_out(db, recipe)


@router.put("/{recipe_id}", response_model=RecipeResponse)
def update_recipe(recipe_id: str, payload: RecipeUpdate, db: Session = Depends(get_db)):
    recipe = db.query(FrameRecipe).filter(FrameRecipe.id == recipe_id).first()
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recipe not found")

    # 乐观并发（镜像 protocol.py 批次五口径）：带 version 必须与当前行一致，
    # 不符 409；先于内容校验（陈旧前置条件先拒）；None（curl 直调）跳过比对。
    if payload.version is not None and payload.version != (recipe.version or 1):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Recipe version conflict: expected {payload.version}, "
                f"current {recipe.version or 1}"
            ),
        )

    if payload.name is not None:
        recipe.name = _check_name(payload.name)
    if payload.description is not None:
        recipe.description = payload.description
    if payload.stages is not None:
        # 重新校验 + 重新回写 hash（协议可能已改 —— 保存期是「失效徽标」的消解点）
        recipe.stages = resolve_stages(db, payload.stages)
    if payload.instruction_id is not None:
        if payload.instruction_id == "":
            # 显式解除：清所有指向本配方的指令关联（单列反向，通常 0/1 条）
            db.query(Instruction).filter(
                Instruction.default_recipe_id == recipe_id
            ).update({"default_recipe_id": None}, synchronize_session=False)
        else:
            _link_instruction(db, recipe_id, payload.instruction_id)

    recipe.version = (recipe.version or 0) + 1
    recipe.updated_at = _now()
    db.commit()
    db.refresh(recipe)
    return _to_out(db, recipe)


@router.delete("/{recipe_id}")
def delete_recipe(recipe_id: str, db: Session = Depends(get_db)):
    recipe = db.query(FrameRecipe).filter(FrameRecipe.id == recipe_id).first()
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recipe not found")

    # 逻辑外键无 FK（同 protocol_bindings 删除级联先例）：引用本配方的指令
    # default_recipe_id 一并清 NULL，回执条数供前端提示（不静默留脏行）。
    cleared = (
        db.query(Instruction)
        .filter(Instruction.default_recipe_id == recipe_id)
        .update({"default_recipe_id": None}, synchronize_session=False)
    )
    db.delete(recipe)
    db.commit()
    return {"status": "deleted", "id": recipe_id, "cleared_instructions": cleared}
