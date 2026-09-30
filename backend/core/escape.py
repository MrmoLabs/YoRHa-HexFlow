"""N4 (G3): 传输层帧字节转义 —— 转义逻辑唯一实现入口。

层位定案（§8.16 N4，「传输层 · 内核转义后套壳」）：
- 转义发生在**出线前、套壳前**：/dispatch 先按转义表转义**内核 payload**，
  再交 build_wrapped 套协议外壳 —— 外壳字节（FA…ED）不进转义范围；
- 内核自身的 length/checksum/画布偏移在前端编码期按**逻辑字节**算完，转义不改
  它们；壳内 length/checksum 由 build_wrapped 对注入后的**线上字节**（转义后）
  重算 —— 即「内核域按逻辑字节、壳域按线上字节」；
- 缺省关闭 → 逐字节不变（§0 硬约束）。配置骑在传输配置 JSON（零 DDL）。

转义表形态（transport config `escape` 段，双端同形）：

    {"enabled": true, "pairs": [["7D", "7D5D"], ["11", "7D31"]]}

单趟映射：字节命中 pairs 的 from → 输出 to 序列，未命中 → 原样；替换产物
不再回扫（单趟）。一个表覆盖三型：0x7D 型字头（7D→7D5D）、0x10 型前缀
（11→1011 = 前缀+原字节）、非前缀多字节替换（0D→0D0A）。

双端纪律：向量表锚定 backend/tests/test_escape.py ↔
frontend/src/utils/__tests__/escapeTable.test.js（FE 仅配置面板样例预览用，
出线字节 SSOT 在本模块），改一必改二。
"""

import re
from typing import Dict, Mapping

# 分隔符口径与 backend/routers/export.hex_to_bytes 一致（空白/下划线/连字符）
_HEX_CLEANER = re.compile(r"[\s,_-]")
_HEX2 = re.compile(r"^[0-9A-Fa-f]{2}$")
_HEX_STRICT = re.compile(r"^[0-9A-Fa-f]+$")


def normalize_escape(raw) -> Dict:
    """transport config 的 `escape` 段 → 规范形态 {enabled, pairs}。

    None/缺段 → 默认关闭（旧库存量配置无此段，restore 不得静默失败）；
    非法 → ValueError（validate_config 透传 → 路由层 400）。
    from 归一为大写 2 位、to 归一为大写偶长；from 大小写不敏感判重。
    """
    if raw is None:
        return {"enabled": False, "pairs": []}
    if not isinstance(raw, dict):
        raise ValueError("escape 配置必须是对象")
    unknown = set(raw) - {"enabled", "pairs"}
    if unknown:
        raise ValueError(f"未知 escape 配置字段: {', '.join(sorted(unknown))}")

    enabled = raw.get("enabled", False)
    if not isinstance(enabled, bool):
        raise ValueError("escape.enabled 必须是布尔值")

    pairs = raw.get("pairs", [])
    if not isinstance(pairs, list):
        raise ValueError("escape.pairs 必须是数组")

    out = []
    seen = set()
    for i, pair in enumerate(pairs):
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise ValueError(f"escape.pairs[{i}] 必须是 [原字节, 替换序列] 两项")
        src, dst = pair
        src_s = src.strip() if isinstance(src, str) else None
        if src_s is None or not _HEX2.match(src_s):
            raise ValueError(f"escape.pairs[{i}].from 必须是 2 位 hex：{src!r}")
        dst_s = dst.strip() if isinstance(dst, str) else None
        if (dst_s is None or not _HEX_STRICT.match(dst_s)
                or len(dst_s) < 2 or len(dst_s) % 2 != 0):
            raise ValueError(f"escape.pairs[{i}].to 必须是 ≥2 位偶数长度 hex：{dst!r}")
        src_u, dst_u = src_s.upper(), dst_s.upper()
        if src_u in seen:
            raise ValueError(f"escape.pairs[{i}].from 重复：{src_u}")
        seen.add(src_u)
        out.append([src_u, dst_u])

    return {"enabled": enabled, "pairs": out}


def build_table(escape_cfg) -> Dict[int, bytes]:
    """规范（或任意）escape 段 → {原字节: 替换字节序列}。

    关闭 / 空表 / 脏数据一律回落空表 = 直通（fail-open：转义配置只可能来自
    已过 validate_config 的传输配置，运行期绝不因它炸发送路径）。
    """
    if not isinstance(escape_cfg, dict) or not escape_cfg.get("enabled"):
        return {}
    pairs = escape_cfg.get("pairs")
    if not isinstance(pairs, list):
        return {}

    table: Dict[int, bytes] = {}
    for pair in pairs:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            continue
        src, dst = pair
        src_s = str(src) if src is not None else ""
        dst_s = str(dst) if dst is not None else ""
        if not _HEX2.match(src_s):
            continue
        if not dst_s or len(dst_s) % 2 != 0 or not _HEX_STRICT.match(dst_s):
            continue
        table[int(src_s, 16)] = bytes.fromhex(dst_s)
    return table


def table_from_config(config) -> Dict[int, bytes]:
    """传输配置（transport.get_config() 形态）→ 转义表；任何异常态 → 空表。"""
    if not isinstance(config, Mapping):
        return {}
    return build_table(config.get("escape"))


def escape_bytes(data, table: Dict[int, bytes]) -> bytes:
    """单趟转义：命中表 → 替换序列，未命中 → 原字节；空表直通。"""
    if not table:
        return bytes(data)
    out = bytearray()
    for b in bytes(data):
        repl = table.get(b)
        out.extend(repl if repl is not None else bytes((b,)))
    return bytes(out)


def escape_hex(hex_str: str, table: Dict[int, bytes]) -> str:
    """hex（可带分隔符）→ 转义后紧凑大写 hex。

    空表 → **原样返回**（不解析、不改写：/dispatch 关闭态连错误文案都与存量
    逐字节一致，错误统一由下游 hex_to_bytes 抛）；有表 → 解析，非法 hex 的
    ValueError 文案与 export.hex_to_bytes 同源（HTTP 侧统一 "Invalid payload"）。
    """
    if not table:
        return hex_str
    cleaned = _HEX_CLEANER.sub("", hex_str or "")
    if cleaned == "":
        return ""
    if len(cleaned) % 2 != 0:
        raise ValueError("hex_string has an odd number of hex digits")
    try:
        raw = bytes.fromhex(cleaned)
    except ValueError as e:
        raise ValueError(f"invalid hex string: {e}") from e
    return escape_bytes(raw, table).hex().upper()
