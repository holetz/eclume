# ruff: noqa: INP001, S101  # loose tests of the deploy scripts; deploy/ is not a Python package
"""Tests of `gate.py`: the decision on the `eclume/gate` status, the description and the push targets."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import tomllib
from pathlib import Path

import pytest
import yaml

_spec = importlib.util.spec_from_file_location("gate", Path(__file__).with_name("gate.py"))
assert _spec is not None
assert _spec.loader is not None
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

SHA = "a" * 40
LOG = f"~/eclume-gate/logs/{SHA}.log"


def combined(*statuses: tuple[str, str]) -> dict[str, object]:
    """A GitHub combined status with one status per context."""
    return {"state": "pending", "statuses": [{"context": c, "state": s} for c, s in statuses]}


def run(
    argv: list[str], data: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> tuple[int, str]:
    """Runs `gate.main` with the data on stdin and returns (code, output)."""
    monkeypatch.setattr("sys.stdin", io.StringIO(data))
    code = gate.main(argv)
    return code, capsys.readouterr().out


# --- decide ---------------------------------------------------------------------------------------


def test_decide_clears_only_with_the_gate_in_success() -> None:
    """Only `success` clears; the other states refuse, naming the state."""
    assert gate.decide(combined(("eclume/gate", "success")))[0] is True
    for state in ("pending", "failure", "error"):
        cleared, message = gate.decide(combined(("eclume/gate", state)))
        assert cleared is False
        assert state in message


def test_decide_refuses_without_the_gate_even_with_other_green_contexts() -> None:
    """Another green context, or the waiver, does not replace the gate."""
    cleared, message = gate.decide(combined(("ci/other", "success"), ("eclume/gate-dispensa", "failure")))
    assert cleared is False
    assert "missing" in message


def test_decide_reads_the_latest_per_context_of_the_combined_status() -> None:
    """The combined status already carries one per context; the waiver beside it does not get in the way."""
    assert gate.decide(combined(("eclume/gate-dispensa", "failure"), ("eclume/gate", "success")))[0] is True


def test_decide_from_the_command_line(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """Exit code 0 only with a green gate; invalid input counts as a missing gate."""
    code, out = run(["decide"], json.dumps(combined(("eclume/gate", "success"))), monkeypatch, capsys)
    assert code == 0
    assert "success" in out
    code, out = run(["decide"], "not json", monkeypatch, capsys)
    assert code == 1
    assert "missing" in out


# --- describe ------------------------------------------------------------------------------------


def every(code: int = 0) -> dict[str, int]:
    """Every pillar with the same exit code."""
    return dict.fromkeys(gate.PILLARS, code)


def test_describe_success_only_with_every_pillar_green() -> None:
    """`success` needs every pillar with exit 0."""
    state, text = gate.describe(every(), 125, LOG)
    assert state == "success"
    assert text == f"{len(gate.PILLARS)} pillars green · 2min05s · log {LOG}"


def test_describe_failure_names_the_failed_pillars_in_order() -> None:
    """The description names the failed pillars, in `--list` order."""
    results = every() | {"windows": 101, "python": 1}
    state, text = gate.describe(results, 40, LOG)
    assert state == "failure"
    assert text.startswith("failed: python, windows · 40s")


def test_describe_error_when_a_pillar_is_missing() -> None:
    """A pillar without a result is a gate without proof: `error`."""
    results = every()
    del results["mobile"]
    state, text = gate.describe(results, 0, LOG)
    assert state == "error"
    assert "no proof: mobile" in text


def test_describe_fits_in_140_characters() -> None:
    """GitHub refuses a description longer than 140 characters."""
    state, text = gate.describe(every(1), 3600 * 2, "~/" + "x" * 200)
    assert state == "failure"
    assert len(text) <= gate.DESCRIPTION_LIMIT
    assert text.startswith("failed: python, contracts")


def test_describe_from_the_command_line(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """State on the first line and description on the second."""
    data = "\n".join(f"{p} 0" for p in gate.PILLARS) + "\n"
    code, out = run(["describe", "--duration", "61", "--log", LOG], data, monkeypatch, capsys)
    assert code == 0
    assert out.splitlines() == ["success", f"{len(gate.PILLARS)} pillars green · 1min01s · log {LOG}"]


def test_invalid_result_is_refused() -> None:
    """An unknown pillar in the input is an error, not a green pillar."""
    with pytest.raises(ValueError, match="invalid"):
        gate.read_results(["lumea 0"])


# --- push-targets ---------------------------------------------------------------------------------


def test_push_targets_only_main_and_no_deleted_ref() -> None:
    """Only updates of `refs/heads/main` fire the gate; deleting the ref does not."""
    lines = [
        f"refs/heads/main {SHA} refs/heads/main {'b' * 40}",
        f"refs/heads/plan/1-x {'c' * 40} refs/heads/plan/1-x {gate.NULL_SHA}",
        f"(delete) {gate.NULL_SHA} refs/heads/main {'d' * 40}",
        f"refs/heads/other {'e' * 40} refs/heads/main {SHA}",
    ]
    assert gate.push_targets(lines) == [SHA, "e" * 40]


def test_push_targets_from_the_command_line(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """One SHA per output line."""
    code, out = run(["push-targets"], f"refs/heads/main {SHA} refs/heads/main {'b' * 40}\n", monkeypatch, capsys)
    assert code == 0
    assert out.split() == [SHA]


# --- contract with CI -----------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"


def commands(job: dict[str, object]) -> str:
    """All of a workflow job's `run:`, as one string."""
    steps = job.get("steps") or []
    assert isinstance(steps, list)
    return "\n".join(str(step.get("run", "")) for step in steps)


def test_each_ci_job_calls_its_pillar() -> None:
    """Each pillar job of `ci.yml` calls `deploy/pillars.sh <job>`; the gate-only pillars stay out of CI."""
    jobs = yaml.safe_load((WORKFLOWS / "ci.yml").read_text(encoding="utf-8"))["jobs"]
    ci_pillars = set(jobs) - {"changes"}
    assert ci_pillars == set(gate.PILLARS) - set(gate.GATE_ONLY)
    for name in ci_pillars:
        assert f"bash deploy/pillars.sh {name}" in commands(jobs[name]), name
    for pillar in gate.GATE_ONLY:
        assert f"pillars.sh {pillar}" not in (WORKFLOWS / "ci.yml").read_text(encoding="utf-8")


def test_android_is_a_gate_only_pillar() -> None:
    """The verified APK (host SDK, about 15 min) runs only on the gate, after the others."""
    assert gate.PILLARS[-2] == "android"
    assert "android" in gate.GATE_ONLY


def test_gpu_e2e_is_the_last_pillar_and_gate_only() -> None:
    """The CUDA proof needs the host GPU: it comes last and stays out of CI."""
    assert gate.PILLARS[-1] == "gpu-e2e"
    assert "gpu-e2e" in gate.GATE_ONLY


@pytest.mark.parametrize(
    "path",
    [
        "worker-gpu/src/x.py",
        "engines/whisperx/a.py",
        "contracts/transcript.schema.json",
        "deploy/docker-compose.gpu-test.yml",
    ],
)
def test_gpu_e2e_required_by_gpu_engines_and_schema(path: str) -> None:
    """A change in worker-gpu, the engines, the transcript schema or the compose turns `gpu-e2e` on."""
    assert "gpu-e2e" in gate.required_pillars([path])


def test_gpu_e2e_skipped_for_a_web_only_change() -> None:
    """A change only in `web/` does not pay for the GPU."""
    assert "gpu-e2e" not in gate.required_pillars(["web/src/App.jsx"])


def test_gpu_e2e_75_is_inconclusive_no_proof_never_success_nor_failure() -> None:
    """Exit 75 of `gpu-e2e` (GPU busy) becomes an "inconclusive" `error`, distinct from failure."""
    state, text = gate.describe(every() | {"gpu-e2e": 75}, 10, LOG)
    assert state == "error"
    assert "no proof: gpu-e2e" in text
    assert "inconclusive" in text
    assert "failed" not in text


def test_gpu_e2e_real_failure_is_failure() -> None:
    """Any other non-zero exit of `gpu-e2e` is a failure, not inconclusive."""
    state, text = gate.describe(every() | {"gpu-e2e": 1}, 10, LOG)
    assert state == "failure"
    assert text.startswith("failed: gpu-e2e")


def test_75_in_another_pillar_is_failure() -> None:
    """Only `gpu-e2e` has the inconclusive code."""
    state, _ = gate.describe(every() | {"python": 75}, 10, LOG)
    assert state == "failure"


def test_pillars_sh_lists_the_same_pillars_as_the_gate() -> None:
    """`pillars.sh --list` and `gate.PILLARS` move together."""
    text = (ROOT / "deploy" / "pillars.sh").read_text(encoding="utf-8")
    assert f"PILLARS=({' '.join(gate.PILLARS)})" in text


@pytest.mark.parametrize("name", ["desktop-release.yml"])
def test_release_workflows_check_the_gate_before_publishing(name: str) -> None:
    """When they publish, the Actions releases check the commit's `eclume/gate`, with no waiver."""
    jobs = yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))["jobs"]
    checks = [
        (job_name, step)
        for job_name, job in jobs.items()
        for step in job.get("steps") or []
        if "deploy/gate.py decide" in str(step.get("run", ""))
    ]
    assert len(checks) == 1, name
    job_name, step = checks[0]
    assert "publish == 'true'" in step["if"]
    assert "--skip-gate" not in step["run"]
    assert jobs[job_name]["permissions"]["statuses"] == "read"


# --- pillars by diff ------------------------------------------------------------------------------


def _ci_filters() -> dict[str, set[str]]:
    """The path filters of the `changes` job of `ci.yml`, with the YAML anchors resolved."""
    jobs = yaml.safe_load((WORKFLOWS / "ci.yml").read_text(encoding="utf-8"))["jobs"]
    steps = jobs["changes"]["steps"]
    filters = yaml.safe_load(next(p["with"]["filters"] for p in steps if p.get("id") == "filter"))

    def flatten(items: list[object]) -> set[str]:
        out: set[str] = set()
        for item in items:
            out |= flatten(item) if isinstance(item, list) else {str(item)}
        return out

    return {name: flatten(items) for name, items in filters.items() if name in gate.PILLARS}


def test_gate_path_map_is_the_ci_filter_map() -> None:
    """The seven CI pillars have, in the gate, exactly the paths of the `ci.yml` filters."""
    from_ci = _ci_filters()
    assert set(from_ci) == set(gate.PILLARS) - set(gate.GATE_ONLY)
    for pillar, globs in from_ci.items():
        assert set(gate.FILTERS[pillar]) == globs, pillar
    assert set(gate.FILTERS) == set(gate.PILLARS)


def test_pytest_testpaths_are_in_the_python_filter() -> None:
    """Each `testpaths` folder sits under a `<prefix>/**` glob of the CI `python` filter."""
    testpaths = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["tool"]["pytest"]["ini_options"][
        "testpaths"
    ]
    prefixes = {g.removesuffix("/**") for g in _ci_filters()["python"] if g.endswith("/**")}
    uncovered = [folder for folder in testpaths if not any(folder == p or folder.startswith(f"{p}/") for p in prefixes)]
    assert not uncovered, f"testpaths folders outside the CI python filter: {uncovered}"


@pytest.mark.parametrize(
    ("files", "expected"),
    [
        (["web/src/App.jsx"], ["web", "web-browser"]),
        (["docs/index.md"], ["docs"]),
        (["README.md"], ["docs"]),
        (["server/eclume_server/app.py"], ["python"]),
        (["contracts/openapi.yaml"], ["python", "contracts", "web", "web-browser"]),
        (["desktop/src-tauri/src/main.rs"], ["desktop", "windows"]),
        (["mobile/src-tauri/src/lib.rs"], ["mobile", "android"]),
        (["desktop/crates/core/src/lib.rs"], ["desktop", "mobile", "windows", "android"]),
        (["web/src/lib/vocabulario.js"], ["web", "web-browser", "desktop", "mobile", "windows", "android"]),
        (["desktop/deny.toml"], ["desktop", "audit", "windows"]),
        ([".design/tokens.json", ".claude/settings.json"], []),
        ([], []),
    ],
)
def test_required_pillars_by_the_path_map(files: list[str], expected: list[str]) -> None:
    """Each file turns on the pillars that consume it, in `PILLARS` order; the rest turns on none."""
    assert gate.required_pillars(files) == [p for p in gate.PILLARS if p in expected]


@pytest.mark.parametrize(
    "path",
    [
        "deploy/staging.sh",
        "deploy/gate-host.sh",
        ".github/workflows/ci.yml",
        "uv.lock",
        "pyproject.toml",
        "web/package-lock.json",
        "desktop/Cargo.lock",
        "desktop/rust-toolchain.toml",
        ".nvmrc",
    ],
)
def test_deploy_lock_and_toolchain_run_everything(path: str) -> None:
    """A change in `deploy/`, a lock or the toolchain runs the eleven pillars, with any other file."""
    assert gate.required_pillars([path]) == list(gate.PILLARS)
    assert gate.required_pillars(["docs/index.md", path]) == list(gate.PILLARS)


def test_unknown_diff_runs_everything() -> None:
    """Without a diff (first run, rewritten history), every pillar."""
    assert gate.required_pillars(None) == list(gate.PILLARS)


def test_pillars_from_the_command_line(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """`--stdin` reads the paths; `--all` ignores the diff; a `--since` git cannot resolve runs everything."""
    code, out = run(["pillars", "--stdin"], "docs/a.md\nweb/x.js\n", monkeypatch, capsys)
    assert (code, out.split()) == (0, ["web", "web-browser", "docs"])
    _, out = run(["pillars", "--stdin", "--all"], "docs/a.md\n", monkeypatch, capsys)
    assert out.split() == list(gate.PILLARS)
    argv = ["pillars", "--since", "f" * 40, "--sha", "e" * 40, "--repo", str(ROOT)]
    _, out = run(argv, "", monkeypatch, capsys)
    assert out.split() == list(gate.PILLARS)


def test_changed_files_reads_the_git_diff(tmp_path: Path) -> None:
    """The `since..until` diff of a real repository becomes the path list."""
    env = {
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
        "PATH": os.environ["PATH"],
    }

    def git(*args: str) -> str:
        command = ["git", "-C", str(tmp_path), *args]
        return subprocess.run(command, check=True, capture_output=True, text=True, env=env).stdout.strip()  # noqa: S603

    git("init", "-q")
    (tmp_path / "a.txt").write_text("1")
    git("add", ".")
    git("commit", "-qm", "one")
    base = git("rev-parse", "HEAD")
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "x.js").write_text("2")
    git("add", ".")
    git("commit", "-qm", "two")
    assert gate.changed_files(base, "HEAD", str(tmp_path)) == ["web/x.js"]
    assert gate.changed_files("0" * 40, "HEAD", str(tmp_path)) is None


# --- description with skipped pillars ------------------------------------------------------------


def test_describe_with_skipped_counts_only_the_required() -> None:
    """Skipped is not missing: the green required pillars give `success` and the description says the rest."""
    skipped = tuple(p for p in gate.PILLARS if p not in ("web", "docs"))
    state, text = gate.describe({"web": 0, "docs": 0}, 90, LOG, skipped, "b" * 40)
    assert state == "success"
    assert text.startswith("2 green (web, docs); 9 skipped since bbbbbbb · 1min30s")
    assert len(text) <= gate.DESCRIPTION_LIMIT


def test_describe_with_skipped_still_fails_and_needs_proof() -> None:
    """A required pillar that failed or did not run is not covered by skipping the others."""
    assert gate.describe({"web": 1}, 1, LOG, ("python",), "b" * 40)[0] == "failure"
    state, text = gate.describe({"web": 0}, 1, LOG, ("python",), "b" * 40)
    assert state == "error"
    assert "no proof: contracts" in text


def test_describe_with_no_required_pillar_is_success() -> None:
    """A diff that touches no pillar (only `.design/`) is `success` and says nothing was required."""
    state, text = gate.describe({}, 0, LOG, gate.PILLARS, "b" * 40)
    assert state == "success"
    assert text.startswith("no pillar required; 11 skipped")


def test_describe_with_skipped_from_the_command_line(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--skipped` and `--since` reach the description."""
    skipped = ",".join(p for p in gate.PILLARS if p != "docs")
    argv = ["describe", "--log", LOG, "--skipped", skipped, "--since", "c" * 40]
    _, out = run(argv, "docs 0\n", monkeypatch, capsys)
    assert out.splitlines()[0] == "success"
    assert "10 skipped since ccccccc" in out


def test_gate_sh_exposes_all_and_the_host_decides_the_diff() -> None:
    """`--all` goes from `gate.sh` to the host; the host decides the pillars by diff when it publishes."""
    sh = (ROOT / "deploy" / "gate.sh").read_text(encoding="utf-8")
    host = (ROOT / "deploy" / "gate-host.sh").read_text(encoding="utf-8")
    assert "args+=(--all)" in sh
    assert "--all) FORCE_ALL=1" in host
    assert "gate.py pillars --stdin" in host
    assert "--skipped" in host


# --- superseded SHA, CPU weight and pruning---------------------------------------------------------


def _host() -> str:
    return (ROOT / "deploy" / "gate-host.sh").read_text(encoding="utf-8")


def test_only_pre_push_abandons_a_superseded_sha() -> None:
    """The hook passes `--supersedable` to the gate; a manual request does not, and the host abandons only with the flag."""
    hook = (ROOT / ".githooks" / "pre-push").read_text(encoding="utf-8")
    sh = (ROOT / "deploy" / "gate.sh").read_text(encoding="utf-8")
    host = _host()
    assert 'gate.sh" --background --supersedable' in hook
    assert "args+=(--supersedable)" in sh
    assert "--supersedable) SUPERSEDABLE=1" in host
    # Only a tip ahead of the SHA supersedes it; without reading the tip, or with the push in flight, the gate runs.
    assert '"$SUPERSEDABLE" -eq 1' in host
    assert "== ahead" in host
    assert 'publish error "superseded by' in host
    # The check comes after the lock, so it applies to the SHA that waited its turn.
    assert host.index("flock -n 9") < host.index('"$SUPERSEDABLE" -eq 1')


def test_gates_and_pillars_run_in_parallel_without_sharing_state() -> None:
    """Concurrent gates hold distinct slots and projects; pillars run from their own tree copy."""
    host = _host()
    assert 'SLOTS="${ECLUME_GATE_SLOTS:-2}"' in host
    assert 'PROJECT="eclume-gate-$SLOT"' in host
    assert "cpu-shares-$SLOT.yml" in host
    assert "$((55633 + SLOT))" in host
    assert 'cp -a "$SRC" "$tree"' in host
    assert '-v "$tree:/src"' in host
    assert "jobs -rp | wc -l) >= JOBS" in host
    # gpu-e2e never runs beside another gate's gpu-e2e: one GPU, one compose project.
    assert '8>"$GATE_DIR/.trava-gpu"' in host
    assert 'rm -rf "$SRC" "$SRC".p-*' in host


def test_playwright_workers_follow_the_gate_cpu_share() -> None:
    """The gate passes its CPU share and both Playwright suites use it as --workers."""
    assert '-e ECLUME_E2E_WORKERS="$CPUS"' in _host()
    pillars = (ROOT / "deploy" / "pillars.sh").read_text(encoding="utf-8")
    assert 'E2E_WORKERS=(--workers "$ECLUME_E2E_WORKERS")' in pillars
    assert 'run npm --prefix web run test:e2e -- "${E2E_WORKERS[@]}"' in pillars
    assert 'run npm --prefix desktop/ui-tests test -- "${E2E_WORKERS[@]}"' in pillars


def test_every_gate_container_carries_cpu_shares() -> None:
    """The pillars and the test services run with `--cpu-shares 256`, below production."""
    host = _host()
    assert "CPU_SHARES=256" in host
    assert '--cpu-shares "$CPU_SHARES"' in host
    assert "cpu_shares: %s" in host
    assert host.count("docker run") == 1  # the gate's only `docker run` is the one above
    assert '-f "$CPU_YML"' in host


def test_gate_prunes_logs_old_images_and_abandoned_trees() -> None:
    """Pruning deletes logs older than 30 days and build images of another Rust, never the current image."""
    host = _host()
    assert "-name '*.log' -mtime +30 -delete" in host
    assert 'grep -vF ":$RUST"' in host
    assert "eclume-(gate|desktop-build|desktop-build-windows|mobile-build)" in host
    assert "-name 'src-*' -mtime +1" in host
