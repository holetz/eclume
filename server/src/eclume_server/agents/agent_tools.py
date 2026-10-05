"""O registro de ferramentas do Agente: cada ferramenta declara uso, validação, execução e natureza.

O laço (`agents/agent.py`) não conhece ferramenta nenhuma: ele pede ao `ToolRegistry` as linhas do
`system` das disponíveis para a credencial, valida a ação JSON pela ferramenta dona e a executa.
Natureza (`kind`): `read` consulta (a base, os anexos, as habilidades), `produce` prepara um arquivo
para a resposta e `action` age no ambiente — esta, com `confirm`, nunca roda no laço: o `plan` dela
resolve os alvos e registra uma proposta, que a pessoa confirma num cartão e o job `agent_action`
executa (holetz/eclume#145). Uma ação sem `plan` só avisa ao agente que precisa de confirmação. Para
acrescentar uma ferramenta, registre um `AgentTool` em `default_registry()` (ou num registro próprio).
Contrato em docs/standards/code/server-agentes.md §Agente.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date
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
MAX_PROPOSALS = 3
MAX_SKILL_CHARS = 8000
# Até quantas gravações uma ação alcança: regenerar resumos pesa na fila e na cota.
MAX_TARGETS = {"regenerate_summaries": 20, "tag_recordings": 50, "collect_recordings": 50, "set_agenda_type": 50}
TARGET_FILTERS = ("agenda_type", "from", "to", "collection", "tag")
MAX_LABELS = 10
SHOWN_TARGETS = 10
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
    # A pessoa tem habilidades ligadas que o agente pode escolher (`use_skill`).
    skills: bool = False


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


@dataclass(frozen=True)
class Skill:
    """Uma habilidade da pessoa: as instruções e, opcionalmente, as ferramentas permitidas (nulo = todas)."""

    name: str
    description: str
    instructions: str
    allowed_tools: tuple[str, ...] | None = None


@dataclass(frozen=True)
class ProposedAction:
    """Uma ação que o agente propôs: os parâmetros normalizados, o texto do cartão e os alvos `(id, título)`."""

    tool: str
    params: dict[str, Any]
    summary: str
    targets: list[tuple[UUID, str]]


class AgentEnv(Protocol):
    """O acesso das ferramentas ao ambiente do dono, dado pelo job."""

    @property
    def base(self) -> base.BaseTools:
        """A base de gravações, sob a RLS do dono."""
        ...

    async def read_file(self, file_id: UUID) -> InputFile | None:
        """Um anexo desta conversa, ou `None` se ele não existe ou é de outra."""
        ...

    async def skill(self, name: str) -> Skill | None:
        """A habilidade ligada da pessoa com esse nome, ou `None`."""
        ...

    async def plan_action(self, tool: str, params: dict[str, Any], limit: int) -> ProposedAction | str:
        """Resolve os alvos sob a RLS e escreve o resumo; o motivo (texto) quando não há proposta."""
        ...


@dataclass
class RunState:
    """O que uma resposta acumula: as gravações vistas (fontes possíveis), os arquivos e as ações pendentes."""

    seen: dict[UUID, str] = field(default_factory=dict)
    produced: list[ProducedFile] = field(default_factory=list)
    pending_actions: list[dict[str, Any]] = field(default_factory=list)
    proposals: list[ProposedAction] = field(default_factory=list)
    # A habilidade em uso e as ferramentas que ela permite (nulo = todas).
    skill: str | None = None
    allowed: frozenset[str] | None = None


@dataclass(frozen=True)
class AgentTool:
    """Uma ferramenta: o nome da ação, a linha de uso no `system`, a validação e a execução.

    `run(env, action, budget, state)` devolve o bloco `<ferramenta>` para o agente e o registro da
    chamada. `available(caps)` diz se a credencial a enxerga. `kind="action"` com `confirm=True`
    nunca roda no laço: `plan(env, action, state)` registra a proposta e devolve o bloco.
    `description` é a frase do catálogo (`GET /agent/tools`).
    """

    name: str
    usage: str
    validate: Callable[[dict[str, Any]], bool]
    run: Callable[[AgentEnv, dict[str, Any], int, RunState], Awaitable[tuple[str, dict[str, Any]]]]
    kind: ToolKind = "read"
    confirm: bool = False
    available: Callable[[Capabilities], bool] = field(default=lambda _caps: True)
    description: str = ""
    plan: Callable[[AgentEnv, dict[str, Any], RunState], Awaitable[tuple[str, dict[str, Any]]]] | None = None


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

    def available(self, caps: Capabilities, allowed: frozenset[str] | None = None) -> list[AgentTool]:
        """As ferramentas que a credencial enxerga (e a habilidade em uso permite), na ordem de registro."""
        return [
            tool for tool in self._tools.values() if tool.available(caps) and (allowed is None or tool.name in allowed)
        ]

    def names(self, caps: Capabilities, allowed: frozenset[str] | None = None) -> list[str]:
        """Os nomes das ações válidas para a credencial, com `reply` no fim."""
        return [tool.name for tool in self.available(caps, allowed)] + [REPLY]

    def catalog(self) -> list[dict[str, str]]:
        """Todas as ferramentas, com a natureza e a descrição (o seletor de ferramentas de uma habilidade)."""
        tools = self._tools.values()
        return [{"name": tool.name, "kind": tool.kind, "description": tool.description} for tool in tools]


# --- as ferramentas da base (as do chat sobre a base, reaproveitadas) -----------------------------


_BASE_DESCRIPTIONS = {
    "search_summaries": "Busca nos resumos das gravações.",
    "read_summary": "Lê o resumo de uma gravação.",
    "search_transcripts": "Busca nas transcrições.",
    "read_transcript": "Lê um trecho da transcrição.",
}


def _base_tool(name: str, *, transcripts: bool) -> AgentTool:
    async def run(env: AgentEnv, action: dict[str, Any], budget: int, state: RunState) -> tuple[str, dict[str, Any]]:
        return await base._run_tool(env.base, action, budget, state.seen)  # noqa: SLF001 — o mesmo protocolo

    return AgentTool(
        name=name,
        usage=base._ACTIONS[name],  # noqa: SLF001
        validate=base._valid,  # noqa: SLF001
        run=run,
        available=(lambda caps: caps.transcripts) if transcripts else (lambda _caps: True),
        description=_BASE_DESCRIPTIONS[name],
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
    description="Lê o texto de um arquivo anexado à conversa.",
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
    description="Gera um arquivo .md, .txt, .csv ou .docx para baixar.",
)


# --- as habilidades -----------------------------------------------------------------------------


def skill_name(value: object) -> str | None:
    """O nome da habilidade sem a barra, em minúsculas, ou `None` se não é texto."""
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().lstrip("/").lower()


async def _use_skill(
    env: AgentEnv, action: dict[str, Any], _budget: int, state: RunState
) -> tuple[str, dict[str, Any]]:
    name = skill_name(action["name"]) or ""
    record = {"tool": "use_skill", "name": name}
    attributes = f" nome={json.dumps(name, ensure_ascii=False)}"
    if state.skill is not None:
        body = f"a habilidade /{state.skill} já está em uso nesta resposta"
        return base._block("use_skill", attributes, body), record  # noqa: SLF001
    found = await env.skill(name)
    if found is None:
        return base._block("use_skill", attributes, "habilidade inexistente ou desligada"), record  # noqa: SLF001
    apply_skill(state, found)
    body = (
        f"Instruções da habilidade /{found.name}, escritas pela própria pessoa: siga-as nesta resposta.\n"
        + found.instructions[:MAX_SKILL_CHARS]
    )
    if found.allowed_tools is not None:
        body += f"\n(Com esta habilidade, só valem as ações: {', '.join([*found.allowed_tools, REPLY])}.)"
    return base._block("use_skill", attributes, body), record  # noqa: SLF001


def apply_skill(state: RunState, skill: Skill) -> None:
    """Marca a habilidade em uso e restringe as ferramentas às permitidas por ela."""
    state.skill = skill.name
    state.allowed = frozenset(skill.allowed_tools) if skill.allowed_tools is not None else None


USE_SKILL = AgentTool(
    name="use_skill",
    usage=(
        '{"action": "use_skill", "name": "nome"} — carrega as instruções de uma habilidade da pessoa (da lista '
        "de habilidades), quando o pedido combina com a descrição dela;"
    ),
    validate=lambda action: skill_name(action.get("name")) is not None,
    run=_use_skill,
    available=lambda caps: caps.skills,
    description="Carrega as instruções de uma habilidade da pessoa.",
)


# --- as ações no ambiente (propostas; o job `agent_action` executa depois da confirmação) -------


def _date(value: str) -> bool:
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def targets_of(action: dict[str, Any]) -> dict[str, Any] | None:
    """Os alvos normalizados: `recording_ids` ou um filtro não vazio; `None` se inválidos."""
    targets = action.get("targets")
    if not isinstance(targets, dict) or not targets:
        return None
    if "recording_ids" in targets:
        ids = targets["recording_ids"]
        if set(targets) != {"recording_ids"} or not isinstance(ids, list) or not ids:
            return None
        parsed = [_file_id(item) for item in ids]
        if any(item is None for item in parsed):
            return None
        return {"recording_ids": [str(item) for item in dict.fromkeys(parsed)]}
    if set(targets) - set(TARGET_FILTERS):
        return None
    found: dict[str, str] = {}
    for key in TARGET_FILTERS:
        value = targets.get(key)
        if value is None:
            continue
        if not isinstance(value, str) or not value.strip():
            return None
        if key in {"from", "to"} and not _date(value.strip()):
            return None
        found[key] = value.strip()
    # Filtro vazio seria a base inteira: recusado, o agente tem de dizer quais.
    return found or None


def _labels(value: object) -> list[str] | None:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_LABELS:
        return None
    if not all(isinstance(item, str) and item.strip() for item in value):
        return None
    return list(dict.fromkeys(item.strip() for item in value))


def action_params(action: dict[str, Any]) -> dict[str, Any] | None:
    """Os parâmetros normalizados da ação (sem a chave `action`), ou `None` se inválidos."""
    name = action.get("action")
    targets = targets_of(action)
    if targets is None:
        return None
    params: dict[str, Any] = {"targets": targets}
    if name in {"tag_recordings", "collect_recordings"}:
        add, remove = _labels(action.get("add")), _labels(action.get("remove"))
        if add is None or remove is None or not (add or remove):
            return None
        params |= {"add": add, "remove": remove}
    elif name == "set_agenda_type":
        agenda = action.get("agenda_type")
        if not isinstance(agenda, str) or not agenda.strip():
            return None
        params["agenda_type"] = agenda.strip()
    return params


async def _plan(env: AgentEnv, action: dict[str, Any], state: RunState) -> tuple[str, dict[str, Any]]:
    name = action["action"]
    record: dict[str, Any] = {"tool": name, "proposal": True}
    if len(state.proposals) >= MAX_PROPOSALS:
        body = f"limite de {MAX_PROPOSALS} propostas por resposta atingido; nada foi proposto"
        return base._block(name, "", body), record  # noqa: SLF001
    params = action_params(action)
    assert params is not None  # noqa: S101 — validado
    planned = await env.plan_action(name, params, MAX_TARGETS[name])
    if isinstance(planned, str):
        return base._block(name, "", f"{planned}; nada foi proposto"), record  # noqa: SLF001
    state.proposals.append(planned)
    record["targets"] = len(planned.targets)
    listed = "\n".join(f"- {rid} — {title}" for rid, title in planned.targets[:SHOWN_TARGETS])
    if len(planned.targets) > SHOWN_TARGETS:
        listed += f"\n- … e mais {len(planned.targets) - SHOWN_TARGETS}"
    body = (
        f"proposta registrada: {planned.summary}\nAlvos ({len(planned.targets)}):\n{listed}\n"
        "Nada mudou ainda: a pessoa vê um cartão com esta proposta e confirma ou descarta. Na resposta, "
        "explique o que será feito, sem dizer que já foi feito."
    )
    return base._block(name, "", body), record  # noqa: SLF001


async def _never(
    _env: AgentEnv, _action: dict[str, Any], _budget: int, _state: RunState
) -> tuple[str, dict[str, Any]]:
    raise AssertionError("ação com confirmação não roda no laço")  # pragma: no cover


_TARGETS_USAGE = (
    '"targets": {"recording_ids": ["id", …]} ou {"agenda_type": "nome", "from": "AAAA-MM-DD", '
    '"to": "AAAA-MM-DD", "collection": "nome", "tag": "nome"}'
)


def _action(name: str, usage: str, scope: str, description: str) -> AgentTool:
    return AgentTool(
        name=name,
        usage=usage,
        validate=lambda action: action_params(action) is not None,
        run=_never,
        kind="action",
        confirm=True,
        available=lambda caps: scope in caps.scopes,
        description=description,
        plan=_plan,
    )


ACTION_SCOPES = {
    "regenerate_summaries": "summaries:write",
    "tag_recordings": "recordings:write",
    "collect_recordings": "recordings:write",
    "set_agenda_type": "recordings:write",
}
ACTION_TOOLS = [
    _action(
        "regenerate_summaries",
        f'{{"action": "regenerate_summaries", {_TARGETS_USAGE}}} — propõe gerar de novo o resumo das '
        f"gravações (até {MAX_TARGETS['regenerate_summaries']}), pelas instruções do tipo de agenda de cada uma;",
        ACTION_SCOPES["regenerate_summaries"],
        "Propõe regenerar os resumos de várias gravações.",
    ),
    _action(
        "tag_recordings",
        f'{{"action": "tag_recordings", {_TARGETS_USAGE}, "add": ["tag"], "remove": ["tag"]}} — propõe '
        f"aplicar e remover tags (até {MAX_TARGETS['tag_recordings']} gravações);",
        ACTION_SCOPES["tag_recordings"],
        "Propõe aplicar ou remover tags em lote.",
    ),
    _action(
        "collect_recordings",
        f'{{"action": "collect_recordings", {_TARGETS_USAGE}, "add": ["coleção"], "remove": ["coleção"]}} — '
        f"propõe incluir e tirar as gravações de coleções existentes (até {MAX_TARGETS['collect_recordings']});",
        ACTION_SCOPES["collect_recordings"],
        "Propõe incluir ou tirar gravações de coleções em lote.",
    ),
    _action(
        "set_agenda_type",
        f'{{"action": "set_agenda_type", {_TARGETS_USAGE}, "agenda_type": "nome"}} — propõe trocar o tipo '
        f"de agenda das gravações (até {MAX_TARGETS['set_agenda_type']}), o que abre um resumo novo;",
        ACTION_SCOPES["set_agenda_type"],
        "Propõe trocar o tipo de agenda de várias gravações.",
    ),
]


def default_registry() -> ToolRegistry:
    """As ferramentas do Agente: a base, os anexos, os arquivos gerados, as habilidades e as ações."""
    return ToolRegistry(
        [
            _base_tool("search_summaries", transcripts=False),
            _base_tool("read_summary", transcripts=False),
            _base_tool("search_transcripts", transcripts=True),
            _base_tool("read_transcript", transcripts=True),
            READ_FILE,
            WRITE_FILE,
            USE_SKILL,
            *ACTION_TOOLS,
        ]
    )


__all__ = [
    "ACTION_SCOPES",
    "MAX_PROPOSALS",
    "MAX_TARGETS",
    "NEEDS_CONFIRMATION",
    "REPLY",
    "AgentEnv",
    "AgentTool",
    "Capabilities",
    "InputFile",
    "ProducedFile",
    "ProposedAction",
    "RunState",
    "Skill",
    "ToolRegistry",
    "action_params",
    "apply_skill",
    "default_registry",
    "skill_name",
    "targets_of",
]
