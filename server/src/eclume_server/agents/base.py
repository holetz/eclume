"""Interface comum dos providers de agente e os erros tipados que o job de resumo entende."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

# Não retentáveis: tentar de novo dá o mesmo resultado.
PROVIDER_AUTH = "provider_auth"
PROVIDER_BAD_REQUEST = "provider_bad_request"
PROVIDER_REFUSED = "provider_refused"
PROVIDER_NOT_CONFIGURED = "provider_not_configured"
CONTEXT_TOO_LONG = "context_too_long"
# Retentáveis: falha do outro lado ou da rede.
PROVIDER_TIMEOUT = "provider_timeout"
PROVIDER_RATE_LIMITED = "provider_rate_limited"
PROVIDER_UNAVAILABLE = "provider_unavailable"
# A resposta não veio no formato pedido (JSON da extração); outra tentativa costuma acertar.
PROVIDER_BAD_OUTPUT = "provider_bad_output"
# Adiamento do Ollama enquanto a fila da GPU tem trabalho; não gasta tentativa.
GPU_BUSY = "gpu_busy"
# O chat de ajuste passou do limite de consultas à transcrição sem responder; definitivo.
CHAT_TOOL_LIMIT = "chat_tool_limit"

_RETRYABLE = {PROVIDER_TIMEOUT, PROVIDER_RATE_LIMITED, PROVIDER_UNAVAILABLE, PROVIDER_BAD_OUTPUT, GPU_BUSY}

# Janela de contexto e saída máxima (tokens) quando `options` não diz.
DEFAULT_CONTEXT_WINDOW = {"claude-cli": 200_000, "anthropic": 200_000, "openai-compatible": 32_000, "ollama": 8_192}
DEFAULT_MAX_OUTPUT = {"claude-cli": 8_192, "anthropic": 8_192, "openai-compatible": 4_096, "ollama": 2_048}
DEFAULT_TIMEOUT_S = 600.0


class ProviderError(Exception):
    """Falha de um provider, com `code` estável (vira `Summary.error.code`)."""

    def __init__(self, code: str, message: str) -> None:
        """Erro com código e mensagem legível pelo usuário."""
        super().__init__(message)
        self.code = code
        self.message = message

    @property
    def retryable(self) -> bool:
        """Tentar de novo pode dar certo."""
        return self.code in _RETRYABLE


@dataclass(frozen=True)
class Completion:
    """Texto gerado e o modelo que respondeu."""

    text: str
    model: str


@dataclass(frozen=True)
class ProviderConfig:
    """Um provider cadastrado, com a chave já decifrada."""

    kind: str
    model: str
    name: str = ""
    base_url: str | None = None
    api_key: str | None = None
    options: dict[str, Any] = field(default_factory=dict)

    def _number(self, key: str, default: float) -> float:
        value = self.options.get(key)
        return float(value) if isinstance(value, int | float) and not isinstance(value, bool) and value > 0 else default

    @property
    def context_window(self) -> int:
        """Janela de contexto em tokens (`options.context_window`)."""
        return int(self._number("context_window", DEFAULT_CONTEXT_WINDOW.get(self.kind, 8_192)))

    @property
    def max_output_tokens(self) -> int:
        """Teto de tokens de saída (`options.max_tokens`)."""
        return int(self._number("max_tokens", DEFAULT_MAX_OUTPUT.get(self.kind, 2_048)))

    @property
    def timeout_s(self) -> float:
        """Tempo máximo de uma chamada (`options.timeout_s`)."""
        return self._number("timeout_s", DEFAULT_TIMEOUT_S)

    @property
    def temperature(self) -> float | None:
        """`options.temperature`, quando o admin fixou uma."""
        value = self.options.get("temperature")
        return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


class Provider(Protocol):
    """Um agente que transforma um prompt em texto."""

    config: ProviderConfig

    async def complete(self, system: str, prompt: str) -> Completion:
        """Uma chamada: instruções de sistema e o prompt do usuário → texto."""
        ...
