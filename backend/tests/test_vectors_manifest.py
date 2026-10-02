"""共享向量表验收（CP2b · D11 分段① 收口 · 单一真相源 = `vectors/*.json`）。

CP2b 已把两端手抄向量表迁到 `vectors/`（迁移范围与特殊值约定见 `vectors/README.md`
§1–§5）；本文件把「验收方式」固化成可执行口径，防**双端测试数据悄悄分叉**：

1. **消费矩阵**：`vectors/` 下每个 `*.json` 必须**同时**被后端测试与前端测试消费 ——
   只有一端消费时，另一端实现改了也不红（这正是手抄时代的失守方式）。
2. **反向引用**：测试里 `load_vectors("<name>")` 引用的表必须真实存在 ——
   新增表忘落 JSON / 改名漏改 → 当场红，而不是运行期 `FileNotFoundError` 之外的静默。
3. **可读性 + `$v` 纪律**：每张表能被后端加载器读出且非空；`$v` 混键 / 未知值必须
   抛错（不 fail-open，防止畸形标记被当普通对象静默放行）。
4. **入库卫生**：`.gitignore` 必须忽略 `__pycache__/` 与 `*.py[cod]`（加载器会在
   `vectors/` 下生成 `__pycache__`）；git 索引里不得出现 `__pycache__` / `*.pyc`
   （git 不可用时该子断言跳过，只保留忽略规则断言）。

前端侧的对应验收在 `frontend/src/utils/__tests__/vectorsLoader.test.js`
（加载器 `$v` 同口径 + 12 张表全量可读）—— 两侧各测自己这半，不重复扫全仓。
"""
import math
import re
import subprocess
import unittest
from pathlib import Path

from vectors.load_vectors import VECTORS_DIR, _decode, load_vectors

REPO_ROOT = Path(__file__).resolve().parents[2]

_LOAD_CALL = re.compile(r'load_vectors\(\s*"([A-Za-z0-9_]+)"')


def _py_files():
    # 验收单自身不计入消费（它按文件名扫描，不算「真的在钉这张表」）
    return sorted(
        p
        for p in (REPO_ROOT / "backend" / "tests").rglob("*.py")
        if p.name != "test_vectors_manifest.py"
    )


def _fe_files():
    # 同上：FE 加载器验收单不算消费，必须有真·语义测试引用
    return sorted(
        p
        for p in list((REPO_ROOT / "frontend" / "src").rglob("*.js"))
        + list((REPO_ROOT / "frontend" / "src").rglob("*.jsx"))
        if p.name != "vectorsLoader.test.js"
    )


class VectorManifestTest(unittest.TestCase):
    """消费矩阵 / 引用可解析 / 表可读 / $v 纪律 / 入库卫生。"""

    def test_every_vector_table_consumed_by_both_sides(self):
        names = sorted(p.stem for p in VECTORS_DIR.glob("*.json"))
        self.assertTrue(names, "vectors/ 至少要有一张向量表")

        be_text = [p.read_text(encoding="utf-8") for p in _py_files()]
        fe_text = [p.read_text(encoding="utf-8") for p in _fe_files()]

        for name in names:
            be_hits = [
                t
                for t in be_text
                if f'load_vectors("{name}"' in t or f"vectors/{name}.json" in t
            ]
            fe_hits = [t for t in fe_text if f"vectors/{name}.json" in t]
            self.assertTrue(
                be_hits,
                f"{name}.json 没有后端测试消费 → 单侧漂移风险（见 vectors/README.md §6）",
            )
            self.assertTrue(
                fe_hits,
                f"{name}.json 没有前端测试消费 → 单侧漂移风险（见 vectors/README.md §6）",
            )

    def test_load_vectors_references_all_resolve(self):
        refs = set()
        for path in _py_files():
            refs |= set(_LOAD_CALL.findall(path.read_text(encoding="utf-8")))
        self.assertTrue(refs, "后端测试应至少有一处 load_vectors(...) 引用")

        missing = sorted(r for r in refs if not (VECTORS_DIR / f"{r}.json").exists())
        self.assertFalse(
            missing,
            f"load_vectors 引用了不存在的表（新增表忘落 JSON？）: {missing}",
        )

    def test_every_table_readable_and_non_empty(self):
        for path in sorted(VECTORS_DIR.glob("*.json")):
            raw = path.read_text(encoding="utf-8")
            import json

            data = json.loads(raw)
            if isinstance(data, dict):
                # 多表对象：逐表取（缺表 → KeyError，形态变化当场红）
                self.assertTrue(data, f"{path.name} 是空对象")
                for key in data:
                    table = load_vectors(path.stem, key)
                    self.assertTrue(table, f"{path.name} 表 {key} 为空")
            else:
                table = load_vectors(path.stem)
                self.assertTrue(table, f"{path.name} 为空表")
                self.assertIsInstance(table, list)

    def test_illegal_v_markers_rejected(self):
        # 混键 / 未知值 → 抛错（不 fail-open）
        with self.assertRaises(ValueError):
            _decode({"$v": "Infinity", "extra": 1})
        with self.assertRaises(ValueError):
            _decode({"$v": "Bogus"})
        # 三态映射
        self.assertEqual(_decode({"$v": "Infinity"}), float("inf"))
        self.assertEqual(_decode({"$v": "-Infinity"}), float("-inf"))
        self.assertTrue(math.isnan(_decode({"$v": "NaN"})))
        # 嵌套递归 + 标量按 JSON 原型分型（字符串不被当数值）
        self.assertEqual(_decode({"a": {"$v": "-Infinity"}}), {"a": float("-inf")})
        self.assertEqual(_decode([1, "1e3", "", None, True]), [1, "1e3", "", None, True])

    def test_repo_ignores_python_bytecode(self):
        gitignore = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("__pycache__/", gitignore, ".gitignore 必须忽略 __pycache__/")
        self.assertIn("*.py[cod]", gitignore, ".gitignore 必须忽略 *.py[cod]")

        try:
            proc = subprocess.run(
                ["git", "ls-files"],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except (OSError, subprocess.SubprocessError):
            # git 不可用（打包/离线环境）→ 只保留忽略规则断言
            return
        if proc.returncode != 0:
            return
        bad = [
            line
            for line in proc.stdout.splitlines()
            if "__pycache__" in line or line.endswith((".pyc", ".pyo"))
        ]
        self.assertEqual(bad, [], f"git 索引含字节码产物: {bad}")


if __name__ == "__main__":
    unittest.main()
