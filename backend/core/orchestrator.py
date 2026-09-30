import math
import re
import struct
from datetime import datetime
from typing import List, Tuple, Dict
from backend.schemas.block import Block, BlockType
from backend.schemas.template import Layer
from backend.core.graph import GraphEngine
from backend.handlers.length import LengthHandler
from backend.handlers.checksum import ChecksumHandler
from backend.handlers.bitfield import BitfieldHandler
# from backend.handlers.escape import EscapeHandler (To be implemented)


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
        self.flattened_stream = []
        for block in self.root_blocks:
            self._flatten_recursive(block)

        # 3. Range-dependent logic (length / checksum) runs on the flattened
        #    stream, because these blocks reference start/end IDs of siblings
        #    and descendants. Children's hex values are already final here.
        flat_tuples: List[Tuple[str, Block]] = [("global", b) for b in self.flattened_stream]

        for block in self.flattened_stream:
            if block.type in [BlockType.LENGTH, BlockType.CHECKSUM] or str(block.type) == "bitfield":
                handler_key = block.type
                if isinstance(block.type, BlockType):
                    handler_key = block.type.value

                handler = self.handlers.get(handler_key)
                if handler:
                    block.hex_value = handler.calculate(block, flat_tuples)

        # 4. Emit final hex (slots are placeholders and emit nothing).
        final_hex = []
        for b in self.flattened_stream:
            if b.is_enabled and b.type != BlockType.SLOT:
                val = b.hex_value or ("00" * b.byte_length)
                # E1-2 (B6): LITTLE-endian blocks reverse their whole byte
                # sequence at emission. Length/checksum handlers already ran
                # above on big-endian order — mirrors the frontend, where
                # refs feed _encodeFieldBytes (unreversed) and the reversal
                # happens in the getFieldBytes wrapper at emit time.
                if str(getattr(b, "endianness", None) or "BIG").upper() == "LITTLE":
                    val = _reverse_hex_pairs(val)
                # ESCAPING LOGIC (Placeholder): val = self.escape_handler.process(val)
                final_hex.append(val)

        return " ".join(final_hex)

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
            for _ in range(max(0, block.repeat_count)):
                for child in block.children:
                    self._flatten_recursive(child)
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


def encode_float_ieee(value) -> str:
    """E1-4 (B2): FLOAT_IEEE 值 → IEEE 754 float32 大端（网络序）8 hex，恒 4 字节。

    有限值经 struct '>f' 转换（round-to-nearest-even，与 JS Float32Array 同）；
    超出 f32 表示范围 → ±Infinity（IEEE 溢出，对齐 JS Float32Array 转换语义）。
    与前端 getFieldBytes 的 FLOAT_IEEE 分支 byte-equal（改一必改二）。
    """
    f = _float_number(value)
    try:
        packed = struct.pack(">f", f)
    except OverflowError:
        packed = struct.pack(">f", math.copysign(math.inf, f))
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
