"""Prova real do provider `claude-cli`: o `claude -p` do host resume a transcrição de fixture.

Fora da CI: pula sem `ECLUME_TEST_CLAUDE=1`. Roda no host, onde a CLI está logada:

    remote-run . 'ECLUME_TEST_CLAUDE=1 PATH=$HOME/.local/bin:$PATH uv run pytest server/tests/test_agents_real.py -m slow -s'
"""

from __future__ import annotations

import asyncio
import os
import time

import pytest

from eclume_server.agents import ProviderConfig
from eclume_server.agents.claude_cli import ClaudeCliProvider
from eclume_server.agents.prompting import render_transcript, summarize
from eclume_server_testing.fakes import contract_transcript

pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(os.environ.get("ECLUME_TEST_CLAUDE") != "1", reason="defina ECLUME_TEST_CLAUDE=1 no host"),
]

ATA = (
    "Escreva a ata da reunião em Markdown, com as seções Contexto, Participantes, Decisões e "
    "Encaminhamentos. Cada encaminhamento é uma caixa de seleção com responsável e prazo, quando "
    "ditos. Não invente o que não foi dito."
)


def test_claude_cli_resume_a_transcricao_de_fixture():
    source = contract_transcript()
    transcript = render_transcript(
        title=source["title"],
        recorded_at=source["recorded_at"][:10],
        speakers={s["id"]: s["label"] for s in source["speakers"]},
        segments=[(s["speaker_id"], s["start_ms"], s["text"]) for s in source["segments"]],
    )
    model = os.environ.get("ECLUME_TEST_CLAUDE_MODEL", "sonnet")
    provider = ClaudeCliProvider(ProviderConfig(kind="claude-cli", model=model), claude_bin="claude")
    started = time.monotonic()
    completion = asyncio.run(summarize(provider, transcript, ATA))
    elapsed = time.monotonic() - started
    print(f"\nmodelo: {completion.model} · {elapsed:.1f} s\n\n{completion.text}\n")  # noqa: T201 — registro do teste real
    assert completion.model.startswith("claude-")
    assert "Encaminhamentos" in completion.text
    assert len(completion.text) > 200
