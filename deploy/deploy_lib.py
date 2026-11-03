# ruff: noqa: INP001  # loose script, called by deploy.sh; deploy/ is not a package
"""Testable decisions of the production deploy (`deploy/deploy.sh`), stdlib only.

Subcommands:

- `env-diverge <host-hashes> <local-env>` — the host sends, over SSH, one `KEY<TAB>sha256` line per
  key of `secrets/env.prod` (the value never leaves the host); it diverges when a host key is missing
  from the local env or has another value. A new key only in the local one passes. Prints the
  diverging keys and exits 1; without divergence, exits 0.
- `env-hashes <env>` — the `KEY<TAB>sha256` lines of an env, in the format the host produces.
- `kept <deploys.log> [N]` — the SHAs of the last N distinct deploys (`keep<TAB>sha`) and the
  pre-deploy dumps of the deploys outside the window (`remove-dump<TAB>path`).
- `rollback <deploys.log> <target-sha> <database-migrations> <target-migrations> [--kept N]` —
  whether the `--rollback` to the SHA is allowed: its trio must be kept, and the database must not
  have migrations the target does not know, except one step back (the expand/contract rule
  guarantees the previous deploy's code runs on the new schema). A refusal points at the
  pre-deploy dump.
- `topology <compose.json>` — the topology of the SHA's compose (`docker compose config --format
  json` of its tree, so it also holds for a `--rollback` to a compose before the single worker and
  the edge with the SPA, holetz/eclume#151): `image<TAB>name<TAB>service` per built
  `eclume-<name>:prod` image (the kept trio: `server`, `edge` or the old `web`, `worker-gpu`),
  `app<TAB>service` per service that starts before the edge (all but the infrastructure, `caddy` and
  `mdns`) and `problem<TAB>text` per `memswap_limit` lower than the `mem_limit`.

`deploys.log` (TSV, one line per deploy, oldest to newest): date, SHA, flags, reason, applied
migrations (comma-separated, or `-`) and the pre-deploy dump (path, or `-`). Entries written before
the English rename carry the pt-BR flag names (`--voltar`, `--sem-gate`…); only the columns matter.
Runbook: docs/project/deploy-producao.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

KEPT = 3
_KEY = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
_EMPTY = "-"


@dataclass(frozen=True)
class Deploy:
    """One line of `deploys.log`."""

    date: str
    sha: str
    flags: str
    reason: str
    migrations: tuple[str, ...]
    dump: str | None


def read_env(text: str) -> dict[str, str]:
    """The keys of an env (`KEY=value`); the last occurrence wins, as in deploy.sh's `env_value`."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        found = _KEY.match(line)
        if found:
            values[found.group(1)] = found.group(2)
    return values


def hash_value(value: str) -> str:
    """The hash of a value, equal to the host's `printf '%s' "$v" | sha256sum`."""
    return hashlib.sha256(value.encode()).hexdigest()


def env_hashes(text: str) -> dict[str, str]:
    """`{key: sha256(value)}` of an env."""
    return {key: hash_value(value) for key, value in read_env(text).items()}


def read_hashes(text: str) -> dict[str, str]:
    """The `KEY<TAB>sha256` lines the host produces; the last occurrence wins."""
    hashes: dict[str, str] = {}
    for line in text.splitlines():
        if "\t" in line:
            key, value = line.split("\t", 1)
            hashes[key.strip()] = value.strip()
    return hashes


def env_diverge(host: dict[str, str], local: dict[str, str]) -> list[str]:
    """The host keys (by hash) missing from the local env or changed; a new key only in the local one passes."""
    return sorted(key for key, value in host.items() if local.get(key) != value)


def read_log(text: str) -> list[Deploy]:
    """The lines of `deploys.log`, in order; a malformed line is ignored."""
    deploys = []
    for line in text.splitlines():
        fields = line.split("\t")
        if len(fields) < 6 or not fields[1]:  # noqa: PLR2004 — the log's six columns
            continue
        date, sha, flags, reason, migrations, dump = fields[:6]
        deploys.append(
            Deploy(
                date=date,
                sha=sha,
                flags=flags,
                reason=reason,
                migrations=tuple(m for m in migrations.split(",") if m and m != _EMPTY),
                dump=None if dump in {"", _EMPTY} else dump,
            )
        )
    return deploys


def window(deploys: list[Deploy], n: int = KEPT) -> list[str]:
    """The SHAs of the last `n` distinct deploys, newest to oldest."""
    seen: list[str] = []
    for deploy in reversed(deploys):
        if deploy.sha not in seen:
            seen.append(deploy.sha)
        if len(seen) == n:
            break
    return seen


def kept(deploys: list[Deploy], n: int = KEPT) -> tuple[list[str], list[str]]:
    """`(SHAs to keep, dumps to remove)`: the dumps of the deploys outside the window go."""
    keep = window(deploys, n)
    remove = [d.dump for d in deploys if d.dump and d.sha not in keep]
    # A dump also cited by a deploy in the window stays.
    cited = {d.dump for d in deploys if d.dump and d.sha in keep}
    return keep, [dump for dump in dict.fromkeys(remove) if dump not in cited]


@dataclass(frozen=True)
class Decision:
    """Is the `--rollback` allowed? If not, why."""

    allowed: bool
    reason: str


def rollback(deploys: list[Deploy], target: str, database: set[str], known: set[str], n: int = KEPT) -> Decision:
    """Decides the `--rollback` to the `target` SHA (see the module docstring)."""
    retained = window(deploys, n)
    if target not in retained:
        return Decision(
            allowed=False,
            reason=f"the trio of {target[:12]} is not kept (only the last {n} deploys: {', '.join(s[:12] for s in retained)})",
        )
    unknown = sorted(database - known)
    if not unknown:
        return Decision(allowed=True, reason="the database only has migrations the target knows")
    # One step back: the target is the distinct deploy right before the current one.
    if len(retained) >= 2 and retained[1] == target:  # noqa: PLR2004 — the current one and the previous one
        return Decision(allowed=True, reason=f"one step back; the new schema is expand/contract ({', '.join(unknown)})")
    last_of_target = max(i for i, d in enumerate(deploys) if d.sha == target)
    dump = next((d.dump for d in deploys[last_of_target + 1 :] if d.dump), None)
    where = f"; restore the database from the dump {dump} (restore-backup.sh --database)" if dump else ""
    return Decision(
        allowed=False,
        reason=f"more than one step back with migrations the target does not know: {', '.join(unknown)}{where}",
    )


INFRA = ("postgres", "redis", "minio")
# They start after the rest, each in its own step: the edge recreated, and the announcement after `publish-ca`.
LAST = ("caddy", "mdns")
_IMAGE = re.compile(r"^eclume-([a-z0-9][a-z0-9-]*):prod$")
_BYTES = re.compile(r"^(\d+)([bkmg]?)b?$", re.IGNORECASE)
_FACTOR = {"": 1, "b": 1, "k": 1024, "m": 1024**2, "g": 1024**3}


@dataclass(frozen=True)
class Topology:
    """What the deploy starts and keeps, read from the SHA's compose."""

    images: tuple[tuple[str, str], ...]
    app: tuple[str, ...]
    problems: tuple[str, ...]


def _bytes(value: object) -> int | None:
    """`mem_limit`/`memswap_limit` in bytes: `config` gives the number; `256m` also passes."""
    if isinstance(value, int):
        return value
    found = _BYTES.match(str(value).strip())
    return int(found.group(1)) * _FACTOR[found.group(2).lower()] if found else None


def topology(config: dict[str, object]) -> Topology:
    """The topology of the resolved compose (see the module docstring)."""
    services = {
        name: service
        for name, service in (config.get("services") or {}).items()  # type: ignore[union-attr]
        if isinstance(service, dict) and not service.get("profiles")
    }
    owners: dict[str, list[str]] = {}
    for name, service in services.items():
        found = _IMAGE.match(str(service.get("image") or ""))
        if found and service.get("build"):
            owners.setdefault(found.group(1), []).append(name)
    # The service that builds each image: the one with the same name (server, worker-gpu) or the only one (caddy).
    images = tuple((image, image if image in names else min(names)) for image, names in sorted(owners.items()))
    app = tuple(name for name in sorted(services) if name not in INFRA + LAST)
    problems = []
    for name in sorted(services):
        ceiling = _bytes(services[name].get("mem_limit")) if services[name].get("mem_limit") else None
        swap = _bytes(services[name].get("memswap_limit")) if services[name].get("memswap_limit") else None
        if ceiling and swap and swap < ceiling:
            problems.append(
                f"{name}: memswap_limit ({swap // 1024**2} MiB) lower than mem_limit ({ceiling // 1024**2} MiB);"
                f" raise ECLUME_MEMSWAP_{name.upper().replace('-', '_')} together with the ceiling"
            )
    return Topology(images=images, app=app, problems=tuple(problems))


def _read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8") if Path(path).exists() else ""


def _lines(path: str) -> set[str]:
    return {line.strip() for line in _read(path).splitlines() if line.strip()}


def _print_topology(path: str) -> int:
    topo = topology(json.loads(_read(path) or "{}"))
    for image, service in topo.images:
        sys.stdout.write(f"image\t{image}\t{service}\n")
    for service in topo.app:
        sys.stdout.write(f"app\t{service}\n")
    for problem in topo.problems:
        sys.stdout.write(f"problem\t{problem}\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Entry point; see the module docstring."""
    parser = argparse.ArgumentParser(prog="deploy_lib.py")
    sub = parser.add_subparsers(dest="command", required=True)
    diverge = sub.add_parser("env-diverge")
    diverge.add_argument("host")
    diverge.add_argument("local")
    sub.add_parser("env-hashes").add_argument("env")
    ret = sub.add_parser("kept")
    ret.add_argument("log")
    ret.add_argument("n", nargs="?", type=int, default=KEPT)
    back = sub.add_parser("rollback")
    for name in ("log", "target", "database", "known"):
        back.add_argument(name)
    back.add_argument("--kept", type=int, default=KEPT)
    sub.add_parser("topology").add_argument("compose")
    args = parser.parse_args(argv)

    if args.command == "topology":
        return _print_topology(args.compose)

    if args.command == "env-hashes":
        for key, value in env_hashes(_read(args.env)).items():
            sys.stdout.write(f"{key}\t{value}\n")
        return 0
    if args.command == "env-diverge":
        keys = env_diverge(read_hashes(_read(args.host)), env_hashes(_read(args.local)))
        for key in keys:
            sys.stdout.write(f"{key}\n")
        return 1 if keys else 0
    if args.command == "kept":
        keep, remove = kept(read_log(_read(args.log)), args.n)
        for sha in keep:
            sys.stdout.write(f"keep\t{sha}\n")
        for dump in remove:
            sys.stdout.write(f"remove-dump\t{dump}\n")
        return 0
    decision = rollback(read_log(_read(args.log)), args.target, _lines(args.database), _lines(args.known), args.kept)
    sys.stdout.write(decision.reason + "\n")
    return 0 if decision.allowed else 1


if __name__ == "__main__":
    sys.exit(main())
