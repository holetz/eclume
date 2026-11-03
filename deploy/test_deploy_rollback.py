# ruff: noqa: INP001, S101, S603, PLR2004, D101, D102  # loose tests of the deploy scripts; runs real bash and git
"""`deploy.sh --rollback` run for real, with `docker`, `ssh` and `gh` swapped for stubs on PATH.

`deploy_lib.py rollback` already has a unit test; here it is the shell that calls it (flag, gate
bypass, plan and refusal) that runs, in a throwaway repository. It asserts exit codes and stable
markers of the output, never the text of the script's commands.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

DEPLOY = Path(__file__).parent
BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(
    BASH is None or sys.platform == "win32",
    reason="deploy.sh needs POSIX bash; the windows pillar does not exercise it (explicit warning, not silence)",
)

IMAGES = ("server", "web", "worker-gpu")
# The `compose config --format json` of a compose before #151, at the minimum the topology reads.
COMPOSE = {
    "services": {
        "caddy": {"image": "caddy:2"},
        "postgres": {"image": "pgvector/pgvector:pg16"},
        "redis": {"image": "redis:7-alpine"},
        "server": {"image": "eclume-server:prod", "build": {"context": "."}},
        "web": {"image": "eclume-web:prod", "build": {"context": "."}},
        "worker-gpu": {"image": "eclume-worker-gpu:prod", "build": {"context": "."}},
    }
}
ENV_PROD = "\n".join(
    [
        "ECLUME_DATA_DIR=/srv/eclume",
        "ECLUME_PUBLIC_URL=https://example.test",
        "ECLUME_CLAUDE_CLI=1",
        *(
            f"{key}=x"
            for key in (
                "ECLUME_RUNTIME_PG_PASSWORD",
                "ECLUME_MINIO_SERVER_PASSWORD",
                "ECLUME_MINIO_GPU_PASSWORD",
                "ECLUME_REDIS_SERVER_PASSWORD",
                "ECLUME_REDIS_GPU_PASSWORD",
            )
        ),
    ]
)

DOCKER = """#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/docker.calls"
case "$1 $2" in
  "context inspect") echo "ssh://test@host" ;;
  "compose version") echo "2.30.0" ;;
  "image inspect") grep -qxF "${3#eclume-}" "$STUB_DIR/images" || exit 1 ;;
  "ps -q") echo cid ;;
  "exec cid")
    if [[ "$*" == *psql* ]]; then cat "$STUB_DIR/database"; else echo 0; fi ;;
  *) [[ "$*" == *"config --format json"* ]] && cat "$STUB_DIR/compose.json" ;;
esac
exit 0
"""
SSH = """#!/usr/bin/env bash
cmd="${*: -1}"
case "$cmd" in
  "cat '"*deploys.log*) cat "$STUB_DIR/deploys.log" ;;
  "test -s"*) exit 1 ;;
  "df "*) echo 42 ;;
esac
exit 0
"""
GH = """#!/usr/bin/env bash
echo "gh $*" >> "$STUB_DIR/gh.calls"
exit 1
"""

# The pt-BR CLI of deploy/versao.py, before the English rename: answers only the old spelling.
OLD_VERSION = """import sys
sys.exit(print("0.1.0") if sys.argv[1] == "--raiz" and sys.argv[3:] == ["atual", "produto"] else 2)
"""


@dataclass
class Case:
    repo: Path
    stubs: Path
    kept: str
    env: dict[str, str]

    def run(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(BASH), "deploy/deploy.sh", "--context", "test", *args],
            cwd=self.repo,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )

    def docker(self) -> list[str]:
        calls_file = self.stubs / "docker.calls"
        return calls_file.read_text(encoding="utf-8").splitlines() if calls_file.exists() else []

    def wrote(self) -> bool:
        """Some docker call that builds or starts (`build`, `compose ... up`)."""
        return any(
            c.split()[:1] == ["build"] or " build" in c or c.endswith((" up", " up -d")) or " up " in c
            for c in self.docker()
        )

    def gate_queried(self) -> bool:
        return (self.stubs / "gh.calls").exists()


def _git(repo: Path, *args: str) -> str:
    cmd = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", *args]
    return subprocess.run(cmd, cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def _case(tmp_path: Path, *, database: str, kept_images: bool, deploys: int = 2, old_version: bool = False) -> Case:
    repo = tmp_path / "repo"
    stubs = tmp_path / "stubs"
    migrations = repo / "server/src/eclume_server/db/migrations"
    (repo / "deploy").mkdir(parents=True)
    migrations.mkdir(parents=True)
    stubs.mkdir()
    for name in ("deploy.sh", "deploy_lib.py", "gpu-lib.sh"):
        shutil.copy(DEPLOY / name, repo / "deploy" / name)
    (repo / "deploy/docker-compose.prod.yml").write_text("services: {}\n", encoding="utf-8")
    (repo / "deploy/.env.prod").write_text(ENV_PROD + "\n", encoding="utf-8")
    (migrations / "001_base.sql").write_text("select 1;\n", encoding="utf-8")
    if old_version:
        # A tree from before the English rename: deploy/versao.py speaks pt-BR.
        (repo / "deploy/versao.py").write_text(OLD_VERSION, encoding="utf-8")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", "-A", "-f")
    _git(repo, "commit", "-q", "-m", "kept")
    kept = _git(repo, "rev-parse", "HEAD")
    (migrations / "002_new.sql").write_text("select 2;\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "current")
    current = _git(repo, "rev-parse", "HEAD")

    # The log: the kept one, (deploys - 2) intermediate deploys and the current one last.
    intermediates = ["c" * 40] * (deploys - 2)
    shas = [kept, *intermediates, current]
    lines = [f"2026-10-0{i + 1}T12:00:00Z\t{sha}\t-\t-\t-\t-" for i, sha in enumerate(shas)]
    (stubs / "deploys.log").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (stubs / "database").write_text(database, encoding="utf-8")
    (stubs / "compose.json").write_text(json.dumps(COMPOSE), encoding="utf-8")
    (stubs / "images").write_text("".join(f"{i}:{kept}\n" for i in IMAGES) if kept_images else "", encoding="utf-8")
    for name, body in (("docker", DOCKER), ("ssh", SSH), ("gh", GH)):
        (stubs / name).write_text(body, encoding="utf-8")
        (stubs / name).chmod(0o755)
    env = {
        "PATH": f"{stubs}:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "STUB_DIR": str(stubs),
    }
    return Case(repo=repo, stubs=stubs, kept=kept, env=env)


def test_plan_rollback_one_step_back_neither_queries_the_gate_nor_writes(tmp_path: Path) -> None:
    """Happy path: exits 0, prints the rollback plan and neither builds nor starts anything."""
    case = _case(tmp_path, database="001_base\n002_new\n", kept_images=True)
    result = case.run("--plan", "--rollback", case.kept)
    assert result.returncode == 0, result.stderr
    assert "Rollback:" in result.stderr
    assert "one step back" in result.stderr
    assert "--rollback refused" not in result.stderr
    assert "the kept image" not in result.stderr
    assert "gate: not applicable" in result.stderr
    assert "Build: nothing" in result.stderr
    assert not case.gate_queried()
    assert case.docker(), "the docker stubs were not called"
    assert not case.wrote()


def test_rollback_two_steps_with_an_unknown_migration_refuses(tmp_path: Path) -> None:
    """The database has 002, which the target does not know, and the target is two deploys back: exits 2."""
    case = _case(tmp_path, database="001_base\n002_new\n", kept_images=True, deploys=3)
    result = case.run("--rollback", case.kept)
    assert result.returncode == 2, result.stderr
    assert "--rollback refused" in result.stderr
    assert "more than one step back" in result.stderr
    assert not case.gate_queried()
    assert not case.wrote()


def test_rollback_without_the_kept_image_refuses(tmp_path: Path) -> None:
    """Without the `eclume-<image>:<sha>` trio on the host, the rollback exits 2 before writing."""
    case = _case(tmp_path, database="001_base\n", kept_images=False)
    result = case.run("--rollback", case.kept)
    assert result.returncode == 2, result.stderr
    assert "the kept image" in result.stderr
    assert not case.wrote()


def test_plan_rollback_to_a_tree_before_the_rename_reads_its_versao_py(tmp_path: Path) -> None:
    """The target's tree only has `deploy/versao.py`: the plan still shows its product version."""
    case = _case(tmp_path, database="001_base\n002_new\n", kept_images=True, old_version=True)
    result = case.run("--plan", "--rollback", case.kept)
    assert result.returncode == 0, result.stderr
    assert "Product version: 0.1.0 (rollback: no tag)" in result.stderr
