"""`cq deploy` — plan, check or write the quenching surface in a target repository."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from quenching.common.deploy import MANIFEST, read_manifest
from quenching.common.config import repository_document
from quenching.common.output import FINDINGS, OK, REFUSAL, NoAbbrevParser, emit, refuse
from quenching.common.version import VERSION
from quenching.deploy import tree as deploy_tree

LEGACY = (".claude/commands", ".claude/references", ".agents/.generated-from.json")
GENERATED_ROOTS = (".agents/quenching/", ".agents/skills/quenching-", ".claude/skills/quenching-",
                   ".claude/agents/quenching-")
MCP_MOUNTS = {"specs"}


def _mcp_refusal(message: str, **extra) -> dict:
    return {"code": "ct-deploy-mcp", "message": message, **extra,
            "remedy": "declare `shared.mcp` as {mount: \"specs\", command: [<python prefix>]}, "
                      "or remove the key"}


def _mcp_option(target: Path) -> tuple[dict | None, dict | None]:
    """`shared.mcp` from the repository layer, validated before anything is written.

    Read through `repository_document`, never the merged envelope: `_apply_user_layer` would
    make the generated file vary by machine. Absent is absence, not an error.
    """
    document, _info, refusal = repository_document(str(target))
    if refusal:
        return None, refusal
    shared = (document or {}).get("shared")
    raw = shared.get("mcp") if isinstance(shared, dict) else None
    if raw is None:
        return None, None
    if not isinstance(raw, dict):
        return None, _mcp_refusal("`shared.mcp` must be an object with `mount` and `command`")
    unknown = sorted(set(raw) - {"mount", "command"})
    if unknown:
        return None, _mcp_refusal(f"`shared.mcp` has unknown key(s): {', '.join(unknown)}",
                                  keys=unknown)
    mount = raw.get("mount", "specs")
    if mount not in MCP_MOUNTS:
        return None, _mcp_refusal(
            f"`shared.mcp.mount` must be one of: {', '.join(sorted(MCP_MOUNTS))}", mount=mount)
    command = raw.get("command")
    if (not isinstance(command, list) or not command
            or not all(isinstance(part, str) and part for part in command)):
        return None, _mcp_refusal(
            "`shared.mcp.command` must be a non-empty list of strings — the prefix that finds "
            "Python, e.g. [\"uv\", \"run\", \"--no-project\", \"python\"]; the runtime path and "
            "the mount are appended by deploy")
    return {"mount": mount, "command": list(command)}, None


def _split(values: list[str] | None) -> list[str]:
    out: list[str] = []
    for value in values or []:
        out.extend(part.strip() for part in value.split(",") if part.strip())
    return out


def _change(change: str, rel: str) -> dict:
    return {"path": rel, "change": change}


def _owned(previous: dict | None) -> set[str]:
    files = (previous or {}).get("files")
    return set(files) if isinstance(files, dict) else set()


def _legacy_refusal(target: Path) -> dict | None:
    for rel in LEGACY:
        if (target / rel).exists():
            return {
                "code": "ct-deploy-legacy",
                "path": rel.removeprefix(".agents/").removeprefix(".claude/"),
                "message": f"{target / rel} is the legacy .claude surface; deploy will not mix "
                           "the two layouts",
                "remedy": "run `cq components migrate --target . --write`, then rerun `cq deploy`",
            }
    return None


def _seed_plan(target: Path, seeds: dict[str, str]) -> tuple[list[dict], list[str]]:
    changes, warnings = [], []
    legacy_config = (target / ".claude/quenching.json").exists()
    for rel in seeds:
        if rel == ".agents/quenching.json" and legacy_config:
            continue
        if not (target / rel).exists():
            changes.append(_change("seed", rel))
    if legacy_config:
        warnings.append("legacy .claude/quenching.json is still read; run `cq components migrate` "
                        "before seeding .agents/quenching.json")
    if (target / "CLAUDE.md").is_file():
        text = (target / "CLAUDE.md").read_text(encoding="utf-8").strip()
        if text == "@AGENTS.md":
            warnings.append("legacy pointer-only CLAUDE.md is present; rerun with --prune-legacy")
        else:
            warnings.append("CLAUDE.md carries its own instructions and shadows AGENTS.md; "
                            "consolidate it with the `quenching-components-harness-align` skill, then remove it")
    return changes, warnings


def recorded(previous: dict | None, key: str, allowed: set[str] | None = None):
    """One recorded selection, or None when absent or malformed.

    The manifest makes `cq deploy --write` an upgrade instead of a fresh `core` install: on a
    target that deployed `--modules all`, the defaults would otherwise build a core tree and
    delete every other module's owned file. An explicit flag still wins; this is only the default.
    """
    value = (previous or {}).get(key)
    if allowed is not None:
        return value if value in allowed else None
    if isinstance(value, list) and all(isinstance(item, str) and item for item in value):
        return list(value)
    return None


def plan(target: Path, built: dict, previous: dict | None) -> dict:
    tree, seeds = built["tree"], built["seeds"]
    owned = _owned(previous)
    changes: list[dict] = []
    conflicts: list[dict] = []
    for rel, (data, _mode_) in sorted(tree.items()):
        path = target / rel
        if not path.exists():
            changes.append(_change("create", rel))
        elif not path.is_file():
            conflicts.append({"path": rel, "why": "a directory occupies a generated file's path"})
        elif rel not in owned:
            conflicts.append({"path": rel, "why": "exists but no deploy manifest owns it"})
        elif path.read_bytes() != data:
            changes.append(_change("update", rel))
        elif bool(path.stat().st_mode & 0o111) != bool(_mode_ & 0o111):
            # The executable bit is the only part of the mode git carries and a caller can
            # observe; a checkout under umask 0002 creates every file 0o664, which is not drift.
            changes.append(_change("mode", rel))
    for rel in sorted(owned - set(tree)):
        if (target / rel).is_file():
            changes.append(_change("delete", rel))
    seed_changes, warnings = _seed_plan(target, seeds)
    changes.extend(seed_changes)
    if (target / MANIFEST).exists():
        try:
            current = json.loads((target / MANIFEST).read_text(encoding="utf-8"))
        except ValueError:
            current = None
        if current != built["manifest"]:
            changes.append(_change("manifest", MANIFEST))
    else:
        changes.append(_change("create", MANIFEST))
    return {"changes": changes, "conflicts": conflicts, "warnings": warnings}


def _safe_relative(rel: str) -> bool:
    path = Path(rel)
    return not path.is_absolute() and ".." not in path.parts and "\\" not in rel


def write(target: Path, built: dict, result: dict, prune_legacy: bool) -> None:
    tree, seeds = built["tree"], built["seeds"]
    previous = read_manifest(str(target)) or {}
    owned = _owned(previous)
    for rel in sorted(owned - set(tree)):
        path = target / rel
        if path.is_file() and _safe_relative(rel):
            path.unlink()
            parent = path.parent
            while parent != target and parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
                parent = parent.parent
    for rel, (data, mode) in sorted(tree.items()):
        if not _safe_relative(rel):
            raise ValueError(f"unsafe deploy path: {rel}")
        path = target / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.is_file() or path.read_bytes() != data:
            path.write_bytes(data)
        os.chmod(path, mode)
    legacy_config = (target / ".claude/quenching.json").exists()
    for rel, text in seeds.items():
        if rel == ".agents/quenching.json" and legacy_config:
            continue
        path = target / rel
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
    if prune_legacy:
        pointer = target / "CLAUDE.md"
        if pointer.is_file() and pointer.read_text(encoding="utf-8").strip() == "@AGENTS.md":
            pointer.unlink()
    (target / MANIFEST).parent.mkdir(parents=True, exist_ok=True)
    (target / MANIFEST).write_text(json.dumps(built["manifest"], indent=2) + "\n",
                                   encoding="utf-8")


def _human(target: Path, built: dict, result: dict, written: bool) -> str:
    manifest = built["manifest"]
    lines = [f"cq deploy — {target}",
             f"  version: {manifest['version']}  modules: {', '.join(manifest['modules'])}"
             f"  runtime: {manifest['runtime']}  harnesses: {', '.join(manifest['harnesses'])}",
             f"  changes: {len(result['changes'])}  conflicts: {len(result['conflicts'])}"
             + ("  (written)" if written else "")]
    for change in result["changes"]:
        lines.append(f"  {change['change']:<8} {change['path']}")
    for conflict in result["conflicts"]:
        lines.append(f"  conflict: {conflict['path']} — {conflict['why']}")
    for warning in result.get("warnings", []):
        lines.append(f"  warning: {warning}")
    return "\n".join(lines)


def _parser() -> argparse.ArgumentParser:
    p = NoAbbrevParser(prog="cq deploy",
                       description="install the quenching surface in a target repository")
    p.add_argument("--target", "--root", dest="target", default=".",
                   help="target repository root (default: current directory)")
    p.add_argument("--modules", action="append", default=None,
                   help="modules to deploy: core, all, or a comma list (default: core)")
    p.add_argument("--profiles", action="append", default=None,
                   help="shared.profiles.installed, comma separated (default: derived)")
    p.add_argument("--harness", action="append", default=None,
                   help="claude, codex, opencode, none (default: claude,codex,opencode)")
    p.add_argument("--runtime", choices=("vendor", "uvx"), default=None,
                   help="vendored runtime (offline) or a pinned uvx shim; defaults to the "
                        "manifest's recorded runtime, then vendor")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="write the plan")
    mode.add_argument("--check", action="store_true", help="exit 1 on drift")
    p.add_argument("--prune-legacy", action="store_true",
                   help="remove a pointer-only CLAUDE.md (content-bearing files are never touched)")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.add_argument("--version", action="version", version=VERSION)
    return p


def main(argv: list[str]) -> int:
    args = _parser().parse_args(argv)
    target = Path(os.path.abspath(args.target))
    if not target.is_dir():
        return refuse({"code": "ct-deploy-target", "target": str(target),
                       "message": "the target is not a directory"}, args.json)
    refusal = _legacy_refusal(target)
    if refusal:
        return refuse(refusal, args.json)
    previous = read_manifest(str(target))
    harnesses = (_split(args.harness) or recorded(previous, "harnesses")
                 or ["claude", "codex", "opencode"])
    if "none" in harnesses:
        harnesses = [h for h in harnesses if h != "none"]
    for harness in harnesses:
        if harness not in {"claude", "codex", "opencode"}:
            return refuse({"code": "ct-deploy-harness", "harness": harness,
                           "message": f"unknown harness: {harness}"}, args.json)
    runtime = args.runtime or recorded(previous, "runtime", {"vendor", "uvx"}) or "vendor"
    mcp, refusal = _mcp_option(target)
    if refusal:
        return refuse(refusal, args.json)
    if mcp and runtime != "vendor":
        return refuse(_mcp_refusal(
            "`shared.mcp` needs `--runtime vendor`: the generated command points at "
            "`.agents/quenching/assets/bin/cq`, which a uvx runtime does not carry"), args.json)
    try:
        manifest = deploy_tree.load_modules(deploy_tree.source_root())
        modules = deploy_tree.normalize_modules(
            _split(args.modules) or recorded(previous, "modules"), manifest)
        profiles = (_split(args.profiles) or recorded(previous, "profiles")
                    or deploy_tree.profiles_for(modules))
        built = deploy_tree.build_tree(deploy_tree.source_root(), target, modules, harnesses,
                                       runtime, profiles, mcp=mcp)
    except (OSError, ValueError) as exc:
        return refuse({"code": "ct-deploy-source", "message": str(exc),
                       "remedy": "run deploy from a complete quenching checkout or wheel"},
                      args.json)
    result = plan(target, built, previous)
    if args.write and result["conflicts"]:
        return refuse({"code": "ct-deploy-unowned", "conflicts": result["conflicts"],
                       "message": "the target holds files no deploy manifest owns; nothing was written",
                       "remedy": "move or rename the listed files, or remove them after review"},
                      args.json)
    written = False
    if args.write:
        write(target, built, result, args.prune_legacy)
        written = True
    payload = {"ok": not result["conflicts"], "target": str(target),
               "version": built["manifest"]["version"], "modules": modules,
               "profiles": profiles, "harnesses": harnesses, "runtime": runtime,
               "changes": result["changes"], "conflicts": result["conflicts"],
               "warnings": result.get("warnings", []), "written": written}
    emit(args.json, payload, _human(target, built, result, written))
    if result["conflicts"]:
        return REFUSAL
    if written:
        return OK
    return FINDINGS if result["changes"] else OK
