from typing import Any, Dict, Optional

from pydantic import BaseModel

# P1 设备档案 API schema：传输配置的命名快照（config = 完整三段形态）。
# is_active = 最后激活的档案（transport_settings.active_profile_id 指针）；
# modified = 激活中但存储快照 ≠ 当前生效配置（激活后被「更新」改过、未再应用）。


class ProfileCreate(BaseModel):
    label: str
    # 省略 → 服务端快照当前生效配置；提供 → 必须完整三段（validate_config 为 SSOT）
    config: Optional[Dict[str, Any]] = None


class ProfileUpdate(BaseModel):
    # 全部可选：None = 不改（同 binding.py 局部更新先例）
    label: Optional[str] = None
    config: Optional[Dict[str, Any]] = None


class ProfileResponse(BaseModel):
    id: str
    label: str
    config: Dict[str, Any]
    is_active: bool = False
    modified: bool = False

    class Config:
        from_attributes = True
