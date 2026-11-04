"""Real proof of the `claude-cli` provider: the host's `claude -p` summarizes the fixture and follows the chat protocol.

Outside CI: skips without `ECLUME_TEST_CLAUDE=1`. Runs on the host, where the CLI is logged in:

    remote-run . 'ECLUME_TEST_CLAUDE=1 PATH=$HOME/.local/bin:$PATH uv run pytest server/tests/test_agents_real.py -m slow -s'
"""

from __future__ import annotations

import asyncio
import os
import time

import pytest

from eclume_server.agents import ProviderConfig
from eclume_server.agents.chat import ChatContext, ChatResult, run_chat
from eclume_server.agents.claude_cli import ClaudeCliProvider
from eclume_server.agents.prompting import hms, render_transcript, summarize
from eclume_server_testing.fakes import contract_transcript

pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(os.environ.get("ECLUME_TEST_CLAUDE") != "1", reason="set ECLUME_TEST_CLAUDE=1 on the host"),
]

ATA = (
    "Escreva a ata da reunião em Markdown, com as seções Contexto, Participantes, Decisões e "
    "Encaminhamentos. Cada encaminhamento é uma caixa de seleção com responsável e prazo, quando "
    "ditos. Não invente o que não foi dito."
)


def test_claude_cli_summarizes_the_fixture_transcript():
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
    completion = asyncio.run(summarize(provider, transcript, ATA, locale="pt-BR"))
    elapsed = time.monotonic() - started
    print(f"\nmodel: {completion.model} · {elapsed:.1f} s\n\n{completion.text}\n")  # noqa: T201 — real test record
    assert completion.model.startswith("claude-")
    assert "Encaminhamentos" in completion.text
    assert len(completion.text) > 200


class FixtureTools:
    """The chat tools over the fixture transcript, in memory."""

    def __init__(self) -> None:
        """The fixture's `[HH:MM:SS] Speaker: text` lines."""
        source = contract_transcript()
        labels = {s["id"]: s["label"] for s in source["speakers"]}
        self.lines = [
            (s["start_ms"], s["end_ms"], f"[{hms(s['start_ms'])}] {labels[s['speaker_id']]}: {s['text']}")
            for s in source["segments"]
        ]

    async def read(self, from_ms: int, to_ms: int) -> list[tuple[int, str]]:
        """The lines that overlap the range."""
        return [(start, line) for start, end, line in self.lines if end >= from_ms and start <= to_ms]

    async def search(self, query: str, limit: int) -> list[str]:
        """The lines containing any of the terms."""
        terms = [term.lower() for term in query.split() if len(term) > 2]
        return [line for _, _, line in self.lines if any(term in line.lower() for term in terms)][:limit]


SUMMARY = (
    "# Alinhamento do programa de lideranças\n\n## Decisões\n\n- Encontros de quatro horas, com tarefa "
    "prática entre um e outro.\n- Assessment antes do primeiro encontro.\n- Três turmas de 12 gestores.\n\n"
    "## Encaminhamentos\n\n- [ ] Enviar a lista da primeira turma até sexta."
)


def _chat(request: str) -> tuple[ChatResult, float]:
    source = contract_transcript()
    header = f"Título: {source['title']}\nData: {source['recorded_at'][:10]}\nDuração: {hms(source['duration_ms'])}"
    model = os.environ.get("ECLUME_TEST_CLAUDE_MODEL", "sonnet")
    provider = ClaudeCliProvider(ProviderConfig(kind="claude-cli", model=model), claude_bin="claude")
    started = time.monotonic()
    result = asyncio.run(run_chat(provider, ChatContext(header, SUMMARY, [], request, locale="pt-BR"), FixtureTools()))
    elapsed = time.monotonic() - started
    print(f"\n{elapsed:.1f} s · reads: {result.reads}\n{result.message}\n\n{result.summary_md}\n")  # noqa: T201
    return result, elapsed


def test_chat_reads_the_transcript_when_the_request_depends_on_it():
    result, _ = _chat("Quem definiu quantas turmas serão? Acrescente o nome dessa pessoa na decisão das turmas.")
    assert result.reads, "the request depends on what was said: the agent must consult the transcript"
    assert result.message
    assert result.summary_md is not None
    assert "Encaminhamentos" in result.summary_md


def test_chat_about_form_does_not_read_the_transcript():
    result, _ = _chat("Encurte o resumo para duas frases, sem títulos.")
    assert result.reads == []
    assert result.summary_md is not None
    assert len(result.summary_md) < len(SUMMARY)
