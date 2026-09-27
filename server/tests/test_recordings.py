"""Gravações: leitura, edição, exclusão, áudio, progresso, retranscrição e compartilhamento."""

from __future__ import annotations

from typing import TYPE_CHECKING

import redis

from eclume_server_testing.api import audio_bytes, upload_file

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
