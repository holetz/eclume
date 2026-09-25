"""Provider `anthropic`: a API da Anthropic pelo SDK oficial, com a chave cadastrada pelo admin."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import anthropic

from eclume_server.agents.base import (
    CONTEXT_TOO_LONG,
    PROVIDER_AUTH,
    PROVIDER_BAD_REQUEST,
    PROVIDER_NOT_CONFIGURED,
    PROVIDER_RATE_LIMITED,
    PROVIDER_REFUSED,
    PROVIDER_TIMEOUT,
    PROVIDER_UNAVAILABLE,
    Completion,
    ProviderConfig,
    ProviderError,
)

if TYPE_CHECKING:
    import httpx2

_SERVER_ERROR = 500


def _status_error(exc: anthropic.APIStatusError) -> ProviderError:
    message = f"API da Anthropic respondeu {exc.status_code}: {exc.message}"
    if exc.status_code >= _SERVER_ERROR:
        return ProviderError(PROVIDER_UNAVAILABLE, message)
    if "prompt is too long" in exc.message.lower():
        return ProviderError(CONTEXT_TOO_LONG, message)
    return ProviderError(PROVIDER_BAD_REQUEST, message)


class AnthropicProvider:
    """Messages API em streaming (respostas longas não esbarram no timeout HTTP)."""

    def __init__(self, config: ProviderConfig, *, http_client: httpx2.AsyncClient | None = None) -> None:
        """Provider para `config`; `http_client` troca o transporte (testes)."""
        self.config = config
        self._http_client = http_client

    def _client(self) -> anthropic.AsyncAnthropic:
        if not self.config.api_key:
            # Sem chave explícita o SDK cairia em variáveis de ambiente e perfis do processo.
            raise ProviderError(
                PROVIDER_NOT_CONFIGURED,
                "O provider anthropic não tem api_key cadastrada nem o segredo anthropic_api_key da organização.",
            )
        # As retentativas são do job de resumo, que registra cada tentativa.
        return anthropic.AsyncAnthropic(
            api_key=self.config.api_key,
            base_url=self.config.base_url or None,
            timeout=self.config.timeout_s,
            max_retries=0,
            http_client=self._http_client,
        )

    async def complete(self, system: str, prompt: str) -> Completion:
        """Uma mensagem com o prompt; recusa e erros da API viram `ProviderError`."""
        params: dict[str, Any] = {
            "model": self.config.model,
            "max_tokens": self.config.max_output_tokens,
            "system": system,
            "messages": [{"role": "user", "content": prompt}],
        }
        if self.config.temperature is not None:
            params["temperature"] = self.config.temperature
        try:
            async with self._client().messages.stream(**params) as stream:
                message = await stream.get_final_message()
        except anthropic.AuthenticationError as exc:
            raise ProviderError(PROVIDER_AUTH, f"Chave da API da Anthropic recusada: {exc.message}") from exc
        except anthropic.PermissionDeniedError as exc:
            raise ProviderError(PROVIDER_AUTH, f"Chave sem permissão: {exc.message}") from exc
        except anthropic.RateLimitError as exc:
            raise ProviderError(PROVIDER_RATE_LIMITED, f"Limite de uso da API da Anthropic: {exc.message}") from exc
        except anthropic.APIStatusError as exc:
            raise _status_error(exc) from exc
        except anthropic.APITimeoutError as exc:
            raise ProviderError(PROVIDER_TIMEOUT, "A API da Anthropic não respondeu a tempo.") from exc
        except anthropic.APIConnectionError as exc:
            raise ProviderError(PROVIDER_UNAVAILABLE, f"Sem conexão com a API da Anthropic: {exc}") from exc
        if message.stop_reason == "refusal":
            raise ProviderError(PROVIDER_REFUSED, "O modelo recusou gerar o resumo.")
        text = "".join(block.text for block in message.content if block.type == "text").strip()
        if not text:
            raise ProviderError(PROVIDER_UNAVAILABLE, "A API da Anthropic respondeu sem texto.")
        return Completion(text=text, model=message.model)
