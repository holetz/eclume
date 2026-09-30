"""Processamento automático depois da transcrição: campos, tipo de agenda e resumo pelo tipo."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text

from eclume_server import agenda_types as agenda_types_module
from eclume_server import fields as fields_module
from eclume_server.agents import base as codes
from eclume_server.agents.base import ProviderError
from eclume_server.agents.extraction import DETECT_SYSTEM, FIELDS_SYSTEM
from eclume_server.agents.prompting import SHARED_SYSTEM
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import FakeAgents, run_cpu, run_gpu
from eclume_server_testing.harness import run

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


async def _detail(conn: Any, recording_id: str, step: str) -> dict[str, Any]:  # noqa: ANN401
    """A `detail` da etapa na maior revisão (a API mostra só o motivo e o erro)."""
    query = text(
        "SELECT detail FROM pipeline_steps WHERE recording_id = :r AND step = :s ORDER BY revision DESC LIMIT 1"
    )
    return (await conn.execute(query, {"r": recording_id, "s": step})).scalar_one()


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
    assert (config.name, system) == ("Claude (servidor)", SHARED_SYSTEM)
    assert FIELDS_SYSTEM in prompt
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


def test_tag_automatica_tem_o_teto_das_tags_padrao(user: Api, services: Services):
    reply = json.dumps({"tags": ["t" * 100, "curta"]})
    recording = _process(user, services, FakeAgents(replies={"fields": [reply]}))
    assert recording["tags"][:2] == ["t" * 64, "curta"]


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
    agents = FakeAgents(failures={"fields": [down, down, down]})
    recording = _process(user, services, agents)
    step = _step(recording, "fields")
    assert (step["state"], step["error"]) == ("failed", {"code": "provider_unavailable", "message": "fora do ar"})
    assert len(agents.of("fields")) == 3

    auth = ProviderError(codes.PROVIDER_AUTH, "Not logged in")
    agents = FakeAgents(failures={"fields": [auth]})
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


def test_tipo_do_usuario_nao_e_trocado_e_sem_outros_tipos_fica_o_padrao(user: Api, services: Services):
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
    assert list(_types(user)) == ["Geral"]
    agents = FakeAgents()
    body = _process(user, services, agents)
    assert _step(body, "agenda_type")["reason"] == "no_types"
    assert agents.of("agenda_detection") == []
    # Sem outros tipos, a gravação fica com o tipo padrão e tem resumo pelas instruções dele.
    assert body["agenda_type"]["name"] == "Geral"
    assert _step(body, "summary")["state"] == "done"
    assert "## Próximos passos" in agents.of("summaries")[-1][2]


def test_tipo_fora_da_lista_retenta(user: Api, services: Services):
    agents = FakeAgents(replies={"agenda_detection": ['{"tipo": "T9"}', '{"tipo": "T2", "confianca": 0.8}']})
    recording = _process(user, services, agents)
    assert recording["agenda_type"]["name"] == "1:1"
    assert len(agents.of("agenda_detection")) == 2
    # O tipo padrão não concorre: a lista do agente tem só os outros.
    assert "Geral" not in agents.of("agenda_detection")[0][2]


@pytest.mark.parametrize(
    ("reply", "candidate"),
    [
        ('{"tipo": null, "confianca": 0.9, "motivo": "nenhum serve"}', None),
        ('{"tipo": "T2", "confianca": 0.4, "motivo": "talvez 1:1"}', "1:1"),
    ],
)
def test_nenhum_tipo_ou_pouca_confianca_fica_o_padrao(user: Api, services: Services, reply: str, candidate: str | None):
    agents = FakeAgents(replies={"agenda_detection": [reply]})
    recording = _process(user, services, agents)
    assert recording["agenda_type"] == {"id": _types(user)["Geral"]["id"], "name": "Geral", "origin": "auto"}
    assert _step(recording, "agenda_type")["state"] == "done"
    detail = run(services.sql(lambda conn: _detail(conn, recording["id"], "agenda_type")))
    assert (detail["fallback"], detail["candidate_name"]) == (True, candidate)
    # O resumo sai pelas instruções do tipo padrão, e o título pelo padrão dele (`{assunto}`).
    assert _step(recording, "summary")["state"] == "done"
    assert "## Próximos passos" in agents.of("summaries")[-1][2]


def test_detecao_falha_fica_o_padrao(user: Api, services: Services):
    down = ProviderError(codes.PROVIDER_AUTH, "Not logged in")
    recording = _process(user, services, FakeAgents(failures={"agenda_detection": [down]}))
    assert _step(recording, "agenda_type")["state"] == "failed"
    assert recording["agenda_type"]["name"] == "Geral"
    assert _step(recording, "summary")["state"] == "done"


def test_o_assunto_do_titulo_segue_a_regra_do_tipo(user: Api, services: Services):
    types = _types(user)
    team = types["Reunião de equipe"]
    user.patch(f"/api/v1/agenda-types/{team['id']}", json={"title_instructions": "O projeto discutido, em 3 palavras."})
    agents = FakeAgents(replies={"fields": ['{"titulo": "Projeto Aurora"}']})
    recording = _process(user, services, agents)
    assert recording["title"] == "Reunião de equipe · Projeto Aurora"
    fields_prompt = agents.of("fields")[0][2]
    assert "O projeto discutido, em 3 palavras." in fields_prompt
    # Sem regra própria, vale a do tipo padrão.
    user.patch(f"/api/v1/agenda-types/{types['Geral']['id']}", json={"title_instructions": "Regra do Geral."})
    user.patch(f"/api/v1/agenda-types/{team['id']}", json={"title_instructions": ""})
    agents = FakeAgents()
    _process(user, services, agents)
    assert "Regra do Geral." in agents.of("fields")[0][2]


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


def test_reaplicar_o_padrao_nao_aninha_o_titulo(user: Api, services: Services):
    # Sem título automático, o assunto é o título de antes do primeiro padrão (o nome do arquivo).
    title_field = next(item for item in user.get("/api/v1/fields").json()["items"] if item["builtin"] == "title")
    user.patch(f"/api/v1/fields/{title_field['id']}", json={"auto_fill": False})
    types = _types(user)
    client = types["Conversa com cliente"]
    user.patch(f"/api/v1/agenda-types/{client['id']}", json={"title_pattern": "Cliente · {assunto}"})
    recording = _process(user, services, FakeAgents())
    assert recording["title"] == "Reunião de equipe · reuniao"

    path = f"/api/v1/recordings/{recording['id']}"
    assert user.patch(path, json={"agenda_type_id": client["id"]}).json()["title"] == "Cliente · reuniao"
    back = user.patch(path, json={"agenda_type_id": types["Reunião de equipe"]["id"]}).json()
    assert back["title"] == "Reunião de equipe · reuniao"
    run_cpu(services.settings)


def test_o_mesmo_tipo_de_novo_nao_duplica_o_resumo_automatico(user: Api, services: Services):
    recording = _process(user, services, FakeAgents())
    detected = recording["agenda_type"]
    path = f"/api/v1/recordings/{recording['id']}"
    # Confirmar o tipo detectado (vira `edited`) não gera outro resumo pelo mesmo tipo.
    same = user.patch(path, json={"agenda_type_id": detected["id"]}).json()
    assert same["agenda_type"]["origin"] == "edited"
    client = _types(user)["Conversa com cliente"]
    user.patch(path, json={"agenda_type_id": client["id"]})
    user.patch(path, json={"agenda_type_id": client["id"]})
    run_cpu(services.settings)
    summaries = user.get(f"/api/v1/transcripts/{recording['transcript_id']}/summaries").json()["items"]
    assert sorted(s["agenda_type"]["name"] for s in summaries) == ["Conversa com cliente", "Reunião de equipe"]


def test_falha_inesperada_fora_do_agente_marca_a_etapa_e_segue(
    user: Api, services: Services, monkeypatch: pytest.MonkeyPatch
):
    def boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError

    monkeypatch.setattr(fields_module, "known_tags", boom)
    monkeypatch.setattr(agenda_types_module, "apply_type", boom)
    recording = _process(user, services, FakeAgents())
    for name in ("fields", "agenda_type"):
        step = _step(recording, name)
        assert (step["state"], step["error"]["code"]) == ("failed", "internal_error"), name
    # A cadeia chegou ao resumo: sem tipo aplicado, ele sai pulado.
    assert (_step(recording, "summary")["state"], _step(recording, "summary")["reason"]) == (
        "skipped",
        "no_agenda_type",
    )


def test_resumo_automatico_apagado_antes_de_gerar_fecha_a_etapa(user: Api, services: Services):
    recording = _process(user, services, FakeAgents())
    client = _types(user)["Conversa com cliente"]
    path = f"/api/v1/recordings/{recording['id']}"
    assert _step(user.patch(path, json={"agenda_type_id": client["id"]}).json(), "summary")["state"] == "active"
    summaries = user.get(f"/api/v1/transcripts/{recording['transcript_id']}/summaries").json()["items"]
    queued = next(s for s in summaries if s["agenda_type"]["name"] == "Conversa com cliente")
    assert user.delete(f"/api/v1/summaries/{queued['id']}").status_code == 204
    run_cpu(services.settings)
    step = _step(user.get(path).json(), "summary")
    assert (step["state"], step["reason"]) == ("skipped", "summary_deleted")


def test_colecoes_automaticas_pela_regra_com_participantes(user: Api, services: Services):
    rule = "Reuniões em que participa alguém da empresa Agro Sul."
    agro = user.post("/api/v1/collections", json={"name": "Agro Sul", "instructions": rule, "auto_assign": True}).json()
    manual = user.post("/api/v1/collections", json={"name": "Manual", "instructions": "Nunca.", "auto_assign": False})
    empty = user.post("/api/v1/collections", json={"name": "Sem regra", "auto_assign": True}).json()
    kept = user.post("/api/v1/collections", json={"name": "Do envio"}).json()

    # Sem participantes ainda: o agente vê as coleções automáticas com regra e escolhe a primeira.
    agents = FakeAgents(replies={"fields": ['{"colecoes": ["C1", "C9", "x"]}']})
    recording = _process(user, services, agents, collection_ids=[kept["id"]])
    prompt = agents.of("fields")[0][2]
    assert f"- C1: Agro Sul — {rule}" in prompt
    assert "Manual" not in prompt
    assert "Sem regra" not in prompt
    assert "## Tipo de agenda da gravação\n\nReunião de equipe" in prompt
    assert recording["collection_ids"] == [kept["id"], agro["id"]]
    assert recording["collections_origin"] == "auto"
    assert manual.status_code == 201
    assert empty["auto_assign"] is True

    # Com um participante ligado, a retranscrição leva os dados dele ao prompt; a escolha nova troca
    # as automáticas e mantém a do envio.
    person = user.post(
        "/api/v1/people",
        json={"name": "Bruna Reis", "company": "Agro Sul", "department": "Compras", "tags": ["cliente"]},
    ).json()
    linked = user.patch(
        f"/api/v1/transcripts/{recording['transcript_id']}/speakers/S1", json={"person_id": person["id"]}
    )
    assert linked.status_code == 200, linked.text
    user.post(f"/api/v1/recordings/{recording['id']}/retranscribe")
    run_gpu(services.settings)
    agents = run_cpu(services.settings, FakeAgents(replies={"fields": ['{"colecoes": []}']}))
    prompt = agents.of("fields")[0][2]
    assert "- Bruna Reis — empresa: Agro Sul; área: Compras; tags: cliente" in prompt
    body = user.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["collection_ids"] == [kept["id"]]

    # O usuário mexeu: o agente não toca mais, e as coleções nem vão ao prompt.
    user.patch(f"/api/v1/recordings/{recording['id']}", json={"collection_ids": [agro["id"]]})
    user.post(f"/api/v1/recordings/{recording['id']}/retranscribe")
    run_gpu(services.settings)
    agents = run_cpu(services.settings, FakeAgents(replies={"fields": ['{"colecoes": ["C1"]}']}))
    assert "## Coleções" not in agents.of("fields")[0][2]
    body = user.get(f"/api/v1/recordings/{recording['id']}").json()
    assert (body["collection_ids"], body["collections_origin"]) == ([agro["id"]], "edited")


def test_so_colecoes_automaticas_tambem_chamam_o_agente(user: Api, services: Services):
    for item in user.get("/api/v1/fields").json()["items"]:
        user.patch(f"/api/v1/fields/{item['id']}", json={"auto_fill": False})
    coll = user.post("/api/v1/collections", json={"name": "Tudo", "instructions": "Todas.", "auto_assign": True})
    agents = FakeAgents(replies={"fields": ['{"colecoes": ["C1"]}']})
    recording = _process(user, services, agents)
    assert _step(recording, "fields")["state"] == "done"
    assert recording["collection_ids"] == [coll.json()["id"]]
    assert "## Campos" not in agents.of("fields")[0][2]
