"""Summarization agents: providers, prompt and chunking (docs/standards/code/server-agentes.md)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from eclume_server.agents.base import (
    PROVIDER_NOT_CONFIGURED,
    Completion,
    Provider,
    ProviderConfig,
    ProviderError,
)

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

__all__ = ["Completion", "Provider", "ProviderConfig", "ProviderError", "build_provider"]


def build_provider(
    config: ProviderConfig, *, claude_bin: str = "claude", gpu_idle: Callable[[], Awaitable[bool]] | None = None
) -> Provider:
    """The provider of the registered type; the provider's module is only imported when the type is used."""
    match config.kind:
        case "claude-cli":
            from eclume_server.agents.claude_cli import ClaudeCliProvider  # noqa: PLC0415

            return ClaudeCliProvider(config, claude_bin=claude_bin)
        case "anthropic":
            from eclume_server.agents.anthropic_api import AnthropicProvider  # noqa: PLC0415

            return AnthropicProvider(config)
        case "openai-compatible":
            from eclume_server.agents.openai_compat import OpenAICompatibleProvider  # noqa: PLC0415

            return OpenAICompatibleProvider(config)
        case "ollama":
            from eclume_server.agents.ollama import OllamaProvider  # noqa: PLC0415

            if gpu_idle is None:
                raise ProviderError(PROVIDER_NOT_CONFIGURED, "O Ollama precisa consultar a fila da GPU.")
            return OllamaProvider(config, gpu_idle=gpu_idle)
    raise ProviderError(PROVIDER_NOT_CONFIGURED, f"Tipo de provider desconhecido: {config.kind}")
