#!/usr/bin/env python3
"""A1-x：LENGTH_CALC「refs 无 formula」批量盘点 / 修复脚本（2026-09-22 已审批）。

默认**只读**：盘点全部 op_code=LENGTH_CALC ∧ parameter_config.refs 非空 ∧
formula 缺失的字段，打印将要写入的合成公式。合成口径镜像前端
frontend/src/utils/synthesizeFormula.js：refs 去重 → 按字段 name 逐个解析 →
"[A] + [B]"；任一 ref 悬空则跳过该块（先修引用，不写半截公式）。

加 --apply 才逐条 PUT /instructions/{id} 落库 —— 保持 API 单一写路径，
不直接改 SQLite。需要后端已启动（默认 http://127.0.0.1:8000）。
仅用标准库（urllib/json），无新增依赖。

用法：
    python scripts/fix_length_formulas.py               # 只读盘点
    python scripts/fix_length_formulas.py --apply       # 逐条落库
    python scripts/fix_length_formulas.py --base-url http://127.0.0.1:8000
退出码：0 成功；1 存在落库失败；2 无法连接后端。
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "http://127.0.0.1:8000"


def synthesize_formula(refs, fields_by_id):
    """镜像 frontend/src/utils/synthesizeFormula.js：
    去重 → 逐个解析（悬空/无名 → None）→ "[A] + [B]"。"""
    if not isinstance(refs, list) or not refs:
        return None
    parts = []
    seen = set()
    for rid in refs:
        if rid in seen:
            continue
        seen.add(rid)
        target = fields_by_id.get(rid)
        if not target:
            return None
        name = target.get("name")
        if not name:
            return None
        parts.append(f"[{name}]")
    return " + ".join(parts) if parts else None


def http_json(method, url, payload=None):
    headers = {"Accept": "application/json"}
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def plan(instructions):
    """返回 (jobs, dangling)。
    jobs:    [{inst, updates: [{field_id, field, formula}]}] — 每指令一条 PUT
    dangling: [{inst, id, field, refs}] — 悬空引用，跳过并提示"""
    jobs, dangling = [], []
    for inst in instructions:
        fields = inst.get("fields") or []
        by_id = {f.get("id"): f for f in fields if f.get("id")}
        updates = []
        for f in fields:
            if f.get("op_code") != "LENGTH_CALC":
                continue
            pc = f.get("parameter_config") or {}
            refs = pc.get("refs")
            if not isinstance(refs, list) or not refs:
                continue  # 目标形态：refs 非空
            formula = pc.get("formula")
            if isinstance(formula, str) and formula.strip():
                continue  # 已有公式 → 不动（本脚本只补缺失）
            synth = synthesize_formula(refs, by_id)
            entry = {
                "inst": inst.get("name"),
                "id": inst.get("id"),
                "field": f.get("name") or f.get("id"),
                "refs": refs,
            }
            if synth is None:
                dangling.append(entry)
            else:
                updates.append({
                    "field_id": f.get("id"),
                    "field": entry["field"],
                    "formula": synth,
                })
        if updates:
            jobs.append({"inst": inst, "updates": updates})
    return jobs, dangling


def build_put_payload(inst, updates):
    """GET 响应 → InstructionUpdate PUT 体（不含指令 id），仅改目标块 formula。"""
    want = {u["field_id"]: u["formula"] for u in updates}
    fields = []
    for f in inst.get("fields") or []:
        pc = dict(f.get("parameter_config") or {})
        if f.get("id") in want:
            pc["formula"] = want[f.get("id")]
        fields.append({**f, "parameter_config": pc})
    inst_type = inst.get("type")
    return {
        "device_code": inst.get("device_code") or "",
        "code": inst.get("code") or "",
        "name": inst.get("name") or "",
        "description": inst.get("description"),
        "type": inst_type if inst_type in ("STATIC", "DYNAMIC") else "DYNAMIC",
        "fields": fields,
    }


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # Windows 控制台
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser(
        description="盘点/批量补全 LENGTH_CALC「refs 无 formula」块（默认只读）")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL, help="后端地址")
    ap.add_argument("--apply", action="store_true", help="真实落库（默认只读盘点）")
    args = ap.parse_args(argv)
    base = args.base_url.rstrip("/")

    try:
        instructions = http_json("GET", f"{base}/instructions/")
    except (urllib.error.URLError, OSError) as e:
        print(f"[错误] 无法连接后端 {base}：{e}", file=sys.stderr)
        print("请先启动后端（如 uvicorn backend.main:app），或用 --base-url 指定地址。。",
              file=sys.stderr)
        return 2

    jobs, dangling = plan(instructions)
    total = sum(len(j["updates"]) for j in jobs)
    print(f"盘点：{len(instructions)} 条指令，命中 {total} 个「refs 无 formula」LENGTH_CALC 块")
    for job in jobs:
        inst = job["inst"]
        print(f"· {inst.get('name')} ({inst.get('id')})")
        for u in job["updates"]:
            print(f"    - {u['field']} → {u['formula']}")
    if dangling:
        print(f"\n[跳过] {len(dangling)} 个块存在悬空引用（先在加工页修复引用再重跑）：")
        for d in dangling:
            print(f"· {d['inst']} / {d['field']}  refs={d['refs']}")

    if not args.apply:
        print("\n只读模式：未写入任何数据。确认无误后加 --apply 落库。")
        return 0
    if not jobs:
        print("\n无可修复项，未执行写入。")
        return 0

    ok = failed = 0
    for job in jobs:
        inst = job["inst"]
        try:
            http_json("PUT", f"{base}/instructions/{inst['id']}",
                      build_put_payload(inst, job["updates"]))
            ok += 1
            print(f"[已写入] {inst.get('name')}（{len(job['updates'])} 块）")
        except urllib.error.HTTPError as e:
            failed += 1
            detail = ""
            try:
                detail = json.loads(e.read().decode("utf-8")).get("detail", "")
            except Exception:
                pass
            print(f"[失败] {inst.get('name')} HTTP {e.code} {detail}", file=sys.stderr)
        except (urllib.error.URLError, OSError) as e:
            failed += 1
            print(f"[失败] {inst.get('name')}：{e}", file=sys.stderr)

    print(f"\n完成：成功 {ok} 条，失败 {failed} 条。")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
