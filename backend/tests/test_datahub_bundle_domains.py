"""R17（PLAN §8.49 · §8.49 R17 行）按域独立导出 `GET /datahub/export/bundle?domains=…`。

钉三条口径：

① **缺省不带参数 = 现行 8 域逐字不变** —— 文件集合、manifest 三键、下载文件名
   （`^yorha-datahub-\\d+\\.zip$`）一个字节都不动（本文件的回归断言与 test_datahub
   的既有端到端互为镜像）；
② 按域导出只出所选域，且 manifest 的 `domainVersion` · `domainCounts` **只列包里真
   有的域**（键序仍按 8 域表，不是按用户给的顺序），`instructionCount` · `relations`
   · `frames` 三个存量子键描述的是**这个包**（没选中的归 0 / 置空）；
③ 非法 `domains` 走 `parse_bundle_domains` 的 400，**不静默忽略**。

端到端用临时库直调路由函数（镜像 test_datahub.RelationsTestCase 建库三步，
并复用它的档案 / 配方 / 序列夹具口径）。
"""

import json
import unittest
import zipfile
from io import BytesIO
from unittest import mock

from fastapi import HTTPException

from backend.db.models import (
    DeviceProfile,
    FrameRecipe,
    OperatorTemplate,
    Sequence,
    SequenceStep,
    TransportSetting,
)
from backend.routers import datahub
from backend.routers.datahub import BUNDLE_DOMAIN_VERSIONS, parse_bundle_domains
from backend.tests.test_datahub import RelationsTestCase


class TestParseBundleDomains(unittest.TestCase):
    """`?domains=` 顶层校验纯函数：缺省 None、合法透传、三类非法 400。"""

    def test_default_none_and_valid_pass_through_in_user_order(self):
        self.assertIsNone(parse_bundle_domains(None))
        self.assertEqual(parse_bundle_domains("recipes,sequences"), ["recipes", "sequences"])
        # 顺序原样保留（导出序由服务端按 8 域表定，见 export_bundle）
        self.assertEqual(parse_bundle_domains("sequences,recipes"), ["sequences", "recipes"])
        # 前后空白归一
        self.assertEqual(parse_bundle_domains(" recipes , templates "), ["recipes", "templates"])

    def test_invalid_shapes_all_400_with_actionable_detail(self):
        for raw, needle in (
            ("", "空项"),
            ("recipes,,sequences", "空项"),
            ("recipes,nope", "未知域"),
            ("recipes,recipes", "重复"),
        ):
            with self.subTest(raw=raw):
                with self.assertRaises(HTTPException) as ctx:
                    parse_bundle_domains(raw)
                self.assertEqual(ctx.exception.status_code, 400)
                self.assertIn(needle, str(ctx.exception.detail))
        # 未知域名报错带**可选全集**，方便照抄
        with self.assertRaises(HTTPException) as ctx:
            parse_bundle_domains("protocols")
        self.assertIn("instructions", str(ctx.exception.detail))
        self.assertIn("templates", str(ctx.exception.detail))


class TestExportBundleDomains(RelationsTestCase):
    """端到端：缺省 8 域逐字不变 / 按域子集 / frames 与 instructions 的独立性。"""

    def setUp(self):
        super().setUp()
        self.db.add(FrameRecipe(id="r1", name="套壳配方", description="d",
                                stages=[{"protocol_id": "p1",
                                         "definition_hash": "sha256:abc"}],
                                version=1))
        self.db.add(Sequence(id="s1", name="冒烟序列", description="d",
                             config={"stop_on_error": True}))
        self.db.add(SequenceStep(id="st1", sequence_id="s1", step_order=0,
                                 instruction_id="i1", label="步一", delay_ms=10,
                                 params={"f1": 1}, payload="AA55FF",
                                 plan={"dynamic": []}, wrap={"recipe_id": "r1"}))
        self.db.add(TransportSetting(id="current", config={"mode": "serial"},
                                     active_profile_id=None))
        self.db.add(DeviceProfile(id="d1", label="车间A", config={"mode": "serial"}))
        self.db.add(OperatorTemplate(op_code="HEX_RAW", name="十六进制原样",
                                     category="BASIC", param_template={"hex": {}},
                                     description="逐字节原样"))
        self.db.commit()

        patcher = mock.patch.object(datahub, "SessionLocal", return_value=self.db)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _export(self, **kwargs):
        resp = datahub.export_bundle(**kwargs)
        zf = zipfile.ZipFile(BytesIO(resp.body))
        self.addCleanup(zf.close)
        return resp, zf

    def test_default_is_still_the_full_eight_domain_package(self):
        """回归：不带参数 = 现行 8 域逐字不变（含文件名口径）。"""
        resp, zf = self._export()
        names = zf.namelist()
        for domain in (
            "instructions.json", "relations.json", "recipes.json",
            "sequences.json", "transport.json", "profiles.json",
            "templates.json",
        ):
            self.assertIn(domain, names)
        self.assertIn("manifest.json", names)
        self.assertTrue(any(name.startswith("frames/") for name in names))

        manifest = json.loads(zf.read("manifest.json"))
        self.assertEqual(list(manifest["domainVersion"]), list(BUNDLE_DOMAIN_VERSIONS))
        self.assertEqual(manifest["domainVersion"], BUNDLE_DOMAIN_VERSIONS)
        self.assertEqual(set(manifest["domainCounts"]), set(BUNDLE_DOMAIN_VERSIONS))
        self.assertEqual(manifest["instructionCount"], 2)
        self.assertEqual(manifest["relations"], {"bindings": 0, "responseSpecs": 0})
        self.assertEqual(len(manifest["frames"]), 2)
        # 文件名不带域名后缀（存量消费方按 ^yorha-datahub-\d+\.zip$ 认）
        self.assertRegex(resp.headers["Content-Disposition"],
                         r'filename="yorha-datahub-\d{8}-\d{6}\.zip"')

    def test_subset_exports_only_selected_domains(self):
        """按域子集：只出所选文件，manifest 只列真在包里的域（键序按 8 域表）。"""
        resp, zf = self._export(domains="sequences,recipes")
        self.assertEqual(set(zf.namelist()),
                         {"recipes.json", "sequences.json", "manifest.json"})

        manifest = json.loads(zf.read("manifest.json"))
        # 用户给的顺序是 sequences,recipes —— manifest 键序仍按 8 域表
        self.assertEqual(list(manifest["domainVersion"]), ["recipes", "sequences"])
        self.assertEqual(list(manifest["domainCounts"]), ["recipes", "sequences"])
        self.assertEqual(manifest["domainCounts"], {"recipes": 1, "sequences": 1})
        # 三个存量子键描述**这个包**：没选中的归 0 / 置空
        self.assertEqual(manifest["instructionCount"], 0)
        self.assertEqual(manifest["relations"], {"bindings": 0, "responseSpecs": 0})
        self.assertEqual(manifest["frames"], [])
        # 下载文件名带域名（按用户给的顺序），几份包不打架
        self.assertIn('filename="yorha-datahub-sequences-recipes-',
                      resp.headers["Content-Disposition"])

        # 选中的域内容照旧完整：序列带着它的步骤（宿主-从属同进同出）
        sequences = json.loads(zf.read("sequences.json"))
        self.assertEqual([s["id"] for s in sequences["sequences"]], ["s1"])
        self.assertEqual([step["id"] for step in sequences["sequences"][0]["steps"]],
                         ["st1"])

    def test_frames_and_instructions_are_independently_selectable(self):
        # 只要 frames：有帧文件、无任何 JSON 域文件，manifest 只列 frames
        _, zf = self._export(domains="frames")
        names = set(zf.namelist())
        self.assertTrue(
            all(name == "manifest.json" or name.startswith("frames/") for name in names)
        )
        self.assertTrue(any(name.endswith(".bin") for name in names))
        manifest = json.loads(zf.read("manifest.json"))
        self.assertEqual(list(manifest["domainVersion"]), ["frames"])
        self.assertEqual(len(manifest["frames"]), 2)  # 两条指令各出 .bin/.hex
        self.assertEqual(manifest["instructionCount"], 0)

        # 只要 instructions：有 JSON、**没有**帧文件，manifest.frames 置空
        _, zf2 = self._export(domains="instructions")
        self.assertEqual(set(zf2.namelist()),
                         {"instructions.json", "manifest.json"})
        manifest2 = json.loads(zf2.read("manifest.json"))
        self.assertEqual(list(manifest2["domainVersion"]), ["instructions"])
        self.assertEqual(manifest2["instructionCount"], 2)
        self.assertEqual(manifest2["frames"], [])

    def test_explicit_all_eight_equals_default(self):
        """显式传全 8 域 ≡ 缺省（只差 generatedAt 一个时间戳字段）。"""
        _, zf_default = self._export()
        _, zf_all = self._export(domains=",".join(BUNDLE_DOMAIN_VERSIONS))
        self.assertEqual(sorted(zf_default.namelist()), sorted(zf_all.namelist()))

        left = json.loads(zf_default.read("manifest.json"))
        right = json.loads(zf_all.read("manifest.json"))
        left.pop("generatedAt")
        right.pop("generatedAt")
        self.assertEqual(left, right)


if __name__ == "__main__":
    unittest.main()
