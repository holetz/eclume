# ruff: noqa: INP001, S101  # teste solto dos scripts de deploy; deploy/ não é pacote Python
"""A imagem do server leva os ajustes de memória e de tráfego da spec holetz/eclume#150."""

from __future__ import annotations

from pathlib import Path

DOCKERFILE = Path(__file__).parent / "server.Dockerfile"


def test_imagem_do_server_fixa_arenas_do_glibc_e_silencia_o_trafego_da_cli() -> None:
    """`MALLOC_ARENA_MAX` e o tráfego não essencial da CLI `claude` ficam no ENV da imagem."""
    texto = DOCKERFILE.read_text(encoding="utf-8")
    assert "MALLOC_ARENA_MAX=2" in texto
    assert "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1" in texto
