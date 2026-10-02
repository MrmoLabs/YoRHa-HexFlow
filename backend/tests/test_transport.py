"""E2 transport layer tests: config validation, loopback parity, TCP round-trip,
serial failure path, and /dispatch three-event send history (raw/response/error).

Run from repo root: python -m unittest discover -s backend/tests
"""

import socket
import threading
import time
import unittest

from fastapi import HTTPException

from backend.core import transport
from backend.routers import dispatch as dispatch_mod
from backend.routers.dispatch import DispatchRequest, dispatch_frame
from backend.routers.transport import (
    get_transport_config,
    get_transport_status,
    set_transport_config,
)


class _TcpPeer:
    """Local TCP server: echoes when reply=True, drains silently when reply=False."""

    def __init__(self, reply=True):
        self.reply = reply
        self.accepts = 0
        self._stop = threading.Event()
        self._conns = []
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(4)
        self._listener.settimeout(0.2)
        self.port = self._listener.getsockname()[1]
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._thread.start()

    def _accept_loop(self):
        while not self._stop.is_set():
            try:
                conn, _ = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            self.accepts += 1
            self._conns.append(conn)
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        conn.settimeout(0.2)
        while not self._stop.is_set():
            try:
                data = conn.recv(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            if not data:
                break
            if self.reply:
                try:
                    conn.sendall(data)
                except OSError:
                    break

    def stop(self):
        self._stop.set()
        try:
            self._listener.close()
        except OSError:
            pass
        for conn in self._conns:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                conn.close()
            except OSError:
                pass
        self._thread.join(timeout=2)


def _closed_local_port() -> int:
    """Bind an ephemeral port then close it → a local port that refuses connections."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


class TransportTestBase(unittest.TestCase):
    def setUp(self):
        transport.reset()
        dispatch_mod._history.clear()

    def tearDown(self):
        transport.reset()
        dispatch_mod._history.clear()


class TransportConfigTests(TransportTestBase):
    def test_default_is_loopback(self):
        config = get_transport_config()
        self.assertEqual(config["mode"], "loopback")
        self.assertEqual(config["tcp"]["host"], "127.0.0.1")
        self.assertEqual(config["tcp"]["port"], 9000)
        self.assertEqual(config["serial"]["baudrate"], 9600)
        self.assertEqual(config["serial"]["parity"], "N")
        self.assertEqual(config["serial"]["stopbits"], 1)

    def test_validate_rejects_bad_mode(self):
        with self.assertRaises(ValueError):
            transport.validate_config({**transport.default_config(), "mode": "udp"})

    def test_validate_rejects_bad_tcp(self):
        base = transport.default_config()
        bad_values = [
            {"host": ""},
            {"host": 123},
            {"port": 0},
            {"port": 65536},
            {"port": True},
            {"connect_timeout_ms": 0},
            {"read_timeout_ms": 60001},
            {"unknown": 1},
        ]
        for patch in bad_values:
            config = transport.default_config()
            config["tcp"].update(patch)
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                transport.validate_config(config)

    def test_validate_rejects_bad_serial(self):
        bad_values = [
            {"port": ""},
            {"baudrate": 0},
            {"bytesize": 4},
            {"bytesize": 9},
            {"parity": "X"},
            {"stopbits": 3},
            {"read_timeout_ms": 0},
            {"unknown": 1},
        ]
        for patch in bad_values:
            config = transport.default_config()
            config["serial"].update(patch)
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                transport.validate_config(config)

    def test_validate_normalizes_parity_and_stopbits(self):
        config = transport.default_config()
        config["serial"]["parity"] = "e"
        config["serial"]["stopbits"] = 2.0
        normalized = transport.validate_config(config)
        self.assertEqual(normalized["serial"]["parity"], "E")
        self.assertEqual(normalized["serial"]["stopbits"], 2)

        config["serial"]["stopbits"] = 1.5
        self.assertEqual(transport.validate_config(config)["serial"]["stopbits"], 1.5)

    def test_set_config_merges_patch(self):
        returned = set_transport_config({"mode": "tcp", "tcp": {"host": "192.168.0.9", "port": 1234}})
        self.assertEqual(returned["mode"], "tcp")
        self.assertEqual(returned["tcp"]["host"], "192.168.0.9")
        self.assertEqual(returned["tcp"]["port"], 1234)
        # Untouched fields survive the merge.
        self.assertEqual(returned["tcp"]["connect_timeout_ms"], 3000)
        self.assertEqual(returned["serial"]["baudrate"], 9600)
        self.assertEqual(get_transport_config()["mode"], "tcp")

    def test_set_config_router_maps_value_error_to_400(self):
        with self.assertRaises(HTTPException) as ctx:
            set_transport_config({"mode": "udp"})
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("未知传输模式", ctx.exception.detail)

        with self.assertRaises(HTTPException) as ctx:
            set_transport_config({"tcp": {"port": 70000}})
        self.assertEqual(ctx.exception.status_code, 400)

        with self.assertRaises(HTTPException) as ctx:
            set_transport_config({"nope": 1})
        self.assertEqual(ctx.exception.status_code, 400)

    def test_status_shape_and_loopback_always_connected(self):
        status = get_transport_status()
        # configHistoryDepth = R2 新增键（§8.37 上一配置回退），只做加法
        self.assertEqual(
            set(status), {"mode", "connected", "last_error", "events", "configHistoryDepth"}
        )
        self.assertEqual(status["mode"], "loopback")
        self.assertTrue(status["connected"])
        self.assertIsNone(status["last_error"])
        self.assertEqual(status["events"], [])
        self.assertEqual(status["configHistoryDepth"], 0)


class LoopbackDispatchTests(TransportTestBase):
    def test_loopback_send_echoes_payload(self):
        self.assertEqual(transport.send(b"\xaa\x55\x01"), b"\xaa\x55\x01")

    def test_loopback_record_shape_unchanged(self):
        """E2-T1 anchor: /dispatch 口径不变 under default loopback mode."""
        record = dispatch_frame(DispatchRequest(hex_string="AA 55", instruction_name="probe"))
        self.assertIsInstance(record.id, int)
        self.assertIsInstance(record.timestamp, str)
        self.assertEqual(record.channel, "LOOPBACK")
        self.assertEqual(record.status, "SENT")
        self.assertEqual(record.byte_count, 2)
        self.assertEqual(record.hex_string, "AA 55")
        self.assertEqual(record.instruction_name, "probe")
        self.assertEqual(record.echo, "AA55")  # compact hex, payload echo
        self.assertEqual([e.type for e in record.events], ["raw", "response"])
        self.assertEqual(record.events[0].hex_string, "AA 55")
        self.assertEqual(record.events[1].hex_string, "AA 55")

    def test_loopback_invalid_payload_is_400(self):
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(DispatchRequest(hex_string="ABC"))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_history_keeps_bounded_records(self):
        dispatch_frame(DispatchRequest(hex_string="01"))
        dispatch_frame(DispatchRequest(hex_string="02"))
        history = dispatch_mod.dispatch_history(limit=10)
        self.assertEqual([r.hex_string for r in history], ["02", "01"])


class TcpTransportTests(TransportTestBase):
    def _configure(self, port, read_timeout_ms=600, connect_timeout_ms=500):
        set_transport_config({
            "mode": "tcp",
            "tcp": {
                "host": "127.0.0.1",
                "port": port,
                "connect_timeout_ms": connect_timeout_ms,
                "read_timeout_ms": read_timeout_ms,
            },
        })

    def test_tcp_roundtrip_persists_connection(self):
        peer = _TcpPeer(reply=True)
        self.addCleanup(peer.stop)
        self._configure(peer.port)

        payload = bytes([0xAA, 0x55, 0x01, 0x02])
        self.assertEqual(transport.send(payload), payload)
        self.assertEqual(transport.send(payload), payload)

        # Second send reuses the same socket → exactly one accept.
        self.assertEqual(peer.accepts, 1)

        status = get_transport_status()
        self.assertEqual(status["mode"], "tcp")
        self.assertTrue(status["connected"])
        self.assertIsNone(status["last_error"])
        events = [e["event"] for e in status["events"]]
        self.assertIn("connected", events)

    def test_tcp_dispatch_records_response_event(self):
        peer = _TcpPeer(reply=True)
        self.addCleanup(peer.stop)
        self._configure(peer.port)

        record = dispatch_frame(DispatchRequest(hex_string="AA55"))
        self.assertEqual(record.channel, "TCP")
        self.assertEqual(record.status, "SENT")
        self.assertEqual(record.echo, "AA55")
        self.assertEqual([e.type for e in record.events], ["raw", "response"])
        self.assertEqual(record.events[1].hex_string, "AA 55")

    def test_tcp_read_timeout_returns_empty_response(self):
        peer = _TcpPeer(reply=False)
        self.addCleanup(peer.stop)
        self._configure(peer.port, read_timeout_ms=150)

        started = time.monotonic()
        response = transport.send(b"\x01\x02")
        elapsed = time.monotonic() - started

        self.assertEqual(response, b"")
        self.assertLess(elapsed, 3.0)
        self.assertTrue(get_transport_status()["connected"])

        # Empty reply is still a successful send with a (empty) response event.
        record = dispatch_frame(DispatchRequest(hex_string="0102"))
        self.assertEqual(record.status, "SENT")
        self.assertEqual(record.echo, "")
        self.assertEqual([e.type for e in record.events], ["raw", "response"])
        self.assertEqual(record.events[1].hex_string, "")

    def test_tcp_connect_failure_raises_transport_error(self):
        self._configure(_closed_local_port(), connect_timeout_ms=300)

        with self.assertRaises(transport.TransportError):
            transport.send(b"\x01")

        status = get_transport_status()
        self.assertFalse(status["connected"])
        self.assertIsNotNone(status["last_error"])
        self.assertIn("TCP 连接", status["last_error"])
        self.assertEqual(status["events"][-1]["event"], "error")

    def test_tcp_failure_maps_to_502_and_error_event(self):
        self._configure(_closed_local_port(), connect_timeout_ms=300)

        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(DispatchRequest(hex_string="AA 55", instruction_name="probe"))
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("Transport error", ctx.exception.detail)

        # The failed attempt is kept in send history as raw + error events.
        record = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(record.status, "ERROR")
        self.assertEqual(record.channel, "TCP")
        self.assertEqual(record.echo, "")
        self.assertEqual(record.byte_count, 2)
        self.assertEqual([e.type for e in record.events], ["raw", "error"])
        self.assertEqual(record.events[0].hex_string, "AA 55")
        self.assertIn("TCP 连接", record.events[1].message)

    def test_switching_mode_back_to_loopback_closes_socket(self):
        peer = _TcpPeer(reply=True)
        self.addCleanup(peer.stop)
        self._configure(peer.port)
        transport.send(b"\x01")
        self.assertTrue(get_transport_status()["connected"])

        set_transport_config({"mode": "loopback"})
        status = get_transport_status()
        self.assertTrue(status["connected"])  # loopback is always "connected"
        self.assertEqual(
            [e["event"] for e in status["events"] if e["event"] == "disconnected"],
            ["disconnected"],
        )
        # 配置变更事件 detail 钉住：真实连接被主动断开。
        disconnects = [e for e in status["events"] if e["event"] == "disconnected"]
        self.assertEqual(disconnects[0]["detail"], "配置变更")


class SerialTransportTests(TransportTestBase):
    def test_serial_bogus_port_raises_transport_error(self):
        set_transport_config({
            "mode": "serial",
            "serial": {"port": "COM99999", "baudrate": 115200},
        })
        with self.assertRaises(transport.TransportError):
            transport.send(b"\x01")

        status = get_transport_status()
        self.assertEqual(status["mode"], "serial")
        self.assertFalse(status["connected"])
        self.assertIsNotNone(status["last_error"])
        self.assertEqual(status["events"][-1]["event"], "error")

    def test_serial_failure_maps_to_502_and_error_event(self):
        set_transport_config({"mode": "serial", "serial": {"port": "COM99999"}})
        with self.assertRaises(HTTPException) as ctx:
            dispatch_frame(DispatchRequest(hex_string="01"))
        self.assertEqual(ctx.exception.status_code, 502)

        record = dispatch_mod.dispatch_history(limit=1)[0]
        self.assertEqual(record.channel, "SERIAL")
        self.assertEqual(record.status, "ERROR")
        self.assertEqual([e.type for e in record.events], ["raw", "error"])


if __name__ == "__main__":
    unittest.main()
