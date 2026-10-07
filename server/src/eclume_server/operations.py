"""As operações de escrita sobre uma gravação, compartilhadas pelo MCP, pela API e pelo Agente.

Cada função roda dentro da transação de quem chama, sob a RLS do dono (`user_tx`): gravação de outra
conta é 404, como na rota. Quem chama confere o escopo (o MCP pelo token, a rota pela dependência,
o Agente na confirmação) e, depois do commit, enfileira o resumo devolvido. O Agente chama estas
funções no próprio processo, em vez do `/mcp` por HTTP (holetz/eclume#145). Contrato em
docs/standards/code/server-agentes.md §Agente e docs/standards/code/server-mcp-e-dispositivos.md.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import select, update

from eclume_server.agenda_types import apply_type
from eclume_server.db import tables as t
from eclume_server.fields import builtin_fields, set_value, validate_value
from eclume_server.pipeline import current_revision
from eclume_server.problems import invalid_field
from eclume_server.quotas import charge_agent, check_open_summaries
from eclume_server.recordings import get_visible
from eclume_server.summaries import (
    create_summary,
    recording_transcript,
    start_auto_summary,
    summary_agenda_type,
    summary_provider,
)

if TYPE_CHECKING:
    from uuid import UUID

    from arq.connections import ArqRedis
    from sqlalchemy.ext.asyncio import AsyncConnection


async def regenerate_summary(
    conn: AsyncConnection, redis: ArqRedis, owner_id: UUID, recording_id: UUID
) -> tuple[UUID, str]:
    """Abre um resumo novo pelas instruções do tipo de agenda da gravação; devolve o id a enfileirar e o token da cota.

    Quem chama estorna o token (`refund_agent_request`) se o resumo não chegar à fila.

    404 sem a gravação, 409 `transcript_missing` sem transcrição, 429 com os resumos em aberto no
    teto e 403 `quota_exceeded` com a cota de 24 h do agente estourada (o pedido conta nela).
    """
    transcript = await recording_transcript(conn, recording_id)
    agenda_type = await summary_agenda_type(conn, transcript, None)
    provider = await summary_provider(conn, None)
    await check_open_summaries(conn, owner_id)
    row = await create_summary(
        conn,
        transcript=transcript,
        agenda_type=agenda_type,
        provider=provider,
        trigger="manual",
        created_by=owner_id,
    )
    token = await charge_agent(conn, redis, owner_id)
    return row["id"], token


async def _touch(conn: AsyncConnection, recording_id: UUID, now: datetime) -> None:
    # O que aparece na transcrição mudou: `?since=` precisa enxergar.
    await conn.execute(update(t.transcripts).where(t.transcripts.c.recording_id == recording_id).values(updated_at=now))


async def edit_tags(
    conn: AsyncConnection, owner_id: UUID, recording_id: UUID, *, add: list[str], remove: list[str]
) -> bool:
    """Acrescenta e tira tags (origem `edited`, como na tela); `False` se nada mudou."""
    recording = await get_visible(conn, recording_id)
    current = list(recording["tags"] or [])
    removed = {tag.casefold() for tag in remove}
    kept = [tag for tag in current if tag.casefold() not in removed]
    present = {tag.casefold() for tag in kept}
    wanted = kept + [tag for tag in dict.fromkeys(add) if tag.strip() and tag.casefold() not in present]
    if wanted == current:
        return False
    builtins = await builtin_fields(conn, owner_id)
    await set_value(conn, recording_id, builtins["tags"], validate_value(builtins["tags"], wanted), "edited")
    now = datetime.now(UTC)
    await conn.execute(update(t.recordings).where(t.recordings.c.id == recording_id).values(updated_at=now))
    await _touch(conn, recording_id, now)
    return True


async def check_collections(conn: AsyncConnection, collection_ids: list[UUID]) -> None:
    """422 se algum id não for coleção do usuário da transação."""
    wanted = set(collection_ids)
    if not wanted:
        return
    found = set((await conn.execute(select(t.collections.c.id).where(t.collections.c.id.in_(wanted)))).scalars())
    if wanted - found:
        raise invalid_field("collection_ids", "coleção inexistente")


async def edit_collections(conn: AsyncConnection, recording_id: UUID, *, add: list[UUID], remove: list[UUID]) -> bool:
    """Inclui e tira a gravação de coleções existentes; o agente de coleções não as muda mais.

    422 se alguma coleção de `add` não é do dono; `False` se nada mudou.
    """
    await check_collections(conn, add)
    recording = await get_visible(conn, recording_id)
    current = list(recording["collection_ids"] or [])
    wanted = [cid for cid in current if cid not in set(remove)]
    wanted += [cid for cid in dict.fromkeys(add) if cid not in wanted]
    if wanted == current:
        return False
    now = datetime.now(UTC)
    await conn.execute(
        update(t.recordings)
        .where(t.recordings.c.id == recording_id)
        .values(collection_ids=wanted, collections_origin="edited", updated_at=now)
    )
    await _touch(conn, recording_id, now)
    return True


async def change_agenda_type(conn: AsyncConnection, recording_id: UUID, agenda_type_id: UUID | None) -> UUID | None:
    """O tipo escolhido pelo usuário: aplica título e tags e, transcrita, abre o resumo automático novo.

    `None` tira o tipo e devolve a escolha à detecção. Devolve o resumo a enfileirar, se houver.
    """
    agenda_type = None
    if agenda_type_id is not None:
        agenda_type = (
            (await conn.execute(select(t.agenda_types).where(t.agenda_types.c.id == agenda_type_id))).mappings().first()
        )
        if agenda_type is None:
            raise invalid_field("agenda_type_id", "tipo de agenda inexistente ou sem acesso")
    current = (await conn.execute(select(t.recordings).where(t.recordings.c.id == recording_id))).mappings().one()
    await apply_type(conn, current, agenda_type, "edited" if agenda_type is not None else None)
    revision = await current_revision(conn, recording_id)
    if agenda_type is None or current["status"] != "transcribed" or revision is None:
        return None
    return await start_auto_summary(conn, recording_id, revision)


__all__ = ["change_agenda_type", "edit_collections", "edit_tags", "regenerate_summary"]
