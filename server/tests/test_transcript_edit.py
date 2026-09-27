"""Edição da transcrição pelo dono: locutor (nome e pessoa), mesclagem e segmento."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text

from eclume_server_testing.fakes import transcribed
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


def _sql(services: Services, sql: str, **params: Any) -> list[tuple[Any, ...]]:  # noqa: ANN401
    async def go(conn: Any) -> list[tuple[Any, ...]]:  # noqa: ANN401
        result = await conn.execute(text(sql), params)
        return [tuple(row) for row in result] if result.returns_rows else []

    return run(services.sql(go))


@pytest.fixture
def owned(as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services) -> dict[str, Any]:
    api = as_user(make_user())
    recording = transcribed(api, services.settings)
    tid = recording["transcript_id"]
    return {"api": api, "recording": recording, "tid": tid, "base": f"/api/v1/transcripts/{tid}"}


def test_renomear_e_ligar_a_pessoa(
    owned: dict[str, Any],
    make_user: Callable[..., Account],
    as_user: Callable[[Account], Api],
):
    api, base = owned["api"], owned["base"]
    before = api.get(base).json()

    renamed = api.patch(f"{base}/speakers/S3", json={"label": "Joana Prado"})
    assert renamed.status_code == 200
    assert renamed.json() == {"id": "S3", "label": "Joana Prado", "person": None, "suggestions": [], "talk_ms": 29750}
    after = api.get(base).json()
    assert after["revision"] == before["revision"] + 1
    assert after["updated_at"] > before["updated_at"]

    person = api.post("/api/v1/people", json={"name": "Rafael Lima"}).json()
    linked = api.patch(f"{base}/speakers/S2", json={"person_id": person["id"]}).json()
    assert (linked["label"], linked["person"]) == ("Rafael Lima", {"id": person["id"], "name": "Rafael Lima"})
    assert api.get(base).json()["revision"] == before["revision"] + 2

    unlinked = api.patch(f"{base}/speakers/S2", json={"person_id": None}).json()
    assert (unlinked["label"], unlinked["person"]) == ("Rafael Lima", None)
    both = api.patch(f"{base}/speakers/S2", json={"person_id": person["id"], "label": "Rafa"}).json()
    assert (both["label"], both["person"]["name"]) == ("Rafa", "Rafael Lima")

    assert api.patch(f"{base}/speakers/S2", json={}).status_code == 422
    assert api.patch(f"{base}/speakers/S2", json={"label": None}).status_code == 422
    assert api.patch(f"{base}/speakers/S2", json={"label": ""}).status_code == 422
    assert api.patch(f"{base}/speakers/S9", json={"label": "x"}).status_code == 404
    assert api.patch(f"{base}/speakers/X1", json={"label": "x"}).status_code == 422
    missing = api.patch(f"{base}/speakers/S2", json={"person_id": "01928f3a-1c00-7a00-8000-000000000999"})
    assert (missing.status_code, missing.json()["errors"][0]["field"]) == (422, "person_id")
    foreign = as_user(make_user()).post("/api/v1/people", json={"name": "De fora"}).json()
    assert api.patch(f"{base}/speakers/S2", json={"person_id": foreign["id"]}).status_code == 422


def test_so_o_dono_edita(
    owned: dict[str, Any],
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
):
    api, base = owned["api"], owned["base"]
    outsider = as_user(make_user())
    assert outsider.get(base).status_code == 404
    edits = (
        ("PATCH", f"{base}/speakers/S1", {"label": "x"}),
        ("POST", f"{base}/speakers/merge", {"source_speaker_ids": ["S3"], "target_speaker_id": "S2"}),
        ("PATCH", f"{base}/segments/seg-0001", {"text": "x"}),
    )
    for method, url, body in edits:
        assert outsider.request(method, url, json=body).status_code == 404, url
    reader = api.pat("transcripts:read")
    denied = reader.patch(f"{base}/speakers/S1", json={"label": "x"})
    assert (denied.status_code, denied.json()["required_scopes"]) == (403, ["transcripts:write"])
    assert api.pat("transcripts:write").patch(f"{base}/speakers/S1", json={"label": "Mariana"}).status_code == 200
    assert api.get(base).json()["speakers"][0]["label"] == "Mariana"


def test_mesclar_locutores(owned: dict[str, Any], services: Services):
    api, base, tid = owned["api"], owned["base"], owned["tid"]
    for speaker in ("S2", "S3"):
        _sql(
            services,
            "INSERT INTO speaker_embeddings (transcript_id, owner_id, speaker_id, model, embedding)"
            " SELECT id, owner_id, :s, 'modelo', '[1,0,0]' FROM transcripts WHERE id = :t",
            s=speaker,
            t=tid,
        )
    before = api.get(base).json()

    invalid = (
        {"source_speaker_ids": ["S2"], "target_speaker_id": "S2"},
        {"source_speaker_ids": ["S9"], "target_speaker_id": "S2"},
        {"source_speaker_ids": ["S3"], "target_speaker_id": "S9"},
        {"source_speaker_ids": ["S3", "S3"], "target_speaker_id": "S2"},
        {"source_speaker_ids": [], "target_speaker_id": "S2"},
    )
    for body in invalid:
        assert api.post(f"{base}/speakers/merge", json=body).status_code == 422, body

    merged = api.post(f"{base}/speakers/merge", json={"source_speaker_ids": ["S3"], "target_speaker_id": "S2"})
    assert merged.status_code == 200
    body = merged.json()
    assert [(s["id"], s["talk_ms"]) for s in body["speakers"]] == [("S1", 87150), ("S2", 37050 + 29750)]
    assert {s["speaker_id"] for s in body["segments"]} == {"S1", "S2"}
    assert body["revision"] == before["revision"] + 1
    assert _sql(services, "SELECT speaker_id FROM speaker_embeddings WHERE transcript_id = :t", t=tid) == [("S2",)]


def test_corrigir_segmento(owned: dict[str, Any], services: Services):
    api, base, tid = owned["api"], owned["base"], owned["tid"]
    before = api.get(base, params={"include": "words"}).json()
    assert "words" in before["segments"][1]

    fixed = api.patch(f"{base}/segments/seg-0002", json={"text": "Texto corrigido sobre calibração."})
    assert fixed.status_code == 200
    assert fixed.json() == {
        "id": "seg-0002",
        "speaker_id": "S2",
        "start_ms": 12400,
        "end_ms": 24100,
        "text": "Texto corrigido sobre calibração.",
        "confidence": before["segments"][1]["confidence"],
    }
    after = api.get(base, params={"include": "words"}).json()
    assert "words" not in after["segments"][1]
    assert after["revision"] == before["revision"] + 1
    # O índice full-text acompanha o texto novo, sem acento.
    found = _sql(
        services,
        "SELECT segment_id FROM segments WHERE transcript_id = :t AND tsv @@ websearch_to_tsquery('eclume_pt', 'calibracao')",
        t=tid,
    )
    assert found == [("seg-0002",)]

    moved = api.patch(f"{base}/segments/seg-0002", json={"speaker_id": "S1"}).json()
    assert moved["speaker_id"] == "S1"
    talk = {s["id"]: s["talk_ms"] for s in api.get(base).json()["speakers"]}
    assert talk == {"S1": 87150 + 11700, "S2": 37050 - 11700, "S3": 29750}

    assert api.patch(f"{base}/segments/seg-9999", json={"text": "x"}).status_code == 404
    assert api.patch(f"{base}/segments/seg-0002", json={"speaker_id": "S9"}).status_code == 422
    assert api.patch(f"{base}/segments/seg-0002", json={"text": None}).status_code == 422
    assert api.patch(f"{base}/segments/seg-0002", json={}).status_code == 422
