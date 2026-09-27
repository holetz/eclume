"""Exportação da gravação: TXT e SRT da transcrição, MD do resumo atual, escopos e isolamento."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

import pytest

from eclume_server.agents.prompting import hms
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import contract_transcript, run_cpu, run_gpu

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

CLAUDE = {"name": "Claude (servidor)", "kind": "claude-cli", "model": "sonnet"}
TITLE = "Alinhamento do programa de lideranças"


@pytest.fixture
def owner(admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]) -> dict[str, Any]:
    """Um usuário com sessão e o admin da plataforma."""
    return {"api": as_user(make_user()), "admin": admin}


def _recording(owner: dict[str, Any], services: Services, *, summary: bool = True) -> str:
    """Gravação transcrita (18/09/2026 14:00:05 UTC), com o resumo gerado pelo tipo 1:1 se `summary`."""
    api: Api = owner["api"]
    if summary:
        owner["admin"].post("/api/v1/admin/agent-providers", json=CLAUDE)
    types = {item["name"]: item["id"] for item in api.get("/api/v1/agenda-types").json()["items"]}
    recording = upload_file(
        api, audio_bytes(2000), title=TITLE, recorded_at="2026-09-18T14:00:05Z", agenda_type_id=types["1:1"]
    )
    run_gpu(services.settings)
    run_cpu(services.settings)
    return recording["id"]


def _export(api: Api, recording_id: str, export_format: str) -> Any:  # noqa: ANN401 — httpx.Response
    return api.get(f"/api/v1/recordings/{recording_id}/export", params={"format": export_format})


def _segments() -> list[dict[str, Any]]:
    return [s for s in contract_transcript()["segments"] if s["text"].strip()]


def test_txt_e_srt_da_transcricao(owner: dict[str, Any], services: Services):
    api: Api = owner["api"]
    recording_id = _recording(owner, services, summary=False)
    first = _segments()[0]

    txt = _export(api, recording_id, "txt")
    assert txt.status_code == 200, txt.text
    assert txt.headers["content-type"].startswith("text/plain")
    assert txt.headers["content-disposition"] == 'attachment; filename="alinhamento-do-programa-de-liderancas.txt"'
    lines = txt.text.splitlines()
    assert lines[:4] == [
        TITLE,
        "Data: 18/09/2026 11:00",
        f"Duração: {hms(contract_transcript()['duration_ms'])}",
        "Participantes: Locutor 1, Locutor 2, Locutor 3",
    ]
    assert lines[5] == f"[{hms(first['start_ms'])}] Locutor {first['speaker_id'][1:]}: {first['text'].strip()}"
    assert len(lines) == 5 + len(_segments())

    srt = _export(api, recording_id, "srt")
    assert srt.headers["content-type"].startswith("application/x-subrip")
    blocks = srt.text.strip().split("\n\n")
    assert len(blocks) == len(_segments())
    number, times, text = blocks[0].split("\n")
    assert number == "1"
    assert re.fullmatch(r"\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}", times)
    assert times.startswith(f"{hms(first['start_ms'])},{first['start_ms'] % 1000:03d} --> ")
    assert text == f"Locutor {first['speaker_id'][1:]}: {first['text'].strip()}"

    missing = _export(api, recording_id, "md")
    assert (missing.status_code, missing.json()["code"]) == (409, "summary_missing")


def test_md_do_resumo_atual(owner: dict[str, Any], services: Services):
    api: Api = owner["api"]
    recording_id = _recording(owner, services)
    edited = api.put(
        f"/api/v1/recordings/{recording_id}/summary", json={"content_md": "## Pontos\n\n- Um", "base_version": 1}
    )
    assert edited.status_code == 200, edited.text
    md = _export(api, recording_id, "md")
    assert md.status_code == 200, md.text
    assert md.headers["content-type"].startswith("text/markdown")
    assert md.text == f"# {TITLE}\n\n18/09/2026 11:00 · 1:1\n\n## Pontos\n\n- Um\n"
    assert md.headers["content-disposition"].endswith('.md"')


def test_escopos_e_isolamento(
    owner: dict[str, Any], services: Services, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    api: Api = owner["api"]
    recording_id = _recording(owner, services)
    lumea = api.pat("transcripts:read")
    assert _export(lumea, recording_id, "txt").status_code == 200
    assert _export(lumea, recording_id, "md").json()["required_scopes"] == ["summaries:read"]
    assert _export(api.pat("summaries:read"), recording_id, "txt").json()["code"] == "insufficient_scope"
    assert _export(api.pat("transcripts:read", "summaries:read"), recording_id, "md").status_code == 200
    assert _export(api, recording_id, "pdf").status_code == 422

    stranger = as_user(make_user())
    assert _export(stranger, recording_id, "txt").status_code == 404
    pending = upload_file(api, audio_bytes(100))
    missing = _export(api, pending["id"], "txt")
    assert (missing.status_code, missing.json()["code"]) == (409, "transcript_missing")
