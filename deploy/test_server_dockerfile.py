# ruff: noqa: INP001, S101  # loose test of the deploy scripts; deploy/ is not a Python package
"""The server image carries the memory and traffic settings of spec holetz/eclume#150."""

from __future__ import annotations

from pathlib import Path

DOCKERFILE = Path(__file__).parent / "server.Dockerfile"


def test_server_image_pins_glibc_arenas_and_silences_the_cli_traffic() -> None:
    """`MALLOC_ARENA_MAX` and the `claude` CLI's nonessential traffic stay in the image ENV."""
    text = DOCKERFILE.read_text(encoding="utf-8")
    assert "MALLOC_ARENA_MAX=2" in text
    assert "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1" in text
