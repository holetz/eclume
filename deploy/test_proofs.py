# ruff: noqa: INP001, S101, S106, S603, D103, PLR2004  # loose tests of the deploy scripts; deploy/ is not a Python package
"""The proofs do not write to production: `smoke_prod.py` refuses its URL without `--read-only`."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

SMOKE = Path(__file__).with_name("smoke_prod.py")
_spec = importlib.util.spec_from_file_location("smoke_prod", SMOKE)
assert _spec is not None
assert _spec.loader is not None
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)


def run(*args: str, **env: str) -> subprocess.CompletedProcess[str]:
    environment = {k: v for k, v in os.environ.items() if k != "ECLUME_PUBLIC_URL"} | env
    return subprocess.run(
        [sys.executable, str(SMOKE), *args],
        env=environment,
        input="",
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )


def test_default_target_is_staging() -> None:
    assert smoke.STAGING == "https://127.0.0.1:18444"
    assert not smoke.is_production(smoke.STAGING)


@pytest.mark.parametrize(
    ("url", "public", "expected"),
    [
        ("https://192.168.15.199:8443", None, True),
        ("https://192.168.15.199:8443/", None, True),
        ("https://eclume.lan:8443", "https://eclume.lan:8443", True),
        ("https://127.0.0.1:18444", "https://eclume.lan:8443", False),
        ("https://192.168.15.199:18444", None, False),
    ],
)
def test_is_production(monkeypatch: pytest.MonkeyPatch, url: str, public: str | None, expected: bool) -> None:  # noqa: FBT001
    if public:
        monkeypatch.setenv("ECLUME_PUBLIC_URL", public)
    else:
        monkeypatch.delenv("ECLUME_PUBLIC_URL", raising=False)
    assert smoke.is_production(url) is expected


def test_refuses_to_write_to_production_before_any_request() -> None:
    r = run("--url", "https://192.168.15.199:8443")

    assert r.returncode == 2
    assert "--read-only" in r.stderr


def test_refuses_the_public_url_of_the_env() -> None:
    r = run("--url", "https://127.0.0.1:1", ECLUME_PUBLIC_URL="https://127.0.0.1:1")

    assert r.returncode == 2


@pytest.mark.parametrize("flag", ["--read-only", "--somente-leitura"])
def test_read_only_accepts_production(flag: str) -> None:
    # The closed port drops the first request: it got past the refusal, without exit 2. The pt-BR
    # spelling is the deprecated alias the host's installed staging.sh still passes.
    r = run(
        "--url",
        "https://127.0.0.1:1",
        flag,
        ECLUME_PUBLIC_URL="https://127.0.0.1:1",
        ECLUME_SMOKE_PASSWORD="x",
    )

    assert r.returncode not in (0, 2)
