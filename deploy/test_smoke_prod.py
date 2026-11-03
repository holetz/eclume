# ruff: noqa: INP001, S101, D103, PLR2004  # loose tests of the deploy scripts; deploy/ is not a Python package
"""The smoke picks the summary provider without registering any (holetz/eclume#129) and guards production."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

_spec = importlib.util.spec_from_file_location("smoke_prod", Path(__file__).with_name("smoke_prod.py"))
assert _spec is not None
assert _spec.loader is not None
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)


def provider(pid: str, kind: str = "ollama", *, enabled: bool = True, used_for: tuple[str, ...] = ()) -> dict[str, Any]:
    return {"id": pid, "name": pid, "kind": kind, "model": "m", "enabled": enabled, "used_for": list(used_for)}


def test_prefers_the_one_declaring_summaries_of_any_kind() -> None:
    items = [
        provider("free"),
        provider("chat", used_for=("chat",)),
        provider("res", "openai-compatible", used_for=("summaries",)),
    ]
    assert smoke.choose_provider(items)["id"] == "res"


def test_with_nobody_declaring_uses_the_enabled_one_without_purpose() -> None:
    items = [provider("off", enabled=False), provider("chat", used_for=("chat",)), provider("free", "anthropic")]
    assert smoke.choose_provider(items)["id"] == "free"


def test_disabled_summaries_one_does_not_count() -> None:
    items = [provider("res", enabled=False, used_for=("summaries",)), provider("free")]
    assert smoke.choose_provider(items)["id"] == "free"


def test_requested_provider_beats_the_purpose() -> None:
    items = [provider("res", used_for=("summaries",)), provider("other", "claude-cli", used_for=("chat",))]
    assert smoke.choose_provider(items, "other")["id"] == "other"


@pytest.mark.parametrize(
    ("items", "wanted", "message"),
    [
        ([], None, "register one in the panel"),
        ([provider("chat", used_for=("chat",))], None, "register one in the panel"),
        ([provider("res", used_for=("summaries",))], "x", "does not exist"),
        ([provider("off", enabled=False)], "off", "disabled"),
    ],
)
def test_none_fits_says_what_to_do(items: list[dict[str, Any]], wanted: str | None, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        smoke.choose_provider(items, wanted)


@pytest.mark.parametrize("flags", [[], ["--email", "a@b.c"]])
def test_production_without_read_only_refuses_before_any_request(
    monkeypatch: pytest.MonkeyPatch, flags: list[str]
) -> None:
    monkeypatch.setattr("sys.argv", ["smoke_prod.py", "--url", smoke.PRODUCTION, *flags])
    assert smoke.main() == 2


@pytest.mark.parametrize("flag", ["--read-only", "--somente-leitura"])
def test_read_only_and_its_deprecated_spelling_pass_the_production_guard(
    monkeypatch: pytest.MonkeyPatch, flag: str
) -> None:
    """Past the guard, the missing account is the next refusal (exit 1), not the production one (2)."""
    monkeypatch.delenv("ECLUME_ADMIN_EMAIL", raising=False)
    monkeypatch.setattr("sys.argv", ["smoke_prod.py", "--url", smoke.PRODUCTION, flag])
    with pytest.raises(SystemExit) as exit_info:
        smoke.main()
    assert exit_info.value.code == 1


def test_help_shows_only_the_english_flag(capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("sys.argv", ["smoke_prod.py", "--help"])
    with pytest.raises(SystemExit):
        smoke.main()
    out = capsys.readouterr().out
    assert "--read-only" in out
    assert "--somente-leitura" not in out
