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

纯函数（fields_to_blocks / compile_blocks / frame_bytes / format_hex_text /
build_bundle / sanitize_filename / validate_backup_name / create_backup /
replace_database_file / list_backups）由 backend/tests/test_datahub.py 用
stdlib unittest 直测，无新增依赖。
"""
import io
import json
import re
import shutil
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from backend.core.orchestrator import Orchestrator
from backend.db.database import DB_PATH, SessionLocal, engine
from backend.db.models import (
    BitField,
    Instruction,
    InstructionField,
    OperatorTemplate,
    ProtocolTemplate,
)
from backend.routers.instruction import serialize_instruction
from backend.schemas.block import Block

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


def fields_to_blocks(fields):
    """扁平指令字段列表 → 后端帧块森林（dict 树）。

    口径与前端 utils/toFrameBlocks.js 一致：
    - 有 children → container（递归）
    - LENGTH_CALC / CHECKSUM_CRC 且 byte_len>0 → length / checksum
      （config=None → handler 退化为 0x00 填充，不引用 target id）
    - 其余（含 byte_len<=0 的 length/checksum）→ fixed，
      hex_value 取 parameter_config.hex，缺省由 Orchestrator 以 0x00 占位。
    既接受 GET /instructions 的扁平列表（parent_id 关联），也接受嵌套
    children 树（扁平副本优先，按 id 去重）。顶层顺序与 children 顺序均按
    sequence → name → id 稳定排序；parent_id 悬空的字段按顶层处理（不丢）。
    """
    pool = {}  # key: ("id", …) 或 ("obj", id(f)) → 扁平去重后的字段池

    def collect(f):
        if not isinstance(f, dict):
            return
        key = ("id", f["id"]) if f.get("id") is not None else ("obj", id(f))
        if key not in pool:
            pool[key] = f
        for child in (f.get("children") or []):
            collect(child)

    for item in (fields or []):
        collect(item)

    ids = {f["id"] for f in pool.values() if f.get("id") is not None}
    by_parent = {}
    for f in pool.values():
        pid = f.get("parent_id")
        key = pid if pid in ids else None
        by_parent.setdefault(key, []).append(f)
    for group in by_parent.values():
        group.sort(key=lambda f: (f.get("sequence") or 0, str(f.get("name") or ""), str(f.get("id") or "")))

    def to_block(f):
        kids = [to_block(c) for c in by_parent.get(f.get("id"), [])]
        byte_len = int(f.get("byte_len") or 0)
        op = str(f.get("op_code") or "").upper()
        if kids:
            btype = "container"
        elif op == "LENGTH_CALC" and byte_len > 0:
            btype = "length"
        elif op == "CHECKSUM_CRC" and byte_len > 0:
            btype = "checksum"
        else:
            btype = "fixed"
        cfg = f.get("parameter_config") or {}
        hex_value = cfg.get("hex") if isinstance(cfg.get("hex"), str) else None
        return {
            "id": str(f.get("id") or f.get("name") or "field"),
            "type": btype,
            "label": str(f.get("name") or "field"),
            "byte_length": byte_len,
            "hex_value": hex_value,
            "config": None,
            "children": kids,
            "is_container": bool(kids),
            "is_enabled": True,
        }

    return [to_block(f) for f in by_parent.get(None, [])]


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


def _backup_entry(path):
    stat = path.stat()
    return {
        "name": path.name,
        "sizeBytes": stat.st_size,
        "modifiedAt": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
        "isSafetySnapshot": path.name.startswith("pre-restore-"),
    }


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
            "instructions": db.query(Instruction).count(),
            "instructionFields": db.query(InstructionField).count(),
            "bitFields": db.query(BitField).count(),
            "protocols": db.query(ProtocolTemplate).count(),
            "operatorTemplates": db.query(OperatorTemplate).count(),
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


@router.get("/export/bundle")
def export_bundle():
    """D1 聚合导出 ZIP：instructions.json + manifest.json + frames/<code>.bin|.hex。

    每条指令都产出帧文件；单条编译失败只在 manifest 标记 error，
    不阻断整包导出（JSON 始终完整）。
    """
    db = SessionLocal()
    try:
        instructions = db.query(Instruction).all()
        payload = instructions_export_payload(instructions)
        frames = []
    finally:
        db.close()

    entries = [
        ("instructions.json", json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")),
    ]
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

    manifest = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "appVersion": APP_VERSION,
        "instructionCount": len(payload["instructions"]),
        "frames": frames,
    }
    entries.append(("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")))

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return Response(
        content=build_bundle(entries),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="yorha-datahub-{stamp}.zip"'},
    )


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


@router.post("/restore")
def restore_db(request: RestoreRequest):
    """D2 从备份恢复数据库。

    步骤：校验文件名（防穿越）→ 当前库先留 pre-restore 安全快照 →
    engine.dispose() 释放连接池空闲连接 → 清理 -wal/-shm/-journal 残留 →
    临时文件 + 原子 rename 替换。运行中换库风险：dispose 只影响池内空闲
    连接，已被请求 checkout 的旧连接仍指向旧文件，恢复窗口内的并发写入
    可能失败或写入即将被替换的文件——恢复期间前端应暂停其它写操作。
    """
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

    return {
        "restored": source.name,
        "safetySnapshot": safety,
        "notice": "已释放连接池并清理 WAL/SHM 残留；恢复期间请避免并发写入，建议刷新页面重新加载数据。",
    }
