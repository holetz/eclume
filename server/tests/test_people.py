"""Pessoas: diretório do usuário, isolamento, escopos e o filtro `person=` do lumea."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from eclume_server_testing.fakes import contract_transcript, transcribed
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


def link(services: Services, transcript_id: str, speaker_id: str, person_id: str | None) -> None:
    """Liga um locutor a uma pessoa direto no banco (a rota de edição tem os próprios testes)."""

    async def go(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(
            text("UPDATE speakers SET person_id = :p WHERE transcript_id = :t AND speaker_id = :s"),
            {"p": person_id, "t": transcript_id, "s": speaker_id},
        )

    run(services.sql(go))


def test_cadastro_edicao_e_exclusao(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    created = api.post(
        "/api/v1/people", json={"name": "Rafael Lima", "email": "Rafael.Lima@example.com", "notes": "RH"}
    )
    assert created.status_code == 201, created.text
    person = created.json()
    assert "voice_consent" not in person
    assert (person["transcript_count"], person["last_seen_at"]) == (0, None)
    assert (person["voice_sample_count"], person["speaking_time_ms"]) == (0, 0)
    assert api.get(f"/api/v1/people/{person['id']}").json() == person

    duplicate = api.post("/api/v1/people", json={"name": "Outro", "email": "rafael.lima@example.com"})
    assert duplicate.status_code == 409
    assert api.post("/api/v1/people", json={"name": ""}).status_code == 422
    assert api.post("/api/v1/people", json={"name": "X", "email": "sem-arroba"}).status_code == 422

    patched = api.patch(f"/api/v1/people/{person['id']}", json={"name": "Rafael Lima Souza", "notes": None})
    assert patched.status_code == 200
    assert (patched.json()["name"], patched.json()["notes"]) == ("Rafael Lima Souza", None)
    assert patched.json()["updated_at"] > person["updated_at"]
    assert api.patch(f"/api/v1/people/{person['id']}", json={}).status_code == 422
    assert api.patch(f"/api/v1/people/{person['id']}", json={"name": None}).status_code == 422
    other = api.post("/api/v1/people", json={"name": "Juliana", "email": "juliana@example.com"}).json()
    taken = api.patch(f"/api/v1/people/{other['id']}", json={"email": "RAFAEL.LIMA@example.com"})
    assert (taken.status_code, taken.json()["errors"][0]["field"]) == (422, "email")

    assert api.delete(f"/api/v1/people/{person['id']}").status_code == 204
    assert api.get(f"/api/v1/people/{person['id']}").status_code == 404
    assert api.delete(f"/api/v1/people/{person['id']}").status_code == 404


def test_lista_alfabetica_sem_acento_com_prefixo(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    for name, email in (
        ("beatriz Nunes", None),
        ("Álvaro Prado", "alvaro@exemplo.com.br"),
        ("André Silva", None),
        ("Maria da Conceição", "mconceicao@exemplo.com.br"),
    ):
        assert api.post("/api/v1/people", json={"name": name, "email": email}).status_code == 201

    def names(**params: Any) -> list[str]:  # noqa: ANN401
        return [p["name"] for p in api.get("/api/v1/people", params=params).json()["items"]]

    assert names() == ["Álvaro Prado", "André Silva", "beatriz Nunes", "Maria da Conceição"]
    assert names(q="and") == ["André Silva"]
    assert names(q="ÁLV") == ["Álvaro Prado"]
    assert names(q="conceicao") == ["Maria da Conceição"]
    assert names(q="mconc") == ["Maria da Conceição"]
    assert names(q="silv") == ["André Silva"]
    assert names(q="%") == []

    first = api.get("/api/v1/people", params={"limit": 3}).json()
    assert [p["name"] for p in first["items"]] == ["Álvaro Prado", "André Silva", "beatriz Nunes"]
    rest = api.get("/api/v1/people", params={"limit": 3, "cursor": first["next_cursor"]}).json()
    assert [p["name"] for p in rest["items"]] == ["Maria da Conceição"]
    assert rest["next_cursor"] is None
    assert api.get("/api/v1/people", params={"cursor": "lixo"}).status_code == 422


def test_pessoas_nao_atravessam_contas(
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
):
    alice = as_user(make_user())
    dave = as_user(make_user())
    person = alice.post("/api/v1/people", json={"name": "Rafael", "email": "rafael@exemplo.com.br"}).json()
    assert dave.get(f"/api/v1/people/{person['id']}").status_code == 404
    assert dave.patch(f"/api/v1/people/{person['id']}", json={"name": "x"}).status_code == 404
    assert dave.delete(f"/api/v1/people/{person['id']}").status_code == 404
    assert dave.get(f"/api/v1/people/{person['id']}/transcripts").status_code == 404
    assert dave.get("/api/v1/people").json()["items"] == []
    # O mesmo e-mail em outra conta é outra pessoa.
    assert dave.post("/api/v1/people", json={"name": "Rafael", "email": "rafael@exemplo.com.br"}).status_code == 201

    # Nem por SQL um locutor liga a pessoa de outra conta: a FK é composta com `owner_id`.
    recording = transcribed(dave, services.settings)
    with pytest.raises(IntegrityError, match="speakers_person_fk"):
        link(services, recording["transcript_id"], "S1", person["id"])


def test_escopos_do_pat(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    person = api.post("/api/v1/people", json={"name": "Rafael"}).json()
    reader = api.pat("people:read")
    assert reader.get("/api/v1/people").status_code == 200
    denied = reader.post("/api/v1/people", json={"name": "Outro"})
    assert (denied.status_code, denied.json()["required_scopes"]) == (403, ["people:write"])
    both = reader.get(f"/api/v1/people/{person['id']}/transcripts")
    assert (both.status_code, both.json()["required_scopes"]) == (403, ["transcripts:read"])
    lumea = api.pat("people:read", "transcripts:read")
    assert lumea.get(f"/api/v1/people/{person['id']}/transcripts").json() == {"items": [], "next_cursor": None}
    writer = api.pat("people:write")
    assert writer.patch(f"/api/v1/people/{person['id']}", json={"notes": "via PAT"}).status_code == 200
    assert writer.get("/api/v1/people").status_code == 403


def test_transcricoes_da_pessoa(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    alice = as_user(make_user())
    person = alice.post("/api/v1/people", json={"name": "Rafael Lima"}).json()
    old = transcribed(alice, services.settings, title="Antiga", recorded_at="2026-09-01T10:00:00Z")
    new = transcribed(alice, services.settings, title="Nova", recorded_at="2026-09-18T14:00:00Z")
    unlinked = transcribed(alice, services.settings, title="Sem Rafael")
    link(services, old["transcript_id"], "S2", person["id"])
    link(services, new["transcript_id"], "S1", person["id"])

    seen = alice.get(f"/api/v1/people/{person['id']}").json()
    assert (seen["transcript_count"], seen["last_seen_at"]) == (2, "2026-09-18T14:00:00Z")
    talk = {speaker["id"]: speaker["talk_ms"] for speaker in contract_transcript()["speakers"]}
    # O tempo de fala soma os locutores ligados, em todas as transcrições.
    assert seen["speaking_time_ms"] == talk["S2"] + talk["S1"]
    assert seen["voice_sample_count"] == 0
    listed = alice.get(f"/api/v1/people/{person['id']}/transcripts").json()
    assert [t["title"] for t in listed["items"]] == ["Nova", "Antiga"]
    speaker = next(s for s in listed["items"][0]["speakers"] if s["id"] == "S1")
    assert speaker["person"] == {"id": person["id"], "name": "Rafael Lima"}
    first = alice.get(f"/api/v1/people/{person['id']}/transcripts", params={"limit": 1}).json()
    second = alice.get(
        f"/api/v1/people/{person['id']}/transcripts", params={"limit": 1, "cursor": first["next_cursor"]}
    ).json()
    assert [t["title"] for t in first["items"] + second["items"]] == ["Nova", "Antiga"]

    # O filtro `person=` que o importador do lumea usa, por PAT.
    lumea = alice.pat("transcripts:read")
    filtered = lumea.get("/api/v1/transcripts", params={"person": person["id"]}).json()
    assert {t["id"] for t in filtered["items"]} == {old["transcript_id"], new["transcript_id"]}
    assert unlinked["transcript_id"] not in {t["id"] for t in filtered["items"]}
    exported = lumea.get(f"/api/v1/transcripts/{new['transcript_id']}/export", params={"format": "md"}).text
    assert "**Rafael Lima** [" in exported


def test_renomear_ou_excluir_a_pessoa_toca_as_transcricoes(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    alice = as_user(make_user())
    person = alice.post("/api/v1/people", json={"name": "Rafael"}).json()
    recording = transcribed(alice, services.settings)
    tid = recording["transcript_id"]
    link(services, tid, "S2", person["id"])
    before = alice.get(f"/api/v1/transcripts/{tid}").json()

    # Renomear a pessoa muda o nome na transcrição: o `?since=` enxerga a mudança.
    assert alice.patch(f"/api/v1/people/{person['id']}", json={"name": "Rafael Lima"}).status_code == 200
    renamed = alice.get(f"/api/v1/transcripts/{tid}").json()
    assert renamed["updated_at"] > before["updated_at"]
    assert renamed["revision"] == before["revision"]
    assert next(s for s in renamed["speakers"] if s["id"] == "S2")["person"]["name"] == "Rafael Lima"
    since = alice.get("/api/v1/transcripts", params={"since": renamed["updated_at"]}).json()
    assert [t["id"] for t in since["items"]] == [tid]

    assert alice.delete(f"/api/v1/people/{person['id']}").status_code == 204
    unlinked = alice.get(f"/api/v1/transcripts/{tid}").json()
    speaker = next(s for s in unlinked["speakers"] if s["id"] == "S2")
    assert (speaker["person"], speaker["label"]) == (None, "Locutor 2")
    assert unlinked["updated_at"] > renamed["updated_at"]


def test_atributos_de_cadastro_e_facetas(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    created = api.post(
        "/api/v1/people",
        json={
            "name": "Rafael Lima",
            "organization": "  Metalúrgica Serra Azul ",
            "department": "RH",
            "job_title": "Gerente",
            "phone": "",
            "tags": ["cliente", " Cliente ", "diretoria", ""],
        },
    )
    assert created.status_code == 422, "tag vazia não passa"
    created = api.post(
        "/api/v1/people",
        json={
            "name": "Rafael Lima",
            "organization": "  Metalúrgica Serra Azul ",
            "department": "RH",
            "job_title": "Gerente",
            "phone": "",
            "tags": ["cliente", " Cliente ", "diretoria"],
        },
    )
    assert created.status_code == 201, created.text
    rafael = created.json()
    assert (rafael["organization"], rafael["department"], rafael["job_title"], rafael["phone"]) == (
        "Metalúrgica Serra Azul",
        "RH",
        "Gerente",
        None,
    )
    assert rafael["tags"] == ["cliente", "diretoria"]
    plain = api.post("/api/v1/people", json={"name": "Sem cadastro"}).json()
    assert (plain["organization"], plain["tags"]) == (None, [])

    patched = api.patch(f"/api/v1/people/{rafael['id']}", json={"department": None, "tags": ["cliente"]})
    assert patched.status_code == 200, patched.text
    assert (patched.json()["department"], patched.json()["tags"]) == (None, ["cliente"])
    assert api.patch(f"/api/v1/people/{rafael['id']}", json={"tags": None}).status_code == 422
    assert api.patch(f"/api/v1/people/{rafael['id']}", json={"organization": "x" * 121}).status_code == 422

    api.post("/api/v1/people", json={"name": "Juliana", "organization": "metalurgica serra azul", "tags": ["Cliente"]})
    api.post("/api/v1/people", json={"name": "Ana", "organization": "Metalúrgica Serra Azul", "department": "Pessoas"})
    api.post("/api/v1/people", json={"name": "Bruno", "organization": "Agro Sul", "tags": ["fornecedor"]})
    facets = api.get("/api/v1/people/facets")
    assert facets.status_code == 200, facets.text
    body = facets.json()
    assert body["organizations"] == [
        {"value": "Agro Sul", "count": 1},
        {"value": "Metalúrgica Serra Azul", "count": 3},
    ]
    assert body["departments"] == [{"value": "Pessoas", "count": 1}]
    assert body["tags"] == [{"value": "cliente", "count": 2}, {"value": "fornecedor", "count": 1}]

    other = as_user(make_user())
    assert other.get("/api/v1/people/facets").json() == {"organizations": [], "departments": [], "tags": []}
