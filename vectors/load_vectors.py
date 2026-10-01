"""CP2b 共享向量加载器（D11 分段 ①：向量表共享 fixture 化）。

单一真相源 = 本目录 `*.json`。两端测试**只读这里**，新增/修改向量只写一处：
- 后端：`from vectors.load_vectors import load_vectors`
- 前端：`import { loadVectors } from '<相对路径>/vectors/vectors.js'` + JSON 默认导入

跨语言特殊值约定（2026-10-01 拍板，JSON 无 Infinity/NaN）：
- `{"$v": "Infinity"}` / `{"$v": "-Infinity"}` / `{"$v": "NaN"}`
- 其余标量按 JSON 原型天然分型：`null` / `true` / 数字 / 字符串
  （故字符串输入 `"1e3"`、`""` 与数值 `1.5` 不会互相混淆）
- 纯对象（非特殊值）递归解码；特殊值对象**只允许**恰好一个 `$v` 键。
"""
import json
from pathlib import Path

VECTORS_DIR = Path(__file__).resolve().parent

_SPECIAL = {
    "Infinity": float("inf"),
    "-Infinity": float("-inf"),
    "NaN": float("nan"),
}


def _decode(value):
    if isinstance(value, dict):
        if "$v" in value:
            if len(value) != 1 or value["$v"] not in _SPECIAL:
                raise ValueError(f"非法 $v 标记: {value!r}")
            return _SPECIAL[value["$v"]]
        return {k: _decode(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_decode(v) for v in value]
    return value


def load_vectors(name, key=None):
    """读 `vectors/<name>.json` 并解码 $v 特殊值。

    name: 文件名（不带 .json）；key: 多表对象里的表名，顶层是数组时必须为 None。
    """
    path = VECTORS_DIR / f"{name}.json"
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    data = _decode(data)
    if key is None:
        if isinstance(data, dict):
            raise KeyError(f"{name}.json 是多表对象，必须指定 key（可选: {sorted(data)}）")
        return data
    if not isinstance(data, dict) or key not in data:
        raise KeyError(f"{name}.json 缺表 {key!r}")
    return data[key]
