"""Exportação da gravação: transcrição em TXT e SRT, resumo em MD, e os dois em DOCX.

Os nomes dos locutores são os da transcrição (a pessoa ligada ou o rótulo); a data sai no horário
de Brasília. Contrato em docs/standards/api/contrato-v1.md.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta, timezone
from io import BytesIO
from typing import TYPE_CHECKING, Any

from docx import Document
from sqlalchemy import select

from eclume_server.agents.prompting import hms
from eclume_server.db import tables as t
from eclume_server.problems import conflict
from eclume_server.summaries import SUMMARY_MISSING, current_version, recording_transcript
from eclume_server.transcripts import load_transcript

if TYPE_CHECKING:
    from uuid import UUID

    from docx.document import Document as DocxDocument
    from docx.text.paragraph import Paragraph
    from sqlalchemy.ext.asyncio import AsyncConnection

# O Brasil não tem horário de verão desde 2019: Brasília é UTC-3 o ano todo.
BRASILIA = timezone(timedelta(hours=-3), "BRT")
MEDIA_TYPES = {
    "txt": "text/plain; charset=utf-8",
    "srt": "application/x-subrip; charset=utf-8",
    "md": "text/markdown; charset=utf-8",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


# Controles que o XML do DOCX não aceita (o python-docx recusa o texto inteiro).
_XML_INVALID = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def slug(title: str, fallback: str = "transcricao") -> str:
    """O título em minúsculas, sem acento e com hífens: o nome do arquivo exportado."""
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_title.lower()).strip("-") or fallback


@dataclass(frozen=True)
class Line:
    """Uma fala: início, fim, nome do locutor e texto."""

    start_ms: int
    end_ms: int
    speaker: str
    text: str


@dataclass(frozen=True)
class Export:
    """O que os formatos precisam: cabeçalho, falas e o resumo atual (se houver)."""

    title: str
    recorded_at: datetime
    duration_ms: int
    agenda_type: str | None
    participants: list[str]
    lines: list[Line]
    summary_md: str | None

    @property
    def date(self) -> str:
        """`dd/mm/aaaa hh:mm` no horário de Brasília."""
        return self.recorded_at.astimezone(BRASILIA).strftime("%d/%m/%Y %H:%M")

    def meta(self) -> list[str]:
        """Data, duração e participantes, uma linha cada."""
        return [
            f"Data: {self.date}",
            f"Duração: {hms(self.duration_ms)}",
            f"Participantes: {', '.join(self.participants) or 'não identificados'}",
        ]


async def load_export(conn: AsyncConnection, recording_id: UUID) -> Export:
    """A gravação do usuário pronta para exportar (404 sem ela, 409 `transcript_missing` sem transcrição)."""
    transcript_row = await recording_transcript(conn, recording_id)
    transcript = await load_transcript(conn, transcript_row["id"], words=False)
    names = {s["id"]: s["person"]["name"] if s["person"] else s["label"] for s in transcript["speakers"]}
    agenda_type = (
        await conn.execute(
            select(t.agenda_types.c.name)
            .join(t.recordings, t.recordings.c.agenda_type_id == t.agenda_types.c.id)
            .where(t.recordings.c.id == recording_id)
        )
    ).scalar()
    current = await current_version(conn, transcript_row["id"])
    return Export(
        title=transcript["title"],
        recorded_at=datetime.fromisoformat(transcript["recorded_at"]).astimezone(UTC),
        duration_ms=transcript["duration_ms"],
        agenda_type=agenda_type,
        participants=list(names.values()),
        lines=[
            Line(s["start_ms"], s["end_ms"], names.get(s["speaker_id"], s["speaker_id"]), s["text"].strip())
            for s in transcript["segments"]
            if s["text"].strip()
        ],
        summary_md=current["content_md"] if current else None,
    )


def render_txt(export: Export) -> str:
    """Título, data, duração e participantes, e uma linha `[HH:MM:SS] Nome: texto` por fala."""
    lines = [export.title, *export.meta(), ""]
    lines += [f"[{hms(line.start_ms)}] {line.speaker}: {line.text}" for line in export.lines]
    return "\n".join(lines) + "\n"


def _srt_time(ms: int) -> str:
    return f"{hms(ms)},{ms % 1000:03d}"


def render_srt(export: Export) -> str:
    """Uma legenda por fala: número, `HH:MM:SS,mmm --> HH:MM:SS,mmm` e `Nome: texto`."""
    # Uma linha em branco dentro do texto encerraria o bloco: a fala sai numa linha só.
    blocks = [
        f"{n}\n{_srt_time(line.start_ms)} --> {_srt_time(line.end_ms)}\n{line.speaker}: {' '.join(line.text.split())}"
        for n, line in enumerate(export.lines, 1)
    ]
    return "\n\n".join(blocks) + "\n"


def render_md(export: Export) -> str:
    """`# Título`, a linha com a data e o tipo de agenda, e o resumo atual; sem resumo, 409."""
    if export.summary_md is None:
        raise conflict("A gravação ainda não tem resumo.", code=SUMMARY_MISSING)
    subtitle = " · ".join(part for part in (export.date, export.agenda_type) if part)
    return f"# {export.title}\n\n{subtitle}\n\n{export.summary_md.strip()}\n"


# --- DOCX -----------------------------------------------------------------------------------------

_HEADING = re.compile(r"^(#{1,3})\s+(.*)$")
_BULLET = re.compile(r"^\s*[-*+]\s+(.*)$")
_NUMBERED = re.compile(r"^\s*\d+[.)]\s+(.*)$")
_CHECKBOX = re.compile(r"^\[( |x|X)\]\s+")
_INLINE = re.compile(r"(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)")


def _runs(paragraph: Paragraph, text: str) -> None:
    """`**negrito**` e `*itálico*` viram runs; o resto é texto."""
    for part in _INLINE.split(text):
        if part.startswith("**") and part.endswith("**") and len(part) > 4:  # noqa: PLR2004 — os dois marcadores
            paragraph.add_run(part[2:-2]).bold = True
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:  # noqa: PLR2004
            paragraph.add_run(part[1:-1]).italic = True
        elif part:
            paragraph.add_run(part)


def _markdown(doc: DocxDocument, markdown: str) -> None:
    """Um subconjunto do Markdown: `#` a `###`, listas, caixas de seleção, negrito, itálico e parágrafos."""
    pending: list[str] = []

    def flush() -> None:
        if pending:
            _runs(doc.add_paragraph(), " ".join(pending))
            pending.clear()

    for raw in markdown.splitlines():
        line = raw.strip()
        heading, bullet, numbered = _HEADING.match(line), _BULLET.match(raw), _NUMBERED.match(raw)
        if not line:
            flush()
        elif heading:
            flush()
            doc.add_heading(heading.group(2).strip(), level=len(heading.group(1)))
        elif bullet or numbered:
            flush()
            item = (bullet or numbered).group(1)
            item = _CHECKBOX.sub(lambda m: "☑ " if m.group(1).strip() else "☐ ", item)
            _runs(doc.add_paragraph(style="List Bullet" if bullet else "List Number"), item)
        else:
            pending.append(line)
    flush()


def render_docx(export: Export) -> bytes:
    """Título, data/duração/participantes, o resumo (se houver) e a transcrição, um parágrafo por fala."""
    export = _xml_safe(export)
    doc = Document()
    doc.add_heading(export.title, level=0)
    doc.add_paragraph(" · ".join(export.meta()))
    if export.summary_md:
        doc.add_heading("Resumo", level=1)
        _markdown(doc, export.summary_md)
    doc.add_heading("Transcrição", level=1)
    for line in export.lines:
        paragraph = doc.add_paragraph()
        paragraph.add_run(line.speaker).bold = True
        paragraph.add_run(f" [{hms(line.start_ms)}]: {line.text}")
    buffer = BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


def _xml_safe(export: Export) -> Export:
    def clean(text: str) -> str:
        return _XML_INVALID.sub("", text)

    return replace(
        export,
        title=clean(export.title),
        participants=[clean(name) for name in export.participants],
        lines=[replace(line, speaker=clean(line.speaker), text=clean(line.text)) for line in export.lines],
        summary_md=clean(export.summary_md) if export.summary_md else export.summary_md,
    )


RENDERERS: dict[str, Any] = {"txt": render_txt, "srt": render_srt, "md": render_md, "docx": render_docx}
