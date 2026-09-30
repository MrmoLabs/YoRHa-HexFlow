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

import math

from backend.core.orchestrator import Orchestrator, encode_int_signed, encode_bcd, encode_scaled, encode_float_ieee, encode_time_accumulator, encode_auto_counter, encode_string, _floor_numeric
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


def _presence_hit(f, by_id):
    """N3 (G1): presence 条件存在判定 —— True=命中（发射）、False=未命中（0 字节）。

    静态值链仅 parameter_config.value（DYNAMIC repeat 静态 resolve 同链；inputs/
    computed 覆盖为 FE-only 运行期行为），str() 归一比较（数值 1 命中 "1"，与
    前端 String() byte-equal；bool/浮整值等非契约类型各自现状锚）。
    fail-open → True：presence 非 dict / 缺 ref_id / 缺 expect（None/""）/
    ref 悬空 / ref 无静态值 —— 半成品配置不吞字节，防数据丢失优于严格过滤
    （前端 InstructionEncoder._presenceHit 同口径，改一必改二）。
    """
    cfg = f.get("parameter_config")
    pres = cfg.get("presence") if isinstance(cfg, dict) else None
    if not isinstance(pres, dict):
        return True
    ref_id = pres.get("ref_id")
    expect = pres.get("expect")
    if ref_id is None or str(ref_id) == "":
        return True
    if expect is None or str(expect) == "":
        return True
    try:
        ref = by_id.get(ref_id)
    except TypeError:
        return True  # 不可哈希 ref_id（自由 JSON 契约外）→ fail-open
    if ref is None:
        return True  # 悬空 ref → fail-open 恒发射
    ref_cfg = ref.get("parameter_config")
    ref_val = ref_cfg.get("value") if isinstance(ref_cfg, dict) else None
    if ref_val is None:
        return True  # 无静态值（运行输入才有）→ fail-open
    return str(ref_val) == str(expect)


def fields_to_blocks(fields, now=None):
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

    E1-6 (B8)：now = 注入的墙钟 epoch ms（测试/回放固定时间），缺省取服务器
    当前毫秒；TIME_ACCUMULATOR 的 Current−BaseTime 秒数按此计算，与前端
    encodeInstruction 第 4 参 opts.now 同名同单位，双端注入同值 → byte-equal。
    """
    now_ms = (
        float(now)
        if isinstance(now, (int, float)) and not isinstance(now, bool) and math.isfinite(now)
        else datetime.now().timestamp() * 1000
    )
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

    by_id = {f["id"]: f for f in pool.values() if f.get("id") is not None}

    def to_block(f):
        # N3 (G1): presence 判定先于子树递归与 repeat 展开 —— 未命中 →
        # byte_length=0 + children=[]（子树不进 flatten），type=fixed 绕开
        # length/checksum handler；orchestrator 发射对 0 字节自动省（`or "00"*0`
        # → ""，join 剥空白）→ orchestrator 零触碰。与前端 emitNode 入口判定
        # byte-equal（改一必改二）。
        if not _presence_hit(f, by_id):
            return {
                "id": str(f.get("id") or f.get("name") or "field"),
                "type": "fixed",
                "label": str(f.get("name") or "field"),
                "byte_length": 0,
                "hex_value": None,
                "config": None,
                "children": [],
                "is_container": False,
                "is_enabled": True,
                "endianness": str(f.get("endianness") or "BIG").upper(),
                "repeat_count": 1,
            }
        kids = [to_block(c) for c in by_parent.get(f.get("id"), [])]
        byte_len = int(f.get("byte_len") or 0)
        op = str(f.get("op_code") or "").upper()
        # E1-5 (B7): repeat 展开次数 resolve（仅组容器有意义；叶子恒 1）：
        # NONE/缺省/未知类型 → 1；FIXED → repeat_count 须为有限 number（非有限/
        # bool/缺失 → 1 同前端 typeof 严格防御口径），max(0, floor(n))；DYNAMIC →
        # ref 字段静态 parameter_config.value（_floor_numeric 同前端解析口径）
        # max(0, n)，ref 缺失/无值 → 0。与前端 _repeatCount byte-equal，orchestrator
        # _flatten_recursive 按此 N 展开子树。
        repeat_n = 1
        if kids:
            rt = str(f.get("repeat_type") or "NONE").upper()
            if rt == "FIXED":
                rc = f.get("repeat_count")
                if isinstance(rc, bool) or not isinstance(rc, (int, float)) or not math.isfinite(rc):
                    repeat_n = 1
                else:
                    repeat_n = max(0, math.floor(rc))
            elif rt == "DYNAMIC":
                ref = by_id.get(f.get("repeat_ref_id"))
                if ref is None:
                    repeat_n = 0
                else:
                    ref_cfg = ref.get("parameter_config") or {}
                    repeat_n = max(0, _floor_numeric(ref_cfg.get("value")))
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
        if op == "INT_SIGNED" and byte_len > 0 and not kids:
            # E1-1(B5): 规范 INT_SIGNED（type 缺省/number）的静态值按两补码出帧，
            # 与前端 getFieldBytes 的 INT_SIGNED 分支 byte-equal；cfg.hex 对
            # INT_SIGNED 无效（前端同样忽略）。矛盾配置（type=string/float/hex 等，
            # 算子模板不会产生）不在契约内，保持既有 zeros 行为。
            if str(cfg.get("type") or "").lower() in ("", "number"):
                hex_value = encode_int_signed(cfg.get("value"), byte_len)
        elif op == "BCD_CODE" and byte_len > 0 and not kids:
            # E1-3 (B3): 规范类型（type 缺省/number）静态值出 packed BCD 帧，
            # 与前端 BCD_CODE 分支 byte-equal；矛盾 type 保持既有 zeros 契约外行为。
            if str(cfg.get("type") or "").lower() in ("", "number"):
                hex_value = encode_bcd(cfg.get("value"), byte_len)
        elif op == "SCALED_DECIMAL" and byte_len > 0 and not kids:
            # E1-3 (B4): 规范类型静态值出定标帧 (value+offset)*factor，
            # 与前端 SCALED_DECIMAL 定标分支 byte-equal。
            if str(cfg.get("type") or "").lower() in ("", "number"):
                hex_value = encode_scaled(
                    cfg.get("value"), cfg.get("factor"), cfg.get("offset"), byte_len
                )
        elif op == "FLOAT_IEEE" and byte_len == 4 and not kids:
            # E1-4 (B2): bits=32（byte_len=4）规范类型静态值出 float32 大端帧
            # （恒 4 字节），与前端 FLOAT_IEEE 分支 byte-equal；bits=64 与矛盾
            # type 不在范围，保持既有 zeros 契约外行为。
            if str(cfg.get("type") or "").lower() in ("", "number"):
                hex_value = encode_float_ieee(cfg.get("value"))
        elif op == "TIME_ACCUMULATOR" and byte_len > 0 and not kids:
            # E1-6 (B8): 规范类型按墙钟 Current−BaseTime 秒数出帧；now 经
            # fields_to_blocks(now=… ms) 注入，与前端 opts.now 同值 byte-equal。
            # base_time 缺失/非法（契约外配置）→ encode 返回 None → 不覆盖
            # hex_value，保持既有 cfg.hex/zeros 现状（前端同情形回落 value
            # 路径，两端各自现状锚，同 E1-3/E1-4 先例）。
            if str(cfg.get("type") or "").lower() in ("", "number"):
                sem = encode_time_accumulator(cfg.get("base_time"), now_ms, byte_len)
                if sem is not None:
                    hex_value = sem
        elif op == "AUTO_COUNTER" and byte_len > 0 and not kids:
            # E1-6 (B8): (Current+Step)%Max —— 静态口径 Current = value（非空）
            # 否则 start_val；与前端 AUTO_COUNTER 分支 byte-equal（运行时
            # computed/input 仅前端有，BE 静态口径同 DYNAMIC repeat 先例）。
            if str(cfg.get("type") or "").lower() in ("", "number"):
                hex_value = encode_auto_counter(
                    cfg.get("value"), cfg.get("start_val"),
                    cfg.get("step"), cfg.get("max"), byte_len,
                )
        elif (op == "STRING" or (op == "INPUT" and str(cfg.get("type") or "").lower() == "string")) and byte_len > 0 and not kids:
            # N2 (G2): 文本字段定长编码（ascii/utf8 × pad/截断）——新算子 STRING
            # 与存量 INPUT+type=string 同口径，与前端 getFieldBytes string 分支
            # byte-equal（test_encode_string 向量表锚定）。byte_len>0 分支闸与前端
            # 「缺失/0 → 变长原样」对齐（缺失场景两端各自现状锚，W1 已提醒）；
            # 数值 op + type=string 矛盾配置不进本分支（E1 各支 zeros 契约外不变）。
            hex_value = encode_string(
                cfg.get("value"), byte_len, cfg.get("encoding"), cfg.get("pad_char")
            )
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
            # E1-2 (B6): 透传字段字节序（前端 normalizeInstruction 同款归一）。
            "endianness": str(f.get("endianness") or "BIG").upper(),
            # E1-5 (B7): resolved repeat 展开次数（组容器；orchestrator flatten 用）。
            "repeat_count": repeat_n,
            # N5 (G4): 字段级对齐/填充 —— 原样透传（orchestrator 发射期按
            # core/pad 归一 fail-open，与前端 padSpec 同口径）。presence 未命中
            # 的早退分支不透传（未命中连 pad 都不发，emitNode 同口径）。
            "align": cfg.get("align"),
            "pad_to": cfg.get("pad_to"),
            "pad_byte": cfg.get("pad_byte"),
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
