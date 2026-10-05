"""Marcação obrigatória dos locutores (holetz/eclume#144): a etapa `speakers` para a cadeia.

Com a preferência da conta ligada, a ingestão deixa a etapa `waiting` quando algum locutor com fala
suficiente está sem pessoa, e o tipo, os campos e o resumo não rodam; nomear o último, soltar a
gravação ou desligar a preferência retoma a cadeia.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from eclume_server.db.session import make_engine
from eclume_server.resume import resume
from eclume_server_testing.fakes import run_cpu, transcribed
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


def _sql(services: Services, statement: str, **params: Any) -> Any:  # noqa: ANN401
    async def go(conn: Any) -> Any:  # noqa: ANN401
        result = await conn.execute(text(statement), params)
        return result.all() if result.returns_rows else None

    return run(services.sql(go))


def call(client: TestClient, token: str, tool: str, **arguments: Any) -> dict[str, Any]:  # noqa: ANN401
    """`tools/call` no `/mcp`, como em test_mcp.py."""
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": arguments}}
    headers = {"Accept": "application/json, text/event-stream", "Authorization": f"Bearer {token}"}
    client.cookies.clear()
    response = client.post("/mcp", json=body, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["result"]


def _require(services: Services, account: Account, *, on: bool = True) -> None:
    _sql(services, "UPDATE users SET require_speaker_naming = :on WHERE id = :id", on=on, id=account.user_id)


def _steps(recording: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {step["step"]: step for step in recording["pipeline"]}


def _recording(api: Api, recording_id: str) -> dict[str, Any]:
    return api.get(f"/api/v1/recordings/{recording_id}").json()


def test_preferencia_desligada_segue_a_cadeia_como_antes(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = transcribed(api, services.settings)
    steps = _steps(recording)
    assert [step["step"] for step in recording["pipeline"]] == [
        "received",
        "preprocessing",
        "transcription",
        "speakers",
        "agenda_type",
        "fields",
        "summary",
    ]
    assert steps["speakers"]["state"] == "done"
    assert steps["speakers"]["reason"] is None
    assert steps["agenda_type"]["state"] != "pending"
    assert recording["awaiting"] is None


def test_preferencia_ligada_para_na_espera_dos_locutores(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    api = as_user(account)
    _require(services, account)
    recording = transcribed(api, services.settings)
    steps = _steps(recording)
    assert steps["transcription"]["state"] == "done"
    assert steps["speakers"]["state"] == "waiting"
    assert steps["speakers"]["reason"] == "unnamed_speakers"
    assert steps["speakers"]["finished_at"] is not None
    # Nada da cadeia por agente rodou: tipo, campos e resumo seguem esperando.
    assert [steps[name]["state"] for name in ("agenda_type", "fields", "summary")] == ["pending"] * 3
    assert recording["awaiting"] == "speakers"
    detail = _sql(
        services,
        "SELECT detail FROM pipeline_steps WHERE recording_id = :r AND step = 'speakers'",
        r=recording["id"],
    )
    assert detail[0][0]["unnamed"] == len(api.get(f"/api/v1/transcripts/{recording['transcript_id']}").json()["speakers"])


def test_locutor_com_pouca_fala_nao_prende_a_gravacao(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = transcribed(api, services.settings)
    # Todo locutor abaixo do piso de 10 s de fala: nenhum conta como faltando nome.
    _sql(services, "UPDATE speakers SET talk_ms = 9000 WHERE transcript_id = :t", t=recording["transcript_id"])

    async def check(conn: Any) -> int:  # noqa: ANN401
        from uuid import UUID  # noqa: PLC0415

        from eclume_server.speaker_naming import unnamed_count  # noqa: PLC0415

        return await unnamed_count(conn, UUID(recording["transcript_id"]))

    assert run(services.sql(check)) == 0


def test_retomada_do_cron_nao_relanca_a_gravacao_parada(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    api = as_user(account)
    _require(services, account)
    recording = transcribed(api, services.settings)

    async def sweep() -> list[str]:
        from arq import create_pool  # noqa: PLC0415
        from arq.connections import RedisSettings  # noqa: PLC0415

        pool = await create_pool(RedisSettings.from_dsn(services.settings.redis_url))
        engine = make_engine(services.settings.database_url)
        try:
            return await resume(engine, pool, now=datetime.now(UTC) + timedelta(minutes=10), limit=100_000)
        finally:
            await engine.dispose()
            await pool.aclose()

    relaunched = run(sweep())
    assert not any(item.startswith(recording["id"]) for item in relaunched)
    run_cpu(services.settings)
    assert _steps(_recording(api, recording["id"]))["agenda_type"]["state"] == "pending"


def _speakers(api: Api, recording: dict[str, Any]) -> list[dict[str, Any]]:
    return api.get(f"/api/v1/transcripts/{recording['transcript_id']}").json()["speakers"]


def _link(api: Api, recording: dict[str, Any], speaker_id: str, name: str) -> None:
    person = api.post("/api/v1/people", json={"name": name}).json()
    response = api.patch(
        f"/api/v1/transcripts/{recording['transcript_id']}/speakers/{speaker_id}", json={"person_id": person["id"]}
    )
    assert response.status_code == 200, response.text


def test_preferencia_pela_rota_le_por_pat_e_escreve_so_com_sessao(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    session = as_user(make_user())
    assert session.get("/api/v1/me/speaker-naming").json() == {"required": False, "waiting_count": 0}
    changed = session.patch("/api/v1/me/speaker-naming", json={"required": True})
    assert changed.status_code == 200
    assert changed.json() == {"required": True, "waiting_count": 0}
    pat = session.pat("recordings:read")
    assert pat.get("/api/v1/me/speaker-naming").json()["required"] is True
    assert pat.patch("/api/v1/me/speaker-naming", json={"required": False}).status_code == 403
    assert session.patch("/api/v1/me/speaker-naming", json={"required": "sim"}).status_code == 422
    assert session.patch("/api/v1/me/speaker-naming", json={}).status_code == 422


def test_nomear_o_ultimo_locutor_retoma_a_cadeia(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    api.patch("/api/v1/me/speaker-naming", json={"required": True})
    recording = transcribed(api, services.settings)
    assert api.get("/api/v1/me/speaker-naming").json()["waiting_count"] == 1
    speakers = _speakers(api, recording)
    for index, speaker in enumerate(speakers[:-1]):
        _link(api, recording, speaker["id"], f"Pessoa {index}")
    # Falta um: segue parada, com a contagem atualizada no detalhe.
    run_cpu(services.settings)
    assert _steps(_recording(api, recording["id"]))["speakers"]["state"] == "waiting"
    detail = _sql(
        services,
        "SELECT detail FROM pipeline_steps WHERE recording_id = :r AND step = 'speakers'",
        r=recording["id"],
    )
    assert detail[0][0]["unnamed"] == 1

    # Renomear sem ligar pessoa não conta como nomear.
    last = speakers[-1]["id"]
    api.patch(f"/api/v1/transcripts/{recording['transcript_id']}/speakers/{last}", json={"label": "Visitante"})
    assert _steps(_recording(api, recording["id"]))["speakers"]["state"] == "waiting"

    _link(api, recording, last, "Última pessoa")
    after = _recording(api, recording["id"])
    assert _steps(after)["speakers"]["state"] == "done"
    assert after["awaiting"] is None
    run_cpu(services.settings)
    steps = _steps(_recording(api, recording["id"]))
    assert steps["agenda_type"]["state"] != "pending"
    assert steps["fields"]["state"] != "pending"
    assert steps["summary"]["state"] in {"done", "skipped", "failed"}
    assert api.get("/api/v1/me/speaker-naming").json()["waiting_count"] == 0


def test_mesclar_no_locutor_nomeado_tambem_retoma(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    api.patch("/api/v1/me/speaker-naming", json={"required": True})
    recording = transcribed(api, services.settings)
    first, *others = [speaker["id"] for speaker in _speakers(api, recording)]
    _link(api, recording, first, "Coordenadora")
    merged = api.post(
        f"/api/v1/transcripts/{recording['transcript_id']}/speakers/merge",
        json={"source_speaker_ids": others, "target_speaker_id": first},
    )
    assert merged.status_code == 200, merged.text
    assert _steps(_recording(api, recording["id"]))["speakers"]["state"] == "done"


def test_seguir_sem_nomear_solta_a_gravacao(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    api.patch("/api/v1/me/speaker-naming", json={"required": True})
    recording = transcribed(api, services.settings)
    desktop = api.pat("recordings:write", "recordings:read")
    released = desktop.post(f"/api/v1/recordings/{recording['id']}/continue")
    assert released.status_code == 200, released.text
    step = _steps(released.json())["speakers"]
    assert (step["state"], step["reason"]) == ("skipped", "continued_by_user")
    assert released.json()["awaiting"] is None
    # Fora da espera, soltar de novo é conflito.
    again = desktop.post(f"/api/v1/recordings/{recording['id']}/continue")
    assert again.status_code == 409
    run_cpu(services.settings)
    assert _steps(_recording(api, recording["id"]))["agenda_type"]["state"] != "pending"


def test_continue_de_outra_conta_e_404(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    owner = as_user(make_user())
    owner.patch("/api/v1/me/speaker-naming", json={"required": True})
    recording = transcribed(owner, services.settings)
    other = as_user(make_user())
    assert other.post(f"/api/v1/recordings/{recording['id']}/continue").status_code == 404
    assert _steps(_recording(owner, recording["id"]))["speakers"]["state"] == "waiting"


def test_desligar_a_preferencia_solta_as_paradas(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    api.patch("/api/v1/me/speaker-naming", json={"required": True})
    first = transcribed(api, services.settings)
    second = transcribed(api, services.settings)
    assert api.get("/api/v1/me/speaker-naming").json()["waiting_count"] == 2
    off = api.patch("/api/v1/me/speaker-naming", json={"required": False}).json()
    assert off == {"required": False, "waiting_count": 0}
    for recording in (first, second):
        step = _steps(_recording(api, recording["id"]))["speakers"]
        assert (step["state"], step["reason"]) == ("skipped", "naming_not_required")
    run_cpu(services.settings)
    for recording in (first, second):
        assert _steps(_recording(api, recording["id"]))["agenda_type"]["state"] != "pending"


def test_awaiting_na_gravacao_no_filtro_da_biblioteca_e_no_mcp(
    client: TestClient, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    ready = transcribed(api, services.settings)
    api.patch("/api/v1/me/speaker-naming", json={"required": True})
    parked = transcribed(api, services.settings)
    assert ready["awaiting"] is None
    assert parked["awaiting"] == "speakers"

    listed = api.get("/api/v1/recordings", params={"awaiting": "speakers"}).json()["items"]
    assert [item["id"] for item in listed] == [parked["id"]]
    everything = api.get("/api/v1/recordings").json()["items"]
    assert {item["id"] for item in everything} == {ready["id"], parked["id"]}
    assert api.get("/api/v1/recordings", params={"awaiting": "outra"}).status_code == 422

    # Outra conta não vê a gravação parada de ninguém.
    other = as_user(make_user())
    assert other.get("/api/v1/recordings", params={"awaiting": "speakers"}).json()["items"] == []

    token = api.pat("recordings:read").token
    assert token is not None
    found = call(client, token, "search_recordings", awaiting="speakers")["structuredContent"]["recordings"]
    assert [(item["id"], item["awaiting"]) for item in found] == [(parked["id"], "speakers")]
    detail = call(client, token, "get_recording", recording_id=parked["id"])["structuredContent"]
    assert detail["awaiting"] == "speakers"
    assert {step["step"]: step["state"] for step in detail["pipeline"]}["speakers"] == "waiting"
