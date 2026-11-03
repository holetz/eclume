"""The Agent tool registry: each tool declares its usage, validation, execution and kind.

The loop (`agents/agent.py`) knows no tool at all: it asks the `ToolRegistry` for the `system` lines
of the tools available to the credential, validates the JSON action through the tool that owns it and
runs it. Kind (`kind`): `read` looks things up (the base, the attachments, the skills), `produce`
prepares a file for the answer and `action` acts on the environment — that one, with `confirm`, never
runs in the loop: its `plan` resolves the targets and records a proposal, which the person confirms on
a card and the `agent_action` job executes (holetz/eclume#145). An action without `plan` only tells the
agent it needs confirmation. To add a tool, register an `AgentTool` in `default_registry()` (or in a
registry of your own). Contract in docs/standards/code/server-agentes.md `§Agente`.
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
UNKNOWN_FILE = "file does not exist in this conversation"
MAX_PROPOSALS = 3
MAX_SKILL_CHARS = 8000
# How many recordings an action may reach: regenerating summaries weighs on the queue and the quota.
MAX_TARGETS = {"regenerate_summaries": 20, "tag_recordings": 50, "collect_recordings": 50, "set_agenda_type": 50}
TARGET_FILTERS = ("agenda_type", "from", "to", "collection", "tag")
MAX_LABELS = 10
SHOWN_TARGETS = 10
NEEDS_CONFIRMATION = (
    "this action changes the environment and needs the asker's confirmation, which is not available yet: "
    "explain in the answer what it would do, without saying it did it"
)


@dataclass(frozen=True)
class Capabilities:
    """What the credential and the conversation allow: reading transcripts, having attachments, the scopes."""

    transcripts: bool = True
    files: bool = False
    scopes: frozenset[str] = frozenset()
    # The person has enabled skills the agent may pick (`use_skill`).
    skills: bool = False


@dataclass(frozen=True)
class InputFile:
    """A conversation attachment, with its extracted text."""

    id: UUID
    name: str
    text: str


@dataclass(frozen=True)
class ProducedFile:
    """A file the agent prepared: the job renders it (`agent_files.render_output`) and stores it."""

    name: str
    format: str
    content: str


@dataclass(frozen=True)
class Skill:
    """A person's skill: its instructions and, optionally, the allowed tools (null = all)."""

    name: str
    description: str
    instructions: str
    allowed_tools: tuple[str, ...] | None = None


@dataclass(frozen=True)
class ProposedAction:
    """An action the agent proposed: the normalised parameters, the card text and the `(id, title)` targets."""

    tool: str
    params: dict[str, Any]
    summary: str
    targets: list[tuple[UUID, str]]


class AgentEnv(Protocol):
    """The tools' access to the owner's environment, provided by the job."""

    @property
    def base(self) -> base.BaseTools:
        """The recordings base, under the owner's RLS."""
        ...

    async def read_file(self, file_id: UUID) -> InputFile | None:
        """An attachment of this conversation, or `None` when it does not exist or belongs to another one."""
        ...

    async def skill(self, name: str) -> Skill | None:
        """The person's enabled skill with that name, or `None`."""
        ...

    async def plan_action(self, tool: str, params: dict[str, Any], limit: int) -> ProposedAction | str:
        """Resolve the targets under RLS and write the summary; the reason (text) when there is no proposal."""
        ...


@dataclass
class RunState:
    """What one answer accumulates: the recordings seen (possible sources), the files and the pending actions."""

    seen: dict[UUID, str] = field(default_factory=dict)
    produced: list[ProducedFile] = field(default_factory=list)
    pending_actions: list[dict[str, Any]] = field(default_factory=list)
    proposals: list[ProposedAction] = field(default_factory=list)
    # The skill in use and the tools it allows (null = all).
    skill: str | None = None
    allowed: frozenset[str] | None = None


@dataclass(frozen=True)
class AgentTool:
    """A tool: the action name, the usage line in the `system`, the validation and the execution.

    `run(env, action, budget, state)` returns the `<ferramenta>` block for the agent and the record of
    the call. `available(caps)` says whether the credential sees it. `kind="action"` with `confirm=True`
    never runs in the loop: `plan(env, action, state)` records the proposal and returns the block.
    `description` is the catalogue sentence (`GET /agent/tools`).
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
    """The agent's tools by name, in registration order; `reply` is reserved for the loop."""

    def __init__(self, tools: list[AgentTool] | None = None) -> None:
        """A registry with the given tools, in order."""
        self._tools: dict[str, AgentTool] = {}
        for tool in tools or []:
            self.register(tool)

    def register(self, tool: AgentTool) -> None:
        """Add a tool; a repeated name or `reply` is a `ValueError`."""
        if tool.name == REPLY or tool.name in self._tools:
            raise ValueError(f"ferramenta já registrada ou reservada: {tool.name}")
        if tool.kind == "action" and not tool.confirm:
            raise ValueError(f"ação sem confirmação: {tool.name}")
        self._tools[tool.name] = tool

    def get(self, name: str) -> AgentTool | None:
        """The tool by name."""
        return self._tools.get(name)

    def available(self, caps: Capabilities, allowed: frozenset[str] | None = None) -> list[AgentTool]:
        """The tools the credential sees (and the skill in use allows), in registration order."""
        return [
            tool for tool in self._tools.values() if tool.available(caps) and (allowed is None or tool.name in allowed)
        ]

    def names(self, caps: Capabilities, allowed: frozenset[str] | None = None) -> list[str]:
        """The names of the actions valid for the credential, with `reply` last."""
        return [tool.name for tool in self.available(caps, allowed)] + [REPLY]

    def catalog(self) -> list[dict[str, str]]:
        """Every tool, with its kind and description (a skill's tool picker)."""
        tools = self._tools.values()
        return [{"name": tool.name, "kind": tool.kind, "description": tool.description} for tool in tools]


# --- the base tools (those of the base chat, reused) --------------------------------------------


_BASE_DESCRIPTIONS = {
    "search_summaries": "Busca nos resumos das gravações.",
    "read_summary": "Lê o resumo de uma gravação.",
    "search_transcripts": "Busca nas transcrições.",
    "read_transcript": "Lê um trecho da transcrição.",
}


def _base_tool(name: str, *, transcripts: bool) -> AgentTool:
    async def run(env: AgentEnv, action: dict[str, Any], budget: int, state: RunState) -> tuple[str, dict[str, Any]]:
        return await base._run_tool(env.base, action, budget, state.seen)  # noqa: SLF001 — the same protocol

    return AgentTool(
        name=name,
        usage=base._ACTIONS[name],  # noqa: SLF001
        validate=base._valid,  # noqa: SLF001
        run=run,
        available=(lambda caps: caps.transcripts) if transcripts else (lambda _caps: True),
        description=_BASE_DESCRIPTIONS[name],
    )


# --- attachments ---------------------------------------------------------------------------------


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
    """The start of the text that fits in `budget` tokens."""
    if estimate_tokens(text) <= budget:
        return text
    return text[: max(budget, 0) * 3]


async def _read_file(
    env: AgentEnv, action: dict[str, Any], budget: int, _state: RunState
) -> tuple[str, dict[str, Any]]:
    file_id = _file_id(action["file_id"])
    assert file_id is not None  # noqa: S101 — validated
    offset = _offset(action.get("offset")) or 0
    record = {"tool": "read_file", "file_id": str(file_id), "offset": offset}
    found = await env.read_file(file_id)
    attributes = f' arquivo="{file_id}"'
    if found is None:
        return base._block("read_file", attributes, UNKNOWN_FILE), record  # noqa: SLF001
    chunk = clip_chars(found.text[offset:], budget)
    end = offset + len(chunk)
    body = f'"{found.name}" (characters {offset} to {end} of {len(found.text)})\n{chunk or "(no readable text)"}'
    if end < len(found.text):
        body += f'\n(continues: read again with "offset": {end})'
    return base._block("read_file", attributes, body), record  # noqa: SLF001


# --- output files -------------------------------------------------------------------------------


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
        body = f"limit of {MAX_OUTPUTS_PER_REPLY} files per answer reached; nothing was generated"
        return base._block("write_file", attributes, body), record  # noqa: SLF001
    clipped = len(content) > MAX_OUTPUT_CHARS
    state.produced.append(ProducedFile(name=name, format=fmt, content=content[:MAX_OUTPUT_CHARS]))
    body = f".{fmt} file prepared; it goes attached to the answer for download"
    if clipped:
        body += f" (cut at {MAX_OUTPUT_CHARS} characters)"
    return base._block("write_file", attributes, body), record  # noqa: SLF001


READ_FILE = AgentTool(
    name="read_file",
    usage=(
        '{"action": "read_file", "file_id": "id", "offset": 0} — reads the text of a file attached to the '
        "conversation, from character `offset`;"
    ),
    validate=_valid_read_file,
    run=_read_file,
    available=lambda caps: caps.files,
    description="Lê o texto de um arquivo anexado à conversa.",
)
WRITE_FILE = AgentTool(
    name="write_file",
    usage=(
        '{"action": "write_file", "name": "name", "format": "md|txt|csv|docx", "content": "the content"} — '
        "generates a file for the person to download (the docx from Markdown);"
    ),
    validate=_valid_write_file,
    run=_write_file,
    kind="produce",
    description="Gera um arquivo .md, .txt, .csv ou .docx para baixar.",
)


# --- skills ------------------------------------------------------------------------------------


def skill_name(value: object) -> str | None:
    """The skill name without the slash, lower-cased, or `None` when it is not text."""
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
        body = f"the skill /{state.skill} is already in use in this answer"
        return base._block("use_skill", attributes, body), record  # noqa: SLF001
    found = await env.skill(name)
    if found is None:
        return base._block("use_skill", attributes, "skill does not exist or is turned off"), record  # noqa: SLF001
    apply_skill(state, found)
    body = (
        f"Instructions of the skill /{found.name}, written by the person: follow them in this answer.\n"
        + found.instructions[:MAX_SKILL_CHARS]
    )
    if found.allowed_tools is not None:
        body += f"\n(With this skill, only these actions apply: {', '.join([*found.allowed_tools, REPLY])}.)"
    return base._block("use_skill", attributes, body), record  # noqa: SLF001


def apply_skill(state: RunState, skill: Skill) -> None:
    """Mark the skill in use and restrict the tools to the ones it allows."""
    state.skill = skill.name
    state.allowed = frozenset(skill.allowed_tools) if skill.allowed_tools is not None else None


USE_SKILL = AgentTool(
    name="use_skill",
    usage=(
        '{"action": "use_skill", "name": "name"} — loads the instructions of a skill of the person (from the '
        "skill list), when the request matches its description;"
    ),
    validate=lambda action: skill_name(action.get("name")) is not None,
    run=_use_skill,
    available=lambda caps: caps.skills,
    description="Carrega as instruções de uma habilidade da pessoa.",
)


# --- environment actions (proposals; the `agent_action` job runs them after confirmation) -------


def _date(value: str) -> bool:
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _id_targets(ids: object) -> dict[str, Any] | None:
    """A non-empty `recording_ids` of UUIDs only, without repeats; `None` when invalid."""
    if not isinstance(ids, list) or not ids:
        return None
    parsed = [_file_id(item) for item in ids]
    if any(item is None for item in parsed):
        return None
    return {"recording_ids": [str(item) for item in dict.fromkeys(parsed)]}


def _filter_targets(targets: dict[str, Any]) -> dict[str, Any] | None:
    """A `TARGET_FILTERS` filter with non-empty texts and valid dates; `None` when invalid or empty."""
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
    # An empty filter would be the whole base: refused, the agent must say which ones.
    return found or None


def targets_of(action: dict[str, Any]) -> dict[str, Any] | None:
    """The normalised targets: `recording_ids` or a non-empty filter; `None` when invalid."""
    targets = action.get("targets")
    if not isinstance(targets, dict) or not targets:
        return None
    if "recording_ids" in targets:
        if set(targets) != {"recording_ids"}:
            return None
        return _id_targets(targets["recording_ids"])
    return _filter_targets(targets)


def _labels(value: object) -> list[str] | None:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_LABELS:
        return None
    if not all(isinstance(item, str) and item.strip() for item in value):
        return None
    return list(dict.fromkeys(item.strip() for item in value))


def action_params(action: dict[str, Any]) -> dict[str, Any] | None:
    """The action's normalised parameters (without the `action` key), or `None` when invalid."""
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
        body = f"limit of {MAX_PROPOSALS} proposals per answer reached; nothing was proposed"
        return base._block(name, "", body), record  # noqa: SLF001
    params = action_params(action)
    assert params is not None  # noqa: S101 — validated
    planned = await env.plan_action(name, params, MAX_TARGETS[name])
    if isinstance(planned, str):
        return base._block(name, "", f"{planned}; nothing was proposed"), record  # noqa: SLF001
    state.proposals.append(planned)
    record["targets"] = len(planned.targets)
    listed = "\n".join(f"- {rid} — {title}" for rid, title in planned.targets[:SHOWN_TARGETS])
    if len(planned.targets) > SHOWN_TARGETS:
        listed += f"\n- … and {len(planned.targets) - SHOWN_TARGETS} more"
    body = (
        f"proposal recorded: {planned.summary}\nTargets ({len(planned.targets)}):\n{listed}\n"
        "Nothing changed yet: the person sees a card with this proposal and confirms or discards it. In the "
        "answer, explain what will be done, without saying it was already done."
    )
    return base._block(name, "", body), record  # noqa: SLF001


async def _never(_env: AgentEnv, _action: dict[str, Any], _budget: int, _state: RunState) -> tuple[str, dict[str, Any]]:
    raise AssertionError("ação com confirmação não roda no laço")  # pragma: no cover


_TARGETS_USAGE = (
    '"targets": {"recording_ids": ["id", …]} or {"agenda_type": "name", "from": "YYYY-MM-DD", '
    '"to": "YYYY-MM-DD", "collection": "name", "tag": "name"}'
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
        f'{{"action": "regenerate_summaries", {_TARGETS_USAGE}}} — proposes generating the summary of the '
        f"recordings again (up to {MAX_TARGETS['regenerate_summaries']}), by each one's agenda type instructions;",
        ACTION_SCOPES["regenerate_summaries"],
        "Propõe regenerar os resumos de várias gravações.",
    ),
    _action(
        "tag_recordings",
        f'{{"action": "tag_recordings", {_TARGETS_USAGE}, "add": ["tag"], "remove": ["tag"]}} — proposes '
        f"applying and removing tags (up to {MAX_TARGETS['tag_recordings']} recordings);",
        ACTION_SCOPES["tag_recordings"],
        "Propõe aplicar ou remover tags em lote.",
    ),
    _action(
        "collect_recordings",
        f'{{"action": "collect_recordings", {_TARGETS_USAGE}, "add": ["collection"], "remove": ["collection"]}} — '
        f"proposes adding the recordings to and removing them from existing collections (up to {MAX_TARGETS['collect_recordings']});",
        ACTION_SCOPES["collect_recordings"],
        "Propõe incluir ou tirar gravações de coleções em lote.",
    ),
    _action(
        "set_agenda_type",
        f'{{"action": "set_agenda_type", {_TARGETS_USAGE}, "agenda_type": "name"}} — proposes changing the agenda '
        f"type of the recordings (up to {MAX_TARGETS['set_agenda_type']}), which opens a new summary;",
        ACTION_SCOPES["set_agenda_type"],
        "Propõe trocar o tipo de agenda de várias gravações.",
    ),
]


def default_registry() -> ToolRegistry:
    """The Agent's tools: the base, the attachments, the generated files, the skills and the actions."""
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
