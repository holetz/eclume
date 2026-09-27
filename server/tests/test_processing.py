"""Processamento automático depois da transcrição: campos, tipo de agenda e resumo pelo tipo."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from eclume_server.agents import base as codes
from eclume_server.agents.base import ProviderError
from eclume_server.agents.extraction import DETECT_SYSTEM, FIELDS_SYSTEM
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import FakeAgents, run_cpu, run_gpu

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

CLAUDE = {"name": "Claude (servidor)", "kind": "claude-cli", "model": "sonnet"}
CLIENT = {"name": "Cliente", "kind": "choice", "options": ["Serra Azul", "Vale Verde"], "instructions": "A empresa."}


@pytest.fixture
def user(admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]) -> Api:
    """Um usuário numa plataforma com um provider para todas as finalidades."""
    assert admin.post("/api/v1/admin/agent-providers", json=CLAUDE).status_code == 201
    return as_user(make_user())


def _process(api: Api, services: Services, agents: FakeAgents, **fields: Any) -> dict[str, Any]:  # noqa: ANN401
    recording = upload_file(api, audio_bytes(2100), **fields)
    run_gpu(services.settings)
    run_cpu(services.settings, agents)
    return api.get(f"/api/v1/recordings/{recording['id']}").json()


def _values(api: Api, recording_id: str) -> dict[str, dict[str, Any]]:
    items = api.get(f"/api/v1/recordings/{recording_id}/fields").json()["items"]
    return {item["field"]["key"]: item for item in items}


def _step(recording: dict[str, Any], name: str) -> dict[str, Any]:
    return next(step for step in recording["pipeline"] if step["step"] == name)


def test_campos_preenchidos_pelo_agente(user: Api, services: Services):
    user.post("/api/v1/fields", json=CLIENT)
    user.post("/api/v1/fields", json={"name": "Pendências", "kind": "list", "instructions": "O que ficou para depois."})
    user.post("/api/v1/fields", json={"name": "Manual", "kind": "text", "auto_fill": False})
    reply = {
        "titulo": "Revisão do contrato de manutenção",
        "tags": ["contrato", "Contrato", "manutenção"],
        "cliente": "Empresa inventada",
        "pendencias": ["enviar proposta", 3, ""],
        "manual": "não pedido",
    }
    agents = FakeAgents(replies={"fields": [json.dumps(reply)]})
    recording = _process(user, services, agents)

    ((config, system, prompt),) = agents.of("fields")
    assert (config.name, system) == ("Claude (servidor)", FIELDS_SYSTEM)
    assert "- cliente (escolha, opções: Serra Azul | Vale Verde): A empresa." in prompt
    assert "- pendencias (lista): O que ficou para depois." in prompt
    assert "manual" not in prompt
    assert "<transcricao>" in prompt

    # O tipo detectado (o primeiro, pela resposta padrão) aplica o padrão de título e as tags dele.
    assert recording["title"] == "Reunião de equipe · Revisão do contrato de manutenção"
    assert recording["tags"] == ["contrato", "Contrato", "manutenção", "interno", "planejamento"]
    values = _values(user, recording["id"])
    assert (values["titulo"]["origin"], values["tags"]["origin"]) == ("auto", "auto")
    # Escolha fora das opções vira "nada encontrado"; da lista, só os textos.
    assert (values["cliente"]["value"], values["cliente"]["origin"]) == (None, "auto")
    assert values["pendencias"]["value"] == ["enviar proposta"]
    assert (values["manual"]["value"], values["manual"]["origin"]) == (None, None)
    fields_step = _step(recording, "fields")
    assert (fields_step["state"], fields_step["error"]) == ("done", None)


def test_o_que_o_usuario_escreveu_nao_e_sobrescrito(user: Api, services: Services):
    reply = json.dumps({"titulo": "Outro título", "tags": ["automática"]})
    agents = FakeAgents(replies={"fields": [reply]})
    recording = _process(user, services, agents, title="Kickoff com a Serra Azul")
    assert recording["title"] == "Kickoff com a Serra Azul"
    assert recording["tags"] == ["automática", "interno", "planejamento"]
    # O título `edited` nem vai ao agente.
    assert "- titulo" not in agents.of("fields")[0][2]


def test_etapa_pulada_sem_provider_ou_sem_campos(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services, admin: Api
):
    api = as_user(make_user())
    recording = _process(api, services, FakeAgents())
    assert (_step(recording, "fields")["state"], _step(recording, "fields")["reason"]) == ("skipped", "no_provider")

    admin.post("/api/v1/admin/agent-providers", json=CLAUDE)
    for item in api.get("/api/v1/fields").json()["items"]:
        api.patch(f"/api/v1/fields/{item['id']}", json={"auto_fill": False})
    agents = FakeAgents()
    recording = _process(api, services, agents)
    assert _step(recording, "fields")["reason"] == "no_auto_fields"
    assert agents.of("fields") == []


def test_json_invalido_retenta_e_falha_sem_parar_a_cadeia(user: Api, services: Services):
    agents = FakeAgents(replies={"fields": ["não é JSON", '{"titulo": "Segunda tentativa"}']})
    recording = _process(user, services, agents)
    assert recording["title"] == "Reunião de equipe · Segunda tentativa"
    assert len(agents.of("fields")) == 2

    down = ProviderError(codes.PROVIDER_UNAVAILABLE, "fora do ar")
    agents = FakeAgents(errors=[down, down, down])
    recording = _process(user, services, agents)
    step = _step(recording, "fields")
    assert (step["state"], step["error"]) == ("failed", {"code": "provider_unavailable", "message": "fora do ar"})
    assert len(agents.of("fields")) == 3

    auth = ProviderError(codes.PROVIDER_AUTH, "Not logged in")
    agents = FakeAgents(errors=[auth])
    recording = _process(user, services, agents)
    assert _step(recording, "fields")["error"]["code"] == "provider_auth"
    assert len(agents.of("fields")) == 1
    # A cadeia seguiu: o tipo e o resumo saíram mesmo com os campos falhos.
    assert (_step(recording, "agenda_type")["state"], _step(recording, "summary")["state"]) == ("done", "done")


def test_retranscricao_recalcula_o_automatico_e_mantem_o_aceito(user: Api, services: Services):
    field = user.post("/api/v1/fields", json=CLIENT).json()
    first = json.dumps({"titulo": "Primeiro", "cliente": "Serra Azul", "tags": ["a"]})
    recording = _process(user, services, FakeAgents(replies={"fields": [first]}))
    user.post(f"/api/v1/recordings/{recording['id']}/fields/{field['id']}/accept")

    user.post(f"/api/v1/recordings/{recording['id']}/retranscribe")
    run_gpu(services.settings)
    second = json.dumps({"titulo": "Segundo", "cliente": "Vale Verde", "tags": ["b"]})
    agents = run_cpu(services.settings, FakeAgents(replies={"fields": [second]}))
    values = _values(user, recording["id"])
    assert (values["titulo"]["value"], values["tags"]["value"]) == (
        "Reunião de equipe · Segundo",
        ["b", "interno", "planejamento"],
    )
    assert (values["cliente"]["value"], values["cliente"]["origin"]) == ("Serra Azul", "accepted")
    assert "- cliente" not in agents.of("fields")[0][2]


# --- tipo de agenda e resumo pelo tipo --------------------------------------------------------------


def _types(api: Api) -> dict[str, dict[str, Any]]:
    return {item["name"]: item for item in api.get("/api/v1/agenda-types").json()["items"]}


def test_deteccao_aplica_o_tipo_e_o_resumo_segue_as_instrucoes_dele(user: Api, services: Services):
    types = _types(user)
    user.patch(
        f"/api/v1/agenda-types/{types['Conversa com cliente']['id']}",
        json={"title_pattern": "{cliente} · {assunto} · {data}", "default_tags": ["cliente"]},
    )
    user.post("/api/v1/fields", json=CLIENT)
    detection = json.dumps({"tipo": "T3", "confianca": 1.7, "motivo": "Fala com a Serra Azul."})
    fields = json.dumps({"titulo": "Proposta de manutenção", "cliente": "Serra Azul", "tags": ["proposta"]})
    agents = FakeAgents(replies={"fields": [fields], "agenda_detection": [detection]})
    recording = _process(user, services, agents, recorded_at="2026-09-18T14:00:05Z")

    ((_, system, prompt),) = agents.of("agenda_detection")
    assert system == DETECT_SYSTEM
    assert "- T1: Reunião de equipe. Reunião recorrente da equipe interna" in prompt
    assert "- T3: Conversa com cliente. Conversa com alguém de fora da equipe" in prompt
    assert recording["agenda_type"] == {
        "id": types["Conversa com cliente"]["id"],
        "name": "Conversa com cliente",
        "origin": "auto",
    }
    assert recording["title"] == "Serra Azul · Proposta de manutenção · 18/09/2026"
    assert recording["tags"] == ["proposta", "cliente"]
    # O título com o padrão continua automático.
    values = _values(user, recording["id"])
    assert (values["titulo"]["value"], values["titulo"]["origin"]) == (recording["title"], "auto")

    summary_prompt = agents.of("summaries")[-1][2]
    assert "## Pedidos do cliente" in summary_prompt
    summaries = user.get(f"/api/v1/transcripts/{recording['transcript_id']}/summaries").json()["items"]
    assert [(s["trigger"], s["status"], s["agenda_type"]["name"]) for s in summaries] == [
        ("automatic", "done", "Conversa com cliente")
    ]
    assert {step["state"] for step in recording["pipeline"]} == {"done"}


def test_tipo_do_usuario_nao_e_trocado_e_sem_tipos_nao_ha_resumo(user: Api, services: Services):
    agents = FakeAgents()
    recording = upload_file(user, audio_bytes(2200))
    one_on_one = _types(user)["1:1"]
    user.patch(f"/api/v1/recordings/{recording['id']}", json={"agenda_type_id": one_on_one["id"]})
    run_gpu(services.settings)
    run_cpu(services.settings, agents)
    body = user.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["agenda_type"]["origin"] == "edited"
    assert (_step(body, "agenda_type")["state"], _step(body, "agenda_type")["reason"]) == ("skipped", "set_by_user")
    assert agents.of("agenda_detection") == []
    assert "## Combinados" in agents.of("summaries")[-1][2]

    for item in _types(user).values():
        user.delete(f"/api/v1/agenda-types/{item['id']}")
    body = _process(user, services, FakeAgents())
    assert _step(body, "agenda_type")["reason"] == "no_types"
    assert (_step(body, "summary")["state"], _step(body, "summary")["reason"]) == ("skipped", "no_agenda_type")


def test_tipo_fora_da_lista_retenta(user: Api, services: Services):
    agents = FakeAgents(replies={"agenda_detection": ['{"tipo": "T9"}', '{"tipo": "T2", "confianca": 0.4}']})
    recording = _process(user, services, agents)
    assert recording["agenda_type"]["name"] == "1:1"
    assert len(agents.of("agenda_detection")) == 2


def test_trocar_o_tipo_a_mao_gera_um_resumo_novo(user: Api, services: Services):
    agents = FakeAgents(replies={"fields": ['{"titulo": "Planejamento do trimestre"}']})
    recording = _process(user, services, agents)
    assert recording["title"] == "Reunião de equipe · Planejamento do trimestre"
    client = _types(user)["Conversa com cliente"]
    changed = user.patch(f"/api/v1/recordings/{recording['id']}", json={"agenda_type_id": client["id"]})
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert body["agenda_type"] == {"id": client["id"], "name": "Conversa com cliente", "origin": "edited"}
    assert _step(body, "summary")["state"] == "active"
    agents = run_cpu(services.settings)
    summaries = user.get(f"/api/v1/transcripts/{recording['transcript_id']}/summaries").json()["items"]
    assert [(s["agenda_type"]["name"], s["trigger"], s["status"]) for s in summaries] == [
        ("Conversa com cliente", "automatic", "done"),
        ("Reunião de equipe", "automatic", "done"),
    ]
    assert "## Pedidos do cliente" in agents.calls[-1][2]
    assert _step(user.get(f"/api/v1/recordings/{recording['id']}").json(), "summary")["state"] == "done"
