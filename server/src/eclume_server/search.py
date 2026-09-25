"""Busca full-text sobre os segmentos visíveis, em português sem acento (config `eclume_pt`).

Tudo roda sob a RLS. O GIN de `segments.tsv` entra pela função `eclume_segment_matches`, que só
devolve as chaves candidatas da organização; a política de `segments` decide o que o usuário vê
(migration 003).
"""

from __future__ import annotations

import html
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sqlalchemy import any_, cast, func, literal_column, select
from sqlalchemy.dialects.postgresql import REGCONFIG, TSVECTOR

from eclume_server.db import tables as t
from eclume_server.pagination import iso
from eclume_server.transcripts import segment_json, speaker_json

if TYPE_CHECKING:
    from datetime import datetime
    from uuid import UUID

    from sqlalchemy import ColumnElement
    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

CONFIG = "eclume_pt"
# Marcadores que não aparecem em fala transcrita; o texto é escapado antes de virarem `<mark>`.
_START, _STOP = "\x02", "\x03"
_HEADLINE_OPTIONS = f'StartSel="{_START}", StopSel="{_STOP}", HighlightAll=true'


@dataclass(frozen=True)
class SearchFilters:
    """Parâmetros de `GET /search` já validados; `q` ou `person` presente."""

    q: str | None
    person: UUID | None
    date_from: datetime | None
    date_to: datetime | None
    tag: str | None
    collection: UUID | None


def _config() -> ColumnElement[Any]:
    return cast(CONFIG, REGCONFIG)


def highlight(raw: str) -> str:
    """Texto escapado com os termos entre `<mark>` e `</mark>`: nenhum outro HTML passa."""
    return html.escape(raw, quote=False).replace(_START, "<mark>").replace(_STOP, "</mark>")


async def search(conn: AsyncConnection, filters: SearchFilters, offset: int, limit: int) -> list[dict[str, Any]]:
    """Até `limit + 1` trechos a partir de `offset` (a sobra só diz que há próxima página)."""
    s = t.segments.alias("s")
    sp = t.speakers.alias("sp")
    tr, r, pe = t.transcripts, t.recordings, t.people
    tsquery = func.websearch_to_tsquery(_config(), filters.q) if filters.q else None
    rank = func.ts_rank_cd(literal_column("s.tsv", TSVECTOR), tsquery) if tsquery is not None else literal_column("0")

    source = (
        s.join(tr, tr.c.id == s.c.transcript_id)
        .join(r, r.c.id == tr.c.recording_id)
        .join(sp, (sp.c.transcript_id == s.c.transcript_id) & (sp.c.speaker_id == s.c.speaker_id))
        .outerjoin(pe, pe.c.id == sp.c.person_id)
    )
    if tsquery is not None:
        matches = func.eclume_segment_matches(tsquery).table_valued("transcript_id", "segment_id").alias("m")
        source = source.join(
            matches, (matches.c.transcript_id == s.c.transcript_id) & (matches.c.segment_id == s.c.segment_id)
        )
    hits = select(
        tr.c.id.label("transcript_id"),
        tr.c.recording_id,
        r.c.title,
        r.c.recorded_at,
        sp.c.speaker_id,
        sp.c.label,
        sp.c.person_id,
        pe.c.name.label("person_name"),
        sp.c.talk_ms,
        s.c.segment_id,
        s.c.start_ms,
        s.c.end_ms,
        s.c.text,
        s.c.confidence,
        s.c.position,
        rank.label("rank"),
    ).select_from(source)
    if filters.person is not None:
        hits = hits.where(sp.c.person_id == filters.person)
    if filters.date_from is not None:
        hits = hits.where(r.c.recorded_at >= filters.date_from)
    if filters.date_to is not None:
        hits = hits.where(r.c.recorded_at < filters.date_to)
    if filters.tag is not None:
        hits = hits.where(filters.tag == any_(r.c.tags))
    if filters.collection is not None:
        hits = hits.where(filters.collection == any_(r.c.collection_ids))

    def order(q: Any) -> list[Any]:  # noqa: ANN401 — colunas da consulta ou da subconsulta
        if tsquery is not None:
            # Relevância; no empate, a gravação mais recente e a ordem da fala.
            return [q.rank.desc(), q.recorded_at.desc(), q.transcript_id, q.position]
        # Só `person`: as falas da pessoa em ordem cronológica.
        return [q.recorded_at, q.transcript_id, q.position]

    page = hits.order_by(*order(hits.selected_columns)).offset(offset).limit(limit + 1).subquery("hit")
    # Um marcador que já estivesse no texto viraria um `<mark>` falso: sai antes do destaque.
    clean = func.translate(page.c.text, _START + _STOP, "")
    marked = func.ts_headline(_config(), clean, tsquery, _HEADLINE_OPTIONS) if tsquery is not None else clean
    rows = (await conn.execute(select(page, marked.label("marked")).order_by(*order(page.c)))).mappings().all()
    return [hit_json(row) for row in rows]


def hit_json(row: Row) -> dict[str, Any]:
    """Schema `SearchHit`."""
    return {
        "transcript": {
            "id": str(row["transcript_id"]),
            "recording_id": str(row["recording_id"]),
            "title": row["title"],
            "recorded_at": iso(row["recorded_at"]),
        },
        "speaker": speaker_json(row),
        "segment": segment_json(row, words=False),
        "highlight": highlight(row["marked"]),
        "rank": float(row["rank"]),
    }
