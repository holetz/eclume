"""O registro de ferramentas do Agente: cada ferramenta declara uso, validação, execução e natureza.

O laço (`agents/agent.py`) não conhece ferramenta nenhuma: ele pede ao `ToolRegistry` as linhas do
`system` das disponíveis para a credencial, valida a ação JSON pela ferramenta dona e a executa.
Natureza (`kind`): `read` consulta (a base, os anexos), `produce` prepara um arquivo para a resposta
e `action` age no ambiente — esta, com `confirm`, só roda depois da confirmação de quem pergunta,
que a spec das ações no ambiente liga (holetz/eclume#142 deixa o encaixe); até lá o laço avisa ao
agente que a ação espera confirmação. Para acrescentar uma ferramenta, registre um `AgentTool` em
`default_registry()` (ou num registro próprio). Contrato em docs/standards/code/server-agentes.md §Agente.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Protocol
from uuid import UUID

from eclume_server.agent_files import MAX_OUTPUT_CHARS, MAX_OUTPUTS_PER_REPLY, OUTPUT_TYPES
from eclume_server.agents import base_chat as base
from eclume_server.agents.prompting import estimate_tokens

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

ToolKind = Literal["read", "produce", "action"]
REPLY = "reply"
UNKNOWN_FILE = "arquivo inexistente nesta conversa"
NEEDS_CONFIRMATION = (
    "esta ação muda o ambiente e precisa da confirmação de quem pergunta, que ainda não está disponível: "
    "explique na resposta o que faria, sem dizer que fez"
)


@dataclass(frozen=True)
class Capabilities:
    """O que a credencial e a conversa permitem: ler transcrições, ter anexos, os escopos."""

    transcripts: bool = True
    files: bool = False
    scopes: frozenset[str] = frozenset()


@dataclass(frozen=True)
class InputFile:
    """Um anexo da conversa, com o texto extraído."""

    id: UUID
    name: str
    text: str


@dataclass(frozen=True)
class ProducedFile:
    """Um arquivo que o agente preparou: o job o monta (`agent_files.render_output`) e guarda."""

    name: str
    format: str
    content: str


class AgentEnv(Protocol):
    """O acesso das ferramentas ao ambiente do dono, dado pelo job."""

    @property
    def base(self) -> base.BaseTools:
        """A base de gravações, sob a RLS do dono."""
        ...

    async def read_file(self, file_id: UUID) -> InputFile | None:
        """Um anexo desta conversa, ou `None` se ele não existe ou é de outra."""
        ...


@dataclass
class RunState:
    """O que uma resposta acumula: as gravações vistas (fontes possíveis), os arquivos e as ações pendentes."""

    seen: dict[UUID, str] = field(default_factory=dict)
    produced: list[ProducedFile] = field(default_factory=list)
    pending_actions: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class AgentTool:
    """Uma ferramenta: o nome da ação, a linha de uso no `system`, a validação e a execução.

    `run(env, action, budget, state)` devolve o bloco `<ferramenta>` para o agente e o registro da
    chamada. `available(caps)` diz se a credencial a enxerga. `kind="action"` com `confirm=True`
    nunca roda sem a confirmação de quem pergunta.
    """

    name: str
    usage: str
    validate: Callable[[dict[str, Any]], bool]
    run: Callable[[AgentEnv, dict[str, Any], int, RunState], Awaitable[tuple[str, dict[str, Any]]]]
    kind: ToolKind = "read"
    confirm: bool = False
    available: Callable[[Capabilities], bool] = field(default=lambda _caps: True)


class ToolRegistry:
    """As ferramentas do agente por nome, na ordem de registro; `reply` é reservada ao laço."""

    def __init__(self, tools: list[AgentTool] | None = None) -> None:
        """Registro com as ferramentas dadas, na ordem."""
        self._tools: dict[str, AgentTool] = {}
        for tool in tools or []:
            self.register(tool)

    def register(self, tool: AgentTool) -> None:
        """Acrescenta uma ferramenta; nome repetido ou `reply` é `ValueError`."""
        if tool.name == REPLY or tool.name in self._tools:
            raise ValueError(f"ferramenta já registrada ou reservada: {tool.name}")
        if tool.kind == "action" and not tool.confirm:
            raise ValueError(f"ação sem confirmação: {tool.name}")
        self._tools[tool.name] = tool

    def get(self, name: str) -> AgentTool | None:
        """A ferramenta pelo nome."""
        return self._tools.get(name)

    def available(self, caps: Capabilities) -> list[AgentTool]:
        """As ferramentas que a credencial enxerga, na ordem de registro."""
        return [tool for tool in self._tools.values() if tool.available(caps)]

    def names(self, caps: Capabilities) -> list[str]:
        """Os nomes das ações válidas para a credencial, com `reply` no fim."""
        return [tool.name for tool in self.available(caps)] + [REPLY]


# --- as ferramentas da base (as do chat sobre a base, reaproveitadas) -----------------------------


def _base_tool(name: str, *, transcripts: bool) -> AgentTool:
    async def run(env: AgentEnv, action: dict[str, Any], budget: int, state: RunState) -> tuple[str, dict[str, Any]]:
        return await base._run_tool(env.base, action, budget, state.seen)  # noqa: SLF001 — o mesmo protocolo

    return AgentTool(
        name=name,
        usage=base._ACTIONS[name],  # noqa: SLF001
        validate=base._valid,  # noqa: SLF001
        run=run,
        available=(lambda caps: caps.transcripts) if transcripts else (lambda _caps: True),
    )


# --- os anexos -----------------------------------------------------------------------------------


def _file_id(value: object) -> UUID | None:
    try:
        return UUID(str(value).strip())
    except ValueError:
        return None


def _offset(value: object) -> int | None:
    if value is None:
        return 0
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def _valid_read_file(action: dict[str, Any]) -> bool:
    return _file_id(action.get("file_id")) is not None and _offset(action.get("offset")) is not None


def clip_chars(text: str, budget: int) -> str:
    """O começo do texto que cabe em `budget` tokens."""
    if estimate_tokens(text) <= budget:
        return text
    return text[: max(budget, 0) * 3]


async def _read_file(
    env: AgentEnv, action: dict[str, Any], budget: int, _state: RunState
) -> tuple[str, dict[str, Any]]:
    file_id = _file_id(action["file_id"])
    assert file_id is not None  # noqa: S101 — validado
    offset = _offset(action.get("offset")) or 0
    record = {"tool": "read_file", "file_id": str(file_id), "offset": offset}
    found = await env.read_file(file_id)
    attributes = f' arquivo="{file_id}"'
    if found is None:
        return base._block("read_file", attributes, UNKNOWN_FILE), record  # noqa: SLF001
    chunk = clip_chars(found.text[offset:], budget)
    end = offset + len(chunk)
    body = f'"{found.name}" (caracteres {offset} a {end} de {len(found.text)})\n{chunk or "(sem texto legível)"}'
    if end < len(found.text):
        body += f'\n(continua: leia de novo com "offset": {end})'
    return base._block("read_file", attributes, body), record  # noqa: SLF001


# --- os arquivos de saída ------------------------------------------------------------------------


def _valid_write_file(action: dict[str, Any]) -> bool:
    name, fmt, content = action.get("name"), action.get("format"), action.get("content")
    return (
        isinstance(name, str)
        and bool(name.strip())
        and fmt in OUTPUT_TYPES
        and isinstance(content, str)
        and bool(content.strip())
    )


async def _write_file(
    _env: AgentEnv, action: dict[str, Any], _budget: int, state: RunState
) -> tuple[str, dict[str, Any]]:
    name, fmt, content = action["name"].strip(), action["format"], action["content"]
    record = {"tool": "write_file", "name": name, "format": fmt}
    attributes = f" nome={json.dumps(name, ensure_ascii=False)}"
    if len(state.produced) >= MAX_OUTPUTS_PER_REPLY:
        body = f"limite de {MAX_OUTPUTS_PER_REPLY} arquivos por resposta atingido; nada foi gerado"
        return base._block("write_file", attributes, body), record  # noqa: SLF001
    clipped = len(content) > MAX_OUTPUT_CHARS
    state.produced.append(ProducedFile(name=name, format=fmt, content=content[:MAX_OUTPUT_CHARS]))
    body = f"arquivo .{fmt} preparado; ele vai anexado à resposta para baixar"
    if clipped:
        body += f" (cortado em {MAX_OUTPUT_CHARS} caracteres)"
    return base._block("write_file", attributes, body), record  # noqa: SLF001


READ_FILE = AgentTool(
    name="read_file",
    usage=(
        '{"action": "read_file", "file_id": "id", "offset": 0} — lê o texto de um arquivo anexado à '
        "conversa, a partir do caractere `offset`;"
    ),
    validate=_valid_read_file,
    run=_read_file,
    available=lambda caps: caps.files,
)
WRITE_FILE = AgentTool(
    name="write_file",
    usage=(
        '{"action": "write_file", "name": "nome", "format": "md|txt|csv|docx", "content": "o conteúdo"} — '
        "gera um arquivo para a pessoa baixar (o docx a partir de Markdown);"
    ),
    validate=_valid_write_file,
    run=_write_file,
    kind="produce",
)


def default_registry() -> ToolRegistry:
    """As ferramentas do Agente: a base (resumos, depois transcrições), os anexos e os arquivos gerados."""
    return ToolRegistry(
        [
            _base_tool("search_summaries", transcripts=False),
            _base_tool("read_summary", transcripts=False),
            _base_tool("search_transcripts", transcripts=True),
            _base_tool("read_transcript", transcripts=True),
            READ_FILE,
            WRITE_FILE,
        ]
    )


__all__ = [
    "NEEDS_CONFIRMATION",
    "REPLY",
    "AgentEnv",
    "AgentTool",
    "Capabilities",
    "InputFile",
    "ProducedFile",
    "RunState",
    "ToolRegistry",
    "default_registry",
]
