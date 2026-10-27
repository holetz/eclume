"""Lightweight queue probe (`python -m eclume_server.sonda`) and the CLI's import cost."""

from __future__ import annotations

import json
import subprocess
import sys
from typing import TYPE_CHECKING

import redis

from eclume_server import sonda

if TYPE_CHECKING:
    import pytest

    from eclume_server_testing.harness import Services

HEAVY = ("anthropic", "fastapi", "sqlalchemy")


def _modules_after(code: str) -> set[str]:
    """Run `code` in a clean interpreter and return the top-level modules imported."""
    script = f"import sys, json\n{code}\nprint(json.dumps(sorted({{m.split('.')[0] for m in sys.modules}})))"
    output = subprocess.run([sys.executable, "-c", script], check=True, capture_output=True, text=True).stdout  # noqa: S603
    return set(json.loads(output))


def test_probe_does_not_import_the_api_weight():
    modules = _modules_after("import eclume_server.sonda, redis.asyncio")
    assert {m for m in HEAVY if m in modules} == set()


def test_cli_imports_only_the_branch_it_runs():
    modules = _modules_after("from eclume_server import cli; cli.build_parser()")
    assert {m for m in (*HEAVY, "boto3", "argon2") if m in modules} == set()


def test_worker_imports_neither_provider_nor_docx_nor_fastapi():
    modules = _modules_after("import eclume_server.worker")
    assert {m for m in ("anthropic", "docx", "fastapi", "zeroconf") if m in modules} == set()


def test_probe_without_arguments_or_with_wrong_verb_exits_2(capsys: pytest.CaptureFixture[str]):
    assert sonda.main([]) == 2
    assert sonda.main(["fila"]) == 2
    assert sonda.main(["outra", "default"]) == 2
    assert "uso:" in capsys.readouterr().err


def test_probe_checks_both_queues_in_one_call(monkeypatch: pytest.MonkeyPatch, services: Services):
    monkeypatch.setenv("ECLUME_REDIS_URL", services.settings.redis_url)
    client = redis.Redis.from_url(services.settings.redis_url)
    keys = ("eclume:default:health-check", "eclume:agents:health-check")
    client.delete(*keys)
    try:
        assert sonda.main(["fila", "default", "agents"]) == 1
        client.set(keys[0], "j_complete=1", ex=16)
        assert sonda.main(["fila", "default"]) == 0
        assert sonda.main(["fila", "default", "agents"]) == 1
        client.set(keys[1], "j_complete=1", ex=16)
        assert sonda.main(["fila", "default", "agents"]) == 0
    finally:
        client.delete(*keys)
