"""O Agente: conversas persistidas, anexos, perguntas com arquivos gerados, download e isolamento."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text

from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import FakeAgents, run_cpu, run_gpu
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

CLAUDE = {"name": "Claude (servidor)", "kind": "claude-cli", "model": "sonnet"}
SESSIONS = "/api/v1/agent/sessions"
UNSEEN = "00000000-0000-4000-8000-0000000000ff"


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


def _session(api: Api, title: str = "") -> dict[str, Any]:
    response = api.post(SESSIONS, json={"title": title})
    assert response.status_code == 201, response.text
    return response.json()


def _attach(api: Api, session_id: str, name: str, data: bytes) -> Any:  # noqa: ANN401
    return api.post(f"{SESSIONS}/{session_id}/files", files={"file": (name, data, "application/octet-stream")})


def _ask(
    api: Api, session_id: str, message: str = "O que foi combinado?", attachments: list[str] | None = None
) -> Any:  # noqa: ANN401
    return api.post(f"{SESSIONS}/{session_id}/messages", json={"message": message, "attachments": attachments or []})


def test_conversa_criada_listada_renomeada_e_excluida(user: Api):
    first = _session(user, "Planejamento")
    second = _session(user)
    assert (first["title"], second["title"]) == ("Planejamento", "")
    listed = user.get(SESSIONS).json()
    assert [item["id"] for item in listed["items"]] == [second["id"], first["id"]]
    page = user.get(SESSIONS, params={"limit": 1}).json()
    assert len(page["items"]) == 1
    assert page["next_cursor"]
    rest = user.get(SESSIONS, params={"limit": 1, "cursor": page["next_cursor"]}).json()
    assert [item["id"] for item in rest["items"]] == [first["id"]]
    renamed = user.patch(f"{SESSIONS}/{first['id']}", json={"title": "  Plano   de março "})
    assert renamed.json()["title"] == "Plano de março"
    assert user.patch(f"{SESSIONS}/{first['id']}", json={"title": ""}).status_code == 422
    assert user.delete(f"{SESSIONS}/{first['id']}").status_code == 204
    assert user.get(f"{SESSIONS}/{first['id']}").status_code == 404
    assert [item["id"] for item in user.get(SESSIONS).json()["items"]] == [second["id"]]


def test_pergunta_com_anexo_gera_arquivo_para_baixar(user: Api, services: Services):
    session = _session(user)
    attached = _attach(user, session["id"], "ata.md", "# Ata\nPrazo: sexta-feira.".encode())
    assert attached.status_code == 201, attached.text
    file = attached.json()
    assert (file["direction"], file["name"], file["message_id"], file["text_chars"]) == ("input", "ata.md", None, 25)
    assert user.get(f"{SESSIONS}/{session['id']}").json()["pending_files"] == [file]

    agents = FakeAgents(
        replies={
            "agent": [
                _json(action="read_file", file_id=file["id"]),
                _json(action="write_file", name="prazos", format="csv", content="item,prazo\nata,sexta"),
                _json(action="reply", message="O prazo é **sexta**. Preparei a tabela.", sources=[]),
            ]
        }
    )
    created = _ask(user, session["id"], "Quais os prazos da ata?", [file["id"]])
    assert created.status_code == 202, created.text
    question, answer = created.json()["question"], created.json()["answer"]
    assert (question["role"], question["status"]) == ("user", "done")
    assert [f["id"] for f in question["files"]] == [file["id"]]
    assert (answer["role"], answer["status"]) == ("assistant", "queued")

    run_cpu(services.settings, agents)
    done = user.get(f"{SESSIONS}/{session['id']}/messages/{answer['id']}").json()
    assert (done["status"], done["error"]) == ("done", None)
    assert done["content"] == "O prazo é **sexta**. Preparei a tabela."
    assert (done["queries"], done["model"]) == (2, "sonnet-fake")
    [output] = done["files"]
    assert (output["direction"], output["name"]) == ("output", "prazos.csv")
    assert output["media_type"] == "text/csv; charset=utf-8"
    prompts = [prompt for _, _, prompt in agents.of("agent")]
    assert f"arquivo {file['id']}" in prompts[0]
    assert "Prazo: sexta-feira." in prompts[1]

    downloaded = user.get(f"/api/v1/agent/files/{output['id']}/content")
    assert downloaded.status_code == 200
    assert downloaded.content == b"item,prazo\nata,sexta"
    assert downloaded.headers["content-disposition"].startswith('attachment; filename="prazos.csv"')
    assert user.get(f"/api/v1/agent/files/{file['id']}/content").content == "# Ata\nPrazo: sexta-feira.".encode()

    detail = user.get(f"{SESSIONS}/{session['id']}").json()
    assert detail["title"] == "Quais os prazos da ata?"
    assert [m["role"] for m in detail["messages"]] == ["user", "assistant"]
    assert detail["pending_files"] == []
    # O anexo enviado fica no histórico.
    assert user.delete(f"{SESSIONS}/{session['id']}/files/{file['id']}").status_code == 409


def test_historico_vem_do_servidor(user: Api, services: Services):
    session = _session(user)
    agents = FakeAgents(replies={"agent": [_json(action="reply", message="Primeira resposta.")]})
    _ask(user, session["id"], "Primeira pergunta")
    run_cpu(services.settings, agents)
    agents = FakeAgents(replies={"agent": [_json(action="reply", message="Segunda resposta.")]})
    _ask(user, session["id"], "Segunda pergunta")
    run_cpu(services.settings, agents)
    [(_, _, prompt)] = agents.of("agent")
    assert "Pessoa: Primeira pergunta\nAgente: Primeira resposta." in prompt
    assert prompt.endswith("## Pergunta\n\nSegunda pergunta")


def test_a_base_continua_disponivel_com_fontes(user: Api, services: Services):
    recording = upload_file(user, audio_bytes(1900), title="Alinhamento da turma")
    run_gpu(services.settings)
    run_cpu(services.settings)
    rid = recording["id"]
    session = _session(user)
    agents = FakeAgents(
        replies={
            "agent": [
                _json(action="search_summaries", query="gerado"),
                _json(action="reply", message="Está no resumo.", sources=[rid, UNSEEN]),
            ]
        }
    )
    answer = _ask(user, session["id"]).json()["answer"]
    run_cpu(services.settings, agents)
    done = user.get(f"{SESSIONS}/{session['id']}/messages/{answer['id']}").json()
    assert done["sources"] == [{"recording_id": rid, "title": "Alinhamento da turma"}]


def test_anexos_recusados_por_tipo_tamanho_e_conversa(user: Api):
    session = _session(user)
    assert _attach(user, session["id"], "planilha.xlsx", b"PK\x03\x04").status_code == 415
    assert _attach(user, session["id"], "falso.pdf", b"texto").status_code == 415
    assert _attach(user, session["id"], "grande.txt", b"a" * (10 * 1024 * 1024 + 1)).status_code == 413
    other = _session(user)
    file = _attach(user, other["id"], "nota.txt", b"oi").json()
    # O anexo de outra conversa não vai junto.
    assert _ask(user, session["id"], attachments=[file["id"]]).status_code == 422
    assert user.delete(f"{SESSIONS}/{other['id']}/files/{file['id']}").status_code == 204


def test_outra_conta_nao_ve_conversa_mensagem_nem_arquivo(
    user: Api, services: Services, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    session = _session(user)
    file = _attach(user, session["id"], "segredo.txt", b"confidencial").json()
    answer = _ask(user, session["id"], attachments=[file["id"]]).json()["answer"]
    other = as_user(make_user())
    assert other.get(SESSIONS).json()["items"] == []
    assert other.get(f"{SESSIONS}/{session['id']}").status_code == 404
    assert other.get(f"{SESSIONS}/{session['id']}/messages/{answer['id']}").status_code == 404
    assert other.patch(f"{SESSIONS}/{session['id']}", json={"title": "x"}).status_code == 404
    assert other.delete(f"{SESSIONS}/{session['id']}").status_code == 404
    assert other.get(f"/api/v1/agent/files/{file['id']}/content").status_code == 404
    assert _attach(other, session["id"], "a.txt", b"x").status_code == 404
    assert _ask(other, session["id"]).status_code == 404
    run_cpu(services.settings)


def test_uma_resposta_por_conversa_e_duas_por_conta(user: Api, services: Services):
    first, second, third = _session(user), _session(user), _session(user)
    assert _ask(user, first["id"]).status_code == 202
    assert _ask(user, first["id"]).status_code == 409
    assert _ask(user, second["id"]).status_code == 202
    assert _ask(user, third["id"]).status_code == 429
    run_cpu(services.settings)
    assert _ask(user, third["id"]).status_code == 202
    run_cpu(services.settings)


def test_escopo_e_validacao(user: Api, services: Services):
    session = _session(user)
    assert user.pat("recordings:read").get(SESSIONS).status_code == 403
    assert _ask(user, session["id"], "").status_code == 422
    assert _ask(user, session["id"], "x" * 4001).status_code == 422
    pat = user.pat("summaries:read")
    answer = _ask(pat, session["id"]).json()["answer"]
    agents = FakeAgents()
    run_cpu(services.settings, agents)
    [(_, system, _)] = agents.of("agent")
    # PAT sem `transcripts:read`: o agente não enxerga as ferramentas de transcrição.
    assert "search_transcripts" not in system
    assert user.get(f"{SESSIONS}/{session['id']}/messages/{answer['id']}").json()["status"] == "done"


def test_sem_provider_a_resposta_falha_com_motivo(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    del admin
    api = as_user(make_user())
    session = _session(api)
    answer = _ask(api, session["id"]).json()["answer"]
    run_cpu(services.settings)
    failed = api.get(f"{SESSIONS}/{session['id']}/messages/{answer['id']}").json()
    assert (failed["status"], failed["error"]["code"]) == ("failed", "no_provider")


def test_resposta_presa_expira_na_leitura(user: Api, services: Services):
    session = _session(user)
    answer = _ask(user, session["id"]).json()["answer"]
    _sql(services, "UPDATE agent_messages SET created_at = now() - interval '1 hour' WHERE id = :m", m=answer["id"])
    stale = user.get(f"{SESSIONS}/{session['id']}/messages/{answer['id']}").json()
    assert (stale["status"], stale["error"]["code"]) == ("failed", "agent_expired")
    run_cpu(services.settings)


def test_excluir_a_conversa_enfileira_os_arquivos_no_bucket(user: Api, services: Services):
    session = _session(user)
    file = _attach(user, session["id"], "nota.txt", b"oi").json()
    [(key,)] = _sql(services, "SELECT storage_key FROM agent_files WHERE id = :f", f=file["id"])
    assert key.endswith(f"/agent/{session['id']}/{file['id']}")
    assert user.delete(f"{SESSIONS}/{session['id']}").status_code == 204
    assert _sql(services, "SELECT count(*) FROM storage_deletions WHERE key = :k", k=key) == [(1,)]
