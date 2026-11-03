"""Generation follows the owner's account locale: every prompt ends its task with the output-language line.

Prompts are English; the language of what the model writes comes from the account locale, defaulting to
English when the account never chose one (docs/standards/code/i18n.md).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from eclume_server.agents.agent import AgentContext, agent_prompt
from eclume_server.agents.base_chat import BaseChatContext, base_chat_prompt
from eclume_server.agents.chat import ChatContext, chat_prompt
from eclume_server.agents.extraction import FieldSpec, fields_prompt
from eclume_server.agents.prompting import OUTPUT_LANGUAGE, output_language, task_prompt
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import FakeAgents, run_cpu, run_gpu

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

CLAUDE = {"name": "Claude (servidor)", "kind": "claude-cli", "model": "sonnet"}
ENGLISH = "Write the output in English."
PORTUGUESE = "Write the output in Brazilian Portuguese (pt-BR)."


def test_the_directive_per_locale():
    assert OUTPUT_LANGUAGE == {"en": ENGLISH, "pt-BR": PORTUGUESE}
    assert output_language("pt-BR") == PORTUGUESE
    assert output_language("en") == ENGLISH
    assert output_language("es") == ENGLISH  # an unsupported locale falls back to the default


@pytest.mark.parametrize(("locale", "line"), [("en", ENGLISH), ("pt-BR", PORTUGUESE)])
def test_every_prompt_ends_with_the_directive(locale: str, line: str):
    assert task_prompt("Rules.", "Instructions.", locale=locale).endswith(line)
    field = FieldSpec(key="client", kind="text", instructions="The client.")
    assert fields_prompt([field], None, locale=locale).endswith(line)
    assert chat_prompt(ChatContext("Title: x", None, [], "Shorten it", locale=locale)).endswith(line)
    assert base_chat_prompt(BaseChatContext([], "What was decided?", locale=locale)).endswith(line)
    assert agent_prompt(AgentContext([], "What was decided?", locale=locale)).endswith(line)


def test_the_default_context_writes_english():
    assert chat_prompt(ChatContext("Title: x", None, [], "Shorten it")).endswith(ENGLISH)
    assert agent_prompt(AgentContext([], "Question")).endswith(ENGLISH)


@pytest.mark.parametrize("case", [("pt-BR", PORTUGUESE), ("en", ENGLISH), (None, ENGLISH)])
def test_the_pipeline_writes_in_the_owner_locale(
    admin: Api,
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
    case: tuple[str | None, str],
):
    choice, line = case
    assert admin.post("/api/v1/admin/agent-providers", json=CLAUDE).status_code == 201
    user = as_user(make_user())
    assert user.patch("/api/v1/me/locale", json={"locale": choice}).status_code == 200
    upload_file(user, audio_bytes(2100))
    agents = FakeAgents()
    run_gpu(services.settings)
    run_cpu(services.settings, agents)

    fields = agents.of("fields")
    summaries = agents.of("summaries")
    assert fields
    assert summaries
    assert all(prompt.endswith(line) for _, _, prompt in fields + summaries)
