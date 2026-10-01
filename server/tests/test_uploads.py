"""Upload multipart: partes assinadas, dedup e retomada por hash, hash divergente e enfileiramento."""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Any

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
    assert key == f"users/{account.user_id}/recordings/{recording['id']}/audio"
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
        "preprocess": {
            "denoise": {"enabled": True, "method": "rnnoise", "strength": 0.6},
            "loudnorm": {"enabled": True, "target_lufs": -16, "true_peak_db": -1.5, "lra": 11},
            "trim_silence": {"enabled": True, "min_silence_s": 3, "threshold_db": -50},
            "split_channels": {"enabled": False},
        },
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


def _multipart(services: Services, upload_id: str) -> tuple[str, str]:
    async def go(conn: Any) -> Any:  # noqa: ANN401
        query = text("SELECT audio_key, s3_upload_id FROM uploads WHERE id = :u")
        return (await conn.execute(query, {"u": upload_id})).one()

    return tuple(run(services.sql(go)))


def _lose_multipart(services: Services, upload_id: str) -> None:
    """O multipart some do bucket (o MinIO o venceu ou alguém o abortou)."""
    key, s3_upload_id = _multipart(services, upload_id)
    services.s3().abort_multipart_upload(Bucket=services.settings.s3_bucket, Key=key, UploadId=s3_upload_id)


def test_multipart_sumido_e_expired_e_o_mesmo_hash_abre_outro(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    data = audio_bytes(1200)
    upload = api.post("/api/v1/uploads", json=_body(data)).json()
    _lose_multipart(services, upload["id"])

    state = api.get(f"/api/v1/uploads/{upload['id']}")
    assert state.status_code == 200
    assert (state.json()["status"], state.json()["parts_received"]) == ("expired", [])
    again = api.post("/api/v1/uploads", json=_body(data))
    assert again.status_code == 201
    assert again.json()["id"] != upload["id"]
    assert again.json()["status"] == "in_progress"


def test_retomada_por_hash_com_multipart_sumido_abre_outro(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    data = audio_bytes(1300)
    upload = api.post("/api/v1/uploads", json=_body(data)).json()
    _lose_multipart(services, upload["id"])
    again = api.post("/api/v1/uploads", json=_body(data))
    assert again.status_code == 201
    assert again.json()["id"] != upload["id"]
    assert api.get(f"/api/v1/uploads/{upload['id']}").json()["status"] == "expired"


def test_parte_e_complete_com_multipart_sumido_respondem_409_upload_expired(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    data = audio_bytes(1400)
    upload = api.post("/api/v1/uploads", json=_body(data)).json()
    _lose_multipart(services, upload["id"])
    part = upload["parts"][0]
    put = api.client.put(part["url"], content=data, headers=part["headers"])
    assert (put.status_code, put.json()["code"]) == (409, "upload_expired")

    other = api.post("/api/v1/uploads", json=_body(audio_bytes(1500))).json()
    sent = put_parts(api, other, audio_bytes(1500))
    _lose_multipart(services, other["id"])
    done = api.post(f"/api/v1/uploads/{other['id']}/complete", json={"parts": sent})
    assert (done.status_code, done.json()["code"]) == (409, "upload_expired")
    assert api.get(f"/api/v1/uploads/{other['id']}").json()["status"] == "expired"


def test_complete_repetido_depois_do_objeto_montado_conclui(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    data = audio_bytes(1600)
    upload = api.post("/api/v1/uploads", json=_body(data)).json()
    sent = put_parts(api, upload, data)
    # O `complete` anterior montou o objeto, mas o commit falhou: o upload segue `in_progress`.
    key, s3_upload_id = _multipart(services, upload["id"])
    services.s3().complete_multipart_upload(
        Bucket=services.settings.s3_bucket,
        Key=key,
        UploadId=s3_upload_id,
        MultipartUpload={"Parts": [{"PartNumber": p["part_number"], "ETag": p["etag"]} for p in sent]},
    )
    done = api.post(f"/api/v1/uploads/{upload['id']}/complete", json={"parts": sent})
    assert done.status_code == 201, done.text
    assert done.json()["status"] == "queued"


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
        ({"kind": "palestra"}, "kind"),
        ({"recorded_at_source": "capture"}, "recorded_at_source"),
    ]
    for fields, field in cases:
        response = api.post("/api/v1/uploads", json=_body(data, **fields))
        assert response.status_code == 422, fields
        assert response.json()["errors"][0]["field"] == field


def test_origem_da_data_e_natureza(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    when = "2026-09-18T14:00:05Z"

    def origin(**fields: object) -> tuple[str, str, str]:
        recording = upload_file(api, audio_bytes(100), **fields)
        return recording["recorded_at_source"], recording["kind"], recording["recorded_at"]

    # Os apps (desktop e celular) mandam o relógio da captura; o navegador, a data que a pessoa
    # confirmou ou digitou.
    assert origin(source="desktop", recorded_at=when) == ("capture", "meeting", when)
    assert origin(source="mobile", recorded_at=when) == ("capture", "meeting", when)
    assert origin(recorded_at=when) == ("user", "meeting", when)
    assert origin(recorded_at=when, recorded_at_source="file_metadata", kind="note") == ("file_metadata", "note", when)
    source, kind, recorded_at = origin()
    assert (source, kind) == ("upload", "meeting")
    assert recorded_at != when


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
