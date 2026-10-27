"""The Agent's skills and the tool catalogue, under the owner's RLS.

Scope `summaries:read`, like the other Agent routes: a skill is configuration of the person's own
agent. Another account: 404. Contract in docs/standards/code/server-agentes.md `§Agente`.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field

from eclume_server.agent_skills import (
    MAX_DESCRIPTION,
    MAX_INSTRUCTIONS,
    MAX_NAME,
    create_skill,
    delete_skill,
    get_skill,
    list_skills,
    update_skill,
)
from eclume_server.agents.agent_tools import default_registry
from eclume_server.auth import Principal, requires
from eclume_server.context import AppContext, get_ctx
from eclume_server.db.session import user_tx
from eclume_server.input_limits import MAX_ALLOWED_TOOLS, MAX_TOOL_NAME_LENGTH

router = APIRouter()
Ctx = Annotated[AppContext, Depends(get_ctx)]
Reader = Annotated[Principal, Depends(requires("summaries:read"))]


class AgentSkillCreate(BaseModel):
    """Schema `AgentSkillCreate`."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=MAX_NAME + 1)
    description: str = Field(min_length=1, max_length=MAX_DESCRIPTION)
    instructions: str = Field(min_length=1, max_length=MAX_INSTRUCTIONS)
    allowed_tools: list[Annotated[str, Field(max_length=MAX_TOOL_NAME_LENGTH)]] | None = Field(
        default=None, max_length=MAX_ALLOWED_TOOLS
    )
    enabled: bool = True


class AgentSkillPatch(BaseModel):
    """Schema `AgentSkillPatch`: the fields sent change; `allowed_tools: null` allows them all."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME + 1)
    description: str | None = Field(default=None, min_length=1, max_length=MAX_DESCRIPTION)
    instructions: str | None = Field(default=None, min_length=1, max_length=MAX_INSTRUCTIONS)
    allowed_tools: list[Annotated[str, Field(max_length=MAX_TOOL_NAME_LENGTH)]] | None = Field(
        default=None, max_length=MAX_ALLOWED_TOOLS
    )
    enabled: bool | None = None


@router.get("/agent/tools")
async def get_tools(principal: Reader) -> dict[str, Any]:  # noqa: ARG001 — authenticates only
    """The Agent's tool catalogue, with the nature of each tool."""
    return {"items": default_registry().catalog()}


@router.get("/agent/skills")
async def get_skills(principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """The account's skills, by name."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await list_skills(conn)


@router.post("/agent/skills", status_code=201)
async def post_skill(body: AgentSkillCreate, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Register a skill; a repeated name is 409."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await create_skill(conn, principal.user_id, body.model_dump())


@router.get("/agent/skills/{skill_id}")
async def get_one_skill(skill_id: UUID, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """One skill."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await get_skill(conn, skill_id)


@router.patch("/agent/skills/{skill_id}")
async def patch_skill(skill_id: UUID, body: AgentSkillPatch, principal: Reader, ctx: Ctx) -> dict[str, Any]:
    """Edit the skill."""
    values = body.model_dump(exclude_unset=True)
    for key in ("name", "description", "instructions", "enabled"):
        if key in values and values[key] is None:
            values.pop(key)
    async with user_tx(ctx.engine, principal.user_id) as conn:
        return await update_skill(conn, skill_id, values)


@router.delete("/agent/skills/{skill_id}", status_code=204)
async def remove_skill(skill_id: UUID, principal: Reader, ctx: Ctx) -> Response:
    """Delete the skill."""
    async with user_tx(ctx.engine, principal.user_id) as conn:
        await delete_skill(conn, skill_id)
    return Response(status_code=204)
