"""R2（PLAN §8.37）：传输配置「上一配置」一键回退（进程内有界回退栈，零 DDL）。

钉：改了才入栈 / 装载不入栈 / 弹栈语义（可连退多版、回退本身不入栈、退空即 400）/
有界 / 回退也走持久化钩子且留痕 / 钩子失败仍生效但必须留痕。

Run from repo root: python -m unittest discover -s backend/tests
"""

import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core import transport
from backend.db.database import Base
from backend.db.transport_store import restore_transport_config, save_config
from backend.routers.transport import (
    get_transport_config,
    get_transport_status,
    revert_transport_config,
    set_transport_config,
)


class RevertBase(unittest.TestCase):
    """每个用例都从默认 loopback + 空栈起步，跑完必须复位（沿 §8.35 泄漏教训）。"""

    def setUp(self):
        transport.reset()

    def tearDown(self):
        transport.reset()  # 连 _persist_hook 一并清空，别把钩子泄漏给下个用例

    def _depth(self):
        return get_transport_status()["configHistoryDepth"]


class RevertTests(RevertBase):
    def test_change_then_revert_restores_previous(self):
        set_transport_config({"mode": "tcp", "tcp": {"host": "10.0.0.1"}})
        self.assertEqual(self._depth(), 1)

        result = revert_transport_config()

        # 回到变更**之前**的那一版（默认 loopback / 127.0.0.1）
        self.assertEqual(result["config"]["mode"], "loopback")
        self.assertEqual(result["config"]["tcp"]["host"], "127.0.0.1")
        self.assertEqual(result["historyDepth"], 0)
        self.assertEqual(get_transport_config()["mode"], "loopback")

    def test_revert_without_history_is_400(self):
        with self.assertRaises(HTTPException) as ctx:
            revert_transport_config()

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.detail, "没有可回退的上一配置")

    def test_revert_is_a_stack_and_drains_to_400(self):
        set_transport_config({"mode": "tcp", "tcp": {"port": 9001}})   # → tcp/9001
        set_transport_config({"tcp": {"port": 9002}})                  # → tcp/9002
        set_transport_config({"mode": "serial"})                       # → serial
        self.assertEqual(self._depth(), 3)

        first = revert_transport_config()
        self.assertEqual(first["config"]["mode"], "tcp")
        self.assertEqual(first["config"]["tcp"]["port"], 9002)

        second = revert_transport_config()
        self.assertEqual(second["config"]["tcp"]["port"], 9001)

        third = revert_transport_config()
        self.assertEqual(third["config"]["mode"], "loopback")
        self.assertEqual(third["historyDepth"], 0)

        # 弹空即止 —— 回退不入栈，否则能一直「回退回退」振荡回刚才那版
        with self.assertRaises(HTTPException):
            revert_transport_config()

    def test_no_op_change_does_not_record_history(self):
        set_transport_config({})          # 什么都没变 → 不入栈
        self.assertEqual(self._depth(), 0)

        set_transport_config({"tcp": {"host": "10.0.0.1"}})
        self.assertEqual(self._depth(), 1)
        set_transport_config({"tcp": {"host": "10.0.0.1"}})  # 值一样 → 仍不入栈
        self.assertEqual(self._depth(), 1)

    def test_history_is_bounded_at_twenty(self):
        for port in range(9000, 9030):    # 30 次真实变更
            set_transport_config({"tcp": {"port": port}})

        self.assertEqual(self._depth(), 20)
        self.assertEqual(get_transport_config()["tcp"]["port"], 9029)
        # 最老那版（第一次变更之前的默认）已被挤掉
        revert_transport_config()
        self.assertEqual(get_transport_config()["tcp"]["port"], 9028)

    def test_revert_persists_and_records_event(self):
        seen = []
        transport.set_persist_hook(lambda cfg: seen.append(cfg))
        set_transport_config({"mode": "tcp", "tcp": {"host": "10.0.0.1"}})
        seen.clear()

        revert_transport_config()

        # 回退必须落库，否则重启后悄悄又回到改错那版
        self.assertTrue(seen, "回退也走持久化钩子")
        self.assertEqual(seen[-1]["mode"], "loopback")
        # 并留痕（§8.33）：配置动了没人知道是最难查的一类问题
        events = [e for e in get_transport_status()["events"] if e["event"] == "config"]
        self.assertTrue(events, "回退必须记入状态事件")
        self.assertIn("上一配置", events[-1]["detail"])

    def test_persist_failure_on_revert_still_applies_but_is_recorded(self):
        def boom(_config):
            raise RuntimeError("连接池炸了")

        transport.set_persist_hook(boom)
        set_transport_config({"mode": "tcp", "tcp": {"port": 9003}})

        result = revert_transport_config()

        # 尽力而为语义不变：钩子炸了配置照常回退
        self.assertEqual(result["config"]["mode"], "loopback")
        errors = [
            e for e in get_transport_status()["events"]
            if e["event"] == "error" and "持久化失败" in (e.get("detail") or "")
        ]
        self.assertTrue(errors, "回退时持久化失败必须留痕")
        self.assertIn("连接池炸了", errors[0]["detail"])

    def test_startup_restore_does_not_record_history(self):
        """启动装载不算「用户改过配置」—— 否则一开机点回退就被重置回默认。"""
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        engine = create_engine(
            f"sqlite:///{(Path(self._tmp.name) / 'r2.db').as_posix()}",
            connect_args={"check_same_thread": False},
        )
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(bind=engine)
        db = sessionmaker(autocommit=False, autoflush=False, bind=engine)()
        self.addCleanup(db.close)

        save_config(db, {"mode": "tcp", "tcp": {"host": "10.9.9.9"}}, None)
        self.assertTrue(restore_transport_config(db))

        # 装载生效但不入栈 → 还没改过配置，回退应当是「没有」而不是退回默认
        self.assertEqual(get_transport_config()["tcp"]["host"], "10.9.9.9")
        self.assertEqual(self._depth(), 0)
        with self.assertRaises(HTTPException) as ctx:
            revert_transport_config()
        self.assertEqual(ctx.exception.detail, "没有可回退的上一配置")

        # 装载之后真的改一次，才开始有得回退
        set_transport_config({"tcp": {"host": "10.0.0.2"}})
        result = revert_transport_config()
        self.assertEqual(result["config"]["tcp"]["host"], "10.9.9.9")


if __name__ == "__main__":
    unittest.main()
