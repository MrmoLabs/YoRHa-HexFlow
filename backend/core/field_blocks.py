"""指令字段 → 帧块森林（**编译侧 SSOT**，R10 从 `routers/datahub.py` 纯搬入)。

为什么在 `core`：R10 要把命中应答**逆向解码**成 `字段 = 值`（`core/field_decode.py`），
解码必须与编译**同一套布局口径**（presence 门 / repeat 展开 / endianness / align /
pad_to / byte_length）。编译在 routers、解码在 core 就得让 core 反向依赖 routers ——
故把编译口径搬进 core，`routers/datahub.py` **原名再导出**（测试与 datahub 内部
`from backend.routers.datahub import fields_to_blocks` 一行未改，行为逐字不变）。

两条口径（改一必改二，与前端对偶）：
- `to_block`：presence 未命中 → 0 字节子树（`byte_length=0` + `children=[]`，
  align/pad 三键不透传 → 连补位都不发），与前端 `emitNode` 入口判定 byte-equal；
- `fields_to_blocks`：组 repeat 按 NONE/FIXED/DYNAMIC resolve 后交
  `orchestrator._flatten_recursive` ×N 展开。
"""

import math
import re
from datetime import datetime

from backend.core.orchestrator import (
    _floor_numeric,
    encode_auto_counter,
    encode_bcd,
    encode_float_ieee,
    encode_int_signed,
    encode_scaled,
    encode_scramble,
    encode_string,
    encode_time_accumulator,
    encode_time_epoch,
)

def _hex_norm(v):
    """R32 (§8.64): 整串十六进制**字符串** → int。

    仅字符串（JSON 数字不按 hex 解）、不做 strip（`" 1"` 不是整串 hex）、
    超安全整数 → None —— 三条与 FE utils/presenceSemantics.hexNorm 同口径。
    安全整数阈取 2**53-1 = JS Number.isSafeInteger 上限，双端精度一致不分叉。
    """
    if not isinstance(v, str) or v == "":
        return None
    if re.fullmatch(r"[0-9A-Fa-f]+", v) is None:
        return None
    n = int(v, 16)
    return n if n <= (2 ** 53 - 1) else None


def _num_of(v):
    """R32 (§8.64): 当前值 → 可比数（FE comparableNumber 同口径）。

    bool **不算数**（`str(True)=="True"` 归 ① 存量 str 比较，不进归一）；
    int/float 原样（非有限 → None）；十进制字符串（不带空白）取 float。
    """
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        return f if math.isfinite(f) else None
    if isinstance(v, str) and re.fullmatch(r"[+-]?\d+(\.\d+)?", v) is not None:
        try:
            f = float(v)
        except ValueError:  # pragma: no cover — 正则已排除不可能
            return None
        return f if math.isfinite(f) else None
    return None


def _presence_equal(expect, ref_val):
    """R32 (§8.64): presence **比较谓词** —— 先 str() 归一（N3 存量口径：数值 1
    命中 "1"），不等再按十六进制归一（`"01"` ≡ 1、`"0A"` ≡ 10，样本② 拍板项）。

    与 FE utils/presenceSemantics.presenceEqual byte-equal（改一必改二）：
    归一仅当 expect 是**字符串**且整串 hex 且数值在安全整数内。
    """
    if str(ref_val) == str(expect):
        return True
    if not isinstance(expect, str):
        return False
    hn = _hex_norm(expect)
    if hn is None:
        return False
    vn = _num_of(ref_val)
    if vn is None:
        return False
    return bool(hn == vn)


def _presence_hit(f, by_id):
    """N3 (G1): presence 条件存在判定 —— True=命中（发射）、False=未命中（0 字节）。

    静态值链仅 parameter_config.value（DYNAMIC repeat 静态 resolve 同链；inputs/
    computed 覆盖为 FE-only 运行期行为），比较走 _presence_equal：
    str() 归一（数值 1 命中 "1"，与前端 String() byte-equal）+ R32 十六进制归一
    （"01" ≡ 1；bool/浮整值等非契约类型各自现状锚）。
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
    return _presence_equal(expect, ref_val)


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
        elif op == "FLOAT_IEEE" and byte_len in (4, 8) and not kids:
            # R5: bits=32（byte_len=4）→ float32 大端 8 hex；bits=64（byte_len=8）
            # → float64 大端 16 hex —— 两端同一解析口径 `_float_number`（非有限
            # 一律归 0），与前端 FLOAT_IEEE 分支 byte-equal；其余长度与矛盾 type
            # 不在范围，保持既有 zeros 契约外行为（前端 W 提醒兜底）。
            if str(cfg.get("type") or "").lower() in ("", "number"):
                hex_value = encode_float_ieee(cfg.get("value"), byte_len)
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
        elif op == "TIME_EPOCH" and byte_len > 0 and not kids:
            # R23 (§8.52 排期): 绝对 Unix 时间戳 —— unit='ms' 取毫秒、缺省 's'
            # 取秒，与前端 lanes/编码器 TIME_EPOCH 分支同源。now 经
            # fields_to_blocks(now=… ms) 注入（同 TIME_ACCUMULATOR），双端注入
            # 同值 → byte-equal；unit 非法值按 's'（算子模板只出 s/ms，收口在
            # plan/编码器同口径）。now 非有限 → None → 不覆盖 hex_value（同上）。
            if str(cfg.get("type") or "").lower() in ("", "number"):
                sem = encode_time_epoch(cfg.get("unit"), now_ms, byte_len)
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
        elif op == "SCRAMBLE" and not kids:
            # R25 (§8.57): 加扰字段 —— 明文（cfg.hex，与 HEX_RAW 同源同规则）经 mode
            # 变换后出线，与前端 _encodeFieldBytes 的 SCRAMBLE 分支 byte-equal
            # （共享向量 vectors/scramble.json 双端锚定）。
            # **无 byte_len 闸**：加扰逐字节保长、不需要位宽（byte_len=0 的空明文两端同为
            # 0 字节）；明文空 / 非 hex → encode 返回 None → 置 None（发射期
            # `hex_value or "00"*byte_length` 补零，与前端「明文非法 → 补零」同字节）——
            # 绝不能沿用上文塞进 hex_value 的原串，那等于把非法明文直接发上线。
            if isinstance(hex_value, str):
                hex_value = encode_scramble(
                    hex_value, cfg.get("mode"), cfg.get("seed"), cfg.get("roll")
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


