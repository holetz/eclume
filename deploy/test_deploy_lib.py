# ruff: noqa: INP001, S101  # loose tests of the deploy scripts; deploy/ is not a Python package
"""Tests of `deploy_lib.py`: env divergence, deploy retention and `--rollback`."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import yaml

if TYPE_CHECKING:
    import pytest

_spec = importlib.util.spec_from_file_location("deploy_lib", Path(__file__).with_name("deploy_lib.py"))
assert _spec is not None
assert _spec.loader is not None
lib = importlib.util.module_from_spec(_spec)
# The module's dataclasses resolve their annotations through `sys.modules`.
sys.modules["deploy_lib"] = lib
_spec.loader.exec_module(lib)

A, B, C, D = ("a" * 40, "b" * 40, "c" * 40, "d" * 40)


def line(sha: str, migrations: str = "-", dump: str = "-", flags: str = "-") -> str:
    """One line of `deploys.log`."""
    return f"2026-10-01T12:00:00Z\t{sha}\t{flags}\t-\t{migrations}\t{dump}"


def test_env_diverges_by_key_and_a_key_only_in_the_local_one_passes() -> None:
    """A host key missing or changed diverges; a new key only in the local one passes."""
    host = lib.env_hashes("ECLUME_PG_PASSWORD=x\nECLUME_SECRET_KEY=y\n")
    assert lib.env_diverge(host, lib.env_hashes("ECLUME_PG_PASSWORD=x\nECLUME_SECRET_KEY=y\nNEW=z\n")) == []
    assert lib.env_diverge(host, lib.env_hashes("ECLUME_PG_PASSWORD=x\n")) == ["ECLUME_SECRET_KEY"]
    assert lib.env_diverge(host, lib.env_hashes("ECLUME_PG_PASSWORD=other\nECLUME_SECRET_KEY=y\n")) == [
        "ECLUME_PG_PASSWORD"
    ]


def test_env_ignores_comments_and_the_last_occurrence_wins() -> None:
    """A comment and an indented line are not keys; the last occurrence wins."""
    assert lib.read_env("# comment\n\nA=1\nA=2\n  B=3\n") == {"A": "2"}


def test_hash_equals_the_hosts() -> None:
    """The value's hash is the host's `printf '%s' | sha256sum`."""
    assert lib.hash_value("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    hashes = lib.read_hashes("A\t" + lib.hash_value("v=1 2") + "\n")
    assert lib.env_diverge(hashes, lib.env_hashes("A=v=1 2\n")) == []


def test_cli_env_diverge(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """The subcommand prints the diverging keys and exits 1."""
    host = tmp_path / "host"
    host.write_text("A\t" + lib.hash_value("1") + "\nB\t" + lib.hash_value("2") + "\n", encoding="utf-8")
    local = tmp_path / "local"
    local.write_text("A=1\nB=3\n", encoding="utf-8")
    assert lib.main(["env-diverge", str(host), str(local)]) == 1
    assert capsys.readouterr().out == "B\n"
    local.write_text("A=1\nB=2\n", encoding="utf-8")
    assert lib.main(["env-diverge", str(host), str(local)]) == 0


def test_kept_holds_the_last_three_distinct_and_drops_the_dumps_outside() -> None:
    """The window is the last three distinct SHAs; the dumps outside it go."""
    log = lib.read_log(
        "\n".join(
            [
                line(A, "020_x", "/srv/eclume/backups/pre-deploy/1.dump"),
                line(B, "021_y", "/srv/eclume/backups/pre-deploy/2.dump"),
                line(C),
                line(C),
                line(D, "022_z", "/srv/eclume/backups/pre-deploy/3.dump"),
                "broken line",
            ]
        )
    )
    keep, remove = lib.kept(log)
    assert keep == [D, C, B]
    assert remove == ["/srv/eclume/backups/pre-deploy/1.dump"]


def test_rollback_without_a_new_migration_is_allowed() -> None:
    """Without a migration the target does not know, the `--rollback` holds."""
    log = lib.read_log("\n".join([line(A), line(B), line(C)]))
    decision = lib.rollback(log, A, database={"001", "002"}, known={"001", "002"})
    assert decision.allowed


def test_rollback_one_step_with_an_expand_migration_is_allowed() -> None:
    """One step back holds even with a new migration (expand/contract)."""
    log = lib.read_log("\n".join([line(A), line(B, "003", "/d/b.dump")]))
    decision = lib.rollback(log, A, database={"001", "002", "003"}, known={"001", "002"})
    assert decision.allowed
    assert "003" in decision.reason


def test_rollback_two_steps_with_an_unknown_migration_refuses_and_points_at_the_dump() -> None:
    """More than one step with an unknown migration refuses and points at the dump."""
    log = lib.read_log("\n".join([line(A), line(B, "003", "/d/b.dump"), line(C, "004", "/d/c.dump")]))
    decision = lib.rollback(log, A, database={"001", "002", "003", "004"}, known={"001", "002"})
    assert not decision.allowed
    assert "003, 004" in decision.reason
    assert "/d/b.dump" in decision.reason
    assert "restore-backup.sh --database" in decision.reason


def test_rollback_to_a_trio_not_kept_refuses() -> None:
    """A trio outside the retention window refuses."""
    log = lib.read_log("\n".join([line(A), line(B), line(C), line(D)]))
    decision = lib.rollback(log, A, database=set(), known=set())
    assert not decision.allowed
    assert "is not kept" in decision.reason


def test_cli_rollback(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """The subcommand exits 0 when allowed and 1 on refusal; `--kept` widens the window."""
    log = tmp_path / "deploys.log"
    log.write_text("\n".join([line(A), line(B, "003", "/d/b.dump"), line(C, "004", "/d/c.dump")]) + "\n")
    database, known = tmp_path / "database", tmp_path / "target"
    database.write_text("001\n003\n004\n")
    known.write_text("001\n003\n")
    assert lib.main(["rollback", str(log), B, str(database), str(known)]) == 0
    assert "one step back" in capsys.readouterr().out
    assert lib.main(["rollback", str(log), A, str(database), str(known)]) == 1
    assert "/d/b.dump" in capsys.readouterr().out
    assert lib.main(["rollback", str(log), A, str(database), str(known), "--kept", "2"]) == 1
    assert "is not kept" in capsys.readouterr().out


def test_cli_kept(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """The subcommand prints `keep` and `remove-dump` lines, the ones deploy.sh reads."""
    log = tmp_path / "deploys.log"
    log.write_text("\n".join([line(A, "001", "/d/a.dump"), line(B), line(C)]) + "\n")
    assert lib.main(["kept", str(log), "2"]) == 0
    assert capsys.readouterr().out.splitlines() == [f"keep\t{C}", f"keep\t{B}", "remove-dump\t/d/a.dump"]


def _service(image: str, *, build: bool = False, **extra: object) -> dict[str, object]:
    service: dict[str, object] = {"image": image, **extra}
    if build:
        service["build"] = {"context": ".", "dockerfile": "Dockerfile"}
    return service


# The `docker compose config --format json` of a compose before #151 (pure Caddy edge, `web` and
# the two CPU workers), as the `--rollback` reads it from the SHA's tree.
PREVIOUS_COMPOSE = {
    "services": {
        "caddy": _service("caddy:2.11@sha256:0c99", mem_limit="268435456"),
        "mdns": _service("eclume-server:prod", build=True),
        "minio": _service("pgsty/minio", mem_limit="1073741824"),
        "postgres": _service("pgvector/pgvector:pg16"),
        "redis": _service("redis:7-alpine", mem_limit="536870912"),
        "server": _service("eclume-server:prod", build=True, mem_limit="1073741824"),
        "web": _service("eclume-web:prod", build=True, mem_limit="134217728"),
        "worker-agents": _service("eclume-server:prod", build=True, mem_limit="2147483648"),
        "worker-cpu": _service("eclume-server:prod", build=True, mem_limit="1073741824"),
        "worker-gpu": _service("eclume-worker-gpu:prod", build=True, mem_limit="8589934592"),
    }
}


def test_topology_of_the_current_compose_starts_the_single_worker_and_keeps_the_edge() -> None:
    """The compose of this checkout: `edge` built by `caddy`, without `web` or the two workers."""
    compose = yaml.safe_load(Path(__file__).with_name("docker-compose.prod.yml").read_text(encoding="utf-8"))
    topo = lib.topology(compose)
    assert topo.images == (("edge", "caddy"), ("server", "server"), ("worker-gpu", "worker-gpu"))
    assert topo.app == ("server", "worker", "worker-gpu")
    assert topo.problems == ()


def test_topology_of_the_previous_compose_on_rollback() -> None:
    """A `--rollback` to a SHA before #151 keeps the trio with `web` and starts its services."""
    topo = lib.topology(PREVIOUS_COMPOSE)
    assert topo.images == (("server", "server"), ("web", "web"), ("worker-gpu", "worker-gpu"))
    assert topo.app == ("server", "web", "worker-agents", "worker-cpu", "worker-gpu")
    assert topo.problems == ()


def test_topology_ignores_the_one_shots_of_the_tools_profile() -> None:
    """A service with a profile does not start with the rest nor counts as a kept image."""
    config = {
        "services": {
            "server": _service("eclume-server:prod", build=True),
            "migrate": _service("eclume-server:prod", build=True, profiles=["tools"]),
            "other": _service("eclume-other:prod", build=True, profiles=["tools"]),
        }
    }
    topo = lib.topology(config)
    assert topo.images == (("server", "server"),)
    assert topo.app == ("server",)


def test_topology_refuses_a_memswap_lower_than_the_ceiling() -> None:
    """A ceiling raised without its swap pair: the `up` would fail mid-deploy."""
    config = {
        "services": {
            "worker": _service("eclume-server:prod", build=True, mem_limit="4294967296", memswap_limit="3221225472"),
            "redis": _service("redis", mem_limit="256m", memswap_limit="384m"),
        }
    }
    (problem,) = lib.topology(config).problems
    assert problem.startswith("worker: memswap_limit (3072 MiB) lower than mem_limit (4096 MiB)")
    assert "ECLUME_MEMSWAP_WORKER" in problem


def test_cli_topology(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """The subcommand reads the `config` JSON and prints images, services and problems."""
    compose = tmp_path / "compose.json"
    compose.write_text(json.dumps(PREVIOUS_COMPOSE), encoding="utf-8")
    assert lib.main(["topology", str(compose)]) == 0
    output = capsys.readouterr().out.splitlines()
    assert "image\tweb\tweb" in output
    assert "app\tworker-agents" in output
    assert not [line for line in output if line.startswith(("app\tcaddy", "app\tmdns", "app\tpostgres"))]
