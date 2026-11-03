"""Automatic processing after transcription: fields, agenda type and the summary by type."""

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
    """A user on a platform with one provider for every purpose."""
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
    """The step's `detail` at the highest revision (the API shows only the reason and the error)."""
    query = text(
        "SELECT detail FROM pipeline_steps WHERE recording_id = :r AND step = :s ORDER BY revision DESC LIMIT 1"
    )
    return (await conn.execute(query, {"r": recording_id, "s": step})).scalar_one()


def _step(recording: dict[str, Any], name: str) -> dict[str, Any]:
    return next(step for step in recording["pipeline"] if step["step"] == name)


def test_fields_filled_by_the_agent(user: Api, services: Services):
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
    user.post("/api/v1/tags", json={"name": "contrato", "description": "Contratos e renovações."})
    agents = FakeAgents(replies={"fields": [json.dumps(reply)]})
    recording = _process(user, services, agents)

    ((config, system, prompt),) = agents.of("fields")
    assert (config.name, system) == ("Claude (servidor)", SHARED_SYSTEM)
    assert FIELDS_SYSTEM in prompt
    assert "- cliente (choice, options: Serra Azul | Vale Verde): A empresa." in prompt
    assert "- pendencias (list): O que ficou para depois." in prompt
    assert "manual" not in prompt
    assert "<transcricao>" in prompt
    assert "- contrato — Contratos e renovações." in prompt
    assert "use only tags from this list" in prompt

    # The detected type (the first, by the default reply) applies its title pattern and its tags.
    assert recording["title"] == "Reunião de equipe · Revisão do contrato de manutenção"
    # Fixed tags: "Contrato" is the registered "contrato"; "manutenção" is not in the catalog and is dropped.
    assert recording["tags"] == ["contrato", "interno", "planejamento"]
    values = _values(user, recording["id"])
    assert (values["titulo"]["origin"], values["tags"]["origin"]) == ("auto", "auto")
    # A choice outside the options becomes "nothing found"; from the list, only the texts.
    assert (values["cliente"]["value"], values["cliente"]["origin"]) == (None, "auto")
    assert values["pendencias"]["value"] == ["enviar proposta"]
    assert (values["manual"]["value"], values["manual"]["origin"]) == (None, None)
    fields_step = _step(recording, "fields")
    assert (fields_step["state"], fields_step["error"]) == ("done", None)


def test_what_the_user_wrote_is_not_overwritten(user: Api, services: Services):
    user.patch("/api/v1/me/tag-assignment", json={"mode": "auto"})
    reply = json.dumps({"titulo": "Outro título", "tags": ["automática"]})
    agents = FakeAgents(replies={"fields": [reply]})
    recording = _process(user, services, agents, title="Kickoff com a Serra Azul")
    assert recording["title"] == "Kickoff com a Serra Azul"
    assert recording["tags"] == ["automática", "interno", "planejamento"]
    # The `edited` title does not even go to the agent.
    assert "- titulo" not in agents.of("fields")[0][2]


def test_automatic_tag_has_the_default_tags_ceiling(user: Api, services: Services):
    user.patch("/api/v1/me/tag-assignment", json={"mode": "auto", "new_limit": 2})
    reply = json.dumps({"tags": ["t" * 100, "curta"]})
    recording = _process(user, services, FakeAgents(replies={"fields": [reply]}))
    assert recording["tags"][:2] == ["t" * 64, "curta"]


def test_step_skipped_without_provider_or_without_fields(
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


def test_invalid_json_retries_and_fails_without_stopping_the_chain(user: Api, services: Services):
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
    # The chain went on: the type and the summary came out even with the fields failed.
    assert (_step(recording, "agenda_type")["state"], _step(recording, "summary")["state"]) == ("done", "done")


def test_retranscription_recomputes_the_automatic_and_keeps_the_accepted(user: Api, services: Services):
    field = user.post("/api/v1/fields", json=CLIENT).json()
    for name in ("a", "b"):
        user.post("/api/v1/tags", json={"name": name})
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


# --- agenda type and the summary by type ------------------------------------------------------------


def _types(api: Api) -> dict[str, dict[str, Any]]:
    return {item["name"]: item for item in api.get("/api/v1/agenda-types").json()["items"]}


def test_detection_applies_the_type_and_the_summary_follows_its_instructions(user: Api, services: Services):
    types = _types(user)
    user.patch(
        f"/api/v1/agenda-types/{types['Conversa com cliente']['id']}",
        json={"title_pattern": "{cliente} · {assunto} · {data}", "default_tags": ["cliente"]},
    )
    user.post("/api/v1/fields", json=CLIENT)
    detection = json.dumps({"tipo": "T3", "confianca": 1.7, "motivo": "Fala com a Serra Azul."})
    user.post("/api/v1/tags", json={"name": "proposta"})
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
    # The title with the pattern stays automatic.
    values = _values(user, recording["id"])
    assert (values["titulo"]["value"], values["titulo"]["origin"]) == (recording["title"], "auto")

    summary_prompt = agents.of("summaries")[-1][2]
    assert "## Pedidos do cliente" in summary_prompt
    summaries = user.get(f"/api/v1/transcripts/{recording['transcript_id']}/summaries").json()["items"]
    assert [(s["trigger"], s["status"], s["agenda_type"]["name"]) for s in summaries] == [
        ("automatic", "done", "Conversa com cliente")
    ]
    assert {step["state"] for step in recording["pipeline"]} == {"done"}


def test_user_type_is_not_replaced_and_without_other_types_the_default_stays(user: Api, services: Services):
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
    # Without other types, the recording keeps the default type and gets a summary by its instructions.
    assert body["agenda_type"]["name"] == "Geral"
    assert _step(body, "summary")["state"] == "done"
    assert "## Próximos passos" in agents.of("summaries")[-1][2]


def test_type_outside_the_list_retries(user: Api, services: Services):
    agents = FakeAgents(replies={"agenda_detection": ['{"tipo": "T9"}', '{"tipo": "T2", "confianca": 0.8}']})
    recording = _process(user, services, agents)
    assert recording["agenda_type"]["name"] == "1:1"
    assert len(agents.of("agenda_detection")) == 2
    # The default type does not compete: the agent's list holds only the others.
    assert "Geral" not in agents.of("agenda_detection")[0][2]


@pytest.mark.parametrize(
    ("reply", "candidate"),
    [
        ('{"tipo": null, "confianca": 0.9, "motivo": "nenhum serve"}', None),
        ('{"tipo": "T2", "confianca": 0.4, "motivo": "talvez 1:1"}', "1:1"),
    ],
)
def test_no_type_or_low_confidence_keeps_the_default(user: Api, services: Services, reply: str, candidate: str | None):
    agents = FakeAgents(replies={"agenda_detection": [reply]})
    recording = _process(user, services, agents)
    assert recording["agenda_type"] == {"id": _types(user)["Geral"]["id"], "name": "Geral", "origin": "auto"}
    assert _step(recording, "agenda_type")["state"] == "done"
    detail = run(services.sql(lambda conn: _detail(conn, recording["id"], "agenda_type")))
    assert (detail["fallback"], detail["candidate_name"]) == (True, candidate)
    # The summary follows the default type's instructions, and the title its pattern (`{assunto}`).
    assert _step(recording, "summary")["state"] == "done"
    assert "## Próximos passos" in agents.of("summaries")[-1][2]


def test_failed_detection_keeps_the_default(user: Api, services: Services):
    down = ProviderError(codes.PROVIDER_AUTH, "Not logged in")
    recording = _process(user, services, FakeAgents(failures={"agenda_detection": [down]}))
    assert _step(recording, "agenda_type")["state"] == "failed"
    assert recording["agenda_type"]["name"] == "Geral"
    assert _step(recording, "summary")["state"] == "done"


def test_the_title_subject_follows_the_type_rule(user: Api, services: Services):
    types = _types(user)
    team = types["Reunião de equipe"]
    user.patch(f"/api/v1/agenda-types/{team['id']}", json={"title_instructions": "O projeto discutido, em 3 palavras."})
    agents = FakeAgents(replies={"fields": ['{"titulo": "Projeto Aurora"}']})
    recording = _process(user, services, agents)
    assert recording["title"] == "Reunião de equipe · Projeto Aurora"
    fields_prompt = agents.of("fields")[0][2]
    assert "O projeto discutido, em 3 palavras." in fields_prompt
    # Without its own rule, the default type's applies.
    user.patch(f"/api/v1/agenda-types/{types['Geral']['id']}", json={"title_instructions": "Regra do Geral."})
    user.patch(f"/api/v1/agenda-types/{team['id']}", json={"title_instructions": ""})
    agents = FakeAgents()
    _process(user, services, agents)
    assert "Regra do Geral." in agents.of("fields")[0][2]


def test_changing_the_type_by_hand_generates_a_new_summary(user: Api, services: Services):
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


def test_reapplying_the_pattern_does_not_nest_the_title(user: Api, services: Services):
    # Without an automatic title, the subject is the title from before the first pattern (the file name).
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


def test_the_same_type_again_does_not_duplicate_the_automatic_summary(user: Api, services: Services):
    recording = _process(user, services, FakeAgents())
    detected = recording["agenda_type"]
    path = f"/api/v1/recordings/{recording['id']}"
    # Confirming the detected type (it becomes `edited`) does not generate another summary for the same type.
    same = user.patch(path, json={"agenda_type_id": detected["id"]}).json()
    assert same["agenda_type"]["origin"] == "edited"
    client = _types(user)["Conversa com cliente"]
    user.patch(path, json={"agenda_type_id": client["id"]})
    user.patch(path, json={"agenda_type_id": client["id"]})
    run_cpu(services.settings)
    summaries = user.get(f"/api/v1/transcripts/{recording['transcript_id']}/summaries").json()["items"]
    assert sorted(s["agenda_type"]["name"] for s in summaries) == ["Conversa com cliente", "Reunião de equipe"]


def test_unexpected_failure_outside_the_agent_marks_the_step_and_moves_on(
    user: Api, services: Services, monkeypatch: pytest.MonkeyPatch
):
    def boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError

    monkeypatch.setattr(fields_module, "tag_guide", boom)
    monkeypatch.setattr(agenda_types_module, "apply_type", boom)
    recording = _process(user, services, FakeAgents())
    for name in ("fields", "agenda_type"):
        step = _step(recording, name)
        assert (step["state"], step["error"]["code"]) == ("failed", "internal_error"), name
    # The chain reached the summary: with no type applied, it comes out skipped.
    assert (_step(recording, "summary")["state"], _step(recording, "summary")["reason"]) == (
        "skipped",
        "no_agenda_type",
    )


def test_automatic_summary_deleted_before_generation_closes_the_step(user: Api, services: Services):
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


def test_automatic_collections_by_the_rule_with_participants(user: Api, services: Services):
    rule = "Reuniões em que participa alguém da empresa Agro Sul."
    agro = user.post("/api/v1/collections", json={"name": "Agro Sul", "instructions": rule, "auto_assign": True}).json()
    manual = user.post("/api/v1/collections", json={"name": "Manual", "instructions": "Nunca.", "auto_assign": False})
    empty = user.post("/api/v1/collections", json={"name": "Sem regra", "auto_assign": True}).json()
    kept = user.post("/api/v1/collections", json={"name": "Do envio"}).json()

    # No participants yet: the agent sees the automatic collections with a rule and picks the first.
    agents = FakeAgents(replies={"fields": ['{"colecoes": ["C1", "C9", "x"]}']})
    recording = _process(user, services, agents, collection_ids=[kept["id"]])
    prompt = agents.of("fields")[0][2]
    assert f"- C1: Agro Sul — {rule}" in prompt
    assert "Manual" not in prompt
    assert "Sem regra" not in prompt
    assert "## Agenda type of the recording\n\nReunião de equipe" in prompt
    assert recording["collection_ids"] == [kept["id"], agro["id"]]
    assert recording["collections_origin"] == "auto"
    assert manual.status_code == 201
    assert empty["auto_assign"] is True

    # With a linked participant, retranscription carries their data into the prompt; the new choice
    # replaces the automatic ones and keeps the one from the upload.
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
    assert "- Bruna Reis — company: Agro Sul; department: Compras; tags: cliente" in prompt
    body = user.get(f"/api/v1/recordings/{recording['id']}").json()
    assert body["collection_ids"] == [kept["id"]]

    # The user changed them: the agent no longer touches them, and the collections do not even go to the prompt.
    user.patch(f"/api/v1/recordings/{recording['id']}", json={"collection_ids": [agro["id"]]})
    user.post(f"/api/v1/recordings/{recording['id']}/retranscribe")
    run_gpu(services.settings)
    agents = run_cpu(services.settings, FakeAgents(replies={"fields": ['{"colecoes": ["C1"]}']}))
    assert "## Collections" not in agents.of("fields")[0][2]
    body = user.get(f"/api/v1/recordings/{recording['id']}").json()
    assert (body["collection_ids"], body["collections_origin"]) == ([agro["id"]], "edited")


def test_only_automatic_collections_also_call_the_agent(user: Api, services: Services):
    for item in user.get("/api/v1/fields").json()["items"]:
        user.patch(f"/api/v1/fields/{item['id']}", json={"auto_fill": False})
    coll = user.post("/api/v1/collections", json={"name": "Tudo", "instructions": "Todas.", "auto_assign": True})
    agents = FakeAgents(replies={"fields": ['{"colecoes": ["C1"]}']})
    recording = _process(user, services, agents)
    assert _step(recording, "fields")["state"] == "done"
    assert recording["collection_ids"] == [coll.json()["id"]]
    assert "## Fields" not in agents.of("fields")[0][2]


def test_fixed_tags_match_variations_and_drop_the_new_ones(user: Api, services: Services):
    user.post("/api/v1/tags", json={"name": "reunião de equipe"})
    reply = json.dumps({"tags": ["Reuniões de Equipe", "inventada"]})
    recording = _process(user, services, FakeAgents(replies={"fields": [reply]}))
    assert recording["tags"] == ["reunião de equipe", "interno", "planejamento"]
    names = {tag["name"]: tag for tag in user.get("/api/v1/tags").json()["items"]}
    assert "inventada" not in names


def test_self_managed_tags_respect_the_limit_and_the_ceiling(
    user: Api, services: Services, monkeypatch: pytest.MonkeyPatch
):
    assert user.patch("/api/v1/me/tag-assignment", json={"mode": "auto"}).json()["new_limit"] == 1
    agents = FakeAgents(replies={"fields": [json.dumps({"tags": ["interno", "nova um", "nova dois"]})]})
    recording = _process(user, services, agents)
    assert "a new one, short and lowercase: at most 1 new tag(s) per recording" in agents.of("fields")[0][2]
    assert recording["tags"] == ["interno", "nova um", "planejamento"]
    created = {tag["name"]: tag["origin"] for tag in user.get("/api/v1/tags").json()["items"]}
    assert (created["nova um"], created["interno"]) == ("auto", "user")
    assert "nova dois" not in created

    # Catalog at the ceiling: the agent creates no more.
    monkeypatch.setattr(fields_module, "MAX_CATALOG", len(created))
    agents = FakeAgents(replies={"fields": [json.dumps({"tags": ["outra nova"]})]})
    recording = _process(user, services, agents)
    assert "outra nova" not in recording["tags"]
