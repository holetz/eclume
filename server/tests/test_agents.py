"""Providers de agente e chunking, sem rede nem serviços: transportes falsos e um `claude` falso."""

from __future__ import annotations

import asyncio
import json
import sys
from typing import TYPE_CHECKING, Any

import httpx
import httpx2
import pytest

from eclume_server.agents import ProviderConfig, ProviderError, build_provider
from eclume_server.agents import base as codes
from eclume_server.agents.anthropic_api import AnthropicProvider
from eclume_server.agents.base import Completion, with_context
from eclume_server.agents.claude_cli import ClaudeCliProvider, claude_command
from eclume_server.agents.extraction import (
    FIELDS_SYSTEM,
    FieldSpec,
    TagGuide,
    clean,
    extract_fields,
    merge,
    parse_object,
)
from eclume_server.agents.ollama import OllamaProvider
from eclume_server.agents.openai_compat import OpenAICompatibleProvider
from eclume_server.agents.prompting import (
    MAP_SYSTEM,
    SHARED_SYSTEM,
    SYSTEM,
    TranscriptText,
    estimate_tokens,
    render_transcript,
    split_sections,
    summarize,
)

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path


def run[T](coro: Any) -> T:  # noqa: ANN401
    return asyncio.run(coro)


def error_of(coro: Any) -> ProviderError:  # noqa: ANN401
    with pytest.raises(ProviderError) as info:
        run(coro)
    return info.value


# --- claude-cli ---------------------------------------------------------------------------------

FAKE_CLAUDE = """#!{python}
import json, os, sys, time
record = os.environ["FAKE_CLAUDE_RECORD"]
prompt = sys.stdin.read()
with open(record, "w") as fh:
    json.dump({{"argv": sys.argv[1:], "stdin": prompt, "cwd": os.getcwd()}}, fh)
mode = os.environ.get("FAKE_CLAUDE_MODE", "ok")
if mode == "ok":
    print(json.dumps({{"type": "result", "subtype": "success", "is_error": False, "result": "# Ata\\n\\n- decidido",
                      "modelUsage": {{"claude-sonnet-5": {{"inputTokens": 10}}}}}}))
elif mode == "auth":
    print(json.dumps({{"type": "result", "subtype": "success", "is_error": True,
                      "result": "Not logged in · Please run /login"}}))
    sys.exit(1)
elif mode == "overloaded":
    sys.stderr.write("API Error: 529 overloaded_error\\n")
    sys.exit(1)
elif mode == "slow":
    time.sleep(5)
"""


FakeClaude = "Callable[..., tuple[ClaudeCliProvider, Path]]"


@pytest.fixture
def fake_claude(tmp_path: Path) -> Callable[..., tuple[ClaudeCliProvider, Path]]:
    script = tmp_path / "claude"
    script.write_text(FAKE_CLAUDE.format(python=sys.executable))
    script.chmod(0o755)
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / ".credentials.json").write_text('{"claudeAiOauth": {}}')
    record = tmp_path / "record.json"

    def make(mode: str = "ok", **options: Any) -> tuple[ClaudeCliProvider, Path]:  # noqa: ANN401
        env = {"HOME": str(home), "PATH": "/usr/bin:/bin", "FAKE_CLAUDE_RECORD": str(record), "FAKE_CLAUDE_MODE": mode}
        config = ProviderConfig(kind="claude-cli", model="sonnet", options=options)
        return ClaudeCliProvider(config, claude_bin=str(script), env=env), record

    return make


def test_claude_cli_roda_sem_ferramentas_e_com_o_prompt_no_stdin(fake_claude: FakeClaude):
    provider, record = fake_claude()
    completion = run(provider.complete("sistema", "a transcrição"))
    assert completion == Completion(text="# Ata\n\n- decidido", model="claude-sonnet-5")
    seen = json.loads(record.read_text())
    argv = seen["argv"]
    assert seen["stdin"] == "a transcrição"
    assert argv[argv.index("--tools") + 1] == ""
    assert argv[argv.index("--output-format") + 1] == "json"
    assert argv[argv.index("--system-prompt") + 1] == "sistema"
    assert "--no-session-persistence" in argv
    assert "--strict-mcp-config" in argv
    # O agente roda num diretório vazio, sem CLAUDE.md de projeto nenhum.
    assert "eclume-claude-" in seen["cwd"]


def test_claude_cli_sem_credencial_nem_chama_a_cli(fake_claude: FakeClaude, tmp_path: Path):
    provider, record = fake_claude()
    provider.env["HOME"] = str(tmp_path / "vazio")
    error = error_of(provider.complete("s", "p"))
    assert error.code == codes.PROVIDER_NOT_CONFIGURED
    assert not error.retryable
    assert not record.exists()


def test_claude_cli_aceita_o_token_de_longa_duracao_sem_arquivo(fake_claude: FakeClaude, tmp_path: Path):
    provider, record = fake_claude()
    provider.env["HOME"] = str(tmp_path / "vazio")
    provider.env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-teste"
    assert run(provider.complete("s", "p")).text == "# Ata\n\n- decidido"
    assert record.exists()


def test_claude_cli_entrega_o_segredo_do_provider_pela_variavel_certa():
    def env_of(api_key: str) -> dict[str, str]:
        config = ProviderConfig(kind="claude-cli", model="sonnet", api_key=api_key)
        return ClaudeCliProvider(config, env={"CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-do-ambiente"}).env

    token = env_of("sk-ant-oat01-do-painel")
    assert token["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat01-do-painel"
    assert "ANTHROPIC_API_KEY" not in token

    chave = env_of("sk-ant-api03-do-painel")
    assert chave["ANTHROPIC_API_KEY"] == "sk-ant-api03-do-painel"
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in chave


def test_claude_cli_classifica_as_falhas(fake_claude: FakeClaude):
    auth, _ = fake_claude("auth")
    error = error_of(auth.complete("s", "p"))
    assert error.code == codes.PROVIDER_AUTH
    assert "Not logged in" in error.message

    busy, _ = fake_claude("overloaded")
    error = error_of(busy.complete("s", "p"))
    assert error.code == codes.PROVIDER_RATE_LIMITED
    assert error.retryable

    slow, _ = fake_claude("slow", timeout_s=0.5)
    error = error_of(slow.complete("s", "p"))
    assert error.code == codes.PROVIDER_TIMEOUT
    assert error.retryable


def test_claude_cli_binario_inexistente():
    config = ProviderConfig(kind="claude-cli", model="sonnet")
    provider = ClaudeCliProvider(config, claude_bin="/nao/existe/claude", env={"ANTHROPIC_API_KEY": "sk-x"})
    assert error_of(provider.complete("s", "p")).code == codes.PROVIDER_NOT_CONFIGURED


def test_claude_command_repassa_o_effort():
    config = ProviderConfig(kind="claude-cli", model="opus", options={"effort": "low"})
    cmd = claude_command("claude", config, "s")
    assert cmd[cmd.index("--effort") + 1] == "low"
    assert cmd[cmd.index("--model") + 1] == "opus"


# --- openai-compatible ----------------------------------------------------------------------------


def _openai(handler: Callable[[httpx.Request], httpx.Response], **options: Any) -> OpenAICompatibleProvider:  # noqa: ANN401
    config = ProviderConfig(
        kind="openai-compatible",
        name="DeepSeek",
        model="deepseek-chat",
        base_url="https://api.exemplo.com/v1/",
        api_key="sk-teste",
        options=options,
    )
    return OpenAICompatibleProvider(config, transport=httpx.MockTransport(handler))


def test_openai_compativel_monta_a_conversa():
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"model": "deepseek-chat", "choices": [{"message": {"content": " ok "}}]})

    completion = run(_openai(handler, temperature=0.2).complete("sistema", "prompt"))
    assert completion == Completion(text="ok", model="deepseek-chat")
    assert seen["url"] == "https://api.exemplo.com/v1/chat/completions"
    assert seen["auth"] == "Bearer sk-teste"
    assert seen["body"]["messages"] == [
        {"role": "system", "content": "sistema"},
        {"role": "user", "content": "prompt"},
    ]
    assert seen["body"]["temperature"] == 0.2


@pytest.mark.parametrize(
    ("status", "code", "retryable"),
    [
        (401, codes.PROVIDER_AUTH, False),
        (400, codes.PROVIDER_BAD_REQUEST, False),
        (429, codes.PROVIDER_RATE_LIMITED, True),
        (503, codes.PROVIDER_UNAVAILABLE, True),
    ],
)
def test_openai_compativel_erros_http(status: int, code: str, retryable: bool):  # noqa: FBT001
    provider = _openai(lambda _: httpx.Response(status, json={"error": {"message": "x"}}))
    error = error_of(provider.complete("s", "p"))
    assert (error.code, error.retryable) == (code, retryable)


def test_openai_compativel_timeout_e_rede():
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("lento", request=request)

    def offline(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("recusado", request=request)

    assert error_of(_openai(timeout).complete("s", "p")).code == codes.PROVIDER_TIMEOUT
    assert error_of(_openai(offline).complete("s", "p")).code == codes.PROVIDER_UNAVAILABLE


# --- ollama ----------------------------------------------------------------------------------------


def _ollama(idle: bool, calls: list[dict[str, Any]]) -> OllamaProvider:  # noqa: FBT001
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append({"url": str(request.url), "body": json.loads(request.content)})
        return httpx.Response(200, json={"model": "qwen3:4b", "message": {"role": "assistant", "content": "resumo"}})

    async def gpu_idle() -> bool:
        return idle

    config = ProviderConfig(kind="ollama", model="qwen3:4b", base_url="http://ollama:11434")
    return OllamaProvider(config, gpu_idle=gpu_idle, transport=httpx.MockTransport(handler))


def test_ollama_espera_a_fila_da_gpu_esvaziar():
    calls: list[dict[str, Any]] = []
    error = error_of(_ollama(idle=False, calls=calls).complete("s", "p"))
    assert error.code == codes.GPU_BUSY
    assert error.retryable
    assert calls == []


def test_ollama_nao_fica_residente():
    calls: list[dict[str, Any]] = []
    completion = run(_ollama(idle=True, calls=calls).complete("s", "p"))
    assert completion.text == "resumo"
    assert calls[0]["url"] == "http://ollama:11434/api/chat"
    body = calls[0]["body"]
    assert body["keep_alive"] == 0
    assert body["stream"] is False
    assert body["options"]["num_ctx"] == 8192


def test_fabrica_exige_a_fila_para_o_ollama():
    config = ProviderConfig(kind="ollama", model="m", base_url="http://x")
    with pytest.raises(ProviderError):
        build_provider(config)
    assert isinstance(build_provider(ProviderConfig(kind="claude-cli", model="sonnet")), ClaudeCliProvider)


# --- anthropic --------------------------------------------------------------------------------------


def _sse(text: str, stop_reason: str = "end_turn") -> str:
    events = [
        (
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-opus-5",
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 10, "output_tokens": 1},
                },
            },
        ),
        (
            "content_block_start",
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        ),
        (
            "content_block_delta",
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
        ),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": stop_reason, "stop_sequence": None},
                "usage": {"output_tokens": 5},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events)


def _anthropic(
    handler: Callable[[httpx2.Request], httpx2.Response], api_key: str | None = "sk-ant-teste"
) -> AnthropicProvider:
    config = ProviderConfig(kind="anthropic", model="claude-opus-5", api_key=api_key)
    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    return AnthropicProvider(config, http_client=client)


def test_anthropic_em_streaming():
    seen: dict[str, Any] = {}

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen["key"] = request.headers["x-api-key"]
        seen["body"] = json.loads(request.content)
        return httpx2.Response(200, text=_sse("# Resumo"), headers={"content-type": "text/event-stream"})

    completion = run(_anthropic(handler).complete("sistema", "prompt"))
    assert completion == Completion(text="# Resumo", model="claude-opus-5")
    assert seen["key"] == "sk-ant-teste"
    assert seen["body"]["system"] == "sistema"
    assert seen["body"]["stream"] is True
    assert "temperature" not in seen["body"]


def test_anthropic_marca_o_contexto_para_o_cache_de_prompt():
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        bodies.append(json.loads(request.content))
        return httpx2.Response(200, text=_sse("ok"), headers={"content-type": "text/event-stream"})

    provider = _anthropic(handler)
    run(provider.complete("sistema", "tarefa", context="transcrição"))
    run(provider.complete("sistema", "tarefa"))
    assert bodies[0]["messages"][0]["content"] == [
        {"type": "text", "text": "transcrição", "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "tarefa"},
    ]
    assert bodies[1]["messages"][0]["content"] == "tarefa"


def test_anthropic_recusa_e_erros():
    refused = _anthropic(
        lambda _: httpx2.Response(200, text=_sse("", "refusal"), headers={"content-type": "text/event-stream"})
    )
    assert error_of(refused.complete("s", "p")).code == codes.PROVIDER_REFUSED

    def limited(_: httpx2.Request) -> httpx2.Response:
        body = {"type": "error", "error": {"type": "rate_limit_error", "message": "devagar"}}
        return httpx2.Response(429, json=body)

    assert error_of(_anthropic(limited).complete("s", "p")).code == codes.PROVIDER_RATE_LIMITED

    def bad_key(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(401, json={"type": "error", "error": {"type": "authentication_error", "message": "x"}})

    assert error_of(_anthropic(bad_key).complete("s", "p")).code == codes.PROVIDER_AUTH
    assert error_of(_anthropic(bad_key, api_key=None).complete("s", "p")).code == codes.PROVIDER_NOT_CONFIGURED


# --- prompt e chunking ----------------------------------------------------------------------------


class FakeProvider:
    """Provider que registra as chamadas e devolve um texto curto."""

    def __init__(self, context_window: int) -> None:
        """Janela pequena força o map-reduce."""
        self.config = ProviderConfig(
            kind="openai-compatible", model="fake", options={"context_window": context_window, "max_tokens": 200}
        )
        self.calls: list[tuple[str, str]] = []

    async def complete(self, system: str, prompt: str, *, context: str = "") -> Completion:
        """Registra a chamada."""
        self.calls.append((system, with_context(context, prompt)))
        return Completion(text=f"notas {len(self.calls)}", model="fake")


def _transcript(lines: int) -> TranscriptText:
    segments = [
        ("S1" if i % 2 else "S2", i * 7000, f"fala número {i} sobre o programa de lideranças " * 3)
        for i in range(lines)
    ]
    return render_transcript(
        title="Alinhamento", recorded_at="2026-09-18", speakers={"S1": "Mariana", "S2": "Locutor 2"}, segments=segments
    )


def test_transcricao_vira_linhas_com_tempo_e_nome():
    transcript = render_transcript(
        title="T",
        recorded_at="2026-09-18",
        speakers={"S1": "Mariana"},
        segments=[("S1", 3_723_000, " olá "), ("S2", 0, " ")],
    )
    assert transcript.lines == ["[01:02:03] Mariana: olá"]
    assert "Participantes: Mariana" in transcript.header


def test_transcricao_curta_em_uma_chamada():
    provider = FakeProvider(context_window=100_000)
    completion = run(summarize(provider, _transcript(10), "Faça uma ata."))
    assert completion.text == "notas 1"
    assert len(provider.calls) == 1
    system, prompt = provider.calls[0]
    assert system == SHARED_SYSTEM
    assert SYSTEM in prompt
    assert "Faça uma ata." in prompt
    assert prompt.index("<transcricao>") < prompt.index("Faça uma ata.")
    assert "<transcricao>" in prompt
    assert "[00:00:07] Mariana" in prompt


def test_transcricao_longa_por_map_reduce():
    provider = FakeProvider(context_window=3_000)
    transcript = _transcript(200)
    assert estimate_tokens(transcript.text()) > 3_000
    run(summarize(provider, transcript, "Faça uma ata."))
    maps = [call for call in provider.calls if call[0] == MAP_SYSTEM]
    assert len(maps) >= 3
    # O reduce final aplica o template sobre as notas, em ordem.
    system, prompt = provider.calls[-1]
    assert system == SHARED_SYSTEM
    assert "Faça uma ata." in prompt
    assert prompt.index("### Parte 1 ") < prompt.index("### Parte 2 ")
    # Nenhuma chamada passou do orçamento de entrada.
    assert all(estimate_tokens(prompt) < 3_000 for _, prompt in provider.calls)


def test_janela_pequena_demais_e_erro_explicito():
    provider = FakeProvider(context_window=600)
    assert error_of(summarize(provider, _transcript(5), "x" * 3000)).code == codes.CONTEXT_TOO_LONG


def test_secoes_respeitam_o_orcamento():
    lines = ["a" * 30] * 10  # 10 tokens + 1 cada
    assert split_sections(lines, 33) == [(0, 3), (3, 6), (6, 9), (9, 10)]
    assert split_sections(["a" * 300], 10) == [(0, 1)]


# --- extração de campos ---------------------------------------------------------------------------

CLIENTE = FieldSpec(key="cliente", kind="choice", instructions="A empresa.", options=("Serra Azul", "Vale Verde"))
TITULO = FieldSpec(key="titulo", kind="text", instructions="Um título curto.")
PENDENCIAS = FieldSpec(key="pendencias", kind="list", instructions="O que ficou para depois.")
TAGS = FieldSpec(key="tags", kind="list", instructions="De 1 a 5 tags.", max_item=64)


class ScriptedProvider(FakeProvider):
    """Responde, em ordem, os textos dados."""

    def __init__(self, context_window: int, replies: list[str]) -> None:
        """Janela e respostas."""
        super().__init__(context_window)
        self.replies = replies

    async def complete(self, system: str, prompt: str, *, context: str = "") -> Completion:
        """Registra e responde o próximo texto."""
        self.calls.append((system, with_context(context, prompt)))
        return Completion(text=self.replies.pop(0), model="fake")


def test_resposta_json_com_ou_sem_cerca():
    assert parse_object('```json\n{"titulo": "A"}\n```') == {"titulo": "A"}
    assert parse_object('Aqui está: {"titulo": null}') == {"titulo": None}
    for text in ("sem json", "[1, 2]", '{"titulo": '):
        with pytest.raises(ProviderError) as info:
            parse_object(text)
        assert (info.value.code, info.value.retryable) == (codes.PROVIDER_BAD_OUTPUT, True)


def test_valores_seguem_o_tipo_do_campo():
    assert clean(CLIENTE, "Serra Azul") == "Serra Azul"
    assert clean(CLIENTE, "Outra") is None
    assert clean(TITULO, "  " + "x" * 400) == "x" * 300
    assert clean(TITULO, ["lista"]) is None
    assert clean(PENDENCIAS, ["a", "a", " b ", 3, ""] + [f"i{n}" for n in range(20)]) == [
        "a",
        "b",
        *[f"i{n}" for n in range(8)],
    ]
    assert clean(PENDENCIAS, []) is None


def test_mescla_das_secoes():
    assert merge(CLIENTE, [None, "Vale Verde", "Serra Azul", "Serra Azul"]) == "Serra Azul"
    # Empate: o primeiro que apareceu.
    assert merge(TITULO, ["B", "A", "A", "B"]) == "B"
    assert merge(PENDENCIAS, [["a"], None, ["b", "a"]]) == ["a", "b"]
    assert merge(TITULO, [None, None]) is None


def test_campos_e_resumo_compartilham_o_system_e_o_bloco_da_transcricao():
    seen: list[tuple[str, str, str]] = []

    class Spy(FakeProvider):
        async def complete(self, system: str, prompt: str, *, context: str = "") -> Completion:
            seen.append((system, prompt, context))
            return Completion(text='{"titulo": "Kickoff"}', model="fake")

    provider = Spy(context_window=100_000)
    transcript = _transcript(10)
    run(extract_fields(provider, [TITULO], None, transcript))
    run(summarize(provider, transcript, "Faça uma ata."))
    (fields_call, summary_call) = seen
    assert fields_call[0] == summary_call[0] == SHARED_SYSTEM
    assert fields_call[2] == summary_call[2] != ""
    assert transcript.text() in fields_call[2]
    assert "<transcricao>" not in fields_call[1]


def test_extracao_curta_numa_chamada_e_longa_por_secoes():
    provider = ScriptedProvider(100_000, ['{"titulo": "Kickoff", "cliente": "Serra Azul", "pendencias": ["a"]}'])
    guide = TagGuide(tags=(("interno", "Reunião só da equipe."),))
    fields = [TITULO, CLIENTE, PENDENCIAS, TAGS]
    values, completion = run(extract_fields(provider, fields, guide, _transcript(10)))
    assert values == {"titulo": "Kickoff", "cliente": "Serra Azul", "pendencias": ["a"], "tags": None}
    assert completion.model == "fake"
    ((system, prompt),) = provider.calls
    assert system == SHARED_SYSTEM
    assert FIELDS_SYSTEM in prompt
    assert "## Tags cadastradas\n\nNo campo tags, use só tags desta lista" in prompt
    assert "- interno — Reunião só da equipe." in prompt
    assert '"cliente": "uma das opções" ou null' in prompt

    transcript = _transcript(200)
    replies = ['{"cliente": "Vale Verde", "pendencias": ["a"]}'] + [
        '{"cliente": "Serra Azul", "pendencias": ["b"]}'
    ] * 20
    provider = ScriptedProvider(3_000, replies)
    values, _ = run(extract_fields(provider, [CLIENTE, PENDENCIAS], None, transcript))
    assert len(provider.calls) >= 3
    assert all(estimate_tokens(prompt) < 3_000 for _, prompt in provider.calls)
    assert values == {"cliente": "Serra Azul", "pendencias": ["a", "b"]}
