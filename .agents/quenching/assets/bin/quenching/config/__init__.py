"""The `config` pillar's own entry point — views over the configuration layers, and the seed.

`export` prints the repository layer through the active provider, `init` seeds the file and `check` lists what it lacks. `show --effective` prints every key with
its effective value and the layer that supplied it (`default`, `user`, `repository`, `branch`)."""
from __future__ import annotations

import argparse
import json
import os
import shlex
import sys

from quenching.common.front import resolve_root
from quenching.common.config import (CONFIG_FILE, config_path, DEFAULT_PROVIDER, PROVIDER_ENV,
                                      active_provider,
                                      find_repo_root, repository_document)
from quenching.common.io import write_text
from quenching.common.output import FINDINGS, OK, REFUSAL, NoAbbrevParser, emit, refuse
from quenching.common.version import VERSION
from quenching.config.effective import effective
from quenching.config.host import build_plan, load_settings
from quenching.config.seed import missing_keys, read_repository, seed_document


def _render(payload: dict) -> str:
    lines = ["layers (low to high precedence):"]
    for layer in payload["layers"]:
        state = ("unparseable: " + layer["unparseable"] if layer["unparseable"]
                 else "present" if layer["present"] else "absent")
        if layer.get("applies") is False:
            state = "not applied (backend is not git)"
        lines.append(f"  {layer['name']:<11} {layer['path'] or '-'}  [{state}]")
    lines.append("")
    width = max((len(row["key"]) for row in payload["values"]), default=0)
    for row in payload["values"]:
        lines.append(f"{row['key']:<{width}} = {json.dumps(row['value'], ensure_ascii=False)}"
                     f"  [{row['source']}]")
    if payload.get("warnings"):
        lines.extend(["", "warnings:", *(f"  {warning}" for warning in payload["warnings"])])
    return "\n".join(lines)


def cmd_show(args) -> int:
    if not args.effective:
        print("cq config show: --effective is required", file=sys.stderr)
        return 3
    payload = {"ok": True, **effective(resolve_root(args.root))}
    emit(args.json, payload, _render(payload))
    return 0


def cmd_host(args) -> int:
    settings, warnings = load_settings(resolve_root(args.root))
    payload = {"ok": True, **settings, "warnings": warnings}
    if args.plan:
        command = [c for c in args.command if c != "--"] if args.command else []
        try:
            steps, notes = build_plan(settings, os.path.basename(resolve_root(args.root)), command)
        except ValueError as exc:
            print(f"cq config host: {exc}", file=sys.stderr)
            return REFUSAL
        payload.update(steps=steps, notes=notes)
        text = "\n".join(f"{s['step']:<5} {shlex.join(s['argv'])}" for s in steps)
        text += "".join(f"\nnote: {n}" for n in notes)
    else:
        text = "\n".join(f"{k} = {json.dumps(v, ensure_ascii=False)}"
                         for k, v in settings.items())
    text += "".join(f"\nwarning: {w}" for w in warnings)
    emit(args.json, payload, text)
    return 0


def _file_only(verb: str, args) -> int | None:
    """Refuse a file write or audit while another provider answers: the service would not get it."""
    provider, refusal = active_provider()
    if provider is None:
        return refuse(refusal, args.json)
    if provider.name == DEFAULT_PROVIDER:
        return None
    return refuse({
        "code": "cq-config-provider-not-file", "provider": provider.name,
        "message": f"cq config {verb} works on {CONFIG_FILE}, and {PROVIDER_ENV}={provider.name} is active",
        "remedy": f"unset {PROVIDER_ENV} to use the file, or change the configuration through {provider.name}",
    }, args.json)


def cmd_export(args) -> int:
    document, info, refusal = repository_document(resolve_root(args.root))
    if refusal:
        return refuse(refusal, args.json)
    if document is None:
        state = "is unparseable: " + info["unparseable"] if info["unparseable"] else "holds no document"
        return refuse({
            "code": "cq-config-unparseable" if info["unparseable"] else "cq-config-absent",
            "provider": info["name"], "config": info["path"],
            "message": f"provider {info['name']} {state}",
            "remedy": "fix or create the repository configuration before exporting it",
        }, args.json)
    emit(args.json, {"ok": True, "provider": info["name"], "path": info["path"],
                     "document": document},
         json.dumps(document, indent=2, ensure_ascii=False))
    return OK


def cmd_init(args) -> int:
    if (refused := _file_only("init", args)) is not None:
        return refused
    root = resolve_root(args.root)
    path = config_path(find_repo_root(root))
    if os.path.isfile(path):
        return refuse({
            "code": "cq-config-present", "config": path,
            "message": f"{CONFIG_FILE} already exists; init will not overwrite it",
            "remedy": "run `cq config check` to list the seeded keys it lacks, and add them by hand",
        }, args.json)
    document = seed_document(root)
    if args.write:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write_text(path, json.dumps(document, indent=2, ensure_ascii=False) + "\n")
    action = "written" if args.write else "preview"
    human = (f"cq config init — {path}\n"
             + json.dumps(document, indent=2, ensure_ascii=False)
             + f"\n{action}: {'yes' if args.write else 'no — rerun with `--write` to create it'}")
    emit(args.json, {"ok": True, "action": f"init-{action}", "path": path,
                     "document": document, "written": args.write}, human)
    return OK


def cmd_check(args) -> int:
    if (refused := _file_only("check", args)) is not None:
        return refused
    root = resolve_root(args.root)
    path = config_path(find_repo_root(root))
    if not os.path.isfile(path):
        return refuse({
            "code": "cq-config-absent", "config": path,
            "message": f"{CONFIG_FILE} does not exist",
            "remedy": "run `cq config init --write` to seed it",
        }, args.json)
    document = read_repository(root)
    if document is None:
        return refuse({
            "code": "cq-config-unparseable", "config": path,
            "message": f"{CONFIG_FILE} is not a JSON object",
            "remedy": "fix the file by hand; check reads only a valid object",
        }, args.json)
    missing = missing_keys(document, root)
    human = ("seeded keys missing from the file:\n" + "\n".join(f"  {k}" for k in missing)
             if missing else "every seeded key is declared")
    emit(args.json, {"ok": not missing, "path": path, "missing": missing}, human)
    return FINDINGS if missing else OK


def build_parser() -> argparse.ArgumentParser:
    p = NoAbbrevParser(prog="cq config", description="the configuration layers, read-only")
    p.add_argument("--version", action="store_true", help="print the version and exit")
    p.add_argument("--root", help="repository root (default: current directory)")
    sub = p.add_subparsers(dest="cmd")
    sp = sub.add_parser("show", help="print the effective configuration with each value's layer")
    sp.add_argument("--effective", action="store_true",
                    help="every key with its effective value and source layer")
    sp.add_argument("--json", action="store_true", help="machine-readable output")
    hp = sub.add_parser("host", help="print the work host (`shared.workHost`) and its dispatch plan")
    hp.add_argument("--plan", action="store_true",
                    help="print the dispatch steps for the command after `--`; runs nothing")
    hp.add_argument("--json", action="store_true", help="machine-readable output")
    hp.add_argument("command", nargs="*", help="the command to dispatch, after `--`")
    xp = sub.add_parser("export", help="print the repository layer as the envelope a service would hold")
    xp.add_argument("--json", action="store_true", help="machine-readable output")
    ip = sub.add_parser("init", help="seed .agents/quenching.json with every adjustable default")
    ip.add_argument("--write", action="store_true", help="create the file (default: preview)")
    ip.add_argument("--json", action="store_true", help="machine-readable output")
    kp = sub.add_parser("check", help="list the seeded keys the file lacks")
    kp.add_argument("--json", action="store_true", help="machine-readable output")
    return p


def main(argv: list[str]) -> int:
    if "--version" in argv:
        print(f"cq config {VERSION}")
        return 0
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.cmd:
        parser.print_usage(sys.stderr)
        return REFUSAL
    return {"host": cmd_host, "export": cmd_export, "init": cmd_init, "check": cmd_check}.get(args.cmd, cmd_show)(args)
