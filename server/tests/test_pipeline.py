"""Ponta a ponta com o worker GPU fake: upload → transcribe → ingest → leitura e export."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING
from uuid import UUID

import pytest
from botocore.exceptions import EndpointConnectionError
from sqlalchemy import text

from eclume_server.db.session import make_engine
from eclume_server.queue import Queue, progress_key
from eclume_server.storage import Storage
from eclume_server.transcripts import fail, render_markdown
from eclume_server.worker import INGEST_RETRY_DELAYS_S, ingest_transcript, transcription_failed
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import DEFAULT_VOICES, ENGINE_INFO, contract_transcript, run_cpu, run_gpu
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

LUMEA_SEGMENT_RE = re.compile(r"^\*\*(?P<speaker>[^*]+)\*\*\s+\[(?P<timestamp>[^\]]+)\]:\s*(?P<text>.*)$")


def _metadata() -> dict[str, object]:
    return {
        "title": "Alinhamento do programa de lideranças",
        "recorded_at": "2026-09-18T14:00:05Z",
        "language": "pt-BR",
        "source": "desktop",
        "tags": ["programa-liderancas"],
    }


def test_upload_transcreve_e_o_lumea_le_por_pat(  # noqa: PLR0915 — o fluxo inteiro é o teste
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user(name="Mariana Couto")
    session = as_user(account)
    desktop = session.pat("recordings:write", "recordings:read")
    lumea = session.pat("transcripts:read")

    recording = upload_file(desktop, audio_bytes(3000), **_metadata())
    calls = run_gpu(services.settings)
    assert [call[0] for call in calls] == [recording["id"]]

    # O worker GPU terminou e publicou progresso, mas a ingestão ainda não rodou.
    pending = desktop.get(f"/api/v1/recordings/{recording['id']}").json()
    assert pending["status"] == "processing"
    assert pending["job"]["stage"] == "finalizing"

    run_cpu(services.settings)
    done = desktop.get(f"/api/v1/recordings/{recording['id']}").json()
    assert done["status"] == "transcribed"
    assert done["job"]["state"] == "succeeded"
    assert done["job"]["progress"] == 1
    assert done["duration_ms"] == 166000
    transcript_id = done["transcript_id"]
    assert transcript_id

    listed = lumea.get("/api/v1/transcripts", params={"since": recording["created_at"]}).json()
    assert [item["id"] for item in listed["items"]] == [transcript_id]
    summary = listed["items"][0]
    assert summary["revision"] == 1
    assert summary["content_hash"] == recording["content_hash"]
    assert summary["owner"] == {"id": str(account.user_id), "name": "Mariana Couto"}
    assert [s["label"] for s in summary["speakers"]] == ["Locutor 1", "Locutor 2", "Locutor 3"]

    full = lumea.get(f"/api/v1/transcripts/{transcript_id}").json()
    source = contract_transcript()
    assert full["schema_version"] == "1.2"
    assert full["recording_id"] == recording["id"]
    assert full["title"] == "Alinhamento do programa de lideranças"
    assert full["recorded_at"] == "2026-09-18T14:00:05Z"
    assert full["source"] == "desktop"
    assert full["tags"] == ["programa-liderancas"]
    assert full["engine"]["model"] == "large-v3-turbo"
    assert [(s["id"], s["talk_ms"], s["person"]) for s in full["speakers"]] == [
        (s["id"], s["talk_ms"], None) for s in source["speakers"]
    ]
    assert [(s["id"], s["speaker_id"], s["start_ms"], s["text"]) for s in full["segments"]] == [
        (s["id"], s["speaker_id"], s["start_ms"], s["text"]) for s in source["segments"]
    ]
    assert all("words" not in s for s in full["segments"])
    with_words = lumea.get(f"/api/v1/transcripts/{transcript_id}", params={"include": "words"}).json()
    assert with_words["segments"][0]["words"] == source["segments"][0]["words"]

    exported = lumea.get(f"/api/v1/transcripts/{transcript_id}/export", params={"format": "md"})
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("text/markdown")
    assert exported.headers["content-disposition"] == 'attachment; filename="alinhamento-do-programa-de-liderancas.md"'
    assert exported.text == render_markdown(full)
    body = [line for line in exported.text.split("---\n", 2)[2].splitlines() if line.strip()]
    assert len(body) == len(source["segments"])
    assert all(LUMEA_SEGMENT_RE.match(line) for line in body)
    assert lumea.get(f"/api/v1/transcripts/{transcript_id}/export", params={"format": "pdf"}).status_code == 422

    # Escopos: o PAT do lumea não lê gravações; o do desktop não lê transcrições.
    assert lumea.get(f"/api/v1/recordings/{recording['id']}").json()["code"] == "insufficient_scope"
    assert desktop.get("/api/v1/transcripts").json()["required_scopes"] == ["transcripts:read"]

    # `since` inclusivo: repetir com o maior `updated_at` visto devolve o item de novo.
    again = lumea.get("/api/v1/transcripts", params={"since": summary["updated_at"]}).json()
    assert [item["id"] for item in again["items"]] == [transcript_id]


def test_ingestao_idempotente_e_retranscricao_sobe_revisao(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3000))
    run_gpu(services.settings)
    run_cpu(services.settings)
    first = api.get(f"/api/v1/recordings/{recording['id']}").json()

    # Um `ingest_transcript` repetido (reentrega) não muda nada.
    async def redeliver() -> None:
        queue = await Queue.connect(services.settings.redis_url)
        try:
            key = f"recordings/{recording['id']}/transcript.raw.json"
            await queue.pool.enqueue_job("ingest_transcript", recording["id"], key, None, ENGINE_INFO)
        finally:
            await queue.close()

    run(redeliver())
    run_cpu(services.settings)
    transcript = api.get(f"/api/v1/transcripts/{first['transcript_id']}").json()
    assert transcript["revision"] == 1

    assert api.post(f"/api/v1/recordings/{recording['id']}/retranscribe").status_code == 202
    calls = run_gpu(services.settings)
    assert len(calls) == 1
    run_cpu(services.settings)
    after = api.get(f"/api/v1/transcripts/{first['transcript_id']}").json()
    assert after["id"] == first["transcript_id"]
    assert after["revision"] == 2
    assert after["updated_at"] > transcript["updated_at"]
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["status"] == "transcribed"


class _EnqueueSpy:
    """O Redis do `ingest_transcript` chamado direto: registra o que ele enfileiraria."""

    def __init__(self) -> None:
        self.jobs: list[str] = []

    async def delete(self, *keys: str) -> None:
        pass

    async def enqueue_job(self, name: str, *_args: object, **_kwargs: object) -> None:
        self.jobs.append(name)


def _ingest_directly(services: Services, recording_id: str) -> list[str]:
    """Roda `ingest_transcript` fora do arq (sem a deduplicação por `_job_id`); devolve o enfileirado."""

    async def go() -> list[str]:
        engine = make_engine(services.settings.database_url)
        redis = _EnqueueSpy()
        ctx = {"engine": engine, "storage": Storage(services.settings), "redis": redis}
        try:
            key = f"recordings/{recording_id}/r1/transcript.raw.json"
            await ingest_transcript(ctx, recording_id, key, None, ENGINE_INFO)
        finally:
            await engine.dispose()
        return redis.jobs

    return run(go())


class _RedisSpy(_EnqueueSpy):
    """Também registra as chaves apagadas."""

    def __init__(self) -> None:
        super().__init__()
        self.deleted: list[str] = []

    async def delete(self, *keys: str) -> None:
        self.deleted.extend(keys)


def _deliver(services: Services, job: str, job_id: str | None, *args: object) -> _RedisSpy:
    """Roda um job de retorno fora do arq, com o `_job_id` dado em `ctx`."""

    async def go() -> _RedisSpy:
        engine = make_engine(services.settings.database_url)
        redis = _RedisSpy()
        ctx = {"engine": engine, "storage": Storage(services.settings), "redis": redis, "job_id": job_id}
        try:
            function = ingest_transcript if job == "ingest_transcript" else transcription_failed
            await function(ctx, *args)
        finally:
            await engine.dispose()
        return redis

    return run(go())


def test_saida_atrasada_da_revisao_anterior_e_ignorada(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3600))
    rid = recording["id"]
    run_gpu(services.settings)
    run_cpu(services.settings)
    first = api.get(f"/api/v1/recordings/{rid}").json()
    retried = api.post(f"/api/v1/recordings/{rid}/retranscribe")
    assert retried.status_code == 202

    # A saída da revisão 1 chega depois de a revisão 2 existir: nem grava, nem falha, nem apaga o progresso.
    key = f"recordings/{rid}/r1/transcript.raw.json"
    spy = _deliver(services, "ingest_transcript", f"ingest_transcript:{rid}:1", rid, key, None, ENGINE_INFO)
    assert (spy.jobs, spy.deleted) == ([], [])
    spy = _deliver(services, "transcription_failed", f"transcription_failed:{rid}:1", rid, "gpu_oom", "OOM", "asr")
    assert spy.deleted == []
    body = api.get(f"/api/v1/recordings/{rid}").json()
    assert body["status"] == "queued"
    assert (body["job"]["state"], body["job"]["id"]) == ("queued", retried.json()["job"]["id"])
    assert api.get(f"/api/v1/transcripts/{first['transcript_id']}").json()["revision"] == 1

    # A da revisão 2 fecha o job dela.
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert api.get(f"/api/v1/recordings/{rid}").json()["status"] == "transcribed"
    assert api.get(f"/api/v1/transcripts/{first['transcript_id']}").json()["revision"] == 2


def test_worker_antigo_sem_revisao_no_job_id_ainda_ingere(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3700))
    run_gpu(services.settings, legacy=True)
    run_cpu(services.settings)
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["status"] == "transcribed"

    failed = upload_file(api, audio_bytes(3800))
    run_gpu(services.settings, legacy=True, fail=True)
    run_cpu(services.settings)
    assert api.get(f"/api/v1/recordings/{failed['id']}").json()["job"]["error"]["code"] == "gpu_oom"


def test_retranscricao_apaga_artefatos_da_revisao_anterior(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3900))
    rid = recording["id"]
    run_gpu(services.settings)
    run_cpu(services.settings)
    s3, bucket = services.s3(), services.settings.s3_bucket

    def listed() -> list[str]:
        return sorted(
            obj["Key"] for obj in s3.list_objects_v2(Bucket=bucket, Prefix=f"recordings/{rid}/").get("Contents", [])
        )

    assert listed() == [f"recordings/{rid}/r1/transcript.raw.json"]
    # Uma chave antiga, sem revisão, também sai.
    s3.put_object(Bucket=bucket, Key=f"recordings/{rid}/transcript.raw.json", Body=b"{}")

    assert api.post(f"/api/v1/recordings/{rid}/retranscribe").status_code == 202
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert listed() == [f"recordings/{rid}/r2/transcript.raw.json"]


def _flaky_read(monkeypatch: pytest.MonkeyPatch, failures: int) -> list[str]:
    """`Storage.read_json` com o S3 fora do ar nas `failures` primeiras chamadas; devolve as chamadas."""
    original = Storage.read_json
    calls: list[str] = []

    async def read(storage: Storage, key: str) -> object:
        calls.append(key)
        if len(calls) <= failures:
            raise EndpointConnectionError(endpoint_url="http://minio:9000")
        return await original(storage, key)

    monkeypatch.setattr(Storage, "read_json", read)
    return calls


def test_ingestao_com_falha_passageira_tenta_de_novo(
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
    monkeypatch: pytest.MonkeyPatch,
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(4000))
    run_gpu(services.settings)
    calls = _flaky_read(monkeypatch, failures=2)
    run_cpu(services.settings)
    assert len(calls) == 3
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["status"] == "transcribed"


def test_falha_passageira_persistente_vira_ingest_failed(
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
    monkeypatch: pytest.MonkeyPatch,
):
    # As esperas cabem antes do teto do reaper, que não declara `ingest_failed` no meio das tentativas.
    assert sum(INGEST_RETRY_DELAYS_S) < services.settings.job_stall_seconds
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(4100))
    run_gpu(services.settings)
    calls = _flaky_read(monkeypatch, failures=99)
    run_cpu(services.settings)
    assert len(calls) == len(INGEST_RETRY_DELAYS_S) + 1
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert (body["status"], body["job"]["error"]["code"]) == ("failed", "ingest_failed")


def test_so_a_ingestao_que_grava_abre_a_cadeia_por_agente(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    # Ingestão repetida depois da cadeia inteira: nada muda e nada entra na fila.
    done = upload_file(api, audio_bytes(3100))
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert _ingest_directly(services, done["id"]) == []

    # Job já falho pelo reaper quando a ingestão chega: a transcrição não é gravada e a cadeia não começa.
    reaped = upload_file(api, audio_bytes(3200))
    run_gpu(services.settings)
    run(services.sql(lambda conn: fail(conn, UUID(reaped["id"]), "job_lost", "sem worker")))
    assert _ingest_directly(services, reaped["id"]) == []
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{reaped['id']}").json()
    assert body["status"] == "failed"
    assert _states(body)["fields"] == "pending"

    # A ingestão que grava abre a cadeia pelo tipo de agenda.
    fresh = upload_file(api, audio_bytes(3300))
    run_gpu(services.settings)
    assert _ingest_directly(services, fresh["id"]) == ["detect_agenda_type"]
    run_cpu(services.settings)


def test_falha_do_worker_gpu_marca_job_e_gravacao(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3000))
    run_gpu(services.settings, fail=True)
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["status"] == "failed"
    assert body["job"]["state"] == "failed"
    assert body["job"]["error"] == {"code": "gpu_oom", "message": "CUDA out of memory", "retryable": True}
    assert body["job"]["finished_at"] is not None
    assert body["transcript_id"] is None
    steps = {step["step"]: step for step in body["pipeline"]}
    assert steps["received"]["state"] == "done"
    assert steps["transcription"]["state"] == "failed"
    assert steps["transcription"]["error"] == {"code": "gpu_oom", "message": "CUDA out of memory"}
    assert steps["summary"]["state"] == "pending"


@pytest.mark.usefixtures("platform")
def test_embeddings_so_com_a_voz_ligada_na_plataforma(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    api = as_user(account)

    async def opt_in(conn):  # noqa: ANN001, ANN202
        await conn.execute(
            text(
                "UPDATE platform_settings"
                " SET voice_identification = jsonb_set(voice_identification, '{enabled}', 'true')"
            )
        )

    without = upload_file(api, audio_bytes(3000))
    run(services.sql(opt_in))
    with_opt_in = upload_file(api, audio_bytes(3000))
    calls = {call[0]: call[2] for call in run_gpu(services.settings)}
    assert calls[without["id"]]["embeddings"] is False
    assert calls[with_opt_in["id"]]["embeddings"] is True
    run_cpu(services.settings)

    async def count(conn):  # noqa: ANN001, ANN202
        rows = await conn.execute(
            text(
                "SELECT r.id::text, e.speaker_id, e.model, vector_dims(e.embedding) FROM speaker_embeddings e"
                " JOIN transcripts t ON t.id = e.transcript_id JOIN recordings r ON r.id = t.recording_id"
                " WHERE r.owner_id = :owner ORDER BY e.speaker_id"
            ),
            {"owner": account.user_id},
        )
        return [tuple(row) for row in rows]

    rows = run(services.sql(count))
    assert [(r[0], r[1], r[3]) for r in rows] == [(with_opt_in["id"], f"S{i}", 256) for i in (1, 2, 3)]


async def _voice_on(conn):  # noqa: ANN001, ANN202
    await conn.execute(
        text("UPDATE platform_settings SET voice_identification = jsonb_set(voice_identification, '{enabled}', 'true')")
    )


def _embedded_speakers(services: Services, recording_id: str) -> list[str]:
    async def go(conn):  # noqa: ANN001, ANN202
        rows = await conn.execute(
            text(
                "SELECT e.speaker_id FROM speaker_embeddings e JOIN transcripts t ON t.id = e.transcript_id"
                " WHERE t.recording_id = :recording ORDER BY e.speaker_id"
            ),
            {"recording": UUID(recording_id)},
        )
        return [row[0] for row in rows]

    return run(services.sql(go))


@pytest.mark.usefixtures("platform")
def test_embedding_nao_finito_de_worker_antigo_nao_derruba_a_ingestao(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    # Fala curta demais: o pyannote gera NaN, e um worker antigo o grava no `speaker_embeddings.json`.
    api = as_user(make_user())
    run(services.sql(_voice_on))
    recording = upload_file(api, audio_bytes(3400))
    voices = dict(DEFAULT_VOICES) | {"S2": [float("nan")] * 256}
    run_gpu(services.settings, voices=voices)
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["status"] == "transcribed"
    assert _embedded_speakers(services, recording["id"]) == ["S1", "S3"]


@pytest.mark.usefixtures("platform")
def test_ingestao_que_falha_vira_falha_recuperavel(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    # Qualquer erro na ingestão desfaz a transação; a gravação não pode ficar presa na fila.
    api = as_user(make_user())
    run(services.sql(_voice_on))
    recording = upload_file(api, audio_bytes(3500))
    run_gpu(services.settings, voices=dict(DEFAULT_VOICES) | {"S2": ["não é número"]})
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["status"] == "failed"
    assert body["transcript_id"] is None
    assert body["job"]["state"] == "failed"
    assert body["job"]["error"]["code"] == "ingest_failed"
    assert body["job"]["error"]["retryable"] is True
    transcription = next(step for step in body["pipeline"] if step["step"] == "transcription")
    assert (transcription["state"], transcription["error"]["code"]) == ("failed", "ingest_failed")

    # Retranscrever com um worker que grava embeddings válidos resolve.
    assert api.post(f"/api/v1/recordings/{recording['id']}/retranscribe").status_code == 202
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert api.get(f"/api/v1/recordings/{recording['id']}").json()["status"] == "transcribed"


def _states(body: dict) -> dict[str, str]:
    return {step["step"]: step["state"] for step in body["pipeline"]}


def test_etapas_do_pipeline_por_revisao(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3100))
    assert [step["step"] for step in recording["pipeline"]] == [
        "received",
        "preprocessing",
        "transcription",
        "agenda_type",
        "fields",
        "summary",
    ]
    assert _states(recording) == {
        "received": "done",
        "preprocessing": "pending",
        "transcription": "pending",
        "fields": "pending",
        "agenda_type": "pending",
        "summary": "pending",
    }

    # Com o worker GPU reportando progresso, a transcrição sai em andamento.
    async def progress() -> None:
        queue = await Queue.connect(services.settings.redis_url)
        try:
            await queue.pool.hset(progress_key(recording["id"]), mapping={"stage": "asr", "pct": "40"})
        finally:
            await queue.close()

    run(progress())
    running = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert _states(running)["transcription"] == "active"

    run_gpu(services.settings)
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    transcription = next(step for step in body["pipeline"] if step["step"] == "transcription")
    assert transcription["state"] == "done"
    assert transcription["finished_at"] is not None
    assert transcription["duration_ms"] >= 0

    # A retranscrição abre uma revisão nova: a cadeia recomeça.
    retried = api.post(f"/api/v1/recordings/{recording['id']}/retranscribe").json()
    assert (_states(retried)["received"], _states(retried)["transcription"]) == ("done", "pending")
    run_gpu(services.settings)
    run_cpu(services.settings)
    assert _states(api.get(f"/api/v1/recordings/{recording['id']}").json())["transcription"] == "done"


def _step(body: dict, name: str) -> dict:
    return next(step for step in body["pipeline"] if step["step"] == name)


def test_pre_processamento_vai_nas_options_e_vira_etapa(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3200))
    ((_, _, options),) = run_gpu(services.settings)
    assert options["preprocess"] == {
        "denoise": {"enabled": True, "method": "rnnoise", "strength": 0.6},
        "loudnorm": {"enabled": True, "target_lufs": -16, "true_peak_db": -1.5, "lra": 11},
        "trim_silence": {"enabled": True, "min_silence_s": 3, "threshold_db": -50},
        "split_channels": {"enabled": False},
    }
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    pre, transcription = _step(body, "preprocessing"), _step(body, "transcription")
    assert (pre["state"], pre["duration_ms"]) == ("done", 1500)
    assert pre["finished_at"] == transcription["started_at"]

    # A cadeia que caiu para só o formato: a etapa falha e a transcrição segue.
    api.post(f"/api/v1/recordings/{recording['id']}/retranscribe")
    run_gpu(services.settings, preprocess_fallback=True)
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert _step(body, "preprocessing")["error"] == {"code": "preprocess_failed", "message": "arnndn: modelo inválido"}
    assert _step(body, "transcription")["state"] == "done"


def test_falha_no_pre_processamento_marca_a_etapa_certa(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(3300))

    async def progress() -> None:
        queue = await Queue.connect(services.settings.redis_url)
        try:
            await queue.pool.hset(progress_key(recording["id"]), mapping={"stage": "preprocess", "pct": "5"})
        finally:
            await queue.close()

    run(progress())
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["job"]["stage"] == "preprocessing"
    assert _step(body, "preprocessing")["state"] == "active"

    run_gpu(services.settings, fail=True, fail_stage="preprocess", failure=("audio_decode_failed", "não abre"))
    run_cpu(services.settings)
    body = api.get(f"/api/v1/recordings/{recording['id']}").json()
    assert _step(body, "preprocessing")["error"] == {"code": "audio_decode_failed", "message": "não abre"}
    assert _step(body, "transcription")["state"] == "pending"
