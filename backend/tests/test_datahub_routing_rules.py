"""R44（PLAN §8.76 · §8.37 R44 行）规则表进数据包 —— `routing_rules` 第 9 域。

本文件在实现前**全红**，红因**全部是缺特性**：`BUNDLE_DOMAIN_VERSIONS` 里没有
`routing_rules`、没有该域的导出载荷、没有 `routing_rules_rows` /
`import_routing_rules`、没有 `/datahub/import/routing_rules` 端点。

四条口径（全部镜像既有 8 域的既有纪律，不另起炉灶）：

① **只出活行、`deleted_at` 不进包** —— 回收站里的规则不进 ZIP，回灌后恒是活行；
② **行序 = 匹配顺序** `(sort_order, name, id)` —— 导出可 diff，回灌即还原优先级；
③ **条件语法交 SSOT** —— `core/condition.parse_condition`（保存侧同一入口），
   datahub 不写第二套判据；**目标指令必须是活行**，缺失 → 单行跳过
   （同 `import_sequences` 的「宿主缺失整条跳过」，不写出一条已悬空的规则）；
④ **名称唯一含回收站占名**（同 `routing._ensure_name_free`）→ 撞车跳过；
   id 自己在站里 → 跳过并提示先恢复或彻底删除。

运行（仓库根目录）：
    python -m unittest backend.tests.test_datahub_routing_rules -v
"""
import json
import unittest
import zipfile
from io import BytesIO
from unittest import mock

from fastapi import HTTPException

from backend.db.models import RoutingRule
from backend.routers import datahub
from backend.routers.datahub import BUNDLE_DOMAIN_VERSIONS, bundle_manifest
from backend.tests.test_datahub import RelationsTestCase


class TestRoutingRulesDomainInventory(unittest.TestCase):
    """`routing_rules` 是第 9 域，排在末尾（导出序 = `BUNDLE_DOMAIN_VERSIONS` 键序）。"""

    def test_is_the_ninth_domain_and_last_in_export_order(self):
        names = list(BUNDLE_DOMAIN_VERSIONS)
        self.assertIn("routing_rules", names)
        self.assertEqual(len(names), 9)
        self.assertEqual(names[-1], "routing_rules")

    def test_schema_version_is_one(self):
        self.assertEqual(datahub.ROUTING_RULES_SCHEMA_VERSION, 1)
        self.assertEqual(
            BUNDLE_DOMAIN_VERSIONS["routing_rules"],
            datahub.ROUTING_RULES_SCHEMA_VERSION,
        )


class TestRoutingRulesExportPayload(RelationsTestCase):
    """导出形：列子集 = models 列序去掉三个记账列，行序 = 匹配序。"""

    def _add(self, rule_id, name, sort_order=0, enabled=1, deleted_at=None):
        self.db.add(RoutingRule(
            id=rule_id, name=name, condition="meter_id == 1",
            instruction_id="i1", sort_order=sort_order, enabled=enabled,
            description="d", created_at="2026-10-07T00:00:00+00:00",
            updated_at="2026-10-07T00:00:00+00:00", deleted_at=deleted_at,
        ))

    def test_row_shape_excludes_bookkeeping_columns(self):
        self._add("rl1", "规则一")
        self.db.commit()
        payload = datahub.routing_rules_export_payload(
            self.db.query(RoutingRule).all()
        )
        self.assertEqual(list(payload), ["schemaVersion", "routing_rules"])
        self.assertEqual(payload["schemaVersion"], datahub.ROUTING_RULES_SCHEMA_VERSION)
        row = payload["routing_rules"][0]
        self.assertEqual(
            list(row),
            ["id", "name", "condition", "instruction_id",
             "sort_order", "enabled", "description"],
        )
        # 三个记账列一律不进包（回灌后用目标机时钟，不搬源机回收站状态）
        for key in ("created_at", "updated_at", "deleted_at"):
            self.assertNotIn(key, row)
        json.dumps(payload)  # ZIP 入口依赖

    def test_rows_follow_match_order(self):
        self._add("rl-0", "零号", sort_order=0)
        self._add("rl-1b", "B 规则", sort_order=1)
        self._add("rl-1a", "A 规则", sort_order=1)
        self.db.commit()
        # 排序收在载荷函数一处：query 给什么顺序都不作数。
        # 键 = (sort_order, name, id)，name 走码位序（与 SQLite BINARY 排序一致）
        payload = datahub.routing_rules_export_payload(
            self.db.query(RoutingRule).all()
        )
        self.assertEqual(
            [r["id"] for r in payload["routing_rules"]],
            ["rl-0", "rl-1a", "rl-1b"],
        )

    def test_empty_ruleset_is_an_empty_list(self):
        payload = datahub.routing_rules_export_payload([])
        self.assertEqual(payload["routing_rules"], [])


class TestExportBundleRoutingRules(RelationsTestCase):
    """端到端：`GET /datahub/export/bundle` 出 `routing_rules.json`，活行进、站内行不进。"""

    def setUp(self):
        super().setUp()
        self.db.add(RoutingRule(
            id="rl-live", name="活规则", condition="meter_id == 1",
            instruction_id="i1", sort_order=0, enabled=1, description=None,
        ))
        self.db.add(RoutingRule(
            id="rl-trash", name="回收站规则", condition="meter_id == 2",
            instruction_id="i1", sort_order=1, enabled=1, description=None,
            deleted_at="2026-10-07T00:00:00+00:00",
        ))
        self.db.commit()
        patcher = mock.patch.object(datahub, "SessionLocal", return_value=self.db)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_default_package_carries_routing_rules_json(self):
        resp = datahub.export_bundle()
        with zipfile.ZipFile(BytesIO(resp.body)) as zf:
            names = zf.namelist()
            self.assertIn("routing_rules.json", names)
            payload = json.loads(zf.read("routing_rules.json"))
            self.assertEqual(
                [r["id"] for r in payload["routing_rules"]], ["rl-live"]
            )
            self.assertNotIn("deleted_at", payload["routing_rules"][0])

            manifest = json.loads(zf.read("manifest.json"))
            self.assertEqual(list(manifest["domainVersion"])[-1], "routing_rules")
            self.assertEqual(manifest["domainCounts"]["routing_rules"], 1)

    def test_routing_rules_is_independently_selectable(self):
        resp = datahub.export_bundle(domains="routing_rules")
        with zipfile.ZipFile(BytesIO(resp.body)) as zf:
            self.assertEqual(
                set(zf.namelist()),
                {"routing_rules.json", "manifest.json"},
            )
            manifest = json.loads(zf.read("manifest.json"))
            self.assertEqual(list(manifest["domainVersion"]), ["routing_rules"])
            self.assertEqual(manifest["domainCounts"], {"routing_rules": 1})
            # 三个存量子键描述**这个包**：没选中的归 0 / 置空
            self.assertEqual(manifest["instructionCount"], 0)
            self.assertEqual(manifest["frames"], [])
        self.assertIn(
            'filename="yorha-datahub-routing_rules-',
            resp.headers["Content-Disposition"],
        )


class TestBundleManifestRoutingRules(unittest.TestCase):
    """`bundle_manifest` 的 counts 表要多一域，键序仍按 `BUNDLE_DOMAIN_VERSIONS`。"""

    def _manifest(self):
        return bundle_manifest(
            {"instructions": [1]},
            {"bindings": [1], "responseSpecs": [1]},
            {
                "recipes": {"recipes": [1]},
                "sequences": {"sequences": [1]},
                "transport": {"settings": [1]},
                "profiles": {"profiles": [1]},
                "templates": {"templates": [1]},
                "routing_rules": {"routing_rules": [1, 2]},
            },
            ["f1"],
        )

    def test_counts_include_routing_rules_in_domain_order(self):
        manifest = self._manifest()
        self.assertEqual(
            list(manifest["domainVersion"]), list(BUNDLE_DOMAIN_VERSIONS)
        )
        self.assertEqual(manifest["domainCounts"]["routing_rules"], 2)
        self.assertEqual(
            set(manifest["domainCounts"]), set(manifest["domainVersion"])
        )


class TestRoutingRulesRowsValidation(unittest.TestCase):
    """按域载荷顶层校验（纯函数）—— 400 必须发生在落快照之前。"""

    def test_rejects_bad_top_level(self):
        for bad, fragment in (
            (["不是对象"], "必须是对象"),
            ({"routing_rules": [], "extra": 1}, "未知顶层键"),
            ({"routing_rules": [], "schemaVersion": 99}, "schemaVersion 不支持"),
            ({"schemaVersion": 1}, "缺 routing_rules 数组"),
        ):
            with self.assertRaises(HTTPException) as ctx:
                datahub.routing_rules_rows(bad)
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn(fragment, str(ctx.exception.detail))

    def test_accepts_current_and_missing_version(self):
        self.assertEqual(datahub.routing_rules_rows({"routing_rules": [1]}), [1])
        self.assertEqual(
            datahub.routing_rules_rows(
                {"routing_rules": [1],
                 "schemaVersion": datahub.ROUTING_RULES_SCHEMA_VERSION}
            ),
            [1],
        )


class TestImportRoutingRules(RelationsTestCase):
    """逐行 upsert / 逐行报告（镜像 `import_profiles` + `import_sequences` 口径）。"""

    @staticmethod
    def _row(rule_id, name, instruction_id="i1", **extra):
        row = {
            "id": rule_id, "name": name, "condition": "meter_id == 1",
            "instruction_id": instruction_id, "sort_order": 0, "enabled": 1,
            "description": "d",
        }
        row.update(extra)
        return row

    def test_round_trip_and_update(self):
        payload = {"routing_rules": [
            self._row("rl1", "命中心跳", sort_order=0, enabled=1),
            self._row("rl2", "次序二", sort_order=1, enabled=0),
        ]}
        # `description` 缺席 → 建行写 NULL（列可空，不写空串）
        payload["routing_rules"][1].pop("description")
        report = datahub.import_routing_rules(self.db, payload)
        self.assertEqual(report["domain"], "routing_rules")
        self.assertEqual(report["imported"], 2)
        self.assertEqual(report["skipped"], [])
        self.assertEqual(
            self.db.query(RoutingRule).filter(RoutingRule.id == "rl2").one().enabled,
            0,
        )
        self.assertIsNone(
            self.db.query(RoutingRule).filter(RoutingRule.id == "rl2").one().description
        )

        # 同 id 再导 → updated（整字段覆盖），id 不变
        payload["routing_rules"][0]["name"] = "命中心跳改"
        payload["routing_rules"][0]["enabled"] = 0
        second = datahub.import_routing_rules(self.db, payload)
        self.assertEqual(second["updated"], 2)
        self.assertEqual(second["imported"], 0)
        row = self.db.query(RoutingRule).filter(RoutingRule.id == "rl1").one()
        self.assertEqual(row.name, "命中心跳改")
        self.assertEqual(row.enabled, 0)
        self.assertEqual(self.db.query(RoutingRule).count(), 2)

    def test_missing_instruction_skips_the_row(self):
        report = datahub.import_routing_rules(self.db, {"routing_rules": [
            self._row("rl1", "悬空规则", instruction_id="i-404"),
        ]})
        self.assertEqual(report["imported"], 0)
        self.assertEqual(report["skipped"][0]["reason"], "指令不存在：i-404")
        self.assertEqual(self.db.query(RoutingRule).count(), 0)

    def test_name_clash_including_trashed_rows_skips_the_row(self):
        # 占名的那行**在回收站里** —— 软删行继续占唯一键，照样拦（同 `_ensure_name_free`）
        self.db.add(RoutingRule(
            id="rl-占", name="占名规则", condition="meter_id == 1",
            instruction_id="i1", sort_order=0, enabled=1,
            deleted_at="2026-10-07T00:00:00+00:00",
        ))
        self.db.commit()
        report = datahub.import_routing_rules(self.db, {"routing_rules": [
            self._row("rl-x", "占名规则"),
        ]})
        self.assertEqual(report["imported"], 0)
        self.assertIn("规则名已存在（行 rl-占）", report["skipped"][0]["reason"])

    def test_own_id_in_trash_skips_the_row(self):
        self.db.add(RoutingRule(
            id="rl-trash", name="站内规则", condition="meter_id == 1",
            instruction_id="i1", sort_order=0, enabled=1,
            deleted_at="2026-10-07T00:00:00+00:00",
        ))
        self.db.commit()
        report = datahub.import_routing_rules(self.db, {"routing_rules": [
            self._row("rl-trash", "站内规则"),
        ]})
        self.assertEqual(report["imported"], 0)
        self.assertIn("回收站", report["skipped"][0]["reason"])
        # 不许把站内行 upsert 成一条看得见的活行（`deleted_at` 原样留着）
        row = self.db.query(RoutingRule).filter(RoutingRule.id == "rl-trash").one()
        self.assertIsNotNone(row.deleted_at)

    def test_invalid_condition_skips_the_row(self):
        report = datahub.import_routing_rules(self.db, {"routing_rules": [
            self._row("rl-bad", "坏条件", condition="meter_id =="),
        ]})
        self.assertEqual(report["imported"], 0)
        self.assertIn("条件语法", report["skipped"][0]["reason"])
        self.assertEqual(self.db.query(RoutingRule).count(), 0)

    def test_sort_order_roundtrip_and_tolerant_absence(self):
        # 在场 → 原样进包即还原；缺席 → 建 0 / 改则保留目标库已有的序；非法 → 整行跳过
        self.db.add(RoutingRule(
            id="rl-keep", name="保留序", condition="meter_id == 1",
            instruction_id="i1", sort_order=7, enabled=1, description=None,
        ))
        self.db.commit()
        report = datahub.import_routing_rules(self.db, {"routing_rules": [
            {"id": "rl-new", "name": "新规则", "condition": "meter_id == 1",
             "instruction_id": "i1"},
            {"id": "rl-keep", "name": "保留序", "condition": "meter_id == 1",
             "instruction_id": "i1"},
            {"id": "rl-neg", "name": "负序", "condition": "meter_id == 1",
             "instruction_id": "i1", "sort_order": -1},
        ]})
        self.assertEqual(report["imported"], 1)
        self.assertEqual(report["updated"], 1)
        self.assertEqual(len(report["skipped"]), 1)
        self.assertIn("sort_order", report["skipped"][0]["reason"])
        self.assertEqual(
            self.db.query(RoutingRule).filter(RoutingRule.id == "rl-new").one().sort_order,
            0,
        )
        self.assertEqual(
            self.db.query(RoutingRule).filter(RoutingRule.id == "rl-keep").one().sort_order,
            7,
        )

    def test_enabled_must_be_zero_or_one(self):
        report = datahub.import_routing_rules(self.db, {"routing_rules": [
            self._row("rl-bad", "坏开关", enabled=5),
        ]})
        self.assertEqual(report["imported"], 0)
        self.assertIn("enabled", report["skipped"][0]["reason"])

    def test_skipped_rows_do_not_roll_back_the_good_ones(self):
        """部分成功即部分落库（R8 三段式第 ③ 条）。"""
        report = datahub.import_routing_rules(self.db, {"routing_rules": [
            self._row("rl-ok", "好规则"),
            self._row("rl-bad", "悬空规则", instruction_id="i-404"),
        ]})
        self.assertEqual(report["imported"], 1)
        self.assertEqual(len(report["skipped"]), 1)
        self.assertEqual(
            [r.id for r in self.db.query(RoutingRule).all()], ["rl-ok"]
        )


if __name__ == "__main__":
    unittest.main()
