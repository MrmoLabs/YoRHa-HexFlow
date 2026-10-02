import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.core import transport
from backend.db.database import get_db
from backend.db.models import DeviceProfile
from backend.db.soft_delete import alive, mark_deleted
from backend.db.transport_store import load_settings, save_config, set_active_profile
from backend.schemas.profile_api import ProfileCreate, ProfileResponse, ProfileUpdate

# P1 设备档案：传输配置的命名快照 CRUD + 激活（新表 device_profiles，仅新增）。
# 无模块级 create_all（同 E4 先例，建表归 lifespan）；单测临时库直调本模块函数。
# 语义：
# - 创建省略 config → 服务端快照当前生效配置；带 config → 完整三段并过
#   transport.validate_config（400 detail 为 SSOT），前端存/更一律送全量快照。
# - 快照值 == 当前生效配置 → 创建即标记激活（save_config 落 pointer）。
# - 激活 = transport.set_config（配置变更钩子会先落库并清 pointer）→ 路由末次
#   写回配置 + pointer，保证激活态不被钩子清掉。
# - 手工 POST /transport/config 经钩子落库并清 pointer（main.py lifespan 接线）。
# - 删除激活档案只清 pointer，不动生效配置。

router = APIRouter(prefix="/profiles", tags=["profiles"])


def _checked_label(db: Session, label, exclude_id: Optional[str] = None) -> str:
    cleaned = str(label or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="档案名不能为空")
    # R6（§8.43 已知取舍）：**不过滤回收站** —— device_profiles.label 是
    # inline UNIQUE（拍板 R6 只新增列、不重建表），软删行继续占名 → 回收站里
    # 还有同名档案时新建/改名 400「已存在」，先恢复或彻底删除才释放。
    query = db.query(DeviceProfile).filter(DeviceProfile.label == cleaned)
    if exclude_id is not None:
        query = query.filter(DeviceProfile.id != exclude_id)
    if query.first() is not None:
        raise HTTPException(status_code=400, detail=f"档案名已存在：{cleaned}")
    return cleaned


def _validated_config(config) -> dict:
    try:
        return transport.validate_config(config)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _active_id(db: Session) -> Optional[str]:
    row = load_settings(db)
    return row.active_profile_id if row is not None else None


def _response(profile: DeviceProfile, active_id: Optional[str]) -> ProfileResponse:
    is_active = active_id is not None and profile.id == active_id
    return ProfileResponse(
        id=profile.id,
        label=profile.label,
        config=profile.config,
        is_active=is_active,
        modified=is_active and profile.config != transport.get_config(),
    )


@router.get("", response_model=List[ProfileResponse])
def get_profiles(db: Session = Depends(get_db)) -> List[ProfileResponse]:
    # R6: 回收站行不进列表（alive = deleted_at IS NULL）
    rows = (
        alive(db.query(DeviceProfile), DeviceProfile)
        .order_by(DeviceProfile.label.asc(), DeviceProfile.id.asc())
        .all()
    )
    active_id = _active_id(db)
    return [_response(row, active_id) for row in rows]


@router.post("", response_model=ProfileResponse)
def create_profile(payload: ProfileCreate, db: Session = Depends(get_db)) -> ProfileResponse:
    label = _checked_label(db, payload.label)
    # 省略 config = 快照当前生效配置（天然合法）；显式 config 归一后入库
    config = transport.get_config() if payload.config is None else _validated_config(payload.config)

    profile = DeviceProfile(id=str(uuid.uuid4()), label=label, config=config)
    db.add(profile)
    db.commit()
    db.refresh(profile)

    # 快照即当前生效配置 → 创建即激活（pointer 同步落库）
    if config == transport.get_config():
        save_config(db, config, active_profile_id=profile.id)
        active_id = profile.id
    else:
        active_id = _active_id(db)
    return _response(profile, active_id)


@router.put("/{profile_id}", response_model=ProfileResponse)
def update_profile(
    profile_id: str, payload: ProfileUpdate, db: Session = Depends(get_db)
) -> ProfileResponse:
    profile = (
        alive(db.query(DeviceProfile), DeviceProfile)
        .filter(DeviceProfile.id == profile_id)
        .first()
    )
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    if payload.label is not None:
        profile.label = _checked_label(db, payload.label, exclude_id=profile.id)
    if payload.config is not None:
        # 只改档案快照，不动生效配置；激活中的档案随之进入 modified 态
        profile.config = _validated_config(payload.config)
    db.commit()
    db.refresh(profile)
    return _response(profile, _active_id(db))


@router.delete("/{profile_id}")
def delete_profile(profile_id: str, db: Session = Depends(get_db)):
    # R6（§8.43）：删除 = 打标记进回收站。激活指针仍照旧清（活行不许指向
    # 回收站行）→ 恢复档案后需重新激活（已知取舍，与配方指针同口径）。
    profile = (
        alive(db.query(DeviceProfile), DeviceProfile)
        .filter(DeviceProfile.id == profile_id)
        .first()
    )
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    if _active_id(db) == profile.id:
        set_active_profile(db, None)  # 清悬空指针，生效配置保持不变
    mark_deleted(profile)
    db.commit()
    return {"status": "deleted", "id": profile_id}


@router.post("/{profile_id}/activate", response_model=ProfileResponse)
def activate_profile(profile_id: str, db: Session = Depends(get_db)) -> ProfileResponse:
    profile = (
        alive(db.query(DeviceProfile), DeviceProfile)
        .filter(DeviceProfile.id == profile_id)
        .first()
    )
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    try:
        transport.set_config(profile.config)  # 生效时断开既有真实连接（同 APPLY 语义）
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"档案配置非法：{e}")

    # set_config 的持久化钩子会清 pointer → 末次写回配置 + 激活指针
    effective = transport.get_config()
    save_config(db, effective, active_profile_id=profile.id)
    return _response(profile, profile.id)
