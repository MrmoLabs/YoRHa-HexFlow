import math
import re
import struct
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from backend.schemas.block import Block, BlockType
from backend.handlers.length import LengthHandler
from backend.handlers.checksum import ChecksumHandler
from backend.handlers.bitfield import BitfieldHandler
from backend.core.pad import (
    align_pad_len,
    normalize_align,
    normalize_pad_byte,
    normalize_pad_to,
    pad_hex,
    pad_to_pad_len,
)
# 帧转义不在编排器（旧占位 `backend.handlers.escape` 已随本批清掉）：N4 拍板
# 「传输层 · 内核转义后套壳」—— 编排器只出逻辑字节（内容口径），出线时由
# dispatch / sequence 调 backend/core/escape.py 转义（escape_hex / escape_bytes）。


def _reverse_hex_pairs(hex_str: str) -> str:
    """E1-2 (B6): LITTLE-endian emission helper.

    Strip spaces, reverse the byte-pair sequence, and rejoin in the same
    spacing style as the input. Odd-length or empty input is returned
    unchanged. Mirrors the frontend InstructionEncoder.getFieldBytes
    wrapper (bytes.reverse() over the leaf value bytes).
    """
    if not hex_str:
        return hex_str
    compact = re.sub(r"\s+", "", hex_str)
    if len(compact) < 2 or len(compact) % 2 != 0:
        return hex_str
    pairs = [compact[i:i + 2] for i in range(0, len(compact), 2)]
    reversed_pairs = list(reversed(pairs))
    if " " in hex_str:
        return " ".join(reversed_pairs)
    return "".join(reversed_pairs)


class _PadMark:
    """N5 (G4): 容器级 align/pad_to 标记。

    容器不进发射流，其 pad 只能以标记形式挂在子树首（align）/尾（pad_to）；
    展开期（_flatten_recursive）插入、发射期按绝对游标解析补位长度。handler
    视野把它过滤掉 —— 长度/校验按内容口径（不含对齐填充），与前端 PASS0
    fieldSizes / _encodeFieldBytes 同口径。
    """

    __slots__ = ("kind", "n", "byte")

    def __init__(self, kind: str, n: int, byte: int):
        self.kind = kind   # "align" | "pad_to"
        self.n = n         # 边界 N（已归一 1..PAD_MAX）
        self.byte = byte   # 填充字节值 0..255


class Orchestrator:
    def __init__(self, root_blocks: List[Block]):
        """
        root_blocks: A forest of block trees (containers with children).
        """
        self.root_blocks = root_blocks
        self.handlers = {
            "length": LengthHandler(),
            "checksum": ChecksumHandler(),
            # 批 4: bitfield —— 位段静态默认值打包（协议结构化位域）
            "bitfield": BitfieldHandler(),
        }
        # Flat stream for final global addressing
        self.flattened_stream: List[Block] = []

    def process(self) -> str:
        # 1. Deep pass (post-order placeholder): children are structural units,
        #    containers emit no bytes of their own.
        for block in self.root_blocks:
            self._process_recursive(block)

        # 2. Flatten the forest into a linear stream.
        self.flatten()

        # 3. Range-dependent logic (length / checksum) runs on the flattened
        #    stream, because these blocks reference start/end IDs of siblings
        #    and descendants. Children's hex values are already final here.
        # N5 (G4): 容器级 pad 标记不进 handler 视野 —— 长度/校验按内容口径
        # （不含对齐填充），与前端 PASS0 fieldSizes / _encodeFieldBytes 同口径。
        emit_blocks: List[Block] = [
            b for b in self.flattened_stream if isinstance(b, Block)
        ]
        flat_tuples: List[Tuple[str, Block]] = [("global", b) for b in emit_blocks]

        for block in emit_blocks:
            if block.type in [BlockType.LENGTH, BlockType.CHECKSUM] or str(block.type) == "bitfield":
                handler_key = block.type
                if isinstance(block.type, BlockType):
                    handler_key = block.type.value

                handler = self.handlers.get(handler_key)
                if handler:
                    block.hex_value = handler.calculate(block, flat_tuples)

        # 4. Emit final hex (slots are placeholders and emit nothing).
        #    N5 (G4): 发射期维护绝对游标 —— 叶的 align 前置 pad / pad_to 后置
        #    pad 与容器标记都按游标解析；pad 在 LITTLE 反转之外（只反转字段内容），
        #    且被 emit_blocks 过滤后不改 handler 眼里的内容字节。
        final_hex = []
        cursor = 0
        # CP3 3c (D6-B): 发射期旁路记录 —— 叶块 id → [(内容起点, 内容终点), ...]。
        # 只增记录、不改发射顺序与字节；供 frame_builder 求载荷注入点（= 外壳
        # 头部字节数）与 length/checksum 字段的绝对位置（plan.shell 逐层区间）。
        # 一对起点/终点 = 单次发射；repeat 展开同 id 多次 → 追加成列表。
        # align 前置 pad 归前一块、pad_to 后置 pad 归后一块（内容口径，同 handler）。
        self.block_spans: Dict[str, List[Tuple[int, int]]] = {}
        for b in self.flattened_stream:
            if not isinstance(b, Block):
                # 容器级 pad 标记：kind=align → 补到 N 边界；pad_to → 同式。
                n = (align_pad_len(cursor, b.n) if b.kind == "align"
                     else pad_to_pad_len(cursor, b.n))
                if n > 0:
                    final_hex.append(pad_hex(n, b.byte))
                    cursor += n
                continue
            if b.is_enabled and b.type != BlockType.SLOT:
                align = normalize_align(b.align)
                pad_to = normalize_pad_to(b.pad_to)
                pad_byte = normalize_pad_byte(b.pad_byte)
                if align:
                    n = align_pad_len(cursor, align)
                    if n > 0:
                        final_hex.append(pad_hex(n, pad_byte))
                        cursor += n
                val = b.hex_value or ("00" * b.byte_length)
                # E1-2 (B6): LITTLE-endian blocks reverse their whole byte
                # sequence at emission. Length/checksum handlers already ran
                # above on big-endian order — mirrors the frontend, where
                # refs feed _encodeFieldBytes (unreversed) and the reversal
                # happens in the getFieldBytes wrapper at emit time.
                if str(getattr(b, "endianness", None) or "BIG").upper() == "LITTLE":
                    val = _reverse_hex_pairs(val)
                # 转义不在此层（N4 定案：传输层 · 内核转义后套壳）——本函数输出
                # 逻辑字节；线上转义见 backend/core/escape.py（dispatch/sequence 调用）。
                content_start = cursor
                final_hex.append(val)
                cursor += len(re.sub(r"\s+", "", val)) // 2
                self.block_spans.setdefault(b.id, []).append((content_start, cursor))
                if pad_to:
                    n = pad_to_pad_len(cursor, pad_to)
                    if n > 0:
                        final_hex.append(pad_hex(n, pad_byte))
                        cursor += n

        return " ".join(final_hex)

    def flatten(self) -> List[object]:
        """块森林 → 扁平流（`_PadMark` | `Block`）——发射与**解码共用一份**（改一必改二）。

        R10（§8.48）：`core/field_decode` 把一帧逆向还原成「字段 = 值」时，布局算法
        必须与这里逐字同源（presence 门 → repeat ×N → 容器 pad 标记 → 叶按游标
        align/content/pad_to），否则解出来的区间会与真实帧错位。故把 flatten 抽成
        公开方法：编码 `process()` 调它，解码也调它拿同一份流。
        """
        self.flattened_stream = []
        for block in self.root_blocks:
            self._flatten_recursive(block)
        return self.flattened_stream

    def _process_recursive(self, block: Block):
        # Containers are wrappers: recurse into children, no self-logic needed
        # (fixed blocks already carry hex_value).
        if block.children:
            for child in block.children:
                self._process_recursive(child)

    def _flatten_recursive(self, block: Block):
        # Containers are groupings and emit no bytes; only atomic (leaf) blocks
        # join the stream, in document order:
        #   Container(HeaderBlock, LengthBlock, PayloadContainer(...), CRCBlock)
        if block.is_container:
            # E1-5 (B7): repeat 展开 —— 容器子树整体重复 N 次（repeat_count 已在
            # datahub.to_block 按 NONE/FIXED/DYNAMIC resolve）。与前端
            # _encodeFieldBytes 组分支 + _repeatCount byte-equal。
            reps = max(0, block.repeat_count)
            # N5 (G4): 容器级 align 首副本前 / pad_to 末副本后补位 —— 容器不进
            # 发射流，pad 以标记形式挂子树首/尾，发射期按绝对游标解析。repeat 0
            # → 不发字节也不补（前端 emitNode n<=0 早退同口径）。
            align = normalize_align(block.align)
            pad_to = normalize_pad_to(block.pad_to)
            pad_byte = normalize_pad_byte(block.pad_byte)
            if reps > 0 and align:
                self.flattened_stream.append(_PadMark("align", align, pad_byte))
            for _ in range(reps):
                for child in block.children:
                    self._flatten_recursive(child)
            if reps > 0 and pad_to:
                self.flattened_stream.append(_PadMark("pad_to", pad_to, pad_byte))
        else:
            self.flattened_stream.append(block)


# E1-1 (B5): 有符号整数 → 按位宽两补码。与前端
# frontend/src/utils/InstructionEncoder.js getFieldBytes 的 INT_SIGNED 分支
# byte-equal —— 向量表锚定在 backend/tests/test_encode_int_signed.py 与
# frontend/src/utils/__tests__/InstructionEncoder.test.js（两端逐行同步，改一必改二）。
_DECIMAL_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")


def _floor_numeric(value) -> int:
    """E1-1/E1-3 统一解析口径（与前端 INT_SIGNED/BCD 分支 byte-equal）：
    - number（bool 除外）：floor，非有限 → 0；
    - 严格十进制字符串：trim 后正则匹配则 floor，否则 0（"FF"/"0x.."/"1e3" → 0）；
    - 其他类型（bool/null/缺失）→ 0。
    """
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        f = float(value)
        return math.floor(f) if math.isfinite(f) else 0
    if isinstance(value, str):
        s = value.strip()
        if _DECIMAL_RE.match(s):
            try:
                f = float(s)
            except ValueError:
                return 0
            return math.floor(f) if math.isfinite(f) else 0
    return 0


def encode_int_signed(value, byte_len: int) -> str:
    """INT_SIGNED 值 → 两补码大端 hex（mod 2^(8*byte_len)，溢出环绕）。

    解析口径见 _floor_numeric；byte_len <= 0 返回空串。
    与前端 getFieldBytes 的 INT_SIGNED 分支 byte-equal（E1-1，向量表锚定
    backend/tests/test_encode_int_signed.py，改一必改二）。
    """
    if byte_len <= 0:
        return ""
    v = _floor_numeric(value)
    masked = v & ((1 << (byte_len * 8)) - 1)
    return f"{masked:0{byte_len * 2}X}"


def encode_bcd(value, byte_len: int) -> str:
    """E1-3 (B3): BCD_CODE 值 → 大端 packed BCD hex。

    数字逐 nibble 打包：floor 解析后取绝对值（负号无 nibble 表达，与前端
    通用路径 abs 口径一致），超长截高位保低 2*byte_len 位数字，高位补 0。
    与前端 getFieldBytes 的 BCD_CODE 分支 byte-equal（改一必改二）。
    """
    if byte_len <= 0:
        return ""
    digits = str(abs(_floor_numeric(value)))
    nib = byte_len * 2
    kept = digits[-nib:] if len(digits) > nib else digits
    return kept.zfill(nib)


def _to_number(value) -> float:
    """JS Number(value) 口径：null→0，bool→1/0，数字字符串→数值，其余→NaN。"""
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def _finite_or(x, default: float) -> float:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def encode_scaled(value, factor, offset, byte_len: int) -> str:
    """E1-3 (B4): SCALED_DECIMAL → (value+offset)*factor 定标 → 定宽 hex。

    factor/offset 空（None/''）或非有限 → 1/0（恒等回归，与前端同口径）；
    value 非有限（NaN 路径）→ 结果 0；定标后 abs(floor)，mod 2^(8*byte_len)
    截高位。与前端 getFieldBytes 的 SCALED_DECIMAL 定标分支 byte-equal。
    """
    if byte_len <= 0:
        return ""
    base = _to_number(value)
    off = 0.0 if offset is None or offset == "" else _finite_or(offset, 0.0)
    fac = 1.0 if factor is None or factor == "" else _finite_or(factor, 1.0)
    scaled = (base + off) * fac
    n = abs(math.floor(scaled)) if math.isfinite(scaled) else 0
    mask = (1 << (byte_len * 8)) - 1
    return f"{n & mask:0{byte_len * 2}X}"


def _float_number(value) -> float:
    """E1-4 统一 float 解析口径（与前端 FLOAT_IEEE 分支 byte-equal）：
    - number（bool 除外）：原样（非有限 → 0）；
    - 严格十进制字符串：trim 后正则匹配 → 浮点（非有限 → 0），否则 0；
    - bool → 1/0；其他类型（null/缺失）→ 0。
    """
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        f = float(value)
        return f if math.isfinite(f) else 0.0
    if isinstance(value, str):
        s = value.strip()
        if _DECIMAL_RE.match(s):
            try:
                f = float(s)
            except ValueError:
                return 0.0
            return f if math.isfinite(f) else 0.0
    return 0.0


def encode_float_ieee(value, byte_len: int = 4) -> str:
    """R5: FLOAT_IEEE 值 → IEEE 754 大端（网络序）hex。

    - ``byte_len == 4``（bits=32）→ ``>f``，8 hex，**恒 4 字节**（存量行为，
      缺省参数即此路径，逐字节不变）；
    - ``byte_len == 8``（bits=64）→ ``>d``，16 hex，**恒 8 字节**（R5 新增）；
    - 其余长度 → 仍按 f32 出（调用方 ``datahub.to_block`` 只在 4/8 分派，
      契约外长度由 W 提醒兜底，保持既有缺省不放大影响面）。

    有限值经 struct 转换（round-to-nearest-even，与 JS Float32Array/Float64Array
    同）；f32 超出表示范围 → ±Infinity（IEEE 溢出，对齐 JS Float32Array 语义）。
    解析口径 `_float_number` 两端共用：**非有限值一律归 0**，故 NaN/±Inf 输入
    两种位宽都出全零（f64 亦然，不会真的写出 NaN 位型）。

    与前端 getFieldBytes 的 FLOAT_IEEE 分支 byte-equal（改一必改二），
    向量表 vectors/float_ieee.json 的 f32/f64 两组锚定双端测试。
    """
    f = _float_number(value)
    fmt = ">d" if byte_len == 8 else ">f"
    try:
        packed = struct.pack(fmt, f)
    except OverflowError:
        packed = struct.pack(fmt, math.copysign(math.inf, f))
    return packed.hex().upper()


def _iso_ms(base_time):
    """E1-6 (B8): ISO-8601 时间串（含尾 Z / 空格分隔）→ epoch ms；非法/缺失 → None。

    对齐 JS Date.parse 的失败返回 NaN —— 消费方按「非法 → 契约外回落」处理。
    naive（无时区）按本地时区解释，与 JS `new Date('…')` 本地语义一致。
    """
    if not isinstance(base_time, str) or not base_time.strip():
        return None
    s = base_time.strip()
    if s[-1:] in ("Z", "z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s).timestamp() * 1000
    except ValueError:
        return None


def encode_time_accumulator(base_time, now_ms, byte_len: int) -> str:
    """E1-6 (B8): TIME_ACCUMULATOR → floor((now − base_time)/1000) 秒，定宽大端。

    与前端 getFieldBytes 的 TIME_ACCUMULATOR 分支 byte-equal（改一必改二）：
    秒数 abs 后 mod 2^(8·byte_len)（负 → abs 同通用路径口径）；base 非法 /
    now 非有限 → None（调用方不覆盖 hex_value，保持既有 cfg.hex/zeros 现状，
    与前端「非法 base 回落 value 路径」同为契约外各自现状锚）。
    """
    base = _iso_ms(base_time)
    if base is None or isinstance(now_ms, bool) or not isinstance(now_ms, (int, float)) \
            or not math.isfinite(now_ms):
        return None
    secs = math.floor((now_ms - base) / 1000)
    return f"{abs(secs) & ((1 << (8 * byte_len)) - 1):0{2 * byte_len}X}"


def encode_time_epoch(unit, now_ms, byte_len: int) -> str:
    """R23 (§8.52 排期): TIME_EPOCH → 绝对 Unix 时间戳，定宽大端。

    与前端 getFieldBytes 的 TIME_EPOCH 分支 byte-equal（改一必改二）：
    unit='ms' 取墙钟毫秒、其余（缺省 's'）取秒 —— abs 后按位掩到
    2^(8·byte_len)（与 encode_time_accumulator 的 ``& mask`` 同式），位宽
    不够即截低位（4 字节秒值覆盖到 2106；毫秒需 ≥5 字节），靠定宽截断而非
    报错，与通用整数路径同口径。now 非有限 → None（调用方不覆盖 hex_value，
    保持既有 cfg.hex/zeros 现状，同 encode_time_accumulator 的契约外锚）。
    """
    if isinstance(now_ms, bool) or not isinstance(now_ms, (int, float)) \
            or not math.isfinite(now_ms):
        return None
    raw = math.floor(now_ms) if str(unit or "s").lower() == "ms" \
        else math.floor(now_ms / 1000)
    return f"{abs(raw) & ((1 << (8 * byte_len)) - 1):0{2 * byte_len}X}"


def encode_auto_counter(value, start_val, step, max_val, byte_len: int) -> str:
    """E1-6 (B8): AUTO_COUNTER → (Current + Step) % Max，定宽大端。

    与前端 getFieldBytes 的 AUTO_COUNTER 分支 byte-equal（改一必改二）：
    Current = value（非 None/非空串）否则 start_val；解析 = _floor_numeric 同款
    （bool → 0；number floor、非有限 → 0；严格十进制字符串 floor；其余 → 0）；
    step 同解析，缺省 → 0；max 非有限/≤0 → 不回绕；回绕用双重取模
    ((n%max)+max)%max 消平 JS/Python 负余数差异；结果 abs(floor) mod
    2^(8·byte_len)。运行时 computed/input 仅前端有（BE 静态口径，同 DYNAMIC
    repeat 先例）；跨帧自动递增状态机不在编码器（纯函数）。
    """
    def floor_num(x):
        if isinstance(x, bool):
            return 0
        if isinstance(x, (int, float)):
            return math.floor(x) if math.isfinite(x) else 0
        if isinstance(x, str) and re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", x.strip()):
            f = float(x.strip())
            return math.floor(f) if math.isfinite(f) else 0
        return 0

    has_cur = value is not None and value != ""
    n = floor_num(value if has_cur else start_val) + floor_num(step)

    if isinstance(max_val, str) and re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", max_val.strip()):
        mx = float(max_val.strip())
        if not math.isfinite(mx):
            mx = None
    elif isinstance(max_val, (int, float)) and not isinstance(max_val, bool):
        mx = max_val if math.isfinite(max_val) else None
    else:
        mx = None
    if mx is not None and mx > 0:
        n = ((n % mx) + mx) % mx
    return f"{abs(math.floor(n)) & ((1 << (8 * byte_len)) - 1):0{2 * byte_len}X}"


# R25（§8.57 · §8.52 排期第 5 批 · BUSINESS_SCENARIOS 挂账 ②）：加扰 / 混淆字段。
# 与 FE utils/scramble.js **逐行同语义**（共享向量 vectors/scramble.json 双端锚定，改一必改二）：
#   XOR_SEED  out[i] = plain[i] ^ seed[i % len(seed)]            —— 种子按字节循环
#   BIT_ROLL  out[i] = (plain[i]<<n | plain[i]>>(8-n)) & 0xFF     —— 逐字节左旋，n = roll%8
# 明文空 / 非 hex → None（调用方置 hex_value=None → 发射期 "00"*byte_length 补零，与前端
# 「明文非法 → 补零」同字节）；mode / seed / roll 契约外 → **恒等**（保存侧 _validate_scrambles
# 已 400 硬拦，这里只为「出线必有确定值」，不静默改语义）。
_SCRAMBLE_MODES = ("XOR_SEED", "BIT_ROLL")
_SCRAMBLE_HEX_RE = re.compile(r"[0-9A-Fa-f]+")
# 十进制字面量：不收 0x/0b —— JS Number('0x10')=16 而 float('0x10') 抛错，不设闸两端各判各的。
_SCRAMBLE_NUM_RE = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")


def _scramble_plain_bytes(text) -> Optional[bytes]:
    """明文 → 字节；空 / 非 hex → None（调用方补零）。奇长丢末尾半字节（同 FE）。"""
    if not isinstance(text, str):
        return None
    clean = re.sub(r"\s+", "", text)
    if not clean or _SCRAMBLE_HEX_RE.fullmatch(clean) is None:
        return None
    if len(clean) % 2:
        clean = clean[:-1]
    return bytes.fromhex(clean)


def _scramble_seed_bytes(seed) -> bytes:
    """XOR 种子 → 字节；空 / 奇长 / 非 hex → b''（= 恒等，同 FE scrambleSeedBytes）。"""
    if seed is None:
        return b""
    clean = re.sub(r"\s+", "", str(seed))
    if not clean or _SCRAMBLE_HEX_RE.fullmatch(clean) is None or len(clean) % 2:
        return b""
    return bytes.fromhex(clean)


def _scramble_roll_bits(roll) -> int:
    """位旋转位数 → 0..7（负值双取模消平 JS/Python 余数差）；非有限 / 非数字 → 0。"""
    s = str("" if roll is None else roll).strip()
    if _SCRAMBLE_NUM_RE.fullmatch(s) is None:
        return 0
    try:
        n = float(s)
    except ValueError:
        return 0
    if not math.isfinite(n):
        return 0
    t = int(n)  # JS Math.trunc 同向（向零取整）
    return ((t % 8) + 8) % 8


def _scramble_apply(data: bytes, mode=None, seed=None, roll=None, inverse: bool = False) -> bytes:
    """加扰核心：反变换只是「左旋 → 右旋」的差别（XOR 自反，逆变换共用 XOR 路径）。"""
    m = str("XOR_SEED" if mode is None else mode).strip().upper()
    if m == "BIT_ROLL":
        n = _scramble_roll_bits(roll)
        if inverse:
            n = (8 - n) % 8
        if n:
            data = bytes(((b << n) | (b >> (8 - n))) & 0xFF for b in data)
        return data
    if m == "XOR_SEED":
        s = _scramble_seed_bytes(seed)
        if s:
            data = bytes(b ^ s[i % len(s)] for i, b in enumerate(data))
        return data
    return data  # 契约外 mode → 恒等


def encode_scramble(plain_hex, mode=None, seed=None, roll=None) -> Optional[str]:
    """SCRAMBLE 明文 → 加扰后 hex（大写无空白）；明文空 / 非 hex → None（补零）。"""
    data = _scramble_plain_bytes(plain_hex)
    if data is None:
        return None
    return _scramble_apply(data, mode, seed, roll).hex().upper()


def unscramble_hex(wire_hex, mode=None, seed=None, roll=None) -> Optional[str]:
    """R25 解码侧：线上 hex → 明文 hex（`core/field_decode` 对偶 FE InstructionDecoder）。

    与 `encode_scramble` 互逆（XOR 自反、左旋的逆是右旋）→ 解码再编码是**不动点**。
    """
    data = _scramble_plain_bytes(wire_hex)
    if data is None:
        return None
    return _scramble_apply(data, mode, seed, roll, inverse=True).hex().upper()


# N2 (G2): utf8 编码前的孤立代理项识别 —— high 无后随 low / low 无前随 high
# → U+FFFD（TextEncoder 的 WHATWG 替换规则）；成对代理项保留 → 合码点 4 字节。
_LONE_SURROGATE_RE = re.compile(
    "[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]"
)


def encode_string(value, byte_len, encoding=None, pad_char=None) -> str:
    """N2 (G2): 定长文本编码 — ascii/utf8 × pad/截断，定宽 hex。

    与前端 getFieldBytes 的 string 分支 byte-equal（test_encode_string 向量表
    锚定，改一必改二）：
    - 取值口径对齐 JS `String(value || '')`：falsy（None/''/0/False/NaN）→ ''，
      True → 'true'（JS String(true)）、±inf → 'Infinity'/'-Infinity'；
    - ascii 按 code point &0xFF（Python str 迭代 = 码点，与前端 for...of
      code-point 迭代 byte-equal，代理对单字节口径）；
    - utf8 走 UTF-8 字节流，孤立代理项 → U+FFFD（对齐 TextEncoder）；
    - byte_len>0 → pad/截断定长（floor 归一），否则变长原样（to_block 分支闸
      byte_len>0，本函数级口径与前端「byte_len 缺失/0 → 变长」对齐）；
    - pad_char 按 2 位以内 hex 严格解析（非法/空/None → 0x00），与前端同一规则。
    """
    if value is None or value == 0:
        s = ""
    elif isinstance(value, bool):  # 仅剩 True：JS String(true) = 'true'
        s = "true"
    elif isinstance(value, float) and value != value:  # NaN → JS falsy → ''
        s = ""
    elif isinstance(value, float) and math.isinf(value):
        s = "Infinity" if value > 0 else "-Infinity"
    else:
        s = str(value)

    enc = str(encoding or "ascii").lower()
    if enc == "utf8":
        # 孤立代理项 → U+FFFD（对齐 TextEncoder 的 WHATWG 替换规则；成对代理项
        # 保留 → 合码点 4 字节）。注意 errors='replace' 在**编码**侧产出的是
        # b'?'（0x3F）而非 U+FFFD，必须先手工替换。
        s_utf8 = _LONE_SURROGATE_RE.sub("�", s)
        data = list(s_utf8.encode("utf-8"))
    else:
        data = [ord(ch) & 0xFF for ch in s]

    try:
        target = int(byte_len)
    except (TypeError, ValueError):
        target = 0
    if target > 0:
        pad_raw = "" if pad_char is None else str(pad_char)
        if 0 < len(pad_raw) <= 2 and all(c in "0123456789abcdefABCDEF" for c in pad_raw):
            pad_b = int(pad_raw, 16)
        else:
            pad_b = 0
        if len(data) > target:
            data = data[:target]
        while len(data) < target:
            data.append(pad_b)
    return "".join(f"{b:02X}" for b in data)
