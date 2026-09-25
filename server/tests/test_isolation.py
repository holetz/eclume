"""Isolamento: ninguém lê a gravação (nem a transcrição) de outro sem compartilhamento.

Provado duas vezes: pela API (404, sem distinguir "não existe" de "não é visível") e por SQL direto
sob o papel `eclume_app` com `app.org_id`/`app.user_id` fixados — o que a RLS garante mesmo que
uma rota esqueça um filtro.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable
    from uuid import UUID

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

CONTENT_TABLES = ("recordings", "transcription_jobs", "transcripts", "speakers", "segments")


def _as_app(services: Services, org_id: UUID | None, user_id: UUID | None, sql: str, **params: Any) -> Any:  # noqa: ANN401
    """Roda `sql` como `eclume_app` com o contexto de RLS dado; devolve as linhas ou o rowcount."""

    async def go(conn: Any) -> Any:  # noqa: ANN401
        await conn.execute(text("SET LOCAL ROLE eclume_app"))
        if org_id is not None:
            await conn.execute(
                text("SELECT set_config('app.org_id', :org, true), set_config('app.user_id', :user, true)"),
                {"org": str(org_id), "user": str(user_id)},
            )
        result = await conn.execute(text(sql), params)
        return [tuple(row) for row in result] if result.returns_rows else result.rowcount

    return run(services.sql(go))


def _visible(services: Services, account: Account, recording_id: str) -> dict[str, int]:
    counts = {}
    for table in CONTENT_TABLES:
        column = "id" if table == "recordings" else "recording_id"
        if table in {"speakers", "segments"}:
            sql = (
                f"SELECT count(*) FROM {table} x JOIN transcripts t ON t.id = x.transcript_id WHERE t.recording_id = :r"  # noqa: S608
            )
        else:
            sql = f"SELECT count(*) FROM {table} WHERE {column} = :r"  # noqa: S608
        counts[table] = _as_app(services, account.org_id, account.user_id, sql, r=recording_id)[0][0]
    return counts


@pytest.fixture
def scenario(
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    make_org: Callable[[], UUID],
    services: Services,
) -> dict[str, Any]:
    alice = make_user(name="Alice")
    bob = make_user(name="Bob")
    carol = make_user(name="Carol")
    admin = make_user(role="admin")
    dave = make_user(role="admin", org_id=make_org(), name="Dave")
    apis = {a.name: as_user(a) for a in (alice, bob, carol, dave)}
    admin_api = as_user(admin)
    group = admin_api.post("/api/v1/groups", json={"name": "Consultores"}).json()
    admin_api.put(f"/api/v1/groups/{group['id']}/members/{bob.user_id}")
    recording = upload_file(apis["Alice"], audio_bytes(3000), title="Reunião sigilosa")
    run_gpu(services.settings)
    run_cpu(services.settings)
    recording = apis["Alice"].get(f"/api/v1/recordings/{recording['id']}").json()
    assert recording["status"] == "transcribed"
    return {
        "accounts": {"alice": alice, "bob": bob, "carol": carol, "dave": dave},
        "apis": apis,
        "group": group,
        "recording": recording,
    }


def _api_sees(api: Api, recording: dict[str, Any]) -> bool:
    rid, tid = recording["id"], recording["transcript_id"]
    probes = [
        api.get(f"/api/v1/recordings/{rid}"),
        api.get(f"/api/v1/recordings/{rid}/shares"),
        api.get(f"/api/v1/recordings/{rid}/audio", follow_redirects=False),
        api.get(f"/api/v1/transcripts/{tid}"),
        api.get(f"/api/v1/transcripts/{tid}/export", params={"format": "md"}),
    ]
    statuses = {p.status_code for p in probes}
    assert statuses in ({404}, {200, 302}), statuses
    listed_recordings = [r["id"] for r in api.get("/api/v1/recordings", params={"owner": "all"}).json()["items"]]
    listed_transcripts = [t["id"] for t in api.get("/api/v1/transcripts").json()["items"]]
    assert (rid in listed_recordings) == (tid in listed_transcripts) == (statuses != {404})
    return statuses != {404}


def test_privada_por_padrao_via_api_e_via_sql(scenario: dict[str, Any], services: Services):
    accounts, apis, recording = scenario["accounts"], scenario["apis"], scenario["recording"]
    assert _api_sees(apis["Alice"], recording)
    full = dict.fromkeys(CONTENT_TABLES, 1) | {"speakers": 3, "segments": 12}
    assert _visible(services, accounts["alice"], recording["id"]) == full
    for name in ("bob", "carol", "dave"):
        assert not _api_sees(apis[name.capitalize()], recording), name
        assert _visible(services, accounts[name], recording["id"]) == dict.fromkeys(CONTENT_TABLES, 0), name
    # Escrever por fora também não passa: nada é alterado nem removido.
    rid = recording["id"]
    for name in ("bob", "dave"):
        account = accounts[name]
        assert apis[name.capitalize()].patch(f"/api/v1/recordings/{rid}", json={"title": "x"}).status_code == 404
        assert apis[name.capitalize()].delete(f"/api/v1/recordings/{rid}").status_code == 404
        sql_update = "UPDATE recordings SET title = 'invadido' WHERE id = :r"
        assert _as_app(services, account.org_id, account.user_id, sql_update, r=rid) == 0
        assert _as_app(services, account.org_id, account.user_id, "DELETE FROM recordings WHERE id = :r", r=rid) == 0
    assert apis["Alice"].get(f"/api/v1/recordings/{rid}").json()["title"] == "Reunião sigilosa"


def test_sem_contexto_de_rls_nada_e_visivel(scenario: dict[str, Any], services: Services):
    for table in (*CONTENT_TABLES, "users", "organizations", "api_tokens", "uploads", "groups"):
        assert _as_app(services, None, None, f"SELECT count(*) FROM {table}")[0][0] == 0, table  # noqa: S608
    del scenario


def test_compartilhar_com_grupo_libera_so_os_membros(scenario: dict[str, Any], services: Services):
    accounts, apis, recording = scenario["accounts"], scenario["apis"], scenario["recording"]
    share = apis["Alice"].post(
        f"/api/v1/recordings/{recording['id']}/shares",
        json={"target_type": "group", "target_id": scenario["group"]["id"]},
    )
    assert share.status_code == 201
    assert _api_sees(apis["Bob"], recording)
    assert _visible(services, accounts["bob"], recording["id"])["segments"] == 12
    assert not _api_sees(apis["Carol"], recording)
    assert _visible(services, accounts["carol"], recording["id"]) == dict.fromkeys(CONTENT_TABLES, 0)
    assert not _api_sees(apis["Dave"], recording)

    # Quem só lê não compartilha adiante, nem por SQL.
    bob = accounts["bob"]
    with pytest.raises(DBAPIError, match="row-level security"):
        _as_app(
            services,
            bob.org_id,
            bob.user_id,
            "INSERT INTO recording_shares (org_id, recording_id, target_type, created_by)"
            " VALUES (:org, :r, 'organization', :u)",
            org=str(bob.org_id),
            r=recording["id"],
            u=str(bob.user_id),
        )


def test_compartilhar_com_a_organizacao_nao_vaza_para_outra(scenario: dict[str, Any], services: Services):
    accounts, apis, recording = scenario["accounts"], scenario["apis"], scenario["recording"]
    apis["Alice"].post(f"/api/v1/recordings/{recording['id']}/shares", json={"target_type": "organization"})
    for name in ("bob", "carol"):
        assert _api_sees(apis[name.capitalize()], recording), name
        assert _visible(services, accounts[name], recording["id"])["transcripts"] == 1
    assert not _api_sees(apis["Dave"], recording)
    assert _visible(services, accounts["dave"], recording["id"]) == dict.fromkeys(CONTENT_TABLES, 0)


def test_pat_de_outro_usuario_nao_enxerga_nada(scenario: dict[str, Any]):
    recording = scenario["recording"]
    lumea_da_carol = scenario["apis"]["Carol"].pat("transcripts:read", "recordings:read")
    assert lumea_da_carol.get(f"/api/v1/transcripts/{recording['transcript_id']}").status_code == 404
    assert lumea_da_carol.get("/api/v1/transcripts").json()["items"] == []
