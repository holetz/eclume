"""Provider `claude-cli`: o `claude -p` do servidor, sem nenhuma ferramenta.

Segue o padrão do `agent_launcher.py` do lumea: subprocess, credencial (`ANTHROPIC_API_KEY`, o
token de longa duração do `claude setup-token` em `CLAUDE_CODE_OAUTH_TOKEN`, ou o OAuth de uma sessão
logada do Claude Code em `$HOME/.claude/.credentials.json`) checada antes de rodar, e a causa de uma falha lida do JSON que a própria CLI devolve. O agente não tem
ferramentas nem configurações do usuário ou do projeto: só texto de entrada e de saída.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from eclume_server.agents.base import (
    CONTEXT_TOO_LONG,
    PROVIDER_AUTH,
    PROVIDER_BAD_REQUEST,
    PROVIDER_NOT_CONFIGURED,
    PROVIDER_RATE_LIMITED,
    PROVIDER_TIMEOUT,
    PROVIDER_UNAVAILABLE,
    Completion,
    ProviderConfig,
    ProviderError,
    with_context,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

API_KEY_ENV = "ANTHROPIC_API_KEY"
OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN"  # noqa: S105 — nome da variável, não o segredo
OAUTH_TOKEN_PREFIX = "sk-ant-oat"  # noqa: S105 — prefixo do token do `claude setup-token`
OAUTH_CREDENTIALS = Path(".claude") / ".credentials.json"
_AUTH_MARKERS = ("authentication_failed", "not logged in", "please run /login", "invalid api key", "401", "oauth")
_RATE_MARKERS = ("rate limit", "rate_limit", "429", "overloaded", "529", "usage limit")
_CONTEXT_MARKERS = ("prompt is too long", "context length", "context window", "too many tokens")
_MODEL_MARKERS = ("model", "not_found", "404")
_DETAIL_LIMIT = 300


def claude_command(claude_bin: str, config: ProviderConfig, system: str) -> list[str]:
    """Linha de comando do `claude -p`: saída JSON, sem ferramentas, sem sessão nem settings."""
    cmd = [
        claude_bin,
        "-p",
        "--output-format",
        "json",
        "--model",
        config.model,
        "--tools",
        "",
        "--system-prompt",
        system,
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--permission-mode",
        "dontAsk",
    ]
    effort = config.options.get("effort")
    if isinstance(effort, str) and effort:
        cmd += ["--effort", effort]
    return cmd


def missing_credentials(env: Mapping[str, str]) -> bool:
    """Sem `ANTHROPIC_API_KEY`, sem `CLAUDE_CODE_OAUTH_TOKEN` e sem o OAuth do Claude Code no `HOME`.

    Um arquivo vazio conta como ausente, como o `/dev/null` que um deploy antigo montava no lugar.
    """
    if env.get(API_KEY_ENV, "").strip() or env.get(OAUTH_TOKEN_ENV, "").strip():
        return False
    home = env.get("HOME") or str(Path.home())
    try:
        return (Path(home) / OAUTH_CREDENTIALS).stat().st_size == 0
    except OSError:
        return True


def classify_failure(detail: str) -> str:
    """Código de erro a partir da causa que a CLI declarou."""
    lowered = detail.lower()
    if any(marker in lowered for marker in _AUTH_MARKERS):
        return PROVIDER_AUTH
    if any(marker in lowered for marker in _RATE_MARKERS):
        return PROVIDER_RATE_LIMITED
    if any(marker in lowered for marker in _CONTEXT_MARKERS):
        return CONTEXT_TOO_LONG
    if "invalid" in lowered and any(marker in lowered for marker in _MODEL_MARKERS):
        return PROVIDER_BAD_REQUEST
    return PROVIDER_UNAVAILABLE


def _parse(stdout: str) -> dict[str, Any] | None:
    """O objeto `type: result` da saída `--output-format json` (último objeto JSON)."""
    text = stdout.strip()
    if not text:
        return None
    try:
        document = json.loads(text)
    except ValueError:
        document = None
        for line in reversed(text.splitlines()):
            with contextlib.suppress(ValueError):
                document = json.loads(line)
                break
    if isinstance(document, list):
        document = next((item for item in reversed(document) if isinstance(item, dict)), None)
    return document if isinstance(document, dict) else None


def _model(result: dict[str, Any], fallback: str) -> str:
    usage = result.get("modelUsage")
    if isinstance(usage, dict) and usage:
        return str(next(iter(usage)))
    return fallback


class ClaudeCliProvider:
    """`claude -p` num subprocesso, com o prompt pelo stdin."""

    def __init__(
        self, config: ProviderConfig, *, claude_bin: str = "claude", env: Mapping[str, str] | None = None
    ) -> None:
        """Provider para `config`; `env` substitui o ambiente do processo (testes)."""
        self.config = config
        self.claude_bin = claude_bin
        self.env = dict(os.environ if env is None else env)
        if config.api_key:
            # O segredo cadastrado no provider vence o do ambiente: o token do `claude setup-token`
            # autentica por CLAUDE_CODE_OAUTH_TOKEN, uma chave de API por ANTHROPIC_API_KEY.
            token = config.api_key.startswith(OAUTH_TOKEN_PREFIX)
            self.env.pop(API_KEY_ENV if token else OAUTH_TOKEN_ENV, None)
            self.env[OAUTH_TOKEN_ENV if token else API_KEY_ENV] = config.api_key

    async def complete(self, system: str, prompt: str, *, context: str = "") -> Completion:
        """Roda `claude -p` e devolve o `result` do JSON."""
        if missing_credentials(self.env):
            raise ProviderError(
                PROVIDER_NOT_CONFIGURED,
                "O claude -p do servidor não tem credencial: defina CLAUDE_CODE_OAUTH_TOKEN (claude "
                "setup-token) ou ANTHROPIC_API_KEY no worker.",
            )
        cmd = claude_command(self.claude_bin, self.config, system)
        # Diretório vazio: nenhum CLAUDE.md nem configuração de projeto entra no agente.
        with tempfile.TemporaryDirectory(prefix="eclume-claude-") as cwd:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=cwd,
                    env=self.env,
                )
            except OSError as exc:
                raise ProviderError(
                    PROVIDER_NOT_CONFIGURED, f"Não foi possível executar {self.claude_bin}: {exc}"
                ) from exc
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(with_context(context, prompt).encode()), self.config.timeout_s
                )
            except TimeoutError as exc:
                raise ProviderError(
                    PROVIDER_TIMEOUT, f"claude -p passou de {self.config.timeout_s:.0f} s sem responder."
                ) from exc
            finally:
                # O processo não sobrevive ao job: teto próprio, timeout do arq (`CancelledError`) ou
                # parada do worker o matam aqui.
                if proc.returncode is None:
                    proc.kill()
                    await proc.wait()
        result = _parse(stdout.decode(errors="replace"))
        if proc.returncode == 0 and result is not None and not result.get("is_error"):
            text = str(result.get("result") or "").strip()
            if not text:
                raise ProviderError(PROVIDER_UNAVAILABLE, "claude -p terminou sem texto.")
            return Completion(text=text, model=_model(result, self.config.model))
        detail = ""
        if result is not None:
            detail = str(result.get("result") or result.get("subtype") or "").strip()
            if result.get("api_error_status"):
                detail = f"{detail} (HTTP {result['api_error_status']})"
        if not detail:
            lines = stderr.decode(errors="replace").strip().splitlines()
            detail = lines[-1] if lines else f"código de saída {proc.returncode}"
        detail = detail[:_DETAIL_LIMIT]
        raise ProviderError(classify_failure(detail), f"claude -p falhou: {detail}")
