"""`parallel` — prove a `[P]` group's `files:` sets are disjoint, mechanically."""
from __future__ import annotations

import json
import re

from quenching.specs.backends import open_backend
from quenching.specs.commands.output import Emitter, read_one
from quenching.specs.parse.tasks import _files_bad_annotation


def _norm_file(p: str) -> str:
    p = p.strip().replace("\\", "/")
    p = re.sub(r"\s*\(new\)\s*$", "", p)      # `src/a.py (new)` is still src/a.py
    return p.strip("./")


def _overlaps(a: str, b: str) -> bool:
    a, b = _norm_file(a), _norm_file(b)
    return a == b or a.startswith(b.rstrip("/") + "/") or b.startswith(a.rstrip("/") + "/")


def parallel_groups(tasks: list[dict]) -> list[list[dict]]:
    """Consecutive `[P]` tasks within one `### N.` section form a group."""
    groups, cur, sec = [], [], None
    for t in tasks:
        if t["parallel"] and (sec is None or t["section"] == sec):
            cur.append(t)
            sec = t["section"]
            continue
        if len(cur) > 1:
            groups.append(cur)
        cur, sec = ([t], t["section"]) if t["parallel"] else ([], None)
    if len(cur) > 1:
        groups.append(cur)
    return groups


def cmd_parallel(args, root: str, out: Emitter) -> int:
    """Prove a `[P]` group's `files:` sets are disjoint — MECHANICALLY, never judged in
    prose. A group with an undeclared `files:` is ineligible: nothing can be proven about
    a task that never said what it touches."""
    backend, err = open_backend(root)
    if err:
        return out.emit_err(args.json, err)
    info, err = read_one(backend, args.spec, out)
    if err:
        return out.emit_err(args.json, err)
    findings = []
    for gi, group in enumerate(parallel_groups(info["tasks"]), 1):
        undeclared = [t["id"] for t in group if not t["files"]]
        annotations = []
        for t in group:
            for e in t["files"]:
                note = _files_bad_annotation(e)
                if note:
                    annotations.append({"task": t["id"], "entry": e, "note": note})
        clashes = []
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                for fa in a["files"]:
                    for fb in b["files"]:
                        if _overlaps(fa, fb):
                            clashes.append({"a": a["id"], "b": b["id"],
                                            "file": _norm_file(fa)})
        eligible = not undeclared and not clashes and not annotations
        findings.append({"group": gi, "tasks": [t["id"] for t in group],
                         "eligible": eligible, "undeclared": undeclared,
                         "annotations": annotations, "clashes": clashes})
    ok = all(f["eligible"] for f in findings)
    if args.json:
        print(json.dumps({"ok": ok, "id": info["id"], "groups": findings},
                         indent=2, ensure_ascii=False))
    else:
        if not findings:
            print(f"{info['id']}: no [P] groups — serial execution")
        for f in findings:
            print(f"group {f['group']}: {', '.join(x or '?' for x in f['tasks'])} — "
                  f"{'eligible' if f['eligible'] else 'NOT eligible'}")
            for c in f["clashes"]:
                print(f"    {c['a']} and {c['b']} both touch {c['file']}")
            for a in f["annotations"]:
                print(f"    {a['task']} declares non-path files entry {a['entry']!r} — "
                      f"remove the comment; `(new)` is the only reserved annotation")
            if f["undeclared"]:
                print(f"    no files: declared by {', '.join(f['undeclared'])}")
    return 0 if ok else 1
