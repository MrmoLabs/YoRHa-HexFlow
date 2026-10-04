"""C3 数据中心页一期（D1–D3）。

- D1 聚合导出：指令 JSON（与指令页导入格式对称，GET /instructions 同口径）+
  逐指令骨架帧 .bin / .hex 打包为 ZIP 下载。
  帧编译复用 /export 的 Orchestrator；字段 → 块映射口径与前端
  utils/toFrameBlocks.js 一致（children→container、LENGTH_CALC/CHECKSUM_CRC→
  length/checksum、其余→fixed）。B7 ARRAY_GROUP 展开等未实现编码语义不在此
  展开，产出的是结构骨架帧（未知长度字段以 0x00 占位或 byte_len=0 省略）。
- D2 备份 / 恢复：复制 yorha.db 到 backend/db/backups/；恢复前自动留安全快照，
  engine.dispose() 释放连接池 → 清理 -wal/-shm/-journal 残留 → 原子替换文件。
  运行中换库风险见 restore 端点 notice 与文档（恢复期间勿并发写入）。
- D3 环境状态：DB 路径 / 大小 / 修改时间、各表行数、后端版本、备份列表。
- 批次四 4a 关系数据：`relations.json`（protocol_bindings + response_specs）
  并入聚合导出 ZIP，`POST /datahub/import/relations` 按 id 回灌（逐行报告）。
  见 `DESIGN_CorePipeline.md` §7 批次四。
- PLAN §8.37 R1：关系数据回灌**前**自动留 `pre-import-*` 安全快照（镜像 D2 恢复前的
  `pre-restore` 先例，补「恢复有快照、导入没有」的风险不对称），响应新增
  `preImportSnapshot`；快照逻辑收在 `safety_snapshot()` —— R8 要补的其它导入端点
  直接复用。
- PLAN §8.45 R7（C-3 选 C · 导出补域）：聚合导出从 **3 域 → 8 域** —— 新增
  `recipes.json` / `sequences.json` / `transport.json` / `profiles.json` /
  `templates.json`；`manifest.json` 加 `domainVersion`（8 域清单，键序 = 导出序）
  与 `domainCounts`（逐域行数，**键集与 domainVersion 严格相等**）。既有三键
  （`instructionCount` / `relations` / `frames`）只做加法。**本批只做出线**，
  按域导入端点 = R8（快照复用 R1 的 `safety_snapshot()`）。
- PLAN §8.46 R8（C-3 选 C 收尾 · 按域导入）：5 个新域补回灌 —— `POST /datahub/import/`
  加 `recipes` / `sequences` / `transport` / `profiles` / `templates`，回执统一
  `{domain, imported, updated, skipped, warnings, preImportSnapshot}`；三段式 =
  ① 纯函数顶层校验（400 **不落快照**）→ ② `pre-import` 快照（复用 R1）→ ③ 逐行
  upsert、部分成功即部分落库。校验复用各域 SSOT（`recipe.resolve_stages` /
  `sequence.normalize_sequence` / `transport.validate_config`），不写第二套口径。

纯函数（fields_to_blocks / compile_blocks / frame_bytes / format_hex_text /
build_bundle / sanitize_filename / validate_backup_name / create_backup /
replace_database_file / list_backups）由 backend/tests/test_datahub.py 用
stdlib unittest 直测，无新增依赖。

PLAN §8.43 R6-1：聚合导出 / 状态面板计数 / 导入的存在性校验一律 `alive()`
过滤 —— 回收站行既不进下载包（`deleted_at` 不在导出列子里，回灌后也是活行）
也不进计数。
"""
import io
import json
import re
import shutil
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from pydantic import BaseModel, ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session


from backend.core import diagnostics as diag
from backend.core import sequence_runner, transport
from backend.core.field_blocks import _presence_hit, fields_to_blocks  # noqa: F401 —— 纯搬入 core 后原名再导出（行为逐字不变）
from backend.core.orchestrator import Orchestrator
from backend.core.response_match import normalize_spec
# R6（§8.43）：导出 / 状态 / 导入校验都是**读端点** → 只认活行
from backend.db.soft_delete import alive
from backend.db.database import (
    Base,
    DB_PATH,
    SessionLocal,
    ensure_binding_columns,
    ensure_protocol_version_column,
    ensure_recipe_columns,
    ensure_response_spec_columns,
    ensure_sequence_step_columns,
    engine,
    get_db,
)
from backend.db.migrate import MigrationError, run_pending_migrations
from backend.db.models import (
    BitField,
    DeviceProfile,
    FrameRecipe,
    Instruction,
    InstructionField,
    OperatorTemplate,
    ProtocolBinding,
    ProtocolTemplate,
    ResponseSpec,
    Sequence,
    SequenceStep,
    TransportSetting,
)
from backend.db.transport_store import restore_transport_config
from backend.routers.binding import find_slot_node
from backend.routers.instruction import serialize_instruction
from backend.routers.recipe import resolve_stages
from backend.routers.response_spec import _stage_mirror
from backend.routers.sequence import normalize_sequence, write_steps
from backend.schemas.block import Block
from backend.schemas.recipe_api import RecipeStage
from backend.schemas.sequence_api import SequenceStepSpec

router = APIRouter(prefix="/datahub", tags=["datahub"])

# README 未声明语义化版本；D3 环境状态面板以此为后端版本口径。
APP_VERSION = "0.2.0"
BACKUP_DIR = DB_PATH.parent / "backups"

_SIDE_SUFFIXES = ("-wal", "-shm", "-journal")


# --------------------------------------------------------------------------
# 纯函数：D1 聚合导出
# --------------------------------------------------------------------------

def sanitize_filename(name, fallback="instruction"):
    """把任意代码/名称压成安全的单段文件名片段（无路径分隔符、无 `..` 串）。"""
    safe = re.sub(r"\.{2,}", "_", str(name or ""))  # 折叠 '..' 连点
    safe = re.sub(r"[^\w.\-]+", "_", safe, flags=re.UNICODE)
    safe = safe.strip("._")
    return safe or fallback


def compile_blocks(block_dicts):
    """块森林（dict 树）→ Orchestrator 编译出的 hex 串。"""
    return Orchestrator([Block(**b) for b in block_dicts]).process()


def frame_bytes(hex_string):
    """hex 串（允许空格/下划线分隔）→ 原始字节；空串 → b""（不报错）。"""
    cleaned = re.sub(r"[\s,_-]", "", hex_string or "")
    if not cleaned:
        return b""
    if len(cleaned) % 2 != 0:
        raise ValueError("hex 位数为奇数")
    return bytes.fromhex(cleaned)


def format_hex_text(data):
    """原始字节 → 与 /export/hex 相同的可读 .hex 文本（大写空格分隔 + 换行）。"""
    return " ".join(f"{byte:02X}" for byte in data) + "\n"


def instructions_export_payload(instructions):
    """ORM 指令列表 → 导出 JSON 载荷（与指令页 analyzeImport 输入格式对称）。"""
    return {
        "schemaVersion": 1,
        "exportedAt": datetime.now().isoformat(timespec="seconds"),
        "instructions": [serialize_instruction(i).model_dump(mode="json") for i in instructions],
    }


def build_bundle(entries):
    """[(zip 内路径, bytes), ...] → ZIP 字节（deflate）。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for arcname, data in entries:
            zf.writestr(arcname, data)
    return buf.getvalue()


# --------------------------------------------------------------------------
# 纯函数：D2 备份 / 恢复（文件级，可注入路径，单测不碰真库）
# --------------------------------------------------------------------------

def validate_backup_name(name, backup_dir):
    """校验恢复源文件名：仅允许备份目录内的平面 `*.db`（阻断路径穿越）。

    返回绝对路径；非法或不存在抛 ValueError。
    """
    raw = str(name or "")
    if not raw or "/" in raw or "\\" in raw or ".." in raw:
        raise ValueError(f"非法备份文件名：{raw or '(空)'}")
    if not re.fullmatch(r"[\w.\-]+\.db", raw):
        raise ValueError("备份名必须以 .db 结尾且仅含字母数字 . _ -")
    path = Path(backup_dir) / raw
    if not path.is_file():
        raise ValueError(f"备份不存在：{raw}")
    return path


def create_backup(db_path, backup_dir, now=None, prefix="yorha"):
    """复制 db_path 到备份目录，返回目标路径（同秒冲突自动加序号）。"""
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    Path(backup_dir).mkdir(parents=True, exist_ok=True)
    dest = Path(backup_dir) / f"{prefix}-{stamp}.db"
    seq = 1
    while dest.exists():
        dest = Path(backup_dir) / f"{prefix}-{stamp}-{seq}.db"
        seq += 1
    shutil.copy2(db_path, dest)
    return dest


def replace_database_file(source, db_path):
    """用 source 覆盖 db_path，并清理 SQLite WAL/SHM/journal 残留。

    先复制到同目录临时文件 → 删残留 → 原子 rename，避免旧 WAL 被 SQLite
    重放到新库上造成损坏。调用方必须先 engine.dispose()：Windows 下目标
    文件被空闲连接占用时替换会 PermissionError。
    """
    db_path = Path(db_path)
    tmp = db_path.with_name(db_path.name + ".restore-tmp")
    try:
        shutil.copy2(source, tmp)
        for suffix in _SIDE_SUFFIXES:
            side = db_path.with_name(db_path.name + suffix)
            if side.exists():
                side.unlink()
        tmp.replace(db_path)
    finally:
        if tmp.exists():
            tmp.unlink()


def list_backups(backup_dir):
    """备份目录 → 按修改时间倒序的备份条目列表（目录不存在 → []）。"""
    directory = Path(backup_dir)
    if not directory.is_dir():
        return []
    items = []
    for path in sorted(directory.glob("*.db"), key=lambda p: p.stat().st_mtime, reverse=True):
        items.append(_backup_entry(path))
    return items


# 安全快照的文件名前缀（危险写操作前自动留）：`_backup_entry` 据此打 [快照] 徽标，
# 备份列表里一眼能看出「这是出事时回退用的，不是手建的备份」。
SAFETY_SNAPSHOT_PREFIXES = ("pre-restore-", "pre-import-")


def _backup_entry(path):
    stat = path.stat()
    return {
        "name": path.name,
        "sizeBytes": stat.st_size,
        "modifiedAt": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
        "isSafetySnapshot": path.name.startswith(SAFETY_SNAPSHOT_PREFIXES),
    }


def safety_snapshot(prefix, scenario, db_path=None, backup_dir=None):
    """危险写操作**之前**留安全快照（PLAN §8.37 R1）→ 快照文件名；无可快照 → None。

    镜像 `/datahub/restore` 里 `pre-restore` 的先例，把「先快照、失败即中止」这条
    不变量收在一处（本批接关系数据回灌用的 `pre-import`；R8 要补的其它导入端点直接
    复用，不必各写一遍）。

    - `db_path` / `backup_dir` 缺省取模块级 `DB_PATH` / `BACKUP_DIR`（**运行时**取值，
      测试可替换）；
    - 库文件还不存在 → 返回 `None` 且**不报错**（首次使用前无从快照）；
    - `OSError` → HTTPException 500、消息带场景词 —— 此时**库一个字节都没动**：
      「先快照后写库」比「先写库再补快照」才真能兜底。
    """
    path = DB_PATH if db_path is None else Path(db_path)
    directory = BACKUP_DIR if backup_dir is None else Path(backup_dir)
    if not path.exists():
        return None
    try:
        return create_backup(path, directory, prefix=prefix).name
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"安全快照失败，已中止{scenario}：{exc}")


# --------------------------------------------------------------------------
# 批次四 4a（DESIGN_CorePipeline §7 批次四 ①）：关系数据（protocol_bindings +
# response_specs）并入聚合导出 ZIP 与回灌端点。
#
# 口径：
# - 导出形 `relations.json` = {schemaVersion, bindings[], responseSpecs[]}，
#   字段与 ORM 行一一对应（`definition_hash` 原样带出）。
# - 导入 = **恢复语义**（非手工编辑）：按 `id` upsert、逐行报告不整批回滚，
#   出处指纹原样回填 —— 目标库协议若已不同，读侧 `stale` 徽标自然点亮（D7-A）。
# - `stage` 不信文件、按 `spec.stages` 重算镜像（SSOT = `_stage_mirror`），
#   `spec` 过 `normalize_spec` 归一（非法行跳过，不 400 整批）。
# - 父不存在 → 跳过并给 reason；槽悬空 → **置 NULL 并记 warning**（§6.2 口径，
#   不静默、也不整行丢弃）；`is_default` 冲突 → 清同指令旧行（默认唯一不变量）。
# --------------------------------------------------------------------------

RELATIONS_SCHEMA_VERSION = 1
_RELATIONS_KEYS = {"schemaVersion", "bindings", "responseSpecs"}


def binding_export_row(row) -> dict:
    """ProtocolBinding → relations.json 条目（列序与 models.py 一致）。"""
    return {
        "id": row.id,
        "protocol_id": row.protocol_id,
        "instruction_id": row.instruction_id,
        "label": row.label,
        "slot_order": row.slot_order,
        "slot_id": row.slot_id,
        "is_default": row.is_default,
        "priority": row.priority,
        "definition_hash": row.definition_hash,
    }


def response_spec_export_row(row) -> dict:
    """ResponseSpec → relations.json 条目（spec 原样、stage 镜像随行带出）。"""
    return {
        "id": row.id,
        "instruction_id": row.instruction_id,
        "spec": row.spec,
        "stage": row.stage,
        "definition_hash": row.definition_hash,
    }


def relations_export_payload(bindings, response_specs) -> dict:
    """relations.json 载荷（与 GET /datahub/export/bundle 内该文件同形）。"""
    return {
        "schemaVersion": RELATIONS_SCHEMA_VERSION,
        "bindings": [binding_export_row(b) for b in bindings],
        "responseSpecs": [response_spec_export_row(s) for s in response_specs],
    }


def _relations_payload(payload):
    """顶层校验（严格键集，未知键 400）→ (bindings, responseSpecs) 两个 list。"""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="关系数据必须是 JSON 对象")
    unknown = sorted(set(payload) - _RELATIONS_KEYS)
    if unknown:
        raise HTTPException(status_code=400, detail=f"关系数据未知字段: {', '.join(unknown)}")
    version = payload.get("schemaVersion")
    if version not in (None, RELATIONS_SCHEMA_VERSION):
        raise HTTPException(status_code=400, detail=f"不支持的 schemaVersion: {version!r}")
    bindings = payload.get("bindings", [])
    specs = payload.get("responseSpecs", [])
    bindings = [] if bindings is None else bindings
    specs = [] if specs is None else specs
    if not isinstance(bindings, list) or not isinstance(specs, list):
        raise HTTPException(status_code=400, detail="bindings / responseSpecs 必须是数组")
    return bindings, specs


def _skip(sink, index, row, reason):
    sink.append({
        "index": index,
        "id": row.get("id") if isinstance(row, dict) else None,
        "reason": reason,
    })


def import_relations(db: Session, payload) -> dict:
    """回灌 relations.json：逐行 upsert，返回 {bindings, responseSpecs, warnings}。

    每行独立提交 —— 单行唯一约束冲突只回滚该行（`IntegrityError` → 跳过），
    已成功行保留；调用方无需事务包裹。纯函数之外的唯一副作用是 db 会话写入。
    """
    raw_bindings, raw_specs = _relations_payload(payload)
    report = {
        "bindings": {"imported": 0, "updated": 0, "skipped": []},
        "responseSpecs": {"imported": 0, "updated": 0, "skipped": []},
        "warnings": [],
    }

    for index, row in enumerate(raw_bindings):
        sink = report["bindings"]["skipped"]
        if not isinstance(row, dict):
            _skip(sink, index, row, "条目必须是对象")
            continue
        binding_id = row.get("id")
        protocol_id = row.get("protocol_id")
        instruction_id = row.get("instruction_id")
        if not binding_id or not protocol_id or not instruction_id:
            _skip(sink, index, row, "缺 id / protocol_id / instruction_id")
            continue
        if alive(db.query(Instruction), Instruction).filter(Instruction.id == instruction_id).first() is None:
            _skip(sink, index, row, f"指令不存在：{instruction_id}")
            continue
        protocol = alive(db.query(ProtocolTemplate), ProtocolTemplate).filter(ProtocolTemplate.id == protocol_id).first()
        if protocol is None:
            _skip(sink, index, row, f"协议不存在：{protocol_id}")
            continue

        slot_id = row.get("slot_id") or None
        if slot_id:
            node = find_slot_node(protocol.children, slot_id)
            if node is None or node.get("type") != "slot":
                report["warnings"].append(
                    f"绑定 {binding_id} 的 slot_id 悬空已置空：{slot_id}（协议 {protocol_id} 无此插槽）"
                )
                slot_id = None

        is_default = 1 if row.get("is_default") else 0
        label = row.get("label") or "新绑定 (NEW)"
        try:
            slot_order = int(row.get("slot_order") or 0)
        except (TypeError, ValueError):
            _skip(sink, index, row, "slot_order 必须是整数")
            continue
        try:
            priority = int(row.get("priority") or 0)
        except (TypeError, ValueError):
            _skip(sink, index, row, "priority 必须是整数")
            continue
        definition_hash = row.get("definition_hash") or None

        if is_default:
            # 默认唯一不变量：清同指令其它行（镜像 create_binding 同事务口径）
            db.query(ProtocolBinding).filter(
                ProtocolBinding.instruction_id == instruction_id,
                ProtocolBinding.id != binding_id,
                ProtocolBinding.is_default == 1,
            ).update({"is_default": 0}, synchronize_session=False)

        existing = db.query(ProtocolBinding).filter(ProtocolBinding.id == binding_id).first()
        kind = "updated" if existing else "imported"
        try:
            if existing:
                existing.protocol_id = protocol_id
                existing.instruction_id = instruction_id
                existing.label = label
                existing.slot_order = slot_order
                existing.slot_id = slot_id
                existing.is_default = is_default
                existing.priority = priority
                existing.definition_hash = definition_hash
            else:
                db.add(ProtocolBinding(
                    id=binding_id, protocol_id=protocol_id, instruction_id=instruction_id,
                    label=label, slot_order=slot_order, slot_id=slot_id,
                    is_default=is_default, priority=priority,
                    definition_hash=definition_hash,
                ))
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            _skip(sink, index, row, f"唯一约束冲突：{exc.orig}")
            continue
        report["bindings"][kind] += 1

    for index, row in enumerate(raw_specs):
        sink = report["responseSpecs"]["skipped"]
        if not isinstance(row, dict):
            _skip(sink, index, row, "条目必须是对象")
            continue
        spec_id = row.get("id")
        instruction_id = row.get("instruction_id")
        raw_spec = row.get("spec")
        if not spec_id or not instruction_id:
            _skip(sink, index, row, "缺 id / instruction_id")
            continue
        if alive(db.query(Instruction), Instruction).filter(Instruction.id == instruction_id).first() is None:
            _skip(sink, index, row, f"指令不存在：{instruction_id}")
            continue
        if not isinstance(raw_spec, dict):
            _skip(sink, index, row, "spec 必须是对象")
            continue
        try:
            spec = normalize_spec(raw_spec)
        except (ValueError, TypeError) as exc:
            _skip(sink, index, row, f"spec 非法：{exc}")
            continue
        clash = db.query(ResponseSpec).filter(
            ResponseSpec.instruction_id == instruction_id,
            ResponseSpec.id != spec_id,
        ).first()
        if clash is not None:
            _skip(sink, index, row, f"该指令已有应答规格（行 {clash.id}）")
            continue
        definition_hash = row.get("definition_hash") or None
        stage = _stage_mirror(spec)
        existing = db.query(ResponseSpec).filter(ResponseSpec.id == spec_id).first()
        kind = "updated" if existing else "imported"
        try:
            if existing:
                existing.instruction_id = instruction_id
                existing.spec = spec
                existing.stage = stage
                existing.definition_hash = definition_hash
            else:
                db.add(ResponseSpec(
                    id=spec_id, instruction_id=instruction_id, spec=spec,
                    stage=stage, definition_hash=definition_hash,
                ))
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            _skip(sink, index, row, f"唯一约束冲突：{exc.orig}")
            continue
        report["responseSpecs"][kind] += 1

    return report


# --------------------------------------------------------------------------
# R7（PLAN §8.45 · §8.37 R7 行 · C-3 选 C）：导出补域 —— 原 3 域 → 8 域
# --------------------------------------------------------------------------
# 本批**只做出线，不碰导入**（按域导入端点 = R8；pre-import 快照已在 R1 复用）。
#
# 域清单 = `BUNDLE_DOMAIN_VERSIONS` 的键（8 个，键序即导出序）：
#   instructions / relations / frames 是改前就有的 3 域；
#   recipes / sequences / transport / profiles / templates 是本批新增的 5 域
#   （拍板「bundle 增 5 域」的那 5 张缺表 → 5 个新 JSON 文件）。
#
# 纪律一：**读端点只出活行**（R6 §8.43）—— 回收站行不进包，`sequence_steps`
#   随宿主同进同出（宿主已删则其步骤一步都不出）。
# 纪律二：**列子集不含 `deleted_at`** —— 日后按域回灌得到的恒是活行，
#   不会把源机的回收站状态搬过去（与 R6-1「导出列子集本无 deleted_at」一致）。
# 纪律三：既有三键（`instructionCount` / `relations` / `frames`）**只做加法**，
#   旧消费方读 manifest 一个字段都不用改。
RECIPES_SCHEMA_VERSION = 1
SEQUENCES_SCHEMA_VERSION = 1
TRANSPORT_SCHEMA_VERSION = 1
PROFILES_SCHEMA_VERSION = 1
TEMPLATES_SCHEMA_VERSION = 1

# 8 域清单（键序 = 导出序 = manifest.domainVersion 的键序）。值 = 该域自己的
# schemaVersion：instructions/relations 直接取各自文件内的 `schemaVersion`，
# 三个既有域本批不改版（仍是 1），新域从 1 起。
BUNDLE_DOMAIN_VERSIONS = {
    "instructions": 1,
    "relations": 1,
    "frames": 1,
    "recipes": RECIPES_SCHEMA_VERSION,
    "sequences": SEQUENCES_SCHEMA_VERSION,
    "transport": TRANSPORT_SCHEMA_VERSION,
    "profiles": PROFILES_SCHEMA_VERSION,
    "templates": TEMPLATES_SCHEMA_VERSION,
}


def recipe_export_row(row) -> dict:
    """FrameRecipe → recipes.json 条目（stages 原样，列序与 models.py 一致）。"""
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "stages": row.stages,
        "version": row.version,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def recipes_export_payload(recipes) -> dict:
    """recipes.json 载荷（形状镜像 relations.json：schemaVersion + 单一数组）。"""
    return {
        "schemaVersion": RECIPES_SCHEMA_VERSION,
        "recipes": [recipe_export_row(r) for r in recipes],
    }


def sequence_step_export_row(row) -> dict:
    """SequenceStep → sequences.json 内嵌步骤（冻结帧快照整行带走，不拆列）。"""
    return {
        "id": row.id,
        "step_order": row.step_order,
        "instruction_id": row.instruction_id,
        "label": row.label,
        "delay_ms": row.delay_ms,
        "params": row.params,
        "payload": row.payload,
        "plan": row.plan,
        # R26: 条件也带走（漏了 → 导出再导入会静默丢分支，往返不等价）
        "condition": getattr(row, "condition", None),
        "wrap": row.wrap,
    }


def sequence_export_row(row, steps) -> dict:
    """Sequence + 其步骤 → sequences.json 条目（步骤内嵌，宿主-从属同进同出）。"""
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "config": row.config,
        "steps": [sequence_step_export_row(s) for s in steps],
    }


def sequences_export_payload(sequences, steps) -> dict:
    """sequences.json 载荷：序列按 (name, id) 排（镜像 `GET /sequences`）。

    `steps` = 已查出的步骤（调用方限定 `sequence_id IN (导出序列)`），此处按
    `sequence_id` 分组后内嵌；**步骤不单独成域** —— 宿主不在包里则其步骤不出现，
    组内保持调用方给定的 (step_order, id) 顺序。
    """
    grouped = {}
    for step in steps:
        grouped.setdefault(step.sequence_id, []).append(step)
    return {
        "schemaVersion": SEQUENCES_SCHEMA_VERSION,
        "sequences": [
            sequence_export_row(seq, grouped.get(seq.id, [])) for seq in sequences
        ],
    }


def transport_export_payload(settings) -> dict:
    """transport.json 载荷（单行约定：id 恒为 `current`，仍用数组统一形状）。

    `active_profile_id` 是逻辑指针 —— 本批只出线、原样带走；目标机上档案是否存在
    （以及指针是否该清空）由 R8 的按域导入决定。
    """
    return {
        "schemaVersion": TRANSPORT_SCHEMA_VERSION,
        "settings": [
            {"id": row.id, "config": row.config, "active_profile_id": row.active_profile_id}
            for row in settings
        ],
    }


def profile_export_row(row) -> dict:
    """DeviceProfile → profiles.json 条目（label 唯一，是档案的自然键）。

    R20（§8.50 ②-3）：随行带 `sort_order` —— 自定义序进包、按域回灌即还原；
    **行序仍按 label 升序**（导出可 diff：一次拖拽不该把整个文件的行序掀了），
    未重排的行是 0。旧包没有这个键 → 回灌按「缺席」处理（不覆盖目标库已有的序）。
    """
    return {
        "id": row.id,
        "label": row.label,
        "config": row.config,
        "sort_order": row.sort_order or 0,
    }


def profiles_export_payload(profiles) -> dict:
    """profiles.json 载荷（行序 = 调用方给定的 label 升序，导出可 diff）。"""
    return {
        "schemaVersion": PROFILES_SCHEMA_VERSION,
        "profiles": [profile_export_row(p) for p in profiles],
    }


def template_export_row(row) -> dict:
    """OperatorTemplate → templates.json 条目（op_code 是主键）。"""
    return {
        "op_code": row.op_code,
        "name": row.name,
        "category": row.category,
        "param_template": row.param_template,
        "description": row.description,
    }


def templates_export_payload(templates) -> dict:
    """templates.json 载荷（行序 = op_code 升序，导出可 diff）。"""
    return {
        "schemaVersion": TEMPLATES_SCHEMA_VERSION,
        "templates": [template_export_row(t) for t in templates],
    }


def bundle_manifest(instruction_payload, relations, extra_payloads, frames, domains=None) -> dict:
    """manifest.json 载荷（**纯函数**，便于单测钉「8 域清单」）。

    - `domainVersion`：8 域清单（键序 = 导出序），值 = 该域 schemaVersion。
      下游按它判断「这包能不能按域回灌」—— 版本不同即拒（R8 的按域导入用）。
    - `domainCounts`：**键集必须与 `domainVersion` 严格相等**（少一域、多一域
      都算 bug），值 = 该域行数；`sequences` 计的是序列数（步骤数看该文件本身）。
    - `instructionCount` / `relations` / `frames` 三键为存量键，**只做加法不变**。

    R17（§8.49）按域独立导出：`domains` 非 None 时 `domainVersion` · `domainCounts`
    **只留包里真有的域**（键序仍按 8 域表，不是按用户给的顺序）—— manifest 描述的是
    **这个包**而不是源库。`domains=None`（缺省）= 现行 8 域**逐字不变**；三个存量子键
    一律取**传进来的载荷**（未选中的域在 export_bundle 侧已清成 0 行形态）。
    """
    counts = {
        "instructions": len(instruction_payload["instructions"]),
        "relations": len(relations["bindings"]) + len(relations["responseSpecs"]),
        "frames": len(frames),
        "recipes": len(extra_payloads["recipes"]["recipes"]),
        "sequences": len(extra_payloads["sequences"]["sequences"]),
        "transport": len(extra_payloads["transport"]["settings"]),
        "profiles": len(extra_payloads["profiles"]["profiles"]),
        "templates": len(extra_payloads["templates"]["templates"]),
    }
    expected = list(BUNDLE_DOMAIN_VERSIONS)
    if list(counts) != expected:
        raise ValueError(
            f"域清单不一致：counts={list(counts)} vs domains={expected}"
        )
    # R17：按域导出只留真在包里的域（键序仍按 8 域表，不是按用户给的顺序）；
    # 缺省 domains=None = 全 8 域，逐字不变。
    keep = expected if domains is None else [
        name for name in expected if name in set(domains)
    ]
    return {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "appVersion": APP_VERSION,
        "domainVersion": {name: BUNDLE_DOMAIN_VERSIONS[name] for name in keep},
        "domainCounts": {name: counts[name] for name in keep},
        "instructionCount": len(instruction_payload["instructions"]),
        "relations": {
            "bindings": len(relations["bindings"]),
            "responseSpecs": len(relations["responseSpecs"]),
        },
        "frames": frames,
    }


# --------------------------------------------------------------------------
# R8（PLAN §8.46 · §8.37 R8 行 · C-3 选 C 收尾）：按域导入 —— R7 出线的 5 域补回灌
# --------------------------------------------------------------------------
# 口径全部复用 CP4-4a `POST /datahub/import/relations` 的三条纪律，不另起炉灶：
#   ① **顶层校验是纯函数**，400 之前既不落快照也不碰库；
#   ② **逐行独立提交** —— 校验失败 / 唯一约束冲突只回滚该行，`skipped` 带
#      index + id + reason，**部分成功即部分落库**、不整批回滚；
#   ③ **导入前先留 `pre-import` 快照**（复用 R1 的 `safety_snapshot()`），
#      响应回 `preImportSnapshot`。
# 校验**不重写第二套**：配方 = `recipe.resolve_stages`（层上限 / 插槽归属 /
# `definition_hash` 按**目标机**协议重算）、序列 = `sequence.normalize_sequence`
# （名字唯一含回收站占名 / config 严格键集 / 步骤 plan·wrap 冻结）、传输与档案 =
# `core.transport.validate_config`（ValueError → 400 的 SSOT）。datahub 只负责
# 「逐行 upsert + 逐行报告 + 快照」。
#
# 回收站（R6 §8.43）：**宿主在站里一律按不存在处理** —— 配方的协议、序列的指令
# 缺失 → 单行跳过；**id 自己在站里**则跳过并提示「先恢复或彻底删除」（软删行继续
# 占唯一键，直接 upsert 会写出一条看不见的行）。


def _domain_rows(payload, key, expected, filename):
    """按域载荷的**顶层**校验（纯函数，镜像 `_relations_payload` 的 400 口径）。"""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail=f"{filename} 载荷必须是对象")
    unknown = set(payload) - {key, "schemaVersion", "exportedAt"}
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"未知顶层键：{', '.join(sorted(unknown))}"
        )
    version = payload.get("schemaVersion")
    if version not in (None, expected):
        raise HTTPException(
            status_code=400, detail=f"{filename} schemaVersion 不支持：{version}"
        )
    rows = payload.get(key)
    if not isinstance(rows, list):
        raise HTTPException(status_code=400, detail=f"缺 {key} 数组（不是 {filename}）")
    return rows


def _domain_report(domain):
    """逐域回执骨架（键序固定 → 前端与单测都按这四键读）。"""
    return {"domain": domain, "imported": 0, "updated": 0, "skipped": [], "warnings": []}


def recipes_rows(payload) -> list:
    return _domain_rows(payload, "recipes", RECIPES_SCHEMA_VERSION, "recipes.json")


def sequences_rows(payload) -> list:
    return _domain_rows(payload, "sequences", SEQUENCES_SCHEMA_VERSION, "sequences.json")


def transport_rows(payload) -> list:
    return _domain_rows(payload, "settings", TRANSPORT_SCHEMA_VERSION, "transport.json")


def profiles_rows(payload) -> list:
    return _domain_rows(payload, "profiles", PROFILES_SCHEMA_VERSION, "profiles.json")


def templates_rows(payload) -> list:
    return _domain_rows(payload, "templates", TEMPLATES_SCHEMA_VERSION, "templates.json")


def import_recipes(db: Session, payload) -> dict:
    """回灌 `recipes.json`：逐行 upsert，父协议缺失 / 阶段非法 → 单行跳过。

    `definition_hash` **不采信载荷** —— `resolve_stages` 按目标机的协议 children
    重算，配方搬到新机器当场就知道与源机是否同构。
    """
    rows = recipes_rows(payload)
    report = _domain_report("recipes")
    sink = report["skipped"]
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            _skip(sink, index, row, "条目必须是对象")
            continue
        recipe_id = row.get("id")
        name = str(row.get("name") or "").strip()
        if not recipe_id or not name:
            _skip(sink, index, row, "缺 id / name")
            continue
        raw_stages = row.get("stages")
        if not isinstance(raw_stages, list) or not raw_stages:
            _skip(sink, index, row, "stages 必须是非空数组")
            continue

        specs, reason = [], None
        for pos, raw in enumerate(raw_stages):
            if not isinstance(raw, dict) or not raw.get("protocol_id"):
                reason = f"stages[{pos}] 缺 protocol_id"
                break
            protocol_id = raw["protocol_id"]
            if alive(db.query(ProtocolTemplate), ProtocolTemplate).filter(
                ProtocolTemplate.id == protocol_id
            ).first() is None:
                reason = f"协议不存在：{protocol_id}"
                break
            try:
                specs.append(RecipeStage(
                    protocol_id=protocol_id,
                    slot_ids=raw.get("slot_ids"),
                    definition_hash=raw.get("definition_hash"),
                ))
            except ValidationError as exc:
                reason = f"stages[{pos}] 形态非法：{exc.errors()[0].get('msg')}"
                break
        if reason:
            _skip(sink, index, row, reason)
            continue

        try:
            stages = resolve_stages(db, specs)
        except HTTPException as exc:
            _skip(sink, index, row, f"阶段校验失败：{exc.detail}")
            continue

        existing = db.query(FrameRecipe).filter(FrameRecipe.id == recipe_id).first()
        if existing is not None and existing.deleted_at:
            _skip(sink, index, row, f"该配方在回收站中：{recipe_id}（先恢复或彻底删除）")
            continue
        version = row.get("version")
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            version = 1
        kind = "updated" if existing else "imported"
        stamp = datetime.now().isoformat(timespec="seconds")
        try:
            if existing:
                existing.name = name
                existing.description = row.get("description")
                existing.stages = stages
                existing.version = version
                existing.updated_at = stamp
            else:
                db.add(FrameRecipe(
                    id=recipe_id, name=name, description=row.get("description"),
                    stages=stages, version=version, created_at=stamp, updated_at=stamp,
                ))
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            _skip(sink, index, row, f"唯一约束冲突：{exc.orig}")
            continue
        report[kind] += 1
    return report


def import_sequences(db: Session, payload) -> dict:
    """回灌 `sequences.json`：序列 + **内嵌步骤**整行进退（宿主-从属同进同出）。

    任一步骤的宿主指令不在（回收站 / 没搬过来）→ **整条序列跳过**，不写一条缺步的
    序列。归一走 `sequence.normalize_sequence`、步骤整体替换走 `write_steps`（删旧写新，
    镜像 `update_sequence` 的单事务口径）；实际写入步数回报在 `steps.written`。
    """
    rows = sequences_rows(payload)
    report = _domain_report("sequences")
    report["steps"] = {"written": 0}
    sink = report["skipped"]
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            _skip(sink, index, row, "条目必须是对象")
            continue
        sequence_id = row.get("id")
        raw_steps = row.get("steps")
        if not sequence_id:
            _skip(sink, index, row, "缺 id")
            continue
        if not isinstance(raw_steps, list):
            _skip(sink, index, row, "steps 必须是数组")
            continue

        broken = None
        for pos, raw in enumerate(raw_steps):
            if not isinstance(raw, dict) or not raw.get("instruction_id"):
                broken = f"steps[{pos}] 缺 instruction_id"
                break
            instruction_id = raw["instruction_id"]
            if alive(db.query(Instruction), Instruction).filter(
                Instruction.id == instruction_id
            ).first() is None:
                broken = f"指令不存在：{instruction_id}"
                break
        if broken:
            _skip(sink, index, row, broken)
            continue

        try:
            specs = [SequenceStepSpec.model_validate(raw) for raw in raw_steps]
        except ValidationError as exc:
            _skip(sink, index, row, f"步骤形态非法：{exc.errors()[0].get('msg')}")
            continue
        try:
            name, config, steps = normalize_sequence(
                db, row.get("name"), row.get("config"), specs, exclude_id=sequence_id
            )
        except HTTPException as exc:
            _skip(sink, index, row, exc.detail)
            continue

        existing = db.query(Sequence).filter(Sequence.id == sequence_id).first()
        if existing is not None and existing.deleted_at:
            _skip(sink, index, row, f"该序列在回收站中：{sequence_id}（先恢复或彻底删除）")
            continue
        kind = "updated" if existing else "imported"
        try:
            if existing is None:
                existing = Sequence(
                    id=sequence_id, name=name,
                    description=row.get("description"), config=config,
                )
                db.add(existing)
                db.flush()
            else:
                existing.name = name
                existing.description = row.get("description")
                existing.config = config
            db.query(SequenceStep).filter(
                SequenceStep.sequence_id == sequence_id
            ).delete(synchronize_session=False)
            write_steps(db, sequence_id, steps)
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            _skip(sink, index, row, f"唯一约束冲突：{exc.orig}")
            continue
        report[kind] += 1
        report["steps"]["written"] += len(steps)
    return report


def import_transport_settings(db: Session, payload) -> dict:
    """回灌 `transport.json`：单行约定（`id` 恒为 `current`）逐行 upsert。

    `config` 走 `validate_config` 归一（ValueError → 单行跳过）；`active_profile_id`
    是**逻辑指针** —— 目标机上没有那个活档案时**置空并记警告**，不带一个悬空指针进来
    （镜像 R6「指针删除期解除」的读侧降级口径）。
    """
    rows = transport_rows(payload)
    report = _domain_report("transport")
    sink = report["skipped"]
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            _skip(sink, index, row, "条目必须是对象")
            continue
        setting_id = row.get("id")
        if setting_id != "current":
            _skip(sink, index, row, f"只支持单行配置（id 必须是 current，收到 {setting_id!r}）")
            continue
        if not isinstance(row.get("config"), dict):
            _skip(sink, index, row, "config 必须是对象")
            continue
        try:
            config = transport.validate_config(row["config"])
        except ValueError as exc:
            _skip(sink, index, row, f"配置非法：{exc}")
            continue
        profile_id = row.get("active_profile_id") or None
        if profile_id and alive(db.query(DeviceProfile), DeviceProfile).filter(
            DeviceProfile.id == profile_id
        ).first() is None:
            report["warnings"].append(
                f"传输配置的档案指针已置空：{profile_id}（目标机无此活档案）"
            )
            profile_id = None

        existing = db.query(TransportSetting).filter(
            TransportSetting.id == setting_id
        ).first()
        if existing is not None and existing.deleted_at:
            _skip(sink, index, row, "该传输配置在回收站中（先恢复或彻底删除）")
            continue
        kind = "updated" if existing else "imported"
        try:
            if existing:
                existing.config = config
                existing.active_profile_id = profile_id
            else:
                db.add(TransportSetting(
                    id=setting_id, config=config, active_profile_id=profile_id,
                ))
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            _skip(sink, index, row, f"唯一约束冲突：{exc.orig}")
            continue
        report[kind] += 1
    return report


def import_profiles(db: Session, payload) -> dict:
    """回灌 `profiles.json`：按 id upsert，**档案名撞车 → 跳过**（`label` 是 inline UNIQUE）。"""
    rows = profiles_rows(payload)
    report = _domain_report("profiles")
    sink = report["skipped"]
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            _skip(sink, index, row, "条目必须是对象")
            continue
        profile_id = row.get("id")
        label = str(row.get("label") or "").strip()
        if not profile_id or not label:
            _skip(sink, index, row, "缺 id / label")
            continue
        if not isinstance(row.get("config"), dict):
            _skip(sink, index, row, "config 必须是对象")
            continue
        try:
            config = transport.validate_config(row["config"])
        except ValueError as exc:
            _skip(sink, index, row, f"配置非法：{exc}")
            continue
        # R20：sort_order 是**可选**行字段 —— 缺席（旧包）不覆盖目标库已有的序，
        # 在场则必须是非负整数（bool 不算数），否则整行跳过（不静默降级成 0）。
        raw_sort = row.get("sort_order")
        sort_order = None
        if raw_sort is not None:
            if isinstance(raw_sort, bool) or not isinstance(raw_sort, int) or raw_sort < 0:
                _skip(sink, index, row, "sort_order 必须是非负整数")
                continue
            sort_order = raw_sort
        clash = db.query(DeviceProfile).filter(
            DeviceProfile.label == label, DeviceProfile.id != profile_id
        ).first()
        if clash is not None:
            _skip(sink, index, row, f"档案名已存在（行 {clash.id}）")
            continue
        existing = db.query(DeviceProfile).filter(DeviceProfile.id == profile_id).first()
        if existing is not None and existing.deleted_at:
            _skip(sink, index, row, f"该档案在回收站中：{profile_id}（先恢复或彻底删除）")
            continue
        kind = "updated" if existing else "imported"
        try:
            if existing:
                existing.label = label
                existing.config = config
                if sort_order is not None:
                    existing.sort_order = sort_order  # 缺席 → 保留目标库已有的序
            else:
                db.add(DeviceProfile(
                    id=profile_id,
                    label=label,
                    config=config,
                    sort_order=sort_order if sort_order is not None else 0,
                ))
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            _skip(sink, index, row, f"唯一约束冲突：{exc.orig}")
            continue
        report[kind] += 1
    return report


def import_operator_templates(db: Session, payload) -> dict:
    """回灌 `templates.json`：`op_code` 既是主键也是自然键 → 天然 upsert。

    算子模板是参考数据（`operator.py` 只读 + 启动播种），没有删除入口，
    因此这里只做**形态校验 + 覆盖**，不涉及回收站。
    """
    rows = templates_rows(payload)
    report = _domain_report("templates")
    sink = report["skipped"]
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            _skip(sink, index, row, "条目必须是对象")
            continue
        op_code = str(row.get("op_code") or "").strip()
        name = str(row.get("name") or "").strip()
        category = str(row.get("category") or "").strip()
        if not op_code or not name or not category:
            _skip(sink, index, row, "缺 op_code / name / category")
            continue
        param_template = row.get("param_template")
        if not isinstance(param_template, dict):
            _skip(sink, index, row, "param_template 必须是对象")
            continue
        existing = db.query(OperatorTemplate).filter(
            OperatorTemplate.op_code == op_code
        ).first()
        kind = "updated" if existing else "imported"
        try:
            if existing:
                existing.name = name
                existing.category = category
                existing.param_template = param_template
                existing.description = row.get("description")
            else:
                db.add(OperatorTemplate(
                    op_code=op_code, name=name, category=category,
                    param_template=param_template, description=row.get("description"),
                ))
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            _skip(sink, index, row, f"唯一约束冲突：{exc.orig}")
            continue
        report[kind] += 1
    return report


def run_domain_import(db: Session, payload, validator, importer) -> dict:
    """按域导入三段式（**所有 `/datahub/import/*` 域端点共用**）：

    ① 顶层校验（纯函数，400 不落快照）→ ② `pre-import` 快照（失败 500 中止、
    库未被改）→ ③ 逐行回灌。`preImportSnapshot` 只做加法；`null` = 库文件不存在。
    """
    validator(payload)
    snapshot = safety_snapshot("pre-import", "导入")
    report = importer(db, payload)
    if isinstance(report, dict):
        report["preImportSnapshot"] = snapshot
    return report


# --------------------------------------------------------------------------
# 端点
# --------------------------------------------------------------------------

class RestoreRequest(BaseModel):
    name: str


@router.get("/status")
def datahub_status():
    """D3 环境状态面板：DB 路径 / 行数 / 版本 / 备份列表。"""
    db = SessionLocal()
    try:
        counts = {
            # R6（§8.43）：状态面板计数 = 活行（回收站行不计）
            "instructions": alive(db.query(Instruction), Instruction).count(),
            "instructionFields": db.query(InstructionField).count(),
            "bitFields": db.query(BitField).count(),
            "protocols": alive(db.query(ProtocolTemplate), ProtocolTemplate).count(),
            "operatorTemplates": db.query(OperatorTemplate).count(),
            # 批次四 4a：关系数据行数（随 relations.json 一并导出的两张表）
            "protocolBindings": alive(db.query(ProtocolBinding), ProtocolBinding).count(),
            "responseSpecs": alive(db.query(ResponseSpec), ResponseSpec).count(),
        }
    finally:
        db.close()

    exists = DB_PATH.exists()
    stat = DB_PATH.stat() if exists else None
    return {
        "appVersion": APP_VERSION,
        "dbPath": str(DB_PATH),
        "dbExists": exists,
        "dbSizeBytes": stat.st_size if stat else 0,
        "dbModifiedAt": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds") if stat else None,
        "counts": counts,
        "backups": list_backups(BACKUP_DIR),
        "backupsDir": str(BACKUP_DIR),
    }


def parse_bundle_domains(raw):
    """`?domains=a,b` → 域名单；`None`（不带该参数）= 缺省全 8 域。

    R17（§8.49 按域独立导出）的**顶层校验纯函数**：400 口径明确、绝不静默忽略 ——
    空项（`?domains=`、`a,,b`）/ 未知域名 / 重复域名三类都报错，报错文案带**可选域全集**，
    方便照抄。合法时保留用户给的顺序（去重已保证无重复）。
    """
    if raw is None:
        return None
    names = [part.strip() for part in str(raw).split(",")]
    if not names or any(not name for name in names):
        raise HTTPException(
            status_code=400,
            detail="domains 含空项（形如 ?domains=recipes,sequences）",
        )
    unknown = [name for name in names if name not in BUNDLE_DOMAIN_VERSIONS]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"未知域：{'、'.join(unknown)}（可选：{'、'.join(BUNDLE_DOMAIN_VERSIONS)}）",
        )
    if len(set(names)) != len(names):
        raise HTTPException(status_code=400, detail="domains 有重复项")
    return names


@router.get("/export/bundle")
def export_bundle(domains: Optional[str] = None):
    """D1 聚合导出 ZIP：**8 域** + manifest.json + frames/*（R7 · PLAN §8.45）。

    域文件 = `instructions.json` + `relations.json` + 本批新增 5 域
    （`recipes.json` / `sequences.json` / `transport.json` / `profiles.json` /
    `templates.json`）+ 派生物 `frames/*`；`manifest.json` 写 `domainVersion`
    （8 域清单）与 `domainCounts`（逐域行数），既有三键只做加法。

    R17（§8.49）**按域独立导出**：`?domains=recipes,sequences` 只出所选域 ——
    ① **缺省不带参数 = 现行 8 域逐字不变**（文件集合、manifest 三键、下载文件名一个字节
    都不动）；② manifest 的 `domainVersion` · `domainCounts` 只列包里真有的域（键序仍按
    8 域表），`instructionCount` · `relations` · `frames` 三键描述的是**这个包**（没选中的
    归 0 / 空）；③ 非法 `domains` 走 `parse_bundle_domains` 的 400，不静默忽略；
    ④ **协议数据仍走协议页既有导出**（relations 域可单选，但不因此重开「第 9 域」拍板项）。

    每条指令都产出帧文件；单条编译失败只在 manifest 标记 error，不阻断整包导出
    （JSON 始终完整）。**读端点只出活行**（R6 §8.43）：指令 / 绑定 / 应答规格 /
    配方 / 序列 / 档案 / 传输配置 / 算子模板一律 `alive()`，回收站行不进包；
    序列步骤随宿主同进同出（宿主在站里则其步骤一步都不出）。

    本批**只做出线，不碰导入**：按域导入端点 = R8（导入侧**不读** domains 参数）。
    """
    wanted = parse_bundle_domains(domains)
    wanted_set = set(wanted) if wanted is not None else None

    def include(name):
        """这个域进不进包。缺省（wanted is None）= 全 8 域。"""
        return wanted_set is None or name in wanted_set

    db = SessionLocal()
    try:
        instructions = alive(db.query(Instruction), Instruction).all()
        payload = instructions_export_payload(instructions)
        relations = relations_export_payload(
            alive(db.query(ProtocolBinding), ProtocolBinding).order_by(ProtocolBinding.id).all(),
            alive(db.query(ResponseSpec), ResponseSpec).order_by(ResponseSpec.id).all(),
        )
        # R7 补域：5 个新域（列子集不含 deleted_at → 回灌后恒是活行）
        recipes = recipes_export_payload(
            alive(db.query(FrameRecipe), FrameRecipe).order_by(FrameRecipe.id).all()
        )
        sequence_rows = (
            alive(db.query(Sequence), Sequence)
            .order_by(Sequence.name.asc(), Sequence.id.asc())
            .all()
        )
        step_rows = []
        if sequence_rows:
            step_rows = (
                db.query(SequenceStep)
                .filter(SequenceStep.sequence_id.in_([s.id for s in sequence_rows]))
                .order_by(SequenceStep.step_order.asc(), SequenceStep.id.asc())
                .all()
            )
        sequences = sequences_export_payload(sequence_rows, step_rows)
        # 局部名不能叫 `transport`：会遮蔽本模块已导入的 backend.core.transport
        transport_payload = transport_export_payload(
            alive(db.query(TransportSetting), TransportSetting)
            .order_by(TransportSetting.id)
            .all()
        )
        profiles = profiles_export_payload(
            alive(db.query(DeviceProfile), DeviceProfile)
            .order_by(DeviceProfile.label.asc(), DeviceProfile.id.asc())
            .all()
        )
        templates = templates_export_payload(
            alive(db.query(OperatorTemplate), OperatorTemplate)
            .order_by(OperatorTemplate.op_code.asc())
            .all()
        )
        frames = []
    finally:
        db.close()

    # R17 按域导出：未选中的域**连文件都不写**（键序仍按 8 域表 = 导出序）
    entries = []
    if include("instructions"):
        entries.append(("instructions.json", json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")))
    if include("relations"):
        entries.append(("relations.json", json.dumps(relations, ensure_ascii=False, indent=2).encode("utf-8")))
    if include("recipes"):
        entries.append(("recipes.json", json.dumps(recipes, ensure_ascii=False, indent=2).encode("utf-8")))
    if include("sequences"):
        entries.append(("sequences.json", json.dumps(sequences, ensure_ascii=False, indent=2).encode("utf-8")))
    if include("transport"):
        entries.append(("transport.json", json.dumps(transport_payload, ensure_ascii=False, indent=2).encode("utf-8")))
    if include("profiles"):
        entries.append(("profiles.json", json.dumps(profiles, ensure_ascii=False, indent=2).encode("utf-8")))
    if include("templates"):
        entries.append(("templates.json", json.dumps(templates, ensure_ascii=False, indent=2).encode("utf-8")))
    # `frames` 是 manifest 八键之一（独立域），内容派生自指令 —— 不选它就不编译
    if include("frames"):
        for inst in payload["instructions"]:
            base = sanitize_filename(inst.get("code") or inst.get("id"), "instruction")
            entry = {"code": inst.get("code"), "name": inst.get("name"), "file": f"frames/{base}", "status": "ok", "bytes": 0}
            try:
                data = frame_bytes(compile_blocks(fields_to_blocks(inst.get("fields") or [])))
            except ValueError as exc:
                data, entry["status"] = b"", f"error: {exc}"
            entries.append((f"frames/{base}.bin", data))
            entries.append((f"frames/{base}.hex", format_hex_text(data).encode("ascii")))
            entry["bytes"] = len(data)
            frames.append(entry)

    # manifest 描述**这个包**：没选中的域，三个存量子键（instructionCount /
    # relations / frames）归零或置空；domainVersion · domainCounts 由 domains 过滤
    manifest = bundle_manifest(
        payload if include("instructions") else {**payload, "instructions": []},
        relations if include("relations") else {**relations, "bindings": [], "responseSpecs": []},
        {
            "recipes": recipes,
            "sequences": sequences,
            "transport": transport_payload,
            "profiles": profiles,
            "templates": templates,
        },
        frames,
        domains=wanted,
    )
    entries.append(("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")))

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    # 缺省文件名逐字不变（存量消费方按 `^yorha-datahub-\d+\.zip$` 认）；按域导出带上域名，
    # 免得几份包混在一个下载目录里分不出哪份是哪域
    filename = (
        f"yorha-datahub-{stamp}.zip"
        if wanted is None
        else f"yorha-datahub-{'-'.join(wanted)}-{stamp}.zip"
    )
    return Response(
        content=build_bundle(entries),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/import/relations")
def import_relations_endpoint(payload: dict = Body(...), db: Session = Depends(get_db)):
    """批次四 4a：回灌 relations.json（ZIP 内该文件的原文）。

    逐行 upsert、逐行报告（缺父 / 槽悬空 / 唯一冲突 → skipped 或 warning），
    部分成功即部分落库，**不整批回滚**；顶层未知键 / 非法 schemaVersion → 400。

    PLAN §8.37 R1：**回灌前先留 `pre-import` 快照**（镜像 `/restore` 的 `pre-restore`
    先例）。顺序 = ① 顶层校验 → ② 快照 → ③ 逐行回灌：
    ① 的 400 **不产生快照文件**（纯函数，还没碰库）；② 失败 → 500 中止且**库未被
    改动**（此时拿 `pre-import-*` 一键回退都不需要，因为压根没写）。响应新增
    `preImportSnapshot`（只做加法；`null` = 库文件不存在、无从快照）。
    """
    # ① 顶层校验先行：`_relations_payload` 是纯函数，400 时既不落快照也不写库
    _relations_payload(payload)
    # ② 快照（失败 → 500 中止）
    snapshot = safety_snapshot("pre-import", "导入")
    # ③ 逐行回灌（内部会再校验一次 —— 同一纯函数，幂等）
    report = import_relations(db, payload)
    if isinstance(report, dict):
        report["preImportSnapshot"] = snapshot
    return report


# ---- R8（PLAN §8.46）：按域导入端点 —— 与 `/import/relations` 同形同纪律 ----
# 每个端点都只是一行 `run_domain_import`：① 顶层校验（纯函数）→ ② pre-import
# 快照 → ③ 逐行 upsert / 逐行报告。回执统一
# `{domain, imported, updated, skipped, warnings, preImportSnapshot}`。


@router.post("/import/recipes")
def import_recipes_endpoint(payload: dict = Body(...), db: Session = Depends(get_db)):
    """回灌 `recipes.json`（配方）：父协议缺失 / 阶段非法 → 单行跳过。"""
    return run_domain_import(db, payload, recipes_rows, import_recipes)


@router.post("/import/sequences")
def import_sequences_endpoint(payload: dict = Body(...), db: Session = Depends(get_db)):
    """回灌 `sequences.json`（序列 + 内嵌步骤）：任一步骤宿主缺失 → 整条跳过。"""
    return run_domain_import(db, payload, sequences_rows, import_sequences)


@router.post("/import/transport")
def import_transport_endpoint(payload: dict = Body(...), db: Session = Depends(get_db)):
    """回灌 `transport.json`（单行 current）：档案指针缺失 → 置空并记警告。"""
    return run_domain_import(db, payload, transport_rows, import_transport_settings)


@router.post("/import/profiles")
def import_profiles_endpoint(payload: dict = Body(...), db: Session = Depends(get_db)):
    """回灌 `profiles.json`（设备档案）：`label` 撞车 → 单行跳过。"""
    return run_domain_import(db, payload, profiles_rows, import_profiles)


@router.post("/import/templates")
def import_templates_endpoint(payload: dict = Body(...), db: Session = Depends(get_db)):
    """回灌 `templates.json`（算子模板）：`op_code` 即主键 → 天然 upsert。"""
    return run_domain_import(db, payload, templates_rows, import_operator_templates)


@router.post("/backup")
def create_db_backup():
    """D2 新建数据库备份（shutil.copy2 到 backend/db/backups/）。"""
    if not DB_PATH.exists():
        raise HTTPException(status_code=404, detail="数据库文件不存在")
    try:
        dest = create_backup(DB_PATH, BACKUP_DIR)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"备份失败：{exc}")
    return {"created": _backup_entry(dest)}


def _heal_schema_after_restore(safety):
    """恢复后立即跑「启动期同一套」schema 自愈（PLAN §8.33）。

    老备份可能缺表 / 缺列 / 没有版本表 —— 不自愈的话，进程重启前的**每一次写入**
    都可能撞上缺列报错。迁移一律 `do_backup=False`：上面刚留的 pre-restore 快照
    就是回退路径，失败时把它写进错误消息。**只补结构、不补数据**（种子交给下次
    启动的幂等播种，避免把用户删掉的数据又种回来）。
    """
    try:
        Base.metadata.create_all(bind=engine)
        ensure_protocol_version_column(engine)
        ensure_binding_columns(engine)
        ensure_recipe_columns(engine)
        ensure_sequence_step_columns(engine)
        ensure_response_spec_columns(engine)
        report = run_pending_migrations(engine, do_backup=False, backups_dir=BACKUP_DIR)
    except MigrationError as exc:
        raise HTTPException(
            status_code=500,
            detail=(
                f"恢复后 schema 校验失败：{exc}"
                f"（恢复前快照 {safety or '无'}，可用它回退）"
            ),
        )
    return {
        "applied": report["applied"],
        "version": report["to_version"],
        "integrity": report["integrity"],
    }


def _reload_transport_after_restore() -> bool:
    """恢复后把内存里的传输配置对齐到恢复出的库（否则要等重启才生效）。

    先摘持久化钩子再交回配置 —— 沿用 `transport_store` 的启动纪律「先恢复、后挂钩」：
    否则 `set_config` 生效时的回写会走 `persist_hook`（固定写 `active_profile_id=None`），
    把恢复出来的激活档案指针清掉。
    """
    hook = transport.get_persist_hook()
    transport.set_persist_hook(None)
    try:
        db = SessionLocal()
        try:
            return restore_transport_config(db)
        finally:
            db.close()
    finally:
        transport.set_persist_hook(hook)


@router.post("/restore")
def restore_db(request: RestoreRequest):
    """D2 从备份恢复数据库。

    步骤：**序列运行中拒绝（409，Runner 还在往旧库写）** → 校验文件名（防穿越）→
    当前库先留 pre-restore 安全快照 → engine.dispose() 释放连接池空闲连接 →
    清理 -wal/-shm/-journal 残留 → 临时文件 + 原子 rename 替换 →
    **立即跑启动期同一套 schema 自愈 + 版本化迁移 + integrity_check 终检**
    （§8.33：老备份缺列不自愈的话，重启前每次写都可能炸）→ 把内存传输配置对齐到
    恢复出的库。响应新增 `schema` / `transportConfigRestored` 两个字段（只做加法）。
    运行中换库风险：dispose 只影响池内空闲连接，已被请求 checkout 的旧连接仍指向
    旧文件，恢复窗口内的并发写入可能失败或写入即将被替换的文件——恢复期间前端应
    暂停其它写操作（前端有确认弹窗，notice 亦有提示）。
    """
    if sequence_runner.is_running():
        raise diag.http(
            409, "序列运行中，禁止恢复数据库（先停止序列）",
            "sequence", "SEQUENCE_RUNNING", data_sent=False,
        )
    try:
        source = validate_backup_name(request.name, BACKUP_DIR)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    safety = None
    if DB_PATH.exists():
        try:
            safety = create_backup(DB_PATH, BACKUP_DIR, prefix="pre-restore").name
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"安全快照失败，已中止恢复：{exc}")

    engine.dispose()  # 释放连接池空闲连接（Windows 下否则替换被占用文件失败）
    try:
        replace_database_file(source, DB_PATH)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"替换数据库文件失败：{exc}")

    schema = _heal_schema_after_restore(safety)
    transport_restored = _reload_transport_after_restore()

    return {
        "restored": source.name,
        "safetySnapshot": safety,
        "schema": schema,
        "transportConfigRestored": transport_restored,
        "notice": "已释放连接池并清理 WAL/SHM 残留；恢复期间请避免并发写入，建议刷新页面重新加载数据。",
    }
