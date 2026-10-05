"""As habilidades na conversa e as ações do Agente: proposta, confirmação, execução e auditoria."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text

from eclume_server.agents.agent import AGENT_SYSTEM_PREFIX
from eclume_server_testing.fakes import FakeAgents, run_cpu, transcribed
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

CLAUDE = {"name": "Claude (servidor)", "kind": "claude-cli", "model": "sonnet"}
SESSIONS = "/api/v1/agent/sessions"
ACTIONS = "/api/v1/agent/actions"


def _json(**action: Any) -> str:  # noqa: ANN401
    return json.dumps(action, ensure_ascii=False)


def _sql(services: Services, statement: str, **params: Any) -> Any:  # noqa: ANN401
    async def go(conn: Any) -> Any:  # noqa: ANN401
        result = await conn.execute(text(statement), params)
        return result.all() if result.returns_rows else None

    return run(services.sql(go))


@pytest.fixture
def user(admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]) -> Api:
    assert admin.post("/api/v1/admin/agent-providers", json=CLAUDE).status_code == 201
    return as_user(make_user())


def _turn(
    api: Api,
    services: Services,
    replies: list[str],
    message: str = "Faça isso",
    **body: Any,  # noqa: ANN401
) -> dict[str, Any]:
    session = api.post(SESSIONS, json={}).json()
    created = api.post(f"{SESSIONS}/{session['id']}/messages", json={"message": message, **body})
    assert created.status_code == 202, created.text
    run_cpu(services.settings, FakeAgents(replies={"agent": replies}))
    answer = created.json()["answer"]
    done = api.get(f"{SESSIONS}/{session['id']}/messages/{answer['id']}").json()
    assert done["status"] == "done", done
    return {"session": session, "question": created.json()["question"], "answer": done}


def _propose_tags(api: Api, services: Services) -> dict[str, Any]:
    turn = _turn(
        api,
        services,
        [
            _json(action="tag_recordings", targets={"tag": "cliente-aurora"}, add=["auditoria"]),
            _json(action="reply", message="Proponho aplicar a tag auditoria; confirme no cartão."),
        ],
        "Ponha a tag auditoria nas gravações da Aurora",
    )
    [action] = turn["answer"]["actions"]
    return turn | {"action": action}


def test_proposta_confirmada_executa_uma_vez_e_fica_na_auditoria(user: Api, services: Services):
    first = transcribed(user, services.settings, tags=["cliente-aurora"])
    second = transcribed(user, services.settings, tags=["cliente-aurora"])
    transcribed(user, services.settings, tags=["outro"])
    turn = _propose_tags(user, services)
    action = turn["action"]
    assert (action["tool"], action["status"]) == ("tag_recordings", "proposed")
    assert action["summary"] == 'Nas tags de 2 gravações: aplicar "auditoria".'
    assert {item["recording_id"] for item in action["targets"]} == {first["id"], second["id"]}
    # Nada mudou antes da confirmação.
    assert "auditoria" not in user.get(f"/api/v1/recordings/{first['id']}").json()["tags"]

    confirmed = user.post(f"{ACTIONS}/{action['id']}/confirm")
    assert confirmed.status_code == 202, confirmed.text
    assert confirmed.json()["status"] == "queued"
    again = user.post(f"{ACTIONS}/{action['id']}/confirm")
    assert (again.status_code, again.json()["status"]) == (202, "queued")
    run_cpu(services.settings, FakeAgents())

    done = user.get(f"{ACTIONS}/{action['id']}").json()
    assert done["status"] == "done"
    assert done["counts"] == {"done": 2, "skipped": 0, "failed": 0, "pending": 0}
    assert done["confirmed_via"] == "session"
    for recording in (first, second):
        assert user.get(f"/api/v1/recordings/{recording['id']}").json()["tags"] == ["cliente-aurora", "auditoria"]
    assert user.post(f"{ACTIONS}/{action['id']}/confirm").json()["status"] == "done"
    assert user.post(f"{ACTIONS}/{action['id']}/cancel").status_code == 409

    # A auditoria sobrevive à conversa.
    assert user.delete(f"{SESSIONS}/{turn['session']['id']}").status_code == 204
    [audited] = user.get(ACTIONS).json()["items"]
    assert (audited["id"], audited["session_id"], audited["status"]) == (action["id"], None, "done")


def test_execucao_retomada_pula_os_alvos_ja_feitos(user: Api, services: Services):
    first = transcribed(user, services.settings, tags=["cliente-aurora"])
    second = transcribed(user, services.settings, tags=["cliente-aurora"])
    action = _propose_tags(user, services)["action"]
    assert user.post(f"{ACTIONS}/{action['id']}/confirm").status_code == 202
    # Como se uma execução anterior tivesse feito o primeiro alvo e caído.
    _sql(
        services,
        'UPDATE agent_actions SET results = jsonb_build_object(CAST(:rid AS text), \'{"status": "done"}\'::jsonb)'
        " WHERE id = :id",
        rid=first["id"],
        id=action["id"],
    )
    run_cpu(services.settings, FakeAgents())
    done = user.get(f"{ACTIONS}/{action['id']}").json()
    assert done["status"] == "done"
    assert "auditoria" not in user.get(f"/api/v1/recordings/{first['id']}").json()["tags"]
    assert "auditoria" in user.get(f"/api/v1/recordings/{second['id']}").json()["tags"]


def test_regenerar_resumos_abre_um_resumo_por_alvo(user: Api, services: Services):
    recording = transcribed(user, services.settings)
    count = "SELECT count(*) FROM summaries s JOIN transcripts t ON t.id = s.transcript_id WHERE t.recording_id = :id"
    before = _sql(services, count, id=recording["id"])[0][0]
    turn = _turn(
        user,
        services,
        [
            _json(action="regenerate_summaries", targets={"recording_ids": [recording["id"]]}),
            _json(action="reply", message="Proponho regenerar 1 resumo."),
        ],
    )
    [action] = turn["answer"]["actions"]
    assert action["summary"].startswith("Gerar de novo o resumo de 1 gravação")
    assert user.post(f"{ACTIONS}/{action['id']}/confirm").status_code == 202
    run_cpu(services.settings, FakeAgents())
    done = user.get(f"{ACTIONS}/{action['id']}").json()
    assert done["status"] == "done"
    [target] = done["targets"]
    assert target["result"]["status"] == "done"
    assert target["result"]["summary_id"]
    after = _sql(services, count, id=recording["id"])[0][0]
    assert after == before + 1


def test_tipo_inexistente_nao_vira_proposta(user: Api, services: Services):
    transcribed(user, services.settings, tags=["cliente-aurora"])
    turn = _turn(
        user,
        services,
        [
            _json(action="set_agenda_type", targets={"tag": "cliente-aurora"}, agenda_type="Tipo que não existe"),
            _json(action="reply", message="Esse tipo não existe."),
        ],
    )
    assert turn["answer"]["actions"] == []


def test_descartar_vencer_e_escopo_do_pat(user: Api, services: Services):
    transcribed(user, services.settings, tags=["cliente-aurora"])
    discarded = _propose_tags(user, services)["action"]
    cancelled = user.post(f"{ACTIONS}/{discarded['id']}/cancel")
    assert (cancelled.status_code, cancelled.json()["status"]) == (200, "cancelled")
    refused = user.post(f"{ACTIONS}/{discarded['id']}/confirm")
    assert (refused.status_code, refused.json()["code"]) == (409, "action_cancelled")

    old = _propose_tags(user, services)["action"]
    _sql(services, "UPDATE agent_actions SET created_at = now() - interval '25 hours' WHERE id = :id", id=old["id"])
    assert user.get(f"{ACTIONS}/{old['id']}").json()["status"] == "expired"
    expired = user.post(f"{ACTIONS}/{old['id']}/confirm")
    assert (expired.status_code, expired.json()["code"]) == (409, "action_expired")

    fresh = _propose_tags(user, services)["action"]
    reader = user.pat("summaries:read")
    assert reader.post(f"{ACTIONS}/{fresh['id']}/confirm").status_code == 403
    writer = user.pat("summaries:read", "recordings:write", name="escrita")
    confirmed = writer.post(f"{ACTIONS}/{fresh['id']}/confirm")
    assert (confirmed.status_code, confirmed.json()["confirmed_via"]) == (202, "pat")


def test_outra_conta_nao_ve_nem_confirma(
    user: Api, services: Services, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    transcribed(user, services.settings, tags=["cliente-aurora"])
    action = _propose_tags(user, services)["action"]
    stranger = as_user(make_user())
    assert stranger.get(f"{ACTIONS}/{action['id']}").status_code == 404
    assert stranger.post(f"{ACTIONS}/{action['id']}/confirm").status_code == 404
    assert stranger.get(ACTIONS).json()["items"] == []


def test_habilidade_por_barra_ou_pelo_corpo(user: Api, services: Services):
    skill = {
        "name": "ata",
        "description": "Escreve a ata de uma reunião.",
        "instructions": "Liste decisões, prazos e responsáveis.",
        "allowed_tools": ["search_summaries", "read_summary"],
    }
    assert user.post("/api/v1/agent/skills", json=skill).status_code == 201
    agents = FakeAgents(replies={"agent": [_json(action="reply", message="A ata.")]})
    session = user.post(SESSIONS, json={}).json()
    created = user.post(f"{SESSIONS}/{session['id']}/messages", json={"message": "/ata da reunião de ontem"})
    assert created.status_code == 202, created.text
    assert (created.json()["question"]["content"], created.json()["question"]["skill"]) == (
        "da reunião de ontem",
        "ata",
    )
    run_cpu(services.settings, agents)
    [call] = agents.of("agent")
    system = call[1]
    assert system.startswith(AGENT_SYSTEM_PREFIX)
    assert "### Habilidade /ata" in system
    assert "Liste decisões, prazos e responsáveis." in system
    assert "search_transcripts" not in system

    by_body = user.post(f"{SESSIONS}/{session['id']}/messages", json={"message": "Faça a ata", "skill": "ata"})
    assert by_body.json()["question"]["skill"] == "ata"
    run_cpu(services.settings, FakeAgents(replies={"agent": [_json(action="reply", message="Ok.")]}))

    unknown = user.post(f"{SESSIONS}/{session['id']}/messages", json={"message": "/nada faça"})
    assert unknown.status_code == 422
    only_prefix = user.post(f"{SESSIONS}/{session['id']}/messages", json={"message": "/ata"})
    assert only_prefix.status_code == 422


def test_habilidades_ligadas_listadas_ao_agente(user: Api, services: Services):
    for name, enabled in (("ata", True), ("rascunho", False)):
        body = {"name": name, "description": f"Habilidade {name}.", "instructions": "Faça.", "enabled": enabled}
        assert user.post("/api/v1/agent/skills", json=body).status_code == 201
    agents = FakeAgents(replies={"agent": [_json(action="reply", message="Ok.")]})
    session = user.post(SESSIONS, json={}).json()
    assert user.post(f"{SESSIONS}/{session['id']}/messages", json={"message": "Oi"}).status_code == 202
    run_cpu(services.settings, agents)
    system = agents.of("agent")[0][1]
    assert "- ata: Habilidade ata." in system
    assert "rascunho" not in system
    assert "regenerate_summaries" in system
