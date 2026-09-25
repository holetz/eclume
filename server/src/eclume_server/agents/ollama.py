"""Provider `ollama`: `POST {base_url}/api/chat`, não residente e só com a fila da GPU vazia.

A GTX 1660 (6 GB) não comporta o ASR e um LLM ao mesmo tempo. Antes de cada chamada o provider
pergunta se `eclume:gpu` está vazia — o arq mantém o job na fila até ele terminar, então vazia quer
dizer nada enfileirado e nada rodando — e pede `keep_alive: 0`, para o Ollama descarregar o modelo
assim que responder. Fila ocupada vira `gpu_busy`, que o job de resumo adia sem gastar tentativa.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from eclume_server.agents.base import (
    GPU_BUSY,
    PROVIDER_NOT_CONFIGURED,
    PROVIDER_UNAVAILABLE,
    Completion,
    ProviderConfig,
    ProviderError,
)
from eclume_server.agents.openai_compat import post_json

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    import httpx


class OllamaProvider:
    """API nativa do Ollama, que aceita `keep_alive` e `num_ctx`."""

    def __init__(
        self,
        config: ProviderConfig,
        *,
        gpu_idle: Callable[[], Awaitable[bool]],
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """Provider para `config`; `gpu_idle` diz se a fila da GPU está vazia."""
        self.config = config
        self.gpu_idle = gpu_idle
        self.transport = transport

    async def complete(self, system: str, prompt: str) -> Completion:
        """Uma conversa, com o modelo descarregado logo depois."""
        if not self.config.base_url:
            raise ProviderError(PROVIDER_NOT_CONFIGURED, "O provider ollama precisa de base_url.")
        if not await self.gpu_idle():
            raise ProviderError(GPU_BUSY, "A fila da GPU tem transcrições; o Ollama espera ela esvaziar.")
        options: dict[str, Any] = {"num_ctx": self.config.context_window, "num_predict": self.config.max_output_tokens}
        if self.config.temperature is not None:
            options["temperature"] = self.config.temperature
        body = {
            "model": self.config.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "stream": False,
            "keep_alive": 0,
            "options": options,
        }
        url = self.config.base_url.rstrip("/") + "/api/chat"
        document = await post_json(self.config, url, body, who="o Ollama", transport=self.transport)
        message = document.get("message")
        text = str(message.get("content") or "").strip() if isinstance(message, dict) else ""
        if not text:
            raise ProviderError(PROVIDER_UNAVAILABLE, "O Ollama respondeu sem texto.")
        return Completion(text=text, model=str(document.get("model") or self.config.model))
