"""Provider `openai-compatible`: `POST {base_url}/chat/completions` (DeepSeek, Groq, OpenRouter, Ollama /v1)."""

from __future__ import annotations

from typing import Any

import httpx

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

_UNAUTHORIZED = {401, 403}
_RATE_LIMITED = 429
_SERVER_ERROR = 500
_DETAIL_LIMIT = 300


def http_error(response: httpx.Response, who: str) -> ProviderError:
    """Erro tipado de uma resposta HTTP não 2xx."""
    detail = response.text[:_DETAIL_LIMIT]
    message = f"{who} respondeu {response.status_code}: {detail}"
    if response.status_code in _UNAUTHORIZED:
        return ProviderError(PROVIDER_AUTH, message)
    if response.status_code == _RATE_LIMITED:
        return ProviderError(PROVIDER_RATE_LIMITED, message)
    if response.status_code >= _SERVER_ERROR:
        return ProviderError(PROVIDER_UNAVAILABLE, message)
    if "context" in detail.lower() and ("length" in detail.lower() or "window" in detail.lower()):
        return ProviderError(CONTEXT_TOO_LONG, message)
    return ProviderError(PROVIDER_BAD_REQUEST, message)


async def post_json(  # noqa: PLR0913 — URL, corpo e o contexto da chamada, todos nomeados
    config: ProviderConfig,
    url: str,
    body: dict[str, Any],
    *,
    who: str,
    headers: dict[str, str] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """POST JSON com o timeout do provider; falhas de rede e HTTP viram `ProviderError`."""
    try:
        async with httpx.AsyncClient(timeout=config.timeout_s, transport=transport) as client:
            response = await client.post(url, json=body, headers=headers)
    except httpx.TimeoutException as exc:
        raise ProviderError(PROVIDER_TIMEOUT, f"{who} não respondeu em {config.timeout_s:.0f} s.") from exc
    except httpx.HTTPError as exc:
        raise ProviderError(PROVIDER_UNAVAILABLE, f"Sem conexão com {who}: {exc}") from exc
    if response.is_error:
        raise http_error(response, who)
    try:
        document = response.json()
    except ValueError as exc:
        raise ProviderError(PROVIDER_UNAVAILABLE, f"{who} respondeu algo que não é JSON.") from exc
    if not isinstance(document, dict):
        raise ProviderError(PROVIDER_UNAVAILABLE, f"{who} respondeu um JSON inesperado.")
    return document


class OpenAICompatibleProvider:
    """Chat Completions de qualquer API compatível com a da OpenAI."""

    def __init__(self, config: ProviderConfig, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        """Provider para `config`; `transport` troca a rede (testes)."""
        self.config = config
        self.transport = transport

    async def complete(self, system: str, prompt: str) -> Completion:
        """Uma conversa de duas mensagens (sistema e usuário)."""
        if not self.config.base_url:
            raise ProviderError(PROVIDER_NOT_CONFIGURED, "O provider openai-compatible precisa de base_url.")
        body: dict[str, Any] = {
            "model": self.config.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "max_tokens": self.config.max_output_tokens,
            "stream": False,
        }
        if self.config.temperature is not None:
            body["temperature"] = self.config.temperature
        headers = {"Authorization": f"Bearer {self.config.api_key}"} if self.config.api_key else None
        url = self.config.base_url.rstrip("/") + "/chat/completions"
        document = await post_json(
            self.config, url, body, who=self.config.name or "o provider", headers=headers, transport=self.transport
        )
        try:
            choice = document["choices"][0]
            text = str(choice["message"].get("content") or "").strip()
        except (KeyError, IndexError, TypeError, AttributeError) as exc:
            raise ProviderError(PROVIDER_UNAVAILABLE, "Resposta sem choices[0].message.content.") from exc
        if choice.get("finish_reason") == "content_filter":
            raise ProviderError(PROVIDER_REFUSED, "O provider filtrou a resposta.")
        if not text:
            raise ProviderError(PROVIDER_UNAVAILABLE, "O provider respondeu sem texto.")
        return Completion(text=text, model=str(document.get("model") or self.config.model))
