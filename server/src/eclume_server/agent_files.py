"""Arquivos do Agente: o texto extraído dos anexos e os arquivos que o agente gera.

Entrada: .txt, .md, .csv, .pdf e .docx, até `MAX_INPUT_BYTES`; o texto extraído é cortado em
`MAX_TEXT_CHARS`. O tipo vem da extensão e é conferido pelo conteúdo (o PDF começa por `%PDF`, o
.docx é um zip com `word/document.xml`); o original nunca é executado. Saída: .md, .txt, .csv e
.docx, montados a partir do texto que o agente escreveu (o .docx pelo subconjunto de Markdown da
exportação). Regras em docs/standards/code/server-agentes.md §Agente.
"""

from __future__ import annotations

import re
import unicodedata
import zipfile
from dataclasses import dataclass
from io import BytesIO
from typing import TYPE_CHECKING

from eclume_server.exports import _markdown

if TYPE_CHECKING:
    from uuid import UUID

MAX_INPUT_BYTES = 10 * 1024 * 1024
MAX_TEXT_CHARS = 200_000
MAX_INPUTS_PER_MESSAGE = 5
MAX_INPUTS_PER_SESSION = 20
MAX_OUTPUT_CHARS = 200_000
MAX_OUTPUTS_PER_REPLY = 3
MAX_PDF_PAGES = 500
# Teto do conteúdo descompactado de um .docx: barra a bomba de zip antes de abrir o XML.
MAX_DOCX_UNZIPPED = 50 * 1024 * 1024
MAX_NAME = 200

INPUT_TYPES = {
    "txt": "text/plain; charset=utf-8",
    "md": "text/markdown; charset=utf-8",
    "csv": "text/csv; charset=utf-8",
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
OUTPUT_TYPES = {
    "md": "text/markdown; charset=utf-8",
    "txt": "text/plain; charset=utf-8",
    "csv": "text/csv; charset=utf-8",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
ACCEPTED = ", ".join(f".{ext}" for ext in INPUT_TYPES)
_XML_INVALID = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_UNSAFE_NAME = re.compile(r"[\\/:*?\"<>|\x00-\x1f]+")


class FileRejectedError(Exception):
    """O anexo não é aceito: tipo fora da lista, conteúdo que não bate com a extensão ou ilegível."""


@dataclass(frozen=True)
class Extracted:
    """O texto do anexo, o tipo dele e se o texto foi cortado no teto."""

    text: str
    media_type: str
    truncated: bool


@dataclass(frozen=True)
class Rendered:
    """Um arquivo gerado: o nome final, o tipo e os bytes."""

    name: str
    media_type: str
    data: bytes


def file_key(owner_id: UUID, session_id: UUID, file_id: UUID) -> str:
    """Chave do arquivo no bucket: sob o dono, como o áudio."""
    return f"users/{owner_id}/agent/{session_id}/{file_id}"


def extension(name: str) -> str:
    """A extensão em minúsculas, sem o ponto (vazia sem extensão)."""
    _, dot, ext = name.rpartition(".")
    return ext.lower() if dot else ""


def clean_name(name: str, fallback: str = "arquivo") -> str:
    """Um nome de arquivo sem caminho nem caracteres de controle, até `MAX_NAME`."""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    base = _UNSAFE_NAME.sub("-", unicodedata.normalize("NFC", base)).strip(" .-")
    return (base or fallback)[:MAX_NAME]


def _decode(data: bytes) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("latin-1")


def _pdf_text(data: bytes) -> str:
    from pypdf import PdfReader  # noqa: PLC0415 — só quem anexa PDF paga a importação
    from pypdf.errors import PdfReadError  # noqa: PLC0415

    if not data.startswith(b"%PDF"):
        raise FileRejectedError("O arquivo não é um PDF.")
    try:
        reader = PdfReader(BytesIO(data))
        if reader.is_encrypted:
            raise FileRejectedError("O PDF está protegido por senha.")
        pages = []
        for page in reader.pages[:MAX_PDF_PAGES]:
            pages.append(page.extract_text() or "")
            if sum(len(text) for text in pages) > MAX_TEXT_CHARS:
                break
    except (PdfReadError, ValueError, KeyError, TypeError) as exc:
        raise FileRejectedError("O PDF não pôde ser lido.") from exc
    return "\n\n".join(pages)


def _docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(BytesIO(data)) as archive:
            if "word/document.xml" not in archive.namelist():
                raise FileRejectedError("O arquivo não é um documento do Word (.docx).")
            if sum(info.file_size for info in archive.infolist()) > MAX_DOCX_UNZIPPED:
                raise FileRejectedError("O documento descompactado passa do limite.")
    except zipfile.BadZipFile as exc:
        raise FileRejectedError("O arquivo não é um documento do Word (.docx).") from exc
    from docx import Document  # noqa: PLC0415 — o worker não lê DOCX

    try:
        doc = Document(BytesIO(data))
    except Exception as exc:
        raise FileRejectedError("O documento não pôde ser lido.") from exc
    lines = [paragraph.text for paragraph in doc.paragraphs]
    for table in doc.tables:
        lines.extend(" | ".join(cell.text.strip() for cell in row.cells) for row in table.rows)
    return "\n".join(lines)


def extract_text(name: str, data: bytes) -> Extracted:
    """O texto do anexo; `FileRejectedError` fora da lista ou com conteúdo que não bate."""
    ext = extension(name)
    if ext not in INPUT_TYPES:
        raise FileRejectedError(f"Tipo não aceito. Anexe {ACCEPTED}.")
    if ext == "pdf":
        text = _pdf_text(data)
    elif ext == "docx":
        text = _docx_text(data)
    else:
        if b"\x00" in data[:8192]:
            raise FileRejectedError("O arquivo não é de texto.")
        text = _decode(data)
    text = _XML_INVALID.sub("", text.replace("\r\n", "\n")).strip()
    truncated = len(text) > MAX_TEXT_CHARS
    return Extracted(text=text[:MAX_TEXT_CHARS], media_type=INPUT_TYPES[ext], truncated=truncated)


def output_name(name: str, fmt: str) -> str:
    """O nome do arquivo gerado, com a extensão do formato."""
    base = clean_name(name, "resultado")
    if extension(base) == fmt:
        base = base[: -(len(fmt) + 1)] or "resultado"
    return f"{base[: MAX_NAME - len(fmt) - 1]}.{fmt}"


def render_output(name: str, fmt: str, content: str) -> Rendered:
    """Monta o arquivo que o agente pediu; `ValueError` para formato fora de `OUTPUT_TYPES`."""
    if fmt not in OUTPUT_TYPES:
        raise ValueError(fmt)
    content = content[:MAX_OUTPUT_CHARS]
    if fmt == "docx":
        from docx import Document  # noqa: PLC0415

        doc = Document()
        _markdown(doc, _XML_INVALID.sub("", content))
        buffer = BytesIO()
        doc.save(buffer)
        data = buffer.getvalue()
    else:
        data = content.encode("utf-8")
    return Rendered(name=output_name(name, fmt), media_type=OUTPUT_TYPES[fmt], data=data)


__all__ = [
    "INPUT_TYPES",
    "MAX_INPUT_BYTES",
    "OUTPUT_TYPES",
    "Extracted",
    "FileRejectedError",
    "Rendered",
    "extract_text",
    "file_key",
    "render_output",
]
