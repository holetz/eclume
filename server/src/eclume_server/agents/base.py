"""Common interface of the agent providers and the typed errors the summary job understands."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

# Not retryable: trying again gives the same result.
PROVIDER_AUTH = "provider_auth"
PROVIDER_BAD_REQUEST = "provider_bad_request"
PROVIDER_REFUSED = "provider_refused"
PROVIDER_NOT_CONFIGURED = "provider_not_configured"
CONTEXT_TOO_LONG = "context_too_long"
# Retryable: a failure on the other side or in the network.
PROVIDER_TIMEOUT = "provider_timeout"
PROVIDER_RATE_LIMITED = "provider_rate_limited"
PROVIDER_UNAVAILABLE = "provider_unavailable"
# The reply did not come in the requested format (extraction JSON); another attempt usually gets it right.
PROVIDER_BAD_OUTPUT = "provider_bad_output"
# Ollama postponement while the GPU queue has work; does not spend an attempt.
GPU_BUSY = "gpu_busy"
# The adjustment chat exceeded the limit of transcript queries without answering; permanent.
CHAT_TOOL_LIMIT = "chat_tool_limit"

_RETRYABLE = {PROVIDER_TIMEOUT, PROVIDER_RATE_LIMITED, PROVIDER_UNAVAILABLE, PROVIDER_BAD_OUTPUT, GPU_BUSY}

# Context window and maximum output (tokens) when `options` does not say.
DEFAULT_CONTEXT_WINDOW = {"claude-cli": 200_000, "anthropic": 200_000, "openai-compatible": 32_000, "ollama": 8_192}
DEFAULT_MAX_OUTPUT = {"claude-cli": 8_192, "anthropic": 8_192, "openai-compatible": 4_096, "ollama": 2_048}
DEFAULT_TIMEOUT_S = 600.0


class ProviderError(Exception):
    """A provider failure, with a stable `code` (it becomes `Summary.error.code`)."""

    def __init__(self, code: str, message: str) -> None:
        """Error with a code and a message readable by the user."""
        super().__init__(message)
        self.code = code
        self.message = message

    @property
    def retryable(self) -> bool:
        """Trying again may succeed."""
        return self.code in _RETRYABLE


@dataclass(frozen=True)
class Completion:
    """Generated text and the model that answered."""

    text: str
    model: str


@dataclass(frozen=True)
class ProviderConfig:
    """A registered provider, with the key already decrypted."""

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
        """Context window in tokens (`options.context_window`)."""
        return int(self._number("context_window", DEFAULT_CONTEXT_WINDOW.get(self.kind, 8_192)))

    @property
    def max_output_tokens(self) -> int:
        """Ceiling of output tokens (`options.max_tokens`)."""
        return int(self._number("max_tokens", DEFAULT_MAX_OUTPUT.get(self.kind, 2_048)))

    @property
    def timeout_s(self) -> float:
        """Maximum time of one call (`options.timeout_s`)."""
        return self._number("timeout_s", DEFAULT_TIMEOUT_S)

    @property
    def temperature(self) -> float | None:
        """`options.temperature`, when the admin set one."""
        value = self.options.get("temperature")
        return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


class Provider(Protocol):
    """An agent that turns a prompt into text."""

    config: ProviderConfig

    async def complete(self, system: str, prompt: str, *, context: str = "") -> Completion:
        """One call: system instructions and the user prompt → text.

        `context` is the material that several calls on the same recording repeat (the transcript): it goes
        before the `prompt` in the user message and, where the provider caches prefixes, it is the marked block.
        """
        ...


def with_context(context: str, prompt: str) -> str:
    """The user message of the providers without cache marking: the context and then the prompt."""
    return f"{context}\n\n{prompt}" if context else prompt
