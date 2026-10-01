"""Chat sobre a base: perguntar, esperar a resposta com as fontes, o isolamento entre contas e os limites."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from eclume_server.agents.base_chat import BASE_CHAT_SUMMARIES_SYSTEM, correction
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import FakeAgents, contract_transcript, run_cpu, run_gpu

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

UNSEEN = "00000000-0000-4000-8000-0000000000ff"
CLAUDE = {"name": "Claude (servidor)", "kind": "claude-cli", "model": "sonnet"}


def _json(**action: Any) -> str:  # noqa: ANN401
    return json.dumps(action, ensure_ascii=False)


@pytest.fixture
def user(admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]) -> Api:
    assert admin.post("/api/v1/admin/agent-providers", json=CLAUDE).status_code == 201
    return as_user(make_user())


def _recording(api: Api, services: Services, title: str) -> dict[str, Any]:
    recording = upload_file(api, audio_bytes(1900), title=title)
    run_gpu(services.settings)
    run_cpu(services.settings)
    return api.get(f"/api/v1/recordings/{recording['id']}").json()


def _ask(api: Api, message: str = "O que foi combinado?", history: list[dict[str, str]] | None = None) -> Any:  # noqa: ANN401
    return api.post("/api/v1/base-chat", json={"message": message, "history": history or []})


def test_pergunta_consulta_os_resumos_e_devolve_as_fontes(user: Api, services: Services):
    recording = _recording(user, services, "Alinhamento da turma")
    rid = recording["id"]
    agents = FakeAgents(
        replies={
            "base_chat": [
                _json(action="search_summaries", query="gerado"),
                _json(action="read_summary", recording_id=rid),
                # Um id que nunca apareceu nas consultas não vira fonte.
                _json(action="reply", message="Foi **combinado** o resumo.", sources=[rid, "não é id", UNSEEN]),
            ]
        }
    )
    created = _ask(user, history=[{"role": "user", "content": "Oi"}, {"role": "assistant", "content": "Olá."}])
    assert created.status_code == 202, created.text
    assert (created.json()["status"], created.json()["answer"], created.json()["sources"]) == ("queued", None, [])
    run_cpu(services.settings, agents)
    done = user.get(f"/api/v1/base-chat/{created.json()['id']}").json()
    assert (done["status"], done["error"]) == ("done", None)
    assert done["answer"] == "Foi **combinado** o resumo."
    assert done["sources"] == [{"recording_id": rid, "title": "Alinhamento da turma"}]
    assert (done["queries"], done["model"]) == (2, "sonnet-fake")
    prompts = [prompt for _, _, prompt in agents.of("base_chat")]
    assert "Pessoa: Oi\nAgente: Olá." in prompts[0]
    assert f'<ferramenta nome="read_summary" gravacao="{rid}">' in prompts[2]
    assert "gerado por" in prompts[2]


def test_a_busca_da_transcricao_devolve_o_momento_e_o_locutor(user: Api, services: Services):
    recording = _recording(user, services, "Alinhamento")
    segment = contract_transcript()["segments"][0]
    word = max(segment["text"].split(), key=len).strip(".,;:!?")
    agents = FakeAgents(
        replies={
            "base_chat": [
                _json(action="search_transcripts", query=word),
                _json(action="read_transcript", recording_id=recording["id"], **{"from": "00:00:00", "to": "00:00:30"}),
                _json(action="reply", message="Está na transcrição.", sources=[recording["id"]]),
            ]
        }
    )
    created = _ask(user, "Onde falaram disso?").json()
    run_cpu(services.settings, agents)
    done = user.get(f"/api/v1/base-chat/{created['id']}").json()
    assert (done["status"], done["queries"]) == ("done", 2)
    prompts = [prompt for _, _, prompt in agents.of("base_chat")]
    assert segment["text"] in prompts[2]
    assert '<ferramenta nome="read_transcript"' in prompts[2]
    assert [source["recording_id"] for source in done["sources"]] == [recording["id"]]


def test_outra_conta_nao_ve_a_pergunta_nem_as_gravacoes(
    user: Api, services: Services, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    recording = _recording(user, services, "Confidencial")
    other = as_user(make_user())
    created = _ask(other).json()
    assert user.get(f"/api/v1/base-chat/{created['id']}").status_code == 404
    agents = FakeAgents(
        replies={
            "base_chat": [
                _json(action="search_summaries", query="gerado"),
                _json(action="read_summary", recording_id=recording["id"]),
                _json(action="reply", message="Nada.", sources=[recording["id"]]),
            ]
        }
    )
    run_cpu(services.settings, agents)
    done = other.get(f"/api/v1/base-chat/{created['id']}").json()
    assert (done["status"], done["sources"]) == ("done", [])
    prompts = [prompt for _, _, prompt in agents.of("base_chat")]
    assert "nenhum resultado" in prompts[1]
    assert "gravação inexistente ou sem acesso" in prompts[2]
    assert "Confidencial" not in prompts[2]


def test_sem_provider_falha_com_motivo(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    api = as_user(make_user())
    created = _ask(api).json()
    del admin
    run_cpu(services.settings)
    failed = api.get(f"/api/v1/base-chat/{created['id']}").json()
    assert (failed["status"], failed["error"]["code"]) == ("failed", "no_provider")


def test_validacao_escopo_e_limite_por_conta(
    user: Api, services: Services, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    assert user.post("/api/v1/base-chat", json={"message": ""}).status_code == 422
    too_long = [{"role": "user", "content": "x"}] * 11
    assert user.post("/api/v1/base-chat", json={"message": "a", "history": too_long}).status_code == 422
    assert user.pat("recordings:read").post("/api/v1/base-chat", json={"message": "a"}).status_code == 403
    assert _ask(user).status_code == 202
    assert _ask(user).status_code == 202
    third = _ask(user)
    assert (third.status_code, third.json()["code"]) == (429, "rate_limited")
    # O limite é por conta.
    assert _ask(as_user(make_user())).status_code == 202
    # Terminados, liberam a vez.
    run_cpu(services.settings)
    assert _ask(user).status_code == 202
    assert user.get("/api/v1/base-chat/01928f3a-1c00-7a00-8000-000000000e09").status_code == 404


def test_pat_sem_transcripts_read_so_consulta_resumos(user: Api, services: Services):
    pat = user.pat("summaries:read")
    agents = FakeAgents(
        replies={
            "base_chat": [
                # A ação de transcrição não vale para esta credencial: recebe o pedido de correção.
                _json(action="search_transcripts", query="orçamento"),
                _json(action="reply", message="Só pelos resumos.", sources=[]),
            ]
        }
    )
    created = pat.post("/api/v1/base-chat", json={"message": "Qual o orçamento?"})
    assert created.status_code == 202, created.text
    run_cpu(services.settings, agents)
    done = pat.get(f"/api/v1/base-chat/{created.json()['id']}").json()
    assert (done["status"], done["answer"], done["queries"]) == ("done", "Só pelos resumos.", 0)
    # Só as chamadas desta pergunta: o worker também drena perguntas deixadas na fila por outros testes.
    calls = [call for call in agents.of("base_chat") if "Qual o orçamento?" in call[2]]
    assert len(calls) == 2
    assert all(system == BASE_CHAT_SUMMARIES_SYSTEM for _, system, _ in calls)
    assert "search_transcripts" not in calls[0][1]
    assert correction(transcripts=False) in calls[1][2]
