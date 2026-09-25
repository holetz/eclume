"""Resumos: configuração da organização, templates, criação versionada e o job `summarize`.

Contrato e decisões em docs/standards/code/server-agentes.md.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import func, insert, select, text, update

from eclume_server.db import tables as t
from eclume_server.pagination import iso

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row


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


# --- formas JSON ------------------------------------------------------------------------------------


def template_json(row: Row, org_default_id: str | None) -> dict[str, Any]:
    """Schema `SummaryTemplate`; o `is_default` da organização vem de `default_template_id`."""
    organization = row["owner_id"] is None
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "instructions": row["instructions"],
        "scope": "organization" if organization else "user",
        "is_default": str(row["id"]) == org_default_id if organization else row["is_default"],
        "created_at": iso(row["created_at"]),
        "updated_at": iso(row["updated_at"]),
    }


def summary_json(row: Row) -> dict[str, Any]:
    """Schema `Summary`, com template e provider em instantâneo."""
    error = None
    if row["error_code"]:
        error = {"code": row["error_code"], "message": row["error_message"] or ""}
    return {
        "id": str(row["id"]),
        "transcript_id": str(row["transcript_id"]),
        "transcript_revision": row["transcript_revision"],
        "template": {"id": str(row["template_id"]), "name": row["template_name"]},
        "version": row["version"],
        "status": row["status"],
        "trigger": row["trigger"],
        "provider": {"id": str(row["provider_id"]), "name": row["provider_name"], "kind": row["provider_kind"]},
        "model": row["model"],
        "content_md": row["content_md"] if row["status"] == "done" else None,
        "error": error,
        "created_at": iso(row["created_at"]),
        "completed_at": iso(row["completed_at"]),
    }


# --- criação -----------------------------------------------------------------------------------------


async def create_summary(  # noqa: PLR0913 — o resumo nasce de transcrição, template, provider e gatilho
    conn: AsyncConnection,
    *,
    transcript: Row,
    template: Row,
    provider: Row,
    trigger: str,
    created_by: UUID,
) -> Row:
    """Insere um resumo `queued` com a próxima `version` do par (transcrição, template).

    Serve à API (sob a RLS, que exige o dono da gravação) e ao resumo automático (papel de sistema).
    O lock do par serializa gerações simultâneas do mesmo template.
    """
    s = t.summaries.c
    await conn.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:pair, 0))"),
        {"pair": f"summary:{transcript['id']}:{template['id']}"},
    )
    version = (
        await conn.execute(
            select(func.coalesce(func.max(s.version), 0) + 1).where(
                s.transcript_id == transcript["id"], s.template_id == template["id"]
            )
        )
    ).scalar_one()
    return (
        (
            await conn.execute(
                insert(t.summaries)
                .values(
                    org_id=transcript["org_id"],
                    transcript_id=transcript["id"],
                    transcript_revision=transcript["revision"],
                    template_id=template["id"],
                    template_name=template["name"],
                    instructions=template["instructions"],
                    version=version,
                    status="queued",
                    trigger=trigger,
                    provider_id=provider["id"],
                    provider_name=provider["name"],
                    provider_kind=provider["kind"],
                    model=provider["model"],
                    created_by=created_by,
                )
                .returning(t.summaries)
            )
        )
        .mappings()
        .one()
    )
