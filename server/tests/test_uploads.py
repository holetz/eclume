"""Upload multipart: partes assinadas, dedup e retomada por hash, hash divergente e enfileiramento."""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING

import redis
from sqlalchemy import text

from eclume_server.worker import expire_uploads, shutdown, startup
from eclume_server_testing.api import audio_bytes, put_parts, upload_file
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

MIB = 1024 * 1024


def _body(data: bytes, **fields: object) -> dict[str, object]:
    return {
        "filename": "2026-09-18 11-00 Teams.opus",
        "content_type": "audio/ogg; codecs=opus",
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        **fields,
    }


def _queued_job(services: Services, job_id: str) -> tuple[str, tuple, dict] | None:
    import pickle  # noqa: PLC0415 — o arq serializa o job com pickle

    client = redis.Redis.from_url(services.settings.redis_url)
    raw = client.get(f"arq:job:{job_id}")
    in_queue = client.zscore("eclume:gpu", job_id) is not None
    if raw is None or not in_queue:
        return None
    job = pickle.loads(raw)  # noqa: S301 — dado que o próprio teste enfileirou
    return job["f"], job["a"], job["k"]


def test_upload_em_partes_cria_gravacao_e_enfileira_transcribe(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user(name="Mariana Couto")
    pat = as_user(account).pat("recordings:write", "recordings:read")
    data = audio_bytes(12 * MIB)
    created = pat.post(
        "/api/v1/uploads",
        json=_body(
            data,
            title="Alinhamento do programa de lideranças",
            recorded_at="2026-09-18T14:00:05Z",
            language="pt-BR",
            source="desktop",
            capture={"meeting_app": "teams", "device_name": "NB-MARIANA", "client_version": "eclume-desktop/0.3.0"},
            tags=["programa-liderancas"],
            metadata={"cliente": "Metalúrgica Serra Azul"},
        ),
    )
    assert created.status_code == 201
    upload = created.json()
    assert upload["status"] == "in_progress"
    assert upload["part_size"] == 5 * MIB
    assert upload["part_count"] == 3
    assert [p["part_number"] for p in upload["parts"]] == [1, 2, 3]
    assert upload["parts"][0]["url"].startswith("https://testserver/api/v1/uploads/")
    assert upload["recording_id"] is None

    parts = put_parts(pat, upload, data)
    completed = pat.post(f"/api/v1/uploads/{upload['id']}/complete", json={"parts": parts})
    assert completed.status_code == 201
    recording = completed.json()
    assert recording["status"] == "queued"
    assert recording["title"] == "Alinhamento do programa de lideranças"
    assert recording["source"] == "desktop"
    assert recording["owner"] == {"id": str(account.user_id), "name": "Mariana Couto"}
    assert recording["visibility"] == "private"
    assert recording["content_hash"] == f"sha256:{upload['sha256']}"
    assert recording["job"]["state"] == "queued"
    assert recording["job"]["error"] is None
    assert recording["capture"]["meeting_app"] == "teams"

    job = _queued_job(services, f"transcribe:{recording['id']}:1")
    assert job is not None
    function, args, _ = job
    assert function == "transcribe"
    recording_id, key, options = args
    assert recording_id == recording["id"]
    assert key == f"orgs/{account.org_id}/users/{account.user_id}/recordings/{recording['id']}/audio"
    assert options == {
        "language": "pt",
        "min_speakers": None,
        "max_speakers": None,
        "engine": "whisperx-local",
        "model": "large-v3-turbo",
        "compute_type": "int8_float16",
        "batch_size": None,
        "fallback_model": "medium",
        "endpoint_url": None,
        "diarize": True,
        "diarization_model": "pyannote/speaker-diarization-community-1",
        "embeddings": False,
    }
    stored = services.s3().get_object(Bucket=services.settings.s3_bucket, Key=key)["Body"].read()
    assert stored == data

    again = pat.post(f"/api/v1/uploads/{upload['id']}/complete", json={"parts": parts})
    assert again.status_code == 201
    assert again.json()["id"] == recording["id"]
    assert pat.get(f"/api/v1/uploads/{upload['id']}").json()["status"] == "completed"


def test_mesmo_hash_deduplica_sem_transferir(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    data = audio_bytes(1000)
    recording = upload_file(api, data)
    response = api.post("/api/v1/uploads", json=_body(data))
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "deduplicated"
    assert body["recording_id"] == recording["id"]
    assert body["parts"] == []
    assert body["part_count"] == 0

    other = as_user(make_user())
    assert other.post("/api/v1/uploads", json=_body(data)).status_code == 201  # o dedup é por usuário


def test_retomada_pelo_hash_e_pelo_get(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    data = audio_bytes(11 * MIB)
    upload = api.post("/api/v1/uploads", json=_body(data)).json()
    first = put_parts(api, upload, data, only={1})

    state = api.get(f"/api/v1/uploads/{upload['id']}").json()
    assert [p["part_number"] for p in state["parts_received"]] == [1]
    assert state["parts_received"][0]["etag"] == first[0]["etag"]
    assert state["parts_received"][0]["size_bytes"] == 5 * MIB

    resumed = api.post("/api/v1/uploads", json=_body(data))
    assert resumed.status_code == 201
    assert resumed.json()["id"] == upload["id"]
    assert [p["part_number"] for p in resumed.json()["parts"]] == [2, 3]

    urls = api.post(f"/api/v1/uploads/{upload['id']}/part-urls", json={"part_numbers": [2, 3]})
    assert urls.status_code == 200
    rest = put_parts(api, {**upload, "parts": urls.json()["parts"]}, data)
    assert api.post(f"/api/v1/uploads/{upload['id']}/part-urls", json={"part_numbers": [4]}).status_code == 422
    done = api.post(f"/api/v1/uploads/{upload['id']}/complete", json={"parts": first + rest})
    assert done.status_code == 201
    assert api.post(f"/api/v1/uploads/{upload['id']}/part-urls", json={"part_numbers": [1]}).status_code == 409


def test_hash_divergente_vira_falha_do_job(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    data = audio_bytes(2000)
    declared = hashlib.sha256(b"outro conteudo").hexdigest()
    upload = api.post("/api/v1/uploads", json=_body(data, sha256=declared)).json()
    parts = put_parts(api, upload, data)
    recording = api.post(f"/api/v1/uploads/{upload['id']}/complete", json={"parts": parts}).json()
    assert recording["status"] == "failed"
    assert recording["job"]["state"] == "failed"
    assert recording["job"]["error"]["code"] == "hash_mismatch"
    assert recording["content_hash"] == f"sha256:{hashlib.sha256(data).hexdigest()}"
    assert _queued_job(services, f"transcribe:{recording['id']}:1") is None
    # O hash declarado não ficou preso à gravação falha: um novo upload dele começa normalmente.
    assert api.post("/api/v1/uploads", json=_body(b"outro conteudo")).status_code == 201


def test_partes_invalidas(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    data = audio_bytes(6 * MIB)
    upload = api.post("/api/v1/uploads", json=_body(data)).json()
    url = upload["parts"][0]["url"]
    client = api.client

    assert client.put(url, content=b"curta").status_code == 409
    assert client.put(url.replace("sig=", "sig=0"), content=data[: 5 * MIB]).status_code == 401
    assert client.put(url.split("?")[0], content=data[: 5 * MIB]).status_code == 401
    forged = url.replace("/parts/1?", "/parts/2?")
    assert client.put(forged, content=data[5 * MIB :]).status_code == 401

    one = put_parts(api, upload, data, only={1})
    missing = api.post(f"/api/v1/uploads/{upload['id']}/complete", json={"parts": one})
    assert missing.status_code == 422
    wrong_etag = api.post(
        f"/api/v1/uploads/{upload['id']}/complete",
        json={"parts": [*one, {"part_number": 2, "etag": '"nao-existe"'}]},
    )
    assert wrong_etag.status_code == 422
    assert wrong_etag.json()["errors"][0]["field"] == "parts[1].etag"

    assert api.delete(f"/api/v1/uploads/{upload['id']}").status_code == 204
    assert api.get(f"/api/v1/uploads/{upload['id']}").json()["status"] == "aborted"
    assert client.put(url, content=data[: 5 * MIB]).status_code == 409


def test_validacao_da_criacao(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    data = audio_bytes(100)
    cases = [
        ({"sha256": "ABC"}, "sha256"),
        ({"content_type": "text/plain"}, "content_type"),
        ({"size_bytes": 0}, "size_bytes"),
        ({"size_bytes": 10_001 * 5 * MIB}, "size_bytes"),
        ({"language": "portugues"}, "language"),
        ({"collection_ids": ["01928f3a-1c00-7a00-8000-000000000801"]}, "collection_ids"),
    ]
    for fields, field in cases:
        response = api.post("/api/v1/uploads", json=_body(data, **fields))
        assert response.status_code == 422, fields
        assert response.json()["errors"][0]["field"] == field


def test_escopo_e_dono_do_upload(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    owner = as_user(make_user())
    reader = owner.pat("recordings:read")
    data = audio_bytes(100)
    denied = reader.post("/api/v1/uploads", json=_body(data))
    assert denied.status_code == 403
    assert denied.json() | {"detail": None} == {
        "type": "https://eclume.dev/problems/insufficient-scope",
        "title": "Escopo insuficiente",
        "status": 403,
        "code": "insufficient_scope",
        "detail": None,
        "required_scopes": ["recordings:write"],
    }
    upload = owner.post("/api/v1/uploads", json=_body(data)).json()
    stranger = as_user(make_user())
    assert stranger.get(f"/api/v1/uploads/{upload['id']}").status_code == 404
    assert json.loads(stranger.delete(f"/api/v1/uploads/{upload['id']}").text)["code"] == "not_found"


def test_uploads_vencidos_sao_descartados_pelo_worker(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    upload = api.post("/api/v1/uploads", json=_body(audio_bytes(100))).json()

    async def age(conn):  # noqa: ANN001, ANN202
        return (
            await conn.execute(
                text(
                    "UPDATE uploads SET expires_at = now() - interval '1 minute' WHERE id = :id RETURNING s3_upload_id"
                ),
                {"id": upload["id"]},
            )
        ).scalar_one()

    s3_upload_id = run(services.sql(age))
    assert api.get(f"/api/v1/uploads/{upload['id']}").json()["status"] == "expired"

    async def sweep() -> int:
        ctx: dict[str, object] = {"settings": services.settings}
        await startup(ctx)
        try:
            return await expire_uploads(ctx)
        finally:
            await shutdown(ctx)

    assert run(sweep()) >= 1
    assert api.get(f"/api/v1/uploads/{upload['id']}").json()["status"] == "expired"
    pending = services.s3().list_multipart_uploads(Bucket=services.settings.s3_bucket).get("Uploads", [])
    assert s3_upload_id not in {u["UploadId"] for u in pending}
