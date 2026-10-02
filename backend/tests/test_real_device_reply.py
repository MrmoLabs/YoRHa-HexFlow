"""§9.7 ④ 真机应答模拟 —— 「应答是否带转义字节」销项（§8.35）。

背景：`escape` 反转义此前未接进 `response_match`，「真机应答是否也带转义字节」
在环回下无法定论，`DESIGN_CorePipeline.md` §9.7 必查 ④ 与 D15 关联项一直挂着
「需真实设备帧」。本模块按**公开规范里的真机行为**做模拟应答，把口径钉成用例
—— 不再等硬件。

调研（2026-10-02，两条规范，都说明转义是**双向对称**的链路性质）：

1. **DL/T 645-2007《多功能电能表通信协议》**（帧内字段变换型 —— 与本仓
   「内核先转义再套壳」同类的层位）：
   - 数据域发送前**逐字节 +0x33**、接收端 −0x33，**请求与应答同样处理**
     （规范示例报文：请求 `68 … 11 04 33 33 34 33 AE 16`、
     应答 `68 … 91 08 33 33 34 33 B9 34 33 33 6D 16` —— 应答数据域照样带 +33）；
   - **L = 数据域线上字节长度**（含 +33 之后）、**CS 按「已加 0x33 的实际发送
     字节」累加** → **线上口径**（LEN/CS 覆盖转义后字节）。
2. **RFC 1662 §4.2 / RFC 1549（PPP in HDLC Framing）**（链路塞字节型）：
   - 0x7D octet-stuffing **双向**（"sending and receiving implementations"、
     "Receiving implementations MUST correctly process all Control Escape
     sequences"）；转义样例 `0x7D→0x7D5D`、`0x11→0x7D31` —— **正是本仓转义表的
     默认示例对**；
   - **FCS 在塞字节之前算**（"After FCS computation, the transmitter examines…" /
     "Prior to FCS computation, the receiver examines…"）→ **逻辑口径**。

**拍板（PLAN §8.34 C-4 = A）**：应答**带**转义字节（对称，真机不会只发不回）；
而 L/CS 覆盖哪种字节取决于该层的变换层位，两种都真实存在 —— 本仓自己就是混合
的（内核先算 LEN/CS 再转义 = RFC 1662 型；外壳转义后再算 = DL/T 645 型，见
`backend/core/escape.py` 模块文档「内核域按逻辑字节、壳域按线上字节」）。

故收侧口径 = **先线上、后逻辑**：`match_response(..., unescape=表)` 第 1 次按
线上字节判，未过且表确实能改变字节时第 2 次按还原后的逻辑字节判，第 2 次通过
即命中；两次都不过则报**第 1 次（线上口径）**的 reasons。`escape` 缺省关闭 →
调用方传 `unescape=None` → 单口径，与存量逐字节一致（§0 硬约束）。

Run from repo root: python -m unittest discover -s backend/tests
"""

import tempfile
import unittest
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core import transport
from backend.core.escape import build_table, escape_bytes, unescape_bytes
from backend.core.response_match import match_response, normalize_spec
from backend.db.database import Base
from backend.routers import dispatch as dispatch_mod
from backend.routers.dispatch import TransactionRequest, dispatch_transaction
from backend.routers.transport import set_transport_config
from vectors.load_vectors import load_vectors

# 本仓转义表默认示例形态（7D 型字头 + 0x10 型前缀）—— 与 RFC 1662 样例同形
PAIRS = [["7D", "7D5D"], ["11", "7D31"], ["0D", "7D0A"]]
TABLE = build_table({"enabled": True, "pairs": PAIRS})
UNESCAPE = (lambda b: unescape_bytes(b, TABLE))

# 内核帧（编码期形态）：A5 | LEN(=len(payload)) | payload | SUM8(整帧除字段自身)
# LEN/CS 均按**逻辑字节**算完 —— 与本仓内核域口径同（RFC 1662 型）
BARE_SPEC = normalize_spec({
    "mode": "rules",
    "prefix": "A5",
    "length": {"offset": 1, "byte_length": 1, "offset_val": -3},
    "checksum": {"algo": "sum", "field_offset": 5, "field_byte_length": 1},
})

# DL/T 645 型：先转义、后算 LEN/CS —— 声明值按**线上字节**自洽
# 线上帧 8B（载荷转义后 5B），LEN=05 = 8-3；校验字段落在帧尾 index 7
BARE_WIRE_SPEC = normalize_spec({
    "mode": "rules",
    "prefix": "A5",
    "length": {"offset": 1, "byte_length": 1, "offset_val": -3},
    "checksum": {"algo": "sum", "field_offset": 7, "field_byte_length": 1},
})


def _bare(payload: bytes) -> bytes:
    """编码期内核帧（LEN/CS 覆盖逻辑字节）。"""
    body = bytes([0xA5, len(payload)]) + payload
    return body + bytes([sum(body) % 256])


def _bare_wire_style(payload: bytes) -> bytes:
    """DL/T 645 型应答帧（先转义、LEN/CS 覆盖线上字节）。"""
    body = bytes([0xA5, len(escape_bytes(payload, TABLE))]) + escape_bytes(payload, TABLE)
    return body + bytes([sum(body) % 256])


def _payload() -> bytes:
    """载荷含可转义字节 0x11 / 0x7D —— 真机回的数据里出现定界字节是常态。"""
    return bytes([0x11, 0x7D, 0x02])


class UnescapeRoundTripTests(unittest.TestCase):
    """`unescape_bytes` = `escape_bytes` 的逆（共享向量表驱动，双端同一份数据）。"""

    def test_shared_vector_roundtrip(self):
        for pairs, src, _want in load_vectors("escape"):
            table = build_table({"enabled": True, "pairs": pairs})
            raw = bytes.fromhex(src.replace(" ", ""))
            self.assertEqual(
                unescape_bytes(escape_bytes(raw, table), table), raw,
                f"转义后未还原：pairs={pairs} src={src}",
            )

    def test_empty_table_is_identity(self):
        self.assertEqual(unescape_bytes(b"\x01\x7D\x02", {}), b"\x01\x7D\x02")
        self.assertEqual(unescape_bytes(b"", TABLE), b"")

    def test_longest_match_wins_left_to_right(self):
        # 7D5D / 7D31 / 7D0A 共用 7D 字头 → 按最长（同为 2B，取插入序）左到右取
        self.assertEqual(unescape_bytes(bytes.fromhex("7D5D7D317D0A"), TABLE),
                         bytes.fromhex("7D110D"))
        # 未命中转义字头的字节原样带过（5D 不是任何 to 序列的开头）
        self.assertEqual(unescape_bytes(bytes.fromhex("5D01"), TABLE),
                         bytes.fromhex("5D01"))


class LogicalStyleReplyTests(unittest.TestCase):
    """RFC 1662 型真机（本仓内核口径）：先算 LEN/CS 再转义 → 收侧需还原后判。"""

    def setUp(self):
        self.sent = escape_bytes(_bare(_payload()), TABLE)      # 线上请求帧 8B
        self.reply = escape_bytes(
            _bare(bytes([0x11, 0x7D, 0x02])), TABLE             # 线上应答帧 8B
        )

    def test_wire_only_view_mismatches(self):
        # 没有第二口径时的既有症状：LEN 声明逻辑 03、线上帧长 08 → LENGTH_MISMATCH
        ok, reasons = match_response(BARE_SPEC, self.sent, self.reply)
        self.assertFalse(ok)
        self.assertTrue(reasons[0].startswith("LENGTH_MISMATCH"), reasons)
        self.assertIn("CHECKSUM_MISMATCH", reasons[1])

    def test_unescape_second_verdict_matches(self):
        ok, reasons = match_response(
            BARE_SPEC, self.sent, self.reply, unescape=UNESCAPE
        )
        self.assertTrue(ok, reasons)
        self.assertEqual(reasons, [])

    def test_reply_bytes_really_carried_escapes(self):
        # 前提断言：应答确实带转义字节（逻辑 6B → 线上 8B，且 11/7D 被展开）
        logical = _bare(bytes([0x11, 0x7D, 0x02]))
        self.assertEqual(len(logical), 6)
        self.assertEqual(len(self.reply), 8)
        self.assertNotEqual(self.reply, logical)
        self.assertEqual(unescape_bytes(self.reply, TABLE), logical)

    def test_corrupted_reply_not_masked_by_second_verdict(self):
        # 两次口径都不过 → 报第 1 次（线上口径）的 reasons，绝不 fail-open
        bad = bytearray(self.reply)
        bad[7] ^= 0xFF                                   # 改线上校验字节
        ok, reasons = match_response(BARE_SPEC, self.sent, bytes(bad), unescape=UNESCAPE)
        self.assertFalse(ok)
        self.assertTrue(reasons, "失配必须给出 reasons")
        # 第 1 次口径的两条理由（长度 + 校验）都要在 —— 诊断不因第二口径而稀释
        self.assertTrue(any(r.startswith("LENGTH_MISMATCH") for r in reasons), reasons)
        self.assertTrue(any("CHECKSUM_MISMATCH" in r for r in reasons), reasons)

    def test_table_that_changes_nothing_skips_second_verdict(self):
        # 表对两侧都无作用 → 第二次等价于第一次，直接返回首次结果
        plain = _bare(bytes([0x02, 0x03, 0x04]))         # 不含可转义字节的 6B 帧
        ok, reasons = match_response(
            BARE_SPEC, plain, plain,
            unescape=(lambda b: unescape_bytes(b, build_table(
                {"enabled": True, "pairs": [["F0", "F0F0"]]}
            ))),
        )
        self.assertTrue(ok, reasons)


class WireStyleReplyTests(unittest.TestCase):
    """DL/T 645 型真机：LEN/CS 覆盖线上字节 → 第 1 次（线上口径）即命中。"""

    def setUp(self):
        self.reply = _bare_wire_style(_payload())         # 8B，LEN=06 按线上

    def test_wire_verdict_matches_first_pass(self):
        ok, reasons = match_response(BARE_WIRE_SPEC, self.reply, self.reply,
                                     unescape=UNESCAPE)
        self.assertTrue(ok, reasons)

    def test_unescaping_first_would_break_it(self):
        # 反证「必须先线上」：把应答先还原成逻辑字节再判 → DL/T 645 型规格是按
        # **线上几何**锚定的（LEN/校验字段位置都在转义后帧上），帧一变短就错位失配
        rx = unescape_bytes(self.reply, TABLE)
        ok, reasons = match_response(BARE_WIRE_SPEC, self.reply, rx)
        self.assertFalse(ok)
        self.assertTrue(any(r.startswith("LENGTH_MISMATCH") for r in reasons), reasons)
        self.assertIn("CHECKSUM_OUT_OF_RANGE", reasons)   # 线上锚定的字段位置越界


class WrappedShellReplyTests(unittest.TestCase):
    """套壳帧（外壳 LEN/CS 在转义之后算 = DL/T 645 型）→ 线上口径恒成立。

    两层几何手工构造：L2 `FA FA <LEN> <L1> ED`（壳 LEN 按线上字节），
    L1 `B0 <LEN> <内核(已转义)> <SUM8>`（L1 的 LEN/CS 也在套壳期按线上算）。
    """

    KERNEL = _payload()                                   # 11 7D 02（含定界字节）

    def _frames(self):
        # 请求侧内核含定界字节 → 转义后 5B（11→7D31、7D→7D5D、02→02）
        kernel_wire = escape_bytes(self.KERNEL, TABLE)
        l1_body = bytes([0xB0, len(kernel_wire)]) + kernel_wire
        l1 = l1_body + bytes([sum(l1_body) % 256])
        tx = b"\xFA\xFA" + bytes([len(l1)]) + l1 + b"\xED"
        # 应答侧：另一份内核，同样**先算 LEN/CS 再转义**（与本仓内核口径同构）
        # 转义后 5B → 两层几何与请求侧完全一致
        rl_kernel_wire = escape_bytes(bytes([0x11, 0x7D, 0x03]), TABLE)
        rl1_body = bytes([0xB0, len(rl_kernel_wire)]) + rl_kernel_wire
        rl1 = rl1_body + bytes([sum(rl1_body) % 256])
        rx = b"\xFA\xFA" + bytes([len(rl1)]) + rl1 + b"\xED"
        return tx, rx

    SPEC = normalize_spec({
        "mode": "rules",
        "prefix": "FAFA",
        "suffix": "ED",
        "stages": [
            {"unpack": {"head": 1, "trailer": 0},
             "length": {"offset": 1, "byte_length": 1, "offset_val": -3},
             "checksum": {"algo": "sum", "field_offset": 7, "field_byte_length": 1}},
            {"unpack": {"head": 3, "trailer": 1},
             "length": {"offset": 2, "byte_length": 1, "offset_val": -4}},
        ],
    })

    def test_shell_reply_matches_on_wire_verdict(self):
        tx, rx = self._frames()
        # 第 1 次（线上）即过 → 第 2 次不参与；给不给 unescape 结果相同
        self.assertEqual(match_response(self.SPEC, tx, rx), (True, []))
        self.assertEqual(match_response(self.SPEC, tx, rx, unescape=UNESCAPE), (True, []))

    def test_bad_inner_checksum_reports_stage_reason(self):
        tx, rx = self._frames()
        bad = rx[:-2] + bytes([rx[-2] ^ 0xFF]) + rx[-1:]   # 换掉 L1 校验（内层）
        ok, reasons = match_response(self.SPEC, tx, bad, unescape=UNESCAPE)
        self.assertFalse(ok)
        self.assertIn("STAGE[0].CHECKSUM_MISMATCH", reasons[0])


class SimulatedDeviceTransactionTests(unittest.TestCase):
    """整链路（转义开 → 模拟真机应答 → 事务判定）—— 直调 dispatch_transaction。"""

    def setUp(self):
        transport.reset()
        dispatch_mod._history.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = create_engine(
            f"sqlite:///{(Path(self.tmp.name) / 'test_reply.db').as_posix()}",
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(bind=self.engine)
        self.session_factory = sessionmaker(
            autocommit=False, autoflush=False, bind=self.engine
        )
        self.db = self.session_factory()
        self._original_send = transport.send

    def tearDown(self):
        transport.send = self._original_send               # 还原被替换的模块属性
        transport.reset()                                  # reset 同时清钩子
        dispatch_mod._history.clear()
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _tx(self, **kwargs):
        return dispatch_transaction(
            TransactionRequest(hex_string="A5 03 11 7D 02 38", **kwargs), db=self.db
        )

    def _simulate(self, reply_bytes):
        transport.send = lambda data, read_timeout_ms=None: bytes(reply_bytes)

    def test_logical_style_device_replies_ok(self):
        # 真机模拟（RFC 1662 型 / 与本仓内核口径同构）：收侧解转义 → 按同一编码器
        # 构逻辑应答（LEN/CS 覆盖逻辑字节）→ 出线前对称转义
        set_transport_config({"escape": {"enabled": True, "pairs": PAIRS}})
        self._simulate(escape_bytes(_bare(_payload()), TABLE))

        record = self._tx(response_spec=BARE_SPEC)
        self.assertEqual(record.status, "OK", record.attempts[0].reasons)
        self.assertEqual(record.attempts[0].status, "OK")
        self.assertEqual(record.attempts[0].reasons, [])

    def test_wire_style_device_replies_ok(self):
        # 真机模拟（DL/T 645 型）：LEN/CS 覆盖线上字节 → 第 1 次口径即过
        set_transport_config({"escape": {"enabled": True, "pairs": PAIRS}})
        self._simulate(_bare_wire_style(_payload()))

        record = self._tx(response_spec=BARE_WIRE_SPEC)
        self.assertEqual(record.status, "OK", record.attempts[0].reasons)

    def test_bad_device_reply_still_fails(self):
        set_transport_config({"escape": {"enabled": True, "pairs": PAIRS}})
        bad = bytearray(escape_bytes(_bare(_payload()), TABLE))
        bad[-1] ^= 0xFF
        self._simulate(bytes(bad))

        record = self._tx(response_spec=BARE_SPEC, retries=1, interval_ms=0)
        self.assertEqual(record.status, "FAILED")
        self.assertEqual([a.status for a in record.attempts],
                         ["MATCH_FAILED", "MATCH_FAILED"])
        self.assertTrue(record.attempts[0].reasons)
        # 失败事件照旧入 /dispatch/history（诊断口径不受本批影响）
        top = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(top.status, "ERROR")

    def test_escape_disabled_keeps_single_verdict(self):
        # escape 缺省关闭 → unescape=None → 单口径；真机回逻辑帧（自身即线上帧）
        self._simulate(_bare(_payload()))
        record = self._tx(response_spec=BARE_SPEC)
        self.assertEqual(record.status, "OK", record.attempts[0].reasons)

    def test_loopback_echo_with_escape_unchanged(self):
        # 环回原样回显（= 线上字节）→ 第 1 次即过，收侧不改任何字节
        set_transport_config({"escape": {"enabled": True, "pairs": PAIRS}})
        record = self._tx()                                # 默认 echo 规格
        self.assertEqual(record.status, "OK")
        attempt = record.attempts[0]
        self.assertEqual(attempt.received, attempt.sent)
        self.assertIn("7D31", attempt.sent.replace(" ", ""))  # 出线帧确实带转义


if __name__ == "__main__":
    unittest.main()
