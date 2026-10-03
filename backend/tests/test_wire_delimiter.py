"""§9.7 ① / §8.34 B1-2 销项：**出线方向** —— 载荷含定界字节时「有 LEN = 不需要转义」
的**公开规范佐证 + 仓内仿真**（2026-10-03）。

背景：`DESIGN_Decisions.md` D13「边界（转义）」把「链路壳有 LEN → 不需要转义」记为
**经验判定**，并把「真实设备是否异常」挂进 `DESIGN_CorePipeline.md` §9.7 人工验证必查 ①
（观察对象 = §8.27 复跑那条 `… FA FA … ED …` 的 17B 链路帧）。本批按 **§8.35 同一套
方法（拿公开规范模拟真机）** 补证据，三组各钉一角：

* **A 组 · 公开规范真实帧**：IEC 60870-5-104（起始 68H + 长度域）、DL/T 645-2007
  （68H…L…16H + 0x33 换算）、Modbus TCP（MBAP 长度域）—— 三条**有长度域**的协议，
  载荷里出现 68H / 16H / 7EH 照常成帧，按长度域即可完整切出；
* **B 组 · 本仓出线仿真**：三层配方帧（`vectors/wrap.json::three`）注入**含每一层
  头尾、且含规范定界字节**的内核 → 外壳定界字节**字面不转**、壳内 LEN 按**线上
  （转义后）字节**重算、自外向内按 LEN 反解出与注入**逐字节相同**的内核；
* **C 组 · 反例**：**无 LEN** 的纯定界帧（RFC 1662 旗标同构口径）—— 载荷含定界字节
  必然断错帧，开转义后才安全，收侧 `unescape_bytes` 可逆。

**结论（同步写进 D13 实施注与 §9.7 ①）**：D13 判定由「经验」升级为「与公开规范
一致」；残余风险**收窄**为「目标设备是否按其声明的协议实现」→ 转触发式。
"""

import unittest

from backend.core.escape import (
    build_table,
    escape_bytes,
    escape_hex,
    unescape_bytes,
)
from backend.core.frame_builder import build_wrapped
from vectors.load_vectors import load_vectors

# 三层配方帧主向量（CP2b / D11-① 单一真相源，与 test_wrap_api / InstructionProcessor 同读）
THREE = load_vectors("wrap", "three")

# 三型定界 / 转义表（前缀 7D、旗标 ED → 7DCD = ED^0x20，与 RFC 1662 §4.2 同构）
FLAG_TABLE = {"enabled": True, "pairs": [["ED", "7DCD"], ["7D", "7D5D"]]}


def _b(hex_str):
    """pretty / 紧凑 hex 都吃 → bytes。"""
    return bytes.fromhex(hex_str.replace(" ", ""))


def _h(data):
    """bytes → pretty hex（断言文案可读）。"""
    return " ".join(f"{byte:02X}" for byte in data)


def _split_by_length(frame, length_at, length_len, head_len, trailer_len):
    """LEN 协议的**收侧口径**（与 `response_match` 的 length 元素同构）：
    头 `head_len` 字节 → 读长度域 → 取 LEN 字节 → 余下 `trailer_len` 字节为尾。
    返回 (头, 长度域值, 载荷, 尾)；头/尾长度对不上即判结构性失配。"""
    length = int.from_bytes(frame[length_at:length_at + length_len], "big")
    start = length_at + length_len
    head, payload, trailer = frame[:length_at], frame[start:start + length], frame[start + length:]
    if len(head) != head_len or len(trailer) != trailer_len:
        raise AssertionError(
            f"按长度域切帧失配：head={_h(head)} trailer={_h(trailer)} len={length}"
        )
    return head, length, payload, trailer


def _chain(kernel_hex, table=None):
    """配方串行编译（与 `core/recipe_compile` 同序）：先转义内核，再逐层套壳。
    `table` 为空/None → 内核不转（escape 缺省关闭口径，逐字节不变）。"""
    frame = escape_hex(kernel_hex, table) if table else kernel_hex
    for layer in THREE["layers"]:
        frame = build_wrapped(
            layer["children"],
            [frame],
            slot_ids=[layer["slot_id"]],
            strict_fit=True,
        )["hex"]
    return frame


def _unwrap(frame_hex):
    """自外向内按 LEN 反解三层 → (每层 (头, LEN, 内层帧, 尾), 内核线上字节)。"""
    raw = _b(frame_hex)
    steps = []
    for _ in THREE["layers"]:
        head, length, payload, trailer = _split_by_length(raw, 1, 1, 1, 1)
        steps.append((head, length, payload, trailer))
        raw = payload
    return steps, raw


class PublicSpecFrameTest(unittest.TestCase):
    """A 组 · 公开规范真实帧：有长度域的协议，载荷含定界字节照样正常成帧。"""

    # ---- IEC 60870-5-104：起始 68H + 长度域（长度 = 其后所有字节） ----------
    # 公开示例（EpiSensor「IEC 101 vs 104」同值对照例）：M_ME_NC_1 12.5 MW，
    # I 格式 N(S)=5 / N(R)=3 → `68 12 0A 00 06 00 0D 01 03 00 01 00 A1 0F 00 00 00 48 41 00`
    # （68 起始 · 12 长度=18 · 4 控制字节 · ASDU 14 字节，值 00 00 48 41 = 0x41480000 小端 = 12.5）
    IEC104_EXAMPLE = "68 12 0A 00 06 00 0D 01 03 00 01 00 A1 0F 00 00 00 48 41 00"

    def test_iec104_published_example_matches_length_octet(self):
        frame = _b(self.IEC104_EXAMPLE)
        self.assertEqual(len(frame), 20)
        self.assertEqual(frame[0], 0x68)                    # 起始字节
        head, length, payload, trailer = _split_by_length(frame, 1, 1, 1, 0)
        self.assertEqual(length, len(frame) - 2)            # 长度域 = 起始 + 长度之后的全部字节
        self.assertEqual(trailer, b"")                      # 无尾定界：帧尾完全由长度域决定
        self.assertEqual(_h(head), "68")                    # 长度域之前只有起始字节
        self.assertEqual(_h(payload[:4]), "0A 00 06 00")    # 4 控制字节
        self.assertEqual(
            _h(payload[4:]), "0D 01 03 00 01 00 A1 0F 00 00 00 48 41 00"
        )

    def test_iec104_payload_with_start_byte_inside_fragments_by_length_only(self):
        """载荷内插一个 68H（对象地址第三字节 → IOA 0x680FA1，仍是合法值）：
        帧里第二个 68H **不是**新帧头 —— 按长度域切可逐字节还原，按定界字节重同步必断错。"""
        asdu = _b("0D 01 03 00 01 00 A1 0F 68 00 00 48 41 00")
        ctrl = _b("0A 00 06 00")
        frame = bytes([0x68, len(ctrl) + len(asdu)]) + ctrl + asdu

        self.assertEqual(_h(frame), "68 12 0A 00 06 00 0D 01 03 00 01 00 A1 0F 68 00 00 48 41 00")
        self.assertEqual(
            [_i for _i, byte in enumerate(frame) if byte == 0x68], [0, 14]
        )                                                   # 起始 + 载荷内 68H

        _, length, payload, _ = _split_by_length(frame, 1, 1, 1, 0)
        self.assertEqual(length, len(ctrl) + len(asdu))
        self.assertEqual(payload, ctrl + asdu)              # 长度域切 → 还原逐字节

        # 对照：把「下一个 68H 当帧头」的重同步套上去 → 断在对象地址处
        naive = frame[frame.index(b"\x68", 1):]
        self.assertEqual(_h(naive), "68 00 00 48 41 00")    # 只剩 6 字节
        self.assertNotEqual(naive[1], len(naive) - 2)       # 它报的长度 = 0，实际余 5 字节 → 断错

    # ---- DL/T 645-2007：68H … L … 16H + 数据域 0x33 换算 ---------------------
    # 公开收发示例（亿佰特 DLT645 协议页）：
    DLT645_REQ = "68 03 20 12 22 20 65 68 11 04 33 33 33 33 8D 16"
    DLT645_RSP = "68 03 20 12 22 20 65 68 91 08 33 33 33 33 33 33 33 33 DD 16"

    def test_dlt645_published_frames_checksum_and_length(self):
        for hex_str, want_l, want_cs in (
            (self.DLT645_REQ, 0x04, 0x8D),
            (self.DLT645_RSP, 0x08, 0xDD),
        ):
            with self.subTest(frame=hex_str):
                frame = _b(hex_str)
                self.assertEqual(frame[0], 0x68)            # 第一个起始符
                self.assertEqual(frame[7], 0x68)            # 第二个起始符（地址域后）
                head, length, payload, trailer = _split_by_length(frame, 9, 1, 9, 2)
                self.assertIn(frame[8], (0x11, 0x91))       # 控制码：0x11 读数据 / 0x91 正常应答
                self.assertEqual(length, want_l)            # L = 数据域字节数（不含 CS / 16H）
                self.assertEqual(len(trailer), 2)           # CS + 16H
                self.assertEqual(trailer[1], 0x16)          # 帧结束符
                self.assertEqual(sum(frame[: 10 + length]) & 0xFF, want_cs)  # CS = 首 68 至数据域末累加和
                self.assertEqual(sum(frame[: 10 + length]) & 0xFF, trailer[0])
                self.assertEqual(len(payload), want_l)
                self.assertEqual(head[0], 0x68)

    def test_dlt645_data_domain_may_contain_start_and_stop_bytes(self):
        """**关键**：0x33 换算并不保证线上不出现 68H / 16H（raw 0x35→0x68、
        raw 0xE3→0x16 即可反推）—— 真正兜住定界的是 **L 域**：按 L 切即可，
        既不需要转义、也不靠「扫 68 找头、扫 16 找尾」。"""
        raw_data = _b("35 E3")                              # 原始数据域
        stuffed = bytes((byte + 0x33) & 0xFF for byte in raw_data)
        self.assertEqual(_h(stuffed), "68 16")              # 上线后恰是起始符 / 结束符字节

        head = _b("68 03 20 12 22 20 65 68 11")
        body = bytes([len(raw_data)]) + stuffed
        frame = head + body + bytes([(sum(head) + sum(body)) & 0xFF]) + b"\x16"

        self.assertEqual(_h(frame), "68 03 20 12 22 20 65 68 11 02 68 16 3D 16")
        _, length, payload, trailer = _split_by_length(frame, 9, 1, 9, 2)
        self.assertEqual(length, 2)
        self.assertEqual(payload, stuffed)                  # 数据域里的 68 / 16 原样取出
        self.assertEqual(trailer[0], (sum(frame[: 10 + length])) & 0xFF)

        # 对照：扫 16H 当帧尾 → 在数据域里提前收帧，余下 2 字节成了残帧
        naive_end = frame.index(b"\x16", 10)
        self.assertLess(naive_end, len(frame) - 1)
        self.assertNotEqual(frame[naive_end:], b"\x16")

    # ---- Modbus TCP：MBAP 长度域（自单元号起计） -----------------------------
    def test_modbus_tcp_mbap_length_allows_any_payload_byte(self):
        """写多寄存器 PDU，寄存器值 0x6868 / 0x7E7E —— 68H 与 7EH（HDLC 旗标字节）
        都在载荷里，MBAP 长度域照常切出完整 PDU：**有长度域就不需要转义**。"""
        frame = _b("00 01 00 00 00 0B 01 10 00 00 00 02 04 68 68 7E 7E")
        length = int.from_bytes(frame[4:6], "big")
        body = frame[6:]                                    # 长度域计数自单元号起
        self.assertEqual(length, len(body))                 # 11 字节
        self.assertEqual(body[0], 0x01)                     # 单元号
        self.assertEqual(_h(body[1:]), "10 00 00 00 02 04 68 68 7E 7E")
        self.assertIn(0x68, body)
        self.assertIn(0x7E, body)
        # 按长度域切完，PDU 逐字节还原（转义一个字节都没用到）
        self.assertEqual(_h(frame[6:6 + length]), _h(body))


class RepoWireFrameTest(unittest.TestCase):
    """B 组 · 本仓出线仿真：三层壳 + 载荷含**每一层定界字节**。"""

    # 内核躺着 A/B/C 三层的头、E0/E1/E2 三层的尾，外加 68 / 16 / 7E / 7D / FA / ED
    KERNEL = "A0 B0 C0 E0 E1 E2 68 16 7E 7D FA ED"

    def test_len_recovers_kernel_containing_every_layer_delimiter(self):
        frame = _chain(self.KERNEL)
        steps, kernel = _unwrap(frame)

        self.assertEqual(len(steps), 3)
        # 每层头 = 协议头 1B + LEN 1B，尾 = 1B，且 LEN 恰好覆盖内层帧
        for index, (head, length, payload, trailer) in enumerate(steps):
            with self.subTest(layer=index):
                self.assertEqual(head[0], (0xC0, 0xB0, 0xA0)[index])      # 自外向内：C0 → B0 → A0
                self.assertEqual(len(payload), length)      # 长度域 = 内层帧字节数
                self.assertEqual(len(trailer), 1)
                self.assertEqual(trailer[0], (0xE2, 0xE1, 0xE0)[index])   # 自外向内：E2 → E1 → E0

        # 自外向内按 LEN 反解 → 内核与注入**逐字节相同**（定界字节无需转义）
        self.assertEqual(_h(kernel), _h(_b(self.KERNEL)))

        # 外壳定界字节字面在帧里（A0/B0/C0 头与 E0/E1/E2 尾**从未被转义**）
        for literal in (0xA0, 0xB0, 0xC0, 0xE0, 0xE1, 0xE2, 0x68, 0x16, 0x7E, 0x7D, 0xFA, 0xED):
            self.assertIn(literal, _b(frame))

    def test_escape_targets_kernel_only_and_shell_len_counts_wire_bytes(self):
        """开转义（缺省关闭 → 本例只是把 N4 层位口径再钉一次）：
        转义只发生在**第 0 层之前**、外壳不进转义范围；壳内 LEN 按**线上（转义后）
        字节**重算 —— 收侧按 LEN 取到的正是线上字节，`unescape_bytes` 可逆。"""
        table = build_table(FLAG_TABLE)
        kernel = "01 ED 02 7D 03"
        wire_kernel = _b(escape_hex(kernel, table))
        self.assertEqual(_h(wire_kernel), "01 7D CD 02 7D 5D 03")

        frame = _chain(kernel, table)
        steps, recovered = _unwrap(frame)

        # 外壳定界字节字面在帧里（0x7D 前缀只出现在内核域）
        for literal in (0xA0, 0xB0, 0xC0, 0xE0, 0xE1, 0xE2):
            self.assertIn(literal, _b(frame))

        self.assertEqual(recovered, wire_kernel)            # LEN 切出的是线上字节
        self.assertEqual(steps[2][1], len(wire_kernel))     # 最内层 LEN = 7（非 5）
        self.assertEqual(steps[2][1], 7)
        self.assertEqual(len(_b(kernel)), 5)                # 对照：按逻辑字节算就少 2 字节
        self.assertEqual(unescape_bytes(recovered, table), _b(kernel))  # 收侧可逆

    def test_escape_disabled_keeps_wire_bytes_identical(self):
        """escape 缺省关闭（§0 硬约束）→ 转义器不改一个字节，出线与关态逐字相同。"""
        with_escape_off = _chain(self.KERNEL, build_table({"enabled": False, "pairs": []}))
        self.assertEqual(with_escape_off, _chain(self.KERNEL))


class LenLessFramingTest(unittest.TestCase):
    """C 组 · 反例：**无 LEN** 的纯定界帧，载荷含定界字节就必须转义。"""

    def test_scan_framing_breaks_on_payload_delimiter_until_escaped(self):
        table = build_table(FLAG_TABLE)
        payload = _b("01 ED 02")
        raw_frame = b"\xFA\xFA" + payload + b"\xED"         # 无长度域：只能靠扫 ED 定帧尾

        # 未转义 → 第一个 ED 落在**载荷里**：帧尾断在 3（真帧尾在 5）——
        # 收到的载荷只剩 `01`（真载荷 `01 ED 02` 被截断），余下 `02 ED` 成残帧
        cut = raw_frame.index(b"\xED")
        self.assertEqual(cut, 3)
        self.assertEqual(raw_frame[:cut + 1], b"\xFA\xFA\x01\xED")
        self.assertEqual(raw_frame[cut + 1:], b"\x02\xED")
        self.assertEqual(raw_frame[:cut + 1][2:-1], b"\x01")   # 与真载荷 `01 ED 02` 不等

        # 开转义 → 载荷里不再有裸旗标字节，唯一 ED = 真帧尾；收侧可逆
        safe = escape_bytes(payload, table)
        self.assertEqual(_h(safe), "01 7D CD 02")
        self.assertNotIn(0xED, safe)
        framed = b"\xFA\xFA" + safe + b"\xED"
        self.assertEqual(framed.rindex(b"\xED"), len(framed) - 1)
        self.assertEqual(unescape_bytes(safe, table), payload)

    def test_len_framing_needs_no_escape_for_same_payload(self):
        """同一份载荷换成「有 LEN」的壳 → 一字节不用转就切得出来（与 C 组同载荷对照）。"""
        payload = "01 ED 02"
        steps, kernel = _unwrap(_chain(payload))
        self.assertEqual(_h(kernel), _h(_b(payload)))       # 未转义也逐字节还原
        self.assertEqual(steps[2][1], 3)
        self.assertIn(0xED, _b(_chain(payload)))            # 载荷里的 ED 原样在帧中


if __name__ == "__main__":
    unittest.main()
