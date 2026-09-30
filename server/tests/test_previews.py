"""Pré-visualizações: testar a regra de um campo e um tipo de agenda em rascunho sem gravar nada."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from eclume_server.agents.extraction import DETECT_SYSTEM, FIELDS_SYSTEM
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import FakeAgents, run_cpu, run_gpu

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

CLAUDE = {"name": "Claude (servidor)", "kind": "claude-cli", "model": "sonnet"}
CLIENT = {"name": "Cliente", "kind": "choice", "options": ["Serra Azul", "Vale Verde"], "instructions": "A empresa."}
MENTORING = {
    "name": "Mentoria",
    "title_pattern": "Mentoria · {assunto}",
    "identify": "Conversa de acompanhamento com uma pessoa mentorada.",
    "default_tags": ["mentoria"],
    "summary_instructions": "## Temas\nUm item por tema.",
}


@pytest.fixture
def user(admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]) -> Api:
    assert admin.post("/api/v1/admin/agent-providers", json=CLAUDE).status_code == 201
    return as_user(make_user())


def _recording(api: Api, services: Services, title: str) -> dict[str, Any]:
    recording = upload_file(api, audio_bytes(1900), title=title)
    run_gpu(services.settings)
    run_cpu(services.settings)
    return api.get(f"/api/v1/recordings/{recording['id']}").json()


def _finish(api: Api, services: Services, created: Any, agents: FakeAgents) -> dict[str, Any]:  # noqa: ANN401
    assert created.status_code == 202, created.text
    assert (created.json()["status"], created.json()["items"]) == ("queued", [])
    run_cpu(services.settings, agents)
    done = api.get(f"/api/v1/previews/{created.json()['id']}")
    assert done.status_code == 200, done.text
    return done.json()


def test_testar_a_regra_de_um_campo(user: Api, services: Services):
    first = _recording(user, services, "Reunião A")
    second = _recording(user, services, "Reunião B")
    agents = FakeAgents(replies={"fields": ['{"campo": "Serra Azul"}', '{"campo": "Outra"}']})
    preview = _finish(user, services, user.post("/api/v1/fields/preview", json={"field": CLIENT}), agents)
    assert (preview["kind"], preview["status"], preview["error"]) == ("field_rule", "done", None)
    # As mais recentes primeiro; escolha fora das opções vira null.
    assert [(i["recording_id"], i["value"]) for i in preview["items"]] == [
        (second["id"], "Serra Azul"),
        (first["id"], None),
    ]
    assert all(FIELDS_SYSTEM in prompt for _, _, prompt in agents.calls)
    assert "- campo (escolha, opções: Serra Azul | Vale Verde): A empresa." in agents.calls[0][2]
    # Nada foi gravado: o campo não existe e a gravação não mudou.
    assert "cliente" not in {f["key"] for f in user.get("/api/v1/fields").json()["items"]}

    chosen = user.post("/api/v1/fields/preview", json={"field": CLIENT, "recording_ids": [first["id"]]})
    assert len(_finish(user, services, chosen, FakeAgents())["items"]) == 1
    for body in (
        {"field": {**CLIENT, "options": []}},
        {"field": CLIENT, "recording_ids": [first["id"]] * 2 + [second["id"], first["id"]]},
        {"field": CLIENT, "recording_ids": [user.get("/api/v1/me").json()["user"]["id"]]},
    ):
        assert user.post("/api/v1/fields/preview", json=body).status_code == 422, body


def test_previsualizar_um_tipo_numa_gravacao(user: Api, services: Services):
    recording = _recording(user, services, "Conversa com a Ana")
    detection = json.dumps({"tipo": "T5", "confianca": 0.82, "motivo": "Acompanhamento de carreira."})
    agents = FakeAgents(replies={"agenda_detection": [detection]})
    created = user.post(
        "/api/v1/agenda-types/preview", json={"agenda_type": MENTORING, "recording_id": recording["id"]}
    )
    preview = _finish(user, services, created, agents)
    (item,) = preview["items"]
    assert item["detected"] is True
    assert (item["detected_type_name"], item["confidence"]) == ("Mentoria", 0.82)
    assert item["title"] == "Mentoria · Conversa com a Ana"
    assert item["tags"] == [*recording["tags"], "mentoria"]
    assert item["summary_md"].startswith("# Resumo")
    detect_prompt = next(prompt for _, system, prompt in agents.calls if system == DETECT_SYSTEM)
    assert "- T5: Mentoria. Conversa de acompanhamento" in detect_prompt
    assert "## Temas" in agents.of("summaries")[-1][2]
    # Nada foi gravado.
    assert "Mentoria" not in {t["name"] for t in user.get("/api/v1/agenda-types").json()["items"]}
    assert user.get(f"/api/v1/recordings/{recording['id']}").json()["title"] == recording["title"]
    assert item["fallback"] is False


def test_previa_com_pouca_confianca_e_do_tipo_padrao(user: Api, services: Services):
    recording = _recording(user, services, "Conversa solta")
    types = {t["name"]: t for t in user.get("/api/v1/agenda-types").json()["items"]}
    unsure = json.dumps({"tipo": "T5", "confianca": 0.3, "motivo": "Talvez."})
    created = user.post(
        "/api/v1/agenda-types/preview", json={"agenda_type": MENTORING, "recording_id": recording["id"]}
    )
    (item,) = _finish(user, services, created, FakeAgents(replies={"agenda_detection": [unsure]}))["items"]
    assert (item["detected"], item["fallback"], item["detected_type_name"]) == (False, True, "Geral")

    # O rascunho do próprio tipo padrão não concorre: sem tipo que sirva, é ele que fica.
    geral = {
        k: types["Geral"][k] for k in ("name", "title_pattern", "identify", "default_tags", "summary_instructions")
    }
    nothing = json.dumps({"tipo": None, "confianca": 0.9, "motivo": "Nenhum serve."})
    agents = FakeAgents(replies={"agenda_detection": [nothing]})
    created = user.post(
        "/api/v1/agenda-types/preview",
        json={
            "agenda_type": {**geral, "name": "Outros"},
            "agenda_type_id": types["Geral"]["id"],
            "recording_id": recording["id"],
        },
    )
    (item,) = _finish(user, services, created, agents)["items"]
    assert (item["detected"], item["fallback"], item["detected_type_name"]) == (True, True, "Outros")
    detect_prompt = next(prompt for _, system, prompt in agents.calls if system == DETECT_SYSTEM)
    assert "Geral" not in detect_prompt
    assert "Outros" not in detect_prompt


def test_sem_provider_a_previa_falha_com_motivo(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    recording = upload_file(api, audio_bytes(1800))
    run_gpu(services.settings)
    run_cpu(services.settings)
    preview = _finish(api, services, api.post("/api/v1/fields/preview", json={"field": CLIENT}), FakeAgents())
    assert preview["status"] == "failed"
    assert preview["error"]["code"] == "no_provider"
    del admin, recording


def test_previa_de_outra_conta_nao_existe(
    user: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    created = user.post("/api/v1/fields/preview", json={"field": CLIENT}).json()
    other = as_user(make_user())
    assert other.get(f"/api/v1/previews/{created['id']}").status_code == 404
    assert user.get("/api/v1/previews/01928f3a-1c00-7a00-8000-000000000e09").status_code == 404
    recording = _recording(user, services, "Minha")
    refused = other.post(
        "/api/v1/agenda-types/preview", json={"agenda_type": MENTORING, "recording_id": recording["id"]}
    )
    assert refused.status_code == 422
    assert user.pat("recordings:read").post("/api/v1/fields/preview", json={"field": CLIENT}).status_code == 403


def test_no_maximo_tres_em_aberto_por_conta(
    user: Api, services: Services, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    _recording(user, services, "Reunião A")
    for _ in range(3):
        assert user.post("/api/v1/fields/preview", json={"field": CLIENT}).status_code == 202
    fourth = user.post("/api/v1/fields/preview", json={"field": CLIENT})
    assert (fourth.status_code, fourth.json()["code"]) == (429, "rate_limited")
    # O limite é por conta.
    assert as_user(make_user()).post("/api/v1/fields/preview", json={"field": CLIENT}).status_code == 202
    # Terminadas, liberam a vez.
    run_cpu(services.settings)
    assert user.post("/api/v1/fields/preview", json={"field": CLIENT}).status_code == 202
    run_cpu(services.settings)
