# -*- coding: utf-8 -*-
# R14（PLAN §8.49）· GET /transport/ports 串口端口枚举单测
# 范式对齐 test_diagnostics：stdlib unittest **直调路由函数**（无 TestClient、不触 lifespan）。
# 三条口径 = 只读不碰配置 / 成功形状与排序 / 两条降级路径**绝不抛**（枚举是锦上添花，
# 缺依赖或驱动炸了都要让配置页照常用）。

import sys
import unittest
from types import SimpleNamespace
from unittest import mock

from backend.routers.transport import list_transport_ports


class TransportPortsTest(unittest.TestCase):
    def test_ports_shape_and_sorted(self):
        """成功：设备名升序 + {device, description} 形状 + source=pyserial。"""
        fake = [
            SimpleNamespace(device="COM10", description=" USB-SERIAL CH340 (COM10) "),
            SimpleNamespace(device="COM3", description=None),
            SimpleNamespace(device="COM1", description=" 通信端口 "),
        ]
        with mock.patch("serial.tools.list_ports.comports", return_value=fake):
            result = list_transport_ports()

        self.assertEqual(result["source"], "pyserial")
        self.assertNotIn("error", result)
        self.assertEqual(
            result["ports"],
            [
                {"device": "COM1", "description": "通信端口"},
                {"device": "COM3", "description": ""},
                {"device": "COM10", "description": "USB-SERIAL CH340 (COM10)"},
            ],
        )

    def test_empty_ports_is_normal_not_error(self):
        """本机一个串口都没有 = 正常态（不是错误）→ 空列表 + source=pyserial。"""
        with mock.patch("serial.tools.list_ports.comports", return_value=[]):
            result = list_transport_ports()
        self.assertEqual(result, {"ports": [], "source": "pyserial"})

    def test_enum_failure_degrades_never_raises(self):
        """枚举抛异常（权限/驱动）→ 降级 200 形：空列表 + source=unavailable + error 原文。"""
        with mock.patch(
            "serial.tools.list_ports.comports", side_effect=OSError("拒绝访问")
        ):
            result = list_transport_ports()

        self.assertEqual(result["ports"], [])
        self.assertEqual(result["source"], "unavailable")
        self.assertIn("端口枚举失败", result["error"])
        self.assertIn("拒绝访问", result["error"])

    def test_pyserial_missing_degrades_never_raises(self):
        """pyserial 未安装 → 降级 200 形（sys.modules 置 None = import 即 ImportError）。"""
        blocked = {
            "serial": None,
            "serial.tools": None,
            "serial.tools.list_ports": None,
        }
        with mock.patch.dict(sys.modules, blocked):
            result = list_transport_ports()

        self.assertEqual(result["ports"], [])
        self.assertEqual(result["source"], "unavailable")
        self.assertIn("pyserial 未安装", result["error"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
