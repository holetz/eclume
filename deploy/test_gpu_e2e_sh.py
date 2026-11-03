# ruff: noqa: INP001, S101, S603, PLR2004, D101, D102, D103  # loose tests of the deploy scripts; runs real bash
"""`deploy/gpu-e2e.sh` run for real, with `docker` and `nvidia-smi` swapped for stubs on PATH.

Asserts only what is stable: the `up`, the `down -v`, what is never called (stopping production) and
the exit code; never the whole text of the docker commands.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

DEPLOY = Path(__file__).parent
BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(
    BASH is None or sys.platform == "win32",
    reason="gpu-e2e.sh needs POSIX bash; the windows pillar does not exercise it (explicit notice, not silence)",
)

# `exec` answers the production Redis `busy`; `run` is the pytest of the eclume-gate container.
DOCKER = """#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/docker.calls"
case "$1" in
  ps) echo cid ;;
  exec) cat "$STUB_DIR/busy" ;;
  run) exit "$(cat "$STUB_DIR/pytest.rc")" ;;
esac
exit 0
"""
NVIDIA_SMI = """#!/usr/bin/env bash
cat "$STUB_DIR/vram"
"""


@dataclass
class Case:
    repo: Path
    stubs: Path
    env: dict[str, str]

    def run(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(BASH), "deploy/gpu-e2e.sh"],
            cwd=self.repo,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )

    def calls(self) -> list[str]:
        calls_file = self.stubs / "docker.calls"
        return calls_file.read_text(encoding="utf-8").splitlines() if calls_file.exists() else []

    def started(self) -> bool:
        return any(" up " in f" {c} " for c in self.calls() if c.startswith("compose"))

    def ran_pytest(self) -> bool:
        return any(c.startswith("run ") for c in self.calls())

    def tore_down(self) -> list[str]:
        return [c for c in self.calls() if c.startswith("compose") and " down -v" in c]

    def stopped_something(self) -> bool:
        return any(c.split()[0] in {"stop", "kill", "rm", "restart"} or " stop" in c for c in self.calls())


def _case(tmp_path: Path, *, busy: str = "0", vram: str = "6000", pytest_rc: int = 0) -> Case:
    repo = tmp_path / "repo"
    stubs = tmp_path / "stubs"
    (repo / "deploy").mkdir(parents=True)
    stubs.mkdir()
    for name in ("gpu-e2e.sh", "gpu-lib.sh"):
        shutil.copy(DEPLOY / name, repo / "deploy" / name)
    (stubs / "busy").write_text(busy + "\n", encoding="utf-8")
    (stubs / "vram").write_text(vram + "\n", encoding="utf-8")
    (stubs / "pytest.rc").write_text(str(pytest_rc), encoding="utf-8")
    for name, body in (("docker", DOCKER), ("nvidia-smi", NVIDIA_SMI)):
        (stubs / name).write_text(body, encoding="utf-8")
        (stubs / name).chmod(0o755)
    env = {
        "PATH": f"{stubs}:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "STUB_DIR": str(stubs),
        "ECLUME_GPU_E2E_WAIT": "0",
        "ECLUME_GPU_E2E_INTERVAL": "0",
        "ECLUME_GATE_IMAGE": "eclume-gate:test",
    }
    return Case(repo=repo, stubs=stubs, env=env)


def test_free_gpu_starts_runs_and_tears_down(tmp_path: Path) -> None:
    case = _case(tmp_path)
    result = case.run()
    assert result.returncode == 0, result.stderr
    assert case.started()
    assert case.ran_pytest()
    assert case.tore_down(), "the down -v did not run"
    assert " down -v" in case.calls()[-1]


def test_failing_test_still_tears_down_and_propagates_the_code(tmp_path: Path) -> None:
    case = _case(tmp_path, pytest_rc=3)
    result = case.run()
    assert result.returncode == 3, result.stderr
    assert case.started()
    assert " down -v" in case.calls()[-1]


def test_gpu_busy_past_the_limit_exits_75_without_starting_or_stopping(tmp_path: Path) -> None:
    case = _case(tmp_path, busy="1")
    result = case.run()
    assert result.returncode == 75, result.stderr
    assert "inconclusive" in result.stderr
    assert not case.started()
    assert not case.ran_pytest()
    assert not case.stopped_something()
    assert case.tore_down(), "the defensive down -v and the trap one run here too"


def test_free_vram_below_the_minimum_counts_as_busy(tmp_path: Path) -> None:
    case = _case(tmp_path, vram="2048")
    result = case.run()
    assert result.returncode == 75, result.stderr
    assert "VRAM" in result.stderr
    assert not case.started()
    assert not case.stopped_something()


def test_gpu_freed_during_the_wait_runs(tmp_path: Path) -> None:
    """Busy on the first check and free afterwards: it waits and runs, instead of exiting 75."""
    case = _case(tmp_path, busy="1")
    docker = case.stubs / "docker"
    docker.write_text(
        DOCKER.replace('exec) cat "$STUB_DIR/busy" ;;', 'exec) cat "$STUB_DIR/busy"; echo 0 > "$STUB_DIR/busy" ;;'),
        encoding="utf-8",
    )
    case.env["ECLUME_GPU_E2E_WAIT"] = "1"
    result = case.run()
    assert result.returncode == 0, result.stderr
    assert "waiting" in result.stderr
    assert case.started()
    assert case.ran_pytest()


@pytest.mark.parametrize(
    ("env", "inconclusive"),
    [
        # The deprecated pt-BR names still hold: a 1-minute wait lets the freed GPU run.
        ({"ECLUME_GPU_E2E_ESPERA": "1", "ECLUME_GPU_E2E_INTERVALO": "0"}, False),
        # The English name wins over the deprecated one: no wait, so the busy GPU is inconclusive.
        ({"ECLUME_GPU_E2E_WAIT": "0", "ECLUME_GPU_E2E_ESPERA": "1"}, True),
    ],
)
def test_wait_and_interval_read_the_deprecated_names_and_the_new_ones_win(
    tmp_path: Path, env: dict[str, str], *, inconclusive: bool
) -> None:
    case = _case(tmp_path, busy="1")
    (case.stubs / "docker").write_text(
        DOCKER.replace('exec) cat "$STUB_DIR/busy" ;;', 'exec) cat "$STUB_DIR/busy"; echo 0 > "$STUB_DIR/busy" ;;'),
        encoding="utf-8",
    )
    for name in ("ECLUME_GPU_E2E_WAIT", "ECLUME_GPU_E2E_INTERVAL"):
        case.env.pop(name)
    case.env.update(env)
    started = time.monotonic()
    result = case.run()
    assert (result.returncode == 75) is inconclusive, result.stderr
    # ECLUME_GPU_E2E_INTERVALO=0 was read: no default 30 s sleep between the two checks.
    assert time.monotonic() - started < 20


def test_every_deploy_path_the_script_names_exists() -> None:
    """The skip check runs inside the container, out of reach of the stubs: its paths must exist."""
    import re  # noqa: PLC0415  # only this static check needs it

    text = (DEPLOY / "gpu-e2e.sh").read_text(encoding="utf-8")
    named = set(re.findall(r"\bdeploy/[\w.-]+\.(?:py|sh|txt|yml)\b", text))
    assert "deploy/skips.py" in named
    assert [p for p in sorted(named) if not (DEPLOY.parent / p).exists()] == []
