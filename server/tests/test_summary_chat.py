"""Chat de ajuste do resumo: rotas, o job `summary_chat` no worker CPU real e a versão `chat`."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text

from eclume_server.agents import base as codes
from eclume_server.agents.base import ProviderError
from eclume_server.agents.chat import CHAT_SYSTEM
from eclume_server.db.session import make_engine
from eclume_server.summary_chat import reap_stalled_chats
from eclume_server_testing.api import agenda_types, audio_bytes, upload_file
from eclume_server_testing.fakes import FakeAgents, contract_transcript, run_cpu, run_gpu
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

CLAUDE = {"name": "Claude (servidor)", "kind": "claude-cli", "model": "sonnet"}


def _json(**action: Any) -> str:  # noqa: ANN401
    return json.dumps(action, ensure_ascii=False)


@pytest.fixture
def owner(admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]) -> dict[str, Any]:
    """Um usuário com sessão e o admin que cadastra (ou não) o agente."""
    account = make_user()
    return {"api": as_user(account), "account": account, "admin": admin}


def _recording(owner: dict[str, Any], services: Services, *, provider: bool = True) -> str:
    """Uma gravação transcrita com o resumo gerado pelo tipo 1:1 (versão 1); devolve o id."""
    if provider:
        owner["admin"].post("/api/v1/admin/agent-providers", json=CLAUDE)
    api: Api = owner["api"]
    one_on_one = next(t for t in agenda_types(services, owner["account"].user_id) if t["name"] == "1:1")
    recording = upload_file(api, audio_bytes(2000), title="Alinhamento", agenda_type_id=str(one_on_one["id"]))
    run_gpu(services.settings)
    run_cpu(services.settings)
    return recording["id"]


def _state(api: Api, recording_id: str) -> dict[str, Any]:
    return api.get(f"/api/v1/recordings/{recording_id}/summary").json()


def _ask(api: Api, recording_id: str, message: str = "Quem falou das turmas?") -> dict[str, Any]:
    response = api.post(f"/api/v1/recordings/{recording_id}/summary/chat", json={"message": message})
    assert response.status_code == 202, response.text
    return response.json()


def _reply(api: Api, exchange: dict[str, Any]) -> dict[str, Any]:
    return api.get(f"/api/v1/summary-chat-messages/{exchange['reply']['id']}").json()


def test_ajuste_le_a_transcricao_e_cria_a_versao_chat(owner: dict[str, Any], services: Services):
    api: Api = owner["api"]
    recording_id = _recording(owner, services)
    generated = _state(api, recording_id)["current"]
    assert (generated["version"], generated["origin"]) == (1, "generated")

    exchange = _ask(api, recording_id)
    message, reply = exchange["message"], exchange["reply"]
    assert (message["role"], message["status"], message["content"]) == ("user", "done", "Quem falou das turmas?")
    assert (reply["role"], reply["status"], reply["content"]) == ("assistant", "queued", None)
    assert (reply["reply_to"], reply["base_summary_id"]) == (message["id"], generated["id"])
    busy = api.post(f"/api/v1/recordings/{recording_id}/summary/chat", json={"message": "De novo"})
    assert (busy.status_code, busy.json()["code"]) == (409, "chat_busy")

    first = contract_transcript()["segments"][0]
    agents = FakeAgents(
        replies={
            "chat": [
                _json(action="read_transcript", **{"from": "00:00:00", "to": "00:00:30"}),
                _json(action="reply", message="Foi a Mariana.", summary_md="# Resumo\n\n- A Mariana falou das turmas."),
            ]
        }
    )
    run_cpu(services.settings, agents)
    done = _reply(api, exchange)
    assert (done["status"], done["content"], done["error"]) == ("done", "Foi a Mariana.", None)
    assert done["reads"] == [{"tool": "read_transcript", "from_ms": 0, "to_ms": 30_000, "clipped": False}]
    assert (done["provider"]["name"], done["model"]) == ("Claude (servidor)", "sonnet-fake")
    (read_prompt, answer_prompt) = [prompt for _, system, prompt in agents.calls if system == CHAT_SYSTEM]
    assert generated["content_md"] in read_prompt
    assert first["text"] not in read_prompt
    assert first["text"] in answer_prompt

    state = _state(api, recording_id)
    current = state["current"]
    assert (current["id"], current["version"], current["origin"]) == (done["summary_id"], 2, "chat")
    assert (current["chat_message_id"], current["provider"]["name"]) == (done["id"], "Claude (servidor)")
    assert current["content_md"] == "# Resumo\n\n- A Mariana falou das turmas."
    assert state["generated"]["id"] == generated["id"]
    chat = api.get(f"/api/v1/recordings/{recording_id}/summary/chat").json()
    assert [(m["role"], m["status"]) for m in chat["items"]] == [("user", "done"), ("assistant", "done")]


def test_busca_so_na_transcricao_da_gravacao(owner: dict[str, Any], services: Services):
    api: Api = owner["api"]
    recording_id = _recording(owner, services)
    # Outra gravação com as mesmas falas: a busca do chat não a enxerga.
    _recording(owner, services, provider=False)
    term = "turmas"
    # O full-text `eclume_pt` acha "turma" e "turmas" (o mesmo radical).
    expected = sum("turma" in segment["text"].lower() for segment in contract_transcript()["segments"])
    assert expected > 0
    exchange = _ask(api, recording_id)
    agents = FakeAgents(
        replies={"chat": [_json(action="search_transcript", query=term), _json(action="reply", message="Achei.")]}
    )
    run_cpu(services.settings, agents)
    done = _reply(api, exchange)
    assert done["reads"] == [{"tool": "search_transcript", "query": term, "hits": min(expected, 8)}]
    # Sem `summary_md`, a resposta não cria versão.
    assert done["summary_id"] is None
    assert _state(api, recording_id)["version_count"] == 1


def test_resumo_mudou_durante_o_ajuste(owner: dict[str, Any], services: Services):
    api: Api = owner["api"]
    recording_id = _recording(owner, services)
    exchange = _ask(api, recording_id, "Encurte")
    edited = api.put(f"/api/v1/recordings/{recording_id}/summary", json={"content_md": "# Meu", "base_version": 1})
    assert edited.status_code == 200, edited.text
    agents = FakeAgents(replies={"chat": [_json(action="reply", message="Encurtei.", summary_md="# Curto")]})
    run_cpu(services.settings, agents)
    done = _reply(api, exchange)
    assert (done["status"], done["content"], done["summary_id"]) == ("done", "Encurtei.", None)
    assert done["error"]["code"] == "summary_changed"
    assert _state(api, recording_id)["current"]["id"] == edited.json()["id"]


def test_resposta_abandonada_nao_trava_o_chat(owner: dict[str, Any], services: Services):
    api: Api = owner["api"]
    recording_id = _recording(owner, services)
    exchange = _ask(api, recording_id)

    async def reap_after(minutes: int) -> int:
        await services.sql(
            lambda conn: conn.execute(
                text("UPDATE summary_chat_messages SET created_at = created_at - make_interval(mins => :m)"),
                {"m": minutes},
            )
        )
        engine = make_engine(services.settings.database_url)
        try:
            return await reap_stalled_chats(engine)
        finally:
            await engine.dispose()

    # Dentro do pior caso do job, a resposta segue em aberto.
    assert run(reap_after(5)) == 0
    assert _reply(api, exchange)["status"] == "queued"
    # Worker morto: a varredura falha a resposta e a gravação aceita um pedido novo.
    assert run(reap_after(15)) == 1
    stalled = _reply(api, exchange)
    assert (stalled["status"], stalled["error"]["code"]) == ("failed", "internal_error")
    _ask(api, recording_id, "De novo")
    run_cpu(services.settings, FakeAgents(replies={"chat": [_json(action="reply", message="Ok.", summary_md=None)]}))


def test_falhas_do_agente(owner: dict[str, Any], services: Services):
    api: Api = owner["api"]
    recording_id = _recording(owner, services)

    def attempt(agents: FakeAgents) -> dict[str, Any]:
        exchange = _ask(api, recording_id)
        run_cpu(services.settings, agents)
        return _reply(api, exchange)

    # A GPU ocupada (Ollama) falha na hora: um chat não espera a fila.
    gpu = FakeAgents(errors=[ProviderError(codes.GPU_BUSY, "fila da GPU ocupada")])
    busy = attempt(gpu)
    assert (busy["status"], busy["error"]["code"], len(gpu.of("chat"))) == ("failed", "gpu_busy", 1)
    assert "tente em instantes" in busy["error"]["message"]

    # Falha passageira: uma nova tentativa só.
    down = ProviderError(codes.PROVIDER_UNAVAILABLE, "fora do ar")
    recovered = FakeAgents(errors=[down])
    assert attempt(recovered)["status"] == "done"
    twice = FakeAgents(errors=[down, down, down])
    failed = attempt(twice)
    assert (failed["status"], failed["error"]["code"], len(twice.of("chat"))) == ("failed", "provider_unavailable", 2)

    bad = attempt(FakeAgents(replies={"chat": ["não sei", "ainda não sei"]}))
    assert (bad["status"], bad["error"]["code"]) == ("failed", "provider_bad_output")
    assert _state(api, recording_id)["version_count"] == 1


def test_sem_agente_de_chat(owner: dict[str, Any], services: Services):
    api: Api = owner["api"]
    recording_id = _recording(owner, services, provider=False)
    exchange = _ask(api, recording_id)
    run_cpu(services.settings)
    failed = _reply(api, exchange)
    assert (failed["status"], failed["error"]["code"]) == ("failed", "provider_not_configured")


def test_isolamento_e_exclusao(
    owner: dict[str, Any], services: Services, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    api: Api = owner["api"]
    recording_id = _recording(owner, services)
    exchange = _ask(api, recording_id)
    stranger = as_user(make_user())
    url = f"/api/v1/recordings/{recording_id}/summary/chat"
    assert stranger.get(url).status_code == 404
    assert stranger.post(url, json={"message": "x"}).status_code == 404
    assert stranger.get(f"/api/v1/summary-chat-messages/{exchange['reply']['id']}").status_code == 404
    reader = api.pat("summaries:read")
    assert reader.get(url).status_code == 200
    assert reader.post(url, json={"message": "x"}).json()["code"] == "insufficient_scope"

    # Excluir o resumo leva o chat; o job ainda na fila termina sem chamar o agente.
    assert api.delete(f"/api/v1/recordings/{recording_id}/summary").status_code == 204
    assert api.get(url).json()["items"] == []
    agents = run_cpu(services.settings)
    assert agents.of("chat") == []

    upload = upload_file(api, audio_bytes(100))
    missing = api.post(f"/api/v1/recordings/{upload['id']}/summary/chat", json={"message": "x"})
    assert (missing.status_code, missing.json()["code"]) == (409, "transcript_missing")
