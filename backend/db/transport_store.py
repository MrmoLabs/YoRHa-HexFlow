"""P1 连接持久化：transport_settings 单行表的读写与 lifespan 接线件。

- 写入口只有两处：transport 配置变更钩子（main.py lifespan 注册，落库并清激活
  指针）与 /profiles 激活（路由末次写入，配置 + 激活指针一起落）。
- 恢复（restore_transport_config）必须先于挂钩执行，避免启动时回写。
"""

from typing import Any, Callable, Dict, Optional

from sqlalchemy.orm import Session

from backend.core import transport
from backend.db.models import TransportSetting

_CURRENT = "current"


def load_settings(db: Session) -> Optional[TransportSetting]:
    """读取单行设置（无行 → None）。"""
    return db.query(TransportSetting).filter(TransportSetting.id == _CURRENT).first()


def save_config(db: Session, config: Dict[str, Any], active_profile_id: Optional[str]) -> None:
    """落库当前生效配置 + 激活档案指针（upsert 单行，两个字段一起写）。"""
    row = load_settings(db)
    if row is None:
        row = TransportSetting(id=_CURRENT)
        db.add(row)
    row.config = config
    row.active_profile_id = active_profile_id
    db.commit()


def set_active_profile(db: Session, profile_id: Optional[str]) -> None:
    """仅改激活指针（配置不动）；无行时无操作（激活必经 save_config 建行）。"""
    row = load_settings(db)
    if row is None:
        return
    row.active_profile_id = profile_id
    db.commit()


def restore_transport_config(db: Session) -> bool:
    """启动恢复：把落库配置交回 transport.set_config；无行/非法 → False（保持默认）。"""
    row = load_settings(db)
    if row is None or not row.config:
        return False
    try:
        transport.set_config(row.config)
    except ValueError:
        return False
    return True


def persist_hook(db_factory: Callable[[], Session]) -> Callable[[Dict[str, Any]], None]:
    """为 transport.set_persist_hook 造回调：每次配置变更以独立会话落库并清激活指针。"""

    def hook(config: Dict[str, Any]) -> None:
        db = db_factory()
        try:
            save_config(db, config, active_profile_id=None)
        finally:
            db.close()

    return hook
