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

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


def _sql(services: Services, statement: str, **params: Any) -> Any:  # noqa: ANN401
    async def go(conn: Any) -> Any:  # noqa: ANN401
        result = await conn.execute(text(statement), params)
        return result.all() if result.returns_rows else None

    return run(services.sql(go))


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
