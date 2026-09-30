"""Gravações: leitura, edição, exclusão, áudio, progresso, retranscrição e compartilhamento."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import uuid4

import redis
from sqlalchemy import text

from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import run_cpu, transcribed
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


def test_listar_obter_e_filtrar(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    first = upload_file(api, audio_bytes(100), tags=["cliente-a"])
    second = upload_file(api, audio_bytes(100), tags=["cliente-b"])
    listed = api.get("/api/v1/recordings").json()
    assert [r["id"] for r in listed["items"]] == [second["id"], first["id"]]
    assert listed["next_cursor"] is None
    assert [r["id"] for r in api.get("/api/v1/recordings", params={"tag": "cliente-a"}).json()["items"]] == [
        first["id"]
    ]
    assert api.get("/api/v1/recordings", params={"status": "transcribed"}).json()["items"] == []
    assert len(api.get("/api/v1/recordings", params={"status": "queued"}).json()["items"]) == 2
    paged = api.get("/api/v1/recordings", params={"limit": 1}).json()
    assert [r["id"] for r in paged["items"]] == [second["id"]]
    rest = api.get("/api/v1/recordings", params={"limit": 1, "cursor": paged["next_cursor"]}).json()
    assert [r["id"] for r in rest["items"]] == [first["id"]]
    assert api.get(f"/api/v1/recordings/{first['id']}").json()["tags"] == ["cliente-a"]
    since = api.get("/api/v1/recordings", params={"since": second["updated_at"]}).json()
    assert [r["id"] for r in since["items"]] == [second["id"]]


def _ids(api: Api, **params: object) -> list[str]:
    response = api.get("/api/v1/recordings", params=params)
    assert response.status_code == 200, response.text
    return [r["id"] for r in response.json()["items"]]


def test_biblioteca_por_intervalo_e_filtros(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())

    def recording(when: str, **fields: object) -> str:
        return upload_file(api, audio_bytes(100), recorded_at=when, **fields)["id"]

    a = recording("2026-09-01T10:00:00Z", tags=["x"])
    b = recording("2026-09-03T10:00:00Z", tags=["y"], kind="note")
    c = recording("2026-09-10T10:00:00Z", tags=["x", "z"])

    # A semana: `from` inclusivo, `to` exclusivo, pelo início da gravação.
    week = {"from": "2026-09-01T10:00:00Z", "to": "2026-09-10T10:00:00Z", "sort": "recorded_asc"}
    assert _ids(api, **week) == [a, b]
    assert _ids(api, sort="recorded_desc") == [c, b, a]
    # Paginando pela data de gravação, nada se perde nem se repete.
    seen, cursor = [], None
    while True:
        page = api.get(
            "/api/v1/recordings", params={"sort": "recorded_asc", "limit": 1} | ({"cursor": cursor} if cursor else {})
        ).json()
        seen += [r["id"] for r in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == [a, b, c]

    # OU dentro do mesmo filtro, E entre filtros.
    assert set(_ids(api, tag=["x", "y"])) == {a, b, c}
    assert _ids(api, tag="x", kind="meeting", sort="recorded_asc") == [a, c]
    assert _ids(api, tag="y", kind="meeting") == []
    assert _ids(api, kind="note") == [b]
    assert set(_ids(api, kind=["note", "meeting"])) == {a, b, c}
    assert set(_ids(api, status=["queued", "failed"])) == {a, b, c}

    # Campos do usuário: o valor do campo próprio e os embutidos (título e tags).
    field = api.post("/api/v1/fields", json={"name": "Cliente", "kind": "text"}).json()
    team = api.post("/api/v1/fields", json={"name": "Equipes", "kind": "list"}).json()
    assert api.put(f"/api/v1/recordings/{a}/fields/{field['id']}", json={"value": "Serra Azul"}).status_code == 200
    assert api.put(f"/api/v1/recordings/{b}/fields/{field['id']}", json={"value": "Outro"}).status_code == 200
    assert api.put(f"/api/v1/recordings/{c}/fields/{team['id']}", json={"value": ["rh", "ti"]}).status_code == 200
    assert _ids(api, field=f"{field['id']}:Serra Azul") == [a]
    assert set(_ids(api, field=[f"{field['id']}:Serra Azul", f"{field['id']}:Outro"])) == {a, b}
    assert _ids(api, field=[f"{field['id']}:Serra Azul", f"{team['id']}:ti"]) == []
    assert _ids(api, field=f"{team['id']}:ti") == [c]
    tags_field = next(f for f in api.get("/api/v1/fields").json()["items"] if f["builtin"] == "tags")
    assert set(_ids(api, field=f"{tags_field['id']}:z")) == {c}
    assert api.get("/api/v1/recordings", params={"field": "sem-dois-pontos"}).status_code == 422


def test_biblioteca_por_pessoa(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    with_rafael = transcribed(api, services.settings)
    without = transcribed(api, services.settings)
    rafael = api.post("/api/v1/people", json={"name": "Rafael Lima"}).json()
    linked = api.patch(
        f"/api/v1/transcripts/{with_rafael['transcript_id']}/speakers/S2", json={"person_id": rafael["id"]}
    )
    assert linked.status_code == 200, linked.text
    assert _ids(api, person=rafael["id"]) == [with_rafael["id"]]
    assert without["id"] in _ids(api)


def test_biblioteca_por_atributos_de_um_mesmo_participante(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    both = transcribed(api, services.settings)
    split = transcribed(api, services.settings)
    nobody = transcribed(api, services.settings)
    rafael = api.post(
        "/api/v1/people", json={"name": "Rafael", "organization": "Metalúrgica Serra Azul", "tags": ["Cliente"]}
    ).json()
    ana = api.post("/api/v1/people", json={"name": "Ana", "organization": "Metalúrgica Serra Azul"}).json()
    bruno = api.post("/api/v1/people", json={"name": "Bruno", "department": "RH", "tags": ["cliente"]}).json()

    def link(recording: dict[str, Any], speaker: str, person: dict[str, Any]) -> None:
        linked = api.patch(
            f"/api/v1/transcripts/{recording['transcript_id']}/speakers/{speaker}", json={"person_id": person["id"]}
        )
        assert linked.status_code == 200, linked.text

    link(both, "S1", rafael)
    # A organização e a tag estão na gravação, mas em pessoas diferentes.
    link(split, "S1", ana)
    link(split, "S2", bruno)

    org = "metalurgica serra azul"
    assert set(_ids(api, person_organization=org)) == {both["id"], split["id"]}
    assert set(_ids(api, person_tag="CLIENTE")) == {both["id"], split["id"]}
    assert _ids(api, person_organization=org, person_tag="cliente") == [both["id"]]
    assert _ids(api, person_department="rh") == [split["id"]]
    assert set(_ids(api, person_department=["rh", "Financeiro"], person_tag="cliente")) == {split["id"]}
    assert _ids(api, person_organization="Outra") == []
    assert nobody["id"] not in _ids(api, person_tag="cliente")


def test_editar_metadados_so_o_dono(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    owner = as_user(make_user())
    recording = upload_file(owner, audio_bytes(100))
    patched = owner.patch(
        f"/api/v1/recordings/{recording['id']}",
        json={"title": "Novo título", "tags": ["a", "b"], "metadata": {"projeto": "X"}, "language": "pt-BR"},
    )
    assert patched.status_code == 200
    body = patched.json()
    assert (body["title"], body["tags"], body["metadata"], body["language"]) == (
        "Novo título",
        ["a", "b"],
        {"projeto": "X"},
        "pt-BR",
    )
    assert body["updated_at"] > recording["updated_at"]
    # Corrigir a data a torna informada pela pessoa; a natureza muda à mão.
    assert recording["recorded_at_source"] == "upload"
    redated = owner.patch(
        f"/api/v1/recordings/{recording['id']}", json={"recorded_at": "2026-09-01T10:00:00Z", "kind": "note"}
    ).json()
    assert (redated["recorded_at"], redated["recorded_at_source"], redated["kind"]) == (
        "2026-09-01T10:00:00Z",
        "user",
        "note",
    )
    assert owner.patch(f"/api/v1/recordings/{recording['id']}", json={"kind": None}).status_code == 422
    assert owner.patch(f"/api/v1/recordings/{recording['id']}", json={}).status_code == 422
    assert owner.patch(f"/api/v1/recordings/{recording['id']}", json={"title": None}).status_code == 422
    assert (
        owner.patch(
            f"/api/v1/recordings/{recording['id']}", json={"collection_ids": ["01928f3a-1c00-7a00-8000-000000000801"]}
        ).status_code
        == 422
    )


def test_excluir_apaga_audio(as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services):
    account = make_user()
    api = as_user(account)
    recording = upload_file(api, audio_bytes(100))
    key = f"users/{account.user_id}/recordings/{recording['id']}/audio"
    s3 = services.s3()
    assert s3.list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=key)["KeyCount"] == 1
    assert api.delete(f"/api/v1/recordings/{recording['id']}").status_code == 204
    assert api.get(f"/api/v1/recordings/{recording['id']}").status_code == 404
    assert s3.list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=key)["KeyCount"] == 0


def _count(services: Services, sql: str, **params: Any) -> int:  # noqa: ANN401
    async def go(conn: Any) -> int:  # noqa: ANN401
        return (await conn.execute(text(sql), params)).scalar_one()

    return run(services.sql(go))


def test_excluir_leva_resumo_chat_marcadores_e_audio(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    api = as_user(account)
    recording = transcribed(api, services.settings, markers=[{"client_id": str(uuid4()), "at_ms": 1000}])
    rid, tid = recording["id"], recording["transcript_id"]
    admin.post("/api/v1/admin/agent-providers", json={"name": "Claude", "kind": "claude-cli", "model": "sonnet"})
    types = api.get("/api/v1/agenda-types").json()["items"]
    done = api.post(f"/api/v1/transcripts/{tid}/summaries", json={"agenda_type_id": types[0]["id"]})
    assert done.status_code == 202, done.text
    run_cpu(services.settings)
    # Um resumo ainda na fila quando a gravação sai, e um pedido de ajuste já feito.
    queued = api.post(f"/api/v1/transcripts/{tid}/summaries", json={"agenda_type_id": types[0]["id"]})
    assert queued.status_code == 202, queued.text

    async def chat(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(
            text(
                "INSERT INTO summary_chat_messages (owner_id, recording_id, transcript_id, role, content, status)"
                " VALUES (:o, :r, :t, 'user', 'Encurte', 'done')"
            ),
            {"o": account.user_id, "r": rid, "t": tid},
        )

    run(services.sql(chat))
    counts = {
        "summaries": "SELECT count(*) FROM summaries WHERE transcript_id = :t",
        "chat": "SELECT count(*) FROM summary_chat_messages WHERE recording_id = :r",
        "markers": "SELECT count(*) FROM markers WHERE recording_id = :r",
    }
    assert {name: _count(services, sql, t=tid, r=rid) for name, sql in counts.items()} == {
        "summaries": 2,
        "chat": 1,
        "markers": 1,
    }
    key = f"users/{account.user_id}/recordings/{rid}/audio"
    s3 = services.s3()
    assert s3.list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=key)["KeyCount"] == 1

    assert api.delete(f"/api/v1/recordings/{rid}").status_code == 204
    assert {name: _count(services, sql, t=tid, r=rid) for name, sql in counts.items()} == {
        "summaries": 0,
        "chat": 0,
        "markers": 0,
    }
    assert s3.list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=key)["KeyCount"] == 0
    # O resumo que estava na fila encontra a gravação apagada e não faz nada.
    agents = run_cpu(services.settings)
    assert agents.calls == []


def test_audio_redireciona_para_url_assinada_com_range(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    api = as_user(make_user())
    data = audio_bytes(5000)
    recording = upload_file(api, data)
    redirect = api.get(f"/api/v1/recordings/{recording['id']}/audio", follow_redirects=False)
    assert redirect.status_code == 302
    location = redirect.headers["location"]
    assert location.startswith(f"https://testserver/media/recordings/{recording['id']}/audio?")
    api.client.cookies.clear()
    whole = api.client.get(location)
    assert whole.status_code == 200
    assert whole.content == data
    partial = api.client.get(location, headers={"Range": "bytes=100-199"})
    assert partial.status_code == 206
    assert partial.content == data[100:200]
    assert partial.headers["content-range"] == f"bytes 100-199/{len(data)}"
    assert api.client.get(location.replace("sig=", "sig=0")).status_code == 401


def test_progresso_do_worker_aparece_no_job(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(100))
    client = redis.Redis.from_url(services.settings.redis_url)
    client.hset(
        f"eclume:progress:{recording['id']}",
        mapping={"stage": "diarize", "pct": "40", "updated_at": "2026-09-18T14:09:35Z"},
    )
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["status"] == "processing"
    assert body["job"]["state"] == "running"
    assert body["job"]["stage"] == "diarization"
    assert body["job"]["progress"] == 0.4
    assert [r["id"] for r in api.get("/api/v1/recordings", params={"status": "processing"}).json()["items"]] == [
        recording["id"]
    ]
    assert api.get("/api/v1/recordings", params={"status": "queued"}).json()["items"] == []


def test_retranscrever_so_sem_job_em_andamento(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(100))
    busy = api.post(f"/api/v1/recordings/{recording['id']}/retranscribe")
    assert busy.status_code == 409

    from sqlalchemy import text  # noqa: PLC0415

    from eclume_server_testing.harness import run  # noqa: PLC0415

    async def finish(conn):  # noqa: ANN001, ANN202
        await conn.execute(
            text(
                "UPDATE transcription_jobs SET state = 'failed', error_code = 'engine_error' WHERE recording_id = :id"
            ),
            {"id": recording["id"]},
        )

    run(services.sql(finish))
    again = api.post(f"/api/v1/recordings/{recording['id']}/retranscribe", json={"language": "en"})
    assert again.status_code == 202
    assert again.json()["job"]["state"] == "queued"
    assert again.json()["language"] == "en"
    assert redis.Redis.from_url(services.settings.redis_url).zscore("eclume:gpu", f"transcribe:{recording['id']}:2")


def test_excluir_por_pat_exige_recordings_delete(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    session = as_user(make_user())
    recording = upload_file(session, audio_bytes(101))
    writer = session.pat("recordings:read", "recordings:write")
    denied = writer.delete(f"/api/v1/recordings/{recording['id']}")
    assert denied.status_code == 403
    assert denied.json()["required_scopes"] == ["recordings:delete"]
    deleter = session.pat("recordings:delete")
    assert deleter.delete(f"/api/v1/recordings/{recording['id']}").status_code == 204
    assert session.get(f"/api/v1/recordings/{recording['id']}").status_code == 404
