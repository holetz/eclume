# ruff: noqa: INP001, S101  # loose test of the deploy scripts; deploy/ is not a Python package
"""CI jobs get ffmpeg from the shared cached action, never from an inline apt-get install."""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github/workflows/ci.yml"
ACTION = "./.github/actions/ffmpeg"


def steps(job: str) -> list[dict[str, object]]:
    """The steps of one `ci.yml` job."""
    jobs = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))["jobs"]
    return jobs[job]["steps"]


def test_no_job_installs_ffmpeg_inline() -> None:
    """No line of `ci.yml` runs `apt-get install` for ffmpeg."""
    for line in WORKFLOW.read_text(encoding="utf-8").splitlines():
        assert not ("apt-get install" in line and "ffmpeg" in line), line


def test_jobs_that_need_ffmpeg_use_the_shared_action() -> None:
    """`python` and `web-browser` both call the shared action."""
    for job in ("python", "web-browser"):
        assert any(step.get("uses") == ACTION for step in steps(job)), job


def test_action_caches_the_packages_and_bounds_each_step() -> None:
    """The action restores a cache and every script step has its own timeout."""
    action = yaml.safe_load((ROOT / ".github/actions/ffmpeg/action.yml").read_text(encoding="utf-8"))
    composite = action["runs"]["steps"]
    assert any(str(step.get("uses", "")).startswith("actions/cache@") for step in composite)
    scripts = [step for step in composite if "run" in step]
    # Composite actions reject `timeout-minutes`, so each script bounds itself with `timeout`.
    assert not any("timeout-minutes" in step for step in composite)
    assert all(str(step["run"]).lstrip().startswith("timeout ") for step in scripts)
