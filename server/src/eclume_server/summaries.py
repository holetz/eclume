"""Resumos: configuração da organização, templates, criação versionada e o job `summarize`.

Contrato e decisões em docs/standards/code/server-agentes.md.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select, update

from eclume_server.db import tables as t

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection


# --- configuração da organização (bloco `summarization` de `org_settings`) ------------------------


async def get_summarization(conn: AsyncConnection, org_id: UUID) -> dict[str, Any]:
    """Bloco `summarization`: `default_provider_id`, `auto_summarize`, `default_template_id`."""
    value = (
        await conn.execute(select(t.org_settings.c.summarization).where(t.org_settings.c.org_id == org_id))
    ).scalar()
    return dict(value or {})


async def set_summarization(conn: AsyncConnection, org_id: UUID, user_id: UUID | None, **changes: Any) -> None:  # noqa: ANN401
    """Muda campos do bloco `summarization` (sob a RLS, só admin consegue)."""
    current = await get_summarization(conn, org_id)
    await conn.execute(
        update(t.org_settings)
        .where(t.org_settings.c.org_id == org_id)
        .values(summarization={**current, **changes}, updated_at=func.now(), updated_by=user_id)
    )
